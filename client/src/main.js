import * as THREE from 'https://unpkg.com/three@0.176.0/build/three.module.js';
import { io } from 'https://cdn.socket.io/4.8.1/socket.io.esm.min.js';

const canvas = document.getElementById('game');
const menu = document.getElementById('menu');
const playBtn = document.getElementById('playBtn');
const ui = {
  maxHp: 100,
  timer: document.getElementById('timer'),
  score: document.getElementById('score'),
  health: document.getElementById('health'),
  ammo: document.getElementById('ammo'),
  kills: document.getElementById('kills'),
  respawn: document.getElementById('respawn'),
  leaderboardList: document.getElementById('leaderboardList')
};



const createHpBarTexture = () => {
  const w = 128;
  const h = 24;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const draw = (hp01 = 1) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(32, 6, 14, 0.85)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#ff6b90';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, w - 2, h - 2);

    const fillW = Math.max(0, Math.min(w - 6, (w - 6) * hp01));
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#ff5d84');
    grad.addColorStop(1, '#5dff9f');
    ctx.fillStyle = grad;
    ctx.fillRect(3, 3, fillW, h - 6);
  };

  draw(1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return { texture, draw };
};

const createHpBar = () => {
  const { texture, draw } = createHpBarTexture();
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.position.set(0, 2.6, 0);
  sprite.scale.set(1.2, 0.26, 1);
  sprite.userData.updateHp = (hp01) => {
    draw(hp01);
    texture.needsUpdate = true;
  };
  return sprite;
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
const mobileControls = document.getElementById('mobileControls');
const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints || 0) > 1;
let pointerLocked = false;
const local = { id: null, team: null, yaw: 0, pitch: 0, pos: new THREE.Vector3(0, 2, 0), vel: new THREE.Vector3(), hp: 100, ammo: 30, kills: 0, deaths: 0, weapon: 'rifle', alive: true, respawnAt: 0 };
const players = new Map();
const projectiles = [];
const tracerGroup = new THREE.Group();
scene.add(tracerGroup);
let seq = 0;


const renderLeaderboard = (playersSnap) => {
  if (!ui.leaderboardList) return;
  const sorted = [...playersSnap]
    .sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths) || a.name.localeCompare(b.name))
    .slice(0, 8);

  ui.leaderboardList.innerHTML = '';
  for (const p of sorted) {
    const li = document.createElement('li');
    if (p.id === local.id) li.classList.add('me');
    const name = document.createElement('span');
    const tag = p.bot ? '🤖' : '';
    name.textContent = `${tag}${p.name}`;
    const kd = document.createElement('span');
    kd.textContent = `${p.kills}/${p.deaths}`;
    li.appendChild(name);
    li.appendChild(kd);
    ui.leaderboardList.appendChild(li);
  }
};

const socket = io();
socket.on('welcome', ({ id, team }) => { local.id = id; local.team = team; });
socket.on('snapshot', (snap) => {
  for (const p of snap.players) {
    if (p.id === local.id) {
      local.hp = p.hp; local.ammo = p.ammo; local.kills = p.kills; local.deaths = p.deaths; local.alive = p.alive; local.respawnAt = p.respawnAt || 0;
      if (!local.alive && p.position) local.pos.set(p.position.x, p.position.y, p.position.z);
      if (local.alive && p.position) {
        const dx = p.position.x - local.pos.x;
        const dy = p.position.y - local.pos.y;
        const dz = p.position.z - local.pos.z;
        const driftSq = dx * dx + dy * dy + dz * dz;
        if (driftSq > 64) local.pos.set(p.position.x, p.position.y, p.position.z);
      }
      continue;
    }
    let m = players.get(p.id);
    if (!m) {
      m = new THREE.Mesh(new THREE.CapsuleGeometry(0.8, 1.2, 6, 12), new THREE.MeshStandardMaterial({ color: p.team === 'A' ? 0x00e6ff : 0xff408d }));
      m.castShadow = true; scene.add(m); players.set(p.id, m);
      m.userData.team = p.team;
      const hpBar = createHpBar();
      m.add(hpBar);
      m.userData.hpBar = hpBar;
    }
    m.visible = !!p.alive;
    if (m.userData.hpBar?.userData?.updateHp) {
      const hp01 = Math.max(0, Math.min(1, (p.hp || 0) / ui.maxHp));
      m.userData.hpBar.userData.updateHp(hp01);
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
  renderLeaderboard(snap.players);
});


mobileControls.style.display = isMobile ? 'flex' : 'none';
if (isMobile) {
  menu.style.display = 'none';
  pointerLocked = true;
}

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

if (isMobile) {
  let lookTouchId = null;
  let lastTouch = null;

  const isControlTouch = (target) => !!target?.closest?.('#mobileControls');

  document.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      if (isControlTouch(t.target)) continue;
      lookTouchId = t.identifier;
      lastTouch = { x: t.clientX, y: t.clientY };
      break;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (lookTouchId === null || !lastTouch) return;
    for (const t of e.changedTouches) {
      if (t.identifier !== lookTouchId) continue;
      const dx = t.clientX - lastTouch.x;
      const dy = t.clientY - lastTouch.y;
      local.yaw -= dx * 0.004;
      local.pitch = Math.max(-1.3, Math.min(1.3, local.pitch - dy * 0.004));
      lastTouch = { x: t.clientX, y: t.clientY };
      break;
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== lookTouchId) continue;
      lookTouchId = null;
      lastTouch = null;
      break;
    }
  }, { passive: true });
}

addEventListener('mousedown', () => pointerLocked && keys.add('Mouse0'));
addEventListener('mouseup', () => keys.delete('Mouse0'));

document.getElementById('shootBtn').addEventListener('touchstart', (e) => { e.preventDefault(); touchShootActive = true; keys.add('Mouse0'); }, { passive: false });
document.getElementById('shootBtn').addEventListener('touchend', (e) => { e.preventDefault(); touchShootActive = false; keys.delete('Mouse0'); }, { passive: false });
document.getElementById('jumpBtn').addEventListener('touchstart', (e) => { e.preventDefault(); keys.add('Space'); setTimeout(() => keys.delete('Space'), 140); }, { passive: false });
document.getElementById('jumpBtn').addEventListener('touchend', (e) => { e.preventDefault(); keys.delete('Space'); }, { passive: false });


const joystick = document.getElementById('joystick');
const joyKnob = document.getElementById('joyKnob');
const joy = { x: 0, y: 0, active: false };
let touchShootActive = false;
if (isMobile && joystick && joyKnob) {
  const maxR = 33;
  const centerKnob = () => { joyKnob.style.left = '33px'; joyKnob.style.top = '33px'; joy.x = 0; joy.y = 0; joy.active = false; };
  const onMove = (touch) => {
    const rect = joystick.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = touch.clientX - cx;
    let dy = touch.clientY - cy;
    const len = Math.hypot(dx, dy) || 1;
    if (len > maxR) { dx = (dx / len) * maxR; dy = (dy / len) * maxR; }
    joy.x = dx / maxR;
    joy.y = dy / maxR;
    joy.active = true;
    joyKnob.style.left = `${33 + dx}px`;
    joyKnob.style.top = `${33 + dy}px`;
  };
  joystick.addEventListener('touchstart', (e) => { e.preventDefault(); onMove(e.touches[0]); }, { passive: false });
  joystick.addEventListener('touchmove', (e) => { e.preventDefault(); onMove(e.touches[0]); }, { passive: false });
  joystick.addEventListener('touchend', (e) => { e.preventDefault(); centerKnob(); }, { passive: false });
  joystick.addEventListener('touchcancel', centerKnob, { passive: true });
}

playBtn.onclick = async () => {
  if (isMobile) {
    pointerLocked = true;
    menu.style.display = 'none';
    return;
  }
  await canvas.requestPointerLock();
  pointerLocked = true;
  menu.style.display = 'none';
};

document.addEventListener('pointerlockchange', () => {
  if (isMobile) {
    pointerLocked = true;
    return;
  }
  pointerLocked = !!document.pointerLockElement;
  if (!pointerLocked) menu.style.display = 'grid';
});


const updateMobileAutoShoot = () => {
  if (!isMobile) return;
  if (!local.alive) {
    if (!touchShootActive) keys.delete('Mouse0');
    return;
  }

  const forward = new THREE.Vector3(Math.sin(local.yaw), 0, Math.cos(local.yaw));
  let shouldShoot = false;
  for (const mesh of players.values()) {
    if (local.team && mesh.userData.team === local.team) continue;
    const toEnemy = new THREE.Vector3().subVectors(mesh.position, local.pos);
    const distance = toEnemy.length();
    if (distance < 4 || distance > 60) continue;
    toEnemy.y = 0;
    toEnemy.normalize();
    const dot = forward.dot(toEnemy);
    if (dot > 0.86) {
      shouldShoot = true;
      break;
    }
  }

  if (shouldShoot || touchShootActive) keys.add('Mouse0');
  else keys.delete('Mouse0');
};

const tracerMat = new THREE.LineBasicMaterial({ color: 0xffaa22 });
function tick(dt) {
  updateMobileAutoShoot();
  const speed = keys.has('ShiftLeft') ? 22 : keys.has('ControlLeft') ? 7 : 14;
  if (!local.alive) {
    local.vel.set(0, 0, 0);
    keys.delete('Mouse0');
  }
  const keyX = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const keyZ = (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0);
  const moveX = isMobile ? keyX + joy.x : keyX;
  const moveZ = isMobile ? keyZ + joy.y : keyZ;
  const dir = new THREE.Vector3(moveX, 0, moveZ);
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

  if (!local.id) return;

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

  tracerGroup.clear();
  for (const p of projectiles.slice(0, 12)) {
    const points = [new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z), new THREE.Vector3(p.pos.x - p.dir.x * 2, p.pos.y - p.dir.y * 2, p.pos.z - p.dir.z * 2)];
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), tracerMat);
    tracerGroup.add(line);
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
