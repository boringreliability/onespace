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

import { bus } from '@/core/EventBus';
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

describe('travelCost — mutation hardening', () => {
  it('Given a NaN distance, Then a jump costs the 4 % floor', () => {
    expect(jumpPropellantFraction(NaN)).toBe(0.04);
  });

  it('Given a NaN or negative cruise distance, Then cruiseLegKg is exactly 0', () => {
    expect(cruiseLegKg(NaN, CAP)).toBe(0);
    expect(cruiseLegKg(-AU, CAP)).toBe(0);
  });

  it('Given a jump of 3.8 ly (5.52 %), Then the chart row rounds to 6 %, not floors to 5 %', () => {
    expect(jumpPropellantRow(tank(1), 3.8).text).toBe('PROPELLANT 6 %');
  });

  // R17: every travel price is a fixed fraction of BASE capacity, whatever capacity has been lost.
  describe('R17 — prices are fractions of the BASE capacity', () => {
    function shrunk(massKg: number): Propellant {
      const p = new Propellant(CAP, 1);
      p.capacityLossFrac = 0.5;
      p.consume(p.massKg - massKg);
      return p;
    }

    it('Given 50 % capacity lost, When the cruise drive is spooled, Then it costs 0.5 % of BASE capacity (100 kg)', () => {
      const p = shrunk(10_000);
      expect(applyAction(p, { kind: 'cruise-spool' }).kg).toBeCloseTo(0.005 * CAP, 6);
    });

    it('Given 50 % capacity lost, When a 5 ly jump is paid, Then it costs 6 % of BASE capacity (1 200 kg)', () => {
      const p = shrunk(10_000);
      expect(applyAction(p, { kind: 'jump', distanceLy: 5 }).kg).toBeCloseTo(0.06 * CAP, 6);
    });

    it('Given 50 % capacity lost, When one AU of cruise is paid, Then it costs 1 % of BASE capacity (200 kg)', () => {
      const p = shrunk(10_000);
      expect(applyAction(p, { kind: 'cruise-leg', distanceKm: AU }).kg).toBeCloseTo(0.01 * CAP, 6);
    });

    it('Given 50 % capacity lost and 1 000 kg left, Then a 5 ly jump (1 200 kg) is refused and the row warns', () => {
      const p = shrunk(1_000);
      expect(applyAction(p, { kind: 'jump', distanceLy: 5 }).ok).toBe(false);
      const row = jumpPropellantRow(p, 5);
      expect(row.affordable).toBe(false);
      expect(row.tone).toBe('warn');
    });

    it('Given 50 % capacity lost and 1 300 kg left, Then a 5 ly jump is affordable and the row is normal', () => {
      const p = shrunk(1_300);
      const row = jumpPropellantRow(p, 5);
      expect(row.affordable).toBe(true);
      expect(row.tone).toBe('normal');
    });
  });
});

// ---------------------------------------------------------------------------
// Final whole-branch review, I3 — one tank unit on screen.
// The price stays in BASE kg (R17); the chart shows it as a share of the
// CURRENT tank, the same unit as the HUD's tank %.
// ---------------------------------------------------------------------------

describe('final review I3 — the chart shows the jump price as a share of the current tank', () => {
  function shrunk(massKg: number): Propellant {
    const p = new Propellant(CAP, 1);
    p.capacityLossFrac = 0.5;
    p.consume(p.massKg - massKg);
    return p;
  }

  it('Given 50 % capacity lost, When a 5 ly jump is shown, Then the row reads PROPELLANT 12 % (1 200 kg of a 10 000 kg tank), not 6 %', () => {
    expect(jumpPropellantRow(shrunk(10_000), 5).text).toBe('PROPELLANT 12 %');
  });

  it('Given 50 % capacity lost, When the jump is paid, Then the kg charged is still 6 % of BASE capacity (R17 unchanged)', () => {
    const p = shrunk(10_000);
    expect(applyAction(p, { kind: 'jump', distanceLy: 5 }).kg).toBeCloseTo(0.06 * CAP, 6);
  });

  it('Given 50 % capacity lost and 1 000 kg left, Then the 12 % row is still judged by the 1 200 kg price: unaffordable, warning', () => {
    const row = jumpPropellantRow(shrunk(1_000), 5);
    expect(row.text).toBe('PROPELLANT 12 %');
    expect(row.affordable).toBe(false);
    expect(row.tone).toBe('warn');
  });

  it('Given 20 % capacity lost, When a 3.8 ly jump (1 104 kg) is shown, Then the current-tank share 1 104 / 16 000 = 6.9 % rounds to 7 %', () => {
    const p = new Propellant(CAP, 1);
    p.capacityLossFrac = 0.2;
    expect(jumpPropellantRow(p, 3.8).text).toBe('PROPELLANT 7 %');
  });

  it('Given no capacity lost, Then the row is unchanged: 5 ly reads PROPELLANT 6 %', () => {
    expect(jumpPropellantRow(tank(1), 5).text).toBe('PROPELLANT 6 %');
  });
});

// ---------------------------------------------------------------------------
// Final whole-branch review, I4 — every tank change is a named action (P3),
// and applyAction is the one voice that announces it: `propellant:action`.
// ---------------------------------------------------------------------------

describe('final review I4 — named actions and the propellant:action event', () => {
  type Seen = { action: PropellantAction; ok: boolean; kg: number };
  const seen: Seen[] = [];
  let off: (() => void) | null = null;
  function listen(): void {
    seen.length = 0;
    off = bus.on('propellant:action' as never, ((e: Seen) => seen.push(e)) as never);
  }
  afterEach(() => {
    off?.();
    off = null;
  });

  it('The action type carries the refund kinds — jump-refund {kg} and spool-refund {kg}', () => {
    const kinds: PropellantAction[] = [
      { kind: 'jump-refund', kg: 1 } as PropellantAction,
      { kind: 'spool-refund', kg: 1 } as PropellantAction,
    ];
    expect(kinds).toHaveLength(2);
  });

  it('Given a half tank, When a jump-refund of 1 200 kg is applied, Then it is ok, the tank holds 1 200 kg more, and kg reports what went back in', () => {
    const p = tank(0.5);
    const r = applyAction(p, { kind: 'jump-refund', kg: 1_200 } as PropellantAction);
    expect(r.ok).toBe(true);
    expect(r.kg).toBeCloseTo(1_200, 6);
    expect(p.massKg).toBeCloseTo(0.5 * CAP + 1_200, 6);
  });

  it('Given a half tank, When a spool-refund of 100 kg is applied, Then it is ok and the tank holds 100 kg more', () => {
    const p = tank(0.5);
    const r = applyAction(p, { kind: 'spool-refund', kg: 100 } as PropellantAction);
    expect(r.ok).toBe(true);
    expect(r.kg).toBeCloseTo(100, 6);
    expect(p.massKg).toBeCloseTo(0.5 * CAP + 100, 6);
  });

  it('Given 50 kg of free space, When a 1 200 kg refund is applied, Then the tank is clamped to capacity and kg reports only the 50 kg that fit', () => {
    const p = new Propellant(CAP, 1);
    p.consume(50);
    const r = applyAction(p, { kind: 'jump-refund', kg: 1_200 } as PropellantAction);
    expect(p.massKg).toBe(CAP);
    expect(r.kg).toBeCloseTo(50, 6);
  });

  it('Given a refund of NaN or a negative kg, Then nothing is added', () => {
    const p = tank(0.5);
    applyAction(p, { kind: 'spool-refund', kg: Number.NaN } as PropellantAction);
    applyAction(p, { kind: 'jump-refund', kg: -500 } as PropellantAction);
    expect(p.massKg).toBeCloseTo(0.5 * CAP, 9);
  });

  it('Given an applied action, Then applyAction emits exactly one propellant:action carrying { action, ok, kg }', () => {
    listen();
    const a: PropellantAction = { kind: 'jump', distanceLy: 5 };
    const r = applyAction(tank(1), a);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.action).toEqual(a);
    expect(seen[0]!.ok).toBe(r.ok);
    expect(seen[0]!.kg).toBeCloseTo(r.kg, 9);
  });

  it('Given a refused action (5 % left, 6 % jump), Then propellant:action is still emitted once, with ok false and kg 0', () => {
    listen();
    applyAction(tank(0.05), { kind: 'jump', distanceLy: 5 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ok).toBe(false);
    expect(seen[0]!.kg).toBe(0);
  });

  it('Given each kind (spool, leg, jump, both refunds, cannibalize, beacon), Then each emits one propellant:action named for it', () => {
    listen();
    applyAction(tank(1), { kind: 'cruise-spool' });
    applyAction(tank(1), { kind: 'cruise-leg', distanceKm: AU });
    applyAction(tank(1), { kind: 'jump', distanceLy: 1 });
    applyAction(tank(0.5), { kind: 'jump-refund', kg: 10 } as PropellantAction);
    applyAction(tank(0.5), { kind: 'spool-refund', kg: 10 } as PropellantAction);
    applyAction(tank(0), { kind: 'cannibalize', part: 'tank' });
    applyAction(tank(0), { kind: 'beacon' });
    expect(seen.map((e) => e.action.kind)).toEqual([
      'cruise-spool',
      'cruise-leg',
      'jump',
      'jump-refund',
      'spool-refund',
      'cannibalize',
      'beacon',
    ]);
  });
});
