/**
 * Arrival frames (v3 T4, PLAN E6). After a jump neither the star (behind the
 * camera — the arrival offset points at it) nor the hero world (hidden until
 * its programs compile) used to be in frame. The fix compiles the world
 * during the tunnel (Universe, marked block); this is the predicate the
 * harness and the fallback use.
 */

import { Vector3 } from 'three';

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

export type ArrivalAim = 'world' | 'star' | 'none';

export function arrivalAim(s: { readonly worldDrawn: boolean; readonly starInFrame: boolean }): ArrivalAim {
  if (s.worldDrawn) return 'world';
  return s.starInFrame ? 'none' : 'star';
}
