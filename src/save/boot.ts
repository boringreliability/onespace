/**
 * The boot's decisions, pure and injected (v4 sub-plan 3, Task 6 fix round 1;
 * rulings R17–R19). registry.ts only wires these to the real storage.
 *
 *  - `decideBoot`: which save, which mode, continue or new — before any
 *    module is built. `?new=1` starts a new game over a save ONLY with the
 *    one-time nonce NEW GAME's confirmed press stored in sessionStorage (R17);
 *    a bare or replayed link boots the title (CONTINUE first) with a notice.
 *    `new` and `nonce` always leave the URL here, so a reload never repeats
 *    them. A replaced game is kept (current as revision + 1, and a copy on
 *    the kept shelf, I2). Reader tabs never write; nor does a boot whose
 *    store failed or did not answer in 3 s (`storeAvailable: false`, R25).
 *  - `restartAfterRestoreFail`: the saved system cannot be found — a new
 *    start above the kept old game.
 *  - `logBeforeWorld`: the log imported before the Universe exists is the
 *    NEW game's; a continued save's own log comes with applySave, so a failed
 *    restore leaves nothing of the old game behind.
 */

import { bootPlan, parseRoute, type BootPlan, type Route } from '@/core/Route';
import { loadForBootResult, openingLog, replaceGame, type BootLoad } from './bootLoad';
import { consumeNewGameNonce, type SessionLike } from './newGameNonce';
import type { SaveV1 } from './schema';
import type { SaveStore } from './store';
import type { Wal } from './wal';
import type { WriterLock } from './writerLock';

export const NEW_GAME_REFUSED_TEXT = 'NEW GAME NEEDS CONFIRMING ON THE TITLE';
export const OLD_SAVE_KEPT_TEXT = 'OLD SAVE KEPT AS A COPY';
export const RESTORE_FAILED_TEXT = 'SAVED SYSTEM NOT FOUND — NEW START';

export interface BootDeps {
  readonly search: string;
  readonly store: SaveStore;
  readonly wal: Wal;
  /** Resolved: this tab writes, or it is a reader. */
  readonly lock: WriterLock;
  /** sessionStorage (null where it is unavailable). */
  readonly session: SessionLike | null;
  /** Replace the page's query string without a reload (history.replaceState). */
  replaceSearch(search: string): void;
}

export interface BootDecision {
  readonly route: Route;
  readonly plan: BootPlan;
  readonly load: BootLoad;
  /** A new game's first save goes above this revision. */
  readonly afterRevision: number;
  /** Log lines for the player, in order. */
  readonly notices: string[];
  /**
   * R25 I2: false when the store failed (or did not answer) at boot — the
   * session is then store-inert: SaveGame writes the WAL only.
   */
  readonly storeAvailable: boolean;
}

/** `search` without `new` and `nonce`; null when it carries neither. */
function stripped(search: string): string | null {
  const q = new URLSearchParams(search);
  if (!q.has('new') && !q.has('nonce')) return null;
  q.delete('new');
  q.delete('nonce');
  const out = q.toString().replace(/(^|&)dev=(?=&|$)/, '$1dev');
  return out ? `?${out}` : '';
}

export async function decideBoot(d: BootDeps): Promise<BootDecision> {
  const parsed = parseRoute(d.search);
  const clean = stripped(d.search);
  if (clean !== null) {
    try {
      d.replaceSearch(clean);
    } catch {
      // a URL that cannot be rewritten is still refused below
    }
  }

  const notices: string[] = [];
  const { load, storeAvailable } = await loadForBootResult(d.store, d.wal, { writer: d.lock.writer });
  if (load.notice) notices.push(load.notice);
  const hasSave = load.save !== null;

  // R17: consumed on the first check, right or wrong, whatever else happens.
  const confirmed = parsed.newGame === true && consumeNewGameNonce(d.session, parsed.newGameNonce);
  let route: Route = parsed;
  let plan: BootPlan;
  if (parsed.newGame && !confirmed && hasSave) {
    route = { ...parsed, newGame: undefined, newGameNonce: undefined };
    plan = { mode: 'title', start: 'continue' };
    notices.push(NEW_GAME_REFUSED_TEXT);
  } else {
    plan = bootPlan(parsed, hasSave);
  }

  let afterRevision = 0;
  if (plan.start === 'new' && load.save) {
    if (d.lock.writer) {
      const r = await replaceGame(d.store, d.wal, load, { storeAvailable });
      afterRevision = r.afterRevision;
      if (r.kept) notices.push(OLD_SAVE_KEPT_TEXT);
    } else {
      afterRevision = load.save.revision + 1;
    }
  }
  return { route, plan, load, afterRevision, notices, storeAvailable };
}

/** The saved place cannot be found: a new start, above the kept old game (writer only). */
export async function restartAfterRestoreFail(d: {
  readonly store: SaveStore;
  readonly wal: Wal;
  readonly lock: WriterLock;
  readonly load: BootLoad;
  /** R25 I2/C4: the boot's verdict on the store; false writes nothing to it. Default true. */
  readonly storeAvailable?: boolean;
}): Promise<{ afterRevision: number; notices: string[] }> {
  const notices = [RESTORE_FAILED_TEXT];
  const save = d.load.save;
  if (!save) return { afterRevision: 0, notices };
  if (!d.lock.writer) return { afterRevision: save.revision + 1, notices };
  const r = await replaceGame(d.store, d.wal, d.load, { storeAvailable: d.storeAvailable });
  if (r.kept) notices.push(OLD_SAVE_KEPT_TEXT);
  return { afterRevision: r.afterRevision, notices };
}

/** The log a boot imports before the Universe exists: always the new game's opening log. */
export function logBeforeWorld(load: BootLoad): SaveV1['log'] {
  return openingLog(load, 'new');
}
