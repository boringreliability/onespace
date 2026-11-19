/**
 * [v3-T1] FlightModel's accumulator and the proper-acceleration readout.
 *
 * Only the update path is under test here — the substep budget and a
 * read-only average of what the hull feels. Rotation and assist belong to
 * another track and are deliberately not exercised.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { DEFAULT_SHIP_CONFIG, FlightModel } from './FlightModel';
import { ENGINE_MAX_DT } from '@/core/substeps';

const C = DEFAULT_SHIP_CONFIG;
const MAIN = (C.mainThrust / C.mass) * 1e-3; // km/s²

function deepSpace(v = new Vector3()): FlightModel {
  const fm = new FlightModel(C);
  fm.flightAssist = false;
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0 });
  fm.teleport(new Vector3(), v, new Quaternion());
  return fm;
}

describe('FlightModel: no lost time', () => {
  it('Given a coasting ship and a frame sequence with 66.7 ms hitches, When updated, Then the drawn position is exactly velocity × elapsed time', () => {
    const fm = deepSpace(new Vector3(0, 0, -1)); // 1 km/s along the nose
    let elapsed = 0;
    // A realistic run: mostly 60 fps, a carry builds up, then clamped hitches.
    const pattern = [1 / 60, 0.007, 1 / 60, 0.0123, ENGINE_MAX_DT, 1 / 144, ENGINE_MAX_DT, 1 / 60];
    for (let i = 0; i < 400; i++) {
      const dt = pattern[i % pattern.length]!;
      fm.update(dt);
      elapsed += dt;
    }
    // renderPosition = position + v·carry: the display time is the wall time.
    expect(fm.renderPosition.z).toBeCloseTo(-elapsed, 9);
  });

  it('Given a carry of almost one substep, When one clamped hitch arrives, Then the ship advances by the whole hitch', () => {
    const fm = deepSpace(new Vector3(0, 0, -1));
    fm.update(0.0083); // carry ~8.3 ms, no substep yet
    const before = fm.renderPosition.z;
    fm.update(ENGINE_MAX_DT);
    expect(before - fm.renderPosition.z).toBeCloseTo(ENGINE_MAX_DT, 9);
  });
});

describe('FlightModel.properAccel', () => {
  it('Given full main drive in deep space, When the spool has settled, Then properAccel is the drive along the nose', () => {
    const fm = deepSpace();
    fm.command.throttle = 1;
    for (let i = 0; i < 600; i++) fm.update(1 / 60);
    const a = fm.properAccel;
    expect(a.length()).toBeCloseTo(MAIN * fm.throttle, 4);
    // Nose is -Z at identity.
    expect(a.z).toBeLessThan(0);
    expect(Math.abs(a.x) + Math.abs(a.y)).toBeLessThan(1e-9);
  });

  it('Given a coasting orbit, When the velocity turns under gravity, Then properAccel is zero (free fall feels nothing)', () => {
    const fm = new FlightModel(C);
    fm.flightAssist = false;
    const mu = 398600;
    const r = 7000;
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu, radius: 6000 });
    fm.teleport(new Vector3(r, 0, 0), new Vector3(0, 0, Math.sqrt(mu / r)), new Quaternion());
    for (let i = 0; i < 120; i++) fm.update(1 / 60);
    expect(fm.properAccel.length()).toBeLessThan(1e-9);
    // ...while the velocity really is turning at ~8 m/s².
    expect(fm.gravityAccel.length()).toBeGreaterThan(0.005);
  });

  it('Given one frame of eight substeps under constant thrust, When read, Then properAccel is the average, not the sum', () => {
    const fm = deepSpace();
    fm.command.throttle = 1;
    for (let i = 0; i < 600; i++) fm.update(1 / 60);
    fm.update(ENGINE_MAX_DT);
    expect(fm.properAccel.length()).toBeLessThanOrEqual(MAIN * 1.0001);
    expect(fm.properAccel.length()).toBeGreaterThan(MAIN * fm.throttle * 0.99);
  });

  it('Given a frame with no substep (tiny dt), When read, Then properAccel keeps the last value instead of reading zero', () => {
    const fm = deepSpace();
    fm.command.throttle = 1;
    for (let i = 0; i < 600; i++) fm.update(1 / 60);
    const before = fm.properAccel.length();
    fm.update(0.0001);
    expect(fm.properAccel.length()).toBeCloseTo(before, 9);
  });
});
