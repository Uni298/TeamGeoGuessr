const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

const PORT = process.env.PORT || 3000;

// In-memory rooms structure
// rooms[roomId] = { id, hostId, settings: { timeLimit }, players: { socketId: {id,name,color,score, lastGuess}}, spawnIndex }
const rooms = {};

function makeRoomId(){
  return (Math.floor(Math.random()*9000)+1000).toString();
}

function broadcastRoomUpdate(roomId){
  const room = rooms[roomId];
  if(!room) return;
  const players = Object.values(room.players).map(p=>({id:p.id,name:p.name,color:p.color,connected:p.connected, submitCount: p.submitCount || 0, excluded: p.excluded||false, team: p.team}));
  io.to(roomId).emit('room_update', {players, hostId: room.hostId, settings: room.settings});
}

io.on('connection', (socket) => {
  console.log('conn', socket.id);

  socket.on('create_room', ({name, settings}, cb) => {
    const roomId = makeRoomId();
    const room = {
      id: roomId,
      hostId: socket.id,
      settings: Object.assign({timeLimit:-1, guessCountdown:-1}, settings || {}),
      players: {},
      spawnIndex: 0,
      status: 'waiting',
      timer: null,
      guessTimer: null
    };
    rooms[roomId] = room;

    socket.join(roomId);
    const randomTeam = Math.random() < 0.5 ? 'red' : 'blue';
    room.players[socket.id] = {id: socket.id, name: name || 'Host', color: '#1f2937', score: 0, lastGuess: null, connected:true, submitCount:0, excluded:false, team: randomTeam};

    console.log('room created', roomId);
    broadcastRoomUpdate(roomId);
    cb({ok:true, roomId});
  });

  socket.on('join_room', ({roomId, name}, cb) => {
    const room = rooms[roomId];
    if(!room) return cb({ok:false, msg:'ルームが存在しません'});
    socket.join(roomId);
    // assign color
    const colors = ['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#06b6d4','#f97316','#0ea5a4','#7c3aed'];
    const idx = Object.keys(room.players).length % colors.length;
    const randomTeam = Math.random() < 0.5 ? 'red' : 'blue';
    room.players[socket.id] = {id: socket.id, name: name || 'Player', color: colors[idx], score: 0, lastGuess: null, connected:true, submitCount:0, excluded:false, team: randomTeam};
    broadcastRoomUpdate(roomId);
    cb({ok:true});
  });

  socket.on('leave_room', ({roomId}) => {
    const room = rooms[roomId];
    if(!room) return;
    delete room.players[socket.id];
    socket.leave(roomId);
    broadcastRoomUpdate(roomId);
  });

  socket.on('kick_player', ({roomId, playerId}, cb) => {
    const room = rooms[roomId];
    if(!room) return cb({ok:false});
    if(room.hostId !== socket.id) return cb({ok:false});
    const target = room.players[playerId];
    if(target){
      io.to(playerId).emit('kicked');
      delete room.players[playerId];
      io.sockets.sockets.get(playerId)?.leave(roomId);
      broadcastRoomUpdate(roomId);
      return cb({ok:true});
    }
    cb({ok:false});
  });

  socket.on('toggle_team', ({roomId, playerId}, cb) => {
    const room = rooms[roomId];
    if(!room) return cb({ok:false});
    if(room.hostId !== socket.id) return cb({ok:false});
    const target = room.players[playerId];
    if(target){
      target.team = target.team === 'red' ? 'blue' : 'red';
      broadcastRoomUpdate(roomId);
      return cb({ok:true});
    }
    cb({ok:false});
  });

  socket.on('start_round', ({roomId, spawnIndex}, cb) => {
    const room = rooms[roomId];
    if(!room) return cb({ok:false});
    if(room.hostId !== socket.id) return cb({ok:false});

    room.status = 'playing';
    if(typeof spawnIndex === 'number') room.spawnIndex = spawnIndex % 100000;
    // clear last guesses
    Object.values(room.players).forEach(p => { p.lastGuess = null; p.submitCount = 0; p.excluded = false; });

    io.to(roomId).emit('round_started', {spawnIndex: room.spawnIndex, settings: room.settings});

    // if timeLimit >0 start timer
    if(room.settings.timeLimit && room.settings.timeLimit > 0){
      if(room.timer) clearTimeout(room.timer);
      room.timer = setTimeout(()=>{
        endRound(roomId);
      }, room.settings.timeLimit*1000);
    }

    cb({ok:true});
  });

  socket.on('submit_guess', ({roomId, lat, lng, time}, cb) => {
    const room = rooms[roomId];
    if(!room) return cb({ok:false, msg:'room not found'});
    const player = room.players[socket.id];
    if(!player) return cb({ok:false, msg:'player not in room'});
    if(room.status !== 'playing') return cb({ok:false, msg:'not playing'});
    // enforce max overwrite attempts (2)
    const MAX_OVERWRITES = 2;
    if(typeof player.submitCount === 'undefined') player.submitCount = 0;
    if(player.submitCount >= MAX_OVERWRITES) return cb({ok:false, msg:'提出回数の上限に達しました'});
    player.submitCount = (player.submitCount||0) + 1;
    player.lastGuess = {lat, lng, time: time || Date.now()};
    // notify room of new guess statuses (include name/color)
    io.to(roomId).emit('player_guessed', {playerId: player.id, name: player.name, color: player.color, submitCount: player.submitCount});

    // if a guess-countdown is configured, start it on first guess
    if(room.settings.guessCountdown && room.settings.guessCountdown > 0 && !room.guessTimer){
      const duration = room.settings.guessCountdown;
      io.to(roomId).emit('countdown_started', {duration});
      room.guessTimer = setTimeout(()=>{
        // end round and mark players without guesses as excluded
        endRound(roomId);
      }, duration*1000);
    }

    // check all players guessed
    const pcount = Object.keys(room.players).length;
    const guessed = Object.values(room.players).filter(p=>p.lastGuess).length;
    if(guessed >= pcount){
      endRound(roomId);
    }

    cb({ok:true});
  });

  socket.on('next_round', ({roomId}, cb) => {
    const room = rooms[roomId];
    if(!room) return cb({ok:false});
    if(room.hostId !== socket.id) return cb({ok:false});
    // move index
    room.spawnIndex = (room.spawnIndex + 1) % 100000;
    room.status = 'waiting';
    if(room.timer) { clearTimeout(room.timer); room.timer = null; }
    if(room.guessTimer) { clearTimeout(room.guessTimer); room.guessTimer = null; }
    // reset per-player state
    Object.values(room.players).forEach(p=>{ p.lastGuess = null; p.submitCount = 0; p.excluded = false; });
    io.to(roomId).emit('round_ready');
    cb({ok:true});
  });

  socket.on('disconnecting', () => {
    // remove from any rooms
    for(const roomId of socket.rooms){
      if(roomId === socket.id) continue;
      const room = rooms[roomId];
      if(!room) continue;
      if(room.players && room.players[socket.id]){
        room.players[socket.id].connected = false;
        // if host disconnected, assign new host
        if(room.hostId === socket.id){
          const ids = Object.keys(room.players).filter(id=>id!==socket.id);
          room.hostId = ids.length? ids[0] : null;
        }
        broadcastRoomUpdate(roomId);
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('disconn', socket.id);
    // cleanup empty rooms
    for(const roomId in rooms){
      const room = rooms[roomId];
      if(!room) continue;
      if(room.players && room.players[socket.id]){
        delete room.players[socket.id];
      }
      if(Object.keys(room.players).length === 0){
        if(room.timer) clearTimeout(room.timer);
        delete rooms[roomId];
      }
    }
  });

  function endRound(roomId){
    const room = rooms[roomId];
    if(!room) return;
    if(room.timer){ clearTimeout(room.timer); room.timer = null; }
    if(room.guessTimer){ clearTimeout(room.guessTimer); room.guessTimer = null; }
    // ask clients to provide spawn details (client will fetch spawn.json and find index)
    // gather guesses
    // We will emit 'round_ended' and include all players' lastGuess (null means no answer -> invalid)
    const results = Object.values(room.players).map(p => ({id:p.id, name:p.name, color:p.color, lastGuess:p.lastGuess, excluded: p.lastGuess? false : true, submitCount: p.submitCount||0, team: p.team}));
    room.status = 'ended';
    io.to(roomId).emit('round_ended', {results, spawnIndex: room.spawnIndex});
  }

});

server.listen(PORT, ()=>{
  console.log('listening on', PORT);
});
