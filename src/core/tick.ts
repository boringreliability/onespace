/**
 * The frame loop's module pass, as a pure function.
 *
 * Gating rules:
 * - A module without `activeIn` is always on (log, audio, codex — anything
 *   whose time must keep flowing). This is also the migration default: an
 *   unannotated v1 module behaves exactly as before.
 * - A module whose `activeIn` contains the base mode ticks. If an overlay is
 *   up and the module does not live in the overlay itself, it ticks with
 *   dt = 0: its scene stays current (cameras, transforms settle) but its
 *   simulation stands still. That is what photo mode means.
 * - A module active only in the overlay ticks with real dt.
 * - All updates run before any lateUpdate, in registration order.
 */

import type { BaseMode, Mode, Overlay } from './Modes';

export interface TickableModule<C> {
  readonly name: string;
  readonly activeIn?: readonly Mode[];
  update?(dt: number, ctx: C): void;
  lateUpdate?(dt: number, ctx: C): void;
}

export interface TickState {
  readonly base: BaseMode;
  readonly overlay: Overlay | null;
}

/** dt this module should see, or -1 when it sleeps. */
export function moduleDt(m: { activeIn?: readonly Mode[] }, s: TickState, dt: number): number {
  const on = m.activeIn;
  if (!on) return dt;
  if (s.overlay && on.includes(s.overlay)) return dt;
  if (on.includes(s.base)) return s.overlay ? 0 : dt;
  return -1;
}

export function tickModules<C>(
  modules: readonly TickableModule<C>[],
  state: TickState,
  dt: number,
  ctx: C,
): void {
  for (const m of modules) {
    const d = moduleDt(m, state, dt);
    if (d >= 0) m.update?.(d, ctx);
  }
  for (const m of modules) {
    const d = moduleDt(m, state, dt);
    if (d >= 0) m.lateUpdate?.(d, ctx);
  }
}
