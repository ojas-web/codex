import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  MATCH_LENGTH_MS,
  MAX_HEALTH,
  RESPAWN_DELAY_MS,
  TEAM_A,
  TEAM_B,
  TICK_RATE,
  WEAPONS
} from '../../shared/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.resolve(__dirname, '../../client')));

const state = {
  startedAt: Date.now(),
  players: new Map(),
  projectiles: [],
  score: { [TEAM_A]: 0, [TEAM_B]: 0 }
};

const BOT_DETECTION_RADIUS = 67;
const BOT_STOP_DISTANCE = 14;
const BOT_MOVE_SPEED = 0.28;
const BOT_FIRE_RANGE = 50;
const BOT_SEPARATION_RADIUS = 6;
const BOT_SEPARATION_FORCE = 0.14;
const BOT_MAX_STEP_PER_TICK = 0.22;
const HIT_RADIUS = 2.4;

const spawnPoints = {
  [TEAM_A]: [{ x: -60, y: 2, z: -40 }, { x: -50, y: 2, z: 30 }],
  [TEAM_B]: [{ x: 60, y: 2, z: 40 }, { x: 50, y: 2, z: -30 }]
};

const teamForJoin = () => {
  let a = 0;
  let b = 0;
  for (const p of state.players.values()) p.team === TEAM_A ? a++ : b++;
  return a <= b ? TEAM_A : TEAM_B;
};

const randomSpawn = (team) => {
  const spots = spawnPoints[team];
  return spots[Math.floor(Math.random() * spots.length)];
};

const sanitizeInput = (input) => {
  if (!input) return null;
  return {
    seq: Number(input.seq) || 0,
    pos: {
      x: Number(input.pos?.x) || 0,
      y: Number(input.pos?.y) || 2,
      z: Number(input.pos?.z) || 0
    },
    rotY: Math.max(-Math.PI, Math.min(Math.PI, Number(input.rotY) || 0)),
    pitch: Math.max(-1.4, Math.min(1.4, Number(input.pitch) || 0)),
    velocity: {
      x: Number(input.velocity?.x) || 0,
      y: Number(input.velocity?.y) || 0,
      z: Number(input.velocity?.z) || 0
    },
    crouch: !!input.crouch,
    sprint: !!input.sprint,
    fire: !!input.fire,
    weapon: WEAPONS[input.weapon] ? input.weapon : 'rifle',
    timestamp: Date.now()
  };
};

const createBot = (index) => {
  const team = index % 2 ? TEAM_A : TEAM_B;
  const spawn = randomSpawn(team);
  const id = `bot-${index}`;
  state.players.set(id, {
    id,
    bot: true,
    name: `BOT_${index}`,
    team,
    alive: true,
    hp: MAX_HEALTH,
    ammo: WEAPONS.smg.magazine,
    weapon: 'smg',
    kills: 0,
    deaths: 0,
    position: { ...spawn },
    rotationY: 0,
    pitch: 0,
    velocity: { x: 0, y: 0, z: 0 },
    lastShotMs: 0,
    lastInputSeq: 0,
    respawnAt: 0
  });
};

const spawnProjectile = (shooter) => {
  const weapon = WEAPONS[shooter.weapon] || WEAPONS.rifle;
  const now = Date.now();
  if (shooter.ammo <= 0 || now - shooter.lastShotMs < weapon.fireRateMs) return;

  shooter.lastShotMs = now;
  shooter.ammo -= 1;

  state.projectiles.push({
    id: `${shooter.id}-${now}`,
    owner: shooter.id,
    team: shooter.team,
    pos: { ...shooter.position },
    dir: {
      x: Math.sin(shooter.rotationY),
      y: Math.sin(shooter.pitch) * -1,
      z: Math.cos(shooter.rotationY)
    },
    dmg: weapon.damage,
    speed: 3,
    ttl: 40
  });
};

const killPlayer = (target, ownerId) => {
  target.alive = false;
  target.deaths++;
  const killer = state.players.get(ownerId);
  if (killer) {
    killer.kills++;
    state.score[killer.team]++;
  }

  target.velocity = { x: 0, y: 0, z: 0 };
  target.respawnAt = Date.now() + RESPAWN_DELAY_MS;
};


const keepInsideArena = (entity) => {
  entity.position.x = Math.max(-92, Math.min(92, entity.position.x));
  entity.position.z = Math.max(-92, Math.min(92, entity.position.z));
};

const applyBotSeparation = (bot, bots) => {
  let pushX = 0;
  let pushZ = 0;
  for (const other of bots) {
    if (other.id === bot.id || !other.alive) continue;
    const dx = bot.position.x - other.position.x;
    const dz = bot.position.z - other.position.z;
    const distSq = dx * dx + dz * dz;
    if (!distSq || distSq > BOT_SEPARATION_RADIUS * BOT_SEPARATION_RADIUS) continue;
    const dist = Math.sqrt(distSq);
    const weight = (BOT_SEPARATION_RADIUS - dist) / BOT_SEPARATION_RADIUS;
    pushX += (dx / dist) * weight;
    pushZ += (dz / dist) * weight;
  }

  bot.position.x += pushX * BOT_SEPARATION_FORCE;
  bot.position.z += pushZ * BOT_SEPARATION_FORCE;
};

const updateBots = () => {
  const bots = [...state.players.values()].filter((p) => p.bot && p.alive);
  const aliveTargets = [...state.players.values()].filter((p) => p.alive);

  for (const bot of bots) {
    let nearest = null;
    let nearestSq = BOT_DETECTION_RADIUS * BOT_DETECTION_RADIUS;

    for (const candidate of aliveTargets) {
      if (candidate.id === bot.id || candidate.team === bot.team) continue;
      const dx = candidate.position.x - bot.position.x;
      const dz = candidate.position.z - bot.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < nearestSq) {
        nearestSq = distSq;
        nearest = candidate;
      }
    }

    if (!nearest) {
      bot.rotationY += 0.03;
      bot.velocity = { x: 0, y: 0, z: 0 };
      continue;
    }

    const dx = nearest.position.x - bot.position.x;
    const dy = nearest.position.y - bot.position.y;
    const dz = nearest.position.z - bot.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz) || 0.0001;

    bot.rotationY = Math.atan2(dx, dz);
    bot.pitch = Math.max(-0.6, Math.min(0.6, -Math.atan2(dy, dist)));

    if (dist > BOT_STOP_DISTANCE) {
      const step = Math.min(BOT_MOVE_SPEED, BOT_MAX_STEP_PER_TICK, dist - BOT_STOP_DISTANCE);
      bot.position.x += (dx / dist) * step;
      bot.position.z += (dz / dist) * step;
      bot.velocity = { x: (dx / dist) * step, y: 0, z: (dz / dist) * step };
    } else {
      bot.velocity = { x: 0, y: 0, z: 0 };
    }

    applyBotSeparation(bot, bots);
    keepInsideArena(bot);

    if (dist <= BOT_FIRE_RANGE) {
      if (bot.ammo <= 0) {
        bot.ammo = WEAPONS[bot.weapon].magazine;
      }
      spawnProjectile(bot);
    }
  }
};

for (let i = 0; i < 4; i++) createBot(i + 1);

io.on('connection', (socket) => {
  const team = teamForJoin();
  const spawn = randomSpawn(team);
  const player = {
    id: socket.id,
    bot: false,
    name: `Player-${socket.id.slice(0, 4)}`,
    team,
    alive: true,
    hp: MAX_HEALTH,
    ammo: WEAPONS.rifle.magazine,
    weapon: 'rifle',
    kills: 0,
    deaths: 0,
    position: { ...spawn },
    rotationY: 0,
    pitch: 0,
    velocity: { x: 0, y: 0, z: 0 },
    lastShotMs: 0,
    lastInputSeq: 0,
    respawnAt: 0
  };

  state.players.set(socket.id, player);
  socket.emit('welcome', { id: socket.id, team, matchStart: state.startedAt });

  socket.on('input', (rawInput) => {
    const input = sanitizeInput(rawInput);
    const p = state.players.get(socket.id);
    if (!p || !p.alive || !input) return;
    p.position = input.pos;
    p.rotationY = input.rotY;
    p.pitch = input.pitch;
    p.velocity = input.velocity;
    p.lastInputSeq = input.seq;
    p.weapon = input.weapon;

    if (input.fire) {
      spawnProjectile(p);
    }
  });

  socket.on('reload', () => {
    const p = state.players.get(socket.id);
    if (!p) return;
    p.ammo = WEAPONS[p.weapon].magazine;
  });

  socket.on('disconnect', () => state.players.delete(socket.id));
});

setInterval(() => {
  updateBots();

  for (const proj of state.projectiles) {
    proj.pos.x += proj.dir.x * proj.speed;
    proj.pos.y += proj.dir.y * proj.speed;
    proj.pos.z += proj.dir.z * proj.speed;
    proj.ttl -= 1;
    for (const target of state.players.values()) {
      if (!target.alive || target.id === proj.owner || target.team === proj.team) continue;
      const dx = proj.pos.x - target.position.x;
      const dy = proj.pos.y - target.position.y;
      const dz = proj.pos.z - target.position.z;
      if (dx * dx + dy * dy + dz * dz <= HIT_RADIUS * HIT_RADIUS) {
        target.hp -= proj.dmg;
        proj.ttl = 0;
        if (target.hp <= 0) {
          killPlayer(target, proj.owner);
        }
      }
    }
  }

  state.projectiles = state.projectiles.filter((p) => p.ttl > 0);

  for (const p of state.players.values()) {
    if (!p.alive && p.respawnAt && Date.now() >= p.respawnAt) {
      const spawn = randomSpawn(p.team);
      p.position = { ...spawn };
      p.velocity = { x: 0, y: 0, z: 0 };
      p.hp = MAX_HEALTH;
      p.ammo = WEAPONS[p.weapon].magazine;
      p.respawnAt = 0;
      p.alive = true;
    }
  }

  io.emit('snapshot', {
    t: Date.now(),
    remainingMs: Math.max(0, MATCH_LENGTH_MS - (Date.now() - state.startedAt)),
    players: [...state.players.values()],
    projectiles: state.projectiles,
    score: state.score
  });
}, 1000 / TICK_RATE);

httpServer.listen(process.env.PORT || 3000, () => {
  console.log('Neon Strike Arena server on http://localhost:3000');
});
