/**
 * v4 sub-plan 3 (local save), Task 3 fix round 1 — ruling R8: the log can
 * recompute the ship.
 *
 * `replay(initial, actions)` is pure: from a start state and an action log it
 * recomputes the tank (mass, capacity loss), the hold per resource, the
 * depletion per asteroid and the emergency counts. A checkpoint carries the
 * NET EFFECT of everything it absorbed, so
 *     replay(initial, compact(log)) === replay(initial, log)
 * for any compaction. This file pins the rules entry by entry and the
 * checkpoint's net fields; capture.test.ts pins replay against a live game.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Resource } from '@/gen/belt';
import { REPAIR_METAL_KG, REPAIR_SILICATE_KG, type CargoAction, type CargoResult } from '@/ship/cargo';
import { cannibalizeLossFrac } from '@/ship/emergency';
import type { PropellantAction } from '@/ship/travelCost';
import { compactEntries } from './actionJournal';
import { replay, type ReplayState } from './replay';
import { ActionEntrySchema, type ActionEntry } from './schema';

const RESOURCES: readonly Resource[] = ['ice', 'metal', 'silicate', 'rare'];

function start(over: Partial<ReplayState> = {}): ReplayState {
  return {
    tank: { massKg: 12_000, capacityLossFrac: 0 },
    cargo: { ice: 0, metal: 0, silicate: 0, rare: 0 },
    depletion: {},
    emergency: { cannibalize: 0, cannibalizeCargo: 0, beacon: 0 },
    ...over,
  };
}

/** A log builder: seq and clocks rise with each entry. */
function logOf() {
  const entries: ActionEntry[] = [];
  let seq = 0;
  const at = () => ({ seq: ++seq, wallMs: 1_800_000_000_000 + seq * 1_000, orbitSeconds: seq * 10 });
  const res = (p: Partial<CargoResult>): CargoResult => ({ ok: true, kgIn: 0, kgOut: 0, fuelKg: 0, restoredFrac: 0, ...p });
  const b = {
    entries,
    propellant(action: PropellantAction, kg: number, tankDeltaKg: number, ok = true) {
      entries.push({ ...at(), source: 'propellant', payload: { action, ok, kg, tankDeltaKg } });
      return b;
    },
    cargo(action: CargoAction, r: Partial<CargoResult>) {
      entries.push({ ...at(), source: 'cargo', payload: { action, result: res(r) } });
      return b;
    },
    mine(id: string, resource: Resource, kg: number) {
      b.cargo({ kind: 'mine', asteroidId: id, resource, kg }, { kgIn: kg });
      entries.push({ ...at(), source: 'mined', payload: { id, by: 'local', resource, kg } });
      return b;
    },
    emergency(kind: 'cannibalize' | 'cannibalize-cargo' | 'beacon', timesUsed?: number) {
      entries.push({ ...at(), source: 'emergency', payload: timesUsed === undefined ? { kind } : { kind, timesUsed } });
      return b;
    },
    thrust(kg: number) {
      entries.push({ ...at(), source: 'thrust', payload: { kg } });
      return b;
    },
  };
  return b;
}

function expectSameState(a: ReplayState, b: ReplayState): void {
  expect(Math.abs(a.tank.massKg - b.tank.massKg)).toBeLessThan(1e-6);
  expect(Math.abs(a.tank.capacityLossFrac - b.tank.capacityLossFrac)).toBeLessThan(1e-9);
  for (const r of RESOURCES) expect(Math.abs(a.cargo[r] - b.cargo[r])).toBeLessThan(1e-6);
  const ids = new Set([...Object.keys(a.depletion), ...Object.keys(b.depletion)]);
  for (const id of ids) {
    for (const r of RESOURCES) {
      expect(Math.abs((a.depletion[id]?.[r] ?? 0) - (b.depletion[id]?.[r] ?? 0)), `${id} ${r}`).toBeLessThan(1e-6);
    }
  }
  expect(a.emergency).toEqual(b.emergency);
}

/**
 * Everything the game can log, in an order the game could produce: thrust,
 * a jump and its refund, a cruise leg and a dry partial leg, three mines
 * across two asteroids, a refine, a tank cannibalization, a repair, a cargo
 * cannibalization, a beacon (with its jettison), and a second cannibalization.
 */
function session() {
  return logOf()
    .thrust(500)
    .propellant({ kind: 'jump', distanceLy: 10 }, 1_600, -1_600)
    .propellant({ kind: 'jump-refund', kg: 1_600 }, 1_600, 1_600)
    .mine('ast:gx-a:0:0', 'ice', 2_000)
    .mine('ast:gx-a:0:0', 'metal', 1_500)
    .mine('ast:gx-b:0:1', 'silicate', 1_200)
    .cargo({ kind: 'refine' }, { kgOut: 2_000, fuelKg: 1_600 })
    .propellant({ kind: 'cruise-leg', distanceKm: 7.5e7 }, 100, -100)
    .thrust(12_970)
    .propellant({ kind: 'cruise-leg', distanceKm: 1.5e8 }, 30, -30, false) // ran dry: ok:false, 30 kg really taken
    .propellant({ kind: 'cannibalize', part: 'tank', timesUsed: 0 }, 0, 600)
    .emergency('cannibalize', 1)
    .cargo({ kind: 'repair' }, { kgOut: REPAIR_METAL_KG + REPAIR_SILICATE_KG, restoredFrac: 0.04 })
    .thrust(600)
    .cargo({ kind: 'cannibalize-cargo' }, { kgOut: 1_700, fuelKg: 600 })
    .emergency('cannibalize-cargo')
    .thrust(600)
    .propellant({ kind: 'beacon' }, 0, 960)
    .cargo({ kind: 'jettison-all' }, { kgOut: 0 }) // (refused jettisons are never logged; an ok one with 0 is harmless)
    .emergency('beacon')
    .mine('ast:gx-a:0:0', 'rare', 12.5)
    .thrust(960)
    .propellant({ kind: 'cannibalize', part: 'tank', timesUsed: 1 }, 0, 576)
    .emergency('cannibalize', 2);
}

// ---------------------------------------------------------------------------

describe('replay — entry by entry', () => {
  it('Given an empty log, Then the state is the initial one — a copy; the input is not mutated', () => {
    const s0 = start({ cargo: { ice: 5, metal: 0, silicate: 0, rare: 0 }, depletion: { 'ast:gx-a:0:0': { ice: 1, metal: 0, silicate: 0, rare: 0 } } });
    const frozen = JSON.stringify(s0);
    const out = replay(s0, []);
    expect(out).toEqual(s0);
    expect(out).not.toBe(s0);
    out.cargo.ice = 999;
    out.depletion['ast:gx-a:0:0']!.ice = 999;
    expect(JSON.stringify(s0)).toBe(frozen);
  });

  it('Given propellant entries, Then the tank moves by Σ tankDeltaKg — a refused leg that ran dry still took its kg', () => {
    const log = logOf()
      .propellant({ kind: 'cruise-spool' }, 100, -100)
      .propellant({ kind: 'spool-refund', kg: 100 }, 100, 100)
      .propellant({ kind: 'jump', distanceLy: 900 }, 0, 0, false)
      .propellant({ kind: 'cruise-leg', distanceKm: 1e9 }, 42.5, -42.5, false);
    expect(replay(start(), log.entries).tank.massKg).toBeCloseTo(12_000 - 42.5, 9);
  });

  it('Given thrust entries, Then the tank falls by their kg', () => {
    expect(replay(start(), logOf().thrust(120.5).thrust(0.25).entries).tank.massKg).toBeCloseTo(12_000 - 120.75, 9);
  });

  it('Given an ok tank cannibalization with timesUsed n, Then capacity loss rises by cannibalizeLossFrac(n) and the tank by its tankDeltaKg', () => {
    const log = logOf()
      .propellant({ kind: 'cannibalize', part: 'tank', timesUsed: 0 }, 0, 600)
      .propellant({ kind: 'cannibalize', part: 'tank', timesUsed: 1 }, 0, 576);
    const out = replay(start({ tank: { massKg: 0, capacityLossFrac: 0 } }), log.entries);
    expect(out.tank.capacityLossFrac).toBeCloseTo(cannibalizeLossFrac(0) + cannibalizeLossFrac(1), 12);
    expect(out.tank.massKg).toBeCloseTo(1_176, 9);
  });

  it('Given a REFUSED cannibalization, Then the capacity loss does not change', () => {
    const log = logOf().propellant({ kind: 'cannibalize', part: 'tank', timesUsed: 0 }, 0, 0, false);
    expect(replay(start(), log.entries).tank.capacityLossFrac).toBe(0);
  });

  it('Given mines, Then the hold gains kgIn per resource and the depletion is kept per asteroid', () => {
    const out = replay(start(), logOf().mine('ast:gx-a:0:0', 'ice', 2_000).mine('ast:gx-a:0:0', 'ice', 500).mine('ast:gx-b:0:1', 'metal', 300).entries);
    expect(out.cargo).toEqual({ ice: 2_500, metal: 300, silicate: 0, rare: 0 });
    expect(out.depletion).toEqual({
      'ast:gx-a:0:0': { ice: 2_500, metal: 0, silicate: 0, rare: 0 },
      'ast:gx-b:0:1': { ice: 0, metal: 300, silicate: 0, rare: 0 },
    });
  });

  it('Given a refine, Then the ice falls by kgOut and the tank rises by fuelKg', () => {
    const out = replay(start(), logOf().mine('ast:gx-a:0:0', 'ice', 2_000).cargo({ kind: 'refine' }, { kgOut: 1_250, fuelKg: 1_000 }).entries);
    expect(out.cargo.ice).toBeCloseTo(750, 9);
    expect(out.tank.massKg).toBeCloseTo(13_000, 9);
  });

  it('Given a repair, Then 600 kg metal and 400 kg silicate leave the hold and the loss falls by restoredFrac', () => {
    const s0 = start({ tank: { massKg: 0, capacityLossFrac: 0.08 }, cargo: { ice: 0, metal: 1_000, silicate: 500, rare: 0 } });
    const out = replay(s0, logOf().cargo({ kind: 'repair' }, { kgOut: 1_000, restoredFrac: 0.04 }).entries);
    expect(out.cargo).toEqual({ ice: 0, metal: 1_000 - REPAIR_METAL_KG, silicate: 500 - REPAIR_SILICATE_KG, rare: 0 });
    expect(out.tank.capacityLossFrac).toBeCloseTo(0.04, 12);
  });

  it('Given a jettison, Then the hold is empty', () => {
    const s0 = start({ cargo: { ice: 10, metal: 20, silicate: 30, rare: 4 } });
    expect(replay(s0, logOf().cargo({ kind: 'jettison-all' }, { kgOut: 64 }).entries).cargo).toEqual({ ice: 0, metal: 0, silicate: 0, rare: 0 });
  });

  it('Given a cargo cannibalization, Then the hold is empty and the tank rises by fuelKg', () => {
    const s0 = start({ tank: { massKg: 0, capacityLossFrac: 0 }, cargo: { ice: 0, metal: 900, silicate: 800, rare: 0 } });
    const out = replay(s0, logOf().cargo({ kind: 'cannibalize-cargo' }, { kgOut: 1_700, fuelKg: 600 }).entries);
    expect(out.cargo).toEqual({ ice: 0, metal: 0, silicate: 0, rare: 0 });
    expect(out.tank.massKg).toBeCloseTo(600, 9);
  });

  it('Given emergency entries, Then each kind is counted', () => {
    const out = replay(start(), logOf().emergency('cannibalize', 1).emergency('beacon').emergency('beacon').emergency('cannibalize-cargo').entries);
    expect(out.emergency).toEqual({ cannibalize: 1, cannibalizeCargo: 1, beacon: 2 });
  });

  it('Given the whole session, Then replay lands where the arithmetic says', () => {
    const out = replay(start(), session().entries);
    // 12 000 − 500 − 1 600 + 1 600 + 1 600 − 100 − 12 970 − 30 + 600 − 600 + 600 − 600 + 960 − 960 + 576
    expect(out.tank.massKg).toBeCloseTo(576, 6);
    expect(out.tank.capacityLossFrac).toBeCloseTo(cannibalizeLossFrac(0) - 0.04 + cannibalizeLossFrac(1), 12);
    expect(out.cargo).toEqual({ ice: 0, metal: 0, silicate: 0, rare: 12.5 });
    expect(out.depletion).toEqual({
      'ast:gx-a:0:0': { ice: 2_000, metal: 1_500, silicate: 0, rare: 12.5 },
      'ast:gx-b:0:1': { ice: 0, metal: 0, silicate: 1_200, rare: 0 },
    });
    expect(out.emergency).toEqual({ cannibalize: 2, cannibalizeCargo: 1, beacon: 1 });
  });
});

describe('the checkpoint carries the net effect (R8)', () => {
  it('Given the session compacted to any size, Then replay(initial, compacted) equals replay(initial, full)', () => {
    const full = session().entries;
    const want = replay(start(), full);
    for (let max = 1; max <= full.length; max++) {
      const c = compactEntries(full, max);
      expect(c.length).toBeLessThanOrEqual(Math.max(max, 1));
      expectSameState(replay(start(), c), want);
    }
  });

  it('Given the session compacted twice (to 12, then to 5), Then replay is unchanged and the log is valid', () => {
    const full = session().entries;
    const twice = compactEntries(compactEntries(full, 12), 5);
    expect(twice).toHaveLength(5);
    expect(twice.filter((e) => e.source === 'checkpoint')).toHaveLength(1);
    expectSameState(replay(start(), twice), replay(start(), full));
    for (const e of twice) expect(ActionEntrySchema.safeParse(e).success).toBe(true);
  });

  it('Given a known prefix folded, Then the checkpoint holds exactly its net effect', () => {
    const log = logOf()
      .thrust(500) // −500
      .propellant({ kind: 'jump', distanceLy: 10 }, 1_600, -1_600)
      .propellant({ kind: 'jump-refund', kg: 400 }, 400, 400)
      .propellant({ kind: 'cruise-leg', distanceKm: 1e9 }, 30, -30, false)
      .mine('ast:gx-a:0:0', 'ice', 2_000)
      .mine('ast:gx-b:0:1', 'metal', 1_500)
      .cargo({ kind: 'refine' }, { kgOut: 1_250, fuelKg: 1_000 })
      .propellant({ kind: 'cannibalize', part: 'tank', timesUsed: 0 }, 0, 600)
      .emergency('cannibalize', 1)
      .cargo({ kind: 'repair' }, { kgOut: 1_000, restoredFrac: 0.04 })
      .emergency('beacon')
      .thrust(1); // the one entry left after the fold
    const c = compactEntries(log.entries, 2);
    expect(c).toHaveLength(2);
    const cp = c[0]!;
    if (cp.source !== 'checkpoint') throw new Error('expected a checkpoint first');
    expect(cp.payload.upToSeq).toBe(log.entries.at(-2)!.seq);
    expect(cp.payload.tankNetKg).toBeCloseTo(-500 - 1_600 + 400 - 30 + 1_000 + 600, 9);
    expect(cp.payload.capacityLossNetFrac).toBeCloseTo(cannibalizeLossFrac(0) - 0.04, 12);
    expect(cp.payload.cargoNetKg.ice).toBeCloseTo(2_000 - 1_250, 9);
    expect(cp.payload.cargoNetKg.metal).toBeCloseTo(1_500 - REPAIR_METAL_KG, 9);
    expect(cp.payload.cargoNetKg.silicate).toBeCloseTo(-REPAIR_SILICATE_KG, 9);
    expect(cp.payload.cargoNetKg.rare).toBe(0);
    expect(cp.payload.minedByAsteroid).toEqual({
      'ast:gx-a:0:0': { ice: 2_000, metal: 0, silicate: 0, rare: 0 },
      'ast:gx-b:0:1': { ice: 0, metal: 1_500, silicate: 0, rare: 0 },
    });
    expect(cp.payload.emergency).toEqual({ cannibalize: 1, cannibalizeCargo: 0, beacon: 1 });
    expect(cp.payload.lastCannibalizeTimesUsed).toBe(1);
    expect(ActionEntrySchema.safeParse(cp).success).toBe(true);
  });

  it('Given a checkpoint folded into a newer one with no cannibalization since, Then lastCannibalizeTimesUsed is carried over', () => {
    const log = logOf().emergency('cannibalize', 3).thrust(1).thrust(1).thrust(1).thrust(1);
    const once = compactEntries(log.entries, 4); // folds the cannibalize
    const twice = compactEntries([...once, ...logOf().thrust(1).thrust(1).entries.map((e, i) => ({ ...e, seq: 100 + i }))], 2);
    const cp = twice[0]!;
    if (cp.source !== 'checkpoint') throw new Error('expected a checkpoint first');
    expect(cp.payload.lastCannibalizeTimesUsed).toBe(3);
  });

  it('Given a jettison inside the folded prefix (the log starts at a new game: an empty hold), Then the net cargo empties the hold it had filled', () => {
    const log = logOf().mine('ast:gx-a:0:0', 'ice', 700).mine('ast:gx-a:0:0', 'metal', 300).cargo({ kind: 'jettison-all' }, { kgOut: 1_000 }).mine('ast:gx-b:0:1', 'rare', 5).thrust(1);
    const c = compactEntries(log.entries, 2);
    expectSameState(replay(start(), c), replay(start(), log.entries));
    expect(replay(start(), c).cargo).toEqual({ ice: 0, metal: 0, silicate: 0, rare: 5 });
  });
});

// =============================================================================
// Final review, ruling R25 I1 — defence in depth. The schema keeps a hostile
// id out; if anything ever bypasses it, the depletion map still must not be a
// door to Object.prototype ("__proto__" read off a plain {} IS the prototype).
// =============================================================================

describe('R25 I1 — a hostile asteroid key never reaches Object.prototype (schema bypassed)', () => {
  /** What the RED state writes: Object.prototype.ice = NaN etc. Scrubbed so it cannot leak into other tests. */
  function polluted(): string[] {
    const hit = RESOURCES.filter((r) => Object.prototype.hasOwnProperty.call(Object.prototype, r));
    for (const r of hit) delete (Object.prototype as Record<string, unknown>)[r];
    return hit;
  }
  afterEach(() => {
    polluted();
  });

  const at = { wallMs: 1_800_000_000_000, orbitSeconds: 10 };
  /** Cast past the schema on purpose: this is what a bypass would hand replay. */
  const hostileMined = (id: string, seq = 1) =>
    ({ seq, source: 'mined', payload: { id, by: 'local', resource: 'ice', kg: 5 }, ...at }) as ActionEntry;
  const hostileCheckpoint = (): ActionEntry =>
    JSON.parse(
      '{"seq":1,"source":"checkpoint","payload":{"upToSeq":1,"tankNetKg":0,"capacityLossNetFrac":0,' +
        '"cargoNetKg":{"ice":0,"metal":0,"silicate":0,"rare":0},' +
        '"minedByAsteroid":{"__proto__":{"ice":5,"metal":0,"silicate":0,"rare":0}},' +
        '"emergency":{"cannibalize":0,"cannibalizeCargo":0,"beacon":0},"lastCannibalizeTimesUsed":0},' +
        '"wallMs":1800000000000,"orbitSeconds":10}',
    ) as ActionEntry;

  it('Given a mined entry with id "__proto__", When replayed, Then Object.prototype gains no resource key and ({}).ice stays undefined', () => {
    replay(start(), [hostileMined('__proto__')]);
    const seen = ({} as Record<string, unknown>).ice;
    expect(polluted()).toEqual([]);
    expect(seen).toBeUndefined();
  });

  it('Given a checkpoint whose minedByAsteroid holds an own "__proto__" key, When replayed, Then Object.prototype is untouched', () => {
    replay(start(), [hostileCheckpoint()]);
    expect(polluted()).toEqual([]);
  });

  it('Given hostile ids ("__proto__", "constructor", "toString"), When compacted into a checkpoint, Then Object.prototype is untouched and the other asteroids keep their sums', () => {
    const log = [
      hostileMined('__proto__', 1),
      hostileMined('constructor', 2),
      hostileMined('toString', 3),
      ...logOf()
        .mine('ast:gx-a:0:0', 'ice', 700)
        .thrust(1)
        .entries.map((e, i) => ({ ...e, seq: 10 + i })),
    ];
    const c = compactEntries(log, 2);
    expect(polluted()).toEqual([]);
    const cp = c[0]!;
    if (cp.source !== 'checkpoint') throw new Error('expected a checkpoint first');
    expect(cp.payload.minedByAsteroid['ast:gx-a:0:0']).toEqual({ ice: 700, metal: 0, silicate: 0, rare: 0 });
    expect(typeof Object.prototype.toString).toBe('function');
    expect(typeof Object.prototype.constructor).toBe('function');
  });
});

// =============================================================================
// v4 sub-plan 6, Task 1 (phase A) — replay and compaction know `jettison`.
//
// Assumed (plan 6 Task 1 Interfaces): `applyEntry` subtracts `result.kgOut`
// from `cargo[action.resource]` for an ok `{ kind: 'jettison', resource, kg }`.
// The checkpoint already nets the hold per resource and is not changed
// (Review Focus 2, 3). The action is cast: `CargoAction` does not have it yet.
// =============================================================================

const jettisonAction = (resource: Resource, kg: number) => ({ kind: 'jettison', resource, kg }) as unknown as CargoAction;

/** mine 500 ice, jettison 250 ice, mine 250 ice — then one thrust so a fold leaves something after it. */
function mineJettisonMine() {
  return logOf()
    .mine('ast:gx-a:0:0', 'ice', 500)
    .cargo(jettisonAction('ice', 250), { kgOut: 250 })
    .mine('ast:gx-a:0:0', 'ice', 250)
    .thrust(1);
}

describe('replay — jettison (plan 6 task 1)', () => {
  it('Given 1 000 kg of ice and an ok jettison of 250 kg ice, Then 750 kg of ice is left and nothing else moves', () => {
    const s0 = start({ cargo: { ice: 1_000, metal: 20, silicate: 30, rare: 4 } });
    const out = replay(s0, logOf().cargo(jettisonAction('ice', 250), { kgOut: 250 }).entries);
    expect(out.cargo).toEqual({ ice: 750, metal: 20, silicate: 30, rare: 4 });
    expect(out.tank).toEqual(s0.tank);
  });

  it('Given a jettison asked for 250 kg but kgOut 100 (only 100 held), Then replay takes kgOut — what really left — not the asked kg', () => {
    const s0 = start({ cargo: { ice: 0, metal: 100, silicate: 0, rare: 0 } });
    const out = replay(s0, logOf().cargo(jettisonAction('metal', 250), { kgOut: 100 }).entries);
    expect(out.cargo.metal).toBe(0);
  });

  it('Given a log: mine 500, jettison 250, mine 250 (all ice), Then the hold is 500 kg of ice', () => {
    const out = replay(start(), mineJettisonMine().entries);
    expect(out.cargo).toEqual({ ice: 500, metal: 0, silicate: 0, rare: 0 });
  });

  it('Given that log, Then the depletion counts every kg mined (750): a jettison gives the rock nothing back', () => {
    const out = replay(start(), mineJettisonMine().entries);
    expect(out.cargo.ice, 'the jettison was applied').toBe(500);
    expect(out.depletion['ast:gx-a:0:0']).toEqual({ ice: 750, metal: 0, silicate: 0, rare: 0 });
  });

  it('Given a jettison of each resource in turn, Then each takes from its own resource only', () => {
    const s0 = start({ cargo: { ice: 400, metal: 400, silicate: 400, rare: 400 } });
    let log = logOf();
    for (const [i, r] of RESOURCES.entries()) log = log.cargo(jettisonAction(r, 100 * (i + 1)), { kgOut: 100 * (i + 1) });
    expect(replay(s0, log.entries).cargo).toEqual({ ice: 300, metal: 200, silicate: 100, rare: 0 });
  });

  it('Given that log compacted to every size, Then replay of the compacted log is the same 500 kg of ice, and every log is schema-valid', () => {
    const full = mineJettisonMine().entries;
    expect(replay(start(), full).cargo.ice).toBe(500);
    for (let max = 1; max <= full.length; max++) {
      const c = compactEntries(full, max);
      expectSameState(replay(start(), c), replay(start(), full));
      expect(replay(start(), c).cargo.ice, `max ${max}`).toBeCloseTo(500, 9);
      for (const e of c) expect(ActionEntrySchema.safeParse(e).success, `max ${max} seq ${e.seq}`).toBe(true);
    }
  });

  it('Given that log folded so the jettison is inside the checkpoint, Then the checkpoint nets the ice to +500 and keeps the depletion at 750', () => {
    const c = compactEntries(mineJettisonMine().entries, 2);
    const cp = c[0]!;
    if (cp.source !== 'checkpoint') throw new Error('expected a checkpoint first');
    expect(cp.payload.cargoNetKg).toEqual({ ice: 500, metal: 0, silicate: 0, rare: 0 });
    expect(cp.payload.minedByAsteroid['ast:gx-a:0:0']).toEqual({ ice: 750, metal: 0, silicate: 0, rare: 0 });
  });

  it('Given a jettison of cargo held BEFORE the log began (1 000 kg ice at the start), folded into a checkpoint, Then replay still gives 750 — unlike jettison-all, the net is exact from any start', () => {
    const s0 = start({ cargo: { ice: 1_000, metal: 0, silicate: 0, rare: 0 } });
    const log = logOf().cargo(jettisonAction('ice', 250), { kgOut: 250 }).thrust(1).thrust(1);
    const c = compactEntries(log.entries, 2);
    expect(c[0]!.source).toBe('checkpoint');
    expect(replay(s0, c).cargo.ice).toBe(750);
    expectSameState(replay(s0, c), replay(s0, log.entries));
  });

  it('Given the whole session plus jettisons, compacted to any size, Then replay(compacted) equals replay(full)', () => {
    const extra = session()
      .mine('ast:gx-b:0:1', 'metal', 900)
      .cargo(jettisonAction('metal', 250), { kgOut: 250 })
      .cargo(jettisonAction('rare', 250), { kgOut: 12.5 })
      .thrust(5);
    const full = extra.entries;
    const want = replay(start(), full);
    expect(want.cargo.metal).toBeCloseTo(650, 9);
    expect(want.cargo.rare).toBeCloseTo(0, 9);
    for (let max = 1; max <= full.length; max++) expectSameState(replay(start(), compactEntries(full, max)), want);
  });
});
