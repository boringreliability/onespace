/**
 * review-p1 — tests that kill the surviving mutants of the cruise envelope,
 * the drop bleed and the orbit insertion.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { CRUISE_DEFAULTS, CruiseDrive, type CruiseInputs } from './CruiseDrive';
import { DEFAULT_SHIP_CONFIG, FlightModel } from './FlightModel';
import { circularExitVelocity, circularSpeed, insertIntoOrbit } from './cruiseOrbit';

const base: CruiseInputs = { requested: true, clearanceKm: 1e7, grounded: false, atmosphericDensity: 0, nearestRadiusKm: 0 };

/** A drive in 'cruise' at the given clearance. */
function cruising(clearanceKm = 1e7, extra: Partial<CruiseInputs> = {}): CruiseDrive {
  const d = new CruiseDrive();
  for (let i = 0; i < 200 && d.phase !== 'cruise'; i++) d.update(1 / 60, { ...base, clearanceKm, ...extra });
  expect(d.phase).toBe('cruise');
  d.update(1 / 60, { ...base, clearanceKm, ...extra }); // one cruise frame: the ceiling is set
  return d;
}

describe('CruiseDrive — boundaries', () => {
  it('Given cruise closing on a world exactly at its arrival clearance (2 R = 14 480 km), Then it has not arrived yet', () => {
    const d = cruising(1e7, { nearestRadiusKm: 7_240 });
    d.update(1 / 60, {
      ...base, clearanceKm: 14_480, nearestRadiusKm: 7_240,
      arrival: { clearanceKm: 14_480, radiusKm: 7_240, soiRadiusKm: Infinity, closing: true },
    });
    expect(d.phase).toBe('cruise');
  });

  it('Given a spool started at 5 000 km, When the clearance falls to 1 000 km (between hold and engage), Then the spool aborts as MASS', () => {
    const d = new CruiseDrive();
    d.update(1 / 60, { ...base, clearanceKm: 5_000 });
    expect(d.phase).toBe('spooling');
    d.update(1 / 60, { ...base, clearanceKm: 1_000 });
    expect(d.phase).toBe('idle');
    expect(d.blocked).toBe('mass');
  });

  it('Given a NaN clearance, Then the drive refuses as MASS', () => {
    const d = new CruiseDrive();
    d.update(1 / 60, { ...base, clearanceKm: NaN });
    expect(d.phase).toBe('idle');
    expect(d.blocked).toBe('mass');
  });

  it('Given exactly the engage floor (1 200 km), Then it spools', () => {
    const d = new CruiseDrive();
    d.update(1 / 60, { ...base, clearanceKm: 1_200 });
    expect(d.phase).toBe('spooling');
  });
});

describe('CruiseDrive — the drop bleed', () => {
  it('Given an exit speed of 0, Then the bleed stays finite and floored at 0.01 km/s', () => {
    const d = cruising();
    d.update(1 / 60, { ...base, requested: false, exitSpeedKmS: 0 });
    expect(Number.isFinite(d.capKmS)).toBe(true);
    expect(d.capKmS).toBeGreaterThanOrEqual(0.01);
  });

  it('Given a NaN exit speed, Then the bleed falls back to the configured exit and stays finite', () => {
    const d = cruising();
    for (let i = 0; i < 10; i++) d.update(1 / 60, { ...base, requested: false, exitSpeedKmS: NaN });
    expect(Number.isFinite(d.capKmS)).toBe(true);
  });

  it('Given a release far out, When the clearance collapses to 800 km on the next frame, Then the bleed is still under the law (≤ 0.35 × 800)', () => {
    const d = cruising(1e6);
    d.update(1 / 60, { ...base, requested: false, clearanceKm: 800 });
    expect(d.capKmS).toBeLessThanOrEqual(0.35 * 800 + 1e-9);
  });

  it('Given a drop from 1.05e6 km/s to 60, When half the drop has passed, Then the ceiling is 60·(1.05e6/60)^¼ — geometric in progress²', () => {
    const d = cruising(3e6);
    d.update(CRUISE_DEFAULTS.dropTime / 2, { ...base, requested: false, clearanceKm: 3e6, exitSpeedKmS: 60 });
    const expected = 60 * Math.pow(1.05e6 / 60, 0.25);
    expect(Math.abs(d.capKmS - expected) / expected).toBeLessThan(0.01);
  });
});

describe('cruiseOrbit — fallbacks', () => {
  const MU = 398_600;
  function ship(pos: Vector3, vel: Vector3, nose = new Vector3(0, 0, -1)): FlightModel {
    const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: MU, radius: 6_000 });
    fm.teleport(pos, vel, new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), nose.clone().normalize()));
    return fm;
  }

  it('Given r = 0, Then the circular speed is 0, not Infinity', () => {
    expect(circularSpeed(MU, 0)).toBe(0);
  });

  it('Given an almost exactly radial dive, Then the orbit turns the ecliptic way (−Z at +X), not along the noise', () => {
    const v = circularExitVelocity(ship(new Vector3(10_000, 0, 0), new Vector3(-5, 1e-9, 0)), new Vector3()).normalize();
    expect(v.z).toBeLessThan(-0.99);
  });

  it('Given an exactly radial dive at +X, Then the exit direction is −Z, the spawn convention', () => {
    const v = circularExitVelocity(ship(new Vector3(10_000, 0, 0), new Vector3(-5, 0, 0)), new Vector3()).normalize();
    expect(v.z).toBeCloseTo(-1, 9);
  });

  it('Given a ship at rest with the nose along +Y, Then the orbit follows the nose', () => {
    const v = circularExitVelocity(ship(new Vector3(10_000, 0, 0), new Vector3(), new Vector3(0, 1, 0)), new Vector3()).normalize();
    expect(v.y).toBeGreaterThan(0.99);
  });

  it('Given a dive straight down over the pole, Then the insertion still finds a plane and leaves a circular orbit', () => {
    const fm = ship(new Vector3(0, 10_000, 0), new Vector3(0, -5, 0));
    expect(insertIntoOrbit(fm)).toBe(true);
    expect(fm.velocity.length()).toBeCloseTo(Math.sqrt(MU / 10_000), 6);
    expect(Math.abs(fm.velocity.dot(fm.position))).toBeLessThan(1e-6);
  });
});
