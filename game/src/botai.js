// Bot brains: one step function per bot per fixed tick. A bot reads the world through
// line of sight (a real raycast, staggered at 10 Hz) and hearing (noise events from
// gunfire), then walks the waypoint graph, holds angles, fires in bursts, plants and
// defuses. Roles come from the match: attackers take a site, defenders hold one.
import * as THREE from 'three';

const TURN_RATE = 4.2;
const EYE = 1.55;
const WALK_SPEED = 3.6;
const AIM_SPEED = 1.4;
const SIGHT_RANGE = 55;
const SCAN_HZ = 10;
const STUCK_AFTER = 2;
const SIDESTEP_FOR = 0.8;
const ARRIVE_DIST = 0.5;

// Shortest turn from a to b, clamped to t of the way there.
function turnToward(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(1, t);
}

function headingTo(from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

export function createBotAI(world) {
  const tmp = new THREE.Vector3();

  function nearestNodeId(pos) {
    let start = null;
    let bestD = Infinity;
    for (const [id, [nx, nz]] of Object.entries(world.waypoints.nodes)) {
      const d = (nx - pos.x) * (nx - pos.x) + (nz - pos.z) * (nz - pos.z);
      if (d < bestD) {
        bestD = d;
        start = id;
      }
    }
    return start;
  }

  function setPath(bot, goalNode) {
    bot.path = bot.findPath(nearestNodeId(bot.group.position), goalNode, bot.random);
    bot.pathIndex = 0;
  }

  function nodePos(id) {
    const n = world.waypoints.nodes[id];
    return { x: n[0], z: n[1] };
  }

  function walkTo(bot, x, z, dt, ctx) {
    const pos = bot.group.position;
    const dx = x - pos.x;
    const dz = z - pos.z;
    if (Math.hypot(dx, dz) < ARRIVE_DIST) {
      bot.stuckTime = 0;
      bot.sideTime = 0;
      return true;
    }
    bot.yaw = turnToward(bot.yaw, Math.atan2(-dx, -dz), TURN_RATE * dt);
    bot.group.rotation.y = bot.yaw;
    const speed = bot.state === 'engage' ? AIM_SPEED : WALK_SPEED;
    if (bot.sideTime > 0) {
      // Stuck recovery: sidestep perpendicular to the facing yaw for a moment,
      // alternating sides each time, then resume the walk.
      bot.sideTime -= dt;
      const dir = bot.sideDir || 1;
      const sx = pos.x + Math.cos(bot.yaw) * dir * speed * dt;
      const sz = pos.z + -Math.sin(bot.yaw) * dir * speed * dt;
      if (!ctx.blocked(sx, pos.z)) pos.x = sx;
      if (!ctx.blocked(pos.x, sz)) pos.z = sz;
    } else {
      // Step forward along the facing yaw; waypoints sit in open lanes, so no steering needed.
      const nx = pos.x + -Math.sin(bot.yaw) * speed * dt;
      const nz = pos.z + -Math.cos(bot.yaw) * speed * dt;
      if (!ctx.blocked(nx, pos.z)) pos.x = nx;
      if (!ctx.blocked(pos.x, nz)) pos.z = nz;
      // A bot wedged on geometry makes no progress: after ~2 s, sidestep.
      if (bot.stuckX === null) {
        bot.stuckX = pos.x;
        bot.stuckZ = pos.z;
        bot.stuckTime = 0;
      } else if (Math.hypot(pos.x - bot.stuckX, pos.z - bot.stuckZ) > 0.4) {
        bot.stuckX = pos.x;
        bot.stuckZ = pos.z;
        bot.stuckTime = 0;
      } else {
        bot.stuckTime += dt;
        if (bot.stuckTime > STUCK_AFTER) {
          bot.sideTime = SIDESTEP_FOR;
          bot.sideDir = -(bot.sideDir || 1);
          bot.stuckTime = 0;
          bot.stuckX = pos.x;
          bot.stuckZ = pos.z;
        }
      }
    }
    bot.moving = true;
    bot.walkPhase += dt * 9;
    const swing = Math.sin(bot.walkPhase) * 0.08;
    bot.group.children[0].rotation.x = swing;
    bot.group.children[1].rotation.x = -swing;
    return false;
  }

  function fallOver(bot, dt) {
    if (bot.fall < 1) {
      bot.fall = Math.min(1, bot.fall + dt / 0.4);
      bot.group.rotation.x = -bot.fall * 1.45;
      bot.group.position.y = -bot.fall * 0.1;
    } else {
      bot.fadeTimer += dt;
      if (bot.fadeTimer > 3) bot.group.visible = false;
    }
  }

  function listen(bot, ctx, now) {
    // Hearing: a fresh noise nearby becomes an investigation.
    if (bot.state === 'engage' || bot.state === 'plant' || bot.state === 'defuse') return;
    const pos = bot.group.position;
    for (const n of ctx.noise) {
      if (n.time < now - 0.5 || n.time > now) continue;
      const d2 = (n.pos.x - pos.x) ** 2 + (n.pos.z - pos.z) ** 2;
      if (d2 < n.radius * n.radius && bot.random() < 0.7) {
        bot.investigate = { x: n.pos.x, z: n.pos.z };
        bot.investigateTimer = 3;
        if (bot.state === 'hold') bot.state = 'investigate';
      }
    }
  }

  function scan(bot, ctx, dt) {
    // Line of sight, staggered so nine bots do not raycast every frame.
    bot.losTimer -= dt;
    if (bot.losTimer > 0) return;
    bot.losTimer = 1 / SCAN_HZ + bot.index * 0.011;
    bot.targetVisible = false;
    bot.target = null;
    const pos = bot.group.position;
    let bestD = Infinity;
    for (const e of ctx.enemiesOf(bot)) {
      if (!e.alive) continue;
      const d = Math.hypot(e.pos.x - pos.x, e.pos.z - pos.z);
      if (d > SIGHT_RANGE) continue;
      if (!ctx.los(pos.x, pos.y + EYE, pos.z, e.pos.x, e.pos.y + 1.2, e.pos.z, e)) continue;
      if (d < bestD) {
        bestD = d;
        bot.target = e;
        bot.targetVisible = true;
      }
    }
    if (bot.targetVisible && bot.state !== 'engage') {
      bot.reactTimer = 0.25 + bot.random() * 0.35 + bestD * 0.004;
      bot.prevState = bot.state;
      bot.state = 'engage';
      bot.burstLeft = 0;
      bot.burstPause = 0;
    }
  }

  function fight(bot, ctx, dt) {
    const t = bot.target;
    const pos = bot.group.position;
    if (!t || !t.alive || !bot.targetVisible) {
      bot.loseTimer = (bot.loseTimer || 0) + dt;
      if (bot.loseTimer > 1.2) {
        bot.loseTimer = 0;
        bot.state = bot.investigate ? 'investigate' : (bot.prevState || 'hold');
      }
      return;
    }
    bot.loseTimer = 0;
    bot.yaw = turnToward(bot.yaw, headingTo(pos, t.pos), TURN_RATE * dt);
    bot.group.rotation.y = bot.yaw;
    bot.moving = false;
    bot.reactTimer -= dt;
    if (bot.reactTimer > 0) return;
    bot.loadout.step(dt);
    if (bot.burstLeft <= 0) {
      bot.burstPause -= dt;
      if (bot.burstPause <= 0) {
        bot.burstLeft = 3 + Math.floor(bot.random() * 3);
        bot.burstPause = 0.5 + bot.random() * 0.4;
      }
      return;
    }
    if (!bot.loadout.ready()) {
      if (bot.loadout.state.reloadLeft === 0) bot.loadout.reload();
      return;
    }
    const def = bot.loadout.def();
    const dist = Math.hypot(t.pos.x - pos.x, t.pos.z - pos.z);
    const targetMoving = Math.hypot(t.vel?.x || 0, t.vel?.z || 0) > 1.5;
    const err = 0.012 + dist * 0.0006 + (targetMoving ? 0.012 : 0);
    bot.loadout.takeRound();
    bot.loadout.pullTrigger();
    ctx.botShoot(bot, t, err, def);
    bot.burstLeft -= 1;
  }

  function investigateNoise(bot, ctx, dt) {
    if (!bot.investigate) return;
    bot.investigateTimer -= dt;
    const arrived = walkTo(bot, bot.investigate.x, bot.investigate.z, dt, ctx);
    if (arrived || bot.investigateTimer <= 0) {
      bot.holdTimer = 1.5;
      bot.state = 'hold';
      bot.investigate = null;
    }
  }

  function holdAngle(bot, ctx, dt, now) {
    bot.holdTimer -= dt;
    const sweep = Math.sin(now * 0.5 + bot.index * 1.3) * 0.55;
    bot.yaw = turnToward(bot.yaw, bot.holdYaw + sweep, 2.2 * dt);
    bot.group.rotation.y = bot.yaw;
    bot.moving = false;
    if (bot.holdTimer > 0 || bot.role !== 'attack' || !bot.isCarrier || ctx.bomb.state !== 'carried') return;
    // Carrier reaches the site and nobody is watching: plant.
    const site = ctx.bomb.site;
    const p = world.sites[site].plant;
    const pos = bot.group.position;
    if (Math.hypot(p.x - pos.x, p.z - pos.z) < 1.6) {
      bot.state = 'plant';
      bot.plantTimer = 0;
      ctx.plantStart(bot);
      return;
    }
    setPath(bot, site === 'A' ? 'aPlant' : 'bPlant');
    bot.state = 'advance';
  }

  function followPath(bot, ctx, dt) {
    if (bot.pathIndex >= bot.path.length) {
      if (bot.afterMid) {
        const next = bot.afterMid;
        bot.afterMid = null;
        setPath(bot, next);
        return;
      }
      const pos = bot.group.position;
      // A defender who reaches the planted spike starts defusing.
      if (bot.role === 'defend' && ctx.bomb.state === 'planted' && ctx.bomb.plantPos) {
        const p = ctx.bomb.plantPos;
        if (Math.hypot(p.x - pos.x, p.z - pos.z) < 2.4) {
          bot.state = 'defuse';
          bot.defuseTimer = 0;
          ctx.defuseStart(bot);
          return;
        }
        setPath(bot, ctx.bomb.site === 'A' ? 'aSite' : 'bSite');
        return;
      }
      if (bot.role === 'attack' && bot.isCarrier && ctx.bomb.state === 'carried') {
        const site = ctx.bomb.site;
        const p = world.sites[site].plant;
        if (Math.hypot(p.x - pos.x, p.z - pos.z) < 2.2) {
          bot.state = 'plant';
          bot.plantTimer = 0;
          ctx.plantStart(bot);
          return;
        }
      }
      bot.state = 'hold';
      bot.holdTimer = 4 + bot.random() * 4;
      bot.holdYaw = bot.yaw;
      return;
    }
    const node = nodePos(bot.path[bot.pathIndex]);
    if (walkTo(bot, node.x, node.z, dt, ctx)) bot.pathIndex += 1;
  }

  function stepBot(bot, dt, ctx) {
    if (!bot.alive) {
      fallOver(bot, dt);
      return;
    }
    const now = ctx.time;
    listen(bot, ctx, now);
    scan(bot, ctx, dt);

    // Plant / defuse channels are owned by the match (game.js): the bot stands
    // still while the channel runs; main.js advances it each tick.
    if (bot.state === 'plant' || bot.state === 'defuse') {
      bot.moving = false;
      return;
    }
    if (bot.state === 'engage') {
      fight(bot, ctx, dt);
      return;
    }
    if (bot.state === 'investigate') {
      investigateNoise(bot, ctx, dt);
      return;
    }
    if (bot.state === 'hold') {
      holdAngle(bot, ctx, dt, now);
      return;
    }
    if (bot.state === 'advance' || bot.state === 'rotate') {
      followPath(bot, ctx, dt);
    }
  }

  return { stepBot, setPath, nodePos };
}
