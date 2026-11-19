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

  it('Ruling R42: Given the store cannot be opened at boot (the WAL may be the only copy), When runBootSync, Then local-only/offline and sync.boot is NOT called', async () => {
    const ts = testStore();
    const wal = createWal(new MemoryStorage() as unknown as Storage);
    wal.writeSnapshot(save({ revision: 7 }));
    const store = { ...ts.store, load: () => Promise.reject(new DOMException('blocked', 'VersionError')) };
    const boot = vi.fn(async () => ({ decision: { kind: 'use-cloud' as const }, cloud: null, notice: null }));
    const b = await runBootSync({ sync: { boot } as unknown as SyncClient, store, wal, writer: true });
    expect(b.decision).toEqual({ kind: 'local-only', reason: 'offline' });
    expect(boot).not.toHaveBeenCalled();
    expect(ts.calls).toEqual([]);
    expect(wal.read().snapshot).not.toBeNull();
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

// =============================================================================
//  v4 sub-plan 4, Task 6 (phase A) — the conflict screen needs the local card.
//
//  runBootSync's result also carries `local: SaveV1 | null` — the save it
//  handed to sync.boot (newest valid, WAL merged); null when the store failed
//  at boot (sync.boot not called). The registry gives it to
//  settleBootConflict (src/ui/conflictScreen.ts) for the THIS DEVICE card.
// =============================================================================

describe('runBootSync — the local save for the conflict screen (Task 6)', () => {
  it('Given a WAL-merged local save in conflict with the cloud, When runBootSync, Then the result carries local = the save sync.boot got', async () => {
    const ts = testStore();
    const wal = createWal(new MemoryStorage() as unknown as Storage);
    await ts.store.save(save({ revision: 7 }));
    wal.appendCritical(criticalEntry(50, 9), GAME_X);
    const api = fakeApi({ getSave: () => cloudReply(save({ revision: 9 })) });
    const b = await runBootSync({ sync: client({ api, ts, wal }), store: ts.store, wal, writer: true });
    expect(b.decision).toEqual({ kind: 'conflict-same' });
    expect(b.local).toEqual((await loadForBoot(ts.store, wal)).save);
    expect(b.local?.ship.emergencyTimesUsed).toBe(9);
  });

  it('Given nothing stored, When runBootSync, Then local is null', async () => {
    const ts = testStore();
    const wal = createWal(new MemoryStorage() as unknown as Storage);
    const boot = vi.fn(async () => ({ decision: { kind: 'guest' as const }, cloud: null, notice: null }));
    const b = await runBootSync({ sync: { boot } as unknown as SyncClient, store: ts.store, wal, writer: true });
    expect(b.local).toBeNull();
  });

  it('Given the store cannot be opened at boot, When runBootSync, Then local is null (sync.boot was not called)', async () => {
    const ts = testStore();
    const wal = createWal(new MemoryStorage() as unknown as Storage);
    const store = { ...ts.store, load: () => Promise.reject(new DOMException('blocked', 'VersionError')) };
    const b = await runBootSync({ sync: { boot: vi.fn() } as unknown as SyncClient, store, wal, writer: true });
    expect(b.local).toBeNull();
  });
});

describe('registry.ts wires sign-in, the account and the conflict screen (Task 6)', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(dir, '../game/registry.ts'), 'utf8');
  const loadBootBody = (): string => {
    const start = src.indexOf('export async function loadBoot(');
    expect(start).toBeGreaterThanOrEqual(0);
    return src.slice(start, src.indexOf('\n}\n', start));
  };

  it('R49: Given loadBoot, Then the conflict is settled after runBootSync and before decideBoot — the screen appears only at boot, before the game continues', () => {
    const body = loadBootBody();
    const sync = body.indexOf('runBootSync(');
    const settle = body.indexOf('settleBootConflict(');
    const decide = body.indexOf('decideBoot(');
    expect(sync).toBeGreaterThanOrEqual(0);
    expect(settle).toBeGreaterThan(sync);
    expect(decide).toBeGreaterThan(settle);
  });

  it('R49: Given the sources, Then settleBootConflict is called from registry.ts loadBoot only — never mid-session', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const root = join(dir, '..');
    const callers: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n) && readFileSync(p, 'utf8').includes('settleBootConflict(')) callers.push(p);
      }
    };
    walk(root);
    const nonDefining = callers.filter((p) => !p.endsWith(join('ui', 'conflictScreen.ts')));
    expect(nonDefining.map((p) => p.slice(root.length + 1))).toEqual([join('game', 'registry.ts')]);
  });

  it('R55: Given loadBoot, Then the conflict screen gets a body-name resolver (bodyName), so a card names the body rather than its id', () => {
    const body = loadBootBody();
    const i = body.indexOf('settleBootConflict(');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(body.slice(i, body.indexOf(');', i))).toMatch(/bodyName/);
  });

  it('R49: Given loadBoot, Then the status line is read after the conflict is settled (a resolved conflict is not reported as one)', () => {
    const body = loadBootBody();
    const settle = body.indexOf('settleBootConflict(');
    expect(settle).toBeGreaterThanOrEqual(0);
    expect(body.lastIndexOf('statusText()')).toBeGreaterThan(settle);
  });

  it('R50: Given loadBoot, Then the auth return (?auth=…) is read and cleaned before decideBoot reads the search', () => {
    const body = loadBootBody();
    const auth = body.indexOf('authReturn(');
    expect(auth).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('decideBoot(')).toBeGreaterThan(auth);
  });

  it('R51: Given the registry, Then the title and the pause get the account (accountView from the writer lock and the identity confirmed this session)', () => {
    expect(src).toMatch(/accountView\(/);
    expect(src).toMatch(/identity\(\)/);
    const t = src.indexOf('new Title(');
    expect(src.slice(t, src.indexOf(';', t))).toMatch(/account/);
    const p = src.indexOf('new Pause(');
    expect(src.slice(p, src.indexOf(';', p))).toMatch(/account/);
    expect(src.slice(p, src.indexOf(';', p))).toMatch(/sync/);
  });
});
