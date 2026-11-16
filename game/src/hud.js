// The DOM HUD: crosshair, hit marker, health, armour, ammo, money, timer, score,
// kill feed, buy menu, banners and the one overlay panel. It never touches the
// simulation; main.js pushes numbers in and reads callbacks out.
import { WEAPONS, ARMOR_PRICE } from './weapons.js';

const COPY = {
  start: {
    title: 'FERROLINE',
    copy: 'A dusk rail yard. Two teams, one spike. Plant it at Crane Deck or the Depot — or stop the plant. First to 7 rounds takes the match.',
    action: 'Click to play',
  },
  paused: {
    title: 'FERROLINE',
    copy: 'Paused. Click to resume.',
    action: 'Click to resume',
  },
  dead: {
    title: 'You are down',
    copy: 'Your team fights on. You rejoin next round.',
    action: 'Spectate',
  },
  end: {
    title: 'Match over',
    copy: '',
    action: 'Play again',
  },
};

const IDS = ['overlay', 'overlay-title', 'overlay-copy', 'play', 'ammo', 'ammo-mag',
  'ammo-reserve', 'weapon-name', 'health-value', 'health-bar', 'armor-value', 'armor-bar',
  'armor-row', 'money-value', 'timer-value', 'timer-label', 'score-v', 'score-s',
  'round-value', 'feed', 'hitmarker', 'crosshair', 'damage-flash', 'dir-indicator',
  'banner', 'banner-title', 'banner-sub', 'channel', 'channel-label', 'channel-bar',
  'buy-menu', 'buy-money', 'buy-list', 'buy-hint', 'spike-tag', 'phase-tag'];

const BUY_ROWS = [
  { key: '1', id: 'rifle', desc: 'Auto rifle · 30 rounds · accurate' },
  { key: '2', id: 'smg', desc: 'Fast SMG · 32 rounds · close quarters' },
  { key: '3', id: 'sniper', desc: 'Bolt sniper · 5 rounds · one-shot body' },
  { key: '4', id: 'pistol', desc: 'Sidearm · 12 rounds · always with you' },
  { key: '5', id: 'armor', name: 'Kevlar Armour', desc: '100 armour · halves damage' },
  { key: '6', id: 'grenade', desc: 'Frag grenade · throw with G' },
];

export function createHud() {
  const el = {};
  for (const id of IDS) el[id] = document.getElementById(id);

  // Last values pushed, so unchanged numbers never touch the DOM.
  const seen = { ammo: '', health: -1, armor: -1, money: -1, timer: -1, score: '' };
  let hitTimer = 0;
  let bannerTimer = 0;

  function makeEl(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setHealth(health, armor) {
    const h = Math.max(0, Math.round(health));
    const a = Math.max(0, Math.round(armor));
    if (h !== seen.health) {
      seen.health = h;
      el['health-value'].textContent = String(h);
      el['health-bar'].style.width = `${h}%`;
      el['health-bar'].classList.toggle('low', h <= 30);
    }
    if (a !== seen.armor) {
      seen.armor = a;
      el['armor-value'].textContent = String(a);
      el['armor-bar'].style.width = `${a}%`;
      el['armor-row'].style.visibility = a > 0 ? 'visible' : 'hidden';
    }
  }

  function setAmmo(mag, reserve, label, name) {
    const key = `${mag}|${reserve}|${name}`;
    if (key === seen.ammo) return;
    seen.ammo = key;
    el['ammo-mag'].textContent = String(mag);
    el['ammo-reserve'].textContent = `${label} ${reserve}`;
    el['weapon-name'].textContent = name;
    el.ammo.classList.toggle('empty', mag === 0);
  }

  function setMoney(value) {
    if (value === seen.money) return;
    seen.money = value;
    el['money-value'].textContent = `$${value}`;
    el['buy-money'].textContent = `$${value}`;
  }

  function setTimer(seconds, label) {
    if (seconds === seen.timer && el['timer-label'].textContent === label) return;
    seen.timer = seconds;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    el['timer-value'].textContent = `${m}:${String(s).padStart(2, '0')}`;
    el['timer-label'].textContent = label;
    el['timer-value'].classList.toggle('urgent', seconds <= 10);
  }

  function setScore(v, s, round) {
    const key = `${v}|${s}|${round}`;
    if (key === seen.score) return;
    seen.score = key;
    el['score-v'].textContent = String(v);
    el['score-s'].textContent = String(s);
    el['round-value'].textContent = `ROUND ${round}`;
  }

  function setPhase(phase, round, score) {
    setScore(score.vanguard, score.sentinel, round);
    el['phase-tag'].textContent = phase === 'buy'
      ? 'BUY PHASE — press B to shop'
      : phase === 'live' ? 'ROUND LIVE' : phase.toUpperCase();
  }

  function setFeed(feed) {
    el.feed.replaceChildren();
    for (const entry of feed) {
      if ((entry.t || 0) > 6) continue;
      el.feed.appendChild(makeEl('div', `feed-item ${entry.cls || ''}`, entry.text));
    }
  }

  function hitMarker(killed, holdMs = 90) {
    el.hitmarker.classList.add('on');
    el.hitmarker.classList.toggle('kill', !!killed);
    clearTimeout(hitTimer);
    hitTimer = setTimeout(() => el.hitmarker.classList.remove('on', 'kill'), holdMs);
  }

  function flashDamage() {
    el['damage-flash'].classList.add('on');
    setTimeout(() => el['damage-flash'].classList.remove('on'), 140);
  }

  function showDirection(angleDeg) {
    el['dir-indicator'].style.transform = `translate(-50%, -50%) rotate(${angleDeg}deg)`;
    el['dir-indicator'].classList.add('on');
    setTimeout(() => el['dir-indicator'].classList.remove('on'), 500);
  }

  function setCrosshairSpread(px) {
    el.crosshair.style.setProperty('--gap', `${px}px`);
  }

  function setBomb(status) {
    // status: 'carry' | 'planted' | null
    if (status === 'carry') {
      el['spike-tag'].hidden = false;
      el['spike-tag'].textContent = '◆ SPIKE — plant at A or B (hold E)';
      el['spike-tag'].className = 'spike-carry';
    } else if (status === 'planted') {
      el['spike-tag'].hidden = false;
      el['spike-tag'].textContent = '◆ SPIKE PLANTED — defend it';
      el['spike-tag'].className = 'spike-planted';
    } else {
      el['spike-tag'].hidden = true;
    }
  }

  function setChannel(label, progress) {
    if (!label) {
      el.channel.hidden = true;
      return;
    }
    el.channel.hidden = false;
    el['channel-label'].textContent = label;
    el['channel-bar'].style.width = `${Math.round(progress * 100)}%`;
  }

  function showBanner(titleText, subText, seconds = 2.5) {
    el['banner-title'].textContent = titleText;
    el['banner-sub'].textContent = subText;
    el.banner.hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      el.banner.hidden = true;
    }, seconds * 1000);
  }

  function openBuy(money, owned) {
    el['buy-menu'].hidden = false;
    el['buy-money'].textContent = `$${money}`;
    el['buy-list'].replaceChildren();
    for (const row of BUY_ROWS) {
      const def = WEAPONS[row.id];
      const name = row.name || (def && def.name);
      const price = row.id === 'armor' ? ARMOR_PRICE : def.price;
      const item = makeEl('button', 'buy-item', '');
      item.type = 'button';
      item.dataset.buy = row.id;
      const ownedMark = owned && owned.includes(row.id) ? ' — OWNED' : '';
      item.innerHTML = `<b>[${row.key}] ${name}${ownedMark}</b><span>${row.desc}</span><i>$${price}</i>`;
      item.disabled = money < price;
      el['buy-list'].appendChild(item);
    }
    el['buy-hint'].textContent = 'Keys 1–6 to buy · B or Esc to close';
    el['buy-menu'].querySelectorAll('.buy-item').forEach((button) => {
      button.addEventListener('click', () => {
        if (api.onBuy) api.onBuy(button.dataset.buy);
      });
    });
  }

  function closeBuy() {
    el['buy-menu'].hidden = true;
  }

  function isBuyOpen() {
    return !el['buy-menu'].hidden;
  }

  function showOverlay(mode, score, extra) {
    const text = COPY[mode];
    el['overlay-title'].textContent = text.title;
    if (mode === 'end' && extra) {
      el['overlay-copy'].textContent = `${extra.winner} wins the match ${extra.score.vanguard}–${extra.score.sentinel}. You scored ${extra.kills} eliminations with ${extra.deaths} deaths.`;
    } else {
      el['overlay-copy'].textContent = text.copy;
    }
    el.play.textContent = text.action;
    el.overlay.hidden = false;
    el.play.focus();
  }

  function showMatchEnd(winner, score, kills) {
    showOverlay('end', score, { winner, score, kills: kills.player, deaths: kills.deaths });
  }

  function hideOverlay() {
    el.overlay.hidden = true;
  }

  const api = {
    setHealth,
    setAmmo,
    setMoney,
    setTimer,
    setScore,
    setPhase,
    setFeed,
    hitMarker,
    flashDamage,
    showDirection,
    setCrosshairSpread,
    setBomb,
    setChannel,
    showBanner,
    openBuy,
    closeBuy,
    isBuyOpen,
    showOverlay,
    showMatchEnd,
    hideOverlay,
    onPlay(handler) {
      el.play.addEventListener('click', handler);
    },
    onBuy: null,
  };
  return api;
}
