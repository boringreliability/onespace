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

import { fieldOrbits, nearestFieldIndex, type BeltSpec } from '@/gen/belt';
import { AU, type StarSystemSpec } from '@/gen/types';
import { fyssBelt, startSystem, startUniverse } from '@/game/testing/beltFixture';
import { beltNodeTarget, beltRing, radial } from './beltChart';
import { planetsCell, systemDetailsOf } from './StarMap';

/** The local chart's outer radius for a system, as SystemMap.rebuild computes it. */
function chartMaxKm(sys: StarSystemSpec): number {
  return sys.planets.reduce((m, p) => Math.max(m, p.orbit.semiMajorAxis * (1 + p.orbit.eccentricity)), AU) * 1.12;
}

describe('beltRing — the dashed annulus on the system chart', () => {
  it('Given Fyss’s belt, Then inner < outer, both inside the chart’s maximum, through the chart’s radial()', () => {
    const sys = startSystem();
    const belt = fyssBelt();
    const maxKm = chartMaxKm(sys);
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
    const maxKm = chartMaxKm(startSystem());
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
