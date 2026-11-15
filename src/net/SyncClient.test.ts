/**
 * v4 sub-plan 4, Task 5 (phase A) — `SyncClient`: boot, push and resolve
 * (R30, R31; DESIGN-4 §5.2–5.4). The local save stays the truth on the device.
 *
 * Pinned surface (src/net/SyncClient.ts):
 *
 *   PUSH_MIN_INTERVAL_MS === 5_000          // ≥ 5 s between PUT starts
 *   PUSH_BACKOFF_MS == [5_000, 15_000, 60_000, 300_000]   // then 300 s repeatedly
 *   SYNC_OFFLINE_TEXT  === 'OFFLINE — SAVED LOCALLY'
 *   SYNC_REAUTH_TEXT   === 'SIGN IN AGAIN TO SYNC'
 *   SYNC_CONFLICT_TEXT === 'SYNC CONFLICT — CHOOSE ON NEXT START'
 *   type SyncStatus = 'off' | 'synced' | 'pending' | 'offline' | 'reauth' | 'conflict'
 *   type BootDecision = Decision | { kind: 'local-only'; reason: 'reader' | 'offline' | 'timeout' | 'unreadable' }
 *   interface BootSync { decision: BootDecision; cloud: SaveV1 | null; notice: string | null }
 *   new SyncClient({
 *     api: Api,
 *     storage: StorageLike | null,           // the sync state lives here (onespace.sync.v1)
 *     isWriter: () => boolean,
 *     schedule: (fn: () => void, ms: number) => () => void,   // a timer; returns cancel
 *     store: SaveStore,                      // boot/resolve write the chosen save here
 *     wal: Wal,                              // superseded when the local save is replaced
 *     uuid: () => string,                    // deviceId, generated once
 *     clearLocal: () => Promise<void>,       // empties the store's slots (switch-account)
 *   })
 *   .boot(local: SaveV1 | null): Promise<BootSync>
 *   .onStored(save: SaveV1): void           // never works synchronously
 *   .status(): SyncStatus                   // 'pending' while a save is queued or in flight
 *   .statusText(): string | null            // offline/reauth/conflict → the texts; else null
 *   .resolve(keep: 'device' | 'cloud'):
 *      Promise<{ ok: true; save: SaveV1 } | { ok: false; reason: 'offline' | 'reauth' | 'moved'; cloud?: SaveV1 }>
 *
 * Timers: vitest fake timers; `schedule` is setTimeout-backed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadForBoot } from '@/save/bootLoad';
import type { SaveV1 } from '@/save/schema';
import { createWal, type Wal } from '@/save/wal';

import {
  ACCT_A,
  ACCT_B,
  DEVICE_ID,
  GAME_X,
  GAME_Y,
  MemoryStorage,
  ThrowingStorage,
  WALL,
  cloudReply,
  criticalEntry,
  deferred,
  fail,
  fakeApi,
  head,
  never,
  noSave,
  ok,
  save,
  syncState,
  testStore,
  timerSchedule,
  type FakeApi,
  type TestStore,
} from './__fixtures__/sync';
import { reconcile } from './reconcile';
import {
  PUSH_BACKOFF_MS,
  PUSH_MIN_INTERVAL_MS,
  SYNC_CONFLICT_TEXT,
  SYNC_OFFLINE_TEXT,
  SYNC_REAUTH_TEXT,
  SyncClient,
} from './SyncClient';
import type { StorageLike, SyncState } from './syncState';

const SYNC_KEY = 'onespace.sync.v1';

interface Rig {
  sync: SyncClient;
  api: FakeApi;
  storage: MemoryStorage;
  ts: TestStore;
  walStorage: MemoryStorage;
  wal: Wal;
  schedule: ReturnType<typeof vi.fn>;
  /** The persisted sync state. */
  state(): SyncState;
}

function rig(
  o: {
    state?: SyncState | null;
    api?: Partial<FakeApi['reply']>;
    writer?: boolean;
    storage?: StorageLike;
    ts?: TestStore;
    walStorage?: MemoryStorage;
  } = {},
): Rig {
  const storage = new MemoryStorage();
  if (o.state !== null) storage.setItem(SYNC_KEY, JSON.stringify(o.state ?? syncState()));
  const api = fakeApi(o.api);
  const ts = o.ts ?? testStore();
  const walStorage = o.walStorage ?? new MemoryStorage();
  const wal = createWal(walStorage as unknown as Storage);
  const schedule = vi.fn(timerSchedule);
  const sync = new SyncClient({
    api,
    storage: o.storage ?? storage,
    isWriter: () => o.writer ?? true,
    schedule,
    store: ts.store,
    wal,
    uuid: () => DEVICE_ID,
    clearLocal: () => ts.clearLocal(),
  });
  return {
    sync,
    api,
    storage,
    ts,
    walStorage,
    wal,
    schedule,
    state: () => JSON.parse(storage.getItem(SYNC_KEY)!) as SyncState,
  };
}

const boundB = (L: SaveV1 | null, o: Partial<SyncState> = {}): SyncState =>
  syncState({ accountId: ACCT_B.id, accountName: ACCT_B.name, lastSeenCloud: L ? head(L) : null, ...o });
const boundA = (L: SaveV1 | null, o: Partial<SyncState> = {}): SyncState =>
  syncState({ accountId: ACCT_A.id, accountName: ACCT_A.name, lastSeenCloud: L ? head(L) : null, ...o });

/** Signed in as B, in sync at X r7: status 'synced', nothing pushed yet. */
async function signedIn(api: Partial<FakeApi['reply']> = {}, o: { storage?: StorageLike } = {}): Promise<Rig> {
  const r = rig({ state: boundB(save({ revision: 7 })), api: { getSave: () => cloudReply(save({ revision: 7 })), ...api }, ...o });
  const b = await r.sync.boot(save({ revision: 7 }));
  expect(b.decision.kind).toBe('in-sync');
  return r;
}

const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(Math.max(0, ms));
};
const TEN_MIN = 600_000;

/** Advance in 100 ms steps until `n` PUTs have started (at most PUSH_MIN_INTERVAL_MS + 100). */
async function untilPut(api: FakeApi, n = 1): Promise<void> {
  for (let t = 0; t <= 5_100 && api.puts.length < n; t += 100) await settle(100);
  expect(api.puts.length).toBeGreaterThanOrEqual(n);
}

/** Start-to-start gaps of the PUTs made so far. */
const gaps = (api: FakeApi): number[] => api.putTimes.slice(1).map((t, i) => t - api.putTimes[i]!);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(WALL);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// =============================================================================

describe('SyncClient — constants and texts', () => {
  it('Given the module, Then the push spacing, backoff and texts are verbatim', () => {
    expect(PUSH_MIN_INTERVAL_MS).toBe(5_000);
    expect([...PUSH_BACKOFF_MS]).toEqual([5_000, 15_000, 60_000, 300_000]);
    expect(SYNC_OFFLINE_TEXT).toBe('OFFLINE — SAVED LOCALLY');
    expect(SYNC_REAUTH_TEXT).toBe('SIGN IN AGAIN TO SYNC');
    expect(SYNC_CONFLICT_TEXT).toBe('SYNC CONFLICT — CHOOSE ON NEXT START');
  });

  it("Given a client before boot, Then status is 'off' and statusText null", () => {
    const r = rig();
    expect(r.sync.status()).toBe('off');
    expect(r.sync.statusText()).toBeNull();
  });
});

describe('SyncClient.boot — a reader tab (Review Focus 3)', () => {
  it('Given a reader tab, When boot, Then local-only/reader, no save call reaches the network, and the store is untouched', async () => {
    const r = rig({ writer: false, state: boundB(save({ revision: 7 })) });
    const b = await r.sync.boot(save({ revision: 9 }));
    expect(b).toEqual({ decision: { kind: 'local-only', reason: 'reader' }, cloud: null, notice: null });
    expect(r.api.calls.filter((c) => c === 'getSave' || c === 'putSave' || c === 'resolve')).toEqual([]);
    expect(r.ts.calls).toEqual([]);
    expect(r.sync.status()).toBe('off');
  });

  it('Given a reader tab, When onStored is called again and again over 10 minutes, Then it never PUTs', async () => {
    const r = rig({ writer: false, state: boundB(save({ revision: 7 })) });
    await r.sync.boot(save({ revision: 9 }));
    for (let i = 10; i < 20; i++) {
      r.sync.onStored(save({ revision: i }));
      await settle(60_000);
    }
    expect(r.api.puts).toEqual([]);
    expect(r.sync.status()).toBe('off');
  });
});

describe('SyncClient.boot — one 3 s budget for me() and getSave()', () => {
  it('Given me() is still pending, Then getSave() has already been called (they run in parallel)', async () => {
    const r = rig({ state: boundB(save()), api: { me: never, getSave: never } });
    void r.sync.boot(save());
    await settle(0);
    expect(r.api.calls).toContain('me');
    expect(r.api.calls).toContain('getSave');
  });

  it('Given neither me() nor getSave() answers, When boot, Then it resolves at 3 000 ms — not before — as local-only/timeout, with no conflict and the local save untouched', async () => {
    const r = rig({ state: boundB(save({ revision: 7 })), api: { me: never, getSave: never } });
    let b: unknown = null;
    void r.sync.boot(save({ revision: 9 })).then((x) => (b = x));
    await settle(2_999);
    expect(b).toBeNull();
    await settle(1);
    expect(b).toEqual({ decision: { kind: 'local-only', reason: 'timeout' }, cloud: null, notice: null });
    expect(r.ts.calls).toEqual([]);
    expect(r.state().conflict).toBe(false);
    expect(r.sync.status()).toBe('offline');
    expect(r.sync.statusText()).toBe(SYNC_OFFLINE_TEXT);
  });

  it('Given me() answers at 2.9 s and getSave() never, When boot, Then it still resolves at 3 000 ms (one budget, not one per call)', async () => {
    const r = rig({
      state: boundB(save()),
      api: { me: () => new Promise((res) => setTimeout(() => res(ok(200, { ...ACCT_B })), 2_900)), getSave: never },
    });
    let b: { decision: { kind: string; reason?: string } } | null = null;
    void r.sync.boot(save()).then((x) => (b = x as typeof b));
    await settle(2_999);
    expect(b).toBeNull();
    await settle(1);
    expect(b!.decision).toEqual({ kind: 'local-only', reason: 'timeout' });
  });

  it("Given getSave() reports 'timeout' from the api, When boot, Then local-only/timeout", async () => {
    const r = rig({ state: boundB(save()), api: { getSave: () => fail('timeout') } });
    expect((await r.sync.boot(save())).decision).toEqual({ kind: 'local-only', reason: 'timeout' });
  });

  it.each<[string, Partial<FakeApi['reply']>]>([
    ['getSave() is offline', { getSave: () => fail('offline') }],
    ['me() is offline', { me: () => fail('offline') }],
    ['getSave() answers 503', { getSave: () => fail(503) }],
    ['me() answers 500', { me: () => fail(500) }],
  ])("Given %s, When boot, Then local-only/offline, status 'offline', no conflict, nothing written", async (_what, api) => {
    const r = rig({ state: boundB(save({ revision: 7 })), api });
    const b = await r.sync.boot(save({ revision: 9 }));
    expect(b.decision).toEqual({ kind: 'local-only', reason: 'offline' });
    expect(b.cloud).toBeNull();
    expect(r.sync.status()).toBe('offline');
    expect(r.state().conflict).toBe(false);
    expect(r.ts.calls).toEqual([]);
  });
});

describe('SyncClient.boot — not signed in', () => {
  it("Given me() 401 and a guest state, When boot, Then 'guest', status 'off', and onStored never PUTs", async () => {
    const r = rig({ api: { me: () => fail(401), getSave: () => fail(401) } });
    const b = await r.sync.boot(save());
    expect(b.decision).toEqual({ kind: 'guest' });
    expect(r.sync.status()).toBe('off');
    r.sync.onStored(save({ revision: 8 }));
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
  });

  it("Given me() 401 and a state bound to A, When boot, Then 'guest', status 'reauth' with SIGN IN AGAIN TO SYNC, and the save stays bound to A", async () => {
    const r = rig({ state: boundA(save({ revision: 7 })), api: { me: () => fail(401), getSave: () => fail(401) } });
    const b = await r.sync.boot(save({ revision: 9 }));
    expect(b.decision).toEqual({ kind: 'guest' });
    expect(r.sync.status()).toBe('reauth');
    expect(r.sync.statusText()).toBe(SYNC_REAUTH_TEXT);
    expect(r.state()).toEqual(boundA(save({ revision: 7 })));
    r.sync.onStored(save({ revision: 10 }));
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
  });
});

describe('SyncClient.boot — an unreadable cloud save (Review Focus 4)', () => {
  it.each<[string, () => ReturnType<FakeApi['reply']['getSave']>]>([
    ['format 99', () => cloudReply({ ...save({ revision: 9 }), format: 99 })],
    ['an invalid save', () => cloudReply({ format: 1, revision: 9, junk: true })],
    ['a 200 with no body', () => ok(200, null)],
  ])('Given the cloud holds %s, When boot, Then local-only/unreadable: no conflict, nothing written, and NO PUT for the rest of the session', async (_what, getSave) => {
    // Bound to B with local ahead of L: a readable cloud = L would mean push-local.
    const r = rig({ state: boundB(save({ revision: 7 })), api: { getSave } });
    const b = await r.sync.boot(save({ revision: 9 }));
    expect(b.decision).toEqual({ kind: 'local-only', reason: 'unreadable' });
    expect(b.cloud).toBeNull();
    expect(r.state().conflict).toBe(false);
    expect(r.ts.calls).toEqual([]);
    await settle(TEN_MIN);
    r.sync.onStored(save({ revision: 10 }));
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
  });
});

describe('SyncClient.boot — effects of each decision, applied before boot resolves', () => {
  it("Given the cloud is newer on the same game (cloud r9, local = L r7), When boot, Then 'use-cloud': the store holds the cloud save before boot resolves, L = r9, status 'synced', nothing shelved, no PUT", async () => {
    const cloud = save({ revision: 9, tank: 4_000 });
    const r = rig({ state: boundB(save({ revision: 7 })), api: { getSave: () => cloudReply(cloud) } });
    await r.ts.store.save(save({ revision: 7 }));
    const b = await r.sync.boot(save({ revision: 7 }));
    expect(b.decision).toEqual({ kind: 'use-cloud' });
    expect(b.cloud).toEqual(cloud);
    expect(b.notice).toBeNull();
    expect(await r.ts.current()).toEqual(cloud);
    expect(r.state().lastSeenCloud).toEqual({ saveId: GAME_X, revision: 9 });
    expect(r.ts.shelf).toEqual([]);
    expect(r.sync.status()).toBe('synced');
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
  });

  it("Given another device started NEW GAME (cloud Y r3, local X = L r7), When boot, Then 'use-cloud': the local game goes to the shelf FIRST, then the cloud is written, and the next load yields the cloud game", async () => {
    const local = save({ revision: 7 });
    const cloud = save({ saveId: GAME_Y, revision: 3 });
    const r = rig({ state: boundB(local), api: { getSave: () => cloudReply(cloud) } });
    await r.ts.store.save(local);
    r.ts.calls.length = 0;
    const b = await r.sync.boot(local);
    expect(b.decision).toEqual({ kind: 'use-cloud' });
    expect(r.ts.shelf.map((e) => e.raw)).toContainEqual(local);
    const keep = r.ts.calls.indexOf(`keep:${GAME_X}:7`);
    const write = r.ts.calls.indexOf(`save:${GAME_Y}:3`);
    expect(keep).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(keep);
    expect((await loadForBoot(r.ts.store, r.wal)).save).toEqual(cloud);
    expect(r.state().lastSeenCloud).toEqual({ saveId: GAME_Y, revision: 3 });
  });

  it("Given a fresh device (no local save, guest state) and a cloud save, When boot, Then 'use-cloud': the store holds the cloud and the state is bound to me", async () => {
    const cloud = save({ revision: 9 });
    const r = rig({ api: { getSave: () => cloudReply(cloud) } });
    const b = await r.sync.boot(null);
    expect(b.decision).toEqual({ kind: 'use-cloud' });
    expect(await r.ts.current()).toEqual(cloud);
    expect(r.state()).toMatchObject({ accountId: ACCT_B.id, accountName: ACCT_B.name, lastSeenCloud: head(cloud) });
  });

  it("Given a guest save and an empty cloud, When boot, Then 'adopt': the state is bound to me at once, status 'pending', and a PUT with base null follows on a timer", async () => {
    const local = save({ revision: 7 });
    const r = rig({ api: { getSave: noSave } });
    const b = await r.sync.boot(local);
    expect(b.decision).toEqual({ kind: 'adopt' });
    expect(r.state()).toMatchObject({ deviceId: DEVICE_ID, accountId: ACCT_B.id, accountName: ACCT_B.name, lastSeenCloud: null });
    expect(r.api.puts).toEqual([]);
    expect(r.sync.status()).toBe('pending');
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.api.puts).toEqual([{ deviceId: DEVICE_ID, base: null, save: local }]);
    expect(r.state().lastSeenCloud).toEqual({ saveId: GAME_X, revision: 7 });
    expect(r.sync.status()).toBe('synced');
  });

  it("Given local ahead (r9) of the cloud = L (r7), When boot, Then 'push-local': a PUT of the local save with base = L follows on a timer", async () => {
    const local = save({ revision: 9 });
    const r = rig({ state: boundB(save({ revision: 7 })), api: { getSave: () => cloudReply(save({ revision: 7 })) } });
    const b = await r.sync.boot(local);
    expect(b.decision).toEqual({ kind: 'push-local' });
    expect(r.api.puts).toEqual([]);
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.api.puts).toEqual([{ deviceId: DEVICE_ID, base: { saveId: GAME_X, revision: 7 }, save: local }]);
    expect(r.state().lastSeenCloud).toEqual({ saveId: GAME_X, revision: 9 });
  });

  it("Given bound and in sync (local = cloud = L), When boot, Then 'in-sync': L unchanged, status 'synced', nothing written, no PUT", async () => {
    const r = await signedIn();
    expect(r.state()).toEqual(boundB(save({ revision: 7 })));
    expect(r.sync.status()).toBe('synced');
    expect(r.ts.calls).toEqual([]);
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
  });

  it("Given a guest save equal to the cloud (same game, same revision), When boot, Then 'in-sync' and the state is bound to me", async () => {
    const r = rig({ api: { getSave: () => cloudReply(save({ revision: 7 })) } });
    const b = await r.sync.boot(save({ revision: 7 }));
    expect(b.decision).toEqual({ kind: 'in-sync' });
    expect(r.state()).toMatchObject({ accountId: ACCT_B.id, accountName: ACCT_B.name });
  });

  it('Concern (ruling says "L unchanged"): Given a guest save equal to the cloud bound by an in-sync boot, When the game saves r8, Then the PUT carries base = the cloud head r7 — with L left null the server would answer 409 and the next boot would be conflict-same', async () => {
    const r = rig({ api: { getSave: () => cloudReply(save({ revision: 7 })) } });
    await r.sync.boot(save({ revision: 7 }));
    r.sync.onStored(save({ revision: 8 }));
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.api.puts.map((p) => p.base)).toEqual([{ saveId: GAME_X, revision: 7 }]);
  });

  it('Given a save bound to A with unsynced progress and B signed in, When boot, Then refuse-switch: logout() is called, the state is untouched (still A), the notice is the text, status off, nothing written and no PUT', async () => {
    const state = boundA(save({ revision: 7 }));
    const r = rig({ state, api: { getSave: () => cloudReply(save({ saveId: GAME_Y, revision: 2 })) } });
    const b = await r.sync.boot(save({ revision: 9 }));
    const text = 'UNSYNCED PROGRESS FOR Ava — SIGN IN AS Ava ONCE ONLINE TO SYNC';
    expect(b.decision).toEqual({ kind: 'refuse-switch', message: text });
    expect(b.notice).toBe(text);
    expect(r.api.calls.filter((c) => c === 'logout')).toHaveLength(1);
    expect(r.state()).toEqual(state);
    expect(r.sync.status()).toBe('off');
    expect(r.ts.calls).toEqual([]);
    r.sync.onStored(save({ revision: 10 }));
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
  });

  it("Given A's synced save and B signed in with a cloud save, When boot, Then switch-account: A's save goes to the shelf, the next load yields B's game (even at a lower revision), and the state is B's with L = B's cloud", async () => {
    const aLocal = save({ revision: 40 });
    const bCloud = save({ saveId: GAME_Y, revision: 2 });
    const walStorage = new MemoryStorage();
    createWal(walStorage as unknown as Storage).writeSnapshot(aLocal);
    const r = rig({ state: boundA(aLocal), api: { getSave: () => cloudReply(bCloud) }, walStorage });
    await r.ts.store.save(save({ revision: 39 }));
    await r.ts.store.save(aLocal);
    const b = await r.sync.boot(aLocal);
    expect(b.decision).toEqual({ kind: 'switch-account' });
    expect(b.cloud).toEqual(bCloud);
    expect(r.ts.shelf.map((e) => e.raw)).toContainEqual(aLocal);
    expect((await loadForBoot(r.ts.store, r.wal)).save).toEqual(bCloud);
    expect(r.state()).toEqual(
      syncState({ deviceId: DEVICE_ID, accountId: ACCT_B.id, accountName: ACCT_B.name, lastSeenCloud: head(bCloud) }),
    );
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
  });

  it("Given A's synced save (also in the WAL) and B signed in with an EMPTY cloud, When boot, Then switch-account: A's save goes to the shelf and the next load finds no save at all — B starts a new game, A's is never adopted", async () => {
    const aLocal = save({ revision: 7 });
    const walStorage = new MemoryStorage();
    createWal(walStorage as unknown as Storage).writeSnapshot(aLocal);
    const r = rig({ state: boundA(aLocal), api: { getSave: noSave }, walStorage });
    await r.ts.store.save(aLocal);
    const b = await r.sync.boot(aLocal);
    expect(b.decision).toEqual({ kind: 'switch-account' });
    expect(r.ts.shelf.map((e) => e.raw)).toContainEqual(aLocal);
    expect((await loadForBoot(r.ts.store, r.wal)).save).toBeNull();
    expect(r.state()).toEqual(syncState({ deviceId: DEVICE_ID, accountId: ACCT_B.id, accountName: ACCT_B.name, lastSeenCloud: null }));
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
  });

  it.each<[string, string, SyncState, SaveV1, SaveV1]>([
    ['both moved on one game (local r9, cloud r8, L r7)', 'conflict-same', boundB(save({ revision: 7 })), save({ revision: 9 }), save({ revision: 8 })],
    ['a guest save and a cloud with another game', 'conflict-different', syncState(), save(), save({ saveId: GAME_Y, revision: 3 })],
  ])('Given %s, When boot, Then %s: nothing is written, conflict: true is persisted, status conflict with its text, and no PUT', async (_what, kind, state, local, cloud) => {
    const r = rig({ state, api: { getSave: () => cloudReply(cloud) } });
    const b = await r.sync.boot(local);
    expect(b.decision).toEqual({ kind });
    expect(b.cloud).toEqual(cloud);
    expect(r.ts.calls).toEqual([]);
    expect(r.state().conflict).toBe(true);
    expect(r.sync.status()).toBe('conflict');
    expect(r.sync.statusText()).toBe(SYNC_CONFLICT_TEXT);
    r.sync.onStored(save({ revision: 12 }));
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
  });
});

describe('SyncClient — a replaced local save is not undone by the WAL (Task 3 review carry-over)', () => {
  it('Given use-cloud on the same game and a WAL holding the local snapshot and an untagged critical entry of that game above the cloud\'s coverage, When boot, Then the next load yields EXACTLY the cloud save (no old entry re-applied)', async () => {
    const local = save({ revision: 7, emergency: 1 });
    const cloud = save({ revision: 9, emergency: 1, tank: 3_000 });
    const walStorage = new MemoryStorage();
    const w = createWal(walStorage as unknown as Storage);
    w.writeSnapshot(local);
    expect(w.appendCritical(criticalEntry(50, 9), GAME_X)).toBe(true);
    const r = rig({ state: boundB(save({ revision: 7 })), api: { getSave: () => cloudReply(cloud) }, walStorage });
    await r.ts.store.save(local);
    await r.sync.boot(local);
    expect((await loadForBoot(r.ts.store, r.wal)).save).toEqual(cloud);
  });

  it('Given use-cloud of ANOTHER game at a lower revision and a WAL snapshot of the replaced game at r20, When boot, Then the next load yields the cloud game, not the WAL snapshot', async () => {
    const local = save({ revision: 20 });
    const cloud = save({ saveId: GAME_Y, revision: 3 });
    const walStorage = new MemoryStorage();
    createWal(walStorage as unknown as Storage).writeSnapshot(local);
    const r = rig({ state: boundB(local), api: { getSave: () => cloudReply(cloud) }, walStorage });
    await r.ts.store.save(save({ revision: 19 }));
    await r.ts.store.save(local);
    await r.sync.boot(local);
    expect((await loadForBoot(r.ts.store, r.wal)).save).toEqual(cloud);
  });

  it('Given a same-game conflict resolved to r10 and a WAL holding the local r9 snapshot and an untagged critical entry above r10\'s coverage, When resolve succeeds, Then the next load yields EXACTLY the resolved save', async () => {
    const local = save({ revision: 9 });
    const result = save({ revision: 10, tank: 2_000 });
    const walStorage = new MemoryStorage();
    const w = createWal(walStorage as unknown as Storage);
    w.writeSnapshot(local);
    w.appendCritical(criticalEntry(60, 7), GAME_X);
    const r = rig({
      state: boundB(save({ revision: 7 })),
      api: { getSave: () => cloudReply(save({ revision: 8 })), resolve: () => ok(200, { revision: 10, save: result }) },
      walStorage,
    });
    await r.ts.store.save(local);
    await r.sync.boot(local);
    expect(await r.sync.resolve('device')).toEqual({ ok: true, save: result });
    expect((await loadForBoot(r.ts.store, r.wal)).save).toEqual(result);
  });

  it('Given a guest save X r20 (store and WAL) in conflict with cloud game Y r3, When resolve("cloud") returns Y r3, Then the next load yields Y r3 and X is on the shelf', async () => {
    const local = save({ revision: 20 });
    const cloud = save({ saveId: GAME_Y, revision: 3 });
    const walStorage = new MemoryStorage();
    createWal(walStorage as unknown as Storage).writeSnapshot(local);
    const r = rig({
      api: { getSave: () => cloudReply(cloud), resolve: () => ok(200, { revision: 3, save: cloud }) },
      walStorage,
    });
    await r.ts.store.save(save({ revision: 19 }));
    await r.ts.store.save(local);
    await r.sync.boot(local);
    expect(await r.sync.resolve('cloud')).toEqual({ ok: true, save: cloud });
    expect((await loadForBoot(r.ts.store, r.wal)).save).toEqual(cloud);
    expect(r.ts.shelf.map((e) => e.raw)).toContainEqual(local);
  });
});

describe('SyncClient.onStored — never synchronous (R31)', () => {
  it('Given a signed-in client, When onStored(save), Then neither the api nor JSON.stringify runs inside the call — a timer is scheduled; When it fires, Then the PUT is made', async () => {
    const r = await signedIn();
    const stringify = vi.spyOn(JSON, 'stringify');
    const scheduled = r.schedule.mock.calls.length;
    r.sync.onStored(save({ revision: 8 }));
    expect(stringify).not.toHaveBeenCalled();
    expect(r.api.puts).toEqual([]);
    expect(r.schedule.mock.calls.length).toBeGreaterThan(scheduled);
    stringify.mockRestore();
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.api.puts).toHaveLength(1);
  });

  it("Given a signed-in client, When onStored, Then status is 'pending' until the PUT succeeds, then 'synced' and L = the pushed save", async () => {
    const r = await signedIn();
    r.sync.onStored(save({ revision: 8 }));
    expect(r.sync.status()).toBe('pending');
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.sync.status()).toBe('synced');
    expect(r.sync.statusText()).toBeNull();
    expect(r.state().lastSeenCloud).toEqual({ saveId: GAME_X, revision: 8 });
  });

  it('Given L = r7, When r8 then r9 are pushed one after the other, Then their bases are r7 then r8 (base = L)', async () => {
    const r = await signedIn();
    r.sync.onStored(save({ revision: 8 }));
    await settle(PUSH_MIN_INTERVAL_MS);
    r.sync.onStored(save({ revision: 9 }));
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.api.puts.map((p) => [p.base, p.save.revision])).toEqual([
      [{ saveId: GAME_X, revision: 7 }, 8],
      [{ saveId: GAME_X, revision: 8 }, 9],
    ]);
  });

  it('Given three saves stored at once, When the timer fires, Then exactly one PUT — of the latest', async () => {
    const r = await signedIn();
    r.sync.onStored(save({ revision: 8 }));
    r.sync.onStored(save({ revision: 9 }));
    r.sync.onStored(save({ revision: 10 }));
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.api.puts.map((p) => p.save.revision)).toEqual([10]);
  });

  it('Given a PUT that started at t, When another save is stored at t + 1 s, Then the next PUT starts at t + 5 s — not before (≥ PUSH_MIN_INTERVAL_MS between starts)', async () => {
    const r = await signedIn();
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    const t = r.api.putTimes[0]!;
    await settle(t + 1_000 - Date.now());
    r.sync.onStored(save({ revision: 9 }));
    await settle(t + 4_999 - Date.now());
    expect(r.api.puts).toHaveLength(1);
    await settle(1);
    expect(r.api.puts).toHaveLength(2);
    expect(gaps(r.api)).toEqual([5_000]);
  });

  it('Given a PUT in flight, When newer saves are stored, Then no second PUT starts until it settles; then one PUT of the latest, with base = the first PUT\'s result', async () => {
    const first = deferred();
    let n = 0;
    const r = await signedIn({ putSave: (b) => (n++ === 0 ? first.promise : ok(200, { revision: b.save.revision })) });
    r.sync.onStored(save({ revision: 8 }));
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.api.puts).toHaveLength(1);
    r.sync.onStored(save({ revision: 9 }));
    r.sync.onStored(save({ revision: 10 }));
    await settle(60_000);
    expect(r.api.puts).toHaveLength(1);
    expect(r.sync.status()).toBe('pending');
    first.settle(ok(200, { revision: 8 }));
    await settle(100);
    expect(r.api.puts.map((p) => [p.base, p.save.revision])).toEqual([
      [{ saveId: GAME_X, revision: 7 }, 8],
      [{ saveId: GAME_X, revision: 8 }, 10],
    ]);
  });
});

describe('SyncClient.onStored — failures (R31)', () => {
  it('Given a PUT answered 401, Then status reauth with SIGN IN AGAIN TO SYNC, and no more PUTs this session (Review Focus 1)', async () => {
    const r = await signedIn({ putSave: () => fail(401) });
    r.sync.onStored(save({ revision: 8 }));
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.sync.status()).toBe('reauth');
    expect(r.sync.statusText()).toBe(SYNC_REAUTH_TEXT);
    for (let i = 9; i < 14; i++) {
      r.sync.onStored(save({ revision: i }));
      await settle(TEN_MIN);
    }
    expect(r.api.puts).toHaveLength(1);
    expect(r.sync.status()).toBe('reauth');
  });

  it("Given the network is down, Then status offline with OFFLINE — SAVED LOCALLY, and the PUT is retried after 5 s, 15 s, 60 s, then every 300 s", async () => {
    const r = await signedIn({ putSave: () => fail('offline') });
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    expect(r.api.puts).toHaveLength(1);
    expect(r.sync.status()).toBe('offline');
    expect(r.sync.statusText()).toBe(SYNC_OFFLINE_TEXT);
    await settle(5_000 + 15_000 + 60_000 + 300_000 + 300_000 + 1_000 - (Date.now() - r.api.putTimes[0]!));
    expect(gaps(r.api)).toEqual([5_000, 15_000, 60_000, 300_000, 300_000]);
  });

  it('Given an offline failure, When a newer save is stored during the backoff, Then the backoff is not cut short and the retry sends the LATEST save', async () => {
    const r = await signedIn({ putSave: () => fail('offline') });
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    const t = r.api.putTimes[0]!;
    await settle(t + 1_000 - Date.now());
    r.sync.onStored(save({ revision: 9 }));
    await settle(t + 4_999 - Date.now());
    expect(r.api.puts).toHaveLength(1);
    await settle(1);
    expect(r.api.puts.map((p) => p.save.revision)).toEqual([8, 9]);
  });

  it('Given failures then a success, When the next failure comes, Then the backoff starts again at 5 s', async () => {
    const replies = [fail('offline'), fail('offline'), ok(200, { revision: 8 }), fail('offline'), fail('offline')];
    const r = await signedIn({ putSave: () => replies.shift() ?? fail('offline') });
    r.sync.onStored(save({ revision: 8 }));
    await settle(PUSH_MIN_INTERVAL_MS + 5_000 + 15_000);
    expect(r.api.puts).toHaveLength(3);
    expect(r.sync.status()).toBe('synced');
    await settle(10_000);
    r.sync.onStored(save({ revision: 9 }));
    await settle(PUSH_MIN_INTERVAL_MS + 5_000);
    expect(r.api.puts).toHaveLength(5);
    expect(gaps(r.api)[3]).toBe(5_000);
  });

  it.each<[string, () => ReturnType<FakeApi['reply']['putSave']>]>([
    ['a timeout', () => fail('timeout')],
    ['a 503', () => fail(503)],
    ['a 500', () => fail(500)],
  ])('Given %s on PUT, Then status offline and a retry after 5 s', async (_what, putSave) => {
    const r = await signedIn({ putSave });
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    expect(r.sync.status()).toBe('offline');
    await settle(5_000);
    expect(gaps(r.api)).toEqual([5_000]);
  });

  it.each<[string, number | null, number]>([
    ['Retry-After 30 s (longer than the backoff step)', 30, 30_000],
    ['Retry-After 1 s (shorter than the backoff step)', 1, 5_000],
    ['no Retry-After', null, 5_000],
  ])('Given a 429 with %s, Then the retry comes after max(Retry-After, backoff step)', async (_what, retryAfterS, gap) => {
    let n = 0;
    const r = await signedIn({
      putSave: (b) => (n++ === 0 ? fail(429, { retryAfterS, body: { error: 'rate_limited' } }) : ok(200, { revision: b.save.revision })),
    });
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    await settle(r.api.putTimes[0]! + gap - 1 - Date.now());
    expect(r.api.puts).toHaveLength(1);
    await settle(1);
    expect(r.api.puts).toHaveLength(2);
    expect(gaps(r.api)).toEqual([gap]);
  });

  it('Given a PUT answered 409 mid-game, Then conflict: true is persisted, status conflict with its text, no more PUTs — and a reload reconciles to a conflict', async () => {
    const cloud = save({ revision: 9, tank: 1_000 });
    const r = await signedIn({ putSave: () => fail(409, { body: { cloud: { revision: 9, save: cloud } } }) });
    r.sync.onStored(save({ revision: 8 }));
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.state().conflict).toBe(true);
    expect(r.state().lastSeenCloud).toEqual({ saveId: GAME_X, revision: 7 });
    expect(r.sync.status()).toBe('conflict');
    expect(r.sync.statusText()).toBe(SYNC_CONFLICT_TEXT);
    for (let i = 9; i < 13; i++) {
      expect(() => r.sync.onStored(save({ revision: i }))).not.toThrow();
      await settle(TEN_MIN);
    }
    expect(r.api.puts).toHaveLength(1);
    const reload = reconcile({ local: save({ revision: 12 }), cloud, state: r.state(), me: { ...ACCT_B } });
    expect(reload.kind).toBe('conflict-same');
  });

  it.each([400, 413])('Given a PUT answered %i (not retryable), Then pushing stops for the session, status off, and console.error is called once', async (status) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await signedIn({ putSave: () => fail(status, { body: { error: 'invalid-save' } }) });
    r.sync.onStored(save({ revision: 8 }));
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.sync.status()).toBe('off');
    for (let i = 9; i < 13; i++) {
      r.sync.onStored(save({ revision: i }));
      await settle(TEN_MIN);
    }
    expect(r.api.puts).toHaveLength(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('Given local-only/offline at boot with a GUEST state, When onStored, Then no PUT (nothing is bound to an account)', async () => {
    const r = rig({ api: { me: () => fail('offline'), getSave: () => fail('offline') } });
    await r.sync.boot(save());
    r.sync.onStored(save({ revision: 8 }));
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
  });
});

describe('SyncClient — storage that throws (private mode, R32)', () => {
  it('Given a sync storage that throws on every call, When a guest save is adopted and the game saves again, Then nothing crashes and L lives in memory: the second PUT has base = the first result', async () => {
    const r = rig({ state: null, storage: new ThrowingStorage(), api: { getSave: noSave } });
    const b = await r.sync.boot(save({ revision: 7 }));
    expect(b.decision).toEqual({ kind: 'adopt' });
    await settle(PUSH_MIN_INTERVAL_MS);
    r.sync.onStored(save({ revision: 8 }));
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.api.puts.map((p) => [p.deviceId, p.base])).toEqual([
      [DEVICE_ID, null],
      [DEVICE_ID, { saveId: GAME_X, revision: 7 }],
    ]);
    expect(r.sync.status()).toBe('synced');
  });
});

describe('SyncClient.resolve', () => {
  /** Bound to B, L r7, local r9, cloud r8: conflict-same. */
  async function inConflict(resolve: FakeApi['reply']['resolve'], local = save({ revision: 9 })): Promise<Rig> {
    const r = rig({ state: boundB(save({ revision: 7 })), api: { getSave: () => cloudReply(save({ revision: 8 })), resolve } });
    await r.ts.store.save(local);
    r.ts.calls.length = 0;
    expect((await r.sync.boot(local)).decision.kind).toBe('conflict-same');
    return r;
  }

  it('Given a conflict, When resolve("device"), Then POST {deviceId, keep, device: local, base: L, cloud: the head seen at boot}; on 200 the result is stored, the old local shelved, L = result, conflict cleared, status synced', async () => {
    const local = save({ revision: 9 });
    const result = save({ revision: 10, tank: 5_000 });
    const r = await inConflict(() => ok(200, { revision: 10, save: result }), local);
    const out = await r.sync.resolve('device');
    expect(r.api.resolves).toEqual([
      { deviceId: DEVICE_ID, keep: 'device', device: local, base: { saveId: GAME_X, revision: 7 }, cloud: { saveId: GAME_X, revision: 8 } },
    ]);
    expect(out).toEqual({ ok: true, save: result });
    expect(await r.ts.current()).toEqual(result);
    expect(r.ts.shelf.map((e) => e.raw)).toContainEqual(local);
    expect(r.state()).toMatchObject({ lastSeenCloud: { saveId: GAME_X, revision: 10 }, conflict: false });
    expect(r.sync.status()).toBe('synced');
  });

  it('Given a guest save in conflict with another cloud game, When resolve("device") returns the local save unchanged, Then it is NOT shelved (identical), it is current, and the state is bound to me', async () => {
    const local = save({ revision: 7 });
    const r = rig({
      api: { getSave: () => cloudReply(save({ saveId: GAME_Y, revision: 3 })), resolve: () => ok(200, { revision: 7, save: local }) },
    });
    await r.ts.store.save(local);
    expect((await r.sync.boot(local)).decision.kind).toBe('conflict-different');
    expect(await r.sync.resolve('device')).toEqual({ ok: true, save: local });
    expect(r.ts.shelf).toEqual([]);
    expect(await r.ts.current()).toEqual(local);
    expect(r.state()).toMatchObject({ accountId: ACCT_B.id, accountName: ACCT_B.name, lastSeenCloud: head(local), conflict: false });
  });

  it('Given the cloud moved again (409), When resolve, Then {ok: false, reason: "moved", cloud: the new head}, still in conflict; When resolved again, Then the new head is sent as cloud', async () => {
    const moved = save({ revision: 11 });
    let n = 0;
    const r = await inConflict((b) =>
      n++ === 0 ? fail(409, { body: { cloud: { revision: 11, save: moved } } }) : ok(200, { revision: 12, save: { ...b.device, revision: 12 } }),
    );
    expect(await r.sync.resolve('device')).toEqual({ ok: false, reason: 'moved', cloud: moved });
    expect(r.sync.status()).toBe('conflict');
    expect(r.state().conflict).toBe(true);
    await r.sync.resolve('device');
    expect(r.api.resolves[1]!.cloud).toEqual({ saveId: GAME_X, revision: 11 });
  });

  it.each<[string, ReturnType<FakeApi['reply']['resolve']>, string]>([
    ['401', fail(401), 'reauth'],
    ['offline', fail('offline'), 'offline'],
    ['a timeout', fail('timeout'), 'offline'],
  ])('Given resolve gets %s, Then {ok: false, reason: %s}, nothing written, and the conflict flag stays', async (_what, reply, reason) => {
    const r = await inConflict(() => reply);
    expect(await r.sync.resolve('cloud')).toEqual({ ok: false, reason });
    expect(r.ts.calls).toEqual([]);
    expect(r.state().conflict).toBe(true);
  });

  it('Choice: Given a conflict boot and the game saved r10 afterwards (no PUT in conflict), When resolve, Then device = the latest stored save, not the boot one', async () => {
    const r = await inConflict((b) => ok(200, { revision: 11, save: { ...b.device, revision: 11 } }));
    r.sync.onStored(save({ revision: 10, tank: 6_000 }));
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
    await r.sync.resolve('device');
    expect(r.api.resolves[0]!.device).toEqual(save({ revision: 10, tank: 6_000 }));
  });
});
