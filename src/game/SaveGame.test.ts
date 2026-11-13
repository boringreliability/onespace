/**
 * v4 sub-plan 3 (local save), Task 5 — `SaveGame`: autosave, manual save and
 * the emergency exit first.
 *
 * SaveGame is the ONLY writer (Global Constraints). It runs against a REAL
 * Universe in Fyss (as capture.test.ts), a real ShipLog, WorldState,
 * Emergency, ActionJournal, a memory SaveStore and a real WAL on an in-memory
 * localStorage.
 *
 * The surface these tests pin:
 *
 *   new SaveGame({
 *     world: SaveWorld,                 // with cruise and input wired
 *     store: SaveStore,
 *     wal: Wal,
 *     lock: WriterLock,                 // resolved: writer or reader
 *     page: { document, window },       // visibilitychange / pagehide targets
 *   })
 *   .name === 'save'                    // gated to flight + map (gating.ts)
 *   .init() / .update(dt, ctx) / .dispose()
 *   .saveNow(reason): Promise<boolean>
 *   .status: 'idle' | 'saving' | 'disabled'
 *   .critical(used): void               // R2: the synchronous WAL hook
 *
 * `Emergency` takes `critical` in its options and `RecoveryCut` takes it as
 * its third argument; both call it on the paying code path, after the price
 * is paid and BEFORE any event of that action (log, ship:recovered,
 * emergency:used) — not from a bus listener.
 *
 * Carried obligations (Task 3/4 reviews), each pinned below:
 *  1. journal.setBaseline(tank) at init and whenever the tank changes;
 *  2. registry wires onMined → journal, the real Cruise and the engine Input;
 *  3. a failed store write keeps the built save as prev — nothing drained is lost;
 *  4. order: capture → wal.writeSnapshot → store.save → wal.clear(revision);
 *     a writeSnapshot false is not read as "the old snapshot is intact";
 *  5. R2: the WAL holds the emergency entry BEFORE ship:recovered;
 *  6. only the writer writes; a reader shows the disabled text, touches nothing;
 *  7. revisions rise strictly across every save, pagehide included;
 *  8. 120 s interval, 5 s gap, hidden → IDB save, pagehide → WAL snapshot.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import type { ActionName } from '@/core/Input';
import { modes, type BaseMode } from '@/core/Modes';
import { Emergency } from '@/game/Emergency';
import { ShipLog } from '@/game/Log';
import { Mining, type MiningOptions } from '@/game/Mining';
import { RecoveryCut } from '@/game/RecoveryCut';
import { Universe } from '@/game/Universe';
import { fyssField, nodeCtx } from '@/game/testing/beltFixture';
import { WorldState, type MinedEntry } from '@/game/worldState';
import type { AsteroidSpec } from '@/gen/belt';
import { applyCargoAction } from '@/ship/cargo';
import { EXHAUST_VELOCITY_KMS, PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
import { ActionJournal, MAX_ACTIONS } from '@/save/actionJournal';
import { decideBoot } from '@/save/boot';
import { loadForBoot } from '@/save/bootLoad';
import type { SaveWorld } from '@/save/capture';
import { memoryStore } from '@/save/memoryStore';
import { SaveV1Schema, type ActionEntry, type SaveV1 } from '@/save/schema';
import type { SaveStore } from '@/save/store';
import { WAL_KEY, WAL_SNAPSHOT_KEY, createWal, type Wal } from '@/save/wal';
import type { WriterLock } from '@/save/writerLock';
import { Pause } from '@/ui/Pause';
import { SaveGame } from './SaveGame';

/** Universe steps that need a GPU; everything else in update() runs for real. */
const RENDER_STEPS = ['streamRenderers', 'updateBodies', 'updateStar', 'publishMotionReference', 'refreshAtmosphere'];
const WALL = 1_800_000_000_000;
const DISABLED_TEXT = 'SAVING DISABLED — OPEN IN ANOTHER TAB';

type CriticalUse = { kind: 'cannibalize' | 'cannibalize-cargo' | 'beacon'; timesUsed?: number };
type LogLine = { text: string; tone?: 'normal' | 'warn' | 'good' };

/** A localStorage that behaves like the real one (as in capture.test.ts). */
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

let storage: MemoryStorage;
const offs: Array<() => void> = [];

function toMode(m: BaseMode): void {
  if (modes.overlay) modes.pop();
  if (modes.base === m) return;
  if (!modes.can(m)) modes.go('flight');
  modes.go(m);
}

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(WALL);
  toMode('flight');
});
afterEach(() => {
  for (const off of offs.splice(0)) off();
  bus.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let the store's promises (and anything chained on them) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

function stubRender(u: Universe): void {
  const raw = u as unknown as Record<string, unknown>;
  for (const k of RENDER_STEPS) raw[k] = () => undefined;
}

// --- the live game ------------------------------------------------------------

interface Live {
  u: Universe;
  ctx: EngineContext;
  w: SaveWorld;
  worldState: WorldState;
  shipLog: ShipLog;
  emergency: Emergency;
  journal: ActionJournal;
  /** Where Emergency's `critical` option leads (late-bound, as the registry will). */
  hook: { fn: ((u: CriticalUse) => void) | null };
  frames(seconds: number): void;
  press(action: ActionName): void;
}

/**
 * A live game at a new start in Fyss, wired as the registry must wire it:
 * WorldState's mines reach the journal through `onMined`, and Emergency's
 * `critical` hook leads (late-bound) to SaveGame.
 */
function live(): Live {
  const ctx = nodeCtx();
  const shipLog = new ShipLog();
  shipLog.init();
  const u = new Universe();
  const journal = new ActionJournal({ wallMs: () => Date.now(), orbitSeconds: () => u.orbitSeconds });
  const worldState = new WorldState({
    orbitSeconds: () => u.orbitSeconds,
    wallMs: () => Date.now(),
    onMined: (e: MinedEntry) => journal.noteMined(e),
  });
  u.init(ctx);
  stubRender(u);
  const hook: Live['hook'] = { fn: null };
  const emergency = new Emergency({
    universe: u,
    recovery: { active: false },
    warp: { phase: 'idle' },
    log: shipLog,
    critical: (used: CriticalUse) => hook.fn?.(used),
  } as ConstructorParameters<typeof Emergency>[0]);
  const w: SaveWorld = {
    universe: u,
    worldState,
    shipLog,
    emergency,
    journal,
    cruise: { flushLeg: () => undefined, reset: () => undefined },
    input: { setThrottle: () => undefined },
  };
  offs.push(() => {
    shipLog.dispose();
    journal.dispose();
  });
  return {
    u,
    ctx,
    w,
    worldState,
    shipLog,
    emergency,
    journal,
    hook,
    frames: (seconds) => {
      const n = Math.round(seconds * 60);
      for (let i = 0; i < n; i++) u.update(1 / 60, ctx);
    },
    press: (action) => {
      const input = { pressed: (a: ActionName) => a === action, setThrottle: () => undefined };
      emergency.update(1 / 60, { ...ctx, input } as unknown as EngineContext);
    },
  };
}

const ASTEROID = (): string => fyssField(0).asteroids[0]!.id;

/** Mine the way Mining completes one: the hold first (cargo:action), then the world. */
function mine(g: Live, asteroidId: string, resource: 'ice' | 'metal' | 'silicate' | 'rare', kg: number): void {
  const r = applyCargoAction(g.u.cargo, g.u.flight.propellant, { kind: 'mine', asteroidId, resource, kg });
  expect(r.ok).toBe(true);
  g.worldState.recordMined(asteroidId, resource, r.kgIn, 'local');
}

// --- the store, the WAL and the page --------------------------------------------

interface SpyStore {
  store: SaveStore;
  /** Saves the store accepted, in order (copies). */
  saved: SaveV1[];
  /** Every revision the store was asked to write, accepted or not, in order. */
  attempts: number[];
  failOnce(): void;
  /** Hold every write until the returned function is called. */
  hold(): () => void;
}

function spyStore(events?: string[]): SpyStore {
  const inner = memoryStore();
  const saved: SaveV1[] = [];
  const attempts: number[] = [];
  let fail = 0;
  let gate: Promise<void> | null = null;
  const store: SaveStore = {
    load: () => inner.load(),
    keepCorrupt: (raw, wallMs) => inner.keepCorrupt(raw, wallMs),
    async save(s) {
      events?.push(`store:${s.revision}`);
      attempts.push(s.revision);
      if (gate) await gate;
      if (fail > 0) {
        fail--;
        throw new Error('QuotaExceededError (test)');
      }
      await inner.save(s);
      saved.push(structuredClone(s));
    },
  };
  return {
    store,
    saved,
    attempts,
    failOnce: () => {
      fail = 1;
    },
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        gate = null;
        release();
      };
    },
  };
}

/** The real WAL on this test's storage, with every write recorded in `events`. */
function recordingWal(events: string[], over: Partial<Wal> = {}): Wal {
  const base = createWal(storage as unknown as Storage);
  return {
    appendCritical: (e) => {
      events.push(`append:${e.seq}`);
      return base.appendCritical(e);
    },
    writeSnapshot: (s) => {
      events.push(`snapshot:${s.revision}`);
      return over.writeSnapshot ? over.writeSnapshot(s) : base.writeSnapshot(s);
    },
    read: () => base.read(),
    readTagged: () => base.readTagged(),
    clear: (n) => {
      events.push(`clear:${n}`);
      base.clear(n);
    },
    // R25 I4a: interface-forced passthrough (as readTagged in R19); records `cover:N`.
    markCovered: (s: SaveV1) => {
      events.push(`cover:${s.revision}`);
      return (base as unknown as { markCovered(s: SaveV1): boolean }).markCovered(s);
    },
  } as Wal;
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
}

interface Rig {
  g: Live;
  sg: SaveGame;
  s: SpyStore;
  wal: Wal;
  lock: WriterLock & { released: number };
  logs: LogLine[];
  tick(dt?: number): void;
  /** Play `seconds` of SaveGame updates in `step` s frames. */
  play(seconds: number, step?: number): void;
  hide(): void;
  show(): void;
  pagehide(): void;
}

function rig(
  o: { g?: Live; writer?: boolean; store?: SpyStore; wal?: Wal; init?: boolean; extra?: Record<string, unknown> } = {},
): Rig {
  const g = o.g ?? live();
  const s = o.store ?? spyStore();
  const wal = o.wal ?? createWal(storage as unknown as Storage);
  const lock = {
    writer: o.writer ?? true,
    released: 0,
    release() {
      lock.released++;
    },
  };
  const doc = new FakeDocument();
  const win = new EventTarget();
  const sg = new SaveGame({
    world: g.w,
    store: s.store,
    wal,
    lock,
    page: { document: doc, window: win },
    ...o.extra,
  } as unknown as ConstructorParameters<typeof SaveGame>[0]);
  if (!o.g) g.hook.fn = (used) => sg.critical(used);
  const logs: LogLine[] = [];
  offs.push(bus.on('log', (l) => logs.push(l)));
  if (o.init !== false) sg.init();
  offs.push(() => sg.dispose());
  const tick = (dt = 1 / 60): void => sg.update(dt, g.ctx);
  return {
    g,
    sg,
    s,
    wal,
    lock,
    logs,
    tick,
    play: (seconds, step = 0.5) => {
      const n = Math.round(seconds / step);
      for (let i = 0; i < n; i++) tick(step);
    },
    hide: () => {
      doc.visibilityState = 'hidden';
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    show: () => {
      doc.visibilityState = 'visible';
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    pagehide: () => {
      win.dispatchEvent(new Event('pagehide'));
    },
  };
}

const landed = (g: Live): void => bus.emit('planet:landed', { planet: g.u.system.planets[0]! });
const isMined = (e: ActionEntry): boolean => e.source === 'mined';
const isCargoMine = (e: ActionEntry): boolean =>
  e.source === 'cargo' && (e.payload as { action: { kind: string } }).action.kind === 'mine';
const emergencyEntries = (actions: readonly ActionEntry[], kind: string): ActionEntry[] =>
  actions.filter((e) => e.source === 'emergency' && (e.payload as { kind: string }).kind === kind);
const walCritical = (): ActionEntry[] => createWal(storage as unknown as Storage).read().critical;
const walSnapshot = (): SaveV1 | null => createWal(storage as unknown as Storage).read().snapshot as SaveV1 | null;
const thrustKg = (actions: readonly ActionEntry[]): number =>
  actions.filter((e) => e.source === 'thrust').reduce((a, e) => a + (e.payload as { kg: number }).kg, 0);

// =============================================================================

describe('SaveGame — the module', () => {
  it("Given a SaveGame, Then its name is 'save' (the gating table's key) and a writer starts idle", () => {
    const r = rig();
    expect(r.sg.name).toBe('save');
    expect(r.sg.status).toBe('idle');
  });

  it('Given a writer, When it is disposed, Then the writer lock is released (once)', () => {
    const r = rig();
    r.sg.dispose();
    r.sg.dispose();
    expect(r.lock.released).toBe(1);
  });
});

describe('SaveGame — autosave (memoryStore)', () => {
  it('Given a running game, When the ship lands, Then a valid save is written to the store', async () => {
    const r = rig();
    landed(r.g);
    r.tick();
    await flush();
    expect(r.s.saved).toHaveLength(1);
    expect(SaveV1Schema.safeParse(r.s.saved[0]).success).toBe(true);
  });

  it('Given a mine completes (cargo:action, then recordMined), When SaveGame ticks, Then a save is written holding the cargo mine AND the mined entry — not half a mine', async () => {
    const r = rig();
    mine(r.g, ASTEROID(), 'ice', 2_000);
    r.tick();
    await flush();
    expect(r.s.saved).toHaveLength(1);
    const s = r.s.saved[0]!;
    expect(s.actions.filter(isCargoMine)).toHaveLength(1);
    expect(s.actions.filter(isMined)).toHaveLength(1);
    expect(s.world.entries).toHaveLength(1);
    expect(s.ship.cargo.ice).toBe(2_000);
  });

  it('Given a running game, When a system is entered, Then a save is written', async () => {
    const r = rig();
    bus.emit('system:entered', { system: r.g.u.system });
    r.tick();
    await flush();
    expect(r.s.saved).toHaveLength(1);
  });

  it('Given no trigger, When 119.5 s are played, Then nothing is saved; When 120 s are reached, Then one save is written', async () => {
    const r = rig();
    r.play(119.5);
    await flush();
    expect(r.s.saved).toHaveLength(0);
    r.play(0.5);
    await flush();
    expect(r.s.saved).toHaveLength(1);
  });

  it('Given a landing save at 60 s, When 120 s from the start are reached, Then no interval save (the interval counts from the last save); at 180 s, Then one', async () => {
    const r = rig();
    r.play(60);
    landed(r.g);
    r.tick(0);
    await flush();
    expect(r.s.saved).toHaveLength(1);
    r.play(60);
    await flush();
    expect(r.s.saved).toHaveLength(1);
    r.play(60);
    await flush();
    expect(r.s.saved).toHaveLength(2);
  });

  it('Given a landing save, When a mine and a system entry follow within 5 s, Then there is still exactly one save', async () => {
    const r = rig();
    landed(r.g);
    r.tick();
    await flush();
    r.play(2);
    mine(r.g, ASTEROID(), 'metal', 500);
    r.tick();
    bus.emit('system:entered', { system: r.g.u.system });
    r.tick();
    await flush();
    expect(r.s.saved).toHaveLength(1);
  });

  it('Given a landing save, When a mine completes 5 s later, Then a second save is written (the gap is ≥ 5 s, not more)', async () => {
    const r = rig();
    landed(r.g);
    r.tick(0);
    await flush();
    r.play(5);
    mine(r.g, ASTEROID(), 'metal', 500);
    r.tick(0);
    await flush();
    expect(r.s.saved).toHaveLength(2);
  });

  it('R13: Given a mine 2 s after a landing save (inside the gap), When the gap has passed, Then the deferred mine IS saved — once, holding the mined entry', async () => {
    const r = rig();
    landed(r.g);
    r.tick(0);
    await flush();
    r.play(2);
    mine(r.g, ASTEROID(), 'metal', 500);
    r.tick(0);
    await flush();
    expect(r.s.saved).toHaveLength(1);
    r.play(3);
    await flush();
    expect(r.s.saved).toHaveLength(2);
    expect(r.s.saved[1]!.actions.filter(isMined)).toHaveLength(1);
    r.play(10);
    await flush();
    expect(r.s.saved).toHaveLength(2);
  });

  it('Given autosaves, Then the log says nothing about them (SAVED is for the manual save only)', async () => {
    const r = rig();
    landed(r.g);
    r.tick();
    r.play(120);
    await flush();
    expect(r.s.saved.length).toBeGreaterThan(0);
    expect(r.logs.filter((l) => l.text === 'SAVED')).toHaveLength(0);
  });
});

describe('SaveGame — the manual save', () => {
  it('Given a running game, When saveNow(manual), Then it resolves true, the store has it and the log says SAVED, quietly (tone normal)', async () => {
    const r = rig();
    await expect(r.sg.saveNow('manual')).resolves.toBe(true);
    expect(r.s.saved).toHaveLength(1);
    expect(r.logs.filter((l) => l.text === 'SAVED')).toEqual([{ text: 'SAVED', tone: 'normal' }]);
  });

  it('Given an autosave a moment ago, When saveNow(manual), Then it saves anyway (no gap for the pilot)', async () => {
    const r = rig();
    landed(r.g);
    r.tick();
    await flush();
    await expect(r.sg.saveNow('manual')).resolves.toBe(true);
    expect(r.s.saved).toHaveLength(2);
  });

  it("Given a save in flight, Then status is 'saving'; When the store finishes, Then it is 'idle' again", async () => {
    const r = rig();
    const release = r.s.hold();
    const p = r.sg.saveNow('manual');
    await flush();
    expect(r.sg.status).toBe('saving');
    release();
    await expect(p).resolves.toBe(true);
    expect(r.sg.status).toBe('idle');
  });

  it('Given the Pause sheet is open, When SAVE is clicked, Then the game is saved and the log says SAVED', async () => {
    const r = rig();
    vi.stubGlobal('document', { querySelector: () => null, pointerLockElement: null });
    const pause = new Pause({
      universe: r.g.u,
      recovery: { active: false } as unknown as RecoveryCut,
      warp: { phase: 'idle' },
      save: r.sg,
    } as ConstructorParameters<typeof Pause>[0]);
    pause.update(1 / 60, { input: { pressed: (a: ActionName) => a === 'pause' } } as unknown as EngineContext);
    expect(pause.isOpen).toBe(true);
    (pause as unknown as { requestSave(): void }).requestSave();
    await flush();
    expect(pause.isOpen).toBe(true);
    expect(r.s.saved).toHaveLength(1);
    expect(r.logs.some((l) => l.text === 'SAVED')).toBe(true);
  });
});

describe('SaveGame — the save order and failures (obligations 3, 4, 7)', () => {
  it('Given a save, Then the order is: WAL snapshot → store → WAL clear, all with the same revision', async () => {
    const events: string[] = [];
    const r = rig({ store: spyStore(events), wal: recordingWal(events) });
    await r.sg.saveNow('manual');
    expect(events).toEqual(['snapshot:1', 'store:1', 'clear:1']);
  });

  it('Given a save, When the store is asked to write it, Then the WAL already holds that snapshot (synchronously, before IndexedDB)', async () => {
    const r = rig();
    let seen: number | null | undefined;
    const write = r.s.store.save.bind(r.s.store);
    r.s.store.save = async (s) => {
      seen = walSnapshot()?.revision ?? null;
      return write(s);
    };
    await r.sg.saveNow('manual');
    expect(seen).toBe(1);
  });

  it('Given a durable save, Then the WAL is cleared after it: no snapshot and no covered entries left', async () => {
    const r = rig();
    mine(r.g, ASTEROID(), 'ice', 500);
    await expect(r.sg.saveNow('manual')).resolves.toBe(true);
    expect(r.s.saved).toHaveLength(1);
    expect(storage.getItem(WAL_SNAPSHOT_KEY)).toBeNull();
    expect(walCritical()).toHaveLength(0);
  });

  it('Given the store rejects once, When a mine was drained into that save, Then saveNow resolves false, SAVE FAILED is logged (warn) and the WAL keeps that snapshot', async () => {
    const r = rig();
    mine(r.g, ASTEROID(), 'ice', 2_000);
    r.s.failOnce();
    await expect(r.sg.saveNow('manual')).resolves.toBe(false);
    expect(r.logs).toContainEqual({ text: 'SAVE FAILED', tone: 'warn' });
    expect(r.logs.some((l) => l.text === 'SAVED')).toBe(false);
    expect(walSnapshot()?.actions.some(isMined)).toBe(true);
    expect(r.sg.status).toBe('idle');
  });

  it('Given the store rejected once, When the next save succeeds, Then it holds the actions the failed save drained, under a higher revision', async () => {
    const r = rig();
    mine(r.g, ASTEROID(), 'ice', 2_000);
    r.s.failOnce();
    await r.sg.saveNow('manual');
    await expect(r.sg.saveNow('manual')).resolves.toBe(true);
    const s = r.s.saved.at(-1)!;
    expect(s.actions.filter(isMined)).toHaveLength(1);
    expect(s.actions.filter(isCargoMine)).toHaveLength(1);
    expect(s.revision).toBeGreaterThan(r.s.attempts[0]!);
  });

  it('Given the WAL snapshot write fails (false), When the store write succeeds, Then the save counts (true) and the WAL is still cleared up to that revision', async () => {
    const events: string[] = [];
    const r = rig({ store: spyStore(events), wal: recordingWal(events, { writeSnapshot: () => false }) });
    await expect(r.sg.saveNow('manual')).resolves.toBe(true);
    expect(r.s.saved).toHaveLength(1);
    expect(events).toContain('clear:1');
  });

  it('Given an OLD snapshot in the WAL and a failing snapshot write, When the store write fails too, Then it is SAVE FAILED — the old snapshot is not taken as cover — and the next save still holds the drained actions', async () => {
    const events: string[] = [];
    let walFails = true;
    const base = createWal(storage as unknown as Storage);
    const r = rig({
      store: spyStore(events),
      wal: recordingWal(events, { writeSnapshot: (s) => (walFails ? false : base.writeSnapshot(s)) }),
    });
    walFails = false;
    r.pagehide(); // an old snapshot (revision 1) in the WAL
    walFails = true;
    mine(r.g, ASTEROID(), 'silicate', 700);
    r.s.failOnce();
    await expect(r.sg.saveNow('manual')).resolves.toBe(false);
    expect(r.logs).toContainEqual({ text: 'SAVE FAILED', tone: 'warn' });
    walFails = false;
    await expect(r.sg.saveNow('manual')).resolves.toBe(true);
    expect(r.s.saved.at(-1)!.actions.filter(isMined)).toHaveLength(1);
  });

  it('Given saves of every kind (manual, pagehide, failed, hidden, landing), Then every revision written anywhere rises strictly, in the order written', async () => {
    const events: string[] = [];
    const r = rig({ store: spyStore(events), wal: recordingWal(events) });
    await r.sg.saveNow('manual');
    r.pagehide();
    r.s.failOnce();
    await r.sg.saveNow('manual');
    r.hide();
    await flush();
    r.show();
    r.play(6);
    landed(r.g);
    r.tick();
    await flush();
    const revs = events
      .filter((e) => e.startsWith('snapshot:') || e.startsWith('store:'))
      .map((e) => e.split(':') as [string, string]);
    // Each save is snapshotted once and stored at most once, under one revision.
    const firstSeen: number[] = [];
    for (const [, n] of revs) if (!firstSeen.includes(Number(n))) firstSeen.push(Number(n));
    expect(firstSeen.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < firstSeen.length; i++) expect(firstSeen[i]!).toBeGreaterThan(firstSeen[i - 1]!);
    for (let i = 1; i < r.s.attempts.length; i++) expect(r.s.attempts[i]!).toBeGreaterThan(r.s.attempts[i - 1]!);
  });

  it('Given two manual saves started together, Then both resolve true and the store gets strictly rising revisions, the newest last', async () => {
    const r = rig();
    const [a, b] = await Promise.all([r.sg.saveNow('manual'), r.sg.saveNow('manual')]);
    expect([a, b]).toEqual([true, true]);
    expect(r.s.attempts).toHaveLength(2);
    expect(r.s.attempts[1]!).toBeGreaterThan(r.s.attempts[0]!);
    const { current } = await r.s.store.load();
    expect((current as SaveV1).revision).toBe(Math.max(...r.s.attempts));
  });
});

describe('SaveGame — the emergency exit is written first (R2, §5.2)', () => {
  function dry(r: Rig): void {
    const tank = r.g.u.flight.propellant!;
    tank.consume(tank.massKg);
    expect(tank.empty).toBe(true);
  }

  it('Given an empty tank, When emergency key 2 fires the beacon, Then the WAL holds the beacon entry BEFORE ship:recovered is emitted', () => {
    const r = rig();
    dry(r);
    let atRecovered: ActionEntry[] | null = null;
    offs.push(bus.on('ship:recovered', () => (atRecovered ??= walCritical())));
    r.g.press('emergency');
    r.g.press('emergencyBeacon');
    expect(atRecovered).not.toBeNull();
    expect(emergencyEntries(atRecovered!, 'beacon')).toHaveLength(1);
  });

  it('Given an empty tank, When key 1 cannibalizes the tank, Then the WAL holds {cannibalize, timesUsed 1} before TANK CANNIBALIZED is logged and before emergency:used', () => {
    const r = rig();
    dry(r);
    let atLog: ActionEntry[] | null = null;
    let atUsed: ActionEntry[] | null = null;
    offs.push(bus.on('log', (l) => l.text === 'TANK CANNIBALIZED' && (atLog = walCritical())));
    offs.push(bus.on('emergency:used', () => (atUsed ??= walCritical())));
    r.g.press('emergency');
    r.g.press('emergencyCannibalize');
    expect(r.g.emergency.timesUsed).toBe(1);
    for (const seen of [atLog, atUsed]) {
      expect(seen).not.toBeNull();
      const e = emergencyEntries(seen!, 'cannibalize');
      expect(e).toHaveLength(1);
      expect(e[0]!.payload).toEqual({ kind: 'cannibalize', timesUsed: 1 });
    }
  });

  it('Given an empty tank and 1.5 t aboard, When key 3 burns the cargo, Then the WAL holds the cannibalize-cargo entry before CARGO CANNIBALIZED and before emergency:used', () => {
    const r = rig();
    mine(r.g, ASTEROID(), 'metal', 1_500);
    dry(r);
    let atLog: ActionEntry[] | null = null;
    let atUsed: ActionEntry[] | null = null;
    offs.push(bus.on('log', (l) => l.text === 'CARGO CANNIBALIZED' && (atLog = walCritical())));
    offs.push(bus.on('emergency:used', () => (atUsed ??= walCritical())));
    r.g.press('emergency');
    r.g.press('emergencyCannibalizeCargo');
    for (const seen of [atLog, atUsed]) {
      expect(seen).not.toBeNull();
      expect(emergencyEntries(seen!, 'cannibalize-cargo')).toHaveLength(1);
    }
  });

  it('Given a tank, When the paid RETURN TO ORBIT reaches black, Then the WAL holds the beacon entry BEFORE emergency:used and ship:recovered are emitted', () => {
    const r = rig();
    const cut = new RecoveryCut(r.g.u, r.g.shipLog, (used: CriticalUse) => r.sg.critical(used));
    let atUsed: ActionEntry[] | null = null;
    let atRecovered: ActionEntry[] | null = null;
    offs.push(bus.on('emergency:used', () => (atUsed ??= walCritical())));
    offs.push(bus.on('ship:recovered', () => (atRecovered ??= walCritical())));
    const ctx = { ...r.g.ctx, input: { setThrottle: () => undefined } } as unknown as EngineContext;
    cut.request('requested');
    for (let i = 0; i < 240 && atRecovered === null; i++) cut.update(1 / 60, ctx);
    expect(atRecovered).not.toBeNull();
    expect(emergencyEntries(atUsed!, 'beacon')).toHaveLength(1);
    expect(emergencyEntries(atRecovered!, 'beacon')).toHaveLength(1);
  });

  it('Given a crash recovery (free), When the cut reaches black, Then the WAL holds no emergency entry', () => {
    const r = rig();
    const cut = new RecoveryCut(r.g.u, r.g.shipLog, (used: CriticalUse) => r.sg.critical(used));
    let recovered = false;
    offs.push(bus.on('ship:recovered', () => (recovered = true)));
    const ctx = { ...r.g.ctx, input: { setThrottle: () => undefined } } as unknown as EngineContext;
    cut.request('crash');
    for (let i = 0; i < 240 && !recovered; i++) cut.update(1 / 60, ctx);
    expect(recovered).toBe(true);
    expect(walCritical()).toHaveLength(0);
  });

  it('Given a beacon, When SaveGame ticks, Then a save follows holding exactly ONE beacon entry, with the seq the WAL entry had (dedup by seq), and the WAL is cleared after it', async () => {
    const r = rig();
    dry(r);
    r.g.press('emergency');
    r.g.press('emergencyBeacon');
    const inWal = emergencyEntries(walCritical(), 'beacon');
    expect(inWal).toHaveLength(1);
    r.tick();
    await flush();
    expect(r.s.saved).toHaveLength(1);
    const inSave = emergencyEntries(r.s.saved[0]!.actions, 'beacon');
    expect(inSave).toHaveLength(1);
    expect(inSave[0]!.seq).toBe(inWal[0]!.seq);
    expect(walCritical()).toHaveLength(0);
    expect(storage.getItem(WAL_SNAPSHOT_KEY)).toBeNull();
  });

  it('Given a landing save a moment ago, When the beacon fires, Then it is saved anyway (no gap for the emergency)', async () => {
    const r = rig();
    landed(r.g);
    r.tick();
    await flush();
    dry(r);
    r.g.press('emergency');
    r.g.press('emergencyBeacon');
    r.tick();
    await flush();
    expect(r.s.saved).toHaveLength(2);
  });
});

describe('SaveGame — the tab hidden and closed (§5.2)', () => {
  it('Given a running game, When the tab is hidden, Then an IndexedDB save is written — even right after another save', async () => {
    const r = rig();
    landed(r.g);
    r.tick();
    await flush();
    r.hide();
    await flush();
    expect(r.s.saved).toHaveLength(2);
  });

  it('Given a hidden tab, When it becomes visible again, Then nothing more is saved', async () => {
    const r = rig();
    r.hide();
    await flush();
    r.show();
    await flush();
    expect(r.s.saved).toHaveLength(1);
  });

  it('Given a running game, When pagehide fires, Then the whole snapshot is in the WAL synchronously — before the handler returns, with no await', () => {
    const r = rig();
    mine(r.g, ASTEROID(), 'ice', 1_200);
    r.pagehide();
    const snap = walSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.revision).toBe(1);
    expect(snap!.ship.cargo.ice).toBe(1_200);
    expect(snap!.actions.filter(isMined)).toHaveLength(1);
  });

  it('Given a pagehide snapshot (the tab came back from the bfcache), When the next save is written, Then it continues it: a higher revision, the drained mine included', async () => {
    const r = rig();
    mine(r.g, ASTEROID(), 'ice', 1_200);
    r.pagehide();
    await r.sg.saveNow('manual');
    const s = r.s.saved.at(-1)!;
    expect(s.revision).toBe(2);
    expect(s.actions.filter(isMined)).toHaveLength(1);
  });

  it('Given the title screen (the opening world behind the menu), When the tab is hidden or closed, Then nothing is written anywhere', async () => {
    const r = rig();
    toMode('title');
    r.hide();
    r.pagehide();
    await flush();
    expect(r.s.attempts).toHaveLength(0);
    expect(storage.getItem(WAL_SNAPSHOT_KEY)).toBeNull();
  });

  it('Given a mine 2 s in, When pagehide fires, Then the saved state has no half mine (cargo unchanged, no mined entry, no cargo mine action)', () => {
    const r = rig();
    const g = r.g;
    const ast: AsteroidSpec = fyssField(0).asteroids.find((a) => a.composition.ice >= 6_000)!;
    expect(ast).toBeDefined();
    const ship = () => g.u.flight.renderWorldPosition ?? g.u.flight.worldPosition;
    const belt = {
      asteroidSpec: (id: string) => (id === ast.id ? ast : null),
      asteroidWorld: (id: string, out: { x: number; y: number; z: number }) => {
        const p = ship();
        out.x = p.x + ast.radiusKm + 0.2;
        out.y = p.y;
        out.z = p.z;
        return id === ast.id;
      },
      asteroidVelocity: (id: string, out: { x: number; y: number; z: number }) => {
        const v = g.u.flight.velocity;
        const pv = g.u.shipParent?.worldVelocity;
        out.x = v.x + (pv ? pv.x : 0);
        out.y = v.y + (pv ? pv.y : 0);
        out.z = v.z + (pv ? pv.z : 0);
        return id === ast.id;
      },
      remainingKg: (id: string, res: 'ice' | 'metal' | 'silicate' | 'rare') =>
        id === ast.id ? ast.composition[res] - g.worldState.depleted(id)[res] : 0,
    };
    const mining = new Mining({
      universe: g.u,
      belt: belt as unknown as MiningOptions['belt'],
      worldState: g.worldState,
      targeting: { targetId: ast.id },
      cruise: { busy: false },
      warp: { phase: 'idle' },
    });
    mining.init();
    offs.push(() => mining.dispose());
    const cargoBefore = { ...g.u.cargo.snapshot() };
    const keys = (a: ActionName | null) =>
      ({ ...g.ctx, input: { pressed: (x: ActionName) => x === a, setThrottle: () => undefined } }) as unknown as EngineContext;
    mining.update(1 / 60, keys('mine'));
    expect(mining.busy?.kind).toBe('mine');
    for (let i = 0; i < 120; i++) {
      g.u.update(1 / 60, g.ctx);
      mining.update(1 / 60, keys(null));
    }
    expect(mining.busy).not.toBeNull(); // really mid-mine: ~2 s left
    r.pagehide();
    const snap = walSnapshot()!;
    expect(snap).not.toBeNull();
    expect(snap.ship.cargo).toEqual(cargoBefore);
    expect(snap.world.entries).toHaveLength(0);
    expect(snap.actions.filter(isMined)).toHaveLength(0);
    expect(snap.actions.filter(isCargoMine)).toHaveLength(0);
  });
});

describe('SaveGame — one writing tab (Global Constraints)', () => {
  it('Given a second tab without the lock, Then it shows the disabled text (warn) and its status is disabled', () => {
    const tab2 = rig({ writer: false });
    expect(tab2.sg.status).toBe('disabled');
    expect(tab2.logs).toContainEqual({ text: DISABLED_TEXT, tone: 'warn' });
  });

  it("Given a second tab without the lock, When it is asked to save in every way, Then it writes nothing, and tab 1's WAL and journal are untouched", async () => {
    const tab1 = rig();
    // Tab 1's store is held, so tab 1's own emergency save (if it has started
    // one) cannot finish and clear the WAL while tab 2 is being tested.
    const release = tab1.s.hold();
    // Tab 1 pays a beacon: its entry is in the WAL, its journal holds it.
    const tank = tab1.g.u.flight.propellant!;
    tank.consume(tank.massKg);
    tab1.g.press('emergency');
    tab1.g.press('emergencyBeacon');
    const attemptsBefore = tab1.s.attempts.length;
    const walBefore = [storage.getItem(WAL_KEY), storage.getItem(WAL_SNAPSHOT_KEY)];
    expect(walBefore[0]).not.toBeNull();

    // Tab 2 — a reader. It shares the storage, the store and (to catch any
    // drain) even tab 1's world and journal.
    const tab2 = rig({ g: tab1.g, writer: false, store: tab1.s });
    await expect(tab2.sg.saveNow('manual')).resolves.toBe(false);
    tab2.sg.critical({ kind: 'beacon' });
    tab2.hide();
    tab2.pagehide();
    tab2.play(130);
    await flush();
    expect(tab1.s.attempts).toHaveLength(attemptsBefore);
    expect([storage.getItem(WAL_KEY), storage.getItem(WAL_SNAPSHOT_KEY)]).toEqual(walBefore);
    expect(tab2.logs.some((l) => l.text === 'SAVED')).toBe(false);

    // Tab 1's next save still holds its beacon — exactly once.
    release();
    await expect(tab1.sg.saveNow('manual')).resolves.toBe(true);
    await flush();
    expect(emergencyEntries(tab1.s.saved.at(-1)!.actions, 'beacon')).toHaveLength(1);
  });
});

describe('SaveGame — no tank (Yard / showroom hull)', () => {
  it('Given no tank attached, When any trigger fires (manual, landing, interval, hidden, pagehide), Then nothing is saved anywhere', async () => {
    const r = rig();
    r.g.u.flight.attachPropellant(null, EXHAUST_VELOCITY_KMS);
    await expect(r.sg.saveNow('manual')).resolves.toBe(false);
    landed(r.g);
    r.tick();
    r.play(121);
    r.hide();
    r.pagehide();
    await flush();
    expect(r.s.attempts).toHaveLength(0);
    expect(storage.getItem(WAL_SNAPSHOT_KEY)).toBeNull();
  });
});

describe('SaveGame — the books follow the tank (obligation 1)', () => {
  it('Given the tank is at 40 % when SaveGame starts (not the opening fill), When it saves with nothing burned, Then no thrust and no unexplained gain are booked', async () => {
    const g = live();
    g.u.flight.attachPropellant(new Propellant(PROBE_TANK_CAPACITY_KG, 0.4), EXHAUST_VELOCITY_KMS);
    const r = rig({ g });
    g.hook.fn = (used) => r.sg.critical(used);
    await r.sg.saveNow('manual');
    expect(thrustKg(r.s.saved[0]!.actions)).toBeLessThan(1e-9);
    expect(g.journal.unexplainedGainKg).toBeLessThan(1e-9);
  });

  it('Given a running SaveGame, When the tank is swapped for one at 30 % and SaveGame ticks, Then the next save books no thrust and no unexplained gain for the swap', async () => {
    const r = rig();
    await r.sg.saveNow('manual');
    r.g.u.flight.attachPropellant(new Propellant(PROBE_TANK_CAPACITY_KG, 0.3), EXHAUST_VELOCITY_KMS);
    r.tick(0);
    await r.sg.saveNow('manual');
    expect(thrustKg(r.s.saved[1]!.actions.slice(r.s.saved[0]!.actions.length))).toBeLessThan(1e-9);
    expect(r.g.journal.unexplainedGainKg).toBeLessThan(1e-9);
  });
});

describe('registry.ts wires the save (obligations 2, 5, 6)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'registry.ts'), 'utf8');
  /** From `start` to the next `;` — one constructor call. */
  const call = (start: string): string => {
    const i = src.indexOf(start);
    expect(i, `${start} not found in registry.ts`).toBeGreaterThanOrEqual(0);
    return src.slice(i, src.indexOf(';', i));
  };

  it("Given the registry, Then WorldState's mines reach the journal (onMined)", () => {
    expect(call('new WorldState(')).toMatch(/onMined/);
  });

  it('Given the registry, Then SaveGame gets the real Cruise and the engine Input, a writer lock, and is added after Emergency and Mining', () => {
    const sg = call('new SaveGame(');
    expect(sg).toMatch(/cruise/);
    expect(sg).toMatch(/engine\.input/);
    expect(src).toMatch(/acquireWriterLock\(/);
    expect(src.indexOf('new SaveGame(')).toBeGreaterThan(src.indexOf('new Mining('));
    expect(src.indexOf('new SaveGame(')).toBeGreaterThan(src.indexOf('new Emergency('));
  });

  it('Given the registry, Then Emergency and RecoveryCut get the critical hook and Pause gets the save', () => {
    expect(call('new Emergency(')).toMatch(/critical/);
    expect(call('new RecoveryCut(')).toMatch(/critical/);
    expect(call('new Pause(')).toMatch(/save/);
  });
});

// =============================================================================
// Fix round 1 (ruling R14)
// =============================================================================

/** Enter the Yard as the engine does: the mode changes, then every module is told. */
function enterYard(r: Rig): void {
  const from = modes.base;
  toMode('yard');
  r.sg.onModeChange?.(from, 'yard', r.g.ctx);
}

describe('R14 I1 — the Yard is no escape from the books (the tank stays attached in the Yard)', () => {
  it('Given a landing save a moment ago and a mine after it, When the pilot enters the Yard, Then a save is written at once (no gap) and it holds the mine', async () => {
    const r = rig();
    landed(r.g);
    r.tick(0);
    await flush();
    mine(r.g, ASTEROID(), 'ice', 2_000);
    enterYard(r);
    await flush();
    expect(r.s.saved).toHaveLength(2);
    expect(r.s.saved[1]!.actions.filter(isMined)).toHaveLength(1);
  });

  it('Given a mine, When the pilot enters the Yard and the tab is closed (pagehide), Then the WAL snapshot holds the mine — synchronously', () => {
    const r = rig();
    mine(r.g, ASTEROID(), 'ice', 2_000);
    enterYard(r);
    r.pagehide();
    const snap = walSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.actions.filter(isMined)).toHaveLength(1);
    expect(snap!.ship.cargo.ice).toBe(2_000);
  });

  it('Given the Yard with the tank attached, When the tank changes and the tab is closed, Then the WAL snapshot holds the tank as it is now', async () => {
    const r = rig();
    enterYard(r);
    await flush();
    const tank = r.g.u.flight.propellant!;
    tank.consume(250);
    r.pagehide();
    const snap = walSnapshot()!;
    expect(snap).not.toBeNull();
    expect(snap.ship.propellant.massKg).toBe(tank.massKg);
    expect(snap.revision).toBeGreaterThan(r.s.attempts.at(-1) ?? 0);
  });

  it('Given the Yard with the tank attached, When the tab is hidden, Then an IndexedDB save is written', async () => {
    const r = rig();
    enterYard(r);
    await flush();
    const before = r.s.saved.length;
    r.hide();
    await flush();
    expect(r.s.saved.length).toBe(before + 1);
  });

  it('Given the Yard with the tank attached, When SAVE is asked for, Then it saves and logs SAVED', async () => {
    const r = rig();
    enterYard(r);
    await flush();
    await expect(r.sg.saveNow('manual')).resolves.toBe(true);
    expect(r.logs.some((l) => l.text === 'SAVED')).toBe(true);
  });

  it('R15: Given a landing save a moment ago and a mine after it, When the pilot quits flight to the title, Then a save is flushed at once (no gap) holding the mine', async () => {
    const r = rig();
    landed(r.g);
    r.tick(0);
    await flush();
    mine(r.g, ASTEROID(), 'ice', 2_000);
    toMode('title');
    r.sg.onModeChange?.('flight', 'title', r.g.ctx);
    await flush();
    expect(r.s.saved).toHaveLength(2);
    expect(r.s.saved[1]!.actions.filter(isMined)).toHaveLength(1);
  });

  it('Given the title screen, When SAVE is asked for, Then nothing is written (the title is still excluded)', async () => {
    const r = rig();
    toMode('title');
    await expect(r.sg.saveNow('manual')).resolves.toBe(false);
    r.hide();
    r.pagehide();
    await flush();
    expect(r.s.attempts).toHaveLength(0);
    expect(storage.getItem(WAL_SNAPSHOT_KEY)).toBeNull();
  });
});

describe('R14 M2 — a capture syncs the books with the tank first', () => {
  it('Given a save, When the tank is swapped for one at 30 % and the tab is closed before any tick, Then the snapshot books no thrust and no unexplained gain for the swap', async () => {
    const r = rig();
    await r.sg.saveNow('manual');
    const n = r.s.saved[0]!.actions.length;
    r.g.u.flight.attachPropellant(new Propellant(PROBE_TANK_CAPACITY_KG, 0.3), EXHAUST_VELOCITY_KMS);
    r.pagehide();
    const snap = walSnapshot()!;
    expect(snap).not.toBeNull();
    expect(thrustKg(snap.actions.slice(n))).toBeLessThan(1e-9);
    expect(r.g.journal.unexplainedGainKg).toBeLessThan(1e-9);
  });
});

describe('R14 M3 — a manual SAVE that cannot write says so', () => {
  it('Given a reader tab, When SAVE is asked for, Then it resolves false and the disabled text is logged again (warn)', async () => {
    const r = rig({ writer: false });
    r.logs.length = 0;
    await expect(r.sg.saveNow('manual')).resolves.toBe(false);
    expect(r.logs).toContainEqual({ text: DISABLED_TEXT, tone: 'warn' });
  });

  it('Given no tank attached, When SAVE is asked for, Then it resolves false and SAVE FAILED is logged (warn)', async () => {
    const r = rig();
    r.g.u.flight.attachPropellant(null, EXHAUST_VELOCITY_KMS);
    await expect(r.sg.saveNow('manual')).resolves.toBe(false);
    expect(r.logs).toContainEqual({ text: 'SAVE FAILED', tone: 'warn' });
  });

  it("Given no tank attached, When an autosave trigger fires, Then the log stays quiet (only the pilot's own SAVE is answered)", async () => {
    const r = rig();
    r.g.u.flight.attachPropellant(null, EXHAUST_VELOCITY_KMS);
    landed(r.g);
    r.tick();
    r.play(121);
    await flush();
    expect(r.logs.some((l) => l.text === 'SAVE FAILED')).toBe(false);
  });
});

describe('R14 M4 — a WAL append that fails is not silent', () => {
  it('Given a WAL that refuses the append, When the beacon fires, Then SAVE FAILED is logged (warn) before ship:recovered', () => {
    const base = createWal(storage as unknown as Storage);
    const r = rig({ wal: { ...base, appendCritical: () => false } });
    const tank = r.g.u.flight.propellant!;
    tank.consume(tank.massKg);
    let failedBeforeRecovered: boolean | null = null;
    offs.push(
      bus.on('ship:recovered', () => {
        failedBeforeRecovered ??= r.logs.some((l) => l.text === 'SAVE FAILED' && l.tone === 'warn');
      }),
    );
    r.g.press('emergency');
    r.g.press('emergencyBeacon');
    expect(failedBeforeRecovered).toBe(true);
  });

  it('Given a working WAL, When the beacon fires, Then nothing about a failure is logged', () => {
    const r = rig();
    const tank = r.g.u.flight.propellant!;
    tank.consume(tank.massKg);
    r.g.press('emergency');
    r.g.press('emergencyBeacon');
    expect(r.logs.some((l) => l.text === 'SAVE FAILED')).toBe(false);
  });
});

// =============================================================================
// Final review, ruling R25
//  I2 — a store that failed at boot is store-inert for the session: SaveGame
//       ({ storeAvailable: false }) writes the WAL only — never store.save,
//       never wal.clear — and keeps the notice.
//  I3 — a store write gets 3 s: then SAVE FAILED (warn), the queue moves on,
//       the WAL is not cleared.
//  I4 — a regular autosave (interval, landing, mine, system) tags WAL coverage
//       (wal.markCovered) instead of writing the whole snapshot; hidden,
//       pagehide, emergency, leave — and the pilot's SAVE — still write it.
//       world.entries are aggregated per (asteroid, resource). The
//       synchronous part of an interval autosave at the cap stays small.
//  M4 — a reader tab's journal does not grow without bound.
// =============================================================================

const UNAVAILABLE_TEXT = 'SAVE STORAGE UNAVAILABLE — RELOAD THE TAB';
/** AUTOSAVE_INTERVAL_S and a little: one tick that crosses the interval. */
const AUTOSAVE_INTERVAL = 121;

/** A beacon on an empty tank, paid as the pilot pays it (keys 0 then 2). */
function payBeacon(r: Rig): void {
  const tank = r.g.u.flight.propellant!;
  tank.consume(tank.massKg);
  r.g.press('emergency');
  r.g.press('emergencyBeacon');
}

describe('R25 I2 — a store unavailable at boot is never written this session', () => {
  it('Given storeAvailable: false, When every kind of save happens (SAVE, landing, mine, interval, hidden, pagehide, emergency, leave), Then store.save is never called and the WAL is never cleared; the WAL snapshot holds the newest save', async () => {
    const events: string[] = [];
    const r = rig({ store: spyStore(events), wal: recordingWal(events), extra: { storeAvailable: false } });
    await r.sg.saveNow('manual');
    landed(r.g);
    r.tick();
    r.play(6);
    mine(r.g, ASTEROID(), 'ice', 500);
    r.tick();
    r.play(121);
    r.hide();
    r.show();
    r.pagehide();
    r.play(6);
    payBeacon(r);
    r.tick();
    enterYard(r);
    await flush();
    expect(r.s.attempts).toEqual([]);
    expect(events.filter((e) => e.startsWith('clear:'))).toEqual([]);
    expect(r.sg.revision).toBeGreaterThanOrEqual(6);
    expect(walSnapshot()?.revision).toBe(r.sg.revision);
    expect(emergencyEntries(walSnapshot()!.actions, 'beacon')).toHaveLength(1);
  });

  it('Given storeAvailable: false, When SAVE is asked for, Then it resolves false and the unavailable notice is logged again (warn) — never SAVED', async () => {
    const r = rig({ extra: { storeAvailable: false } });
    await expect(r.sg.saveNow('manual')).resolves.toBe(false);
    expect(r.logs).toContainEqual({ text: UNAVAILABLE_TEXT, tone: 'warn' });
    expect(r.logs.some((l) => l.text === 'SAVED')).toBe(false);
  });

  it('Given store.load rejected at boot (an old save 7 in it) and the store then recovers, When the new game saves in every way, Then no store.save happens this session — and the next boot still finds the old save, current in the store', async () => {
    // The old game, as a store holds it.
    const r0 = rig({ store: spyStore() });
    await r0.sg.saveNow('manual');
    const old: SaveV1 = { ...structuredClone(r0.s.saved[0]!), revision: 7 };
    r0.sg.dispose();
    storage.map.clear();

    const s = spyStore();
    await s.store.save(old);
    const attemptsBefore = s.attempts.length;
    const healthyLoad = s.store.load.bind(s.store);
    let loads = 0;
    s.store.load = () => (loads++ === 0 ? Promise.reject(new DOMException('blocked', 'VersionError')) : healthyLoad());

    const wal = createWal(storage as unknown as Storage);
    const d = await decideBoot({
      search: '',
      store: s.store,
      wal,
      lock: { writer: true, release: () => undefined },
      session: null,
      replaceSearch: () => undefined,
    });
    expect(d.load.save).toBeNull();
    expect(d.notices).toContain(UNAVAILABLE_TEXT);

    const r = rig({ store: s, wal, extra: { storeAvailable: (d as { storeAvailable?: unknown }).storeAvailable } });
    r.sg.startNew(d.afterRevision);
    await r.sg.saveNow('manual');
    landed(r.g);
    r.tick();
    r.play(121);
    r.hide();
    await flush();
    expect(s.attempts.length).toBe(attemptsBefore);

    const next = await loadForBoot(s.store, wal);
    expect(next.save?.saveId).toBe(old.saveId);
    expect(next.save?.revision).toBe(7);
    expect(((await s.store.load()).current as SaveV1).saveId).toBe(old.saveId);
  });
});

describe('R25 I3 — a store write gets 3 s', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(WALL);
  });

  it('Given store.save never settles, When SAVE and 3 s pass, Then it resolves false, SAVE FAILED is logged (warn), the status is idle and the WAL is not cleared — and not before 3 s', async () => {
    const events: string[] = [];
    const r = rig({ store: spyStore(events), wal: recordingWal(events) });
    r.s.hold(); // never released: a hung IndexedDB transaction
    let done: boolean | null = null;
    void r.sg.saveNow('manual').then((x) => (done = x));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(false);
    expect(r.logs).toContainEqual({ text: 'SAVE FAILED', tone: 'warn' });
    expect(r.sg.status).toBe('idle');
    expect(events.filter((e) => e.startsWith('clear:'))).toEqual([]);
    expect(walSnapshot()?.revision).toBe(1);
  });

  it('Given the first store write hung past 3 s, When the next save is asked for, Then it reaches the store (the queue moved on) and resolves true', async () => {
    const r = rig();
    const write = r.s.store.save.bind(r.s.store);
    let n = 0;
    r.s.store.save = (s) => (n++ === 0 ? new Promise<void>(() => undefined) : write(s));
    void r.sg.saveNow('manual');
    await vi.advanceTimersByTimeAsync(3_000);
    let second: boolean | null = null;
    void r.sg.saveNow('manual').then((x) => (second = x));
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toBe(true);
    expect(r.s.saved.map((s) => s.revision)).toEqual([2]);
  });
});

describe('R25 I4a — a regular autosave tags coverage; the whole snapshot only where it is needed', () => {
  /** Rig, trigger, settle: the WAL/store events of that one save. */
  async function eventsOf(trigger: (r: Rig) => void | Promise<unknown>): Promise<string[]> {
    const events: string[] = [];
    const r = rig({ store: spyStore(events), wal: recordingWal(events) });
    await trigger(r);
    await flush();
    return events;
  }

  const REGULAR: Array<[string, (r: Rig) => void]> = [
    ['landing', (r) => (landed(r.g), r.tick())],
    ['mine', (r) => (mine(r.g, ASTEROID(), 'ice', 500), r.tick())],
    ['system entry', (r) => (bus.emit('system:entered', { system: r.g.u.system }), r.tick())],
    ['interval', (r) => r.play(120)],
  ];

  for (const [what, trigger] of REGULAR) {
    it(`Given a ${what} autosave, Then no WAL snapshot is written for it: coverage is tagged (markCovered) before the store write, and the WAL cleared after`, async () => {
      expect(await eventsOf(trigger)).toEqual(['cover:1', 'store:1', 'clear:1']);
    });
  }

  const WHOLE: Array<[string, (r: Rig) => void | Promise<unknown>]> = [
    ['hidden', (r) => r.hide()],
    ['emergency', (r) => (payBeacon(r), r.tick())],
    ['leave (the Yard)', (r) => enterYard(r)],
    ['SAVE (manual)', (r) => r.sg.saveNow('manual')],
  ];

  for (const [what, trigger] of WHOLE) {
    it(`Given a ${what} save, Then the whole snapshot goes to the WAL first, as before`, async () => {
      const events = await eventsOf(trigger);
      expect(events.filter((e) => !e.startsWith('append:'))).toEqual(['snapshot:1', 'store:1', 'clear:1']);
    });
  }

  it('Given a running game, When pagehide fires, Then the whole snapshot is written (and nothing else)', async () => {
    expect(await eventsOf((r) => r.pagehide())).toEqual(['snapshot:1']);
  });

  it('Given an interval autosave, When the store is asked to write it, Then the WAL holds NO snapshot and the paid entries are tagged by its revision', async () => {
    const r = rig();
    await r.sg.saveNow('manual'); // revision 1, durable: the WAL is empty again
    payBeacon(r); // the paid entries go to the WAL (R2), untagged
    let seen: { snapshot: string | null; by: Array<number | null> } | null = null;
    const write = r.s.store.save.bind(r.s.store);
    r.s.store.save = async (s) => {
      seen ??= {
        snapshot: storage.getItem(WAL_SNAPSHOT_KEY),
        by: createWal(storage as unknown as Storage).readTagged().critical.map((c) => c.by),
      };
      return write(s);
    };
    await r.sg.saveNow('interval');
    expect(seen).not.toBeNull();
    expect(seen!.snapshot).toBeNull();
    expect(seen!.by.length).toBeGreaterThan(0);
    expect(new Set(seen!.by)).toEqual(new Set([2]));
  });

  it('Given a durable save, a beacon paid after it, and an interval autosave the tab dies under (IndexedDB never commits), When the game boots again, Then the beacon is there — once — and the tank is as paid (a paid action is never lost)', async () => {
    const r = rig();
    await r.sg.saveNow('manual'); // revision 1, durable
    payBeacon(r);
    const paidTankKg = r.g.u.flight.propellant!.massKg;
    r.s.hold(); // never released: the tab dies before IndexedDB commits
    void r.sg.saveNow('interval');
    const boot = await loadForBoot(r.s.store, createWal(storage as unknown as Storage));
    expect(boot.save).not.toBeNull();
    expect(emergencyEntries(boot.save!.actions, 'beacon')).toHaveLength(1);
    expect(boot.save!.ship.propellant.massKg).toBeCloseTo(paidTankKg, 6);
  });

  it('Choice: Given a regular autosave the store refuses, Then its whole snapshot goes to the WAL after all (the fallback), so the next boot continues it', async () => {
    const r = rig();
    mine(r.g, ASTEROID(), 'ice', 500);
    r.s.failOnce();
    r.tick();
    await flush();
    expect(r.s.saved).toHaveLength(0);
    expect(walSnapshot()?.revision).toBe(1);
    expect(walSnapshot()!.actions.some(isMined)).toBe(true);
    const boot = await loadForBoot(r.s.store, createWal(storage as unknown as Storage));
    expect(boot.save?.revision).toBe(1);
  });
});

describe('R25 I4b — world entries are aggregated per (asteroid, resource) in a save', () => {
  it('Given three ice mines and one metal mine on one rock and one ice mine on another, When saved, Then world.entries holds three — kg summed, the newest clocks, first-seen order — the action log keeps every mine, and a load gives the same depletion', async () => {
    const r = rig();
    const [a, b] = [fyssField(0).asteroids[0]!.id, fyssField(0).asteroids[1]!.id];
    const steps: Array<[string, 'ice' | 'metal', number]> = [
      [a, 'ice', 300],
      [a, 'metal', 200],
      [a, 'ice', 300],
      [b, 'ice', 100],
      [a, 'ice', 300],
    ];
    steps.forEach(([id, res, kg], i) => {
      vi.setSystemTime(WALL + (i + 1) * 1_000);
      mine(r.g, id, res, kg);
    });
    await r.sg.saveNow('manual');
    const s = r.s.saved[0]!;
    expect(s.world.entries.map((e) => [e.id, e.resource, e.kg, e.wallMs])).toEqual([
      [a, 'ice', 900, WALL + 5_000],
      [a, 'metal', 200, WALL + 2_000],
      [b, 'ice', 100, WALL + 4_000],
    ]);
    expect(s.actions.filter(isMined)).toHaveLength(5);
    expect(SaveV1Schema.safeParse(s).success).toBe(true);
    const loaded = new WorldState({ orbitSeconds: () => 0, wallMs: () => 0 });
    loaded.restore(s.world.entries);
    expect(loaded.depleted(a)).toEqual(r.g.worldState.depleted(a));
    expect(loaded.depleted(b)).toEqual(r.g.worldState.depleted(b));
  });
});

describe('R25 I4c — the synchronous part of an interval autosave at the cap', () => {
  /**
   * The bound: 2 ms (the fastest of 5 interval autosaves). Measured on the
   * owner's machine (node, vitest) before the fix: 3.1–3.8 ms with no WAL
   * snapshot stored, 7–8 ms with one (writeSnapshot parses the stored 1.4 MB
   * snapshot for its revision, then serialises the new one). With the
   * snapshot write skipped (the prototype of I4a), 0.13–0.18 ms. The frame
   * budget is 16.7 ms and the e2e autosave frame already peaks at 9.4 ms, so
   * the save's synchronous slice must stay a small share of the headroom;
   * 2 ms leaves >10× margin over the fixed cost on a slower CI box.
   */
  it('Given MAX_ACTIONS in the log, 5 000 world entries and a WAL snapshot already stored, When interval autosaves run, Then the fastest synchronous part is under 2 ms', async () => {
    const r = rig();
    await r.sg.saveNow('manual');
    const base = r.s.saved[0]!;
    const ids = Array.from({ length: 4 }, (_, k) => fyssField(k).asteroids.map((x) => x.id)).flat();
    const RES = ['ice', 'metal', 'silicate', 'rare'] as const;
    const actions: ActionEntry[] = [];
    for (let i = 1; i <= MAX_ACTIONS; i++) {
      const id = ids[i % ids.length]!;
      actions.push(
        i % 2
          ? {
              seq: i,
              source: 'cargo',
              payload: {
                action: { kind: 'mine', asteroidId: id, resource: 'ice', kg: 100 },
                result: { ok: true, kgIn: 100, kgOut: 0, fuelKg: 0, restoredFrac: 0 },
              },
              wallMs: WALL + i,
              orbitSeconds: 12_345.678 + i,
            }
          : { seq: i, source: 'mined', payload: { id, by: 'local', resource: 'ice', kg: 100 }, wallMs: WALL + i, orbitSeconds: 12_345.678 + i },
      );
    }
    const world = Array.from({ length: 5_000 }, (_, i) => ({
      id: ids[i % ids.length]!,
      by: 'local' as const,
      resource: RES[i % 4]!,
      kg: 100,
      wallMs: WALL + i,
      orbitSeconds: 1 + i,
    }));
    r.g.worldState.restore(world);
    const big: SaveV1 = { ...base, revision: 2, actions, world: { ...base.world, entries: world } };
    r.sg.continueFrom(big);
    r.g.journal.restore(actions);

    const wal = createWal(storage as unknown as Storage);
    const times: number[] = [];
    for (let k = 0; k < 5; k++) {
      // As a pagehide or a failed store write would have left it.
      expect(wal.writeSnapshot({ ...big, revision: r.sg.revision })).toBe(true);
      for (let i = 0; i < 20; i++) {
        bus.emit('propellant:action', { action: { kind: 'jump', distanceLy: 1 }, ok: true, kg: 0, tankDeltaKg: 0 });
      }
      const attempts = r.s.attempts.length;
      const t0 = performance.now();
      r.tick(AUTOSAVE_INTERVAL);
      times.push(performance.now() - t0);
      await flush();
      expect(r.s.attempts.length).toBe(attempts + 1); // it did save
    }
    const fastest = Math.min(...times);
    expect(fastest, `interval autosave sync ms: ${times.map((t) => t.toFixed(2)).join(' ')}`).toBeLessThan(2);
  });
});

describe('R25 M4 — a reader tab\'s journal does not grow without bound', () => {
  it('Given a reader tab, When MAX_ACTIONS + 1 000 named actions are announced and it ticks, Then its journal holds at most MAX_ACTIONS entries', () => {
    const r = rig({ writer: false });
    for (let i = 0; i < MAX_ACTIONS + 1_000; i++) {
      bus.emit('propellant:action', { action: { kind: 'jump', distanceLy: 1 }, ok: true, kg: 1, tankDeltaKg: -1 });
    }
    r.tick();
    expect(r.g.journal.peek().length).toBeLessThanOrEqual(MAX_ACTIONS);
  });
});

describe('R25 — registry.ts wires the fixes', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'registry.ts'), 'utf8');

  it('Given the registry, Then SaveGame is told whether the boot found the store usable (I2)', () => {
    const i = src.indexOf('new SaveGame(');
    expect(src.slice(i, src.indexOf(';', i))).toMatch(/storeAvailable:\s*boot\.storeAvailable/);
  });

  it('Given the registry, Then applySave does not place the ship again — the Universe was built in the save (M1)', () => {
    expect(src).toMatch(/applySave\(saveWorld, continued, \{ universeRestored: true \}\)/);
  });
});
