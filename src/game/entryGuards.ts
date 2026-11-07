/**
 * Who may open what, and who owns the keyboard — as pure answers.
 *
 * The Yard, photo mode and the pause sheet each listen on `window` in the
 * capture phase. `stopPropagation()` does NOT stop the other listeners on the
 * same target, so "this module owns the keyboard" only holds if every other
 * listener also asks whether it is its turn. These are those questions, in one
 * place, so they can be pinned in node (review-p2):
 *
 *  - photo over the Yard: Esc left the photo AND the Yard, and ← / → swapped
 *    the hull under the frozen frame, because the Yard's own key handler also
 *    ran on every photo-mode key;
 *  - photo's "never over a menu" guard looked for `.os-pause-open` and
 *    `.os-codex-open`, classes nothing in the game sets, so P opened photo
 *    straight over the pause sheet and the codex;
 *  - `Y` opened the Yard mid-jump and mid-recovery — the recovery veil (z 40)
 *    then hung black over the whole Yard.
 */

import type { BaseMode, Overlay } from '@/core/Modes';

export interface KeyMods {
  readonly repeat?: boolean;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
}

export interface EntryContext {
  readonly base: BaseMode;
  readonly overlay: Overlay | null;
  /** The pause sheet, the codex or either chart is up. */
  readonly menuOpen: boolean;
  /** A jump or a recovery cut is running; neither can be stepped out of. */
  readonly busy?: boolean;
}

function plain(k: KeyMods): boolean {
  return !k.repeat && !k.metaKey && !k.ctrlKey && !k.altKey;
}

/** `P` opens photo mode: from flight or the Yard, never over a menu or another overlay. */
export function mayEnterPhoto(c: EntryContext, k: KeyMods = {}): boolean {
  if (!plain(k) || c.overlay !== null || c.menuOpen) return false;
  return c.base === 'flight' || c.base === 'yard';
}

/** `Y` opens the Yard: from plain flight only, never mid-sequence. */
export function mayEnterYard(c: EntryContext, k: KeyMods = {}): boolean {
  if (!plain(k) || c.overlay !== null || c.menuOpen || c.busy === true) return false;
  return c.base === 'flight';
}

/** The Yard's own controls answer only while nothing sits on top of it. */
export function yardOwnsInput(c: Pick<EntryContext, 'base' | 'overlay'>): boolean {
  return c.base === 'yard' && c.overlay === null;
}
