/**
 * Right means right: every stick source, measured end to end.
 *
 * A GPU browser run found ArrowRight turning the nose LEFT. The sign chain is
 * Input (`keyYaw = Left − Right`, `mouseYaw = −sx`) → `FlightModel.command` →
 * `yawAxisSign` (−1) → body ω.y → `orientation.multiply(dq)`. With the nose on
 * body −Z, a POSITIVE ω.y swings it toward −X: left. Two negations made a
 * positive rate out of a right input, and positive ω.y is a left turn.
 *
 * So this file does not test any sign in isolation. It drives the real Input
 * (fake DOM, as Input.test.ts) into the real FlightModel, the way main.ts
 * runs a frame, and asks one question per source: where did the nose go,
 * measured in the ship's own starting frame? Screen right in the chase and
 * cockpit cameras is body +X (CameraRig: chase offset +Z/+Y, cockpit copies
 * the hull quaternion), screen up is body +Y.
 *
 * Conventions pinned here:
 *  - yaw:   ArrowRight / mouse-right  → nose to body +X (pilot's right).
 *  - pitch: ArrowUp / mouse-up        → nose to body +Y (nose up); invertY
 *           (src/ui/stickSettings.ts, default off) flips the MOUSE only.
 *  - roll:  E rolls right (clockwise seen from behind: the roof leans to +X),
 *           Q rolls left.
 * There are no yaw letter keys (A/D strafe), no gamepad, and the virtual
 * stick is the mouse (src/core/stick.ts), so these are all the sources.
 *
 * Both flight-assist modes are flown: assist ON is the rate command
 * (`rateCommandAgainst`), assist OFF is raw torque — each applies the axis
 * sign on its own line.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import { Input } from './Input';
import { STICK_DEFAULTS } from './stick';
import { DEFAULT_SHIP_CONFIG, FlightModel, type ShipConfig } from '@/ship/FlightModel';
import { noseErrorRad, steerToward } from '@/ship/cruiseSteer';

// ---------------------------------------------------------------------------
// Fake DOM (same surface as Input.test.ts)
// ---------------------------------------------------------------------------

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

const g = globalThis as unknown as Record<string, unknown>;
let win: FakeTarget;
let doc: FakeDocument;
let el: FakeElement;

beforeEach(() => {
  win = new FakeTarget();
  doc = new FakeDocument();
  el = new FakeElement();
  const store = new Map<string, string>();
  g.window = win;
  g.document = doc;
  g.localStorage = {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => void store.set(k, v),
  };
});

afterEach(() => {
  delete g.window;
  delete g.document;
  delete g.localStorage;
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const DT = 1 / 60;
/** Long enough for a clear turn, short enough that nothing wraps round. */
const HOLD_S = 0.4;
/** A turn this small is noise, not a direction. */
const MIN_TURN = 2 * DEG;

/** An arbitrary, deliberately non-identity start: no axis may line up by luck. */
const START = new Quaternion().setFromEuler(new Euler(0.3, 1.1, -0.4, 'YXZ'));

type Source =
  | { kind: 'key'; code: string }
  | { kind: 'mouse'; dx: number; dy: number; invertY?: boolean };

function ship(assist: boolean): FlightModel {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0 });
  fm.teleport(new Vector3(), new Vector3(), START.clone());
  fm.attitudeHold = assist;
  return fm;
}

interface Turn {
  /** Where the nose went, in the START body frame: +x right, +y up. */
  nose: Vector3;
  /** Where the roof went, in the START body frame: +x = leaned right. */
  roof: Vector3;
}

/** Hold one source for HOLD_S through Input → applyInput → update, as main.ts. */
function fly(source: Source, assist: boolean): Turn {
  const input = new Input(el as unknown as HTMLElement);
  const fm = ship(assist);
  if (source.kind === 'key') {
    win.fire('keydown', { code: source.code, repeat: false, preventDefault() {} });
  } else {
    if (source.invertY) input.setStickSettings({ sensitivity: 1, invertY: true });
    doc.pointerLockElement = el;
    doc.fire('pointerlockchange');
    win.fire('pointermove', { movementX: source.dx, movementY: source.dy });
  }
  for (let t = 0; t < HOLD_S - 1e-9; t += DT) {
    input.update(DT);
    fm.applyInput(input.axes, false, false);
    fm.update(DT);
    input.endFrame();
  }
  input.dispose?.();
  const delta = START.clone().invert().multiply(fm.orientation);
  return {
    nose: new Vector3(0, 0, -1).applyQuaternion(delta),
    roof: new Vector3(0, 1, 0).applyQuaternion(delta),
  };
}

const R = STICK_DEFAULTS.radiusPx;
const MODES = [true, false] as const;
const modeName = (assist: boolean): string => (assist ? 'assist on' : 'assist off');

// ---------------------------------------------------------------------------
// Yaw — the bug
// ---------------------------------------------------------------------------

describe('yaw: right means right', () => {
  for (const assist of MODES) {
    it(`Given ${modeName(assist)}, When ArrowRight is held, Then the nose turns to the pilot's right (body +X)`, () => {
      const { nose } = fly({ kind: 'key', code: 'ArrowRight' }, assist);
      expect(nose.x).toBeGreaterThan(Math.sin(MIN_TURN));
      expect(Math.abs(nose.x)).toBeGreaterThan(Math.abs(nose.y));
    });

    it(`Given ${modeName(assist)}, When ArrowLeft is held, Then the nose turns to the pilot's left (body −X)`, () => {
      const { nose } = fly({ kind: 'key', code: 'ArrowLeft' }, assist);
      expect(nose.x).toBeLessThan(-Math.sin(MIN_TURN));
      expect(Math.abs(nose.x)).toBeGreaterThan(Math.abs(nose.y));
    });

    it(`Given ${modeName(assist)}, When the mouse stick is pushed right, Then the nose turns to the pilot's right (body +X)`, () => {
      const { nose } = fly({ kind: 'mouse', dx: R, dy: 0 }, assist);
      expect(nose.x).toBeGreaterThan(Math.sin(MIN_TURN));
      expect(Math.abs(nose.x)).toBeGreaterThan(Math.abs(nose.y));
    });

    it(`Given ${modeName(assist)}, When the mouse stick is pushed left, Then the nose turns to the pilot's left (body −X)`, () => {
      const { nose } = fly({ kind: 'mouse', dx: -R, dy: 0 }, assist);
      expect(nose.x).toBeLessThan(-Math.sin(MIN_TURN));
      expect(Math.abs(nose.x)).toBeGreaterThan(Math.abs(nose.y));
    });
  }

  it('Given mouse-right and ArrowRight, Then they turn the nose the same way (one convention, not two)', () => {
    const k = fly({ kind: 'key', code: 'ArrowRight' }, true);
    const m = fly({ kind: 'mouse', dx: R, dy: 0 }, true);
    expect(Math.sign(m.nose.x)).toBe(Math.sign(k.nose.x));
  });
});

// ---------------------------------------------------------------------------
// Pitch and roll — guards (same class of bug, expected already correct)
// ---------------------------------------------------------------------------

describe('pitch: up means nose up (guard)', () => {
  for (const assist of MODES) {
    it(`Given ${modeName(assist)}, When ArrowUp is held, Then the nose rises (body +Y)`, () => {
      const { nose } = fly({ kind: 'key', code: 'ArrowUp' }, assist);
      expect(nose.y).toBeGreaterThan(Math.sin(MIN_TURN));
      expect(Math.abs(nose.y)).toBeGreaterThan(Math.abs(nose.x));
    });

    it(`Given ${modeName(assist)}, When ArrowDown is held, Then the nose drops (body −Y)`, () => {
      const { nose } = fly({ kind: 'key', code: 'ArrowDown' }, assist);
      expect(nose.y).toBeLessThan(-Math.sin(MIN_TURN));
    });

    it(`Given ${modeName(assist)} and invertY off (the default), When the mouse stick is pushed up, Then the nose rises`, () => {
      const { nose } = fly({ kind: 'mouse', dx: 0, dy: -R }, assist);
      expect(nose.y).toBeGreaterThan(Math.sin(MIN_TURN));
      expect(Math.abs(nose.y)).toBeGreaterThan(Math.abs(nose.x));
    });

    it(`Given ${modeName(assist)} and invertY on, When the mouse stick is pushed up, Then the nose drops (the setting flips the mouse only)`, () => {
      const { nose } = fly({ kind: 'mouse', dx: 0, dy: -R, invertY: true }, assist);
      expect(nose.y).toBeLessThan(-Math.sin(MIN_TURN));
    });
  }
});

describe('roll: E rolls right, Q rolls left (same sign chain — found inverted too)', () => {
  for (const assist of MODES) {
    it(`Given ${modeName(assist)}, When E is held, Then the ship rolls right — clockwise seen from behind, the roof leans to body +X`, () => {
      const { roof, nose } = fly({ kind: 'key', code: 'KeyE' }, assist);
      expect(roof.x).toBeGreaterThan(Math.sin(MIN_TURN));
      // A roll, not a turn: the nose stays put.
      expect(nose.angleTo(new Vector3(0, 0, -1))).toBeLessThan(1 * DEG);
    });

    it(`Given ${modeName(assist)}, When Q is held, Then the ship rolls left — the roof leans to body −X`, () => {
      const { roof } = fly({ kind: 'key', code: 'KeyQ' }, assist);
      expect(roof.x).toBeLessThan(-Math.sin(MIN_TURN));
    });
  }
});

// ---------------------------------------------------------------------------
// Consumers of the axis sign — guard
// ---------------------------------------------------------------------------

/**
 * cruiseSteer and autopilot write `FlightModel.command` and divide
 * `config.yawAxisSign` / `rollAxisSign` back out. A fix that changes the sign
 * must leave them steering home. Flown at BOTH signs, so the guard passes
 * whichever one the fix lands on, and fails if a consumer stops honouring it
 * (or the plant applies a sign the config does not declare).
 */
describe('computer steering honours the yaw sign, whatever it is (guard)', () => {
  for (const sign of [-1, 1] as const) {
    for (const assist of MODES) {
      it(`Given yawAxisSign ${sign} and ${modeName(assist)}, When cruiseSteer chases a target 90° to either side hands-off, Then the nose arrives within 1°`, () => {
        for (const side of [1, -1]) {
          const cfg: ShipConfig = { ...DEFAULT_SHIP_CONFIG, yawAxisSign: sign };
          const fm = new FlightModel(cfg);
          fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0 });
          fm.teleport(new Vector3(), new Vector3(), new Quaternion());
          fm.attitudeHold = assist;
          const target = new Vector3(side * 1e6, 0, 0);
          for (let i = 0; i < 10 * 60; i++) {
            fm.command.pitch = 0;
            fm.command.yaw = 0;
            fm.command.roll = 0;
            fm.command.throttle = 0;
            steerToward(fm, target);
            fm.update(DT);
          }
          expect(noseErrorRad(fm, target)).toBeLessThan(1 * DEG);
        }
      });
    }
  }
});
