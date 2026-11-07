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
import { Vector3 } from 'three';
import { arrivalAim, framesSubject } from './arrivalFraming';

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
