/**
 * The save store (v4 sub-plan 3, Task 4; DESIGN §5.2 "offline først").
 *
 * `SaveStore` is the seam: today IndexedDB (`idbStore`) and memory
 * (`memoryStore`); later a cloud/multiplayer store behind the same promises.
 *
 * A store keeps two slots — current and previous (the old current) — and a
 * shelf of corrupt saves. `load` hands back what is stored as `unknown`: a
 * store never trusts its own bytes; `migrate` is the only door in.
 */

import type { SaveV1 } from './schema';

export interface SaveStore {
  /** The two slots as stored, unvalidated; null where a slot is empty. */
  load(): Promise<{ current: unknown | null; previous: unknown | null }>;
  /** Write `s` as current; the old current becomes previous. Rejects on failure, changing nothing. */
  save(s: SaveV1): Promise<void>;
  /** Keep a save that could not be read, untouched, with the wall time it was found. */
  keepCorrupt(raw: unknown, wallMs: number): Promise<void>;
}

/**
 * The newer of two saves: the higher revision; on equal revisions the later
 * `savedAt.wallMs`; on a full tie the first argument. Returns one of its
 * arguments, never a copy.
 */
export function newestOf(a: SaveV1 | null, b: SaveV1 | null): SaveV1 | null {
  if (a === null) return b;
  if (b === null) return a;
  if (a.revision !== b.revision) return a.revision > b.revision ? a : b;
  return b.savedAt.wallMs > a.savedAt.wallMs ? b : a;
}
