/**
 * Leaving flight for the Yard (or a review shot) and coming back must put the
 * player exactly where they were: same lens, same roll, real time.
 */

import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';

import { FlightSnapshot } from './FlightSnapshot';

function clock(fixedDt: number | null) {
  return {
    fixedDt,
    resumed: 0,
    resumeRealtime() {
      this.fixedDt = null;
      this.resumed++;
    },
  };
}

function flightCamera(): PerspectiveCamera {
  const c = new PerspectiveCamera(62, 16 / 9, 0.0005, 1e12);
  c.position.set(12.5, -3.25, 4000.125);
  c.quaternion.set(0.1, 0.2, 0.3, 0.9).normalize();
  c.up.set(0.05, 0.99, 0.1).normalize();
  c.updateProjectionMatrix();
  return c;
}

describe('FlightSnapshot', () => {
  it('Given fixedDt = 1/60 left by a review settle, When restored to flight, Then fixedDt is null', () => {
    const cam = flightCamera();
    const snap = new FlightSnapshot();
    snap.capture(cam, { exposureBias: 1, pointerLocked: false });
    const c = clock(1 / 60);
    snap.restore(cam, c);
    expect(c.fixedDt).toBeNull();
    expect(c.resumed).toBe(1);
  });

  it('Given a captured flight camera, When the yard moves it and it is restored, Then pose, up and fov are exact', () => {
    const cam = flightCamera();
    const want = { p: cam.position.clone(), q: cam.quaternion.clone(), up: cam.up.clone(), fov: cam.fov };
    const snap = new FlightSnapshot();
    snap.capture(cam, { exposureBias: 1, pointerLocked: true });

    cam.position.set(0, 0, 0.3);
    cam.quaternion.identity();
    cam.up.set(0, 1, 0);
    cam.fov = 24;
    cam.updateProjectionMatrix();

    expect(snap.restore(cam, clock(null))).toBe(true);
    expect(cam.position.equals(want.p)).toBe(true);
    expect(cam.quaternion.equals(want.q)).toBe(true);
    expect(cam.up.equals(want.up)).toBe(true);
    expect(cam.fov).toBe(want.fov);
  });

  it('Given a restored fov, Then the projection matrix is rebuilt for it', () => {
    const cam = flightCamera();
    const expected = cam.projectionMatrix.clone();
    const snap = new FlightSnapshot();
    snap.capture(cam, { exposureBias: 1, pointerLocked: false });
    cam.fov = 20;
    cam.updateProjectionMatrix();
    snap.restore(cam, clock(null));
    expect(cam.projectionMatrix.equals(expected)).toBe(true);
  });

  it('Given an exposure hook, When restored, Then the captured exposure bias is handed back', () => {
    const cam = flightCamera();
    const snap = new FlightSnapshot();
    snap.capture(cam, { exposureBias: 0.75, pointerLocked: false });
    let got = -1;
    snap.restore(cam, clock(null), { setExposureBias: (v) => (got = v) });
    expect(got).toBe(0.75);
  });

  it('Given the snapshot recorded pointer lock, Then it reports so (it can only be re-requested from a gesture)', () => {
    const snap = new FlightSnapshot();
    snap.capture(flightCamera(), { exposureBias: 1, pointerLocked: true });
    expect(snap.wasPointerLocked).toBe(true);
  });

  it('Given nothing was captured, When restored, Then the camera is untouched but real time still resumes', () => {
    const cam = flightCamera();
    const p = cam.position.clone();
    const c = clock(1 / 60);
    expect(new FlightSnapshot().restore(cam, c)).toBe(false);
    expect(cam.position.equals(p)).toBe(true);
    expect(c.fixedDt).toBeNull();
  });

  it('Given a restore, When restored again, Then the second is a no-op (the snapshot is consumed)', () => {
    const cam = flightCamera();
    const snap = new FlightSnapshot();
    snap.capture(cam, { exposureBias: 1, pointerLocked: false });
    expect(snap.restore(cam, clock(null))).toBe(true);
    cam.position.set(1, 2, 3);
    expect(snap.restore(cam, clock(null))).toBe(false);
    expect(cam.position.x).toBe(1);
    expect(snap.captured).toBe(false);
  });

  it('Given the captured camera is later mutated, Then the snapshot holds copies, not references', () => {
    const cam = flightCamera();
    const p = cam.position.clone();
    const snap = new FlightSnapshot();
    snap.capture(cam, { exposureBias: 1, pointerLocked: false });
    cam.position.x += 100;
    snap.restore(cam, clock(null));
    expect(cam.position.equals(p)).toBe(true);
  });
});
