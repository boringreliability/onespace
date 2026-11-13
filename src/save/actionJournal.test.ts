/**
 * v4 sub-plan 3 (local save), Task 3 — the action log (P3, D13).
 *
 * The journal is append-only: every named thing that changes the ship or the
 * world becomes exactly one entry, stamped with BOTH clocks (P5):
 *  - `propellant:action` (refused ones too — the payload carries `ok`),
 *  - `cargo:action`, only when `result.ok`,
 *  - `emergency:used`,
 *  - a mine, through `WorldState.recordMined` (a hook, `onMined`): Mining
 *    announces `cargo:action` BEFORE it records the mine, so a journal that
 *    only listened to the bus would see half a mine;
 *  - unannounced thrust, as one aggregated `thrust` entry (`noteThrust`) so the
 *    tank's books always balance.
 *
 * `drain()` hands over what was noted since the last drain. `seq` rises
 * strictly and never repeats, even after a `restore`. Past `MAX_ACTIONS` the
 * oldest entries fold into one `checkpoint` holding their sums.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import { MINING_KEYS, actionForKey, type ActionName } from '@/core/Input';
import type { AsteroidSpec, Resource } from '@/gen/belt';
import { Belt } from '@/game/Belt';
import { Mining, type MiningWorld } from '@/game/Mining';
import { fyssField, nodeCtx, startSystem } from '@/game/testing/beltFixture';
import { WorldState, type MinedEntry } from '@/game/worldState';
import { CARGO_CAPACITY_KG, Cargo, type CargoAction, type CargoResult } from '@/ship/cargo';
import { PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
import type { PropellantAction } from '@/ship/travelCost';
import { ActionJournal, MAX_ACTIONS, compactEntries } from './actionJournal';
import { replay, type ReplayState } from './replay';
import { ActionEntrySchema, type ActionEntry } from './schema';

const RESOURCES: readonly Resource[] = ['ice', 'metal', 'silicate', 'rare'];

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  bus.clear();
});

/** A clock the test moves by hand. */
function handClock(wall = 1_800_000_000_000, orbit = 0) {
  const c = { wall, orbit };
  return { c, clock: { wallMs: () => c.wall, orbitSeconds: () => c.orbit } };
}

function journal(wall?: number, orbit?: number) {
  const { c, clock } = handClock(wall, orbit);
  const j = new ActionJournal(clock);
  offs.push(() => j.dispose());
  return { j, c };
}

// --- event helpers ------------------------------------------------------------

/** R7: the event carries the signed tank change; a spend by default (−kg). */
function propellant(action: PropellantAction, kg: number, ok = true, tankDeltaKg = ok ? -kg : 0): void {
  bus.emit('propellant:action', { action, ok, kg, tankDeltaKg });
}

function okResult(p: Partial<CargoResult> = {}): CargoResult {
  return { ok: true, kgIn: 0, kgOut: 0, fuelKg: 0, restoredFrac: 0, ...p };
}

function cargo(action: CargoAction, result: CargoResult): void {
  bus.emit('cargo:action', { action, result });
}

function mineAction(resource: Resource, kg: number, asteroidId = 'gx-test:f0:a1'): void {
  cargo({ kind: 'mine', asteroidId, resource, kg }, okResult({ kgIn: kg }));
}

function mined(over: Partial<MinedEntry> = {}): MinedEntry {
  return { id: 'gx-test:f0:a1', by: 'local', resource: 'ice', kg: 2_000, orbitSeconds: 40, wallMs: 1_800_000_000_500, ...over };
}

/** Every entry is a valid v1 action entry (the schema is the contract with the save). */
function expectValid(entries: readonly ActionEntry[]): void {
  for (const e of entries) expect(ActionEntrySchema.safeParse(e).success).toBe(true);
}

function seqsOf(entries: readonly ActionEntry[]): number[] {
  return entries.map((e) => e.seq);
}

function expectStrictlyRising(xs: readonly number[]): void {
  for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
}

// ---------------------------------------------------------------------------

describe('one event, one entry, both clocks', () => {
  const W = 1_800_000_123_000;
  const O = 3_600.25;

  const cases: Array<[string, (j: ActionJournal) => void, ActionEntry['source']]> = [
    ['a propellant:action (a jump)', () => propellant({ kind: 'jump', distanceLy: 12 }, 1_120), 'propellant'],
    ['an ok cargo:action (a mine)', () => mineAction('ice', 2_000), 'cargo'],
    ['an emergency:used (cannibalize)', () => bus.emit('emergency:used', { kind: 'cannibalize', timesUsed: 1 }), 'emergency'],
    ['an emergency:used (beacon)', () => bus.emit('emergency:used', { kind: 'beacon' }), 'emergency'],
    ['a recorded mine (noteMined)', (j) => j.noteMined(mined({ wallMs: W, orbitSeconds: O })), 'mined'],
    ['unannounced thrust (noteThrust)', (j) => j.noteThrust(10_000, 9_000, 400), 'thrust'],
  ];

  for (const [what, act, source] of cases) {
    it(`Given ${what}, Then the journal holds exactly one ${source} entry stamped with both clocks`, () => {
      const { j } = journal(W, O);
      act(j);
      const out = j.drain();
      expect(out).toHaveLength(1);
      expect(out[0]!.source).toBe(source);
      expect(out[0]!.wallMs).toBe(W);
      expect(out[0]!.orbitSeconds).toBe(O);
      expect(out[0]!.seq).toBeGreaterThanOrEqual(1);
      expectValid(out);
    });
  }

  it('Given a propellant:action, Then its payload is the event as announced ({action, ok, kg, tankDeltaKg})', () => {
    const { j } = journal();
    propellant({ kind: 'cruise-leg', distanceKm: 5e6 }, 66.84);
    expect(j.drain()[0]!.payload).toEqual({ action: { kind: 'cruise-leg', distanceKm: 5e6 }, ok: true, kg: 66.84, tankDeltaKg: -66.84 });
  });

  it('Given a cannibalize announced with kg 0 but a +600 kg tank change, Then the entry keeps tankDeltaKg +600 (R7)', () => {
    const { j } = journal();
    propellant({ kind: 'cannibalize', part: 'tank', timesUsed: 0 }, 0, true, 600);
    expect(j.drain()[0]!.payload).toEqual({ action: { kind: 'cannibalize', part: 'tank', timesUsed: 0 }, ok: true, kg: 0, tankDeltaKg: 600 });
  });

  it('Given a REFUSED propellant:action, Then it is still logged once, with ok:false (the payload carries ok)', () => {
    const { j } = journal();
    propellant({ kind: 'jump', distanceLy: 40 }, 0, false);
    const out = j.drain();
    expect(out).toHaveLength(1);
    expect(out[0]!.payload).toEqual({ action: { kind: 'jump', distanceLy: 40 }, ok: false, kg: 0, tankDeltaKg: 0 });
  });

  it('Given an ok cargo:action, Then its payload is {action, result} as announced', () => {
    const { j } = journal();
    const result = okResult({ kgOut: 1_250, fuelKg: 1_000 });
    cargo({ kind: 'refine' }, result);
    expect(j.drain()[0]!.payload).toEqual({ action: { kind: 'refine' }, result });
  });

  it('Given emergency:used, Then the payload carries the kind and (for cannibalize) timesUsed', () => {
    const { j } = journal();
    bus.emit('emergency:used', { kind: 'cannibalize', timesUsed: 2 });
    bus.emit('emergency:used', { kind: 'cannibalize-cargo' });
    const out = j.drain();
    expect(out.map((e) => e.payload)).toEqual([
      { kind: 'cannibalize', timesUsed: 2 },
      expect.objectContaining({ kind: 'cannibalize-cargo' }),
    ]);
  });

  it('Given noteMined, Then the entry is {id, by, resource, kg} and keeps the moment it was MINED (the MinedEntry clocks)', () => {
    const { j } = journal(1_900_000_000_000, 99_999);
    j.noteMined(mined({ id: 'gx-x:f2:a9', resource: 'metal', kg: 512.5, wallMs: 1_800_000_000_777, orbitSeconds: 12.5 }));
    const e = j.drain()[0]!;
    expect(e.payload).toEqual({ id: 'gx-x:f2:a9', by: 'local', resource: 'metal', kg: 512.5 });
    expect(e.wallMs).toBe(1_800_000_000_777);
    expect(e.orbitSeconds).toBe(12.5);
  });

  it('Given the clocks move between events, Then each entry carries the clocks of ITS moment', () => {
    const { j, c } = journal(1_000, 10);
    propellant({ kind: 'cruise-spool' }, 100);
    c.wall = 2_000;
    c.orbit = 20;
    propellant({ kind: 'cruise-spool' }, 100);
    const out = j.drain();
    expect(out.map((e) => [e.wallMs, e.orbitSeconds])).toEqual([
      [1_000, 10],
      [2_000, 20],
    ]);
  });
});

describe('refused cargo actions give no entry', () => {
  const refusals: Array<[CargoAction, NonNullable<CargoResult['reason']>]> = [
    [{ kind: 'mine', asteroidId: 'gx-test:f0:a1', resource: 'ice', kg: 2_000 }, 'hold-full'],
    [{ kind: 'refine' }, 'tank-full'],
    [{ kind: 'repair' }, 'nothing-to-repair'],
    [{ kind: 'jettison-all' }, 'empty'],
    [{ kind: 'cannibalize-cargo' }, 'not-empty'],
  ];
  for (const [action, reason] of refusals) {
    it(`Given cargo:action ${action.kind} refused (${reason}), Then the journal stays empty`, () => {
      const { j } = journal();
      cargo(action, { ok: false, kgIn: 0, kgOut: 0, fuelKg: 0, restoredFrac: 0, reason });
      expect(j.drain()).toEqual([]);
    });
  }

  it('Given a refusal between two ok actions, Then only the two ok actions are logged', () => {
    const { j } = journal();
    mineAction('ice', 100);
    cargo({ kind: 'refine' }, { ok: false, kgIn: 0, kgOut: 0, fuelKg: 0, restoredFrac: 0, reason: 'tank-full' });
    mineAction('metal', 50);
    expect(j.drain().map((e) => (e.payload as { action: CargoAction }).action.kind)).toEqual(['mine', 'mine']);
  });
});

describe('drain and seq', () => {
  it('Given entries drained, Then a second drain is empty (each entry is handed over once)', () => {
    const { j } = journal();
    propellant({ kind: 'cruise-spool' }, 100);
    expect(j.drain()).toHaveLength(1);
    expect(j.drain()).toEqual([]);
  });

  it('Given events across several drains, Then seq starts at 1 and rises strictly, never repeating', () => {
    const { j } = journal();
    const all: ActionEntry[] = [];
    propellant({ kind: 'cruise-spool' }, 100);
    mineAction('ice', 10);
    all.push(...j.drain());
    bus.emit('emergency:used', { kind: 'beacon' });
    all.push(...j.drain());
    j.noteThrust(1_000, 900, 0);
    j.noteMined(mined());
    all.push(...j.drain());
    expect(all[0]!.seq).toBe(1);
    expectStrictlyRising(seqsOf(all));
    expect(new Set(seqsOf(all)).size).toBe(all.length);
  });

  it('Given a restore of a saved log ending at seq 42, Then the next entry has a seq above 42', () => {
    const { j } = journal();
    const saved: ActionEntry[] = [
      { seq: 40, source: 'thrust', payload: { kg: 1 }, wallMs: 1, orbitSeconds: 1 },
      { seq: 41, source: 'emergency', payload: { kind: 'beacon' }, wallMs: 2, orbitSeconds: 2 },
      { seq: 42, source: 'propellant', payload: { action: { kind: 'cruise-spool' }, ok: true, kg: 100, tankDeltaKg: -100 }, wallMs: 3, orbitSeconds: 3 },
    ];
    j.restore(saved);
    propellant({ kind: 'cruise-spool' }, 100);
    mineAction('ice', 1);
    const out = j.drain();
    const fresh = out.filter((e) => !saved.some((s) => s.seq === e.seq && s.wallMs === e.wallMs));
    expect(fresh).toHaveLength(2);
    expect(fresh[0]!.seq).toBeGreaterThan(42);
    expectStrictlyRising(seqsOf(fresh));
  });

  it('Given a restored log that starts with a checkpoint, Then seq continues above the highest seq in it', () => {
    const { j } = journal();
    j.restore([
      {
        seq: 3_000,
        source: 'checkpoint',
        payload: {
          upToSeq: 2_999,
          tankNetKg: -10,
          capacityLossNetFrac: 0,
          cargoNetKg: { ice: 0, metal: 0, silicate: 0, rare: 0 },
          minedByAsteroid: {},
          emergency: { cannibalize: 0, cannibalizeCargo: 0, beacon: 0 },
          lastCannibalizeTimesUsed: 0,
        },
        wallMs: 1,
        orbitSeconds: 1,
      },
      { seq: 3_001, source: 'thrust', payload: { kg: 1 }, wallMs: 2, orbitSeconds: 2 },
    ]);
    bus.emit('emergency:used', { kind: 'beacon' });
    const last = j.drain().at(-1)!;
    expect(last.source).toBe('emergency');
    expect(last.seq).toBeGreaterThan(3_001);
  });

  it('Given a journal already at seq 10, When an OLDER log (max seq 3) is restored, Then seq never goes back (next > 10)', () => {
    const { j } = journal();
    for (let i = 0; i < 10; i++) propellant({ kind: 'cruise-spool' }, 1);
    j.drain();
    j.restore([{ seq: 3, source: 'thrust', payload: { kg: 1 }, wallMs: 1, orbitSeconds: 1 }]);
    propellant({ kind: 'cruise-spool' }, 1);
    expect(j.drain().at(-1)!.seq).toBeGreaterThan(10);
  });

  it('Given dispose, Then later events make no entries', () => {
    const { j } = journal();
    j.dispose();
    propellant({ kind: 'cruise-spool' }, 100);
    mineAction('ice', 1);
    bus.emit('emergency:used', { kind: 'beacon' });
    expect(j.drain()).toEqual([]);
  });

  it('M-3: Given dispose, Then a WorldState hooked to the journal no longer feeds it (onMined is unhooked)', () => {
    const { j } = journal();
    const ws = new WorldState({ orbitSeconds: () => 0, wallMs: () => 0, onMined: (e: MinedEntry) => j.noteMined(e) });
    ws.recordMined('gx-test:f0:a1', 'ice', 10, 'local');
    expect(j.drain()).toHaveLength(1);
    j.dispose();
    ws.recordMined('gx-test:f0:a1', 'ice', 10, 'local');
    j.noteMined(mined());
    expect(j.drain()).toEqual([]);
  });
});

describe('noteThrust balances the books', () => {
  /** Σ named + thrust = tank delta, to 1e-9. */
  const cases: Array<[number, number, number]> = [
    [10_000, 7_000, 1_200],
    [12_000, 10_149.5, 1_600 - 800], // a jump paid, a refine put 800 back
    [0.3, 0.1, 0.1], // float dust
    [20_000, 0, 19_999.999_999],
    [8_765.4321, 1_234.5678, 0], // all of it unannounced
  ];
  for (const [before, after, named] of cases) {
    it(`Given the tank went ${before} → ${after} kg with ${named} kg named, Then named + thrust = ${before - after} kg (1e-9) in one thrust entry`, () => {
      const { j } = journal();
      j.noteThrust(before, after, named);
      const thrust = j.drain().filter((e) => e.source === 'thrust');
      expect(thrust.length).toBeLessThanOrEqual(1);
      const kg = thrust.reduce((s, e) => s + (e.payload as { kg: number }).kg, 0);
      expect(Math.abs(named + kg - (before - after))).toBeLessThan(1e-9);
      expectValid(thrust);
    });
  }

  it('Given nothing burned beyond the named actions (or float dust below zero), Then no negative thrust is ever logged', () => {
    const { j } = journal();
    j.noteThrust(5_000, 4_000, 1_000);
    j.noteThrust(5_000, 4_000.000_000_000_1, 1_000);
    const out = j.drain();
    for (const e of out) {
      expect(e.source).toBe('thrust');
      expect((e.payload as { kg: number }).kg).toBeGreaterThanOrEqual(0);
    }
    expect(out.reduce((s, e) => s + (e.payload as { kg: number }).kg, 0)).toBeLessThan(1e-9);
    expectValid(out);
  });

  it('M-2: Given the tank rose more than the named actions explain, Then no thrust is logged and the gain is counted on unexplainedGainKg', () => {
    const { j } = journal();
    expect(j.unexplainedGainKg).toBe(0);
    j.noteThrust(5_000, 5_100, 0); // +100 kg from nowhere
    j.noteThrust(5_000, 4_000, 1_025); // named took 1 025, the tank fell only 1 000: +25
    expect(j.drain().some((e) => e.source === 'thrust')).toBe(false);
    expect(j.unexplainedGainKg).toBeCloseTo(125, 9);
  });

  it('M-2: Given float dust below zero (1e-10 kg), Then it is not counted as an unexplained gain worth reporting', () => {
    const { j } = journal();
    j.noteThrust(5_000, 4_000.000_000_000_1, 1_000);
    expect(j.unexplainedGainKg).toBeLessThan(1e-9);
  });
});

// --- compaction -----------------------------------------------------------------

/**
 * I-2 / R8: the oracle is `replay` itself. A compacted log must recompute the
 * same ship as the full one (tank, loss, hold, depletion, emergency counts).
 */
const START: ReplayState = {
  tank: { massKg: 1e9, capacityLossFrac: 0 },
  cargo: { ice: 0, metal: 0, silicate: 0, rare: 0 },
  depletion: {},
  emergency: { cannibalize: 0, cannibalizeCargo: 0, beacon: 0 },
};

function expectSameReplay(compacted: readonly ActionEntry[], full: readonly ActionEntry[]): void {
  const a = replay(START, compacted);
  const b = replay(START, full);
  expect(Math.abs(a.tank.massKg - b.tank.massKg)).toBeLessThan(1e-6);
  expect(Math.abs(a.tank.capacityLossFrac - b.tank.capacityLossFrac)).toBeLessThan(1e-9);
  for (const r of RESOURCES) expect(Math.abs(a.cargo[r] - b.cargo[r])).toBeLessThan(1e-6);
  const ids = new Set([...Object.keys(a.depletion), ...Object.keys(b.depletion)]);
  expect(ids.size).toBeGreaterThan(0);
  for (const id of ids) {
    for (const r of RESOURCES) expect(Math.abs((a.depletion[id]?.[r] ?? 0) - (b.depletion[id]?.[r] ?? 0))).toBeLessThan(1e-6);
  }
  expect(a.emergency).toEqual(b.emergency);
}

/** `n` events of every kind, in a fixed rotation, through the real channels. */
function play(j: ActionJournal, n: number, from = 0): void {
  for (let i = from; i < from + n; i++) {
    const r = RESOURCES[i % 4]!;
    switch (i % 6) {
      case 0:
        propellant({ kind: 'jump', distanceLy: i % 13 }, 800 + (i % 7));
        break;
      case 1:
        mineAction(r, 10 + (i % 3) * 0.25);
        break;
      case 2:
        j.noteMined(mined({ id: `gx-test:f0:a${i % 50}`, resource: r, kg: 10 + (i % 3) * 0.25 }));
        break;
      case 3:
        if (i % 3 === 0) bus.emit('emergency:used', { kind: 'cannibalize', timesUsed: 1 + (i % 4) });
        else bus.emit('emergency:used', { kind: i % 3 === 1 ? 'beacon' : 'cannibalize-cargo' });
        break;
      case 4:
        j.noteThrust(1_000, 999.5 - (i % 5) * 0.1, 0);
        break;
      case 5:
        propellant({ kind: 'jump', distanceLy: 900 }, 0, false);
        break;
    }
  }
}

describe('compaction (MAX_ACTIONS)', () => {
  it('Given MAX_ACTIONS, Then it is 5 000', () => {
    expect(MAX_ACTIONS).toBe(5_000);
  });

  it('Given 5 001 entries, When compact, Then 5 000 remain — the oldest folded into one checkpoint — with the same sums', () => {
    const { j } = journal();
    play(j, 5_001);
    j.compact();
    const out = j.drain();
    j.dispose();
    expect(out).toHaveLength(5_000);
    expect(out[0]!.source).toBe('checkpoint');
    expect(out.filter((e) => e.source === 'checkpoint')).toHaveLength(1);
    // Rebuild the uncompacted history independently and compare its sums.
    const plain = journal();
    play(plain.j, 5_001);
    expectSameReplay(out, plain.j.drain());
  });

  it('Given a compacted log, Then the checkpoint names the last seq it absorbed, and every later entry keeps its own, higher seq', () => {
    const { j } = journal();
    play(j, 5_001);
    j.compact();
    const out = j.drain();
    const cp = out[0]!;
    if (cp.source !== 'checkpoint') throw new Error('expected a checkpoint first');
    expect(cp.payload.upToSeq).toBeLessThan(out[1]!.seq);
    expectStrictlyRising(seqsOf(out.slice(1)));
    expect(new Set(seqsOf(out)).size).toBe(out.length);
    expectValid(out);
  });

  it('Given exactly 5 000 entries, When compact, Then nothing changes (no checkpoint)', () => {
    const { j } = journal();
    play(j, 5_000);
    j.compact();
    const out = j.drain();
    expect(out).toHaveLength(5_000);
    expect(out.some((e) => e.source === 'checkpoint')).toBe(false);
  });

  it('Given a log that already starts with a checkpoint, When it grows past 5 000 and is compacted again, Then still 5 000, ONE checkpoint, the same sums', () => {
    const { j } = journal();
    play(j, 5_001);
    j.compact();
    play(j, 37, 5_001);
    j.compact();
    const out = j.drain();
    j.dispose();
    expect(out).toHaveLength(5_000);
    expect(out[0]!.source).toBe('checkpoint');
    expect(out.filter((e) => e.source === 'checkpoint')).toHaveLength(1);
    const plain = journal();
    play(plain.j, 5_038);
    expectSameReplay(out, plain.j.drain());
    expectValid(out);
  });
});

// --- the hook ordering problem ---------------------------------------------------

describe('WorldState feeds the journal through a hook (onMined)', () => {
  it('Given a WorldState with onMined, When recordMined, Then the hook gets the stamped entry once', () => {
    const seen: MinedEntry[] = [];
    const ws = new WorldState({ orbitSeconds: () => 7, wallMs: () => 1_800_000_000_000, onMined: (e: MinedEntry) => seen.push(e) });
    ws.recordMined('gx-test:f0:a1', 'ice', 2_000, 'local');
    expect(seen).toEqual([{ id: 'gx-test:f0:a1', by: 'local', resource: 'ice', kg: 2_000, orbitSeconds: 7, wallMs: 1_800_000_000_000 }]);
  });

  it('Given a refused recordMined (NaN or negative kg), Then the hook is not called', () => {
    const seen: MinedEntry[] = [];
    const ws = new WorldState({ orbitSeconds: () => 0, wallMs: () => 0, onMined: (e: MinedEntry) => seen.push(e) });
    ws.recordMined('a', 'ice', Number.NaN, 'local');
    ws.recordMined('a', 'ice', -1, 'local');
    expect(seen).toEqual([]);
  });

  it('Given a WorldState.restore (loading a save), Then the hook is NOT called — what was mined is already in the saved log', () => {
    const seen: MinedEntry[] = [];
    const ws = new WorldState({ orbitSeconds: () => 0, wallMs: () => 0, onMined: (e: MinedEntry) => seen.push(e) });
    ws.restore([mined(), mined({ id: 'gx-test:f0:a2' })]);
    expect(seen).toEqual([]);
  });
});

class StubInput {
  private presses = new Set<ActionName>();
  pressKey(code: string): void {
    const a = actionForKey(code);
    if (a) this.presses.add(a);
  }
  pressed(a: ActionName): boolean {
    return this.presses.has(a);
  }
  held(): boolean {
    return false;
  }
  isDown(): boolean {
    return false;
  }
  setThrottle(): void {}
  endFrame(): void {
    this.presses.clear();
  }
}

/** The real Mining over a real Belt in Fyss, its WorldState hooked to a journal. */
function miningRig() {
  const { j } = journal();
  const belt0 = { system: startSystem(), orbitSeconds: 0, flight: { worldPosition: new Vector3() } };
  const worldState = new WorldState({
    orbitSeconds: () => belt0.orbitSeconds,
    wallMs: () => 1_800_000_000_000,
    onMined: (e: MinedEntry) => j.noteMined(e),
  });
  const belt = new Belt({ universe: belt0, worldState });
  const bctx = nodeCtx();
  const frame = (): void => belt.update(1 / 60, bctx);
  frame();
  const ast: AsteroidSpec | undefined = fyssField(0).asteroids.find((a) => a.composition.ice >= 4_000);
  if (!ast) throw new Error('fixture: no asteroid in Fyss field 0 with ≥ 4 t ice');
  const astWorld = new Vector3();
  const astVel = new Vector3();
  if (!belt.asteroidWorld(ast.id, astWorld) || !belt.asteroidVelocity(ast.id, astVel)) {
    throw new Error('fixture: the belt does not know the asteroid');
  }
  belt0.flight.worldPosition.copy(astWorld).add(new Vector3(ast.radiusKm + 0.2, 0, 0));
  frame();

  const tank = new Propellant(PROBE_TANK_CAPACITY_KG, 0.5);
  const hold = new Cargo(CARGO_CAPACITY_KG);
  const world = {
    paused: false as boolean,
    frozen: false as boolean,
    simulatedSeconds: 0,
    cargo: hold,
    flight: { propellant: tank, worldPosition: belt0.flight.worldPosition, velocity: astVel.clone() },
    shipParent: null as { worldVelocity: Vector3 } | null,
  } satisfies MiningWorld;
  const mining = new Mining({
    universe: world,
    belt,
    worldState,
    targeting: { targetId: ast.id },
    cruise: { busy: false },
    warp: { phase: 'idle' },
  });
  const input = new StubInput();
  const ctx = { input, elapsed: 0 } as unknown as EngineContext;
  mining.init?.(ctx);
  offs.push(() => mining.dispose?.());
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      world.simulatedSeconds = 1 / 60;
      frame();
      mining.update(1 / 60, ctx);
      input.endFrame();
    }
  };
  return { j, ast, mining, input, tick, worldState };
}

describe('ordering: a completed mine is in the journal whole', () => {
  it('Given a mine completes, Then the journal has the cargo action AND the mined entry before any save is built (recordMined comes after cargo:action)', () => {
    const r = miningRig();
    r.input.pressKey(MINING_KEYS.mine);
    r.tick(1);
    expect(r.mining.busy).not.toBeNull();
    r.tick(240);
    expect(r.mining.busy).toBeNull();
    expect(r.worldState.entries()).toHaveLength(1);
    // Straight after the completing frame — nothing else has run.
    const out = r.j.drain();
    expect(out.map((e) => e.source)).toEqual(['cargo', 'mined']);
    expect(out[0]!.payload).toMatchObject({ action: { kind: 'mine', asteroidId: r.ast.id, resource: 'ice', kg: 2_000 }, result: { ok: true } });
    expect(out[1]!.payload).toEqual({ id: r.ast.id, by: 'local', resource: 'ice', kg: 2_000 });
    expect(out[1]!.seq).toBeGreaterThan(out[0]!.seq);
    expectValid(out);
  });

  it('Given a mine aborted midway, Then the journal holds neither half', () => {
    const r = miningRig();
    r.input.pressKey(MINING_KEYS.mine);
    r.tick(120);
    bus.emit('ship:recovered', { cause: 'beacon' });
    r.tick(300);
    expect(r.j.drain().filter((e) => e.source === 'cargo' || e.source === 'mined')).toEqual([]);
  });
});

// v4-save Task 5, R13/R14 M1 — noteEmergency is the one source of an exit's
// entry; the emergency:used that follows is not logged again. A claim never
// outlives a drain: a hook whose emit never came must not swallow a later,
// unrelated emergency:used.
describe('R13/R14 — noteEmergency and its claim', () => {
  it('Given noteEmergency(beacon), When its emergency:used follows, Then the drain holds exactly one beacon entry — the noted one, same seq', () => {
    const { j } = journal();
    const noted = j.noteEmergency({ kind: 'beacon' });
    expect(noted).not.toBeNull();
    bus.emit('emergency:used', { kind: 'beacon' });
    const out = j.drain().filter((e) => e.source === 'emergency');
    expect(out).toHaveLength(1);
    expect(out[0]!.seq).toBe(noted!.seq);
  });

  it('M1: Given noteEmergency(beacon) whose emit never came, When the journal is drained and a beacon is then announced on the bus, Then that beacon IS logged', () => {
    const { j } = journal();
    j.noteEmergency({ kind: 'beacon' });
    j.drain();
    bus.emit('emergency:used', { kind: 'beacon' });
    expect(j.drain().filter((e) => e.source === 'emergency')).toHaveLength(1);
  });
});

// =============================================================================
// Task 7 — gaps the mutation run found (J1–J13).
// =============================================================================

function thrustEntry(seq: number, over: Partial<ActionEntry> = {}): ActionEntry {
  return { seq, source: 'thrust', payload: { kg: 1 }, wallMs: 1_000 + seq, orbitSeconds: seq, ...over } as ActionEntry;
}

function cannibalizeEntry(seq: number, kind: 'cannibalize' | 'cannibalize-cargo', timesUsed: number): ActionEntry {
  return { seq, source: 'emergency', payload: { kind, timesUsed }, wallMs: 1_000 + seq, orbitSeconds: seq };
}

describe('Task 7 — the books ignore non-finite named amounts (J1)', () => {
  it('J1: Given baseline 100, a NaN tankDeltaKg, a -10 spend and an ok cargo action with fuelKg NaN, When settleThrust(70, 100), Then thrust of 20 kg is drained', () => {
    const { j } = journal();
    j.setBaseline(100);
    bus.emit('propellant:action', { action: { kind: 'beacon' }, ok: true, kg: 0, tankDeltaKg: Number.NaN });
    propellant({ kind: 'beacon' }, 10);
    cargo({ kind: 'refine' }, okResult({ fuelKg: Number.NaN }));
    j.settleThrust(70, 100);
    const thrusts = j.drain().filter((e) => e.source === 'thrust');
    expect(thrusts).toHaveLength(1);
    expect((thrusts[0]!.payload as { kg: number }).kg).toBeCloseTo(20, 9);
  });
});

describe('Task 7 — a noted emergency is claimed exactly once, by kind AND timesUsed (J2)', () => {
  it('J2a: Given noteEmergency(beacon), When emergency:used cannibalize-cargo arrives (both timesUsed undefined), Then it is logged too', () => {
    const { j } = journal();
    j.noteEmergency({ kind: 'beacon' });
    bus.emit('emergency:used', { kind: 'cannibalize-cargo' });
    const out = j.drain();
    expect(out).toHaveLength(2);
    expectStrictlyRising(seqsOf(out));
  });

  it('J2b: Given noteEmergency(cannibalize, timesUsed 1), When emergency:used cannibalize timesUsed 2 arrives, Then it is logged too', () => {
    const { j } = journal();
    j.noteEmergency({ kind: 'cannibalize', timesUsed: 1 });
    bus.emit('emergency:used', { kind: 'cannibalize', timesUsed: 2 });
    expect(j.drain()).toHaveLength(2);
  });

  it('J2c: Given one noteEmergency(beacon) and TWO emergency:used beacon, Then the drain holds 2 entries — a claim is consumed once', () => {
    const { j } = journal();
    j.noteEmergency({ kind: 'beacon' });
    bus.emit('emergency:used', { kind: 'beacon' });
    bus.emit('emergency:used', { kind: 'beacon' });
    expect(j.drain()).toHaveLength(2);
  });
});

describe('Task 7 — dispose (J3, J4)', () => {
  it('J3: Given the journal subscribed to the bus, When it is disposed, Then every unsubscribe it was handed is called exactly once', () => {
    const real = bus.on.bind(bus);
    const captured: Array<ReturnType<typeof vi.fn>> = [];
    const spy = vi.spyOn(bus, 'on').mockImplementation(((event: never, fn: never) => {
      const off = vi.fn(real(event, fn));
      captured.push(off);
      return off;
    }) as never);
    try {
      const { clock } = handClock();
      const j = new ActionJournal(clock);
      expect(captured.length).toBeGreaterThan(0);
      j.dispose();
      for (const off of captured) expect(off).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('J4: Given a disposed journal, When noteThrust and settleThrust run, Then nothing is logged', () => {
    const { j } = journal();
    j.dispose();
    j.noteThrust(100, 50, 0);
    j.settleThrust(50, 100);
    expect(j.drain()).toEqual([]);
  });
});

describe('Task 7 — noteThrust refuses what is not a number, and dust (J5, J6)', () => {
  it('J5: Given a non-finite tank before or after, When noteThrust runs, Then nothing is logged and no gain is counted', () => {
    const { j } = journal();
    j.noteThrust(Number.POSITIVE_INFINITY, 10, 0);
    j.noteThrust(10, Number.POSITIVE_INFINITY, 0);
    expect(j.drain()).toEqual([]);
    expect(j.unexplainedGainKg).toBe(0);
  });

  it('J6: Given a remainder of ±1e-12 kg (float dust), When noteThrust runs, Then it is neither a burn nor a gain', () => {
    const { j } = journal();
    j.noteThrust(100, 100 - 1e-12, 0);
    j.noteThrust(100, 100 + 1e-12, 0);
    expect(j.drain()).toEqual([]);
    expect(j.unexplainedGainKg).toBe(0);
  });
});

describe('Task 7 — the baseline must be a finite number (J7)', () => {
  for (const [what, v] of [['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY]] as const) {
    it(`J7: Given setBaseline(${what}), When settleThrust(50, 100), Then one thrust of 50 kg — the opening mass stands in`, () => {
      const { j } = journal();
      j.setBaseline(v);
      j.settleThrust(50, 100);
      const out = j.drain();
      expect(out).toHaveLength(1);
      expect(out[0]!.source).toBe('thrust');
      expect((out[0]!.payload as { kg: number }).kg).toBe(50);
    });
  }
});

describe('Task 7 — peek is a copy (J8)', () => {
  it('J8: Given one noted entry, When peek() is held and another action is noted, Then the held array is unchanged', () => {
    const { j } = journal();
    j.noteMined(mined());
    const p = j.peek();
    expect(p).toHaveLength(1);
    j.noteMined(mined({ id: 'gx-test:f0:a2' }));
    expect(p).toHaveLength(1);
    expect(j.peek()).toHaveLength(2);
  });
});

describe('Task 7 — restore forgets the other timeline (J9, J10)', () => {
  it('J9a: Given a noted beacon whose emit never came, When restore([]) and a beacon is announced, Then it is logged (the claim was cleared)', () => {
    const { j } = journal();
    j.noteEmergency({ kind: 'beacon' });
    j.restore([]);
    bus.emit('emergency:used', { kind: 'beacon' });
    expect(j.drain()).toHaveLength(1);
  });

  it('J9b: Given baseline 100 and a -10 spend, When restore([]) and settleThrust(70, 100), Then thrust is 30 (the stale -10 is gone)', () => {
    const { j } = journal();
    j.setBaseline(100);
    propellant({ kind: 'beacon' }, 10);
    j.restore([]);
    j.settleThrust(70, 100);
    const out = j.drain();
    expect(out).toHaveLength(1);
    expect((out[0]!.payload as { kg: number }).kg).toBeCloseTo(30, 9);
  });

  it('J10: Given a restored checkpoint whose upToSeq (10) exceeds its seq (3), When a mine is noted, Then its seq is 11', () => {
    const { j } = journal();
    const checkpoint = {
      seq: 3,
      source: 'checkpoint',
      payload: {
        upToSeq: 10,
        tankNetKg: 0,
        capacityLossNetFrac: 0,
        cargoNetKg: { ice: 0, metal: 0, silicate: 0, rare: 0 },
        minedByAsteroid: {},
        emergency: { cannibalize: 0, cannibalizeCargo: 0, beacon: 0 },
        lastCannibalizeTimesUsed: 0,
      },
      wallMs: 1,
      orbitSeconds: 1,
    } as ActionEntry;
    j.restore([checkpoint]);
    j.noteMined(mined());
    expect(j.drain()[0]!.seq).toBe(11);
  });
});

describe('Task 7 — compactEntries edges (J11–J13)', () => {
  it('J11a: Given max 0, When one entry is compacted, Then it comes back as it is (at least one is kept)', () => {
    const e1 = thrustEntry(1);
    expect(compactEntries([e1], 0)).toEqual([e1]);
  });

  it('J11b: Given 5 entries and a fractional max 2.5, When compacted, Then 2 entries remain (the max is floored)', () => {
    const entries = [1, 2, 3, 4, 5].map((n) => thrustEntry(n));
    expect(compactEntries(entries, 2.5)).toHaveLength(2);
  });

  it('J12: Given a cannibalize (timesUsed 1) then a cannibalize-cargo (timesUsed 3), When folded, Then lastCannibalizeTimesUsed is 1', () => {
    const entries = [cannibalizeEntry(1, 'cannibalize', 1), cannibalizeEntry(2, 'cannibalize-cargo', 3), thrustEntry(3), thrustEntry(4), thrustEntry(5)];
    const out = compactEntries(entries, 3);
    const cp = out[0]!;
    expect(cp.source).toBe('checkpoint');
    if (cp.source === 'checkpoint') expect(cp.payload.lastCannibalizeTimesUsed).toBe(1);
  });

  it('J13: Given entries with different clocks folded at max 2, Then the checkpoint carries the clocks of the LAST absorbed entry', () => {
    const entries = [1, 2, 3, 4].map((n) => thrustEntry(n, { wallMs: 5_000 + n * 10, orbitSeconds: n * 100 }));
    const out = compactEntries(entries, 2);
    expect(out).toHaveLength(2);
    expect(out[0]!.source).toBe('checkpoint');
    expect(out[0]!.wallMs).toBe(5_030);
    expect(out[0]!.orbitSeconds).toBe(300);
  });
});
