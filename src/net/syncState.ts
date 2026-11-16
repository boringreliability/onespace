/**
 * The device's sync state (v4 sub-plan 4, Task 5; R32), in localStorage
 * under `onespace.sync.v1`, next to the local save:
 *
 *  - `deviceId` — this device, generated once (a uuid);
 *  - `accountId` / `accountName` — the account the local save is bound to
 *    (null for a guest save);
 *  - `lastSeenCloud` (L) — the cloud head this device last saw;
 *  - `conflict` — a PUT met a moved cloud: choose on the next start.
 *
 * Read through Zod; anything invalid resets to a fresh state (keeping a
 * valid deviceId when one can be read) and is written back, so a generated
 * deviceId is generated once. Storage that throws (private mode) never
 * crashes: read gives a fresh state, write gives false.
 */

import * as z from 'zod';

export const SYNC_STATE_KEY = 'onespace.sync.v1';

export interface CloudHead {
  saveId: string;
  revision: number;
}

export interface SyncState {
  deviceId: string;
  accountId: string | null;
  accountName: string | null;
  lastSeenCloud: CloudHead | null;
  conflict: boolean;
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const CloudHeadSchema = z.strictObject({ saveId: z.uuid(), revision: z.number().int().min(0) });

const SyncStateSchema = z.strictObject({
  deviceId: z.uuid(),
  accountId: z.string().min(1).nullable(),
  accountName: z.string().nullable(),
  lastSeenCloud: CloudHeadSchema.nullable(),
  conflict: z.boolean(),
});

function fresh(deviceId: string): SyncState {
  return { deviceId, accountId: null, accountName: null, lastSeenCloud: null, conflict: false };
}

export function readSyncState(storage: StorageLike | null, uuid: () => string): SyncState {
  let text: string | null = null;
  try {
    text = storage ? storage.getItem(SYNC_STATE_KEY) : null;
  } catch {
    return fresh(uuid());
  }
  let raw: unknown = undefined;
  if (text !== null) {
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
  }
  const parsed = SyncStateSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const kept = z.uuid().safeParse((raw as { deviceId?: unknown } | null | undefined)?.deviceId);
  const s = fresh(kept.success && raw && typeof raw === 'object' && !Array.isArray(raw) ? kept.data : uuid());
  writeSyncState(storage, s);
  return s;
}

export function writeSyncState(storage: StorageLike | null, s: SyncState): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SYNC_STATE_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}
