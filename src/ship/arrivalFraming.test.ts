/**
 * v3 T4 / PLAN E6 — arrival frames.
 *
 * The audit's V4: ~12 s of bare stars after a warp. The ship is placed at
 * 1.6 R with the opening attitude, offset TOWARDS the star — so the star is
 * behind the camera — and the hero world stays hidden until its programs have
 * compiled. With neither subject in frame, the arrival is an empty black
 * screen, which ARCHITECTURE §6 calls a failure state.
 *
 * `framesSubject` is the acceptance predicate (also used by the browser
 * harness); `arrivalAim` picks what the arrival must hold in frame while the
 * world is not yet drawn.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { arrivalAim, framesSubject, openSpaceArrivalAttitude } from './arrivalFraming';

const NOSE = new Vector3(0, 0, -1);
const ROOF = new Vector3(0, 1, 0);
const DEG = Math.PI / 180;
const H = 44 * DEG; // half horizontal FOV (88° at 16:9)
const V = 27 * DEG; // half vertical

function dir(yawDeg: number, pitchDeg: number): Vector3 {
  const y = yawDeg * DEG;
  const p = pitchDeg * DEG;
  return new Vector3(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
}

describe('framesSubject: is the subject (or its limb) inside the view?', () => {
  it('Given a point straight ahead, Then it is framed', () => {
    expect(framesSubject(NOSE, ROOF, NOSE, 0, H, V)).toBe(true);
  });

  it('Given a point behind, Then it is not', () => {
    expect(framesSubject(NOSE, ROOF, NOSE.clone().negate(), 0, H, V)).toBe(false);
  });

  it('Given a point just outside the vertical edge, Then it is not; a big body there shows its limb, so it is', () => {
    const above = dir(0, 30);
    expect(framesSubject(NOSE, ROOF, above, 0, H, V)).toBe(false);
    expect(framesSubject(NOSE, ROOF, above, 5 * DEG, H, V)).toBe(true);
  });

  it('Given horizontal and vertical half-angles differ, Then each is applied on its own axis', () => {
    expect(framesSubject(NOSE, ROOF, dir(40, 0), 0, H, V)).toBe(true);
    expect(framesSubject(NOSE, ROOF, dir(0, 40), 0, H, V)).toBe(false);
  });
});

describe('openSpaceArrivalAttitude: a system with no world to orbit (measured: Skruzvir Margin)', () => {
  // Measured in the browser: a jump into a system with no planets placed the
  // ship at 6 AU with the identity attitude — nose straight at the star, so
  // the chase camera hid the star exactly behind the hull. 20 s of nothing.
  const toStar = new Vector3(0.2, -0.1, -1).normalize();

  it('Given the star direction, Then the star is in the frame but not behind the hull (off the nose by 12-30°)', () => {
    const q = openSpaceArrivalAttitude(toStar, new Quaternion());
    const nose = NOSE.clone().applyQuaternion(q);
    const roof = ROOF.clone().applyQuaternion(q);
    const off = Math.acos(nose.dot(toStar)) / DEG;
    expect(off).toBeGreaterThanOrEqual(12);
    expect(off).toBeLessThanOrEqual(30);
    expect(framesSubject(nose, roof, toStar, 0, H, V)).toBe(true);
  });

  it('Given the star, Then it sits above the nose (the hull is drawn low in the chase frame)', () => {
    const q = openSpaceArrivalAttitude(toStar, new Quaternion());
    const roof = ROOF.clone().applyQuaternion(q);
    expect(toStar.dot(roof)).toBeGreaterThan(0.15);
  });

  it('Given any star direction, Then the attitude is a unit quaternion', () => {
    for (const d of [new Vector3(0, 1, 0), new Vector3(0, -1, 0), new Vector3(1, 0, 0)]) {
      expect(Math.abs(openSpaceArrivalAttitude(d, new Quaternion()).length() - 1)).toBeLessThan(1e-9);
    }
  });
});

describe('arrivalAim: what the arrival holds in frame', () => {
  it('Given the hero world is drawn, Then it is the world', () => {
    expect(arrivalAim({ worldDrawn: true, starInFrame: false })).toBe('world');
  });

  it('Given the world is not yet drawn but the star is in frame, Then nothing needs to move', () => {
    expect(arrivalAim({ worldDrawn: false, starInFrame: true })).toBe('none');
  });

  it('Given neither subject would be in frame, Then the star is brought into frame (never an empty sky)', () => {
    expect(arrivalAim({ worldDrawn: false, starInFrame: false })).toBe('star');
  });
});
