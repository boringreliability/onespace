/**
 * [v3-T2] Rate-command rotation (PLAN §1 S2, phase B; D0).
 *
 * v2 under attitudeHold was torque plus a pure exponential decay (τ 0.35 s):
 * the steady rate was α·τ and letting go glided 8.8° (mouse), 14.2° (keys)
 * and 21.7° (roll), under 1°/s only after 1.2-1.5 s. Under rate command the
 * stick is a RATE demand and the computer flies ω to it:
 *
 *     ω̇ = clamp((ωcmd − ω ± floor)/τ, ±α)
 *
 * τ_up 0.22 s / α_max (2.5, 2.5, 4 rad/s²) while |ω| grows; τ_down 0.10 s /
 * α_brake while it shrinks. The small `floor` makes the last degree a finite
 * time instead of an exponential tail. The step never passes ωcmd.
 *
 * α_brake > α_max is a deliberate departure from a literal symmetric clamp;
 * see the design note in the stage-1 report: at α 2.5 the kinematic minimum
 * glide from 35°/s is ω²/2α = 4.28°, so D0's own ≤ 4° target cannot be met by
 * a symmetric clamp at all.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { DEFAULT_SHIP_CONFIG, FlightModel } from './FlightModel';
import {
  ALPHA_MAX,
  MAX_RATE,
  RATE_TAU_DOWN,
  RATE_TAU_UP,
  rateCommand,
  rateTuning,
  type RateAxis,
} from './rateCommand';

const DEG = Math.PI / 180;
const H = 1 / 120;
const AXES: readonly RateAxis[] = ['pitch', 'yaw', 'roll'];

/** Glide/settle bounds per axis. Pitch/yaw are D0's; roll is the honest one (see report). */
const GLIDE_MAX_DEG: Record<RateAxis, number> = { pitch: 4, yaw: 4, roll: 7.5 };
const SETTLE_MAX_S: Record<RateAxis, number> = { pitch: 0.35, yaw: 0.35, roll: 0.4 };

function spinUp(axis: RateAxis, seconds: number, cmd = MAX_RATE[axis]): { w: number; trace: number[] } {
  const t = rateTuning(axis);
  let w = 0;
  const trace: number[] = [];
  for (let i = 0; i < Math.round(seconds / H); i++) {
    w = rateCommand(w, cmd, H, t);
    trace.push(w);
  }
  return { w, trace };
}

function release(axis: RateAxis, w0: number, seconds = 3): { glideDeg: number; settleS: number; trace: number[] } {
  const t = rateTuning(axis);
  let w = w0;
  let ang = 0;
  let settle = Number.POSITIVE_INFINITY;
  const trace: number[] = [];
  for (let i = 0; i < Math.round(seconds / H); i++) {
    w = rateCommand(w, 0, H, t);
    ang += Math.abs(w) * H;
    trace.push(w);
    if (settle === Number.POSITIVE_INFINITY && Math.abs(w) < 1 * DEG) settle = (i + 1) * H;
  }
  return { glideDeg: ang / DEG, settleS: settle, trace };
}

// ---------------------------------------------------------------------------

describe('[v3-T2] D0 tuning', () => {
  it('Given D0, Then τ_up is 0.22 s, τ_down 0.10 s and the maxima are 35/28/75 °/s', () => {
    expect(RATE_TAU_UP).toBe(0.22);
    expect(RATE_TAU_DOWN).toBe(0.1);
    expect(MAX_RATE.pitch).toBeCloseTo(35 * DEG, 12);
    expect(MAX_RATE.yaw).toBeCloseTo(28 * DEG, 12);
    expect(MAX_RATE.roll).toBeCloseTo(75 * DEG, 12);
  });

  it('Given D0, Then α_max is 2.5 / 2.5 / 4 rad/s² and the default hull’s RCS has exactly that α (FA-OFF uses the same α)', () => {
    expect(ALPHA_MAX).toEqual({ pitch: 2.5, yaw: 2.5, roll: 4 });
    const c = DEFAULT_SHIP_CONFIG;
    expect((c.rcsTorque.pitch / c.inertia.pitch) * 1e-3).toBeCloseTo(2.5, 9);
    expect((c.rcsTorque.yaw / c.inertia.yaw) * 1e-3).toBeCloseTo(2.5, 9);
    expect((c.rcsTorque.roll / c.inertia.roll) * 1e-3).toBeCloseTo(4, 9);
  });

  it('Given the tuning, Then spin-up uses τ_up/α_max and braking τ_down with at least α_max', () => {
    for (const a of AXES) {
      const t = rateTuning(a);
      expect(t.tauUp).toBe(RATE_TAU_UP);
      expect(t.tauDown).toBe(RATE_TAU_DOWN);
      expect(t.alphaUp).toBe(ALPHA_MAX[a]);
      expect(t.alphaDown).toBeGreaterThanOrEqual(ALPHA_MAX[a]);
    }
  });
});

describe('[v3-T2] rateCommand (pure)', () => {
  for (const axis of AXES) {
    it(`Given ${axis} from rest at full demand, Then ω rises monotonically to ωmax and never overshoots it`, () => {
      const { w, trace } = spinUp(axis, 2);
      let prev = 0;
      for (const x of trace) {
        expect(x).toBeGreaterThanOrEqual(prev);
        expect(x).toBeLessThanOrEqual(MAX_RATE[axis]);
        prev = x;
      }
      expect(w).toBe(MAX_RATE[axis]);
    });

    it(`Given ${axis} spinning up, Then no step's angular acceleration exceeds α_max, and 63 % is reached within 0.3 s`, () => {
      const { trace } = spinUp(axis, 1);
      let prev = 0;
      let t63 = Number.POSITIVE_INFINITY;
      trace.forEach((x, i) => {
        expect(Math.abs(x - prev) / H).toBeLessThanOrEqual(ALPHA_MAX[axis] * (1 + 1e-9));
        prev = x;
        if (t63 === Number.POSITIVE_INFINITY && x >= 0.632 * MAX_RATE[axis]) t63 = (i + 1) * H;
      });
      expect(t63).toBeLessThanOrEqual(0.3);
    });

    it(`Given ${axis} at full rate, When released, Then the glide is ≤ ${GLIDE_MAX_DEG[axis]}° and |ω| < 1°/s within ${SETTLE_MAX_S[axis]} s`, () => {
      const r = release(axis, MAX_RATE[axis]);
      expect(r.glideDeg).toBeLessThanOrEqual(GLIDE_MAX_DEG[axis]);
      expect(r.settleS).toBeLessThanOrEqual(SETTLE_MAX_S[axis]);
    });

    it(`Given ${axis} released, Then ω decays monotonically to exactly 0 and never changes sign (no overshoot)`, () => {
      const r = release(axis, MAX_RATE[axis]);
      let prev = MAX_RATE[axis];
      for (const x of r.trace) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(prev);
        prev = x;
      }
      expect(r.trace[r.trace.length - 1]).toBe(0);
    });

    it(`Given ${axis} braking, Then no step exceeds the braking authority α_brake`, () => {
      const t = rateTuning(axis);
      const r = release(axis, MAX_RATE[axis]);
      let prev = MAX_RATE[axis];
      for (const x of r.trace) {
        expect(Math.abs(x - prev) / H).toBeLessThanOrEqual(t.alphaDown * (1 + 1e-9));
        prev = x;
      }
    });
  }

  it('Given half demand, Then ω settles at exactly half the maximum (the plant is linear; any curve lives in the stick)', () => {
    const { w } = spinUp('pitch', 3, 0.5 * MAX_RATE.pitch);
    expect(w).toBe(0.5 * MAX_RATE.pitch);
  });

  it('Given a reversal from +ωmax to −ωmax, Then ω passes through zero once and stops exactly at −ωmax', () => {
    const t = rateTuning('yaw');
    let w = MAX_RATE.yaw;
    let crossings = 0;
    for (let i = 0; i < 360; i++) {
      const n = rateCommand(w, -MAX_RATE.yaw, H, t);
      if (Math.sign(n) !== Math.sign(w) && w !== 0) crossings++;
      expect(n).toBeGreaterThanOrEqual(-MAX_RATE.yaw);
      w = n;
    }
    expect(crossings).toBe(1);
    expect(w).toBe(-MAX_RATE.yaw);
  });

  it('Given a disturbance that pushes ω back over zero every substep (weathercock in thick air), When the demand is positive, Then ω still rises — it is not pinned at 0', () => {
    // Found in stage 2: a brake that stopped exactly at zero on a reversal
    // pinned ω at 0 under the autopilot in thick air (no flip for 3.6 s).
    const t = rateTuning('pitch');
    let w = 0;
    for (let i = 0; i < 120; i++) {
      w -= 1.0 * H; // 1 rad/s² of restoring torque, well inside α
      w = rateCommand(w, MAX_RATE.pitch, H, t);
    }
    expect(w).toBeGreaterThan(0.5 * MAX_RATE.pitch);
  });

  it('Given ω already equal to the demand, Then it is returned unchanged (bit-identical hold)', () => {
    const t = rateTuning('roll');
    expect(rateCommand(0.3, 0.3, H, t)).toBe(0.3);
    expect(rateCommand(0, 0, H, t)).toBe(0);
  });

  it('Given a non-positive h, Then ω is unchanged', () => {
    const t = rateTuning('pitch');
    expect(rateCommand(0.2, 0.6, 0, t)).toBe(0.2);
    expect(rateCommand(0.2, 0.6, -1, t)).toBe(0.2);
  });
});

// ---------------------------------------------------------------------------
// Through the real FlightModel: the plant the game actually flies.
// ---------------------------------------------------------------------------

function deepShip(): FlightModel {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0 });
  fm.teleport(new Vector3(), new Vector3(), new Quaternion());
  return fm;
}

const BODY: Record<RateAxis, 'x' | 'y' | 'z'> = { pitch: 'x', yaw: 'y', roll: 'z' };

/** Hold full `axis` for `holdS`, release, and measure the glide at frame rate `hz`. */
function flyRelease(axis: RateAxis, hz: number, holdS = 2): { rate: number; glideDeg: number; settleS: number } {
  const fm = deepShip();
  const dt = 1 / hz;
  fm.command[axis] = 1;
  for (let i = 0; i < Math.round(holdS * hz); i++) fm.update(dt);
  const rate = Math.abs(fm.angularVelocity[BODY[axis]]);
  fm.command[axis] = 0;
  const q0 = fm.orientation.clone();
  let settle = Number.POSITIVE_INFINITY;
  for (let i = 0; i < Math.round(3 * hz); i++) {
    fm.update(dt);
    if (settle === Number.POSITIVE_INFINITY && fm.angularVelocity.length() < 1 * DEG) settle = (i + 1) * dt;
  }
  return { rate, glideDeg: (q0.angleTo(fm.orientation) * 180) / Math.PI, settleS: settle };
}

describe('[v3-T2] FlightModel under attitudeHold flies the rate command', () => {
  for (const axis of AXES) {
    it(`Given full ${axis} held 2 s, Then the body rate is the D0 maximum (${(MAX_RATE[axis] / DEG).toFixed(0)}°/s) within 0.5 %`, () => {
      const r = flyRelease(axis, 60);
      expect(Math.abs(r.rate - MAX_RATE[axis]) / MAX_RATE[axis]).toBeLessThan(0.005);
    });

    it(`Given full ${axis} released, Then the hull glides ≤ ${GLIDE_MAX_DEG[axis]}° and is under 1°/s within ${SETTLE_MAX_S[axis]} s (+1 frame)`, () => {
      const r = flyRelease(axis, 60);
      expect(r.glideDeg).toBeLessThanOrEqual(GLIDE_MAX_DEG[axis]);
      expect(r.settleS).toBeLessThanOrEqual(SETTLE_MAX_S[axis] + 1 / 60);
    });
  }

  it('Given the same hold and release, When run at 30, 60 and 144 fps, Then rate and glide agree (fixed substep)', () => {
    const r30 = flyRelease('pitch', 30);
    const r60 = flyRelease('pitch', 60);
    const r144 = flyRelease('pitch', 144);
    expect(Math.abs(r30.rate - r60.rate)).toBeLessThan(1e-9);
    expect(Math.abs(r144.rate - r60.rate)).toBeLessThan(1e-9);
    expect(Math.abs(r30.glideDeg - r60.glideDeg)).toBeLessThan(0.05);
    expect(Math.abs(r144.glideDeg - r60.glideDeg)).toBeLessThan(0.05);
  });

  it('Given positive yaw and roll commands, Then the hull turns the way the axis signs say (yawAxisSign / rollAxisSign kept)', () => {
    const fm = deepShip();
    fm.command.yaw = 1;
    fm.command.roll = 1;
    for (let i = 0; i < 120; i++) fm.update(H);
    expect(Math.sign(fm.angularVelocity.y)).toBe(Math.sign(DEFAULT_SHIP_CONFIG.yawAxisSign));
    expect(Math.sign(fm.angularVelocity.z)).toBe(Math.sign(DEFAULT_SHIP_CONFIG.rollAxisSign));
  });

  it('Given full pitch, Then the rate never exceeds the maximum (no overshoot of ωcmd through the integrator)', () => {
    const fm = deepShip();
    fm.command.pitch = 1;
    for (let i = 0; i < 360; i++) {
      fm.update(H);
      expect(Math.abs(fm.angularVelocity.x)).toBeLessThanOrEqual(MAX_RATE.pitch * (1 + 1e-9));
    }
  });
});

describe('[v3-T2] attitudeHold off stays Newtonian with the same α', () => {
  for (const axis of AXES) {
    it(`Given attitudeHold off and full ${axis} for 0.5 s, Then |ω| = α_max·t (torque, not rate) and it keeps spinning after release`, () => {
      const fm = deepShip();
      fm.attitudeHold = false;
      fm.command[axis] = 1;
      for (let i = 0; i < 60; i++) fm.update(H);
      const w = Math.abs(fm.angularVelocity[BODY[axis]]);
      // Single axis from rest: the Euler cross term is zero.
      expect(w).toBeCloseTo(ALPHA_MAX[axis] * 0.5, 9);
      fm.command[axis] = 0;
      for (let i = 0; i < 240; i++) fm.update(H);
      expect(Math.abs(fm.angularVelocity[BODY[axis]])).toBeCloseTo(w, 9);
    });
  }
});
