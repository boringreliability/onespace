/**
 * v4 sub-plan 1 (propellant), Task 6 — the emergency exit costs something.
 *
 * Pure rules (`ship/emergency.ts`):
 * - cannibalize: +3 % of BASE capacity as propellant, for a permanent loss of
 *   0.08 · 1.5^timesUsed of BASE capacity (8 % → 12 % → 18 % …). Refused
 *   (null) when the remaining capacity cannot carry the loss.
 * - beacon: the tank is set to 5 % of the CURRENT capacity.
 * - `applyAction` routes 'cannibalize' / 'beacon' through the same rules;
 *   cargo cannibalization is the cargo action `cannibalize-cargo` (sub-plan 2).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bus } from '@/core/EventBus';
import { ShipLog } from '@/game/Log';
import { CARGO_CAPACITY_KG, Cargo } from './cargo';
import { PROBE_TANK_CAPACITY_KG, Propellant } from './propellant';
import { applyAction } from './travelCost';
import {
  BEACON_FILL_FRAC,
  CANNIBALIZE_GAIN_FRAC,
  applyBeacon,
  applyCannibalize,
  cannibalizeLossFrac,
  cannibalizeYield,
  emergencyMayAct,
  payBeacon,
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

  it("Task 6 (sub-plan 2): the reserved cannibalize part:'cargo' path is gone — cargo burns only through applyCargoAction('cannibalize-cargo')", () => {
    // The tank action has no hold to burn; one path for one rule (P3).
    const src = readFileSync(fileURLToPath(new URL('./travelCost.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain('cargo-reserved');
    expect(src).not.toMatch(/part:\s*'tank'\s*\|\s*'cargo'/);
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

// ---------------------------------------------------------------------------
// Fix round 1 (R16): one predicate; the tank is only cannibalized when empty.
// ---------------------------------------------------------------------------

describe('emergencyMayAct — the one gate for keys and line', () => {
  const ok = { paused: false, frozen: false, recoveryActive: false, warpPhase: 'idle', tank: emptyTank() };

  it('Given an empty tank and nothing in the way, Then it is true', () => {
    expect(emergencyMayAct(ok)).toBe(true);
  });

  it('Given paused, frozen, a recovery, or any warp phase but idle, Then it is false', () => {
    expect(emergencyMayAct({ ...ok, paused: true })).toBe(false);
    expect(emergencyMayAct({ ...ok, frozen: true })).toBe(false);
    expect(emergencyMayAct({ ...ok, recoveryActive: true })).toBe(false);
    for (const phase of ['charging', 'tunnel', 'arriving', 'anything-not-idle']) {
      expect(emergencyMayAct({ ...ok, warpPhase: phase }), phase).toBe(false);
    }
  });

  it('Given propellant above 0, Then it is false', () => {
    const p = emptyTank();
    p.add(0.001);
    expect(emergencyMayAct({ ...ok, tank: p })).toBe(false);
  });

  it('Given a hull without a tank, Then it is false', () => {
    expect(emergencyMayAct({ ...ok, tank: null })).toBe(false);
  });
});

describe('cannibalize only an empty tank', () => {
  it('Given propellant above 0, When applyCannibalize is called directly, Then it is refused and the tank is unchanged', () => {
    const p = emptyTank();
    p.add(50);
    const r = applyCannibalize(p, 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-empty');
    expect(p.massKg).toBe(50);
    expect(p.capacityLossFrac).toBe(0);
  });

  it("Given propellant above 0, When applyAction cannibalize 'tank' is called, Then it is refused with 'not-empty' and the tank is unchanged", () => {
    const p = emptyTank();
    p.add(50);
    const r = applyAction(p, { kind: 'cannibalize', part: 'tank' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-empty');
    expect(p.massKg).toBe(50);
    expect(p.capacityLossFrac).toBe(0);
  });
});

describe('emergency — mutation hardening', () => {
  it('Given a fractional timesUsed of 1.7, Then it is floored to 1: the loss is 12 %', () => {
    expect(cannibalizeLossFrac(1.7)).toBeCloseTo(0.12, 12);
    expect(cannibalizeLossFrac(1.7)).toBe(cannibalizeLossFrac(1));
  });

  it('Given the remaining capacity exactly equals the loss, Then cannibalize is refused (equality refused)', () => {
    // 1 - 0.88 === 0.12 === 0.08 · 1.5 in floating point
    const p = emptyTank(0.88);
    expect(1 - p.capacityLossFrac).toBe(cannibalizeLossFrac(1));
    expect(cannibalizeYield(p, 1)).toBeNull();
    expect(applyCannibalize(p, 1)).toEqual({ ok: false, kg: 0, reason: 'capacity' });
    expect(p.capacityLossFrac).toBe(0.88);
  });

  it('Given a heavily shrunk tank (90 % lost), When cannibalized, Then the loss lands first and the tank ends at exactly the 2 % that is left (400 kg)', () => {
    const p = emptyTank(0.9);
    expect(applyCannibalize(p, 0)).toEqual({ ok: true, kg: 0 });
    expect(p.capacityLossFrac).toBeCloseTo(0.98, 12);
    expect(p.capacityKg).toBeCloseTo(0.02 * BASE, 6);
    expect(p.massKg).toBeCloseTo(0.02 * BASE, 6);
  });
});

// ---------------------------------------------------------------------------
// v4 sub-plan 2 (mining), Task 6 — payBeacon(tank, cargo, log): the ONE place
// the beacon is paid (Emergency key 2 and RecoveryCut's RETURN TO ORBIT, D11).
// The tank is set to 5 % (the beacon action), the whole hold is jettisoned
// (one `jettison-all`), and the log gets a 'BEACON RECOVERY' note keyed
// `beacon:<n>`. n is derived from the log itself (the highest beacon:<n> it
// holds, + 1), so it is saved with the log and needs no counter of its own.
// ---------------------------------------------------------------------------

/** A localStorage that behaves like the real one. */
class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

describe('Task 6 — payBeacon', () => {
  const offs: Array<() => void> = [];
  afterEach(() => {
    for (const o of offs.splice(0)) o();
    vi.unstubAllGlobals();
  });

  function hold(kg: Partial<Record<'ice' | 'metal' | 'silicate' | 'rare', number>>): Cargo {
    const c = new Cargo(CARGO_CAPACITY_KG);
    c.restore(kg);
    return c;
  }
  const notes = (log: ShipLog) => log.all().filter((e) => e.title === 'BEACON RECOVERY');

  it('Given cargo 3 t and an empty tank, When payBeacon, Then the tank is at 5 % of current capacity, the hold is empty via one jettison-all, and one BEACON RECOVERY note (kind note, key beacon:1) exists', () => {
    const tank = emptyTank(0.2);
    const cargo = hold({ metal: 2_000, rare: 1_000 });
    const log = new ShipLog();
    const seen: Array<{ kind: string; ok: boolean; kgOut: number }> = [];
    offs.push(bus.on('cargo:action', ({ action, result }) => seen.push({ kind: action.kind, ok: result.ok, kgOut: result.kgOut })));
    payBeacon(tank, cargo, log, 'Fyss');
    expect(tank.massKg).toBeCloseTo(0.05 * 0.8 * BASE, 9);
    expect(tank.capacityLossFrac).toBeCloseTo(0.2, 12);
    expect(cargo.totalKg).toBe(0);
    expect(seen).toEqual([{ kind: 'jettison-all', ok: true, kgOut: 3_000 }]);
    const n = notes(log);
    expect(n).toHaveLength(1);
    expect(n[0]!.key).toBe('beacon:1');
    expect(n[0]!.kind).toBe('note');
    expect(n[0]!.system).toBe('Fyss');
    expect(n[0]!.body.length).toBeGreaterThan(0);
  });

  it('Given an empty hold, When payBeacon, Then it does not throw and still writes the note', () => {
    const tank = emptyTank();
    const cargo = hold({});
    const log = new ShipLog();
    expect(() => payBeacon(tank, cargo, log, 'Fyss')).not.toThrow();
    expect(notes(log)).toHaveLength(1);
    expect(tank.massKg).toBeCloseTo(0.05 * BASE, 9);
  });

  it('Given payBeacon twice, Then two notes beacon:1 and beacon:2 (each its own, visits 1)', () => {
    const log = new ShipLog();
    payBeacon(emptyTank(), hold({ metal: 1_000 }), log, 'Fyss');
    payBeacon(emptyTank(), hold({ ice: 1_000 }), log, 'Fyss');
    const n = notes(log);
    expect(n.map((e) => e.key).sort()).toEqual(['beacon:1', 'beacon:2']);
    expect(n.every((e) => e.visits === 1)).toBe(true);
  });

  it('Given two beacons saved with the log, When the log is reloaded, Then the next beacon is beacon:3 (the counter survives a save)', () => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    const first = new ShipLog();
    payBeacon(emptyTank(), hold({}), first, 'Fyss');
    payBeacon(emptyTank(), hold({}), first, 'Fyss');
    const reloaded = new ShipLog();
    payBeacon(emptyTank(), hold({}), reloaded, 'Fyss');
    expect(notes(reloaded).map((e) => e.key).sort()).toEqual(['beacon:1', 'beacon:2', 'beacon:3']);
  });
});
