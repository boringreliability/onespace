/**
 * Arrival frames (v3 T4, PLAN E6). After a jump neither the star (behind the
 * camera — the arrival offset points at it) nor the hero world (hidden until
 * its programs compile) used to be in frame. The fix compiles the world
 * during the tunnel (Universe, marked block); this is the predicate the
 * harness and the fallback use.
 */

import { Matrix4, Quaternion, Vector3 } from 'three';

const sRight = new Vector3();

/**
 * Is a subject in direction `toSubject` (unit), of angular radius
 * `angRadius`, inside a view looking along `fwd` with roof `up` and half
 * angles `halfH` / `halfV`?
 */
export function framesSubject(
  fwd: Vector3,
  up: Vector3,
  toSubject: Vector3,
  angRadius: number,
  halfH: number,
  halfV: number,
): boolean {
  const z = toSubject.dot(fwd);
  const right = sRight.crossVectors(fwd, up);
  const x = toSubject.dot(right);
  const y = toSubject.dot(up);
  if (z <= 0) {
    // Behind the camera plane: only a body big enough to reach past 90° shows.
    const off = Math.acos(Math.max(-1, Math.min(1, z)));
    return off - angRadius < Math.min(halfH, halfV);
  }
  const ah = Math.abs(Math.atan2(x, z));
  const av = Math.abs(Math.atan2(y, z));
  return ah - angRadius <= halfH && av - angRadius <= halfV;
}

/** The star sits this far above the nose in an open-space arrival. */
const OPEN_SPACE_STAR_ELEVATION = (18 * Math.PI) / 180;
const sNose = new Vector3();
const sUp = new Vector3();
const sM = new Matrix4();
const ZERO = new Vector3();

/**
 * Attitude for an arrival with no world to orbit: the nose 18° below the
 * star, roof towards it, so the chase camera frames the star above the hull
 * instead of hiding it exactly behind it. There is no orbit here, so there
 * is no prograde nose to keep.
 */
export function openSpaceArrivalAttitude(toStar: Vector3, out: Quaternion): Quaternion {
  const s = sNose.copy(toStar).normalize();
  // Any direction perpendicular to the star line for the roof.
  const hint = Math.abs(s.y) < 0.9 ? sUp.set(0, 1, 0) : sUp.set(1, 0, 0);
  hint.addScaledVector(s, -s.dot(hint)).normalize();
  // Nose = star rotated down (away from the roof) by the elevation.
  const e = OPEN_SPACE_STAR_ELEVATION;
  const nose = s.multiplyScalar(Math.cos(e)).addScaledVector(hint, -Math.sin(e)).normalize();
  // Roof: perpendicular to the nose, on the star's side.
  const roof = hint.addScaledVector(nose, -nose.dot(hint)).normalize();
  sM.lookAt(ZERO, nose, roof);
  return out.setFromRotationMatrix(sM).normalize();
}

export type ArrivalAim = 'world' | 'star' | 'none';

export function arrivalAim(s: { readonly worldDrawn: boolean; readonly starInFrame: boolean }): ArrivalAim {
  if (s.worldDrawn) return 'world';
  return s.starInFrame ? 'none' : 'star';
}
