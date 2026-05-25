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

const HOUSE_RADIUS = 32;
const ZOMBIE_MELEE_RANGE = 2.6;
const ZOMBIE_MELEE_DAMAGE = 12;
const ZOMBIE_ATTACK_COOLDOWN_MS = 900;
const ZOMBIE_OBJECTIVE_RADIUS = 24;
const ZOMBIE_OBJECTIVE_THRESHOLD = 3;
const MATCH_ZOMBIE_START_DELAY_MS = 60_000;
const ZOMBIE_SPAWN_INTERVAL_MS = 40_000;
const MAX_POSITION_DELTA_PER_TICK = 2.6;
const ARENA_LIMIT = MAP_SIZE / 2 - 8;
const PLAYER_HIT_RADIUS = 3.2;
const BOT_HIT_RADIUS = 9.5;

const HOUSE_WALL_HALF = 39.4;
const HOUSE_WALL_THICKNESS = 1.2;
const HOUSE_ENTRANCE_HALF_WIDTH = 6;

const intersectsWall = (pos) => {
  const withinBandZNorth = Math.abs(pos.z + HOUSE_WALL_HALF) <= HOUSE_WALL_THICKNESS;
  const withinBandZSouth = Math.abs(pos.z - HOUSE_WALL_HALF) <= HOUSE_WALL_THICKNESS;
  const withinBandX = Math.abs(pos.x) <= HOUSE_WALL_HALF;
  if ((withinBandZNorth || withinBandZSouth) && withinBandX) {
    if (withinBandZSouth && Math.abs(pos.x) <= HOUSE_ENTRANCE_HALF_WIDTH) return false;
    return true;
  }

  const withinBandXWest = Math.abs(pos.x + HOUSE_WALL_HALF) <= HOUSE_WALL_THICKNESS;
  const withinBandXEast = Math.abs(pos.x - HOUSE_WALL_HALF) <= HOUSE_WALL_THICKNESS;
  const withinBandZ = Math.abs(pos.z) <= HOUSE_WALL_HALF;
  if ((withinBandXWest || withinBandXEast) && withinBandZ) return true;

  return false;
};

const resolveCollisionStep = (from, to) => {
  const candidate = { ...to };
  if (!intersectsWall(candidate)) return candidate;

  const xOnly = { ...to, z: from.z };
  if (!intersectsWall(xOnly)) return xOnly;

  const zOnly = { ...to, x: from.x };
  if (!intersectsWall(zOnly)) return zOnly;

  return { ...from };
};


const state = {
  startedAt: Date.now(),
  players: new Map(),
  projectiles: [],
  score: { [TEAM_A]: 0, [TEAM_B]: 0 },
  gameOver: false,
  gameOverReason: '',
  matchZombieStartAt: Date.now() + MATCH_ZOMBIE_START_DELAY_MS,
  nextZombieSpawnAt: Date.now() + MATCH_ZOMBIE_START_DELAY_MS + ZOMBIE_SPAWN_INTERVAL_MS,
  turrets: []
};

const playerSpawnPoints = {
  [TEAM_A]: [{ x: -8, y: 2, z: 8 }, { x: -5, y: 2, z: 13 }],
  [TEAM_B]: [{ x: 8, y: 2, z: 8 }, { x: 5, y: 2, z: 13 }]
};

const zombieSpawners = [
  { x: -220, y: 2, z: -220 }, { x: -220, y: 2, z: 220 }, { x: 220, y: 2, z: -220 }, { x: 220, y: 2, z: 220 },
  { x: 0, y: 2, z: -230 }, { x: -230, y: 2, z: 0 }, { x: 230, y: 2, z: 0 }
];

const teamForJoin = () => {
  let a = 0;
  let b = 0;
  for (const p of state.players.values()) p.team === TEAM_A ? a++ : b++;
  return a <= b ? TEAM_A : TEAM_B;
};

const randomSpawn = (team, forBot = false) => {
  if (forBot) return zombieSpawners[Math.floor(Math.random() * zombieSpawners.length)];
  const spots = playerSpawnPoints[team];
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

const createBot = (index, team = index % 2 ? TEAM_A : TEAM_B) => {
  const spawn = randomSpawn(team, true);
  const id = `bot-${index}`;
  state.players.set(id, {
    id,
    bot: true,
    name: `ZOMBIE_${index}`,
    team,
    alive: true,
    hp: MAX_HEALTH,
    money: 120,
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
    if (!killer.bot && !target.bot) killer.money = (killer.money || 0) + KILL_REWARD;
    state.score[killer.team]++;
  }

  target.velocity = { x: 0, y: 0, z: 0 };
  target.respawnAt = Date.now() + RESPAWN_DELAY_MS;
};

const applyProjectileHit = (target, ownerId, proj) => {
  const headshot = target.bot && proj.pos.y >= target.position.y + 1.4;
  if (headshot) {
    target.hp = 0;
  } else {
    target.hp -= proj.dmg;
  }
  if (target.hp <= 0) {
    killPlayer(target, ownerId);
    const killer = state.players.get(ownerId);
    if (killer && !killer.bot) killer.money += headshot ? 50 : 10;
  }
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
    const nextPos = {
      x: bot.position.x + (dx / dist) * Math.min(speed, dist),
      y: bot.position.y,
      z: bot.position.z + (dz / dist) * Math.min(speed, dist)
    };
    bot.position = resolveCollisionStep(bot.position, nextPos);

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
  state.matchZombieStartAt = Date.now() + MATCH_ZOMBIE_START_DELAY_MS;
  state.nextZombieSpawnAt = state.matchZombieStartAt + ZOMBIE_SPAWN_INTERVAL_MS;
  state.turrets = [];

  for (const p of [...state.players.values()]) {
    if (p.bot) state.players.delete(p.id);
  }

  for (const p of state.players.values()) {
    const spawn = randomSpawn(p.team);
    p.position = { ...spawn };
    p.hp = MAX_HEALTH;
    p.alive = true;
    p.kills = 0;
    p.deaths = 0;
    p.money = 120;
    p.weapon = STARTING_WEAPON;
    p.ammo = WEAPONS[STARTING_WEAPON].magazine;
    p.respawnAt = 0;
  }
};

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
    const collisionSafePos = resolveCollisionStep(p.position, clampedPos);
    if (isReasonableMove(p.position, collisionSafePos)) p.position = collisionSafePos;
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
  socket.on('placeTurret', (type) => {
    const p = state.players.get(socket.id);
    if (!p || !p.alive) return;
    const ownedCount = state.turrets.filter((t) => t.owner === p.id).length;
    if (ownedCount >= 2) return;
    if (state.turrets.some((t) => t.owner === p.id && t.type === type)) return;
    if (state.turrets.some((t) => (t.position.x - p.position.x) ** 2 + (t.position.z - p.position.z) ** 2 < 16)) return;
    state.turrets.push({ id: `${p.id}-${type}`, owner: p.id, type, position: { ...p.position }, cooldownAt: 0 });
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
    if (Date.now() >= state.matchZombieStartAt && Date.now() >= state.nextZombieSpawnAt) {
      createBot(Math.floor(Math.random() * 100000), Math.random() > 0.5 ? TEAM_A : TEAM_B);
      state.nextZombieSpawnAt += ZOMBIE_SPAWN_INTERVAL_MS;
    }
    updateBots();
    const now = Date.now();
    for (const turret of state.turrets) {
      if (now < turret.cooldownAt) continue;
      const nearestZombie = [...state.players.values()].filter((p) => p.bot && p.alive).sort((a, b) => {
        const da = (a.position.x - turret.position.x) ** 2 + (a.position.z - turret.position.z) ** 2;
        const db = (b.position.x - turret.position.x) ** 2 + (b.position.z - turret.position.z) ** 2;
        return da - db;
      })[0];
      if (!nearestZombie) continue;
      const dx = nearestZombie.position.x - turret.position.x;
      const dz = nearestZombie.position.z - turret.position.z;
      const distSq = dx * dx + dz * dz;
      const range = turret.type === 'cannon' ? 180 : 120;
      if (distSq > range * range) continue;
      nearestZombie.hp -= turret.type === 'cannon' ? 40 : 14;
      turret.cooldownAt = now + (turret.type === 'cannon' ? 1300 : 240);
      if (nearestZombie.hp <= 0) killPlayer(nearestZombie, turret.owner);
    }

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
          applyProjectileHit(target, proj.owner, proj);
          proj.ttl = 0;
        }
      }
    }

    state.projectiles = state.projectiles.filter((p) => p.ttl > 0);

    for (const p of state.players.values()) {
      if (!p.alive && p.respawnAt && Date.now() >= p.respawnAt) {
        const spawn = randomSpawn(p.team, p.bot);
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
    objective: { houseRadius: HOUSE_RADIUS, zombieStartInMs: Math.max(0, state.matchZombieStartAt - Date.now()) },
    turrets: state.turrets
  });
}, 1000 / TICK_RATE);

httpServer.listen(process.env.PORT || 3000, () => {
  console.log('Survival server on http://localhost:3000');
});
