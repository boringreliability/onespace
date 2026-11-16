/**
 * What a boot does with the local save and the cloud's (v4 sub-plan 4,
 * Task 5; rulings R29, R36, R37; DESIGN-4 §5.2–5.4). Pure.
 *
 * L = state.lastSeenCloud, the cloud head this device last saw. Only L says
 * "in sync": two devices that both went r5 → r6 have equal revisions and a
 * conflict.
 *
 *  - Not signed in → guest.
 *  - Bound to another account A: A's unsynced progress (or paid WAL entries,
 *    `localDirty`) refuses the switch; a synced save switches accounts.
 *  - A guest save / fresh device: adopt into an empty cloud, use the cloud
 *    when there is no local save, otherwise in-sync only for the same game at
 *    the same revision with nothing paid on top (R36).
 *  - Bound to me: local ahead of L, cloud ahead of L, or both (a conflict).
 *    R37: a cloud that moved on the SAME game but is not strictly newer than
 *    local is a conflict, never a silent step back.
 */

import { sameGame } from '@/save/conflict';
import type { SaveV1 } from '@/save/schema';

import type { SyncState } from './syncState';

export type Decision =
  | { kind: 'guest' }
  | { kind: 'in-sync' }
  | { kind: 'use-cloud' }
  | { kind: 'push-local' }
  | { kind: 'adopt' }
  | { kind: 'conflict-same' }
  | { kind: 'conflict-different' }
  | { kind: 'refuse-switch'; message: string }
  | { kind: 'switch-account' };

export interface ReconcileInput {
  local: SaveV1 | null;
  cloud: SaveV1 | null;
  state: SyncState;
  me: { id: string; name: string } | null;
  /** R36: the boot load applied WAL critical entries on top of the stored snapshot. */
  localDirty: boolean;
}

export function unsyncedProgressText(name: string): string {
  return `UNSYNCED PROGRESS FOR ${name} — SIGN IN AS ${name} ONCE ONLINE TO SYNC`;
}

const conflict = (a: SaveV1, b: SaveV1): Decision => ({ kind: sameGame(a, b) ? 'conflict-same' : 'conflict-different' });

export function reconcile(input: ReconcileInput): Decision {
  const { local, cloud, state, me, localDirty } = input;
  if (me === null) return { kind: 'guest' };
  const L = state.lastSeenCloud;
  const dirty = local !== null && localDirty;
  const localAhead =
    local !== null && (L === null || local.saveId !== L.saveId || local.revision > L.revision || dirty);

  if (state.accountId !== null && state.accountId !== me.id) {
    if (localAhead) return { kind: 'refuse-switch', message: unsyncedProgressText(state.accountName ?? state.accountId) };
    return { kind: 'switch-account' };
  }

  if (state.accountId === null) {
    if (local === null) return { kind: cloud === null ? 'in-sync' : 'use-cloud' };
    if (cloud === null) return { kind: 'adopt' };
    if (!sameGame(local, cloud)) return { kind: 'conflict-different' };
    return { kind: local.revision === cloud.revision && !dirty ? 'in-sync' : 'conflict-same' };
  }

  // Bound to me. A local save and an empty cloud: the cloud needs it.
  if (cloud === null) return { kind: local === null ? 'in-sync' : 'push-local' };
  const cloudAhead = cloud !== null && (L === null || cloud.saveId !== L.saveId || cloud.revision !== L.revision);
  if (!localAhead && !cloudAhead) return { kind: 'in-sync' };
  if (localAhead && !cloudAhead) return { kind: 'push-local' };
  if (!localAhead) {
    // Only the cloud moved. R37: the same game, not strictly newer → never go back silently.
    if (local !== null && sameGame(local, cloud!) && cloud!.revision <= local.revision) return { kind: 'conflict-same' };
    return { kind: 'use-cloud' };
  }
  return conflict(local!, cloud!);
}
