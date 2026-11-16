// Boot and the one loop: a fixed 60 Hz simulation feeding a render at the display's rate.
// FERROLINE — a round-based tactical FPS: 5v5, spike plant/defuse, economy and a buy
// menu, bots that walk routes, hold angles and shoot back. ?shot=start|play|buy|end
// with &seed=N sets up a deterministic frame for a capture, renders it twice, then
// freezes it and sets window.__shotReady.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createWorld } from './world.js';
import { createInput } from './input.js';
import { createPlayer } from './player.js';
import { createLoadout, WEAPONS, ARMOR_PRICE } from './weapons.js';
import { createBots } from './bots.js';
import { createBotAI } from './botai.js';
import { createGame } from './game.js';
import { createEffects } from './effects.js';
import { createAudio } from './audio.js';
import { createHud } from './hud.js';

const TICK = 1 / 60;
const EYE_HEIGHT = 1.55;
const query = new URLSearchParams(window.location.search);
const shot = query.get('shot');
const seed = Number.parseInt(query.get('seed') ?? '1', 10) || 1;

// Deterministic dice, seeded from the URL so captures reproduce.
function makeSeededRandom(initial) {
  let a = initial;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = makeSeededRandom(seed);

// ---- Stage: renderer, scene, camera ----
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
scene.fog = new THREE.Fog(new THREE.Color('#232a38'), 34, 110);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 300);
scene.add(camera);

// ---- Systems ----
const world = createWorld(scene);
const audio = createAudio();
const effects = createEffects(scene, camera);
const hud = createHud();
const player = createPlayer(world.colliders);
const loadout = createLoadout(camera, true);
const botsApi = createBots(scene, world);
const botAI = createBotAI(world);
for (const bot of botsApi.bots) {
  bot.ai = botAI;
  bot.findPath = botsApi.findPath;
}
const game = createGame(world, botsApi, player, loadout, hud, audio, effects);
const input = createInput(renderer.domElement, onLockChange);

// ---- Mutable frame state ----
const body = player.state;
let elapsed = 0;
let frozen = false;
let started = false;
let accumulator = 0;
let lastTime = performance.now();
let trauma = 0;
let stepTimer = 0;
let lastWeapon = 'rifle';
let wasFiring = false;
let buyOpen = false;

// ---- Shared scratch (never allocate in the hot loop) ----
const raycaster = new THREE.Raycaster();
raycaster.far = 140;
const aimDir = new THREE.Vector3();
const scratch = new THREE.Vector3();
const scratch2 = new THREE.Vector3();
const playerBox = new THREE.Box3();
const hitPoint = new THREE.Vector3();
const shootables = world.shootables.concat(botsApi.hitMeshes);

// ---- Sight: clear when no world surface is closer than the target. ----
function clearSight(x1, y1, z1, x2, y2, z2) {
  scratch.set(x2 - x1, y2 - y1, z2 - z1);
  const dist = scratch.length();
  if (dist < 0.01) return true;
  raycaster.set(scratch2.set(x1, y1, z1), scratch.normalize());
  raycaster.far = dist;
  return !raycaster.intersectObjects(world.shootables, false)[0];
}

// ---- Foes: who this bot is allowed to fight right now. ----
function foesFor(bot) {
  // No combat before the round goes live: bots may walk to their holds during
  // the buy phase, but nobody shoots until "ROUND LIVE".
  if (game.state.phase !== 'live') return [];
  const foes = [];
  if (bot.team === 'sentinel' && player.state.alive) {
    foes.push({ isPlayer: true, alive: true, pos: body.position, vel: body.velocity, bot: null });
  }
  for (const other of botsApi.bots) {
    if (other.team === bot.team || !other.alive) continue;
    foes.push({ isPlayer: false, alive: true, pos: other.group.position, vel: { x: 0, z: 0 }, bot: other });
  }
  return foes;
}

// ---- Grenades: thrown with an arc, bounce off colliders, explode on the fuse. ----
function makeGrenadeKit() {
  const geo = new THREE.SphereGeometry(0.09, 10, 8);
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#22252a'), roughness: 0.5, metalness: 0.5 });
  const live = [];

  function detonate(g) {
    const pos = g.mesh.position.clone();
    scene.remove(g.mesh);
    effects.explosion(pos);
    audio.explosion();
    trauma = Math.min(1, trauma + 0.7);
    game.addNoise(pos.x, pos.z, 42);
    // Radius damage with falloff: 110 at the centre, 15 at 6 m.
    const victims = [];
    if (player.state.alive) {
      victims.push({ kind: 'player', pos: scratch2.copy(body.position).setY(body.position.y + 1.1).clone(), ref: 'player' });
    }
    for (const bot of botsApi.bots) {
      if (bot.alive) {
        victims.push({ kind: 'bot', pos: bot.group.position.clone().add(new THREE.Vector3(0, 1.1, 0)), ref: bot });
      }
    }
    for (const victim of victims) {
      const d = victim.pos.distanceTo(pos);
      if (d > 6.5) continue;
      // A wall between the blast and the victim blocks it.
      raycaster.set(pos, scratch.copy(victim.pos).sub(pos).normalize());
      raycaster.far = d;
      if (raycaster.intersectObjects(world.shootables, false)[0]) continue;
      const dmg = Math.round(110 - (d / 6.5) * 95);
      if (victim.kind === 'player') game.damagePlayer(dmg, 'torso', null);
      else if (botsApi.damage(victim.ref, dmg, 'torso')) game.onKill(victim.ref, 'player', 'torso');
    }
  }

  return {
    throwAt(from, dir) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(from);
      mesh.castShadow = true;
      scene.add(mesh);
      live.push({
        mesh,
        vel: scratch.copy(dir).multiplyScalar(15).add(new THREE.Vector3(0, 4.5, 0)).clone(),
        fuse: 1.6,
      });
      audio.grenadeBounce();
    },
    tick(dt) {
      for (let i = live.length - 1; i >= 0; i -= 1) {
        const g = live[i];
        g.fuse -= dt;
        g.vel.y -= 16 * dt;
        const next = g.mesh.position.clone().addScaledVector(g.vel, dt);
        // Bounce: if the next point is inside a collider, reflect the dominant axis.
        let bounced = false;
        for (const c of world.colliders) {
          if (c.containsPoint(next)) {
            const dx = Math.min(Math.abs(next.x - c.min.x), Math.abs(next.x - c.max.x));
            const dz = Math.min(Math.abs(next.z - c.min.z), Math.abs(next.z - c.max.z));
            const dy = Math.min(Math.abs(next.y - c.min.y), Math.abs(next.y - c.max.y));
            if (dx <= dy && dx <= dz) g.vel.x *= -0.45;
            else if (dz <= dy) g.vel.z *= -0.45;
            else g.vel.y *= -0.45;
            g.vel.multiplyScalar(0.7);
            bounced = true;
            audio.grenadeBounce();
            break;
          }
        }
        if (!bounced) g.mesh.position.copy(next);
        if (g.mesh.position.y < 0.09) {
          g.mesh.position.y = 0.09;
          if (Math.abs(g.vel.y) > 1.5) audio.grenadeBounce();
          g.vel.y = Math.abs(g.vel.y) * 0.45;
          g.vel.x *= 0.7;
          g.vel.z *= 0.7;
        }
        if (g.fuse <= 0) {
          detonate(g);
          live.splice(i, 1);
        }
      }
    },
  };
}
const grenades = makeGrenadeKit();

// ---- Shooting: one hitscan path for the player, one for bots. ----
function firePlayerWeapon(spread) {
  const def = loadout.def();
  if (def.kind === 'grenade') {
    if (!loadout.takeRound()) return false;
    camera.getWorldDirection(aimDir);
    grenades.throwAt(scratch.copy(camera.position).addScaledVector(aimDir, 0.6).clone(), aimDir);
    loadout.pullTrigger();
    loadout.switchTo(lastWeapon);
    return true;
  }
  if (!loadout.takeRound()) {
    audio.dryFire();
    return false;
  }
  camera.getWorldDirection(aimDir);
  aimDir.x += (random() * 2 - 1) * spread;
  aimDir.y += (random() * 2 - 1) * spread;
  aimDir.z += (random() * 2 - 1) * spread;
  aimDir.normalize();
  scene.updateMatrixWorld(true);
  raycaster.set(camera.position, aimDir);
  raycaster.far = def.range;
  const hit = raycaster.intersectObjects(shootables, false)[0];
  const muzzle = scratch.copy(camera.position).addScaledVector(aimDir, 0.5).clone();
  if (hit) {
    effects.tracer(muzzle, hit.point);
    const bot = hit.object.userData.bot;
    if (bot && bot.alive) {
      const part = hit.object.userData.part;
      const dmg = def.damage * (part === 'head' ? def.headMult : 1);
      effects.blood(hit.point, hit.face ? hit.face.normal : scratch2.set(0, 1, 0));
      hud.hitMarker(false, 90);
      if (part === 'head') audio.headshot();
      else audio.hit();
      if (botsApi.damage(bot, dmg, part)) game.onKill(bot, 'player', part);
    } else {
      effects.impact(hit.point, hit.face ? hit.face.normal : scratch2.set(0, 1, 0));
    }
  } else {
    effects.tracer(muzzle, scratch.copy(camera.position).addScaledVector(aimDir, def.range));
  }
  loadout.pullTrigger();
  player.recoil(0.009 * (def.recoil / 0.013) + random() * 0.004, (random() * 2 - 1) * 0.004);
  game.addNoise(body.position.x, body.position.z, def.kind === 'sniper' ? 34 : 26);
  audio.shot(def.kind);
  trauma = Math.min(1, trauma + (def.kind === 'sniper' ? 0.35 : 0.08));
  hud.setAmmo(loadout.ammoText().mag, loadout.ammoText().reserve, loadout.ammoText().label, def.name);
  return true;
}

// Bot-to-target shot: a real raycast with aim error, so bots miss moving targets.
function fireBotWeapon(bot, target, err, def) {
  const from = scratch.copy(bot.group.position).setY(bot.group.position.y + EYE_HEIGHT).clone();
  const aim = target.isPlayer
    ? scratch2.copy(body.position).setY(body.position.y + 1.25)
    : scratch2.copy(target.pos).setY(target.pos.y + 1.2);
  aimDir.copy(aim).sub(from).normalize();
  // Aim error: mostly chest, sometimes the head.
  if (random() < 0.14) aimDir.y += 0.32 / Math.max(1, from.distanceTo(aim));
  aimDir.x += (random() * 2 - 1) * err;
  aimDir.y += (random() * 2 - 1) * err;
  aimDir.z += (random() * 2 - 1) * err;
  aimDir.normalize();
  scene.updateMatrixWorld(true);
  raycaster.set(from, aimDir);
  raycaster.far = def.range;
  const hits = raycaster.intersectObjects(shootables, false);
  const hit = hits[0];
  const muzzle = from.clone().addScaledVector(aimDir, 0.6);
  const impactNormal = (h) => (h.face ? h.face.normal : scratch2.set(0, 1, 0));
  if (target.isPlayer) {
    // The player is a capsule: test the ray against a box around them.
    playerBox.min.set(body.position.x - 0.34, body.position.y, body.position.z - 0.34);
    playerBox.max.set(body.position.x + 0.34, body.position.y + 1.72, body.position.z + 0.34);
    const playerHit = raycaster.ray.intersectBox(playerBox, hitPoint);
    const wallDist = hit ? hit.distance : Infinity;
    if (playerHit && hitPoint.distanceTo(from) < wallDist) {
      effects.tracer(muzzle, hitPoint.clone());
      const part = hitPoint.y > body.position.y + 1.45 ? 'head' : 'torso';
      game.damagePlayer(def.damage, part, bot);
      // Direction indicator: 0 deg means the shooter is straight ahead.
      const dx = bot.group.position.x - body.position.x;
      const dz = bot.group.position.z - body.position.z;
      const rel = Math.atan2(dx, dz) - body.yaw - Math.PI;
      hud.showDirection((rel * 180) / Math.PI);
    } else if (hit) {
      effects.tracer(muzzle, hit.point);
      effects.impact(hit.point, impactNormal(hit));
    } else {
      effects.tracer(muzzle, from.clone().addScaledVector(aimDir, def.range));
    }
  } else if (hit && hit.object.userData.bot === target.bot) {
    effects.tracer(muzzle, hit.point);
    const part = hit.object.userData.part;
    const dmg = def.damage * (part === 'head' ? def.headMult : 1);
    effects.blood(hit.point, impactNormal(hit));
    if (botsApi.damage(target.bot, dmg, part)) game.onKill(target.bot, bot, part);
  } else if (hit) {
    effects.tracer(muzzle, hit.point);
    effects.impact(hit.point, impactNormal(hit));
  } else {
    effects.tracer(muzzle, from.clone().addScaledVector(aimDir, def.range));
  }
  if (from.distanceTo(body.position) < 30) audio.shot(def.kind);
  else audio.distantShot();
  game.addNoise(bot.group.position.x, bot.group.position.z, 22);
}

// What the bot brain is allowed to see and do.
const botCtx = {
  get time() {
    return elapsed;
  },
  get noise() {
    return game.state.noise;
  },
  get bomb() {
    return game.state.bomb;
  },
  enemiesOf: foesFor,
  los: clearSight,
  blocked(x, z) {
    return game.blocked(x, z);
  },
  botShoot(bot, target, err, def) {
    fireBotWeapon(bot, target, err, def);
  },
  plantStart(bot) {
    game.tryPlant(bot);
  },
  defuseStart(bot) {
    game.tryDefuse(bot);
  },
};

// ---- Buy menu ----
function purchase(id) {
  if (game.state.phase !== 'buy') return;
  const money = game.state.money;
  if (id === 'armor') {
    if (money < ARMOR_PRICE || player.state.armor >= 100) return;
    game.state.money -= ARMOR_PRICE;
    player.state.armor = 100;
  } else if (id === 'grenade') {
    if (money < WEAPONS.grenade.price) return;
    game.state.money -= WEAPONS.grenade.price;
    loadout.addGrenade();
  } else {
    const def = WEAPONS[id];
    if (!def || money < def.price) return;
    game.state.money -= def.price;
    if (def.slot === 1) loadout.buyPrimary(id);
    lastWeapon = id;
  }
  audio.buy();
  hud.setMoney(game.state.money);
  hud.openBuy(game.state.money, ownedItemIds());
  hud.setAmmo(loadout.ammoText().mag, loadout.ammoText().reserve, loadout.ammoText().label, loadout.def().name);
}

function ownedItemIds() {
  const owned = [loadout.state.primary, 'pistol'];
  if (player.state.armor >= 100) owned.push('armor');
  if (loadout.state.grenades > 0) owned.push('grenade');
  return owned;
}

hud.onBuy = purchase;

function setBuyOpen(open) {
  if (game.state.phase !== 'buy') return;
  buyOpen = open;
  if (open) {
    hud.openBuy(game.state.money, ownedItemIds());
    if (document.pointerLockElement) document.exitPointerLock();
  } else {
    hud.closeBuy();
    input.requestLock();
  }
}

hud.onPlay(() => {
  audio.unlock();
  if (shot) return;
  if (game.state.phase === 'menu' || game.state.phase === 'matchEnd') {
    game.startMatch();
    setBuyOpen(true);
  }
  if (game.state.phase === 'buy' && !buyOpen) input.requestLock();
  else if (game.state.phase === 'live') input.requestLock();
  else if (game.state.phase === 'roundEnd') input.requestLock();
  hud.hideOverlay();
});

function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    started = true;
    hud.hideOverlay();
    if (buyOpen) setBuyOpen(false);
  } else if (game.state.phase === 'live' && player.state.alive) {
    hud.showOverlay('paused', game.state.score);
  }
}

function syncCamera() {
  trauma = Math.max(0, trauma - 0.02);
  const shake = trauma * trauma * 0.02;
  camera.position.set(body.position.x, body.position.y + body.eye, body.position.z);
  camera.rotation.set(
    body.pitch + (random() * 2 - 1) * shake,
    body.yaw + (random() * 2 - 1) * shake,
    0,
    'YXZ',
  );
}

// ---- One fixed tick ----
function tick(dt) {
  elapsed += dt;
  game.step(dt, input.state);
  // Bots think and move.
  for (const bot of botsApi.bots) {
    if (!bot.alive && bot.state !== 'dead') continue;
    botAI.stepBot(bot, dt, botCtx);
    if (bot.state === 'plant') game.plantTick(dt, bot);
    if (bot.state === 'defuse') game.defuseTick(dt, bot);
    bot.loadout.step(dt);
  }
  // Player movement and weapon.
  if (player.state.alive && (game.state.phase === 'buy' || game.state.phase === 'live')) {
    player.step(dt, input.state.keys);
    if (player.groundSpeed() > 1 && player.onGround) {
      stepTimer -= dt;
      if (stepTimer <= 0) {
        stepTimer = 0.42;
        audio.step();
      }
    }
  }
  loadout.step(dt);
  grenades.tick(dt);
  effects.step(dt);
  // HUD numbers, every tick (the HUD dedupes by value).
  const ammoText = loadout.ammoText();
  hud.setHealth(player.state.health, player.state.armor);
  hud.setAmmo(ammoText.mag, ammoText.reserve, ammoText.label, loadout.def().name);
  hud.setMoney(game.state.money);
  hud.setFeed(game.state.feed);
  const spreadPx = 4 + loadout.spread(player.groundSpeed()) * 900;
  hud.setCrosshairSpread(Math.min(34, spreadPx));
}

// ---- Input edges, handled once per rendered frame ----
const BUY_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'];
const BUY_IDS = ['rifle', 'smg', 'sniper', 'pistol', 'armor', 'grenade'];

function handlePressed(pressed) {
  if (!shot && game.state.phase !== 'menu' && game.state.phase !== 'matchEnd') {
    if (pressed.has('KeyB') || pressed.has('Escape')) {
      if (hud.isBuyOpen()) setBuyOpen(false);
      else if (game.state.phase === 'buy') setBuyOpen(true);
    }
    if (hud.isBuyOpen()) {
      for (const key of BUY_KEYS) {
        if (pressed.has(key)) purchase(BUY_IDS[Number(key.slice(5)) - 1]);
      }
    } else {
      if (pressed.has('Digit1')) {
        lastWeapon = loadout.state.current;
        loadout.switchTo(loadout.state.primary);
      }
      if (pressed.has('Digit2')) {
        lastWeapon = loadout.state.current;
        loadout.switchTo('pistol');
      }
      if (pressed.has('Digit3')) {
        lastWeapon = loadout.state.current;
        loadout.switchTo('grenade');
      }
      if (pressed.has('KeyQ')) {
        const cur = loadout.state.current;
        loadout.switchTo(lastWeapon);
        lastWeapon = cur;
      }
      if (pressed.has('WheelUp') || pressed.has('WheelDown')) {
        const order = [loadout.state.primary, 'pistol', 'grenade'];
        const idx = order.indexOf(loadout.state.current);
        const next = order[(idx + (pressed.has('WheelUp') ? 1 : order.length - 1)) % order.length];
        lastWeapon = loadout.state.current;
        loadout.switchTo(next);
      }
      if (pressed.has('KeyG')) {
        lastWeapon = loadout.state.current;
        if (loadout.switchTo('grenade') && loadout.ready()) firePlayerWeapon(0);
        else loadout.switchTo(lastWeapon);
      }
    }
  }
  if (input.state.firing && game.state.phase === 'live' && player.state.alive) {
    const def = loadout.def();
    if (loadout.ready() && (def.auto || !wasFiring)) {
      firePlayerWeapon(loadout.spread(player.groundSpeed()));
    } else if (loadout.ammoText().mag === 0 && def.kind !== 'grenade') {
      loadout.reload();
    }
  }
  wasFiring = input.state.firing;
  if (input.state.keys.has('KeyR')) loadout.reload();
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (!frozen) {
    const look = input.takeLook();
    player.look(look.x, look.y);
    handlePressed(input.takePressed());
    accumulator += dt;
    let steps = 0;
    while (accumulator >= TICK && steps < 5) {
      tick(TICK);
      accumulator -= TICK;
      steps += 1;
    }
    if (accumulator > TICK * 5) accumulator = 0;
    syncCamera();
  }
  renderer.render(scene, camera);
}

// ---- Deterministic captures (?shot=...) ----
function settle(steps) {
  for (let index = 0; index < steps; index += 1) tick(TICK);
}

function aimCameraAt(point) {
  const dx = point.x - body.position.x;
  const dy = point.y - (body.position.y + body.eye);
  const dz = point.z - body.position.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  body.yaw = Math.atan2(-dx, -dz);
  body.pitch = Math.asin(Math.max(-1, Math.min(1, dy / length)));
  syncCamera();
}

function stageBot(bot, x, z, yaw, holdNode) {
  bot.group.position.set(x, 0, z);
  bot.group.visible = true;
  bot.alive = true;
  bot.health = 100;
  bot.yaw = yaw;
  bot.group.rotation.y = yaw;
  bot.state = 'hold';
  bot.holdNode = holdNode;
  bot.holdYaw = yaw;
  bot.holdTimer = 60;
}

const SHOT_SCENES = {
  start() {
    hud.setPhase('buy', 1, [0, 0]);
    body.pitch = 0;
    player.teleport(0, 0, 17.5, Math.PI);
    stageBot(this.vanguard[0], -3, 12, Math.PI, 'vMid');
    stageBot(this.vanguard[1], 3, 13, Math.PI, 'vMid');
    stageBot(this.sentinel[0], -8, -2, 0, 'midA');
    stageBot(this.sentinel[1], 8, -4, 0, 'midB');
    settle(30);
    aimCameraAt(new THREE.Vector3(-6, 2.2, -8));
    hud.setHealth(100, 0);
    hud.setAmmo(30, 90, '/ ', 'AR-77 Longshot');
    hud.setMoney(800);
    hud.setTimer(15, 'BUY');
    hud.setScore(0, 0, 1);
    hud.showOverlay('start', { vanguard: 0, sentinel: 0 });
  },
  buy() {
    hud.setPhase('buy', 2, [1, 0]);
    player.teleport(0, 0, 16, Math.PI);
    stageBot(this.vanguard[0], -4, 12, Math.PI, 'vMid');
    stageBot(this.vanguard[1], 4, 12, Math.PI, 'vMid');
    stageBot(this.sentinel[0], 0, -6, 0, 'midTop');
    settle(30);
    aimCameraAt(new THREE.Vector3(0, 1.6, -6));
    hud.setHealth(100, 100);
    hud.setAmmo(30, 90, '/ ', 'AR-77 Longshot');
    hud.setMoney(3250);
    hud.setTimer(12, 'BUY');
    hud.setScore(1, 0, 2);
    hud.openBuy(3250, ['rifle', 'pistol']);
  },
  play() {
    game.state.phase = 'live';
    game.state.timer = 87;
    hud.setPhase('live', 2, [1, 0]);
    player.teleport(1.5, 0, 8, Math.PI);
    stageBot(this.sentinel[0], -2, -4, 0.3, 'midDoor');
    stageBot(this.sentinel[1], 3, -7, -0.4, 'midTop');
    stageBot(this.vanguard[0], -5, 4, Math.PI, 'midLow');
    settle(20);
    const target = this.sentinel[0].group.position.clone().setY(1.25);
    aimCameraAt(target);
    firePlayerWeapon(0);
    settle(1);
    hud.setHealth(82, 50);
    hud.setAmmo(27, 90, '/ ', 'AR-77 Longshot');
    hud.setMoney(3550);
    hud.setTimer(87, 'ROUND');
    hud.setScore(1, 0, 2);
    hud.setBomb('carry');
    hud.hitMarker(false, 4000);
  },
  end() {
    // Round won, banner up, spike smoke over Site A.
    game.state.phase = 'roundEnd';
    game.state.score = { vanguard: 2, sentinel: 0 };
    game.state.round = 2;
    hud.setPhase('roundEnd', 2, [2, 0]);
    player.teleport(-6, 0, 2, Math.PI * 0.85);
    stageBot(this.vanguard[0], -10, -4, Math.PI, 'aEntry');
    stageBot(this.vanguard[1], -4, -8, Math.PI, 'aSite');
    stageBot(this.sentinel[0], 12, -6, 0.5, 'bEntry');
    effects.smoke(new THREE.Vector3(-12, 1.5, -10), 5, 4);
    effects.smoke(new THREE.Vector3(-10, 2, -8), 3.5, 4);
    settle(20);
    aimCameraAt(new THREE.Vector3(-14, 1.8, -12));
    hud.setHealth(64, 25);
    hud.setAmmo(18, 60, '/ ', 'AR-77 Longshot');
    hud.setMoney(6500);
    hud.setTimer(0, 'ROUND');
    hud.setScore(2, 0, 2);
    hud.setBomb(null);
    hud.showBanner('VANGUARD WINS THE ROUND', 'Spike detonated at Crane Deck', 4000);
  },
};

function runShot(name) {
  hud.hideOverlay();
  hud.closeBuy();
  game.startMatch();
  // Deterministic bots: fixed lanes, fixed site.
  game.state.bomb.site = 'A';
  const cast = {
    vanguard: botsApi.bots.filter((b) => b.team === 'vanguard'),
    sentinel: botsApi.bots.filter((b) => b.team === 'sentinel'),
  };
  const sceneFn = SHOT_SCENES[name] || SHOT_SCENES.end;
  sceneFn.call(cast);
  paintTwiceThenReady();
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      frozen = true;
    }
  }
  requestAnimationFrame(paint);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

hud.setHealth(100, 0);
hud.setAmmo(30, 90, '/ ', 'AR-77 Longshot');
hud.setMoney(800);
hud.setTimer(15, 'BUY');
hud.setScore(0, 0, 1);
syncCamera();
if (shot) runShot(shot);
else requestAnimationFrame(frame);
