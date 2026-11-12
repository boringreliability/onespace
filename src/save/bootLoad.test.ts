/**
 * v4 sub-plan 3 (local save), Task 6 — boot: which save, and what it holds.
 *
 * The surface these tests pin (src/save/bootLoad.ts):
 *
 *   loadForBoot(store, wal): Promise<{
 *     save: SaveV1 | null;           // the save to CONTINUE, WAL entries merged; null = new game
 *     notice: string | null;         // one log line for the player, or null
 *     legacyLog: SaveV1['log'] | null; // the pre-save logbook, only when no save exists at all
 *   }>
 *   prepareNewGame(store, wal, load): Promise<{ afterRevision: number }>
 *   openingLog(load, start: 'continue' | 'new'): SaveV1['log']
 *   universeOptionsFor(route, save | null): UniverseOptions   // { seed?, restore? }
 *
 * Promises:
 *  - the save is the NEWEST VALID of IndexedDB current, IndexedDB previous and
 *    the WAL snapshot (`newestOf`; carried: a false from writeSnapshot never
 *    meant "the old snapshot is intact", so all three are simply compared);
 *  - nothing is discarded silently: an unreadable slot (invalid, unknown
 *    format, newer build) is kept with `store.keepCorrupt(raw, Date.now())`
 *    and the notice is `SAVE UNREADABLE — KEPT A COPY`;
 *  - a store that cannot be opened (an IDB `VersionError` after another tab
 *    upgraded the database) never crashes the boot: the WAL snapshot is used
 *    if there is one, else a new game, and the notice is
 *    `SAVE STORAGE UNAVAILABLE — RELOAD THE TAB`;
 *  - WAL critical entries are merged with DEDUP BY SEQ: an entry whose seq the
 *    chosen save already covers (in its actions, or ≤ a checkpoint's upToSeq)
 *    is not applied again; a newer one is appended to `actions` and applied to
 *    the ship by the replay rules (replay.ts `applyEntry`; a cannibalization
 *    also raises `emergencyTimesUsed` to its `timesUsed`), a `mined` entry is
 *    added to the world (P2), and a `beacon` emergency entry writes the
 *    logbook's `BEACON RECOVERY` note under the next `beacon:<n>` key;
 *  - the legacy logbook (`onespace.log.v1`) is offered for import only when
 *    no save exists at all, and its key is never deleted (backup);
 *  - NEW GAME (prepareNewGame) destroys nothing: the old game, WAL entries
 *    merged, is written back as revision + 1 and the WAL is emptied of it;
 *    the new game's first save (afterRevision + 1) pushes it to `previous`.
 */

import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseRoute } from '@/core/Route';
import { PROBE_TANK_CAPACITY_KG } from '@/ship/propellant';
import { BEACON_FILL_FRAC, BEACON_NOTE_TITLE, cannibalizeLossFrac } from '@/ship/emergency';
import { compactEntries } from './actionJournal';
import { loadForBoot, openingLog, prepareNewGame, universeOptionsFor } from './bootLoad';
import golden from './fixtures/v1-golden.json';
import legacy from './fixtures/v0-legacy-log.json';
import { idbStore } from './idbStore';
import { memoryStore } from './memoryStore';
import { migrate } from './migrate';
import { replay, zeroState, type ReplayState } from './replay';
import { SaveV1Schema, type ActionEntry, type SaveV1 } from './schema';
import type { SaveStore } from './store';
import { WAL_SNAPSHOT_KEY, createWal, type Wal } from './wal';

const WALL = 1_800_000_000_000;
const LEGACY_KEY = 'onespace.log.v1';
const UNREADABLE = 'SAVE UNREADABLE — KEPT A COPY';
const UNAVAILABLE = 'SAVE STORAGE UNAVAILABLE — RELOAD THE TAB';
const OTHER_UUID = '9b1d4c2a-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

/** An in-memory Storage (as in wal.test.ts). */
class FakeStorage implements Storage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
}

let storage: FakeStorage;
let wal: Wal;

beforeEach(() => {
  storage = new FakeStorage();
  vi.stubGlobal('localStorage', storage);
  wal = createWal(storage);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(WALL);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The golden save as storage gives it back, at revision `revision`. */
function save(revision = 7, over: Partial<SaveV1> = {}): SaveV1 {
  const m = migrate(structuredClone(golden));
  if (!m.ok) throw new Error(`golden refused: ${m.issues.join('; ')}`);
  return { ...m.save, revision, savedAt: { ...m.save.savedAt, wallMs: m.save.savedAt.wallMs + revision }, ...over };
}

/** A store holding `slots` written in order: the last is current, the one before previous. */
async function storeWith(...slots: unknown[]): Promise<ReturnType<typeof memoryStore>> {
  const s = memoryStore();
  for (const x of slots) await s.save(x as SaveV1);
  return s;
}

function walSnapshot(s: unknown): void {
  storage.setItem(WAL_SNAPSHOT_KEY, JSON.stringify(s));
}

/** A store whose `load` fails as an IDB open does after another tab's upgrade. */
function brokenStore(): SaveStore & { saved: SaveV1[] } {
  const saved: SaveV1[] = [];
  return {
    saved,
    load: () => Promise.reject(new DOMException('The requested version is less than the existing version', 'VersionError')),
    save: async (s) => {
      saved.push(s);
      throw new DOMException('closed', 'InvalidStateError');
    },
    keepCorrupt: () => Promise.reject(new DOMException('closed', 'InvalidStateError')),
  };
}

const at = { wallMs: 1762891300000, orbitSeconds: 5500 };
const G = save();
const GOLD_CARGO_KG = G.ship.cargo.ice + G.ship.cargo.metal + G.ship.cargo.silicate + G.ship.cargo.rare;
/** The beacon's fill on the golden ship: 5 % of the CURRENT capacity. */
const FILL = BEACON_FILL_FRAC * PROBE_TANK_CAPACITY_KG * (1 - G.ship.propellant.capacityLossFrac);

/**
 * A beacon paid after the golden save (its log ends at seq 12): the dry tank's
 * unannounced burn, the beacon's fill, the jettisoned hold, the exit itself.
 */
function beaconAfterGolden(first = 13): ActionEntry[] {
  return [
    { seq: first, source: 'thrust', payload: { kg: G.ship.propellant.massKg }, ...at },
    {
      seq: first + 1,
      source: 'propellant',
      payload: { action: { kind: 'beacon' }, ok: true, kg: 0, tankDeltaKg: FILL },
      ...at,
    },
    {
      seq: first + 2,
      source: 'cargo',
      payload: {
        action: { kind: 'jettison-all' },
        result: { ok: true, kgIn: 0, kgOut: GOLD_CARGO_KG, fuelKg: 0, restoredFrac: 0 },
      },
      ...at,
    },
    { seq: first + 3, source: 'emergency', payload: { kind: 'beacon' }, ...at },
  ];
}

function append(entries: readonly ActionEntry[]): void {
  for (const e of entries) expect(wal.appendCritical(e)).toBe(true);
}

const beaconNotes = (s: SaveV1) => s.log.entries.filter((e) => e.title === BEACON_NOTE_TITLE);
const bySource = (s: SaveV1, source: string, kind?: string) =>
  s.actions.filter(
    (e) => e.source === source && (kind === undefined || (e.payload as { kind?: string }).kind === kind),
  );

function stateOf(s: SaveV1): ReplayState {
  return { ...zeroState(), tank: { ...s.ship.propellant }, cargo: { ...s.ship.cargo } };
}

// =============================================================================

describe('loadForBoot — which save wins', () => {
  it('Given nothing stored anywhere, Then a new game: no save, no notice, no legacy log', async () => {
    expect(await loadForBoot(memoryStore(), wal)).toEqual({ save: null, notice: null, legacyLog: null });
  });

  it('Given IndexedDB revision 7 and a WAL snapshot of revision 8, Then the WAL snapshot wins, with no notice', async () => {
    walSnapshot(save(8));
    const r = await loadForBoot(await storeWith(save(7)), wal);
    expect(r.save?.revision).toBe(8);
    expect(r.notice).toBeNull();
  });

  it('Given IndexedDB revision 9 and a WAL snapshot of revision 8, Then IndexedDB wins', async () => {
    walSnapshot(save(8));
    expect((await loadForBoot(await storeWith(save(9)), wal)).save?.revision).toBe(9);
  });

  it('Given current 5, previous 4 and a WAL snapshot 6, Then the newest valid of the three (6) is taken — writeSnapshot\'s false is never read as "old snapshot intact"', async () => {
    walSnapshot(save(6));
    expect((await loadForBoot(await storeWith(save(4), save(5)), wal)).save?.revision).toBe(6);
  });

  it('Given a corrupt current and a valid previous (revision 6), Then previous is continued, the corrupt one is kept, and the notice says so', async () => {
    const bad = { ...save(9), ship: 'gone' };
    const store = await storeWith(save(6), bad);
    const r = await loadForBoot(store, wal);
    expect(r.save?.revision).toBe(6);
    expect(r.notice).toBe(UNREADABLE);
    expect(store.corrupt).toEqual([{ wallMs: WALL, raw: bad }]);
  });

  it('Given a corrupt current, a valid previous 4 and a WAL snapshot 3, Then previous (4) wins', async () => {
    walSnapshot(save(3));
    const r = await loadForBoot(await storeWith(save(4), { format: 1, junk: true }), wal);
    expect(r.save?.revision).toBe(4);
    expect(r.notice).toBe(UNREADABLE);
  });

  it('Given a format-99 save and nothing else, Then it is kept untouched, the notice says so, and it is a new game', async () => {
    const future = { ...save(12), format: 99 };
    const store = await storeWith(future);
    const r = await loadForBoot(store, wal);
    expect(r.save).toBeNull();
    expect(r.notice).toBe(UNREADABLE);
    expect(store.corrupt).toEqual([{ wallMs: WALL, raw: future }]);
  });

  it('Given a v1 save written by a newer build (a key this build does not know), Then it is kept, noticed, and a new game', async () => {
    const newer = { ...save(12), shields: { kg: 4 } };
    const store = await storeWith(newer);
    const r = await loadForBoot(store, wal);
    expect(r.save).toBeNull();
    expect(r.notice).toBe(UNREADABLE);
    expect(store.corrupt.map((c) => c.raw)).toEqual([newer]);
  });

  it('Given the loaded save, Then it is a valid SaveV1 (it came through migrate)', async () => {
    const r = await loadForBoot(await storeWith(save(7)), wal);
    expect(SaveV1Schema.safeParse(r.save).success).toBe(true);
  });
});

describe('loadForBoot — the store cannot be opened (carried: VersionError after another tab upgraded)', () => {
  it('Given load() rejects with a VersionError and a WAL snapshot of revision 8, Then the boot does not throw and continues the WAL snapshot, with a notice', async () => {
    walSnapshot(save(8));
    const r = await loadForBoot(brokenStore(), wal);
    expect(r.save?.revision).toBe(8);
    expect(r.notice).toBe(UNAVAILABLE);
  });

  it('Given load() rejects and no WAL snapshot, Then a new game with the notice (and no legacy import: a save may well exist)', async () => {
    storage.setItem(LEGACY_KEY, JSON.stringify(legacy));
    expect(await loadForBoot(brokenStore(), wal)).toEqual({ save: null, notice: UNAVAILABLE, legacyLog: null });
  });

  it('Given load() throws synchronously, Then it is handled the same way', async () => {
    const store: SaveStore = {
      load: () => {
        throw new Error('indexedDB is not available');
      },
      save: () => Promise.resolve(),
      keepCorrupt: () => Promise.resolve(),
    };
    expect((await loadForBoot(store, wal)).notice).toBe(UNAVAILABLE);
  });

  it('Given a real IndexedDB that another tab upgraded to version 2, Then idbStore().load() fails and loadForBoot still resolves to a new game with the notice', async () => {
    const name = `onespace-upgraded-${Math.random()}`;
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(name, 2);
      r.onsuccess = () => {
        r.result.close();
        resolve();
      };
      r.onerror = () => reject(r.error);
    });
    const r = await loadForBoot(idbStore(name), wal);
    expect(r.save).toBeNull();
    expect(r.notice).toBe(UNAVAILABLE);
  });

  it('Given keepCorrupt itself fails, Then the boot still resolves: previous continued, notice given', async () => {
    const inner = await storeWith(save(6), { format: 1 });
    const store: SaveStore = {
      load: () => inner.load(),
      save: (s) => inner.save(s),
      keepCorrupt: () => Promise.reject(new Error('quota')),
    };
    const r = await loadForBoot(store, wal);
    expect(r.save?.revision).toBe(6);
    expect(r.notice).toBe(UNREADABLE);
  });
});

describe('loadForBoot — WAL critical entries, dedup by seq (carried obligation 1)', () => {
  it('Given the WAL holds the beacon the save already has (same seq 12), Then nothing is applied twice: the save comes back unchanged', async () => {
    append(G.actions.filter((e) => e.seq === 12));
    const r = await loadForBoot(await storeWith(save(7)), wal);
    expect(r.save).toEqual(save(7));
  });

  it('Given a beacon paid AFTER the last IndexedDB save (seq 13–16 in the WAL), Then it is applied exactly once: tank at the beacon fill, hold empty, one BEACON RECOVERY note, its entries appended', async () => {
    append(beaconAfterGolden());
    const r = await loadForBoot(await storeWith(save(7)), wal);
    const s = r.save!;
    expect(s.revision).toBe(7);
    expect(s.saveId).toBe(G.saveId);
    expect(s.ship.propellant.massKg).toBeCloseTo(FILL, 6);
    expect(s.ship.propellant.capacityLossFrac).toBe(G.ship.propellant.capacityLossFrac);
    expect(s.ship.cargo).toEqual({ ice: 0, metal: 0, silicate: 0, rare: 0 });
    expect(s.actions.map((e) => e.seq)).toEqual([...G.actions.map((e) => e.seq), 13, 14, 15, 16]);
    const notes = beaconNotes(s);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ key: 'beacon:1', kind: 'note', system: G.player.system.name, visits: 1 });
    expect(notes[0]!.body.join(' ')).toContain(`${Math.round(GOLD_CARGO_KG)} kg`);
    expect(s.world).toEqual(G.world);
    expect(SaveV1Schema.safeParse(s).success).toBe(true);
  });

  it('Given that merged beacon, Then the books balance: replaying the appended entries over the saved ship gives the merged ship', async () => {
    append(beaconAfterGolden());
    const s = (await loadForBoot(await storeWith(save(7)), wal)).save!;
    const out = replay(stateOf(G), s.actions.slice(G.actions.length));
    expect(out.tank.massKg).toBeCloseTo(s.ship.propellant.massKg, 6);
    expect(out.tank.capacityLossFrac).toBeCloseTo(s.ship.propellant.capacityLossFrac, 12);
    expect(out.cargo).toEqual(s.ship.cargo);
  });

  it('Given the WAL holds old entries AND the new beacon (seq 10–16), Then only 13–16 are applied', async () => {
    append([...G.actions.filter((e) => e.seq >= 10), ...beaconAfterGolden()]);
    const s = (await loadForBoot(await storeWith(save(7)), wal)).save!;
    expect(s.actions.map((e) => e.seq)).toEqual([...G.actions.map((e) => e.seq), 13, 14, 15, 16]);
    expect(bySource(s, 'emergency', 'beacon')).toHaveLength(2); // golden's seq 12 + the new one
    expect(beaconNotes(s)).toHaveLength(1);
  });

  it('Given the merged save is saved (revision 8) and the WAL was not yet cleared, When the game boots again, Then the beacon is still there exactly once', async () => {
    append(beaconAfterGolden());
    const store = await storeWith(save(7));
    const first = (await loadForBoot(store, wal)).save!;
    await store.save({ ...first, revision: 8 });
    const again = (await loadForBoot(store, wal)).save!;
    expect(again.revision).toBe(8);
    expect(again.actions).toHaveLength(first.actions.length);
    expect(beaconNotes(again)).toHaveLength(1);
    expect(again.ship).toEqual(first.ship);
  });

  it("Given a save whose log is folded into a checkpoint (upToSeq 12), When the WAL holds seq 12, Then it is covered and not applied", async () => {
    const folded = save(7, { actions: compactEntries(G.actions, 1) });
    expect(folded.actions.some((e) => e.source === 'checkpoint')).toBe(true);
    append(G.actions.filter((e) => e.seq === 12));
    const s = (await loadForBoot(await storeWith(folded), wal)).save!;
    expect(s.actions).toEqual(folded.actions);
    expect(s.ship).toEqual(folded.ship);
  });

  it('Given the WAL snapshot wins (revision 8, log to seq 12) and the WAL holds 13–16, Then they are merged into the snapshot', async () => {
    walSnapshot(save(8));
    append(beaconAfterGolden());
    const s = (await loadForBoot(await storeWith(save(7)), wal)).save!;
    expect(s.revision).toBe(8);
    expect(s.actions.at(-1)!.seq).toBe(16);
    expect(beaconNotes(s)).toHaveLength(1);
  });

  it('Given a tank cannibalization after the save (timesUsed 2), Then the capacity loss and the tank follow the replay rules and emergencyTimesUsed becomes 2; no logbook note', async () => {
    const dry = save(7, { ship: { ...G.ship, propellant: { ...G.ship.propellant, massKg: 0 } } });
    const gain = 600;
    append([
      {
        seq: 13,
        source: 'propellant',
        payload: { action: { kind: 'cannibalize', part: 'tank', timesUsed: 1 }, ok: true, kg: 0, tankDeltaKg: gain },
        ...at,
      },
      { seq: 14, source: 'emergency', payload: { kind: 'cannibalize', timesUsed: 2 }, ...at },
    ]);
    const s = (await loadForBoot(await storeWith(dry), wal)).save!;
    expect(s.ship.propellant.capacityLossFrac).toBeCloseTo(G.ship.propellant.capacityLossFrac + cannibalizeLossFrac(1), 12);
    expect(s.ship.propellant.massKg).toBeCloseTo(gain, 9);
    expect(s.ship.emergencyTimesUsed).toBe(2);
    expect(s.log).toEqual(G.log);
  });

  it('Given a mine recorded after the save, Then the world gains its depletion (P2: by local, both clocks from the entry)', async () => {
    const id = G.world.entries[0]!.id;
    append([{ seq: 13, source: 'mined', payload: { id, by: 'local', resource: 'rare', kg: 5 }, ...at }]);
    const s = (await loadForBoot(await storeWith(save(7)), wal)).save!;
    expect(s.world.entries).toEqual([
      ...G.world.entries,
      { id, by: 'local', resource: 'rare', kg: 5, wallMs: at.wallMs, orbitSeconds: at.orbitSeconds },
    ]);
  });

  it('Given WAL entries but no save at all, Then a new game (there is nothing to apply them to)', async () => {
    append(beaconAfterGolden());
    expect((await loadForBoot(memoryStore(), wal)).save).toBeNull();
  });
});

describe('loadForBoot — the legacy logbook (carried obligation 6)', () => {
  it('Given no save and a legacy logbook, Then it is offered for import, and the old key is left in place', async () => {
    storage.setItem(LEGACY_KEY, JSON.stringify(legacy));
    const r = await loadForBoot(memoryStore(), wal);
    expect(r.save).toBeNull();
    expect(r.legacyLog).toEqual({ time: legacy.time, entries: legacy.entries });
    expect(storage.getItem(LEGACY_KEY)).toBe(JSON.stringify(legacy));
  });

  it('Given a save exists (the first save imported the log) and the legacy key is still there, Then it is NOT offered again and the save\'s own log is used as is', async () => {
    storage.setItem(LEGACY_KEY, JSON.stringify(legacy));
    const r = await loadForBoot(await storeWith(save(7)), wal);
    expect(r.legacyLog).toBeNull();
    expect(r.save!.log).toEqual(G.log);
  });

  it('Given only an unreadable save and a legacy logbook, Then the legacy log is not offered (it most likely lives in that save)', async () => {
    storage.setItem(LEGACY_KEY, JSON.stringify(legacy));
    expect((await loadForBoot(await storeWith({ format: 99 }), wal)).legacyLog).toBeNull();
  });

  it('Given an unreadable legacy logbook, Then nothing is offered and nothing throws', async () => {
    storage.setItem(LEGACY_KEY, '{"version":1,"entries":[{"key":""}]}');
    expect((await loadForBoot(memoryStore(), wal)).legacyLog).toBeNull();
  });
});

describe('openingLog — the log a boot starts with', () => {
  const empty = { time: 0, entries: [] };

  it('Given CONTINUE, Then the save\'s log', () => {
    expect(openingLog({ save: save(7), notice: null, legacyLog: null }, 'continue')).toEqual(G.log);
  });

  it('Given a new game and no save ever, Then the legacy logbook (imported once, into the first save)', () => {
    const legacyLog = { time: legacy.time, entries: legacy.entries } as SaveV1['log'];
    expect(openingLog({ save: null, notice: null, legacyLog }, 'new')).toEqual(legacyLog);
  });

  it('Given NEW GAME over a save, Then an empty log — the legacy entries belong to the old game', () => {
    expect(openingLog({ save: save(7), notice: null, legacyLog: null }, 'new')).toEqual(empty);
  });

  it('Given a new game and nothing at all, Then an empty log', () => {
    expect(openingLog({ save: null, notice: null, legacyLog: null }, 'new')).toEqual(empty);
  });
});

describe('prepareNewGame — NEW GAME destroys nothing (carried obligation 5)', () => {
  it('Given no save, Then afterRevision is 0 and the store is untouched', async () => {
    const store = memoryStore();
    const load = await loadForBoot(store, wal);
    expect(await prepareNewGame(store, wal, load)).toEqual({ afterRevision: 0 });
    expect(await store.load()).toEqual({ current: null, previous: null });
  });

  it('Given a save (7) with a beacon in the WAL, Then the old game, beacon merged, is stored as revision 8 and the WAL holds nothing of it', async () => {
    append(beaconAfterGolden());
    const store = await storeWith(save(7));
    const load = await loadForBoot(store, wal);
    expect(await prepareNewGame(store, wal, load)).toEqual({ afterRevision: 8 });
    const { current } = await store.load();
    expect((current as SaveV1).revision).toBe(8);
    expect((current as SaveV1).saveId).toBe(G.saveId);
    expect(beaconNotes(current as SaveV1)).toHaveLength(1);
    expect(wal.read()).toEqual({ snapshot: null, critical: [] });
  });

  it('Given NEW GAME confirmed but the tab closed before the new game saved, Then the next boot still offers the old game (beacon once)', async () => {
    append(beaconAfterGolden());
    const store = await storeWith(save(7));
    await prepareNewGame(store, wal, await loadForBoot(store, wal));
    const again = (await loadForBoot(store, wal)).save!;
    expect(again.saveId).toBe(G.saveId);
    expect(again.revision).toBe(8);
    expect(beaconNotes(again)).toHaveLength(1);
  });

  it("Given the new game's first save (afterRevision + 1, a fresh saveId), Then it is what the next boot continues, and the old game is kept as previous", async () => {
    const store = await storeWith(save(7));
    const { afterRevision } = await prepareNewGame(store, wal, await loadForBoot(store, wal));
    const fresh = save(afterRevision + 1, { saveId: OTHER_UUID, actions: [] });
    await store.save(fresh);
    const r = await loadForBoot(store, wal);
    expect(r.save?.saveId).toBe(OTHER_UUID);
    expect(r.save?.revision).toBe(9);
    const { previous } = await store.load();
    expect((previous as SaveV1).saveId).toBe(G.saveId);
  });

  it('Given the store cannot write, Then prepareNewGame still resolves with afterRevision above the old save (the new game outranks it)', async () => {
    walSnapshot(save(8));
    const store = brokenStore();
    const load = await loadForBoot(store, wal);
    await expect(prepareNewGame(store, wal, load)).resolves.toEqual({ afterRevision: 9 });
  });
});

describe('universeOptionsFor — the Universe a boot builds', () => {
  it('Given no save, Then the route decides: ?seed= or the default', () => {
    expect(universeOptionsFor(parseRoute(''), null)).toEqual({});
    expect(universeOptionsFor(parseRoute('?seed=1a2b'), null)).toEqual({ seed: 0x1a2b });
  });

  it("Given a save, Then its own universe (seed from universeId) and its place — a ?seed= on the link does not move the save to another universe", () => {
    const s = save(7);
    const o = universeOptionsFor(parseRoute('?seed=1a2b'), s);
    expect(o.seed).toBe(parseInt('1mwhji', 36));
    expect(o.restore).toEqual({
      system: s.player.system,
      orbitSeconds: s.savedAt.orbitSeconds,
      parentId: s.player.parentId,
      flight: {
        position: s.player.flight.position,
        velocity: s.player.flight.velocity,
        orientation: s.player.flight.orientation,
        grounded: false,
      },
      flightAssist: s.player.flight.flightAssist,
    });
  });

  it('Given a save marked grounded with no parent, Then the restore is not grounded (a corrupt save must not freeze the ship)', () => {
    const s = save(7, { player: { ...G.player, parentId: null, flight: { ...G.player.flight, grounded: true } } });
    expect(universeOptionsFor(parseRoute(''), s).restore?.flight.grounded).toBe(false);
  });
});

// =============================================================================
// Fix round 1 (rulings R17/R18)
//
// I1: WAL critical entries carry the saveId of the game that wrote them
// (`appendCritical(entry, saveId)`; `readTagged()` exposes `{ e, by, saveId }`).
// `mergeCritical` applies an entry only when
//   - its saveId is the chosen save's (an entry without a saveId: seq rule only),
//   - it is not tagged as covered by a revision ≤ the chosen save's (`by`),
//   - and its seq is above what the save covers.
// So an old game's entries can never leak into a new game, even when IndexedDB
// is unavailable and the WAL is all there is.
//
// Minors: keepCorrupt only in writer tabs (`loadForBoot(store, wal, { writer })`,
// writer by default), and never twice for an identical raw.
// I2: prepareNewGame keeps a copy of the replaced game on the kept shelf.
// =============================================================================

function appendAs(saveId: string, entries: readonly ActionEntry[]): void {
  for (const e of entries) expect(wal.appendCritical(e, saveId)).toBe(true);
}

describe('fix round 1 — I1: an old game\'s WAL entries never reach a new game', () => {
  it('Given IndexedDB unavailable, NEW GAME over save 7 with its beacon still in the WAL, and the new game\'s first save only in the WAL, When the game reloads, Then the new game comes back untouched', async () => {
    const store = brokenStore();
    walSnapshot(save(7));
    appendAs(G.saveId, beaconAfterGolden());
    const old = await loadForBoot(store, wal);
    expect(beaconNotes(old.save!)).toHaveLength(1);
    const { afterRevision } = await prepareNewGame(store, wal, old);
    const fresh = save(afterRevision + 1, { saveId: OTHER_UUID, actions: [] });
    expect(wal.writeSnapshot(fresh)).toBe(true);

    const r = await loadForBoot(store, wal);
    expect(r.save).toEqual(fresh);
  });

  it('Given entries WITHOUT a saveId tagged as covered by the old game (by 8), When the new game (revision 10, no actions) is loaded, Then they are not applied (the by rule)', async () => {
    const store = brokenStore();
    walSnapshot(save(7));
    append(beaconAfterGolden());
    const old = await loadForBoot(store, wal);
    await prepareNewGame(store, wal, old);
    const fresh = save(10, { saveId: OTHER_UUID, actions: [] });
    wal.writeSnapshot(fresh);
    expect((await loadForBoot(store, wal)).save).toEqual(fresh);
  });

  it('Given untagged entries written by the OLD game (saveId mismatch), When a different game is chosen, Then they are not applied (the saveId rule)', async () => {
    walSnapshot(save(3, { saveId: OTHER_UUID, actions: [] }));
    appendAs(G.saveId, beaconAfterGolden(1));
    const r = await loadForBoot(brokenStore(), wal);
    expect(r.save).toEqual(save(3, { saveId: OTHER_UUID, actions: [] }));
  });

  it("Given untagged entries written by THIS game (its saveId), Then they are applied (the reverse)", async () => {
    appendAs(G.saveId, beaconAfterGolden());
    const s = (await loadForBoot(await storeWith(save(7)), wal)).save!;
    expect(s.actions.at(-1)!.seq).toBe(16);
    expect(beaconNotes(s)).toHaveLength(1);
  });

  it("Given the new game's own entries in the WAL after its WAL snapshot, Then they are applied to it and the old game's are not", async () => {
    const fresh = save(10, { saveId: OTHER_UUID, actions: [] });
    walSnapshot(fresh);
    appendAs(G.saveId, beaconAfterGolden());
    appendAs(OTHER_UUID, [
      { seq: 1, source: 'thrust', payload: { kg: 100 }, ...at },
    ]);
    const s = (await loadForBoot(brokenStore(), wal)).save!;
    expect(s.actions.map((e) => e.seq)).toEqual([1]);
    expect(s.ship.propellant.massKg).toBeCloseTo(fresh.ship.propellant.massKg - 100, 9);
    expect(beaconNotes(s)).toHaveLength(0);
  });

  it('Given readTagged, Then each entry shows its saveId and whether a snapshot covers it (by)', () => {
    appendAs(G.saveId, beaconAfterGolden());
    expect(wal.readTagged().critical.map((c) => [c.e.seq, c.by, c.saveId])).toEqual([
      [13, null, G.saveId],
      [14, null, G.saveId],
      [15, null, G.saveId],
      [16, null, G.saveId],
    ]);
  });
});

describe('fix round 1 — keepCorrupt only by a writer, and once per identical raw', () => {
  it('Given a reader tab (writer: false), Then an unreadable slot is reported but not copied', async () => {
    const store = await storeWith(save(6), { format: 99 });
    const r = await loadForBoot(store, wal, { writer: false });
    expect(r.save?.revision).toBe(6);
    expect(store.corrupt).toHaveLength(0);
  });

  it('Given the same unreadable current slot over two boots, Then it is kept once', async () => {
    const store = await storeWith(save(6), { format: 99 });
    await loadForBoot(store, wal);
    await loadForBoot(store, wal);
    expect(store.corrupt).toHaveLength(1);
  });

  it('Given two DIFFERENT unreadable saves, Then both are kept', async () => {
    const store = await storeWith({ format: 98 }, { format: 99 });
    await loadForBoot(store, wal);
    expect(store.corrupt).toHaveLength(2);
  });
});

describe('fix round 1 — I2: NEW GAME keeps a copy of the replaced game', () => {
  it('Given a save (7) and its beacon in the WAL, When prepareNewGame runs, Then the merged old game is also on the kept shelf', async () => {
    appendAs(G.saveId, beaconAfterGolden());
    const store = await storeWith(save(7));
    await prepareNewGame(store, wal, await loadForBoot(store, wal));
    expect(store.corrupt).toHaveLength(1);
    const copy = store.corrupt[0]!.raw as SaveV1;
    expect(copy.saveId).toBe(G.saveId);
    expect(copy.revision).toBe(8);
    expect(beaconNotes(copy)).toHaveLength(1);
    expect(store.corrupt[0]!.wallMs).toBe(WALL);
  });

  it("Given the new game then saves twice (the old game leaves `previous`), Then the copy is still there", async () => {
    const store = await storeWith(save(7));
    const { afterRevision } = await prepareNewGame(store, wal, await loadForBoot(store, wal));
    await store.save(save(afterRevision + 1, { saveId: OTHER_UUID, actions: [] }));
    await store.save(save(afterRevision + 2, { saveId: OTHER_UUID, actions: [] }));
    const { current, previous } = await store.load();
    expect([(current as SaveV1).saveId, (previous as SaveV1).saveId]).toEqual([OTHER_UUID, OTHER_UUID]);
    expect(store.corrupt.map((c) => (c.raw as SaveV1).saveId)).toEqual([G.saveId]);
  });
});
