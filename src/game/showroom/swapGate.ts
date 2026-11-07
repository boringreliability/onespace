/**
 * When the Yard may cut, and what it warms up afterwards. Pure, so it is
 * tested without a window (swapGate.test.ts).
 */

import type { ShipParams } from '@/gen/ships/blueprint';

import { stepSeed, toShipParams, type YardSelection } from './catalog';

/**
 * How long the veil may hold on black waiting for a worker before the cut
 * goes ahead and builds the hull in place. A hull is 30-75 ms on a worker and
 * a pool of two is never more than a couple deep, so this only trips on a
 * worker that is wedged or gone — and then a one-off main-thread build beats
 * a black screen that reads as a hang.
 */
export const SWAP_MAX_WAIT_MS = 1200;

/**
 * Whether the cut may happen `elapsedMs` after the fade started: the veil must
 * be black, and the blueprint either ready or waited for long enough.
 *
 * `sinceAskedMs` is how long ago the hull now selected was asked for. Holding
 * → asks for a new hull on every key repeat while the veil stays black, and
 * the ceiling must run from the LAST ask — measured from the fade alone, a
 * long hold would trip it and build in place on the main thread, which is the
 * stall this whole path exists to remove.
 */
export function mayCut(
  elapsedMs: number,
  fadeMs: number,
  blueprintReady: boolean,
  sinceAskedMs: number = Infinity,
): boolean {
  if (elapsedMs < fadeMs) return false;
  return blueprintReady || Math.min(elapsedMs - fadeMs, sinceAskedMs) >= SWAP_MAX_WAIT_MS;
}

/** The hulls one → and one ← away: what the player is likeliest to ask for next. */
export function seedNeighbours(sel: YardSelection): [ShipParams, ShipParams] {
  return [toShipParams(stepSeed(sel, 1)), toShipParams(stepSeed(sel, -1))];
}
