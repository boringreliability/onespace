/**
 * Input against a fake DOM, and the mouse stick against the real flight model.
 *
 * Input binds to `window`, `document` and an element, none of which exist in
 * node. Rather than mock Input, the test supplies the three objects with just
 * enough surface to record listeners, then drives them the way a browser
 * would: keydown events, pointer-lock changes, `movementX/Y`. The measurement
 * of GAMEPLAY B1 was taken the same way — by writing pointer deltas into Input
 * frame for frame — so these numbers are directly comparable with the 2.6°.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Input } from './Input';
import { STICK_DEFAULTS, STICK_INVERT_Y_KEY, STICK_SENSITIVITY_KEY } from './stick';
import { FlightModel } from '@/ship/FlightModel';
import { Vector3 } from 'three';

type Listener = (e: unknown) => void;

class FakeTarget {
  readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string, e: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}

class FakeElement extends FakeTarget {
  requestPointerLock(): void {
    /* the test decides when the lock is granted */
  }
}

class FakeDocument extends FakeTarget {
  pointerLockElement: unknown = null;
}

interface Dom {
  win: FakeTarget;
  doc: FakeDocument;
  el: FakeElement;
  store: Map<string, string>;
  storageThrows: boolean;
}

const g = globalThis as unknown as Record<string, unknown>;
let dom: Dom;

function installDom(): Dom {
  const d: Dom = {
    win: new FakeTarget(),
    doc: new FakeDocument(),
    el: new FakeElement(),
    store: new Map(),
    storageThrows: false,
  };
  g.window = d.win;
  g.document = d.doc;
  g.localStorage = {
    getItem: (k: string): string | null => {
      if (d.storageThrows) throw new Error('SecurityError');
      return d.store.get(k) ?? null;
    },
    setItem: (k: string, v: string): void => {
      if (d.storageThrows) throw new Error('SecurityError');
      d.store.set(k, v);
    },
  };
  return d;
}

function makeInput(): Input {
  return new Input(dom.el as unknown as HTMLElement);
}

function key(code: string, down = true): void {
  dom.win.fire(down ? 'keydown' : 'keyup', { code, repeat: false, preventDefault() {} });
}

function lock(locked: boolean): void {
  dom.doc.pointerLockElement = locked ? dom.el : null;
  dom.doc.fire('pointerlockchange');
}

function move(dx: number, dy: number): void {
  dom.win.fire('pointermove', { movementX: dx, movementY: dy });
}

/** One engine frame, in the order main.ts runs it. */
function frame(input: Input, dt: number, flight?: FlightModel): void {
  input.update(dt);
  if (flight) {
    flight.applyInput(input.axes, false, false);
    flight.update(dt);
  }
  input.endFrame();
}

beforeEach(() => {
  dom = installDom();
});

afterEach(() => {
  delete g.window;
  delete g.document;
  delete g.localStorage;
});

// ---------------------------------------------------------------------------

describe('Input: mouse as a virtual stick', () => {
  it('Given a locked pointer, When the mouse moves a full radius right and stops, Then the yaw axis stays deflected on later frames', () => {
    const input = makeInput();
    lock(true);
    move(STICK_DEFAULTS.radiusPx, 0);
    frame(input, 1 / 60);
    const first = input.axes.yaw;
    frame(input, 1 / 60);
    frame(input, 1 / 60);
    // The old code zeroed the delta after one frame: the axis was a spike.
    expect(Math.abs(first)).toBeGreaterThan(0.95);
    expect(Math.abs(input.axes.yaw)).toBeGreaterThan(0.9);
  });

  it('Given mouse-right, Then the yaw axis keeps the existing sign convention (negative, as ArrowRight)', () => {
    // FlightModel.yawAxisSign = -1 turns this into a right turn. Fixing that
    // sign is a separate change; the stick must not silently flip it.
    const input = makeInput();
    lock(true);
    move(STICK_DEFAULTS.radiusPx, 0);
    frame(input, 1 / 60);
    const mouse = input.axes.yaw;

    const keys = makeInput();
    key('ArrowRight');
    frame(keys, 1 / 60);
    expect(Math.sign(mouse)).toBe(Math.sign(keys.axes.yaw));
    expect(mouse).toBeLessThan(0);
  });

  it('Given mouse-up (negative movementY) with invertY off, Then pitch is positive, as before', () => {
    const input = makeInput();
    lock(true);
    move(0, -STICK_DEFAULTS.radiusPx);
    frame(input, 1 / 60);
    expect(input.axes.pitch).toBeGreaterThan(0.95);
  });

  it('Given invertY on, When the mouse moves up, Then pitch is negative', () => {
    const input = makeInput();
    input.setStickSettings({ sensitivity: 1, invertY: true });
    lock(true);
    move(0, -STICK_DEFAULTS.radiusPx);
    frame(input, 1 / 60);
    expect(input.axes.pitch).toBeLessThan(-0.95);
  });

  it('Given sensitivity 2, When the mouse moves a quarter radius, Then the stick reads half deflection', () => {
    const input = makeInput();
    input.setStickSettings({ sensitivity: 2, invertY: false });
    lock(true);
    move(STICK_DEFAULTS.radiusPx / 4, 0);
    frame(input, 1 / 60);
    expect(input.stickDeflection.x).toBeCloseTo(0.5, 2);
  });

  it('Given a deflection, Then the normalised deflection is exposed read-only for the HUD dot', () => {
    const input = makeInput();
    lock(true);
    move(STICK_DEFAULTS.radiusPx / 2, -STICK_DEFAULTS.radiusPx / 2);
    frame(input, 1 / 60);
    expect(input.stickDeflection.x).toBeGreaterThan(0.45);
    expect(input.stickDeflection.y).toBeLessThan(-0.45);
  });

  it('Given an unlocked pointer, When the mouse moves, Then the stick does not move', () => {
    const input = makeInput();
    move(STICK_DEFAULTS.radiusPx, 0);
    frame(input, 1 / 60);
    expect(input.stickDeflection.x).toBe(0);
    expect(input.axes.yaw).toBe(0);
  });

  it('Given a deflected stick, When pointer lock is lost, Then the stick recentres at once (nothing stays stuck on)', () => {
    const input = makeInput();
    lock(true);
    move(STICK_DEFAULTS.radiusPx, 0);
    frame(input, 1 / 60);
    lock(false);
    frame(input, 1 / 60);
    expect(input.stickDeflection.x).toBe(0);
    expect(input.axes.yaw).toBe(0);
  });

  it('Given mouse and arrow key both full in the same direction, Then the axis is still clamped to 1', () => {
    const input = makeInput();
    lock(true);
    move(-STICK_DEFAULTS.radiusPx, 0);
    key('ArrowLeft');
    frame(input, 1 / 60);
    expect(input.axes.yaw).toBeLessThanOrEqual(1);
    expect(input.axes.yaw).toBeGreaterThan(0.95);
  });
});

describe('Input: stick settings persistence', () => {
  it('Given stored settings, When Input is constructed, Then it loads them', () => {
    dom.store.set(STICK_SENSITIVITY_KEY, '1.5');
    dom.store.set(STICK_INVERT_Y_KEY, 'true');
    const input = makeInput();
    expect(input.stickSettings).toEqual({ sensitivity: 1.5, invertY: true });
  });

  it('Given new settings, When set, Then they are persisted under the key', () => {
    const input = makeInput();
    input.setStickSettings({ sensitivity: 0.5, invertY: true });
    expect(dom.store.get(STICK_SENSITIVITY_KEY)).toBe('0.5');
    expect(dom.store.get(STICK_INVERT_Y_KEY)).toBe('true');
  });

  it('Given out-of-range settings handed in by code, Then they are validated the same way as stored ones', () => {
    const input = makeInput();
    input.setStickSettings({ sensitivity: 1e9, invertY: true });
    expect(input.stickSettings.sensitivity).toBe(4);
  });

  it('Given localStorage that throws, When Input is constructed and settings saved, Then nothing throws and defaults apply', () => {
    dom.storageThrows = true;
    let input: Input | null = null;
    expect(() => {
      input = makeInput();
    }).not.toThrow();
    expect(input!.stickSettings).toEqual({ sensitivity: 1, invertY: false });
    expect(() => input!.setStickSettings({ sensitivity: 2, invertY: false })).not.toThrow();
    // Still applied for this session even though it could not be stored.
    expect(input!.stickSettings.sensitivity).toBe(2);
  });
});

describe('Input: new actions', () => {
  it('Given throttle at full, When X is pressed, Then the throttle axis is 0 on that same frame (not 1.1 s later)', () => {
    const input = makeInput();
    input.setThrottle(1);
    for (let i = 0; i < 120; i++) frame(input, 1 / 60);
    expect(input.axes.throttle).toBeGreaterThan(0.99);

    key('KeyX');
    expect(input.pressed('zeroThrottle')).toBe(true);
    frame(input, 1 / 60);
    expect(input.axes.throttle).toBe(0);
  });

  it('Given throttle zeroed by X, When later frames pass with no keys, Then it stays at 0 (the target was zeroed too)', () => {
    const input = makeInput();
    input.setThrottle(1);
    for (let i = 0; i < 120; i++) frame(input, 1 / 60);
    key('KeyX');
    frame(input, 1 / 60);
    key('KeyX', false);
    for (let i = 0; i < 60; i++) frame(input, 1 / 60);
    expect(input.axes.throttle).toBe(0);
  });

  it('Given the lever at full, When code cuts it with setThrottle(0) (recovery, touchdown), Then the axis is 0 at once — it does not ease down through FA-ON speed holds', () => {
    // review-p1: the easing never reaches exactly 0 for minutes, and under
    // FA-ON any lever > 0 is a speed hold — at ~0 the computer brakes a 5 km/s
    // recovery orbit to a hover.
    const input = makeInput();
    input.setThrottle(1);
    for (let i = 0; i < 120; i++) frame(input, 1 / 60);
    input.setThrottle(0);
    expect(input.axes.throttle).toBe(0);
    frame(input, 1 / 60);
    expect(input.axes.throttle).toBe(0);
  });

  it('Given the lever at 0, When code sets it to 0.5, Then the lever still eases towards it (only the detent snaps)', () => {
    const input = makeInput();
    input.setThrottle(0.5);
    frame(input, 1 / 60);
    expect(input.axes.throttle).toBeGreaterThan(0);
    expect(input.axes.throttle).toBeLessThan(0.5);
  });

  it('Given Z is pressed, Then flightAssist fires exactly once', () => {
    const input = makeInput();
    key('KeyZ');
    expect(input.pressed('flightAssist')).toBe(true);
    frame(input, 1 / 60);
    expect(input.pressed('flightAssist')).toBe(false);
  });

  it('Given the existing bindings, Then every one of them still maps to the same action', () => {
    const expected: Array<[string, Parameters<Input['pressed']>[0]]> = [
      ['ShiftLeft', 'boost'],
      ['ShiftRight', 'boost'],
      ['Space', 'brake'],
      ['KeyG', 'cruise'],
      ['KeyJ', 'warp'],
      ['KeyT', 'scan'],
      ['KeyM', 'map'],
      ['KeyC', 'codex'],
      ['KeyL', 'land'],
      ['Tab', 'cycleTarget'],
      ['KeyV', 'toggleCamera'],
      ['Escape', 'pause'],
      ['F2', 'screenshot'],
    ];
    for (const [code, action] of expected) {
      const input = makeInput();
      key(code);
      expect(input.pressed(action), `${code} → ${action}`).toBe(true);
      input.dispose();
    }
  });
});

// ---------------------------------------------------------------------------

/**
 * Angle in degrees the nose turns between `fromSeconds` and `seconds`. With
 * `fromSeconds` > 0 this measures the settled turn RATE (°/s over the last
 * second) rather than the first second, which includes the hull spinning up.
 */
function noseTurnDeg(
  hz: number,
  seconds: number,
  drive: (input: Input, i: number, frames: number) => void,
  fromSeconds = 0,
): number {
  dom = installDom();
  const input = makeInput();
  const flight = new FlightModel();
  lock(true);
  const start = flight.forward.clone();
  const frames = Math.round(hz * seconds);
  const fromFrame = Math.round(hz * fromSeconds);
  for (let i = 0; i < frames; i++) {
    if (i === fromFrame) start.copy(flight.forward);
    drive(input, i, frames);
    frame(input, 1 / hz, flight);
  }
  input.dispose();
  return (start.angleTo(flight.forward) * 180) / Math.PI;
}

describe('Mouse stick against the flight model (GAMEPLAY B1 acceptance)', () => {
  // Note on the numbers: the hull's yaw authority is α = 1.8 rad/s² against
  // an attitude-hold τ of 0.35 s, so a held full axis settles at α·τ ≈ 36°/s
  // and the FIRST second, which includes spinning the hull up, covers ~24°.
  // That is the arrow key's behaviour too. GAMEPLAY's 35.6° "ArrowLeft for
  // 1 s" matches the settled rate, so the rate is what is asserted.
  // [v3-T2] threshold re-baselined: yaw max is now 28°/s (D0), so the first
  // second (spin-up included) covers ~20°, not the v2 plant's ~24°.
  it('Given a 2000 px swipe spread over 1 s, Then the nose turns over 15° in that second (was 2.6°) — on par with the arrow key', () => {
    const turn = noseTurnDeg(60, 1, (_input, _i, frames) => move(2000 / frames, 0));
    const arrow = noseTurnDeg(60, 1, (_input, i) => {
      if (i === 0) key('ArrowRight');
    });
    expect(turn).toBeGreaterThan(15);
    expect(Math.abs(turn - arrow) / arrow).toBeLessThan(0.15);
  });

  // [v3-T2] v2 asserted ≥ 30°/s and allowed the mouse to lag (recentring).
  // Now: yaw is rate-commanded at 28°/s and the stick holds, so mouse = key.
  it('Given full mouse deflection held, Then the settled turn rate is the D0 yaw maximum (28°/s), identical to holding ArrowLeft', () => {
    const mouse = noseTurnDeg(
      60,
      2,
      (_input, i) => {
        if (i === 0) move(-STICK_DEFAULTS.radiusPx * 2, 0);
      },
      1,
    );
    const arrow = noseTurnDeg(
      60,
      2,
      (_input, i) => {
        if (i === 0) key('ArrowLeft');
      },
      1,
    );
    expect(arrow).toBeCloseTo(28, 0);
    expect(Math.abs(mouse - arrow) / arrow).toBeLessThan(0.005);
  });

  it('Given the mouse kept at full deflection (the hand following the recentring), Then the rate is the arrow key’s rate', () => {
    const drive = (_input: Input, i: number, frames: number): void => {
      // Push past the rim every frame; the clamp holds it at exactly 1.
      move(-STICK_DEFAULTS.radiusPx, 0);
      void i;
      void frames;
    };
    const mouse = noseTurnDeg(60, 2, drive, 1);
    const arrow = noseTurnDeg(
      60,
      2,
      (_input, i) => {
        if (i === 0) key('ArrowLeft');
      },
      1,
    );
    expect(Math.abs(mouse - arrow) / arrow).toBeLessThan(0.02);
    expect(mouse).toBeGreaterThanOrEqual(27); // [v3-T2] yaw max 28°/s (was ≥ 30)
  });

  it('Given the same 1 s mouse motion, When run at 30, 60 and 144 Hz, Then the nose turns the same amount within 5%', () => {
    const drive = (_input: Input, i: number, frames: number): void => {
      // 600 px over the first half second, then held.
      const half = Math.round(frames / 2);
      if (i < half) move(600 / half, 0);
    };
    const t30 = noseTurnDeg(30, 1, drive);
    const t60 = noseTurnDeg(60, 1, drive);
    const t144 = noseTurnDeg(144, 1, drive);
    expect(t60).toBeGreaterThan(10);
    expect(Math.abs(t30 - t60) / t60).toBeLessThan(0.05);
    expect(Math.abs(t144 - t60) / t60).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// Review p1a
// ---------------------------------------------------------------------------

describe('review p1a: the lever reaches the coast detent however it gets to 0', () => {
  it('Given the lever at 30 %, When S is held until the target hits 0, Then the throttle axis is exactly 0 on that frame (not an eased 1e-20)', () => {
    const input = makeInput();
    input.setThrottle(0.3);
    for (let i = 0; i < 120; i++) frame(input, 1 / 60);
    key('KeyS');
    let frames = 0;
    while (input.axes.throttle !== 0 && frames < 120) {
      frame(input, 1 / 60);
      frames++;
    }
    // 0.3 at 0.9/s is 20 frames of S; the detent must be reached with the target.
    expect(input.axes.throttle).toBe(0);
    expect(frames).toBeLessThanOrEqual(21);
  });

  it('Given the lever up, When code cuts it with setThrottle(0) (touchdown), Then the next frame is exactly 0', () => {
    const input = makeInput();
    input.setThrottle(0.5);
    for (let i = 0; i < 60; i++) frame(input, 1 / 60);
    input.setThrottle(0);
    frame(input, 1 / 60);
    expect(input.axes.throttle).toBe(0);
  });

  it('Given the lever up, When the wheel winds it past 0, Then the throttle axis is exactly 0', () => {
    const input = makeInput();
    input.setThrottle(0.1);
    for (let i = 0; i < 60; i++) frame(input, 1 / 60);
    for (let i = 0; i < 3; i++) dom.el.fire('wheel', { deltaY: 1, preventDefault() {} });
    frame(input, 1 / 60);
    expect(input.axes.throttle).toBe(0);
  });

  it('Given FA-ON in orbit with the lever brought down by S (not X), Then the orbit survives: the computer is in coast, not a stop', () => {
    const input = makeInput();
    const fm = new FlightModel();
    fm.flightAssist = true;
    const mu = 398600;
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu, radius: 6371 });
    const p = new Vector3(0, 7000, 0);
    fm.teleport(p, fm.orbitalVelocityAt(p));
    const v0 = fm.velocity.length();

    input.setThrottle(0.02);
    for (let i = 0; i < 6; i++) frame(input, 1 / 60, fm);
    key('KeyS');
    for (let i = 0; i < 60; i++) frame(input, 1 / 60, fm);
    key('KeyS', false);
    for (let i = 0; i < 60 * 30; i++) frame(input, 1 / 60, fm);

    expect(fm.assistState).toBe('coast');
    // A ~0 km/s speed hold would have retro-burned 7.5 km/s to nothing in ~40 s.
    expect(fm.velocity.length()).toBeGreaterThan(v0 - 0.1);
  });
});

describe('review p1a: stick plumbing survivors', () => {
  // [v3-T2] inverted: v2 asserted the 8 s recentring walk; v3 holds (S1).
  it('Given a deflected stick left alone, When 8 s of frames pass, Then Input still holds it (no recentring)', () => {
    const input = makeInput();
    lock(true);
    move(STICK_DEFAULTS.radiusPx, 0);
    frame(input, 1 / 60);
    expect(input.stickDeflection.x).toBeGreaterThan(0.99);
    for (let i = 0; i < 60 * 8 + 2; i++) frame(input, 1 / 60);
    expect(input.stickDeflection.x).toBeGreaterThan(0.99);
    expect(input.axes.yaw).toBeLessThan(-0.99);
  });

  it('Given mouse motion that arrived before the lock was lost, When the next frame runs, Then that motion is discarded too', () => {
    const input = makeInput();
    lock(true);
    move(STICK_DEFAULTS.radiusPx, 0); // not yet folded in by update()
    lock(false);
    frame(input, 1 / 60);
    expect(input.stickDeflection.x).toBe(0);
    expect(input.axes.yaw).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// [v3-T2] key-axis ramps and mouse/keyboard parity under rate command
// ---------------------------------------------------------------------------

describe('[v3-T2] Input: arrow and roll keys ramp, the mouse does not', () => {
  it('Given ArrowUp pressed, When one 60 Hz frame runs, Then pitch is (1/60)/0.15 — not a step to 1', () => {
    const input = makeInput();
    key('ArrowUp');
    frame(input, 1 / 60);
    expect(input.axes.pitch).toBeCloseTo(1 / 60 / 0.15, 9);
  });

  it('Given ArrowUp held, When 0.15 s passes, Then pitch is exactly 1', () => {
    const input = makeInput();
    key('ArrowUp');
    for (let i = 0; i < 9; i++) frame(input, 1 / 60);
    expect(input.axes.pitch).toBe(1);
  });

  it('Given Q held to full, When released, Then roll falls to exactly 0 within 0.08 s (5 frames at 60 Hz)', () => {
    const input = makeInput();
    key('KeyQ');
    for (let i = 0; i < 20; i++) frame(input, 1 / 60);
    expect(input.axes.roll).toBe(1);
    key('KeyQ', false);
    frame(input, 1 / 60);
    expect(input.axes.roll).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) frame(input, 1 / 60);
    expect(input.axes.roll).toBe(0);
  });

  it('Given ArrowLeft then ArrowRight with no gap, Then yaw reverses through zero (down-rate, then up-rate), never jumping', () => {
    const input = makeInput();
    key('ArrowLeft');
    for (let i = 0; i < 20; i++) frame(input, 1 / 60);
    key('ArrowLeft', false);
    key('ArrowRight');
    let prev = input.axes.yaw;
    for (let i = 0; i < 30; i++) {
      frame(input, 1 / 60);
      expect(Math.abs(input.axes.yaw - prev)).toBeLessThanOrEqual(1 / 60 / 0.08 + 1e-12);
      prev = input.axes.yaw;
    }
    expect(input.axes.yaw).toBe(-1);
  });

  it('Given a full mouse deflection, Then the axis is full on the very first frame (the hand is already the ramp)', () => {
    const input = makeInput();
    lock(true);
    move(0, -STICK_DEFAULTS.radiusPx);
    frame(input, 1 / 60);
    expect(input.axes.pitch).toBeCloseTo(1, 12);
  });
});

describe('[v3-T2] parity: full key = full mouse = the D0 maximum rate', () => {
  for (const [axis, keyCode, dx, dy, rate] of [
    ['pitch', 'ArrowUp', 0, -STICK_DEFAULTS.radiusPx, 35],
    ['yaw', 'ArrowLeft', -STICK_DEFAULTS.radiusPx, 0, 28],
  ] as const) {
    it(`Given full ${axis} on the mouse and on ${keyCode} for 3 s, Then both settle at ${rate}°/s and agree within 0.5 %`, () => {
      const mouse = noseTurnDeg(
        60,
        3,
        (_input, i) => {
          if (i === 0) move(dx, dy);
        },
        2,
      );
      const keyRate = noseTurnDeg(
        60,
        3,
        (_input, i) => {
          if (i === 0) key(keyCode);
        },
        2,
      );
      expect(keyRate).toBeCloseTo(rate, 1);
      expect(Math.abs(mouse - keyRate) / keyRate).toBeLessThan(0.005);
    });
  }
});
