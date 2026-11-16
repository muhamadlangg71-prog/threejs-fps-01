// Bots: 5v5 teammates and enemies with a state machine — buy, advance along the
// waypoint graph, hold angles, engage with reaction time and aim error, plant and
// defuse the spike, rotate on sound. Line of sight is a real raycast; shots are
// real hitscans with spread, so bots miss when you move and hit when you stand still.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createLoadout, WEAPONS } from './weapons.js';

const ARMOR_COST = 650;
const GRENADE_COST = 300;
const GRENADE_CHANCE = 0.6;

// Price tiers for the primary a bot walks out with: richest tier it can afford.
const PRIMARY_TIERS = [[2700, 'rifle'], [1500, 'smg']];

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

// Breadth-first path over the waypoint graph, returns node ids from start to goal.
export function findPath(waypoints, start, goal, random) {
  if (start === goal) return [goal];
  const prev = new Map([[start, null]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    for (const next of waypoints.adjacency[node] || []) {
      if (prev.has(next)) continue;
      prev.set(next, node);
      if (next === goal) {
        const path = [goal];
        for (let cur = goal; prev.get(cur) !== null; cur = prev.get(cur)) path.unshift(prev.get(cur));
        return path;
      }
      queue.push(next);
    }
  }
  return [goal];
}

function nearestNode(waypoints, x, z) {
  let best = null;
  let bestD = Infinity;
  for (const [id, [nx, nz]] of Object.entries(waypoints.nodes)) {
    const d = (nx - x) * (nx - x) + (nz - z) * (nz - z);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

export function createBots(scene, world) {
  const teamMat = {
    vanguard: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.vanguard), roughness: 0.7, metalness: 0.1 }),
    sentinel: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.sentinel), roughness: 0.7, metalness: 0.1 }),
  };
  const darkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#1c1f24'), roughness: 0.85 });
  const skinMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#c9a582'), roughness: 0.8 });
  const gunMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#22252a'), roughness: 0.5, metalness: 0.5 });

  const bots = [];
  const hitMeshes = [];

  // Body parts, in build order — the legs MUST stay first two children, because
  // the walk animation swings group.children[0] and [1].
  // [geometry, material, x, y, z, rotationX?]
  function bodyParts(team) {
    const teamM = teamMat[team];
    const bandMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(team === 'vanguard' ? '#f0a830' : '#7fd4de') });
    return [
      [new THREE.BoxGeometry(0.16, 0.78, 0.16), darkMat, -0.11, 0.39, 0],
      [new THREE.BoxGeometry(0.16, 0.78, 0.16), darkMat, 0.11, 0.39, 0],
      [new THREE.BoxGeometry(0.52, 0.62, 0.3), teamM, 0, 1.09, 0],
      [new THREE.BoxGeometry(0.56, 0.4, 0.34), darkMat, 0, 1.12, 0],
      [new THREE.SphereGeometry(0.16, 12, 10), skinMat, 0, 1.56, 0],
      [new THREE.SphereGeometry(0.175, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), teamM, 0, 1.58, 0],
      [new THREE.BoxGeometry(0.12, 0.5, 0.12), teamM, -0.32, 1.15, 0.12, -1.1],
      [new THREE.BoxGeometry(0.12, 0.5, 0.12), teamM, 0.32, 1.15, 0.12, -1.1],
      [new THREE.BoxGeometry(0.07, 0.09, 0.62), gunMat, 0.1, 1.32, -0.28],
      // Team band on the torso so the eye reads the side at a glance.
      [new THREE.BoxGeometry(0.54, 0.1, 0.32), bandMat, 0, 1.32, 0],
    ];
  }

  function makeBot(index, team, name) {
    const group = new THREE.Group();
    const parts = [];
    for (const [geo, mat, x, y, z, rx] of bodyParts(team)) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      if (rx) mesh.rotation.x = rx;
      mesh.castShadow = true;
      group.add(mesh);
      parts.push(mesh);
    }
    const torso = parts[2];
    const head = parts[4];
    const gun = parts[8];
    group.visible = false;
    scene.add(group);

    const bot = {
      index, team, name, group, head, torso, gun,
      health: 100, armor: 0, alive: false,
      loadout: createLoadout(null, false),
      money: 800,
      role: team === 'vanguard' ? 'attack' : 'defend',
      site: 'A',
      state: 'idle',
      path: [], pathIndex: 0,
      holdNode: null, holdYaw: 0, holdTimer: 0,
      target: null, targetVisible: false, losTimer: Math.random() * 0.1,
      reactTimer: 0, burstLeft: 0, burstPause: 0,
      aimError: 0.02, moveTarget: null,
      plantTimer: 0, defuseTimer: 0, channeling: null,
      investigate: null, investigateTimer: 0,
      fall: 0, fadeTimer: 0,
      yaw: 0, walkPhase: 0, moving: false,
      kills: 0, deaths: 0,
      random: makeSeededRandom(1000 + index * 77),
      // Stuck recovery (botai walkTo): seconds without progress, anchor point,
      // and the sidestep it is currently doing, if any.
      stuckTime: 0, stuckX: null, stuckZ: null, sideTime: 0, sideDir: 1,
    };
    torso.userData.bot = bot;
    torso.userData.part = 'torso';
    head.userData.bot = bot;
    head.userData.part = 'head';
    hitMeshes.push(torso, head);
    bots.push(bot);
    return bot;
  }

  const names = {
    vanguard: ['Rook', 'Havoc', 'Dusty', 'Mira'],
    sentinel: ['Warden', 'Sable', 'Kite', 'Bram', 'Nox'],
  };
  for (let i = 0; i < 4; i += 1) makeBot(i, 'vanguard', names.vanguard[i]);
  for (let i = 0; i < 5; i += 1) makeBot(4 + i, 'sentinel', names.sentinel[i]);

  function resetBot(bot, spawn, yaw) {
    bot.group.position.copy(spawn);
    bot.group.rotation.set(0, 0, 0);
    bot.yaw = yaw;
    bot.group.visible = true;
    bot.health = 100;
    bot.armor = 0;
    bot.alive = true;
    bot.state = 'advance';
    bot.path = [];
    bot.pathIndex = 0;
    bot.target = null;
    bot.targetVisible = false;
    bot.burstLeft = 0;
    bot.burstPause = 0;
    bot.plantTimer = 0;
    bot.defuseTimer = 0;
    bot.channeling = null;
    bot.investigate = null;
    bot.fall = 0;
    bot.fadeTimer = 0;
    bot.stuckTime = 0;
    bot.stuckX = null;
    bot.stuckZ = null;
    bot.sideTime = 0;
    bot.group.traverse((m) => {
      if (m.isMesh && m.material.transparent) m.material.opacity = 1;
    });
  }

  function buyFor(bot) {
    // Spend the round's money like a player: rifle first, armour, then a grenade.
    // The P9 pistol is the default sidearm — always with you, never charged — so
    // a broke bot still walks out armed and its money never goes negative.
    let primary = 'pistol';
    for (const [price, id] of PRIMARY_TIERS) {
      if (bot.money >= price) {
        primary = id;
        break;
      }
    }
    bot.loadout.buyPrimary(primary);
    if (primary !== 'pistol') bot.money -= WEAPONS[primary].price;
    if (bot.money >= ARMOR_COST) {
      bot.armor = 100;
      bot.money -= ARMOR_COST;
    }
    if (bot.money >= GRENADE_COST && bot.random() < GRENADE_CHANCE) {
      bot.loadout.addGrenade();
      bot.money -= GRENADE_COST;
    }
  }

  function damage(bot, amount, part) {
    if (!bot.alive) return false;
    let dmg = amount;
    if (part === 'head') dmg *= 3;
    else if (part === 'leg') dmg *= 0.75;
    if (bot.armor > 0) {
      const absorbed = Math.min(bot.armor, dmg * 0.5);
      bot.armor -= absorbed;
      dmg -= absorbed;
    }
    bot.health -= dmg;
    if (bot.health <= 0) {
      bot.health = 0;
      bot.alive = false;
      bot.state = 'dead';
      bot.deaths += 1;
      bot.fall = 0;
      return true;
    }
    return false;
  }

  return {
    bots,
    hitMeshes,
    resetBot,
    buyFor,
    damage,
    nearestNode(x, z) {
      return nearestNode(world.waypoints, x, z);
    },
    findPath(start, goal, random) {
      return findPath(world.waypoints, start, goal, random);
    },
    setVisible(bot, visible) {
      bot.group.visible = visible;
    },
  };
}
