/**
 * A world's spin as a vector (v3 polish, D22a). Pure, allocation-free.
 *
 * Universe turns each body by `axisAngle((sin tilt, cos tilt, 0), 2π·t/P)`
 * (`updateOrbits`) while the parent frame the ship flies in stays put, so the
 * ground at parent-relative r moves at ω×r. These two functions are that
 * fact, for the autopilot (land WITH the ground) and the touchdown (grade and
 * keep the slip against it).
 */

import type { Vector3 } from 'three';

/**
 * Angular velocity, rad/s, in the parent frame. A negative period is
 * retrograde; a zero or non-finite one does not turn.
 */
export function spinAngularVelocity(rotationPeriodS: number, axialTiltRad: number, out: Vector3): Vector3 {
  if (!Number.isFinite(rotationPeriodS) || rotationPeriodS === 0) return out.set(0, 0, 0);
  const tilt = Number.isFinite(axialTiltRad) ? axialTiltRad : 0;
  // (sin t, cos t, 0) is already unit length.
  const w = (2 * Math.PI) / rotationPeriodS;
  return out.set(Math.sin(tilt) * w, Math.cos(tilt) * w, 0);
}

/** Velocity of the ground (or anything fixed to the world) at `pos`: ω × pos. */
export function groundVelocity(omega: Vector3, pos: Vector3, out: Vector3): Vector3 {
  return out.crossVectors(omega, pos);
}
