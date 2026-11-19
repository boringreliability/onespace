/**
 * v4 sub-plan 2 (mining), Task 7 — the charts show the belt.
 *
 * SystemMap and StarMap build SVG/DOM and do not run in node, so these pin
 * the pure seams they call (the same split as `jumpCostCell.test.ts`):
 *
 * - `beltRing(belt, maxKm)` — the dashed annulus's radii on the local chart,
 *   through the chart's own log scale `radial()` (which moves out of
 *   SystemMap into `ui/beltChart.ts` so both can share it).
 * - `beltNodeTarget(system, shipWorld, orbitSeconds)` — what selecting the
 *   BELT node emits on `target:changed`: the field nearest the ship NOW.
 * - `systemDetailsOf(system)` / `planetsCell(details)` — the galaxy chart's
 *   info panel: MapMode's details provider (it already generates the system)
 *   and the PLANETS cell that lists BELT.
 *
 * Fixture: the real start system (Fyss, via a real `Universe.init`).
 */

import { describe, expect, it } from 'vitest';

import { Rng, hashSeed } from '@/math/rng';
import { beltFor, fieldOrbits, nearestFieldIndex, type BeltSpec } from '@/gen/belt';
import { generateGalaxy, sampleSystemsNear } from '@/gen/galaxy';
import { generateSystem } from '@/gen/system';
import { AU, type StarSystemSpec, type Vec3 } from '@/gen/types';
import { DEFAULT_UNIVERSE_SEED } from '@/game/Universe';
import { fyssBelt, startSystem, startUniverse } from '@/game/testing/beltFixture';
import { CHART_R, beltNodeTarget, beltRing, chartMaxKm, radial } from './beltChart';
import { planetsCell, systemDetailsOf } from './StarMap';

/** The planet-only chart scale, as SystemMap.rebuild computed it before the belt (R21). */
function planetMaxKm(sys: StarSystemSpec): number {
  return sys.planets.reduce((m, p) => Math.max(m, p.orbit.semiMajorAxis * (1 + p.orbit.eccentricity)), AU) * 1.12;
}

/** A start-survey system by name (the 24 candidates `Universe.pickStartSystem` samples). */
function surveyed(name: string): StarSystemSpec {
  const seed = DEFAULT_UNIVERSE_SEED;
  const galaxy = generateGalaxy(seed);
  const rng = new Rng(hashSeed(seed, 'start'));
  const r = galaxy.radiusLy * 0.34;
  const theta = rng.range(0, Math.PI * 2);
  const probe: Vec3 = [r * Math.cos(theta), rng.gaussian(0, 30), r * Math.sin(theta)];
  const stub = sampleSystemsNear(galaxy, probe, 260, 96)
    .slice(0, 24)
    .find((s) => generateSystem(galaxy, s).name === name);
  if (!stub) throw new Error(`${name} is not in the start survey`);
  return generateSystem(galaxy, stub);
}

describe('chartMaxKm — the system chart scale includes the belt (R21)', () => {
  // CZ-9100 (belt 0.39–0.53 AU) and Ghoxak (0.84–1.13 AU — past the 1 AU
  // floor's 1.12 AU scale, so a planets-only scale clamps its ring to the rim).
  for (const name of ['CZ-9100', 'Ghoxak']) {
    it(`Given a belt system with no planets (${name}), Then the chart scale is positive and the belt ring fits inside it`, () => {
      const sys = surveyed(name);
      expect(sys.planets.length).toBe(0);
      const belt = beltFor(sys)!;
      expect(belt).not.toBeNull();
      const maxKm = chartMaxKm(sys);
      expect(Number.isFinite(maxKm) && maxKm > 0).toBe(true);
      expect(maxKm).toBeCloseTo(Math.max(planetMaxKm(sys), belt.outerAU * AU * 1.12), -3);
      const ring = beltRing(belt, maxKm);
      expect(ring.inner).toBeGreaterThan(0);
      expect(ring.inner).toBeLessThan(ring.outer);
      // Strictly inside the rim: not clamped onto it.
      expect(ring.outer).toBeLessThan(radial(maxKm, maxKm));
    });
  }

  it('Given Fyss, Then maxKm is unchanged by the belt (belt inside the planets)', () => {
    const sys = startSystem();
    expect(fyssBelt().outerAU * AU * 1.12).toBeLessThan(planetMaxKm(sys));
    expect(chartMaxKm(sys)).toBe(planetMaxKm(sys));
  });

  it('Given a system without a belt, Then the scale is the planets’ alone', () => {
    const sys: StarSystemSpec = { ...startSystem(), hasAsteroidBelt: false };
    expect(chartMaxKm(sys)).toBe(planetMaxKm(sys));
  });
});

describe('beltRing — the dashed annulus on the system chart', () => {
  it('Given Fyss’s belt, Then inner < outer, both inside the chart’s maximum, through the chart’s radial()', () => {
    const sys = startSystem();
    const belt = fyssBelt();
    const maxKm = planetMaxKm(sys);
    const ring = beltRing(belt, maxKm);
    expect(ring.inner).toBeGreaterThan(0);
    expect(ring.inner).toBeLessThan(ring.outer);
    expect(ring.outer).toBeLessThanOrEqual(radial(maxKm, maxKm));
    // Same scale as the orbits drawn beside it, or the ring sits in the wrong gap.
    expect(ring.inner).toBeCloseTo(radial(belt.innerAU * AU, maxKm), 9);
    expect(ring.outer).toBeCloseTo(radial(belt.outerAU * AU, maxKm), 9);
  });

  it('Given a belt further out (same chart), Then both radii grow — monotonic with AU', () => {
    const belt = fyssBelt();
    const maxKm = planetMaxKm(startSystem());
    const near = beltRing(belt, maxKm);
    const far: BeltSpec = { ...belt, innerAU: belt.innerAU * 1.5, outerAU: belt.outerAU * 1.5 };
    const ring = beltRing(far, maxKm);
    expect(ring.inner).toBeGreaterThan(near.inner);
    expect(ring.outer).toBeGreaterThan(near.outer);
  });
});

describe('beltNodeTarget — selecting the BELT node', () => {
  it('Given the BELT node selected, Then target:changed carries the nearest field id at the current orbitSeconds', () => {
    // At the opening (ship at Remit 31, t = 0) the nearest field is 398, 0.156 AU off.
    const sys = startSystem();
    const ship = startUniverse().flight.worldPosition.clone();
    // R21: the same 'BELT · <system> <k>' is the field's display / ORBIT-log name.
    expect(beltNodeTarget(sys, ship, 0)).toEqual({ id: `field:${sys.id}:398`, name: 'BELT · Fyss 398' });

    // Later on the orbit clock the fields have moved: it is the nearest NOW.
    const t = 40 * 86_400;
    const k = nearestFieldIndex(fieldOrbits(fyssBelt(), sys.seed), ship, t);
    expect(k).not.toBe(398);
    expect(beltNodeTarget(sys, ship, t)).toEqual({ id: `field:${sys.id}:${k}`, name: `BELT · ${sys.name} ${k}` });
  });

  it('Given a system without a belt, Then there is no BELT node to select (null)', () => {
    const sys: StarSystemSpec = { ...startSystem(), hasAsteroidBelt: false };
    expect(beltNodeTarget(sys, startUniverse().flight.worldPosition, 0)).toBeNull();
  });
});

describe('the galaxy chart info panel', () => {
  it('Given the star chart with a belt system selected, Then the info lists BELT; without, it does not', () => {
    const fyss = startSystem();
    expect(fyss.hasAsteroidBelt).toBe(true);
    const withBelt = systemDetailsOf(fyss);
    expect(withBelt.belt).toBe(true);
    expect(withBelt.planetCount).toBe(fyss.planets.length);
    const cell = planetsCell(withBelt);
    expect(cell.startsWith(String(fyss.planets.length))).toBe(true);
    expect(cell).toContain('BELT');

    const bare = systemDetailsOf({ ...fyss, hasAsteroidBelt: false });
    expect(bare.belt).toBe(false);
    expect(planetsCell(bare)).toBe(String(fyss.planets.length));
    expect(planetsCell(bare)).not.toContain('BELT');
  });

  it('Given no details for a contact, Then the cell still reads -- (nothing invented)', () => {
    expect(planetsCell(null)).toBe('--');
  });
});

// ---------------------------------------------------------------------------
// Mutation hardening (Task 8, phase A): radial()'s clamps and constants.
// ---------------------------------------------------------------------------

describe('radial — the log scale, pinned with numbers (hardening)', () => {
  it('Then the chart radius is 500 and the floor of the scale is 1e5 km', () => {
    expect(CHART_R).toBe(500);
    expect(radial(1e5, 1e9)).toBe(0);
    expect(radial(1e9, 1e9)).toBeCloseTo(500, 9);
    // 1e6 km is one decade of four: a quarter of the way out.
    expect(radial(1e6, 1e9)).toBeCloseTo(500 * (1 / 4), 9);
    // log scale about 1e5: a floor of 2e5 would give 500·ln5/ln(1e9/2e5) instead
    expect(radial(1e7, 1e9)).toBeCloseTo(500 * (2 / 4), 9);
    expect(radial(1.5e5, 1e9)).toBeCloseTo((500 * Math.log(1.5)) / Math.log(1e4), 9);
  });

  it('Given a radius below the floor, Then it is clamped to 0 (never negative)', () => {
    expect(radial(5e4, 1e9)).toBe(0);
    expect(radial(0, 1e9)).toBe(0);
    expect(radial(-100, 1e9)).toBe(0);
  });

  it('Given a radius beyond maxKm, Then it is capped at CHART_R', () => {
    expect(radial(1e10, 1e9)).toBe(500);
    expect(radial(Number.POSITIVE_INFINITY, 1e9)).toBe(500);
  });

  it('Given a tiny maxKm, Then the span is at least a decade (1e6 km): no division by zero', () => {
    // maxKm = 1e5 → span = ln(10), not ln(1) = 0.
    expect(radial(2e5, 1e5)).toBeCloseTo((500 * Math.log(2)) / Math.log(10), 9);
    expect(radial(1e6, 1e5)).toBeCloseTo(500, 9);
    expect(radial(2e5, 0)).toBeCloseTo((500 * Math.log(2)) / Math.log(10), 9);
  });
});
