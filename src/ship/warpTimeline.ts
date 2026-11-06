/**
 * The warp's timeline, in seconds — the one source both the jump and the
 * chart's "JUMP EST" read.
 *
 * Pure: no three.js, no DOM. `Warp.ts` drives its whole sequence from these
 * landmarks; `StarMap.ts` turns them into the estimate it prints. They used to
 * be two unrelated numbers (7.4 s versus 22 s + 41 s/ly) and the chart was
 * wrong by a factor of eight.
 */

const CHARGE = 2.0;
const FLASH = 0.4;
const TUNNEL = 2.5;
const ARRIVE = 1.0;
const TAIL = 1.5;

export const WARP_TIMELINE = {
  charge: CHARGE,
  flash: FLASH,
  tunnel: TUNNEL,
  arrive: ARRIVE,
  tail: TAIL,
  /** Unwind time for an aborted charge. Not part of a completed jump. */
  abort: 0.7,
  /** The flash fires here. */
  tunnelAt: CHARGE,
  /** The tunnel body starts after the flash. */
  tunnelBodyAt: CHARGE + FLASH,
  /** World swap happens here — the moment `Warp.engage()` resolves. */
  arriveAt: CHARGE + FLASH + TUNNEL,
  /** End of the arrival beat. */
  endAt: CHARGE + FLASH + TUNNEL + ARRIVE,
  /** The tail is the drive settling; the sequence is over here. */
  doneAt: CHARGE + FLASH + TUNNEL + ARRIVE + TAIL,
} as const;

/** Wall-clock length of a completed jump, seconds. */
export const WARP_TOTAL_SECONDS = WARP_TIMELINE.doneAt;

/**
 * What the chart promises for a jump of `distanceLy`.
 *
 * The drive is a fixed sequence — distance changes where you arrive, not how
 * long it takes — so the honest estimate is the sequence's length. The
 * distance is still taken so the call site stays right if that ever changes.
 */
export function jumpEstimateSeconds(_distanceLy: number): number {
  return WARP_TOTAL_SECONDS;
}
