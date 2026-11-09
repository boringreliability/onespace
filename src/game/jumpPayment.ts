/**
 * v4 sub-plan 1 (propellant), Task 4 fix round 1 — paying for a jump.
 *
 * The one place a jump is judged affordable, paid, and refunded if the warp
 * rejects it (pilot abort, or a warp already running). Owns every log line
 * about the jump's authorisation. MapMode calls it with `warp.engage`.
 */

import { bus } from '@/core/EventBus';
import type { Propellant } from '@/ship/propellant';
import { applyAction } from '@/ship/travelCost';
import { JUMP_NO_SELECTION_HINT } from './jumpKey';

export interface PaidJumpInput {
  /** The tank the jump is paid from; null = a hull without one (jumps free, v3). */
  readonly tank: Propellant | null;
  readonly distanceLy: number;
  readonly name: string;
  /** False while a jump is already running: nothing is charged or asked. */
  readonly warpIdle: boolean;
  readonly engage: () => Promise<void>;
  /** The system jumped to, and the one the ship is in: the same id is no jump (I2). */
  readonly systemId?: string;
  readonly originId?: string | null;
}

export type PaidJumpOutcome = 'jumped' | 'refused' | 'busy' | 'aborted' | 'origin';

/** The ship is already in the target system: nothing to jump to. */
export function isOriginJump(systemId: string | undefined, originId: string | null | undefined): boolean {
  return systemId !== undefined && originId !== undefined && originId !== null && systemId === originId;
}

export async function paidJump(i: PaidJumpInput): Promise<PaidJumpOutcome> {
  if (!i.warpIdle) return 'busy';
  // The chart's Enter used to reach here with the origin selected and pay the
  // 4 % floor while the price cell read `--`. Same answer as the J key.
  if (isOriginJump(i.systemId, i.originId)) {
    bus.emit('log', { text: JUMP_NO_SELECTION_HINT, tone: 'normal' });
    return 'origin';
  }

  let paidKg = 0;
  if (i.tank) {
    const r = applyAction(i.tank, { kind: 'jump', distanceLy: i.distanceLy });
    if (!r.ok) {
      bus.emit('log', { text: 'JUMP · NO PROPELLANT', tone: 'warn' });
      return 'refused';
    }
    paidKg = r.kg;
  }
  bus.emit('log', { text: `JUMP AUTHORISED — ${i.name}`, tone: 'good' });

  try {
    await i.engage();
  } catch {
    // A cancelled jump is a normal outcome, not an error — and costs nothing (R11).
    if (i.tank && paidKg > 0) applyAction(i.tank, { kind: 'jump-refund', kg: paidKg });
    bus.emit('log', { text: 'JUMP ABORTED', tone: 'warn' });
    return 'aborted';
  }
  return 'jumped';
}
