/**
 * The landed frame (DECISIONS open point: "the frame on the ground is a flat
 * grey field").
 *
 * On touchdown the camera used to fall back to the generic orbit view: 200 m
 * out, pitched 20 degrees down at the hull. Measured on the home world that
 * put the horizon on the top tenth of the frame and filled the other nine
 * tenths with the ground between 70 and 500 m, so the payoff of the loop —
 * arriving somewhere and looking at it — was a field of sea. The landed frame
 * is composed instead: low over the hull, looking along the ground towards
 * the star's side of the sky, with the horizon, the sky and (when it is low
 * enough) the star itself in frame.
 *
 * `composeLandedFrame` is pure; the rig springs towards what it returns.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  LANDED_CLEARANCE,
  LANDED_HEIGHT,
  composeLandedFrame,
  type LandedFramingInput,
} from './landedFraming';

const DEG = Math.PI / 180;
const HALF_FOV_Y = 26 * DEG;
const ASPECT = 16 / 9;
const HALF_FOV_X = Math.atan(Math.tan(HALF_FOV_Y) * ASPECT);

/** A sun `elev` degrees up, `az` degrees round from +X, in a frame where `up` is +Y. */
function sunAt(elevDeg: number, azDeg = 0): Vector3 {
  const e = elevDeg * DEG;
  const a = azDeg * DEG;
  return new Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
}

function input(over: Partial<LandedFramingInput> = {}): LandedFramingInput {
  return {
    up: new Vector3(0, 1, 0),
    sunDir: sunAt(60),
    shipForward: new Vector3(0, 0, -1),
    skyWeight: 1,
    time: 0,
    yaw: 0,
    pitch: 0,
    groundRise: 0,
    halfFovY: HALF_FOV_Y,
    ...over,
  };
}

function frame(over: Partial<LandedFramingInput> = {}) {
  const i = input(over);
  const out = composeLandedFrame(i, { offset: new Vector3(), look: new Vector3() });
  return { i, ...out };
}

/** Elevation of `v` above the plane normal to `up`, radians. */
function elevation(v: Vector3, up: Vector3): number {
  return Math.asin(Math.max(-1, Math.min(1, v.clone().normalize().dot(up))));
}

/** Horizontal angle between two directions about `up`, radians, 0..pi. */
function azimuthGap(a: Vector3, b: Vector3, up: Vector3): number {
  const ah = a.clone().addScaledVector(up, -a.dot(up)).normalize();
  const bh = b.clone().addScaledVector(up, -b.dot(up)).normalize();
  return Math.acos(Math.max(-1, Math.min(1, ah.dot(bh))));
}

/**
 * Is a direction (from the eye) inside the frustum? Measured in the camera's
 * own levelled frame: the yaw off the look axis against the horizontal half
 * field, the pitch off it against the vertical one.
 */
function inFrame(dir: Vector3, look: Vector3, up: Vector3, margin = 1): boolean {
  const fwd = look.clone().normalize();
  const right = fwd.clone().cross(up).normalize();
  const camUp = right.clone().cross(fwd).normalize();
  const d = dir.clone().normalize();
  const z = d.dot(fwd);
  if (z <= 0) return false;
  const x = Math.atan(d.dot(right) / z);
  const y = Math.atan(d.dot(camUp) / z);
  return Math.abs(x) < HALF_FOV_X * margin && Math.abs(y) < HALF_FOV_Y * margin;
}

describe('composeLandedFrame', () => {
  it('Given a high sun, When the frame is composed, Then it looks along the ground towards the sun side with the horizon in frame', () => {
    const { i, look } = frame({ sunDir: sunAt(60, 40) });
    // Towards the bright half of the sky, but not straight into the star.
    expect(azimuthGap(look, i.sunDir, i.up)).toBeLessThan(45 * DEG);
    expect(azimuthGap(look, i.sunDir, i.up)).toBeGreaterThan(10 * DEG);
    // Near level: the horizon crosses the frame instead of sitting on its edge.
    const pitch = elevation(look, i.up);
    expect(pitch).toBeGreaterThan(-HALF_FOV_Y * 0.6);
    expect(pitch).toBeLessThan(HALF_FOV_Y * 0.6);
  });

  it('Given any sun, When the frame is composed, Then the hull is in frame and the eye is above its ground', () => {
    for (const elev of [70, 30, 8, -10]) {
      const { i, offset, look } = frame({ sunDir: sunAt(elev, 110) });
      const toShip = offset.clone().negate();
      expect(inFrame(toShip, look, i.up, 0.85)).toBe(true);
      expect(offset.dot(i.up)).toBeGreaterThanOrEqual(LANDED_HEIGHT * 0.9);
      // Low and close: a person-scale view of a 30 m hull, not an aerial one.
      expect(offset.length()).toBeGreaterThan(0.03);
      expect(offset.length()).toBeLessThan(0.15);
    }
  });

  it('Given a sun low over the horizon, When the frame is composed, Then the star itself is in frame', () => {
    const { i, look } = frame({ sunDir: sunAt(9, -70) });
    expect(inFrame(i.sunDir, look, i.up, 0.95)).toBe(true);
  });

  it('Given an atmosphere, When compared with an airless world, Then the frame gives more of itself to the sky', () => {
    const airless = frame({ skyWeight: 0 });
    const thick = frame({ skyWeight: 1 });
    expect(elevation(thick.look, thick.i.up)).toBeGreaterThan(elevation(airless.look, airless.i.up) + 2 * DEG);
  });

  it('Given the star directly overhead, When the frame is composed, Then it falls back to the hull heading and stays finite', () => {
    const { i, look, offset } = frame({ sunDir: new Vector3(0, 1, 0), shipForward: new Vector3(1, -0.2, 0).normalize() });
    expect(Number.isFinite(look.x + look.y + look.z + offset.x + offset.y + offset.z)).toBe(true);
    expect(look.length()).toBeCloseTo(1, 6);
    expect(azimuthGap(look, i.shipForward, i.up)).toBeLessThan(60 * DEG);
  });

  it('Given the star below the horizon, When the frame is composed, Then it still faces the afterglow side', () => {
    const { i, look } = frame({ sunDir: sunAt(-12, 200) });
    expect(azimuthGap(look, i.sunDir, i.up)).toBeLessThan(45 * DEG);
  });

  it('Given ground rising at the eye spot, When the frame is composed, Then the eye clears it', () => {
    const { i, offset } = frame({ groundRise: 0.03 });
    expect(offset.dot(i.up)).toBeGreaterThanOrEqual(0.03 + LANDED_CLEARANCE - 1e-9);
  });

  it('Given time passing, When the frame is recomposed, Then it drifts slowly and never jumps', () => {
    const at = (t: number) => frame({ time: t }).look;
    expect(at(0).angleTo(at(1))).toBeLessThan(1 * DEG);
    let max = 0;
    for (let t = 0; t <= 120; t += 5) max = Math.max(max, at(0).angleTo(at(t)));
    expect(max).toBeGreaterThan(2 * DEG);
    expect(max).toBeLessThan(25 * DEG);
  });

  it('Given the pilot yawing the view a quarter turn, When the frame is composed, Then the eye has orbited the hull by a quarter turn', () => {
    const a = frame({ yaw: 0 });
    const b = frame({ yaw: Math.PI / 2 });
    const ha = a.offset.clone().setY(0);
    const hb = b.offset.clone().setY(0);
    expect(ha.angleTo(hb)).toBeGreaterThan(80 * DEG);
    expect(ha.angleTo(hb)).toBeLessThan(100 * DEG);
  });

  it('Given a world whose vertical is not +Y, When the frame is composed, Then everything is measured against that vertical', () => {
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(1, 2, 3).normalize());
    const base = frame({ sunDir: sunAt(9, -70) });
    const turned = frame({
      up: new Vector3(0, 1, 0).applyQuaternion(q),
      sunDir: sunAt(9, -70).applyQuaternion(q),
      shipForward: new Vector3(0, 0, -1).applyQuaternion(q),
    });
    expect(turned.look.distanceTo(base.look.clone().applyQuaternion(q))).toBeLessThan(1e-6);
    expect(turned.offset.distanceTo(base.offset.clone().applyQuaternion(q))).toBeLessThan(1e-9);
  });

  // --- review-landed: behaviours the mutants above showed were unpinned -----

  /** Signed horizontal angle of `d` off `look`, about `up`; positive = left. */
  function bearingOff(d: Vector3, look: Vector3, up: Vector3): number {
    const f = look.clone().addScaledVector(up, -look.dot(up)).normalize();
    const left = up.clone().cross(f);
    const h = d.clone().addScaledVector(up, -d.dot(up));
    return Math.atan2(h.dot(left), h.dot(f));
  }

  it('Given any sun, When the frame is composed, Then the hull sits off-centre on the side of the frame away from the star', () => {
    for (const az of [0, 110, 250]) {
      const { i, offset, look } = frame({ sunDir: sunAt(20, az) });
      const hull = bearingOff(offset.clone().negate(), look, i.up);
      const star = bearingOff(i.sunDir, look, i.up);
      expect(Math.sign(hull)).toBe(-Math.sign(star));
      expect(Math.abs(hull)).toBeGreaterThan(5 * DEG);
    }
  });

  it('Given a high but not overhead star, When the frame is composed, Then the frame still follows the star and not the hull', () => {
    const { i, look } = frame({ sunDir: sunAt(75, 110), shipForward: sunAt(0, 290) });
    expect(azimuthGap(look, i.sunDir, i.up)).toBeLessThan(45 * DEG);
  });

  it('Given the star overhead and a nose pitched up, When the frame is composed, Then the look is as level as for a level nose', () => {
    const level = frame({ sunDir: new Vector3(0, 1, 0), shipForward: new Vector3(1, 0, 0), skyWeight: 0 });
    const noseUp = frame({ sunDir: new Vector3(0, 1, 0), shipForward: new Vector3(1, 0.6, 0).normalize(), skyWeight: 0 });
    expect(noseUp.look.distanceTo(level.look)).toBeLessThan(1e-9);
    expect(noseUp.offset.distanceTo(level.offset)).toBeLessThan(1e-12);
  });

  it('Given the pilot yawing right (negative yaw, as the rig feeds it), When the frame is composed, Then the view turns right', () => {
    const a = frame({ yaw: 0 });
    const b = frame({ yaw: -0.2 });
    expect(bearingOff(b.look, a.look, a.i.up)).toBeLessThan(-0.15);
  });

  it('Given the pilot pitching up, When the frame is composed, Then the view rises', () => {
    const a = frame({ skyWeight: 0, pitch: 0 });
    const b = frame({ skyWeight: 0, pitch: 0.1 });
    expect(elevation(b.look, b.i.up)).toBeGreaterThan(elevation(a.look, a.i.up) + 0.08);
  });

  it('Given a sky weight past full, When the frame is composed, Then it is the full-sky frame', () => {
    expect(frame({ skyWeight: 3 }).look.distanceTo(frame({ skyWeight: 1 }).look)).toBeLessThan(1e-12);
  });

  it('Given a raised eye and the pilot pitching up as far as allowed, When the frame is composed, Then the hull stays in frame', () => {
    const { i, offset, look } = frame({ groundRise: 0.05, pitch: 0.35 });
    expect(inFrame(offset.clone().negate(), look, i.up, 0.95)).toBe(true);
  });

  it('Given the pilot pitching far down, When the frame is composed, Then the look stops short of the ground under the eye', () => {
    const { i, look } = frame({ skyWeight: 0, pitch: -2 });
    expect(elevation(look, i.up)).toBeGreaterThanOrEqual(-0.6 - 1e-9);
  });

  it('Given time passing frame by frame, When the frame is recomposed, Then no frame-to-frame step is visible', () => {
    let worst = 0;
    let prev = frame({ time: 0 }).look;
    for (let t = 1 / 60; t <= 120; t += 1 / 60) {
      const l = frame({ time: t }).look;
      worst = Math.max(worst, l.angleTo(prev));
      prev = l;
    }
    // A felt drift: well under a hundredth of a degree a frame.
    expect(worst).toBeLessThan(0.01 * DEG);
  });
});

