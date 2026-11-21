/**
 * The pause overlay's state machine. Pure; `ui/Pause.ts` owns the DOM.
 *
 * Esc reaches us two ways: as a lost pointer lock (the browser swallows the key
 * while the pointer is captured) and as a keydown (when it is not) — and on
 * some browsers as both, milliseconds apart. One press must be one press, so a
 * keydown just after a lock-loss open is ignored.
 */

import type { SyncStatus } from '@/net/SyncClient';
import { EMERGENCY_KEYS, MINING_KEYS } from '@/core/Input';
import { FORMATION_KEY } from '@/ship/formation';
import { signedInText, type AccountView } from './accountMenu';

/** A keydown this soon after the pause opened is the same Esc, not a second one. */
export const ESC_DEBOUNCE_MS = 350;

export interface PauseState {
  readonly open: boolean;
  /** `performance.now()` when it opened; meaningless while closed. */
  readonly openedAt: number;
}

export const PAUSE_CLOSED: PauseState = Object.freeze({ open: false, openedAt: 0 });

export type PauseEvent =
  | { readonly type: 'lockLost'; readonly t: number }
  | { readonly type: 'escKey'; readonly t: number }
  | { readonly type: 'resume' }
  | { readonly type: 'returnToOrbit' }
  /** [v4-save] SAVE: the sheet stays open; the caller saves. */
  | { readonly type: 'save' };

export interface PauseContext {
  /** A chart or the codex is up. They own Esc and release the pointer on purpose. */
  readonly overlayOpen: boolean;
  /** A jump or a recovery is running; neither can be paused into. */
  readonly busy: boolean;
}

/**
 * Build the context from what the game is showing. Pause belongs to flight:
 * the Yard and photo mode both release the pointer on purpose when they open
 * (review-p2: that release used to read as "Esc" and open the pause sheet
 * behind them, to be found on the way back to flight).
 */
export function pauseContextFor(s: {
  /** `modes.current === 'flight'` — no overlay, not the Yard, not the title. */
  readonly flightShown: boolean;
  /** A chart or the codex is up. */
  readonly menuOpen: boolean;
  readonly busy: boolean;
}): PauseContext {
  return { overlayOpen: s.menuOpen || !s.flightShown, busy: s.busy };
}

/**
 * [v4-fuel] I1: with a tank, RETURN TO ORBIT costs what the beacon costs, and
 * the sheet says so before it is picked. A hull without a tank: v3, free.
 * [v4-mining] Final review I2: the beacon jettisons the hold, so with cargo
 * aboard the paid return says that too. The free return keeps the cargo.
 */
export function returnToOrbitLabel(hasTank: boolean, cargoKg = 0): string {
  if (!hasTank) return 'RETURN TO ORBIT';
  return cargoKg > 0 ? 'RETURN TO ORBIT · COSTS AS BEACON · LOSES CARGO' : 'RETURN TO ORBIT · COSTS AS BEACON';
}

// =============================================================================
// v4 sub-plan 5, Task 8 — the sheet's key lines (DESIGN-5 §7.7). The keys that
// live in a key map are read from it, not typed here, so a rebinding moves the
// line with it. Pause.ts renders this list and keeps none of its own.
// =============================================================================

/** The key maps the sheet reads: `MINING_KEYS`, `EMERGENCY_KEYS` (core/Input) and `FORMATION_KEY` (ship/formation). */
export interface PauseKeyMap {
  readonly mining: { readonly mine: string; readonly refine: string; readonly repair: string };
  readonly emergency: {
    readonly open: string;
    readonly cannibalize: string;
    readonly beacon: string;
    readonly cannibalizeCargo: string;
  };
  readonly formation: string;
}

const GAME_KEYS: PauseKeyMap = { mining: MINING_KEYS, emergency: EMERGENCY_KEYS, formation: FORMATION_KEY };

/** What the sheet prints for a key code: the code without its Key / Digit prefix (as Emergency.ts writes it). */
function keyLabel(code: string): string {
  return code.replace(/^Key/, '').replace(/^Digit/, '');
}

/** The sheet's key lines, `[key, what it does]`; omitted `keys` = the game's own map. */
export function pauseControls(keys: PauseKeyMap = GAME_KEYS): ReadonlyArray<readonly [string, string]> {
  const { mining, emergency } = keys;
  return [
    ['MOUSE · ARROWS', 'PITCH AND YAW'],
    ['Q / E', 'ROLL'],
    ['W / S · WHEEL', 'THROTTLE'],
    ['X', 'THROTTLE ZERO'],
    ['A D · R F', 'LATERAL · VERTICAL THRUST'],
    ['SHIFT · SPACE', 'BOOST · BRAKE'],
    ['Z', 'FLIGHT ASSIST'],
    ['TAB', 'CYCLE TARGET'],
    [keyLabel(keys.formation), 'FORMATION HOLD'],
    ['G', 'CRUISE'],
    ['T', 'SCAN'],
    ['M', 'CHART (WHEEL OUT FOR THE GALAXY)'],
    ['J', 'JUMP TO THE CHARTED SYSTEM'],
    ['C', 'CODEX'],
    ['V', 'CAMERA'],
    ['F2', 'SCREENSHOT'],
    ['ESC', 'PAUSE'],
    // [v2-p4]; [v4-mining] L also flies to a targeted rock.
    ['L', 'AUTOPILOT — LAND · TO ORBIT · APPROACH TARGET'],
    [', / .', 'TIME COMPRESSION (GROUND · STABLE ORBIT)'],
    // [v4-mining]
    [keyLabel(mining.mine), 'MINE (AGAIN TO STOP)'],
    [keyLabel(mining.refine), 'REFINE ICE TO PROPELLANT'],
    [keyLabel(mining.repair), 'REPAIR THE TANK'],
    // [v4-fuel]
    [
      `${keyLabel(emergency.open)} · ${keyLabel(emergency.cannibalize)} / ${keyLabel(emergency.beacon)} / ${keyLabel(emergency.cannibalizeCargo)}`,
      'EMERGENCY EXIT (EMPTY TANK)',
    ],
  ];
}

/** What the caller must do as a result. */
export type PauseEffect = 'none' | 'requestLock' | 'respawn' | 'save';

export interface PauseResult {
  readonly state: PauseState;
  readonly effect: PauseEffect;
}

export function pauseStep(state: PauseState, event: PauseEvent, ctx: PauseContext): PauseResult {
  const same: PauseResult = { state, effect: 'none' };

  switch (event.type) {
    case 'lockLost':
      if (state.open || ctx.overlayOpen || ctx.busy) return same;
      return { state: { open: true, openedAt: event.t }, effect: 'none' };

    case 'escKey':
      if (state.open) {
        if (event.t - state.openedAt < ESC_DEBOUNCE_MS) return same;
        // Closing by key cannot re-take the pointer (the browser blocks a
        // re-lock right after Esc); the hint line says to click instead.
        return { state: PAUSE_CLOSED, effect: 'none' };
      }
      if (ctx.overlayOpen || ctx.busy) return same;
      return { state: { open: true, openedAt: event.t }, effect: 'none' };

    case 'resume':
      if (!state.open) return same;
      return { state: PAUSE_CLOSED, effect: 'requestLock' };

    case 'returnToOrbit':
      if (!state.open) return same;
      return { state: PAUSE_CLOSED, effect: 'respawn' };

    case 'save':
      // Busy only blocks opening: a sheet that is up may still save.
      if (!state.open) return same;
      return { state, effect: 'save' };
  }
}

// =============================================================================
// [v4-net] Task 6 — the account in the pause sheet (R51, R54, R57) and the
// sync status under the account line.
// =============================================================================

export const DELETE_ACCOUNT_TEXT = 'DELETE ACCOUNT';
export const DELETE_ACCOUNT_CONFIRM_TEXT = 'DELETE ACCOUNT — PRESS AGAIN TO CONFIRM';

export interface DeleteAccountState {
  /** DELETE ACCOUNT was pressed once; the next press confirms. */
  readonly armed: boolean;
}

export const DELETE_DISARMED: DeleteAccountState = Object.freeze({ armed: false });

export type DeleteAccountEvent =
  /** R61: `repeat` — an auto-repeated key; it never arms and never confirms. */
  | { readonly kind: 'press'; readonly repeat?: boolean }
  | { readonly kind: 'other' }
  | { readonly kind: 'closed' };

export type DeleteAccountEffect = { readonly kind: 'none' } | { readonly kind: 'deleteAccount'; readonly confirmed: boolean };

/** Two presses, as NEW GAME on the title: any other button, or the sheet closing, disarms. */
export function deleteAccountStep(
  s: DeleteAccountState,
  e: DeleteAccountEvent,
): { state: DeleteAccountState; effect: DeleteAccountEffect } {
  if (e.kind !== 'press') return { state: DELETE_DISARMED, effect: { kind: 'none' } };
  if (e.repeat === true) return { state: s, effect: { kind: 'none' } };
  const confirmed = s.armed;
  return { state: { armed: !confirmed }, effect: { kind: 'deleteAccount', confirmed } };
}

export function deleteAccountLabel(s: DeleteAccountState): string {
  return s.armed ? DELETE_ACCOUNT_CONFIRM_TEXT : DELETE_ACCOUNT_TEXT;
}

export interface PauseAccountView {
  readonly line: string | null;
  readonly syncLine: string | null;
  readonly deleteAccount: boolean;
}

/**
 * What the sheet shows of the account. Signed in: the account line, the
 * sync status under it, DELETE ACCOUNT. A guest or a reader tab: nothing
 * (R57) — and the sheet never offers sign-in (the title does).
 */
export function pauseAccountView(account: AccountView, syncText: string | null): PauseAccountView {
  if (account.kind !== 'signed-in') return { line: null, syncLine: null, deleteAccount: false };
  return { line: signedInText(account.name), syncLine: syncText, deleteAccount: true };
}

export interface SyncNoticeWatch {
  /** The status text last logged (or reported at boot); null when there is none to repeat. */
  readonly lastText: string | null;
}

/** The boot's status: already in the boot notices, so it is not logged again. */
export function initialSyncNotice(_status: SyncStatus, text: string | null): SyncNoticeWatch {
  return { lastText: text };
}

/**
 * A status change logs its text once. A retry in flight ('pending') is not a
 * change; a status without text (synced, off) clears the watch, so the next
 * outage is logged again.
 */
export function syncNoticeStep(
  w: SyncNoticeWatch,
  status: SyncStatus,
  text: string | null,
): { watch: SyncNoticeWatch; notice: string | null } {
  if (status === 'pending') return { watch: w, notice: null };
  if (text === null) return { watch: w.lastText === null ? w : { lastText: null }, notice: null };
  if (text === w.lastText) return { watch: w, notice: null };
  return { watch: { lastText: text }, notice: text };
}
