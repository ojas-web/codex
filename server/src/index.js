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
  WEAPONS,
  STARTING_WEAPON,
  KILL_REWARD,
  WEAPON_COSTS,
  MAP_SIZE
} from '../../shared/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.resolve(__dirname, '../../client')));

const HOUSE_RADIUS = 50;
const ZOMBIE_MELEE_RANGE = 2.6;
const ZOMBIE_MELEE_DAMAGE = 5;
const ZOMBIE_ATTACK_COOLDOWN_MS = 900;
const ZOMBIE_OBJECTIVE_RADIUS = 24;
const ZOMBIE_OBJECTIVE_THRESHOLD = 3;
const MAX_POSITION_DELTA_PER_TICK = 2.6;
const ARENA_LIMIT = MAP_SIZE / 2 - 8;
const PLAYER_HIT_RADIUS = 3.2;
const BOT_HIT_RADIUS = 5.4;

const state = {
  startedAt: Date.now(),
  players: new Map(),
  projectiles: [],
  score: { [TEAM_A]: 0, [TEAM_B]: 0 },
  gameOver: false,
  gameOverReason: ''
};

const spawnPoints = {
  [TEAM_A]: [{ x: -54, y: 2, z: -46 }, { x: -48, y: 2, z: 38 }],
  [TEAM_B]: [{ x: 54, y: 2, z: 46 }, { x: 48, y: 2, z: -38 }]
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

const canDamage = (attacker, target) => {
  if (!attacker || !target || attacker.id === target.id) return false;
  if (attacker.bot && target.bot) return false;
  if (attacker.bot) return !target.bot;
  if (target.bot) return true;
  return attacker.team !== target.team;
};

const clampToArena = (pos) => ({
  x: Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, Number(pos?.x) || 0)),
  y: Math.max(1.5, Math.min(6, Number(pos?.y) || 2)),
  z: Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, Number(pos?.z) || 0))
});

const isReasonableMove = (from, to) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  return dx * dx + dy * dy + dz * dz <= MAX_POSITION_DELTA_PER_TICK * MAX_POSITION_DELTA_PER_TICK;
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
    fire: !!input.fire,
    weapon: WEAPONS[input.weapon] ? input.weapon : STARTING_WEAPON
  };
};

const createBot = (index) => {
  const team = index % 2 ? TEAM_A : TEAM_B;
  const spawn = randomSpawn(team);
  const id = `bot-${index}`;
  state.players.set(id, {
    id,
    bot: true,
    name: `ZOMBIE_${index}`,
    team,
    alive: true,
    hp: MAX_HEALTH,
    money: 0,
    ammo: 0,
    weapon: 'fists',
    kills: 0,
    deaths: 0,
    position: { ...spawn },
    rotationY: 0,
    pitch: 0,
    velocity: { x: 0, y: 0, z: 0 },
    lastShotMs: 0,
    lastMeleeMs: 0,
    lastInputSeq: 0,
    respawnAt: 0
  });
};

const spawnProjectile = (shooter) => {
  if (shooter.bot || shooter.weapon === 'fists') return;
  const weapon = WEAPONS[shooter.weapon] || WEAPONS[STARTING_WEAPON];
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
    ttl: Math.max(18, Math.round(weapon.range / 3))
  });
};

const killPlayer = (target, ownerId) => {
  target.alive = false;
  target.deaths++;
  const killer = state.players.get(ownerId);
  if (killer) {
    killer.kills++;
    if (!killer.bot) killer.money = (killer.money || 0) + KILL_REWARD;
    state.score[killer.team]++;
  }

  target.velocity = { x: 0, y: 0, z: 0 };
  target.respawnAt = Date.now() + RESPAWN_DELAY_MS;
};

const updateBots = () => {
  const bots = [...state.players.values()].filter((p) => p.bot && p.alive);
  const aliveTargets = [...state.players.values()].filter((p) => p.alive);

  for (const bot of bots) {
    let nearest = null;
    let nearestSq = Number.MAX_SAFE_INTEGER;

    for (const candidate of aliveTargets) {
      if (candidate.id === bot.id || !canDamage(bot, candidate)) continue;
      const dx = candidate.position.x - bot.position.x;
      const dz = candidate.position.z - bot.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < nearestSq) {
        nearestSq = distSq;
        nearest = candidate;
      }
    }

    const targetPos = nearest?.position || { x: 0, y: 2, z: 0 };
    const dx = targetPos.x - bot.position.x;
    const dz = targetPos.z - bot.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz) || 0.0001;
    bot.rotationY = Math.atan2(dx, dz);

    const speed = nearest ? 0.35 : 0.22;
    bot.position.x += (dx / dist) * Math.min(speed, dist);
    bot.position.z += (dz / dist) * Math.min(speed, dist);

    if (nearest && dist <= ZOMBIE_MELEE_RANGE) {
      const now = Date.now();
      if (now - bot.lastMeleeMs >= ZOMBIE_ATTACK_COOLDOWN_MS) {
        bot.lastMeleeMs = now;
        nearest.hp -= ZOMBIE_MELEE_DAMAGE;
        if (nearest.hp <= 0) killPlayer(nearest, bot.id);
      }
    }
  }
};

const checkObjectiveFailure = () => {
  const zombiesInHouse = [...state.players.values()].filter((p) => p.bot && p.alive).filter((z) => {
    const dx = z.position.x;
    const dz = z.position.z;
    return dx * dx + dz * dz <= ZOMBIE_OBJECTIVE_RADIUS * ZOMBIE_OBJECTIVE_RADIUS;
  }).length;

  if (zombiesInHouse >= ZOMBIE_OBJECTIVE_THRESHOLD && !state.gameOver) {
    state.gameOver = true;
    state.gameOverReason = 'Zombies reached the house. Restarting match...';
    setTimeout(restartMatch, 3500);
  }
};

const restartMatch = () => {
  state.projectiles = [];
  state.score = { [TEAM_A]: 0, [TEAM_B]: 0 };
  state.startedAt = Date.now();
  state.gameOver = false;
  state.gameOverReason = '';

  let botIndex = 1;
  for (const p of state.players.values()) {
    if (p.bot) {
      const team = botIndex % 2 ? TEAM_A : TEAM_B;
      const spawn = randomSpawn(team);
      p.team = team;
      p.position = { ...spawn };
      p.hp = MAX_HEALTH;
      p.alive = true;
      p.kills = 0;
      p.deaths = 0;
      p.weapon = 'fists';
      botIndex++;
      continue;
    }

    const spawn = randomSpawn(p.team);
    p.position = { ...spawn };
    p.hp = MAX_HEALTH;
    p.alive = true;
    p.kills = 0;
    p.deaths = 0;
    p.money = 0;
    p.weapon = STARTING_WEAPON;
    p.ammo = WEAPONS[STARTING_WEAPON].magazine;
    p.respawnAt = 0;
  }
};

for (let i = 0; i < 6; i++) createBot(i + 1);

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
    money: 0,
    ammo: WEAPONS[STARTING_WEAPON].magazine,
    weapon: STARTING_WEAPON,
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
    if (!p || !p.alive || !input || state.gameOver) return;
    const clampedPos = clampToArena(input.pos);
    if (isReasonableMove(p.position, clampedPos)) p.position = clampedPos;
    p.rotationY = input.rotY;
    p.pitch = input.pitch;
    p.velocity = input.velocity;
    p.lastInputSeq = input.seq;

    if (input.fire) spawnProjectile(p);
  });

  socket.on('buyWeapon', (weaponKey) => {
    const p = state.players.get(socket.id);
    if (!p || p.bot || !WEAPONS[weaponKey]) return;
    const cost = WEAPON_COSTS[weaponKey] ?? Number.MAX_SAFE_INTEGER;
    if ((p.money || 0) < cost) return;
    p.money -= cost;
    p.weapon = weaponKey;
    p.ammo = WEAPONS[weaponKey].magazine;
  });

  socket.on('reload', () => {
    const p = state.players.get(socket.id);
    if (!p || !WEAPONS[p.weapon]) return;
    p.ammo = WEAPONS[p.weapon].magazine;
  });

  socket.on('disconnect', () => state.players.delete(socket.id));
});

setInterval(() => {
  if (!state.gameOver) {
    updateBots();

    for (const proj of state.projectiles) {
      proj.pos.x += proj.dir.x * proj.speed;
      proj.pos.y += proj.dir.y * proj.speed;
      proj.pos.z += proj.dir.z * proj.speed;
      proj.ttl -= 1;
      for (const target of state.players.values()) {
        const owner = state.players.get(proj.owner);
        if (!target.alive || !canDamage(owner, target)) continue;
        const dx = proj.pos.x - target.position.x;
        const dy = proj.pos.y - target.position.y;
        const dz = proj.pos.z - target.position.z;
        const hitRadius = target.bot ? BOT_HIT_RADIUS : PLAYER_HIT_RADIUS;
        if (dx * dx + dy * dy + dz * dz <= hitRadius * hitRadius) {
          target.hp -= proj.dmg;
          proj.ttl = 0;
          if (target.hp <= 0) killPlayer(target, proj.owner);
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
        p.ammo = WEAPONS[p.weapon]?.magazine || 0;
        p.respawnAt = 0;
        p.alive = true;
      }
    }

    checkObjectiveFailure();
  }

  io.emit('snapshot', {
    t: Date.now(),
    remainingMs: Math.max(0, MATCH_LENGTH_MS - (Date.now() - state.startedAt)),
    players: [...state.players.values()],
    projectiles: state.projectiles,
    score: state.score,
    gameOver: state.gameOver,
    gameOverReason: state.gameOverReason,
    objective: { houseRadius: HOUSE_RADIUS }
  });
}, 1000 / TICK_RATE);

httpServer.listen(process.env.PORT || 3000, () => {
  console.log('Survival server on http://localhost:3000');
});
