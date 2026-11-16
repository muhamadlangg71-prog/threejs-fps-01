// Procedural sound: every effect is synthesised with WebAudio, no audio files.
// One AudioContext, one master gain, short envelopes. Nothing is loaded over the network.
export function createAudio() {
  let ctx = null;
  let master = null;
  let noiseBuf = null;

  function ensure() {
    if (ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      const len = ctx.sampleRate * 1;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
    } catch {
      return false;
    }
    return true;
  }

  function resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  // Primitives: a filtered noise burst, and an oscillator tone with a slide.
  function burst(dur, filterType, freq, gain, when = 0) {
    if (!ensure()) return;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  function beep(freq, dur, type, gain, slideTo = 0, when = 0) {
    if (!ensure()) return;
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  // A recipe is a list of primitives: ['n', dur, filter, freq, gain, when?]
  // or ['t', freq, dur, type, gain, slide?, when?].
  function play(recipe) {
    for (const step of recipe) {
      if (step[0] === 'n') burst(step[1], step[2], step[3], step[4], step[5] || 0);
      else beep(step[1], step[2], step[3], step[4], step[5] || 0, step[6] || 0);
    }
  }

  const SHOTS = {
    sniper: [
      ['n', 0.28, 'lowpass', 900, 0.9],
      ['n', 0.12, 'highpass', 1800, 0.5],
      ['t', 140, 0.18, 'sine', 0.7, 45],
    ],
    rifle: [
      ['n', 0.14, 'lowpass', 1400, 0.8],
      ['n', 0.06, 'highpass', 2400, 0.35],
      ['t', 170, 0.1, 'sine', 0.5, 60],
    ],
    smg: [
      ['n', 0.09, 'lowpass', 1700, 0.6],
      ['t', 200, 0.07, 'sine', 0.35, 80],
    ],
    pistol: [
      ['n', 0.11, 'lowpass', 1200, 0.65],
      ['t', 150, 0.08, 'sine', 0.4, 70],
    ],
  };

  return {
    unlock() {
      ensure();
      resume();
    },
    shot(kind) {
      // kind: 'pistol' | 'smg' | 'rifle' | 'sniper'
      play(SHOTS[kind] || SHOTS.pistol);
    },
    distantShot() {
      play([['n', 0.16, 'lowpass', 700, 0.22]]);
    },
    dryFire() {
      play([['t', 1800, 0.03, 'square', 0.12]]);
    },
    reload() {
      play([
        ['t', 900, 0.04, 'square', 0.14],
        ['t', 600, 0.04, 'square', 0.14, 0, 0.25],
        ['t', 1200, 0.05, 'square', 0.16, 0, 0.6],
      ]);
    },
    hit() {
      play([['t', 2400, 0.05, 'sine', 0.25]]);
    },
    headshot() {
      play([
        ['t', 2400, 0.05, 'sine', 0.28],
        ['t', 3200, 0.07, 'sine', 0.25, 0, 0.06],
      ]);
    },
    hurt() {
      play([['t', 220, 0.12, 'sawtooth', 0.25, 120]]);
    },
    explosion() {
      play([
        ['n', 0.9, 'lowpass', 420, 1.0],
        ['n', 0.5, 'lowpass', 180, 0.9, 0.05],
        ['t', 90, 0.7, 'sine', 0.9, 28],
      ]);
    },
    grenadeBounce() {
      play([['t', 320, 0.06, 'sine', 0.2, 180]]);
    },
    plantBeep(final) {
      play([[ 't', final ? 1560 : 1180, final ? 0.3 : 0.09, 'sine', 0.3 ]]);
    },
    defuseBeep() {
      play([['t', 980, 0.08, 'sine', 0.25]]);
    },
    buy() {
      play([
        ['t', 660, 0.06, 'sine', 0.2],
        ['t', 990, 0.08, 'sine', 0.2, 0, 0.07],
      ]);
    },
    roundWin() {
      play([
        ['t', 523, 0.14, 'sine', 0.3],
        ['t', 659, 0.14, 'sine', 0.3, 0, 0.14],
        ['t', 784, 0.28, 'sine', 0.32, 0, 0.28],
      ]);
    },
    roundLose() {
      play([
        ['t', 392, 0.16, 'sine', 0.28],
        ['t', 330, 0.16, 'sine', 0.28, 0, 0.16],
        ['t', 262, 0.32, 'sine', 0.3, 0, 0.32],
      ]);
    },
    step() {
      play([['n', 0.05, 'lowpass', 500, 0.08]]);
    },
    plantStart() {
      play([
        ['t', 880, 0.1, 'sine', 0.25],
        ['t', 880, 0.1, 'sine', 0.25, 0, 0.18],
      ]);
    },
  };
}
