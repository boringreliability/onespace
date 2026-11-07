/**
 * v3 T3, phase D — the boost ramp (PLAN §2 D, A2).
 *
 * Boost multiplied main thrust ×3 on the substep Shift (or the autopilot)
 * asked for it: 0.4 km/s² (41 g) in 1/120 s, ~1 040 g/s of jerk measured. The
 * multiplier now ramps over BOOST_RAMP_S (0.5 s) both ways, for the pilot's
 * Shift and the autopilot alike, so jerk from boost alone is ≤ 82 g/s.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { BOOST_RAMP_S, DEFAULT_SHIP_CONFIG, FlightModel } from './FlightModel';

const FRAME = 1 / 60;
const G0 = 9.80665e-3;

/** Deep space, FA-OFF, main drive spooled to 100 %, nose +Z. */
function spooled(): FlightModel {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  fm.flightAssist = false;
  fm.teleport(new Vector3(), new Vector3(), new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), new Vector3(0, 0, 1)));
  fm.command.throttle = 1;
  for (let i = 0; i < 60 * 6; i++) fm.update(FRAME); // spool settles
  return fm;
}

/** Proper acceleration along the nose over one frame, km/s². */
function accelOver(fm: FlightModel): number {
  const v0 = fm.velocity.clone();
  fm.update(FRAME);
  return fm.velocity.clone().sub(v0).dot(fm.forward) / FRAME;
}

describe('boost ramp', () => {
  it('Given the ramp, Then it is 0.5 s', () => {
    expect(BOOST_RAMP_S).toBe(0.5);
  });

  it('Given the main drive at 100 %, When boost is pressed (pilot Shift), Then jerk stays ≤ 150 g/s while the thrust ramps to the full ×3 within the ramp (+ a frame)', () => {
    const fm = spooled();
    let prev = accelOver(fm);
    const base = prev;
    fm.command.boost = true;
    let maxJerk = 0;
    let reachedAt = Number.NaN;
    for (let i = 1; i <= 120; i++) {
      const a = accelOver(fm);
      maxJerk = Math.max(maxJerk, Math.abs(a - prev) / FRAME / G0);
      prev = a;
      if (Number.isNaN(reachedAt) && a >= base * DEFAULT_SHIP_CONFIG.boostMultiplier * 0.99) reachedAt = i * FRAME;
    }
    expect(maxJerk).toBeLessThanOrEqual(150);
    expect(reachedAt).toBeLessThanOrEqual(BOOST_RAMP_S + 2 * FRAME);
    expect(fm.boostFactor).toBeCloseTo(DEFAULT_SHIP_CONFIG.boostMultiplier, 9);
  });

  it('Given full boost, When it is released, Then the thrust ramps back down — no 41 g step the other way either', () => {
    const fm = spooled();
    fm.command.boost = true;
    for (let i = 0; i < 60; i++) fm.update(FRAME);
    let prev = accelOver(fm);
    fm.command.boost = false;
    let maxJerk = 0;
    for (let i = 0; i < 60; i++) {
      const a = accelOver(fm);
      maxJerk = Math.max(maxJerk, Math.abs(a - prev) / FRAME / G0);
      prev = a;
    }
    expect(maxJerk).toBeLessThanOrEqual(150);
    expect(fm.boostFactor).toBeCloseTo(1, 9);
  });

  it('Given boost tapped for one frame, Then the factor rises only by one frame of ramp, not to ×3', () => {
    const fm = spooled();
    fm.command.boost = true;
    fm.update(FRAME);
    fm.command.boost = false;
    const step = ((DEFAULT_SHIP_CONFIG.boostMultiplier - 1) * FRAME) / BOOST_RAMP_S;
    expect(fm.boostFactor).toBeGreaterThan(1);
    expect(fm.boostFactor).toBeLessThanOrEqual(1 + step + 1e-9);
  });

  it('Given no boost ever, Then the factor is exactly 1 and the unboosted flight is unchanged', () => {
    const fm = spooled();
    expect(fm.boostFactor).toBe(1);
    expect(accelOver(fm)).toBeCloseTo((DEFAULT_SHIP_CONFIG.mainThrust / DEFAULT_SHIP_CONFIG.mass) * 1e-3, 3);
  });
});
