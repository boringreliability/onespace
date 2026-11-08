/**
 * v4 sub-plan 1 (propellant), Task 2 — the flight model draws on the tank.
 *
 * Contract (rulings R3 + task brief):
 *  - Without a tank the step is v3, bit for bit (pinned by golden numbers).
 *  - With a tank: thrust is scaled by massScale(dry, prop, extra); each
 *    substep needs propellantForImpulse(|thrust accel|, total mass, h, ve),
 *    measured BEFORE drag is added; if the tank gives less than that, thrust
 *    is scaled by got/need in that same substep and `thrustStarved` is set.
 *  - Rotation (torque) is free. Gravity always acts.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { DEFAULT_SHIP_CONFIG, FlightModel } from './FlightModel';
import {
  EXHAUST_VELOCITY_KMS,
  PROBE_DRY_MASS_KG,
  PROBE_TANK_CAPACITY_KG,
  Propellant,
  massScale,
  propellantForImpulse,
} from './propellant';
import { simSlices } from '@/game/timeCompression';

const C = DEFAULT_SHIP_CONFIG;
const H = 1 / 120;
const VE = EXHAUST_VELOCITY_KMS;
const DRY = PROBE_DRY_MASS_KG;

/** Hull at rest in deep space (mu 0, no air), nose −Z, at the origin. */
function deepSpace(): FlightModel {
  const fm = new FlightModel(C);
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0 });
  fm.teleport(new Vector3(), new Vector3(), new Quaternion());
  fm.flightAssist = false;
  return fm;
}

function run(fm: FlightModel, seconds: number, each?: (fm: FlightModel) => void): void {
  for (let i = 0; i < Math.round(seconds / H); i++) {
    fm.update(H);
    each?.(fm);
  }
}

function tank(kg: number): Propellant {
  return new Propellant(PROBE_TANK_CAPACITY_KG, kg / PROBE_TANK_CAPACITY_KG);
}

function totalMass(fm: FlightModel): number {
  return DRY + (fm.propellant?.massKg ?? 0) + fm.extraMassKg;
}

// ---------------------------------------------------------------------------
// Golden v3 trajectory.
//
// Recorded from the UNMODIFIED v3 FlightModel at commit 6c1c4b9 (before Task 2
// touched FlightModel.ts), with exactly the sequence in `flyGoldenSequence`:
// parent at the origin, mu 4e5 km³/s², radius 1000 km; hull at (0, 3000, 0)
// at rest, identity orientation (nose −Z); FA-OFF full main burn for 5 s
// (600 × 1/120 s), then FA-ON + brake (the FA stop) for 5 s, throttle 0.
// Values printed with toPrecision(17).
// ---------------------------------------------------------------------------

const GOLDEN_POS = [0.0, 2998.9424906425347, -3.876783417385028] as const;
const GOLDEN_VEL = [0.0, -0.000030493341888545826, -0.00036622953012823551] as const;

function goldenHull(): FlightModel {
  const fm = new FlightModel(C);
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 4e5, radius: 1000 });
  fm.teleport(new Vector3(0, 3000, 0), new Vector3(), new Quaternion());
  return fm;
}

function flyGoldenSequence(fm: FlightModel): void {
  fm.flightAssist = false;
  fm.command.throttle = 1;
  run(fm, 5);
  fm.command.throttle = 0;
  fm.flightAssist = true;
  fm.command.brake = true;
  run(fm, 5);
}

/** |actual − expected| ≤ 1e-12 · max(1, |expected|). */
function expectGolden(fm: FlightModel): void {
  const p = [fm.position.x, fm.position.y, fm.position.z];
  const v = [fm.velocity.x, fm.velocity.y, fm.velocity.z];
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(p[i]! - GOLDEN_POS[i]!)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(GOLDEN_POS[i]!)));
    expect(Math.abs(v[i]! - GOLDEN_VEL[i]!)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(GOLDEN_VEL[i]!)));
  }
}

describe('[v4-fuel] FlightModel without a tank is v3', () => {
  it('Given no tank attached, When the same input sequence as a v3 test is flown, Then position and velocity match a FlightModel built the v3 way to 1e-12', () => {
    // Uses no v4 API: passes on unmodified v3 and must keep passing.
    const fm = goldenHull();
    flyGoldenSequence(fm);
    expectGolden(fm);
  });

  it('Given attachPropellant(null, ve) (tank detached), When the same sequence is flown, Then it still matches the v3 golden to 1e-12 and nothing reports starvation', () => {
    const fm = goldenHull();
    expect(fm.propellant).toBeNull();
    expect(fm.extraMassKg).toBe(0);
    fm.attachPropellant(null, VE);
    expect(fm.propellant).toBeNull();
    flyGoldenSequence(fm);
    expectGolden(fm);
    expect(fm.thrustStarved).toBe(false);
  });
});

describe('[v4-fuel] FlightModel draws on the tank', () => {
  it('Given a tank, When a 1 s full main burn is flown in vacuum, Then propellant drops by propellantForImpulse(thrust accel, total mass, 1, ve) ± 1 %', () => {
    const fm = deepSpace();
    const p = tank(12_000);
    fm.attachPropellant(p, VE);
    expect(fm.propellant).toBe(p);
    fm.command.throttle = 1;
    run(fm, 3); // spool the drive up to (≈) full output
    const v0 = fm.velocity.clone();
    const kg0 = p.massKg;
    const m0 = totalMass(fm);
    run(fm, 1);
    // Vacuum, mu 0, no rotation: all of Δv is thrust.
    const thrustAccel = fm.velocity.clone().sub(v0).length() / 1;
    const used = kg0 - p.massKg;
    const expected = propellantForImpulse(thrustAccel, m0, 1, VE);
    expect(expected).toBeGreaterThan(0);
    expect(Math.abs(used - expected)).toBeLessThanOrEqual(0.01 * expected);
    // And in absolute terms: F·dt/ve with F = mainThrust (km units) ≈ 40 kg.
    const full = ((C.mainThrust * 1e-3) / C.mass) * DRY * 1 / VE;
    expect(Math.abs(used - full)).toBeLessThanOrEqual(0.01 * full);
    expect(fm.thrustStarved).toBe(false);
  });

  it('Given a tank, When only rotating for 10 s, Then propellant is unchanged', () => {
    const fm = deepSpace();
    const p = tank(5_000);
    fm.attachPropellant(p, VE);
    const kg0 = p.massKg;
    fm.command.pitch = 1;
    fm.command.yaw = 0.5;
    fm.command.roll = -0.7;
    let turned = 0;
    run(fm, 10, (f) => {
      turned = Math.max(turned, f.angularVelocity.length());
    });
    expect(turned).toBeGreaterThan(0.1); // it really did rotate
    expect(p.massKg).toBe(kg0);
    expect(fm.thrustStarved).toBe(false);
  });

  it('Given a tank, When drag decelerates a coasting hull, Then no propellant is used', () => {
    const fm = new FlightModel(C);
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0 });
    fm.teleport(new Vector3(0, 1e4, 0), new Vector3(0, 0, -2), new Quaternion());
    fm.flightAssist = false;
    fm.setAtmosphere(1);
    const p = tank(5_000);
    fm.attachPropellant(p, VE);
    const kg0 = p.massKg;
    run(fm, 2);
    expect(fm.speed).toBeLessThan(1.9); // drag really acted
    expect(p.massKg).toBe(kg0);
    expect(fm.thrustStarved).toBe(false);
  });

  it('Given a full vs an empty tank, Then main-burn acceleration differs by massScale and by less than 10 %', () => {
    // "Empty" here = the dry end of the tank: 1 kg, enough for the first
    // substep (a truly empty tank gives no thrust at all — see the starvation
    // tests). One substep from rest: throttle and limiter are identical in
    // both hulls, so the ratio is exactly the mass response.
    const accelFirstSubstep = (kg: number): number => {
      const fm = deepSpace();
      fm.attachPropellant(tank(kg), VE);
      fm.command.throttle = 1;
      fm.update(H);
      return fm.velocity.length() / H;
    };
    const aFull = accelFirstSubstep(PROBE_TANK_CAPACITY_KG);
    const aEmpty = accelFirstSubstep(1);
    expect(aFull).toBeGreaterThan(0);
    const ratio = aFull / aEmpty;
    const expectedRatio = massScale(DRY, PROBE_TANK_CAPACITY_KG, 0) / massScale(DRY, 1, 0);
    expect(Math.abs(ratio - expectedRatio)).toBeLessThanOrEqual(1e-6);
    expect(ratio).toBeLessThan(1);
    expect(1 - ratio).toBeLessThan(0.1);
  });

  it('Given 1 kg left, When burning at 100× sim rate (simulate with large dt in slices), Then propellant ends at exactly 0, never negative, thrust stops in the same substep, and thrustStarved is true', () => {
    // 100× is not update(100·dt) (the substep ceiling would eat it): the game
    // slices the frame with simSlices, each slice an ordinary update().
    const fm = deepSpace();
    const p = tank(1);
    fm.attachPropellant(p, VE);
    fm.command.throttle = 1;
    const out = { count: 0, slice: 0 };
    const frameDt = 1 / 30;
    let minKg = Number.POSITIVE_INFINITY;
    let simT = 0;
    for (let frame = 0; frame < 3; frame++) {
      simSlices(frameDt, 100, out);
      for (let s = 0; s < out.count; s++) {
        fm.update(out.slice);
        simT += out.slice;
        minKg = Math.min(minKg, p.massKg);
      }
    }
    expect(simT).toBeGreaterThan(9.9); // ~10 s of sim time
    expect(minKg).toBeGreaterThanOrEqual(0);
    expect(p.massKg).toBe(0);
    expect(p.empty).toBe(true);
    expect(fm.thrustStarved).toBe(true);

    // Thrust stops in the substep the tank runs dry: total Δv is exactly the
    // impulse of 1 kg, Σ got·ve/m with m ∈ [dry, dry + 1] — no overshoot.
    const dv = fm.velocity.length();
    expect(dv).toBeGreaterThan(0);
    expect(dv).toBeGreaterThanOrEqual((1 * VE) / (DRY + 1) - 1e-12);
    expect(dv).toBeLessThanOrEqual((1 * VE) / DRY + 1e-12);

    // Consumption follows SIM time: the same burn at 1× for the same sim time
    // ends on the same velocity.
    const ref = deepSpace();
    ref.attachPropellant(tank(1), VE);
    ref.command.throttle = 1;
    run(ref, 10);
    expect(ref.propellant!.massKg).toBe(0);
    expect(Math.abs(ref.velocity.length() - dv)).toBeLessThanOrEqual(1e-12);

    // And once dry, nothing more happens.
    const vDry = fm.velocity.clone();
    run(fm, 1);
    expect(fm.velocity.distanceTo(vDry)).toBe(0);
    expect(fm.thrustStarved).toBe(true);
  });

  it('Given an empty tank, When FA-ON hold is commanded, Then no thrust is applied and gravity still acts', () => {
    const make = (): FlightModel => {
      const fm = new FlightModel(C);
      fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 4e5, radius: 1000 });
      fm.teleport(new Vector3(0, 2000, 0), new Vector3(), new Quaternion());
      return fm;
    };
    const fm = make();
    fm.attachPropellant(tank(0), VE);
    fm.flightAssist = true;
    fm.command.throttle = 0.5; // a hold: the computer would cancel gravity and fly the nose
    expect(fm.propellant!.empty).toBe(true);

    // Ballistic twin: no tank, FA-OFF, lever at 0 — pure free fall.
    const twin = make();
    twin.flightAssist = false;

    let maxProper = 0;
    for (let i = 0; i < 240; i++) {
      fm.update(H);
      twin.update(H);
      maxProper = Math.max(maxProper, fm.properAccel.length());
    }
    expect(fm.assistState).toBe('hold');
    expect(fm.thrustStarved).toBe(true);
    expect(maxProper).toBeLessThanOrEqual(1e-15); // no thrust at all
    // Gravity still acts: 2 s at g = 4e5/2000² = 0.1 km/s² towards the parent.
    expect(fm.velocity.y).toBeLessThan(-0.15);
    expect(fm.velocity.distanceTo(twin.velocity)).toBeLessThanOrEqual(1e-12);
    expect(fm.position.distanceTo(twin.position)).toBeLessThanOrEqual(1e-9);
    expect(fm.propellant!.massKg).toBe(0);
  });
});
