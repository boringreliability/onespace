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
import { STICK_DEFAULTS, VirtualStick } from './stick';

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

describe('VirtualStick recentring', () => {
  it('Given a held deflection, When half a second passes, Then it has recentred only a little', () => {
    const s = new VirtualStick();
    s.addDelta(R, 0);
    for (let i = 0; i < 30; i++) s.update(1 / 60);
    expect(s.deflection.x).toBeGreaterThan(0.8);
  });

  it('Given a held deflection, When ten seconds pass, Then it has drifted back close to centre', () => {
    const s = new VirtualStick();
    s.addDelta(R, 0);
    for (let i = 0; i < 600; i++) s.update(1 / 60);
    expect(s.deflection.x).toBeLessThan(0.1);
    expect(s.deflection.x).toBeGreaterThanOrEqual(0);
  });

  it('Given the same hold, When it is updated at 30, 60 and 144 Hz for 1 s, Then the recentring is identical', () => {
    const out: number[] = [];
    for (const hz of [30, 60, 144]) {
      const s = new VirtualStick();
      s.addDelta(R, 0);
      for (let i = 0; i < hz; i++) s.update(1 / hz);
      out.push(s.deflection.x);
    }
    expect(out[1]).toBeCloseTo(out[0]!, 9);
    expect(out[2]).toBeCloseTo(out[0]!, 9);
  });

  it('Given recentring disabled in the tuning, Then a deflection is held indefinitely', () => {
    const s = new VirtualStick({ recentreSeconds: 0 });
    s.addDelta(R / 2, 0);
    for (let i = 0; i < 600; i++) s.update(1 / 60);
    expect(s.deflection.x).toBeCloseTo(0.5, 9);
  });

  it('Given a deflected stick, When reset() is called, Then it is centred at once', () => {
    const s = new VirtualStick();
    s.addDelta(R, -R);
    s.reset();
    expect(s.deflection.x).toBe(0);
    expect(s.deflection.y).toBe(0);
    expect(s.axis.x).toBe(0);
    expect(s.axis.y).toBe(0);
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

describe('review p1a: VirtualStick survivors', () => {
  it('Given a shove of exactly two radii, When the hand comes back one radius, Then the stick is centred (no wound-up travel)', () => {
    const s = new VirtualStick({ recentreSeconds: 0 });
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

  it('Given a negative dt (clock went backwards), Then recentring does not push the stick outwards', () => {
    const s = new VirtualStick();
    s.addDelta(R / 2, 0);
    s.update(-1);
    expect(s.deflection.x).toBeCloseTo(0.5, 12);
  });

  it('Given a small deflection and a long frame, Then recentring stops at the centre and never overshoots it', () => {
    const s = new VirtualStick();
    s.addDelta(R * 0.01, 0);
    s.update(1); // walks 12.5 % of R: far more than the 1 % left
    expect(s.deflection.x).toBe(0);
    expect(s.deflection.y).toBe(0);
  });

  it('Given a half deflection straight down, Then the axis is the rescaled magnitude, not half of it', () => {
    const s = new VirtualStick({ recentreSeconds: 0 });
    s.addDelta(0, R / 2);
    const dz = STICK_DEFAULTS.deadzone;
    expect(s.axis.y).toBeCloseTo((0.5 - dz) / (1 - dz), 12);
    expect(s.axis.x).toBe(0);
  });
});
