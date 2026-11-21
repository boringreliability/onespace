/**
 * The boot glue (v4 sub-plan 4, Task 5): sync runs before `decideBoot`.
 *
 * The local save is read the way the boot reads it (newest valid, WAL
 * merged) and handed to `sync.boot`, with whether WAL entries were merged on
 * top (R36: paid progress the cloud has never seen). When this resolves,
 * boot's effects are in the store, so `decideBoot` reads the save sync
 * chose. A cloud that does not answer costs at most SYNC_TIMEOUT_MS — except
 * (R83) with a pending resolve to replay: then me() (within SYNC_TIMEOUT_MS),
 * the replay (SYNC_WRITE_TIMEOUT_MS) and the getSave after it
 * (SYNC_TIMEOUT_MS) can cost up to about 36 s.
 */

import { loadForBootResult } from '@/save/bootLoad';
import type { Save } from '@/save/schema';
import type { SaveStore } from '@/save/store';
import type { Wal } from '@/save/wal';

import type { BootSync, SyncClient } from './SyncClient';

export interface BootSyncDeps {
  readonly sync: Pick<SyncClient, 'boot'>;
  readonly store: SaveStore;
  readonly wal: Wal;
  /** The writer lock's verdict: a reader never writes (not even a shelf copy). */
  readonly writer: boolean;
}

/** The boot's sync result, with the local save it was given (the conflict screen's THIS DEVICE card). */
export interface BootSyncResult extends BootSync {
  readonly local: Save | null;
}

export async function runBootSync(d: BootSyncDeps): Promise<BootSyncResult> {
  const { load, storeAvailable } = await loadForBootResult(d.store, d.wal, { writer: d.writer });
  // R25 I2: a store that failed at boot is never written this session, and the
  // WAL may be the only copy of the game — sync must not replace or reset it.
  if (!storeAvailable) return { decision: { kind: 'local-only', reason: 'offline' }, cloud: null, notice: null, local: null };
  const local = load.save;
  const b = await d.sync.boot(local, { localDirty: load.walApplied === true });
  return { ...b, local };
}
