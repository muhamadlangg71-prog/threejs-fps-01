// The map: Ferroline Yard, a dusk rail yard with two spike sites. Vanguard attacks
// from the south yard, Sentinel defends the north sheds. Three lanes (A-long west,
// mid, B-long east), crates, containers, a rail car and a crane deck for cover.
// Every solid is a collider for movement and a surface a bullet stops on.
// Textures are drawn on canvases at load — no files, no network.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

// ---- Canvas textures ----
function paintCanvas(size, draw, repeat = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  return tex;
}

function scatter(g, size, count, fill) {
  for (let i = 0; i < count; i += 1) fill(g, Math.random() * size, Math.random() * size);
}

function concreteTexture() {
  return paintCanvas(256, (g, s) => {
    g.fillStyle = '#4a4640';
    g.fillRect(0, 0, s, s);
    scatter(g, s, 2600, (ctx, x, y) => {
      const v = 60 + Math.random() * 40;
      ctx.fillStyle = `rgba(${v}, ${v - 4}, ${v - 10}, 0.25)`;
      ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
    });
    g.strokeStyle = 'rgba(20, 18, 16, 0.5)';
    g.lineWidth = 1;
    for (let i = 0; i < 7; i += 1) {
      g.beginPath();
      let x = Math.random() * s;
      let y = Math.random() * s;
      g.moveTo(x, y);
      for (let j = 0; j < 4; j += 1) {
        x += (Math.random() - 0.5) * 70;
        y += (Math.random() - 0.5) * 70;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    g.fillStyle = 'rgba(30, 26, 22, 0.35)';
    scatter(g, s, 12, (ctx, x, y) => {
      ctx.beginPath();
      ctx.ellipse(x, y, 12 + Math.random() * 30, 8 + Math.random() * 20, Math.random() * 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }, 8);
}

function hazardTexture() {
  return paintCanvas(128, (g, s) => {
    g.fillStyle = '#f0a830';
    g.fillRect(0, 0, s, s);
    g.fillStyle = '#181d26';
    for (let x = -s; x < s * 2; x += 32) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + 16, 0);
      g.lineTo(x + 16 + s, s);
      g.lineTo(x + s, s);
      g.closePath();
      g.fill();
    }
  });
}

function containerTexture(base) {
  return paintCanvas(256, (g, s) => {
    g.fillStyle = base;
    g.fillRect(0, 0, s, s);
    for (let x = 0; x < s; x += 16) {
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.fillRect(x, 0, 5, s);
      g.fillStyle = 'rgba(255,255,255,0.07)';
      g.fillRect(x + 8, 0, 4, s);
    }
    scatter(g, s, 300, (ctx, x, y) => {
      ctx.fillStyle = `rgba(20,14,10,${0.05 + Math.random() * 0.2})`;
      ctx.fillRect(x, y, 2 + Math.random() * 6, 2 + Math.random() * 4);
    });
  });
}

function skyTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 256;
  const g = canvas.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#232c3e');
  grad.addColorStop(0.45, '#4a4a58');
  grad.addColorStop(0.62, '#c97e46');
  grad.addColorStop(0.72, '#8a5a3a');
  grad.addColorStop(1, '#181d26');
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 256);
  return new THREE.CanvasTexture(canvas);
}

// ---- Waypoint graph: nodes bots walk between, edges join neighbours. Bots pathfind with BFS. ----
const NODES = {
  vSpawn: [0, 17], vMid: [0, 12], vWest: [-8, 13], vEast: [8, 13],
  midLow: [0, 6], midDoor: [0, -1], midTop: [0, -8],
  aLong1: [-19, 10], aLong2: [-19, 0], aLong3: [-19, -8], aEntry: [-14, -9],
  bLong1: [19, 10], bLong2: [19, 0], bLong3: [19, -8], bEntry: [14, -9],
  midA: [-8, -3], midB: [8, -3],
  aSite: [-15, -12], aPlant: [-15, -12], aHold1: [-20, -15], aHold2: [-9, -15], aBack: [-15, -17],
  bSite: [15, -12], bPlant: [15, -12], bHold1: [20, -15], bHold2: [9, -15], bBack: [15, -17],
  sSpawn: [0, -17], sMid: [0, -13],
};
const EDGES = [
  ['vSpawn', 'vMid'], ['vSpawn', 'vWest'], ['vSpawn', 'vEast'],
  ['vMid', 'midLow'], ['vWest', 'aLong1'], ['vEast', 'bLong1'],
  ['midLow', 'midDoor'], ['midLow', 'aLong2'], ['midLow', 'bLong2'],
  ['midLow', 'midA'], ['midLow', 'midB'],
  ['midDoor', 'midTop'], ['midTop', 'sMid'],
  ['aLong1', 'aLong2'], ['aLong2', 'aLong3'], ['aLong3', 'aEntry'],
  ['bLong1', 'bLong2'], ['bLong2', 'bLong3'], ['bLong3', 'bEntry'],
  ['midA', 'aEntry'], ['midB', 'bEntry'],
  ['aEntry', 'aSite'], ['aSite', 'aHold1'], ['aSite', 'aHold2'], ['aSite', 'aBack'], ['aSite', 'aPlant'],
  ['bEntry', 'bSite'], ['bSite', 'bHold1'], ['bSite', 'bHold2'], ['bSite', 'bBack'], ['bSite', 'bPlant'],
  ['sMid', 'aHold2'], ['sMid', 'bHold2'], ['sMid', 'sSpawn'],
  ['aHold1', 'aBack'], ['bHold1', 'bBack'],
];

function buildAdjacency() {
  const adjacency = {};
  for (const id of Object.keys(NODES)) adjacency[id] = [];
  for (const [a, b] of EDGES) {
    adjacency[a].push(b);
    adjacency[b].push(a);
  }
  return adjacency;
}

// ---- Solid layout: [w, h, d, x, y, z, material, solid?] ----
// The mid pillar and the mid lamp sit at x=+2.5, off the x=0 midLow->midDoor
// lane line — a bot wedged on the centreline could never steer around them.
const BOXES = [
  // Ground: 48 x 40 m yard.
  [49, 0.4, 41, 0, -0.2, 0, 'ground'],
  // Perimeter walls, 5 m high.
  [0.6, 5, 41, -24.3, 2.5, 0, 'wall'],
  [0.6, 5, 41, 24.3, 2.5, 0, 'wall'],
  [49, 5, 0.6, 0, 2.5, -20.3, 'wall'],
  [49, 5, 0.6, 0, 2.5, 20.3, 'wall'],
  // Site A: Crane Deck (northwest). Raised deck, crane pillars, crates.
  [10, 0.8, 7, -15, 0.4, -12, 'steel'],
  [1.2, 0.4, 1.2, -11, 0.2, -7.5, 'wood'],
  [0.8, 7, 0.8, -19.5, 3.5, -15, 'rust'],
  [0.8, 7, 0.8, -10.5, 3.5, -15, 'rust'],
  [10.5, 0.7, 0.9, -15, 7, -15, 'rust'],
  [2.2, 1.1, 1.2, -18, 1.35, -10, 'wood'],
  [1.2, 1.1, 2.2, -11.5, 1.35, -13.5, 'wood'],
  [1.2, 1.1, 1.2, -18.5, 1.35, -14.5, 'wood'],
  [10, 0.06, 0.5, -15, 0.83, -8.6, 'hazard', false],
  // Site B: Depot (northeast). Rail car, containers, shed wall.
  [9, 2.6, 2.6, 15, 1.3, -15.5, 'contC'],
  [9, 0.5, 2.8, 15, 2.85, -15.5, 'dark'],
  [2.4, 2.4, 2.4, 20.5, 1.2, -10, 'contA'],
  [2.4, 2.4, 2.4, 9.5, 1.2, -10.5, 'contB'],
  [2.4, 1.2, 2.4, 20.5, 3.0, -10, 'contB'],
  [10, 0.06, 0.5, 15, 0.03, -8.6, 'hazard', false],
  // Mid: container wall with a door gap, plus a pillar.
  [2.4, 2.4, 6, -3.6, 1.2, 2, 'contA'],
  [2.4, 2.4, 6, 3.6, 1.2, 2, 'contB'],
  [2.4, 2.4, 2.4, -3.6, 3.6, 2, 'contB'],
  [1.4, 3.4, 1.4, 2.5, 1.7, -4, 'steel'],
  [3.2, 1.1, 1.4, -7, 0.55, 6, 'wood'],
  [3.2, 1.1, 1.4, 7, 0.55, 6, 'wood'],
  [1.4, 1.1, 1.4, -7, 0.55, -6, 'wood'],
  [1.4, 1.1, 1.4, 7, 0.55, -6, 'wood'],
  // Long lanes: crates, barrels, pipes.
  [2.2, 1.1, 1.2, -21, 0.55, 4, 'wood'],
  [1.2, 1.1, 2.2, -21, 0.55, -4, 'wood'],
  [2.2, 1.1, 1.2, 21, 0.55, 4, 'wood'],
  [1.2, 1.1, 2.2, 21, 0.55, -4, 'wood'],
  // Overhead pipe run along B-long.
  [0.5, 0.5, 22, 22.5, 3.6, 0, 'steel'],
  // Spawn cover.
  [2.4, 1.2, 1.2, -4, 0.6, 15, 'wood'],
  [2.4, 1.2, 1.2, 4, 0.6, 15, 'wood'],
  [2.4, 1.2, 1.2, -4, 0.6, -15.5, 'wood'],
  [2.4, 1.2, 1.2, 4, 0.6, -15.5, 'wood'],
];

// ---- Cylinders: [radius, height, x, y, z, material] ----
const CYLINDERS = [
  [0.5, 0.4, 11.5, 0.2, -14.2, 'dark'],
  [0.5, 0.4, 18.5, 0.2, -14.2, 'dark'],
  [0.55, 1.1, -22, 0.55, 12, 'rust'],
  [0.55, 1.1, 22, 0.55, 12, 'rust'],
  [0.55, 1.1, -22, 0.55, -13, 'rust'],
  [0.55, 1.1, 22, 0.55, -13, 'rust'],
];

const LAMPS = [[-15, -8.5], [15, -8.5], [2.5, 6], [-19, 10], [19, 10]];

const SKYLINE = [
  [-40, 6, -34, 8, 12], [-28, 9, -38, 10, 18], [-12, 5, -40, 7, 10],
  [6, 11, -38, 9, 22], [22, 7, -36, 8, 14], [38, 10, -30, 10, 20],
  [-44, 8, 10, 8, 16], [44, 6, 14, 8, 12], [-38, 5, 34, 8, 10], [36, 8, 36, 9, 16],
];

export function createWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const mats = {
    ground: new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.95, metalness: 0.02 }),
    steel: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.surface), roughness: 0.6, metalness: 0.55 }),
    wall: new THREE.MeshStandardMaterial({ color: new THREE.Color('#2e343c'), roughness: 0.85, metalness: 0.25 }),
    rust: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.rust), roughness: 0.9, metalness: 0.15 }),
    contA: new THREE.MeshStandardMaterial({ map: containerTexture('#3a4a52'), roughness: 0.7, metalness: 0.4 }),
    contB: new THREE.MeshStandardMaterial({ map: containerTexture('#5c4632'), roughness: 0.7, metalness: 0.4 }),
    contC: new THREE.MeshStandardMaterial({ map: containerTexture('#6b4a2a'), roughness: 0.7, metalness: 0.4 }),
    hazard: new THREE.MeshStandardMaterial({ map: hazardTexture(), roughness: 0.8, metalness: 0.1 }),
    wood: new THREE.MeshStandardMaterial({ color: new THREE.Color('#6b5232'), roughness: 0.9, metalness: 0.05 }),
    dark: new THREE.MeshStandardMaterial({ color: new THREE.Color('#20242a'), roughness: 0.9, metalness: 0.2 }),
    lamp: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.accent), emissive: new THREE.Color(PALETTE.accent), emissiveIntensity: 1.6 }),
  };

  const colliders = [];
  const shootables = [];

  function addBox(w, h, d, x, y, z, mat, solid = true) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats[mat]);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (solid) {
      colliders.push(new THREE.Box3().setFromObject(mesh));
      shootables.push(mesh);
    }
    return mesh;
  }

  function addCylinder(r, h, x, y, z, mat, segments = 14) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, segments), mats[mat]);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push(new THREE.Box3().setFromObject(mesh));
    shootables.push(mesh);
    return mesh;
  }

  for (const [w, h, d, x, y, z, mat, solid] of BOXES) addBox(w, h, d, x, y, z, mat, solid);
  for (const [r, h, x, y, z, mat] of CYLINDERS) addCylinder(r, h, x, y, z, mat);

  // Lamp posts with warm light at both sites and mid.
  for (const [x, z] of LAMPS) {
    addBox(0.18, 4.2, 0.18, x, 2.1, z, 'dark');
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.5), mats.lamp);
    head.position.set(x, 4.25, z);
    group.add(head);
    const light = new THREE.PointLight(new THREE.Color(PALETTE.accent), 14, 13, 1.8);
    light.position.set(x, 4.0, z);
    scene.add(light);
  }

  // Distant skyline silhouettes outside the walls, for depth.
  const skyline = new THREE.Group();
  const silMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#12151c'), fog: false });
  for (const [x, h, z, w, d] of SKYLINE) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), silMat);
    m.position.set(x, h / 2 - 0.2, z);
    skyline.add(m);
  }
  scene.add(skyline);

  // Sky dome: vertical dusk gradient. Sun disc low in the west.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(130, 24, 16),
    new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false }),
  );
  scene.add(sky);
  const sunCanvas = document.createElement('canvas');
  sunCanvas.width = 128;
  sunCanvas.height = 128;
  const sg = sunCanvas.getContext('2d');
  const radial = sg.createRadialGradient(64, 64, 4, 64, 64, 64);
  radial.addColorStop(0, 'rgba(255, 196, 120, 1)');
  radial.addColorStop(0.35, 'rgba(240, 150, 70, 0.55)');
  radial.addColorStop(1, 'rgba(240, 150, 70, 0)');
  sg.fillStyle = radial;
  sg.fillRect(0, 0, 128, 128);
  const sun = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sunCanvas), transparent: true, fog: false, depthWrite: false }),
  );
  sun.position.set(-108, 40, -72);
  sun.lookAt(0, 8, 0);
  scene.add(sun);

  // Light: low warm sun from the west, cool dusk fill, hemisphere sky/ground.
  const hemi = new THREE.HemisphereLight(new THREE.Color('#5a6a86'), new THREE.Color('#2a241e'), 1.0);
  scene.add(hemi);
  const sunLight = new THREE.DirectionalLight(new THREE.Color('#ffb066'), 2.2);
  sunLight.position.set(-45, 42, 8);
  sunLight.target.position.set(4, 0, -6);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -30;
  sunLight.shadow.camera.right = 30;
  sunLight.shadow.camera.top = 30;
  sunLight.shadow.camera.bottom = -30;
  sunLight.shadow.camera.far = 110;
  sunLight.shadow.bias = -0.0006;
  scene.add(sunLight, sunLight.target);
  const fill = new THREE.DirectionalLight(new THREE.Color('#7d8aa5'), 0.5);
  fill.position.set(20, 18, 24);
  scene.add(fill);

  // Site zones and plant spots.
  const sites = {
    A: { name: 'Crane Deck', zone: new THREE.Box3(new THREE.Vector3(-20, 0, -16), new THREE.Vector3(-10, 4, -8)), plant: new THREE.Vector3(-15, 0.8, -12) },
    B: { name: 'Depot', zone: new THREE.Box3(new THREE.Vector3(10, 0, -16), new THREE.Vector3(20, 4, -8)), plant: new THREE.Vector3(15, 0, -12) },
  };

  const spawns = {
    vanguard: [
      new THREE.Vector3(-4, 0, 17.5), new THREE.Vector3(-2, 0, 18.5),
      new THREE.Vector3(0, 0, 17), new THREE.Vector3(2, 0, 18.5), new THREE.Vector3(4, 0, 17.5),
    ],
    sentinel: [
      new THREE.Vector3(-4, 0, -17.5), new THREE.Vector3(-2, 0, -18.5),
      new THREE.Vector3(0, 0, -17), new THREE.Vector3(2, 0, -18.5), new THREE.Vector3(4, 0, -17.5),
    ],
  };

  const waypoints = { nodes: NODES, edges: EDGES, adjacency: buildAdjacency() };

  return { colliders, shootables, group, sites, spawns, waypoints };
}
