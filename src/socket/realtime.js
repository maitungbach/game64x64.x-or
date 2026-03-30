/* eslint-disable no-console */
function configureRealtime(io, deps) {
  const { config, stats, auth, game } = deps;

  if (config.AUTH_REQUIRED) {
    io.use((socket, next) => {
      (async () => {
        const authContext = await auth.getAuthenticatedUserByToken(auth.getAuthTokenFromSocket(socket));
        if (!authContext) {
          next(new Error('unauthorized'));
          return;
        }

        socket.data.auth = {
          userId: authContext.user.id,
          email: authContext.user.email,
          name: authContext.user.name,
        };
        socket.data.authToken = authContext.token;
        auth.clearPendingSessionRelease(authContext.user.id);
        next();
      })().catch((error) => {
        console.error('[socket-auth] failed:', error);
        next(new Error('unauthorized'));
      });
    });
  }

  io.on('connection', (socket) => {
    stats.connectionsTotal += 1;

    (async () => {
      const createdPlayer = await game.connectPlayer(socket.id);
      if (!createdPlayer) {
        socket.disconnect(true);
      }
    })().catch((error) => {
      stats.errorsTotal += 1;
      console.error('[connection] failed:', error);
      socket.disconnect(true);
    });

    socket.on('move', (payload) => {
      stats.movesReceived += 1;

      (async () => {
        const seq = game.normalizeSeq(payload?.seq);
        const coordX = game.normalizeCoord(payload?.x, config.GRID_SIZE - 1);
        const coordY = game.normalizeCoord(payload?.y, config.GRID_SIZE - 1);
        const hasCoordFields = payload && ('x' in payload || 'y' in payload);
        const hasCoords = coordX !== null && coordY !== null;
        const direction = payload?.direction;

        if (hasCoordFields && !hasCoords) {
          stats.movesRejectedInvalid += 1;
          game.emitMoveAck(socket, seq, false, 'invalid_coords');
          return;
        }

        if (hasCoords) {
          const moved = await game.movePlayerTo(socket.id, coordX, coordY);
          if (!moved.ok) {
            game.emitMoveAck(socket, seq, false, moved.reason || 'missing_player');
            return;
          }
          game.emitPlayerMoved(moved.player, seq);
          game.emitMoveAck(socket, seq, true, null, moved.player);
          await game.emitPlayersNow();
          stats.movesApplied += 1;
          return;
        }

        if (typeof direction !== 'string' || !game.VALID_DIRECTIONS.has(direction)) {
          stats.movesRejectedInvalid += 1;
          game.emitMoveAck(socket, seq, false, 'invalid_direction');
          return;
        }

        const player = await game.getPlayerById(socket.id);
        if (!player) {
          game.emitMoveAck(socket, seq, false, 'missing_player');
          return;
        }

        if (game.consumeMoveRateLimit(socket.id, config.MOVE_INTERVAL_MS)) {
          stats.movesRejectedRateLimit += 1;
          game.emitMoveAck(socket, seq, false, 'rate_limited', player);
          return;
        }

        if (game.usesRedisStorage()) {
          const moved = await game.movePlayerRedis(socket.id, direction);
          if (moved.state === 'occupied') {
            stats.movesRejectedOccupied += 1;
            game.emitMoveAck(socket, seq, false, 'occupied', player);
            return;
          }
          if (moved.state !== 'applied') {
            game.emitMoveAck(socket, seq, false, 'missing_player');
            return;
          }
          const updatedPlayer = moved.player || player;
          game.emitPlayerMoved(updatedPlayer, seq);
          game.emitMoveAck(socket, seq, true, null, updatedPlayer);
          await game.emitPlayersNow();
          stats.movesApplied += 1;
        } else {
          const next = game.getNextPosition(player, direction);
          if (await game.isOccupied(next.x, next.y, socket.id)) {
            stats.movesRejectedOccupied += 1;
            game.emitMoveAck(socket, seq, false, 'occupied', player);
            return;
          }

          player.x = next.x;
          player.y = next.y;
          await game.savePlayer(player);
          game.emitPlayerMoved(player, seq);
          game.emitMoveAck(socket, seq, true, null, player);
          await game.emitPlayersNow();
          stats.movesApplied += 1;
        }
      })().catch((error) => {
        stats.errorsTotal += 1;
        console.error('[move] failed:', error);
      });
    });

    socket.on('disconnect', () => {
      stats.disconnectionsTotal += 1;

      (async () => {
        const userId = socket?.data?.auth?.userId || null;
        const authToken = socket?.data?.authToken || null;
        await game.disconnectPlayer(socket.id);
        auth.scheduleSessionRelease(userId, authToken);
      })().catch((error) => {
        stats.errorsTotal += 1;
        console.error('[disconnect] failed:', error);
      });
    });
  });
}

module.exports = {
  configureRealtime,
};
