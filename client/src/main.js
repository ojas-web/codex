import * as THREE from 'https://unpkg.com/three@0.176.0/build/three.module.js';
import { io } from 'https://cdn.socket.io/4.8.1/socket.io.esm.min.js';

const canvas = document.getElementById('game');
const menu = document.getElementById('menu');
const playBtn = document.getElementById('playBtn');
const ui = {
  timer: document.getElementById('timer'),
  score: document.getElementById('score'),
  health: document.getElementById('health'),
  ammo: document.getElementById('ammo'),
  kills: document.getElementById('kills'),
  respawn: document.getElementById('respawn')
};

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x050814, 0.018);
const camera = new THREE.PerspectiveCamera(85, innerWidth / innerHeight, 0.1, 500);

scene.add(new THREE.HemisphereLight(0x63a4ff, 0x050507, 0.8));
const sun = new THREE.DirectionalLight(0x8fd7ff, 1.4);
sun.position.set(20, 40, 10);
sun.castShadow = true;
scene.add(sun);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x131826, metalness: 0.5, roughness: 0.6 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

for (let i = 0; i < 80; i++) {
  const crate = new THREE.Mesh(new THREE.BoxGeometry(6, 6, 6), new THREE.MeshStandardMaterial({ color: i % 2 ? 0x24324a : 0x182030, emissive: i % 5 ? 0 : 0x004455 }));
  crate.position.set((Math.random() - 0.5) * 160, 3, (Math.random() - 0.5) * 160);
  crate.castShadow = true;
  crate.receiveShadow = true;
  scene.add(crate);
}

const neonLines = new THREE.Group();
for (let i = 0; i < 40; i++) {
  const g = new THREE.Mesh(new THREE.BoxGeometry(30, 0.2, 0.2), new THREE.MeshBasicMaterial({ color: i % 2 ? 0x00e6ff : 0xff3bf1 }));
  g.position.set((Math.random() - 0.5) * 150, 0.2, (Math.random() - 0.5) * 150);
  neonLines.add(g);
}
scene.add(neonLines);

const keys = new Set();
let pointerLocked = false;
const local = { id: null, yaw: 0, pitch: 0, pos: new THREE.Vector3(0, 2, 0), vel: new THREE.Vector3(), hp: 100, ammo: 30, kills: 0, deaths: 0, weapon: 'rifle', alive: true, respawnAt: 0 };
const players = new Map();
const projectiles = [];
let seq = 0;

const socket = io();
socket.on('welcome', ({ id }) => (local.id = id));
socket.on('snapshot', (snap) => {
  for (const p of snap.players) {
    if (p.id === local.id) {
      local.hp = p.hp; local.ammo = p.ammo; local.kills = p.kills; local.deaths = p.deaths; local.alive = p.alive; local.respawnAt = p.respawnAt || 0;
      if (!local.alive && p.position) local.pos.set(p.position.x, p.position.y, p.position.z);
      if (local.alive && p.position) local.pos.lerp(new THREE.Vector3(p.position.x, p.position.y, p.position.z), 0.35);
      continue;
    }
    let m = players.get(p.id);
    if (!m) {
      m = new THREE.Mesh(new THREE.CapsuleGeometry(0.8, 1.2, 6, 12), new THREE.MeshStandardMaterial({ color: p.team === 'A' ? 0x00e6ff : 0xff408d }));
      m.castShadow = true; scene.add(m); players.set(p.id, m);
    }
    m.position.lerp(new THREE.Vector3(p.position.x, p.position.y, p.position.z), 0.45);
  }
  for (const [id, mesh] of players.entries()) {
    if (!snap.players.find((p) => p.id === id)) { scene.remove(mesh); players.delete(id); }
  }
  projectiles.splice(0, projectiles.length, ...snap.projectiles);
  ui.score.textContent = `A ${snap.score.A} - ${snap.score.B} B`;
  const s = Math.floor(snap.remainingMs / 1000);
  ui.timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
});

addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('mousemove', (e) => {
  if (!pointerLocked) return;
  local.yaw -= e.movementX * 0.0022;
  local.pitch = Math.max(-1.3, Math.min(1.3, local.pitch - e.movementY * 0.0022));
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
addEventListener('mousedown', () => pointerLocked && keys.add('Mouse0'));
addEventListener('mouseup', () => keys.delete('Mouse0'));

document.getElementById('shootBtn').addEventListener('touchstart', () => keys.add('Mouse0'));
document.getElementById('shootBtn').addEventListener('touchend', () => keys.delete('Mouse0'));
document.getElementById('jumpBtn').addEventListener('touchstart', () => keys.add('Space'));

playBtn.onclick = async () => {
  await canvas.requestPointerLock();
  pointerLocked = true;
  menu.style.display = 'none';
};

document.addEventListener('pointerlockchange', () => { pointerLocked = !!document.pointerLockElement; if (!pointerLocked) menu.style.display = 'grid'; });

const tracerMat = new THREE.LineBasicMaterial({ color: 0xffaa22 });
function tick(dt) {
  const speed = keys.has('ShiftLeft') ? 22 : keys.has('ControlLeft') ? 7 : 14;
  if (!local.alive) {
    local.vel.set(0, 0, 0);
    keys.delete('Mouse0');
  }
  const dir = new THREE.Vector3((keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0), 0, (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0));
  if (dir.lengthSq()) dir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), local.yaw);
  local.vel.x = THREE.MathUtils.lerp(local.vel.x, dir.x * speed, 0.2);
  local.vel.z = THREE.MathUtils.lerp(local.vel.z, dir.z * speed, 0.2);
  local.vel.y -= 30 * dt;
  if (local.alive && keys.has('Space') && local.pos.y <= 2.01) local.vel.y = 12;
  local.pos.addScaledVector(local.vel, dt);
  if (local.pos.y < 2) { local.pos.y = 2; local.vel.y = 0; }

  camera.position.copy(local.pos);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = local.yaw;
  camera.rotation.x = local.pitch;

  socket.emit('input', {
    seq: ++seq,
    pos: { x: local.pos.x, y: local.pos.y, z: local.pos.z },
    rotY: local.yaw,
    pitch: local.pitch,
    velocity: { x: local.vel.x, y: local.vel.y, z: local.vel.z },
    crouch: keys.has('ControlLeft'),
    sprint: keys.has('ShiftLeft'),
    fire: local.alive && keys.has('Mouse0'),
    weapon: local.weapon
  });

  ui.health.textContent = `HP ${Math.max(0, local.hp | 0)}`;
  ui.ammo.textContent = String(local.ammo);
  ui.kills.textContent = `K ${local.kills} / D ${local.deaths}`;
  if (!local.alive) {
    const remain = Math.max(0, Math.ceil((local.respawnAt - Date.now()) / 1000));
    ui.respawn.textContent = `RESPAWNING IN ${remain}s`;
    ui.respawn.classList.remove('hidden');
  } else {
    ui.respawn.classList.add('hidden');
  }

  while (scene.children.find((x) => x.userData.tracer)) scene.remove(scene.children.find((x) => x.userData.tracer));
  for (const p of projectiles.slice(0, 18)) {
    const points = [new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z), new THREE.Vector3(p.pos.x - p.dir.x * 2, p.pos.y - p.dir.y * 2, p.pos.z - p.dir.z * 2)];
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), tracerMat);
    line.userData.tracer = true;
    scene.add(line);
  }
}

let last = performance.now();
(function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  tick(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
})(last);
