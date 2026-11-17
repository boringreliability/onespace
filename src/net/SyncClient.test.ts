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
 *     store: SaveStore,                      // boot/resolve replace the local save here (R34 replaceAll)
 *     wal: Wal,                              // reset when the local save is replaced (R35)
 *     uuid: () => string,                    // deviceId, generated once
 *   })
 *   .boot(local: SaveV1 | null, opts?: { localDirty?: boolean }): Promise<BootSync>
 *      // localDirty (R36) = the boot load applied WAL critical entries (BootLoad.walApplied)
 *   .onStored(save: SaveV1): void           // never works synchronously
 *   .status(): SyncStatus                   // 'pending' while a save is queued or in flight
 *   .statusText(): string | null            // offline/reauth/conflict → the texts; else null
 *   .resolve(keep: 'device' | 'cloud'):
 *      Promise<{ ok: true; save: SaveV1 } | { ok: false; reason: 'offline' | 'reauth' | 'moved'; cloud?: SaveV1 }>
 *
 * Replacing the local save (use-cloud, switch-account, a resolved conflict) —
 * Ruling R35, in this order: (1) shelve the old (WAL-merged) local with
 * store.keepCorrupt when the rule shelves it, (2) wal.reset(), (3)
 * store.replaceAll(new | null). A crash after (2) leaves the old stored
 * snapshot and the next boot reconciles again; the opposite order could apply
 * old WAL entries on top of the new save.
 *
 * Ruling R38: pushes need a `me` confirmed in THIS session with
 * id === state.accountId; after an offline/timeout boot, onStored checks me()
 * before any PUT.
 *
 * Fix round 1 (R40, R43–R47): the newest save is sent once identity is
 * confirmed; same content is in sync; a confirmed other account is 'off';
 * resolve needs a confirmed identity; a persisted conflict holds while the
 * cloud is unreachable; an unreadable cloud says so
 * (`CLOUD SAVE UNREADABLE — SYNC OFF`).
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
  recordingWal,
  save,
  syncState,
  testStore,
  timerSchedule,
  type FakeApi,
  type TestStore,
} from './__fixtures__/sync';
import type { ApiResult, PutBody, ResolveBody } from './api';
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
  const wal = recordingWal(walStorage, ts.calls);
  const schedule = vi.fn(timerSchedule);
  const sync = new SyncClient({
    api,
    storage: o.storage ?? storage,
    isWriter: () => o.writer ?? true,
    schedule,
    store: ts.store,
    wal,
    uuid: () => DEVICE_ID,
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
  it('Ruling R66: Given me() is still pending, Then getSave() has NOT been called yet (it waits for a signed-in me)', async () => {
    const r = rig({ state: boundB(save()), api: { me: never, getSave: never } });
    void r.sync.boot(save());
    await settle(0);
    expect(r.api.calls).toContain('me');
    expect(r.api.calls).not.toContain('getSave');
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
    r.ts.calls.length = 0;
    const b = await r.sync.boot(save({ revision: 7 }));
    expect(b.decision).toEqual({ kind: 'use-cloud' });
    expect(r.ts.calls).toEqual(['wal:reset', `replace:${GAME_X}:9`]);
    expect(b.cloud).toEqual(cloud);
    expect(b.notice).toBeNull();
    expect(await r.ts.current()).toEqual(cloud);
    expect(r.state().lastSeenCloud).toEqual({ saveId: GAME_X, revision: 9 });
    expect(r.ts.shelf).toEqual([]);
    expect(r.sync.status()).toBe('synced');
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
  });

  it("Given another device started NEW GAME (cloud Y r3, local X = L r7), When boot, Then 'use-cloud' — Ruling R35 order: keepCorrupt(local), wal.reset(), store.replaceAll(cloud) — and the next load yields the cloud game", async () => {
    const local = save({ revision: 7 });
    const cloud = save({ saveId: GAME_Y, revision: 3 });
    const r = rig({ state: boundB(local), api: { getSave: () => cloudReply(cloud) } });
    await r.ts.store.save(local);
    r.ts.calls.length = 0;
    const b = await r.sync.boot(local);
    expect(b.decision).toEqual({ kind: 'use-cloud' });
    expect(r.ts.shelf.map((e) => e.raw)).toContainEqual(local);
    expect(r.ts.calls).toEqual([`keep:${GAME_X}:7`, 'wal:reset', `replace:${GAME_Y}:3`]);
    expect((await loadForBoot(r.ts.store, r.wal)).save).toEqual(cloud);
    expect(r.state().lastSeenCloud).toEqual({ saveId: GAME_Y, revision: 3 });
  });

  it("Given a fresh device (no local save, guest state) and a cloud save, When boot, Then 'use-cloud': the store holds the cloud and the state is bound to me", async () => {
    const cloud = save({ revision: 9 });
    const r = rig({ api: { getSave: () => cloudReply(cloud) } });
    const b = await r.sync.boot(null);
    expect(b.decision).toEqual({ kind: 'use-cloud' });
    expect(r.ts.calls).toEqual(['wal:reset', `replace:${GAME_X}:9`]);
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

  it('Choice (accepted, replaces "L unchanged"): Given a guest save equal to the cloud bound by an in-sync boot, When the game saves r8, Then the PUT carries base = the cloud head r7 — with L left null the server would answer 409 and the next boot would be conflict-same', async () => {
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
    r.ts.calls.length = 0;
    const b = await r.sync.boot(aLocal);
    expect(b.decision).toEqual({ kind: 'switch-account' });
    expect(r.ts.calls).toEqual([`keep:${GAME_X}:40`, 'wal:reset', `replace:${GAME_Y}:2`]);
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
    r.ts.calls.length = 0;
    const b = await r.sync.boot(aLocal);
    expect(b.decision).toEqual({ kind: 'switch-account' });
    expect(r.ts.calls).toEqual([`keep:${GAME_X}:7`, 'wal:reset', 'replace:null']);
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

  // CHANGED by Ruling R68(a) (final fix round): was "…the retry sends the LATEST save" / toEqual([8, 9]).
  it('Ruling R68: Given an offline failure, When a newer save is stored during the backoff, Then the backoff is not cut short and the retry resends the SAME save (r8), not the newer one', async () => {
    const r = await signedIn({ putSave: () => fail('offline') });
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    const t = r.api.putTimes[0]!;
    await settle(t + 1_000 - Date.now());
    r.sync.onStored(save({ revision: 9 }));
    await settle(t + 4_999 - Date.now());
    expect(r.api.puts).toHaveLength(1);
    await settle(1);
    expect(r.api.puts.map((p) => p.save.revision)).toEqual([8, 8]);
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

  it("Ruling R39: Given a 429 (Retry-After 1 s) and then the network down, Then the status is 'pending' after the 429, and the 429 did NOT advance the backoff: the retry after the following failure still waits 5 s, not 15 s", async () => {
    const replies = [fail(429, { retryAfterS: 1, body: { error: 'rate_limited' } }), fail('offline'), ok(200, { revision: 8 })];
    const r = await signedIn({ putSave: () => replies.shift() ?? fail('offline') });
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    expect(r.sync.status()).toBe('pending');
    await settle(r.api.putTimes[0]! + 5_000 + 5_000 + 100 - Date.now());
    expect(gaps(r.api)).toEqual([5_000, 5_000]);
    expect(r.sync.status()).toBe('synced');
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
    const reload = reconcile({ local: save({ revision: 12 }), cloud, state: r.state(), me: { ...ACCT_B }, localDirty: false, sameContent: false });
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

describe('Ruling R36 — a WAL-merged (dirty) local save at boot', () => {
  it('Ruling R36: Given bound, a dirty local at L (r7) and the cloud newer (r9), When boot, Then conflict-same — nothing written, the paid entries are not dropped by use-cloud', async () => {
    const r = rig({ state: boundB(save({ revision: 7 })), api: { getSave: () => cloudReply(save({ revision: 9 })) } });
    await r.ts.store.save(save({ revision: 7 }));
    r.ts.calls.length = 0;
    const b = await r.sync.boot(save({ revision: 7, emergency: 9 }), { localDirty: true });
    expect(b.decision).toEqual({ kind: 'conflict-same' });
    expect(r.ts.calls).toEqual([]);
    expect(r.state().conflict).toBe(true);
  });

  it('Ruling R36: Given bound, a dirty local at the SAME revision as L and cloud = L, When boot, Then push-local but no PUT of that revision (the server would 409 it): status pending; When r8 is stored, Then r8 is PUT with base r7', async () => {
    const r = rig({ state: boundB(save({ revision: 7 })), api: { getSave: () => cloudReply(save({ revision: 7 })) } });
    const b = await r.sync.boot(save({ revision: 7, emergency: 9 }), { localDirty: true });
    expect(b.decision).toEqual({ kind: 'push-local' });
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
    expect(r.sync.status()).toBe('pending');
    r.sync.onStored(save({ revision: 8, emergency: 9 }));
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.api.puts.map((p) => [p.base, p.save.revision])).toEqual([[{ saveId: GAME_X, revision: 7 }, 8]]);
  });

  it('Ruling R36: Given bound, a dirty local ABOVE L (r9 > r7) and cloud = L, When boot, Then push-local and r9 is PUT as usual', async () => {
    const r = rig({ state: boundB(save({ revision: 7 })), api: { getSave: () => cloudReply(save({ revision: 7 })) } });
    const local = save({ revision: 9, emergency: 9 });
    expect((await r.sync.boot(local, { localDirty: true })).decision).toEqual({ kind: 'push-local' });
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.api.puts).toEqual([{ deviceId: DEVICE_ID, base: { saveId: GAME_X, revision: 7 }, save: local }]);
  });

  it('Ruling R36: Given no opts, When boot, Then localDirty counts as false (a clean local = L with a newer cloud is use-cloud)', async () => {
    const r = rig({ state: boundB(save({ revision: 7 })), api: { getSave: () => cloudReply(save({ revision: 9 })) } });
    expect((await r.sync.boot(save({ revision: 7 }))).decision).toEqual({ kind: 'use-cloud' });
  });
});

describe('Ruling R38 — pushing needs an identity confirmed this session', () => {
  /** Bound to B at L r7; the boot could not reach the server (offline or timeout). */
  async function offlineBoot(how: 'offline' | 'timeout'): Promise<Rig> {
    const r = rig({
      state: boundB(save({ revision: 7 })),
      api: how === 'offline' ? { me: () => fail('offline'), getSave: () => fail('offline') } : { me: never, getSave: never },
    });
    const done = r.sync.boot(save({ revision: 7 }));
    if (how === 'timeout') await settle(3_000);
    expect((await done).decision).toEqual({ kind: 'local-only', reason: how });
    return r;
  }

  it.each(['offline', 'timeout'] as const)(
    'Ruling R38: Given a %s boot with a state bound to B, When the game saves and me() now says B, Then me() is asked BEFORE the PUT, and the PUT carries base = L',
    async (how) => {
      const r = await offlineBoot(how);
      r.api.reply.me = () => ok(200, { ...ACCT_B });
      r.api.reply.getSave = () => cloudReply(save({ revision: 7 }));
      const before = r.api.calls.length;
      r.sync.onStored(save({ revision: 8 }));
      await untilPut(r.api);
      const after = r.api.calls.slice(before);
      expect(after.indexOf('me')).toBeGreaterThanOrEqual(0);
      expect(after.indexOf('me')).toBeLessThan(after.indexOf('putSave'));
      expect(r.api.puts.map((p) => [p.base, p.save.revision])).toEqual([[{ saveId: GAME_X, revision: 7 }, 8]]);
    },
  );

  it('Ruling R38: Given an offline boot bound to B, When the game saves and me() answers 401, Then status reauth and no PUT', async () => {
    const r = await offlineBoot('offline');
    r.api.reply.me = () => fail(401);
    r.sync.onStored(save({ revision: 8 }));
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
    expect(r.sync.status()).toBe('reauth');
    expect(r.sync.statusText()).toBe(SYNC_REAUTH_TEXT);
  });

  it("Ruling R38: Given an offline boot bound to B, When me() now says A (another account's cookie), Then no PUT for the rest of the session and status off — B's save is never pushed into A's cloud", async () => {
    const r = await offlineBoot('offline');
    r.api.reply.me = () => ok(200, { ...ACCT_A });
    r.sync.onStored(save({ revision: 8 }));
    await settle(TEN_MIN);
    r.sync.onStored(save({ revision: 9 }));
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
    expect(r.sync.status()).toBe('off');
  });

  it('Ruling R38: Given an offline boot bound to B, When me() is still offline, Then status offline and the identity check is retried on the backoff (5 s) before any PUT; once me() says B, Then the PUT follows', async () => {
    const r = await offlineBoot('offline');
    const meTimes: number[] = [];
    let n = 0;
    r.api.reply.me = () => {
      meTimes.push(Date.now());
      return n++ === 0 ? fail('offline') : ok(200, { ...ACCT_B });
    };
    const before = r.api.calls.length;
    r.sync.onStored(save({ revision: 8 }));
    for (let t = 0; t <= 5_100 && meTimes.length < 1; t += 100) await settle(100);
    expect(meTimes).toHaveLength(1);
    expect(r.api.puts).toEqual([]);
    expect(r.sync.status()).toBe('offline');
    await settle(meTimes[0]! + 4_999 - Date.now());
    expect(meTimes).toHaveLength(1);
    expect(r.api.puts).toEqual([]);
    await settle(1);
    expect(meTimes).toHaveLength(2);
    expect(meTimes[1]! - meTimes[0]!).toBe(5_000);
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.api.calls.slice(before).filter((c) => c === 'me' || c === 'putSave')).toEqual(['me', 'me', 'putSave']);
    expect(r.api.puts).toHaveLength(1);
  });

  it('Ruling R38: Given a normal boot where me() confirmed B (bound to B), When the game saves, Then the PUT needs no extra me() call', async () => {
    const r = await signedIn();
    const before = r.api.calls.length;
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    expect(r.api.calls.slice(before)).toEqual(['putSave']);
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
    // CHANGED by Ruling R71 (final fix round): the unchosen cloud r8 is shelved first; was [`keep:${GAME_X}:9`, 'wal:reset', …].
    expect(r.ts.calls).toEqual([`keep:${GAME_X}:8`, `keep:${GAME_X}:9`, 'wal:reset', `replace:${GAME_X}:10`]); // Ruling R35 order
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

// =============================================================================
//  Fix round 1 — what the Task 5 review found (R40, R43–R47)
// =============================================================================

const UNREADABLE_TEXT = 'CLOUD SAVE UNREADABLE — SYNC OFF';

describe('Ruling R40 — the newest save is the one sent', () => {
  it('Ruling R40: Given an offline boot bound to B, When r8 is stored, me() is still answering, r9 is stored, and me() then says B, Then exactly one PUT — of r9 — and status synced once r9 is acknowledged', async () => {
    const r = rig({ state: boundB(save({ revision: 7 })), api: { me: () => fail('offline'), getSave: () => fail('offline') } });
    expect((await r.sync.boot(save({ revision: 7 }))).decision).toEqual({ kind: 'local-only', reason: 'offline' });
    const me = deferred();
    r.api.reply.me = () => me.promise;
    r.sync.onStored(save({ revision: 8 }));
    for (let t = 0; t <= 5_100 && !r.api.calls.slice(1).includes('me'); t += 100) await settle(100);
    expect(r.api.calls.slice(1)).toContain('me');
    r.sync.onStored(save({ revision: 9 }));
    me.settle(ok(200, { ...ACCT_B }));
    await settle(TEN_MIN);
    expect(r.api.puts.map((p) => p.save.revision)).toEqual([9]);
    expect(r.sync.status()).toBe('synced');
    expect(r.state().lastSeenCloud).toEqual({ saveId: GAME_X, revision: 9 });
  });

  it("Ruling R40: Given a PUT of r8 in flight and r9 stored meanwhile, When r8 is acknowledged, Then the status is 'pending' (not synced) until r9 is acknowledged too", async () => {
    const first = deferred();
    const second = deferred();
    const replies = [first.promise, second.promise];
    const r = await signedIn({ putSave: () => replies.shift()! });
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    r.sync.onStored(save({ revision: 9 }));
    first.settle(ok(200, { revision: 8 }));
    await settle(0);
    expect(r.sync.status()).toBe('pending');
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.api.puts.map((p) => p.save.revision)).toEqual([8, 9]);
    expect(r.sync.status()).toBe('pending');
    second.settle(ok(200, { revision: 9 }));
    await settle(0);
    expect(r.sync.status()).toBe('synced');
  });
});

describe('Ruling R43 — the same content is in sync (boot)', () => {
  it("Ruling R43: Given the store holds B's save identical to B's cloud while the state is still bound to A, When B signs in, Then in-sync: re-bound to B with L = the cloud head, store and WAL untouched, no logout, no refuse-switch", async () => {
    const local = save({ revision: 9 });
    const cloud = save({ revision: 9 });
    const r = rig({ state: boundA(save({ saveId: GAME_Y, revision: 3 })), api: { getSave: () => cloudReply(cloud) } });
    await r.ts.store.save(local);
    r.ts.calls.length = 0;
    const b = await r.sync.boot(local);
    expect(b.decision).toEqual({ kind: 'in-sync' });
    expect(b.notice).toBeNull();
    expect(r.api.calls).not.toContain('logout');
    expect(r.ts.calls).toEqual([]);
    expect(r.state()).toEqual(
      syncState({ deviceId: DEVICE_ID, accountId: ACCT_B.id, accountName: ACCT_B.name, lastSeenCloud: head(cloud) }),
    );
    expect(r.sync.status()).toBe('synced');
  });

  it('Ruling R43: Given bound to B with L behind (r7) and local identical to the cloud at r9 (a lost PUT acknowledgement), When boot, Then in-sync with L = r9, nothing replaced, no PUT', async () => {
    const r = rig({ state: boundB(save({ revision: 7 })), api: { getSave: () => cloudReply(save({ revision: 9 })) } });
    const b = await r.sync.boot(save({ revision: 9 }));
    expect(b.decision).toEqual({ kind: 'in-sync' });
    expect(r.ts.calls).toEqual([]);
    expect(r.state().lastSeenCloud).toEqual({ saveId: GAME_X, revision: 9 });
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
  });

  it("Ruling R43: Given a guest save of the cloud's game at the same revision but different content, When boot, Then conflict-same — nothing written", async () => {
    const r = rig({ api: { getSave: () => cloudReply(save({ revision: 7, tank: 9_000 })) } });
    const b = await r.sync.boot(save({ revision: 7, tank: 100 }));
    expect(b.decision).toEqual({ kind: 'conflict-same' });
    expect(r.ts.calls).toEqual([]);
  });
});

describe('Ruling R44 — a confirmed other account is off, not offline', () => {
  it.each(['offline', 'timeout'] as const)(
    "Ruling R44: Given a state bound to A, me() answering B in time and getSave() %s, When boot, Then status 'off' (not offline) and no PUT",
    async (how) => {
      const r = rig({
        state: boundA(save({ revision: 7 })),
        api: { me: () => ok(200, { ...ACCT_B }), getSave: how === 'offline' ? () => fail('offline') : never },
      });
      const done = r.sync.boot(save({ revision: 9 }));
      if (how === 'timeout') await settle(3_000);
      expect((await done).decision).toEqual({ kind: 'local-only', reason: how });
      expect(r.sync.status()).toBe('off');
      r.sync.onStored(save({ revision: 10 }));
      await settle(TEN_MIN);
      expect(r.api.puts).toEqual([]);
    },
  );
});

describe('Ruling R45 — resolve needs a confirmed identity', () => {
  it("Ruling R45: Given an offline boot bound to B (no identity confirmed) with a persisted conflict, When resolve, Then {ok: false, reason: 'reauth'} and nothing is sent", async () => {
    const r = rig({
      state: boundB(save({ revision: 7 }), { conflict: true }),
      api: { me: () => fail('offline'), getSave: () => fail('offline'), resolve: () => ok(200, { revision: 10, save: save({ revision: 10 }) }) },
    });
    await r.sync.boot(save({ revision: 9 }));
    expect(await r.sync.resolve('device')).toEqual({ ok: false, reason: 'reauth' });
    expect(r.api.resolves).toEqual([]);
    expect(r.ts.calls).toEqual([]);
  });

  it("Ruling R45: Given a refused switch (state bound to A, me() = B), When resolve, Then {ok: false, reason: 'reauth'} and nothing is sent", async () => {
    const r = rig({
      state: boundA(save({ revision: 7 })),
      api: { getSave: () => cloudReply(save({ saveId: GAME_Y, revision: 2 })), resolve: () => ok(200, { revision: 10, save: save({ revision: 10 }) }) },
    });
    expect((await r.sync.boot(save({ revision: 9 }))).decision.kind).toBe('refuse-switch');
    expect(await r.sync.resolve('device')).toEqual({ ok: false, reason: 'reauth' });
    expect(r.api.resolves).toEqual([]);
  });

  // R48 replaces R45's unbound exception: resolve ALWAYS needs a me confirmed this session.
  it("Ruling R48: Given an UNBOUND state and no identity confirmed (offline boot), When resolve, Then {ok: false, reason: 'reauth'} and nothing is sent", async () => {
    const result = save({ revision: 8 });
    const r = rig({ api: { me: () => fail('offline'), getSave: () => fail('offline'), resolve: () => ok(200, { revision: 8, save: result }) } });
    await r.sync.boot(save({ revision: 7 }));
    expect(await r.sync.resolve('device')).toEqual({ ok: false, reason: 'reauth' });
    expect(r.api.resolves).toEqual([]);
    expect(r.ts.calls).toEqual([]);
  });

  it('Ruling R48: Given an UNBOUND state and me() confirmed as B this session (a guest save in conflict with B\'s cloud), When resolve succeeds, Then the request was sent and the state is bound to B', async () => {
    const local = save({ revision: 7 });
    const result = save({ saveId: GAME_Y, revision: 3 });
    const r = rig({ api: { getSave: () => cloudReply(result), resolve: () => ok(200, { revision: 3, save: result }) } });
    expect((await r.sync.boot(local)).decision.kind).toBe('conflict-different');
    expect(await r.sync.resolve('cloud')).toEqual({ ok: true, save: result });
    expect(r.api.resolves).toHaveLength(1);
    expect(r.state()).toMatchObject({ accountId: ACCT_B.id, accountName: ACCT_B.name, lastSeenCloud: head(result), conflict: false });
  });
});

describe('Ruling R46 — a persisted conflict holds until a boot reaches the cloud', () => {
  it.each(['offline', 'timeout'] as const)(
    "Ruling R46: Given a persisted conflict and the cloud %s at boot, Then status conflict, and no PUT for the session even after saves",
    async (how) => {
      const r = rig({
        state: boundB(save({ revision: 7 }), { conflict: true }),
        api: how === 'offline' ? { me: () => fail('offline'), getSave: () => fail('offline') } : { me: never, getSave: never },
      });
      const done = r.sync.boot(save({ revision: 9 }));
      if (how === 'timeout') await settle(3_000);
      await done;
      expect(r.sync.status()).toBe('conflict');
      expect(r.sync.statusText()).toBe(SYNC_CONFLICT_TEXT);
      r.api.reply.me = () => ok(200, { ...ACCT_B });
      for (let i = 10; i < 13; i++) {
        r.sync.onStored(save({ revision: i }));
        await settle(TEN_MIN);
      }
      expect(r.api.puts).toEqual([]);
      expect(r.state().conflict).toBe(true);
    },
  );

  it.each<[string, SaveV1, SaveV1, string]>([
    ['in-sync (local = cloud = L)', save({ revision: 7 }), save({ revision: 7 }), 'in-sync'],
    ['push-local (local ahead, cloud = L)', save({ revision: 9 }), save({ revision: 7 }), 'push-local'],
    ['use-cloud (cloud ahead, local = L)', save({ revision: 7 }), save({ revision: 9 }), 'use-cloud'],
  ])('Ruling R46: Given a stale persisted conflict flag and a boot that reaches the cloud with %s, Then the persisted flag is cleared', async (_what, local, cloud, kind) => {
    const r = rig({ state: boundB(save({ revision: 7 }), { conflict: true }), api: { getSave: () => cloudReply(cloud) } });
    expect((await r.sync.boot(local)).decision).toEqual({ kind });
    expect(r.state().conflict).toBe(false);
    expect(r.sync.status()).not.toBe('conflict');
  });
});

describe('Ruling R47 — an unreadable cloud says so', () => {
  it.each<[string, () => ReturnType<FakeApi['reply']['getSave']>]>([
    ['format 99', () => cloudReply({ ...save({ revision: 9 }), format: 99 })],
    ['an invalid save', () => cloudReply({ format: 1, revision: 9, junk: true })],
  ])("Ruling R47: Given the cloud holds %s, When boot, Then the notice is exactly 'CLOUD SAVE UNREADABLE — SYNC OFF' and status stays off", async (_what, getSave) => {
    const r = rig({ state: boundB(save({ revision: 7 })), api: { getSave } });
    const b = await r.sync.boot(save({ revision: 9 }));
    expect(b.decision).toEqual({ kind: 'local-only', reason: 'unreadable' });
    expect(b.notice).toBe(UNREADABLE_TEXT);
    expect(r.sync.status()).toBe('off');
  });
});

// =============================================================================
//  v4 sub-plan 4, Task 6 (phase A) — what the UI needs from SyncClient
//  (rulings R51, R53, R54). Assumed surface:
//
//   .identity(): { id: string; name: string } | null
//      // the identity confirmed THIS session (the boot's me); null when not
//      // confirmed (401, offline, reader, before boot) or after sign-out /
//      // a refused switch (which logs out) / a deleted account.
//   .signOut(): Promise<boolean>
//      // POST logout (api.logout). true → identity null, no more PUTs, the
//      // persisted sync state (the binding) and the store untouched; R56:
//      // status 'off' (a voluntary sign-out is not a reauth).
//      // false (the request failed) → nothing changes.
//   .deleteAccount(): Promise<boolean>
//      // DELETE /api/account (api.deleteAccount). true → the sync state is
//      // reset to a fresh one with the SAME deviceId (persisted), identity
//      // null, no more PUTs, status 'off', the store untouched. false →
//      // nothing changes. Without a confirmed identity: false, no request.
// =============================================================================

// =============================================================================
//  Task 6 fix round 2 — Ruling R66: a guest never asks for a save. boot()
//  calls getSave() only after me() answered with a signed-in user; both
//  share the ONE 3 s budget (R30): getSave gets only what me() left.
// =============================================================================

describe('Ruling R66 — getSave() only after a signed-in me()', () => {
  it.each<[string, SyncState | null]>([
    ['a guest state', null],
    ['a state bound to A', boundA(save({ revision: 7 }))],
  ])('Ruling R66: Given me() answers 401 and %s, When boot, Then guest and NO request for the save', async (_what, state) => {
    const r = rig({ ...(state ? { state } : {}), api: { me: () => fail(401) } });
    const b = await r.sync.boot(save());
    expect(b.decision).toEqual({ kind: 'guest' });
    expect(r.api.calls).toEqual(['me']);
  });

  it.each<[string, Partial<FakeApi['reply']>, string]>([
    ['me() is offline', { me: () => fail('offline') }, 'offline'],
    ['me() answers 500', { me: () => fail(500) }, 'offline'],
    ["me() reports 'timeout'", { me: () => fail('timeout') }, 'timeout'],
    ['me() answers 200 without a user', { me: () => ok(200, { nope: true }) }, 'offline'],
  ])('Ruling R66: Given %s, When boot, Then local-only as before and no request for the save', async (_what, api, reason) => {
    const r = rig({ state: boundB(save({ revision: 7 })), api });
    const b = await r.sync.boot(save({ revision: 9 }));
    expect(b.decision).toEqual({ kind: 'local-only', reason });
    expect(r.api.calls).not.toContain('getSave');
  });

  it('Ruling R66: Given a signed-in boot, Then getSave() is called only once me() has answered — me first, then getSave', async () => {
    const me = deferred();
    const r = rig({ state: boundB(save({ revision: 7 })), api: { me: () => me.promise, getSave: () => cloudReply(save({ revision: 7 })) } });
    const p = r.sync.boot(save({ revision: 7 }));
    await settle(500);
    expect(r.api.calls).toEqual(['me']);
    me.settle(ok(200, { ...ACCT_B }));
    const b = await p;
    expect(r.api.calls).toEqual(['me', 'getSave']);
    expect(b.decision).toEqual({ kind: 'in-sync' });
  });

  it('Ruling R66 (R30): Given me() answers at 1 s and getSave() 1.5 s after it is asked, When boot, Then it completes at 2.5 s inside the one budget', async () => {
    const r = rig({
      state: boundB(save({ revision: 7 })),
      api: {
        me: () => new Promise((res) => setTimeout(() => res(ok(200, { ...ACCT_B })), 1_000)),
        getSave: () => new Promise((res) => setTimeout(() => res(cloudReply(save({ revision: 7 }))), 1_500)),
      },
    });
    let b: { decision: unknown } | null = null;
    void r.sync.boot(save({ revision: 7 })).then((x) => (b = x));
    await settle(2_499);
    expect(b).toBeNull();
    await settle(1);
    expect(b!.decision).toEqual({ kind: 'in-sync' });
  });

  it('Ruling R66 (R30): Given me() answers at 2 s and getSave() would take 1.5 s more, When boot, Then the budget is shared — it resolves at 3 000 ms as local-only/timeout, not at 3.5 s or 5 s', async () => {
    const r = rig({
      state: boundB(save({ revision: 7 })),
      api: {
        me: () => new Promise((res) => setTimeout(() => res(ok(200, { ...ACCT_B })), 2_000)),
        getSave: () => new Promise((res) => setTimeout(() => res(cloudReply(save({ revision: 7 }))), 1_500)),
      },
    });
    let b: { decision: unknown } | null = null;
    void r.sync.boot(save({ revision: 9 })).then((x) => (b = x));
    await settle(2_000);
    expect(r.api.calls).toEqual(['me', 'getSave']);
    await settle(999);
    expect(b).toBeNull();
    await settle(1);
    expect(b!.decision).toEqual({ kind: 'local-only', reason: 'timeout' });
    expect(r.ts.calls).toEqual([]);
  });
});

describe('Task 6 — SyncClient.identity() (R51)', () => {
  it('Given a client before boot, Then identity() is null', () => {
    expect(rig().sync.identity()).toBeNull();
  });

  it('Given a boot where me() answers B, Then identity() is B — confirmed this session', async () => {
    const r = await signedIn();
    expect(r.sync.identity()).toEqual({ id: ACCT_B.id, name: ACCT_B.name });
  });

  it.each<[string, Partial<FakeApi['reply']>]>([
    ['401', { me: () => fail(401), getSave: () => fail(401) }],
    ['offline', { me: () => fail('offline'), getSave: () => fail('offline') }],
  ])('Given me() answers %s at boot, Then identity() is null (guest items)', async (_what, api) => {
    const r = rig({ state: boundB(save({ revision: 7 })), api });
    await r.sync.boot(save({ revision: 7 }));
    expect(r.sync.identity()).toBeNull();
  });

  it('Given a reader tab, When boot, Then identity() is null and me() was never asked', async () => {
    const r = rig({ writer: false });
    await r.sync.boot(save());
    expect(r.sync.identity()).toBeNull();
    expect(r.api.calls).not.toContain('me');
  });

  it('Given me() never answers within the 3 s budget, Then identity() is null', async () => {
    const r = rig({ api: { me: never, getSave: never } });
    const p = r.sync.boot(save());
    await settle(3_000);
    await p;
    expect(r.sync.identity()).toBeNull();
  });

  it('Given a refused switch (bound to A with unsynced progress, signed in as B), When boot, Then the client logged out and identity() is null', async () => {
    const r = rig({ state: boundA(save({ revision: 7 })), api: { getSave: () => noSave() } });
    const b = await r.sync.boot(save({ revision: 9 }));
    expect(b.decision.kind).toBe('refuse-switch');
    expect(r.api.calls).toContain('logout');
    expect(r.sync.identity()).toBeNull();
  });

  it('Given me() answers B and the cloud save is unreadable, Then identity() is still B (the identity was confirmed; only sync is off)', async () => {
    const r = rig({ state: boundB(save({ revision: 7 })), api: { getSave: () => cloudReply({ ...save({ revision: 9 }), format: 99 }) } });
    await r.sync.boot(save({ revision: 9 }));
    expect(r.sync.identity()).toEqual({ id: ACCT_B.id, name: ACCT_B.name });
  });
});

describe('Task 6 — SyncClient.signOut() (R53)', () => {
  it('Given signed in as B and in sync, When signOut succeeds, Then logout was POSTed, it answers true, identity() is null, the binding and the store are untouched, and no save is pushed again', async () => {
    const r = await signedIn();
    const before = r.storage.getItem(SYNC_KEY);
    r.ts.calls.length = 0;
    expect(await r.sync.signOut()).toBe(true);
    expect(r.api.calls.filter((c) => c === 'logout')).toHaveLength(1);
    expect(r.sync.identity()).toBeNull();
    expect(r.storage.getItem(SYNC_KEY)).toBe(before);
    expect(r.state()).toEqual(boundB(save({ revision: 7 })));
    expect(r.ts.calls).toEqual([]);
    r.sync.onStored(save({ revision: 8 }));
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
  });

  it("Ruling R56: Given signed in and bound to B, When signOut succeeds, Then status is 'off' (not reauth) and there is no status text to log", async () => {
    const r = await signedIn();
    await r.sync.signOut();
    expect(r.sync.status()).toBe('off');
    expect(r.sync.statusText()).toBeNull();
  });

  it.each<[string, ReturnType<FakeApi['reply']['logout']>]>([
    ['offline', fail('offline')],
    ['a 500', fail(500)],
    ['a timeout', fail('timeout')],
  ])('Given the logout request fails (%s), When signOut, Then it answers false and nothing changes: still B, still synced, pushes go on', async (_what, reply) => {
    const r = await signedIn({ logout: () => reply });
    const before = r.storage.getItem(SYNC_KEY);
    expect(await r.sync.signOut()).toBe(false);
    expect(r.sync.identity()).toEqual({ id: ACCT_B.id, name: ACCT_B.name });
    expect(r.sync.status()).toBe('synced');
    expect(r.storage.getItem(SYNC_KEY)).toBe(before);
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    expect(r.api.puts[0]!.save).toEqual(save({ revision: 8 }));
  });
});

describe('Task 6 — SyncClient.deleteAccount() (R54)', () => {
  it("Given signed in as B, When deleteAccount succeeds, Then DELETE was sent, it answers true, the sync state is fresh with the SAME deviceId, identity() is null, status 'off', the store untouched, and nothing is pushed again", async () => {
    const r = await signedIn();
    r.ts.calls.length = 0;
    const stored = await r.ts.current();
    expect(await r.sync.deleteAccount()).toBe(true);
    expect(r.api.calls.filter((c) => c === 'deleteAccount')).toHaveLength(1);
    expect(r.state()).toEqual(syncState({ deviceId: DEVICE_ID }));
    expect(r.sync.identity()).toBeNull();
    expect(r.sync.status()).toBe('off');
    expect(r.sync.statusText()).toBeNull();
    expect(r.ts.calls).toEqual([]);
    expect(await r.ts.current()).toEqual(stored);
    r.sync.onStored(save({ revision: 8 }));
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
  });

  it.each<[string, ReturnType<FakeApi['reply']['deleteAccount']>]>([
    ['offline', fail('offline')],
    ['a 500', fail(500)],
    ['a 401', fail(401)],
  ])('Given the delete request fails (%s), When deleteAccount, Then it answers false and nothing changes', async (_what, reply) => {
    const r = await signedIn({ deleteAccount: () => reply });
    const before = r.storage.getItem(SYNC_KEY);
    r.ts.calls.length = 0;
    expect(await r.sync.deleteAccount()).toBe(false);
    expect(r.storage.getItem(SYNC_KEY)).toBe(before);
    expect(r.sync.identity()).toEqual({ id: ACCT_B.id, name: ACCT_B.name });
    expect(r.ts.calls).toEqual([]);
  });

  it('Given no identity confirmed this session (a 401 boot), When deleteAccount, Then it answers false and sends nothing', async () => {
    const r = rig({ api: { me: () => fail(401), getSave: () => fail(401) } });
    await r.sync.boot(save());
    expect(await r.sync.deleteAccount()).toBe(false);
    expect(r.api.calls).not.toContain('deleteAccount');
  });
});

// =============================================================================
//  Task 6 fix round 1 — Ruling R60: a request in flight when signOut() or
//  deleteAccount() succeeded changes nothing when it answers later: status
//  stays 'off' (no text), the persisted state is what sign-out/delete left,
//  no retry, and no PUT is ever sent again this session.
// =============================================================================

describe('Ruling R60 — a late PUT after sign-out / delete changes nothing', () => {
  type Action = 'signOut' | 'deleteAccount';
  type Answer = Parameters<ReturnType<typeof deferred>['settle']>[0];
  /** What the persisted state must be after the action (and after the late answer). */
  // CHANGED by Ruling R68(b) (final fix round): after signOut the r8 in-flight marker persisted before the PUT stays
  // (a late answer touches nothing, R60); was boundB(save({ revision: 7 })).
  const after = (action: Action): SyncState =>
    action === 'signOut'
      ? boundB(save({ revision: 7 }), { inFlightPut: { saveId: GAME_X, revision: 8, fingerprint: expect.any(String) } })
      : syncState({ deviceId: DEVICE_ID });

  /** Signed in as B, in sync at r7; r8 stored and its PUT in flight (unanswered). */
  async function putInFlight(): Promise<{ r: Rig; answer: (a: Answer) => Promise<void> }> {
    const d = deferred();
    const r = await signedIn({ putSave: () => d.promise });
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    expect(r.api.puts).toHaveLength(1);
    return {
      r,
      answer: async (a) => {
        d.settle(a);
        await settle(0);
      },
    };
  }

  const cases: Array<[string, Answer]> = [
    ['200', ok(200, { revision: 8 })],
    ['401', fail(401)],
    ['500', fail(500)],
    ['a timeout', fail('timeout')],
    ['409', fail(409, { body: { cloud: { revision: 9, save: save({ revision: 9 }) } } })],
  ];

  for (const action of ['signOut', 'deleteAccount'] as const) {
    it.each(cases)(
      `Ruling R60: Given a PUT in flight, When ${action}() succeeds and the PUT then answers %s, Then status stays 'off' with no text, the persisted state is what ${action} left, and no retry is scheduled`,
      async (_what, reply) => {
        const { r, answer } = await putInFlight();
        expect(await r.sync[action]()).toBe(true);
        await answer(reply);
        expect(r.sync.status()).toBe('off');
        expect(r.sync.statusText()).toBeNull();
        expect(r.state()).toEqual(after(action));
        expect(r.state().conflict).toBe(false);
        await settle(TEN_MIN);
        expect(r.api.puts).toHaveLength(1);
        expect(r.sync.status()).toBe('off');
      },
    );

    it(`Ruling R60: Given ${action}() succeeded while a PUT was in flight, When the game stores again afterwards, Then no PUT is ever sent again this session`, async () => {
      const { r, answer } = await putInFlight();
      await r.sync[action]();
      await answer(ok(200, { revision: 8 }));
      r.sync.onStored(save({ revision: 9 }));
      await settle(TEN_MIN);
      r.sync.onStored(save({ revision: 10 }));
      await settle(TEN_MIN);
      expect(r.api.puts).toHaveLength(1);
    });
  }

  it("Ruling R60: Given an offline boot bound to B and an identity check (me()) in flight, When signOut() succeeds and me() then answers B, Then identity() stays null, status 'off', and nothing is pushed", async () => {
    const me = deferred();
    let n = 0;
    const r = rig({
      state: boundB(save({ revision: 7 })),
      api: { me: () => (n++ === 0 ? fail('offline') : me.promise), getSave: () => fail('offline') },
    });
    await r.sync.boot(save({ revision: 7 }));
    r.sync.onStored(save({ revision: 8 }));
    for (let t = 0; t <= 5_100 && r.api.calls.filter((c) => c === 'me').length < 2; t += 100) await settle(100);
    expect(r.api.calls.filter((c) => c === 'me')).toHaveLength(2);
    expect(await r.sync.signOut()).toBe(true);
    me.settle(ok(200, { ...ACCT_B }));
    await settle(0);
    expect(r.sync.identity()).toBeNull();
    expect(r.sync.status()).toBe('off');
    expect(r.sync.statusText()).toBeNull();
    expect(r.state()).toEqual(boundB(save({ revision: 7 })));
    r.sync.onStored(save({ revision: 9 }));
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
  });
});

// =============================================================================
//  Final fix round — what the final review found (R68–R71; final-fix-brief.md).
//  Assumed surface (phase B implements it):
//
//   SyncState gains two OPTIONAL fields (an old state without them still parses):
//     inFlightPut?: { saveId: string; revision: number; fingerprint: string }
//        // R68(b): persisted before each PUT, cleared (absent or null) when the
//        // PUT is acknowledged; fingerprint = a cheap deterministic hash of the
//        // save's content key (rawKey). At boot a cloud head whose saveId,
//        // revision AND fingerprint equal it counts as last-seen-cloud.
//     pendingResolve?: ResolveBody
//        // R69: the exact resolve request body, persisted before the POST,
//        // cleared on success or a definitive refusal; replayed verbatim at
//        // the next boot before reconcile.
//   R68(a): after a retryable PUT failure (timeout / offline / 5xx / 429) the
//   SAME save is resent before any newer queued one.
//   R69: a retryable resolve failure is retried once, at once (no timer — the
//   approved test "Given resolve gets offline/timeout…" awaits resolve() with
//   no timer advanced).
//   R71: resolve('device') on the same game shelves the unchosen cloud save
//   (store.keepCorrupt) before the local save changes.
// =============================================================================

/** The persisted sync state, as raw JSON (fields phase B adds included). */
const rawState = (r: Rig): Record<string, unknown> => JSON.parse(r.storage.getItem(SYNC_KEY)!) as Record<string, unknown>;

describe('Ruling R68(a) — an unacknowledged PUT is resent before any newer save', () => {
  it.each<[string, ApiResult]>([
    ['a timeout', fail('timeout')],
    ['offline', fail('offline')],
    ['a 503', fail(503)],
    ['a 429', fail(429, { retryAfterS: null, body: { error: 'rate_limited' } })],
  ])(
    'Ruling R68: Given L r7 and the PUT of r8 failing with %s, When r9 is stored during the backoff, Then the next PUT is r8 again (base r7), and only then r9 with base r8 — no conflict',
    async (_what, failure) => {
      let n = 0;
      const r = await signedIn({ putSave: (b) => (n++ === 0 ? failure : ok(200, { revision: b.save.revision })) });
      r.sync.onStored(save({ revision: 8 }));
      await untilPut(r.api);
      await settle(1_000);
      r.sync.onStored(save({ revision: 9 }));
      await settle(60_000);
      expect(r.api.puts.map((p) => [p.base, p.save.revision])).toEqual([
        [{ saveId: GAME_X, revision: 7 }, 8],
        [{ saveId: GAME_X, revision: 7 }, 8],
        [{ saveId: GAME_X, revision: 8 }, 9],
      ]);
      expect(r.api.puts[1]!.save).toEqual(save({ revision: 8 }));
      expect(r.sync.status()).toBe('synced');
      expect(r.state().conflict).toBe(false);
      expect(r.state().lastSeenCloud).toEqual({ saveId: GAME_X, revision: 9 });
    },
  );

  it('Ruling R68: Given the PUT of r8 fails, When r9 AND r10 are stored during the backoff, Then the PUTs are r8, r8, then r10 (the newest) — nothing in between', async () => {
    let n = 0;
    const r = await signedIn({ putSave: (b) => (n++ === 0 ? fail('timeout') : ok(200, { revision: b.save.revision })) });
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    await settle(1_000);
    r.sync.onStored(save({ revision: 9 }));
    r.sync.onStored(save({ revision: 10 }));
    await settle(60_000);
    expect(r.api.puts.map((p) => p.save.revision)).toEqual([8, 8, 10]);
    expect(r.api.puts[2]!.base).toEqual({ saveId: GAME_X, revision: 8 });
  });

  it('Ruling R68 (I1): Given a server that COMMITS the PUT of r8 but whose answer is lost (timeout), When r9 is stored during the backoff, Then the resend of r8 is answered unchanged, r9 follows with base r8 — no 409, no conflict, and the cloud ends at r9', async () => {
    // The server's rules (server/save/repo.ts): an identical save is `unchanged`; a stale base is a 409.
    let cloud = save({ revision: 7 });
    let lose = 1;
    const putSave = (b: PutBody): ApiResult => {
      if (JSON.stringify(b.save) === JSON.stringify(cloud)) return ok(200, { revision: cloud.revision });
      if (!b.base || b.base.saveId !== cloud.saveId || b.base.revision !== cloud.revision) {
        return fail(409, { body: { cloud: { revision: cloud.revision, save: cloud } } });
      }
      cloud = b.save;
      if (lose > 0) {
        lose--;
        return fail('timeout');
      }
      return ok(200, { revision: cloud.revision });
    };
    const r = await signedIn({ putSave });
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    await settle(1_000);
    r.sync.onStored(save({ revision: 9 }));
    await settle(60_000);
    expect(r.sync.status()).toBe('synced');
    expect(r.state().conflict).toBe(false);
    expect(r.state().lastSeenCloud).toEqual({ saveId: GAME_X, revision: 9 });
    expect(cloud).toEqual(save({ revision: 9 }));
  });
});

describe('Ruling R68(b) — the in-flight marker (tab death mid-PUT)', () => {
  it('Ruling R68: Given a PUT of r8, When putSave is called, Then the sync state ALREADY holds the marker {saveId, revision: 8, fingerprint} — persisted before the request', async () => {
    let seen: unknown = 'not called';
    const r: Rig = await signedIn({
      putSave: (b) => {
        seen = rawState(r).inFlightPut;
        return ok(200, { revision: b.save.revision });
      },
    });
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    expect(seen).toEqual({ saveId: GAME_X, revision: 8, fingerprint: expect.any(String) });
    expect((seen as { fingerprint: string }).fingerprint.length).toBeGreaterThan(0);
  });

  it('Ruling R68: Given the PUT of r8 is acknowledged, Then the marker is cleared from the persisted state', async () => {
    const r = await signedIn();
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    await settle(0);
    expect(r.state().lastSeenCloud).toEqual({ saveId: GAME_X, revision: 8 });
    expect(r.state().inFlightPut ?? null).toBeNull();
  });

  it('Ruling R68: Given the PUT of r8 times out, Then the marker for r8 stays (the server may have committed it)', async () => {
    const r = await signedIn({ putSave: () => fail('timeout') });
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    await settle(0);
    expect(r.state().inFlightPut).toEqual({ saveId: GAME_X, revision: 8, fingerprint: expect.any(String) });
  });

  it('Ruling R68: Given two devices PUT the same save and a third the same saveId + revision with other content, Then the fingerprint is deterministic (equal for the same content) and differs for other content', async () => {
    const markerOf = async (s: SaveV1): Promise<unknown> => {
      const r = await signedIn({ putSave: never });
      r.sync.onStored(s);
      await untilPut(r.api);
      return (r.state().inFlightPut as { fingerprint: unknown } | undefined)?.fingerprint;
    };
    const a = await markerOf(save({ revision: 8, tank: 1_234 }));
    const b = await markerOf(save({ revision: 8, tank: 1_234 }));
    const c = await markerOf(save({ revision: 8, tank: 999 }));
    expect(typeof a).toBe('string');
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  /** Session 1: bound to B at L r7, the PUT of `sent` is in flight when the tab dies. Returns its persisted state. */
  async function tabDiedMidPut(sent: SaveV1): Promise<SyncState> {
    const r1 = await signedIn({ putSave: never });
    r1.sync.onStored(sent);
    await untilPut(r1.api);
    return r1.state();
  }

  it('Ruling R68 (I1, tab death): Given the PUT of r8 was in flight when the tab died and the cloud now holds EXACTLY that r8, When the next boot has local r9 (the pagehide snapshot), Then push-local — not a conflict — and r9 is PUT with base r8', async () => {
    const sent = save({ revision: 8, tank: 1_234 });
    const state = await tabDiedMidPut(sent);
    const r = rig({ state, api: { getSave: () => cloudReply(sent) } });
    const b = await r.sync.boot(save({ revision: 9, tank: 1_234 }));
    expect(b.decision).toEqual({ kind: 'push-local' });
    expect(r.state().conflict).toBe(false);
    expect(r.sync.status()).not.toBe('conflict');
    await settle(PUSH_MIN_INTERVAL_MS);
    expect(r.api.puts.map((p) => [p.base, p.save.revision])).toEqual([[{ saveId: GAME_X, revision: 8 }, 9]]);
  });

  it('Ruling R68 (guard): Given the marker names r8 but the cloud holds an r8 with OTHER content (another device wrote it), When the next boot has local r9, Then it is NOT trusted — conflict-same, as without a marker', async () => {
    const state = await tabDiedMidPut(save({ revision: 8, tank: 1_234 }));
    const r = rig({ state, api: { getSave: () => cloudReply(save({ revision: 8, tank: 999 })) } });
    const b = await r.sync.boot(save({ revision: 9, tank: 1_234 }));
    expect(b.decision).toEqual({ kind: 'conflict-same' });
    expect(r.state().conflict).toBe(true);
  });
});

/** Bound to B, L r7, local r9 (stored), cloud r8 on the same game: a conflict-same boot. */
async function conflictRig(api: Partial<FakeApi['reply']> = {}, local = save({ revision: 9 })): Promise<Rig> {
  const r = rig({ state: boundB(save({ revision: 7 })), api: { getSave: () => cloudReply(save({ revision: 8 })), ...api } });
  await r.ts.store.save(local);
  r.ts.calls.length = 0;
  expect((await r.sync.boot(local)).decision.kind).toBe('conflict-same');
  return r;
}

/** The body resolve('device') sends from conflictRig. */
const DEVICE_BODY = (): ResolveBody => ({
  deviceId: DEVICE_ID,
  keep: 'device',
  device: save({ revision: 9 }),
  base: { saveId: GAME_X, revision: 7 },
  cloud: { saveId: GAME_X, revision: 8 },
});

describe('Ruling R69 — resolve is persisted, retried once, and replayed verbatim at the next boot', () => {
  it('Ruling R69: Given a conflict, When resolve("device") is POSTed, Then the exact request body is ALREADY in the persisted sync state', async () => {
    let seen: unknown = 'not called';
    const result = save({ revision: 10, tank: 5_000 });
    const r: Rig = await conflictRig({
      resolve: () => {
        seen = rawState(r).pendingResolve;
        return ok(200, { revision: 10, save: result });
      },
    });
    await r.sync.resolve('device');
    expect(r.api.resolves).toHaveLength(1);
    expect(seen).toEqual(r.api.resolves[0]);
    expect(seen).toEqual(DEVICE_BODY());
  });

  it('Ruling R69: Given resolve succeeds at once, Then the pending resolve is cleared', async () => {
    const r = await conflictRig({ resolve: () => ok(200, { revision: 10, save: save({ revision: 10 }) }) });
    expect((await r.sync.resolve('device')).ok).toBe(true);
    expect(r.state().pendingResolve ?? null).toBeNull();
  });

  it.each<[string, ApiResult]>([
    ['a timeout', fail('timeout')],
    ['offline', fail('offline')],
    ['a 503', fail(503)],
    ['a 429', fail(429, { retryAfterS: 1, body: { error: 'rate_limited' } })],
  ])(
    'Ruling R69: Given every resolve POST fails with %s, When resolve("device"), Then it is sent exactly twice with deep-equal bodies, answers {ok: false, reason: "offline"}, and the body stays persisted with the conflict flag',
    async (_what, failure) => {
      const r = await conflictRig({ resolve: () => failure });
      expect(await r.sync.resolve('device')).toEqual({ ok: false, reason: 'offline' });
      expect(r.api.resolves).toHaveLength(2);
      expect(r.api.resolves[1]).toEqual(r.api.resolves[0]);
      expect(r.state().pendingResolve).toEqual(r.api.resolves[0]);
      expect(r.state().conflict).toBe(true);
      expect(r.ts.calls).toEqual([]);
    },
  );

  it('Ruling R69: Given the first resolve POST times out and the retry answers 200, Then ok, both bodies are identical, the result is stored and the pending resolve is cleared', async () => {
    const result = save({ revision: 10, tank: 5_000 });
    const replies = [fail('timeout'), ok(200, { revision: 10, save: result })];
    const r = await conflictRig({ resolve: () => replies.shift()! });
    expect(await r.sync.resolve('device')).toEqual({ ok: true, save: result });
    expect(r.api.resolves).toHaveLength(2);
    expect(r.api.resolves[1]).toEqual(r.api.resolves[0]);
    expect(await r.ts.current()).toEqual(result);
    expect(r.state().pendingResolve ?? null).toBeNull();
    expect(r.state().conflict).toBe(false);
  });

  it.each<[string, ApiResult]>([
    ['401', fail(401)],
    ['409 (the cloud moved)', fail(409, { body: { cloud: { revision: 11, save: save({ revision: 11 }) } } })],
  ])('Ruling R69: Given resolve answers %s (a definitive answer), Then it is NOT retried', async (_what, reply) => {
    const r = await conflictRig({ resolve: () => reply });
    await r.sync.resolve('device');
    expect(r.api.resolves).toHaveLength(1);
  });

  /** Session 1: a conflict, resolve("device") whose answers are lost (both POSTs time out). Returns its rig. */
  async function lostResolve(): Promise<Rig> {
    const r1 = await conflictRig({ resolve: () => fail('timeout') });
    expect(await r1.sync.resolve('device')).toEqual({ ok: false, reason: 'offline' });
    expect(r1.state().pendingResolve).toEqual(DEVICE_BODY());
    return r1;
  }

  /** The next boot on the same device: the same store and sync state, a new client. */
  function nextBoot(prev: Rig, api: Partial<FakeApi['reply']>): Rig {
    const r = rig({ state: prev.state(), ts: prev.ts, walStorage: prev.walStorage, api });
    r.ts.calls.length = 0;
    return r;
  }

  it('Ruling R69 (I2), R75: Given a resolve whose response was lost (the server committed r10) and the local save still at the device revision (r9 = pendingResolve.device.revision), When the next boot runs, Then the IDENTICAL body is sent again (deep equal) before reconcile, the result is applied like a normal resolve, the pending entry is cleared and the boot is in sync', async () => {
    const result = save({ revision: 10, tank: 5_000 });
    const r1 = await lostResolve();
    const r = nextBoot(r1, { getSave: () => cloudReply(result), resolve: () => ok(200, { revision: 10, save: result }) });
    const b = await r.sync.boot(save({ revision: 9 }));
    expect(r.api.resolves).toEqual([DEVICE_BODY()]);
    expect(r.api.resolves[0]).toEqual(r1.api.resolves[0]);
    expect(b.decision).toEqual({ kind: 'in-sync' });
    expect(await r.ts.current()).toEqual(result);
    expect(r.state()).toMatchObject({ lastSeenCloud: { saveId: GAME_X, revision: 10 }, conflict: false });
    expect(r.state().pendingResolve ?? null).toBeNull();
    expect(r.sync.status()).toBe('synced');
  });

  it.each<[string, ApiResult]>([
    ['409 (the cloud moved on)', fail(409, { body: { cloud: { revision: 11, save: save({ revision: 11 }) } } })],
    ['400', fail(400, { body: { error: 'invalid' } })],
  ])(
    'Ruling R69: Given a pending resolve and the replay at the next boot answers %s (a definitive refusal), Then the pending entry is cleared and boot continues normally (reconcile: conflict-same against the cloud r11)',
    async (_what, reply) => {
      const r1 = await lostResolve();
      const r = nextBoot(r1, { getSave: () => cloudReply(save({ revision: 11 })), resolve: () => reply });
      const b = await r.sync.boot(save({ revision: 9 }));
      expect(r.api.resolves).toEqual([DEVICE_BODY()]);
      expect(r.state().pendingResolve ?? null).toBeNull();
      expect(b.decision).toEqual({ kind: 'conflict-same' });
      expect(r.ts.calls).toEqual([]);
    },
  );

  it.each<[string, ApiResult]>([
    ['a timeout', fail('timeout')],
    ['offline', fail('offline')],
    ['a 503', fail(503)],
  ])(
    'Ruling R69: Given a pending resolve and the replay at the next boot fails with %s, Then the entry stays, boot continues local with the conflict flag kept, nothing is written and nothing is pushed',
    async (_what, reply) => {
      const r1 = await lostResolve();
      const r = nextBoot(r1, { getSave: () => cloudReply(save({ revision: 10 })), resolve: () => reply });
      const b = await r.sync.boot(save({ revision: 9 }));
      expect(r.api.resolves.length).toBeGreaterThanOrEqual(1);
      for (const body of r.api.resolves) expect(body).toEqual(DEVICE_BODY());
      expect(b.decision.kind).toBe('local-only');
      expect(r.state().pendingResolve).toEqual(DEVICE_BODY());
      expect(r.state().conflict).toBe(true);
      expect(r.sync.status()).toBe('conflict');
      expect(r.ts.calls).toEqual([]);
      r.sync.onStored(save({ revision: 12 }));
      await settle(TEN_MIN);
      expect(r.api.puts).toEqual([]);
    },
  );

  it('Ruling R69 (I2): Given a lost resolve, a boot whose replay times out, and a later boot whose replay succeeds, Then every resolve ever sent for this conflict is the same body — never a second, different one', async () => {
    const result = save({ revision: 10, tank: 5_000 });
    const r1 = await lostResolve();
    const r2 = nextBoot(r1, { getSave: () => cloudReply(result), resolve: () => fail('timeout') });
    await r2.sync.boot(save({ revision: 9 }));
    const r3 = nextBoot(r2, { getSave: () => cloudReply(result), resolve: () => ok(200, { revision: 10, save: result }) });
    expect((await r3.sync.boot(save({ revision: 9 }))).decision).toEqual({ kind: 'in-sync' });
    const all = [...r1.api.resolves, ...r2.api.resolves, ...r3.api.resolves];
    expect(r3.api.resolves.length).toBeGreaterThanOrEqual(1);
    for (const body of all) expect(body).toEqual(DEVICE_BODY());
  });

  it('Ruling R69 (guard, R48): Given a pending resolve bound to B and the next boot signed in as A, Then nothing is replayed (B\'s resolve is never sent with A\'s cookie) and the entry is not used up', async () => {
    const r1 = await lostResolve();
    const r = nextBoot(r1, { me: () => ok(200, { ...ACCT_A }), getSave: () => noSave(), resolve: () => ok(200, { revision: 10, save: save({ revision: 10 }) }) });
    await r.sync.boot(save({ revision: 9 }));
    expect(r.api.resolves).toEqual([]);
  });

  it('Ruling R69 (guard): Given a pending resolve and a reader tab, When boot, Then nothing is replayed', async () => {
    const r1 = await lostResolve();
    const r = rig({ state: r1.state(), ts: r1.ts, writer: false, api: { resolve: () => ok(200, { revision: 10, save: save({ revision: 10 }) }) } });
    await r.sync.boot(save({ revision: 9 }));
    expect(r.api.resolves).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Addendum — Ruling R75: local progress made after a lost resolve is never discarded.

  it('Ruling R75: Given a lost resolve (device r9) and the player played on to r11 locally, When the next boot replays the identical body and gets the result r10, Then the result is NOT written over r11 — nothing shelved or reset, the pending entry is cleared, L = the result head, and the boot is an ordinary conflict between r11 and the result (no PUT)', async () => {
    const result = save({ revision: 10, tank: 5_000 });
    const advanced = save({ revision: 11, tank: 4_000 });
    const r1 = await lostResolve();
    r1.sync.onStored(advanced);
    await r1.ts.store.save(advanced);
    const r = nextBoot(r1, { getSave: () => cloudReply(result), resolve: () => ok(200, { revision: 10, save: result }) });
    const b = await r.sync.boot(advanced);
    expect(r.api.resolves).toEqual([DEVICE_BODY()]);
    expect(r.ts.calls).toEqual([]);
    expect(r.ts.shelf.map((e) => e.raw)).not.toContainEqual(advanced);
    expect(await r.ts.current()).toEqual(advanced);
    expect(r.state().pendingResolve ?? null).toBeNull();
    expect(r.state().lastSeenCloud).toEqual({ saveId: GAME_X, revision: 10 });
    expect(b.decision).toEqual({ kind: 'conflict-same' });
    expect(b.cloud).toEqual(result);
    expect(r.state().conflict).toBe(true);
    expect(r.sync.status()).toBe('conflict');
    await settle(TEN_MIN);
    expect(r.api.puts).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Addendum — Ruling R76: the boot replay lives inside the shared 3 s boot budget.

  it('Ruling R76: Given a pending resolve and a replay that never answers, When the next boot runs, Then boot ends at 3 000 ms — not before, not at 30 s — local-only, with the entry kept, the conflict flag kept and nothing written', async () => {
    const r1 = await lostResolve();
    const r = nextBoot(r1, { getSave: () => cloudReply(save({ revision: 10 })), resolve: never });
    let b: { decision: { kind: string } } | null = null;
    void r.sync.boot(save({ revision: 9 })).then((x) => (b = x));
    await settle(2_999);
    expect(r.api.resolves).toEqual([DEVICE_BODY()]);
    expect(b).toBeNull();
    await settle(1);
    expect(b).not.toBeNull();
    expect(b!.decision.kind).toBe('local-only');
    expect(r.state().pendingResolve).toEqual(DEVICE_BODY());
    expect(r.state().conflict).toBe(true);
    expect(r.sync.status()).toBe('conflict');
    expect(r.ts.calls).toEqual([]);
  });

  it('Ruling R76 (guard): Given a conflict, When the in-session resolve() answers only after 10 s, Then it still succeeds — the 3 s boot budget does not apply to resolve() (its call keeps 30 s, R70)', async () => {
    const result = save({ revision: 10, tank: 5_000 });
    const r = await conflictRig({ resolve: () => new Promise<ApiResult>((res) => setTimeout(() => res(ok(200, { revision: 10, save: result })), 10_000)) });
    let out: unknown = null;
    void r.sync.resolve('device').then((x) => (out = x));
    await settle(10_000);
    expect(out).toEqual({ ok: true, save: result });
  });

  // ---------------------------------------------------------------------------
  // Addendum 2 — Ruling R79: the R75 conflict survives a reboot (sync state
  // `unmergedCloud: { saveId, revision }` = the result head; reconcile reads it).

  /** Sessions 1–2: a lost resolve (device r9), the player plays on to r11, the next boot is the R75 conflict. */
  async function r75Boot(result: SaveV1, advanced: SaveV1): Promise<Rig> {
    const r1 = await lostResolve();
    r1.sync.onStored(advanced);
    await r1.ts.store.save(advanced);
    const r2 = nextBoot(r1, { getSave: () => cloudReply(result), resolve: () => ok(200, { revision: result.revision, save: result }) });
    expect((await r2.sync.boot(advanced)).decision).toEqual({ kind: 'conflict-same' });
    return r2;
  }

  it.each(['device', 'cloud'] as const)(
    "Ruling R79: Given the R75 conflict (local r11, result r10 = L), When the game reloads with nothing changed, Then conflict-same again and zero PUTs; When resolve('%s') then succeeds, Then unmergedCloud is gone and a later boot behaves normally (local r13 over cloud r12 is push-local)",
    async (keep) => {
      const result = save({ revision: 10, tank: 5_000 });
      const advanced = save({ revision: 11, tank: 4_000 });
      const r2 = await r75Boot(result, advanced);
      expect(r2.state().unmergedCloud).toEqual({ saveId: GAME_X, revision: 10 });
      expect(r2.state().lastSeenCloud).toEqual({ saveId: GAME_X, revision: 10 });

      // Reload: nothing changed — the cloud is still exactly L.
      const resolved = save({ revision: 12, tank: 3_500 });
      const r3 = nextBoot(r2, { getSave: () => cloudReply(result), resolve: () => ok(200, { revision: 12, save: resolved }) });
      const b3 = await r3.sync.boot(advanced);
      expect(b3.decision).toEqual({ kind: 'conflict-same' });
      expect(b3.cloud).toEqual(result);
      expect(r3.sync.status()).toBe('conflict');
      r3.sync.onStored(save({ revision: 12, tank: 3_900 }));
      await settle(TEN_MIN);
      expect(r3.api.puts).toEqual([]);

      // The player chooses; the resolve is acknowledged.
      expect((await r3.sync.resolve(keep)).ok).toBe(true);
      expect(r3.state().unmergedCloud ?? null).toBeNull();
      expect(r3.state().conflict).toBe(false);

      // A later boot: the cloud holds the resolved r12, the player has played on to r13 — normal rules: push-local, PUT r13.
      const r4 = nextBoot(r3, { getSave: () => cloudReply(resolved) });
      expect((await r4.sync.boot(save({ revision: 13, tank: 3_400 }))).decision).toEqual({ kind: 'push-local' });
      await settle(PUSH_MIN_INTERVAL_MS);
      expect(r4.api.puts.map((p) => [p.base, p.save.revision])).toEqual([[{ saveId: GAME_X, revision: 12 }, 13]]);
    },
  );

  it('Ruling R79: Given the R75 conflict persisted and the local save gone (no local), When the next boot takes the cloud save (use-cloud), Then unmergedCloud is cleared', async () => {
    const result = save({ revision: 10, tank: 5_000 });
    const r2 = await r75Boot(result, save({ revision: 11, tank: 4_000 }));
    const r3 = nextBoot(r2, { getSave: () => cloudReply(result) });
    expect((await r3.sync.boot(null)).decision).toEqual({ kind: 'use-cloud' });
    expect(r3.state().unmergedCloud ?? null).toBeNull();
  });

  it.each(['offline', 'timeout'] as const)(
    'Ruling R79 (guard, R46): Given the R75 conflict persisted, When the next boot cannot reach the cloud (%s), Then status conflict and no PUT for the session, and unmergedCloud is kept',
    async (how) => {
      const r2 = await r75Boot(save({ revision: 10, tank: 5_000 }), save({ revision: 11, tank: 4_000 }));
      const r3 = nextBoot(r2, how === 'offline' ? { me: () => fail('offline'), getSave: () => fail('offline') } : { me: never, getSave: never });
      const done = r3.sync.boot(save({ revision: 11, tank: 4_000 }));
      if (how === 'timeout') await settle(3_000);
      expect((await done).decision.kind).toBe('local-only');
      expect(r3.sync.status()).toBe('conflict');
      r3.api.reply.me = () => ok(200, { ...ACCT_B });
      r3.sync.onStored(save({ revision: 12 }));
      await settle(TEN_MIN);
      expect(r3.api.puts).toEqual([]);
      expect(r3.state().unmergedCloud).toEqual({ saveId: GAME_X, revision: 10 });
    },
  );

  // ---------------------------------------------------------------------------
  // Addendum 2 — Ruling R80: a replay that answers after the boot budget changes nothing mid-session.

  it.each<[string, ApiResult]>([
    ['200 with the result', ok(200, { revision: 10, save: save({ revision: 10, tank: 5_000 }) })],
    ['a 500', fail(500)],
    ['a 409', fail(409, { body: { cloud: { revision: 11, save: save({ revision: 11 }) } } })],
  ])(
    'Ruling R80: Given the boot replay outlived the 3 s budget (boot went local-only), When it answers %s afterwards, Then store, sync state, status and L are untouched and pendingResolve is still there — and the next boot replays the identical body',
    async (_what, late) => {
      const r1 = await lostResolve();
      const answer = deferred();
      const r = nextBoot(r1, { getSave: () => cloudReply(save({ revision: 10 })), resolve: () => answer.promise });
      const done = r.sync.boot(save({ revision: 9 }));
      await settle(3_000);
      expect((await done).decision.kind).toBe('local-only');
      const stateBefore = r.storage.getItem(SYNC_KEY);
      const storeBefore = await r.ts.current();
      const statusBefore = r.sync.status();
      r.ts.calls.length = 0;

      answer.settle(late);
      await settle(0);
      await settle(TEN_MIN);
      expect(r.storage.getItem(SYNC_KEY)).toBe(stateBefore);
      expect(r.state().pendingResolve).toEqual(DEVICE_BODY());
      expect(r.state().lastSeenCloud).toEqual({ saveId: GAME_X, revision: 7 });
      expect(r.state().conflict).toBe(true);
      expect(await r.ts.current()).toEqual(storeBefore);
      expect(r.ts.calls).toEqual([]);
      expect(r.sync.status()).toBe(statusBefore);
      expect(r.api.puts).toEqual([]);

      const result = save({ revision: 10, tank: 5_000 });
      const next = nextBoot(r, { getSave: () => cloudReply(result), resolve: () => ok(200, { revision: 10, save: result }) });
      await next.sync.boot(save({ revision: 9 }));
      expect(next.api.resolves).toEqual([DEVICE_BODY()]);
    },
  );
});

describe('Ruling R71 — the unchosen cloud snapshot goes on the shelf', () => {
  it('Ruling R71: Given a same-game conflict (local r9, cloud r8), When resolve("device") succeeds, Then the cloud r8 the boot saw is on the shelf, shelved before the local save changes', async () => {
    const cloud = save({ revision: 8 });
    const r = await conflictRig({ resolve: () => ok(200, { revision: 10, save: save({ revision: 10, tank: 5_000 }) }) });
    expect((await r.sync.resolve('device')).ok).toBe(true);
    expect(r.ts.shelf.map((e) => e.raw)).toContainEqual(cloud);
    const keepCloud = r.ts.calls.indexOf(`keep:${GAME_X}:8`);
    expect(keepCloud).toBeGreaterThanOrEqual(0);
    expect(keepCloud).toBeLessThan(r.ts.calls.indexOf('wal:reset'));
    expect(keepCloud).toBeLessThan(r.ts.calls.indexOf(`replace:${GAME_X}:10`));
  });

  it('Ruling R71: Given the cloud moved during the choice (409 with r11) and resolve("device") then succeeds, Then the cloud that was actually overruled — r11 — is on the shelf', async () => {
    const moved = save({ revision: 11, tank: 7_000 });
    const replies = [fail(409, { body: { cloud: { revision: 11, save: moved } } }), ok(200, { revision: 12, save: save({ revision: 12 }) })];
    const r = await conflictRig({ resolve: () => replies.shift()! });
    expect(await r.sync.resolve('device')).toEqual({ ok: false, reason: 'moved', cloud: moved });
    expect((await r.sync.resolve('device')).ok).toBe(true);
    expect(r.ts.shelf.map((e) => e.raw)).toContainEqual(moved);
  });

  it('Ruling R71 (guard, existing behaviour): Given a same-game conflict, When resolve("cloud") succeeds with the cloud r8, Then the device r9 is on the shelf and the chosen cloud is not', async () => {
    const cloud = save({ revision: 8 });
    const r = await conflictRig({ resolve: () => ok(200, { revision: 8, save: cloud }) });
    expect((await r.sync.resolve('cloud')).ok).toBe(true);
    const shelf = r.ts.shelf.map((e) => e.raw);
    expect(shelf).toContainEqual(save({ revision: 9 }));
    expect(shelf).not.toContainEqual(cloud);
  });
});

// =============================================================================
//  Addendum — Ruling R74: a pending resolve that cannot be recorded is not
//  sent (R69 protects nothing if the body was never persisted). A failed
//  in-flight marker write does NOT block a PUT: an unrecorded PUT costs at
//  worst a conflict the player chooses; an unsent PUT costs the sync itself.
// =============================================================================

/** A localStorage that refuses (quota) any write whose value contains `refuse`. */
class RefusingStorage extends MemoryStorage {
  refuse: string;
  constructor(refuse: string, state: SyncState) {
    super();
    this.refuse = refuse;
    super.setItem(SYNC_KEY, JSON.stringify(state));
  }
  override setItem(k: string, v: string): void {
    if (String(v).includes(this.refuse)) throw new DOMException('quota exceeded', 'QuotaExceededError');
    super.setItem(k, v);
  }
}

describe('Ruling R74 — what happens when the sync state cannot be written', () => {
  // CHANGED by Ruling R78 (addendum 2): narrowed to persistent storage in use (the state was read from it) that refuses the
  // write; was "Given a conflict and a sync state that cannot record the pending resolve (quota)…". Assertions unchanged.
  it("Ruling R74/R78: Given a conflict, persistent storage in use (the sync state was read from it) and that storage refusing to record the pending resolve (quota), When resolve('device'), Then NO POST is sent, it answers {ok: false, reason: 'offline'}, the conflict flag stays and nothing is written", async () => {
    const storage = new RefusingStorage('"pendingResolve"', boundB(save({ revision: 7 })));
    const r = rig({
      storage,
      api: { getSave: () => cloudReply(save({ revision: 8 })), resolve: () => ok(200, { revision: 10, save: save({ revision: 10 }) }) },
    });
    await r.ts.store.save(save({ revision: 9 }));
    r.ts.calls.length = 0;
    expect((await r.sync.boot(save({ revision: 9 }))).decision.kind).toBe('conflict-same');
    expect(await r.sync.resolve('device')).toEqual({ ok: false, reason: 'offline' });
    expect(r.api.resolves).toEqual([]);
    expect((JSON.parse(storage.getItem(SYNC_KEY)!) as SyncState).conflict).toBe(true);
    expect(r.sync.status()).toBe('conflict');
    expect(r.ts.calls).toEqual([]);
  });

  it('Ruling R74 (deliberate difference): Given a sync state that cannot record the in-flight marker (quota), When the game saves r8, Then the PUT is still sent, and once acknowledged L = r8 is persisted', async () => {
    const storage = new RefusingStorage('"inFlightPut"', boundB(save({ revision: 7 })));
    const r = rig({ storage, api: { getSave: () => cloudReply(save({ revision: 7 })) } });
    expect((await r.sync.boot(save({ revision: 7 }))).decision.kind).toBe('in-sync');
    r.sync.onStored(save({ revision: 8 }));
    await untilPut(r.api);
    await settle(0);
    expect(r.api.puts.map((p) => p.save.revision)).toEqual([8]);
    expect((JSON.parse(storage.getItem(SYNC_KEY)!) as SyncState).lastSeenCloud).toEqual({ saveId: GAME_X, revision: 8 });
    expect(r.sync.status()).toBe('synced');
  });
});

// =============================================================================
//  Addendum 2 — Ruling R78: R74 blocks resolve only when persistent storage is
//  in use and refuses the write. In memory mode — no storage, or the private-
//  mode path where the state could not even be read (R32: sync works in
//  memory) — resolve() proceeds and sends the POST unrecorded, as today.
// =============================================================================

describe('Ruling R78 — memory mode resolves unrecorded', () => {
  it.each<[string, StorageLike | null]>([
    ['no storage at all (null)', null],
    ['private mode (every storage call throws)', new ThrowingStorage()],
  ])("Ruling R78 (guard): Given %s and a guest save in conflict with B's cloud, When resolve('device'), Then the POST IS sent and the result is applied", async (_what, storage) => {
    const local = save({ revision: 7 });
    const api = fakeApi({ getSave: () => cloudReply(save({ saveId: GAME_Y, revision: 3 })), resolve: () => ok(200, { revision: 7, save: local }) });
    const ts = testStore();
    const sync = new SyncClient({
      api,
      storage,
      isWriter: () => true,
      schedule: timerSchedule,
      store: ts.store,
      wal: recordingWal(new MemoryStorage(), ts.calls),
      uuid: () => DEVICE_ID,
    });
    await ts.store.save(local);
    expect((await sync.boot(local)).decision.kind).toBe('conflict-different');
    expect(await sync.resolve('device')).toEqual({ ok: true, save: local });
    expect(api.resolves).toHaveLength(1);
    expect(sync.status()).toBe('synced');
  });
});
