/**
 * [v3-T2] Key axes ramp (PLAN phase B): up over 0.15 s, down over 0.08 s.
 *
 * An arrow key was a step from 0 to full rate demand, which under the new
 * rate-command plant would be the α_max kick on every tap. The ramp is a pure
 * function of (current, target, dt), linear in time, so it is exactly the same
 * however a second is sliced into frames — including a reversal, which ramps
 * down through zero at the down rate and then up at the up rate.
 */

import { describe, expect, it } from 'vitest';
import { KEY_RAMP, rampAxis } from './Input';

function ramp(from: number, to: number, seconds: number, hz: number): number {
  let v = from;
  const n = Math.round(seconds * hz);
  for (let i = 0; i < n; i++) v = rampAxis(v, to, 1 / hz);
  return v;
}

describe('[v3-T2] rampAxis (pure)', () => {
  it('Given the tuning, Then up is 0.15 s and down is 0.08 s for a full stroke', () => {
    expect(KEY_RAMP.upSeconds).toBe(0.15);
    expect(KEY_RAMP.downSeconds).toBe(0.08);
  });

  it('Given an axis at 0, When the key is held, Then it is 0.5 after 0.075 s and exactly 1 after 0.15 s', () => {
    expect(rampAxis(0, 1, 0.075)).toBeCloseTo(0.5, 12);
    expect(rampAxis(0, 1, 0.15)).toBe(1);
    expect(rampAxis(0, -1, 0.15)).toBe(-1);
  });

  it('Given an axis at full, When the key is released, Then it is 0.5 after 0.04 s and exactly 0 after 0.08 s', () => {
    expect(rampAxis(1, 0, 0.04)).toBeCloseTo(0.5, 12);
    expect(rampAxis(1, 0, 0.08)).toBe(0);
    expect(rampAxis(-1, 0, 0.08)).toBe(0);
  });

  it('Given any step, Then the axis never passes its target (no overshoot)', () => {
    expect(rampAxis(0, 0.3, 1)).toBe(0.3);
    expect(rampAxis(0.9, 0.2, 1)).toBe(0.2);
    expect(rampAxis(0.2, 0.2, 1 / 60)).toBe(0.2);
  });

  // [review-v3a] mutation survivor: shrinking to a smaller target on the same side.
  it('Given 0.9 easing to 0.2 on the same side, When 0.06 s pass, Then it stops at 0.2 on the down ramp (it does not dip through it towards 0)', () => {
    expect(rampAxis(0.9, 0.2, 0.06)).toBe(0.2);
    expect(rampAxis(-0.9, -0.2, 0.06)).toBe(-0.2);
  });

  it('Given a reversal from +1 to −1, Then it takes 0.08 s down to 0 and then 0.15 s up to −1 (0.23 s in all)', () => {
    expect(rampAxis(1, -1, 0.08)).toBeCloseTo(0, 12);
    expect(rampAxis(1, -1, 0.08 + 0.075)).toBeCloseTo(-0.5, 12);
    expect(rampAxis(1, -1, 0.23)).toBe(-1);
  });

  it('Given the same press, When stepped at 30, 60 and 144 Hz, Then the ramp is identical at every common instant', () => {
    // One big step equals many small ones: linear in time.
    expect(ramp(0, 1, 0.1, 300)).toBeCloseTo(rampAxis(0, 1, 0.1), 12);
    expect(ramp(1, -1, 0.2, 300)).toBeCloseTo(rampAxis(1, -1, 0.2), 12);
    // 1/6 s is a whole number of frames at 30, 60 and 144 Hz.
    const r30 = ramp(1, -1, 1 / 6, 30);
    const r60 = ramp(1, -1, 1 / 6, 60);
    const r144 = ramp(1, -1, 1 / 6, 144);
    expect(r60).toBeCloseTo(r30, 12);
    expect(r144).toBeCloseTo(r30, 12);
    expect(r30).toBeCloseTo(-((1 / 6 - 0.08) / 0.15), 12);
  });

  it('Given a non-positive or non-finite dt, Then the axis is unchanged', () => {
    expect(rampAxis(0.4, 1, 0)).toBe(0.4);
    expect(rampAxis(0.4, 1, -1)).toBe(0.4);
    expect(rampAxis(0.4, 1, Number.NaN)).toBe(0.4);
    expect(rampAxis(0.4, 1, Infinity)).toBe(0.4); // [review-v3a] survivor
  });

  it('Given a non-finite current value, Then it recovers to a finite one (target or 0), never NaN', () => {
    const v = rampAxis(Number.NaN, 1, 1 / 60);
    expect(Number.isFinite(v)).toBe(true);
  });
});
