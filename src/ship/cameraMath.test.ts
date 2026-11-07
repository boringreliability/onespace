/**
 * [v3-T1] The chase camera's pure pieces (docs/v3/PLAN.md phases A2, A3, A7).
 */

import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  SMOOTHERSTEP_PEAK_SLOPE,
  blendSeconds,
  chaseLagOffset,
  constrainAimToFrame,
  limitAnchorVelocity,
  lowPassVec,
  sphericalLerp,
  subjectFrameRadius,
} from './cameraMath';

const out = () => ({ vel: new Vector3(), teleport: new Vector3(), jumped: false });
const A_MAX = 1.5; // km/s²
const DEG = Math.PI / 180;

describe('limitAnchorVelocity', () => {
  it('Given a change of velocity within aMax·dt, When limited, Then it passes untouched and nothing is a teleport', () => {
    const r = limitAnchorVelocity(new Vector3(1, 0, 0), new Vector3(1.02, 0, 0), 1 / 60, A_MAX, out());
    expect(r.vel.x).toBeCloseTo(1.02, 12);
    expect(r.teleport.length()).toBe(0);
    expect(r.jumped).toBe(false);
  });

  it('Given an 8 ms time loss read as a 4 km/s spike, When limited, Then the velocity moves by at most aMax·dt and the excess is a teleport', () => {
    const dt = 1 / 15;
    const r = limitAnchorVelocity(new Vector3(7, 0, 0), new Vector3(3, 0, 0), dt, A_MAX, out());
    expect(r.vel.distanceTo(new Vector3(7, 0, 0))).toBeCloseTo(A_MAX * dt, 12);
    expect(r.jumped).toBe(true);
    // Accounting: what the anchor really moved = limited motion + teleport.
    const moved = r.vel.clone().multiplyScalar(dt).add(r.teleport);
    expect(moved.distanceTo(new Vector3(3, 0, 0).multiplyScalar(dt))).toBeLessThan(1e-12);
  });

  it('Given a cruise drop from 15,000 km/s to 5 km/s, When limited, Then the excess is all teleport and the followed velocity barely moves', () => {
    const r = limitAnchorVelocity(new Vector3(0, 0, -15000), new Vector3(5, 0, 0), 1 / 60, A_MAX, out());
    expect(r.jumped).toBe(true);
    expect(r.vel.distanceTo(new Vector3(0, 0, -15000))).toBeCloseTo(A_MAX / 60, 9);
  });

  it('Given the same physical spike at 30 and 144 fps, Then the allowed change scales with dt (frame-rate independent)', () => {
    const a = limitAnchorVelocity(new Vector3(), new Vector3(100, 0, 0), 1 / 30, A_MAX, out());
    const b = limitAnchorVelocity(new Vector3(), new Vector3(100, 0, 0), 1 / 144, A_MAX, out());
    expect(a.vel.x / (1 / 30)).toBeCloseTo(b.vel.x / (1 / 144), 9);
  });

  it('Given dt = 0, When limited, Then the velocity is held and nothing is a teleport (no division by zero)', () => {
    const r = limitAnchorVelocity(new Vector3(1, 2, 3), new Vector3(50, 0, 0), 0, A_MAX, out());
    expect(r.vel.toArray()).toEqual([1, 2, 3]);
    expect(r.teleport.length()).toBe(0);
  });

  it('Given inputs, Then they are not mutated', () => {
    const p = new Vector3(1, 0, 0);
    const q = new Vector3(90, 0, 0);
    limitAnchorVelocity(p, q, 1 / 60, A_MAX, out());
    expect(p.x).toBe(1);
    expect(q.x).toBe(90);
  });
});

describe('lowPassVec', () => {
  it('Given a step input, When filtered for τ, Then it reaches 1 − 1/e', () => {
    const s = new Vector3();
    const x = new Vector3(1, 0, 0);
    for (let i = 0; i < 150; i++) lowPassVec(s, x, 0.001, 0.15);
    expect(s.x).toBeCloseTo(1 - Math.exp(-1), 6);
  });

  it('Given the same step at 30 fps and at 120 fps, Then the filtered value at 0.3 s is the same (frame-rate independent)', () => {
    const a = new Vector3();
    const b = new Vector3();
    const x = new Vector3(0, 2, 0);
    for (let i = 0; i < 9; i++) lowPassVec(a, x, 1 / 30, 0.15);
    for (let i = 0; i < 36; i++) lowPassVec(b, x, 1 / 120, 0.15);
    expect(a.y).toBeCloseTo(b.y, 9);
  });

  it('Given dt = 0, Then the state is unchanged', () => {
    const s = new Vector3(0.5, 0, 0);
    lowPassVec(s, new Vector3(10, 0, 0), 0, 0.15);
    expect(s.x).toBe(0.5);
  });
});

describe('chaseLagOffset', () => {
  const W = 2 * Math.PI * 1.05;
  const L = 0.016;

  it('Given no acceleration, Then no lag', () => {
    expect(chaseLagOffset(new Vector3(), W, L, new Vector3()).length()).toBe(0);
  });

  it('Given a gentle burn, Then the lag is the spring’s steady-state a/ω², opposite the acceleration', () => {
    const a = new Vector3(0, 0, -0.02); // 2 g forward
    const o = chaseLagOffset(a, W, L, new Vector3());
    expect(o.z).toBeGreaterThan(0); // falls back
    expect(o.length()).toBeCloseTo(0.02 / (W * W), 4);
  });

  it('Given a 0.3 km/s² burn, Then the ship is pushed ~6-7 m from the lens', () => {
    const o = chaseLagOffset(new Vector3(0, 0, -0.3), W, L, new Vector3());
    expect(o.length()).toBeGreaterThan(0.0055);
    expect(o.length()).toBeLessThan(0.0075);
  });

  it('Given a violent 10 km/s² event, Then the lag approaches but never exceeds lMax (soft, not a hard clamp)', () => {
    const o = chaseLagOffset(new Vector3(10, 0, 0), W, L, new Vector3());
    expect(o.length()).toBeLessThanOrEqual(L);
    expect(o.length()).toBeGreaterThan(0.99 * L);
  });

  it('Given increasing acceleration, Then the lag grows monotonically and smoothly (no knee to toggle across)', () => {
    let prev = 0;
    let prevStep = Infinity;
    for (let i = 1; i <= 100; i++) {
      const l = chaseLagOffset(new Vector3(i * 0.02, 0, 0), W, L, new Vector3()).length();
      expect(l).toBeGreaterThan(prev);
      const step = l - prev;
      expect(step).toBeLessThanOrEqual(prevStep + 1e-12); // concave: the slope only falls
      prevStep = step;
      prev = l;
    }
  });

  it('Given a non-positive omega, Then the offset is finite and bounded', () => {
    const o = chaseLagOffset(new Vector3(1, 0, 0), 0, L, new Vector3());
    expect(Number.isFinite(o.x)).toBe(true);
    expect(o.length()).toBeLessThanOrEqual(L);
  });
});

describe('subjectFrameRadius / constrainAimToFrame', () => {
  const up = new Vector3(0, 1, 0);
  const aim = new Vector3(0, 0, -1);
  const HALF_Y = (57 / 2) * DEG;
  const ASPECT = 16 / 9;
  const dirAt = (yawDeg: number, pitchDeg: number) =>
    new Vector3(0, 0, -1).applyAxisAngle(new Vector3(1, 0, 0), pitchDeg * DEG).applyAxisAngle(up, yawDeg * DEG);

  it('Given a subject dead ahead, Then its frame radius is 0 and the aim is unchanged', () => {
    expect(subjectFrameRadius(aim, aim, up, HALF_Y, ASPECT)).toBeCloseTo(0, 9);
    const o = constrainAimToFrame(new Vector3(), aim, aim, up, HALF_Y, ASPECT);
    expect(o.distanceTo(aim)).toBeLessThan(1e-9);
  });

  it('Given a subject on the top edge of the frame, Then its frame radius is 1', () => {
    expect(subjectFrameRadius(aim, dirAt(0, 57 / 2), up, HALF_Y, ASPECT)).toBeCloseTo(1, 6);
  });

  it('Given a subject at 30 % of the frame, When constrained, Then the aim is untouched (inside the soft zone)', () => {
    const s = dirAt(0, -Math.atan(0.3 * Math.tan(HALF_Y)) / DEG);
    const o = constrainAimToFrame(new Vector3(), aim, s, up, HALF_Y, ASPECT);
    expect(o.distanceTo(aim)).toBeLessThan(1e-9);
  });

  it('Given a subject 40° off the aim, When constrained, Then it ends inside 60 % of the frame and not far inside it', () => {
    const s = dirAt(0, -40);
    const o = constrainAimToFrame(new Vector3(), aim, s, up, HALF_Y, ASPECT);
    const r = subjectFrameRadius(o, s, up, HALF_Y, ASPECT);
    expect(r).toBeLessThanOrEqual(0.6 + 1e-6);
    expect(r).toBeGreaterThan(0.5);
    expect(o.length()).toBeCloseTo(1, 9);
  });

  it('Given a subject behind the camera, When constrained, Then the aim is turned until it is in frame', () => {
    const s = dirAt(150, 0);
    expect(subjectFrameRadius(aim, s, up, HALF_Y, ASPECT)).toBe(Infinity);
    const o = constrainAimToFrame(new Vector3(), aim, s, up, HALF_Y, ASPECT);
    expect(subjectFrameRadius(o, s, up, HALF_Y, ASPECT)).toBeLessThanOrEqual(0.6 + 1e-6);
  });

  it('Given the subject swept outwards, Then its constrained radius rises continuously and monotonically through the 40 % knee', () => {
    let prev = -1;
    for (let deg = 0; deg <= 80; deg += 0.5) {
      const s = dirAt(0, -deg);
      const o = constrainAimToFrame(new Vector3(), aim, s, up, HALF_Y, ASPECT);
      const r = subjectFrameRadius(o, s, up, HALF_Y, ASPECT);
      expect(r).toBeGreaterThanOrEqual(prev - 1e-9);
      if (prev >= 0) expect(r - prev).toBeLessThan(0.03); // no jump at the knee
      prev = r;
    }
  });

  it('Given a wide screen, Then a subject may sit further off-centre in angle horizontally than vertically', () => {
    const sx = dirAt(-35, 0);
    const sy = dirAt(0, -35);
    const ox = constrainAimToFrame(new Vector3(), aim, sx, up, HALF_Y, 21 / 9);
    const oy = constrainAimToFrame(new Vector3(), aim, sy, up, HALF_Y, 21 / 9);
    expect(ox.angleTo(sx)).toBeGreaterThan(oy.angleTo(sy));
  });

  it('Given inputs, Then they are not mutated', () => {
    const a = aim.clone();
    const s = dirAt(0, -40);
    const sc = s.clone();
    constrainAimToFrame(new Vector3(), a, s, up, HALF_Y, ASPECT);
    expect(a.equals(aim) && s.equals(sc)).toBe(true);
  });
});

describe('sphericalLerp', () => {
  it('Given t = 0 and t = 1, Then it returns the ends', () => {
    const a = new Vector3(0, 0.02, 0.07);
    const b = new Vector3(0, 0.0085, 0.052);
    expect(sphericalLerp(new Vector3(), a, b, 0).distanceTo(a)).toBeLessThan(1e-12);
    expect(sphericalLerp(new Vector3(), a, b, 1).distanceTo(b)).toBeLessThan(1e-12);
  });

  it('Given two offsets on opposite sides of the hull, When blended, Then the camera never comes closer than the nearer end (it swings round, not through)', () => {
    const a = new Vector3(0.07, 0.01, -0.01);
    const b = new Vector3(-0.05, 0.008, 0.02);
    const minR = Math.min(a.length(), b.length());
    for (let i = 0; i <= 100; i++) {
      expect(sphericalLerp(new Vector3(), a, b, i / 100).length()).toBeGreaterThanOrEqual(minR - 1e-12);
    }
  });

  it('Given exactly opposite offsets, When blended halfway, Then the result is finite and at the blended radius', () => {
    const o = sphericalLerp(new Vector3(), new Vector3(0.05, 0, 0), new Vector3(-0.07, 0, 0), 0.5);
    expect(Number.isFinite(o.x + o.y + o.z)).toBe(true);
    expect(o.length()).toBeCloseTo(0.06, 9);
  });
});

describe('blendSeconds', () => {
  it('Given a small turn, Then the floor applies (1.5 s)', () => {
    expect(blendSeconds(10 * DEG, 1.5, 90 * DEG)).toBeCloseTo(1.5, 9);
  });

  it('Given a 180° turn at 90°/s, Then the blend is long enough that smootherstep’s peak rate stays within 90°/s', () => {
    const T = blendSeconds(Math.PI, 1.5, 90 * DEG);
    expect((SMOOTHERSTEP_PEAK_SLOPE * Math.PI) / T).toBeLessThanOrEqual(90 * DEG + 1e-9);
    expect(T).toBeLessThan(4);
  });

  it('Given a non-finite angle, Then the floor is returned', () => {
    expect(blendSeconds(Number.NaN, 1.5, 90 * DEG)).toBe(1.5);
  });
});
