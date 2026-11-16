// Hit feedback: tracers, impact sparks, blood puffs, explosions. All effects are
// pooled meshes reused across frames — no new objects are made in the hot loop.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const TRACER_POOL = 24;
const SPARK_POOL = 40;
const SMOKE_POOL = 16;

// A round-robin pool: spawn() hands out the next slot, wrapping forever.
function makePool(count, build) {
  const slots = [];
  for (let i = 0; i < count; i += 1) slots.push(build());
  let cursor = 0;
  return {
    slots,
    next() {
      const slot = slots[cursor];
      cursor = (cursor + 1) % count;
      return slot;
    },
  };
}

function softDiscTexture(inner, outer) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  const radial = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  radial.addColorStop(0, inner);
  radial.addColorStop(1, outer);
  g.fillStyle = radial;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

export function createEffects(scene, camera) {
  // Tracers: thin stretched boxes from muzzle to hit point, fading in 70 ms.
  const tracerMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.85, depthWrite: false,
  });
  const tracers = makePool(TRACER_POOL, () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 1), tracerMat.clone());
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, life: 0 };
  });

  // Sparks: small tetrahedra that fly out and fall, used for wall impacts and blood.
  const sparkGeo = new THREE.TetrahedronGeometry(0.06);
  const sparks = makePool(SPARK_POOL, () => {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(sparkGeo, mat);
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, vel: new THREE.Vector3(), life: 0, gravity: 9 };
  });

  // Smoke puffs: soft sprites that grow and fade (explosions, grenade landings).
  const smokeTex = softDiscTexture('rgba(200, 190, 175, 0.7)', 'rgba(200, 190, 175, 0)');
  const smokes = makePool(SMOKE_POOL, () => {
    const mat = new THREE.SpriteMaterial({ map: smokeTex, transparent: true, opacity: 0, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    scene.add(sprite);
    return { sprite, life: 0, maxLife: 1, grow: 1 };
  });

  // Explosion flash: a point light + a bright sphere that pops and fades.
  const boomLight = new THREE.PointLight(new THREE.Color('#ffb066'), 0, 22, 1.6);
  scene.add(boomLight);
  const boomMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffcf8a'), transparent: true, opacity: 0, depthWrite: false }),
  );
  boomMesh.visible = false;
  scene.add(boomMesh);
  let boomLife = 0;

  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  function spawnSpark(point, normal, color, speed, count, gravity) {
    for (let n = 0; n < count; n += 1) {
      const s = sparks.next();
      s.mesh.visible = true;
      s.mesh.position.copy(point);
      s.mesh.material.color.set(color);
      s.mesh.material.opacity = 0.95;
      tmpA.copy(normal).multiplyScalar(speed * (0.5 + Math.random() * 0.8));
      tmpB.set((Math.random() - 0.5) * speed, Math.random() * speed * 0.7, (Math.random() - 0.5) * speed);
      s.vel.copy(tmpA).add(tmpB);
      s.life = 0.35 + Math.random() * 0.25;
      s.gravity = gravity;
    }
  }

  function puff(point, scale, life) {
    const s = smokes.next();
    s.sprite.visible = true;
    s.sprite.position.copy(point);
    s.sprite.scale.setScalar(0.4);
    s.sprite.material.opacity = 0.55;
    s.life = life;
    s.maxLife = life;
    s.grow = scale;
  }

  const api = {
    tracer(from, to) {
      const t = tracers.next();
      tmpA.copy(to).sub(from);
      const len = tmpA.length();
      if (len < 0.1) return;
      t.mesh.visible = true;
      t.mesh.position.copy(from).addScaledVector(tmpA, 0.5);
      t.mesh.scale.set(1, 1, len);
      t.mesh.lookAt(to);
      t.mesh.material.opacity = 0.85;
      t.life = 0.12;
    },
    impact(point, normal) {
      spawnSpark(point, normal, PALETTE.accent, 3.2, 6, 9);
    },
    blood(point, normal) {
      spawnSpark(point, normal, '#a02020', 2.2, 8, 7);
    },
    smoke(point, scale = 1.6, life = 1.1) {
      puff(point, scale, life);
    },
    explosion(point) {
      boomLight.position.copy(point);
      boomLight.intensity = 90;
      boomMesh.position.copy(point);
      boomMesh.visible = true;
      boomMesh.scale.setScalar(0.6);
      boomMesh.material.opacity = 0.95;
      boomLife = 0.45;
      spawnSpark(point, tmpA.set(0, 1, 0), '#ffcf8a', 7, 14, 10);
      puff(point, 4.5, 1.6);
      puff(tmpB.copy(point).add(new THREE.Vector3(0, 1.2, 0)), 3, 1.3);
    },
    muzzleFlash() {
      // The weapon's own flash quad handles the look; the light is driven by weapon.step.
    },
    step(dt) {
      for (const t of tracers.slots) {
        if (!t.mesh.visible) continue;
        t.life -= dt;
        if (t.life <= 0) t.mesh.visible = false;
        else t.mesh.material.opacity = 0.85 * (t.life / 0.12);
      }
      for (const s of sparks.slots) {
        if (!s.mesh.visible) continue;
        s.life -= dt;
        if (s.life <= 0) {
          s.mesh.visible = false;
          continue;
        }
        s.vel.y -= s.gravity * dt;
        s.mesh.position.addScaledVector(s.vel, dt);
        s.mesh.material.opacity = Math.min(0.95, s.life * 3);
        s.mesh.rotation.x += dt * 9;
        s.mesh.rotation.y += dt * 7;
      }
      for (const s of smokes.slots) {
        if (!s.sprite.visible) continue;
        s.life -= dt;
        if (s.life <= 0) {
          s.sprite.visible = false;
          continue;
        }
        const k = 1 - s.life / s.maxLife;
        s.sprite.scale.setScalar(0.4 + k * s.grow);
        s.sprite.material.opacity = 0.55 * (s.life / s.maxLife);
      }
      if (boomLife > 0) {
        boomLife -= dt;
        const k = Math.max(0, boomLife / 0.45);
        boomLight.intensity = 90 * k;
        boomMesh.scale.setScalar(0.6 + (1 - k) * 4.5);
        boomMesh.material.opacity = 0.95 * k;
        if (boomLife <= 0) {
          boomMesh.visible = false;
          boomLight.intensity = 0;
        }
      }
      void camera;
    },
  };
  return api;
}
