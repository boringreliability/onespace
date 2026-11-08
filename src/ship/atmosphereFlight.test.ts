/**
 * [v3-atmo] Flight in air (owner: "flying in a planet's atmosphere is quite
 * flaky — the controls and the camera jump around").
 *
 * Two root causes, measured (see the branch's commit message):
 *
 * 1. The rate command flew the aerodynamic moment as an UNKNOWN disturbance.
 *    `stepRotation` integrated the weathercock (and the gyroscopic term) into
 *    ω and then let the rate loop — proportional, τ_down 0.10 s — fly it back
 *    out. A proportional loop holds a constant moment M only with a standing
 *    error of τ·M, so with the stick released the hull kept turning on its
 *    own (2 km/s, 1 bar, 20° of relative wind: 4.4°/s; 4 km/s, 60°: 52°/s);
 *    a demanded rate came out short (35 → 14°/s); and between α_max and
 *    α_brake the "brake through zero" branch chattered ω across zero every
 *    substep. The computer computes that moment itself, so it now cancels
 *    it — up to the RCS's authority — and only the excess turns the hull.
 *
 * 2. The air did not turn with its world. Drag, weathercock and heating used
 *    the centre-frame velocity, so on a turning world a hull flying with the
 *    ground sat in a crosswind of ω×r (Grey Angle 0.39 km/s, the generator
 *    goes past 2 km/s) — while the dust and the autopilot already treated the
 *    ground's motion as the reference. The relative wind is now v − ω×r.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { PlanetSpec } from '@/gen/types';
import { DEFAULT_SHIP_CONFIG, FlightModel } from './FlightModel';
import { MAX_RATE } from './rateCommand';
import { groundVelocity, spinAngularVelocity } from './surfaceSpin';

const DEG = Math.PI / 180;
const H = 1 / 120;
const X = new Vector3(1, 0, 0);

/** A hull in air with no gravity, nose −Z, relative wind `aoaDeg` off the nose in pitch. */
function inAir(rho: number, speed: number, aoaDeg: number, fa = false): FlightModel {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0 });
  // Positive aoa: the velocity sits ABOVE the nose (towards +Y), so the
  // weathercock pitches the nose up.
  const v = new Vector3(0, 0, -speed).applyAxisAngle(X, aoaDeg * DEG);
  fm.teleport(new Vector3(0, 1e4, 0), v, new Quaternion());
  fm.flightAssist = fa;
  fm.setAtmosphere(rho);
  return fm;
}

/** Weathercock angular acceleration the model applies, rad/s² (FlightModel's own law). */
function aeroMoment(rho: number, speed: number, aoaDeg: number): number {
  return DEFAULT_SHIP_CONFIG.aeroAlign * rho * speed * speed * Math.sin(aoaDeg * DEG);
}

function relativeWindAngle(fm: FlightModel): number {
  return Math.acos(Math.min(1, fm.forward.dot(fm.velocity.clone().normalize()))) / DEG;
}

describe('[v3-atmo] rate command against the aerodynamic moment', () => {
  it('Given air pressing 1.8 rad/s² of weathercock on the nose (inside the RCS), When the stick is released, Then the hull holds its attitude: |ω| < 0.05°/s and the nose moves < 0.2° in 4 s', () => {
    // 1 bar-ish, 2 km/s, 30° of relative wind: M = 0.9·1·4·0.5 = 1.8 rad/s².
    const fm = inAir(1, 2, 30);
    expect(aeroMoment(1, 2, 30)).toBeCloseTo(1.8, 5);
    const nose0 = fm.forward.clone();
    let wMax = 0;
    for (let i = 0; i < 480; i++) {
      fm.update(H);
      wMax = Math.max(wMax, fm.angularVelocity.length());
    }
    expect(wMax / DEG).toBeLessThan(0.05);
    expect(fm.forward.angleTo(nose0) / DEG).toBeLessThan(0.2);
  });

  it('Given that same moment, When full pitch is held AGAINST the wind for 1 s, Then the rate reaches ≥ 97 % of the 35°/s demand (authority is not eaten by the air)', () => {
    // Nose-down demand while the wind is above the nose: the weathercock
    // opposes the turn. Before: ω settled ~25 % short.
    const fm = inAir(1, 2, 30);
    fm.command.pitch = -1;
    for (let i = 0; i < 120; i++) fm.update(H);
    expect(-fm.angularVelocity.x).toBeGreaterThan(0.97 * MAX_RATE.pitch);
  });

  it('Given that moment, When pitch is held WITH the wind, Then the rate never overshoots the demand', () => {
    const fm = inAir(1, 2, 30);
    fm.command.pitch = 1;
    let wMax = 0;
    for (let i = 0; i < 120; i++) {
      fm.update(H);
      wMax = Math.max(wMax, fm.angularVelocity.x);
    }
    expect(wMax).toBeLessThanOrEqual(MAX_RATE.pitch + 1e-9);
    expect(wMax).toBeGreaterThan(0.97 * MAX_RATE.pitch);
  });

  it('Given a moment between α_max and α_brake (4 rad/s²), When the pilot demands a turn into the wind, Then ω does not chatter across zero substep to substep and the turn builds', () => {
    // 2 km/s, ρ 2, 34°: M ≈ 4.0. Before: the brake-through-zero branch pinned ω
    // at ~−1°/s, flipping its sign every substep.
    const fm = inAir(2, 2, 34);
    expect(aeroMoment(2, 2, 34)).toBeGreaterThan(3.9);
    fm.command.pitch = -1;
    let flips = 0;
    let prev = 0;
    for (let i = 0; i < 120; i++) {
      fm.update(H);
      const w = fm.angularVelocity.x;
      if (i > 0 && w !== 0 && prev !== 0 && Math.sign(w) !== Math.sign(prev)) flips++;
      prev = w;
    }
    expect(flips).toBe(0);
    expect(-fm.angularVelocity.x).toBeGreaterThan(0.5 * MAX_RATE.pitch);
  });

  it('Given a moment far beyond the RCS (4 km/s, ρ 1, 60°), When hands-off, Then physics wins honestly: the nose weathervanes into the wind monotonically and settles (< 1°/s) without ω reversing', () => {
    const fm = inAir(1, 4, 60);
    expect(aeroMoment(1, 4, 60)).toBeGreaterThan(12);
    let prevAoa = relativeWindAngle(fm);
    let increases = 0;
    let reversals = 0;
    let prevW = 0;
    for (let i = 0; i < 6 * 120; i++) {
      fm.update(H);
      const a = relativeWindAngle(fm);
      if (a > prevAoa + 1e-6) increases++;
      prevAoa = a;
      const w = fm.angularVelocity.x;
      if (prevW > 1e-6 && w < -1e-6) reversals++;
      prevW = w;
    }
    expect(increases).toBe(0);
    expect(reversals).toBe(0);
    expect(relativeWindAngle(fm)).toBeLessThan(5);
    expect(fm.angularVelocity.length() / DEG).toBeLessThan(1);
  });

  it('Given vacuum, When a pitch is flown and released, Then ω follows exactly the pure rate law (no aero moment, single axis: nothing to cancel)', () => {
    const a = inAir(0, 1, 0);
    a.command.pitch = 1;
    const seq: number[] = [];
    for (let i = 0; i < 240; i++) {
      if (i === 120) a.command.pitch = 0;
      a.update(H);
      seq.push(a.angularVelocity.x);
    }
    // Spin-up then a sharp stop; no residual.
    expect(Math.max(...seq)).toBeCloseTo(MAX_RATE.pitch, 6);
    expect(seq[seq.length - 1]).toBe(0);
  });

  it('Given attitude hold OFF in air, Then the weathercock still acts on the raw hull (the cancellation belongs to the flight computer only)', () => {
    const fm = inAir(1, 2, 30);
    fm.attitudeHold = false;
    fm.update(H);
    expect(fm.angularVelocity.x).toBeGreaterThan(0.9 * aeroMoment(1, 2, 30) * H);
  });
});

// ---------------------------------------------------------------------------

const R = 6000;
const PERIOD = 20000; // ω·R ≈ 1.88 km/s at the equator
const TILT = 0;

function turningWorld(rho: number): { fm: FlightModel; ground: Vector3; pos: Vector3 } {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0, radius: R });
  fm.setLandingContext({ id: 't', name: 'turning', rotationPeriod: PERIOD, axialTilt: TILT } as unknown as PlanetSpec);
  const pos = new Vector3(R + 2, 0, 0); // on the equator, 2 km up
  const ground = groundVelocity(spinAngularVelocity(PERIOD, TILT, new Vector3()), pos, new Vector3());
  fm.setAtmosphere(rho);
  return { fm, ground, pos };
}

describe('[v3-atmo] the air turns with its world', () => {
  it('Given a turning world, When the hull moves exactly with the ground (v = ω×r) in thick air, Then it feels no drag', () => {
    const { fm, ground, pos } = turningWorld(1);
    fm.flightAssist = false;
    fm.teleport(pos, ground.clone(), new Quaternion());
    fm.update(H);
    // ω×r turns as the hull moves round, so compare against the ground at the
    // new position: what is left is drag, and there is none.
    const after = groundVelocity(spinAngularVelocity(PERIOD, TILT, new Vector3()), fm.position, new Vector3());
    expect(fm.velocity.distanceTo(after)).toBeLessThan(1e-6);
  });

  it('Given a turning world, When the hull moves with the ground, Then there is no weathercock (raw hull, hold off) and no heating', () => {
    const { fm, ground, pos } = turningWorld(1);
    fm.flightAssist = false;
    fm.attitudeHold = false;
    // Nose along the radial: 90° off the ground's motion.
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), new Vector3(1, 0, 0));
    fm.teleport(pos, ground.clone(), q);
    for (let i = 0; i < 120; i++) fm.update(H);
    expect(fm.angularVelocity.length()).toBeLessThan(1e-9);
    expect(fm.heating).toBeLessThan(1e-6);
  });

  it('Given a turning world, When the hull is at rest in the centre frame, Then the air carries it along ω×r (drag = c·ρ·|ω×r|·ω×r)', () => {
    const { fm, ground, pos } = turningWorld(1);
    fm.flightAssist = false;
    fm.teleport(pos, new Vector3(), new Quaternion());
    fm.update(H);
    const g = ground.length();
    const expected = DEFAULT_SHIP_CONFIG.dragCoefficient * 1 * g * g * H;
    expect(fm.velocity.length()).toBeCloseTo(expected, 6);
    expect(fm.velocity.clone().normalize().dot(ground.clone().normalize())).toBeGreaterThan(0.9999);
  });

  it('Given a world that does not turn, Then drag is exactly the still-air law −c·ρ·|v|·v', () => {
    const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0, radius: R });
    fm.setAtmosphere(1);
    fm.flightAssist = false;
    fm.teleport(new Vector3(R + 2, 0, 0), new Vector3(0, 0, -1), new Quaternion());
    fm.update(H);
    const expected = 1 - DEFAULT_SHIP_CONFIG.dragCoefficient * 1 * 1 * H;
    expect(fm.velocity.length()).toBeCloseTo(expected, 9);
  });

  it('Given a hull resting on a turning world in air (its velocity is surface-relative, D24), Then the air does not shove it: it stays at rest', () => {
    const { fm } = turningWorld(1);
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0.4, radius: R });
    fm.setGroundSampler((p) => p.length() - R);
    fm.flightAssist = false;
    // Arrive matching the ground (so the touchdown leaves no slip), sinking 1 m/s.
    const at = new Vector3(R + 1e-4, 0, 0);
    const v = groundVelocity(spinAngularVelocity(PERIOD, TILT, new Vector3()), at, new Vector3()).add(new Vector3(-0.001, 0, 0));
    fm.teleport(at, v, new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(1, 0, 0)));
    for (let i = 0; i < 240; i++) fm.update(H);
    expect(fm.grounded).toBe(true);
    expect(fm.velocity.length()).toBeLessThan(1e-3);
  });
});
