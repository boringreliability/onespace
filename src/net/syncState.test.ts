/**
 * v4 sub-plan 4, Task 5 (phase A) — the local sync state (R32).
 *
 * Pinned surface (src/net/syncState.ts):
 *
 *   SYNC_STATE_KEY === 'onespace.sync.v1'
 *   interface SyncState {
 *     deviceId: string;                                  // a uuid, generated once
 *     accountId: string | null;                          // the account the local save is bound to
 *     accountName: string | null;                        // its name (for the refuse-switch text)
 *     lastSeenCloud: { saveId: string; revision: number } | null;   // L
 *     conflict: boolean;
 *   }
 *   type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
 *   readSyncState(storage: StorageLike | null, uuid: () => string): SyncState
 *   writeSyncState(storage: StorageLike | null, s: SyncState): boolean
 *
 * Zod-validated. Invalid JSON or shape → reset to
 * { deviceId: kept if it was a valid uuid, else new; accountId: null;
 *   accountName: null; lastSeenCloud: null; conflict: false }.
 * A generated deviceId is written back, so it is generated once.
 * Storage that throws (private mode) never crashes: read gives a fresh
 * state, write gives false.
 */

import { describe, expect, it, vi } from 'vitest';

import { ACCT_A, DEVICE_ID, DEVICE_ID_2, GAME_X, MemoryStorage, ThrowingStorage, syncState } from './__fixtures__/sync';
import { SYNC_STATE_KEY, readSyncState, writeSyncState } from './syncState';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FRESH = { accountId: null, accountName: null, lastSeenCloud: null, conflict: false };

function stored(storage: MemoryStorage, value: unknown): void {
  storage.setItem(SYNC_STATE_KEY, typeof value === 'string' ? value : JSON.stringify(value));
}

describe('syncState — the key and a round trip', () => {
  it("Given the module, Then the key is 'onespace.sync.v1'", () => {
    expect(SYNC_STATE_KEY).toBe('onespace.sync.v1');
  });

  it('Given a full state written, When it is read back, Then it is the same state, under onespace.sync.v1', () => {
    const storage = new MemoryStorage();
    const s = syncState({
      accountId: ACCT_A.id,
      accountName: ACCT_A.name,
      lastSeenCloud: { saveId: GAME_X, revision: 7 },
      conflict: true,
    });
    expect(writeSyncState(storage, s)).toBe(true);
    expect(storage.map.has('onespace.sync.v1')).toBe(true);
    const uuid = vi.fn(() => DEVICE_ID_2);
    expect(readSyncState(storage, uuid)).toEqual(s);
    expect(uuid).not.toHaveBeenCalled();
  });
});

describe('syncState — a fresh device', () => {
  it('Given nothing stored, When read, Then a fresh state with a deviceId from the injected uuid', () => {
    const storage = new MemoryStorage();
    expect(readSyncState(storage, () => DEVICE_ID)).toEqual({ deviceId: DEVICE_ID, ...FRESH });
  });

  it('Given nothing stored, When read twice with different uuid functions, Then the deviceId is the first one (generated once, written back)', () => {
    const storage = new MemoryStorage();
    const first = readSyncState(storage, () => DEVICE_ID);
    const uuid2 = vi.fn(() => DEVICE_ID_2);
    const second = readSyncState(storage, uuid2);
    expect(first.deviceId).toBe(DEVICE_ID);
    expect(second.deviceId).toBe(DEVICE_ID);
    expect(uuid2).not.toHaveBeenCalled();
  });

  it('Given the default uuid source (crypto.randomUUID) is used by the caller, Then the deviceId is a uuid', () => {
    const s = readSyncState(new MemoryStorage(), () => crypto.randomUUID());
    expect(s.deviceId).toMatch(UUID_RE);
  });
});

describe('syncState — invalid stored state is reset (R32)', () => {
  it('Given invalid JSON under the key, When read, Then it is reset to a fresh state with a new deviceId (nothing readable to keep), and written back', () => {
    const storage = new MemoryStorage();
    stored(storage, '{not json');
    const s = readSyncState(storage, () => DEVICE_ID_2);
    expect(s).toEqual({ deviceId: DEVICE_ID_2, ...FRESH });
    expect(JSON.parse(storage.getItem(SYNC_STATE_KEY)!)).toEqual(s);
  });

  it.each<[string, Record<string, unknown>]>([
    ['accountId is a number', { accountId: 5 }],
    ['conflict is a string', { conflict: 'yes' }],
    ['lastSeenCloud has no revision', { lastSeenCloud: { saveId: GAME_X } }],
    ['lastSeenCloud has a negative revision', { lastSeenCloud: { saveId: GAME_X, revision: -1 } }],
    ['lastSeenCloud has a fractional revision', { lastSeenCloud: { saveId: GAME_X, revision: 1.5 } }],
    ['lastSeenCloud.saveId is not a uuid', { lastSeenCloud: { saveId: 'x', revision: 3 } }],
    ['accountName is missing', { accountName: undefined }],
  ])('Given a valid deviceId but %s, When read, Then the state is reset and the deviceId is KEPT', (_what, over) => {
    const storage = new MemoryStorage();
    stored(storage, {
      deviceId: DEVICE_ID,
      accountId: ACCT_A.id,
      accountName: ACCT_A.name,
      lastSeenCloud: { saveId: GAME_X, revision: 7 },
      conflict: false,
      ...over,
    });
    const uuid = vi.fn(() => DEVICE_ID_2);
    expect(readSyncState(storage, uuid)).toEqual({ deviceId: DEVICE_ID, ...FRESH });
    expect(uuid).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ['a deviceId that is not a uuid', { ...syncState(), deviceId: 'device-1' }],
    ['no deviceId', { accountId: null, accountName: null, lastSeenCloud: null, conflict: false }],
    ['an array', [1, 2, 3]],
    ['null', null],
    ['a number', 42],
  ])('Given %s stored, When read, Then a fresh state with a NEW deviceId', (_what, value) => {
    const storage = new MemoryStorage();
    stored(storage, value);
    expect(readSyncState(storage, () => DEVICE_ID_2)).toEqual({ deviceId: DEVICE_ID_2, ...FRESH });
  });

  it('Given a reset, When read again, Then the reset state is what is read (the reset was written back)', () => {
    const storage = new MemoryStorage();
    stored(storage, { deviceId: DEVICE_ID, accountId: 5 });
    readSyncState(storage, () => DEVICE_ID_2);
    expect(readSyncState(storage, () => 'unused')).toEqual({ deviceId: DEVICE_ID, ...FRESH });
  });
});

describe('syncState — storage that throws (private mode)', () => {
  it('Given storage that throws on every call, When read, Then a fresh in-memory state with a new deviceId and no crash', () => {
    expect(readSyncState(new ThrowingStorage(), () => DEVICE_ID)).toEqual({ deviceId: DEVICE_ID, ...FRESH });
  });

  it('Given storage that throws, When written, Then false and no crash', () => {
    expect(writeSyncState(new ThrowingStorage(), syncState())).toBe(false);
  });

  it('Given no storage at all (null), Then read gives a fresh state and write gives false', () => {
    expect(readSyncState(null, () => DEVICE_ID)).toEqual({ deviceId: DEVICE_ID, ...FRESH });
    expect(writeSyncState(null, syncState())).toBe(false);
  });
});
