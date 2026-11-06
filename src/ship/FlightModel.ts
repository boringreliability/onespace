/**
 * 6DOF newtonian flight.
 *
 * This is the only place in the game where the ship's motion is decided. It is
 * a plain class rather than a `GameModule` because the integrator needs to
 * choose *when* it runs relative to the universe update (gravity sources move,
 * the terrain sampler changes as you approach a planet), and because it must be
 * runnable headlessly for `flightSelfTest()`.
 *
 * THE FRAME — read this before touching anything below.
 *
 * oneSpace uses patched conics with an explicit parent body, the way Kerbal
 * Space Program does. `position` and `velocity` are stored RELATIVE TO THE
 * PARENT, exactly one body's gravity acts, and `worldPosition` is a derived
 * quantity that exists only for rendering and the floating origin.
 *
 * The alternative — integrating in the star-centred inertial frame while
 * measuring speed against the nearby body — is what this file used to do, and
 * it made the body the parent of the ship's *velocity* but not of its
 * *position*. Every consumer then had to remember to add the planet's ~49 km/s
 * by hand. Traffic forgot and its contacts drifted; landing forgot and the
 * ship's height above ground rose while it descended. Both looked like an
 * engine-level frame mismatch and were not: they were the missing half of a
 * decision nobody had finished making. `referenceVelocity` was the patch over
 * that gap and it is gone, because there is no longer a gap.
 *
 * Frames are crossed in exactly one function: `rebase()`. If a second copy of
 * those two lines appears anywhere in the project, the design has failed.
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
 * - Two separate computers, two switches.
 *   `attitudeHold` bleeds off rotation in about a second so the ship handles
 *   like an aeroplane; off, you rotate until you rotate back.
 *   `flightAssist` (FA, the Z key) is the translational computer. FA-OFF is
 *   plain Newtonian: the lever is thrust, and drift is yours to manage. FA-ON
 *   makes the lever a *set speed* along the nose, relative to the parent, and
 *   flies the hull there with the main drive, the retro and the RCS — each
 *   inside its own authority, so it can be slow but it can never lie. The
 *   lever's exact zero is a detent that means COAST: no translational thrust
 *   at all, so an orbit (the spawn orbit, a cruise drop into orbit) survives
 *   hands-off. The brake under FA-ON is an active all-stop, against gravity
 *   too. See `stepAssist`.
 *   The class defaults to FA-OFF so headless physics — orbit tests, landing
 *   tests — stays plainly Newtonian; the game turns FA on for the player.
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

/** Seconds for the cruise speed to answer the throttle. */
const CRUISE_RESPONSE = 1.6;
/** Seconds for the brake to bleed cruise speed away. Sharper than the throttle. */
const CRUISE_BRAKE = 0.7;
/** Altitude (km) above ground at which "grounded" releases. 5 m of hysteresis. */
const GROUND_RELEASE = 0.005;

/**
 * Sphere-of-influence hysteresis. A ship skimming a boundary would otherwise
 * swap parents every frame, and each swap is a subtraction of two large,
 * nearly-equal numbers — the one operation in this design that costs precision.
 * Enter low, leave high, so the band between them is dead.
 */
export const SOI_ENTER_FACTOR = 0.98;
export const SOI_LEAVE_FACTOR = 1.02;

/**
 * Floor on a body's sphere of influence, in units of its own radius.
 *
 * The formula is honest and occasionally produces a boundary INSIDE the body —
 * measured, 12 of 699 generated bodies, worst case 0.54 radii. Those are worlds
 * so tidally dominated by their primary that you genuinely cannot orbit them,
 * which is a fine thing to model and a terrible thing to ship: a body that can
 * never become the parent is a body the ground sampler is never installed for,
 * so the player would fly through its surface. 1.5 radii is the smallest floor
 * that leaves room to descend, and it changes nothing for the other 98%.
 */
export const SOI_MIN_RADII = 1.5;

/**
 * Has the ship left its parent's sphere of influence? `distance` is
 * parent-relative, km. Deliberately a function rather than an inline
 * comparison: the asymmetry with `entersSoi` IS the hysteresis, and the two
 * belong side by side where that is visible.
 */
export function leavesSoi(distance: number, radius: number): boolean {
  return distance > radius * SOI_LEAVE_FACTOR;
}

/** Has the ship entered a child's sphere of influence? `distance` is to that child. */
export function entersSoi(distance: number, radius: number): boolean {
  return radius > 0 && distance < radius * SOI_ENTER_FACTOR;
}

/**
 * Radius of a body's sphere of influence, km — the standard two-body result
 *
 *     r_soi = a · (m / M)^(2/5)
 *
 * `semiMajorAxis` is the body's own orbit about its primary, `mu` its
 * gravitational parameter and `parentMu` the primary's. Mass ratio and mu ratio
 * are the same number, and mu is what the rest of the engine already carries.
 *
 * A body with no primary (the star) has no boundary within its own system, so
 * an infinite radius is the honest answer rather than a large magic number:
 * every comparison against it then falls out correctly without a special case.
 */
export function soiRadius(semiMajorAxis: number, mu: number, parentMu: number): number {
  if (!(parentMu > 0)) return Number.POSITIVE_INFINITY;
  if (!(semiMajorAxis > 0) || !(mu > 0)) return 0;
  return semiMajorAxis * Math.pow(mu / parentMu, 0.4);
}

// ---------------------------------------------------------------------------
// Flight assist
// ---------------------------------------------------------------------------

/**
 * Bottom of the FA lever's speed scale, km/s. The curve below is
 * `V0·((1 + vmax/V0)^t − 1)`: exactly 0 at t = 0, exactly vmax at t = 1, and
 * exponential in between. With vmax 60 km/s that puts ~50 m/s at 10% of the
 * lever (touchdown and docking speeds), ~1.7 km/s at mid-lever (low orbit) and
 * ~10 km/s at three quarters. A linear lever would spend its first 10% on
 * 0-6 km/s, which makes landing a matter of holding the key for 1/30 s.
 */
export const ASSIST_V0 = 0.05;

/**
 * Time constant of the speed hold, seconds: demanded acceleration is
 * (velocity error)/τ, then clipped to what the thrusters have. 0.5 s settles
 * the last 100 m/s in about a second without the hunting a shorter one shows
 * against a 120 Hz step, and outside that band the hull is simply saturated.
 */
const ASSIST_TAU = 0.5;

export type AssistState = 'off' | 'coast' | 'hold' | 'stop';

/** FA lever (0..1) → set speed, km/s. Pure; see `ASSIST_V0` for the shape. */
export function assistTargetSpeed(throttle: number, vmax: number): number {
  if (!(throttle > 0) || !(vmax > 0)) return 0; // NaN fails `> 0` too
  if (throttle >= 1) return vmax;
  return ASSIST_V0 * (Math.pow(1 + vmax / ASSIST_V0, throttle) - 1);
}

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
  // 100 m/s² — half the main drive. It was a quarter (50 m/s²), which made
  // flight assist take ~35 s to swing the velocity round after a 90° turn at
  // orbital speed. RCS is the only thing allowed to fix lateral drift (the
  // computer never steers the nose to do it), so its authority IS the
  // handling.
  rcsThrust: 2.0e7,
  // 200 m/s² — parity with the main drive (GAMEPLAY B4). It was 80 m/s², so
  // slowing down took 2.5× as long as speeding up and no assist could hide
  // that; with parity the FA lever feels the same in both directions.
  brakeThrust: 4.0e7,
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

/**
 * The one body whose gravity acts, and the frame the ship's state is stored in.
 *
 * `position` and `velocity` are WORLD quantities owned by the caller and held
 * by reference — mutate them in place as the body travels its own orbit and the
 * ship follows for free, which is the entire point of the parent-relative
 * model. Everything else the ship stores is measured against them.
 */
export interface ParentBody {
  /** World position, km. Mutated in place by whoever owns the body. */
  readonly position: Vector3;
  /** World velocity, km/s. Same ownership. */
  readonly velocity: Vector3;
  /** Standard gravitational parameter GM, km³/s². Earth is 398600. */
  readonly mu: number;
  /** Body radius, km. Optional; lets `altitude` work without a ground sampler. */
  readonly radius?: number;
}

/**
 * Terrain query for collision.
 *
 * Takes the ship's PARENT-RELATIVE position — the planet you are landing on is
 * the parent by construction, so the sampler never has to undo the body's
 * orbital motion, and a landing site cannot slide out from under the ship.
 *
 * Returns the ship's ALTITUDE ABOVE THE SURFACE in km, negative when
 * penetrating. NOT the surface radius: this was wired to
 * PlanetRenderer.surfaceRadius() once, which returns ~11,000, so the ship was
 * never in contact with anything and simply flew through the ground.
 */
export type GroundSampler = (parentRelativePos: Vector3) => number;

/**
 * Stand-in for "no parent": deep space, or a headless test with no world.
 * Having a zero object rather than a null branch keeps the hot path free of
 * `if (parent)` in every method that reads a frame.
 */
const NO_PARENT: ParentBody = {
  position: new Vector3(),
  velocity: new Vector3(),
  mu: 0,
};

export type ImpactKind = 'landing' | 'hard' | 'crash';

// ---------------------------------------------------------------------------

export class FlightModel {
  readonly config: ShipConfig;

  // --- authoritative rigid-body state -------------------------------------
  /**
   * Position RELATIVE TO THE PARENT, km. This is the canonical storage; the
   * world position is derived from it. Read freely; use `teleport()` to move
   * the ship and `rebase()` to change which body it is measured against.
   */
  readonly position = new Vector3();
  /** Velocity RELATIVE TO THE PARENT, km/s. Already the number the HUD wants. */
  readonly velocity = new Vector3();
  /** Hull orientation. The nose points along local -Z. */
  readonly orientation = new Quaternion();
  /** Angular velocity in BODY axes, rad/s. (x = pitch, y = yaw, z = roll.) */
  readonly angularVelocity = new Vector3();

  /**
   * `parent.position + position`, refreshed once per `update()`. Derived, never
   * integrated — the floating origin and anything that has to place the ship
   * against a body it is not orbiting read this. Writing to it does nothing.
   */
  readonly worldPosition = new Vector3();

  /**
   * Position/orientation extrapolated to the *display* time, i.e. including the
   * fraction of a substep left in the accumulator. Renderers and the camera rig
   * should read these; physics reads `position`/`orientation`. Without this the
   * ship visibly beats against the 120 Hz grid at unrelated frame rates.
   *
   * `renderPosition` is parent-relative like `position`; `renderWorldPosition`
   * is the same instant expressed in world coordinates, and is what the hull is
   * actually drawn at.
   */
  readonly renderPosition = new Vector3();
  readonly renderWorldPosition = new Vector3();
  readonly renderOrientation = new Quaternion();

  // --- derived frames, refreshed every substep ----------------------------
  /** Hull -Z in world space. */
  readonly forward = new Vector3(0, 0, -1);
  /** Hull +X in world space. */
  readonly right = new Vector3(1, 0, 0);
  /** Hull +Y in world space. */
  readonly up = new Vector3(0, 1, 0);
  /** Away from the parent; +Y with no parent. */
  readonly localUp = new Vector3(0, 1, 0);
  /** Gravitational acceleration acting on the ship, km/s². */
  readonly gravityAccel = new Vector3();

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
  private parentBody: ParentBody = NO_PARENT;
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
  private _verticalSpeed = 0;
  private _altitude = Number.POSITIVE_INFINITY;
  private _gForce = 0;
  private _throttle = 0;
  private _heading = 0;
  private _heating = 0;
  private _grounded = false;
  private _boosting = false;
  private _attitudeHold = true;
  private _fa = false;
  private _assistState: AssistState = 'off';
  private _assistTarget = 0;
  private lastEmittedThrottle = -1;

  /**
   * Speed ceiling imposed by the cruise drive, km/s, or null when sublight.
   *
   * Non-null replaces the whole force model: see `stepCruise`. A ship under
   * cruise is not on a trajectory, so gravity, drag and the sublight thrust
   * curve all stand down.
   */
  private cruiseCap: number | null = null;
  /** Scalar speed along the nose while cruising. The velocity vector follows it. */
  private cruiseSpeed = 0;

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

  /**
   * km/s relative to the parent — what the thrust limiter, the HUD and the
   * camera all mean by "speed". There is no world-speed readout because nothing
   * in the game has ever wanted one: parked in a stable orbit it reads ~53 km/s
   * against the star, which is a true number that answers no useful question.
   */
  get speed(): number {
    return this._speed;
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
   * Flight assist (FA). On, the lever is a set speed and the computer flies
   * it; off, the lever is thrust. Most of the game's character, so it
   * announces itself. Does not touch `attitudeHold`.
   */
  get flightAssist(): boolean {
    return this._fa;
  }
  set flightAssist(on: boolean) {
    if (on === this._fa) return;
    this._fa = on;
    if (!on) {
      this._assistState = 'off';
      this._assistTarget = 0;
    }
    bus.emit('log', {
      text: on ? 'FLIGHT ASSIST ENGAGED' : 'FLIGHT ASSIST OFF — NEWTONIAN',
      tone: on ? 'normal' : 'warn',
    });
  }

  /** Rotation damping. Off is vacuum: whatever rotation you started, you keep. */
  get attitudeHold(): boolean {
    return this._attitudeHold;
  }
  set attitudeHold(on: boolean) {
    this._attitudeHold = on;
  }

  /** What the FA computer did on the last substep — for the HUD. */
  get assistState(): AssistState {
    return this._assistState;
  }

  /** The speed FA is holding along the nose, km/s; 0 unless `assistState` is 'hold'. */
  get assistTargetKmS(): number {
    return this._assistTarget;
  }

  // -------------------------------------------------------------------------
  // World hooks
  // -------------------------------------------------------------------------

  /** The body the ship's state is measured against. `null` = deep space. */
  get parent(): ParentBody | null {
    return this.parentBody === NO_PARENT ? null : this.parentBody;
  }

  /**
   * Declare the parent WITHOUT converting the state vector.
   *
   * This reinterprets `position` and `velocity` as being relative to the new
   * body, which for any non-zero state is a teleport. It exists for exactly two
   * moments — system entry and warp arrival — where the state is about to be
   * overwritten by `teleport()` anyway, and `orbitalVelocityAt()` needs to know
   * the parent's `mu` first. During flight, use `rebase()`.
   */
  setParent(parent: ParentBody | null): void {
    this.parentBody = parent ?? NO_PARENT;
    this.altCache = 0;
    this.refreshDerived();
  }

  /**
   * Cross a sphere-of-influence boundary: re-express the ship's state relative
   * to a new parent, leaving its world motion untouched.
   *
   * THIS IS THE ONLY PLACE IN THE PROJECT WHERE FRAMES ARE CROSSED. The two
   * lines below are the whole of the patched-conic model's cost, and the reason
   * the rest of the game never has to think about a planet's 49 km/s. If you
   * find yourself writing `+ body.velocity` anywhere else, you are re-opening
   * the bug this design closed.
   */
  rebase(parent: ParentBody | null): void {
    const from = this.parentBody;
    const to = parent ?? NO_PARENT;
    if (from === to) return;

    this.position.add(from.position).sub(to.position);
    this.velocity.add(from.velocity).sub(to.velocity);

    this.parentBody = to;
    this.altCache = 0; // a new parent means a new surface, if any
    this.renderPosition.copy(this.position);
    this.refreshDerived();

    // Readouts are cached during update(), and a transition happens after it.
    // Without this the HUD shows the OLD frame's speed for one frame — which on
    // a boundary crossing is a 49 km/s jump in a number that did not change.
    this._speed = this.velocity.length();
    this.computeLocalUp();
    this._verticalSpeed = this.velocity.dot(this.localUp);
  }

  /** Local atmospheric density at the ship, kg/m³. 0 = vacuum. */
  setAtmosphere(densityAtShip: number): void {
    this.density = densityAtShip > 0 ? densityAtShip : 0;
  }

  /**
   * Hand the flight model a cruise ceiling, km/s, or `null` to fly sublight.
   *
   * Entering seeds the scalar speed from the current velocity so the drive
   * picks the ship up rather than snatching it. Leaving keeps the velocity
   * vector exactly as it is — by then the drive has already bled the ceiling
   * down to sublight, so what the orbital machinery inherits is a normal state
   * vector pointing where the nose points.
   */
  setCruise(capKmS: number | null): void {
    if (capKmS === null) {
      this.cruiseCap = null;
      return;
    }
    if (this.cruiseCap === null) this.cruiseSpeed = this.velocity.length();
    this.cruiseCap = Math.max(0, capKmS);
  }

  /** True while the cruise drive is carrying the ship. */
  get cruising(): boolean {
    return this.cruiseCap !== null;
  }

  /** Local atmospheric density last handed in, kg/m³. 0 = vacuum. */
  get atmosphericDensity(): number {
    return this.density;
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
   * Velocity of a circular orbit at parent-relative `pos`, in the parent's
   * frame — so it is the velocity to hand straight to `teleport()`, with no
   * composition of the parent's own motion. That composition is what used to be
   * required here and is what this whole change deletes.
   *
   * The direction is the one that keeps the orbit closest to the world XZ
   * plane, which is where systems are generated, so spawning is predictable.
   * Not called from `update()` — allocating a default `out` is fine here.
   */
  orbitalVelocityAt(pos: Vector3, out = new Vector3()): Vector3 {
    const mu = this.parentBody.mu;
    const r = pos.length();
    if (mu <= 0 || r < 1e-6) return out.set(0, 0, 0);

    // Any unit vector perpendicular to r works; pick the one nearest prograde
    // in the ecliptic by crossing with world up, with a fallback for poles.
    this.sTmp2.set(0, 1, 0);
    out.crossVectors(this.sTmp2, pos);
    if (out.lengthSq() < 1e-12) {
      this.sTmp2.set(1, 0, 0);
      out.crossVectors(this.sTmp2, pos);
    }
    return out.normalize().multiplyScalar(Math.sqrt(mu / r));
  }

  /**
   * Place the ship. Used at spawn and on warp arrival; never during flight.
   * Both arguments are PARENT-RELATIVE — set the parent first.
   */
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
    this.refreshDerived();
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
    this.refreshDerived();
    this.updateReadouts();
  }

  // -------------------------------------------------------------------------

  private step(h: number): void {
    const c = this.config;
    this.refreshBodyAxes();

    if (this.cruiseCap !== null) {
      this.stepCruise(h);
      return;
    }

    this._boosting = this.command.boost;

    // --- flight assist mode -------------------------------------------------
    // Decided before anything moves, so a coasting ship runs the Newtonian
    // path below line for line and is bit-identical to FA-OFF.
    let active = false;
    if (this._fa) {
      if (this.command.brake) this._assistState = 'stop';
      else if (this.command.throttle > 0) this._assistState = 'hold';
      else this._assistState = 'coast'; // the detent, and NaN
      active = this._assistState !== 'coast';
    }

    // --- throttle spool -----------------------------------------------------
    // Under an active assist `_throttle` is instead the engine output the
    // computer chose, written in `stepAssist`.
    // In the coast detent the computer cuts the drive outright: the spool would
    // otherwise keep pushing whatever output the hold last chose for ~1 s
    // (up to ~0.14 km/s along the nose) after the pilot asked for no thrust.
    if (this._fa && !active) this._throttle = 0;
    else if (!active) {
      this._throttle = damp(this._throttle, clamp01(this.command.throttle), c.throttleSpoolTime, h);
    }

    // --- gravity ------------------------------------------------------------
    // One source: the parent. Not a sum. That is the patched-conic
    // approximation, and it is a feature — it is what makes an orbit *stay* an
    // orbit over hours of play instead of slowly eating a third body's error.
    this.parentGravity(this.sGrav);
    this.gravityAccel.copy(this.sGrav);

    // --- non-gravitational forces ------------------------------------------
    this.sAcc.set(0, 0, 0);
    // `velocity` is already relative to the parent, so this is the speed the
    // limiter, the drag term and the brake all want, with nothing to subtract.
    const speed = this.velocity.length();

    // Thrust fades as the ceiling approaches. Never clamp the velocity: the
    // whole point is that you feel the engine give up, not the world stop you.
    const boostMul = this._boosting ? c.boostMultiplier : 1;
    const vmax = c.topSpeed * boostMul;
    const limiter = clamp01(1 - Math.pow(Math.min(speed / vmax, 1), c.speedFalloffExponent));

    if (active) {
      this.stepAssist(vmax, boostMul, limiter);
    } else {
      if (this._fa) this._assistTarget = 0;

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

  /**
   * The FA computer, 'hold' or 'stop'. Writes thrust into `sAcc`; gravity is
   * added by the caller as for any other thrust.
   *
   * It flies the hull, it does not move it: the demanded acceleration is
   * resolved into body axes and each axis is clipped to the one actuator that
   * can push that way — main drive forward only (and through the same speed
   * limiter as the pilot's throttle), retro backward only, RCS laterally. It
   * never turns the nose to help; a ship drifting sideways is corrected by RCS
   * alone, so a big turn at speed takes the time a real hull would take.
   *
   * Gravity is cancelled in the demand, which is what makes 'stop' a hover and
   * 'hold' a straight line near a body. Not on the ground, where the gear
   * already carries the weight and cancelling it would float the ship off.
   *
   * No engine spool here: the spool models the lag between the pilot's lever
   * and the drive, and a controller wrapped round a 0.7 s lag overshoots.
   * The computer throttles the drive directly, and the readout says so.
   */
  private stepAssist(vmax: number, boostMul: number, limiter: number): void {
    const cmd = this.command;
    const v = this.velocity;

    const vset = this._assistState === 'hold' ? assistTargetSpeed(cmd.throttle, vmax) : 0;
    this._assistTarget = vset;

    // a_des = (nose·vset − v)/τ − g, in sTmp.
    const d = this.sTmp.copy(this.forward).multiplyScalar(vset).sub(v);
    d.multiplyScalar(1 / ASSIST_TAU);
    if (!this._grounded) d.sub(this.sGrav);

    const f = d.dot(this.forward);
    const mainCap = this.mainAccel * boostMul;
    const main = f > 0 ? Math.min(f, mainCap * limiter) : 0;
    const retro = f < 0 ? Math.min(-f, this.brakeAccel) : 0;

    // The pilot's strafe wins on its own axis: the computer must not fight
    // the stick, or strafing under FA would be impossible.
    const rcs = this.rcsAccel;
    const rx = cmd.strafeX !== 0 ? cmd.strafeX * rcs : clampAbs(d.dot(this.right), rcs);
    const uy = cmd.strafeY !== 0 ? cmd.strafeY * rcs : clampAbs(d.dot(this.up), rcs);

    this.sAcc.addScaledVector(this.forward, main - retro);
    this.sAcc.addScaledVector(this.right, rx);
    this.sAcc.addScaledVector(this.up, uy);

    // The readout is what the main drive is actually doing, not the lever:
    // holding a speed in vacuum reads idle, which is the truth.
    this._throttle = mainCap > 0 ? main / mainCap : 0;
  }

  /**
   * One substep under the cruise drive.
   *
   * Deliberately not the sublight force model with a bigger number in it. Under
   * cruise the ship is *carried*, not accelerated: velocity is the nose times a
   * scalar, gravity is suspended, and there is no drag because the drive only
   * runs in vacuum. That is what makes the trip steerable — a 10^6 km/s state
   * vector being bent by thrust would answer the controls in geological time.
   *
   * The one line that must not be softened is the hard clamp to the ceiling.
   * The ceiling falls as the ship closes on a body, and it is that fall which
   * keeps the step below a fraction of the clearance. Easing towards it instead
   * would let the speed lag the ceiling on approach, which is precisely how a
   * ship ends up inside a planet.
   */
  private stepCruise(h: number): void {
    const c = this.config;
    const cap = this.cruiseCap ?? 0;

    this._boosting = false;
    this._throttle = damp(this._throttle, clamp01(this.command.throttle), c.throttleSpoolTime, h);

    // Throttle chooses a fraction of the ceiling, so the pilot can coast in
    // slowly rather than being pinned at the maximum the gap allows.
    const target = cap * clamp01(this.command.throttle);
    this.cruiseSpeed = damp(this.cruiseSpeed, target, CRUISE_RESPONSE, h);
    if (this.command.brake) this.cruiseSpeed = damp(this.cruiseSpeed, 0, CRUISE_BRAKE, h);
    // Hard, unsmoothed, every step. See the note above.
    this.cruiseSpeed = Math.min(this.cruiseSpeed, cap);

    this.velocity.copy(this.forward).multiplyScalar(this.cruiseSpeed);
    this.position.addScaledVector(this.velocity, h);

    // No proper acceleration to report: the drive does not push the crew.
    this.gravityAccel.set(0, 0, 0);
    this._gForce = damp(this._gForce, 0, 0.15, h);
    this.density = 0;
    this._heating = damp(this._heating, 0, 0.4, h);

    // Zero speed into the rotation step: its only speed term is the aero one,
    // which is already gated on density, and handing it 10^7 invites a term
    // nobody has thought about to wake up.
    this.stepRotation(h, 0);
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

    if (this._attitudeHold) {
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

  /** a = -mu/r² · r̂, with r the parent-relative position. */
  private parentGravity(out: Vector3): void {
    const mu = this.parentBody.mu;
    const r2 = this.position.lengthSq();
    if (mu <= 0 || r2 < 1e-9) {
      out.set(0, 0, 0);
      return;
    }
    out.copy(this.position).multiplyScalar(-(mu / r2) / Math.sqrt(r2));
  }

  private computeLocalUp(): void {
    if (this.parentBody.mu <= 0) {
      this.localUp.set(0, 1, 0);
      return;
    }
    const len = this.position.length();
    if (len < 1e-9) this.localUp.set(0, 1, 0);
    else this.localUp.copy(this.position).multiplyScalar(1 / len);
  }

  /**
   * `world = parent.world + position`. The single derivation of the world
   * frame, kept next to nothing else so it stays obviously cheap and obviously
   * one-directional — nothing ever writes back into it.
   */
  private refreshDerived(): void {
    this.worldPosition.addVectors(this.parentBody.position, this.position);
    this.renderWorldPosition.addVectors(this.parentBody.position, this.renderPosition);
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
    this.computeLocalUp();
    this._verticalSpeed = this.velocity.dot(this.localUp);

    // One authoritative terrain sample per *frame* for the altimeter — the
    // substep gate above uses a conservative bound, which would make a level
    // cruise read as a slow descent if the HUD trusted it.
    if (this.groundSampler) {
      this._altitude = this.groundSampler(this.position);
      this.altCache = this._altitude;
    } else {
      const radius = this.parentBody.radius;
      this._altitude =
        radius !== undefined ? this.position.length() - radius : Number.POSITIVE_INFINITY;
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
    this.parentBody = NO_PARENT;
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

function clampAbs(v: number, limit: number): number {
  return v < -limit ? -limit : v > limit ? limit : v;
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
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu, radius: 1 });
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

  // --- 4. attitude hold on/off ---------------------------------------------
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
    fm2.attitudeHold = false;
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
      fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 10, radius: groundY });
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
