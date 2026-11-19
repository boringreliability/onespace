/**
 * v4 sub-plan 3 (local save), Task 4 — one writing tab.
 *
 * Two tabs on one save must not both write it. `acquireWriterLock(locks?)`
 * asks the Web Locks API for the exclusive lock `onespace-save`, WITHOUT
 * waiting (`ifAvailable`): a second tab learns at once that it is a reader.
 *
 * Promises:
 *  - two acquires give exactly one writer; the second resolves (never hangs);
 *  - `release()` lets the next acquire in; it is idempotent, and a no-op for
 *    a reader;
 *  - no Locks API (old browser, or `request` throws) → writer: a single tab is
 *    the overwhelmingly common case, and refusing to save would lose progress;
 *  - with no argument it uses `navigator.locks`.
 *
 * Node 24 ships a real `navigator.locks`; the tests use it where a real lock
 * manager is wanted and a stub where one is not.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireWriterLock } from './writerLock';

const held: Array<{ release(): void }> = [];
afterEach(() => {
  for (const h of held.splice(0)) h.release();
  vi.unstubAllGlobals();
});

async function acquire(locks?: LockManager) {
  const h = await acquireWriterLock(locks);
  held.push(h);
  return h;
}

/** Resolves to 'timeout' if `p` has not settled within `ms`. */
function within<T>(p: Promise<T>, ms = 500): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), ms))]);
}

describe('acquireWriterLock — with a lock manager', () => {
  it('Given a free lock, When acquired, Then this tab is the writer', async () => {
    const h = await acquire(navigator.locks);
    expect(h.writer).toBe(true);
  });

  it('Given one writer, When a second tab acquires, Then it resolves promptly as a reader', async () => {
    const first = await acquire(navigator.locks);
    const second = await within(acquire(navigator.locks));
    expect(first.writer).toBe(true);
    expect(second).not.toBe('timeout');
    expect((second as { writer: boolean }).writer).toBe(false);
  });

  it('Given two concurrent acquires, Then exactly one is the writer', async () => {
    const [a, b] = await Promise.all([acquire(navigator.locks), acquire(navigator.locks)]);
    expect([a.writer, b.writer].filter(Boolean)).toHaveLength(1);
  });

  it('Given a writer, When it releases, Then the next acquire is the writer', async () => {
    const first = await acquire(navigator.locks);
    first.release();
    await new Promise((r) => setTimeout(r, 0)); // the lock manager frees on a later tick
    const next = await acquire(navigator.locks);
    expect(next.writer).toBe(true);
  });

  it('Given a writer, When release is called twice, Then nothing throws and the lock is free', async () => {
    const first = await acquire(navigator.locks);
    first.release();
    expect(() => first.release()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect((await acquire(navigator.locks)).writer).toBe(true);
  });

  it('Given a reader, When it releases, Then the writer keeps the lock', async () => {
    const writer = await acquire(navigator.locks);
    const reader = await acquire(navigator.locks);
    expect(() => reader.release()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(writer.writer).toBe(true);
    expect((await acquire(navigator.locks)).writer).toBe(false);
  });

  it('Given a writer, Then the lock it holds is named "onespace-save" and is exclusive', async () => {
    await acquire(navigator.locks);
    const snap = await navigator.locks.query();
    expect(snap.held?.some((l) => l.name === 'onespace-save' && l.mode === 'exclusive')).toBe(true);
  });

  it('Given a lock manager, When acquiring, Then it asks without waiting (ifAvailable)', async () => {
    const request = vi.fn((_name: string, _opts: LockOptions, cb: (l: Lock | null) => unknown) => cb(null));
    const h = await acquire({ request, query: vi.fn() } as unknown as LockManager);
    expect(h.writer).toBe(false);
    expect(request).toHaveBeenCalledWith('onespace-save', expect.objectContaining({ ifAvailable: true }), expect.any(Function));
  });
});

describe('acquireWriterLock — without the Locks API', () => {
  it('Given navigator has no locks, When acquired with no argument, Then this tab is the writer', async () => {
    vi.stubGlobal('navigator', {});
    const h = await acquire();
    expect(h.writer).toBe(true);
    expect(() => h.release()).not.toThrow();
  });

  it('Given no navigator at all, When acquired, Then this tab is the writer', async () => {
    vi.stubGlobal('navigator', undefined);
    expect((await acquire()).writer).toBe(true);
  });

  it('Given a lock manager whose request throws (e.g. SecurityError), When acquired, Then it resolves as writer, no throw', async () => {
    const broken = {
      request: () => {
        throw new DOMException('not allowed', 'SecurityError');
      },
    } as unknown as LockManager;
    await expect(acquire(broken)).resolves.toMatchObject({ writer: true });
  });

  it('Given a lock manager whose request rejects, When acquired, Then it resolves as writer, no unhandled rejection', async () => {
    const broken = {
      request: () => Promise.reject(new DOMException('not allowed', 'SecurityError')),
    } as unknown as LockManager;
    await expect(acquire(broken)).resolves.toMatchObject({ writer: true });
  });
});

describe('acquireWriterLock — the default lock manager', () => {
  it('Given navigator.locks, When acquired twice with no argument, Then the first is the writer and the second a reader', async () => {
    const a = await acquire();
    const b = await acquire();
    expect(a.writer).toBe(true);
    expect(b.writer).toBe(false);
  });
});
