// Keyboard and mouse, and the pointer lock that turns the mouse into look. Plain browser
// APIs only: the game asks the canvas for pointer lock and reads movementX/Y while it holds it.
// `pressed` is the edge set: keys that went down since the last takePressed() call, so the
// game can act on one press (buy, switch weapon, throw) without repeats.
export function createInput(canvas, onLockChange) {
  const keys = new Set();
  const pressed = new Set();
  const state = { keys, pressed, locked: false, firing: false, lookX: 0, lookY: 0 };

  function trackKey(event, down) {
    if (down) {
      if (!keys.has(event.code)) pressed.add(event.code);
      keys.add(event.code);
    } else {
      keys.delete(event.code);
    }
    if (event.code === 'Space') event.preventDefault();
  }

  function trackMouse(event) {
    if (!state.locked) return;
    state.lookX += event.movementX;
    state.lookY += event.movementY;
  }

  function trackFire(event, down) {
    if (event.button !== 0) return;
    if (down && !state.locked) return;
    state.firing = down;
  }

  function trackWheel(event) {
    if (!state.locked) return;
    pressed.add(event.deltaY > 0 ? 'WheelDown' : 'WheelUp');
  }

  function trackLock() {
    state.locked = document.pointerLockElement === canvas;
    if (!state.locked) {
      keys.clear();
      state.firing = false;
    }
    onLockChange(state.locked);
  }

  function clearAll() {
    keys.clear();
    pressed.clear();
  }

  // [target, event, handler, options?]
  const listeners = [
    [window, 'keydown', (e) => trackKey(e, true)],
    [window, 'keyup', (e) => trackKey(e, false)],
    [window, 'blur', clearAll],
    [window, 'mousemove', trackMouse],
    [window, 'mousedown', (e) => trackFire(e, true)],
    [window, 'mouseup', (e) => trackFire(e, false)],
    [window, 'wheel', trackWheel, { passive: true }],
    [document, 'pointerlockchange', trackLock],
  ];
  for (const [target, event, handler, options] of listeners) {
    target.addEventListener(event, handler, options);
  }

  return {
    state,
    requestLock() {
      canvas.requestPointerLock();
    },
    takeLook() {
      const x = state.lookX;
      const y = state.lookY;
      state.lookX = 0;
      state.lookY = 0;
      return { x, y };
    },
    takePressed() {
      const out = new Set(pressed);
      pressed.clear();
      return out;
    },
  };
}
