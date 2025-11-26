// client.js — multiplayer geoguessr client
const socket = io();

let spawnList = [];
let roomId = null;
let isHost = false;
let myId = null;
let smallMap = null;
let markerGuess = null;
let markerCorrect = null;
let playerMarkers = {};
let polyLines = [];
let settings = { timeLimit: -1 };
let currentSpawnIndex = 0;
let startTime = 0;
let elapsedTimer = null;
let guessedMap = {};
let resultMap = null;
let resultMapLayers = [];
let playersState = {};
const MAX_OVERWRITES = 2;
let submitLocked = false;

// Helper function to animate number counting
function animateNumber(element, start, end, duration, decimals = 0) {
  const startTime = Date.now();
  const range = end - start;
  
  function update() {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const current = start + (range * progress);
    element.textContent = decimals > 0 ? current.toFixed(decimals) : Math.round(current);
    
    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }
  
  requestAnimationFrame(update);
}

// Calculate score based on distance (max 5000)
function calculateScore(distanceKm) {
  // Score decreases exponentially with distance
  // Perfect guess (0km) = 5000 points
  // 100km = ~2500 points
  // 1000km = ~500 points
  // 5000km+ = ~0 points
  const maxScore = 5000;
  const score = maxScore * Math.exp(-distanceKm / 1500);
  return Math.round(Math.max(0, Math.min(maxScore, score)));
}

// DOM helpers
const $ = id => document.getElementById(id);

function setRoomInfo() {
  $('room-id').textContent = roomId ? `Room: ${roomId}` : 'Room: -';
  $('role').textContent = isHost ? 'Role: Host' : (roomId ? 'Role: Player' : 'Role: -');
}

async function loadSpawns() {
  try {
    const res = await fetch('spawn.json');
    spawnList = await res.json();
    console.log('spawns', spawnList.length);
  } catch (e) {
    alert('spawn.json を読み込めませんでした。ローカルサーバーで実行してください。');
  }
}

function setIframe(p) {
  if (!p) return;
  const iframe = $('streetview');
  const src = `https://www.google.com/maps/embed?pb=!4v0!6m8!1m7!1s${encodeURIComponent(p.pano)}!2m2!1d${p.lat}!2d${p.lng}!3f${p.heading || 0}!4f${p.pitch || 0}!5f1.0`;
  iframe.src = src;
}

function initSmallMap() {
  smallMap = L.map('small-map', { zoomControl: false, attributionControl: false }).setView([35.68, 139.76], 5);
  L.tileLayer('https://tile.openstreetmap.jp/{z}/{x}/{y}.png', { maxZoom: 20, attribution: '&copy; OSM contributors' }).addTo(smallMap);
  const el = document.querySelector('.small-map');
  // click to place guess when revealed, otherwise reveal
  smallMap.on('click', (e) => { if (el.classList.contains('reveal')) placeGuess(e.latlng.lat, e.latlng.lng); else revealSmallMap(true); });
  // auto shrink when cursor leaves
  el.addEventListener('mouseleave', () => { revealSmallMap(false); });
  el.addEventListener('mouseenter', () => { revealSmallMap(true); });
}

function revealSmallMap(show) {
  const el = document.querySelector('.small-map');
  if (show) { el.classList.remove('compact'); el.classList.add('reveal'); setTimeout(() => smallMap.invalidateSize(), 320); }
  else { el.classList.remove('reveal'); el.classList.add('compact'); setTimeout(() => smallMap.invalidateSize(), 320); }
}

function placeGuess(lat, lng) {
  if (markerGuess) smallMap.removeLayer(markerGuess);
  markerGuess = L.marker([lat, lng], { title: 'あなたの推測' }).addTo(smallMap);
  $('sel-lat').textContent = lat.toFixed(5);
  $('sel-lng').textContent = lng.toFixed(5);
}

function startElapsed() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  startTime = Date.now();
  elapsedTimer = setInterval(() => {
    const s = (Date.now() - startTime) / 1000;
    // show somewhere if needed
  }, 100);
}
function stopElapsed() { if (elapsedTimer) clearInterval(elapsedTimer); elapsedTimer = null; }

// UI actions
$('btn-create').addEventListener('click', async () => {
  const name = $('display-name').value || 'Host';
  settings.timeLimit = parseInt($('time-limit').value || '-1', 10);
  settings.guessCountdown = parseInt($('guess-countdown').value || '-1', 10);
  socket.emit('create_room', { name, settings }, (res) => {
    if (res.ok) { roomId = res.roomId; isHost = true; myId = socket.id; setRoomInfo(); $('room-input').value = roomId; }
  });
});

$('btn-join').addEventListener('click', () => {
  const name = $('display-name').value || 'Player';
  const rid = $('room-input').value.trim();
  if (!rid) { alert('Room ID を入力してください'); return; }
  socket.emit('join_room', { roomId: rid, name }, (res) => {
    if (res.ok) { roomId = rid; isHost = false; setRoomInfo(); }
    else alert(res.msg || '参加できません');
  });
});

$('start-round').addEventListener('click', () => {
  if (!roomId) return;
  const spawnIdx = Math.floor(Math.random() * spawnList.length);
  socket.emit('start_round', { roomId, spawnIndex: spawnIdx }, (res) => { if (!res.ok) alert('開始失敗'); });
});

$('kick-selected').addEventListener('click', () => {
  // kick first selected checkbox
  const cb = document.querySelector('#lobby-players input[type=checkbox]:checked');
  if (!cb) return alert('プレイヤーを選択してください');
  const pid = cb.dataset.id;
  socket.emit('kick_player', { roomId, playerId: pid }, (res) => { if (!res.ok) alert('kick に失敗'); });
});

$('submit').addEventListener('click', () => {
  if (!markerGuess) return alert('推測してください');
  if (!roomId) return alert('ルームに参加してください');
  // local check for attempts (server is authoritative)
  if (submitLocked) return;
  const myState = playersState[myId] || {};
  if ((myState.submitCount || 0) >= MAX_OVERWRITES) { alert('提出回数の上限に達しました'); return; }
  const lat = markerGuess.getLatLng().lat; const lng = markerGuess.getLatLng().lng;
  submitLocked = true; $('submit').disabled = true;
  socket.emit('submit_guess', { roomId, lat, lng, time: Date.now() }, (res) => { if (!res.ok) alert(res.msg || '送信失敗'); else { /* OK */ } });
  // unlock after short delay to prevent rapid resubmits
  setTimeout(() => { submitLocked = false; $('submit').disabled = false; }, 2000);
});

$('next-round').addEventListener('click', () => {
  socket.emit('next_round', { roomId }, (res) => { if (!res.ok) alert('次のターンへ移行できません'); });
});

// host-next (floating on result map)
const hostNextBtn = document.getElementById('host-next');
if (hostNextBtn) { hostNextBtn.addEventListener('click', () => { socket.emit('next_round', { roomId }, (res) => { if (!res.ok) alert('次のターンへ移行できません'); }); }); }

// socket events
socket.on('connect', () => { myId = socket.id; });

socket.on('room_update', (data) => {
  // update lobby UI
  const container = $('lobby-players'); container.innerHTML = '';
  data.players.forEach(p => {
    playersState[p.id] = p;
    const div = document.createElement('div'); div.className = 'player-row card';
    // Add team class
    if(p.team === 'red') div.classList.add('team-red');
    if(p.team === 'blue') div.classList.add('team-blue');
    
    const chk = document.createElement('input'); chk.type = 'checkbox'; chk.dataset.id = p.id;
    const dot = document.createElement('div'); dot.className = 'player-dot'; dot.style.background = p.color || (p.id === socket.id ? '#111' : '#888');
    const name = document.createElement('div'); name.className = 'player-name'; name.textContent = p.name + (p.id === data.hostId ? ' (Host)' : '');
    const status = document.createElement('div'); status.className = 'status'; status.textContent = guessedMap[p.id] ? 'guessed' : '';
    if (guessedMap[p.id]) div.classList.add('guessed');
    // attempts badge
    const attempts = document.createElement('div'); attempts.className = 'attempt-badge'; attempts.textContent = `残り:${Math.max(0, MAX_OVERWRITES - (p.submitCount || 0))}`;
    
    // Add toggle team button for host
    if(socket.id === data.hostId && p.id !== data.hostId){
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'btn-toggle-team';
      toggleBtn.textContent = 'チーム変更';
      toggleBtn.onclick = () => {
        socket.emit('toggle_team', {roomId, playerId: p.id}, (res) => {
          if(!res.ok) alert('チーム変更に失敗しました');
        });
      };
      div.appendChild(chk); div.appendChild(dot); div.appendChild(name); div.appendChild(status); div.appendChild(attempts); div.appendChild(toggleBtn);
    } else {
      div.appendChild(chk); div.appendChild(dot); div.appendChild(name); div.appendChild(status); div.appendChild(attempts);
    }
    
    container.appendChild(div);
  });
  // update my attempts display
  const me = data.players.find(p => p.id === socket.id);
  if (me) { const a = document.getElementById('attempts-left'); if (a) a.textContent = Math.max(0, MAX_OVERWRITES - (me.submitCount || 0)); }
  // show host-only parts if I'm host
  isHost = (socket.id === data.hostId);
  if (isHost) document.querySelectorAll('.host-only').forEach(el => el.style.display = 'block'); else document.querySelectorAll('.host-only').forEach(el => el.style.display = 'none');
  setRoomInfo();
});

socket.on('kicked', () => { alert('KICKED'); location.reload(); });

socket.on('round_started', async ({ spawnIndex, settings: s }) => {
  settings = s;
  currentSpawnIndex = spawnIndex;
  // reset guessed markers state
  guessedMap = {};
  // Add round-active class to minimize UI
  document.body.classList.add('round-active');
  // Hide result panel completely and reset values
  const panel = $('result-panel'); 
  if (panel) {
    panel.classList.remove('show');
    panel.style.opacity = '0';
    panel.style.top = '-400px';
  }
  // Reset result values
  const distEl = $('result-distance');
  const timeEl = $('result-time');
  const scoreEl = $('result-score');
  if (distEl) distEl.textContent = '0.00';
  if (timeEl) timeEl.textContent = '0.00';
  if (scoreEl) scoreEl.textContent = '0';
  // hide lobby controls
  document.querySelectorAll('#join-form, .host-only').forEach(el => el.style.display = 'none');
  // load spawn data and set iframe
  await loadSpawns();
  const spawn = spawnList[spawnIndex % spawnList.length];
  setIframe(spawn);
  // clear map overlays
  Object.values(playerMarkers).forEach(m => smallMap.removeLayer(m)); playerMarkers = {};
  polyLines.forEach(l => smallMap.removeLayer(l)); polyLines = [];
  if (markerCorrect) smallMap.removeLayer(markerCorrect); markerCorrect = null;
  if (markerGuess) smallMap.removeLayer(markerGuess); markerGuess = null; $('sel-lat').textContent = '—'; $('sel-lng').textContent = '—'; $('submit').disabled = false;
  // pan small map to region
  smallMap.setView([spawn.lat, spawn.lng], 5);
  startElapsed();
});

socket.on('player_guessed', ({ playerId }) => {
  // mark as guessed in lobby (server now sends name/color)
  guessedMap[playerId] = true;
  // update UI quickly and flash
  const rows = document.querySelectorAll('#lobby-players .player-row');
  rows.forEach(r => {
    const cb = r.querySelector('input[type=checkbox]');
    if (cb && cb.dataset.id === playerId) {
      r.classList.add('guessed');
      const st = r.querySelector('.status'); if (st) st.textContent = 'guessed';
      // pulse & flash to emphasize to others
      r.classList.add('pulse-highlight'); setTimeout(() => r.classList.remove('pulse-highlight'), 900);
      r.classList.add('flash-red'); setTimeout(() => r.classList.remove('flash-red'), 800);
    }
  });
  // if it's our own guess, show submit popup and effect
  if (playerId === myId) {
    const myRow = Array.from(rows).find(r => r.querySelector('input[type=checkbox]')?.dataset.id === myId);
    if (myRow) anime({ targets: myRow, scale: [1, 1.05, 1], duration: 700, easing: 'easeOutCubic' });
    if (markerGuess) markerGuess.bindPopup('提出済み').openPopup();
  }
});

socket.on('countdown_started', ({ duration }) => {
  // show a small countdown overlay
  let overlay = document.getElementById('countdown-overlay');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'countdown-overlay'; overlay.style = 'position:fixed;right:20px;top:80px;padding:10px 14px;background:rgba(0,0,0,0.75);color:#fff;border-radius:8px;z-index:100;font-weight:700'; document.body.appendChild(overlay); }
  let remain = duration;
  overlay.textContent = `締切まで: ${remain}s`;
  const iv = setInterval(() => {
    remain -= 1; if (remain <= 0) { clearInterval(iv); overlay.remove(); } else overlay.textContent = `締切まで: ${remain}s`;
  }, 1000);
});

socket.on('round_ended', async ({ results, spawnIndex }) => {
  stopElapsed();
  // load spawn to get coords
  await loadSpawns();
  const spawn = spawnList[spawnIndex % spawnList.length];
  // animate a result map sliding up and zooming
  const rmapEl = document.getElementById('result-map');
  // clear previous result map layers if any
  rmapEl.innerHTML = '';
  rmapEl.classList.add('show');
  resultMapLayers = [];
  // hide guess small map to focus on result
  const smallEl = document.querySelector('.small-map'); if (smallEl) smallEl.style.display = 'none';
  // create leaflet map inside result-map
  if (resultMap) { resultMap.remove(); resultMap = null; }
  resultMap = L.map('result-map', { zoomControl: true, attributionControl: false }).setView([spawn.lat, spawn.lng], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OSM contributors' }).addTo(resultMap);

  // prepare guesses data but DON'T add markers yet - delay until after zoom animation
  // Store correct marker data to add later as well
  const bounds = [];
  const delayedMarkers = [];
  const delayedLines = [];
  const correctMarker = { lat: spawn.lat, lng: spawn.lng, color: '#ef4444', isCorrect: true };

  // Calculate team scores - find best player from each team
  const redPlayers = results.filter(r => r.team === 'red' && r.lastGuess);
  const bluePlayers = results.filter(r => r.team === 'blue' && r.lastGuess);
  
  let bestRed = null, bestBlue = null;
  let redDistance = Infinity, blueDistance = Infinity;
  
  redPlayers.forEach(r => {
    const d = calcDistance(spawn.lat, spawn.lng, r.lastGuess.lat, r.lastGuess.lng);
    if (d < redDistance) {
      redDistance = d;
      bestRed = r;
    }
  });
  
  bluePlayers.forEach(r => {
    const d = calcDistance(spawn.lat, spawn.lng, r.lastGuess.lat, r.lastGuess.lng);
    if (d < blueDistance) {
      blueDistance = d;
      bestBlue = r;
    }
  });

  // Only show markers for best players from each team
  if(bestRed && bestRed.lastGuess){
    delayedMarkers.push({ lat: bestRed.lastGuess.lat, lng: bestRed.lastGuess.lng, color: '#ef4444', name: bestRed.name });
    delayedLines.push({ from: [spawn.lat, spawn.lng], to: [bestRed.lastGuess.lat, bestRed.lastGuess.lng], color: '#ef4444' });
    bounds.push([bestRed.lastGuess.lat, bestRed.lastGuess.lng]);
    bounds.push([spawn.lat, spawn.lng]);
  }
  
  if(bestBlue && bestBlue.lastGuess){
    delayedMarkers.push({ lat: bestBlue.lastGuess.lat, lng: bestBlue.lastGuess.lng, color: '#3b82f6', name: bestBlue.name });
    delayedLines.push({ from: [spawn.lat, spawn.lng], to: [bestBlue.lastGuess.lat, bestBlue.lastGuess.lng], color: '#3b82f6' });
    bounds.push([bestBlue.lastGuess.lat, bestBlue.lastGuess.lng]);
    bounds.push([spawn.lat, spawn.lng]);
  }

  // build team ranking
  const teamRanking = [];
  if(bestRed){
    teamRanking.push({team: 'Red', distance: redDistance, player: bestRed.name, color: '#ef4444'});
  }
  if(bestBlue){
    teamRanking.push({team: 'Blue', distance: blueDistance, player: bestBlue.name, color: '#3b82f6'});
  }
  teamRanking.sort((a, b) => a.distance - b.distance);
  
  // display team ranking
  const rankEl = $('ranking-list'); rankEl.innerHTML = '';
  teamRanking.forEach((t, i) => { 
    const li = document.createElement('li'); 
    li.style.color = t.color;
    li.style.fontWeight = '700';
    li.textContent = `${i + 1}. ${t.team} チーム — ${t.distance.toFixed(2)} km (${t.player})`;
    rankEl.appendChild(li); 
  });

  // compute and populate current player's stats (distance/time/score)
  const me = results.find(r => r.id === myId);
  if (me && me.lastGuess) {
    const myDist = calcDistance(spawn.lat, spawn.lng, me.lastGuess.lat, me.lastGuess.lng);
    const myTime = me.lastGuess.time && startTime ? Math.max(0, (me.lastGuess.time - startTime) / 1000) : 0;
    const myScore = calculateScore(myDist);
    
    const distEl = $('result-distance'); 
    const timeEl = $('result-time');
    const scoreEl = $('result-score');
    
    // Set initial values to 0 for animation
    if (distEl) distEl.textContent = '0.00';
    if (timeEl) timeEl.textContent = '0.00';
    if (scoreEl) scoreEl.textContent = '0';
  } else {
    const distEl = $('result-distance'); 
    const timeEl = $('result-time');
    const scoreEl = $('result-score');
    if (distEl) distEl.textContent = '—'; 
    if (timeEl) timeEl.textContent = '—';
    if (scoreEl) scoreEl.textContent = '—';
  }

  // (drawing of connecting lines is delayed until after the map shrink/zoom completes)

  // first focus on correct spot (zoom in), then animate zoom out to include guesses
  resultMap.flyTo([spawn.lat, spawn.lng], 15, { duration: 1.2 });
  setTimeout(() => {
    if (bounds.length > 0) {
      const b = L.latLngBounds(bounds);
      resultMap.flyToBounds(b.pad(0.6), { duration: 2.2 });
    } else {
      resultMap.flyTo([spawn.lat, spawn.lng], 6, { duration: 1.2 });
    }
  }, 1200);

  // after zoom animation completes, add markers and show stats (NO map shrinking)
  setTimeout(() => {
    // NOW add the correct marker first
    const corr = L.circleMarker([correctMarker.lat, correctMarker.lng], { radius: 4, color: correctMarker.color, fillColor: correctMarker.color, fillOpacity: 1 }).addTo(resultMap);
    resultMapLayers.push(corr);

    // Then add the player markers after zoom is complete
    delayedMarkers.forEach(dm => {
      const m = L.circleMarker([dm.lat, dm.lng], { radius: 6, color: dm.color, fillColor: dm.color, fillOpacity: 1 }).addTo(resultMap);
      resultMapLayers.push(m);
    });

    // show result panel with drop-in text
    const panel = $('result-panel'); panel.classList.add('show');
    anime({ targets: panel, top: [-400, 80], opacity: [0, 1], duration: 900, easing: 'easeOutExpo' });
    
    // Animate numbers with counter effect
    const me = results.find(r => r.id === myId);
    if (me && me.lastGuess) {
      const myDist = calcDistance(spawn.lat, spawn.lng, me.lastGuess.lat, me.lastGuess.lng);
      const myTime = me.lastGuess.time && startTime ? Math.max(0, (me.lastGuess.time - startTime) / 1000) : 0;
      const myScore = calculateScore(myDist);
      
      setTimeout(() => {
        const distEl = $('result-distance');
        const timeEl = $('result-time');
        const scoreEl = $('result-score');
        
        if (distEl) animateNumber(distEl, 0, myDist, 1200, 2);
        if (timeEl) animateNumber(timeEl, 0, myTime, 1200, 2);
        if (scoreEl) animateNumber(scoreEl, 0, myScore, 1500, 0);
      }, 400);
    }

    // draw delayed distance lines now that zoom is complete - with dashed style
    setTimeout(() => {
      delayedLines.forEach(dl => {
        const line = L.polyline([dl.from, dl.to], { color: dl.color, weight: 3, opacity: 0.9, dashArray: '10, 10', interactive: false, renderer: L.canvas() }).addTo(resultMap);
        resultMapLayers.push(line);
      });
    }, 300);

    // show host next button (floating) and enable main host next as well
    if (isHost) {
      $('next-round').disabled = false;
      const h = document.getElementById('host-next'); if (h) { h.style.display = 'inline-block'; h.disabled = false; }
    }
  }, 3800);
});

socket.on('round_ready', () => {
  // host ended previous and now ready to start
  // Remove round-active class to restore UI
  document.body.classList.remove('round-active');
  document.querySelectorAll('#join-form, .host-only').forEach(el => el.style.display = 'block');
  $('next-round').disabled = true;
  const panel = $('result-panel'); panel.classList.remove('show');
  // restore UI
  const smallEl = document.querySelector('.small-map'); if (smallEl) smallEl.style.display = '';
  // (no global blur/overlay needed) 
  const rmapEl = document.getElementById('result-map'); rmapEl.classList.remove('show'); rmapEl.innerHTML = '';
  if (resultMap) { resultMap.remove(); resultMap = null; }
  // reset guessed and players state
  guessedMap = {}; playersState = {}; resultMapLayers = [];
  // reset UI highlights and attempt display
  const rows = document.querySelectorAll('#lobby-players .player-row'); rows.forEach(r => { r.classList.remove('guessed', 'pulse-highlight', 'flash-red'); const st = r.querySelector('.status'); if (st) st.textContent = ''; });
  const a = document.getElementById('attempts-left'); if (a) a.textContent = '2';
  submitLocked = false; $('submit').disabled = false;
});

socket.on('disconnect', () => { alert('サーバーから切断されました'); });

// helpers
function calcDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; const toRad = x => x * Math.PI / 180; const dLat = toRad(lat2 - lat1); const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

window.addEventListener('load', async () => { await loadSpawns(); initSmallMap(); setRoomInfo(); });
