/**
 * [v3-T1] Pure pieces of the chase camera. No allocation: every function
 * writes into an `out` the caller owns.
 *
 * STAGE-1 STUB: signatures only. Implemented in stage 2.
 */

import { Vector3 } from 'three';

/** 6t^5-15t^4+10t^3 has its steepest slope, 15/8, at t = 0.5. */
export const SMOOTHERSTEP_PEAK_SLOPE = 1.875;

export interface AnchorVelocity {
  /** The velocity the spring may follow, km/s. */
  readonly vel: Vector3;
  /** The excess, as a displacement this frame, km. Carried, never chased. */
  readonly teleport: Vector3;
  /** True when anything was cut off. */
  jumped: boolean;
}

/**
 * Bound the anchor's change of velocity to `aMax·dt`. Whatever exceeds it is
 * not motion but a discontinuity (lost time, a cruise drop, an attitude
 * snap): returned as a displacement so the caller moves the camera WITH it
 * instead of feeding it to the spring as an impulse.
 */
export function limitAnchorVelocity(
  prevVel: Vector3,
  rawVel: Vector3,
  dt: number,
  aMax: number,
  out: AnchorVelocity,
): AnchorVelocity {
  void prevVel;
  void rawVel;
  void dt;
  void aMax;
  void out;
  throw new Error('limitAnchorVelocity: not implemented (v3-T1 stage 1)');
}

/** First-order low-pass, frame-rate independent. Mutates and returns `state`. */
export function lowPassVec(state: Vector3, input: Vector3, dt: number, tau: number): Vector3 {
  void state;
  void input;
  void dt;
  void tau;
  throw new Error('lowPassVec: not implemented (v3-T1 stage 1)');
}

/**
 * Where the camera trails under a (filtered, proper) acceleration: the
 * steady-state deflection of a spring of natural frequency `omega` (rad/s),
 * `-a/ω²`, softly saturated by tanh so it approaches `lMax` and never
 * reaches it.
 */
export function chaseLagOffset(
  aFiltered: Vector3,
  omega: number,
  lMax: number,
  out: Vector3,
): Vector3 {
  void aFiltered;
  void omega;
  void lMax;
  void out;
  throw new Error('chaseLagOffset: not implemented (v3-T1 stage 1)');
}

/**
 * The subject's distance from frame centre as a fraction of the half-frame:
 * 1 is the frame edge (an ellipse in angle, through the edge midpoints).
 * Infinity when the subject is behind the camera.
 */
export function subjectFrameRadius(
  aimDir: Vector3,
  toSubject: Vector3,
  up: Vector3,
  halfFovY: number,
  aspect: number,
): number {
  void aimDir;
  void toSubject;
  void up;
  void halfFovY;
  void aspect;
  throw new Error('subjectFrameRadius: not implemented (v3-T1 stage 1)');
}

/**
 * Turn `aimDir` towards the subject just enough that the subject's frame
 * radius stays under `margin` (default 0.6), softly from `2/3·margin` (0.4).
 * Inside the soft radius the aim is returned unchanged. Writes a unit vector.
 */
export function constrainAimToFrame(
  out: Vector3,
  aimDir: Vector3,
  toSubject: Vector3,
  up: Vector3,
  halfFovY: number,
  aspect: number,
  margin = 0.6,
): Vector3 {
  void out;
  void aimDir;
  void toSubject;
  void up;
  void halfFovY;
  void aspect;
  void margin;
  throw new Error('constrainAimToFrame: not implemented (v3-T1 stage 1)');
}

/**
 * Interpolate two offsets from a centre in spherical coordinates: the radius
 * linearly, the direction along the great circle. A blend between two camera
 * positions on opposite sides of the hull swings round it instead of passing
 * through it.
 */
export function sphericalLerp(out: Vector3, a: Vector3, b: Vector3, t: number): Vector3 {
  void out;
  void a;
  void b;
  void t;
  throw new Error('sphericalLerp: not implemented (v3-T1 stage 1)');
}

/**
 * Duration of a smootherstep blend that turns through `angleRad` without ever
 * exceeding `maxRateRad` per second, and lasts at least `minSeconds`.
 */
export function blendSeconds(angleRad: number, minSeconds: number, maxRateRad: number): number {
  void angleRad;
  void minSeconds;
  void maxRateRad;
  throw new Error('blendSeconds: not implemented (v3-T1 stage 1)');
}
