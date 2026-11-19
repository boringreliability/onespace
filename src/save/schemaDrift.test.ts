/**
 * The save schemas cannot drift from the runtime types they mirror (R4).
 *
 * The schemas are strict whitelists, written by hand next to types that live
 * elsewhere (Log.ts, worldState.ts, travelCost.ts, cargo.ts, EventBus.ts). If
 * one of those types grows a variant — a new PropellantAction kind, a new
 * CargoResult reason — `tsc` stays green and the strict schema quietly starts
 * rejecting real saves. Two guards:
 *
 *  1. Type level (fails `npx tsc --noEmit`): every runtime type must be
 *     assignable to its schema's `z.input`.
 *  2. Runtime: real outputs — every PropellantAction kind through
 *     `applyAction`, every CargoResult reason through `applyCargoAction`, each
 *     `emergency:used`, a real WorldState entry and real ShipLog entries — are
 *     fed through the schemas.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { bus, type GameEvents } from '@/core/EventBus';
import { ShipLog, type LogEntry } from '@/game/Log';
import { WorldState, type MinedEntry } from '@/game/worldState';
import type { PlanetSpec, ScanResult, StarSystemSpec } from '@/gen/types';
import { Cargo, CARGO_CAPACITY_KG, applyCargoAction, type CargoAction, type CargoResult } from '@/ship/cargo';
import { PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
import { applyAction, type PropellantAction } from '@/ship/travelCost';

import { ActionEntrySchema, LogEntrySchema, LogSchema, MinedEntrySchema } from './schema';

// --- 1. type level -----------------------------------------------------------

/** `true` iff A is assignable to B (non-distributive). */
type Extends<A, B> = [A] extends [B] ? true : false;
/** Compiles only when T is `true`. */
type Assert<T extends true> = T;

type EntryIn = z.input<typeof ActionEntrySchema>;
type PayloadIn<S extends EntryIn['source']> = Extract<EntryIn, { source: S }>['payload'];

export type DriftGuards = [
  Assert<Extends<LogEntry, z.input<typeof LogEntrySchema>>>,
  Assert<Extends<MinedEntry, z.input<typeof MinedEntrySchema>>>,
  Assert<Extends<PropellantAction, PayloadIn<'propellant'>['action']>>,
  Assert<Extends<GameEvents['propellant:action'], PayloadIn<'propellant'>>>,
  Assert<Extends<CargoAction, PayloadIn<'cargo'>['action']>>,
  Assert<Extends<CargoResult, PayloadIn<'cargo'>['result']>>,
  Assert<Extends<GameEvents['cargo:action'], PayloadIn<'cargo'>>>,
  Assert<Extends<GameEvents['emergency:used'], PayloadIn<'emergency'>>>,
];

// --- 2. runtime ---------------------------------------------------------------

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

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  bus.clear();
});

let seq = 0;
function asEntry(source: string, payload: unknown) {
  seq += 1;
  return { seq, source, payload, wallMs: 1762891200000, orbitSeconds: 5412.25 };
}

/** The issues of a failed parse, for a readable failure message. */
function issuesOf(r: { success: boolean; error?: { issues: unknown[] } }): unknown[] {
  return r.success ? [] : (r.error?.issues ?? []);
}

describe('runtime drift — propellant:action, every PropellantAction kind', () => {
  /** Exhaustive at compile time: a new kind without a case here fails tsc. */
  const KINDS = {
    'cruise-spool': { kind: 'cruise-spool' },
    'cruise-leg': { kind: 'cruise-leg', distanceKm: 1.2e8 },
    jump: { kind: 'jump', distanceLy: 12.5 },
    cannibalize: { kind: 'cannibalize', part: 'tank', timesUsed: 1 },
    beacon: { kind: 'beacon' },
    'jump-refund': { kind: 'jump-refund', kg: 400 },
    'spool-refund': { kind: 'spool-refund', kg: 60 },
  } satisfies { [K in PropellantAction['kind']]: Extract<PropellantAction, { kind: K }> };

  for (const fill of [0.6, 0, 1]) {
    it(`Given a tank at fill ${fill}, When every PropellantAction kind is applied, Then each announced event parses as a propellant ActionEntry`, () => {
      const seen: GameEvents['propellant:action'][] = [];
      bus.on('propellant:action', (e) => seen.push(e));
      for (const a of Object.values(KINDS)) applyAction(new Propellant(PROBE_TANK_CAPACITY_KG, fill), a);
      expect(seen).toHaveLength(Object.keys(KINDS).length);
      for (const e of seen) {
        const r = ActionEntrySchema.safeParse(asEntry('propellant', e));
        expect(r.success, JSON.stringify({ e, issues: issuesOf(r) })).toBe(true);
      }
    });
  }
});

describe('runtime drift — cargo:action, every CargoResult reason and every success', () => {
  /** Exhaustive at compile time: a new reason without an entry here fails tsc. */
  const REASONS = {
    'hold-full': true,
    'nothing-to-refine': true,
    'tank-full': true,
    insufficient: true,
    'nothing-to-repair': true,
    empty: true,
    'not-empty': true,
    'no-tank': true,
    invalid: true,
  } satisfies Record<NonNullable<CargoResult['reason']>, true>;

  function hold(contents: Partial<Record<'ice' | 'metal' | 'silicate' | 'rare', number>>): Cargo {
    const c = new Cargo(CARGO_CAPACITY_KG);
    c.restore(contents);
    return c;
  }
  function tank(fill: number, lossFrac = 0): Propellant {
    const p = new Propellant(PROBE_TANK_CAPACITY_KG, fill);
    p.capacityLossFrac = lossFrac;
    return p;
  }

  const cases: Array<{ name: string; run: () => CargoResult }> = [
    { name: 'mine ok', run: () => applyCargoAction(hold({}), tank(0.5), { kind: 'mine', asteroidId: 'ast:s:398:4', resource: 'rare', kg: 3 }) },
    { name: 'mine invalid', run: () => applyCargoAction(hold({}), tank(0.5), { kind: 'mine', asteroidId: 'ast:s:398:4', resource: 'ice', kg: -1 }) },
    { name: 'mine hold-full', run: () => applyCargoAction(hold({ ice: CARGO_CAPACITY_KG }), tank(0.5), { kind: 'mine', asteroidId: 'ast:s:398:4', resource: 'ice', kg: 10 }) },
    { name: 'refine ok', run: () => applyCargoAction(hold({ ice: 1000 }), tank(0.3), { kind: 'refine' }) },
    { name: 'refine no-tank', run: () => applyCargoAction(hold({ ice: 1000 }), null, { kind: 'refine' }) },
    { name: 'refine nothing-to-refine', run: () => applyCargoAction(hold({}), tank(0.3), { kind: 'refine' }) },
    { name: 'refine tank-full', run: () => applyCargoAction(hold({ ice: 1000 }), tank(1), { kind: 'refine' }) },
    { name: 'repair ok', run: () => applyCargoAction(hold({ metal: 700, silicate: 500 }), tank(0.5, 0.1), { kind: 'repair' }) },
    { name: 'repair nothing-to-repair', run: () => applyCargoAction(hold({ metal: 700, silicate: 500 }), tank(0.5), { kind: 'repair' }) },
    { name: 'repair insufficient', run: () => applyCargoAction(hold({}), tank(0.5, 0.1), { kind: 'repair' }) },
    { name: 'jettison-all ok', run: () => applyCargoAction(hold({ silicate: 40 }), tank(0.5), { kind: 'jettison-all' }) },
    { name: 'jettison-all empty', run: () => applyCargoAction(hold({}), tank(0.5), { kind: 'jettison-all' }) },
    { name: 'cannibalize-cargo ok', run: () => applyCargoAction(hold({ ice: 2000 }), tank(0), { kind: 'cannibalize-cargo' }) },
    { name: 'cannibalize-cargo not-empty', run: () => applyCargoAction(hold({ ice: 2000 }), tank(0.5), { kind: 'cannibalize-cargo' }) },
    { name: 'cannibalize-cargo insufficient', run: () => applyCargoAction(hold({ ice: 10 }), tank(0), { kind: 'cannibalize-cargo' }) },
    { name: 'cannibalize-cargo tank-full (no capacity left)', run: () => applyCargoAction(hold({ ice: 2000 }), tank(0, 1), { kind: 'cannibalize-cargo' }) },
  ];

  it('Given every cargo action on its success path and every refusal path, Then every reason is reached and each announced event parses as a cargo ActionEntry', () => {
    const seen: GameEvents['cargo:action'][] = [];
    bus.on('cargo:action', (e) => seen.push(e));
    const results = cases.map((c) => ({ name: c.name, r: c.run() }));

    const reasons = new Set(results.map((x) => x.r.reason).filter((x) => x !== undefined));
    expect([...reasons].sort()).toEqual(Object.keys(REASONS).sort());
    for (const kind of ['mine', 'refine', 'repair', 'jettison-all', 'cannibalize-cargo']) {
      expect(seen.some((e) => e.action.kind === kind && e.result.ok), `${kind} succeeded once`).toBe(true);
    }

    expect(seen).toHaveLength(cases.length);
    for (const e of seen) {
      // Every result — every reason — must fit the schema (checked beside a known-good action).
      const result = ActionEntrySchema.safeParse(asEntry('cargo', { action: { kind: 'refine' }, result: e.result }));
      expect(result.success, JSON.stringify({ result: e.result, issues: issuesOf(result) })).toBe(true);
      // The whole event too — except `invalid`, which by definition carries the
      // invalid input (kg -1). It is never logged: only result.ok is (P3).
      if (e.result.reason === 'invalid') continue;
      const r = ActionEntrySchema.safeParse(asEntry('cargo', e));
      expect(r.success, JSON.stringify({ e, issues: issuesOf(r) })).toBe(true);
    }
  });
});

describe('runtime drift — emergency:used, each kind', () => {
  const EVENTS = {
    cannibalize: { kind: 'cannibalize', timesUsed: 1 },
    'cannibalize-cargo': { kind: 'cannibalize-cargo' },
    beacon: { kind: 'beacon' },
  } satisfies { [K in GameEvents['emergency:used']['kind']]: GameEvents['emergency:used'] & { kind: K } };

  it('Given an emergency:used of each kind, When announced on the bus, Then each parses as an emergency ActionEntry', () => {
    const seen: GameEvents['emergency:used'][] = [];
    bus.on('emergency:used', (e) => seen.push(e));
    for (const e of Object.values(EVENTS)) bus.emit('emergency:used', e);
    expect(seen).toHaveLength(3);
    for (const e of seen) {
      const r = ActionEntrySchema.safeParse(asEntry('emergency', e));
      expect(r.success, JSON.stringify({ e, issues: issuesOf(r) })).toBe(true);
    }
  });
});

describe('runtime drift — WorldState.recordMined', () => {
  it('Given a real WorldState that mined each resource, Then every entry parses as a MinedEntry and (minus the clocks) as a mined ActionEntry payload', () => {
    const w = new WorldState({ orbitSeconds: () => 3300.5, wallMs: () => 1762890900000 });
    w.recordMined('ast:gx-1mwhji--377.-3.266.1:398:12', 'ice', 820, 'local');
    w.recordMined('ast:gx-1mwhji--377.-3.266.1:398:12', 'metal', 310.5, 'local');
    w.recordMined('ast:gx-1mwhji--377.-3.266.1:398:4', 'silicate', 95, 'local');
    w.recordMined('ast:gx-1mwhji--377.-3.266.1:398:4', 'rare', 2.25, 'local');
    expect(w.entries()).toHaveLength(4);
    for (const m of w.entries()) {
      const asWorld = MinedEntrySchema.safeParse(m);
      expect(asWorld.success, JSON.stringify(issuesOf(asWorld))).toBe(true);
      const { id, by, resource, kg } = m;
      const asAction = ActionEntrySchema.safeParse(asEntry('mined', { id, by, resource, kg }));
      expect(asAction.success, JSON.stringify(issuesOf(asAction))).toBe(true);
    }
  });
});

describe('runtime drift — ShipLog entries', () => {
  it('Given a real ShipLog that logged an arrival, a world, a contact, an asteroid note and a landing, Then every entry parses as a LogEntry and the log as a save log', () => {
    const log = new ShipLog();
    log.init();
    const system = {
      id: 'gx-1mwhji--377.-3.266.1',
      name: 'Fyss',
      stars: [{ spectralClass: 'K' }],
      planets: [{}, {}],
      blurb: 'A quiet orange star with a working belt.',
    } as unknown as StarSystemSpec;
    const planet = {
      id: 'gx-1mwhji--377.-3.266.1:p2',
      name: 'Remit 31 / Fyss',
      type: 'rocky',
      gravity: 9.1,
      blurb: 'The lights never go out.',
    } as PlanetSpec;
    const scan = (targetId: string, name: string, kind?: ScanResult['kind']): ScanResult => ({
      targetId,
      name,
      lines: ['class .......... rocky'],
      kind,
    });

    bus.emit('system:entered', { system });
    log.update(42.5);
    bus.emit('scan:complete', scan(planet.id, planet.name, 'world'));
    bus.emit('scan:complete', scan('vessel-77', 'kestrel', 'vessel'));
    bus.emit('scan:complete', scan('ast:gx-1mwhji--377.-3.266.1:398:12', 'asteroid 398-12', 'asteroid'));
    bus.emit('scan:complete', scan('ast:gx-1mwhji--377.-3.266.1:398:12', 'asteroid 398-12', 'asteroid'));
    log.update(600);
    bus.emit('planet:landed', { planet });

    const kinds = new Set(log.all().map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['arrival', 'contact', 'landing', 'note', 'world']);
    for (const e of log.all()) {
      const r = LogEntrySchema.safeParse(e);
      expect(r.success, JSON.stringify({ e, issues: issuesOf(r) })).toBe(true);
    }
    // Round-tripped through JSON, as the sink will store it.
    const asSaved = LogSchema.safeParse(JSON.parse(JSON.stringify({ time: 642.5, entries: log.all() })));
    expect(asSaved.success, JSON.stringify(issuesOf(asSaved))).toBe(true);
  });
});
