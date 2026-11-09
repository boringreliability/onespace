/**
 * v4 sub-plan 2, Task 2 — the hold and its named resource actions.
 *
 * Pure: Cargo is changed only through applyCargoAction, which announces
 * `cargo:action` exactly once per call, refusals included.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '@/core/EventBus';
import { Rng } from '@/math/rng';
import {
  CANNIBALIZE_CARGO_MIN_KG,
  CARGO_CAPACITY_KG,
  REFINE_ICE_TO_FUEL,
  REPAIR_METAL_KG,
  REPAIR_RESTORE_FRAC,
  REPAIR_SILICATE_KG,
  Cargo,
  applyCargoAction,
  type CargoAction,
  type CargoResult,
  type Resource,
} from './cargo';
import { Propellant } from './propellant';

type Seen = { action: CargoAction; result: CargoResult };
let seen: Seen[] = [];
let off: () => void;

beforeEach(() => {
  seen = [];
  off = bus.on('cargo:action', (e: Seen) => seen.push(e));
});
afterEach(() => off());

const mine = (cargo: Cargo, resource: Resource, kg: number) =>
  applyCargoAction(cargo, null, { kind: 'mine', asteroidId: 'a1', resource, kg });

/** A hold with the given contents, filled through the named action. */
function hold(contents: Partial<Record<Resource, number>>, cap = CARGO_CAPACITY_KG): Cargo {
  const c = new Cargo(cap);
  for (const [r, kg] of Object.entries(contents)) mine(c, r as Resource, kg);
  seen = [];
  return c;
}

describe('constants', () => {
  it('Given the plan, Then the values are as specified', () => {
    expect(CARGO_CAPACITY_KG).toBe(8_000);
    expect(REFINE_ICE_TO_FUEL).toBe(0.8);
    expect(REPAIR_METAL_KG).toBe(600);
    expect(REPAIR_SILICATE_KG).toBe(400);
    expect(REPAIR_RESTORE_FRAC).toBe(0.04);
    expect(CANNIBALIZE_CARGO_MIN_KG).toBe(1_000);
  });
});

describe('Cargo', () => {
  it('Given a new hold, Then it is empty and all of it is free', () => {
    const c = new Cargo(8_000);
    expect(c.capacityKg).toBe(8_000);
    expect(c.totalKg).toBe(0);
    expect(c.freeKg).toBe(8_000);
    expect(c.kg('ice')).toBe(0);
  });
});

describe('mine', () => {
  it('Given room, When mining 3 000 kg of ice, Then it is added', () => {
    const c = new Cargo(8_000);
    const r = mine(c, 'ice', 3_000);
    expect(r.ok).toBe(true);
    expect(r.kgIn).toBe(3_000);
    expect(c.kg('ice')).toBe(3_000);
  });

  it('Given 2 000 kg free, When mining 5 000 kg, Then only min(kg, freeKg) is added', () => {
    const c = hold({ metal: 6_000 });
    const r = mine(c, 'ice', 5_000);
    expect(r.ok).toBe(true);
    expect(r.kgIn).toBe(2_000);
    expect(c.kg('ice')).toBe(2_000);
    expect(c.freeKg).toBe(0);
  });

  it('Given a full hold, When mining, Then hold-full and the cargo is unchanged', () => {
    const c = hold({ metal: 8_000 });
    const r = mine(c, 'ice', 100);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('hold-full');
    expect(c.totalKg).toBe(8_000);
    expect(c.kg('ice')).toBe(0);
  });

  it.each([NaN, -5, -Infinity])('Given kg = %s, When mining, Then refused and unchanged', (kg) => {
    const c = hold({ ice: 100 });
    const r = mine(c, 'metal', kg);
    expect(r.ok).toBe(false);
    expect(c.totalKg).toBe(100);
    expect(c.kg('metal')).toBe(0);
  });
});

describe('refine', () => {
  it('Given 5 000 kg ice and an empty 20 t tank, Then 4 000 kg fuel and the ice is gone', () => {
    const c = hold({ ice: 5_000 });
    const t = new Propellant(20_000, 0);
    const r = applyCargoAction(c, t, { kind: 'refine' });
    expect(r.ok).toBe(true);
    expect(r.fuelKg).toBeCloseTo(4_000, 6);
    expect(r.kgOut).toBeCloseTo(5_000, 6);
    expect(t.massKg).toBeCloseTo(4_000, 6);
    expect(c.kg('ice')).toBe(0);
  });

  it('Given a tank with 1 000 kg free, Then 1 250 kg ice is used, the rest stays, and the totals balance', () => {
    const c = hold({ ice: 3_000 });
    const t = new Propellant(20_000, 0.95);
    const r = applyCargoAction(c, t, { kind: 'refine' });
    expect(r.ok).toBe(true);
    expect(r.fuelKg).toBeCloseTo(1_000, 6);
    expect(c.kg('ice')).toBeCloseTo(1_750, 6);
    expect(t.massKg).toBeCloseTo(20_000, 6);
    expect(r.fuelKg).toBeCloseTo((3_000 - c.kg('ice')) * REFINE_ICE_TO_FUEL, 6);
  });

  it('Given no ice, Then nothing-to-refine', () => {
    const c = hold({ metal: 500 });
    const r = applyCargoAction(c, new Propellant(20_000, 0), { kind: 'refine' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('nothing-to-refine');
  });

  it('Given a full tank, Then tank-full and the ice is kept', () => {
    const c = hold({ ice: 1_000 });
    const r = applyCargoAction(c, new Propellant(20_000, 1), { kind: 'refine' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tank-full');
    expect(c.kg('ice')).toBe(1_000);
  });

  it('Given no tank, Then refused and the ice is kept', () => {
    const c = hold({ ice: 1_000 });
    const r = applyCargoAction(c, null, { kind: 'refine' });
    expect(r.ok).toBe(false);
    expect(c.kg('ice')).toBe(1_000);
  });
});

describe('repair', () => {
  it('Given loss 0.12 and 600/400 kg, Then loss is 0.08 and the materials are removed', () => {
    const c = hold({ metal: 600, silicate: 400 });
    const t = new Propellant(20_000, 0.5);
    t.capacityLossFrac = 0.12;
    const r = applyCargoAction(c, t, { kind: 'repair' });
    expect(r.ok).toBe(true);
    expect(r.restoredFrac).toBeCloseTo(0.04, 9);
    expect(t.capacityLossFrac).toBeCloseTo(0.08, 9);
    expect(c.kg('metal')).toBe(0);
    expect(c.kg('silicate')).toBe(0);
  });

  it('Given loss 0.02, Then it becomes 0, never negative', () => {
    const c = hold({ metal: 600, silicate: 400 });
    const t = new Propellant(20_000, 0.5);
    t.capacityLossFrac = 0.02;
    const r = applyCargoAction(c, t, { kind: 'repair' });
    expect(r.ok).toBe(true);
    expect(r.restoredFrac).toBeCloseTo(0.02, 9);
    expect(t.capacityLossFrac).toBe(0);
  });

  it('Given too little material, Then insufficient and nothing changes', () => {
    const c = hold({ metal: 599, silicate: 400 });
    const t = new Propellant(20_000, 0.5);
    t.capacityLossFrac = 0.12;
    const r = applyCargoAction(c, t, { kind: 'repair' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('insufficient');
    expect(t.capacityLossFrac).toBeCloseTo(0.12, 9);
    expect(c.kg('metal')).toBe(599);
  });

  it('Given loss 0, Then nothing-to-repair and nothing is spent', () => {
    const c = hold({ metal: 600, silicate: 400 });
    const r = applyCargoAction(c, new Propellant(20_000, 0.5), { kind: 'repair' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('nothing-to-repair');
    expect(c.kg('metal')).toBe(600);
    expect(c.kg('silicate')).toBe(400);
  });
});

describe('jettison-all', () => {
  it('Given a loaded hold, Then it empties and kgOut is the total', () => {
    const c = hold({ ice: 1_000, metal: 2_000, rare: 50 });
    const r = applyCargoAction(c, null, { kind: 'jettison-all' });
    expect(r.ok).toBe(true);
    expect(r.kgOut).toBe(3_050);
    expect(c.totalKg).toBe(0);
  });

  it('Given an empty hold, Then empty', () => {
    const r = applyCargoAction(new Cargo(8_000), null, { kind: 'jettison-all' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty');
  });
});

describe('cannibalize-cargo', () => {
  it('Given under 1 000 kg, Then refused and nothing changes', () => {
    const c = hold({ metal: 999 });
    const t = new Propellant(20_000, 0.1);
    const r = applyCargoAction(c, t, { kind: 'cannibalize-cargo' });
    expect(r.ok).toBe(false);
    expect(c.totalKg).toBe(999);
    expect(t.massKg).toBeCloseTo(2_000, 6);
  });

  it('Given 1 000 kg or more, Then the hold empties and the tank rises by 3 % of base, with no capacity loss', () => {
    const c = hold({ metal: 1_500, ice: 500 });
    const t = new Propellant(20_000, 0.1);
    const r = applyCargoAction(c, t, { kind: 'cannibalize-cargo' });
    expect(r.ok).toBe(true);
    expect(r.kgOut).toBe(2_000);
    expect(r.fuelKg).toBeCloseTo(600, 6);
    expect(c.totalKg).toBe(0);
    expect(t.massKg).toBeCloseTo(2_600, 6);
    expect(t.capacityLossFrac).toBe(0);
  });
});

describe('cargo:action event', () => {
  const cases: [string, () => void][] = [
    ['mine ok', () => void mine(new Cargo(8_000), 'ice', 100)],
    ['mine refused', () => void mine(new Cargo(8_000), 'ice', NaN)],
    ['refine refused', () => void applyCargoAction(new Cargo(8_000), null, { kind: 'refine' })],
    [
      'repair refused',
      () => void applyCargoAction(new Cargo(8_000), new Propellant(20_000, 1), { kind: 'repair' }),
    ],
    ['jettison refused', () => void applyCargoAction(new Cargo(8_000), null, { kind: 'jettison-all' })],
    [
      'cannibalize refused',
      () =>
        void applyCargoAction(new Cargo(8_000), new Propellant(20_000, 0), {
          kind: 'cannibalize-cargo',
        }),
    ],
  ];
  it.each(cases)('Given %s, Then exactly one event is emitted', (_n, run) => {
    run();
    expect(seen).toHaveLength(1);
  });

  it('Given a refusal, Then the event carries the action and the result', () => {
    const r = mine(hold({ metal: 8_000 }), 'ice', 1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.action).toEqual({ kind: 'mine', asteroidId: 'a1', resource: 'ice', kg: 1 });
    expect(seen[0]!.result).toEqual(r);
    expect(seen[0]!.result.reason).toBe('hold-full');
  });
});

describe('invariant — totalKg + freeKg = capacityKg', () => {
  it('Given a seeded random sequence of actions, Then it holds after every step', () => {
    const rng = new Rng(20260809);
    const res: Resource[] = ['ice', 'metal', 'silicate', 'rare'];
    const c = new Cargo(CARGO_CAPACITY_KG);
    const t = new Propellant(20_000, 0.3);
    t.capacityLossFrac = 0.2;
    for (let i = 0; i < 500; i++) {
      const p = rng.next();
      let a: CargoAction;
      if (p < 0.5) {
        a = { kind: 'mine', asteroidId: 'x', resource: rng.pick(res), kg: rng.next() * 3_000 };
      } else if (p < 0.65) a = { kind: 'refine' };
      else if (p < 0.8) a = { kind: 'repair' };
      else if (p < 0.9) a = { kind: 'cannibalize-cargo' };
      else a = { kind: 'jettison-all' };
      applyCargoAction(c, t, a);
      expect(c.totalKg + c.freeKg).toBeCloseTo(c.capacityKg, 6);
      expect(c.freeKg).toBeGreaterThanOrEqual(0);
      expect(c.totalKg).toBeGreaterThanOrEqual(0);
    }
  });
});
