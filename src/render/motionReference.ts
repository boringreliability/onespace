/**
 * Motion blur's frame of reference — see motionReference.test.ts for the
 * measurement that motivated it.
 *
 * PostFX's reprojection assumes a world that stands still in render space.
 * Between floating-origin rebases it does not: a world and everything on it
 * sweep through render space at orbital speed. What the reprojection should
 * hold still is the ground the ship is over, so it is handed the displacement
 * of that patch of ground over the last frame and subtracts it.
 */

import { Quaternion, Vector3 } from 'three';

const scratchQ = new Quaternion();
const scratchV = new Vector3();

/**
 * How far the body-fixed point currently at `shipRel` (parent-relative,
 * world axes) moved between two frames, given the body's world position and
 * spin at each. Allocation-free; writes `out` and returns it.
 *
 *   anchor   = spin^-1 * shipRel                (body-fixed)
 *   was      = prevWorld + prevSpin * anchor
 *   is       = world + shipRel
 *   out      = is - was
 */
export function referenceDisplacement(
  prevWorld: Vector3,
  prevSpin: Quaternion,
  world: Vector3,
  spin: Quaternion,
  shipRel: Vector3,
  out: Vector3,
): Vector3 {
  // prevSpin * spin^-1 carries the point from where it is now back to where
  // it was, in the body's frame of a frame ago.
  scratchQ.copy(spin).invert().premultiply(prevSpin);
  scratchV.copy(shipRel).applyQuaternion(scratchQ);
  return out.copy(world).sub(prevWorld).add(shipRel).sub(scratchV);
}
