/**
 * The write-ahead log (v4 sub-plan 3, Task 4; DESIGN §5.2, ruling R2).
 *
 * IndexedDB is asynchronous; a paying action (the emergency exit above all)
 * must be on disk BEFORE its effect shows. The WAL is the synchronous half:
 * one localStorage key, `onespace.wal.v1`, holding one JSON envelope:
 *
 *     { v: 1, snapshot: unknown | null, snapRev: number | null,
 *       critical: [{ e: ActionEntry, by: number | null }] }
 *
 * `by` is the revision of the first snapshot written AFTER the entry — the
 * save that contains it. `clear(N)` drops the snapshot if `snapRev ≤ N` and
 * the entries with `by ≤ N`; an entry with `by: null` (after the latest
 * snapshot) is never cleared. The intended order is writeSnapshot →
 * IndexedDB → clear.
 *
 * Nothing here throws: a full or missing storage gives `false`; foreign bytes
 * read as empty, are not erased by reading, and the next write replaces them.
 * `read` trusts nothing: each entry is checked with `ActionEntrySchema` and
 * dropped alone if it fails; the snapshot goes through `migrate`.
 */

import { migrate } from './migrate';
import { ActionEntrySchema, type ActionEntry, type SaveV1 } from './schema';

export const WAL_KEY = 'onespace.wal.v1';

interface Envelope {
  v: 1;
  snapshot: unknown | null;
  snapRev: number | null;
  critical: Array<{ e: unknown; by: number | null }>;
}

export interface Wal {
  /** Synchronously record a resource-critical action. False if it could not be written. */
  appendCritical(entry: ActionEntry): boolean;
  /** Synchronously keep `s` as THE snapshot; it covers every entry appended so far. */
  writeSnapshot(s: SaveV1): boolean;
  /** What is stored, validated; foreign bytes read as empty. */
  read(): { snapshot: unknown | null; critical: ActionEntry[] };
  /** Drop what a durable save of revision ≤ `upToRevision` already holds. */
  clear(upToRevision: number): void;
}

function empty(): Envelope {
  return { v: 1, snapshot: null, snapRev: null, critical: [] };
}

function isRev(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** The stored envelope, or null for foreign bytes / nothing stored / unreadable storage. */
function load(storage: Storage | null): Envelope | null {
  if (!storage) return null;
  let text: string | null;
  try {
    text = storage.getItem(WAL_KEY);
  } catch {
    return null;
  }
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || !Array.isArray(o.critical)) return null;
  const critical: Envelope['critical'] = [];
  for (const item of o.critical) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    critical.push({ e: it.e, by: isRev(it.by) ? it.by : null });
  }
  return {
    v: 1,
    snapshot: o.snapshot ?? null,
    snapRev: isRev(o.snapRev) ? o.snapRev : null,
    critical,
  };
}

function store(storage: Storage | null, env: Envelope): boolean {
  if (!storage) return false;
  try {
    if (env.snapshot === null && env.critical.length === 0) storage.removeItem(WAL_KEY);
    else storage.setItem(WAL_KEY, JSON.stringify(env));
    return true;
  } catch {
    return false;
  }
}

export function createWal(storage: Storage | null | undefined): Wal {
  const s = storage ?? null;
  return {
    appendCritical(entry) {
      if (!s) return false;
      const env = load(s) ?? empty();
      env.critical.push({ e: entry, by: null });
      return store(s, env);
    },

    writeSnapshot(save) {
      if (!s) return false;
      const env = load(s) ?? empty();
      for (const c of env.critical) if (c.by === null) c.by = save.revision;
      env.snapshot = save;
      env.snapRev = save.revision;
      return store(s, env);
    },

    read() {
      const env = load(s);
      if (!env) return { snapshot: null, critical: [] };
      const critical: ActionEntry[] = [];
      for (const c of env.critical) {
        const r = ActionEntrySchema.safeParse(c.e);
        if (r.success) critical.push(r.data);
      }
      let snapshot: unknown | null = null;
      if (env.snapshot !== null) {
        const m = migrate(env.snapshot);
        snapshot = m.ok ? m.save : null;
      }
      return { snapshot, critical };
    },

    clear(upToRevision) {
      const env = load(s);
      if (!env) return;
      env.critical = env.critical.filter((c) => c.by === null || c.by > upToRevision);
      if (env.snapRev === null || env.snapRev <= upToRevision) {
        env.snapshot = null;
        env.snapRev = null;
      }
      store(s, env);
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
