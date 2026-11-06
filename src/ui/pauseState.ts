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
  | { readonly type: 'returnToOrbit' };

export interface PauseContext {
  /** A chart or the codex is up. They own Esc and release the pointer on purpose. */
  readonly overlayOpen: boolean;
  /** A jump or a recovery is running; neither can be paused into. */
  readonly busy: boolean;
}

/** What the caller must do as a result. */
export type PauseEffect = 'none' | 'requestLock' | 'respawn';

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
  }
}
