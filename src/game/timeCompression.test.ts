/**
 * v2 phase 4 (GAMEPLAY P6) — time compression, 1× / 10× / 100×, only when legal.
 *
 * "Legal" is the whole feature. Compression multiplies SIMULATED time, and a
 * ship that is thrusting, cruising, jumping or being flown by the autopilot
 * at 100× is a ship whose pilot cannot react — so compression exists only
 * where nothing can happen: on the ground, or in a stable orbit with the
 * engines idle. Stable means the orbit is bound, inside the SOI, and its
 * periapsis clears the atmosphere and the terrain.
 *
 * Accuracy. FlightModel integrates at a fixed 1/120 s and discards anything
 * past 8 substeps a call (its spiral-of-death guard), so 100× cannot be "pass
 * a 100× dt". The simulation is advanced in slices small enough that the
 * accumulator never hits that ceiling — and these tests prove the slicing
 * changes nothing: 100× for N frames is the same trajectory as 1× for 100·N.
 */

import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';

import { DEFAULT_SHIP_CONFIG, FlightModel } from '@/ship/FlightModel';
import {
  MAX_SIM_SECONDS_PER_FRAME,
  SIM_SLICE_S,
  TIME_RATES,
  compressionBlock,
  pilotTouching,
  simSlices,
  stepTimeRate,
  type CompressionInputs,
} from './timeCompression';

describe('the rate ladder', () => {
  it('Given 1×, When "." is pressed twice, Then the rate goes 10× then 100×, and a third press stays at 100×', () => {
    expect(stepTimeRate(1, 1)).toBe(10);
    expect(stepTimeRate(10, 1)).toBe(100);
    expect(stepTimeRate(100, 1)).toBe(100);
  });
  it('Given 100×, When "," is pressed, Then it steps down to 10× then 1×, never below', () => {
    expect(stepTimeRate(100, -1)).toBe(10);
    expect(stepTimeRate(10, -1)).toBe(1);
    expect(stepTimeRate(1, -1)).toBe(1);
  });
  it('The ladder is exactly 1, 10, 100', () => {
    expect([...TIME_RATES]).toEqual([1, 10, 100]);
  });
});

/** A ship parked in a 1.6 R circular orbit about Remit 31, engines cold. */
const STABLE: CompressionInputs = {
  hasWorld: true,
  grounded: false,
  cruising: false,
  warpIdle: true,
  autopilotActive: false,
  engineOutput: 0,
  commandIdle: true,
  periapsisKm: 11_584,
  apoapsisKm: 11_584,
  safeRadiusKm: 7_240 + 187,
  soiRadiusKm: 1e6,
};

describe('when compression is legal', () => {
  it('Given a stable circular orbit with the engines idle, Then compression is allowed', () => {
    expect(compressionBlock(STABLE)).toBeNull();
  });

  it('Given the ship on the ground with the engines idle, Then compression is allowed even though its "orbit" intersects the planet', () => {
    expect(compressionBlock({ ...STABLE, grounded: true, periapsisKm: 0, apoapsisKm: 7_240 })).toBeNull();
  });

  it('Given the main drive still spooled (output above idle), Then it is refused as "thrust"', () => {
    expect(compressionBlock({ ...STABLE, engineOutput: 0.2 })).toBe('thrust');
  });

  it('Given any command on the controls (lever, strafe, brake, boost), Then it is refused as "thrust" — on the ground too', () => {
    expect(compressionBlock({ ...STABLE, commandIdle: false })).toBe('thrust');
    expect(compressionBlock({ ...STABLE, grounded: true, commandIdle: false })).toBe('thrust');
  });

  it('Given the cruise drive engaged, Then it is refused as "cruise"', () => {
    expect(compressionBlock({ ...STABLE, cruising: true })).toBe('cruise');
  });

  it('Given a jump in progress, Then it is refused as "warp"', () => {
    expect(compressionBlock({ ...STABLE, warpIdle: false })).toBe('warp');
  });

  it('Given the autopilot flying, Then it is refused as "autopilot" (it burns; the pilot must be able to take over)', () => {
    expect(compressionBlock({ ...STABLE, autopilotActive: true })).toBe('autopilot');
  });

  it('Given a periapsis inside the atmosphere or terrain margin, Then it is refused as "unstable"', () => {
    expect(compressionBlock({ ...STABLE, periapsisKm: 7_300 })).toBe('unstable');
  });

  it('Given an escape trajectory or an apoapsis beyond the SOI, Then it is refused as "unstable"', () => {
    expect(compressionBlock({ ...STABLE, apoapsisKm: Number.POSITIVE_INFINITY })).toBe('unstable');
    expect(compressionBlock({ ...STABLE, apoapsisKm: 2e6 })).toBe('unstable');
  });

  it('Given no parent world (deep space), Then it is refused as "no-world"', () => {
    expect(compressionBlock({ ...STABLE, hasWorld: false })).toBe('no-world');
  });

  it('Given NaN apsides (a degenerate state), Then it is refused, never allowed', () => {
    expect(compressionBlock({ ...STABLE, periapsisKm: Number.NaN })).toBe('unstable');
  });
});

describe('pilot input drops compression', () => {
  const still = { pitch: 0, yaw: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0, strafeZ: 0 };
  it('Given hands off everything, Then the pilot is not touching', () => {
    expect(pilotTouching(still, false, false)).toBe(false);
  });
  it('Given any stick, lever, strafe, brake or boost, Then the pilot is touching', () => {
    expect(pilotTouching({ ...still, pitch: 0.3 }, false, false)).toBe(true);
    expect(pilotTouching({ ...still, yaw: -0.3 }, false, false)).toBe(true);
    expect(pilotTouching({ ...still, roll: 1 }, false, false)).toBe(true);
    expect(pilotTouching({ ...still, throttle: 0.01 }, false, false)).toBe(true);
    expect(pilotTouching({ ...still, strafeX: 1 }, false, false)).toBe(true);
    expect(pilotTouching({ ...still, strafeY: -1 }, false, false)).toBe(true);
    expect(pilotTouching(still, true, false)).toBe(true);
    expect(pilotTouching(still, false, true)).toBe(true);
  });
  it('Given a stick resting inside its deadzone, Then that is not a touch', () => {
    expect(pilotTouching({ ...still, pitch: 0.01, yaw: -0.01 }, false, false)).toBe(false);
  });
});

describe('slicing the simulated time', () => {
  it('Given 1× at 60 fps, Then the frame is one slice of exactly dt — the uncompressed path is unchanged', () => {
    const s = simSlices(1 / 60, 1, { count: 0, slice: 0 });
    expect(s.count).toBe(1);
    expect(s.slice).toBe(1 / 60);
  });

  it('Given the engine dt clamp (1/15 s) at 1×, Then it is still one slice', () => {
    const s = simSlices(1 / 15, 1, { count: 0, slice: 0 });
    expect(s.count).toBe(1);
    expect(s.slice).toBeCloseTo(1 / 15, 12);
  });

  it(`Given 100× at 60 fps, Then each slice is ≤ ${SIM_SLICE_S.toFixed(3)} s so FlightModel never hits its 8-substep ceiling, and the slices add up to 100·dt`, () => {
    const s = simSlices(1 / 60, 100, { count: 0, slice: 0 });
    expect(s.slice).toBeLessThanOrEqual(SIM_SLICE_S + 1e-12);
    // + one leftover substep in the accumulator must still fit under 8/120.
    expect(s.slice + 1 / 120).toBeLessThan(8 / 120);
    expect(s.count * s.slice).toBeCloseTo(100 / 60, 9);
  });

  it(`Given a slow frame at 100×, Then the simulated time is capped at ${MAX_SIM_SECONDS_PER_FRAME.toFixed(2)} s per frame (a time budget, never a spiral)`, () => {
    const s = simSlices(1 / 15, 100, { count: 0, slice: 0 });
    expect(s.count * s.slice).toBeLessThanOrEqual(MAX_SIM_SECONDS_PER_FRAME + 1e-9);
  });

  it('Given dt = 0 (a frozen or photo-mode frame), Then nothing is simulated', () => {
    const s = simSlices(0, 100, { count: 0, slice: 0 });
    expect(s.count * s.slice).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Accuracy, with the real integrator
// ---------------------------------------------------------------------------

const R = 7_240;
const MU = 9.8e-3 * R * R;

function parked(): FlightModel {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: MU, radius: R });
  const p = new Vector3(1.6 * R, 0, 0);
  fm.teleport(p, fm.orbitalVelocityAt(p));
  return fm;
}

/** One game frame at `rate`, advanced the way Universe advances it. */
function frame(fm: FlightModel, dt: number, rate: number, scratch: { count: number; slice: number }): void {
  simSlices(dt, rate, scratch);
  for (let i = 0; i < scratch.count; i++) fm.update(scratch.slice);
}

function energy(fm: FlightModel): number {
  return fm.velocity.lengthSq() / 2 - MU / fm.position.length();
}

describe('100× is the same physics, just more of it', () => {
  it('Given the same start, When 100× runs for 60 frames and 1× for 6 000, Then the two trajectories agree to the metre', () => {
    const a = parked();
    const b = parked();
    const s = { count: 0, slice: 0 };
    for (let i = 0; i < 60; i++) frame(a, 1 / 60, 100, s);
    for (let i = 0; i < 6_000; i++) frame(b, 1 / 60, 1, s);
    expect(a.position.distanceTo(b.position)).toBeLessThan(1e-3);
    expect(a.velocity.distanceTo(b.velocity)).toBeLessThan(1e-6);
  });

  it('Given a stable 1.6 R orbit about Remit 31, When one full orbit is flown at 100×, Then specific orbital energy drifts < 0.1 %', () => {
    const fm = parked();
    const e0 = energy(fm);
    const period = 2 * Math.PI * Math.sqrt((1.6 * R) ** 3 / MU);
    const frames = Math.ceil(period / (100 / 60));
    const s = { count: 0, slice: 0 };
    let worst = 0;
    for (let i = 0; i < frames; i++) {
      frame(fm, 1 / 60, 100, s);
      worst = Math.max(worst, Math.abs((energy(fm) - e0) / e0));
    }
    console.info(`[time-compression] orbit period ${period.toFixed(0)} s → ${frames} frames at 100× (${(frames / 60).toFixed(0)} s wall); worst energy drift ${(worst * 100).toExponential(2)} %`);
    expect(worst).toBeLessThan(1e-3);
  });

  it('Given the ship resting on the ground, When 100× runs for 10 s of wall time, Then it stays on the ground and does not creep', () => {
    const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: MU, radius: R });
    fm.setGroundSampler((p) => p.length() - R);
    fm.teleport(new Vector3(0, R, 0));
    const s = { count: 0, slice: 0 };
    for (let i = 0; i < 30; i++) frame(fm, 1 / 60, 1, s);
    const start = fm.position.clone();
    for (let i = 0; i < 600; i++) frame(fm, 1 / 60, 100, s);
    expect(fm.grounded).toBe(true);
    expect(fm.position.distanceTo(start)).toBeLessThan(0.01);
  });
});
