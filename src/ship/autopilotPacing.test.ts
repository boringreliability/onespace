/**
 * v3 track T3, phase D — the autopilot's pace and smoothness (PLAN §2 D, D0).
 *
 * D0 (owner): auto-land keeps honest physics, including the fast dive; the
 * sim runs at 10× while the computer flies hands-off above 20 km AGL outside
 * thick air and at 1× below; phase changes are smoother; pilot input still
 * aborts. So every test below runs the REAL FlightModel against the same
 * plateau-and-relief worlds as `autopilot.test.ts`, and flies the leg the way
 * Universe's slice loop will: the frame's sim time is cut by `simSlices`, and
 * the autopilot is stepped once PER SLICE (not once per frame), with the air
 * density refreshed per slice too.
 *
 * Wall-clock time is the number of 60 Hz frames the leg takes, i.e. what the
 * player sits through. The A1 audit measured 157-501 s of it (all at 1×).
 *
 * Jerk is measured as the audit sweep measured it (`apsim.ts`): the frame-to-
 * frame change in proper acceleration, divided by the frame, in g/s. The audit
 * found ~1 040 g/s (the instant ×3 boost step) — the target is ≤ 150 g/s.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import { autopilotTimeRate, simSlices } from '@/game/timeCompression';
import { openingAttitude } from '@/game/recovery';
import type { PlanetSpec } from '@/gen/types';
import { DEFAULT_SHIP_CONFIG, FlightModel, type ParentBody } from './FlightModel';
import { groundVelocity, spinAngularVelocity } from './surfaceSpin';
import {
  ATTITUDE_SLEW_MAX_RAD_S,
  Autopilot,
  FINAL_ALTITUDE_KM,
  FINAL_MAX_DESCENT_KMS,
  HOVER_LOCK_ALT_KM,
  TOUCHDOWN_KMS,
  SPIN_MATCH_FULL_KM,
  SPIN_MATCH_TOP_KM,
  descentSpeedKmS,
  roundedSqrt,
  spinMatchWeight,
  type AutopilotWorld,
} from './autopilot';

// ---------------------------------------------------------------------------
// Worlds (the same three as autopilot.test.ts)
// ---------------------------------------------------------------------------

interface TestWorld extends AutopilotWorld {
  readonly name: string;
  readonly pressure: number;
  readonly scaleHeightKm: number;
  readonly plateauKm: number;
  readonly reliefKm: number;
  /** Wall-clock target for the auto-land leg, s (PLAN §2 D). */
  readonly wallTargetS: number;
  /** v3 polish (D22a): sidereal rotation period, s (0 = the world does not turn), and tilt. */
  readonly rotationPeriodS?: number;
  readonly axialTilt?: number;
}

const REMIT: TestWorld = {
  name: 'Remit 31',
  radiusKm: 7_240,
  mu: 9.8e-3 * 7_240 ** 2,
  atmosphereTopKm: 187,
  pressure: 1,
  scaleHeightKm: 14.6,
  plateauKm: 3.5,
  reliefKm: 1.5,
  // Coordinator (stage-1 approval): ≤ 70 s; the plan's "~60 s" is reported honestly.
  wallTargetS: 70,
};

const THICK: TestWorld = {
  name: 'thick atmosphere',
  radiusKm: 6_000,
  mu: 9.8e-3 * 6_000 ** 2,
  atmosphereTopKm: 1_000,
  pressure: 4,
  scaleHeightKm: 72,
  plateauKm: 2,
  reliefKm: 1,
  // Coordinator (stage-1 approval, option a): 1× below 20 km in ~3 bar under the
  // 20 g drag cap is ~70 s on its own, so 90 s is out of reach; 120 s accepted.
  wallTargetS: 120,
};

const MOON: TestWorld = {
  name: 'small moon',
  radiusKm: 1_000,
  mu: 1_500,
  atmosphereTopKm: 0,
  pressure: 0,
  scaleHeightKm: 1,
  plateauKm: 4,
  reliefKm: 2,
  wallTargetS: 60,
};

const WORLDS = [REMIT, THICK, MOON] as const;

/** Period that gives an equatorial ground speed of `kmS`. */
const periodFor = (radiusKm: number, kmS: number): number => (2 * Math.PI * radiusKm) / kmS;

/**
 * v3 polish (D22a): the same worlds, turning. Ground speeds well above the
 * review's 22 m/s (Remit 31) so a skid cannot hide under the 2 m/s bar, and
 * the tilts put the opening orbit's landing site off the equator.
 */
const SPINNING: readonly TestWorld[] = [
  { ...REMIT, name: 'Remit 31 turning', rotationPeriodS: periodFor(REMIT.radiusKm, 0.1), axialTilt: 0.4 },
  { ...THICK, name: 'thick atmosphere turning', rotationPeriodS: periodFor(THICK.radiusKm, 0.1), axialTilt: 0.2 },
  { ...MOON, name: 'small moon turning', rotationPeriodS: -periodFor(MOON.radiusKm, 0.03), axialTilt: 0.05 },
];

function terrainRadius(w: TestWorld, dir: Vector3): number {
  const relief =
    w.reliefKm * 0.5 * (1 + Math.sin(dir.x * 7.1 + dir.y * 3.3) * Math.cos(dir.z * 5.7 - dir.y * 2.1));
  return w.radiusKm + w.plateauKm + relief;
}

const FRAME = 1 / 60;
const G0 = 9.80665e-3;
const DEG = Math.PI / 180;
/** Legs that have not landed by now have failed; long enough for a 1× thick leg. */
const SIM_LIMIT_S = 900;

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

interface Leg {
  result: string;
  /** Frames × 1/60 s: what the player waits. */
  wallSeconds: number;
  simSeconds: number;
  touchdowns: Array<{ vertical: number; speed: number; dir: Vector3; slip: number }>;
  /** Surface-relative horizontal speed at first contact, measured here from the pre-contact state, km/s. */
  slipKmS: number;
  crashes: number;
  /** Max |Δ proper accel| / frame, g/s, airborne frames only. */
  maxJerkGs: number;
  /** Max body rate, rad/s, airborne. */
  maxRateRadS: number;
  /** THRUST↔HOVER changes while below HOVER_LOCK_ALT_KM of terrain altitude. */
  modeChangesBelowLock: number;
  /** Sim seconds flown at 10×. */
  fastSeconds: number;
}

/**
 * One auto-land leg from the opening orbit. `auto` = the time rate follows
 * `autopilotTimeRate` (the D0 rule); otherwise 1× throughout. Either way the
 * autopilot is stepped per slice, as Universe will do it.
 */
function flyLeg(w: TestWorld, auto: boolean): Leg {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  const frame: ParentBody = { position: new Vector3(), velocity: new Vector3(), mu: w.mu, radius: w.radiusKm };
  fm.setParent(frame);
  // v3 polish: a turning world, turned as Universe turns it — the terrain is
  // fixed in the body frame, and a grounded ship is carried with it.
  const period = w.rotationPeriodS ?? 0;
  const tilt = w.axialTilt ?? 0;
  const spinAxis = new Vector3(Math.sin(tilt), Math.cos(tilt), 0).normalize();
  const omega = spinAngularVelocity(period, tilt, new Vector3());
  const spinQ = new Quaternion();
  const spinInv = new Quaternion();
  const spinPrev = new Quaternion();
  const spinDelta = new Quaternion();
  let orbitTime = 0;
  if (period !== 0) fm.setLandingContext({ id: 'test', name: w.name, rotationPeriod: period, axialTilt: tilt } as unknown as PlanetSpec);
  const d = new Vector3();
  fm.setGroundSampler((p) => {
    const r = p.length();
    d.copy(p).divideScalar(r).applyQuaternion(spinInv);
    return r - terrainRadius(w, d);
  });
  const pos = new Vector3(-0.8, 0.35, -0.5).normalize().multiplyScalar(w.radiusKm * 1.6);
  const vel = fm.orbitalVelocityAt(pos);
  fm.teleport(pos, vel, openingAttitude(vel, pos, new Quaternion()));

  const leg: Leg = {
    result: 'flying',
    wallSeconds: 0,
    simSeconds: 0,
    touchdowns: [],
    slipKmS: Number.NaN,
    crashes: 0,
    maxJerkGs: 0,
    maxRateRadS: 0,
    modeChangesBelowLock: 0,
    fastSeconds: 0,
  };
  offs.push(
    bus.on('ship:touchdown', ({ vertical, speed, slip }) => {
      leg.touchdowns.push({ vertical, speed, slip, dir: fm.position.clone().applyQuaternion(spinInv).normalize() });
      // Independent of FlightModel's own figure: the state before this slice.
      if (leg.touchdowns.length === 1) {
        groundVelocity(omega, preP, gV);
        up.copy(preP).normalize();
        rel.subVectors(preV, gV);
        rel.addScaledVector(up, -rel.dot(up));
        leg.slipKmS = rel.length();
      }
    }),
    bus.on('ship:crashed', () => {
      leg.crashes++;
    }),
  );

  const air = (): void => {
    if (w.pressure <= 0) {
      fm.setAtmosphere(0);
      return;
    }
    const alt = fm.position.length() - w.radiusKm;
    fm.setAtmosphere(Math.exp(-Math.max(0, alt) / w.scaleHeightKm) * w.pressure);
  };

  const preP = new Vector3();
  const preV = new Vector3();
  const gV = new Vector3();
  const up = new Vector3();
  const rel = new Vector3();
  const apWorld: AutopilotWorld = { radiusKm: w.radiusKm, mu: w.mu, atmosphereTopKm: w.atmosphereTopKm, spinRadS: omega };
  const ap = new Autopilot();
  ap.engage('land', fm, apWorld);
  const slices = { count: 0, slice: 0 };
  const prevV = new Vector3();
  const acc = new Vector3();
  const prevAcc = new Vector3();
  let havePrevAcc = false;
  let lastMode = ap.attitudeMode;

  air();
  while (leg.simSeconds < SIM_LIMIT_S && leg.result === 'flying') {
    const rate = auto
      ? autopilotTimeRate({ altKm: fm.altitude, rho: fm.atmosphericDensity, phase: ap.phase, hands: false })
      : 1;
    simSlices(FRAME, rate, slices);
    prevV.copy(fm.velocity);
    const wasGrounded = fm.grounded;
    const tdBefore = leg.touchdowns.length;
    let frameSim = 0;
    for (let i = 0; i < slices.count; i++) {
      // Universe's slice order: the worlds turn (carrying a grounded ship), then guidance, then the integration.
      orbitTime += slices.slice;
      spinPrev.copy(spinQ);
      spinQ.setFromAxisAngle(spinAxis, period !== 0 ? (orbitTime / period) * Math.PI * 2 : 0);
      spinInv.copy(spinQ).invert();
      if (fm.grounded) fm.carryWithSurface(spinDelta.copy(spinPrev).invert().premultiply(spinQ));
      air();
      leg.result = ap.step(fm, apWorld, slices.slice);
      if (leg.result !== 'flying') break;
      preP.copy(fm.position);
      preV.copy(fm.velocity);
      fm.update(slices.slice);
      frameSim += slices.slice;
      const mode = ap.attitudeMode;
      if (mode !== lastMode && fm.altitude < HOVER_LOCK_ALT_KM) leg.modeChangesBelowLock++;
      lastMode = mode;
    }
    leg.simSeconds += frameSim;
    leg.wallSeconds += FRAME;
    if (rate > 1) leg.fastSeconds += frameSim;

    const airborne = !wasGrounded && !fm.grounded && leg.touchdowns.length === tdBefore;
    // Jerk is judged at 1× only: at 10× a frame spans several slices, and a
    // 0.17 s difference quotient is not the quantity the target is about.
    if (airborne && frameSim > 0 && rate === 1) {
      acc.subVectors(fm.velocity, prevV).divideScalar(frameSim).sub(fm.gravityAccel);
      if (havePrevAcc) leg.maxJerkGs = Math.max(leg.maxJerkGs, acc.distanceTo(prevAcc) / frameSim / G0);
      prevAcc.copy(acc);
      havePrevAcc = true;
    } else {
      havePrevAcc = false;
    }
    if (airborne) leg.maxRateRadS = Math.max(leg.maxRateRadS, fm.angularVelocity.length());
  }
  console.info(
    `[autopilot v3] ${w.name} ${auto ? 'auto-rate' : '1×'}: ${leg.result} · wall ${leg.wallSeconds.toFixed(1)} s · sim ${leg.simSeconds.toFixed(0)} s` +
      ` (10× for ${leg.fastSeconds.toFixed(0)} s) · touchdown ${leg.touchdowns[0] ? (leg.touchdowns[0].vertical * 1000).toFixed(2) + ' m/s' : '-'}` +
      ` · slip ${(leg.slipKmS * 1000).toFixed(2)} m/s` +
      ` · jerk ${leg.maxJerkGs.toFixed(0)} g/s · rate ${(leg.maxRateRadS / DEG).toFixed(1)}°/s · modes<20km ${leg.modeChangesBelowLock}`,
  );
  return leg;
}

/** Legs are expensive; each (world, rate rule) is flown once and shared. */
const cache = new Map<string, Leg>();
function leg(w: TestWorld, auto: boolean): Leg {
  const key = `${w.name}|${auto}`;
  let l = cache.get(key);
  if (!l) {
    l = flyLeg(w, auto);
    cache.set(key, l);
  }
  return l;
}

// ---------------------------------------------------------------------------
// roundedSqrt
// ---------------------------------------------------------------------------

describe('roundedSqrt — the √ field with a rounded tip (PLAN §2 D)', () => {
  const a = 0.2;
  const tau = 1.2;

  it('Given e = 0, Then it is exactly 0', () => {
    expect(roundedSqrt(0, a, tau)).toBe(0);
  });

  it('Given any e, Then it is odd: f(−e) = −f(e)', () => {
    for (const e of [1e-6, 0.01, 0.5, 3, 400]) {
      expect(roundedSqrt(-e, a, tau)).toBeCloseTo(-roundedSqrt(e, a, tau), 12);
    }
  });

  it('Given e near 0, Then its slope is 1/τ (linear, so the loop gain stays finite instead of the √ singularity)', () => {
    const h = 1e-7;
    const slope = (roundedSqrt(h, a, tau) - roundedSqrt(-h, a, tau)) / (2 * h);
    expect(slope).toBeCloseTo(1 / tau, 4);
  });

  it('Given the closed form, Then f(e) = sign(e)·(√(2a|e| + (aτ)²) − aτ)', () => {
    for (const e of [-50, -0.3, 0.002, 0.7, 12]) {
      const at = a * tau;
      expect(roundedSqrt(e, a, tau)).toBeCloseTo(Math.sign(e) * (Math.sqrt(2 * a * Math.abs(e) + at * at) - at), 12);
    }
  });

  it('Given rising e, Then it is strictly increasing, and always inside the plain √ envelope (never asks for more than braking at a allows)', () => {
    let prev = -Infinity;
    for (let e = -100; e <= 100; e += 0.37) {
      const v = roundedSqrt(e, a, tau);
      expect(v).toBeGreaterThan(prev);
      expect(Math.abs(v)).toBeLessThanOrEqual(Math.sqrt(2 * a * Math.abs(e)) + 1e-12);
      prev = v;
    }
  });

  it('Given a large e, Then it approaches the plain √ less the constant aτ', () => {
    const e = 1e6;
    expect(roundedSqrt(e, a, tau)).toBeCloseTo(Math.sqrt(2 * a * e) - a * tau, 3); // the (aτ)² under the root is 4.6e-5 here
  });

  it('Given NaN or a non-positive a or τ, Then it returns 0, never NaN', () => {
    expect(roundedSqrt(Number.NaN, a, tau)).toBe(0);
    expect(roundedSqrt(1, Number.NaN, tau)).toBe(0);
    expect(roundedSqrt(1, 0, tau)).toBe(0);
    expect(Number.isNaN(roundedSqrt(1, a, 0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The landing field
// ---------------------------------------------------------------------------

describe('the landing field, v3', () => {
  it('Given phase D, Then the final segment starts at 0.6 km of terrain altitude (was 2 km; measured −42-47 s)', () => {
    expect(FINAL_ALTITUDE_KM).toBe(0.6);
  });

  it('Given the final segment, Then the field near the ground is TOUCHDOWN + roundedSqrt (slope 1/τ at 0, no √ singularity)', () => {
    const brake = 0.2;
    const v0 = descentSpeedKmS(0, brake);
    expect(v0).toBeCloseTo(TOUCHDOWN_KMS, 12);
    const h = 1e-6;
    const slope = (descentSpeedKmS(h, brake) - v0) / h;
    expect(Number.isFinite(slope)).toBe(true);
    expect(slope).toBeLessThan(2); // √ would give ~77 /s here
  });

  it('Given the field either side of FINAL_ALTITUDE_KM, Then it is continuous there (no step in the demand)', () => {
    const brake = 0.2;
    const below = descentSpeedKmS(FINAL_ALTITUDE_KM - 1e-9, brake);
    const above = descentSpeedKmS(FINAL_ALTITUDE_KM + 1e-9, brake);
    expect(Math.abs(above - below)).toBeLessThan(1e-6);
    expect(below).toBeLessThanOrEqual(FINAL_MAX_DESCENT_KMS + 1e-12);
  });
});

// ---------------------------------------------------------------------------
// The leg, per world
// ---------------------------------------------------------------------------

describe('auto-land, per sim slice with the D0 time rule', () => {
  for (const w of WORLDS) {
    it(`Given the opening orbit over ${w.name}, When L flies hands-off with auto-10× above 20 km, Then it touches down CLEAN (< 2 m/s), no crash, inside ${w.wallTargetS} s of wall-clock`, () => {
      const l = leg(w, true);
      expect(l.crashes).toBe(0);
      expect(l.result).toBe('landed');
      expect(l.touchdowns[0]!.vertical).toBeLessThan(0.002);
      expect(l.fastSeconds).toBeGreaterThan(0); // the rule actually engaged 10×
      expect(l.wallSeconds).toBeLessThanOrEqual(w.wallTargetS);
    });

    it(`Given the same leg over ${w.name} flown at 1× and at auto-10× (autopilot stepped per slice), Then both land CLEAN and the impact points are within 1 km — 10× is the same flight, not a different one`, () => {
      const slow = leg(w, false);
      const fast = leg(w, true);
      expect(slow.result).toBe('landed');
      expect(fast.result).toBe('landed');
      expect(slow.touchdowns[0]!.vertical).toBeLessThan(0.002);
      expect(fast.touchdowns[0]!.vertical).toBeLessThan(0.002);
      const angle = slow.touchdowns[0]!.dir.angleTo(fast.touchdowns[0]!.dir);
      expect(angle * w.radiusKm).toBeLessThan(1);
    });

    it(`Given the leg over ${w.name}, Then below ${HOVER_LOCK_ALT_KM} km of terrain altitude the attitude mode changes at most once (HOVER, once entered, is locked — A2 measured 4-6 flips near the ground)`, () => {
      expect(leg(w, false).modeChangesBelowLock).toBeLessThanOrEqual(1);
      expect(leg(w, true).modeChangesBelowLock).toBeLessThanOrEqual(1);
    });

    it(`Given the leg over ${w.name} at 1×, Then the jerk never exceeds 150 g/s (A2 measured ~1 040 g/s at the boost step)`, () => {
      expect(leg(w, false).maxJerkGs).toBeLessThanOrEqual(150);
    });

    // Stage 2: on v2's torque plant the weathercock torque in air overran the
    // slewed setpoint (29.5°/s on the thick world at 317 km); on T2's
    // rate-command plant it no longer does, so +5 % holds everywhere.
    const slack = 1.05;
    it(`Given the leg over ${w.name}, Then the hull never turns faster than the 25°/s attitude slew limit (+${Math.round((slack - 1) * 100)} % for the attitude loop's lag) — flips are swings, not snaps`, () => {
      expect(ATTITUDE_SLEW_MAX_RAD_S).toBeCloseTo(25 * DEG, 9);
      expect(leg(w, false).maxRateRadS).toBeLessThanOrEqual(ATTITUDE_SLEW_MAX_RAD_S * slack);
      expect(leg(w, true).maxRateRadS).toBeLessThanOrEqual(ATTITUDE_SLEW_MAX_RAD_S * slack);
    });
  }
});

// ---------------------------------------------------------------------------
// v3 polish (D22a): the ground moves
// ---------------------------------------------------------------------------

describe('spinMatchWeight — how much of the ground’s velocity the landing field asks for', () => {
  it('Given terrain altitude at or above SPIN_MATCH_TOP_KM (the 10× deorbit and brake legs), Then 0 — those legs are unchanged', () => {
    expect(SPIN_MATCH_TOP_KM).toBe(HOVER_LOCK_ALT_KM);
    for (const h of [SPIN_MATCH_TOP_KM, 25, 400, 1e6]) expect(spinMatchWeight(h)).toBe(0);
  });

  it('Given terrain altitude at or below SPIN_MATCH_FULL_KM, Then 1 — the whole final segment flies with the ground', () => {
    expect(SPIN_MATCH_FULL_KM).toBeGreaterThan(FINAL_ALTITUDE_KM);
    for (const h of [SPIN_MATCH_FULL_KM, 1, FINAL_ALTITUDE_KM, 0, -0.2]) expect(spinMatchWeight(h)).toBe(1);
  });

  it('Given falling altitude, Then the weight rises monotonically and continuously (no step in the demand)', () => {
    let prev = -1;
    for (let h = SPIN_MATCH_TOP_KM + 1; h >= 0; h -= 0.01) {
      const wgt = spinMatchWeight(h);
      expect(wgt).toBeGreaterThanOrEqual(prev);
      if (prev >= 0) expect(wgt - prev).toBeLessThan(0.01);
      prev = wgt;
    }
  });

  it('Given NaN altitude, Then a number in [0, 1], never NaN', () => {
    const wgt = spinMatchWeight(Number.NaN);
    expect(Number.isFinite(wgt)).toBe(true);
    expect(wgt).toBeGreaterThanOrEqual(0);
    expect(wgt).toBeLessThanOrEqual(1);
  });
});

describe('the landing field above the blend is the same on a turning world', () => {
  it('Given the same hull state 30 km up, When the autopilot steps against a still and a turning world, Then the command is identical', () => {
    const mk = (): FlightModel => {
      const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
      fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: REMIT.mu, radius: REMIT.radiusKm });
      const pos = new Vector3(0.3, 0.8, -0.5).normalize().multiplyScalar(REMIT.radiusKm + 30);
      fm.teleport(pos, new Vector3(0.2, -0.4, 0.1), new Quaternion());
      return fm;
    };
    const still = mk();
    const turning = mk();
    const a = new Autopilot();
    const b = new Autopilot();
    const base: AutopilotWorld = { radiusKm: REMIT.radiusKm, mu: REMIT.mu, atmosphereTopKm: 0 };
    const spun: AutopilotWorld = { ...base, spinRadS: spinAngularVelocity(periodFor(REMIT.radiusKm, 0.1), 0.4, new Vector3()) };
    a.engage('land', still, base);
    b.engage('land', turning, spun);
    for (let i = 0; i < 30; i++) {
      a.step(still, base, FRAME);
      b.step(turning, spun, FRAME);
      expect(turning.command).toEqual(still.command);
      still.update(FRAME);
      turning.update(FRAME);
    }
  });
});

describe('auto-land on a turning world (D22a: the review measured a ~22 m/s sideways skid on Remit 31)', () => {
  for (const w of SPINNING) {
    const groundMs = Math.abs((2 * Math.PI * w.radiusKm) / w.rotationPeriodS!) * 1000;
    it(`Given the opening orbit over ${w.name} (ground ${groundMs.toFixed(0)} m/s at the equator), When L flies hands-off with auto-10×, Then it touches down CLEAN with < 2 m/s relative to the ground, no crash, inside ${w.wallTargetS} s`, () => {
      const l = leg(w, true);
      expect(l.crashes).toBe(0);
      expect(l.result).toBe('landed');
      expect(l.touchdowns[0]!.vertical).toBeLessThan(0.002);
      expect(l.slipKmS).toBeLessThan(0.002);
      // FlightModel's own figure agrees (it is what Pilot grades on).
      expect(l.touchdowns[0]!.slip).toBeLessThan(0.002);
      expect(l.wallSeconds).toBeLessThanOrEqual(w.wallTargetS);
    });

    it(`Given the leg over ${w.name}, Then it is still smooth: ≤ 1 mode change below ${HOVER_LOCK_ALT_KM} km, jerk ≤ 150 g/s at 1×, hull rate inside the slew limit`, () => {
      const fast = leg(w, true);
      const slow = leg(w, false);
      expect(slow.result).toBe('landed');
      expect(slow.slipKmS).toBeLessThan(0.002);
      expect(fast.modeChangesBelowLock).toBeLessThanOrEqual(1);
      expect(slow.modeChangesBelowLock).toBeLessThanOrEqual(1);
      expect(slow.maxJerkGs).toBeLessThanOrEqual(150);
      expect(fast.maxRateRadS).toBeLessThanOrEqual(ATTITUDE_SLEW_MAX_RAD_S * 1.05);
    });
  }
});
