/**
 * 6DOF newtonian flight.
 *
 * This is the only place in the game where the ship's motion is decided. It is
 * a plain class rather than a `GameModule` because the integrator needs to
 * choose *when* it runs relative to the universe update (gravity sources move,
 * the terrain sampler changes as you approach a planet), and because it must be
 * runnable headlessly for `flightSelfTest()`.
 *
 * DESIGN NOTES
 *
 * - The ship is a rigid body, not a camera on rails. Everything the pilot does
 *   is a *force* or a *torque*; nothing sets a velocity or an angle directly.
 *   That is what makes 200 tonnes feel like 200 tonnes.
 * - Integration is semi-implicit (symplectic) Euler at a fixed 120 Hz substep.
 *   Symplectic Euler has no secular energy drift, so an orbit stays an orbit
 *   for hours of play; a fixed step means the physics is identical at 30 fps
 *   and 144 fps.
 * - The top speed is enforced by *fading the thrust out*, never by clamping the
 *   velocity. Clamping reads as hitting an invisible wall; fading reads as an
 *   engine running out of breath, which is what it is.
 * - `flightAssist` is the character switch. On, a flight computer bleeds off
 *   rotation in about a second and the ship handles like an aeroplane. Off, the
 *   ship handles like an object in vacuum: you rotate until you rotate back.
 *   Assist deliberately does NOT cancel linear drift — newtonian drift is the
 *   point of the game.
 *
 * UNITS  distance km · time s · mass kg · force N · angle rad
 *   Config forces are given in newtons because those are numbers a human can
 *   reason about; `M_TO_KM` converts the resulting acceleration into the
 *   kilometre world exactly once, at construction.
 */

import { Quaternion, Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import type { InputAxes } from '@/core/Input';
import type { PlanetSpec } from '@/gen/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** N/kg gives m/s²; the world is in km. */
const M_TO_KM = 1e-3;
/** Standard gravity in km/s², for the g-meter. */
const G0 = 9.80665e-3;
/** Physics substep. 120 Hz survives a 25 g burn without visible integration error. */
const FIXED_H = 1 / 120;
/**
 * Ceiling on substeps per frame. 8 × 1/120 s = 1/15 s, which is exactly the dt
 * clamp in `Engine.step()`, so a stalled frame never spirals.
 */
const MAX_SUBSTEPS = 8;
/** Altitude (km) above ground at which "grounded" releases. 5 m of hysteresis. */
const GROUND_RELEASE = 0.005;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AxisTriple {
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
}

export interface ShipConfig {
  /** Dry mass, kg. */
  readonly mass: number;
  /** Main drive, newtons, directed along the hull's -Z. */
  readonly mainThrust: number;
  /** Multiplier on main thrust *and* on top speed while boost is held. */
  readonly boostMultiplier: number;
  /** RCS translation authority, newtons, per axis. */
  readonly rcsThrust: number;
  /** Retro authority when the brake is held, newtons, applied along -velocity. */
  readonly brakeThrust: number;
  /** Principal moments of inertia, kg·km². Roll is the cheap axis on a hull. */
  readonly inertia: AxisTriple;
  /** Peak RCS couple per axis, N·km. */
  readonly rcsTorque: AxisTriple;
  /**
   * Time constant of the flight computer's attitude hold, seconds. Rotation
   * decays as exp(-t/tau), so ~0.35 s means the stick is fully "let go" after
   * about a second. Also sets the steady-state rate: rate = alpha · tau.
   */
  readonly assistDampTime: number;
  /** Cruise ceiling, km/s. Thrust fades to nothing here. */
  readonly topSpeed: number;
  /** How abruptly thrust fades near the ceiling. 3 = imperceptible until ~70%. */
  readonly speedFalloffExponent: number;
  /** Engine spool time, seconds. The throttle lever is not the engine. */
  readonly throttleSpoolTime: number;
  /**
   * Drag acceleration is `dragCoefficient · density · v²` (km/s²), with density
   * in kg/m³ and v in km/s. 0.16 puts terminal velocity at ~1 km/s in one bar.
   */
  readonly dragCoefficient: number;
  /** Weathercock strength: angular accel per (kg/m³ · (km/s)²) of dynamic pressure. */
  readonly aeroAlign: number;
  /** Aerodynamic angular damping per (kg/m³ · km/s). Applies with assist off too. */
  readonly aeroAngularDamp: number;
  /** density·v³ that reads as fully glowing hot. */
  readonly heatReference: number;
  /** Impact speed along the surface normal, km/s, below which this is a landing. */
  readonly landingSpeed: number;
  /** Impact speed along the surface normal, km/s, at or above which the hull fails. */
  readonly crashSpeed: number;
  /** Bounce factor for the band between landing and crash. */
  readonly restitution: number;
  /** Tangential velocity decay on the ground, per second. */
  readonly groundFriction: number;
  /**
   * Sign applied to the yaw axis. `Input.update()` currently maps mouse-right
   * to a *negative* yaw axis (and ArrowLeft to a positive one), which is the
   * opposite of the sign documented on `InputAxes`. -1 makes mouse-right yaw
   * right today; set to +1 if Input is ever corrected.
   */
  readonly yawAxisSign: number;
  /** Same story for roll: `KeyQ` produces +1 and pilots expect Q to roll left. */
  readonly rollAxisSign: number;
}

/**
 * A 30 m, 200 tonne survey ship. ~25 g on the main drive sounds absurd until
 * you try to cross 100,000 km of empty system with less; the fiction is an
 * inertial compensator, and the *feel* is preserved by the spool time, the
 * inertia and the damping, not by making the numbers small.
 */
export const DEFAULT_SHIP_CONFIG: ShipConfig = {
  mass: 2.0e5,
  mainThrust: 4.0e7, // 200 m/s² = 0.2 km/s²
  boostMultiplier: 3,
  rcsThrust: 1.0e7, // 50 m/s² — deliberately a quarter of the main drive
  brakeThrust: 1.6e7,
  // I ≈ m·r² for a 30 m hull: heavy in pitch/yaw, light about the roll axis.
  inertia: { pitch: 18, yaw: 18, roll: 7 },
  // alpha = torque·1e-3 / I  →  2.0, 1.8 and 3.2 rad/s².
  rcsTorque: { pitch: 3.6e4, yaw: 3.24e4, roll: 2.24e4 },
  assistDampTime: 0.35,
  // 60 km/s in the local frame. Orbital distances are enormous — 11,000 km to
  // a planet you can see filling the screen — and at a physically honest few
  // km/s you would never arrive. This is the one place the game is
  // deliberately unphysical, and it is cheaper than a cruise mode.
  topSpeed: 60,
  speedFalloffExponent: 3,
  throttleSpoolTime: 0.7,
  dragCoefficient: 0.16,
  aeroAlign: 0.9,
  aeroAngularDamp: 0.5,
  heatReference: 10,
  landingSpeed: 0.04, // 40 m/s
  crashSpeed: 0.12, // 120 m/s
  restitution: 0.25,
  groundFriction: 1.8,
  yawAxisSign: -1,
  rollAxisSign: -1,
};

// ---------------------------------------------------------------------------
// Inputs and world hooks
// ---------------------------------------------------------------------------

/**
 * The pilot's intent for this frame. A preallocated struct rather than an
 * argument object, so the integrator can write into it every frame without
 * allocating. Fields mirror `InputAxes` plus the two held actions the model
 * cares about.
 */
export interface FlightCommand {
  pitch: number;
  yaw: number;
  roll: number;
  throttle: number;
  strafeX: number;
  strafeY: number;
  strafeZ: number;
  boost: boolean;
  brake: boolean;
}

export interface GravitySource {
  /** World position, km. Owned by the caller — mutate it in place as bodies orbit. */
  readonly position: Vector3;
  /** Standard gravitational parameter GM, km³/s². Earth is 398600. */
  readonly mu: number;
  /** Body radius, km. Optional; lets `altitude` work without a ground sampler. */
  readonly radius?: number;
}

/**
 * Returns the ship's altitude above the terrain at `worldPos`, in km.
 * Negative means the ship is inside the ground. Sampling terrain is expensive,
 * so this is only called when the ship is plausibly near a surface.
 */
/**
 * Terrain query for collision.
 *
 * Returns the ship's ALTITUDE ABOVE THE SURFACE in km at that world position —
 * negative when penetrating. NOT the surface radius: this was wired to
 * PlanetRenderer.surfaceRadius() once, which returns ~11,000, so the ship was
 * never in contact with anything and simply flew through the ground.
 */
export type GroundSampler = (worldPos: Vector3) => number;

export type ImpactKind = 'landing' | 'hard' | 'crash';

// ---------------------------------------------------------------------------

export class FlightModel {
  readonly config: ShipConfig;

  // --- authoritative rigid-body state -------------------------------------
  /** World position, km. Read freely; use `teleport()` to move the ship. */
  readonly position = new Vector3();
  /** World velocity, km/s. */
  readonly velocity = new Vector3();
  /** Hull orientation. The nose points along local -Z. */
  readonly orientation = new Quaternion();
  /** Angular velocity in BODY axes, rad/s. (x = pitch, y = yaw, z = roll.) */
  readonly angularVelocity = new Vector3();

  /**
   * Position/orientation extrapolated to the *display* time, i.e. including the
   * fraction of a substep left in the accumulator. Renderers and the camera rig
   * should read these; physics reads `position`/`orientation`. Without this the
   * ship visibly beats against the 120 Hz grid at unrelated frame rates.
   */
  readonly renderPosition = new Vector3();
  readonly renderOrientation = new Quaternion();

  // --- derived frames, refreshed every substep ----------------------------
  /** Hull -Z in world space. */
  readonly forward = new Vector3(0, 0, -1);
  /** Hull +X in world space. */
  readonly right = new Vector3(1, 0, 0);
  /** Hull +Y in world space. */
  readonly up = new Vector3(0, 1, 0);
  /** Away from the dominant gravity source; +Y in deep space. */
  readonly localUp = new Vector3(0, 1, 0);
  /** Gravitational acceleration acting on the ship, km/s². */
  readonly gravityAccel = new Vector3();

  /**
   * Velocity of the frame the ship is flying in — the body it is near, moving
   * on its own orbit. Everything that asks "how fast are we going" must ask it
   * about THIS, not about the world.
   *
   * A planet's orbital speed around its star is tens of km/s, far above any
   * ship's top speed. Measuring against the world therefore pins the thrust
   * limiter at zero everywhere in the universe: full throttle, no acceleration,
   * no G, nothing moves. The ship is unflyable in any orbit.
   */
  readonly referenceVelocity = new Vector3();
  /** velocity - referenceVelocity. Recomputed each step, never allocated. */
  readonly relativeVelocity = new Vector3();

  /** The pilot's intent. Write into this, or call `applyInput()`. */
  readonly command: FlightCommand = {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: 0,
    strafeX: 0,
    strafeY: 0,
    strafeZ: 0,
    boost: false,
    brake: false,
  };

  // --- precomputed authority (km/s², rad/s²) ------------------------------
  private readonly mainAccel: number;
  private readonly rcsAccel: number;
  private readonly brakeAccel: number;
  private readonly alphaPitch: number;
  private readonly alphaYaw: number;
  private readonly alphaRoll: number;

  // --- world hooks --------------------------------------------------------
  private sources: readonly GravitySource[] = [];
  private groundSampler: GroundSampler | null = null;
  private landingPlanet: PlanetSpec | null = null;
  private density = 0;
  /**
   * Last known altitude, decayed pessimistically by the distance travelled each
   * substep. Terrain is fBm and far too expensive to evaluate 8× a frame, so a
   * substep only pays for a real sample once this conservative bound says the
   * ground is within reach.
   */
  private altCache = 0;

  // --- readouts -----------------------------------------------------------
  private _speed = 0;
  private _relSpeed = 0;
  private _verticalSpeed = 0;
  private _altitude = Number.POSITIVE_INFINITY;
  private _gForce = 0;
  private _throttle = 0;
  private _heading = 0;
  private _heating = 0;
  private _grounded = false;
  private _boosting = false;
  private _assist = true;
  private lastEmittedThrottle = -1;

  private accumulator = 0;

  // --- scratch. Every vector the update path touches lives here. ----------
  private readonly sAcc = new Vector3();
  private readonly sGrav = new Vector3();
  private readonly sTorque = new Vector3();
  private readonly sTmp = new Vector3();
  private readonly sTmp2 = new Vector3();
  private readonly sVdir = new Vector3();
  private readonly sAxis = new Vector3();
  private readonly sInvQ = new Quaternion();
  private readonly sDeltaQ = new Quaternion();

  constructor(config: Partial<ShipConfig> = {}) {
    this.config = {
      ...DEFAULT_SHIP_CONFIG,
      ...config,
      inertia: { ...DEFAULT_SHIP_CONFIG.inertia, ...config.inertia },
      rcsTorque: { ...DEFAULT_SHIP_CONFIG.rcsTorque, ...config.rcsTorque },
    };

    const c = this.config;
    this.mainAccel = (c.mainThrust / c.mass) * M_TO_KM;
    this.rcsAccel = (c.rcsThrust / c.mass) * M_TO_KM;
    this.brakeAccel = (c.brakeThrust / c.mass) * M_TO_KM;
    this.alphaPitch = (c.rcsTorque.pitch / c.inertia.pitch) * M_TO_KM;
    this.alphaYaw = (c.rcsTorque.yaw / c.inertia.yaw) * M_TO_KM;
    this.alphaRoll = (c.rcsTorque.roll / c.inertia.roll) * M_TO_KM;
  }

  // -------------------------------------------------------------------------
  // Readouts — the HUD's entire contract with the flight model
  // -------------------------------------------------------------------------

  /** km/s. */
  get speed(): number {
    return this._speed;
  }
  /** Speed within the local frame — what the limiter and the HUD both mean. */
  get relativeSpeed(): number {
    return this._relSpeed;
  }
  /** km/s along `localUp`. Positive is climbing. */
  get verticalSpeed(): number {
    return this._verticalSpeed;
  }
  /** km above terrain, or `Infinity` when nothing has told us where the ground is. */
  get altitude(): number {
    return this._altitude;
  }
  /** Non-gravitational acceleration in g. Free fall reads zero, as an accelerometer would. */
  get gForce(): number {
    return this._gForce;
  }
  /** Engine output 0..1 — the spooled value, not the lever position. */
  get throttle(): number {
    return this._throttle;
  }
  /** Radians 0..2π, clockwise from local north. Meaningless without a gravity source. */
  get heading(): number {
    return this._heading;
  }
  /** 0..1 re-entry heat, for the hull glow and the warning tone. */
  get heating(): number {
    return this._heating;
  }
  get grounded(): boolean {
    return this._grounded;
  }
  get boosting(): boolean {
    return this._boosting;
  }

  /**
   * Attitude hold. Off is vacuum: whatever rotation you started, you keep.
   * This toggle is most of the game's character, so it announces itself.
   */
  get flightAssist(): boolean {
    return this._assist;
  }
  set flightAssist(on: boolean) {
    if (on === this._assist) return;
    this._assist = on;
    bus.emit('log', {
      text: on ? 'FLIGHT ASSIST ENGAGED' : 'FLIGHT ASSIST OFF — NEWTONIAN',
      tone: on ? 'normal' : 'warn',
    });
  }

  // -------------------------------------------------------------------------
  // World hooks
  // -------------------------------------------------------------------------

  /**
   * The bodies pulling on the ship. The array and its `Vector3`s are held by
   * reference so orbiting bodies cost nothing per frame — mutate them in place.
   * Keep this list short: only the star and the current planet/moon matter.
   */
  setGravitySources(sources: readonly GravitySource[]): void {
    this.sources = sources;
  }

  /** Local atmospheric density at the ship, kg/m³. 0 = vacuum. */
  /**
   * Tell the model which frame it is flying in. Pass the velocity of the body
   * you are near; pass zero in deep space.
   */
  setReferenceVelocity(v: Vector3 | null): void {
    if (v) this.referenceVelocity.copy(v);
    else this.referenceVelocity.set(0, 0, 0);
  }

  setAtmosphere(densityAtShip: number): void {
    this.density = densityAtShip > 0 ? densityAtShip : 0;
  }

  /** Install (or clear, with `null`) the terrain height query used for collision. */
  setGroundSampler(fn: GroundSampler | null): void {
    this.groundSampler = fn;
    this.altCache = 0; // force a real sample on the next substep
    if (!fn) {
      this._grounded = false;
      this._altitude = Number.POSITIVE_INFINITY;
    }
  }

  /**
   * Which planet we are over, so a touchdown can be announced as
   * `planet:landed`. The flight model has no other knowledge of the universe.
   */
  setLandingContext(planet: PlanetSpec | null): void {
    this.landingPlanet = planet;
  }

  /**
   * Speed of a circular orbit at `pos` around whichever source dominates there.
   * The direction is the one that keeps the orbit closest to the world XZ
   * plane, which is where systems are generated, so spawning is predictable.
   * Not called from `update()` — allocating a default `out` is fine here.
   */
  orbitalVelocityAt(pos: Vector3, out = new Vector3()): Vector3 {
    const src = this.dominantSourceAt(pos);
    if (!src) return out.set(0, 0, 0);

    this.sTmp.copy(pos).sub(src.position);
    const r = this.sTmp.length();
    if (r < 1e-6) return out.set(0, 0, 0);

    // Any unit vector perpendicular to r works; pick the one nearest prograde
    // in the ecliptic by crossing with world up, with a fallback for poles.
    this.sTmp2.set(0, 1, 0);
    out.crossVectors(this.sTmp2, this.sTmp);
    if (out.lengthSq() < 1e-12) {
      this.sTmp2.set(1, 0, 0);
      out.crossVectors(this.sTmp2, this.sTmp);
    }
    return out.normalize().multiplyScalar(Math.sqrt(src.mu / r));
  }

  /** Place the ship. Used at spawn and on warp arrival; never during flight. */
  teleport(position: Vector3, velocity?: Vector3, orientation?: Quaternion): void {
    this.position.copy(position);
    this.velocity.copy(velocity ?? this.sTmp.set(0, 0, 0));
    if (orientation) this.orientation.copy(orientation).normalize();
    this.angularVelocity.set(0, 0, 0);
    this.accumulator = 0;
    this._grounded = false;
    this._heating = 0;
    this.altCache = 0; // force a fresh terrain sample wherever we arrived
    this.renderPosition.copy(this.position);
    this.renderOrientation.copy(this.orientation);
    this.refreshBodyAxes();
  }

  /** Convenience for the integrator: fold `Input` into the command struct. */
  applyInput(axes: InputAxes, boost: boolean, brake: boolean): void {
    const cmd = this.command;
    cmd.pitch = axes.pitch;
    cmd.yaw = axes.yaw;
    cmd.roll = axes.roll;
    cmd.throttle = axes.throttle;
    cmd.strafeX = axes.strafeX;
    cmd.strafeY = axes.strafeY;
    cmd.strafeZ = axes.strafeZ;
    cmd.boost = boost;
    cmd.brake = brake;
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  update(dt: number): void {
    this.accumulator += dt;
    // Discard anything beyond the substep ceiling rather than trying to catch
    // up: a 2 s hitch must not become a 2 s burn.
    const maxCarry = MAX_SUBSTEPS * FIXED_H;
    if (this.accumulator > maxCarry) this.accumulator = maxCarry;

    let steps = 0;
    while (this.accumulator >= FIXED_H && steps < MAX_SUBSTEPS) {
      this.step(FIXED_H);
      this.accumulator -= FIXED_H;
      steps++;
    }

    this.extrapolateForRender(this.accumulator);
    this.updateReadouts();
  }

  // -------------------------------------------------------------------------

  private step(h: number): void {
    const c = this.config;
    this.refreshBodyAxes();

    // --- throttle spool -----------------------------------------------------
    this._boosting = this.command.boost;
    this._throttle = damp(this._throttle, clamp01(this.command.throttle), c.throttleSpoolTime, h);

    // --- gravity ------------------------------------------------------------
    this.accumulateGravity(this.position, this.sGrav);
    this.gravityAccel.copy(this.sGrav);

    // --- non-gravitational forces ------------------------------------------
    this.sAcc.set(0, 0, 0);
    // Relative to the local frame, not the world — see referenceVelocity.
    this.sTmp.subVectors(this.velocity, this.referenceVelocity);
    const speed = this.sTmp.length();

    // Thrust fades as the ceiling approaches. Never clamp the velocity: the
    // whole point is that you feel the engine give up, not the world stop you.
    const boostMul = this._boosting ? c.boostMultiplier : 1;
    const vmax = c.topSpeed * boostMul;
    const limiter = clamp01(1 - Math.pow(Math.min(speed / vmax, 1), c.speedFalloffExponent));

    const main = this._throttle * this.mainAccel * boostMul * limiter;
    this.sAcc.addScaledVector(this.forward, main);

    const rcs = this.rcsAccel * limiter;
    this.sAcc.addScaledVector(this.right, this.command.strafeX * rcs);
    this.sAcc.addScaledVector(this.up, this.command.strafeY * rcs);
    this.sAcc.addScaledVector(this.forward, this.command.strafeZ * rcs);

    // Brake is retro-thrust along -v, so it is exempt from the speed limiter —
    // it only ever removes energy.
    if (this.command.brake && speed > 1e-6) {
      const bite = Math.min(1, speed / (this.brakeAccel * h + 1e-9));
      this.sAcc.addScaledVector(this.velocity, (-this.brakeAccel * bite) / speed);
    }

    // --- atmosphere ---------------------------------------------------------
    if (this.density > 0 && speed > 1e-9) {
      this.sVdir.copy(this.velocity).multiplyScalar(1 / speed);
      const dragMag = c.dragCoefficient * this.density * speed * speed;
      this.sAcc.addScaledVector(this.sVdir, -dragMag);
    }

    // --- accelerometer, then integrate --------------------------------------
    // g-force is what an accelerometer reads: proper acceleration only, so free
    // fall is 0 g and sitting on a planet is 1 g.
    this._gForce = damp(this._gForce, this.sAcc.length() / G0, 0.15, h);

    this.sAcc.add(this.sGrav);
    // Semi-implicit Euler: velocity first, then position with the NEW velocity.
    // That one ordering is what keeps a 100-orbit test from spiralling.
    this.velocity.addScaledVector(this.sAcc, h);
    this.position.addScaledVector(this.velocity, h);

    this.stepRotation(h, speed);
    this.stepHeating(h, speed);
    if (this.groundSampler) this.stepGround(h);
  }

  // -------------------------------------------------------------------------

  private stepRotation(h: number, speed: number): void {
    const c = this.config;
    const w = this.angularVelocity;

    // Pilot torque, body axes. See `yawAxisSign` / `rollAxisSign` for why the
    // last two are negated by default.
    this.sTorque.set(
      this.command.pitch * this.alphaPitch,
      this.command.yaw * this.alphaYaw * c.yawAxisSign,
      this.command.roll * this.alphaRoll * c.rollAxisSign,
    );

    if (this.density > 0 && speed > 1e-9) {
      // Weathercock: a body with fins wants its nose down the relative wind.
      // Working in body space makes the axis almost free — the nose is a
      // constant (0,0,-1), so (0,0,-1) × v̂ collapses to (v̂.y, -v̂.x, 0).
      this.sInvQ.copy(this.orientation).invert();
      this.sVdir.copy(this.velocity).multiplyScalar(1 / speed).applyQuaternion(this.sInvQ);
      const q = c.aeroAlign * this.density * speed * speed;
      this.sTorque.x += this.sVdir.y * q;
      this.sTorque.y += -this.sVdir.x * q;

      // Aerodynamic damping is physical, so it survives assist being off.
      const aeroDamp = c.aeroAngularDamp * this.density * speed;
      this.sTorque.addScaledVector(w, -aeroDamp);
    }

    // Euler's equation: I·ω̇ = τ - ω × (I·ω). The cross term is why a tumbling
    // hull with unequal moments wanders between axes instead of spinning
    // cleanly. With assist off, that wander is the whole point.
    const ix = c.inertia.pitch;
    const iy = c.inertia.yaw;
    const iz = c.inertia.roll;
    this.sTorque.x -= ((iz - iy) * w.y * w.z) / ix;
    this.sTorque.y -= ((ix - iz) * w.z * w.x) / iy;
    this.sTorque.z -= ((iy - ix) * w.x * w.y) / iz;

    w.addScaledVector(this.sTorque, h);

    if (this._assist) {
      // Exponential decay towards zero — not a rate controller. Steady state
      // under a held stick is alpha·tau, and letting go bleeds off in ~1 s.
      // Landing gear locked on the ground stiffens it considerably.
      const tau = this._grounded ? c.assistDampTime * 0.25 : c.assistDampTime;
      w.multiplyScalar(Math.exp(-h / tau));
    }

    // Exponential map: exact for a constant ω over the substep, and it keeps
    // the quaternion on the unit sphere without a normalise every frame.
    const wMag = w.length();
    if (wMag > 1e-9) {
      this.sAxis.copy(w).multiplyScalar(1 / wMag);
      this.sDeltaQ.setFromAxisAngle(this.sAxis, wMag * h);
      // Right-multiply: ω is in body axes.
      this.orientation.multiply(this.sDeltaQ);
    }
  }

  // -------------------------------------------------------------------------

  private stepHeating(h: number, speed: number): void {
    const target = clamp01(
      (this.density * speed * speed * speed) / this.config.heatReference,
    );
    // Asymmetric: the hull lights up fast and soaks for a long time afterwards.
    const tau = target > this._heating ? 0.5 : 2.5;
    this._heating = damp(this._heating, target, tau, h);
  }

  // -------------------------------------------------------------------------

  private stepGround(h: number): void {
    const sampler = this.groundSampler;
    if (!sampler) return;

    // Cheap gate: assume every metre travelled was straight down. If even that
    // worst case leaves us clear, the terrain does not need evaluating.
    this.altCache -= this.velocity.length() * h;
    if (this.altCache > GROUND_RELEASE) {
      this._grounded = false;
      return;
    }

    const alt = sampler(this.position);
    this.altCache = alt;

    if (alt > GROUND_RELEASE) {
      this._grounded = false;
      return;
    }
    if (alt > 0) return; // inside the hysteresis band but not penetrating

    const c = this.config;
    this.computeLocalUp();

    // Push out along the surface normal rather than reversing the last step:
    // the sampler is the ground truth, and this is stable against a moving one.
    this.position.addScaledVector(this.localUp, -alt);
    this.altCache = 0; // we are now exactly on the surface

    const vn = this.velocity.dot(this.localUp);
    const wasGrounded = this._grounded;

    if (vn < 0) {
      const impact = -vn;
      let kind: ImpactKind = 'landing';
      if (impact >= c.crashSpeed) kind = 'crash';
      else if (impact > c.landingSpeed) kind = 'hard';

      if (kind === 'crash') {
        this.velocity.set(0, 0, 0);
        this.angularVelocity.set(0, 0, 0);
        this._grounded = true;
        bus.emit('ship:crashed', { speed: impact, planetId: this.landingPlanet?.id ?? null });
        bus.emit('log', { text: 'HULL BREACH — IMPACT', tone: 'warn' });
        return;
      }

      if (kind === 'hard') {
        this.velocity.addScaledVector(this.localUp, -vn * (1 + c.restitution));
      } else {
        this.velocity.addScaledVector(this.localUp, -vn);
      }
    }

    this._grounded = true;

    // Friction on the tangential component only; the normal one is gone.
    const vnNow = this.velocity.dot(this.localUp);
    this.sTmp.copy(this.velocity).addScaledVector(this.localUp, -vnNow);
    this.sTmp.multiplyScalar(Math.exp(-c.groundFriction * h) - 1);
    this.velocity.add(this.sTmp);

    if (!wasGrounded) {
      const impact = Math.max(0, -vn);
      bus.emit('ship:touchdown', {
        speed: this.velocity.length(),
        vertical: impact,
        planetId: this.landingPlanet?.id ?? null,
      });
      if (this.landingPlanet) bus.emit('planet:landed', { planet: this.landingPlanet });
      bus.emit('log', {
        text: impact > c.landingSpeed ? 'HARD LANDING' : 'TOUCHDOWN',
        tone: impact > c.landingSpeed ? 'warn' : 'good',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private refreshBodyAxes(): void {
    this.forward.set(0, 0, -1).applyQuaternion(this.orientation);
    this.right.set(1, 0, 0).applyQuaternion(this.orientation);
    this.up.set(0, 1, 0).applyQuaternion(this.orientation);
  }

  private accumulateGravity(at: Vector3, out: Vector3): void {
    out.set(0, 0, 0);
    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i]!;
      this.sTmp.copy(s.position).sub(at);
      const r2 = this.sTmp.lengthSq();
      if (r2 < 1e-9) continue;
      // a = mu/r² towards the body; the extra 1/r normalises sTmp in place.
      out.addScaledVector(this.sTmp, (s.mu / r2) * (1 / Math.sqrt(r2)));
    }
  }

  private dominantSourceAt(at: Vector3): GravitySource | null {
    let best: GravitySource | null = null;
    let bestPull = 0;
    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i]!;
      const r2 = this.sTmp.copy(s.position).sub(at).lengthSq();
      if (r2 < 1e-9) continue;
      const pull = s.mu / r2;
      if (pull > bestPull) {
        bestPull = pull;
        best = s;
      }
    }
    return best;
  }

  private computeLocalUp(): void {
    const src = this.dominantSourceAt(this.position);
    if (!src) {
      this.localUp.set(0, 1, 0);
      return;
    }
    this.localUp.copy(this.position).sub(src.position);
    const len = this.localUp.length();
    if (len < 1e-9) this.localUp.set(0, 1, 0);
    else this.localUp.multiplyScalar(1 / len);
  }

  /**
   * Advance the *visual* transform by the leftover accumulator so the hull is
   * never a physics tick behind the frame it is drawn in.
   */
  private extrapolateForRender(alpha: number): void {
    this.renderPosition.copy(this.position).addScaledVector(this.velocity, alpha);
    const wMag = this.angularVelocity.length();
    if (wMag > 1e-9 && alpha > 0) {
      this.sAxis.copy(this.angularVelocity).multiplyScalar(1 / wMag);
      this.sDeltaQ.setFromAxisAngle(this.sAxis, wMag * alpha);
      this.renderOrientation.copy(this.orientation).multiply(this.sDeltaQ);
    } else {
      this.renderOrientation.copy(this.orientation);
    }
  }

  private updateReadouts(): void {
    this._speed = this.velocity.length();
    this.relativeVelocity.subVectors(this.velocity, this.referenceVelocity);
    this._relSpeed = this.relativeVelocity.length();
    this.computeLocalUp();
    this._verticalSpeed = this.velocity.dot(this.localUp);

    // One authoritative terrain sample per *frame* for the altimeter — the
    // substep gate above uses a conservative bound, which would make a level
    // cruise read as a slow descent if the HUD trusted it.
    if (this.groundSampler) {
      this._altitude = this.groundSampler(this.position);
      this.altCache = this._altitude;
    } else {
      const src = this.dominantSourceAt(this.position);
      this._altitude =
        src && src.radius !== undefined
          ? this.sTmp.copy(this.position).sub(src.position).length() - src.radius
          : Number.POSITIVE_INFINITY;
    }

    // Heading: bearing of the nose in the local horizontal plane, taking world
    // +Y as the pole. In deep space localUp is +Y and this degrades to a plain
    // azimuth, which is exactly what the compass ribbon wants.
    this.sTmp.set(0, 1, 0);
    this.sTmp.addScaledVector(this.localUp, -this.sTmp.dot(this.localUp));
    if (this.sTmp.lengthSq() < 1e-12) this.sTmp.set(1, 0, 0).addScaledVector(this.localUp, -this.localUp.x);
    this.sTmp.normalize();
    this.sTmp2.crossVectors(this.localUp, this.sTmp); // local east
    const north = this.forward.dot(this.sTmp);
    const east = this.forward.dot(this.sTmp2);
    let hdg = Math.atan2(east, north);
    if (hdg < 0) hdg += Math.PI * 2;
    this._heading = hdg;

    if (Math.abs(this._throttle - this.lastEmittedThrottle) > 0.02) {
      this.lastEmittedThrottle = this._throttle;
      bus.emit('throttle:changed', { value: this._throttle });
    }
  }

  /** Drop every reference the model holds. It owns no GPU resources. */
  dispose(): void {
    this.sources = [];
    this.groundSampler = null;
    this.landingPlanet = null;
  }
}

// ---------------------------------------------------------------------------
// Small maths helpers. Local, so nothing else has to import them.
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Frame-rate independent critical damping towards a target. */
function damp(current: number, target: number, tau: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

// ---------------------------------------------------------------------------
// Self test
// ---------------------------------------------------------------------------

/**
 * Headless sanity checks. These are not unit tests in the ceremonial sense —
 * they are the three or four properties that, if they break, make the game
 * unplayable in a way that is very hard to see by flying around: the drive is
 * the wrong strength, orbits decay, drag has no terminal velocity, or the
 * assist toggle does nothing.
 *
 * Call from the console (`flightSelfTest().forEach(l => console.log(l))`) or
 * from a build script.
 */
export function flightSelfTest(): string[] {
  const out: string[] = [];
  const ok = (name: string, pass: boolean, detail: string): void => {
    out.push(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(34)}  ${detail}`);
  };
  const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

  const H = 1 / 120;
  const run = (fm: FlightModel, seconds: number): void => {
    const n = Math.round(seconds / H);
    for (let i = 0; i < n; i++) fm.update(H);
  };

  // --- 1. thrust from rest -------------------------------------------------
  {
    const fm = new FlightModel();
    fm.command.throttle = 1;
    // Skip the spool so the test measures the drive, not the lever.
    run(fm, 4);
    const t = 10;
    fm.velocity.set(0, 0, 0);
    fm.position.set(0, 0, 0);
    run(fm, t);
    const expected = (DEFAULT_SHIP_CONFIG.mainThrust / DEFAULT_SHIP_CONFIG.mass) * 1e-3 * t;
    // The speed limiter shaves a little off near 2 km/s of 9.
    const limiterLoss = 1 - expected / (expected * 1.02);
    ok(
      'thrust from rest',
      near(fm.speed, expected, expected * 0.03),
      `v=${fm.speed.toFixed(4)} km/s, ideal a·t=${expected.toFixed(4)} (limiter ~${(limiterLoss * 100).toFixed(1)}%)`,
    );
    ok(
      'g-meter under burn',
      near(fm.gForce, (expected / t) / G0, 0.6),
      `${fm.gForce.toFixed(2)} g`,
    );
  }

  // --- 2. circular orbit, 100 revolutions ----------------------------------
  {
    // A deliberately tiny body: same physics, 100 orbits in a second of CPU.
    const mu = 10;
    const r = 10;
    const fm = new FlightModel();
    fm.setGravitySources([{ position: new Vector3(0, 0, 0), mu, radius: 1 }]);
    const p = new Vector3(r, 0, 0);
    const v = fm.orbitalVelocityAt(p);
    fm.teleport(p, v);

    const vCirc = Math.sqrt(mu / r);
    const period = 2 * Math.PI * Math.sqrt((r * r * r) / mu);
    const perp = Math.abs(v.dot(p)) / (v.length() * p.length());
    ok(
      'orbitalVelocityAt is circular',
      near(v.length(), vCirc, 1e-9) && perp < 1e-9,
      `|v|=${v.length().toFixed(6)} (want ${vCirc.toFixed(6)}), v·r̂=${perp.toExponential(1)}`,
    );

    let rMin = Infinity;
    let rMax = 0;
    const steps = Math.round((period * 100) / H);
    for (let i = 0; i < steps; i++) {
      fm.update(H);
      const rr = fm.position.length();
      if (rr < rMin) rMin = rr;
      if (rr > rMax) rMax = rr;
    }
    const drift = Math.abs(fm.position.length() - r) / r;
    const band = (rMax - rMin) / r;
    ok(
      'orbit stable over 100 orbits',
      drift < 0.01 && band < 0.02,
      `r=${fm.position.length().toFixed(4)} km (drift ${(drift * 100).toFixed(3)}%), band ${(band * 100).toFixed(3)}%`,
    );
    ok(
      'free fall reads ~0 g',
      fm.gForce < 0.01,
      `${fm.gForce.toExponential(2)} g`,
    );
  }

  // --- 3. drag terminal velocity -------------------------------------------
  {
    const rho = 1.225; // one bar at sea level
    const c = DEFAULT_SHIP_CONFIG;
    const aMain = (c.mainThrust / c.mass) * 1e-3;
    // Solve thrust(v) = drag(v) by bisection for the reference value.
    const f = (vv: number): number =>
      aMain * (1 - Math.pow(Math.min(vv / c.topSpeed, 1), c.speedFalloffExponent)) -
      c.dragCoefficient * rho * vv * vv;
    let lo = 0;
    let hi = c.topSpeed;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) > 0) lo = mid;
      else hi = mid;
    }
    const vTerm = (lo + hi) / 2;

    const fm = new FlightModel();
    fm.setAtmosphere(rho);
    fm.command.throttle = 1;
    run(fm, 120);
    ok(
      'drag terminal velocity',
      near(fm.speed, vTerm, vTerm * 0.02),
      `v=${fm.speed.toFixed(4)} km/s, analytic ${vTerm.toFixed(4)} km/s`,
    );
    ok(
      'heating rises in atmosphere',
      fm.heating > 0.05 && fm.heating <= 1,
      `heating=${fm.heating.toFixed(3)}`,
    );
  }

  // --- 4. flight assist on/off ---------------------------------------------
  {
    const fm = new FlightModel();
    fm.command.pitch = 1;
    run(fm, 3);
    const held = fm.angularVelocity.length();
    fm.command.pitch = 0;
    run(fm, 1);
    const bled = fm.angularVelocity.length();
    ok(
      'assist ON bleeds off in ~1 s',
      bled < held * 0.1,
      `${held.toFixed(4)} → ${bled.toFixed(4)} rad/s (${((bled / held) * 100).toFixed(1)}%)`,
    );

    const fm2 = new FlightModel();
    fm2.flightAssist = false;
    fm2.command.pitch = 1;
    run(fm2, 1);
    const spun = fm2.angularVelocity.length();
    fm2.command.pitch = 0;
    run(fm2, 5);
    const still = fm2.angularVelocity.length();
    ok(
      'assist OFF keeps rotating',
      near(still, spun, spun * 1e-6),
      `${spun.toFixed(4)} → ${still.toFixed(4)} rad/s after 5 s coast`,
    );
  }

  // --- 5. ground collision -------------------------------------------------
  {
    const groundY = 100;
    const mk = (vy: number): FlightModel => {
      const fm = new FlightModel();
      fm.setGravitySources([{ position: new Vector3(0, 0, 0), mu: 10, radius: groundY }]);
      fm.setGroundSampler((p) => p.length() - groundY);
      fm.teleport(new Vector3(0, groundY + 0.5, 0), new Vector3(0, vy, 0));
      return fm;
    };
    const soft = mk(-0.02);
    run(soft, 40); // 0.5 km of fall at 1 m/s² takes ~20 s, then time to settle
    ok(
      'soft touchdown rests on ground',
      soft.grounded && Math.abs(soft.altitude) < 0.01 && soft.speed < 0.01,
      `alt=${soft.altitude.toFixed(5)} km, v=${soft.speed.toFixed(5)} km/s, grounded=${soft.grounded}`,
    );

    const hard = mk(-0.4);
    run(hard, 4);
    ok(
      'high-speed impact is a crash',
      hard.grounded && hard.speed === 0,
      `v=${hard.speed.toFixed(5)} km/s after impact`,
    );
  }

  // --- 6. frame-rate independence ------------------------------------------
  {
    const a = new FlightModel();
    const b = new FlightModel();
    a.command.throttle = 1;
    b.command.throttle = 1;
    for (let i = 0; i < 600; i++) a.update(1 / 120); // 5 s at 120 fps
    for (let i = 0; i < 150; i++) b.update(1 / 30); // 5 s at 30 fps
    const rel = Math.abs(a.speed - b.speed) / Math.max(a.speed, 1e-9);
    ok(
      'frame-rate independent',
      rel < 1e-6,
      `120 fps ${a.speed.toFixed(6)} vs 30 fps ${b.speed.toFixed(6)} km/s`,
    );
  }

  return out;
}
