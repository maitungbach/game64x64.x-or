const { io } = require('socket.io-client');
const http = require('http');

let roomId = null;
const s1 = io('http://localhost:5001', { transports: ['polling'] });
const s2 = io('http://localhost:5001', { transports: ['polling'] });

s1.on('connect', async () => {
  console.log('S1 connected');
  const cr = await httpPost('/api/rooms', {maxPlayers:4, gameDurationSec:30});
  roomId = cr.body.room.id;
  console.log('Room:', roomId);
  s1.emit('joinRoom', {roomId});
});

s1.once('roomJoined', async () => {
  console.log('S1 joined');
  s2.connect();
});

s2.on('connect', () => {
  console.log('S2 connected');
  s2.emit('joinRoom', {roomId});
});

s2.once('roomJoined', async () => {
  console.log('S2 joined');
  const lb = await httpGet(`/api/rooms/${roomId}/leaderboard`);
  console.log('Leaderboard entries:', lb.body.leaderboard.length);
  console.log('Expected: 2 (host + player)');
  console.log('Data:', lb.body.leaderboard);
  
  const room = await httpGet(`/api/rooms/${roomId}`);
  console.log('Current players in room:', room.body.room.currentPlayers);
  
  if (lb.body.leaderboard.length === 2) {
    console.log('\n✅ LEADERBOARD CORRECT - shows all players');
  } else {
    console.log('\n❌ LEADERBOARD WRONG - expected 2 entries');
  }
  process.exit(0);
});

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

setTimeout(() => { console.log('Timeout'); process.exit(1); }, 10000);
