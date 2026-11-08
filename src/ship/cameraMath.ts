/**
 * [v3-T1] Pure pieces of the chase camera. No allocation: every function
 * writes into an `out` the caller owns (module scratch is used internally and
 * never escapes a call).
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
  const px = prevVel.x;
  const py = prevVel.y;
  const pz = prevVel.z;
  const rx = rawVel.x;
  const ry = rawVel.y;
  const rz = rawVel.z;
  if (!(dt > 0)) {
    out.vel.set(px, py, pz);
    out.teleport.set(0, 0, 0);
    out.jumped = false;
    return out;
  }
  const dx = rx - px;
  const dy = ry - py;
  const dz = rz - pz;
  const dv = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const maxDv = Math.max(0, aMax) * dt;
  if (dv <= maxDv) {
    out.vel.set(rx, ry, rz);
    out.teleport.set(0, 0, 0);
    out.jumped = false;
    return out;
  }
  const k = maxDv / dv;
  out.vel.set(px + dx * k, py + dy * k, pz + dz * k);
  out.teleport.set((rx - out.vel.x) * dt, (ry - out.vel.y) * dt, (rz - out.vel.z) * dt);
  out.jumped = true;
  return out;
}

/** First-order low-pass, frame-rate independent. Mutates and returns `state`. */
export function lowPassVec(state: Vector3, input: Vector3, dt: number, tau: number): Vector3 {
  if (!(dt > 0)) return state;
  const k = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
  state.x += (input.x - state.x) * k;
  state.y += (input.y - state.y) * k;
  state.z += (input.z - state.z) * k;
  return state;
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
  const a = aFiltered.length();
  if (!(a > 1e-12) || !(lMax > 0)) return out.set(0, 0, 0);
  const mag = omega > 0 ? lMax * Math.tanh(a / (omega * omega * lMax)) : lMax;
  return out.copy(aFiltered).multiplyScalar(-mag / a);
}

const sF = new Vector3();
const sR = new Vector3();
const sU = new Vector3();
const sS = new Vector3();
const sAxis = new Vector3();
const sTry = new Vector3();
const sA = new Vector3();
const sB = new Vector3();

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
  const f = sF.copy(aimDir).normalize();
  const r = sR.crossVectors(f, up);
  if (r.lengthSq() < 1e-12) {
    r.set(1, 0, 0).cross(f);
    if (r.lengthSq() < 1e-12) r.set(0, 0, 1).cross(f);
  }
  r.normalize();
  const u = sU.crossVectors(r, f);
  const s = sS.copy(toSubject).normalize();
  const z = s.dot(f);
  if (z <= 1e-9) return Infinity;
  const tanY = Math.tan(halfFovY);
  const tanX = tanY * aspect;
  return Math.hypot(s.dot(r) / z / tanX, s.dot(u) / z / tanY);
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
  const aim = sA.copy(aimDir).normalize();
  const subj = sB.copy(toSubject).normalize();
  const rho = subjectFrameRadius(aim, subj, up, halfFovY, aspect);
  const soft = (2 / 3) * margin;
  if (!(rho > soft)) return out.copy(aim);
  const band = margin - soft;
  const want = Number.isFinite(rho) ? soft + band * Math.tanh((rho - soft) / band) : margin;

  // Great circle from the aim to the subject; bisect the turn that lands the
  // subject's radius on `want`. Radius falls as the aim closes on the subject.
  const theta = Math.acos(Math.max(-1, Math.min(1, aim.dot(subj))));
  const axis = sAxis.crossVectors(aim, subj);
  if (axis.lengthSq() < 1e-14) {
    axis.crossVectors(up, aim);
    if (axis.lengthSq() < 1e-14) axis.set(1, 0, 0).cross(aim);
  }
  axis.normalize();
  let lo = 0;
  let hi = theta;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    sTry.copy(aim).applyAxisAngle(axis, mid);
    if (subjectFrameRadius(sTry, subj, up, halfFovY, aspect) > want) lo = mid;
    else hi = mid;
  }
  return out.copy(aim).applyAxisAngle(axis, hi).normalize();
}

/**
 * Interpolate two offsets from a centre in spherical coordinates: the radius
 * linearly, the direction along the great circle. A blend between two camera
 * positions on opposite sides of the hull swings round it instead of passing
 * through it.
 */
export function sphericalLerp(out: Vector3, a: Vector3, b: Vector3, t: number): Vector3 {
  const ra = a.length();
  const rb = b.length();
  if (ra < 1e-12 || rb < 1e-12) return out.lerpVectors(a, b, t);
  const ua = sA.copy(a).divideScalar(ra);
  const ub = sB.copy(b).divideScalar(rb);
  const r = ra + (rb - ra) * t;
  const c = Math.max(-1, Math.min(1, ua.dot(ub)));
  const th = Math.acos(c);
  if (th < 1e-7) return out.copy(ua).multiplyScalar(r);
  if (Math.PI - th < 1e-6) {
    const axis = sAxis.set(0, 1, 0).cross(ua);
    if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0).cross(ua);
    axis.normalize();
    return out.copy(ua).applyAxisAngle(axis, th * t).multiplyScalar(r);
  }
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return out.set(ua.x * wa + ub.x * wb, ua.y * wa + ub.y * wb, ua.z * wa + ub.z * wb).multiplyScalar(r);
}

/**
 * Duration of a smootherstep blend that turns through `angleRad` without ever
 * exceeding `maxRateRad` per second, and lasts at least `minSeconds`.
 */
export function blendSeconds(angleRad: number, minSeconds: number, maxRateRad: number): number {
  if (!Number.isFinite(angleRad) || !(angleRad > 0) || !(maxRateRad > 0)) return minSeconds;
  return Math.max(minSeconds, (SMOOTHERSTEP_PEAK_SLOPE * angleRad) / maxRateRad);
}
