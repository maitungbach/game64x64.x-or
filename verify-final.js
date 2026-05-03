const { io } = require('socket.io-client');
const http = require('http');

(async () => {
  await sleep(2000);

  // Tạo room
  const cr = await httpPost('/api/rooms', {maxPlayers:4, gameDurationSec:30});
  const roomId = cr.body.room.id;
  console.log('✅ Room created:', roomId);

  // Kết nối 2 socket
  const s1 = io('http://localhost:5001', {transports:['polling'], reconnection:false});
  await waitFor(s1, 'connect');
  console.log('✅ S1 connected');

  const s2 = io('http://localhost:5001', {transports:['polling'], reconnection:false});
  await waitFor(s2, 'connect');
  console.log('✅ S2 connected');

  // Join
  await joinRoom(s1, roomId);
  await joinRoom(s2, roomId);

  // Kiểm tra leaderboard SAU KHI JOIN
  const lb = await httpGet(`/api/rooms/${roomId}/leaderboard`);
  console.log('\n📊 Leaderboard after both joined:');
  console.log('   Entries:', lb.body.leaderboard.length);
  lb.body.leaderboard.forEach(e => console.log(`   ${e.playerId.substring(0,6)}: ${e.score}`));

  if (lb.body.leaderboard.length >= 2) {
    console.log('✅ Leaderboard HIỂN THỊ ĐỦ PLAYERS (2+)');
  } else {
    console.log('❌ Leaderboard CHƯA ĐỦ - expect 2, got', lb.body.leaderboard.length);
  }

  // Start game
  console.log('\n→ Starting game...');
  s1.emit('startRoom', {});
  await waitFor(s1, 'roomStarted');

  // Kiểm tra collectibles
  const room = await httpGet(`/api/rooms/${roomId}`);
  console.log('\n🎮 Game status:', room.body.room.status);
  console.log('   Collectibles spawned:', room.body.room.collectibles.length);
  console.log('   Time remaining:', room.body.room.timeRemainingSec, 's');

  if (room.body.room.collectibles.length > 0) {
    console.log('✅ COLLECTIBLES ĐÃ SPAWN NGAY KHI START');
  } else {
    console.log('❌ Collectibles CHƯA SPAWN');
  }

  // Di chuyển để test ăn collectible
  console.log('\n→ Moving to eat...');
  for (let i = 0; i < 30; i++) {
    s1.emit('move', {direction: i % 2 ? 'right' : 'down', seq: i+1});
    await sleep(50);
  }
  await sleep(300);

  // Check leaderboard sau khi ăn
  const lb2 = await httpGet(`/api/rooms/${roomId}/leaderboard`);
  console.log('\n📊 Leaderboard after moves:');
  lb2.body.leaderboard.forEach(e => console.log(`   ${e.playerId.substring(0,6)}: ${e.score}`));

  console.log('\n✅ TEST HOÀN TẤT');
  process.exit(0);
})();

function httpPost(path, body) {
  return new Promise(resolve => {
    const req = http.request({hostname:'localhost',port:5001,path,method:'POST',headers:{'Content-Type':'application/json','Origin':'http://localhost:5001'}}, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode, body:JSON.parse(d)}));
    });
    req.write(JSON.stringify(body)); req.end();
  });
}
function httpGet(path) {
  return new Promise(resolve => {
    http.get(`http://localhost:5001${path}`, {headers:{'Origin':'http://localhost:5001'}}, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode, body:JSON.parse(d)}));
    });
  });
}
function waitFor(socket, event) {
  return new Promise(resolve => socket.once(event, resolve));
}
function joinRoom(socket, roomId) {
  return new Promise(resolve => socket.once('roomJoined', resolve).emit('joinRoom', {roomId}));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
