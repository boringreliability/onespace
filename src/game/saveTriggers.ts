/**
 * What triggers a save now (v4 sub-plan 3, Task 5; DESIGN §5.2). Pure.
 *
 *  - `emergency`, `hidden`, `manual` and `leave` always save: the exit is paid
 *    for, a hidden tab may never come back, the pilot asked, nothing ticks
 *    where the pilot is going.
 *  - `landed`, `mined` and `system` save only when at least
 *    AUTOSAVE_MIN_GAP_S have passed since the last save.
 *  - `interval` saves every AUTOSAVE_INTERVAL_S.
 *
 * `sinceLastS` is +Infinity before the first save. A broken clock (NaN or
 * negative) never adds an autosave; the always-reasons still save.
 */

export const AUTOSAVE_INTERVAL_S = 120;
export const AUTOSAVE_MIN_GAP_S = 5;

/** `leave`: flight/map left for the Yard or the title (R14/R15) — always saves. */
export type SaveReason = 'landed' | 'mined' | 'emergency' | 'system' | 'interval' | 'hidden' | 'manual' | 'leave';

export function shouldAutosave(s: { sinceLastS: number; reason: SaveReason }): boolean {
  switch (s.reason) {
    case 'emergency':
    case 'hidden':
    case 'manual':
    case 'leave':
      return true;
    case 'interval':
      return s.sinceLastS >= AUTOSAVE_INTERVAL_S;
    case 'landed':
    case 'mined':
    case 'system':
      return s.sinceLastS >= AUTOSAVE_MIN_GAP_S;
  }
}
