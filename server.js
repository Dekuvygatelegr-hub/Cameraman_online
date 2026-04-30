// ══════════════════════════════════════════════════════════════════
// CAMERAMAN: ONLINE — Authoritative Game Server v2.0
// Server owns: enemy AI, waves, damage, ability validation
// Clients own: rendering, input, character animation
// ══════════════════════════════════════════════════════════════════
'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');
const fs   = require('fs');
const path = require('path');

const PORT     = process.env.PORT || 3000;
const TICK_MS  = 50;   // 20 ticks/s
const SNAP_MS  = 100;  // send enemy snapshot every 100ms (10/s)

// ══════════════════════════════════════════════════════════════════
// ENEMY TYPE DATABASE
// ══════════════════════════════════════════════════════════════════
const ENEMY_DEF = {
  // ── Точные значения из исходного кода клиента ──
  normal:             { hp:100,   spd:2.8,  meleeDmg:10,  range:2.2,  atkRate:2.0, reward:10,   size:1.0, type:'ground' },
  large:              { hp:150,   spd:1.8,  meleeDmg:30,  range:3.2,  atkRate:3.0, reward:15,   size:2.0, type:'ground' },
  big:                { hp:300,   spd:1.2,  meleeDmg:50,  range:3.5,  atkRate:3.5, reward:40,   size:2.5, type:'ground' },
  strider:            { hp:250,   spd:4.2,  meleeDmg:50,  range:4.0,  atkRate:3.0, reward:50,   size:1.8, type:'ground' },
  gun:                { hp:80,    spd:2.8,  meleeDmg:10,  range:12.0, atkRate:2.0, reward:18,   size:1.0, type:'ranged', projSpd:22 },
  headphones:         { hp:120,   spd:2.8,  meleeDmg:10,  range:2.2,  atkRate:2.0, reward:15,   size:1.0, type:'ground' },
  headphones_glasses: { hp:150,   spd:2.8,  meleeDmg:10,  range:2.2,  atkRate:2.0, reward:20,   size:1.0, type:'ground' },
  jetpack:            { hp:130,   spd:5.5,  meleeDmg:25,  range:3.0,  atkRate:2.0, reward:25,   size:1.0, type:'flying' },
  titan:              { hp:1250,  spd:0.8,  meleeDmg:90,  range:4.0,  atkRate:5.0, reward:100,  size:4.0, type:'ground' },
  g_toilet:           { hp:8000,  spd:1.0,  meleeDmg:200, range:6.0,  atkRate:3.0, reward:1000, size:1.5, type:'ground', special:'laser' },
  heli:               { hp:150,   spd:3.8,  meleeDmg:0,   range:0,    atkRate:99,  reward:20,   size:1.2, type:'flying' },
  black:              { hp:150,   spd:3.2,  meleeDmg:15,  range:1.8,  atkRate:1.6, reward:20,   size:1.0, type:'ground' },
  black_large:        { hp:250,   spd:2.2,  meleeDmg:40,  range:3.6,  atkRate:1.6, reward:35,   size:2.0, type:'ground' },
  black_titan:        { hp:1500,  spd:1.2,  meleeDmg:250, range:3.0,  atkRate:2.5, reward:150,  size:4.2, type:'ground' },
  kamikaze:           { hp:250,   spd:0,    meleeDmg:1500,range:8.0,  atkRate:99,  reward:15,   size:2.8, type:'ground', special:'explode' },
  elite_mutant_titan: { hp:15000, spd:1.0,  meleeDmg:200, range:5.5,  atkRate:3.0, reward:2000, size:5.0, type:'ground', special:'multiattack' },
};

// ══════════════════════════════════════════════════════════════════
// WAVE DEFINITIONS  (M1 = 10 waves, M2 = 5 waves)
// ══════════════════════════════════════════════════════════════════
const WAVE_DEF = {
  m1: [
    null, // 0 unused
    /* 1 */ [{ t:'normal',   n:6 }],
    /* 2 */ [{ t:'normal',   n:8 },  { t:'black',  n:2 }],
    /* 3 */ [{ t:'normal',   n:6 },  { t:'black',  n:4 }, { t:'strider', n:2 }],
    /* 4 */ [{ t:'large',    n:3 },  { t:'normal', n:8 }, { t:'gun',     n:3 }],
    /* 5 */ [{ t:'black',    n:6 },  { t:'large',  n:4 }, { t:'strider', n:4 }, { t:'kamikaze', n:3 }],
    /* 6 */ [{ t:'big',      n:2 },  { t:'black',  n:8 }, { t:'gun',     n:5 }, { t:'heli',     n:2 }],
    /* 7 */ [{ t:'black_large', n:4 }, { t:'big',  n:2 }, { t:'jetpack', n:4 }, { t:'g_toilet', n:1 }],
    /* 8 */ [{ t:'titan',   n:1 },   { t:'black_large',n:5 }, { t:'headphones',n:6 }, { t:'kamikaze',n:4 }],
    /* 9 */ [{ t:'titan',   n:2 },   { t:'black_titan',n:1 }, { t:'g_toilet',n:2 }, { t:'elite_mutant_titan',n:0 }, { t:'headphones_glasses',n:6 }],
    /* 10*/ [{ t:'black_titan',n:2 },{ t:'elite_mutant_titan',n:1 }, { t:'g_toilet',n:3 }, { t:'titan',n:2 }, { t:'kamikaze',n:6 }],
  ],
  m2: [
    null,
    /* 1 */ [{ t:'normal',   n:8 },  { t:'strider', n:3 }],
    /* 2 */ [{ t:'gun',      n:6 },  { t:'black',   n:5 }, { t:'jetpack', n:3 }],
    /* 3 */ [{ t:'large',    n:4 },  { t:'black',   n:8 }, { t:'heli',    n:3 }, { t:'kamikaze',n:4 }],
    /* 4 */ [{ t:'black_large',n:4 },{ t:'big',     n:2 }, { t:'g_toilet',n:2 }, { t:'headphones_glasses',n:6 }],
    /* 5 */ [{ t:'elite_mutant_titan',n:1 }, { t:'black_titan',n:1 }, { t:'big',n:3 }, { t:'kamikaze',n:8 }],
  ],
};

// Spawn rings around core (M1) or specific points (M2)
const M1_CORE   = { x:0,   z:0 };
const SPAWN_RADIUS = 65;
const M2_SPAWNS = [
  { x:-40, z:-40 }, { x:40, z:-40 }, { x:0, z:-55 },
  { x:-40, z:40  }, { x:40, z:40  },
];

// ══════════════════════════════════════════════════════════════════
// CHARACTER ABILITY DATABASE
// ══════════════════════════════════════════════════════════════════
const ABILITY_DEF = {
  // ── Точные значения из исходного кода клиента ──

  // Camera Man
  punch:           { dmg:10,   range:2.2,  aoe:false, type:'melee'  },
  blaster:         { dmg:250,  range:30,   aoe:true,  aoeR:4.5, type:'ray', width:1.0 },
  baton:           { dmg:80,   range:3.0,  aoe:false, type:'melee', stun:5.0 },
  rocket:          { dmg:400,  range:35,   aoe:true,  aoeR:5,   type:'projectile' },
  dropkick:        { dmg:80,   range:5.0,  aoe:false, type:'melee' },

  // Speaker Man
  sound_wave:      { dmg:100,  range:14,   aoe:true,  aoeR:10,  type:'projectile' }, // expanding ring, 100dmg on contact
  // TV Man (no server dmg — effects are client-visual only, stun handled server-side)
  blue_screen:     { dmg:0,    range:10,   aoe:true,  aoeR:10,  type:'radial', stun:5.0 },
  red_screen:      { dmg:0,    range:10,   aoe:true,  aoeR:10,  type:'radial' }, // visual only on server

  // Large Camera Man
  giant_punch:     { dmg:30,   range:4.3,  aoe:true,  aoeR:3.0, type:'cone'   }, // 30 per hit, wider cone
  lcm_stomp:       { dmg:180,  range:5.0,  aoe:true,  aoeR:5.0, type:'radial' }, // 180 for small, 90 for large
  lcm_grab:        { dmg:200,  range:5.0,  aoe:false, type:'melee' },

  // Large Speaker Man
  mega_wave:       { dmg:150,  range:20,   aoe:true,  aoeR:16,  type:'projectile' }, // 3 rings × 150
  lsm_stomp:       { dmg:60,   range:4.0,  aoe:true,  aoeR:4.0, type:'radial' },
  lsm_punch:       { dmg:50,   range:2.5,  aoe:false, type:'melee' },

  // Speaker Woman
  knives:          { dmg:80,   range:16,   aoe:false, type:'ray', width:1.0 }, // 80 + bleed per knife
  sw_wave:         { dmg:100,  range:12,   aoe:true,  aoeR:9,   type:'radial' },
  sw_reflect:      { dmg:0,    range:0,    aoe:false, type:'buff', duration:4.0 },

  // Large TV Man
  radiation:       { dmg:50,   range:12,   aoe:true,  aoeR:12,  type:'radial', dps:true }, // 50/tick, 150/tick extended
  ltm_grab:        { dmg:150,  range:5.5,  aoe:false, type:'melee' },
  ltm_stomp:       { dmg:120,  range:7.0,  aoe:true,  aoeR:7.0, type:'radial' },

  // Speaker Helicopter
  heli_wave:       { dmg:100,  range:18,   aoe:true,  aoeR:14,  type:'radial' },
  heli_missile:    { dmg:300,  range:40,   aoe:true,  aoeR:6,   type:'projectile' },

  // Titan Camera Man
  tcm_laser:       { dmg:2,    range:50,   aoe:false, type:'ray', width:1.5, dps:true, interval:0.2 }, // 2dmg/0.2s to player
  tcm_crush:       { dmg:500,  range:6.0,  aoe:true,  aoeR:6.0, type:'radial' },
  tcm_stomp:       { dmg:60,   range:5.0,  aoe:true,  aoeR:5.0, type:'radial' },

  // Titan Speaker Man
  tsm_sonic:       { dmg:400,  range:22,   aoe:true,  aoeR:18,  type:'radial' }, // tsmForwardWave 8×50
  tsm_front_wave:  { dmg:500,  range:18,   aoe:true,  aoeR:10,  type:'cone'   }, // single wave 500dmg
  tsm_scream:      { dmg:187,  range:16,   aoe:true,  aoeR:14,  type:'radial' }, // 8 waves × 187 = ~1500
  tsm_blast:       { dmg:150,  range:35,   aoe:false, type:'ray', width:1.2 },
};

// ══════════════════════════════════════════════════════════════════
// ROOM STATE
// ══════════════════════════════════════════════════════════════════
const rooms   = {};
const clients = {};
let   _eidCounter = 0;

function makeRoom(code, mission, isOpen) {
  return {
    code, mission: mission || 1, isOpen: !!isOpen,
    players:    {},   // id → { id, x, z, hp, maxHp, char, role, lives, ... }
    enemies:    {},   // eid → EnemyState
    projectiles:[],   // active server projectiles
    wave: 0, waveActive: false, waveTimer: 0, betweenWaves: true,
    gameover: false, inGame: false,
    hostId: null, createdAt: Date.now(),
    _tickHandle: null, _snapHandle: null,
    _spawnQueue: [],   // enemies waiting to spawn (staggered)
    _spawnTimer: 0,
    _snapDirty: false,
    lastTick: Date.now(),
  };
}

// ══════════════════════════════════════════════════════════════════
// ENEMY STATE
// ══════════════════════════════════════════════════════════════════
function makeEnemy(type, x, z) {
  const def = ENEMY_DEF[type] || ENEMY_DEF.normal;
  return {
    id:    ++_eidCounter,
    type,
    x, z,
    vx:0, vz:0,
    hp:    def.hp, maxHp: def.hp,
    state: 'chase',   // chase | attack | dead | stunned
    targetId: null,
    atkTimer:  0,
    stunTimer: 0,
    def,
    dead:  false,
  };
}

// ══════════════════════════════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════════════════════════════
function dist2(ax,az,bx,bz){ const dx=ax-bx,dz=az-bz; return dx*dx+dz*dz; }
function dist(ax,az,bx,bz){ return Math.sqrt(dist2(ax,az,bx,bz)); }
function rnd(min,max){ return min+Math.random()*(max-min); }
function randAngle(){ return Math.random()*Math.PI*2; }

function broadcast(room, msg, excludeId) {
  const str = JSON.stringify(msg);
  Object.keys(room.players).forEach(id => {
    if (id === excludeId) return;
    const c = clients[id];
    if (c && c.ws.readyState === 1) c.ws.send(str);
  });
}
function broadcastAll(room, msg){ broadcast(room, msg, null); }
function sendTo(id, msg){
  const c = clients[id];
  if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
}

// ══════════════════════════════════════════════════════════════════
// WAVE SPAWNER
// ══════════════════════════════════════════════════════════════════
function startWave(room) {
  const wdefs = WAVE_DEF[`m${room.mission}`];
  if (!wdefs || !wdefs[room.wave]) return;
  room.betweenWaves = false;
  room.waveActive   = true;
  room._spawnQueue  = [];
  room._spawnTimer  = 0;

  // Build spawn queue
  wdefs[room.wave].forEach(entry => {
    for (let i = 0; i < entry.n; i++) {
      room._spawnQueue.push(entry.t);
    }
  });
  // Shuffle
  for (let i = room._spawnQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [room._spawnQueue[i], room._spawnQueue[j]] = [room._spawnQueue[j], room._spawnQueue[i]];
  }

  broadcastAll(room, {
    type: 'wave_started',
    data: { wave: room.wave, total: room._spawnQueue.length }
  });
  room._snapDirty = true;
}

function spawnEnemy(room, eType) {
  let sx, sz;
  if (room.mission === 1) {
    const a = randAngle();
    sx = M1_CORE.x + Math.cos(a) * SPAWN_RADIUS;
    sz = M1_CORE.z + Math.sin(a) * SPAWN_RADIUS;
  } else {
    const sp = M2_SPAWNS[Math.floor(Math.random() * M2_SPAWNS.length)];
    sx = sp.x + rnd(-5, 5);
    sz = sp.z + rnd(-5, 5);
  }
  const e = makeEnemy(eType, sx, sz);
  room.enemies[e.id] = e;
  broadcastAll(room, { type: 'enemy_spawned', data: _serEnemy(e) });
  room._snapDirty = true;
  return e;
}

function _serEnemy(e) {
  return {
    id: e.id, type: e.type,
    x: Math.round(e.x*100)/100,
    z: Math.round(e.z*100)/100,
    hp: e.hp, maxHp: e.maxHp,
    state: e.state,
    targetId: e.targetId,
  };
}

function checkWaveComplete(room) {
  if (!room.waveActive) return;
  if (room._spawnQueue.length > 0) return;
  if (Object.keys(room.enemies).length > 0) return;
  // Wave done
  room.waveActive = false;
  room.betweenWaves = true;
  room.waveTimer = 5000; // 5 sec break
  broadcastAll(room, { type: 'wave_complete', data: { wave: room.wave } });
  room.wave++;
  const maxWave = room.mission === 1 ? 10 : 5;
  if (room.wave > maxWave) {
    room.wave = maxWave;
    broadcastAll(room, { type: 'game_won', data: { mission: room.mission } });
  }
}

// ══════════════════════════════════════════════════════════════════
// ENEMY AI TICK
// ══════════════════════════════════════════════════════════════════
function tickEnemy(e, room, dt) {
  if (e.dead) return;
  if (e.state === 'dead') return;

  // Stun
  if (e.stunTimer > 0) {
    e.stunTimer -= dt;
    e.state = 'stunned';
    return;
  } else if (e.state === 'stunned') {
    e.state = 'chase';
  }

  // Find nearest alive player
  let nearDist = Infinity, nearPlayer = null;
  Object.values(room.players).forEach(p => {
    if (!p.x && p.x !== 0) return;
    if (p.hp <= 0) return;
    const d = dist(e.x, e.z, p.x, p.z);
    if (d < nearDist) { nearDist = d; nearPlayer = p; }
  });

  // If no players — move toward core
  if (!nearPlayer) {
    const dx = M1_CORE.x - e.x, dz = M1_CORE.z - e.z;
    const d = Math.sqrt(dx*dx+dz*dz);
    if (d > 2) {
      e.x += (dx/d)*e.def.spd*dt;
      e.z += (dz/d)*e.def.spd*dt;
    }
    return;
  }

  e.targetId = nearPlayer.id;

  const def = e.def;
  const attackRange = def.range;

  if (nearDist <= attackRange) {
    // Attack
    e.state = 'attack';
    e.atkTimer -= dt;
    if (e.atkTimer <= 0) {
      e.atkTimer = def.atkRate;

      // Kamikaze — explode
      if (def.special === 'explode') {
        // Damage all players in radius 6
        Object.values(room.players).forEach(p => {
          const pd = dist(e.x, e.z, p.x || 0, p.z || 0);
          if (pd <= 6) {
            sendTo(p.id, { type: 'player_damage', data: { targetId: p.id, dmg: def.meleeDmg, eid: e.id, eType: e.type } });
          }
        });
        killEnemy(e, room, null);
        return;
      }

      // Normal attack — target player
      sendTo(nearPlayer.id, {
        type: 'player_damage',
        data: { targetId: nearPlayer.id, dmg: def.meleeDmg, eid: e.id, eType: e.type }
      });

      // G-Toilet laser
      if (def.special === 'laser' && Math.random() < 0.3) {
        sendTo(nearPlayer.id, {
          type: 'player_damage',
          data: { targetId: nearPlayer.id, dmg: 50, eid: e.id, eType: 'g_laser' }
        });
      }
    }
  } else {
    // Chase
    e.state = 'chase';
    const dx = nearPlayer.x - e.x, dz = nearPlayer.z - e.z;
    const d = Math.sqrt(dx*dx+dz*dz);
    if (d > 0.1) {
      const spd = e.def.type === 'flying' ? e.def.spd * 1.2 : e.def.spd;
      e.x += (dx/d)*spd*dt;
      e.z += (dz/d)*spd*dt;
    }
  }
}

function killEnemy(e, room, killerId) {
  if (e.dead) return;
  e.dead = true; e.state = 'dead';
  delete room.enemies[e.id];
  const reward = e.def.reward;
  broadcastAll(room, { type: 'enemy_killed', data: { eid: e.id, killerId, reward, eType: e.type } });
  // Give money to killer
  if (killerId) {
    sendTo(killerId, { type: 'money_reward', data: { amount: reward } });
  }
  room._snapDirty = true;
  checkWaveComplete(room);
}

// ══════════════════════════════════════════════════════════════════
// ABILITY PROCESSING (server-side hit detection)
// ══════════════════════════════════════════════════════════════════
function processAbility(room, playerId, abilityType, px, pz, dirX, dirZ) {
  const adef = ABILITY_DEF[abilityType];
  if (!adef) return;

  const hits = [];

  Object.values(room.enemies).forEach(e => {
    if (e.dead) return;
    const d = dist(px, pz, e.x, e.z);
    let hit = false;

    if (adef.aoe && adef.type === 'radial') {
      hit = d <= (adef.aoeR || adef.range);

    } else if (adef.type === 'ray' || adef.type === 'projectile') {
      // Ray/line check: project enemy onto ray
      if (d <= adef.range) {
        const ex = e.x - px, ez = e.z - pz;
        const dl = dirX * ex + dirZ * ez; // dot product (project onto dir)
        if (dl > 0) {
          const cx = px + dirX * dl - e.x;
          const cz = pz + dirZ * dl - e.z;
          const perpDist = Math.sqrt(cx*cx + cz*cz);
          const w = adef.width || 1.0;
          hit = perpDist <= (w + (e.def.size || 1.0) * 0.5);
        }
      }

    } else if (adef.type === 'cone') {
      if (d <= (adef.aoeR || adef.range)) {
        const ex = (e.x - px) / d, ez = (e.z - pz) / d;
        const dot = dirX * ex + dirZ * ez;
        hit = dot > 0.5; // ~60° half-angle
      }

    } else if (adef.type === 'melee') {
      hit = d <= adef.range;
    }

    if (hit) {
      let dmg = adef.dmg;
      // Apply damage
      e.hp -= dmg;
      hits.push({ eid: e.id, dmg, hp: e.hp });
      if (adef.stun && adef.stun > 0) e.stunTimer = adef.stun;
      if (e.hp <= 0) {
        killEnemy(e, room, playerId);
      }
    }
  });

  // Handle 'count' abilities (knives — multiple rays)
  if (adef.count && adef.count > 1 && adef.type === 'ray') {
    const spread = adef.spread || 0.2;
    for (let k = 1; k < adef.count; k++) {
      const angle = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * spread;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const ndx = dirX * cos - dirZ * sin;
      const ndz = dirX * sin + dirZ * cos;
      processAbility(room, playerId, abilityType + '_sub', px, pz, ndx, ndz);
    }
  }

  if (hits.length > 0) {
    sendTo(playerId, { type: 'ability_result', data: { ability: abilityType, hits } });
    room._snapDirty = true;
  }
}

// ══════════════════════════════════════════════════════════════════
// GAME LOOP PER ROOM
// ══════════════════════════════════════════════════════════════════
function startRoomLoop(room) {
  if (room._tickHandle) return;

  room._tickHandle = setInterval(() => {
    if (!room.inGame) return;
    const now = Date.now();
    const dt  = Math.min((now - room.lastTick) / 1000, 0.1);
    room.lastTick = now;

    // --- Wave timer (between waves) ---
    if (room.betweenWaves && room.inGame) {
      room.waveTimer -= dt * 1000;
      if (room.waveTimer <= 0) {
        startWave(room);
      }
    }

    // --- Spawn queue (stagger spawns every 0.4s) ---
    if (room._spawnQueue.length > 0) {
      room._spawnTimer -= dt;
      if (room._spawnTimer <= 0) {
        room._spawnTimer = 0.4;
        const eType = room._spawnQueue.shift();
        spawnEnemy(room, eType);
      }
    }

    // --- Enemy AI ---
    Object.values(room.enemies).forEach(e => tickEnemy(e, room, dt));

    room._snapDirty = true;
  }, TICK_MS);

  // Snapshot broadcast (less frequent)
  room._snapHandle = setInterval(() => {
    if (!room.inGame || !room._snapDirty) return;
    room._snapDirty = false;
    const snap = Object.values(room.enemies).map(_serEnemy);
    broadcastAll(room, { type: 'enemy_state', data: { enemies: snap, wave: room.wave, active: room.waveActive } });
  }, SNAP_MS);
}

function stopRoomLoop(room) {
  if (room._tickHandle) { clearInterval(room._tickHandle); room._tickHandle = null; }
  if (room._snapHandle) { clearInterval(room._snapHandle); room._snapHandle = null; }
}

// ══════════════════════════════════════════════════════════════════
// HTTP SERVER
// ══════════════════════════════════════════════════════════════════
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
    const names = ['index.html', 'cameraman1_5alpha_online.html'];
    let found = false;
    for (const name of names) {
      const fp = path.join(__dirname, name);
      if (fs.existsSync(fp)) {
        fs.readFile(fp, (err, data) => {
          if (err) { res.writeHead(500); res.end('Error'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(data);
        });
        found = true; break;
      }
    }
    if (!found) { res.writeHead(404); res.end('Game file not found'); }
  }
});

// ══════════════════════════════════════════════════════════════════
// WEBSOCKET
// ══════════════════════════════════════════════════════════════════
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let myId   = null;
  let myRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const { type, data } = msg;

    switch (type) {

      // ── Create room ──
      case 'create_room': {
        myId = data.id;
        const code = data.code || _genCode();
        const room = makeRoom(code, data.mission, data.isOpen);
        room.hostId = myId;
        rooms[code]  = room;
        myRoom       = room;
        clients[myId]= { ws, roomCode: code };
        room.players[myId] = { ...data.player, id: myId, isHost: true, hp: 100, maxHp: 100, lives: 3 };
        ws.send(JSON.stringify({ type: 'room_created', data: { code, mission: room.mission } }));
        break;
      }

      // ── Join room ──
      case 'join_room': {
        myId = data.id;
        const room = rooms[data.code];
        if (!room) { ws.send(JSON.stringify({ type: 'error', data: { msg: 'Room not found' } })); return; }
        myRoom = room;
        clients[myId] = { ws, roomCode: data.code };
        room.players[myId] = { ...data.player, id: myId, isHost: false, hp: 100, maxHp: 100, lives: 3 };
        ws.send(JSON.stringify({
          type: 'room_state',
          data: {
            players:   Object.values(room.players),
            mission:   room.mission,
            wave:      room.wave,
            waveActive:room.waveActive,
            enemies:   Object.values(room.enemies).map(_serEnemy),
            inGame:    room.inGame || false,
          }
        }));
        broadcast(room, { type: 'player_joined', data: room.players[myId] }, myId);
        break;
      }

      // ── Player position update ──
      case 'player_pos': {
        if (!myRoom || !myId) return;
        const p = myRoom.players[myId];
        if (p) Object.assign(p, data);
        broadcast(myRoom, { type: 'player_pos', data: { ...data, id: myId } }, myId);
        break;
      }

      // ── Player HP update (client reports own HP) ──
      case 'player_hp': {
        if (!myRoom || !myId) return;
        if (myRoom.players[myId]) myRoom.players[myId].hp = data.hp;
        break;
      }

      // ── Role change ──
      case 'player_role': {
        if (!myRoom || !myId) return;
        if (myRoom.players[myId]) myRoom.players[myId].role = data.role;
        broadcast(myRoom, { type: 'player_role', data: { id: myId, role: data.role } }, myId);
        break;
      }

      // ── Game start (any player can trigger) ──
      case 'game_start': {
        if (!myRoom) return;
        myRoom.inGame     = true;
        myRoom.wave       = 1;
        myRoom.betweenWaves= true;
        myRoom.waveTimer  = 3000; // 3s before first wave
        myRoom.lastTick   = Date.now();
        startRoomLoop(myRoom);
        broadcastAll(myRoom, { type: 'game_start', data: { mission: myRoom.mission } });
        break;
      }

      // ── ABILITY USE — server validates hit, applies damage ──
      case 'ability_use': {
        if (!myRoom || !myId) return;
        const { ability, px, pz, dirX, dirZ } = data;
        processAbility(myRoom, myId, ability, px || 0, pz || 0, dirX || 0, dirZ || 1);
        // Also broadcast ability VFX to others (for animation)
        broadcast(myRoom, { type: 'ability_vfx', data: { id: myId, ability, px, pz, dirX, dirZ } }, myId);
        break;
      }

      // ── Enemy damage from client (legacy / fallback) ──
      case 'enemy_damage': {
        if (!myRoom) return;
        const e = myRoom.enemies[data.eid];
        if (!e || e.dead) return;
        e.hp -= (data.dmg || 0);
        if (e.hp <= 0) killEnemy(e, myRoom, myId);
        else myRoom._snapDirty = true;
        break;
      }

      // ── Life lost ──
      case 'player_life_lost': {
        if (!myRoom || !myId) return;
        if (myRoom.players[myId]) myRoom.players[myId].lives = data.lives;
        broadcast(myRoom, { type: 'player_life_lost', data: { ...data, id: myId } }, myId);
        // Check game over
        const allDead = Object.values(myRoom.players).every(p => (p.lives || 0) <= 0);
        if (allDead && myRoom.inGame) {
          myRoom.gameover = true; myRoom.inGame = false;
          stopRoomLoop(myRoom);
          broadcastAll(myRoom, { type: 'game_over', data: { wave: myRoom.wave } });
        }
        break;
      }

      // ── Player damage from enemy (client applies, server tracks) ──
      case 'player_damage': {
        if (!myRoom) return;
        sendTo(data.targetId, { type: 'player_damage', data });
        break;
      }

      // ── Commander actions ──
      case 'cmd_action': {
        if (!myRoom) return;
        broadcast(myRoom, { type: 'cmd_action', data: { ...data, id: myId } }, myId);
        break;
      }
      case 'cmd_money': {
        if (!myRoom) return;
        broadcast(myRoom, { type: 'cmd_money', data }, myId);
        break;
      }
      case 'kill_reward': {
        if (!myRoom) return;
        Object.entries(myRoom.players).forEach(([id, p]) => {
          if (p.role === 'commander') sendTo(id, { type: 'kill_reward', data });
        });
        break;
      }

      // ── Ally/turret actions relay ──
      case 'ally_action': {
        if (!myRoom) return;
        broadcast(myRoom, { type: 'ally_action', data: { ...data, id: myId } }, myId);
        break;
      }

      // ── Chat ──
      case 'chat': {
        if (!myRoom) return;
        broadcast(myRoom, { type: 'chat', data: { ...data, id: myId } }, myId);
        break;
      }

      // ── Wave sync (client request to advance wave) ──
      case 'wave_sync': {
        if (!myRoom) return;
        // Only relay if client is reporting completion (server manages waves, but accept override)
        broadcastAll(myRoom, { type: 'wave_sync', data: { wave: myRoom.wave, active: myRoom.waveActive } });
        break;
      }

      // ── Leave room ──
      case 'leave_room': {
        _handleLeave(myId, myRoom);
        myRoom = null; myId = null;
        break;
      }

      // ── Ping ──
      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong', data: { t: data.t } }));
        break;
      }
    }
  });

  ws.on('close', () => { if (myId) _handleLeave(myId, myRoom); });
});

// ══════════════════════════════════════════════════════════════════
// LEAVE / HOST TRANSFER
// ══════════════════════════════════════════════════════════════════
function _handleLeave(id, room) {
  if (!id) return;
  delete clients[id];
  if (!room) return;
  delete room.players[id];
  broadcast(room, { type: 'player_left', data: { id } }, id);
  if (room.hostId === id) {
    const remaining = Object.keys(room.players);
    if (remaining.length > 0) {
      room.hostId = remaining[0];
      room.players[remaining[0]].isHost = true;
      sendTo(remaining[0], { type: 'you_are_host', data: {} });
      broadcast(room, { type: 'new_host', data: { id: remaining[0] } }, remaining[0]);
    } else {
      stopRoomLoop(room);
      delete rooms[room.code];
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// CLEANUP
// ══════════════════════════════════════════════════════════════════
function _genCode() {
  const C = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => C[Math.floor(Math.random() * C.length)]).join('');
}

setInterval(() => {
  const now = Date.now();
  Object.entries(rooms).forEach(([code, room]) => {
    if (Object.keys(room.players).length === 0 && now - room.createdAt > 300000) {
      stopRoomLoop(room);
      delete rooms[code];
    }
  });
}, 300000);

server.listen(PORT, () => {
  console.log(`CAMERAMAN SERVER v2.0 — port ${PORT}`);
  console.log(`Enemies: ${Object.keys(ENEMY_DEF).length} types | Abilities: ${Object.keys(ABILITY_DEF).length} | Tick: ${TICK_MS}ms`);
});
