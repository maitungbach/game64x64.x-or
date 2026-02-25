const { createClient } = require('redis');

async function main() {
  const redisUrl = process.argv[2];
  if (!redisUrl) {
    console.error('Missing redis url argument');
    process.exit(1);
  }

  const client = createClient({ url: redisUrl });
  await client.connect();

  const emails = [
    'tester01@example.com',
    'tester02@example.com',
    'tester03@example.com',
    'tester04@example.com',
    'tester05@example.com',
  ];

  await client.sendCommand(['HDEL', 'game64x64:users', ...emails]);

  const sessionKeys = [];
  for await (const key of client.scanIterator({ MATCH: 'game64x64:session:*' })) {
    sessionKeys.push(key);
  }
  if (sessionKeys.length > 0) {
    await client.sendCommand(['DEL', ...sessionKeys]);
  }

  const userSessionKeys = [];
  for await (const key of client.scanIterator({ MATCH: 'game64x64:user-session:*' })) {
    userSessionKeys.push(key);
  }
  if (userSessionKeys.length > 0) {
    await client.sendCommand(['DEL', ...userSessionKeys]);
  }

  await client.sendCommand(['DEL', 'game64x64:players', 'game64x64:cells']);

  const usersLeft = await client.hLen('game64x64:users');
  const playersLeft = await client.hLen('game64x64:players');
  const cellsLeft = await client.hLen('game64x64:cells');
  const sessionsLeft = [];
  for await (const key of client.scanIterator({ MATCH: 'game64x64:session:*' })) {
    sessionsLeft.push(key);
  }
  const userSessionsLeft = [];
  for await (const key of client.scanIterator({ MATCH: 'game64x64:user-session:*' })) {
    userSessionsLeft.push(key);
  }

  console.log(JSON.stringify({
    redisUrl,
    usersLeft,
    playersLeft,
    cellsLeft,
    sessionsLeft: sessionsLeft.length,
    userSessionsLeft: userSessionsLeft.length,
  }));

  await client.quit();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
