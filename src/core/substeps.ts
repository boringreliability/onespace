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
 * The invariant is `ENGINE_MAX_DT + FIXED_H ≤ MAX_SUBSTEPS · FIXED_H`: the
 * longest frame the engine hands out, plus the most the accumulator can carry
 * into it, always fits. Hence 9 substeps, not 8.
 */

/** Physics substep, s. 120 Hz survives a 25 g burn without visible error. */
export const FIXED_H = 1 / 120;
/** Ceiling on substeps per `FlightModel.update()` call. */
export const MAX_SUBSTEPS = 9;
/** The engine's dt clamp, s: a background tab or GC pause is not a 2 s burn. */
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
 * Conserves time: `steps·h + carry + dropped === acc + dt`. Time is dropped
 * only past the ceiling, and then in whole substeps so the carry keeps its
 * phase.
 */
export function substepBudget(
  acc: number,
  dt: number,
  h: number,
  maxSteps: number,
  out: SubstepBudget = { steps: 0, carry: 0, dropped: 0 },
): SubstepBudget {
  const a = Number.isFinite(acc) && acc > 0 ? acc : 0;
  out.dropped = 0;
  if (!(dt > 0) || !(h > 0)) {
    out.steps = 0;
    out.carry = a;
    return out;
  }
  let rem = a + dt;
  let steps = 0;
  while (rem >= h && steps < maxSteps) {
    rem -= h;
    steps++;
  }
  if (rem >= h) {
    const keep = rem % h;
    out.dropped = rem - keep;
    rem = keep;
  }
  out.steps = steps;
  out.carry = rem;
  return out;
}
