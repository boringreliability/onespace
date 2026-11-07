/**
 * [v3-T2] Shaping for the FA-ON computer (PLAN §1 A3, phase B). Pure.
 *
 * Audit: the assist actuator went 0 → 20 g in one 1/120 s substep, the speed
 * overshot +20 % after a 55° turn, and the Space stop ended in a ~2.3 s
 * exponential tail. Three pieces fix that:
 *
 *  - `actuatorStep`: a first-order actuator (τa 0.15 s) with a slew bound of
 *    a_max/τa, so the per-substep change of thrust is bounded (~136 g/s on
 *    the main axis instead of ~2400 g/s).
 *  - `OVERSPEED_CUT`: main drive is withheld while |v| > 1.02·v_set.
 *  - `stopDecel`: the stop's deceleration demand, "rounded √": the full cap
 *    while far from rest, then √(2·J·e) — the time-optimal taper for a
 *    jerk-limited actuator, J = a_cap/τa — then linear (e/τmin) for the last
 *    metres per second, so the end is fast but discrete-stable.
 *
 * FlightModel feeds these a LEAD-COMPENSATED error (v + τa·a_out): since
 * d/dt(v + τa·a) = a_demand for a first-order actuator, the lag cannot turn
 * any of these profiles into an overshoot.
 */

export const ASSIST_ACTUATOR_TAU = 0.15;
export const OVERSPEED_CUT = 1.02;
/** Linear end of the stop profile, s. Six substeps: stable and quick. */
export const STOP_TAU_MIN = 0.05;

/**
 * One substep of the actuator: first-order towards `demand` with time
 * constant `tauA`, the change bounded by `aMax·h/tauA`. Never passes the demand.
 */
export function actuatorStep(
  current: number,
  demand: number,
  h: number,
  aMax: number,
  tauA: number = ASSIST_ACTUATOR_TAU,
): number {
  if (!(h > 0)) return current;
  const bound = (aMax * h) / tauA;
  let d = ((demand - current) * h) / tauA;
  if (d > bound) d = bound;
  else if (d < -bound) d = -bound;
  return current + d;
}

/** Deceleration magnitude demanded for a speed error `err` (km/s) towards rest. */
export function stopDecel(
  err: number,
  aCap: number,
  tauA: number = ASSIST_ACTUATOR_TAU,
  tauMin: number = STOP_TAU_MIN,
): number {
  if (!(err > 0) || !(aCap > 0)) return 0;
  const jerk = aCap / tauA;
  return Math.min(aCap, Math.sqrt(2 * jerk * err), err / tauMin);
}
