/**
 * [v3-T2] FA-ON polish (PLAN §1 A3, phase B).
 *
 * Audit: the assist actuator went 0 → 20 g in one 1/120 s substep, the speed
 * overshot +20 % after a 55° turn, and the Space stop ended in a ~2.3 s
 * exponential tail. v3:
 *
 *  - the assist output passes a first-order actuator (τa 0.15 s) with a slew
 *    bound, so |Δa| per substep ≤ a_axis·h/τa while the computer is flying;
 *  - main drive is cut while |v| > 1.02·v_set;
 *  - the stop decelerates at full retro, then rounds off on a jerk-limited √
 *    profile instead of the long exponential tail.
 *
 * Kept from v2 (D23/D24/D33/D39/D40, tested in flightAssist.test.ts and
 * flightAssistSoi.test.ts): lever 0 is the coast detent, bit-identical to
 * FA-OFF, with the drive cut from the next substep (no actuator tail), and the
 * SOI latch.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { DEFAULT_SHIP_CONFIG, FlightModel, assistTargetSpeed } from './FlightModel';
import { ASSIST_ACTUATOR_TAU, OVERSPEED_CUT, actuatorStep, stopDecel } from './assistShape';

const C = DEFAULT_SHIP_CONFIG;
const MAIN = (C.mainThrust / C.mass) * 1e-3;
const RETRO = (C.brakeThrust / C.mass) * 1e-3;
const RCS = (C.rcsThrust / C.mass) * 1e-3;
const H = 1 / 120;

function deepSpace(assist = true): FlightModel {
  const fm = new FlightModel(C);
  fm.flightAssist = assist;
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0 });
  fm.teleport(new Vector3(), new Vector3(), new Quaternion());
  return fm;
}

function run(fm: FlightModel, seconds: number, each?: (fm: FlightModel) => void): void {
  for (let i = 0; i < Math.round(seconds / H); i++) {
    fm.update(H);
    each?.(fm);
  }
}

// ---------------------------------------------------------------------------

describe('[v3-T2] actuatorStep (pure)', () => {
  it('Given the tuning, Then τa is 0.15 s and the overspeed cut is 1.02·v_set', () => {
    expect(ASSIST_ACTUATOR_TAU).toBe(0.15);
    expect(OVERSPEED_CUT).toBe(1.02);
  });

  it('Given a step demand, Then the output never moves more than a_max·h/τa in one substep', () => {
    let a = 0;
    for (let i = 0; i < 120; i++) {
      const n = actuatorStep(a, MAIN, H, MAIN);
      expect(Math.abs(n - a)).toBeLessThanOrEqual((MAIN * H) / ASSIST_ACTUATOR_TAU + 1e-15);
      a = n;
    }
  });

  it('Given a full reversal (+a_max → −a_max), Then the slew bound still holds', () => {
    let a = MAIN;
    for (let i = 0; i < 360; i++) {
      const n = actuatorStep(a, -MAIN, H, MAIN);
      expect(Math.abs(n - a)).toBeLessThanOrEqual((MAIN * H) / ASSIST_ACTUATOR_TAU + 1e-15);
      a = n;
    }
    expect(a).toBeCloseTo(-MAIN, 6);
  });

  it('Given a small step (inside the slew bound), Then it is first-order: 63 % after τa, and never overshoots the demand', () => {
    let a = 0;
    const d = MAIN * 0.1;
    let max = 0;
    for (let i = 0; i < Math.round(ASSIST_ACTUATOR_TAU / H); i++) {
      a = actuatorStep(a, d, H, MAIN);
      max = Math.max(max, a);
    }
    expect(a / d).toBeGreaterThan(0.6);
    expect(a / d).toBeLessThan(0.68);
    for (let i = 0; i < 600; i++) {
      a = actuatorStep(a, d, H, MAIN);
      max = Math.max(max, a);
    }
    expect(max).toBeLessThanOrEqual(d);
  });
});

describe('[v3-T2] stopDecel: the rounded-√ stop profile (pure)', () => {
  it('Given a large speed error, Then the demand is the full cap (constant deceleration)', () => {
    expect(stopDecel(1.7, RETRO)).toBe(RETRO);
    expect(stopDecel(0.2, RETRO)).toBe(RETRO);
  });

  it('Given the error swept down to 0, Then the demand is monotone, ≤ the cap, and exactly 0 at 0', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let e = 0.5; e >= 0; e -= 0.0005) {
      const a = stopDecel(Math.max(0, e), RETRO);
      expect(a).toBeLessThanOrEqual(prev);
      expect(a).toBeLessThanOrEqual(RETRO);
      expect(a).toBeGreaterThanOrEqual(0);
      prev = a;
    }
    expect(stopDecel(0, RETRO)).toBe(0);
  });

  it('Given v′ = −stopDecel(v) from 1.7 km/s, Then v is under 1 m/s within v/a + 0.3 s and never goes negative', () => {
    let v = 1.7;
    let t = 0;
    let min = v;
    while (v >= 0.001 && t < 30) {
      v -= stopDecel(v, RETRO) * H;
      min = Math.min(min, v);
      t += H;
    }
    expect(t).toBeLessThanOrEqual(1.7 / RETRO + 0.3);
    expect(min).toBeGreaterThanOrEqual(0);
  });

  it('Given a negative or non-finite error, Then the demand is 0, never NaN', () => {
    expect(stopDecel(-1, RETRO)).toBe(0);
    expect(stopDecel(Number.NaN, RETRO)).toBe(0);
  });

  // [review-v3a] mutation survivors: each segment of the rounded-√ stop is pinned.
  it('Given a tiny, a middling and a large error, Then the demand is e/τmin, √(2·J·e) and the cap respectively (J = cap/τa)', () => {
    const J = RETRO / ASSIST_ACTUATOR_TAU;
    const eTiny = 0.0005;
    const eMid = ((RETRO * RETRO) / (2 * J)) * 0.5; // under the cap's knee
    expect(stopDecel(eTiny, RETRO)).toBeCloseTo(eTiny / 0.05, 12);
    expect(Math.sqrt(2 * J * eMid)).toBeLessThan(eMid / 0.05);
    expect(stopDecel(eMid, RETRO)).toBeCloseTo(Math.sqrt(2 * J * eMid), 12);
    expect(stopDecel(10, RETRO)).toBe(RETRO);
  });
});

// ---------------------------------------------------------------------------

/**
 * Body-axis thrust acceleration per substep (deep space: Δv/h is thrust).
 * Calls `check(prev, now)` for every pair of substeps while the computer is
 * flying (hold or stop); the detent cut into coast is exempt by design.
 */
function jerkScenario(script: (fm: FlightModel, t: number) => void, seconds: number): { fwd: number; lat: number } {
  const fm = deepSpace(true);
  const prevV = new Vector3();
  const dv = new Vector3();
  let prev: [number, number, number] | null = null;
  let worstF = 0;
  let worstL = 0;
  for (let i = 0; i < Math.round(seconds / H); i++) {
    script(fm, i * H);
    prevV.copy(fm.velocity);
    fm.update(H);
    dv.copy(fm.velocity).sub(prevV).multiplyScalar(1 / H);
    const now: [number, number, number] = [dv.dot(fm.forward), dv.dot(fm.right), dv.dot(fm.up)];
    const flying = fm.assistState === 'hold' || fm.assistState === 'stop';
    if (prev && flying) {
      worstF = Math.max(worstF, Math.abs(now[0] - prev[0]));
      worstL = Math.max(worstL, Math.abs(now[1] - prev[1]), Math.abs(now[2] - prev[2]));
    }
    prev = flying ? now : null;
  }
  return { fwd: worstF, lat: worstL };
}

describe('[v3-T2] FA-ON actuator jerk bound', () => {
  const FWD_BOUND = (Math.max(MAIN, RETRO) * H) / ASSIST_ACTUATOR_TAU + 1e-12;
  const LAT_BOUND = (RCS * H) / ASSIST_ACTUATOR_TAU + 1e-12;

  it('Given FA-ON from rest, When the lever goes to 0.5, Then no substep changes forward thrust by more than a·h/τa (audit: 0 → 20 g in one)', () => {
    const w = jerkScenario((fm, t) => {
      if (t === 0) fm.command.throttle = 0.5;
    }, 12);
    expect(w.fwd).toBeLessThanOrEqual(FWD_BOUND);
  });

  it('Given FA-ON holding, When Space is pressed and later released, Then the hold→stop→hold transitions respect the bound', () => {
    const w = jerkScenario((fm, t) => {
      fm.command.throttle = 0.5;
      fm.command.brake = t >= 10 && t < 20;
    }, 30);
    expect(w.fwd).toBeLessThanOrEqual(FWD_BOUND);
  });

  it('Given FA-ON with sideways drift appearing at once, Then RCS ramps in within the lateral bound', () => {
    const w = jerkScenario((fm, t) => {
      if (t === 0) {
        fm.command.throttle = 0.3;
        fm.teleport(new Vector3(), new Vector3(0.5, -0.4, -0.2), new Quaternion());
      }
    }, 15);
    expect(w.lat).toBeLessThanOrEqual(LAT_BOUND);
  });

  it('Given FA-ON accelerating from rest, Then the speed reaches v_set without overshooting it (ζ ≥ 0.9)', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0.5;
    const vset = assistTargetSpeed(0.5, C.topSpeed);
    let max = 0;
    run(fm, vset / MAIN + 15, (f) => {
      max = Math.max(max, f.speed);
    });
    expect(max).toBeLessThanOrEqual(vset * 1.002);
    expect(Math.abs(fm.speed - vset) / vset).toBeLessThan(0.002);
  });
});

describe('[v3-T2] FA-ON overspeed: main is cut above 1.02·v_set', () => {
  it('Given a hold at 1.7 km/s, When the nose is flown through 90° on the stick, Then |v| never exceeds 1.02·v_set (audit: +20 %)', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0.5;
    const vset = assistTargetSpeed(0.5, C.topSpeed);
    run(fm, vset / MAIN + 10);
    let max = 0;
    // Full pitch for 90° at 35°/s, plus spin-up; then hands off.
    const turnS = 90 / 35 + 0.3;
    for (let i = 0; i < Math.round(40 / H); i++) {
      fm.command.pitch = i * H < turnS ? 1 : 0;
      fm.update(H);
      max = Math.max(max, fm.speed);
    }
    expect(max).toBeLessThanOrEqual(OVERSPEED_CUT * vset + 1e-9);
  });

  it('Given a hold, When the nose is snapped through 90° at once, Then |v| stays ≤ 1.02·v_set and the velocity still swings onto the nose', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0.4;
    const vset = assistTargetSpeed(0.4, C.topSpeed);
    run(fm, vset / MAIN + 10);
    fm.orientation.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    let max = 0;
    run(fm, vset / RCS + 20, (f) => {
      max = Math.max(max, f.speed);
    });
    expect(max).toBeLessThanOrEqual(OVERSPEED_CUT * vset + 1e-9);
    expect(fm.velocity.clone().normalize().dot(fm.forward)).toBeGreaterThan(Math.cos(Math.PI / 180));
  });

  it('Given a hold with |v| already 5 % over v_set (sideways), Then the main drive reads exactly 0 until |v| is back under the cut', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0.5;
    const vset = assistTargetSpeed(0.5, C.topSpeed);
    fm.teleport(new Vector3(), new Vector3(vset * 1.05, 0, 0), new Quaternion());
    let checked = 0;
    run(fm, 3, (f) => {
      if (f.speed > OVERSPEED_CUT * vset) {
        expect(f.throttle).toBe(0);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(10);
  });
});

describe('[v3-T2] FA-ON Space stop: constant decel, then a short rounded tail', () => {
  it('Given a hold at 1.7 km/s, When Space is held, Then |v| < 1 m/s within v/a_retro + 0.6 s (v2: ~+2.3 s tail)', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0.5;
    const vset = assistTargetSpeed(0.5, C.topSpeed);
    run(fm, vset / MAIN + 10);
    const v0 = fm.speed;
    fm.command.brake = true;
    let t = 0;
    while (fm.speed >= 0.001 && t < 30) {
      fm.update(H);
      t += H;
    }
    expect(t).toBeLessThanOrEqual(v0 / RETRO + 0.6);
  });

  it('Given the stop, Then the velocity never reverses along its original direction (no overshoot past zero)', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0.5;
    const vset = assistTargetSpeed(0.5, C.topSpeed);
    run(fm, vset / MAIN + 10);
    const dir = fm.velocity.clone().normalize();
    fm.command.brake = true;
    let min = Number.POSITIVE_INFINITY;
    run(fm, 15, (f) => {
      min = Math.min(min, f.velocity.dot(dir));
    });
    expect(min).toBeGreaterThan(-1e-4); // 0.1 m/s
    expect(fm.speed).toBeLessThan(1e-4);
  });

  it('Given a stop near an Earth-mass parent, Then it still ends in a hover (gravity cancelled), under 1 m/s within v/a + 1 s', () => {
    const fm = new FlightModel(C);
    fm.flightAssist = true;
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 398600, radius: 6371 });
    fm.teleport(new Vector3(0, 7000, 0), new Vector3(0, 0, -1), new Quaternion());
    fm.command.brake = true;
    let t = 0;
    while (fm.speed >= 0.001 && t < 30) {
      fm.update(H);
      t += H;
    }
    expect(t).toBeLessThanOrEqual(1 / RETRO + 1);
    run(fm, 10);
    expect(fm.speed).toBeLessThan(0.001);
  });
});

describe('[v3-T2] coast detent unchanged by the actuator', () => {
  it('Given FA-ON mid-stop (actuator loaded), When Space is released at lever 0, Then velocity is exactly constant from the next substep (no actuator tail)', () => {
    const fm = deepSpace(true);
    fm.teleport(new Vector3(), new Vector3(0, 0, -1.5), new Quaternion());
    fm.command.throttle = 0;
    fm.command.brake = true;
    run(fm, 2);
    fm.command.brake = false;
    run(fm, H);
    const v = fm.velocity.clone();
    run(fm, 3);
    expect(fm.velocity.equals(v)).toBe(true);
    expect(fm.throttle).toBe(0);
  });

  it('Given an FA-ON ship and an FA-OFF ship in the same state at lever 0, Then their trajectories are bit-identical (even after FA-ON has been flying)', () => {
    const on = deepSpace(true);
    on.command.throttle = 0.4;
    run(on, 5);
    on.command.throttle = 0;
    run(on, H);
    const off = deepSpace(false);
    off.teleport(on.position.clone(), on.velocity.clone(), on.orientation.clone());
    for (const fm of [on, off]) fm.command.yaw = 0.3;
    run(on, 4);
    run(off, 4);
    expect(on.velocity.equals(off.velocity)).toBe(true);
    expect(on.orientation.equals(off.orientation)).toBe(true);
  });

  it('Given FA-ON coasting, When the lever comes off the detent, Then the actuator starts from 0 (no stored thrust from the last hold)', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0.6;
    run(fm, 2);
    fm.command.throttle = 0;
    run(fm, 1);
    fm.command.throttle = 0.6;
    const v0 = fm.velocity.clone();
    fm.update(H);
    const a = fm.velocity.clone().sub(v0).length() / H;
    expect(a).toBeLessThanOrEqual((Math.max(MAIN, RETRO) * H) / ASSIST_ACTUATOR_TAU + 1e-12);
  });
});
