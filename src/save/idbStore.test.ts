/**
 * v4 sub-plan 3 (local save), Task 4 — the store (§5.2 "offline først").
 *
 * `SaveStore` is the seam a later cloud/multiplayer store plugs into, so the
 * same contract runs against both local implementations:
 *  - `idbStore(name)` — IndexedDB (here fake-indexeddb), object stores `slots`
 *    and `corrupt`;
 *  - `memoryStore()` — the same promises, in memory.
 *
 * Promises:
 *  - save → load round-trips; the old current becomes previous (two slots);
 *  - load hands back what is stored as `unknown` — it never validates and
 *    never throws on foreign bytes; `migrate` is the only door (Task 1);
 *  - a write that fails rejects, and leaves current/previous exactly as they
 *    were (one transaction);
 *  - a corrupt save is kept, untouched, with the wall time it was found.
 *
 * Layout pinned here (IndexedDB only): `slots` holds the two saves under the
 * out-of-line keys 'current' and 'previous'; `corrupt` holds
 * `{ wallMs, raw }` records.
 */

import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import golden from './fixtures/v1-golden.json';
import { idbStore } from './idbStore';
import { memoryStore } from './memoryStore';
import { migrate } from './migrate';
import type { SaveV1 } from './schema';
import type { SaveStore } from './store';

function saveAt(revision: number, wallMs = 1762891200000 + revision): SaveV1 {
  const s = structuredClone(golden) as unknown as SaveV1;
  s.revision = revision;
  s.savedAt = { wallMs, orbitSeconds: s.savedAt.orbitSeconds };
  return s;
}

let dbCounter = 0;
/** A fresh database per test: no state leaks between tests. */
function freshDbName(): string {
  return `onespace-test-${++dbCounter}-${Math.random().toString(36).slice(2)}`;
}

// --- a tiny raw IndexedDB helper (the test reads/writes past the store) -----

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function rawOpen(name: string): Promise<IDBDatabase> {
  return req(indexedDB.open(name));
}

async function rawGetAll(name: string, store: string): Promise<unknown[]> {
  const db = await rawOpen(name);
  try {
    return await req(db.transaction(store, 'readonly').objectStore(store).getAll());
  } finally {
    db.close();
  }
}

async function rawPut(name: string, store: string, key: IDBValidKey, value: unknown): Promise<void> {
  const db = await rawOpen(name);
  try {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } finally {
    db.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

// --- the contract, for every SaveStore ---------------------------------------

const stores: Array<[string, () => SaveStore]> = [
  ['idbStore', () => idbStore(freshDbName())],
  ['memoryStore', () => memoryStore()],
];

describe.each(stores)('SaveStore contract — %s', (_label, make) => {
  it('Given an empty store, When it is loaded, Then current and previous are both null', async () => {
    const store = make();
    await expect(store.load()).resolves.toEqual({ current: null, previous: null });
  });

  it('Given a save, When it is saved and loaded, Then current equals it and previous is null', async () => {
    const store = make();
    const s = saveAt(7);
    await store.save(s);
    const { current, previous } = await store.load();
    expect(current).toEqual(s);
    expect(previous).toBeNull();
  });

  it('Given a saved revision 7, When revision 8 is saved, Then 8 is current and 7 becomes previous', async () => {
    const store = make();
    await store.save(saveAt(7));
    await store.save(saveAt(8));
    const { current, previous } = await store.load();
    expect((current as SaveV1).revision).toBe(8);
    expect((previous as SaveV1).revision).toBe(7);
  });

  it('Given three saves, When loaded, Then only the last two are kept (the oldest is gone)', async () => {
    const store = make();
    await store.save(saveAt(7));
    await store.save(saveAt(8));
    await store.save(saveAt(9));
    const { current, previous } = await store.load();
    expect((current as SaveV1).revision).toBe(9);
    expect((previous as SaveV1).revision).toBe(8);
  });

  it('Given a saved object, When the caller mutates it afterwards, Then the stored save is unchanged (a copy is kept)', async () => {
    const store = make();
    const s = saveAt(7);
    await store.save(s);
    s.ship.propellant.massKg = 0;
    s.revision = 99;
    const { current } = await store.load();
    expect((current as SaveV1).revision).toBe(7);
    expect((current as SaveV1).ship.propellant.massKg).toBe(golden.ship.propellant.massKg);
  });

  it('Given a loaded save, When the caller mutates it, Then a second load is unchanged', async () => {
    const store = make();
    await store.save(saveAt(7));
    const first = await store.load();
    (first.current as SaveV1).revision = 99;
    const second = await store.load();
    expect((second.current as SaveV1).revision).toBe(7);
  });

  it('Given a corrupt save, When it is kept, Then keepCorrupt resolves and does not touch current/previous', async () => {
    const store = make();
    await store.save(saveAt(7));
    await store.keepCorrupt({ format: 1, revision: 'nope' }, 1762891300000);
    const { current, previous } = await store.load();
    expect((current as SaveV1).revision).toBe(7);
    expect(previous).toBeNull();
  });
});

// --- v4 sub-plan 4, Task 5 — Ruling R34: replaceAll -----------------------------
//
//   replaceAll(save: SaveV1 | null): Promise<void>
//
// current = save (or empty), previous = empty, in ONE transaction (idbStore);
// the shelf (`corrupt`) is untouched. Sync uses it when the local save is
// replaced by a cloud or resolved save, or cleared on an account switch: a
// plain save() would leave the old game as `previous`, and the boot's
// newest-by-revision rule could bring it back.

describe.each(stores)('Ruling R34 — SaveStore.replaceAll — %s', (_label, make) => {
  it('Given revisions 7 and 8 stored, When replaceAll(another game at r3), Then load yields only it: current r3, previous null', async () => {
    const store = make();
    await store.save(saveAt(7));
    await store.save(saveAt(8));
    const other = { ...saveAt(3), saveId: '11111111-2222-4333-8444-555555555555' };
    await store.replaceAll(other);
    await expect(store.load()).resolves.toEqual({ current: other, previous: null });
  });

  it('Given revisions 7 and 8 stored, When replaceAll(null), Then load yields nothing', async () => {
    const store = make();
    await store.save(saveAt(7));
    await store.save(saveAt(8));
    await store.replaceAll(null);
    await expect(store.load()).resolves.toEqual({ current: null, previous: null });
  });

  it('Given an empty store, When replaceAll(r5), Then current r5 and previous null; When r6 is saved after, Then r5 becomes previous as usual', async () => {
    const store = make();
    await store.replaceAll(saveAt(5));
    await expect(store.load()).resolves.toEqual({ current: saveAt(5), previous: null });
    await store.save(saveAt(6));
    const { current, previous } = await store.load();
    expect((current as SaveV1).revision).toBe(6);
    expect((previous as SaveV1).revision).toBe(5);
  });

  it('Given a replaced save, When the caller mutates its object afterwards, Then the stored copy is unchanged', async () => {
    const store = make();
    const s = saveAt(5);
    await store.replaceAll(s);
    s.revision = 99;
    expect(((await store.load()).current as SaveV1).revision).toBe(5);
  });
});

describe('Ruling R34 — replaceAll leaves the shelf alone', () => {
  it('Given a kept copy on the memoryStore shelf, When replaceAll(x) and replaceAll(null), Then the shelf still holds it', async () => {
    const store = memoryStore();
    await store.keepCorrupt({ format: 99 }, 1);
    await store.save(saveAt(7));
    await store.replaceAll(saveAt(3));
    await store.replaceAll(null);
    expect(store.corrupt).toEqual([{ wallMs: 1, raw: { format: 99 } }]);
  });

  it('Given a kept copy in the idbStore corrupt store, When replaceAll(x) and replaceAll(null), Then the corrupt store still holds it', async () => {
    const name = freshDbName();
    const store = idbStore(name);
    await store.keepCorrupt({ format: 99 }, 1);
    await store.save(saveAt(7));
    await store.replaceAll(saveAt(3));
    await store.replaceAll(null);
    expect(await rawGetAll(name, 'corrupt')).toEqual([{ wallMs: 1, raw: { format: 99 } }]);
  });
});

describe('Ruling R34 — a failed replaceAll leaves the old content (one transaction)', () => {
  /** Make the n-th mutating IDBObjectStore call (put, delete or clear) throw. */
  function failNthMutation(n: number): { count: () => number } {
    let calls = 0;
    for (const m of ['put', 'delete', 'clear'] as const) {
      const real = IDBObjectStore.prototype[m] as (...a: unknown[]) => IDBRequest;
      vi.spyOn(IDBObjectStore.prototype, m).mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
        calls += 1;
        if (calls === n) throw new DOMException('the disk is full', 'QuotaExceededError');
        return real.apply(this, args);
      } as never);
    }
    return { count: () => calls };
  }

  it('Given revisions 7 and 8, When the SECOND write of replaceAll(r3) throws, Then it rejects and 8/7 are intact (the first write was rolled back)', async () => {
    const store = idbStore(freshDbName());
    await store.save(saveAt(7));
    await store.save(saveAt(8));
    const spy = failNthMutation(2);
    await expect(store.replaceAll(saveAt(3))).rejects.toBeDefined();
    expect(spy.count()).toBe(2);
    vi.restoreAllMocks();
    const { current, previous } = await store.load();
    expect((current as SaveV1).revision).toBe(8);
    expect((previous as SaveV1).revision).toBe(7);
  });

  it.each([
    ['replaceAll(r3)', () => saveAt(3)],
    ['replaceAll(null)', () => null],
  ])('Given revisions 7 and 8, When the FIRST write of %s throws, Then it rejects and 8/7 are intact; the connection still works afterwards', async (_what, next) => {
    const store = idbStore(freshDbName());
    await store.save(saveAt(7));
    await store.save(saveAt(8));
    failNthMutation(1);
    await expect(store.replaceAll(next())).rejects.toBeDefined();
    vi.restoreAllMocks();
    const { current, previous } = await store.load();
    expect((current as SaveV1).revision).toBe(8);
    expect((previous as SaveV1).revision).toBe(7);
    await store.replaceAll(saveAt(4));
    await expect(store.load()).resolves.toEqual({ current: saveAt(4), previous: null });
  });
});

// --- IndexedDB specifics -------------------------------------------------------

describe('idbStore — layout and foreign bytes', () => {
  it('Given idbStore with no name, Then it uses the database "onespace"', async () => {
    const store = idbStore();
    await store.save(saveAt(3));
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).toContain('onespace');
    const slots = await rawGetAll('onespace', 'slots');
    expect(slots).toHaveLength(1);
  });

  it('Given a save, When stored, Then the database has object stores "slots" and "corrupt"', async () => {
    const name = freshDbName();
    await idbStore(name).save(saveAt(7));
    const db = await rawOpen(name);
    try {
      expect([...db.objectStoreNames].sort()).toEqual(['corrupt', 'slots']);
    } finally {
      db.close();
    }
  });

  it('Given foreign bytes in slots/current, When loaded, Then load resolves with the raw value (no throw) and migrate rejects it', async () => {
    const name = freshDbName();
    const store = idbStore(name);
    await store.save(saveAt(7)); // creates the schema
    await rawPut(name, 'slots', 'current', 'definitely not a save');
    const { current, previous } = await store.load();
    expect(current).toBe('definitely not a save');
    expect(previous).toBeNull();
    expect(migrate(current).ok).toBe(false);
  });

  it('Given a structurally wrong object in slots/previous, When loaded, Then it comes back untouched as unknown', async () => {
    const name = freshDbName();
    const store = idbStore(name);
    await store.save(saveAt(7));
    const foreign = { format: 99, hello: ['world'] };
    await rawPut(name, 'slots', 'previous', foreign);
    const { current, previous } = await store.load();
    expect((current as SaveV1).revision).toBe(7);
    expect(previous).toEqual(foreign);
  });

  it('Given a corrupt raw value, When kept at a wall time, Then the corrupt store holds { wallMs, raw } untouched', async () => {
    const name = freshDbName();
    const store = idbStore(name);
    const raw = { format: 1, revision: 'nope', nested: { a: [1, 2, 3] } };
    await store.keepCorrupt(raw, 1762891300000);
    await store.keepCorrupt('second bad thing', 1762891400000);
    const kept = await rawGetAll(name, 'corrupt');
    expect(kept).toContainEqual({ wallMs: 1762891300000, raw });
    expect(kept).toContainEqual({ wallMs: 1762891400000, raw: 'second bad thing' });
    expect(kept).toHaveLength(2);
  });
});

describe('idbStore — a failed write', () => {
  it('Given revisions 7 then 8 saved, When the SECOND put of saving 9 throws, Then save rejects and 8/7 are intact (one transaction, not two)', async () => {
    const name = freshDbName();
    const store = idbStore(name);
    await store.save(saveAt(7));
    await store.save(saveAt(8));

    // R11/M1: the first write of the rotation lands; the second fails. An
    // implementation that rotates in two transactions would keep the first
    // (previous = 8) — only one transaction rolls it back.
    const realPut = IDBObjectStore.prototype.put;
    let puts = 0;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      puts += 1;
      if (puts === 2) throw new DOMException('the disk is full', 'QuotaExceededError');
      return realPut.apply(this, args);
    });

    await expect(store.save(saveAt(9))).rejects.toBeDefined();
    vi.restoreAllMocks();
    expect(puts).toBe(2);

    const { current, previous } = await store.load();
    expect((current as SaveV1).revision).toBe(8);
    expect((previous as SaveV1).revision).toBe(7);
  });

  it('Given a full disk (put throws QuotaExceededError), When saving, Then save rejects (no unhandled throw) and the store is unchanged', async () => {
    const name = freshDbName();
    const store = idbStore(name);
    await store.save(saveAt(7));

    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('the disk is full', 'QuotaExceededError');
    });

    await expect(store.save(saveAt(8))).rejects.toBeDefined();
    vi.restoreAllMocks();

    const { current, previous } = await store.load();
    expect((current as SaveV1).revision).toBe(7);
    expect(previous).toBeNull();
  });

  it('Given a failed save, When the next save succeeds, Then the store recovers (the connection is still usable)', async () => {
    const name = freshDbName();
    const store = idbStore(name);
    await store.save(saveAt(7));
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('the disk is full', 'QuotaExceededError');
    });
    await expect(store.save(saveAt(8))).rejects.toBeDefined();
    vi.restoreAllMocks();

    await store.save(saveAt(9));
    const { current, previous } = await store.load();
    expect((current as SaveV1).revision).toBe(9);
    expect((previous as SaveV1).revision).toBe(7);
  });
});

// Task 6 fix round 1 (minor): the same unreadable save, found again on the
// next boot, is not kept twice. A different one still is.
describe('idbStore — keepCorrupt keeps an identical raw once (Task 6 fix round 1)', () => {
  it('Given the same raw kept twice (two boots), Then the corrupt store holds it once', async () => {
    const name = freshDbName();
    const store = idbStore(name);
    const raw = { format: 99, revision: 12, nested: { a: [1, 2] } };
    await store.keepCorrupt(raw, 1762891300000);
    await store.keepCorrupt(structuredClone(raw), 1762891400000);
    expect(await rawGetAll(name, 'corrupt')).toEqual([{ wallMs: 1762891300000, raw }]);
  });

  it('Given two different raws, Then both are kept', async () => {
    const name = freshDbName();
    const store = idbStore(name);
    await store.keepCorrupt({ format: 98 }, 1);
    await store.keepCorrupt({ format: 99 }, 2);
    expect(await rawGetAll(name, 'corrupt')).toHaveLength(2);
  });
});
