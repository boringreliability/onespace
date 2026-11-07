/**
 * Traffic legibility and scale through motion — the pure parts (v3 T4,
 * PLAN E3-E4). Ship-local axes: -Z nose, +Y roof, +X starboard.
 */

import { Quaternion, Vector3 } from 'three';
import { progradeAttitude } from './recovery';

/** Contact 0 sits this far above the nose in the opening frame. */
export const CONTACT_ELEVATION_RAD = (15 * Math.PI) / 180;
/** And this far away, km. */
export const CONTACT_RANGE_KM: readonly [number, number] = [1.5, 2.5];

export const TRAFFIC_THROTTLE_MIN = 0.15;
export const TRAFFIC_THROTTLE_MAX = 0.3;

const sRoof = new Vector3();

export function contactRangeKm(u01: number): number {
  const u = Number.isFinite(u01) ? Math.min(1, Math.max(0, u01)) : 0.5;
  return CONTACT_RANGE_KM[0] + (CONTACT_RANGE_KM[1] - CONTACT_RANGE_KM[0]) * u;
}

/** Offset (km) from the player to contact 0: `elevation` above the nose, in the nose-roof plane. */
export function openingContactOffset(nose: Vector3, roof: Vector3, rangeKm: number, out: Vector3): Vector3 {
  const f = out.copy(nose).normalize();
  const u = sRoof.copy(roof).addScaledVector(f, -f.dot(roof));
  if (u.lengthSq() < 1e-12) u.set(0, 1, 0).addScaledVector(f, -f.y);
  u.normalize();
  return f
    .multiplyScalar(Math.cos(CONTACT_ELEVATION_RAD))
    .addScaledVector(u, Math.sin(CONTACT_ELEVATION_RAD))
    .multiplyScalar(rangeKm);
}

/** Velocity of a point rigidly rotating at `rate` about `axis`: rate · (axis × r). */
export function coOrbitVelocity(axis: Vector3, rate: number, local: Vector3, out: Vector3): Vector3 {
  return out.crossVectors(axis, local).multiplyScalar(rate);
}

/** Nose along the velocity, roof radially out. */
export function hullAttitude(velocity: Vector3, radialOut: Vector3, out: Quaternion): Quaternion {
  return progradeAttitude(velocity, radialOut, out);
}

/**
 * The drive at a working idle: a slow, aperiodic breathe in the band. Two
 * incommensurate sines; the fastest term is ~0.6 Hz so the per-frame change
 * stays well below a visible step.
 */
export function trafficThrottle(t: number, phase: number): number {
  const p = phase * 6.2831853;
  const s = 0.55 * Math.sin(t * 0.83 + p) + 0.3 * Math.sin(t * 2.17 + p * 2.3) + 0.15 * Math.sin(t * 3.71 + p * 4.1);
  const k = 0.5 + 0.5 * s; // 0..1
  return TRAFFIC_THROTTLE_MIN + (TRAFFIC_THROTTLE_MAX - TRAFFIC_THROTTLE_MIN) * k;
}

export interface HullSway {
  /** Yaw about the hull's +Y, radians. */
  yawRad: number;
  /** Lateral station-keeping drift along +X, metres. */
  lateralM: number;
  /** RCS yaw command, -1..1; non-zero only during a puff. */
  rcsYaw: number;
  /** Ship-local RCS command for the drive state (the puff's visible jets). */
  readonly rcs: Vector3;
}

const SWAY_AMP_RAD = (2.5 * Math.PI) / 180;
/** |sin| above which the swing is near its turnaround and RCS fires. */
const PUFF_THRESHOLD = 0.96;

/**
 * Slow attitude sway with RCS puffs at the turnarounds. A harmonic swing has
 * its angular acceleration at the extremes, opposing the displacement — that
 * is when a station-keeping computer would fire, so that is when it puffs.
 * Period grows with √length: a 1 km hull takes ~3× as long as a 100 m one.
 */
export function hullSway(t: number, lengthKm: number, phase: number, out?: HullSway): HullSway {
  const o = out ?? { yawRad: 0, lateralM: 0, rcsYaw: 0, rcs: new Vector3() };
  const len = Number.isFinite(lengthKm) && lengthKm > 0 ? lengthKm : 0.1;
  const period = 40 * Math.sqrt(len / 0.1); // s
  const w = (2 * Math.PI) / period;
  const a = w * t + phase * 6.2831853;
  const s = Math.sin(a);
  o.yawRad = SWAY_AMP_RAD * s;
  o.lateralM = 0.004 * len * 1000 * Math.sin(a * 0.5 + 1.3);
  const over = Math.abs(s) - PUFF_THRESHOLD;
  o.rcsYaw = over > 0 ? -Math.sign(s) * Math.min(1, over / (1 - PUFF_THRESHOLD)) : 0;
  // A yaw couple shows on the lateral jets.
  o.rcs.set(o.rcsYaw, 0, 0);
  return o;
}
