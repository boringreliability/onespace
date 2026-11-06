/**
 * review-p1 — tests that kill the surviving mutants of the phase-1 pure
 * modules (targets, flightAids, scanChoice, recovery). Each one pins a
 * boundary, a constant or a guard that the track tests only read back.
 */

import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';

import { TargetSelection, etaSeconds, orderByNoseAngle } from './targets';
import { pickAltitude, projectToScreen, type ScreenPoint } from './flightAids';
import { RETICLE_MARGIN_RAD, chooseScanTarget, type ScanBody } from './scanChoice';
import {
  OPENING_PITCH_DOWN_RAD,
  RecoveryTimeline,
  circularOrbitState,
  openingAttitude,
  progradeAttitude,
  starRadiusKm,
} from './recovery';

const NOSE = { x: 0, y: 0, z: -1 };
const at = (id: string, angle: number, d: number) => ({
  id,
  name: id,
  rel: { x: Math.sin(angle) * d, y: 0, z: -Math.cos(angle) * d },
});
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('targets — boundaries', () => {
  it('Given a zero-range candidate and one dead astern, When ordered, Then the zero-range one still goes last', () => {
    const out = orderByNoseAngle([{ id: 'A', name: 'A', rel: { x: 0, y: 0, z: 0 } }, { id: 'B', name: 'B', rel: { x: 0, y: 0, z: 100 } }], NOSE);
    expect(ids(out)).toEqual(['B', 'A']);
  });

  it('Given A 0.05 rad off the nose and near, B on the nose and far, Then B comes first (0.05 rad is a real angle)', () => {
    expect(ids(orderByNoseAngle([at('A', 0.05, 1_000), at('B', 0, 2_000)], NOSE))).toEqual(['B', 'A']);
  });

  it('Given A 0.0005 rad off the nose and near, B on the nose and far, Then A comes first (inside the tie tolerance the nearer wins)', () => {
    expect(ids(orderByNoseAngle([at('B', 0, 1_000), at('A', 0.0005, 100)], NOSE))).toEqual(['A', 'B']);
  });

  it('Given two candidates in the same place, Then they order by id', () => {
    expect(ids(orderByNoseAngle([at('b', 0, 100), at('a', 0, 100)], NOSE))).toEqual(['a', 'b']);
  });

  it('Given the target is the FIRST live id, When validated, Then it is kept', () => {
    const s = new TargetSelection();
    s.apply('x', []);
    expect(s.validate(['x', 'y'])).toBe(false);
    expect(s.id).toBe('x');
  });

  it('Given closing exactly at the 1 m/s floor, Then there is an ETA; 0.05 km/s gives range/closing; a negative range is 0', () => {
    expect(etaSeconds(10, 1e-3)).toBeCloseTo(10_000, 6);
    expect(etaSeconds(100, 0.05)).toBeCloseTo(2_000, 6);
    expect(etaSeconds(-5, 2)).toBe(0);
  });
});

describe('flightAids — pickAltitude and projectToScreen edges', () => {
  const W = 1600;
  const H = 900;
  const cam = (): PerspectiveCamera => {
    const c = new PerspectiveCamera(60, W / H, 0.01, 1e9);
    c.lookAt(0, 0, -1);
    c.updateMatrixWorld();
    return c;
  };
  const pt = (): ScreenPoint => ({ x: 0, y: 0, behind: false });

  it('Given the parent at 10 R and a moon nearer, Then ALT is still the parent (the reach is 40 R, pinned)', () => {
    expect(pickAltitude({ parentName: 'Fyss', parentAltKm: 60_000, parentRadiusKm: 6_000, nearestName: 'Moon', nearestAltKm: 500 }))
      .toEqual({ altitudeKm: 60_000, bodyName: 'Fyss' });
  });

  it('Given the parent exactly at 40 R and nothing else, Then there is no altitude', () => {
    expect(pickAltitude({ parentName: 'Fyss', parentAltKm: 240_000, parentRadiusKm: 6_000, nearestName: null, nearestAltKm: null })).toBeNull();
  });

  it('Given a non-finite parent altitude, Then the nearest body is used', () => {
    expect(pickAltitude({ parentName: 'Fyss', parentAltKm: -Infinity, parentRadiusKm: 6_000, nearestName: 'Moon', nearestAltKm: 500 }))
      .toEqual({ altitudeKm: 500, bodyName: 'Moon' });
  });

  it('Given no nearest name, Then a stray nearest altitude is not reported', () => {
    expect(pickAltitude({ parentName: null, parentAltKm: Infinity, parentRadiusKm: 0, nearestName: null, nearestAltKm: 500 })).toBeNull();
  });

  it('Given a direction exactly abeam, Then it is flagged behind and lands on finite pixels', () => {
    const o = projectToScreen(1, 0, 0, 0, cam(), W, H, pt());
    expect(o.behind).toBe(true);
    expect(Number.isFinite(o.x)).toBe(true);
    expect(Number.isFinite(o.y)).toBe(true);
  });

  it('Given a direction behind and to the right, Then it is behind and on the right half (the mirrored projection the edge clamp expects)', () => {
    const o = projectToScreen(0.1, 0, 1, 0, cam(), W, H, pt());
    expect(o.behind).toBe(true);
    expect(o.x).toBeGreaterThan(W / 2);
  });
});

describe('scanChoice — the reticle margin', () => {
  const body = (angleRad: number, angularRadiusRad: number): ScanBody => ({
    id: 'p', angleRad, angularRadiusRad, distanceKm: 1_000, inRange: true,
  });
  const deg = (d: number) => (d * Math.PI) / 180;

  it('Given a body exactly at its disc plus the margin, Then it is under the reticle', () => {
    const a = deg(1);
    expect(chooseScanTarget({ target: null, parentId: null, bodies: [body(a + RETICLE_MARGIN_RAD, a)] })).toEqual({ kind: 'scan', id: 'p' });
  });

  it('Given a 1° disc 10° off the nose, Then it is not under the reticle (the margin is 3°, pinned)', () => {
    expect(chooseScanTarget({ target: null, parentId: null, bodies: [body(deg(10), deg(1))] })).toEqual({ kind: 'none' });
  });

  it('Given a planet filling 30° with the nose 20° off its centre, Then the nose is on the disc and it is scanned', () => {
    expect(chooseScanTarget({ target: null, parentId: null, bodies: [body(deg(20), deg(30))] })).toEqual({ kind: 'scan', id: 'p' });
  });
});

describe('recovery — guards and conventions', () => {
  it('Given a non-finite radial, Then the orbit falls back to +X instead of NaN', () => {
    const s = circularOrbitState(new Vector3(Infinity, 0, 0), 1_000, 1);
    expect(s.position.x).toBeCloseTo(1_600, 9);
    expect(s.position.y).toBe(0);
  });

  it('Given a radial of +X, Then the recovery orbit runs towards −Z (the spawn convention)', () => {
    const v = circularOrbitState(new Vector3(1, 0, 0), 1_000, 1).velocity.clone().normalize();
    expect(v.z).toBeCloseTo(-1, 9);
  });

  it('Given a velocity with a radial part, Then the opening nose is exactly 30° off it and in the (v, r) plane on the world side', () => {
    const v = new Vector3(0.5, 0, -1);
    const q = openingAttitude(v, new Vector3(1, 0, 0));
    const nose = new Vector3(0, 0, -1).applyQuaternion(q);
    expect(nose.angleTo(v)).toBeCloseTo(OPENING_PITCH_DOWN_RAD, 6);
    expect(nose.y).toBeCloseTo(0, 9);
  });

  it('Given an infinite star radius, Then it counts as no radius', () => {
    expect(starRadiusKm({ radius: Infinity })).toBe(0);
  });

  it('Given a zero velocity, Then progradeAttitude is the identity', () => {
    const q = progradeAttitude(new Vector3(), new Vector3(1, 0, 0));
    expect(q.equals(new Quaternion())).toBe(true);
  });

  it('Given one long 1.2 s frame, Then the move fires on it and the screen is fully black', () => {
    const t = new RecoveryTimeline();
    t.start();
    expect(t.step(1.2)).toBe(true);
    expect(t.blackout).toBe(1);
  });

  it('Given a negative dt, Then it does not rewind the fade', () => {
    const t = new RecoveryTimeline();
    t.start();
    t.step(-5);
    expect(t.step(0.6)).toBe(true);
  });
});
