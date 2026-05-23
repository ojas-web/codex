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
    pos: input.pos || { x: 0, y: 2, z: 0 },
    rotY: Math.max(-Math.PI, Math.min(Math.PI, Number(input.rotY) || 0)),
    pitch: Math.max(-1.4, Math.min(1.4, Number(input.pitch) || 0)),
    velocity: input.velocity || { x: 0, y: 0, z: 0 },
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
    ammo: WEAPONS.rifle.magazine,
    weapon: 'rifle',
    kills: 0,
    deaths: 0,
    position: { ...spawn },
    rotationY: 0,
    pitch: 0,
    velocity: { x: 0, y: 0, z: 0 },
    lastShotMs: 0,
    lastInputSeq: 0
  });
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
    lastInputSeq: 0
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
      const weapon = WEAPONS[p.weapon];
      const now = Date.now();
      if (p.ammo <= 0 || now - p.lastShotMs < weapon.fireRateMs) return;
      p.lastShotMs = now;
      p.ammo -= 1;
      state.projectiles.push({
        id: `${p.id}-${now}`,
        owner: p.id,
        team: p.team,
        pos: { ...p.position },
        dir: {
          x: Math.sin(p.rotationY),
          y: Math.sin(p.pitch) * -1,
          z: Math.cos(p.rotationY)
        },
        dmg: weapon.damage,
        speed: 3,
        ttl: 40
      });
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
      if (dx * dx + dy * dy + dz * dz < 3.5) {
        target.hp -= proj.dmg;
        proj.ttl = 0;
        if (target.hp <= 0) {
          target.alive = false;
          target.deaths++;
          const killer = state.players.get(proj.owner);
          if (killer) {
            killer.kills++;
            state.score[killer.team]++;
          }
          setTimeout(() => {
            const spawn = randomSpawn(target.team);
            target.position = { ...spawn };
            target.hp = MAX_HEALTH;
            target.alive = true;
          }, RESPAWN_DELAY_MS);
        }
      }
    }
  }

  state.projectiles = state.projectiles.filter((p) => p.ttl > 0);

  const bots = [...state.players.values()].filter((p) => p.bot && p.alive);
  for (const bot of bots) {
    bot.rotationY += 0.06;
    bot.position.x += Math.sin(bot.rotationY) * 0.3;
    bot.position.z += Math.cos(bot.rotationY) * 0.3;
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
