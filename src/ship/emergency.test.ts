/**
 * v4 sub-plan 1 (propellant), Task 6 — the emergency exit costs something.
 *
 * Pure rules (`ship/emergency.ts`):
 * - cannibalize: +3 % of BASE capacity as propellant, for a permanent loss of
 *   0.08 · 1.5^timesUsed of BASE capacity (8 % → 12 % → 18 % …). Refused
 *   (null) when the remaining capacity cannot carry the loss.
 * - beacon: the tank is set to 5 % of the CURRENT capacity.
 * - `applyAction` routes 'cannibalize' / 'beacon' through the same rules;
 *   cargo cannibalization is reserved for sub-plan 2 and refused.
 */

import { describe, expect, it } from 'vitest';

import { PROBE_TANK_CAPACITY_KG, Propellant } from './propellant';
import { applyAction } from './travelCost';
import {
  BEACON_FILL_FRAC,
  CANNIBALIZE_GAIN_FRAC,
  applyBeacon,
  applyCannibalize,
  cannibalizeLossFrac,
  cannibalizeYield,
} from './emergency';

const BASE = PROBE_TANK_CAPACITY_KG;

function emptyTank(lossFrac = 0): Propellant {
  const p = new Propellant(BASE, 0);
  p.capacityLossFrac = lossFrac;
  return p;
}

describe('the price list is the brief, verbatim', () => {
  it('gain is 3 % of base capacity; beacon fill is 5 %', () => {
    expect(CANNIBALIZE_GAIN_FRAC).toBe(0.03);
    expect(BEACON_FILL_FRAC).toBe(0.05);
  });

  it('When used 0, 1, 2, 3 times, Then the loss is 8 %, 12 %, 18 %, 27 % of base capacity', () => {
    expect(cannibalizeLossFrac(0)).toBeCloseTo(0.08, 12);
    expect(cannibalizeLossFrac(1)).toBeCloseTo(0.12, 12);
    expect(cannibalizeLossFrac(2)).toBeCloseTo(0.18, 12);
    expect(cannibalizeLossFrac(3)).toBeCloseTo(0.27, 12);
  });

  it('Given a nonsense use count (NaN, negative, ±Infinity), Then it counts as 0 (the first, cheapest loss)', () => {
    for (const n of [Number.NaN, -1, -Infinity, Infinity]) {
      expect(cannibalizeLossFrac(n)).toBeCloseTo(0.08, 12);
    }
  });
});

describe('cannibalizeYield', () => {
  it('Given an intact empty tank, Then it yields 3 % of base capacity for an 8 % loss', () => {
    const y = cannibalizeYield(emptyTank(), 0);
    expect(y).not.toBeNull();
    expect(y!.gainKg).toBeCloseTo(0.03 * BASE, 9);
    expect(y!.lossFrac).toBeCloseTo(0.08, 12);
  });

  it('Given a tank already cut down, Then the gain is still 3 % of BASE capacity, not of what is left', () => {
    const y = cannibalizeYield(emptyTank(0.5), 1);
    expect(y!.gainKg).toBeCloseTo(0.03 * BASE, 9);
    expect(y!.lossFrac).toBeCloseTo(0.12, 12);
  });

  it('is pure: it changes nothing on the tank', () => {
    const p = emptyTank(0.2);
    cannibalizeYield(p, 0);
    expect(p.massKg).toBe(0);
    expect(p.capacityLossFrac).toBeCloseTo(0.2, 12);
  });

  it('Given remaining capacity smaller than the loss, Then it is refused (null)', () => {
    // 5 % left, an 8 % loss.
    expect(cannibalizeYield(emptyTank(0.95), 0)).toBeNull();
    // 20 % left, an 18 % loss is fine; a 27 % loss is not.
    expect(cannibalizeYield(emptyTank(0.8), 2)).not.toBeNull();
    expect(cannibalizeYield(emptyTank(0.8), 3)).toBeNull();
  });

  it('Given remaining capacity exactly equal to the loss, Then it is refused (a zero tank cannot hold the gain)', () => {
    expect(cannibalizeYield(emptyTank(0.92), 0)).toBeNull();
  });

  it('Given a tank with no capacity left, Then it is refused', () => {
    expect(cannibalizeYield(emptyTank(1), 0)).toBeNull();
  });
});

describe('applyCannibalize', () => {
  it('Given an empty tank, When cannibalized, Then propellant rises by 3 % of base and capacityLossFrac by 8 %', () => {
    const p = emptyTank();
    const r = applyCannibalize(p, 0);
    expect(r.ok).toBe(true);
    expect(p.capacityLossFrac).toBeCloseTo(0.08, 12);
    expect(p.massKg).toBeCloseTo(0.03 * BASE, 9);
  });

  it('When used a second time, Then the loss is 12 % (8 % + 12 % = 20 % total)', () => {
    const p = emptyTank();
    applyCannibalize(p, 0);
    p.consume(p.massKg);
    applyCannibalize(p, 1);
    expect(p.capacityLossFrac).toBeCloseTo(0.2, 12);
    expect(p.massKg).toBeCloseTo(0.03 * BASE, 9);
  });

  it('Given repeated use, Then the losses compound 8 % → 12 % → 18 % and capacity never goes below zero', () => {
    const p = emptyTank();
    const seen: number[] = [];
    for (let n = 0; n < 20; n++) {
      const before = p.capacityLossFrac;
      const r = applyCannibalize(p, n);
      if (!r.ok) break;
      seen.push(p.capacityLossFrac - before);
      p.consume(p.massKg);
      expect(p.capacityKg).toBeGreaterThan(0);
    }
    expect(seen[0]).toBeCloseTo(0.08, 12);
    expect(seen[1]).toBeCloseTo(0.12, 12);
    expect(seen[2]).toBeCloseTo(0.18, 12);
    // 0.08 + 0.12 + 0.18 + 0.27 = 0.65; the next (0.405) cannot be carried by 0.35.
    expect(seen).toHaveLength(4);
    expect(p.capacityLossFrac).toBeCloseTo(0.65, 12);
    expect(p.capacityKg).toBeGreaterThan(0);
  });

  it('Given capacity too low to pay the loss, Then it is refused and the tank is untouched', () => {
    const p = emptyTank(0.95);
    const r = applyCannibalize(p, 0);
    expect(r.ok).toBe(false);
    expect(p.massKg).toBe(0);
    expect(p.capacityLossFrac).toBeCloseTo(0.95, 12);
  });
});

describe('applyBeacon', () => {
  it('When the beacon is used, Then the tank is set to 5 % of CURRENT capacity', () => {
    const p = emptyTank(0.2);
    applyBeacon(p);
    expect(p.massKg).toBeCloseTo(0.05 * p.capacityKg, 9);
    expect(p.massKg).toBeCloseTo(0.05 * 0.8 * BASE, 9);
    expect(p.capacityLossFrac).toBeCloseTo(0.2, 12);
  });

  it('Given a tank with a little left, Then it is SET to 5 %, not topped up by 5 %', () => {
    const p = emptyTank();
    p.add(10);
    applyBeacon(p);
    expect(p.massKg).toBeCloseTo(0.05 * BASE, 9);
  });
});

describe('applyAction routes the emergency kinds through the same rules', () => {
  it("cannibalize 'tank' via applyAction equals applyCannibalize (first use)", () => {
    const a = emptyTank();
    const b = emptyTank();
    const r = applyAction(a, { kind: 'cannibalize', part: 'tank' });
    applyCannibalize(b, 0);
    expect(r.ok).toBe(true);
    expect(a.massKg).toBeCloseTo(b.massKg, 9);
    expect(a.capacityLossFrac).toBeCloseTo(b.capacityLossFrac, 12);
  });

  it("cannibalize 'cargo' is reserved for sub-plan 2: refused, tank untouched", () => {
    const p = emptyTank();
    const r = applyAction(p, { kind: 'cannibalize', part: 'cargo' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('cargo-reserved');
    expect(p.massKg).toBe(0);
    expect(p.capacityLossFrac).toBe(0);
  });

  it('beacon via applyAction sets the tank to 5 % of current capacity and takes nothing', () => {
    const p = emptyTank(0.1);
    const r = applyAction(p, { kind: 'beacon' });
    expect(r.ok).toBe(true);
    expect(r.kg).toBe(0);
    expect(p.massKg).toBeCloseTo(0.05 * p.capacityKg, 9);
  });

  it("cannibalize 'tank' via applyAction is refused when the capacity cannot carry the loss", () => {
    const p = emptyTank(0.95);
    const r = applyAction(p, { kind: 'cannibalize', part: 'tank' });
    expect(r.ok).toBe(false);
    expect(p.massKg).toBe(0);
  });
});
