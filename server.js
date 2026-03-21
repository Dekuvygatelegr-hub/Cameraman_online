// CAMERAMAN: ONLINE — Game Server
// Node.js WebSocket server for Replit
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════
// State
// ══════════════════════════════════════════
const rooms = {}; // roomCode → Room
const clients = {}; // clientId → {ws, roomCode, player}

function makeRoom(code, mission, isOpen) {
  return {
    code,
    mission: mission || 1,
    isOpen: !!isOpen,
    players: {}, // id → playerData
    enemies: {}, // id → enemyData
    wave: 1,
    waveActive: false,
    waveStartDelay: 3,
    gameover: false,
    hostId: null,
    createdAt: Date.now(),
  };
}

// ══════════════════════════════════════════
// HTTP server (also serves ping endpoint)
// ══════════════════════════════════════════
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/ping') {
    res.writeHead(200); res.end('pong');
  } else if (req.url === '/rooms') {
    const open = Object.values(rooms)
      .filter(r => r.isOpen && Object.keys(r.players).length > 0)
      .map(r => ({ code: r.code, mission: r.mission, players: Object.keys(r.players).length }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(open));
  } else {
    // Отдаём HTML файл игры
    const names = ['index.html', 'cameraman1_5alpha_online.html'];
    let found = false;
    for (const name of names) {
      const filePath = path.join(__dirname, name);
      if (fs.existsSync(filePath)) {
        fs.readFile(filePath, (err, data) => {
          if (err) { res.writeHead(500); res.end('Error reading file'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(data);
        });
        found = true; break;
      }
    }
    if (!found) { res.writeHead(404); res.end('Game file not found'); }
  }
});

// ══════════════════════════════════════════
// WebSocket
// ══════════════════════════════════════════
const wss = new WebSocketServer({ server });

function broadcast(room, msg, excludeId) {
  const str = JSON.stringify(msg);
  Object.entries(room.players).forEach(([id]) => {
    const c = clients[id];
    if (c && c.ws.readyState === 1 && id !== excludeId) {
      c.ws.send(str);
    }
  });
}

function broadcastAll(room, msg) {
  broadcast(room, msg, null);
}

function sendTo(clientId, msg) {
  const c = clients[clientId];
  if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  let myId = null;
  let myRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const { type, data } = msg;

    switch (type) {

      // ── Создать комнату ──
      case 'create_room': {
        myId = data.id;
        const code = data.code || _genCode();
        const room = makeRoom(code, data.mission, data.isOpen);
        room.hostId = myId;
        rooms[code] = room;
        myRoom = room;
        clients[myId] = { ws, roomCode: code };
        const p = { ...data.player, id: myId, isHost: true };
        room.players[myId] = p;
        ws.send(JSON.stringify({ type: 'room_created', data: { code, mission: room.mission } }));
        break;
      }

      // ── Войти в комнату ──
      case 'join_room': {
        myId = data.id;
        const room = rooms[data.code];
        if (!room) { ws.send(JSON.stringify({ type: 'error', data: { msg: 'Room not found' } })); return; }
        myRoom = room;
        clients[myId] = { ws, roomCode: data.code };
        const p = { ...data.player, id: myId, isHost: false };
        room.players[myId] = p;
        // Отправляем новому игроку полное состояние
        ws.send(JSON.stringify({
          type: 'room_state',
          data: {
            players: Object.values(room.players),
            mission: room.mission,
            wave: room.wave,
            waveActive: room.waveActive,
            enemies: Object.values(room.enemies),
            inGame: room.inGame || false,
          }
        }));
        // Сообщаем остальным
        broadcast(room, { type: 'player_joined', data: p }, myId);
        break;
      }

      // ── Позиция игрока ──
      case 'player_pos': {
        if (!myRoom || !myId) return;
        myRoom.players[myId] = { ...myRoom.players[myId], ...data };
        broadcast(myRoom, { type: 'player_pos', data: { ...data, id: myId } }, myId);
        break;
      }

      // ── Смена роли ──
      case 'player_role': {
        if (!myRoom || !myId) return;
        if (myRoom.players[myId]) myRoom.players[myId].role = data.role;
        broadcast(myRoom, { type: 'player_role', data: { id: myId, role: data.role } }, myId);
        break;
      }

      // ── Старт игры (только хост) ──
      case 'game_start': {
        if (!myRoom || myRoom.hostId !== myId) return;
        myRoom.inGame = true;
        broadcastAll(myRoom, { type: 'game_start', data: { mission: myRoom.mission } });
        break;
      }

      // ── Состояние врагов (от хоста) ──
      case 'enemy_state': {
        if (!myRoom || myRoom.hostId !== myId) return;
        // Обновляем состояние врагов на сервере
        const snap = data.enemies || [];
        // Убираем мёртвых
        const snapIds = new Set(snap.map(e => e.id));
        Object.keys(myRoom.enemies).forEach(id => { if (!snapIds.has(id)) delete myRoom.enemies[id]; });
        snap.forEach(e => { myRoom.enemies[e.id] = e; });
        myRoom.wave = data.wave || myRoom.wave;
        myRoom.waveActive = data.active !== undefined ? data.active : myRoom.waveActive;
        // Рассылаем всем (кроме хоста)
        broadcast(myRoom, { type: 'enemy_state', data }, myId);
        break;
      }

      // ── Урон врагу (от любого игрока → пересылаем хосту) ──
      case 'enemy_damage': {
        if (!myRoom) return;
        sendTo(myRoom.hostId, { type: 'enemy_damage', data: { ...data, fromId: myId } });
        break;
      }

      // ── Враг убит (от хоста → всем) ──
      case 'enemy_kill': {
        if (!myRoom || myRoom.hostId !== myId) return;
        delete myRoom.enemies[data.eid];
        broadcastAll(myRoom, { type: 'enemy_kill', data });
        break;
      }

      // ── Синхронизация волны ──
      case 'wave_sync': {
        if (!myRoom || myRoom.hostId !== myId) return;
        myRoom.wave = data.wave;
        myRoom.waveActive = data.active;
        broadcastAll(myRoom, { type: 'wave_sync', data });
        break;
      }

      // ── Жизнь потеряна ──
      case 'player_life_lost': {
        if (!myRoom || !myId) return;
        if (myRoom.players[myId]) myRoom.players[myId].lives = data.lives;
        broadcast(myRoom, { type: 'player_life_lost', data: { ...data, id: myId } }, myId);
        break;
      }

      // ── Урон игроку от врага (от хоста) ──
      case 'player_damage': {
        if (!myRoom || myRoom.hostId !== myId) return;
        sendTo(data.targetId, { type: 'player_damage', data });
        break;
      }

      // ── Действия командира ──
      case 'cmd_action': {
        if (!myRoom) return;
        broadcast(myRoom, { type: 'cmd_action', data: { ...data, id: myId } }, myId);
        break;
      }

      // ── Деньги командира → шутерам ──
      case 'cmd_money': {
        if (!myRoom) return;
        broadcast(myRoom, { type: 'cmd_money', data }, myId);
        break;
      }

      // ── Награда за убийство → командиру ──
      case 'kill_reward': {
        if (!myRoom) return;
        // Найти командира и отправить ему
        Object.entries(myRoom.players).forEach(([id, p]) => {
          if (p.role === 'commander') sendTo(id, { type: 'kill_reward', data });
        });
        break;
      }

      // ── Чат ──
      case 'chat': {
        if (!myRoom) return;
        broadcast(myRoom, { type: 'chat', data: { ...data, id: myId } }, myId);
        break;
      }

      // ── Выход из комнаты ──
      case 'leave_room': {
        _handleLeave(myId, myRoom);
        myRoom = null; myId = null;
        break;
      }
    }
  });

  ws.on('close', () => {
    if (myId) _handleLeave(myId, myRoom);
  });
});

function _handleLeave(id, room) {
  if (!id) return;
  delete clients[id];
  if (!room) return;
  delete room.players[id];
  broadcast(room, { type: 'player_left', data: { id } }, id);
  // Если хост ушёл — назначаем нового
  if (room.hostId === id) {
    const remaining = Object.keys(room.players);
    if (remaining.length > 0) {
      room.hostId = remaining[0];
      room.players[remaining[0]].isHost = true;
      sendTo(remaining[0], { type: 'you_are_host', data: {} });
      broadcast(room, { type: 'new_host', data: { id: remaining[0] } }, remaining[0]);
    } else {
      // Комната пустая — удаляем
      delete rooms[room.code];
    }
  }
}

function _genCode() {
  const C = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => C[Math.floor(Math.random() * C.length)]).join('');
}

// Чистим старые пустые комнаты каждые 5 минут
setInterval(() => {
  const now = Date.now();
  Object.entries(rooms).forEach(([code, room]) => {
    if (Object.keys(room.players).length === 0 && now - room.createdAt > 300000) {
      delete rooms[code];
    }
  });
}, 300000);

server.listen(PORT, () => {
  console.log(`CAMERAMAN SERVER running on port ${PORT}`);
});
