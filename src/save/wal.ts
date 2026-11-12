/**
 * The write-ahead log (v4 sub-plan 3, Task 4; DESIGN §5.2, rulings R2, R11, R12).
 *
 * IndexedDB is asynchronous; a paying action (the emergency exit above all)
 * must be on disk BEFORE its effect shows. The WAL is the synchronous half,
 * in localStorage under two keys:
 *
 *  - `onespace.wal.v1` — the critical entries: `{ v: 1, critical: [{ e, by }] }`;
 *  - `onespace.wal.v1.snapshot` — the one snapshot, a SaveV1 as JSON. Kept apart
 *    so an append re-serialises only the entries, never the save (M2).
 *
 * Coverage (R11/I1): `by` is the revision of the save that CONTAINS the entry,
 * decided when `writeSnapshot(save)` runs — an untagged entry is tagged when
 * its seq ≤ the highest seq in `save.actions` (a checkpoint counts with its
 * `upToSeq`). Call order means nothing: an entry paid between the capture and
 * the WAL write keeps `by: null`. `clear(N)` drops entries with `by ≤ N` and
 * the snapshot if its revision ≤ N; an untagged entry is never cleared.
 *
 * `writeSnapshot` refuses (false) a save strictly older than the stored
 * snapshot; an equal revision (a retry) is accepted. It writes the snapshot
 * FIRST and the tags second: if the second write fails the entries stay
 * untagged — kept, never lost — and it returns false.
 *
 * Growth: the entries key holds what was appended since the last `clear`;
 * the snapshot key holds one save. Save → IndexedDB → `clear` keeps both small.
 *
 * Nothing here throws: a full or missing storage gives `false`. Foreign bytes
 * under the entries key read as empty, are not erased by reading, and the
 * next write replaces them. `appendCritical` refuses an entry that fails
 * `ActionEntrySchema` (M4). `read` trusts nothing: each entry is checked again
 * and dropped alone if it fails; an item that is not even an object is
 * dropped on load and so disappears at the next write (M3); the snapshot goes
 * through `migrate`.
 */

import { migrate } from './migrate';
import { ActionEntrySchema, type ActionEntry, type SaveV1 } from './schema';

export const WAL_KEY = 'onespace.wal.v1';
export const WAL_SNAPSHOT_KEY = 'onespace.wal.v1.snapshot';

interface Envelope {
  v: 1;
  critical: Array<{ e: unknown; by: number | null }>;
}

export interface Wal {
  /** Synchronously record a resource-critical action. False if invalid or not written. */
  appendCritical(entry: ActionEntry): boolean;
  /** Synchronously keep `s` as THE snapshot; it covers the entries its action log holds. */
  writeSnapshot(s: SaveV1): boolean;
  /** What is stored, validated; foreign bytes read as empty. */
  read(): { snapshot: unknown | null; critical: ActionEntry[] };
  /** Drop what a durable save of revision ≤ `upToRevision` already holds. */
  clear(upToRevision: number): void;
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function getText(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function parse(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The stored entries, or null for foreign bytes / nothing stored / unreadable storage. */
function loadEntries(storage: Storage): Envelope | null {
  const raw = parse(getText(storage, WAL_KEY));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || !Array.isArray(o.critical)) return null;
  const critical: Envelope['critical'] = [];
  for (const item of o.critical) {
    if (!item || typeof item !== 'object') continue; // M3: gone at the next write
    const it = item as Record<string, unknown>;
    critical.push({ e: it.e, by: isNum(it.by) ? it.by : null });
  }
  return { v: 1, critical };
}

function storeEntries(storage: Storage, env: Envelope): boolean {
  try {
    if (env.critical.length === 0) storage.removeItem(WAL_KEY);
    else storage.setItem(WAL_KEY, JSON.stringify(env));
    return true;
  } catch {
    return false;
  }
}

/** The stored snapshot, parsed but unvalidated; undefined when there is none. */
function loadSnapshot(storage: Storage): unknown {
  return parse(getText(storage, WAL_SNAPSHOT_KEY));
}

function revisionOf(snapshot: unknown): number | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const r = (snapshot as { revision?: unknown }).revision;
  return isNum(r) ? r : null;
}

function seqOf(e: unknown): number | null {
  if (!e || typeof e !== 'object') return null;
  const s = (e as { seq?: unknown }).seq;
  return isNum(s) ? s : null;
}

/** The highest seq a save's action log holds (a checkpoint counts with its upToSeq); 0 for none. */
function coveredSeq(s: SaveV1): number {
  let m = 0;
  if (!Array.isArray(s.actions)) return m;
  for (const a of s.actions) {
    const seq = seqOf(a);
    if (seq !== null) m = Math.max(m, seq);
    if (a && a.source === 'checkpoint' && isNum(a.payload?.upToSeq)) m = Math.max(m, a.payload.upToSeq);
  }
  return m;
}

export function createWal(storage: Storage | null | undefined): Wal {
  const s = storage ?? null;
  return {
    appendCritical(entry) {
      if (!s) return false;
      if (!ActionEntrySchema.safeParse(entry).success) return false;
      const env = loadEntries(s) ?? { v: 1, critical: [] };
      env.critical.push({ e: entry, by: null });
      return storeEntries(s, env);
    },

    writeSnapshot(save) {
      if (!s) return false;
      const stored = revisionOf(loadSnapshot(s));
      if (stored !== null && save.revision < stored) return false;
      try {
        s.setItem(WAL_SNAPSHOT_KEY, JSON.stringify(save));
      } catch {
        return false;
      }
      const env = loadEntries(s);
      if (!env) return true;
      const upTo = coveredSeq(save);
      let changed = false;
      for (const c of env.critical) {
        const seq = seqOf(c.e);
        if (c.by === null && seq !== null && seq <= upTo) {
          c.by = save.revision;
          changed = true;
        }
      }
      return changed ? storeEntries(s, env) : true;
    },

    read() {
      if (!s) return { snapshot: null, critical: [] };
      const critical: ActionEntry[] = [];
      for (const c of loadEntries(s)?.critical ?? []) {
        const r = ActionEntrySchema.safeParse(c.e);
        if (r.success) critical.push(r.data);
      }
      let snapshot: unknown | null = null;
      const raw = loadSnapshot(s);
      if (raw !== undefined && raw !== null) {
        const m = migrate(raw);
        snapshot = m.ok ? m.save : null;
      }
      return { snapshot, critical };
    },

    clear(upToRevision) {
      if (!s) return;
      const rev = revisionOf(loadSnapshot(s));
      if (rev !== null && rev <= upToRevision) {
        try {
          s.removeItem(WAL_SNAPSHOT_KEY);
        } catch {
          // left for the next clear
        }
      }
      const env = loadEntries(s);
      if (!env) return;
      const kept = env.critical.filter((c) => c.by === null || c.by > upToRevision);
      if (kept.length !== env.critical.length) storeEntries(s, { v: 1, critical: kept });
    },
  };
}

function currentStorage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** The game's WAL on `localStorage`, looked up at call time. */
export const wal: Wal = {
  appendCritical: (entry) => createWal(currentStorage()).appendCritical(entry),
  writeSnapshot: (save) => createWal(currentStorage()).writeSnapshot(save),
  read: () => createWal(currentStorage()).read(),
  clear: (upTo) => createWal(currentStorage()).clear(upTo),
};
