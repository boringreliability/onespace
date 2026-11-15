/**
 * Shared fakes for the client-sync tests (v4 sub-plan 4, Task 5).
 *
 *  - `save(o)`: a valid SaveV1 built from the golden v1 save;
 *  - `MemoryStorage` / `ThrowingStorage`: localStorage stand-ins;
 *  - `testStore()`: a memoryStore-backed SaveStore whose slots `clearLocal()`
 *    can empty (the SaveStore seam has no clear — see the Task 5 report),
 *    with every call recorded;
 *  - `fakeApi()`: the `Api` with scripted replies and every call recorded;
 *  - `timerSchedule`: the `schedule` dep on (fake) setTimeout.
 */

import golden from '@/save/fixtures/v1-golden.json';
import { memoryStore } from '@/save/memoryStore';
import type { ActionEntry, SaveV1 } from '@/save/schema';
import type { SaveStore } from '@/save/store';

import type { Api, ApiResult, PutBody, ResolveBody } from '../api';
import type { SyncState } from '../syncState';

/** The golden save's game. */
export const GAME_X = '3f9c2b1e-7a4d-4e8b-9c61-2d5f0a8e7b14';
/** Another game. */
export const GAME_Y = '11111111-2222-4333-8444-555555555555';
export const DEVICE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const DEVICE_ID_2 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
export const ACCT_A = { id: 'a1a1a1a1-0000-4000-8000-000000000001', name: 'Ava' } as const;
export const ACCT_B = { id: 'b2b2b2b2-0000-4000-8000-000000000002', name: 'Bo' } as const;
export const WALL = 1_800_000_000_000;

export interface SaveOver {
  saveId?: string;
  revision?: number;
  wallMs?: number;
  emergency?: number;
  tank?: number;
}

/** A valid SaveV1 (the golden one, actions seq 1–12), with the fields a test names set. */
export function save(o: SaveOver = {}): SaveV1 {
  const s = structuredClone(golden) as unknown as SaveV1;
  s.saveId = o.saveId ?? GAME_X;
  s.revision = o.revision ?? 7;
  if (o.wallMs !== undefined) s.savedAt.wallMs = o.wallMs;
  if (o.emergency !== undefined) s.ship.emergencyTimesUsed = o.emergency;
  if (o.tank !== undefined) s.ship.propellant.massKg = o.tank;
  return s;
}

/** `{saveId, revision}` of a save. */
export const head = (s: SaveV1): { saveId: string; revision: number } => ({ saveId: s.saveId, revision: s.revision });

/** A critical WAL entry above the golden save's coverage (seq 12): an emergency cannibalize. */
export function criticalEntry(seq: number, timesUsed: number): ActionEntry {
  return {
    seq,
    source: 'emergency',
    payload: { kind: 'cannibalize', timesUsed },
    wallMs: WALL + seq,
    orbitSeconds: 6_000 + seq,
  } as ActionEntry;
}

export function syncState(o: Partial<SyncState> = {}): SyncState {
  return { deviceId: DEVICE_ID, accountId: null, accountName: null, lastSeenCloud: null, conflict: false, ...o };
}

/** A localStorage that behaves like the real one. */
export class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

/** Private mode: every call throws. */
export class ThrowingStorage {
  getItem(_k: string): string | null {
    throw new DOMException('denied', 'SecurityError');
  }
  setItem(_k: string, _v: string): void {
    throw new DOMException('denied', 'SecurityError');
  }
  removeItem(_k: string): void {
    throw new DOMException('denied', 'SecurityError');
  }
}

export interface TestStore {
  store: SaveStore;
  /** Every store call, in order: `save:<saveId>:<rev>`, `keep:<saveId|?>:<rev|?>`, `clear`. */
  calls: string[];
  /** What keepCorrupt shelved. */
  readonly shelf: ReadonlyArray<{ wallMs: number; raw: unknown }>;
  /** The injected `clearLocal` dep: both slots emptied, the shelf kept. */
  clearLocal(): Promise<void>;
  /** The current slot, as stored. */
  current(): Promise<SaveV1 | null>;
}

const tag = (raw: unknown): string => {
  const r = raw as { saveId?: unknown; revision?: unknown } | null;
  return `${typeof r?.saveId === 'string' ? r.saveId : '?'}:${typeof r?.revision === 'number' ? r.revision : '?'}`;
};

export function testStore(): TestStore {
  let slots = memoryStore();
  const shelfStore = memoryStore();
  const calls: string[] = [];
  const store: SaveStore = {
    load: () => slots.load(),
    async save(s) {
      calls.push(`save:${tag(s)}`);
      await slots.save(s);
    },
    async keepCorrupt(raw, wallMs) {
      calls.push(`keep:${tag(raw)}`);
      await shelfStore.keepCorrupt(raw, wallMs);
    },
  };
  return {
    store,
    calls,
    get shelf() {
      return shelfStore.corrupt;
    },
    async clearLocal() {
      calls.push('clear');
      slots = memoryStore();
    },
    async current() {
      return ((await slots.load()).current as SaveV1 | null) ?? null;
    },
  };
}

type Reply = ApiResult | Promise<ApiResult>;

export interface FakeApi extends Api {
  /** Method names in call order. */
  calls: string[];
  puts: PutBody[];
  /** Date.now() at each putSave call. */
  putTimes: number[];
  resolves: ResolveBody[];
  /** Scripted replies; each may return a promise that never settles. */
  reply: {
    me: () => Reply;
    getSave: () => Reply;
    putSave: (b: PutBody) => Reply;
    resolve: (b: ResolveBody) => Reply;
    logout: () => Reply;
    deleteAccount: () => Reply;
  };
}

export const ok = (status: number, body: unknown): ApiResult => ({ ok: true, status, body }) as ApiResult;
export const fail = (status: number | 'offline' | 'timeout', extra: Record<string, unknown> = {}): ApiResult =>
  ({ ok: false, status, ...extra }) as ApiResult;
export const never = (): Promise<ApiResult> => new Promise<ApiResult>(() => undefined);
/** The cloud as GET /api/save returns it. */
export const cloudReply = (s: SaveV1 | Record<string, unknown>): ApiResult =>
  ok(200, { revision: (s as { revision?: number }).revision, save: s });
export const noSave = (): ApiResult => fail(404, { body: { error: 'no-save' } });

/**
 * Defaults: signed in as B, empty cloud (404 no-save), PUT accepted (its
 * revision echoed), logout 204.
 */
export function fakeApi(over: Partial<FakeApi['reply']> = {}): FakeApi {
  const api: FakeApi = {
    calls: [],
    puts: [],
    putTimes: [],
    resolves: [],
    reply: {
      me: () => ok(200, { ...ACCT_B }),
      getSave: () => noSave(),
      putSave: (b) => ok(200, { revision: (b.save as SaveV1).revision }),
      resolve: () => fail(500),
      logout: () => ok(204, null),
      deleteAccount: () => ok(204, null),
      ...over,
    },
    async me() {
      api.calls.push('me');
      return api.reply.me();
    },
    async getSave() {
      api.calls.push('getSave');
      return api.reply.getSave();
    },
    async putSave(b) {
      api.calls.push('putSave');
      api.puts.push(b);
      api.putTimes.push(Date.now());
      return api.reply.putSave(b);
    },
    async resolve(b) {
      api.calls.push('resolve');
      api.resolves.push(b);
      return api.reply.resolve(b);
    },
    async logout() {
      api.calls.push('logout');
      return api.reply.logout();
    },
    async deleteAccount() {
      api.calls.push('deleteAccount');
      return api.reply.deleteAccount();
    },
  } as FakeApi;
  return api;
}

/** The `schedule` dep on (fake) setTimeout; returns its cancel. */
export function timerSchedule(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/** A deferred reply the test settles. */
export function deferred(): { promise: Promise<ApiResult>; settle(r: ApiResult): void } {
  let settle!: (r: ApiResult) => void;
  const promise = new Promise<ApiResult>((r) => {
    settle = r;
  });
  return { promise, settle };
}
