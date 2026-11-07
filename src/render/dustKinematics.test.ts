/**
 * v3 T4 / PLAN E1 — orbital dust.
 *
 * The audit's V1: nothing in the frame changes with speed. Dust is the cheap,
 * honest fix, but only if its frame of reference is right. Dust that stands
 * still in the inertial frame streams past at 7 km/s in every orbit, which
 * reads as "fast" while the ship is in fact coasting — the opposite of the
 * truth the player needs. So the dust lives in the LOCAL CIRCULAR-ORBIT frame
 * (surface-relative inside an atmosphere): coasting in orbit it is near still,
 * and a burn makes it stream in proportion to the Δv the burn bought.
 *
 * Units: positions km, velocities km/s (parent-relative, as FlightModel), the
 * dust cube and streaks in metres.
 */

import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  DUST_CUBE_M,
  DUST_MAX_STREAK_M,
  DustDrift,
  dustEnabled,
  dustForwardScatter,
  dustReferenceVelocity,
  dustRelativeVelocity,
  inPlanetShadow,
  streakLengthM,
  wrapToCube,
} from './dustKinematics';

const MU = 398600.4418; // km³/s², an Earth-mass parent
const R = 7240 * 1.6; // the opening orbit radius about Remit 31, km

function circular(r: Vector3, mu = MU): Vector3 {
  // Prograde about +Y for a position in the XZ plane.
  const vc = Math.sqrt(mu / r.length());
  return new Vector3().crossVectors(new Vector3(0, 1, 0), r).normalize().multiplyScalar(vc);
}

describe('dustReferenceVelocity / dustRelativeVelocity: the local circular-orbit frame', () => {
  const r = new Vector3(R, 0, 0);
  const v = circular(r);

  it('Given a ship coasting in a circular orbit, Then the dust is still relative to it (|v_rel| < 1 m/s)', () => {
    const rel = dustRelativeVelocity(r, v, MU, null, new Vector3());
    expect(rel.length()).toBeLessThan(1e-3);
  });

  it('Given a prograde burn of Δv, Then the dust streams at ≈ Δv, backwards along the burn', () => {
    const dv = 0.25; // km/s
    const burned = v.clone().add(v.clone().normalize().multiplyScalar(dv));
    const rel = dustRelativeVelocity(r, burned, MU, null, new Vector3());
    expect(rel.length()).toBeCloseTo(dv, 3);
    expect(rel.dot(v)).toBeGreaterThan(0); // ship moves forward through the dust
  });

  it('Given a retrograde burn of Δv, Then the dust streams at ≈ Δv the other way (both directions read)', () => {
    const dv = 0.4;
    const burned = v.clone().add(v.clone().normalize().multiplyScalar(-dv));
    const rel = dustRelativeVelocity(r, burned, MU, null, new Vector3());
    expect(rel.length()).toBeCloseTo(dv, 3);
    expect(rel.dot(v)).toBeLessThan(0);
  });

  it('Given a radial burn, Then the radial Δv streams (the circular frame has no radial motion)', () => {
    const burned = v.clone().add(new Vector3(0.1, 0, 0));
    const rel = dustRelativeVelocity(r, burned, MU, null, new Vector3());
    expect(rel.x).toBeCloseTo(0.1, 4);
  });

  it('Given a bigger burn, Then the relative speed is larger (monotone in Δv)', () => {
    let prev = -1;
    for (const dv of [0, 0.05, 0.2, 0.8, 2]) {
      const burned = v.clone().add(v.clone().normalize().multiplyScalar(dv));
      const s = dustRelativeVelocity(r, burned, MU, null, new Vector3()).length();
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });

  it('Given the ship inside an atmosphere (a spin vector is passed), Then the reference is the co-rotating surface (ω × r)', () => {
    const spin = new Vector3(0, 2 * Math.PI / 86400, 0);
    const ref = dustReferenceVelocity(r, v, MU, spin, new Vector3());
    expect(ref.distanceTo(new Vector3().crossVectors(spin, r))).toBeLessThan(1e-12);
  });

  it('Given a ship resting on a rotating world, Then the dust is still (surface-relative)', () => {
    const spin = new Vector3(0, 2 * Math.PI / 86400, 0);
    const surf = new Vector3(6371, 0, 0);
    const resting = new Vector3().crossVectors(spin, surf);
    expect(dustRelativeVelocity(surf, resting, MU, spin, new Vector3()).length()).toBeLessThan(1e-12);
  });

  // review-v3b: FlightModel holds a LANDED ship at zero frame velocity and
  // turns it with the world kinematically (carryWithSurface) — it does not
  // carry ω × r in its velocity, as the test above assumes. Landed in air the
  // reference is ω × r, so the dust streamed past a parked ship at |ω × r|.
  it('Given a ship LANDED in an atmosphere (FlightModel: velocity 0, carried kinematically), Then the dust is still', () => {
    const spin = new Vector3(0, 2 * Math.PI / 86400, 0);
    const surf = new Vector3(6371, 0, 0);
    const parked = new Vector3(0, 0, 0);
    expect(dustRelativeVelocity(surf, parked, MU, spin, new Vector3(), true).length()).toBe(0);
  });

  it('Given a ship landed on an airless world, Then the dust is still too', () => {
    const surf = new Vector3(6371, 0, 0);
    expect(dustRelativeVelocity(surf, new Vector3(0, 0, 0), MU, null, new Vector3(), true).length()).toBe(0);
  });

  it('Given no parent to orbit (mu 0 or null), Then the dust is still whatever the ship does (no frame to stream against)', () => {
    const rel = dustRelativeVelocity(r, new Vector3(30, 0, 0), null, null, new Vector3());
    expect(rel.length()).toBe(0);
    expect(dustRelativeVelocity(r, new Vector3(30, 0, 0), 0, null, new Vector3()).length()).toBe(0);
  });

  it('Given the horizontal speed sweeping through zero (a hover), Then the reference never jumps (nothing snaps, §6)', () => {
    // Retro-burn from orbit down to a hover and on past it: the reference must
    // change continuously, or the dust field would flip direction in a frame.
    const vc = v.length();
    const t = v.clone().normalize();
    let prev: Vector3 | null = null;
    for (let s = 1.2 * vc; s >= -0.2 * vc; s -= vc / 400) {
      const ref = dustReferenceVelocity(r, t.clone().multiplyScalar(s), MU, null, new Vector3());
      if (prev) expect(ref.distanceTo(prev)).toBeLessThan(0.05 * vc);
      prev = ref;
    }
  });

  it('Given a ship hovering at rest in vacuum, Then the dust is near still (no 7 km/s storm at a hover)', () => {
    const rel = dustRelativeVelocity(r, new Vector3(), MU, null, new Vector3());
    expect(rel.length()).toBeLessThan(1e-9);
  });

  it('Given non-finite inputs, Then the reference is zero rather than NaN', () => {
    const ref = dustReferenceVelocity(new Vector3(Number.NaN, 0, 0), v, MU, null, new Vector3());
    expect(Number.isFinite(ref.x) && Number.isFinite(ref.y) && Number.isFinite(ref.z)).toBe(true);
  });

  it('Given the inputs, Then they are not mutated and `out` is returned', () => {
    const rc = r.clone();
    const vcl = v.clone();
    const out = new Vector3();
    expect(dustRelativeVelocity(r, v, MU, null, out)).toBe(out);
    expect(r.equals(rc) && v.equals(vcl)).toBe(true);
  });
});

describe('wrapToCube: the field wraps around the camera', () => {
  it('Given a coordinate inside the cube, Then it is unchanged', () => {
    expect(wrapToCube(12.5, 400)).toBeCloseTo(12.5, 12);
    expect(wrapToCube(-199, 400)).toBeCloseTo(-199, 12);
  });

  it('Given any coordinate, Then the result lies in [-size/2, size/2)', () => {
    for (const x of [-1e9, -401, -200, 199.999, 200, 401, 1234.5, 1e12]) {
      const w = wrapToCube(x, 400);
      expect(w).toBeGreaterThanOrEqual(-200);
      expect(w).toBeLessThan(200);
    }
  });

  it('Given a coordinate one cube away, Then it wraps to the same place (periodic)', () => {
    expect(wrapToCube(37 + 400, 400)).toBeCloseTo(37, 9);
    expect(wrapToCube(37 - 800, 400)).toBeCloseTo(37, 9);
  });

  it('Given the default cube, Then it is ~400 m', () => {
    expect(DUST_CUBE_M).toBeGreaterThanOrEqual(300);
    expect(DUST_CUBE_M).toBeLessThanOrEqual(500);
  });
});

describe('streakLengthM: streak = relative speed × shutter', () => {
  it('Given zero relative velocity, Then the streak has zero length (a point, not a smear)', () => {
    expect(streakLengthM(0, 1 / 60)).toBe(0);
  });

  it('Given 100 m/s and a 1/50 s shutter, Then the streak is 2 m', () => {
    expect(streakLengthM(0.1, 1 / 50)).toBeCloseTo(2, 9);
  });

  it('Given a doubling of speed below the cap, Then the streak doubles (linear)', () => {
    expect(streakLengthM(0.2, 1 / 50)).toBeCloseTo(2 * streakLengthM(0.1, 1 / 50), 9);
  });

  it('Given an absurd speed (a teleport, a cruise exit), Then the streak is capped', () => {
    expect(streakLengthM(5000, 1 / 30)).toBe(DUST_MAX_STREAK_M);
    expect(DUST_MAX_STREAK_M).toBeLessThan(DUST_CUBE_M / 2);
  });

  it('Given a non-finite or negative speed, Then the streak is 0', () => {
    expect(streakLengthM(Number.NaN, 1 / 60)).toBe(0);
    expect(streakLengthM(-1, 1 / 60)).toBe(0);
  });
});

describe('DustDrift: the field offset is integrated from relative velocity, never from position', () => {
  it('Given zero relative velocity for ten minutes, Then the field does not move', () => {
    const d = new DustDrift(400);
    const before = d.offsetM.clone();
    for (let i = 0; i < 36000; i++) d.advance(new Vector3(), 1 / 60);
    expect(d.offsetM.distanceTo(before)).toBe(0);
  });

  it('Given the ship moving +X at 10 m/s relative for 1 s, Then the dust moved 10 m in -X', () => {
    const d = new DustDrift(400);
    const x0 = d.offsetM.x;
    for (let i = 0; i < 60; i++) d.advance(new Vector3(0.01, 0, 0), 1 / 60);
    const moved = wrapToCube(d.offsetM.x - x0, 400);
    expect(moved).toBeCloseTo(-10, 6);
  });

  it('Given any history, Then the offset stays inside one cube (no float growth in a long session)', () => {
    const d = new DustDrift(400);
    for (let i = 0; i < 10000; i++) d.advance(new Vector3(7.8, -3, 1.2), 1 / 60);
    for (const c of [d.offsetM.x, d.offsetM.y, d.offsetM.z]) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(400);
    }
  });

  it('Given a floating-origin rebase (the camera position jumps, the velocity does not), Then nothing in the drift changes — it never reads position', () => {
    // The API has no position input at all: a rebase cannot reach it. This
    // pins that: two drifts fed the same velocities agree exactly.
    const a = new DustDrift(400);
    const b = new DustDrift(400);
    for (let i = 0; i < 100; i++) {
      a.advance(new Vector3(0.3, 0, 0), 1 / 60);
      b.advance(new Vector3(0.3, 0, 0), 1 / 60);
    }
    expect(a.offsetM.equals(b.offsetM)).toBe(true);
  });

  it('Given a non-finite velocity or dt, Then the step is skipped (no NaN poisoning the field)', () => {
    const d = new DustDrift(400);
    const before = d.offsetM.clone();
    d.advance(new Vector3(Number.NaN, 0, 0), 1 / 60);
    d.advance(new Vector3(1, 0, 0), Number.NaN);
    expect(d.offsetM.equals(before)).toBe(true);
  });
});

describe('dustEnabled: off in cruise and warp', () => {
  it('Given sublight flight, Then the dust is on', () => {
    expect(dustEnabled({ cruise: false, warp: false })).toBe(true);
  });
  it('Given the cruise drive engaged, Then it is off (0.78c through dust is a lie)', () => {
    expect(dustEnabled({ cruise: true, warp: false })).toBe(false);
  });
  it('Given a jump in progress, Then it is off (the tunnel owns the frame)', () => {
    expect(dustEnabled({ cruise: false, warp: true })).toBe(false);
  });
});

describe('dustForwardScatter / inPlanetShadow: lit only when facing the star', () => {
  it('Given the view ray pointing at the star, Then the dust is fully lit (forward scatter)', () => {
    expect(dustForwardScatter(1)).toBeCloseTo(1, 6);
  });

  it('Given the view ray pointing away from the star, Then it is practically dark (≤ 5 %)', () => {
    expect(dustForwardScatter(-1)).toBeLessThanOrEqual(0.05);
    expect(dustForwardScatter(0)).toBeLessThan(0.35);
  });

  it('Given the ray swept from away to towards, Then brightness rises monotonically within [0, 1]', () => {
    let prev = -1;
    for (let c = -1; c <= 1.0000001; c += 0.05) {
      const b = dustForwardScatter(c);
      expect(b).toBeGreaterThanOrEqual(prev);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
      prev = b;
    }
  });

  it('Given the ship behind the planet from the star, Then it is in shadow (dust unlit)', () => {
    const toStar = new Vector3(1, 0, 0);
    expect(inPlanetShadow(new Vector3(-8000, 0, 0), toStar, 7240)).toBe(true);
  });

  it('Given the ship on the day side or beside the shadow cylinder, Then it is lit', () => {
    const toStar = new Vector3(1, 0, 0);
    expect(inPlanetShadow(new Vector3(8000, 0, 0), toStar, 7240)).toBe(false);
    expect(inPlanetShadow(new Vector3(-8000, 7300, 0), toStar, 7240)).toBe(false);
  });
});
