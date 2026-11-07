/**
 * v3 polish (D22a) — the ground moves.
 *
 * Universe turns every world by `spin = axisAngle((sin tilt, cos tilt, 0),
 * 2π·t/P)`; the parent frame does not turn. A point on the ground therefore
 * moves at ω×r in the frame the ship flies in, and the review measured the
 * auto-land setting down with the ground sliding past at ~22 m/s because the
 * landing field aimed for zero velocity in the centre frame.
 *
 * And the touchdown: a grounded ship's velocity is SURFACE-relative (ground
 * friction pulls it to 0 while `carryWithSurface` moves it with the world),
 * an airborne one's is centre-frame. The switch at first contact used to be
 * silent, so a hull that had matched the ground skidded on afterwards at the
 * ground's own speed, and one that had not was stopped dead for free.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import type { PlanetSpec } from '@/gen/types';
import { DEFAULT_SHIP_CONFIG, FlightModel } from './FlightModel';
import { groundVelocity, spinAngularVelocity } from './surfaceSpin';

const R = 7_240;
const MU = 9.8e-3 * R * R;
/** Equatorial ground speed 100 m/s. */
const PERIOD = (2 * Math.PI * R) / 0.1;
const TILT = 0.4;

/** Universe's spin quaternion at orbit time `t` (Universe.updateOrbits). */
function universeSpin(period: number, tilt: number, t: number, out = new Quaternion()): Quaternion {
  const axis = new Vector3(Math.sin(tilt), Math.cos(tilt), 0).normalize();
  return out.setFromAxisAngle(axis, period !== 0 ? (t / period) * Math.PI * 2 : 0);
}

describe('spinAngularVelocity: the world turning, as a vector in the parent frame', () => {
  it('Given a period and tilt, When a surface point is turned by Universe’s spin for 1 s, Then it moved by ω×r (within 1e-9 of R)', () => {
    const w = spinAngularVelocity(PERIOD, TILT, new Vector3());
    const p = new Vector3(0.3, -0.2, 0.9).normalize().multiplyScalar(R);
    const t0 = 12_345;
    const q0 = universeSpin(PERIOD, TILT, t0);
    const q1 = universeSpin(PERIOD, TILT, t0 + 1);
    const delta = q1.clone().multiply(q0.clone().invert());
    const moved = p.clone().applyQuaternion(delta).sub(p);
    const g = groundVelocity(w, p, new Vector3());
    expect(moved.distanceTo(g)).toBeLessThan(1e-9 * R);
  });

  it('Given the equator, Then the ground speed is 2πR/P (100 m/s here)', () => {
    const w = spinAngularVelocity(PERIOD, 0, new Vector3());
    const eq = new Vector3(R, 0, 0);
    expect(groundVelocity(w, eq, new Vector3()).length()).toBeCloseTo(0.1, 9);
  });

  it('Given a negative (retrograde) period, Then ω points the other way', () => {
    const pro = spinAngularVelocity(PERIOD, TILT, new Vector3());
    const retro = spinAngularVelocity(-PERIOD, TILT, new Vector3());
    expect(retro.clone().add(pro).length()).toBeLessThan(1e-15);
  });

  it('Given a zero or non-finite period, Then ω is zero (no NaN)', () => {
    expect(spinAngularVelocity(0, TILT, new Vector3()).length()).toBe(0);
    expect(spinAngularVelocity(Number.NaN, TILT, new Vector3()).length()).toBe(0);
    expect(spinAngularVelocity(Number.POSITIVE_INFINITY, TILT, new Vector3()).length()).toBe(0);
  });

  it('Given the pole (r along ω), Then the ground does not move', () => {
    const w = spinAngularVelocity(PERIOD, TILT, new Vector3());
    const pole = w.clone().normalize().multiplyScalar(R);
    expect(groundVelocity(w, pole, new Vector3()).length()).toBeLessThan(1e-15);
  });
});

// ---------------------------------------------------------------------------
// The touchdown frame switch (FlightModel)
// ---------------------------------------------------------------------------

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

const planet = { id: 'remit', name: 'Remit 31', rotationPeriod: PERIOD, axialTilt: TILT } as unknown as PlanetSpec;

interface Drop {
  fm: FlightModel;
  touchdowns: Array<{ vertical: number; slip: number }>;
  logs: string[];
  /** Body-frame (turning-ground) slide after touchdown, km. */
  slideKm: number;
}

/**
 * Drop a hull 3 m above the equator of a turning sphere, sinking at 1 m/s,
 * with `matchGround` = its horizontal velocity equal to the ground's (else
 * still in the centre frame), and run 3 s past touchdown the way Universe
 * does: spin and carry, then integrate.
 */
function drop(matchGround: boolean): Drop {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: MU, radius: R });
  fm.setLandingContext(planet);
  const qInv = new Quaternion();
  let t = 0;
  const spin = new Quaternion();
  const prev = new Quaternion();
  const local = new Vector3();
  fm.setGroundSampler((p) => p.length() - R);
  const w = spinAngularVelocity(PERIOD, TILT, new Vector3());
  // A point well off the pole: the equator of the TILTED axis.
  const axis = w.clone().normalize();
  const site = new Vector3(0, 0, 1).addScaledVector(axis, -axis.z).normalize();
  const pos = site.clone().multiplyScalar(R + 0.003);
  const vel = site.clone().multiplyScalar(-0.001);
  if (matchGround) vel.add(groundVelocity(w, pos, new Vector3()));
  fm.teleport(pos, vel, new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), site));

  const out: Drop = { fm, touchdowns: [], logs: [], slideKm: 0 };
  offs.push(
    bus.on('ship:touchdown', (e) => out.touchdowns.push({ vertical: e.vertical, slip: e.slip })),
    bus.on('log', (e) => out.logs.push(e.text)),
  );
  const h = 1 / 60;
  let tdAt = -1;
  const bodyAtTd = new Vector3();
  for (let i = 0; i < 60 * 10; i++) {
    prev.copy(spin);
    t += h;
    universeSpin(PERIOD, TILT, t, spin);
    if (fm.grounded) fm.carryWithSurface(spin.clone().multiply(prev.clone().invert()));
    fm.update(h);
    if (tdAt < 0 && out.touchdowns.length > 0) {
      tdAt = t;
      bodyAtTd.copy(fm.position).applyQuaternion(qInv.copy(spin).invert());
    }
    if (tdAt >= 0 && t - tdAt > 3) break;
  }
  local.copy(fm.position).applyQuaternion(qInv.copy(spin).invert());
  out.slideKm = tdAt >= 0 ? local.distanceTo(bodyAtTd) : Number.NaN;
  return out;
}

describe('touchdown on a turning world (FlightModel, D22a)', () => {
  it('Given a hull that matched the ground’s velocity, When it touches down, Then the touchdown reports ~0 surface-relative slip and it does not slide afterwards (< 0.5 m in 3 s)', () => {
    const d = drop(true);
    expect(d.touchdowns.length).toBe(1);
    expect(d.touchdowns[0]!.slip).toBeLessThan(0.0005);
    expect(d.slideKm).toBeLessThan(0.0005);
  });

  it('Given a hull holding still in the centre frame (the ground sliding under it at ~100 m/s), When it touches down, Then the touchdown reports that slip — the arrival is not silently stopped dead', () => {
    const d = drop(false);
    expect(d.touchdowns.length).toBe(1);
    expect(d.touchdowns[0]!.slip).toBeGreaterThan(0.09);
    expect(d.touchdowns[0]!.slip).toBeLessThan(0.11);
    // It skids on the ground and friction stops it: an honest slide, not an instant stop.
    expect(d.slideKm).toBeGreaterThan(0.01);
  });

  it('Given any touchdown, Then FlightModel itself logs nothing — the graded line is the only one (review: "TOUCHDOWN — CLEAN · x" was followed by a bare "TOUCHDOWN")', () => {
    const d = drop(true);
    expect(d.logs).toEqual([]);
  });

  it('Given a world that does not turn (no landing context), Then slip is just the horizontal speed at contact, as before', () => {
    const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: MU, radius: R });
    fm.setGroundSampler((p) => p.length() - R);
    fm.teleport(new Vector3(0, R + 0.002, 0), new Vector3(0.003, -0.001, 0), new Quaternion());
    const tds: number[] = [];
    offs.push(bus.on('ship:touchdown', (e) => tds.push(e.slip)));
    for (let i = 0; i < 600 && tds.length === 0; i++) fm.update(1 / 60);
    expect(tds.length).toBe(1);
    expect(tds[0]!).toBeGreaterThan(0.0025);
    expect(tds[0]!).toBeLessThan(0.0035);
  });
});
