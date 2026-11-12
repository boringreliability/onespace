/**
 * One writing tab (v4 sub-plan 3, Task 4).
 *
 * Asks the Web Locks API for the exclusive lock `onespace-save` WITHOUT
 * waiting (`ifAvailable`): the first tab writes, a second learns at once that
 * it is a reader. The lock is held until `release()` (idempotent; a no-op for
 * a reader). Without a Locks API — or when it throws or rejects — the tab is
 * the writer: one tab is the common case, and refusing to save loses progress.
 */

export const WRITER_LOCK_NAME = 'onespace-save';

export interface WriterLock {
  readonly writer: boolean;
  release(): void;
}

const noop = (): void => {};

function defaultLocks(): LockManager | undefined {
  try {
    return (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  } catch {
    return undefined;
  }
}

export function acquireWriterLock(locks?: LockManager): Promise<WriterLock> {
  const lm = locks ?? defaultLocks();
  if (!lm || typeof lm.request !== 'function') return Promise.resolve({ writer: true, release: noop });

  return new Promise<WriterLock>((resolve) => {
    let settled = false;
    const done = (h: WriterLock) => {
      if (settled) return;
      settled = true;
      resolve(h);
    };
    const unlocked = () => done({ writer: true, release: noop });

    let pending: unknown;
    try {
      pending = lm.request(WRITER_LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (!lock) {
          done({ writer: false, release: noop });
          return undefined;
        }
        return new Promise<void>((free) => {
          let freed = false;
          done({
            writer: true,
            release: () => {
              if (freed) return;
              freed = true;
              free();
            },
          });
        });
      });
    } catch {
      unlocked();
      return;
    }
    Promise.resolve(pending).catch(unlocked);
  });
}
