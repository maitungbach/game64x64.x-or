const { createClient } = require("redis");

async function main() {
  const redisUrl = process.argv[2];
  if (!redisUrl) {
    console.error("Usage: node scripts/reset-runtime-state.js <redis-url>");
    process.exit(1);
  }

  const client = createClient({ url: redisUrl });
  await client.connect();

  const sessionKeys = [];
  for await (const key of client.scanIterator({ MATCH: "game64x64:session:*" })) {
    sessionKeys.push(key);
  }
  if (sessionKeys.length > 0) {
    await client.sendCommand(["DEL", ...sessionKeys]);
  }

  const userSessionKeys = [];
  for await (const key of client.scanIterator({ MATCH: "game64x64:user-session:*" })) {
    userSessionKeys.push(key);
  }
  if (userSessionKeys.length > 0) {
    await client.sendCommand(["DEL", ...userSessionKeys]);
  }

  await client.sendCommand(["DEL", "game64x64:players", "game64x64:cells"]);

  const usersCount = await client.hLen("game64x64:users");
  const playersCount = await client.hLen("game64x64:players");
  const cellsCount = await client.hLen("game64x64:cells");

  console.log(JSON.stringify({
    redisUrl,
    usersCount,
    playersCount,
    cellsCount,
    removedSessionKeys: sessionKeys.length,
    removedUserSessionKeys: userSessionKeys.length,
  }));

  await client.quit();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
