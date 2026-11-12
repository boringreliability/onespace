/**
 * The SaveStore on IndexedDB — a small promise wrapper, no library.
 *
 * Database `onespace` (version 1):
 *  - `slots`: the saves under the out-of-line keys 'current' and 'previous';
 *  - `corrupt`: `{ wallMs, raw }` records (auto-increment keys).
 *
 * `save` is ONE readwrite transaction (read current → put it as previous →
 * put the new current), so a failure anywhere rolls back to what was there.
 * Every failure rejects; nothing throws out of a callback. The connection is
 * opened lazily, closed on `versionchange` (another tab's upgrade must not
 * be blocked forever) and reopened on the next call.
 */

import type { SaveV1 } from './schema';
import type { SaveStore } from './store';

const DB_VERSION = 1;
const SLOTS = 'slots';
const CORRUPT = 'corrupt';

export function idbStore(name = 'onespace'): SaveStore {
  let opening: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    if (opening) return opening;
    const p = new Promise<IDBDatabase>((resolve, reject) => {
      let r: IDBOpenDBRequest;
      try {
        r = indexedDB.open(name, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(SLOTS)) db.createObjectStore(SLOTS);
        if (!db.objectStoreNames.contains(CORRUPT)) db.createObjectStore(CORRUPT, { autoIncrement: true });
      };
      r.onsuccess = () => {
        const db = r.result;
        const forget = () => {
          if (opening === p) opening = null;
        };
        db.onversionchange = () => {
          db.close();
          forget();
        };
        db.onclose = forget;
        resolve(db);
      };
      r.onerror = () => reject(r.error);
      // onblocked: another tab holds an older version open; its
      // onversionchange closes it, and success follows.
    });
    opening = p;
    p.catch(() => {
      if (opening === p) opening = null;
    });
    return p;
  }

  /**
   * Run `body` in one transaction; resolve with what `body` handed to `done`
   * when the transaction COMMITS, reject (once) on any error or abort.
   */
  async function run<T>(
    stores: string | string[],
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction, done: (v: T) => void, fail: (e: unknown) => void) => void,
  ): Promise<T> {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let value: T;
      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        try {
          tx.abort();
        } catch {
          // already finished or aborted
        }
        reject(e ?? new Error('IndexedDB transaction failed'));
      };
      let tx: IDBTransaction;
      try {
        tx = db.transaction(stores, mode);
      } catch (e) {
        settled = true;
        reject(e);
        return;
      }
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error ?? new DOMException('transaction aborted', 'AbortError'));
      try {
        body(tx, (v) => (value = v), fail);
      } catch (e) {
        fail(e);
      }
    });
  }

  return {
    load() {
      return run<{ current: unknown | null; previous: unknown | null }>(SLOTS, 'readonly', (tx, done, fail) => {
        const slots = tx.objectStore(SLOTS);
        const out = { current: null as unknown | null, previous: null as unknown | null };
        done(out);
        const cur = slots.get('current');
        cur.onsuccess = () => (out.current = cur.result ?? null);
        cur.onerror = () => fail(cur.error);
        const prev = slots.get('previous');
        prev.onsuccess = () => (out.previous = prev.result ?? null);
        prev.onerror = () => fail(prev.error);
      });
    },

    save(s: SaveV1) {
      return run<void>(SLOTS, 'readwrite', (tx, _done, fail) => {
        const slots = tx.objectStore(SLOTS);
        const cur = slots.get('current');
        cur.onerror = () => fail(cur.error);
        cur.onsuccess = () => {
          try {
            if (cur.result !== undefined) slots.put(cur.result, 'previous');
            slots.put(s, 'current');
          } catch (e) {
            fail(e);
          }
        };
      });
    },

    keepCorrupt(raw: unknown, wallMs: number) {
      return run<void>(CORRUPT, 'readwrite', (tx) => {
        tx.objectStore(CORRUPT).put({ wallMs, raw });
      });
    },
  };
}
