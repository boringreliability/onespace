/**
 * Reference-frame consistency.
 *
 * A vessel placed co-orbital with the player drifted at about 49 km/s — close
 * enough to a planet's own orbital speed around its star to say the two are
 * not in the same frame. These tests isolate where the disagreement is, and
 * they matter beyond traffic: landing is navigation relative to a body that
 * both rotates and orbits, and the same mismatch would slide a landing site
 * out from under the ship.
 */

import { describe, expect, it } from 'vitest';
import { generateGalaxy, sampleSystemsNear } from './galaxy';
import { generateSystem } from './system';
import { orbitalPosition, orbitalVelocity } from './orbit';

const MU_SUN = 1.32712440018e11;

const GALAXY = generateGalaxy(0x51a1);
const SYSTEMS = sampleSystemsNear(GALAXY, [GALAXY.radiusLy * 0.3, 0, 0], 300, 20)
  .slice(0, 12)
  .map((s) => generateSystem(GALAXY, s));

describe('orbitalVelocity agrees with orbitalPosition', () => {
  it('matches a finite difference of the position it is paired with', () => {
    // The two are derived independently: position integrates the mean anomaly
    // from `period`, velocity comes from vis-viva and needs `mu`. If the two
    // do not describe the same orbit they disagree, and anything that uses the
    // analytic velocity as a reference frame drifts by exactly that error.
    const worst: Array<{ system: string; planet: string; ratio: number }> = [];

    for (const s of SYSTEMS) {
      const mu = MU_SUN * s.stars.reduce((sum, x) => sum + x.mass, 0);
      for (const p of s.planets) {
        const t = p.orbit.period * 0.137;
        const h = Math.max(1, p.orbit.period * 1e-6);
        const a = orbitalPosition(p.orbit, t - h);
        const b = orbitalPosition(p.orbit, t + h);
        const fd = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / (2 * h);
        const v = orbitalVelocity(p.orbit, t, mu);
        const analytic = Math.hypot(v.x, v.y, v.z);
        worst.push({ system: s.name, planet: p.name, ratio: analytic / fd });
      }
    }

    worst.sort((x, y) => Math.abs(Math.log(y.ratio)) - Math.abs(Math.log(x.ratio)));
    const w = worst[0]!;
    // A 1% tolerance: the finite difference carries its own truncation error,
    // but nothing here should be off by tens of percent, let alone a factor.
    expect(
      w.ratio,
      `${w.system} / ${w.planet}: analytic speed is ${w.ratio.toFixed(3)}x the ` +
        `rate its own position actually changes`,
    ).toBeCloseTo(1, 2);
  });

  it('points the same way as the motion it describes', () => {
    for (const s of SYSTEMS.slice(0, 4)) {
      const mu = MU_SUN * s.stars.reduce((sum, x) => sum + x.mass, 0);
      for (const p of s.planets) {
        const t = p.orbit.period * 0.31;
        const h = Math.max(1, p.orbit.period * 1e-6);
        const a = orbitalPosition(p.orbit, t - h);
        const b = orbitalPosition(p.orbit, t + h);
        const fd = [(b.x - a.x) / (2 * h), (b.y - a.y) / (2 * h), (b.z - a.z) / (2 * h)];
        const v = orbitalVelocity(p.orbit, t, mu);
        const dot =
          (fd[0]! * v.x + fd[1]! * v.y + fd[2]! * v.z) /
          (Math.hypot(...fd) * Math.hypot(v.x, v.y, v.z));
        expect(dot).toBeGreaterThan(0.999);
      }
    }
  });
});

describe("Kepler's third law holds for generated orbits", () => {
  it('period matches the semi-major axis and the stellar mass', () => {
    // If the generator stores a period that does not satisfy P^2 = 4pi^2 a^3/mu
    // for the mass anything else uses, then position and velocity are computing
    // two different orbits and no amount of care downstream reconciles them.
    for (const s of SYSTEMS) {
      const mu = MU_SUN * s.stars.reduce((sum, x) => sum + x.mass, 0);
      for (const p of s.planets) {
        const expected = 2 * Math.PI * Math.sqrt(p.orbit.semiMajorAxis ** 3 / mu);
        expect(
          p.orbit.period / expected,
          `${s.name} / ${p.name}: stored period is ` +
            `${(p.orbit.period / expected).toFixed(3)}x Kepler's`,
        ).toBeCloseTo(1, 1);
      }
    }
  });
});
