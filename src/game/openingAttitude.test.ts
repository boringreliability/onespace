/**
 * The opening frame.
 *
 * Track D made the spawn nose prograde (GAMEPLAY F8). At 1.6 R the limb then
 * sits ~51° below the nose and the chase camera (±31° vertical) frames only
 * stars — an empty black opening shot, a failure state per ARCHITECTURE §6.
 * The opening attitude pitches the nose down towards the limb by a fixed
 * angle: still mostly prograde, so W is "faster along the orbit", not a dive.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { OPENING_PITCH_DOWN_RAD, openingAttitude } from './recovery';

const r = new Vector3(0, 0, 1.6 * 7240); // ship position, planet-centred
const v = new Vector3(5, 0, 0); // prograde along +x
const nose = (q: Quaternion) => new Vector3(0, 0, -1).applyQuaternion(q);

describe('openingAttitude', () => {
  it('Given the opening orbit, Then the nose is still mostly prograde (W accelerates along the orbit)', () => {
    const n = nose(openingAttitude(v, r));
    expect(n.dot(v.clone().normalize())).toBeCloseTo(Math.cos(OPENING_PITCH_DOWN_RAD), 6);
    expect(n.dot(v.clone().normalize())).toBeGreaterThan(0.8);
  });

  it('Given the opening orbit, Then the nose is pitched down towards the world, not up and not sideways', () => {
    const n = nose(openingAttitude(v, r));
    expect(n.dot(r.clone().normalize())).toBeCloseTo(-Math.sin(OPENING_PITCH_DOWN_RAD), 6);
    expect(Math.abs(n.y)).toBeLessThan(1e-9); // stays in the orbit plane
  });

  it('Given 1.6 R, Then the limb lies inside a 31° half-angle chase view below the nose', () => {
    const horizonDepression = Math.acos(1 / 1.6); // ≈ 51.3°
    const limbBelowNose = horizonDepression - OPENING_PITCH_DOWN_RAD;
    expect(limbBelowNose).toBeGreaterThan(0.1); // the limb is not dead centre
    expect(limbBelowNose).toBeLessThan((31 * Math.PI) / 180);
  });

  it('Given the opening attitude, Then the roof points away from the world (no rolled horizon)', () => {
    const roof = new Vector3(0, 1, 0).applyQuaternion(openingAttitude(v, r));
    expect(roof.dot(r.clone().normalize())).toBeGreaterThan(0.8);
  });

  it('Given the inputs, Then they are not mutated', () => {
    const rc = r.clone();
    const vc = v.clone();
    openingAttitude(v, r);
    expect(r.equals(rc) && v.equals(vc)).toBe(true);
  });
});
