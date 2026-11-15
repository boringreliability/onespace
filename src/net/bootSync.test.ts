/**
 * v4 sub-plan 4, Task 5 (phase A) — the boot glue: sync before `decideBoot`.
 *
 * registry.ts is hard to unit-test, so the wiring is a small function it
 * calls before `decideBoot` (src/net/bootSync.ts):
 *
 *   runBootSync(d: {
 *     sync: Pick<SyncClient, 'boot'>;
 *     store: SaveStore;
 *     wal: Wal;
 *     writer: boolean;            // the writer lock's verdict
 *   }): Promise<BootSync>
 *
 * It reads the local save as the boot will (`loadForBootResult(store, wal,
 * { writer })` — newest valid, WAL merged), hands it to
 * `sync.boot(local, { localDirty: load.walApplied })` (Ruling R36), and
 * resolves once boot's effects are in the store — so `decideBoot` then reads
 * the save sync chose. A cloud that does not answer costs at most 3 s.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decideBoot } from '@/save/boot';
import { loadForBoot } from '@/save/bootLoad';
import { createWal } from '@/save/wal';

import {
  ACCT_B,
  DEVICE_ID,
  MemoryStorage,
  WALL,
  cloudReply,
  criticalEntry,
  fakeApi,
  GAME_X,
  head,
  never,
  save,
  syncState,
  testStore,
  timerSchedule,
} from './__fixtures__/sync';
import { runBootSync } from './bootSync';
import { SyncClient } from './SyncClient';

const SYNC_KEY = 'onespace.sync.v1';

function client(o: { api: ReturnType<typeof fakeApi>; ts: ReturnType<typeof testStore>; wal: ReturnType<typeof createWal>; writer?: boolean }): SyncClient {
  const storage = new MemoryStorage();
  storage.setItem(
    SYNC_KEY,
    JSON.stringify(syncState({ accountId: ACCT_B.id, accountName: ACCT_B.name, lastSeenCloud: head(save({ revision: 7 })) })),
  );
  return new SyncClient({
    api: o.api,
    storage,
    isWriter: () => o.writer ?? true,
    schedule: timerSchedule,
    store: o.ts.store,
    wal: o.wal,
    uuid: () => DEVICE_ID,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(WALL);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('runBootSync — before decideBoot', () => {
  it('Given use-cloud (cloud r9, local = L r7), When runBootSync resolves, Then the store already holds the cloud save — and decideBoot then CONTINUES the cloud save', async () => {
    const ts = testStore();
    const wal = createWal(new MemoryStorage() as unknown as Storage);
    await ts.store.save(save({ revision: 7 }));
    const cloud = save({ revision: 9, tank: 4_321 });
    const api = fakeApi({ getSave: () => cloudReply(cloud) });
    const b = await runBootSync({ sync: client({ api, ts, wal }), store: ts.store, wal, writer: true });
    expect(b.decision).toEqual({ kind: 'use-cloud' });
    expect(await ts.current()).toEqual(cloud);
    const d = await decideBoot({
      search: '',
      store: ts.store,
      wal,
      lock: { writer: true, release: () => undefined },
      session: null,
      replaceSearch: () => undefined,
    });
    expect(d.plan.start).toBe('continue');
    expect(d.load.save).toEqual(cloud);
  });

  it('Ruling R36: Given a stored save and a WAL entry of its game, When runBootSync, Then sync.boot gets the local save as the boot loads it (newest valid, WAL merged) and localDirty: true', async () => {
    const ts = testStore();
    const walStorage = new MemoryStorage();
    const wal = createWal(walStorage as unknown as Storage);
    await ts.store.save(save({ revision: 6 }));
    await ts.store.save(save({ revision: 7 }));
    wal.appendCritical(criticalEntry(50, 9), GAME_X);
    const boot = vi.fn(async () => ({ decision: { kind: 'in-sync' as const }, cloud: null, notice: null }));
    await runBootSync({ sync: { boot } as unknown as SyncClient, store: ts.store, wal, writer: true });
    expect(boot).toHaveBeenCalledTimes(1);
    const expected = (await loadForBoot(ts.store, wal)).save;
    expect(expected?.ship.emergencyTimesUsed).toBe(9);
    expect(boot).toHaveBeenCalledWith(expected, { localDirty: true });
  });

  it('Given nothing stored, When runBootSync, Then sync.boot gets null and localDirty: false', async () => {
    const ts = testStore();
    const wal = createWal(new MemoryStorage() as unknown as Storage);
    const boot = vi.fn(async () => ({ decision: { kind: 'guest' as const }, cloud: null, notice: null }));
    await runBootSync({ sync: { boot } as unknown as SyncClient, store: ts.store, wal, writer: true });
    expect(boot).toHaveBeenCalledWith(null, { localDirty: false });
  });

  it('Ruling R36: Given a stored save and an empty WAL, When runBootSync, Then localDirty: false', async () => {
    const ts = testStore();
    const wal = createWal(new MemoryStorage() as unknown as Storage);
    await ts.store.save(save({ revision: 7 }));
    const boot = vi.fn(async () => ({ decision: { kind: 'in-sync' as const }, cloud: null, notice: null }));
    await runBootSync({ sync: { boot } as unknown as SyncClient, store: ts.store, wal, writer: true });
    expect(boot).toHaveBeenCalledWith(save({ revision: 7 }), { localDirty: false });
  });

  it('Ruling R36: Given save r7 = L stored, a paid WAL entry after it and the cloud at r9, When runBootSync, Then conflict-same — the store is untouched and the next load still holds the paid entry', async () => {
    const ts = testStore();
    const wal = createWal(new MemoryStorage() as unknown as Storage);
    await ts.store.save(save({ revision: 7 }));
    wal.appendCritical(criticalEntry(50, 9), GAME_X);
    ts.calls.length = 0;
    const api = fakeApi({ getSave: () => cloudReply(save({ revision: 9 })) });
    const b = await runBootSync({ sync: client({ api, ts, wal }), store: ts.store, wal, writer: true });
    expect(b.decision).toEqual({ kind: 'conflict-same' });
    expect(ts.calls).toEqual([]);
    expect((await loadForBoot(ts.store, wal)).save?.ship.emergencyTimesUsed).toBe(9);
  });

  it('Given the cloud never answers, When runBootSync, Then it resolves at ≈3 s (not before) as local-only/timeout, and the local save is untouched', async () => {
    const ts = testStore();
    const wal = createWal(new MemoryStorage() as unknown as Storage);
    const local = save({ revision: 9 });
    await ts.store.save(local);
    ts.calls.length = 0;
    const api = fakeApi({ me: never, getSave: never });
    let b: { decision: unknown } | null = null;
    void runBootSync({ sync: client({ api, ts, wal }), store: ts.store, wal, writer: true }).then((x) => (b = x));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(b).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(b!.decision).toEqual({ kind: 'local-only', reason: 'timeout' });
    expect(ts.calls).toEqual([]);
    expect(await ts.current()).toEqual(local);
  });

  it('Given a reader tab and an unreadable slot, When runBootSync, Then local-only/reader and nothing is written — not even a copy of the unreadable slot', async () => {
    const ts = testStore();
    const wal = createWal(new MemoryStorage() as unknown as Storage);
    await ts.store.save({ format: 1, junk: true } as never);
    await ts.store.save(save({ revision: 7 }));
    ts.calls.length = 0;
    const api = fakeApi();
    const b = await runBootSync({ sync: client({ api, ts, wal, writer: false }), store: ts.store, wal, writer: false });
    expect(b.decision).toEqual({ kind: 'local-only', reason: 'reader' });
    expect(ts.calls).toEqual([]);
  });
});

describe('registry.ts wires the sync', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../game/registry.ts'), 'utf8');

  it('Given loadBoot, Then runBootSync runs before decideBoot', () => {
    const start = src.indexOf('export async function loadBoot(');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    const sync = body.indexOf('runBootSync(');
    const decide = body.indexOf('decideBoot(');
    expect(sync).toBeGreaterThanOrEqual(0);
    expect(decide).toBeGreaterThan(sync);
  });

  it('Given the registry, Then SaveGame gets onStored wired to the SyncClient', () => {
    const i = src.indexOf('new SaveGame(');
    expect(src.slice(i, src.indexOf(';', i))).toMatch(/onStored/);
  });
});
