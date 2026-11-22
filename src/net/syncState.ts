/**
 * The device's sync state (v4 sub-plan 4, Task 5; R32), in localStorage
 * under `onespace.sync.v1`, next to the local save:
 *
 *  - `deviceId` — this device, generated once (a uuid);
 *  - `accountId` / `accountName` — the account the local save is bound to
 *    (null for a guest save);
 *  - `lastSeenCloud` (L) — the cloud head this device last saw;
 *  - `conflict` — a PUT met a moved cloud: choose on the next start;
 *  - `inFlightPut` (R68b, optional) — the PUT sent but not yet acknowledged:
 *    a cloud head with the same saveId, revision AND fingerprint is this
 *    device's own save (a tab that died mid-PUT is not a conflict);
 *  - `pendingResolve` / `pendingResolveFor` (R69, optional) — the exact
 *    resolve body sent but not answered, and the account it was sent for:
 *    replayed verbatim, never decided again;
 *  - `unmergedCloud` (R75/R79, optional) — a replayed resolve result that
 *    was not applied because the local save had advanced: still a choice.
 *
 * An old state without the optional fields still parses.
 *
 * Read through Zod; anything invalid resets to a fresh state (keeping a
 * valid deviceId when one can be read) and is written back, so a generated
 * deviceId is generated once. Storage that throws (private mode) never
 * crashes: read gives a fresh state, write gives false.
 */

import * as z from 'zod';

import type { Save } from '@/save/schema';

import type { ResolveBody } from './api';

export const SYNC_STATE_KEY = 'onespace.sync.v1';

export interface CloudHead {
  saveId: string;
  revision: number;
}

export interface InFlightPut {
  saveId: string;
  revision: number;
  /** A cheap deterministic hash of the save's content key (rawKey). */
  fingerprint: string;
}

export interface SyncState {
  deviceId: string;
  accountId: string | null;
  accountName: string | null;
  lastSeenCloud: CloudHead | null;
  conflict: boolean;
  /** R68(b): cleared = absent or null. */
  inFlightPut?: InFlightPut | null;
  /** R69: the resolve body as sent, verbatim. */
  pendingResolve?: ResolveBody | null;
  /** R69: the account id pendingResolve was sent as (never replayed for another). */
  pendingResolveFor?: string | null;
  /** R79: a resolve result head not merged into the local save. */
  unmergedCloud?: CloudHead | null;
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const CloudHeadSchema = z.strictObject({ saveId: z.uuid(), revision: z.number().int().min(0) });

const InFlightPutSchema = z.strictObject({
  saveId: z.uuid(),
  revision: z.number().int().min(0),
  fingerprint: z.string().min(1),
});

/** The device save inside a pending resolve: kept verbatim (the server validates it when replayed). */
const PendingDeviceSchema = z.custom<Save>((v) => {
  const o = v as { saveId?: unknown; revision?: unknown } | null;
  return typeof o === 'object' && o !== null && !Array.isArray(o) && typeof o.saveId === 'string' && typeof o.revision === 'number';
});

const PendingResolveSchema = z.strictObject({
  deviceId: z.uuid(),
  keep: z.enum(['device', 'cloud']),
  device: PendingDeviceSchema,
  base: CloudHeadSchema.nullable(),
  cloud: CloudHeadSchema.nullable(),
});

const SyncStateSchema = z.strictObject({
  deviceId: z.uuid(),
  accountId: z.string().min(1).nullable(),
  accountName: z.string().nullable(),
  lastSeenCloud: CloudHeadSchema.nullable(),
  conflict: z.boolean(),
  inFlightPut: InFlightPutSchema.nullish(),
  pendingResolve: PendingResolveSchema.nullish(),
  pendingResolveFor: z.string().min(1).nullish(),
  unmergedCloud: CloudHeadSchema.nullish(),
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
