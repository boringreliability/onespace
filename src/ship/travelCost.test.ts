/**
 * v4 sub-plan 1 (propellant), Task 4 — what cruise and jumps cost.
 *
 * Pure: the price list (`jumpPropellantFraction`, `cruiseSpoolKg`,
 * `cruiseLegKg`), the till (`canAfford`, `applyAction`) and the chart's
 * JUMP-row seam (`jumpPropellantRow`), which StarMap's DOM row will call —
 * StarMap and MapMode build DOM and do not run in node, so the row's text and
 * tone, and the refusal they act on, are tested here.
 *
 * Plus the budget moved here by controller ruling R2: on one full tank the
 * probe can land three times on each side of a jump to the nearest neighbour
 * and jump back (3·2L + 2·jump ≤ 1), with L the auto-land use MEASURED by
 * Task 3's landing simulation.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { Rng, hashSeed } from '@/math/rng';
import { generateGalaxy, sampleSystemsNear, type StarSystemStub } from '@/gen/galaxy';
import { AU, type Vec3 } from '@/gen/types';
import { DEFAULT_UNIVERSE_SEED } from '@/game/Universe';
import type { FlightModel } from './FlightModel';
import { EXHAUST_VELOCITY_KMS, PROBE_TANK_CAPACITY_KG, Propellant } from './propellant';
import { REMIT, flyLeg, releaseLegListeners } from './testing/landingSim';
import {
  applyAction,
  canAfford,
  cruiseLegKg,
  cruiseSpoolKg,
  jumpPropellantFraction,
  jumpPropellantRow,
  type PropellantAction,
} from './travelCost';

afterEach(releaseLegListeners);

const CAP = PROBE_TANK_CAPACITY_KG;

/** A probe tank holding `fraction` of its capacity. */
function tank(fraction: number): Propellant {
  return new Propellant(CAP, fraction);
}

describe('jumpPropellantFraction — 0.04 + 0.004·ly, clamped to [0.04, 0.3] (D2)', () => {
  it('Given a 5 ly jump, Then it costs 6 % of the tank', () => {
    expect(jumpPropellantFraction(5)).toBeCloseTo(0.06, 12);
  });

  it('Given a 0 ly jump, Then it still costs the 4 % floor', () => {
    expect(jumpPropellantFraction(0)).toBeCloseTo(0.04, 12);
  });

  it('Given a 10 ly jump, Then it is linear: 8 %', () => {
    expect(jumpPropellantFraction(10)).toBeCloseTo(0.08, 12);
  });

  it('Given an 80 ly jump, Then it is clamped to 30 %', () => {
    expect(jumpPropellantFraction(80)).toBe(0.3);
  });

  it('Given a negative distance, Then it is clamped to the 4 % floor', () => {
    expect(jumpPropellantFraction(-10)).toBeCloseTo(0.04, 12);
  });
});

describe('cruise prices', () => {
  it('Given the probe tank, Then spooling the drive costs 0.5 % of capacity (100 kg)', () => {
    expect(cruiseSpoolKg(CAP)).toBeCloseTo(100, 9);
  });

  it('Given the probe tank, Then 1 AU of cruise costs 1 % of capacity (200 kg)', () => {
    expect(cruiseLegKg(AU, CAP)).toBeCloseTo(200, 9);
  });

  it('Given half an AU, Then it costs half as much — linear in distance', () => {
    expect(cruiseLegKg(AU / 2, CAP)).toBeCloseTo(100, 9);
    expect(cruiseLegKg(0, CAP)).toBe(0);
  });

  it('Given a different capacity, Then both prices scale with it', () => {
    expect(cruiseSpoolKg(1_000)).toBeCloseTo(5, 9);
    expect(cruiseLegKg(AU, 1_000)).toBeCloseTo(10, 9);
  });
});

describe('canAfford', () => {
  it('Given 1 000 kg in the tank, Then 1 000 kg is affordable and 1 000.1 kg is not', () => {
    const p = tank(0.05); // 1 000 kg
    expect(canAfford(p, 1_000)).toBe(true);
    expect(canAfford(p, 1_000.1)).toBe(false);
  });

  it('Given an empty tank, Then any positive cost is unaffordable', () => {
    expect(canAfford(tank(0), 1)).toBe(false);
  });
});

describe('applyAction — all-or-nothing for spool and jump; cruise-leg takes what is there', () => {
  it('Given 5 % left, When a 6 % jump (5 ly) is applied, Then ok is false, reason is insufficient, and the tank is unchanged', () => {
    const p = tank(0.05);
    const before = p.massKg;
    const r = applyAction(p, { kind: 'jump', distanceLy: 5 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('insufficient');
    expect(p.massKg).toBe(before);
  });

  it('Given a full tank, When a 5 ly jump is applied, Then ok, it reports 6 % of capacity in kg, and the tank holds that much less', () => {
    const p = tank(1);
    const r = applyAction(p, { kind: 'jump', distanceLy: 5 });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.kg).toBeCloseTo(0.06 * CAP, 6);
    expect(p.massKg).toBeCloseTo(0.94 * CAP, 6);
  });

  it('Given a full tank, When the drive is spooled, Then ok and 100 kg are taken', () => {
    const p = tank(1);
    const r = applyAction(p, { kind: 'cruise-spool' });
    expect(r.ok).toBe(true);
    expect(r.kg).toBeCloseTo(100, 9);
    expect(p.massKg).toBeCloseTo(CAP - 100, 9);
  });

  it('Given less than the spool price, When the drive is spooled, Then ok is false, reason is insufficient, and nothing is taken', () => {
    const p = new Propellant(CAP, 0);
    p.add(99);
    const r = applyAction(p, { kind: 'cruise-spool' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('insufficient');
    expect(p.massKg).toBe(99);
  });

  it('Given an empty tank, When the drive is spooled, Then ok is false and the tank stays empty', () => {
    const p = tank(0);
    const r = applyAction(p, { kind: 'cruise-spool' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBeDefined();
    expect(p.massKg).toBe(0);
  });

  it('Given enough propellant, When a cruise leg of 0.5 AU is applied, Then ok and 100 kg are taken', () => {
    const p = tank(1);
    const r = applyAction(p, { kind: 'cruise-leg', distanceKm: AU / 2 });
    expect(r.ok).toBe(true);
    expect(r.kg).toBeCloseTo(100, 9);
    expect(p.massKg).toBeCloseTo(CAP - 100, 9);
  });

  it('Given 50 kg left, When a 1 AU cruise leg (200 kg) is applied, Then it takes the 50 kg there is, the tank is empty, and ok is false with reason nothing-left', () => {
    const p = new Propellant(CAP, 0);
    p.add(50);
    const r = applyAction(p, { kind: 'cruise-leg', distanceKm: AU });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('nothing-left');
    expect(r.kg).toBeCloseTo(50, 9);
    expect(p.empty).toBe(true);
  });

  it('Given a 0 km cruise leg, Then it is free and ok', () => {
    const p = tank(0.5);
    const before = p.massKg;
    const r = applyAction(p, { kind: 'cruise-leg', distanceKm: 0 });
    expect(r.ok).toBe(true);
    expect(r.kg).toBe(0);
    expect(p.massKg).toBe(before);
  });

  it('The action type carries the Task 6 kinds (cannibalize, beacon) — a compile-time contract', () => {
    const kinds: PropellantAction[] = [
      { kind: 'cruise-spool' },
      { kind: 'cruise-leg', distanceKm: 1 },
      { kind: 'jump', distanceLy: 1 },
      { kind: 'cannibalize', part: 'tank' },
      { kind: 'cannibalize', part: 'cargo' },
      { kind: 'beacon' },
    ];
    expect(kinds).toHaveLength(6);
  });
});

describe('the chart JUMP row seam — jumpPropellantRow (StarMap calls it beside jumpEstimateSeconds)', () => {
  it('Given the chart open on a system 5 ly away with 5 % left, Then the row reads PROPELLANT 6 % in the warning tone, and the jump it would command is refused', () => {
    const p = tank(0.05);
    const row = jumpPropellantRow(p, 5);
    expect(row.text).toBe('PROPELLANT 6 %');
    expect(row.tone).toBe('warn');
    expect(row.affordable).toBe(false);
    // MapMode pays (or refuses) through the same till before warp.engage.
    const before = p.massKg;
    expect(applyAction(p, { kind: 'jump', distanceLy: 5 }).ok).toBe(false);
    expect(p.massKg).toBe(before);
  });

  it('Given a full tank and the same 5 ly system, Then the row reads PROPELLANT 6 % in the normal tone', () => {
    const row = jumpPropellantRow(tank(1), 5);
    expect(row.text).toBe('PROPELLANT 6 %');
    expect(row.tone).toBe('normal');
    expect(row.affordable).toBe(true);
  });

  it('Given an 80 ly system, Then the row shows the 30 % cap', () => {
    expect(jumpPropellantRow(tank(1), 80).text).toBe('PROPELLANT 30 %');
  });
});

// ---------------------------------------------------------------------------
// The budget (R2)
// ---------------------------------------------------------------------------

function distLy(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Nearest other system to `stub`, ly. */
function nearestNeighbourLy(galaxy: ReturnType<typeof generateGalaxy>, stub: StarSystemStub): number {
  const near = sampleSystemsNear(galaxy, stub.position, 120, 4).filter((s) => s.id !== stub.id);
  return near.length ? distLy(near[0]!.position, stub.position) : Number.POSITIVE_INFINITY;
}

/**
 * The start system's nearest neighbour, bounded from above. `Universe.pickStartSystem`
 * (private) chooses the best-scoring of the first 24 systems sampled about a
 * probe at 0.34 of the disc radius (or, failing all, the first). This
 * reproduces only the probe and the candidate list — not the scoring — and
 * takes the WORST nearest-neighbour distance among those candidates, so the
 * start system, whichever it is, can do no worse.
 * (Measured at DEFAULT_UNIVERSE_SEED in Task 4 phase A: start Fyss, 7.68 ly;
 * worst candidate 15.30 ly.)
 */
function startNeighbourLyBound(seed: number): number {
  const galaxy = generateGalaxy(seed);
  const rng = new Rng(hashSeed(seed, 'start'));
  const r = galaxy.radiusLy * 0.34;
  const theta = rng.range(0, Math.PI * 2);
  const probe: Vec3 = [r * Math.cos(theta), rng.gaussian(0, 30), r * Math.sin(theta)];
  const candidates = sampleSystemsNear(galaxy, probe, 260, 96).slice(0, 24);
  expect(candidates.length).toBeGreaterThan(0);
  let worst = 0;
  for (const c of candidates) worst = Math.max(worst, nearestNeighbourLy(galaxy, c));
  return worst;
}

describe('the one-tank budget (R2)', () => {
  it('Given the measured auto-land use L (Task 3 landingSim, full tank, Remit), Then 3·2L + 2·jumpPropellantFraction(neighbourLy) ≤ 1', () => {
    let hull: FlightModel | null = null;
    const leg = flyLeg(REMIT, true, (fm) => {
      fm.attachPropellant(new Propellant(CAP, 1.0), EXHAUST_VELOCITY_KMS);
      hull = fm;
    });
    expect(leg.result).toBe('landed');
    const L = (CAP - hull!.propellant!.massKg) / CAP;
    const neighbourLy = startNeighbourLyBound(DEFAULT_UNIVERSE_SEED);
    const budget = 3 * 2 * L + 2 * jumpPropellantFraction(neighbourLy);
    console.info(
      `[fuel budget] L ${(L * 100).toFixed(2)} % · neighbour ≤ ${neighbourLy.toFixed(2)} ly · ` +
        `jump ${(jumpPropellantFraction(neighbourLy) * 100).toFixed(2)} % · budget ${budget.toFixed(3)}`,
    );
    expect(L).toBeGreaterThan(0);
    expect(Number.isFinite(neighbourLy)).toBe(true);
    expect(budget).toBeLessThanOrEqual(1);
  });
});
