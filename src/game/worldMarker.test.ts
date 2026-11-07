/**
 * World-locked HUD markers (v3 PLAN A8 / H1).
 *
 * v2 damped prograde, retrograde and the target bracket in SCREEN space
 * (Hud.ts ~899-957, rate 12-14/s). A camera that rotates — a turn, the chase
 * aim, a frame of shake — moves every world point on the glass at once, and a
 * screen-damped marker trails that motion, so it swam against the stars.
 *
 * v3: the damping lives in WORLD space (a unit direction, or a point held at
 * its exact range), and the result is projected through the camera every
 * frame. A pure camera rotation therefore cannot move a marker off its point.
 */

import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';

import { projectToScreen, type ScreenPoint } from './flightAids';
import { MARKER_LAMBDA, WorldMarker, WorldPointMarker, dampDirection } from './worldMarker';

const W = 1600;
const H = 900;
const DT = 1 / 60;
const DEG = Math.PI / 180;

function camera(): PerspectiveCamera {
  const c = new PerspectiveCamera(70, W / H, 0.001, 1e9);
  c.position.set(0, 0, 0);
  c.lookAt(0, 0, -1);
  c.updateMatrixWorld();
  return c;
}

function rotateCamera(c: PerspectiveCamera, yawDeg: number, pitchDeg: number, rollDeg: number): void {
  c.rotateY(yawDeg * DEG);
  c.rotateX(pitchDeg * DEG);
  c.rotateZ(rollDeg * DEG);
  c.updateMatrixWorld();
}

const pt = (): ScreenPoint => ({ x: 0, y: 0, behind: false });

function angleBetween(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const d = a.x * b.x + a.y * b.y + a.z * b.z;
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  return Math.acos(Math.max(-1, Math.min(1, d / (la * lb))));
}

// ---------------------------------------------------------------------------
// dampDirection — the world-space filter
// ---------------------------------------------------------------------------

describe('dampDirection', () => {
  it('Given the shown direction already equals the target, When stepped, Then it does not move', () => {
    const cur = new Vector3(0, 0, -1);
    dampDirection(cur, new Vector3(0, 0, -1), MARKER_LAMBDA, DT);
    expect(cur.x).toBeCloseTo(0, 12);
    expect(cur.y).toBeCloseTo(0, 12);
    expect(cur.z).toBeCloseTo(-1, 12);
  });

  it('Given a 30° error, When stepped one 60 Hz frame, Then the ANGLE decays exponentially (30°·e^(−λ·dt)) and the result stays unit length', () => {
    const cur = new Vector3(0, 0, -1);
    const tgt = new Vector3(Math.sin(30 * DEG), 0, -Math.cos(30 * DEG));
    dampDirection(cur, tgt, MARKER_LAMBDA, DT);
    expect(angleBetween(cur, tgt)).toBeCloseTo(30 * DEG * Math.exp(-MARKER_LAMBDA * DT), 6);
    expect(cur.length()).toBeCloseTo(1, 9);
  });

  it('Given the same total time, When stepped as two half frames or one whole frame, Then the result is the same (frame-rate independent)', () => {
    const tgt = new Vector3(0.6, 0.3, -0.74).normalize();
    const a = new Vector3(0, 0, -1);
    const b = new Vector3(0, 0, -1);
    dampDirection(a, tgt, MARKER_LAMBDA, DT);
    dampDirection(b, tgt, MARKER_LAMBDA, DT / 2);
    dampDirection(b, tgt, MARKER_LAMBDA, DT / 2);
    expect(angleBetween(a, b)).toBeLessThan(1e-6);
  });

  it('Given dt = 0 (photo mode / pause), Then the direction is untouched', () => {
    const cur = new Vector3(0, 0, -1);
    dampDirection(cur, new Vector3(1, 0, 0), MARKER_LAMBDA, 0);
    expect(cur.z).toBeCloseTo(-1, 12);
  });

  it('Given an exactly opposite target (velocity reversed through zero), Then the result is the target — finite, unit, no NaN', () => {
    const cur = new Vector3(0, 0, -1);
    dampDirection(cur, new Vector3(0, 0, 1), MARKER_LAMBDA, DT);
    expect(Number.isFinite(cur.x) && Number.isFinite(cur.y) && Number.isFinite(cur.z)).toBe(true);
    expect(cur.z).toBeCloseTo(1, 9);
  });

  it('Given it is fed the caller’s object, Then it writes in place and returns the same object (no allocation)', () => {
    const cur = new Vector3(0, 0, -1);
    expect(dampDirection(cur, new Vector3(0, 1, 0), MARKER_LAMBDA, DT)).toBe(cur);
  });
});

// ---------------------------------------------------------------------------
// WorldMarker — a direction at infinity (prograde, retrograde)
// ---------------------------------------------------------------------------

describe('WorldMarker — glued to the world under camera motion', () => {
  it('Given a never-stepped marker, When first fed a direction, Then it starts exactly on it (no sweep in from nowhere)', () => {
    const m = new WorldMarker();
    const d = new Vector3(0.2, -0.1, -1).normalize();
    m.step(d, DT);
    expect(angleBetween(m.dir, d)).toBeLessThan(1e-9);
  });

  it('Given a settled prograde marker, When ONLY the camera rotates (25° yaw, 10° pitch, 15° roll in one frame), Then the marker projects exactly onto the true prograde point', () => {
    const cam = camera();
    const pro = new Vector3(0.25, 0.1, -1).normalize();
    const m = new WorldMarker();
    for (let i = 0; i < 120; i++) m.step(pro, DT);

    rotateCamera(cam, 25, 10, 15);
    cam.updateMatrixWorld();
    m.step(pro, DT);

    const truth = projectToScreen(pro.x, pro.y, pro.z, 0, cam, W, H, pt());
    const shown = projectToScreen(m.dir.x, m.dir.y, m.dir.z, 0, cam, W, H, pt());
    expect(Math.abs(shown.x - truth.x)).toBeLessThan(1e-6);
    expect(Math.abs(shown.y - truth.y)).toBeLessThan(1e-6);
  });

  it('Given camera shake (60 frames of random sub-degree rotations), Then on every frame the marker sits on the true point to within 0.01 px', () => {
    const cam = camera();
    const pro = new Vector3(-0.3, 0.05, -1).normalize();
    const m = new WorldMarker();
    m.step(pro, DT);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < 60; i++) {
      rotateCamera(cam, rnd() * 0.8, rnd() * 0.8, rnd() * 1.2);
      m.step(pro, DT);
      const truth = projectToScreen(pro.x, pro.y, pro.z, 0, cam, W, H, pt());
      const shown = projectToScreen(m.dir.x, m.dir.y, m.dir.z, 0, cam, W, H, pt());
      expect(Math.hypot(shown.x - truth.x, shown.y - truth.y)).toBeLessThan(0.01);
    }
  });

  it('Given the SAME camera rotation, When the v2 screen-space damper is used instead, Then it lags by tens of pixels — the swim this replaces', () => {
    // Documents the defect: one frame after a 25° yaw, a screen point damped
    // at 12/s has only covered 18 % of the jump.
    const cam = camera();
    const pro = new Vector3(0.25, 0.1, -1).normalize();
    const before = projectToScreen(pro.x, pro.y, pro.z, 0, cam, W, H, pt());
    const sx0 = before.x;
    rotateCamera(cam, 25, 0, 0);
    const truth = projectToScreen(pro.x, pro.y, pro.z, 0, cam, W, H, pt());
    const k = Math.exp(-12 * DT);
    const screenDamped = truth.x + (sx0 - truth.x) * k;
    expect(Math.abs(screenDamped - truth.x)).toBeGreaterThan(20);
  });

  it('Given the TRUE direction changes by 20° (a burn swings prograde), Then the marker eases toward it over frames instead of jumping', () => {
    const m = new WorldMarker();
    const a = new Vector3(0, 0, -1);
    const b = new Vector3(Math.sin(20 * DEG), 0, -Math.cos(20 * DEG));
    m.step(a, DT);
    m.step(b, DT);
    const first = angleBetween(m.dir, b);
    expect(first).toBeGreaterThan(10 * DEG); // did not jump
    for (let i = 0; i < 60; i++) m.step(b, DT);
    expect(angleBetween(m.dir, b)).toBeLessThan(0.01 * DEG); // and settles within a second
  });

  it('Given reset(), When fed again, Then it starts on the new direction (a marker returning from "too slow" does not sweep)', () => {
    const m = new WorldMarker();
    m.step(new Vector3(0, 0, -1), DT);
    m.reset();
    const d = new Vector3(1, 0, 0);
    m.step(d, DT);
    expect(angleBetween(m.dir, d)).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------------------
// WorldPointMarker — a point at finite range (target bracket, contacts)
// ---------------------------------------------------------------------------

describe('WorldPointMarker — target and contact brackets', () => {
  it('Given a target 2 km away and a stationary ship, When the camera both rotates AND translates (chase lag, shake), Then the bracket projects exactly onto the target', () => {
    const cam = camera();
    const ship = new Vector3(0, 0, 0);
    const target = new Vector3(0.4, 0.3, -2);
    const m = new WorldPointMarker();
    m.step(ship, target, DT);

    cam.position.set(0.012, -0.006, 0.03); // 12 m of lag, 6 m, 30 m back
    rotateCamera(cam, -8, 4, 11);
    m.step(ship, target, DT);

    const out = new Vector3();
    m.point(ship, out);
    const truth = projectToScreen(target.x, target.y, target.z, 1, cam, W, H, pt());
    const shown = projectToScreen(out.x, out.y, out.z, 1, cam, W, H, pt());
    expect(Math.hypot(shown.x - truth.x, shown.y - truth.y)).toBeLessThan(1e-4);
  });

  it('Given the range changes, Then the marker point keeps the EXACT current range (only the direction is damped)', () => {
    const ship = new Vector3(0, 0, 0);
    const m = new WorldPointMarker();
    m.step(ship, new Vector3(0, 0, -10), DT);
    m.step(ship, new Vector3(0, 0, -3), DT);
    const out = new Vector3();
    m.point(ship, out);
    expect(out.length()).toBeCloseTo(3, 9);
  });

  it('Given the target is re-selected to a point 60° away, Then the bracket slews across in world space (first frame moves < 25 %) rather than teleporting', () => {
    const ship = new Vector3(0, 0, 0);
    const a = new Vector3(0, 0, -5);
    const b = new Vector3(5 * Math.sin(60 * DEG), 0, -5 * Math.cos(60 * DEG));
    const m = new WorldPointMarker();
    m.step(ship, a, DT);
    m.step(ship, b, DT);
    const out = new Vector3();
    m.point(ship, out);
    expect(angleBetween(out, b)).toBeGreaterThan(60 * DEG * 0.75);
  });

  it('Given the ship moves with the target (co-orbiting, same velocity), Then the bracket does not drift', () => {
    const m = new WorldPointMarker();
    const ship = new Vector3();
    const tgt = new Vector3();
    const out = new Vector3();
    for (let i = 0; i < 120; i++) {
      ship.set(i * 0.13, 0, i * 0.05); // 7.8 km/s-ish
      tgt.set(ship.x + 1, ship.y + 0.2, ship.z - 1.5);
      m.step(ship, tgt, DT);
      m.point(ship, out);
      expect(out.distanceTo(tgt)).toBeLessThan(1e-9);
    }
  });
});
