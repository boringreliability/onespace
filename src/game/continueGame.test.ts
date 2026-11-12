/**
 * v4 sub-plan 3 (local save), Task 6 — CONTINUE, end to end in node.
 *
 * Real Universe (GPU steps stubbed, as SaveGame.test.ts), real ShipLog,
 * WorldState, Belt, Emergency, ActionJournal and SaveGame, a memory store and
 * a real WAL on an in-memory localStorage. A "boot" here is the part of
 * registry.ts (`loadBoot` → `registerModules`) a node test can run:
 * `loadForBoot` → `universeOptionsFor` → a new Universe → `applySave` →
 * `saveGame.continueFrom(save)` before flight. It skips the decisions
 * (decideBoot, boot.test.ts) and the log imported before the world
 * (`logBeforeWorld`, pinned below on its own).
 *
 * Promises (Task 6 brief + carried obligations):
 *  - a Universe built from a save enters the SAVED system on init: no
 *    `system:entered` for the start system, and the first frame is the save's;
 *  - continueFrom(loaded) → the next save is revision loaded + 1, same saveId,
 *    the loaded action log as its prefix; continueFrom clears what the title
 *    screen's opening world queued (no save of that world);
 *  - startNew(afterRevision) (NEW GAME) → the next save is afterRevision + 1
 *    under a fresh saveId, with none of the old game's actions;
 *  - a beacon paid after the last IndexedDB save survives a crash exactly
 *    once: tank at the beacon's fill, hold empty, one BEACON RECOVERY note;
 *    the books-balance test beside it is a guard (it also held before the
 *    merge existed, since an unmerged save balances trivially);
 *  - depletion after Continue: a mined rock is still mined.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import type { ActionName } from '@/core/Input';
import { modes, type BaseMode } from '@/core/Modes';
import { parseRoute } from '@/core/Route';
import { Belt } from '@/game/Belt';
import { Emergency } from '@/game/Emergency';
import { ShipLog } from '@/game/Log';
import { Universe, type UniverseOptions } from '@/game/Universe';
import { fyssField, nodeCtx } from '@/game/testing/beltFixture';
import { WorldState, type MinedEntry } from '@/game/worldState';
import { applyCargoAction } from '@/ship/cargo';
import { BEACON_FILL_FRAC, BEACON_NOTE_TITLE } from '@/ship/emergency';
import { PROBE_TANK_CAPACITY_KG, START_FILL } from '@/ship/propellant';
import { ActionJournal } from '@/save/actionJournal';
import { loadForBoot, universeOptionsFor } from '@/save/bootLoad';
import { applySave, type SaveWorld } from '@/save/capture';
import { memoryStore } from '@/save/memoryStore';
import { replay, zeroState } from '@/save/replay';
import type { SaveV1 } from '@/save/schema';
import { createWal, type Wal } from '@/save/wal';
import { SaveGame } from './SaveGame';

const RENDER_STEPS = ['streamRenderers', 'updateBodies', 'updateStar', 'publishMotionReference', 'refreshAtmosphere'];
const WALL = 1_800_000_000_000;
const START = 'Fyss';

type CriticalUse = { kind: 'cannibalize' | 'cannibalize-cargo' | 'beacon'; timesUsed?: number };

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
let wal: Wal;
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
  wal = createWal(storage as unknown as Storage);
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

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

function stubRender(u: Universe): void {
  const raw = u as unknown as Record<string, unknown>;
  for (const k of RENDER_STEPS) raw[k] = () => undefined;
}

interface Live {
  u: Universe;
  ctx: EngineContext;
  w: SaveWorld;
  worldState: WorldState;
  shipLog: ShipLog;
  belt: Belt;
  sg: SaveGame;
  press(action: ActionName): void;
}

/**
 * One tab's game, wired as the registry wires it, booted with `options`
 * (a new game by default) and a writer SaveGame on the shared store and WAL.
 */
function live(store: ReturnType<typeof memoryStore>, options: UniverseOptions = {}): Live {
  const ctx = nodeCtx();
  const shipLog = new ShipLog();
  shipLog.init();
  const u = new Universe(options);
  const journal = new ActionJournal({ wallMs: () => Date.now(), orbitSeconds: () => u.orbitSeconds });
  const worldState = new WorldState({
    orbitSeconds: () => u.orbitSeconds,
    wallMs: () => Date.now(),
    onMined: (e: MinedEntry) => journal.noteMined(e),
  });
  u.init(ctx);
  stubRender(u);
  const belt = new Belt({ universe: u, worldState });
  const hook: { fn: ((x: CriticalUse) => void) | null } = { fn: null };
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
  const sg = new SaveGame({
    world: w,
    store,
    wal,
    lock: { writer: true, release: () => undefined },
    page: null,
  } as unknown as ConstructorParameters<typeof SaveGame>[0]);
  hook.fn = (used) => sg.critical(used);
  sg.init();
  offs.push(() => {
    sg.dispose();
    shipLog.dispose();
    journal.dispose();
  });
  return {
    u,
    ctx,
    w,
    worldState,
    shipLog,
    belt,
    sg,
    press: (action) => {
      const input = { pressed: (a: ActionName) => a === action, setThrottle: () => undefined };
      emergency.update(1 / 60, { ...ctx, input } as unknown as EngineContext);
    },
  };
}

/** A boot from storage, as registry.ts does it: load, build the Universe in the save, apply, continue. */
async function boot(store: ReturnType<typeof memoryStore>): Promise<{ g: Live; save: SaveV1 }> {
  const load = await loadForBoot(store, wal);
  expect(load.save).not.toBeNull();
  const g = live(store, universeOptionsFor(parseRoute(''), load.save));
  expect(applySave(g.w, load.save!)).toBe(true);
  g.sg.continueFrom(load.save);
  return { g, save: load.save! };
}

const ASTEROID = (): string => fyssField(0).asteroids[0]!.id;

function mine(g: Live, asteroidId: string, resource: 'ice' | 'metal' | 'silicate' | 'rare', kg: number): void {
  const r = applyCargoAction(g.u.cargo, g.u.flight.propellant, { kind: 'mine', asteroidId, resource, kg });
  expect(r.ok).toBe(true);
  g.worldState.recordMined(asteroidId, resource, r.kgIn, 'local');
}

async function current(store: ReturnType<typeof memoryStore>): Promise<SaveV1> {
  return (await store.load()).current as SaveV1;
}

// =============================================================================

describe('Universe from a save — the saved system, from the first frame', () => {
  it('Given a save in a neighbour of Fyss, When the boot builds its Universe with universeOptionsFor, Then system:entered fires only for the neighbour and the first frame is in it', async () => {
    const store = memoryStore();
    const g0 = live(store);
    expect(g0.u.system.name).toBe(START);
    await g0.sg.saveNow('manual');
    const n = g0.u.neighbours(60, 16).find((s) => s.id !== g0.u.system.id)!;
    expect(n).toBeDefined();
    const s0 = await current(store);
    const there: SaveV1 = {
      ...s0,
      player: {
        system: { id: n.id, seed: n.seed, name: n.name, positionLy: [n.position[0], n.position[1], n.position[2]] },
        parentId: null,
        flight: { ...s0.player.flight, position: [0, 0, 9e8], grounded: false },
      },
    };

    const entered: string[] = [];
    offs.push(bus.on('system:entered', ({ system }) => entered.push(system.id)));
    const u = new Universe(universeOptionsFor(parseRoute(''), there));
    u.init(nodeCtx());
    stubRender(u);

    expect(entered).toEqual([n.id]);
    expect(u.system.id).toBe(n.id);
    expect(u.restoreFailed).toBe(false);
  });
});

describe('continueFrom / startNew — revisions go on (carried obligation 4)', () => {
  it('Given a loaded save of revision r, When continued and saved, Then the save is r + 1 with the same saveId and the loaded log as its prefix', async () => {
    const store = memoryStore();
    const g0 = live(store);
    mine(g0, ASTEROID(), 'ice', 200);
    await g0.sg.saveNow('manual');
    await g0.sg.saveNow('manual');
    const { g, save } = await boot(store);
    expect(save.revision).toBe(2);

    await g.sg.saveNow('manual');
    const next = await current(store);
    expect(next.revision).toBe(3);
    expect(next.saveId).toBe(save.saveId);
    expect(next.actions.slice(0, save.actions.length)).toEqual(save.actions);
  });

  it('Given triggers queued while the title showed the opening world, When continueFrom runs before flight, Then they are dropped: no save of that world', async () => {
    const store = memoryStore();
    const g0 = live(store);
    await g0.sg.saveNow('manual');
    const load = await loadForBoot(store, wal);
    toMode('title');
    const g = live(store, universeOptionsFor(parseRoute(''), load.save));
    bus.emit('planet:landed', { planet: g.u.system.planets[0]! });
    applySave(g.w, load.save!);
    g.sg.continueFrom(load.save);
    toMode('flight');
    for (let i = 0; i < 60; i++) g.sg.update(1 / 10, g.ctx);
    await flush();
    expect((await current(store)).revision).toBe(1);
  });

  it('Given NEW GAME over a save, When startNew(afterRevision) and the new game saves, Then revision afterRevision + 1, a fresh saveId, none of the old actions', async () => {
    const store = memoryStore();
    const g0 = live(store);
    mine(g0, ASTEROID(), 'metal', 150);
    await g0.sg.saveNow('manual');
    const old = await current(store);

    const g = live(store);
    g.sg.startNew(8);
    await g.sg.saveNow('manual');
    const fresh = await current(store);
    expect(fresh.revision).toBe(9);
    expect(fresh.saveId).not.toBe(old.saveId);
    expect(old.actions.some((e) => e.source === 'mined')).toBe(true);
    expect(fresh.actions.some((e) => e.source === 'cargo' || e.source === 'mined')).toBe(false);
    expect(fresh.world.entries).toEqual([]);
  });
});

describe('A beacon paid after the last save survives a crash — exactly once (carried obligation 1)', () => {
  async function crashAfterBeacon(): Promise<{ store: ReturnType<typeof memoryStore>; paidKg: number; lossFrac: number }> {
    const store = memoryStore();
    const g0 = live(store);
    mine(g0, ASTEROID(), 'ice', 400);
    await g0.sg.saveNow('manual');
    expect((await current(store)).revision).toBe(1);
    const tank = g0.u.flight.propellant!;
    tank.consume(tank.massKg); // an unannounced burn to dry
    g0.press('emergency');
    g0.press('emergencyBeacon');
    expect(tank.massKg).toBeGreaterThan(0);
    // The tab dies here: no tick, no hidden, no pagehide — only the WAL has the beacon.
    return { store, paidKg: tank.massKg, lossFrac: tank.capacityLossFrac };
  }

  it('Given the crash, When the game boots and continues, Then the ship has the beacon fill, an empty hold and ONE beacon note', async () => {
    const { store, paidKg, lossFrac } = await crashAfterBeacon();
    expect(paidKg).toBeCloseTo(BEACON_FILL_FRAC * PROBE_TANK_CAPACITY_KG * (1 - lossFrac), 6);
    const { g } = await boot(store);
    expect(g.u.flight.propellant!.massKg).toBeCloseTo(paidKg, 6);
    expect(g.u.cargo.snapshot()).toEqual({ ice: 0, metal: 0, silicate: 0, rare: 0 });
    expect(g.shipLog.exportState().entries.filter((e) => e.title === BEACON_NOTE_TITLE)).toHaveLength(1);
  });

  it('Given the crash, Then the loaded books balance: replaying the whole log from the opening tank gives the loaded ship', async () => {
    const { store } = await crashAfterBeacon();
    const save = (await loadForBoot(store, wal)).save!;
    const out = replay(
      { ...zeroState(), tank: { massKg: START_FILL * PROBE_TANK_CAPACITY_KG, capacityLossFrac: 0 } },
      save.actions,
    );
    expect(out.tank.massKg).toBeCloseTo(save.ship.propellant.massKg, 6);
    expect(out.cargo).toEqual(save.ship.cargo);
    expect(out.emergency.beacon).toBe(1);
  });

  it('Given the crash, When the game boots twice without saving, and then boots, saves and boots again, Then the beacon is there exactly once every time', async () => {
    const { store, paidKg } = await crashAfterBeacon();
    const a = (await loadForBoot(store, wal)).save!;
    const b = (await loadForBoot(store, wal)).save!;
    expect(b).toEqual(a);

    const { g } = await boot(store);
    await g.sg.saveNow('manual');
    const saved = await current(store);
    expect(saved.revision).toBe(2);
    expect(saved.actions.filter((e) => e.source === 'emergency')).toHaveLength(1);

    const c = (await loadForBoot(store, wal)).save!;
    expect(c.actions.filter((e) => e.source === 'emergency')).toHaveLength(1);
    expect(c.log.entries.filter((e) => e.title === BEACON_NOTE_TITLE)).toHaveLength(1);
    expect(c.ship.propellant.massKg).toBeCloseTo(paidKg, 6);
  });
});

describe('Depletion after Continue', () => {
  it('Given a mined rock, When continued, Then remainingKg is still reduced', async () => {
    const store = memoryStore();
    const g0 = live(store);
    const id = ASTEROID();
    g0.belt.update(1 / 60, g0.ctx);
    const before = g0.belt.remainingKg(id, 'ice');
    expect(before).toBeGreaterThan(300);
    mine(g0, id, 'ice', 300);
    await g0.sg.saveNow('manual');

    const { g } = await boot(store);
    g.belt.update(1 / 60, g.ctx);
    expect(g.belt.remainingKg(id, 'ice')).toBeCloseTo(before - 300, 6);
  });
});
