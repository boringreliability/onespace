/**
 * v4 sub-plan 3, Task 6 fix round 1 — the boot's decisions, pure and injected.
 *
 * registry.ts `loadBoot` becomes a thin call to `decideBoot(deps)`; the
 * restore-failed fallback becomes `restartAfterRestoreFail(...)`; the log a
 * boot imports before the world exists is `logBeforeWorld(load)`.
 *
 *   decideBoot({ search, store, wal, lock, session, replaceSearch }):
 *     Promise<{ route, plan, load, afterRevision, notices: string[] }>
 *   restartAfterRestoreFail({ store, wal, lock, load }):
 *     Promise<{ afterRevision, notices: string[] }>
 *   logBeforeWorld(load): SaveV1['log']
 *
 * Rulings pinned here:
 *  - R17 (security): `?new=1` starts a new game over a save ONLY with the
 *    one-time nonce NEW GAME's confirmed press stored in sessionStorage;
 *    consumed on the first check. A bare or replayed link boots the title
 *    (CONTINUE first) with `NEW GAME NEEDS CONFIRMING ON THE TITLE`.
 *  - `new` and `nonce` are stripped from the URL (replaceSearch) before
 *    decideBoot resolves — before any module is built.
 *  - I2: a replaced game is kept as a COPY (the store's kept shelf,
 *    `keepCorrupt`), not only as `previous`, with `OLD SAVE KEPT AS A COPY`.
 *  - Reader tabs never write: no prepareNewGame, no keepCorrupt, no WAL
 *    snapshot or clear.
 *  - Restore failed: `SAVED SYSTEM NOT FOUND — NEW START`; the writer keeps
 *    the old game (current, as revision + 1, and a copy); the new game starts
 *    above it.
 *  - The log imported before the world is the NEW game's opening log; a
 *    continued save's log comes with applySave, so a failed restore keeps the
 *    new start's arrival and none of the old game's entries.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decideBoot, logBeforeWorld, restartAfterRestoreFail } from './boot';
import golden from './fixtures/v1-golden.json';
import legacy from './fixtures/v0-legacy-log.json';
import { memoryStore } from './memoryStore';
import { migrate } from './migrate';
import { NEW_GAME_NONCE_KEY, issueNewGameNonce } from './newGameNonce';
import type { SaveV1 } from './schema';
import type { SaveStore } from './store';
import { WAL_KEY, WAL_SNAPSHOT_KEY, createWal, type Wal } from './wal';
import type { WriterLock } from './writerLock';

const WALL = 1_800_000_000_000;
const REFUSED = 'NEW GAME NEEDS CONFIRMING ON THE TITLE';
const KEPT = 'OLD SAVE KEPT AS A COPY';
const NOT_FOUND = 'SAVED SYSTEM NOT FOUND — NEW START';
const UNREADABLE = 'SAVE UNREADABLE — KEPT A COPY';

class FakeStorage implements Storage {
  private m = new Map<string, string>();
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
    this.m.set(k, String(v));
  }
}

let local: FakeStorage;
let session: FakeStorage;

beforeEach(() => {
  local = new FakeStorage();
  session = new FakeStorage();
  vi.stubGlobal('localStorage', local);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(WALL);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function save(revision = 7, over: Partial<SaveV1> = {}): SaveV1 {
  const m = migrate(structuredClone(golden));
  if (!m.ok) throw new Error(m.issues.join('; '));
  return { ...m.save, revision, ...over };
}

/** A memory store that counts every write. */
function spyStore() {
  const inner = memoryStore();
  const calls = { save: 0, keepCorrupt: 0 };
  const store: SaveStore = {
    load: () => inner.load(),
    save: (s) => {
      calls.save++;
      return inner.save(s);
    },
    keepCorrupt: (raw, wallMs) => {
      calls.keepCorrupt++;
      return inner.keepCorrupt(raw, wallMs);
    },
  };
  return { store, inner, calls };
}

/** The real WAL on `local`, counting its writes. */
function spyWal() {
  const base = createWal(local);
  const calls = { writeSnapshot: 0, clear: 0, appendCritical: 0 };
  const wal: Wal = {
    ...base,
    appendCritical: (e, ...rest: unknown[]) => {
      calls.appendCritical++;
      return (base.appendCritical as (...a: unknown[]) => boolean)(e, ...rest);
    },
    writeSnapshot: (s) => {
      calls.writeSnapshot++;
      return base.writeSnapshot(s);
    },
    clear: (n) => {
      calls.clear++;
      base.clear(n);
    },
    read: () => base.read(),
  };
  return { wal, calls };
}

const writer: WriterLock = { writer: true, release: () => undefined };
const reader: WriterLock = { writer: false, release: () => undefined };

async function withSave(s: SaveV1 = save(7)) {
  const st = spyStore();
  await st.inner.save(s);
  return st;
}

function deps(over: {
  search: string;
  store: SaveStore;
  wal?: Wal;
  lock?: WriterLock;
  session?: Storage | null;
}) {
  const replaced: string[] = [];
  return {
    replaced,
    d: {
      search: over.search,
      store: over.store,
      wal: over.wal ?? createWal(local),
      lock: over.lock ?? writer,
      session: over.session === undefined ? session : over.session,
      replaceSearch: (s: string) => replaced.push(s),
    },
  };
}

// =============================================================================

describe('decideBoot — a link cannot start a new game over a save (R17)', () => {
  it('Given a save and a bare ?new=1, Then no new game: the title with CONTINUE, nothing written, and a notice', async () => {
    const st = await withSave();
    const { d } = deps({ search: '?new=1', store: st.store });
    const r = await decideBoot(d);
    expect(r.plan).toEqual({ mode: 'title', start: 'continue' });
    expect(r.load.save?.revision).toBe(7);
    expect(r.afterRevision).toBe(0);
    expect(r.notices).toContain(REFUSED);
    expect(st.calls.save).toBe(0);
  });

  it('Given a save and ?mode=flight&new=1 without a nonce, Then the title still (never straight into a new flight)', async () => {
    const st = await withSave();
    const r = await decideBoot(deps({ search: '?mode=flight&new=1', store: st.store }).d);
    expect(r.plan).toEqual({ mode: 'title', start: 'continue' });
  });

  it('Given a save and a nonce that was never issued (or a wrong one), Then refused', async () => {
    const st = await withSave();
    issueNewGameNonce(session, () => 'b'.repeat(32));
    const r = await decideBoot(deps({ search: `?new=1&nonce=${'a'.repeat(32)}&mode=flight`, store: st.store }).d);
    expect(r.plan.start).toBe('continue');
    expect(r.notices).toContain(REFUSED);
    expect(st.calls.save).toBe(0);
  });

  it('Given the nonce NEW GAME issued, Then a new game in flight: the old game written back (revision 8), a copy kept, a notice, and the nonce consumed', async () => {
    const st = await withSave();
    const n = issueNewGameNonce(session)!;
    const r = await decideBoot(deps({ search: `?new=1&nonce=${n}&mode=flight`, store: st.store }).d);
    expect(r.plan).toEqual({ mode: 'flight', start: 'new' });
    expect(r.afterRevision).toBe(8);
    expect(r.notices).toContain(KEPT);
    expect(r.notices).not.toContain(REFUSED);
    const { current } = await st.inner.load();
    expect((current as SaveV1).revision).toBe(8);
    expect(st.inner.corrupt.map((c) => (c.raw as SaveV1).saveId)).toEqual([golden.saveId]);
    expect(session.getItem(NEW_GAME_NONCE_KEY)).toBeNull();
  });

  it('Given the same nonce link opened a second time, Then it is refused (one use)', async () => {
    const st = await withSave();
    const n = issueNewGameNonce(session)!;
    const search = `?new=1&nonce=${n}&mode=flight`;
    await decideBoot(deps({ search, store: st.store }).d);
    const saves = st.calls.save;
    const again = await decideBoot(deps({ search, store: st.store }).d);
    expect(again.plan).toEqual({ mode: 'title', start: 'continue' });
    expect(again.notices).toContain(REFUSED);
    expect(st.calls.save).toBe(saves);
  });

  it('Given no session storage at all, Then ?new=1 over a save is refused', async () => {
    const st = await withSave();
    const r = await decideBoot(deps({ search: `?new=1&nonce=${'a'.repeat(32)}`, store: st.store, session: null }).d);
    expect(r.plan.start).toBe('continue');
  });

  it('Given NO save and a bare ?new=1, Then simply a new game, as the link names, with no refusal notice (nothing to protect)', async () => {
    const st = spyStore();
    const r = await decideBoot(deps({ search: '?new=1&mode=flight', store: st.store }).d);
    expect(r.plan).toEqual({ mode: 'flight', start: 'new' });
    expect(r.notices).not.toContain(REFUSED);
  });

  it('Given a save and no ?new, Then continue as before, no notices', async () => {
    const st = await withSave();
    const r = await decideBoot(deps({ search: '?mode=flight', store: st.store }).d);
    expect(r.plan).toEqual({ mode: 'flight', start: 'continue' });
    expect(r.notices).toEqual([]);
  });

  it("Given loadForBoot's own notice (an unreadable slot), Then it is among the notices", async () => {
    const st = spyStore();
    await st.inner.save(save(6));
    await st.inner.save({ format: 99 } as unknown as SaveV1);
    const r = await decideBoot(deps({ search: '', store: st.store }).d);
    expect(r.notices).toContain(UNREADABLE);
  });
});

describe('decideBoot — new and nonce leave the URL before any module is built', () => {
  it('Given ?new=1&nonce=…, Then replaceSearch is called (before decideBoot resolves) with both removed and the rest kept', async () => {
    const st = await withSave();
    const n = issueNewGameNonce(session)!;
    const { d, replaced } = deps({ search: `?tier=low&new=1&nonce=${n}&mode=flight`, store: st.store });
    await decideBoot(d);
    expect(replaced).toHaveLength(1);
    const q = new URLSearchParams(replaced[0]);
    expect(q.has('new')).toBe(false);
    expect(q.has('nonce')).toBe(false);
    expect(q.get('tier')).toBe('low');
    expect(q.get('mode')).toBe('flight');
  });

  it('Given a refused ?new=1, Then it is stripped too (a reload must not ask again)', async () => {
    const st = await withSave();
    const { d, replaced } = deps({ search: '?new=1', store: st.store });
    await decideBoot(d);
    expect(replaced).toEqual(['']);
  });

  it('Given neither new nor nonce, Then the URL is left alone', async () => {
    const st = await withSave();
    const { d, replaced } = deps({ search: '?mode=flight&tier=low', store: st.store });
    await decideBoot(d);
    expect(replaced).toEqual([]);
  });
});

describe('decideBoot — reader tabs never write', () => {
  it('Given a reader tab and a valid nonce, Then a new game above the save but NOTHING written: no store save, no copy, no WAL snapshot or clear', async () => {
    const st = await withSave();
    const w = spyWal();
    const n = issueNewGameNonce(session)!;
    const r = await decideBoot(deps({ search: `?new=1&nonce=${n}`, store: st.store, wal: w.wal, lock: reader }).d);
    expect(r.plan.start).toBe('new');
    expect(r.afterRevision).toBe(8);
    expect(st.calls).toEqual({ save: 0, keepCorrupt: 0 });
    expect(w.calls.writeSnapshot).toBe(0);
    expect(w.calls.clear).toBe(0);
    expect(r.notices).not.toContain(KEPT);
  });

  it('Given a reader tab and an unreadable current slot, Then the save is still read but no copy is kept by this tab', async () => {
    const st = spyStore();
    await st.inner.save(save(6));
    await st.inner.save({ format: 99 } as unknown as SaveV1);
    const r = await decideBoot(deps({ search: '', store: st.store, lock: reader }).d);
    expect(r.load.save?.revision).toBe(6);
    expect(st.calls.keepCorrupt).toBe(0);
  });
});

describe('restartAfterRestoreFail — the saved system cannot be found (I2)', () => {
  it('Given a writer, Then the old game is written back (revision + 1), a copy is kept, and the notices say both', async () => {
    const st = await withSave();
    const w = spyWal();
    const load = { save: save(7), notice: null, legacyLog: null };
    const r = await restartAfterRestoreFail({ store: st.store, wal: w.wal, lock: writer, load });
    expect(r.afterRevision).toBe(8);
    expect(r.notices).toEqual([NOT_FOUND, KEPT]);
    const { current } = await st.inner.load();
    expect((current as SaveV1).revision).toBe(8);
    expect(st.inner.corrupt).toHaveLength(1);
    expect((st.inner.corrupt[0]!.raw as SaveV1).saveId).toBe(golden.saveId);
  });

  it('Given a reader, Then only the notice: afterRevision above the save, nothing written', async () => {
    const st = await withSave();
    const w = spyWal();
    const load = { save: save(7), notice: null, legacyLog: null };
    const r = await restartAfterRestoreFail({ store: st.store, wal: w.wal, lock: reader, load });
    expect(r).toEqual({ afterRevision: 8, notices: [NOT_FOUND] });
    expect(st.calls).toEqual({ save: 0, keepCorrupt: 0 });
    expect(w.calls.writeSnapshot + w.calls.clear).toBe(0);
    expect(local.getItem(WAL_SNAPSHOT_KEY)).toBeNull();
    expect(local.getItem(WAL_KEY)).toBeNull();
  });
});

describe('logBeforeWorld — the log imported before the Universe exists', () => {
  it('Given a save to continue, Then an EMPTY log (the save\'s own log comes with applySave, after a successful restore)', () => {
    expect(logBeforeWorld({ save: save(7), notice: null, legacyLog: null })).toEqual({ time: 0, entries: [] });
  });

  it('Given no save and a legacy logbook, Then the legacy log', () => {
    const legacyLog = { time: legacy.time, entries: legacy.entries } as SaveV1['log'];
    expect(logBeforeWorld({ save: null, notice: null, legacyLog })).toEqual(legacyLog);
  });
});
