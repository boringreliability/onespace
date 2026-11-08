/**
 * The node auto-land simulation, shared by tests (v4 fuel, Task 3).
 *
 * Moved verbatim from `autopilotPacing.test.ts`: the REAL FlightModel flies
 * one auto-land leg from the opening orbit, the way Universe's slice loop
 * does it (frame sim time cut by `simSlices`, the autopilot stepped once per
 * slice, the air refreshed per slice). See that file's header for the D0
 * rules the leg follows.
 *
 * The bus listeners a leg registers live until `releaseLegListeners()` —
 * call it from the test file's `afterEach`, as the pacing test always did.
 */

import { Quaternion, Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import { autopilotTimeRate, simSlices } from '@/game/timeCompression';
import { openingAttitude } from '@/game/recovery';
import type { PlanetSpec } from '@/gen/types';
import { DEFAULT_SHIP_CONFIG, FlightModel, type ParentBody } from '../FlightModel';
import { groundVelocity, spinAngularVelocity } from '../surfaceSpin';
import { Autopilot, HOVER_LOCK_ALT_KM, type AutopilotWorld } from '../autopilot';

// ---------------------------------------------------------------------------
// Worlds (the same three as autopilot.test.ts)
// ---------------------------------------------------------------------------

export interface TestWorld extends AutopilotWorld {
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

export const REMIT: TestWorld = {
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

export const THICK: TestWorld = {
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

export const MOON: TestWorld = {
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

export const WORLDS = [REMIT, THICK, MOON] as const;

/** Period that gives an equatorial ground speed of `kmS`. */
export const periodFor = (radiusKm: number, kmS: number): number => (2 * Math.PI * radiusKm) / kmS;

/**
 * v3 polish (D22a): the same worlds, turning. Ground speeds well above the
 * review's 22 m/s (Remit 31) so a skid cannot hide under the 2 m/s bar, and
 * the tilts put the opening orbit's landing site off the equator.
 */
export const SPINNING: readonly TestWorld[] = [
  { ...REMIT, name: 'Remit 31 turning', rotationPeriodS: periodFor(REMIT.radiusKm, 0.1), axialTilt: 0.4 },
  { ...THICK, name: 'thick atmosphere turning', rotationPeriodS: periodFor(THICK.radiusKm, 0.1), axialTilt: 0.2 },
  { ...MOON, name: 'small moon turning', rotationPeriodS: -periodFor(MOON.radiusKm, 0.03), axialTilt: 0.05 },
];

export function terrainRadius(w: TestWorld, dir: Vector3): number {
  const relief =
    w.reliefKm * 0.5 * (1 + Math.sin(dir.x * 7.1 + dir.y * 3.3) * Math.cos(dir.z * 5.7 - dir.y * 2.1));
  return w.radiusKm + w.plateauKm + relief;
}

export const FRAME = 1 / 60;
export const G0 = 9.80665e-3;
export const DEG = Math.PI / 180;
/** Legs that have not landed by now have failed; long enough for a 1× thick leg. */
export const SIM_LIMIT_S = 900;

const offs: Array<() => void> = [];
/** Drops every bus listener the legs flown so far registered (the pacing test's afterEach). */
export function releaseLegListeners(): void {
  for (const off of offs.splice(0)) off();
}

export interface Leg {
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
 * autopilot is stepped per slice, as Universe will do it. `prepare` (optional)
 * sees the fresh hull before anything else touches it, e.g. to attach a tank.
 */
export function flyLeg(w: TestWorld, auto: boolean, prepare?: (fm: FlightModel) => void): Leg {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  prepare?.(fm);
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
export function leg(w: TestWorld, auto: boolean): Leg {
  const key = `${w.name}|${auto}`;
  let l = cache.get(key);
  if (!l) {
    l = flyLeg(w, auto);
    cache.set(key, l);
  }
  return l;
}
