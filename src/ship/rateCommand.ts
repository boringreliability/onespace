/**
 * [v3-T2] Rate-command rotation (PLAN §1 S2, phase B; D0).
 *
 * Under attitudeHold the stick is a RATE demand, and the flight computer flies
 * the body rate to it per axis:
 *
 *     ω̇ = clamp((e + sign(e)·floor)/τ, ±α),   e = ωcmd − ω
 *
 * - |ω| growing (spin-up): τ_up 0.22 s, α_max — the hull's own RCS α, which is
 *   also what FA-OFF / attitudeHold-off pilots get as torque.
 * - |ω| shrinking (stop, reversal to zero): τ_down 0.10 s, α_brake =
 *   2.5·α_max. Asymmetric on purpose (owner-approved): with a symmetric
 *   α 2.5 the kinematic minimum glide from 35°/s is ω²/2α = 4.28°, so D0's
 *   own ≤ 4° target is unreachable; the brake is the "sharp stop".
 * - `floor` (0.5°/s) turns the last degree into a finite time instead of an
 *   exponential tail, and the step is snapped so it never passes ωcmd.
 *
 * Pure: numbers in, number out. FlightModel calls it per 1/120 s substep.
 */

const DEG = Math.PI / 180;

export type RateAxis = 'pitch' | 'yaw' | 'roll';

export const RATE_TAU_UP = 0.22;
export const RATE_TAU_DOWN = 0.1;
/** D0 maxima, rad/s. */
export const MAX_RATE: Readonly<Record<RateAxis, number>> = Object.freeze({
  pitch: 35 * DEG,
  yaw: 28 * DEG,
  roll: 75 * DEG,
});
/** D0 spin-up limit, rad/s². The default hull's RCS is sized to exactly this. */
export const ALPHA_MAX: Readonly<Record<RateAxis, number>> = Object.freeze({ pitch: 2.5, yaw: 2.5, roll: 4 });
/** α_brake / α_max. */
export const BRAKE_ALPHA_FACTOR = 2.5;
/** Finite-time round-off of the last fraction of a degree per second, rad/s. */
export const RATE_SETTLE_FLOOR = 0.5 * DEG;

export interface RateTuning {
  readonly tauUp: number;
  readonly tauDown: number;
  readonly alphaUp: number;
  readonly alphaDown: number;
  readonly floor: number;
}

/** Tuning for one axis; `alpha` defaults to D0's α_max (a hull may pass its own). */
export function rateTuning(axis: RateAxis, alpha: number = ALPHA_MAX[axis]): RateTuning {
  return {
    tauUp: RATE_TAU_UP,
    tauDown: RATE_TAU_DOWN,
    alphaUp: alpha,
    alphaDown: alpha * BRAKE_ALPHA_FACTOR,
    floor: RATE_SETTLE_FLOOR,
  };
}

/** One step of the rate loop: the new ω after `h` seconds. */
export function rateCommand(w: number, wcmd: number, h: number, t: RateTuning, tauScale = 1): number {
  if (!(h > 0)) return w;
  const e = wcmd - w;
  if (e === 0 || !Number.isFinite(e)) return Number.isFinite(w) ? w : 0;
  // Spin-up when the correction grows |ω| (or ω is at rest).
  const up = w === 0 || (e > 0) === (w > 0);
  const tau = (up ? t.tauUp : t.tauDown) * tauScale;
  const alpha = up ? t.alphaUp : t.alphaDown;
  const s = e > 0 ? 1 : -1;
  let rate = (e + s * t.floor) / tau;
  if (rate > alpha) rate = alpha;
  else if (rate < -alpha) rate = -alpha;
  let next = w + rate * h;
  // Braking through zero towards a demand on the other side: brake to zero,
  // then spend the rest of the step spinning up with spin-up limits. (Not a
  // plain stop at zero: a disturbance that pushes ω back over zero every
  // substep — weathercocking in thick air — would then pin ω at 0 for good.)
  if (!up && wcmd !== 0 && (next > 0) !== (w > 0) && next !== 0) {
    const rest = h + w / rate; // h − time to reach zero (rate has the opposite sign of w)
    let r2 = (wcmd + s * t.floor) / (t.tauUp * tauScale);
    if (r2 > t.alphaUp) r2 = t.alphaUp;
    else if (r2 < -t.alphaUp) r2 = -t.alphaUp;
    next = r2 * rest;
  }
  // Never pass the demand.
  if ((wcmd - next) * s < 0) next = wcmd;
  return next;
}

/**
 * [v3-atmo] One step of the rate loop on a hull that also feels a KNOWN
 * angular acceleration `moment` (rad/s², body axis: weathercock, aero damping,
 * gyroscopic). The computer flies `rateCommand`'s path as if the moment were
 * not there and the RCS supplies the difference — up to α_brake, the most the
 * loop ever asks of it. Only the part of the moment beyond that moves ω off
 * the path, so in air the hull holds a released attitude, a demanded rate is
 * reached, and a moment the RCS cannot hold weathervanes the hull honestly.
 *
 * The old order (integrate the moment, then fly it back out) left a standing
 * error τ·M — the hull turned by itself with the stick released — and, for
 * α_max < M < α_brake, chattered ω across zero every substep. With
 * `moment` 0 this is `rateCommand`, bit for bit.
 */
export function rateCommandAgainst(
  w: number,
  wcmd: number,
  moment: number,
  h: number,
  t: RateTuning,
  tauScale = 1,
): number {
  const next = rateCommand(w, wcmd, h, t, tauScale);
  if (!(h > 0) || !Number.isFinite(moment) || moment === 0) return next;
  // RCS the path needs: (Δω/h) − moment.
  const need = (next - w) / h - moment;
  const cap = t.alphaDown;
  if (need <= cap && need >= -cap) return next;
  return w + ((need > 0 ? cap : -cap) + moment) * h;
}

// ---------------------------------------------------------------------------
// Steering against this plant (cruiseSteer, autopilot)
// ---------------------------------------------------------------------------

/**
 * Gain of the attitude loop around the rate command, (rad/s) per rad.
 *
 * With the rate loop as a first-order lag τ, ωdes = K·e closes to
 * τ·θ̈ + θ̇ + K·θ = 0, critically damped at K = 1/(4τ). An approach always
 * shrinks |ω|, so τ is τ_down: K = K_crit = 2.5, a double pole at 5 rad/s.
 * Measured against the 120 Hz loop with the steering running once per frame:
 * overshoot of a 90° turn < 1°, no limit cycle (< 0.2°/s settled). Far out, ωdes
 * saturates at the axis maximum, so a big turn is a constant-rate slew.
 */
export const STEER_RATE_GAIN = 2.5;

/**
 * Stick-equivalent command (−1..1) that asks the rate loop for K·error,
 * saturated at the axis maximum. `error` in rad, about the body axis.
 */
export function steerRate(error: number, maxRate: number, gain: number = STEER_RATE_GAIN): number {
  if (!(maxRate > 0) || !Number.isFinite(error)) return 0;
  const u = (gain * error) / maxRate;
  return u > 1 ? 1 : u < -1 ? -1 : u;
}

export interface AxisCommand {
  pitch: number;
  yaw: number;
  roll: number;
}

/**
 * `steerRate` on all three body axes at once, saturated JOINTLY: if any axis
 * would exceed full stick, all three are scaled down together, so the demanded
 * ω stays parallel to the error and a combined turn follows the short (great
 * circle) path instead of finishing one axis long before the other.
 */
export function steerRates(
  ex: number,
  ey: number,
  ez: number,
  out: AxisCommand,
  gain: number = STEER_RATE_GAIN,
): AxisCommand {
  let p = Number.isFinite(ex) ? (gain * ex) / MAX_RATE.pitch : 0;
  let y = Number.isFinite(ey) ? (gain * ey) / MAX_RATE.yaw : 0;
  let r = Number.isFinite(ez) ? (gain * ez) / MAX_RATE.roll : 0;
  const m = Math.max(1, Math.abs(p), Math.abs(y), Math.abs(r));
  p /= m;
  y /= m;
  r /= m;
  out.pitch = p;
  out.yaw = y;
  out.roll = r;
  return out;
}
