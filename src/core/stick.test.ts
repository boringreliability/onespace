/**
 * The mouse as a virtual joystick (GAMEPLAY B1).
 *
 * The defect this replaces: one frame's pixel delta became the axis and was
 * then thrown away, so the axis was a spike lasting 1/60 s that the attitude
 * hold damped back out. A 2000 px swipe turned the nose 2.6°, and the same
 * swipe at 144 Hz turned it 2.4× less. The stick keeps the deflection instead:
 * the mouse moves a dot, and the dot's offset from centre IS the axis, held for
 * as long as the dot stays put.
 */

import { describe, expect, it } from 'vitest';
import { STICK_DEFAULTS, VirtualStick, stickCurve } from './stick';

const R = STICK_DEFAULTS.radiusPx;

describe('VirtualStick deflection', () => {
  it('Given a centred stick, When nothing has moved, Then deflection and axis are zero', () => {
    const s = new VirtualStick();
    expect(s.deflection.x).toBe(0);
    expect(s.deflection.y).toBe(0);
    expect(s.axis.x).toBe(0);
    expect(s.axis.y).toBe(0);
  });

  it('Given the default tuning, Then the radius is about 300 px', () => {
    expect(R).toBeGreaterThanOrEqual(250);
    expect(R).toBeLessThanOrEqual(350);
  });

  it('Given a centred stick, When the mouse moves half a radius right, Then deflection.x is 0.5', () => {
    const s = new VirtualStick();
    s.addDelta(R / 2, 0);
    expect(s.deflection.x).toBeCloseTo(0.5, 9);
    expect(s.deflection.y).toBe(0);
  });

  it('Given a centred stick, When the mouse moves down, Then deflection.y is positive (screen convention)', () => {
    const s = new VirtualStick();
    s.addDelta(0, R / 4);
    expect(s.deflection.y).toBeCloseTo(0.25, 9);
  });

  it('Given a deflected stick, When the mouse stops moving, Then the axis is held (not reset next frame)', () => {
    const s = new VirtualStick();
    s.addDelta(R, 0);
    s.update(1 / 60);
    const first = s.axis.x;
    s.update(1 / 60);
    s.update(1 / 60);
    expect(first).toBeGreaterThan(0.95);
    // Recentring is slow, so three frames later it has barely moved.
    expect(s.axis.x).toBeGreaterThan(first * 0.97);
  });
});

describe('VirtualStick clamp', () => {
  it('Given a 2000 px swipe right, Then deflection saturates at exactly 1', () => {
    const s = new VirtualStick();
    s.addDelta(2000, 0);
    expect(s.deflection.x).toBeCloseTo(1, 9);
    expect(s.axis.x).toBeCloseTo(1, 9);
  });

  it('Given a diagonal swipe past the radius, Then the clamp is circular (length 1, direction kept)', () => {
    const s = new VirtualStick();
    s.addDelta(1000, 1000);
    const len = Math.hypot(s.deflection.x, s.deflection.y);
    expect(len).toBeCloseTo(1, 9);
    expect(s.deflection.x).toBeCloseTo(s.deflection.y, 9);
  });

  it('Given a stick pinned at full right by a huge swipe, When the mouse comes back half a radius, Then it reads 0.5 at once (no wound-up travel)', () => {
    // Clamping the accumulator itself, not just the output, is what makes
    // backing off the stick respond immediately.
    const s = new VirtualStick();
    s.addDelta(5000, 0);
    s.addDelta(-R / 2, 0);
    expect(s.deflection.x).toBeCloseTo(0.5, 9);
  });

  it('Given a non-finite pointer delta, Then it is ignored rather than poisoning the stick', () => {
    const s = new VirtualStick();
    s.addDelta(R / 2, 0);
    s.addDelta(Number.NaN, Number.POSITIVE_INFINITY);
    expect(s.deflection.x).toBeCloseTo(0.5, 9);
    expect(Number.isFinite(s.deflection.y)).toBe(true);
    expect(s.deflection.y).toBe(0);
  });
});

describe('VirtualStick deadzone', () => {
  it('Given a tiny deflection inside the deadzone, Then the axis is zero but the HUD deflection is not', () => {
    const s = new VirtualStick();
    const inside = STICK_DEFAULTS.deadzone * R * 0.5;
    s.addDelta(inside, 0);
    expect(s.axis.x).toBe(0);
    expect(s.deflection.x).toBeGreaterThan(0);
  });

  it('Given a deflection just past the deadzone, Then the axis starts near zero (continuous, no jump)', () => {
    const s = new VirtualStick();
    s.addDelta(STICK_DEFAULTS.deadzone * R * 1.05, 0);
    expect(s.axis.x).toBeGreaterThan(0);
    expect(s.axis.x).toBeLessThan(0.01);
  });

  it('Given full deflection, Then the rescaled axis still reaches 1', () => {
    const s = new VirtualStick();
    s.addDelta(0, -R);
    expect(s.axis.y).toBeCloseTo(-1, 9);
  });

  it('Given the deadzone, Then it is small (a few percent of the radius)', () => {
    expect(STICK_DEFAULTS.deadzone).toBeGreaterThan(0);
    expect(STICK_DEFAULTS.deadzone).toBeLessThanOrEqual(0.1);
  });
});

describe('VirtualStick framerate independence', () => {
  /**
   * The same physical hand movement — 600 px right spread evenly over 0.5 s,
   * then held for 0.5 s — sampled at three frame rates. What the flight model
   * integrates is the axis over time, so that integral is the measure.
   */
  function axisIntegral(hz: number): number {
    const s = new VirtualStick();
    const dt = 1 / hz;
    let sum = 0;
    const frames = Math.round(hz);
    const moveFrames = Math.round(hz / 2);
    for (let i = 0; i < frames; i++) {
      if (i < moveFrames) s.addDelta(600 / moveFrames, 0);
      s.update(dt);
      sum += s.axis.x * dt;
    }
    return sum;
  }

  it('Given the same mouse motion over 1 s, When sampled at 30, 60 and 144 Hz, Then the integrated axis agrees within 5%', () => {
    const a30 = axisIntegral(30);
    const a60 = axisIntegral(60);
    const a144 = axisIntegral(144);
    expect(a60).toBeGreaterThan(0.5);
    expect(Math.abs(a30 - a60) / a60).toBeLessThan(0.05);
    expect(Math.abs(a144 - a60) / a60).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// [v3-T2] S1: the stick holds. The v2 constant recentring (linear, 8 s for a
// full deflection) is gone: it ate small deflections (0.25 was gone after
// 2 s), which made precision aiming impossible. These replace the v2
// "VirtualStick recentring" block, which asserted the drift itself.
// ---------------------------------------------------------------------------

describe('[v3-T2] VirtualStick holds until the hand moves', () => {
  it('Given a half deflection, When 10 s of frames pass with no mouse motion, Then the deflection is exactly where it was put', () => {
    const s = new VirtualStick();
    s.addDelta(R / 2, 0);
    for (let i = 0; i < 600; i++) {
      s.addDelta(0, 0); // Input feeds a zero delta every frame
      s.update(1 / 60);
    }
    expect(s.deflection.x).toBe(0.5);
    expect(s.deflection.y).toBe(0);
  });

  it('Given a small precision deflection (0.25), When held 2 s, Then it survives intact (S1: v2 had eaten it by now)', () => {
    const s = new VirtualStick();
    s.addDelta(R / 4, 0);
    for (let i = 0; i < 120; i++) s.update(1 / 60);
    expect(s.deflection.x).toBe(0.25);
  });

  it('Given the default tuning, Then auto-centre is OFF (a held turn is a turn, however long it lasts)', () => {
    expect(STICK_DEFAULTS.autoCentre).toBe(false);
  });

  it('Given the default tuning, Then the radius is unchanged at 300 px and the deadzone is 2.5 %', () => {
    expect(STICK_DEFAULTS.radiusPx).toBe(300);
    expect(STICK_DEFAULTS.deadzone).toBe(0.025);
  });

  it('Given a deflected stick, When reset() is called (pointer lock lost), Then it is centred at once', () => {
    const s = new VirtualStick();
    s.addDelta(R, -R);
    s.reset();
    expect(s.deflection.x).toBe(0);
    expect(s.deflection.y).toBe(0);
    expect(s.axis.x).toBe(0);
    expect(s.axis.y).toBe(0);
  });
});

describe('[v3-T2] response curve 0.35x + 0.65x³ after the deadzone rescale', () => {
  it('Given the curve, Then it is 0 at 0, 1 at 1, odd, and 0.25625 at 0.5', () => {
    expect(stickCurve(0)).toBe(0);
    expect(stickCurve(1)).toBeCloseTo(1, 12);
    expect(stickCurve(0.5)).toBeCloseTo(0.35 * 0.5 + 0.65 * 0.125, 12);
    expect(stickCurve(-0.5)).toBeCloseTo(-stickCurve(0.5), 12);
  });

  it('Given the curve swept 0→1, Then it rises strictly monotonically and never leaves [0, 1]', () => {
    let prev = -1;
    for (let x = 0; x <= 1.0000001; x += 0.01) {
      const y = stickCurve(Math.min(1, x));
      expect(y).toBeGreaterThan(prev);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1 + 1e-12);
      prev = y;
    }
  });

  it('Given a half deflection straight down, Then the axis is the curve of the rescaled magnitude', () => {
    const s = new VirtualStick();
    s.addDelta(0, R / 2);
    const dz = STICK_DEFAULTS.deadzone;
    expect(s.axis.y).toBeCloseTo(stickCurve((0.5 - dz) / (1 - dz)), 12);
    expect(s.axis.x).toBe(0);
  });

  it('Given a diagonal deflection, Then the curve acts on the radius: the direction is kept (x = y)', () => {
    const s = new VirtualStick();
    s.addDelta(R * 0.3, R * 0.3);
    expect(s.axis.x).toBeCloseTo(s.axis.y, 12);
    const mag = Math.hypot(0.3, 0.3);
    const dz = STICK_DEFAULTS.deadzone;
    expect(Math.hypot(s.axis.x, s.axis.y)).toBeCloseTo(stickCurve((mag - dz) / (1 - dz)), 12);
  });

  it('Given a deflection of 2 % (inside the 2.5 % deadzone), Then the axis is exactly 0 but the HUD dot still moves', () => {
    const s = new VirtualStick();
    s.addDelta(R * 0.02, 0);
    expect(s.axis.x).toBe(0);
    expect(s.deflection.x).toBeCloseTo(0.02, 12);
  });

  it('Given a deflection of 3 % (just outside), Then the axis is small, positive and continuous with zero', () => {
    const s = new VirtualStick();
    s.addDelta(R * 0.03, 0);
    expect(s.axis.x).toBeGreaterThan(0);
    expect(s.axis.x).toBeLessThan(0.003);
  });
});

describe('[v3-T2] optional auto-centre (1.0 s idle, then exp τ 0.25 s)', () => {
  const AUTO = { autoCentre: true } as const;

  it('Given auto-centre on, When the stick sits idle for 0.99 s, Then nothing has moved yet', () => {
    const s = new VirtualStick(AUTO);
    s.addDelta(R, 0);
    for (let i = 0; i < 99; i++) s.update(0.01);
    expect(s.deflection.x).toBe(1);
  });

  it('Given auto-centre on, When idle for 1.0 s + τ, Then the deflection has decayed to 1/e', () => {
    const s = new VirtualStick(AUTO);
    s.addDelta(R, 0);
    const n = Math.round((STICK_DEFAULTS.autoCentreIdleSeconds + STICK_DEFAULTS.autoCentreTau) * 120);
    for (let i = 0; i < n; i++) s.update(1 / 120);
    expect(s.deflection.x).toBeCloseTo(Math.exp(-1), 6);
  });

  it('Given auto-centre on, When the hand nudges the mouse every 0.9 s, Then the stick never starts centring (motion resets the idle clock)', () => {
    const s = new VirtualStick(AUTO);
    s.addDelta(R * 0.6, 0);
    for (let i = 0; i < 600; i++) {
      if (i % 54 === 53) s.addDelta(0.5, 0);
      s.update(1 / 60);
    }
    expect(s.deflection.x).toBeGreaterThan(0.6);
  });

  it('Given auto-centre on, When a zero delta arrives each frame, Then that is NOT motion (Input feeds zeros every frame)', () => {
    const s = new VirtualStick(AUTO);
    s.addDelta(R, 0);
    for (let i = 0; i < 180; i++) {
      s.addDelta(0, 0);
      s.update(1 / 60);
    }
    expect(s.deflection.x).toBeLessThan(0.1);
  });

  it('Given auto-centre on, When idle for 2 s at 30, 60 and 144 Hz, Then the decay is identical (the idle threshold is crossed mid-frame exactly)', () => {
    const out: number[] = [];
    for (const hz of [30, 60, 144]) {
      const s = new VirtualStick(AUTO);
      s.addDelta(R, 0);
      for (let i = 0; i < 2 * hz; i++) s.update(1 / hz);
      out.push(s.deflection.x);
    }
    expect(out[0]).toBeCloseTo(Math.exp(-1 / STICK_DEFAULTS.autoCentreTau), 6);
    expect(out[1]).toBeCloseTo(out[0]!, 9);
    expect(out[2]).toBeCloseTo(out[0]!, 9);
  });

  it('Given auto-centre on and a negative or non-finite dt, Then the stick does not move', () => {
    const s = new VirtualStick(AUTO);
    s.addDelta(R / 2, 0);
    s.update(-1);
    s.update(Number.NaN);
    s.update(Number.POSITIVE_INFINITY);
    expect(s.deflection.x).toBe(0.5);
  });

  it('Given auto-centre on and a very long idle frame, Then it decays towards the centre and never overshoots it', () => {
    const s = new VirtualStick(AUTO);
    s.addDelta(R * 0.5, 0);
    s.update(30);
    expect(s.deflection.x).toBeGreaterThanOrEqual(0);
    expect(s.deflection.x).toBeLessThan(1e-9);
  });
});

describe('review p1a: VirtualStick survivors', () => {
  it('Given a shove of exactly two radii, When the hand comes back one radius, Then the stick is centred (no wound-up travel)', () => {
    const s = new VirtualStick();
    s.addDelta(2 * R, 0);
    s.addDelta(-R, 0);
    expect(s.deflection.x).toBeCloseTo(0, 12);
  });

  it('Given a non-finite y delta, Then the whole delta is ignored (x does not move either)', () => {
    const s = new VirtualStick();
    s.addDelta(R / 2, Number.NaN);
    s.addDelta(R / 2, Number.POSITIVE_INFINITY);
    expect(s.deflection.x).toBe(0);
    expect(s.deflection.y).toBe(0);
  });
});
