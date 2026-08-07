/**
 * Kepler is the one piece of this project with closed-form answers to check
 * against, so it gets checked against them rather than against itself.
 *
 * It also earns tests for a specific reason: a wrong orbital position is
 * invisible in a screenshot — the planet is simply somewhere — and only shows
 * up as an altitude readout that will not settle.
 */

import { describe, expect, it } from 'vitest';
import { orbitalPosition, orbitalVelocity, solveKepler } from './orbit';
import type { OrbitSpec } from './types';

/** A circular, equatorial orbit: the case with an exact answer everywhere. */
function circular(radiusKm: number, periodS: number): OrbitSpec {
  return {
    semiMajorAxis: radiusKm,
    eccentricity: 0,
    inclination: 0,
    longitudeOfAscendingNode: 0,
    argumentOfPeriapsis: 0,
    meanAnomalyAtEpoch: 0,
    period: periodS,
  };
}

describe('solveKepler', () => {
  it('is the identity for a circular orbit', () => {
    for (const M of [0, 0.5, 1, Math.PI, 5, 6.2]) {
      expect(solveKepler(M, 0)).toBeCloseTo(M % (Math.PI * 2), 12);
    }
  });

  it('satisfies its own equation M = E - e sin E', () => {
    for (const e of [0.01, 0.2, 0.5, 0.8, 0.9]) {
      for (const M of [0.1, 1, 2, 3, 4, 5, 6]) {
        const E = solveKepler(M, e);
        expect(E - e * Math.sin(E)).toBeCloseTo(M, 9);
      }
    }
  });

  it('normalises the mean anomaly', () => {
    const a = solveKepler(0.7, 0.3);
    const b = solveKepler(0.7 + Math.PI * 2, 0.3);
    expect(b).toBeCloseTo(a, 10);
  });
});

describe('orbitalPosition', () => {
  it('holds a constant radius on a circular orbit', () => {
    const o = circular(1000, 3600);
    for (let i = 0; i <= 12; i++) {
      const p = orbitalPosition(o, (i / 12) * 3600);
      expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(1000, 6);
    }
  });

  it('returns to its start after exactly one period', () => {
    const o: OrbitSpec = { ...circular(1000, 3600), eccentricity: 0.4 };
    const a = orbitalPosition(o, 0);
    const b = orbitalPosition(o, 3600);
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
    expect(b.z).toBeCloseTo(a.z, 6);
  });

  it('puts periapsis and apoapsis at a(1-e) and a(1+e)', () => {
    const a = 1000;
    const e = 0.3;
    const o: OrbitSpec = { ...circular(a, 3600), eccentricity: e };
    const peri = orbitalPosition(o, 0);
    const apo = orbitalPosition(o, 1800);
    expect(Math.hypot(peri.x, peri.y, peri.z)).toBeCloseTo(a * (1 - e), 5);
    expect(Math.hypot(apo.x, apo.y, apo.z)).toBeCloseTo(a * (1 + e), 5);
  });

  it('keeps a zero-inclination orbit in the XZ plane', () => {
    // Y is up in render space; the textbook frame is Z-up, and the conversion
    // is the one non-standard line in the file.
    const o = circular(500, 1000);
    for (let i = 0; i < 8; i++) {
      expect(orbitalPosition(o, i * 125).y).toBeCloseTo(0, 9);
    }
  });

  it('lifts an inclined orbit out of the plane by a sin i', () => {
    const inc = 0.5;
    const o: OrbitSpec = { ...circular(1000, 3600), inclination: inc };
    let maxY = 0;
    for (let i = 0; i <= 100; i++) maxY = Math.max(maxY, Math.abs(orbitalPosition(o, i * 36).y));
    expect(maxY).toBeCloseTo(1000 * Math.sin(inc), 3);
  });

  it('treats a zero period as pinned at epoch rather than dividing by zero', () => {
    const o: OrbitSpec = { ...circular(1000, 0), meanAnomalyAtEpoch: 1 };
    const a = orbitalPosition(o, 0);
    const b = orbitalPosition(o, 99999);
    expect(b).toEqual(a);
    expect(Number.isFinite(a.x)).toBe(true);
  });

  it('writes into the supplied out object without allocating', () => {
    const out = { x: 0, y: 0, z: 0 };
    const r = orbitalPosition(circular(10, 100), 25, out);
    expect(r).toBe(out);
  });
});

describe('orbitalVelocity', () => {
  it('matches the circular speed sqrt(mu/r)', () => {
    const r = 1000;
    const mu = 398600.4418;
    const period = 2 * Math.PI * Math.sqrt(r ** 3 / mu);
    const v = orbitalVelocity(circular(r, period), 0, mu);
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(Math.sqrt(mu / r), 6);
  });

  it('is perpendicular to the radius on a circular orbit', () => {
    const r = 1000;
    const mu = 398600.4418;
    const period = 2 * Math.PI * Math.sqrt(r ** 3 / mu);
    const o = circular(r, period);
    for (const t of [0, period * 0.17, period * 0.5, period * 0.83]) {
      const p = orbitalPosition(o, t);
      const v = orbitalVelocity(o, t, mu);
      const dot = p.x * v.x + p.y * v.y + p.z * v.z;
      expect(Math.abs(dot)).toBeLessThan(1e-6 * r * Math.sqrt(mu / r));
    }
  });

  it('is fastest at periapsis and slowest at apoapsis', () => {
    const mu = 398600.4418;
    const o: OrbitSpec = { ...circular(1000, 3600), eccentricity: 0.5 };
    const peri = orbitalVelocity(o, 0, mu);
    const apo = orbitalVelocity(o, 1800, mu);
    expect(Math.hypot(peri.x, peri.y, peri.z)).toBeGreaterThan(
      Math.hypot(apo.x, apo.y, apo.z),
    );
  });

  it('agrees with a finite difference of the position', () => {
    // The velocity is derived analytically from vis-viva rather than by
    // differencing; this is the check that the two agree.
    const mu = 398600.4418;
    const o: OrbitSpec = { ...circular(1000, 3600), eccentricity: 0.25 };
    const t = 900;
    const h = 1e-3;
    const a = orbitalPosition(o, t - h);
    const b = orbitalPosition(o, t + h);
    const fd = { x: (b.x - a.x) / (2 * h), y: (b.y - a.y) / (2 * h), z: (b.z - a.z) / (2 * h) };
    const v = orbitalVelocity(o, t, mu);
    // The period and mu must describe the same orbit for this to hold, so
    // compare directions rather than magnitudes.
    const dot =
      (fd.x * v.x + fd.y * v.y + fd.z * v.z) /
      (Math.hypot(fd.x, fd.y, fd.z) * Math.hypot(v.x, v.y, v.z));
    expect(dot).toBeCloseTo(1, 6);
  });
});
