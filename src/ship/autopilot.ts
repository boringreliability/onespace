/**
 * Auto-land and auto-orbit (v2 phase 4, GAMEPLAY P4) — the pure half.
 *
 * A computer at the controls, not a cut. Everything here ends in
 * `FlightModel.command` — stick, lever, strafe, boost — the same channel the
 * pilot uses, so the autopilot can do nothing a pilot with perfect hands could
 * not (PLAN: helpers may fly the physics, never lie about it). No velocity is
 * ever written; `ship/autopilot.test.ts` checks every frame's Δv against what
 * the hull's actuators can deliver.
 *
 * GUIDANCE: A VELOCITY FIELD
 *
 * Both legs are the same controller with a different field. At every point
 * the field names the velocity the ship should have there; the controller
 * demands
 *
 *     a = (v_field − v)/τ − g_eff,   g_eff = g + (v_h²/r)·r̂
 *
 * and then works out how to produce `a` with the hull it has. `g_eff` is
 * gravity less the centrifugal relief of the current horizontal speed, so a
 * ship already on a circular orbit demands nothing — without that term the
 * orbit leg would hover-thrust against gravity forever.
 *
 * - LAND: the field is straight down at `descentSpeedKmS(terrain altitude)`
 *   with zero horizontal velocity. Above the final segment that is the
 *   classic suicide-burn envelope v = √(v_f² + 2·a_b·(h − h_f)): accelerate
 *   down as hard as the field allows, then brake on the parabola so the
 *   speed meets v_f exactly at h_f. The orbit's horizontal speed is in error
 *   from the first frame, so the deorbit burn is simply the same demand.
 *   The altitude is the FlightModel's own, which is the GROUND SAMPLER's
 *   (terrain, not the sphere) whenever one is installed.
 * - ORBIT: the field climbs radially towards the target radius on the same
 *   envelope and blends in √(μ/r) of horizontal speed as the ship clears the
 *   air. At the target radius the field is exactly a circular orbit, and the
 *   leg ends when the osculating orbit is one.
 * - In air the field's magnitude is capped so drag stays below DRAG_CAP —
 *   physical, and it keeps the hull from cooking itself pushing into air.
 *
 * ACTUATION
 *
 * The ship has one big engine along the nose (spooled, 0.2 km/s², ×3 boost)
 * and instant RCS on three axes (0.1 km/s² each). Two attitudes:
 *
 * - THRUST: the nose follows the demanded acceleration, the main drive gives
 *   its component along the nose once the nose is close (a lander's thrust
 *   vectoring), and RCS covers the rest — including the main drive's spool
 *   lag, measured from the spooled output it actually has.
 * - HOVER: once the demand fits inside RCS authority, the nose goes level
 *   (roof up, nose along the horizon or prograde) and RCS alone flies. That
 *   is how the hull sets down on its belly rather than its tail, and RCS has
 *   no spool, so the last metres are crisp.
 *
 * The flight model is put in FA-OFF for the leg (FA-ON would reinterpret the
 * lever as a set speed) and the pilot's FA is restored on disengage.
 *
 * No allocation in `step()`: module-level scratch only (ARCHITECTURE §5).
 */

import { Matrix4, Quaternion, Vector3 } from 'three';

import type { InputAxes } from '@/core/Input';
import type { FlightModel } from './FlightModel';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Engage range: beyond this many radii there is no "world in range". */
export const LAND_RANGE_RADII = 8;
/** Auto-orbit target, radii from the centre — the opening and recovery standoff. */
export const ORBIT_TARGET_RADII = 1.6;
/** Terrain altitude below which the final descent segment applies, km. */
export const FINAL_ALTITUDE_KM = 2;
/** Descent ceiling inside the final segment, km/s (PLAN P4: "under 30 m/s the last 2 km"). */
export const FINAL_MAX_DESCENT_KMS = 0.03;
/**
 * Speed the field asks for at the ground, km/s. Pilot grades < 2 m/s CLEAN;
 * 0.8 m/s leaves the tracking error and the gear's 5 m hysteresis room.
 */
export const TOUCHDOWN_KMS = 0.0008;
/**
 * Deceleration the final segment brakes at, km/s² (3 m/s²). Gentle enough
 * that RCS alone holds it against ~1 g, quick enough that the 30 m/s ceiling,
 * not the braking, decides the last minute.
 */
const FINAL_DECEL = 0.003;
/**
 * Fraction of the net braking authority the envelope plans with. The rest is
 * margin for the controller's lag, the flip, and the field being evaluated
 * once a frame.
 */
const BRAKE_FRACTION = 0.4;
/** Velocity-error time constant of the field, s. ~2× the main drive's spool. */
const TAU = 1.2;
/**
 * Most drag the field will fly into, km/s² (20 g — a third of the boosted
 * drive, so a climb through air still has ~0.4 km/s² to spare).
 */
const DRAG_CAP = 0.2;
/** Look-ahead for the field's feed-forward, s. */
const FF_DT = 0.25;
/** Above this fraction of RCS authority the nose turns to thrust; below HOVER_IN it levels. */
const THRUST_IN = 0.7;
const HOVER_IN = 0.4;
/** Main drive only fires once the nose is this close to the demand (cos). */
const MAIN_CONE_COS = 0.85;
/** Boost hysteresis as fractions of unboosted main authority. */
const BOOST_ON = 0.9;
const BOOST_OFF = 0.6;
/** Closed-loop natural frequency of the attitude PD, rad/s (as cruiseSteer). */
const OMEGA_N = 2;
/** Stick deflection below which the pilot is hands-off (as cruiseSteer). */
export const PILOT_DEADZONE = 0.02;
/** Orbit is "done" below this eccentricity, within ORBIT_RADIUS_TOL of the target. */
const ORBIT_DONE_E = 0.01;
const ORBIT_RADIUS_TOL = 0.03;

const M_TO_KM = 1e-3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutopilotGoal = 'land' | 'orbit';
export type AutopilotPhase =
  | 'idle'
  | 'deorbit'
  | 'descent'
  | 'final'
  | 'liftoff'
  | 'ascent'
  | 'circularise';
export type AutopilotResult = 'flying' | 'landed' | 'orbit';

/** The world the leg is flown against. Plain numbers; no Universe here. */
export interface AutopilotWorld {
  readonly radiusKm: number;
  /** GM, km³/s². */
  readonly mu: number;
  /** Top of the atmosphere above the datum, km; 0 for vacuum. */
  readonly atmosphereTopKm: number;
}

export interface Apsides {
  /** Distances from the centre, km. Apoapsis is Infinity for an unbound orbit. */
  periapsis: number;
  apoapsis: number;
  eccentricity: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Downward speed the landing field asks for at terrain altitude `altKm`,
 * km/s, planning to brake at `brakeKmS2`. Monotone in altitude, continuous at
 * the final-segment boundary, and ≤ FINAL_MAX_DESCENT_KMS inside it.
 */
export function descentSpeedKmS(altKm: number, brakeKmS2: number): number {
  const h = altKm > 0 ? altKm : 0; // NaN fails `> 0` too
  if (h <= FINAL_ALTITUDE_KM) {
    return Math.min(FINAL_MAX_DESCENT_KMS, TOUCHDOWN_KMS + Math.sqrt(2 * FINAL_DECEL * h));
  }
  const a = brakeKmS2 > 0 ? brakeKmS2 : 0;
  return Math.sqrt(FINAL_MAX_DESCENT_KMS * FINAL_MAX_DESCENT_KMS + 2 * a * (h - FINAL_ALTITUDE_KM));
}

/** Osculating apsides of a parent-relative state, into `out`. Allocation-free. */
export function orbitApsides(p: Vector3, v: Vector3, mu: number, out: Apsides): Apsides {
  const r = p.length();
  if (!(mu > 0) || !(r > 0)) {
    out.periapsis = Number.NaN;
    out.apoapsis = Number.NaN;
    out.eccentricity = Number.NaN;
    return out;
  }
  const energy = v.lengthSq() / 2 - mu / r;
  // |p × v| by components, so no scratch vector is needed.
  const hx = p.y * v.z - p.z * v.y;
  const hy = p.z * v.x - p.x * v.z;
  const hz = p.x * v.y - p.y * v.x;
  const h2 = hx * hx + hy * hy + hz * hz;
  // e from the eccentricity vector (v × h)/μ − r̂ rather than √(1 + 2Eh²/μ²):
  // for a circular orbit the latter is √(1 − 1), and the cancellation alone
  // reads e ≈ 1e-8 and moves the apsides by metres.
  const ex = (v.y * hz - v.z * hy) / mu - p.x / r;
  const ey = (v.z * hx - v.x * hz) / mu - p.y / r;
  const ez = (v.x * hy - v.y * hx) / mu - p.z / r;
  const e = Math.sqrt(ex * ex + ey * ey + ez * ez);
  out.eccentricity = e;
  // Periapsis from the angular momentum: h²/(μ(1+e)) holds for every conic,
  // and stays finite on the parabola where a(1−e) is 0·∞.
  out.periapsis = h2 / (mu * (1 + e));
  out.apoapsis = energy < 0 && e < 1 ? -mu / (2 * energy) * (1 + e) : Number.POSITIVE_INFINITY;
  return out;
}

export type AutopilotRefusal = 'preset' | 'cruise' | 'warp' | 'no-world';

export interface RefusalInputs {
  readonly presetAllows: boolean;
  readonly cruising: boolean;
  readonly warpIdle: boolean;
  readonly hasWorld: boolean;
  /** Ship distance from the world's centre, in its radii. */
  readonly distanceRadii: number;
}

/** Why `L` cannot engage, or null when it can. First reason wins. */
export function autopilotRefusal(s: RefusalInputs): AutopilotRefusal | null {
  if (!s.presetAllows) return 'preset';
  if (s.cruising) return 'cruise';
  if (!s.warpIdle) return 'warp';
  if (!s.hasWorld || !(s.distanceRadii <= LAND_RANGE_RADII)) return 'no-world';
  return null;
}

export interface ControlKeys {
  /** W or S held. */
  readonly throttleKeys: boolean;
  readonly brake: boolean;
  readonly boost: boolean;
  /** X pressed this frame. */
  readonly zeroThrottle: boolean;
}

/**
 * Has the pilot put a hand on the controls since last frame? A rotation axis
 * counts once it is outside the deadzone AND growing — the mouse stick
 * recentres on its own, and a stick left deflected when L was pressed must
 * not cancel the autopilot by relaxing. The lever counts only rising (the
 * autopilot itself sends it to zero, and it eases there). Strafe, brake,
 * boost, W/S and X count outright.
 */
export function pilotIntervened(now: InputAxes, prev: InputAxes, keys: ControlKeys): boolean {
  if (keys.throttleKeys || keys.brake || keys.boost || keys.zeroThrottle) return true;
  if (now.strafeX !== 0 || now.strafeY !== 0 || now.strafeZ !== 0) return true;
  if (now.throttle > prev.throttle + 1e-4) return true;
  return grows(now.pitch, prev.pitch) || grows(now.yaw, prev.yaw) || grows(now.roll, prev.roll);
}

function grows(now: number, prev: number): boolean {
  const a = Math.abs(now);
  return a > PILOT_DEADZONE && a > Math.abs(prev) + 1e-3;
}

// ---------------------------------------------------------------------------
// Scratch (module-level: one autopilot flies at a time, and step() is sync)
// ---------------------------------------------------------------------------

const sUp = new Vector3();
const sHoriz = new Vector3();
const sField = new Vector3();
const sFieldAhead = new Vector3();
const sAhead = new Vector3();
const sFf = new Vector3();
const sUpF = new Vector3();
const sTanF = new Vector3();
const sAcc = new Vector3();
const sAim = new Vector3();
const sRoof = new Vector3();
const sRes = new Vector3();
const sTan = new Vector3();
const sMat = new Matrix4();
const sQDes = new Quaternion();
const sQErr = new Quaternion();
const ZERO = new Vector3();
const WORLD_UP = new Vector3(0, 1, 0);
const WORLD_X = new Vector3(1, 0, 0);
const sApsides: Apsides = { periapsis: 0, apoapsis: 0, eccentricity: 0 };

// ---------------------------------------------------------------------------
// The computer
// ---------------------------------------------------------------------------

export class Autopilot {
  private _goal: AutopilotGoal | null = null;
  private _phase: AutopilotPhase = 'idle';
  /** FA as the pilot had it at engage; restored on disengage. */
  private savedFa = false;
  /** Orbit leg: the plane's normal, fixed at engage so the field cannot wander. */
  private readonly normal = new Vector3(0, 1, 0);
  /** THRUST vs HOVER attitude, with hysteresis. */
  private thrustMode = false;
  private boosting = false;

  get active(): boolean {
    return this._goal !== null;
  }
  get goal(): AutopilotGoal | null {
    return this._goal;
  }
  get phase(): AutopilotPhase {
    return this._phase;
  }

  /**
   * Take the controls for `goal`. Puts the flight model in FA-OFF (the
   * controller flies raw thrust) and remembers the pilot's FA.
   */
  engage(goal: AutopilotGoal, flight: FlightModel, world: AutopilotWorld): void {
    if (!this.active) this.savedFa = flight.flightAssist;
    this._goal = goal;
    this.thrustMode = false;
    this.boosting = false;
    flight.flightAssist = false;

    if (goal === 'orbit') {
      // The orbit plane: the same ecliptic-nearest convention as spawn and
      // recovery (`circularOrbitState`), so auto-orbit lands the ship in the
      // orbit the game would have given it.
      sUp.copy(flight.position).normalize();
      sTan.crossVectors(WORLD_UP, sUp);
      if (sTan.lengthSq() < 1e-12) sTan.crossVectors(WORLD_X, sUp);
      this.normal.crossVectors(sUp, sTan).normalize();
      this._phase = 'liftoff';
    } else {
      this._phase = 'deorbit';
    }
    void world;
  }

  /** Hand the controls back: pilot's FA restored, every channel zeroed. */
  disengage(flight: FlightModel): void {
    if (!this.active) return;
    this._goal = null;
    this._phase = 'idle';
    const c = flight.command;
    c.pitch = 0;
    c.yaw = 0;
    c.roll = 0;
    c.throttle = 0;
    c.strafeX = 0;
    c.strafeY = 0;
    c.strafeZ = 0;
    c.boost = false;
    c.brake = false;
    flight.flightAssist = this.savedFa;
  }

  /**
   * One frame of guidance: write the command for the next integration.
   * Returns 'landed' / 'orbit' when the leg is complete (the caller then
   * disengages), else 'flying'.
   */
  step(flight: FlightModel, world: AutopilotWorld): AutopilotResult {
    const goal = this._goal;
    if (goal === null) return 'flying';
    const cfg = flight.config;
    const cmd = flight.command;
    cmd.brake = false;

    const p = flight.position;
    const v = flight.velocity;
    const r = p.length();
    if (!(r > 1e-6) || !(world.mu > 0)) return 'flying';
    sUp.copy(p).multiplyScalar(1 / r);

    // Terrain altitude when the ground sampler is installed; the sphere otherwise.
    const alt = Number.isFinite(flight.altitude) ? flight.altitude : r - world.radiusKm;

    const vr = v.dot(sUp);
    sHoriz.copy(v).addScaledVector(sUp, -vr);
    const vh2 = sHoriz.lengthSq();

    // --- authority ----------------------------------------------------------
    const mainAccel = (cfg.mainThrust / cfg.mass) * M_TO_KM;
    const rcsAccel = (cfg.rcsThrust / cfg.mass) * M_TO_KM;
    const g = world.mu / (r * r);
    const gSurface = world.mu / (world.radiusKm * world.radiusKm);
    // Braking the envelope plans with: boosted drive less surface gravity.
    const brake = BRAKE_FRACTION * Math.max(0, mainAccel * cfg.boostMultiplier - gSurface);

    // --- completion ---------------------------------------------------------
    if (goal === 'land' && flight.grounded) {
      this.idle(cmd);
      return 'landed';
    }

    // --- the field ------------------------------------------------------------
    this.fieldAt(p, alt, world, brake, sField);
    if (goal === 'land') {
      // Phases only move forward: they are a story for the log, not state the
      // controller depends on.
      if (this._phase === 'deorbit' && vh2 < 0.05 * 0.05) this._phase = 'descent';
      if (alt <= FINAL_ALTITUDE_KM && this._phase !== 'final') this._phase = 'final';
    } else {
      if (this._phase === 'liftoff' && alt > 1) this._phase = 'ascent';
      if (this._phase === 'ascent' && this.lastBlend >= 1) this._phase = 'circularise';

      const rTarget = orbitTargetRadius(world);
      orbitApsides(p, v, world.mu, sApsides);
      const floor = world.radiusKm + Math.max(world.atmosphereTopKm, 0.02 * world.radiusKm + 10);
      if (
        sApsides.eccentricity < ORBIT_DONE_E &&
        Math.abs(rTarget - r) < ORBIT_RADIUS_TOL * rTarget &&
        sApsides.periapsis > floor
      ) {
        this.idle(cmd);
        return 'orbit';
      }
    }

    // Feed-forward: how fast the field itself changes along the ship's path.
    // Without it a velocity field is tracked with a lag of τ·(dv/dt) — on the
    // braking parabola ~0.3 km/s, which reached the final segment at
    // 0.5 km/s instead of 30 m/s. The terrain is taken as level over the
    // look-ahead (it is a quarter of a second).
    sAhead.copy(p).addScaledVector(v, FF_DT);
    this.fieldAt(sAhead, alt + (sAhead.length() - r), world, brake, sFieldAhead);
    this.fieldAt(p, alt, world, brake, sField); // restores lastBlend for this point
    sFf.subVectors(sFieldAhead, sField).multiplyScalar(1 / FF_DT);
    const ffMax = 2 * brake;
    if (sFf.lengthSq() > ffMax * ffMax) sFf.setLength(ffMax);

    // In air, cap the field (and its rate of change with it) so drag stays
    // under DRAG_CAP.
    const rho = flight.atmosphericDensity;
    if (rho > 0) {
      const vq = Math.sqrt(DRAG_CAP / (cfg.dragCoefficient * rho));
      const fl = sField.length();
      if (fl > vq) {
        sField.multiplyScalar(vq / fl);
        sFf.multiplyScalar(vq / fl);
      }
    }

    // --- demanded acceleration -------------------------------------------------
    // a = (field − v)/τ − g_eff, with g_eff = −g·r̂ + (v_h²/r)·r̂.
    sAcc.subVectors(sField, v).multiplyScalar(1 / TAU).add(sFf);
    sAcc.addScaledVector(sUp, g - vh2 / r);
    const aMag = sAcc.length();

    // --- attitude mode ----------------------------------------------------------
    if (this.thrustMode ? aMag < HOVER_IN * rcsAccel : aMag > THRUST_IN * rcsAccel) {
      this.thrustMode = !this.thrustMode;
    }
    if (this.boosting ? aMag < BOOST_OFF * mainAccel : aMag > BOOST_ON * mainAccel) {
      this.boosting = !this.boosting;
    }
    if (!this.thrustMode) this.boosting = false;
    const boostMul = this.boosting ? cfg.boostMultiplier : 1;
    // FlightModel's thrust limiter, mirrored so the allocation is honest near
    // the speed ceiling.
    const vmax = cfg.topSpeed * boostMul;
    const limiter = clamp01(1 - Math.pow(Math.min(flight.speed / vmax, 1), cfg.speedFalloffExponent));
    const rcsEff = rcsAccel * limiter;

    if (this.thrustMode) {
      sAim.copy(sAcc).multiplyScalar(1 / aMag);
      sRoof.copy(flight.up); // keep the roll the hull already has
    } else if (goal === 'orbit') {
      sAim.crossVectors(this.normal, sUp).normalize(); // prograde, roof out
      sRoof.copy(sUp);
    } else {
      // Level on the local horizon, keeping the current heading.
      sAim.copy(flight.forward).addScaledVector(sUp, -flight.forward.dot(sUp));
      if (sAim.lengthSq() < 1e-8) sAim.copy(flight.up).addScaledVector(sUp, -flight.up.dot(sUp));
      if (sAim.lengthSq() < 1e-8) sAim.crossVectors(WORLD_UP, sUp);
      if (sAim.lengthSq() < 1e-8) sAim.crossVectors(WORLD_X, sUp);
      sAim.normalize();
      sRoof.copy(sUp);
    }
    this.steer(flight, sAim, sRoof);

    // --- allocation ---------------------------------------------------------------
    cmd.boost = this.boosting;
    let mainOut = 0;
    if (this.thrustMode) {
      const along = sAcc.dot(flight.forward);
      const cap = mainAccel * boostMul * limiter;
      const want = along > 0 && along > MAIN_CONE_COS * aMag ? along : 0;
      cmd.throttle = cap > 0 ? clamp01(want / cap) : 0;
      // What the drive will actually push this frame is its SPOOLED output,
      // not the lever; RCS makes up the difference, which is what hides the
      // 0.7 s spool from the loop.
      mainOut = flight.throttle * cap;
    } else {
      cmd.throttle = 0;
      mainOut = flight.throttle * mainAccel * limiter;
    }
    sRes.copy(sAcc).addScaledVector(flight.forward, -mainOut);
    cmd.strafeX = rcsEff > 0 ? clampUnit(sRes.dot(flight.right) / rcsEff) : 0;
    cmd.strafeY = rcsEff > 0 ? clampUnit(sRes.dot(flight.up) / rcsEff) : 0;
    cmd.strafeZ = rcsEff > 0 ? clampUnit(sRes.dot(flight.forward) / rcsEff) : 0;
    return 'flying';
  }

  /** Last orbit-leg horizontal blend (0..1), for the phase story. */
  private lastBlend = 0;

  /**
   * The velocity field at parent-relative `pos`, whose terrain altitude is
   * `altKm`, into `out`. A function of position only, so it can be evaluated
   * a step ahead for the feed-forward.
   */
  private fieldAt(pos: Vector3, altKm: number, world: AutopilotWorld, brake: number, out: Vector3): Vector3 {
    const r = pos.length();
    sUpF.copy(pos).multiplyScalar(1 / r);
    if (this._goal === 'land') {
      return out.copy(sUpF).multiplyScalar(-descentSpeedKmS(altKm, brake));
    }
    const rTarget = orbitTargetRadius(world);
    const dr = rTarget - r;
    const vRad = Math.sign(dr) * Math.sqrt(2 * brake * Math.abs(dr));
    // Horizontal speed blends in between the air's middle and well clear of
    // it: a gravity turn by schedule rather than by aerodynamics.
    const hA = Math.max(0.5 * world.atmosphereTopKm, 2);
    const hB = Math.max(world.atmosphereTopKm, 0.02 * world.radiusKm) + 0.1 * (rTarget - world.radiusKm);
    const w = smoothstep((r - world.radiusKm - hA) / (hB - hA));
    this.lastBlend = w;
    // Prograde in the fixed plane: n × r̂.
    sTanF.crossVectors(this.normal, sUpF).normalize();
    return out.copy(sUpF).multiplyScalar(vRad).addScaledVector(sTanF, w * Math.sqrt(world.mu / r));
  }

  private idle(cmd: FlightModel['command']): void {
    cmd.throttle = 0;
    cmd.strafeX = 0;
    cmd.strafeY = 0;
    cmd.strafeZ = 0;
    cmd.boost = false;
    cmd.pitch = 0;
    cmd.yaw = 0;
    cmd.roll = 0;
  }

  /**
   * Three-axis attitude PD towards nose `aim`, roof as near `roof` as the nose
   * allows. Same tuning as `cruiseSteer` (critically damped against the
   * hull's own α and rotation damping), extended to roll.
   */
  private steer(flight: FlightModel, aim: Vector3, roof: Vector3): void {
    // Matrix4.lookAt puts −Z from eye to target, and −Z is the nose.
    sRoof.addScaledVector(aim, -aim.dot(roof));
    if (sRoof.lengthSq() < 1e-10) sRoof.copy(WORLD_UP).addScaledVector(aim, -aim.y);
    if (sRoof.lengthSq() < 1e-10) sRoof.copy(WORLD_X).addScaledVector(aim, -aim.x);
    sRoof.normalize();
    sMat.lookAt(ZERO, aim, sRoof);
    sQDes.setFromRotationMatrix(sMat);

    // Error in body axes: q_des = q · q_err.
    sQErr.copy(flight.orientation).invert().multiply(sQDes);
    if (sQErr.w < 0) {
      sQErr.x = -sQErr.x;
      sQErr.y = -sQErr.y;
      sQErr.z = -sQErr.z;
      sQErr.w = -sQErr.w;
    }
    const s = Math.hypot(sQErr.x, sQErr.y, sQErr.z);
    const angle = 2 * Math.atan2(s, sQErr.w);
    const k = s > 1e-9 ? angle / s : 2;
    const ex = sQErr.x * k;
    const ey = sQErr.y * k;
    const ez = sQErr.z * k;

    const c = flight.config;
    const decay = flight.attitudeHold ? 1 / c.assistDampTime : 0;
    const w = flight.angularVelocity;
    const cmd = flight.command;
    const aP = (c.rcsTorque.pitch / c.inertia.pitch) * M_TO_KM;
    const aY = (c.rcsTorque.yaw / c.inertia.yaw) * M_TO_KM;
    const aR = (c.rcsTorque.roll / c.inertia.roll) * M_TO_KM;
    const kd = Math.max(0, 2 * OMEGA_N - decay);
    const kp = OMEGA_N * OMEGA_N;
    cmd.pitch = clampUnit((kp * ex - kd * w.x) / aP);
    // Torque about body Y/Z carries the hull's axis signs; divide them back out.
    cmd.yaw = clampUnit((kp * ey - kd * w.y) / aY / c.yawAxisSign);
    cmd.roll = clampUnit((kp * ez - kd * w.z) / aR / c.rollAxisSign);
  }
}

/** Auto-orbit radius: 1.6 R, or higher if the air reaches that far. */
export function orbitTargetRadius(world: AutopilotWorld): number {
  const R = world.radiusKm;
  return Math.max(R * ORBIT_TARGET_RADII, R + 1.2 * world.atmosphereTopKm + 50);
}

function smoothstep(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampUnit(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v;
}
