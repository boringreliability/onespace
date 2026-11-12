/**
 * v4 sub-plan 3, Task 6 fix round 1 (rulings R17/R18) — live checks.
 *
 * Real Universe (GPU steps stubbed), ShipLog, WorldState, Emergency,
 * ActionJournal and SaveGame, as continueGame.test.ts.
 *
 *  - I1: every WAL entry `SaveGame.critical` writes carries the saveId of the
 *    game it belongs to — a new game's before its first save too (the saveId
 *    is decided when the game starts, and the first save uses it);
 *  - the log imported before the world is `logBeforeWorld(load)`: a failed
 *    restore keeps the new start's arrival and none of the old game's
 *    entries; a successful one ends with exactly the save's log;
 *  - registry.ts (source): the boot goes through decideBoot /
 *    restartAfterRestoreFail / logBeforeWorld, and the world handed to
 *    SaveGame and to applySave have the same keys. Title.ts issues the nonce.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import type { ActionName } from '@/core/Input';
import { modes, type BaseMode } from '@/core/Modes';
import { parseRoute } from '@/core/Route';
import { Emergency } from '@/game/Emergency';
import { ShipLog } from '@/game/Log';
import { Universe, type UniverseOptions } from '@/game/Universe';
import { nodeCtx } from '@/game/testing/beltFixture';
import { WorldState, type MinedEntry } from '@/game/worldState';
import { ActionJournal } from '@/save/actionJournal';
import { logBeforeWorld } from '@/save/boot';
import { loadForBoot, universeOptionsFor } from '@/save/bootLoad';
import { applySave, type SaveWorld } from '@/save/capture';
import { memoryStore } from '@/save/memoryStore';
import type { SaveV1 } from '@/save/schema';
import { createWal, type Wal } from '@/save/wal';
import { SaveGame } from './SaveGame';

const RENDER_STEPS = ['streamRenderers', 'updateBodies', 'updateStar', 'publishMotionReference', 'refreshAtmosphere'];
const WALL = 1_800_000_000_000;

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

function stubRender(u: Universe): void {
  const raw = u as unknown as Record<string, unknown>;
  for (const k of RENDER_STEPS) raw[k] = () => undefined;
}

interface Live {
  u: Universe;
  w: SaveWorld;
  shipLog: ShipLog;
  sg: SaveGame;
  press(action: ActionName): void;
  dry(): void;
}

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
    w,
    shipLog,
    sg,
    press: (action) => {
      const input = { pressed: (a: ActionName) => a === action, setThrottle: () => undefined };
      emergency.update(1 / 60, { ...ctx, input } as unknown as EngineContext);
    },
    dry: () => {
      const tank = u.flight.propellant!;
      tank.consume(tank.massKg);
    },
  };
}

async function current(store: ReturnType<typeof memoryStore>): Promise<SaveV1> {
  return (await store.load()).current as SaveV1;
}

const beacon = (g: Live): void => {
  g.dry();
  g.press('emergency');
  g.press('emergencyBeacon');
};

// =============================================================================

describe('SaveGame.critical — WAL entries carry their game (I1)', () => {
  it('Given a NEW game before its first save, When the beacon fires, Then every WAL entry carries one saveId — the one its first save then gets', async () => {
    const store = memoryStore();
    const g = live(store);
    g.sg.startNew(0);
    beacon(g);
    const tagged = wal.readTagged().critical;
    expect(tagged.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(tagged.map((c) => c.saveId));
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await g.sg.saveNow('manual');
    expect((await current(store)).saveId).toBe(id);
  });

  it("Given a continued game, When the beacon fires, Then the WAL entries carry the loaded save's saveId", async () => {
    const store = memoryStore();
    const g0 = live(store);
    g0.sg.startNew(0);
    await g0.sg.saveNow('manual');
    const load = await loadForBoot(store, wal);
    const g = live(store, universeOptionsFor(parseRoute(''), load.save));
    expect(applySave(g.w, load.save!)).toBe(true);
    g.sg.continueFrom(load.save);
    beacon(g);
    const ids = wal.readTagged().critical.map((c) => c.saveId);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set([load.save!.saveId]));
  });

  it('Given NEW GAME (startNew) after a save, Then the new game\'s entries do not carry the old saveId', async () => {
    const store = memoryStore();
    const g0 = live(store);
    g0.sg.startNew(0);
    await g0.sg.saveNow('manual');
    const old = await current(store);
    const g = live(store);
    g.sg.startNew(old.revision + 1);
    beacon(g);
    expect(wal.readTagged().critical.some((c) => c.saveId === old.saveId)).toBe(false);
  });
});

describe('logBeforeWorld — what a failed restore leaves in the logbook', () => {
  async function savedGame(): Promise<{ store: ReturnType<typeof memoryStore>; save: SaveV1 }> {
    const store = memoryStore();
    const g0 = live(store);
    g0.sg.startNew(0);
    await g0.sg.saveNow('manual');
    const s = await current(store);
    const marked: SaveV1 = {
      ...s,
      log: {
        time: s.log.time,
        entries: [
          ...s.log.entries,
          { key: 'note:old-game', kind: 'note', at: 1, system: 'Fyss', title: 'OLD GAME', body: ['x'], visits: 1 },
        ],
      },
    };
    await store.save(marked);
    return { store, save: marked };
  }

  it("Given a save whose system cannot be found, When the boot imports logBeforeWorld then builds the Universe (it falls back to the start), Then the log holds the new start's arrival and nothing of the old game", async () => {
    const { save } = await savedGame();
    const lost: SaveV1 = { ...save, player: { ...save.player, system: { ...save.player.system, id: 'gx-nowhere--0.0.0' }, parentId: null } };
    const load = { save: lost, notice: null, legacyLog: null };

    const log = new ShipLog();
    log.init();
    offs.push(() => log.dispose());
    log.importState(logBeforeWorld(load));
    const u = new Universe(universeOptionsFor(parseRoute(''), lost));
    u.init(nodeCtx());
    stubRender(u);

    expect(u.restoreFailed).toBe(true);
    const entries = log.exportState().entries;
    expect(entries.map((e) => e.key)).toEqual([`sys:${u.system.id}`]);
    expect(entries[0]!.visits).toBe(1);
  });

  it('Given a save that restores, When the boot imports logBeforeWorld, builds the Universe and applies the save, Then the log is exactly the save\'s', async () => {
    const { store } = await savedGame();
    const load = await loadForBoot(store, wal);
    const g = live(store, universeOptionsFor(parseRoute(''), load.save));
    g.shipLog.importState(logBeforeWorld(load));
    expect(applySave(g.w, load.save!)).toBe(true);
    expect(g.shipLog.exportState()).toEqual(load.save!.log);
  });
});

describe('registry.ts and Title.ts — the boot is wired through the tested seams (source)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const registry = readFileSync(join(here, 'registry.ts'), 'utf8');
  const title = readFileSync(join(here, '..', 'ui', 'Title.ts'), 'utf8');

  /** The keys of the object literal that starts at `start` (shorthand or `key:`), sorted. */
  function keysAt(src: string, start: string): string[] {
    const i = src.indexOf(start);
    expect(i, `${start} not found`).toBeGreaterThanOrEqual(0);
    const open = src.indexOf('{', i + start.length - 1);
    const close = src.indexOf('}', open);
    return src
      .slice(open + 1, close)
      .split(',')
      .map((p) => p.trim().split(':')[0]!.trim())
      .filter((k) => k.length > 0)
      .sort();
  }

  it('Given the registry, Then the world SaveGame gets and the world applySave gets have the same keys', () => {
    const forSave = keysAt(registry, 'world: {');
    const forApply = keysAt(registry, 'const saveWorld = {');
    expect(forSave.length).toBeGreaterThanOrEqual(7);
    expect(forApply).toEqual(forSave);
  });

  it('Given the registry, Then loadBoot goes through decideBoot, the failed restore through restartAfterRestoreFail, and logBeforeWorld is imported before the Universe is built', () => {
    expect(registry).toMatch(/decideBoot\(/);
    expect(registry).toMatch(/restartAfterRestoreFail\(/);
    const log = registry.indexOf('logBeforeWorld(');
    expect(log).toBeGreaterThanOrEqual(0);
    expect(log).toBeLessThan(registry.indexOf('new Universe('));
    expect(registry).not.toMatch(/openingLog\(/);
    expect(registry).not.toMatch(/prepareNewGame\(/);
  });

  it('Given Title, Then the confirmed NEW GAME issues the one-time nonce and puts it in the reload', () => {
    expect(title).toMatch(/issueNewGameNonce\(/);
    expect(title).toMatch(/newGameSearch\([^)]*,/);
  });
});
