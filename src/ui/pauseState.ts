/**
 * The pause overlay's state machine. Pure; `ui/Pause.ts` owns the DOM.
 *
 * Esc reaches us two ways: as a lost pointer lock (the browser swallows the key
 * while the pointer is captured) and as a keydown (when it is not) — and on
 * some browsers as both, milliseconds apart. One press must be one press, so a
 * keydown just after a lock-loss open is ignored.
 */

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
