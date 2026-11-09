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

export interface PaidJumpInput {
  /** The tank the jump is paid from; null = a hull without one (jumps free, v3). */
  readonly tank: Propellant | null;
  readonly distanceLy: number;
  readonly name: string;
  /** False while a jump is already running: nothing is charged or asked. */
  readonly warpIdle: boolean;
  readonly engage: () => Promise<void>;
}

export type PaidJumpOutcome = 'jumped' | 'refused' | 'busy' | 'aborted';

export async function paidJump(i: PaidJumpInput): Promise<PaidJumpOutcome> {
  if (!i.warpIdle) return 'busy';

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
    if (i.tank && paidKg > 0) i.tank.add(paidKg);
    bus.emit('log', { text: 'JUMP ABORTED', tone: 'warn' });
    return 'aborted';
  }
  return 'jumped';
}
