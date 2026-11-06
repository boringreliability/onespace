/**
 * Orbit insertion — how the cruise drive lets go.
 *
 * v1 handed the flight model 60 km/s along the nose at 3 000 km clearance:
 * fifty seconds to the surface, 750 s of brake to stop (GAMEPLAY.md B4). v2
 * ends the drop in a circular orbit instead.
 *
 * THIS IS THE ONE DELIBERATE CHEAT IN THE CRUISE MODEL, moved rather than
 * added: CRUISE.md already accepted that the drop bleeds a 500c ceiling to a
 * sublight speed in 0.9 s, which no physics allows. The bleed now ends at the
 * circular speed √(μ/r) (`CruiseInputs.exitSpeedKmS`), and at the handover the
 * velocity's *direction* is replaced by the tangent in the plane of (r, v).
 * The magnitude change at the handover is therefore small; the direction
 * change is the cheat, and it is made here and nowhere else.
 *
 * Frames. The ship's velocity is parent-relative (SOI.md), so the circular
 * velocity about the parent is written straight into it with no conversion,
 * and `FlightModel.rebase()` stays the only place frames are crossed. The
 * drive's arrival threshold is pulled inside 0.9 of the target's SOI
 * (`arrivalClearanceKm`), and SOI entry happens at 0.98 with ≤ 0.6 % of the gap
 * per frame, so on arrival the parent *is* the target. For the ~2 % of moons
 * whose SOI is too small to arrive inside, the orbit is about whatever the
 * parent is — still an orbit, never a crash.
 */

import { Vector3 } from 'three';
import type { FlightModel } from './FlightModel';

/** Circular orbital speed, km/s. Zero without a gravity source. */
export function circularSpeed(mu: number, r: number): number {
  if (!(mu > 0) || !(r > 0)) return 0;
  return Math.sqrt(mu / r);
}

/**
 * Weight of the ecliptic fallback in the tangent direction. Small enough that
 * any real sideways motion decides the plane, large enough that a dead-radial
 * dive still gets a well-defined one. Continuous, so there is no threshold at
 * which the orbit plane flips.
 */
const ECLIPTIC_BLEND = 0.05;

const sR = new Vector3();
const sT = new Vector3();
const sF = new Vector3();
const UP = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);

/**
 * Prograde in the ecliptic at parent-relative `rHat` — the same convention as
 * `FlightModel.orbitalVelocityAt`, so a fallback orbit turns the way a spawned
 * one does.
 */
export function eclipticTangent(rHat: Vector3, out: Vector3): Vector3 {
  out.crossVectors(UP, rHat);
  if (out.lengthSq() < 1e-12) out.crossVectors(X, rHat);
  return out.normalize();
}

/**
 * The circular velocity about the ship's parent at its current position, in
 * the parent's frame: magnitude √(μ/r), direction the part of the ship's own
 * velocity perpendicular to r (blended towards the ecliptic prograde when that
 * part vanishes). Zero without a gravity source.
 */
export function circularExitVelocity(flight: FlightModel, out: Vector3): Vector3 {
  const mu = flight.parent?.mu ?? 0;
  const r = flight.position.length();
  const vc = circularSpeed(mu, r);
  if (vc === 0) return out.set(0, 0, 0);

  sR.copy(flight.position).multiplyScalar(1 / r);
  // Under cruise the velocity is the nose times a scalar; at zero speed the
  // nose still says where the pilot meant to go.
  const v = flight.velocity.lengthSq() > 1e-18 ? flight.velocity : flight.forward;
  sT.copy(v).addScaledVector(sR, -v.dot(sR));
  const vLen = v.length();
  eclipticTangent(sR, sF);
  sT.addScaledVector(sF, ECLIPTIC_BLEND * vLen);
  // Re-project: the blend term is already tangential, but rounding is not.
  sT.addScaledVector(sR, -sT.dot(sR));
  if (sT.lengthSq() < 1e-24) sT.copy(sF);
  return out.copy(sT).normalize().multiplyScalar(vc);
}

const sOut = new Vector3();

/**
 * Leave cruise in a circular orbit. Returns false, changing nothing, when
 * there is no gravity source to orbit — deep space keeps the legacy sublight
 * exit along the nose.
 */
export function insertIntoOrbit(flight: FlightModel): boolean {
  circularExitVelocity(flight, sOut);
  if (sOut.lengthSq() === 0) return false;
  // A change of motion, not of frame: the velocity is parent-relative.
  flight.exitCruiseWithVelocity(sOut);
  return true;
}
