/**
 * [v3-T1] The fixed-step budget, shared by the engine's dt clamp and the
 * flight model's accumulator so the two can never disagree again.
 *
 * v2 clamped the engine at 1/15 s and the accumulator at 8 × 1/120 s — the
 * same number, which looked safe and was not: the accumulator also carries up
 * to one substep from the previous frame, so a 66.7 ms frame threw away up to
 * 8.3 ms of ship time while the world and the camera went the full frame. The
 * chase camera read that as a 4 km/s velocity spike (docs/v3/PLAN.md §1).
 *
 * STAGE-1 STUB: signatures only. Implemented in stage 2.
 */

/** Physics substep, s. */
export const FIXED_H = 1 / 120;
/** Ceiling on substeps per `FlightModel.update()` call. */
export const MAX_SUBSTEPS = 8;
/** The engine's dt clamp, s. */
export const ENGINE_MAX_DT = 1 / 15;

export interface SubstepBudget {
  /** Substeps to take this call. */
  steps: number;
  /** Time left in the accumulator afterwards, s. Always in [0, h). */
  carry: number;
  /** Time discarded, s. Zero for any dt the engine can produce. */
  dropped: number;
}

/**
 * How to spend `acc + dt` in substeps of `h`, at most `maxSteps`.
 * Conserves time: `steps·h + carry + dropped === acc + dt`.
 */
export function substepBudget(
  acc: number,
  dt: number,
  h: number,
  maxSteps: number,
  out: SubstepBudget = { steps: 0, carry: 0, dropped: 0 },
): SubstepBudget {
  void acc;
  void dt;
  void h;
  void maxSteps;
  void out;
  throw new Error('substepBudget: not implemented (v3-T1 stage 1)');
}
