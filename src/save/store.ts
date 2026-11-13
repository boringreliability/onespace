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
  /**
   * Keep a save — one that could not be read, or one a NEW GAME replaced —
   * untouched, with the wall time it was found. A raw already on the shelf
   * (structurally equal) is not kept twice.
   */
  keepCorrupt(raw: unknown, wallMs: number): Promise<void>;
}

/**
 * R25 I3: how long a store call may take before it counts as failed. A hung
 * IndexedDB open or transaction must not hang the boot or block the save queue.
 */
export const STORE_TIMEOUT_MS = 3_000;

/**
 * `p`, or a rejection after `ms`. A call that throws synchronously rejects too.
 * The timer is cleared when `p` settles first.
 */
export function withTimeout<T>(call: () => Promise<T>, ms: number = STORE_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`store call timed out after ${ms} ms`)), ms);
    let p: Promise<T>;
    try {
      p = call();
    } catch (e) {
      clearTimeout(timer);
      reject(e);
      return;
    }
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** A key-order-independent fingerprint of a raw value; null when it has none (not JSON). */
export function rawKey(raw: unknown): string | null {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return Object.keys(o)
        .sort()
        .map((k) => [k, norm(o[k])]);
    }
    return v;
  };
  try {
    return JSON.stringify(norm(raw)) ?? null;
  } catch {
    return null;
  }
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
