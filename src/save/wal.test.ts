/**
 * v4 sub-plan 3 (local save), Task 4 — the write-ahead log (§5.2, ruling R2).
 *
 * IndexedDB is asynchronous; a paying action (the emergency exit above all)
 * must be on disk BEFORE its effect shows. The WAL is the synchronous half:
 * one localStorage key, `onespace.wal.v1`.
 *
 * Promises:
 *  - `appendCritical(entry)` is synchronous: the entry is in storage when the
 *    call returns; it returns true, or false when storage is full or missing —
 *    it never throws (the paying code path must not crash);
 *  - `writeSnapshot(s)` keeps ONE snapshot (the latest), synchronously, same
 *    true/false contract;
 *  - `read()` returns `{ snapshot: unknown | null, critical: ActionEntry[] }`;
 *    foreign or broken bytes read as empty, never throw, and are not erased
 *    by reading;
 *  - `clear(upToRevision)` drops what a durable save of that revision covers:
 *    the snapshot if its revision ≤ upTo, and the critical entries appended
 *    BEFORE a snapshot of revision ≤ upTo. Entries appended after the latest
 *    snapshot are never cleared — the save that will contain them does not
 *    exist yet. (The intended order: writeSnapshot → IndexedDB → clear.)
 *
 * The storage is injected (`createWal(storage)`); the exported `wal` binds to
 * `globalThis.localStorage` lazily, at call time.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import golden from './fixtures/v1-golden.json';
import type { ActionEntry, SaveV1 } from './schema';
import { createWal, wal } from './wal';

const KEY = 'onespace.wal.v1';

/** An in-memory Storage that can be made full. */
class FakeStorage implements Storage {
  private m = new Map<string, string>();
  full = false;
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  setItem(k: string, v: string): void {
    if (this.full) throw new DOMException('the quota has been exceeded', 'QuotaExceededError');
    this.m.set(k, String(v));
  }
}

function thrust(seq: number, kg = 1.5): ActionEntry {
  return { seq, source: 'thrust', payload: { kg }, wallMs: 1762891200000 + seq, orbitSeconds: seq };
}

function emergency(seq: number): ActionEntry {
  return { seq, source: 'emergency', payload: { kind: 'beacon' }, wallMs: 1762891200000 + seq, orbitSeconds: seq };
}

function saveAt(revision: number): SaveV1 {
  const s = structuredClone(golden) as unknown as SaveV1;
  s.revision = revision;
  return s;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wal — a synchronous append', () => {
  it('Given an empty WAL, When it is read, Then there is no snapshot and no critical entry', () => {
    const w = createWal(new FakeStorage());
    expect(w.read()).toEqual({ snapshot: null, critical: [] });
  });

  it('Given an append, When read in the same tick (no await), Then the entry is there and already in storage', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    expect(w.appendCritical(emergency(1))).toBe(true);
    expect(w.read().critical).toEqual([emergency(1)]);
    expect(storage.getItem(KEY)).not.toBeNull();
  });

  it('Given an append, When a NEW wal reads the same storage (a reload), Then the entry survives', () => {
    const storage = new FakeStorage();
    createWal(storage).appendCritical(emergency(1));
    expect(createWal(storage).read().critical).toEqual([emergency(1)]);
  });

  it('Given several appends, When read, Then they come back in append order', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(thrust(1));
    w.appendCritical(emergency(2));
    w.appendCritical(thrust(3, 4));
    expect(w.read().critical).toEqual([thrust(1), emergency(2), thrust(3, 4)]);
  });

  it('Given only the WAL key is used, When appending, Then no other localStorage key is touched', () => {
    const storage = new FakeStorage();
    storage.setItem('onespace.log.v1', '{"version":1}');
    createWal(storage).appendCritical(thrust(1));
    expect(storage.length).toBe(2);
    expect(storage.getItem('onespace.log.v1')).toBe('{"version":1}');
  });
});

describe('wal — full or missing storage', () => {
  it('Given full storage, When appending, Then it returns false and does not throw', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    storage.full = true;
    expect(() => w.appendCritical(thrust(1))).not.toThrow();
    expect(w.appendCritical(thrust(2))).toBe(false);
  });

  it('Given entries already written, When storage fills and an append fails, Then the earlier entries are intact', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    w.appendCritical(thrust(1));
    storage.full = true;
    w.appendCritical(thrust(2));
    expect(w.read().critical).toEqual([thrust(1)]);
  });

  it('Given full storage, When writing a snapshot, Then it returns false, does not throw, and keeps the old one', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    expect(w.writeSnapshot(saveAt(7))).toBe(true);
    storage.full = true;
    expect(w.writeSnapshot(saveAt(8))).toBe(false);
    expect((w.read().snapshot as SaveV1).revision).toBe(7);
  });

  it('Given full storage, When clearing, Then it does not throw', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    w.writeSnapshot(saveAt(7));
    storage.full = true;
    expect(() => w.clear(7)).not.toThrow();
  });

  it('Given no storage at all (null), Then append and snapshot give false and read gives empty — nothing throws', () => {
    const w = createWal(null);
    expect(w.appendCritical(thrust(1))).toBe(false);
    expect(w.writeSnapshot(saveAt(7))).toBe(false);
    expect(w.read()).toEqual({ snapshot: null, critical: [] });
    expect(() => w.clear(7)).not.toThrow();
  });

  it('Given a storage whose getItem throws (blocked site data), Then read gives empty and append gives false', () => {
    const storage = new FakeStorage();
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new DOMException('access denied', 'SecurityError');
    });
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new DOMException('access denied', 'SecurityError');
    });
    const w = createWal(storage);
    expect(w.read()).toEqual({ snapshot: null, critical: [] });
    expect(w.appendCritical(thrust(1))).toBe(false);
  });
});

describe('wal — foreign bytes', () => {
  const foreign: Array<[string, string]> = [
    ['not JSON', 'not json {'],
    ['JSON null', 'null'],
    ['a JSON array', '[1,2,3]'],
    ['a JSON string', '"hello"'],
    ['an object of the wrong shape', '{"critical":"nope","snapshot":5}'],
  ];

  it.each(foreign)('Given %s under the WAL key, When read, Then it is empty and does not throw', (_what, bytes) => {
    const storage = new FakeStorage();
    storage.setItem(KEY, bytes);
    const w = createWal(storage);
    expect(() => w.read()).not.toThrow();
    expect(w.read()).toEqual({ snapshot: null, critical: [] });
  });

  it('Given foreign bytes, When read, Then reading does not erase them', () => {
    const storage = new FakeStorage();
    storage.setItem(KEY, 'not json {');
    createWal(storage).read();
    expect(storage.getItem(KEY)).toBe('not json {');
  });

  it('Given foreign bytes, When a critical entry is appended, Then it succeeds and starts a fresh WAL', () => {
    const storage = new FakeStorage();
    storage.setItem(KEY, 'not json {');
    const w = createWal(storage);
    expect(w.appendCritical(emergency(1))).toBe(true);
    expect(w.read()).toEqual({ snapshot: null, critical: [emergency(1)] });
  });
});

describe('wal — the snapshot', () => {
  it('Given a snapshot, When read, Then it round-trips as data (unknown, to go through migrate)', () => {
    const w = createWal(new FakeStorage());
    const s = saveAt(7);
    w.writeSnapshot(s);
    expect(w.read().snapshot).toEqual(s);
  });

  it('Given two snapshots, When read, Then only the latest is kept', () => {
    const w = createWal(new FakeStorage());
    w.writeSnapshot(saveAt(7));
    w.writeSnapshot(saveAt(8));
    expect((w.read().snapshot as SaveV1).revision).toBe(8);
  });

  it('Given critical entries, When a snapshot is written, Then the entries are still there', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(emergency(1));
    w.writeSnapshot(saveAt(7));
    expect(w.read().critical).toEqual([emergency(1)]);
  });
});

describe('wal — clear(upToRevision)', () => {
  it('Given e1, e2, snapshot r8, e3, When clear(8), Then the snapshot and e1/e2 are gone and e3 stays', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(emergency(1));
    w.appendCritical(thrust(2));
    w.writeSnapshot(saveAt(8));
    w.appendCritical(thrust(3));
    w.clear(8);
    expect(w.read()).toEqual({ snapshot: null, critical: [thrust(3)] });
  });

  it('Given snapshot r8, When clear(7) (an older save landed), Then nothing is removed', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(emergency(1));
    w.writeSnapshot(saveAt(8));
    w.appendCritical(thrust(2));
    w.clear(7);
    expect((w.read().snapshot as SaveV1).revision).toBe(8);
    expect(w.read().critical).toEqual([emergency(1), thrust(2)]);
  });

  it('Given snapshot r8, When clear(9), Then the snapshot and what it covers are gone', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(emergency(1));
    w.writeSnapshot(saveAt(8));
    w.clear(9);
    expect(w.read()).toEqual({ snapshot: null, critical: [] });
  });

  it('Given entries and NO snapshot, When clear(100), Then the entries stay (no save is known to contain them)', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(emergency(1));
    w.appendCritical(thrust(2));
    w.clear(100);
    expect(w.read().critical).toEqual([emergency(1), thrust(2)]);
  });

  it('Given e1, snapshot r7, e2, snapshot r8, e3, When clear(7), Then only e1 goes; the r8 snapshot, e2 and e3 stay', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(emergency(1));
    w.writeSnapshot(saveAt(7));
    w.appendCritical(thrust(2));
    w.writeSnapshot(saveAt(8));
    w.appendCritical(thrust(3));
    w.clear(7);
    expect((w.read().snapshot as SaveV1).revision).toBe(8);
    expect(w.read().critical).toEqual([thrust(2), thrust(3)]);
  });
});

describe('wal — the default instance', () => {
  it('Given localStorage is stubbed after import, When the exported wal appends, Then it writes onespace.wal.v1 there', () => {
    const storage = new FakeStorage();
    vi.stubGlobal('localStorage', storage);
    expect(wal.appendCritical(emergency(1))).toBe(true);
    expect(storage.getItem(KEY)).not.toBeNull();
    expect(wal.read().critical).toEqual([emergency(1)]);
  });

  it('Given no localStorage global, When the exported wal appends, Then it returns false and does not throw', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(wal.appendCritical(emergency(1))).toBe(false);
    expect(wal.read()).toEqual({ snapshot: null, critical: [] });
  });
});

/** A save whose action log is exactly `actions` (the golden's are seq 1..12). */
function saveWith(revision: number, actions: ActionEntry[]): SaveV1 {
  const s = saveAt(revision);
  s.actions = actions;
  return s;
}

function checkpoint(seq: number, upToSeq: number): ActionEntry {
  return {
    seq,
    source: 'checkpoint',
    payload: {
      upToSeq,
      tankNetKg: 0,
      capacityLossNetFrac: 0,
      cargoNetKg: { ice: 0, metal: 0, silicate: 0, rare: 0 },
      minedByAsteroid: {},
      emergency: { cannibalize: 0, cannibalizeCargo: 0, beacon: 0 },
      lastCannibalizeTimesUsed: 0,
    },
    wallMs: 1762891200000 + seq,
    orbitSeconds: seq,
  };
}

describe('wal — coverage follows the save, not the call order (R11/I1)', () => {
  it('Given a save captured with actions up to seq 2, When e3 is appended BEFORE writeSnapshot, Then clear(rev) keeps e3', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(emergency(1));
    w.appendCritical(thrust(2));
    const captured = saveWith(8, [emergency(1), thrust(2)]); // buildSave ran here
    w.appendCritical(thrust(3)); // paid after the capture, before the WAL write
    expect(w.writeSnapshot(captured)).toBe(true);
    w.clear(8);
    expect(w.read()).toEqual({ snapshot: null, critical: [thrust(3)] });
  });

  it('Given a snapshot written, When the SAME save is written again after e3 was appended (a retry), Then e3 is still not covered', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(emergency(1));
    const captured = saveWith(8, [emergency(1)]);
    expect(w.writeSnapshot(captured)).toBe(true);
    w.appendCritical(thrust(2));
    expect(w.writeSnapshot(captured)).toBe(true); // equal revision: allowed
    w.clear(8);
    expect(w.read().critical).toEqual([thrust(2)]);
  });

  it('Given a save with an empty action log, When written, Then it covers no entry', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(emergency(1));
    w.writeSnapshot(saveWith(8, []));
    w.clear(8);
    expect(w.read()).toEqual({ snapshot: null, critical: [emergency(1)] });
  });

  it('Given a save whose log starts with a checkpoint (seq 3, upToSeq 20), When written, Then entries up to seq 20 are covered and 21 is not', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(thrust(19));
    w.appendCritical(emergency(20));
    w.appendCritical(thrust(21));
    w.writeSnapshot(saveWith(8, [checkpoint(3, 20)]));
    w.clear(8);
    expect(w.read().critical).toEqual([thrust(21)]);
  });

  it('Given a stored snapshot r8, When an OLDER save r7 is written, Then it returns false and the snapshot and coverage are unchanged', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(emergency(1));
    w.writeSnapshot(saveWith(8, [emergency(1)]));
    w.appendCritical(thrust(2));
    // r7 claims to cover seq 2 — it must not be allowed to tag it.
    expect(w.writeSnapshot(saveWith(7, [emergency(1), thrust(2)]))).toBe(false);
    expect((w.read().snapshot as SaveV1).revision).toBe(8);
    w.clear(7);
    expect(w.read().critical).toEqual([emergency(1), thrust(2)]);
    w.clear(8);
    expect(w.read()).toEqual({ snapshot: null, critical: [thrust(2)] });
  });
});

describe('wal — appendCritical validates (R11/M4)', () => {
  it('Given an entry with a NaN field, When appended to an empty WAL, Then it returns false and nothing is stored', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    expect(w.appendCritical(thrust(1, Number.NaN))).toBe(false);
    expect(storage.getItem(KEY)).toBeNull();
    expect(w.read().critical).toEqual([]);
  });

  it('Given good entries, When an invalid one (seq 0) is appended, Then it returns false and the stored bytes are unchanged', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    w.appendCritical(emergency(1));
    const before = storage.getItem(KEY);
    expect(w.appendCritical({ ...thrust(2), seq: 0 })).toBe(false);
    expect(storage.getItem(KEY)).toBe(before);
    expect(w.read().critical).toEqual([emergency(1)]);
  });
});

describe('wal — a single bad entry (R10)', () => {
  it('Given a malformed entry offered among good ones, When read, Then only the good ones come back', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(emergency(1));
    w.appendCritical({ seq: 0, source: 'thrust', payload: { kg: -5 } } as unknown as ActionEntry);
    w.appendCritical(thrust(3));
    expect(() => w.read()).not.toThrow();
    expect(w.read().critical).toEqual([emergency(1), thrust(3)]);
  });
});

// =============================================================================
// Task 6 fix round 1 (I1): each critical entry carries the saveId of the game
// that wrote it; `readTagged()` shows `{ e, by, saveId }` so the loader can
// keep one game's entries out of another. `read()` is unchanged.
// =============================================================================

const SAVE_A = '3f9c2b1e-7a4d-4e8b-9c61-2d5f0a8e7b14';

describe('wal — entries know their game (Task 6 fix round 1, I1)', () => {
  it('Given appends with a saveId, Then readTagged shows it, untagged (by null); read() still gives the bare entries', () => {
    const w = createWal(new FakeStorage());
    expect(w.appendCritical(emergency(13), SAVE_A)).toBe(true);
    expect(w.readTagged().critical).toEqual([{ e: emergency(13), by: null, saveId: SAVE_A }]);
    expect(w.read().critical).toEqual([emergency(13)]);
  });

  it('Given an append without a saveId, Then readTagged shows saveId null', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(thrust(2));
    expect(w.readTagged().critical).toEqual([{ e: thrust(2), by: null, saveId: null }]);
  });

  it('Given a snapshot that covers the entry, Then readTagged shows by = its revision and keeps the saveId', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(emergency(12), SAVE_A);
    w.writeSnapshot(saveAt(7));
    expect(w.readTagged().critical).toEqual([{ e: emergency(12), by: 7, saveId: SAVE_A }]);
  });

  it('Given a saveId that is not a string, Then the append is refused (whitelist)', () => {
    const w = createWal(new FakeStorage());
    expect(w.appendCritical(emergency(1), 42 as unknown as string)).toBe(false);
    expect(w.read().critical).toEqual([]);
  });

  it('Given the same snapshot in readTagged and read, Then both agree', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    w.writeSnapshot(saveAt(7));
    expect(w.readTagged().snapshot).toEqual(w.read().snapshot);
  });
});

// =============================================================================
// Task 7 — gaps the mutation run found (W1–W10).
// =============================================================================

const SNAP_KEY = 'onespace.wal.v1.snapshot';

/** Put raw critical items under KEY, as another build or a hand edit might have. */
function putEnvelope(storage: FakeStorage, env: unknown): void {
  storage.setItem(KEY, JSON.stringify(env));
}

function storedCritical(storage: FakeStorage): Array<Record<string, unknown>> {
  return (JSON.parse(storage.getItem(KEY)!) as { critical: Array<Record<string, unknown>> }).critical;
}

describe('wal — Task 7: a hostile or foreign envelope (W1, W2, W3, W6)', () => {
  it('W1a: Given junk items (null, 5, "x") beside one good entry, When read, Then it does not throw, returns the good entry, and the next append drops the junk', () => {
    const storage = new FakeStorage();
    putEnvelope(storage, { v: 1, critical: [null, 5, 'x', { e: thrust(1), by: null }] });
    const w = createWal(storage);
    expect(() => w.read()).not.toThrow();
    expect(w.read().critical).toEqual([thrust(1)]);
    expect(w.appendCritical(thrust(2))).toBe(true);
    expect(storedCritical(storage)).toHaveLength(2);
  });

  it('W1b: Given a wrong version or a critical that is not an array, When read, Then it is empty and does not throw', () => {
    for (const env of [{ v: 2, critical: [{ e: thrust(1), by: null }] }, { v: 1, critical: {} }]) {
      const storage = new FakeStorage();
      putEnvelope(storage, env);
      const w = createWal(storage);
      expect(() => w.read()).not.toThrow();
      expect(w.read().critical).toEqual([]);
    }
  });

  it('W2: Given one valid and one invalid stored entry, When read and readTagged, Then only the valid one comes back (no hole)', () => {
    const storage = new FakeStorage();
    putEnvelope(storage, {
      v: 1,
      critical: [
        { e: thrust(1), by: null },
        { e: { seq: 0, source: 'thrust', payload: { kg: -5 } }, by: null },
      ],
    });
    const w = createWal(storage);
    expect(w.read().critical).toEqual([thrust(1)]);
    expect(w.readTagged().critical).toEqual([{ e: thrust(1), by: null, saveId: null }]);
  });

  it('W3: Given a stored snapshot that fails migrate ({"format":1}), When read, Then snapshot is null', () => {
    const storage = new FakeStorage();
    storage.setItem(SNAP_KEY, '{"format":1}');
    expect(createWal(storage).read().snapshot).toBeNull();
    expect(createWal(storage).readTagged().snapshot).toBeNull();
  });

  it('W6: Given a stored entry whose saveId is the number 7, When readTagged, Then its saveId is null', () => {
    const storage = new FakeStorage();
    putEnvelope(storage, { v: 1, critical: [{ e: thrust(1), by: null, saveId: 7 }] });
    expect(createWal(storage).readTagged().critical).toEqual([{ e: thrust(1), by: null, saveId: null }]);
  });
});

describe('wal — Task 7: clear and writeSnapshot touch only what they must (W4, W5, W9, W10)', () => {
  it('W4: Given the only entry is covered by snapshot r5, When clear(5), Then the entries key is removed, not left as an empty envelope', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    w.appendCritical(thrust(1));
    w.writeSnapshot(saveAt(5));
    expect(w.readTagged().critical[0]!.by).toBe(5);
    w.clear(5);
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('W5a: Given untagged entries and a snapshot that covers none, When writeSnapshot, Then the entries key is not rewritten', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    w.appendCritical(thrust(1));
    const save = saveAt(2);
    save.actions = [];
    const spy = vi.spyOn(storage, 'setItem');
    expect(w.writeSnapshot(save)).toBe(true);
    expect(spy.mock.calls.filter(([k]) => k === KEY)).toHaveLength(0);
  });

  it('W5b: Given entries covered by r8, When clear(7) drops nothing, Then the entries key is not rewritten', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    w.appendCritical(thrust(1));
    w.writeSnapshot(saveAt(8));
    const before = storage.getItem(KEY);
    const spy = vi.spyOn(storage, 'setItem');
    w.clear(7);
    expect(spy.mock.calls.filter(([k]) => k === KEY)).toHaveLength(0);
    expect(storage.getItem(KEY)).toBe(before);
  });

  it('W9: Given a stored snapshot with no readable revision, When clear(100), Then it is left in place', () => {
    const storage = new FakeStorage();
    storage.setItem(SNAP_KEY, '{"no":"revision"}');
    createWal(storage).clear(100);
    expect(storage.getItem(SNAP_KEY)).toBe('{"no":"revision"}');
  });

  it('W10: Given a stored entry with no seq, When a snapshot is written and cleared, Then the entry is still there, untagged', () => {
    const storage = new FakeStorage();
    putEnvelope(storage, { v: 1, critical: [{ e: {}, by: null }] });
    const w = createWal(storage);
    w.writeSnapshot(saveAt(3));
    w.clear(3);
    expect(storedCritical(storage)).toEqual([{ e: {}, by: null }]);
  });
});

describe('wal — Task 7: coverage by the highest seq (W7, W8)', () => {
  it('W7: Given an entry stored and a save whose actions is not an array, When writeSnapshot, Then it does not throw and returns true', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    w.appendCritical(thrust(1));
    const save = saveAt(4);
    (save as { actions: unknown }).actions = undefined;
    expect(() => w.writeSnapshot(save)).not.toThrow();
    expect(w.writeSnapshot(save)).toBe(true);
  });

  it('W8: Given an untagged entry seq 6 and actions out of order [seq 9, seq 4], When writeSnapshot(r3), Then the entry is tagged r3 (the highest seq counts)', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    w.appendCritical(thrust(6));
    const save = saveAt(3);
    save.actions = [thrust(9), thrust(4)] as SaveV1['actions'];
    w.writeSnapshot(save);
    expect(w.readTagged().critical[0]!.by).toBe(3);
  });

  it('W8b: Given an untagged entry seq 6 and actions [seq 9, a checkpoint with seq 2 and upToSeq 3], When writeSnapshot(r3), Then the entry is tagged r3 (a lower upToSeq never lowers the cover)', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    w.appendCritical(thrust(6));
    const save = saveAt(3);
    const checkpoint = {
      seq: 2,
      source: 'checkpoint',
      payload: {
        upToSeq: 3,
        tankNetKg: 0,
        capacityLossNetFrac: 0,
        cargoNetKg: { ice: 0, metal: 0, silicate: 0, rare: 0 },
        minedByAsteroid: {},
        emergency: { cannibalize: 0, cannibalizeCargo: 0, beacon: 0 },
        lastCannibalizeTimesUsed: 0,
      },
      wallMs: 1,
      orbitSeconds: 1,
    };
    save.actions = [thrust(9), checkpoint] as SaveV1['actions'];
    w.writeSnapshot(save);
    expect(w.readTagged().critical[0]!.by).toBe(3);
  });
});

// =============================================================================
// Final review, ruling R25 I4a — a regular autosave tags coverage WITHOUT
// writing the whole snapshot (1.4 MB at the cap). `markCovered(save)` follows
// writeSnapshot's rules — an untagged entry is tagged by save.revision when
// its seq ≤ the highest seq in save.actions (a checkpoint counting with its
// upToSeq); a save strictly older than the stored snapshot tags nothing — and
// never writes, rewrites or removes the snapshot. Entries stay until
// clear(rev) after a durable IndexedDB save, so a crash in between loses
// nothing (SaveGame.test.ts proves the round trip).
// =============================================================================

describe('R25 I4a — markCovered: coverage without the snapshot', () => {
  type Marking = { markCovered(s: SaveV1): boolean };
  const marking = (w: ReturnType<typeof createWal>): Marking => w as unknown as Marking;

  it('Given e1, e2, e3 and a save holding seq 1–2, When markCovered, Then e1/e2 are tagged by its revision, e3 stays untagged, and it returns true', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(emergency(1));
    w.appendCritical(thrust(2));
    w.appendCritical(thrust(3));
    expect(marking(w).markCovered(saveWith(8, [emergency(1), thrust(2)]))).toBe(true);
    expect(w.readTagged().critical.map((c) => [c.e.seq, c.by])).toEqual([
      [1, 8],
      [2, 8],
      [3, null],
    ]);
  });

  it('Given a stored snapshot r5, When markCovered(r8), Then the snapshot bytes are untouched — not rewritten, not removed', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    w.writeSnapshot(saveWith(5, []));
    const before = storage.getItem(SNAP_KEY);
    w.appendCritical(emergency(1));
    marking(w).markCovered(saveWith(8, [emergency(1)]));
    expect(storage.getItem(SNAP_KEY)).toBe(before);
  });

  it('Given no snapshot, When markCovered, Then still no snapshot is written', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    w.appendCritical(emergency(1));
    marking(w).markCovered(saveWith(8, [emergency(1)]));
    expect(storage.getItem(SNAP_KEY)).toBeNull();
  });

  it('Given entries tagged by markCovered(r8), When clear(7), Then nothing goes; When clear(8), Then the tagged go and the untagged stay', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(emergency(1));
    w.appendCritical(thrust(2));
    marking(w).markCovered(saveWith(8, [emergency(1)]));
    w.clear(7);
    expect(w.read().critical).toEqual([emergency(1), thrust(2)]);
    w.clear(8);
    expect(w.read().critical).toEqual([thrust(2)]);
  });

  it('Given a save whose log starts with a checkpoint (seq 3, upToSeq 20), When markCovered, Then entries up to seq 20 are covered and 21 is not', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(emergency(20));
    w.appendCritical(thrust(21));
    marking(w).markCovered(saveWith(8, [checkpoint(3, 20)]));
    expect(w.readTagged().critical.map((c) => c.by)).toEqual([8, null]);
  });

  it('Given an entry already tagged by r6, When markCovered(r8), Then it keeps by 6', () => {
    const w = createWal(new FakeStorage());
    w.appendCritical(emergency(1));
    w.writeSnapshot(saveWith(6, [emergency(1)]));
    marking(w).markCovered(saveWith(8, [emergency(1)]));
    expect(w.readTagged().critical[0]!.by).toBe(6);
  });

  it('Given a stored snapshot r8, When an OLDER save r7 is marked, Then it returns false and tags nothing (as writeSnapshot, R11)', () => {
    const w = createWal(new FakeStorage());
    w.writeSnapshot(saveWith(8, []));
    w.appendCritical(thrust(2));
    expect(marking(w).markCovered(saveWith(7, [thrust(2)]))).toBe(false);
    expect(w.readTagged().critical[0]!.by).toBeNull();
  });

  it('Given full storage, When markCovered must tag, Then it returns false, does not throw, and the entries stay untagged (kept, never lost)', () => {
    const storage = new FakeStorage();
    const w = createWal(storage);
    w.appendCritical(emergency(1));
    storage.full = true;
    expect(() => marking(w).markCovered(saveWith(8, [emergency(1)]))).not.toThrow();
    expect(marking(w).markCovered(saveWith(8, [emergency(1)]))).toBe(false);
    expect(w.readTagged().critical.map((c) => c.by)).toEqual([null]);
  });

  it('Given no storage at all, When markCovered, Then false and no throw; the exported wal has it too', () => {
    expect(marking(createWal(null)).markCovered(saveWith(8, []))).toBe(false);
    expect(typeof (wal as unknown as Marking).markCovered).toBe('function');
  });
});
