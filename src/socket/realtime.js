/* eslint-disable no-console */
function configureRealtime(io, deps) {
  const { config, stats, auth, game } = deps;

  io.use((socket, next) => {
    (async () => {
      if (!auth.isTrustedOriginRequest(socket.request)) {
        next(new Error('forbidden_origin'));
        return;
      }

      if (config.AUTH_REQUIRED) {
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
      }

      next();
    })().catch((error) => {
      console.error('[socket-auth] failed:', error);
      next(new Error('unauthorized'));
    });
  });

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
        const hasCoordFields = payload && ('x' in payload || 'y' in payload);
        const direction = payload?.direction;

        if (hasCoordFields) {
          stats.movesRejectedInvalid += 1;
          game.emitMoveAck(socket, seq, false, 'invalid_coords');
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

        const roomId = socket?.data?.roomId || null;
        let scored = false;
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
          if (roomId) {
            const room = game.getRoomById(roomId);
            if (room && room.status === 'playing') {
              game.addRoomScore(roomId, socket.id, 1);
              scored = true;
            }
          }
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
          if (roomId) {
            const room = game.getRoomById(roomId);
            if (room && room.status === 'playing') {
              game.addRoomScore(roomId, socket.id, 1);
              scored = true;
            }
          }
          game.emitPlayerMoved(player, seq);
          game.emitMoveAck(socket, seq, true, null, player);
          await game.emitPlayersNow();
          stats.movesApplied += 1;
        }
        if (scored && roomId) {
          const leaderboard = game.getRoomLeaderboard(roomId);
          io.to(roomId).emit('roomScoreUpdate', { leaderboard });
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
        const roomId = socket?.data?.roomId || null;
        if (roomId) {
          game.leaveRoom(roomId, userId || socket.id);
          socket.to(roomId).emit('roomPlayerLeft', { playerId: userId || socket.id });
        }
        await game.disconnectPlayer(socket.id);
        auth.scheduleSessionRelease(userId, authToken);
      })().catch((error) => {
        stats.errorsTotal += 1;
        console.error('[disconnect] failed:', error);
      });
    });

    socket.on('joinRoom', (payload) => {
      const userId = socket?.data?.auth?.userId || socket.id;
      const roomId = String(payload?.roomId || '').toUpperCase();
      if (!roomId) {
        socket.emit('roomError', { message: 'Missing roomId' });
        return;
      }
      const result = game.joinRoom(roomId, userId);
      if (!result.ok) {
        socket.emit('roomError', { message: result.reason });
        return;
      }
      socket.data.roomId = roomId;
      socket.join(roomId);
      socket.emit('roomJoined', { roomId, room: { id: result.room.id, status: result.room.status, players: result.room.players.size } });
      socket.to(roomId).emit('roomPlayerJoined', { playerId: userId, playerCount: result.room.players.size });
    });

    socket.on('leaveRoom', (payload) => {
      const userId = socket?.data?.auth?.userId || socket.id;
      const roomId = socket?.data?.roomId || null;
      if (!roomId) {
        return;
      }
      const result = game.leaveRoom(roomId, userId);
      socket.data.roomId = null;
      socket.leave(roomId);
      if (result.closed) {
        io.to(roomId).emit('roomClosed', { roomId });
      } else {
        socket.to(roomId).emit('roomPlayerLeft', { playerId: userId });
      }
      socket.emit('roomLeft', { roomId });
    });

    socket.on('startRoom', (payload) => {
      const userId = socket?.data?.auth?.userId || null;
      const roomId = socket?.data?.roomId || null;
      if (!roomId || !userId) {
        socket.emit('roomError', { message: 'Not in a room' });
        return;
      }
      const room = game.getRoomById(roomId);
      if (!room || room.hostId !== userId) {
        socket.emit('roomError', { message: 'Only host can start the game' });
        return;
      }
      const result = game.startRoomGame(roomId);
      if (!result.ok) {
        socket.emit('roomError', { message: result.reason });
        return;
      }
      io.to(roomId).emit('roomStarted', { roomId, endsAt: result.room.endsAt, durationSec: result.room.gameDurationSec });
    });
  });
}

module.exports = {
  configureRealtime,
};
