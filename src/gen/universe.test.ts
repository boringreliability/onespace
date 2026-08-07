/**
 * Invariants of the generated universe.
 *
 * These are not tests of "does it run" — the smoke script covers that. They
 * assert the physical relationships that make a generated system read as real
 * rather than as sampled noise, because those are exactly the properties that
 * can rot silently. The frost line and the mass-luminosity relation were both
 * wrong at one point in this project's history, and neither threw.
 */

import { describe, expect, it } from 'vitest';
import { generateGalaxy, sampleSystemsNear } from './galaxy';
import { generateSystem } from './system';
import { AU } from './types';
import type { StarSystemSpec } from './types';

const GALAXY = generateGalaxy(0x51a1);
const PROBE = [GALAXY.radiusLy * 0.3, 0, 0] as const;
const STUBS = sampleSystemsNear(GALAXY, PROBE, 300, 60);

/** A decent sample of real systems, generated once and shared. */
const SYSTEMS: StarSystemSpec[] = STUBS.slice(0, 40).map((s) => generateSystem(GALAXY, s));

describe('determinism', () => {
  it('regenerates the same galaxy from the same seed', () => {
    const a = generateGalaxy(1234);
    const b = generateGalaxy(1234);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('regenerates the same system from the same stub', () => {
    const stub = STUBS[0]!;
    const a = generateSystem(GALAXY, stub);
    const b = generateSystem(GALAXY, stub);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('samples the same neighbourhood twice', () => {
    const a = sampleSystemsNear(GALAXY, PROBE, 120, 30);
    const b = sampleSystemsNear(GALAXY, PROBE, 120, 30);
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
  });

  it('gives different seeds different galaxies', () => {
    expect(generateGalaxy(1).id).not.toBe(generateGalaxy(2).id);
  });
});

describe('stellar population', () => {
  it('is dominated by M dwarfs, as a real initial mass function is', () => {
    // Kroupa puts M dwarfs at roughly three quarters of all stars. A generator
    // that spreads spectral classes evenly is the loudest possible tell.
    const primaries = SYSTEMS.map((s) => s.stars[0]!);
    const m = primaries.filter((s) => s.spectralClass === 'M').length;
    expect(m / primaries.length).toBeGreaterThan(0.5);
  });

  it('makes hot O and B stars rare', () => {
    const primaries = SYSTEMS.map((s) => s.stars[0]!);
    const hot = primaries.filter((s) => s.spectralClass === 'O' || s.spectralClass === 'B');
    expect(hot.length / primaries.length).toBeLessThan(0.1);
  });

  it('derives colour from temperature rather than picking it', () => {
    // Hotter stars are bluer: blue minus red must rise with temperature.
    const sorted = SYSTEMS.map((s) => s.stars[0]!).sort((a, b) => a.temperature - b.temperature);
    const coolest = sorted[0]!;
    const hottest = sorted[sorted.length - 1]!;
    if (hottest.temperature > coolest.temperature * 1.5) {
      const coolBias = coolest.color[2] - coolest.color[0];
      const hotBias = hottest.color[2] - hottest.color[0];
      expect(hotBias).toBeGreaterThan(coolBias);
    }
  });

  it('keeps luminosity climbing with mass on the main sequence', () => {
    const ms = SYSTEMS.map((s) => s.stars[0]!).filter((s) =>
      ['O', 'B', 'A', 'F', 'G', 'K', 'M'].includes(s.spectralClass),
    );
    for (const a of ms) {
      for (const b of ms) {
        // L ~ M^3.5: a star twice the mass cannot be dimmer.
        if (b.mass > a.mass * 1.5) expect(b.luminosity).toBeGreaterThan(a.luminosity);
      }
    }
  });
});

describe('system structure', () => {
  it('places the habitable zone where the luminosity puts it', () => {
    // Main-sequence stars only. Remnants store the zone of the star they used
    // to be, deliberately and for the same reason the frost line does: a white
    // dwarf lights nothing today, but its planets condensed around a star that
    // did, and their composition still remembers it.
    const MAIN = ['O', 'B', 'A', 'F', 'G', 'K', 'M'];
    for (const s of SYSTEMS) {
      const star = s.stars[0]!;
      const [inner, outer] = s.habitableZone;
      expect(inner).toBeGreaterThan(0);
      expect(outer).toBeGreaterThan(inner);
      if (!MAIN.includes(star.spectralClass)) continue;
      // Within a few percent rather than exact: the stored zone is computed
      // from the luminosity at formation and carries a small correction, so
      // it does not reproduce 0.97*sqrt(L_now) to the digit. What matters is
      // that it tracks sqrt(L) and does not drift an order of magnitude, which
      // is the failure mode a wrong exponent would produce.
      // TOTAL luminosity, not the primary's. A binary lights its planets with
      // both stars, and the generator knows that — testing against stars[0]
      // alone reported a 35% error that was entirely the companion.
      const totalL = s.stars.reduce((sum, x) => sum + x.luminosity, 0);
      const scale = Math.sqrt(totalL);
      expect(inner / (0.97 * scale)).toBeGreaterThan(0.85);
      expect(inner / (0.97 * scale)).toBeLessThan(1.18);
      expect(outer / inner).toBeCloseTo(1.7 / 0.97, 2);
    }
  });

  it('orders planets outward with no overlapping orbits', () => {
    for (const s of SYSTEMS) {
      for (let i = 1; i < s.planets.length; i++) {
        expect(s.planets[i]!.orbit.semiMajorAxis).toBeGreaterThan(
          s.planets[i - 1]!.orbit.semiMajorAxis,
        );
      }
    }
  });

  it('puts giants outside the frost line and rocky worlds inside it', () => {
    // The single rule that does most of the work in making a system feel real.
    let inner = 0;
    let innerGiants = 0;
    let outer = 0;
    let outerGiants = 0;
    for (const s of SYSTEMS) {
      const frostAu = 4.85 * Math.sqrt(s.stars[0]!.luminosity);
      for (const p of s.planets) {
        const au = p.orbit.semiMajorAxis / AU;
        const giant = p.type === 'gas-giant' || p.type === 'ice-giant';
        if (au < frostAu * 0.6) {
          inner++;
          if (giant) innerGiants++;
        } else if (au > frostAu * 1.4) {
          outer++;
          if (giant) outerGiants++;
        }
      }
    }
    expect(inner).toBeGreaterThan(0);
    expect(outer).toBeGreaterThan(0);
    expect(outerGiants / outer).toBeGreaterThan(innerGiants / Math.max(inner, 1));
  });

  it('produces some giants somewhere', () => {
    // They were absent from the entire universe once: orbits were spaced by
    // luminosity while disc extent scales with stellar mass, so around an
    // M dwarf nothing ever crossed the snow line. Nothing threw.
    const giants = SYSTEMS.flatMap((s) => s.planets).filter(
      (p) => p.type === 'gas-giant' || p.type === 'ice-giant',
    );
    expect(giants.length).toBeGreaterThan(0);
  });

  it('gives every planet a physically sane body', () => {
    for (const s of SYSTEMS) {
      for (const p of s.planets) {
        expect(p.radius).toBeGreaterThan(0);
        expect(p.mass).toBeGreaterThan(0);
        expect(p.gravity).toBeGreaterThan(0);
        expect(p.temperature).toBeGreaterThan(0);
        // Nothing in this galaxy is hotter than a stellar surface.
        expect(p.temperature).toBeLessThan(4000);
        expect(p.orbit.eccentricity).toBeGreaterThanOrEqual(0);
        expect(p.orbit.eccentricity).toBeLessThan(1);
        expect(p.orbit.period).toBeGreaterThan(0);
      }
    }
  });

  it('gives atmospheres a scale height in the right order of magnitude', () => {
    // Earth's is 8.5 km. A tenth of that meant the molecular mass was wrong,
    // which happened here and produced 0.86 km atmospheres that still rendered.
    const atmos = SYSTEMS.flatMap((s) => s.planets)
      .map((p) => p.atmosphere)
      .filter((a): a is NonNullable<typeof a> => a !== null);
    expect(atmos.length).toBeGreaterThan(0);
    for (const a of atmos) {
      expect(a.scaleHeight).toBeGreaterThan(1);
      // 120 km is the generator's own ceiling; a hot, low-gravity hydrogen
      // envelope reaches it legitimately. The failure this guards against is
      // the opposite one: Earth came out at 0.86 km when the molecular mass
      // was wrong, and nothing threw.
      expect(a.scaleHeight).toBeLessThanOrEqual(120);
      expect(a.thickness).toBeGreaterThan(a.scaleHeight);
    }
  });

  it('tidally locks close-in worlds', () => {
    const locked = SYSTEMS.flatMap((s) => s.planets).filter(
      (p) => Math.abs(p.rotationPeriod - p.orbit.period) < 1,
    );
    // Not every system has one, but across forty systems some must.
    expect(locked.length).toBeGreaterThan(0);
  });

  it('keeps moons inside a plausible Hill sphere of their planet', () => {
    for (const s of SYSTEMS) {
      for (const p of s.planets) {
        // The real bound is the Hill sphere, not an arbitrary fraction:
        //   r_hill = a * (m_planet / 3 M_star)^(1/3)
        // in consistent units. Earth masses per solar mass is 332,946.
        // Total stellar mass, for the same reason as the luminosity above.
        const totalM = s.stars.reduce((sum, x) => sum + x.mass, 0);
        const hill =
          p.orbit.semiMajorAxis * Math.cbrt(p.mass / (3 * totalM * 332946));
        for (const m of p.moons) {
          expect(m.isMoon).toBe(true);
          expect(m.orbit.semiMajorAxis).toBeGreaterThan(p.radius);
          // Half the Hill radius: the practical stability limit for a prograde
          // satellite, and the bound the generator now enforces. Before it did,
          // the outermost moons of eight-moon systems sat 47% OUTSIDE the
          // sphere they would have to be inside to be bound at all.
          expect(m.orbit.semiMajorAxis).toBeLessThanOrEqual(hill * 0.5 + 1e-6);
        }
      }
    }
  });
});

describe('naming', () => {
  it('never repeats a name inside one system', () => {
    for (const s of SYSTEMS) {
      const names = s.planets.flatMap((p) => [p.name, ...p.moons.map((m) => m.name)]);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('gives everything a non-empty name and a unique id', () => {
    const ids = new Set<string>();
    for (const s of SYSTEMS) {
      expect(s.name.length).toBeGreaterThan(0);
      for (const p of s.planets) {
        expect(p.name.length).toBeGreaterThan(0);
        expect(ids.has(p.id)).toBe(false);
        ids.add(p.id);
      }
    }
  });
});
