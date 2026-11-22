/**
 * v4 sub-plan 6, Task 4 review fix (I-1) — which HUD blocks show over which
 * mode. Pure: the HUD applies it (ReviewGuard, registry.ts), tested in node.
 *
 * On the resources screen `hud`, `instruments` and `action-feed` sleep
 * (gating.ts), so the CARGO block and the MINE / REFINE / REPAIR rows would
 * stand still on what they said before the sheet opened — a CARGO 1 000 beside
 * the sheet's HOLD 0 after a jettison. DESIGN-6 §7.1: the sheet and the HUD
 * rows never say different things. So those two blocks are hidden while the
 * sheet is open; the log stays (the JETTISONED line is read there), and so does
 * the rest of the HUD (instruments, PROP). PROP's Δv depends on the hold's mass
 * (`extraMassKg`, which only Universe's tick updates), so after a jettison it
 * stands still behind the sheet and jumps when the screen closes; the sheet
 * itself shows no Δv, so the two never contradict each other.
 * Whether the HUD shows at all is ReviewGuard's (`flightMode`), not this rule's.
 */

import type { BaseMode } from '@/core/Modes';

export interface HudBlocks {
  readonly cargo: boolean;
  readonly actions: boolean;
  readonly log: boolean;
}

const SHOWN: HudBlocks = Object.freeze({ cargo: true, actions: true, log: true });
const UNDER_SHEET: HudBlocks = Object.freeze({ cargo: false, actions: false, log: true });

/** The blocks shown over `base` (one of two frozen answers: nothing is allocated). */
export function hudBlocks(base: BaseMode): HudBlocks {
  return base === 'resources' ? UNDER_SHEET : SHOWN;
}
