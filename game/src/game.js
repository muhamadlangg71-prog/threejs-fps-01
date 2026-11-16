// The match director: owns the round clock, the spike, the money and the score.
// One state object holds everything; rendering only ever reads this state.
// Phases run menu -> buy (15 s) -> live (100 s, or 40 s once the spike is down)
// -> roundEnd (4 s) -> next buy. First side to 7 rounds takes the match, and
// the sides swap after round 7.
//
// PHASE GATING — the rule every combat entry point obeys: nothing dies, plants
// or defuses outside the live phase. endRound() returns early unless the phase
// is 'live' or 'buy', damagePlayer() refuses damage outside 'live', and
// tryPlant / tryDefuse refuse to start a channel outside 'live'. The buy phase
// is therefore bloodless by construction: bots may walk and shop, but no kill,
// plant or defuse can happen until the round goes live.
import * as THREE from 'three';
import { WEAPONS, ARMOR_PRICE } from './weapons.js';

// ---- Round timing ----
const BUY_LEN = 15;
const ROUND_LEN = 100;
const FUSE_LEN = 40;
const PLANT_LEN = 3;
const DEFUSE_LEN = 5;
const END_PAUSE = 4;
const ROUNDS_TO_WIN = 7;
const HALFTIME_AT = 7;

// ---- Economy (see settleRound for the payout rule) ----
const OPENING_FUNDS = 800;
const WIN_PAYOUT = 3250;
const LOSS_BASE = 1900;
const LOSS_STEP = 500;
const LOSS_CAP = 3400;
const KILL_BOUNTY = 300;
const PLANT_BOUNTY = 300;
const SITE_A_ODDS = 0.55;

// ---- Combat ----
const HEADSHOT_MULT = 3;
const ARMOR_ABSORB = 0.5;
const DEFUSE_REACH = 2.2;
const CARRIER_PLANT_REACH = 2.2;

function freshBomb() {
  return {
    status: 'carried', site: 'A', carrier: 'player',
    plantPos: null, plantedAt: 0, defuser: null,
  };
}

function freshChannel() {
  return { active: false, progress: 0, who: null, site: null };
}

export function createGame(world, bots, player, loadout, hud, audio, effects) {
  const state = {
    phase: 'menu',
    half: 1,
    round: 0,
    score: { vanguard: 0, sentinel: 0 },
    lossStreak: { vanguard: 0, sentinel: 0 },
    money: OPENING_FUNDS,
    timer: 0,
    time: 0,
    bomb: freshBomb(),
    plant: freshChannel(),
    defuse: freshChannel(),
    feed: [],
    noise: [],
    winner: null,
    reason: '',
    kills: { player: 0, deaths: 0 },
    lastSurvived: false,
  };

  const probe = new THREE.Box3();
  const probePoint = new THREE.Vector3();

  // Roles flip at halftime; the teams themselves never change.
  function sideTeam(role) {
    if (state.half === 1) return role === 'attack' ? 'vanguard' : 'sentinel';
    return role === 'attack' ? 'sentinel' : 'vanguard';
  }
  const attackingSide = () => sideTeam('attack');
  const defendingSide = () => sideTeam('defend');
  const playerSide = () => 'vanguard';
  const playerIsAttacking = () => attackingSide() === 'vanguard';

  function postFeed(text, cls) {
    state.feed.unshift({ text, cls, t: 0 });
    if (state.feed.length > 5) state.feed.pop();
    hud.setFeed(state.feed);
  }

  function hear(x, z, radius) {
    state.noise.push({ pos: { x, z }, radius, time: state.time || 0 });
    if (state.noise.length > 24) state.noise.shift();
  }

  function isBlocked(x, z) {
    probe.min.set(x - 0.34, 0.05, z - 0.34);
    probe.max.set(x + 0.34, 1.7, z + 0.34);
    for (const solid of world.colliders) {
      if (probe.intersectsBox(solid)) return true;
    }
    return false;
  }

  function spawnList(team) {
    // Vanguard always spawns south in half 1, north in half 2.
    const south = state.half === 1;
    if (team === 'vanguard') return south ? world.spawns.vanguard : world.spawns.sentinel;
    return south ? world.spawns.sentinel : world.spawns.vanguard;
  }

  function spawnFacing(team) {
    const south = state.half === 1;
    if (team === 'vanguard') return south ? Math.PI : 0;
    return south ? 0 : Math.PI;
  }

  function livingCount(team) {
    let n = team === 'vanguard' && player.state.alive ? 1 : 0;
    for (const bot of bots.bots) {
      if (bot.team === team && bot.alive) n += 1;
    }
    return n;
  }

  function pickAttackLane(bot, slot, count) {
    const site = state.bomb.site;
    const other = site === 'A' ? 'B' : 'A';
    const ai = bot.ai;
    const lanes = [
      site === 'A' ? 'aEntry' : 'bEntry',
      site === 'A' ? 'midA' : 'midB',
      other === 'A' ? 'aLong2' : 'bLong2',
      'midDoor',
    ];
    ai.setPath(bot, lanes[Math.min(slot, lanes.length - 1)]);
    bot.state = 'advance';
    if (slot === 1) bot.afterMid = site === 'A' ? 'aEntry' : 'bEntry';
    bot.holdYaw = 0;
  }

  function pickDefendHold(bot, slot, count) {
    const ai = bot.ai;
    const holds = bot.site === 'A'
      ? [{ node: 'aHold1', yaw: 0.9 }, { node: 'aHold2', yaw: -0.9 }, { node: 'aBack', yaw: Math.PI }]
      : [{ node: 'bHold1', yaw: -0.9 }, { node: 'bHold2', yaw: 0.9 }, { node: 'bBack', yaw: Math.PI }];
    if (slot === count - 1) {
      // Roamer: mid.
      ai.setPath(bot, 'midTop');
      bot.state = 'advance';
      bot.holdNode = 'midTop';
      bot.holdYaw = Math.PI;
      return;
    }
    const hold = holds[slot % holds.length];
    ai.setPath(bot, hold.node);
    bot.state = 'advance';
    bot.holdNode = hold.node;
    bot.holdYaw = hold.yaw;
  }

  function resetPlayerForRound() {
    const survived = state.lastSurvived === true;
    const spots = spawnList('vanguard');
    const spot = spots[2];
    player.teleport(spot.x, spot.y, spot.z, spawnFacing('vanguard'));
    player.state.health = 100;
    player.state.armor = survived ? player.state.armor : 0;
    player.state.alive = true;
    loadout.resetRound(survived);
    state.lastSurvived = false;
  }

  function deployBots() {
    const atk = attackingSide();
    const def = defendingSide();
    const attackers = bots.bots.filter((b) => b.team === atk);
    const defenders = bots.bots.filter((b) => b.team === def);
    const atkSpawns = spawnList(atk);
    const defSpawns = spawnList(def);
    attackers.forEach((bot, i) => {
      const spawn = atkSpawns[i % atkSpawns.length];
      bots.resetBot(bot, spawn, spawnFacing(atk));
      bot.role = 'attack';
      bot.site = state.bomb.site;
      bots.buyFor(bot);
      bot.isCarrier = false;
      pickAttackLane(bot, i, attackers.length);
    });
    defenders.forEach((bot, i) => {
      const spawn = defSpawns[i % defSpawns.length];
      bots.resetBot(bot, spawn, spawnFacing(def));
      bot.role = 'defend';
      bot.site = i % 2 === 0 ? 'A' : 'B';
      bots.buyFor(bot);
      bot.isCarrier = false;
      pickDefendHold(bot, i, defenders.length);
    });
    return attackers;
  }

  function beginMatch() {
    state.phase = 'buy';
    state.half = 1;
    state.round = 0;
    state.score = { vanguard: 0, sentinel: 0 };
    state.lossStreak = { vanguard: 0, sentinel: 0 };
    state.money = OPENING_FUNDS;
    state.kills = { player: 0, deaths: 0 };
    state.winner = null;
    beginRound();
  }

  function beginRound() {
    state.round += 1;
    state.phase = 'buy';
    state.timer = BUY_LEN;
    state.bomb = freshBomb();
    state.bomb.site = Math.random() < SITE_A_ODDS ? 'A' : 'B';
    state.plant = freshChannel();
    state.defuse = freshChannel();
    state.feed = [];
    hud.setFeed([]);
    hud.setPhase('buy', state.round, state.score);
    hud.setBomb(null);
    hud.setMoney(state.money);

    resetPlayerForRound();
    if (playerIsAttacking()) {
      state.bomb.carrier = 'player';
      hud.setBomb('carry');
    } else {
      state.bomb.carrier = null;
      hud.setBomb(null);
    }

    const attackers = deployBots();
    // If the player defends, a random attacker bot carries the spike.
    if (!playerIsAttacking()) {
      const carrier = attackers[Math.floor(Math.random() * attackers.length)];
      carrier.isCarrier = true;
      state.bomb.carrier = carrier;
    }
    audio.buy();
    hud.showBanner(
      `ROUND ${state.round}`,
      playerIsAttacking() ? `Plant the spike at Site ${state.bomb.site}` : 'Defend both sites',
      2.6,
    );
  }

  function settleRound(winner, reason) {
    if (state.phase !== 'live' && state.phase !== 'buy') return;
    state.phase = 'roundEnd';
    state.timer = END_PAUSE;
    state.winner = winner;
    state.reason = reason;
    state.score[winner] += 1;
    const loser = winner === 'vanguard' ? 'sentinel' : 'vanguard';
    state.lossStreak[winner] = 0;
    state.lossStreak[loser] += 1;
    // Economy: winners take $3250, losers take $1900 plus $500 per consecutive
    // loss (cap +$1500). Every bot is paid by its own team's result.
    const losePay = Math.min(LOSS_CAP, LOSS_BASE + (state.lossStreak[loser] - 1) * LOSS_STEP);
    state.money += winner === 'vanguard' ? WIN_PAYOUT : losePay;
    for (const bot of bots.bots) {
      bot.money += bot.team === winner ? WIN_PAYOUT : losePay;
    }
    state.lastSurvived = player.state.alive;
    const playerWon = winner === 'vanguard';
    hud.showBanner(
      playerWon ? 'VANGUARD WINS THE ROUND' : 'SENTINEL WINS THE ROUND',
      reason,
      3.6,
    );
    hud.setPhase('roundEnd', state.round, state.score);
    if (playerWon) audio.roundWin();
    else audio.roundLose();
    postFeed(
      `${winner === 'vanguard' ? 'Vanguard' : 'Sentinel'} takes round ${state.round} — ${reason}`,
      playerWon ? 'good' : 'bad',
    );
    if (state.bomb.status === 'planted') hud.setBomb(null);
  }

  function finishMatchIfWon() {
    if (state.score.vanguard >= ROUNDS_TO_WIN || state.score.sentinel >= ROUNDS_TO_WIN) {
      state.phase = 'matchEnd';
      const winner = state.score.vanguard >= ROUNDS_TO_WIN ? 'vanguard' : 'sentinel';
      hud.showMatchEnd(winner === 'vanguard' ? 'VANGUARD' : 'SENTINEL', state.score, state.kills);
      if (document.pointerLockElement) document.exitPointerLock();
      return true;
    }
    if (state.round === HALFTIME_AT && state.half === 1) {
      state.half = 2;
      hud.showBanner('HALFTIME — SIDES SWAP', 'Vanguard now defends, Sentinel attacks', 3);
    }
    return false;
  }

  function passSpike(from) {
    // The spike drops where its carrier died: the nearest living attacker bot
    // picks it up, else the player if they attack and live, else nobody has it.
    const attackers = bots.bots.filter((b) => b.team === attackingSide() && b.alive && b !== from);
    if (attackers.length) {
      const carrier = attackers[0];
      carrier.isCarrier = true;
      state.bomb.carrier = carrier;
      return;
    }
    if (playerIsAttacking() && player.state.alive) {
      state.bomb.carrier = 'player';
      hud.setBomb('carry');
      return;
    }
    state.bomb.carrier = null;
  }

  function registerKill(victim, killer, part) {
    const victimName = victim === 'player' ? 'You' : victim.name;
    const killerName = killer === 'player' ? 'You' : (killer ? killer.name : '—');
    const weaponName = killer === 'player'
      ? loadout.def().name
      : (killer ? killer.loadout.def().name : '—');
    postFeed(
      `${killerName} ▸ ${victimName}  ·  ${weaponName}${part === 'head' ? '  ·  HEADSHOT' : ''}`,
      killer === 'player' ? 'good' : 'bad',
    );
    if (killer === 'player') {
      state.money += KILL_BOUNTY;
      state.kills.player += 1;
      hud.setMoney(state.money);
    } else if (killer) {
      killer.money += KILL_BOUNTY;
      killer.kills += 1;
    }
    if (victim === 'player') {
      state.kills.deaths += 1;
      player.state.alive = false;
      if (state.bomb.carrier === 'player' && state.bomb.status === 'carried') {
        const attackers = bots.bots.filter((b) => b.team === attackingSide() && b.alive);
        if (attackers.length) {
          const carrier = attackers[0];
          carrier.isCarrier = true;
          state.bomb.carrier = carrier;
          postFeed(`${carrier.name} picks up the spike`, 'info');
        } else {
          state.bomb.carrier = null;
        }
      }
      hud.setBomb(null);
      if (document.pointerLockElement) document.exitPointerLock();
      hud.showOverlay('dead', state.score);
    } else if (victim) {
      if (state.bomb.carrier === victim && state.bomb.status === 'carried') passSpike(victim);
    }
    // Elimination wins the round — unless the spike is already planted.
    if (state.bomb.status !== 'planted') {
      if (livingCount('vanguard') === 0) settleRound('sentinel', 'Vanguard eliminated');
      else if (livingCount('sentinel') === 0) settleRound('vanguard', 'Sentinel eliminated');
    }
  }

  function siteAt(pos) {
    for (const key of ['A', 'B']) {
      if (world.sites[key].zone.containsPoint(probePoint.set(pos.x, pos.y + 0.5, pos.z))) return key;
    }
    return null;
  }

  function beginPlant(who) {
    if (state.phase !== 'live' || state.bomb.status !== 'carried') return false;
    if (who !== state.bomb.carrier) return false;
    const pos = who === 'player' ? player.state.position : who.group.position;
    const site = siteAt(pos);
    if (!site) return false;
    state.plant.active = true;
    state.plant.who = who;
    state.plant.progress = 0;
    state.plant.site = site;
    return true;
  }

  function tickPlant(dt, who) {
    if (!state.plant.active || state.plant.who !== who) return;
    state.plant.progress += dt / PLANT_LEN;
    hud.setChannel('PLANTING SPIKE', state.plant.progress);
    if (state.plant.progress < 1) return;
    state.plant.active = false;
    hud.setChannel(null, 0);
    state.bomb.status = 'planted';
    state.bomb.site = state.plant.site;
    state.bomb.plantedAt = state.timer;
    state.bomb.plantPos = world.sites[state.plant.site].plant.clone();
    state.timer = FUSE_LEN;
    if (who === 'player') {
      state.money += PLANT_BOUNTY;
      hud.setMoney(state.money);
    }
    hud.setBomb('planted');
    hud.showBanner('SPIKE PLANTED', `Site ${state.bomb.site} — ${FUSE_LEN}s to detonation`, 2.6);
    audio.plantBeep(true);
    postFeed(`Spike planted at Site ${state.bomb.site}`, who === 'player' ? 'good' : 'bad');
    // Every defender rotates to the planted site.
    for (const bot of bots.bots) {
      if (bot.team === defendingSide() && bot.alive) {
        bot.state = 'rotate';
        bot.ai.setPath(bot, state.bomb.site === 'A' ? 'aSite' : 'bSite');
      }
    }
  }

  function beginDefuse(who) {
    if (state.phase !== 'live' || state.bomb.status !== 'planted') return false;
    const pos = who === 'player' ? player.state.position : who.group.position;
    if (!state.bomb.plantPos || pos.distanceTo(state.bomb.plantPos) > DEFUSE_REACH) return false;
    state.defuse.active = true;
    state.defuse.who = who;
    state.defuse.progress = 0;
    return true;
  }

  function tickDefuse(dt, who) {
    if (!state.defuse.active || state.defuse.who !== who) return;
    state.defuse.progress += dt / DEFUSE_LEN;
    hud.setChannel('DEFUSING SPIKE', state.defuse.progress);
    if (state.defuse.progress < 1) return;
    state.defuse.active = false;
    hud.setChannel(null, 0);
    state.bomb.status = 'defused';
    settleRound('sentinel', 'Spike defused');
  }

  function dropChannel(who) {
    if (state.plant.active && state.plant.who === who) {
      state.plant.active = false;
      hud.setChannel(null, 0);
    }
    if (state.defuse.active && state.defuse.who === who) {
      state.defuse.active = false;
      hud.setChannel(null, 0);
    }
  }

  function hurtPlayer(amount, part, attacker) {
    if (!player.state.alive || state.phase !== 'live') return false;
    let dmg = amount;
    if (part === 'head') dmg *= HEADSHOT_MULT;
    if (player.state.armor > 0) {
      const absorbed = Math.min(player.state.armor, dmg * ARMOR_ABSORB);
      player.state.armor -= absorbed;
      dmg -= absorbed;
    }
    player.state.health -= dmg;
    audio.hurt();
    hud.flashDamage();
    if (player.state.health <= 0) {
      player.state.health = 0;
      registerKill('player', attacker, part);
      return true;
    }
    return false;
  }

  function tickBuy(dt) {
    state.timer -= dt;
    hud.setTimer(Math.max(0, Math.ceil(state.timer)), 'BUY');
    if (state.timer > 0) return;
    state.phase = 'live';
    state.timer = ROUND_LEN;
    hud.closeBuy();
    hud.setPhase('live', state.round, state.score);
    hud.showBanner('ROUND LIVE', playerIsAttacking() ? 'Plant the spike' : 'Hold the sites', 1.6);
  }

  function tickLive(dt, input) {
    state.timer -= dt;
    hud.setTimer(
      Math.max(0, Math.ceil(state.timer)),
      state.bomb.status === 'planted' ? 'DETONATION' : 'ROUND',
    );
    // Plant / defuse channels for the player (hold E).
    if (input.keys.has('KeyE')) {
      if (playerIsAttacking() && state.bomb.carrier === 'player' && state.bomb.status === 'carried') {
        if (!state.plant.active) beginPlant('player');
        if (state.plant.active) tickPlant(dt, 'player');
      } else if (!playerIsAttacking() && state.bomb.status === 'planted') {
        if (!state.defuse.active) beginDefuse('player');
        if (state.defuse.active) tickDefuse(dt, 'player');
      }
    } else {
      dropChannel('player');
    }
    // Bomb fuse beeps, faster as it nears zero.
    if (state.bomb.status === 'planted' && state.timer > 0) {
      const interval = state.timer > 20 ? 1 : state.timer > 10 ? 0.5 : 0.25;
      if (Math.floor(state.timer / interval) !== Math.floor((state.timer + dt) / interval)) {
        audio.plantBeep(false);
      }
    }
    if (state.timer > 0) return;
    if (state.bomb.status === 'planted') {
      state.bomb.status = 'exploded';
      effects.explosion(state.bomb.plantPos);
      audio.explosion();
      settleRound('vanguard', 'Spike detonated');
    } else {
      settleRound('sentinel', 'Time expired — spike never planted');
    }
  }

  function tickEnd(dt) {
    state.timer -= dt;
    if (state.timer > 0) return;
    if (!finishMatchIfWon()) beginRound();
  }

  const phaseTicks = { buy: tickBuy, live: tickLive, roundEnd: tickEnd };

  function tick(dt, input) {
    state.time = (state.time || 0) + dt;
    for (const entry of state.feed) entry.t += dt;
    const handler = phaseTicks[state.phase];
    if (handler) handler(dt, input);
    // Prune old noise.
    while (state.noise.length && state.noise[0].time < (state.time || 0) - 2) state.noise.shift();
  }

  return {
    state,
    teamOf: sideTeam,
    attackTeam: attackingSide,
    defendTeam: defendingSide,
    playerTeam: playerSide,
    playerAttacks: playerIsAttacking,
    startMatch: beginMatch,
    startRound: beginRound,
    endRound: settleRound,
    onKill: registerKill,
    tryPlant: beginPlant,
    plantTick: tickPlant,
    tryDefuse: beginDefuse,
    defuseTick: tickDefuse,
    cancelChannel: dropChannel,
    damagePlayer: hurtPlayer,
    addNoise: hear,
    blocked: isBlocked,
    aliveCount: livingCount,
    step: tick,
  };
}
