/**
 * Motion blur's frame of reference.
 *
 * PostFX reprojects every pixel through last frame's view-projection, which
 * assumes the world stood still in render space. It does not: the floating
 * origin only rebases every so often, and between rebases a landed ship, its
 * world and the camera all travel together at orbital speed. Measured on the
 * home world's moon, the camera moved 0.9 km in render space per frame, so the
 * reprojection saw a 0.9 km dolly that never happened and smeared the hull
 * and the near ground into the "grainy grey" of the landed frame.
 *
 * The reference is the patch of ground under the ship: where that point of the
 * world went between the two frames, everything near the ship went too.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { referenceDisplacement } from './motionReference';

const R = 1000;

describe('referenceDisplacement', () => {
  it('Given a world that only translated, When asked, Then the displacement is the translation', () => {
    const q = new Quaternion();
    const out = referenceDisplacement(
      new Vector3(0, 0, 0), q,
      new Vector3(0.9, 0, 0.1), q,
      new Vector3(0, R, 0),
      new Vector3(),
    );
    expect(out.distanceTo(new Vector3(0.9, 0, 0.1))).toBeLessThan(1e-12);
  });

  it('Given a world that also turned, When asked for a point on its equator, Then the displacement includes the surface speed', () => {
    const axis = new Vector3(0, 1, 0);
    const prev = new Quaternion();
    const now = new Quaternion().setFromAxisAngle(axis, 1e-3);
    // The ship's parent-relative position NOW, on the equator.
    const ship = new Vector3(R, 0, 0).applyQuaternion(now);
    const out = referenceDisplacement(new Vector3(), prev, new Vector3(), now, ship, new Vector3());
    // A 1 mrad turn moves the equator ~1 km.
    expect(out.length()).toBeCloseTo(R * 1e-3, 3);
    // Where that ground was last frame plus the displacement is where it is now.
    expect(new Vector3(R, 0, 0).add(out).distanceTo(ship)).toBeLessThan(1e-9);
  });

  it('Given no motion at all, When asked, Then the displacement is zero', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.4);
    const out = referenceDisplacement(new Vector3(5, 6, 7), q, new Vector3(5, 6, 7), q, new Vector3(0, R, 0), new Vector3());
    expect(out.length()).toBeLessThan(1e-12);
  });
});
