/**
 * The camera rig.
 *
 * The single most important feel system in the game. The ship is 30 metres of
 * metal moving through a void with no reference points; the *only* thing that
 * communicates its mass is how the camera fails to keep up with it.
 *
 * Three principles hold the whole file together:
 *
 *  1. NOTHING IS RIGID. Every visible quantity — position, orientation, field
 *     of view, head angle — is a second-order damped system chasing a target.
 *     The targets snap; the outputs never do.
 *
 *  2. POSITION AND ORIENTATION ARE DECOUPLED. They run separate springs at
 *     different frequencies. A camera whose aim is welded to its position is a
 *     selfie stick; a camera whose aim trails its position is a drone with a
 *     gimbal, and that is what a chase cam should read as.
 *
 *  3. LAG COMES FROM ACCELERATION, NOT VELOCITY. The chase spring is solved in
 *     the *anchor's* reference frame, so cruising at constant speed produces no
 *     trailing at all, while a hard burn visibly shoves the ship away from the
 *     lens and the camera then hauls itself back in. See `stepChase()`.
 *
 * UNITS: kilometres and seconds throughout. A ship is 0.03 km long, so the
 * offsets in here look absurdly small — they are metres expressed in km.
 *
 * ALLOCATION: `update()` allocates nothing. Every vector, quaternion, matrix
 * and euler it touches is a preallocated field.
 */

import { Euler, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';

import type { EngineContext } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { registerShot } from '@/game/Shots';
import { composeLandedFrame, LANDED_CLEARANCE, type LandedFramingInput } from '@/ship/landedFraming';
// [v3-T1]
import {
  blendSeconds,
  chaseLagOffset,
  constrainAimToFrame,
  limitAnchorVelocity,
  lowPassVec,
  sphericalLerp,
} from '@/ship/cameraMath';
import { shakeNoise } from '@/ship/cameraShake';
import { fovPolicy, type FovInput } from '@/ship/fovPolicy';

export type CameraMode = 'cockpit' | 'chase' | 'cinematic' | 'orbit';

/** The order `cycleMode()` walks. Chase first: it is the default flight view. */
const MODE_ORDER: readonly CameraMode[] = ['chase', 'cockpit', 'orbit', 'cinematic'];

/**
 * Radians the chase aim may deviate from the nose towards the velocity. ~3 deg.
 * [v3-T1] Was 0.19 (~11 deg): in orbit the velocity sits 30 deg above a nose
 * pitched at the world, and the deviation lifted the view off the planet —
 * the opening frame only held the limb because the fov was 78 deg.
 */
const MAX_VELOCITY_AIM_ANGLE = 0.05;

/**
 * Floor on the orbit camera's elevation while a local vertical is known, in
 * radians. ~17 degrees: enough that the lens clears the ship and the ground it
 * is standing on, shallow enough that the sky still occupies most of the frame.
 */
const ORBIT_MIN_SURFACE_ELEVATION = 0.30;

const TWO_PI = Math.PI * 2;
const EPS = 1e-4;

/**
 * What the landed frame needs from the world, supplied by whoever knows it
 * (game/Pilot.ts). Read every frame; the rig keeps no copies.
 */
export interface LandedFrameSource {
  /** Unit direction to the star, render/world axes. */
  readonly sunDir: Vector3;
  /** 0 airless .. 1 full sky (see ship/landedFraming.ts). */
  readonly skyWeight: number;
  /**
   * Height of the terrain at `offset` from the hull (km, render axes) above the
   * ground the hull stands on, km. Positive where the ground rises.
   */
  groundRiseAt(offset: Vector3): number;
}

// ---------------------------------------------------------------------------
// Damped spring
// ---------------------------------------------------------------------------

/**
 * Coefficients for an exact analytic step of `x'' = -w^2 x - 2 z w x'`.
 *
 * Solved in closed form rather than integrated numerically, for two reasons:
 * the result is frame-rate independent (a 30 fps machine and a 240 fps machine
 * produce the same motion, which matters because screenshots must reproduce),
 * and it cannot explode at low frame rates the way the naive
 * `v += (target - x) * k * dt` everyone writes first does.
 */
class SpringCoefficients {
  /** newPos = target + pp * (pos - target) + pv * vel */
  pp = 1;
  pv = 0;
  /** newVel = vp * (pos - target) + vv * vel */
  vp = 0;
  vv = 1;

  /** Scratch outputs for the scalar variant — avoids returning a tuple. */
  outPos = 0;
  outVel = 0;

  compute(dt: number, frequencyHz: number, zeta: number): void {
    if (dt <= 0 || frequencyHz <= 0) {
      this.pp = 1;
      this.pv = 0;
      this.vp = 0;
      this.vv = 1;
      return;
    }
    const w = TWO_PI * frequencyHz;

    if (zeta > 1 + EPS) {
      // Over-damped: two distinct real roots, no overshoot, sluggish tail.
      const za = -w * zeta;
      const zb = w * Math.sqrt(zeta * zeta - 1);
      const z1 = za - zb;
      const z2 = za + zb;
      const e1 = Math.exp(z1 * dt);
      const e2 = Math.exp(z2 * dt);
      const inv = 1 / (z2 - z1);
      this.pp = (z2 * e1 - z1 * e2) * inv;
      this.pv = (e2 - e1) * inv;
      this.vp = z1 * z2 * (e1 - e2) * inv;
      this.vv = (z2 * e2 - z1 * e1) * inv;
    } else if (zeta < 1 - EPS) {
      // Under-damped: a single soft overshoot. Used sparingly — a cockpit that
      // rings once after a hard turn reads as a body being thrown about.
      const wd = w * Math.sqrt(1 - zeta * zeta);
      const e = Math.exp(-zeta * w * dt);
      const c = Math.cos(wd * dt);
      const s = Math.sin(wd * dt);
      this.pp = e * (c + ((zeta * w) / wd) * s);
      this.pv = e * (s / wd);
      this.vp = -zeta * w * this.pp + e * (-wd * s + zeta * w * c);
      this.vv = -zeta * w * this.pv + e * c;
    } else {
      // Critically damped: fastest approach with zero overshoot. The default.
      const e = Math.exp(-w * dt);
      this.pp = e * (1 + w * dt);
      this.pv = e * dt;
      this.vp = -e * w * w * dt;
      this.vv = e * (1 - w * dt);
    }
  }

  step(pos: Vector3, vel: Vector3, target: Vector3): void {
    let x = pos.x - target.x;
    let v = vel.x;
    pos.x = target.x + this.pp * x + this.pv * v;
    vel.x = this.vp * x + this.vv * v;

    x = pos.y - target.y;
    v = vel.y;
    pos.y = target.y + this.pp * x + this.pv * v;
    vel.y = this.vp * x + this.vv * v;

    x = pos.z - target.z;
    v = vel.z;
    pos.z = target.z + this.pp * x + this.pv * v;
    vel.z = this.vp * x + this.vv * v;
  }

  /** Same step with the target pinned at the origin. */
  stepToZero(pos: Vector3, vel: Vector3): void {
    const px = pos.x;
    const py = pos.y;
    const pz = pos.z;
    const vx = vel.x;
    const vy = vel.y;
    const vz = vel.z;
    pos.set(this.pp * px + this.pv * vx, this.pp * py + this.pv * vy, this.pp * pz + this.pv * vz);
    vel.set(this.vp * px + this.vv * vx, this.vp * py + this.vv * vy, this.vp * pz + this.vv * vz);
  }

  stepScalar(pos: number, vel: number, target: number): void {
    const x = pos - target;
    this.outPos = target + this.pp * x + this.pv * vel;
    this.outVel = this.vp * x + this.vv * vel;
  }
}

// ---------------------------------------------------------------------------
// Pose
// ---------------------------------------------------------------------------

/** A complete camera state. Each mode fills one; the rig blends between them. */
class Pose {
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  fov = 62;

  copy(other: Pose): void {
    this.position.copy(other.position);
    this.quaternion.copy(other.quaternion);
    this.fov = other.fov;
  }

  lerpFrom(a: Pose, b: Pose, t: number): void {
    this.position.lerpVectors(a.position, b.position, t);
    this.quaternion.slerpQuaternions(a.quaternion, b.quaternion, t);
    this.fov = a.fov + (b.fov - a.fov) * t;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 6t^5-15t^4+10t^3 — zero first *and* second derivative at both ends. */
function smootherstep(t: number): number {
  const c = clamp(t, 0, 1);
  return c * c * c * (c * (c * 6 - 15) + 10);
}

// ---------------------------------------------------------------------------
// CameraRig
// ---------------------------------------------------------------------------

export class CameraRig {
  // --- tuning: chase -------------------------------------------------------

  /**
   * Natural frequency of the chase position spring, Hz. Lower = heavier, more
   * lag under burn, slower recovery. Steady-state trailing distance under a
   * constant acceleration A is A / (2*pi*f)^2, so at 1.05 Hz a 0.3 km/s^2 burn
   * pushes the ship ~7 m away from the lens. That is the number to tune.
   */
  chaseFrequency = 1.05;

  /** Damping ratio of the chase position spring. 1 = critical, no overshoot. */
  chaseDamping = 1.0;

  /**
   * [v3-T1] Natural frequency of the aim spring, Hz. v2 ran it at 0.44 Hz with
   * no feed-forward, so the aim lagged ~33 deg in a full turn and the ship left
   * 45 % of the screen height. The spring now follows the hull's turn rate
   * (feed-forward) and only smooths what is left.
   */
  chaseAimFrequency = 0.7;

  /** Damping ratio of the aim spring. Critical: aim never rings. */
  chaseOrientationDamping = 1.0;

  /** How slowly camera roll follows hull roll. Slowest system in the rig. */
  chaseRollLagRatio = 0.26;

  /**
   * Follow offset in ship-local space, km. +Z is behind (three.js looks -Z).
   * [v3-T1] 2 m higher than v2: at the narrower D0 fov the hull sits in the
   * lower third with the world below it in the opening frame.
   */
  readonly chaseOffset = new Vector3(0, 0.0105, 0.052);

  /**
   * [v3-T1] Soft ceiling on the trail from proper acceleration, km (tanh, so
   * there is no knee to toggle across). Replaces v2's hard 45 m clamp.
   */
  chaseLagMax = 0.016;
  /** [v3-T1] Low-pass on the proper acceleration that drives the trail, s. */
  chaseAccelTau = 0.15;
  /** [v3-T1] Soft ceiling on the rotational trail of the follower spring, km. */
  chaseSwingMax = 0.012;
  /**
   * [v3-T1] Largest change of the anchor's (ship-relative) velocity that is
   * motion, km/s². A full-rate pitch onset is ~0.13; an attitude snap is ~100.
   */
  chaseAnchorAccelMax = 1.5;
  /**
   * [v3-T1] Hull turn rate beyond which a change of attitude is a snap, rad/s.
   * Above any flown rate: the autopilot at auto-10× turns the hull ~4 rad/s
   * of REAL time (measured), and treating that as snaps re-seated every
   * frame. A one-frame 30 deg snap at 60 fps is 31 rad/s.
   */
  attitudeSnapRate = 8;
  /** [v3-T1] Blend length of an automatic reseat, s. */
  reseatSeconds = 0.5;
  /** [v3-T1] Keep the hull inside this fraction of the half-frame (soft from 2/3 of it). */
  chaseFrameMargin = 0.6;
  /** [v3-T1] Extra pitch of the aim, radians; + looks up (the hull sinks in frame). */
  chaseAimPitchBias = 0.02;

  /** How far ahead of the ship the camera aims, km. Puts the nose low in frame. */
  chaseLookAhead = 0.28;

  /**
   * At speed the aim eases from the nose vector towards the velocity vector, so
   * a ship flying sideways *looks* like it is flying sideways. 0 disables.
   */
  velocityAlign = 0.55;

  // --- tuning: cockpit -----------------------------------------------------

  /** Eye position in ship-local space, km (6 m forward of centre, 4 m up). */
  readonly cockpitOffset = new Vector3(0, 0.0042, -0.0065);

  /** Metres of viewpoint travel per km/s^2 of acceleration (as km per km/s^2). */
  cockpitAccelGain = 0.0016;

  /** Clamp on that nudge, km. 0.4 m — enough to feel, too small to notice. */
  cockpitMaxNudge = 0.0004;

  cockpitFrequency = 2.1;

  /** Under-damped on purpose: the pilot's body rings once after a hard turn. */
  cockpitDamping = 0.72;

  /** Amplitude of the idle breathing bob, km. 4 cm. */
  cockpitBreathAmplitude = 0.00004;

  // --- tuning: head look ---------------------------------------------------

  /** Hold any of these to look around independently of heading. */
  headLookKeys: string[] = ['AltLeft', 'AltRight'];
  headLookSpeed = 2.4;
  headYawLimit = 1.9;
  headPitchLimit = 0.95;
  headLookFrequency = 1.6;
  headReturnFrequency = 0.9;

  // --- tuning: cinematic ---------------------------------------------------

  /** Radians per second of orbit. 0.055 → one revolution every ~114 s. */
  cinematicRate = 0.055;
  cinematicElevation = 0.24;
  /** Orbit radius as a multiple of the subject's radius. */
  cinematicDistanceScale = 4.5;
  /** Long lens: compression is most of what makes a shot read as cinematic. */
  cinematicFov = 40;
  /** Subject offset from frame centre, radians. Lower-left third. */
  cinematicComposeYaw = -0.105;
  cinematicComposePitch = 0.052;

  // --- tuning: orbit -------------------------------------------------------

  orbitFrequency = 1.3;
  orbitDamping = 1.0;
  orbitInputSpeed = 1.5;
  orbitFov = 50;

  // --- tuning: landed ------------------------------------------------------

  /**
   * Natural frequency of the landed eye, Hz. Slow on purpose: on touchdown the
   * camera walks from the chase position round to the composed frame over
   * about five seconds (peak pan ~65 deg/s, measured), which reads as the
   * reveal it is, and the drift inside the composition is felt rather than
   * seen.
   */
  landedFrequency = 0.22;
  /** The aim settles a touch faster than the eye, so the move leads with the look. */
  landedLookFrequency = 0.28;
  /** Slightly wider than the orbit view: this is a landscape, not an inspection. */
  landedFov = 52;
  /** Limit on the pilot's pitch on top of the composition, radians. */
  landedPitchLimit = 0.35;

  // --- tuning: fov (D0, ship/fovPolicy.ts) -------------------------------

  /**
   * Speed at which the velocity-aim blend is ~63 % in. [v3-T1] Speed no
   * longer touches the fov — that breathes from thrust and cruise only.
   */
  speedReference = 1.2;
  /** Approximate settle time of the fov ease, seconds. */
  fovEaseSeconds = 0.8;

  // --- tuning: shake -------------------------------------------------------

  /** Peak translational shake at trauma 1, km. 12 cm. */
  shakeTranslation = 0.00012;
  /** Peak rotational shake at trauma 1, radians (~1.2 degrees). */
  shakeRotation = 0.021;
  /** Roll shake is deliberately larger — it is what sells a hull under load. */
  shakeRollScale = 1.6;
  /** Ceiling on the continuous component so thrust never masks a real impact. */
  shakeThrustCeiling = 0.3;

  // --- tuning: transitions -------------------------------------------------

  /** Mode cross-fade duration, seconds. Never cut. */
  transitionSeconds = 0.6;
  /** [v3-T1] Liftoff (landed → flight view): at least this long... */
  liftoffMinSeconds = 1.5;
  /** [v3-T1] ...and never turning faster than this, rad/s. v2: 512 deg/s. */
  liftoffMaxTurnRate = Math.PI / 2;

  /** When true the rig consumes the `toggleCamera` action itself. */
  handleToggleKey = true;

  // --- state ---------------------------------------------------------------

  private mode_: CameraMode = 'chase';
  private blendFrom: CameraMode = 'chase';
  private blendT = 1;

  private initialised = false;
  private time = 0;
  /** Separate, resettable clock so cinematic framing reproduces in screenshots. */
  private cinematicTime = 0;

  private readonly initialFov: number;

  // chase state — [v3-T1] SHIP-RELATIVE (world axes, origin at the hull).
  // Nothing the ship's position does — lost time, a cruise drop, a rebase,
  // 15,000 km/s — can reach the chase; only the hull's attitude and its proper
  // acceleration move the lens.
  /** The follow offset rotated into world axes. */
  private readonly anchorRel = new Vector3();
  private readonly anchorRelPrev = new Vector3();
  /** Its velocity, limited (limitAnchorVelocity). */
  private readonly anchorRelVel = new Vector3();
  /** Spring deviation of the lens from the anchor, and its velocity. */
  private readonly chaseR = new Vector3();
  private readonly chaseRelVel = new Vector3();
  /** Trail from filtered proper acceleration. */
  private readonly lagOff = new Vector3();
  /** Lens position relative to the hull this frame. */
  private readonly camRel = new Vector3();
  private readonly anchorLimit = { vel: new Vector3(), teleport: new Vector3(), jumped: false };
  /** Hull turn rate, world axes, rad/s (finite difference of attitude). */
  private readonly omega = new Vector3();
  private readonly qPrev = new Quaternion();
  private readonly chaseAim = new Vector3(0, 0, -1);
  private readonly chaseAimVel = new Vector3();
  private readonly chaseUp = new Vector3(0, 1, 0);
  private readonly chaseUpVel = new Vector3();

  // cockpit state (ship-local)
  private readonly cockpitNudge = new Vector3();
  private readonly cockpitNudgeVel = new Vector3();
  private headYaw = 0;
  private headYawVel = 0;
  private headPitch = 0;
  private headPitchVel = 0;
  private headLookActive_ = false;

  // orbit state
  private readonly orbitTarget = new Vector3();
  private orbitTargetSet = false;
  private orbitAzimuth = 0;
  private orbitAzimuthCur = 0;
  private orbitAzimuthVel = 0;
  private orbitElevation = 0.35;
  private orbitElevationCur = 0.35;
  private orbitElevationVel = 0;
  private orbitDistance = 1;
  private orbitDistanceCur = 1;
  private orbitDistanceVel = 0;

  // landed state (see stepLanded). Eye kept in cylindrical coordinates about
  // the hull so the reveal swings round it instead of cutting through it.
  private landedSource: LandedFrameSource | null = null;
  /** The source being released, kept for one transition (setLandedFrame). */
  private landedHold: LandedFrameSource | null = null;
  private landedReleaseT = 1;
  private readonly poseRelease = new Pose();
  private landedSeeded = false;
  private landedTime = 0;
  private landedYaw = 0;
  private landedPitch = 0;
  private landedAz = 0;
  private landedAzVel = 0;
  private landedR = 0;
  private landedRVel = 0;
  private landedH = 0;
  private landedHVel = 0;
  private readonly landedLook = new Vector3(0, 0, -1);
  private readonly landedLookVel = new Vector3();
  private readonly landedTarget = new Vector3();
  private readonly landedRef = new Vector3();
  private readonly landedSide = new Vector3();
  private readonly landedIn: {
    -readonly [K in keyof LandedFramingInput]: LandedFramingInput[K];
  } = {
    up: new Vector3(0, 1, 0),
    sunDir: new Vector3(1, 0, 0),
    shipForward: new Vector3(0, 0, -1),
    skyWeight: 0,
    time: 0,
    yaw: 0,
    pitch: 0,
    groundRise: 0,
    halfFovY: 0.45,
  };
  private readonly landedOut = { offset: new Vector3(), look: new Vector3(0, 0, -1) };

  // cinematic state
  private readonly cinematicSubject = new Vector3();
  private cinematicSubjectSet = false;
  private cinematicRadius = 0.03;

  // derived per-frame values
  private speedEase = 0;

  // [v3-T1] motion inputs (setMotion) and what is derived from them
  private readonly motionAccel = new Vector3();
  private thrustFrac = 0;
  private cruiseSpool = 0;
  /** Proper acceleration, low-passed (chaseAccelTau). */
  private readonly accelF = new Vector3();
  private fovChase = 57;
  private fovCockpit = 57;
  private fovSeeded = false;
  private readonly fovIn: { -readonly [K in keyof FovInput]: FovInput[K] } = {
    aspect: 16 / 9,
    thrustFrac: 0,
    cruiseSpool: 0,
    mode: 'chase',
  };
  /** Smoothed frame rate, for band-limiting the shake. */
  private frameHz = 60;

  // [v3-T1] blended reseat
  private reseatT = 1;
  private reseatDur = 0.5;
  private reseatPending = -1;
  private readonly reseatRel = new Vector3();
  private readonly reseatQuat = new Quaternion();
  /** Last frame's output before shake, relative to the hull. */
  private readonly lastOutRel = new Vector3();
  private readonly lastOutQuat = new Quaternion();
  private lastOutSet = false;
  private readonly lastShipPos = new Vector3();
  private snapAim = false;

  // [v3-T1] mode blend length and liftoff turn clamp
  private blendDur = 0.6;
  private landedReleaseSeconds = 0.6;
  private turnClamp = false;

  // shake
  private impulseTrauma = 0;
  private impulseDecay = 1;
  private thrustTrauma = 0;

  // floating-origin tracking
  private readonly lastOriginOffset = new Vector3();
  private originTracked = false;

  // poses
  private readonly poseChase = new Pose();
  private readonly poseCockpit = new Pose();
  private readonly poseCinematic = new Pose();
  private readonly poseOrbit = new Pose();
  private readonly poseOut = new Pose();

  // scratch — never escapes update()
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpC = new Vector3();
  private readonly tmpD = new Vector3();
  /** Reserved for lookRotation alone, so callers may pass any other scratch. */
  private readonly tmpLook = new Vector3();
  private readonly tmpQ = new Quaternion();
  private readonly tmpQ2 = new Quaternion();
  private readonly tmpM = new Matrix4();
  private readonly tmpE = new Euler();
  private readonly spring = new SpringCoefficients();
  private readonly spring2 = new SpringCoefficients();

  private readonly offBus: Array<() => void> = [];

  constructor(readonly camera: PerspectiveCamera) {
    this.initialFov = camera.fov;
    this.poseOut.fov = camera.fov;

    // Anything that hits the hull asks for shake over the bus rather than
    // reaching in here, so impacts, warp and landing stay decoupled from us.
    this.offBus.push(
      bus.on('camera:shake', ({ intensity, duration }) => this.shake(intensity, duration)),
    );
  }

  get mode(): CameraMode {
    return this.mode_;
  }

  /** True while the pilot is looking around; the flight model should not steer. */
  get headLookActive(): boolean {
    return this.headLookActive_;
  }

  /** 0..1 through the current mode cross-fade. 1 = settled. */
  get transitionProgress(): number {
    return this.blendT;
  }

  // --- public API ----------------------------------------------------------

  /**
   * @param immediate skip the cross-fade. Only the screenshot harness should
   *        pass true — in game a cut is always wrong.
   */
  /**
   * The direction the camera should call "up", in render space.
   *
   * The rig only ever sees a position and an orientation, so it cannot know
   * which way is up on a world — and levelling against world Y gives a
   * diagonal horizon on any planet whose vertical points somewhere else, while
   * levelling against the SHIP gives a diagonal horizon whenever the hull is
   * sitting at an angle, which a landed hull generally is. The integrator
   * knows the local vertical; it tells us. Pass null in open space.
   */
  setReferenceUp(up: Vector3 | null): void {
    if (up) {
      this.referenceUp.copy(up);
      this.hasReferenceUp = true;
    } else {
      this.hasReferenceUp = false;
    }
  }

  private readonly referenceUp = new Vector3(0, 1, 0);
  private hasReferenceUp = false;

  setMode(mode: CameraMode, immediate = false): void {
    if (mode === this.mode_ && this.blendT >= 1) return;

    if (immediate) {
      this.blendFrom = mode;
      this.blendT = 1;
      this.impulseTrauma = 0;
      this.thrustTrauma = 0;
    } else if (this.blendT < 1 && mode === this.blendFrom) {
      // Interrupted mid-fade and asked to go back where we came from: reverse
      // the fade instead of restarting it, so a fast double-tap cannot pop.
      this.blendFrom = this.mode_;
      this.blendT = 1 - this.blendT;
    } else {
      this.blendFrom = this.mode_;
      this.blendT = 0;
      this.blendDur = this.transitionSeconds;
      // [v3-T1] Liftoff: leaving a composed landed frame for a flight view. The
      // two poses can be 180 deg apart round the hull; a 0.6 s fade turned at
      // 512 deg/s. Long enough to stay under liftoffMaxTurnRate, measured on
      // last frame's poses (both are hull-relative, so they are current).
      if (this.landedHold && this.landedReleaseT === 0 && mode !== 'orbit' && this.initialised) {
        const a = this.poseFor(this.blendFrom);
        const b = this.poseFor(mode);
        const turn = a.quaternion.angleTo(b.quaternion);
        const swing = this.tmpA
          .copy(a.position)
          .sub(this.lastShipPos)
          .angleTo(this.tmpB.copy(b.position).sub(this.lastShipPos));
        this.blendDur = blendSeconds(Math.max(turn, swing), this.liftoffMinSeconds, this.liftoffMaxTurnRate);
        this.landedReleaseSeconds = this.blendDur;
        this.turnClamp = true;
      }
    }

    this.mode_ = mode;
    if (mode === 'cinematic') this.cinematicTime = 0;
    bus.emit('camera:mode', { mode });
  }

  cycleMode(): void {
    const i = MODE_ORDER.indexOf(this.mode_);
    this.setMode(MODE_ORDER[(i + 1) % MODE_ORDER.length]);
  }

  /**
   * Kick the camera. `intensity` 0..1, `durationSeconds` is the time to decay
   * back to still. A stronger shake overrides a weaker one in flight rather
   * than summing, so a barrage cannot saturate the screen into mush.
   */
  shake(intensity: number, durationSeconds: number): void {
    const i = clamp(intensity, 0, 1);
    if (i <= this.impulseTrauma) return;
    this.impulseTrauma = i;
    this.impulseDecay = i / Math.max(durationSeconds, 0.05);
  }

  /** Point the inspection camera at something. Distance is in km. */
  setOrbitTarget(position: Vector3, distanceKm: number): void {
    this.orbitTarget.copy(position);
    this.orbitDistance = Math.max(distanceKm, 1e-4);
    if (!this.orbitTargetSet) this.orbitDistanceCur = this.orbitDistance;
    this.orbitTargetSet = true;
  }

  /**
   * Compose the orbit view as a landed frame (ship/landedFraming.ts) while a
   * source is set; null goes back to the plain inspection orbit. The frame is
   * seeded from wherever the camera is when it starts, so switching it on is
   * never a cut.
   */
  setLandedFrame(source: LandedFrameSource | null): void {
    if (!source && this.landedSource && this.landedSeeded) {
      // Leaving is a move too. Keep composing for one transition so whatever
      // view comes next blends out of the frame on screen — dropping it at
      // once cut 70 m -> 200 m and 40 degrees in one frame (review-landed).
      this.landedHold = this.landedSource;
      this.landedReleaseT = 0;
    } else {
      this.landedHold = null;
      this.landedReleaseT = 1;
      this.landedSeeded = false;
    }
    this.landedReleaseSeconds = this.transitionSeconds;
    this.landedSource = source;
  }

  /** True while the orbit view is composing a landed frame. */
  get landedFrameActive(): boolean {
    return this.landedSource !== null;
  }

  /** Map/scan UI drag and zoom. Deltas are radians and a distance multiplier. */
  nudgeOrbit(deltaAzimuth: number, deltaElevation: number, distanceFactor = 1): void {
    this.orbitAzimuth += deltaAzimuth;
    this.orbitElevation = clamp(this.orbitElevation + deltaElevation, -1.45, 1.45);
    this.orbitDistance = Math.max(this.orbitDistance * distanceFactor, 1e-4);
  }

  /** Frame something for the cinematic camera. `radiusKm` sets the orbit scale. */
  setCinematicSubject(position: Vector3, radiusKm: number): void {
    this.cinematicSubject.copy(position);
    this.cinematicRadius = Math.max(radiusKm, 1e-4);
    this.cinematicSubjectSet = true;
  }

  /** Restart the cinematic orbit from its first frame. */
  resetCinematic(): void {
    this.cinematicTime = 0;
  }

  // --- [v3-T1] motion inputs --------------------------------------------------

  /**
   * What the hull feels this frame: PROPER acceleration (km/s², world axes,
   * gravity excluded — FlightModel.properAccel), engine output 0..1 and the
   * cruise spool 0..1. Lag, cockpit nudge, shake and FOV breathing are driven
   * from these, never from differencing positions. Call before `update()`.
   */
  setMotion(properAccel: Vector3, thrustFrac: number, cruiseSpool: number): void {
    if (Number.isFinite(properAccel.x + properAccel.y + properAccel.z)) this.motionAccel.copy(properAccel);
    this.thrustFrac = clamp(Number.isFinite(thrustFrac) ? thrustFrac : 0, 0, 1);
    this.cruiseSpool = clamp(Number.isFinite(cruiseSpool) ? cruiseSpool : 0, 0, 1);
  }

  /** Current shake trauma 0..1 (diagnostics and tests). */
  get trauma(): number {
    return clamp(this.impulseTrauma + this.thrustTrauma, 0, 1);
  }

  /**
   * Blended reseat: carry the camera to its settled pose for the current
   * attitude, blending the view across `seconds` so nothing cuts. For
   * discontinuities someone knows about (an attitude snap, an insertion).
   */
  reseat(seconds = 0.5): void {
    this.reseatPending = Math.max(seconds, 1e-3);
  }

  // --- [/v3-T1] -------------------------------------------------------------

  /** Drop all smoothing and snap to the ship next frame — use after a warp. */
  reset(): void {
    this.initialised = false;
  }

  // --- update --------------------------------------------------------------

  /**
   * All vectors are in RENDER space (post floating-origin). Call once per frame
   * after the flight model has moved the ship — `lateUpdate` is the natural home.
   */
  update(
    dt: number,
    shipPosition: Vector3,
    shipOrientation: Quaternion,
    shipVelocity: Vector3,
    ctx: EngineContext,
  ): void {
    this.followOrigin(ctx);

    if (this.handleToggleKey && ctx.input.pressed('toggleCamera')) this.cycleMode();

    if (!this.initialised) {
      this.snapTo(shipPosition, shipOrientation);
      this.initialised = true;
    }

    const step = Math.max(dt, 0);
    this.time += step;
    this.cinematicTime += step;

    // [v3-T1] v2 re-seated here whenever the lens was 50 km from the ship — a
    // threshold per FRAME, so it fired at 30 fps and not at 144. The chase is
    // hull-relative now and needs no such guard; discontinuities of attitude
    // are detected and blended in stepChase().

    this.updateDerived(step, shipVelocity);
    this.stepChase(step, shipPosition, shipOrientation, shipVelocity);
    this.stepCockpit(step, shipPosition, shipOrientation, ctx);
    this.stepCinematic(shipPosition);
    this.stepOrbit(step, shipPosition, shipOrientation, ctx);

    // Cross-fade. Every mode's pose is solved every frame — they are a handful
    // of springs each — so a transition is a plain interpolation with no state
    // to warm up and no direction it cannot be reversed in.
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + step / Math.max(this.blendDur, 1e-3));
    }
    const to = this.poseFor(this.mode_);
    if (this.blendT >= 1) {
      this.poseOut.copy(to);
    } else {
      // [v3-T1] Round the hull in spherical coordinates, not through it.
      this.blendAboutShip(this.poseFor(this.blendFrom), to, smootherstep(this.blendT), shipPosition);
    }

    // [v3-T1] Blended reseat: from where the lens was to where it now belongs.
    if (this.reseatT < 1) {
      this.reseatT = Math.min(1, this.reseatT + step / this.reseatDur);
      const k = smootherstep(this.reseatT);
      const rel = this.tmpA.copy(this.poseOut.position).sub(shipPosition);
      sphericalLerp(this.tmpB, this.reseatRel, rel, k);
      this.poseOut.position.copy(shipPosition).add(this.tmpB);
      this.tmpQ.copy(this.reseatQuat).slerp(this.poseOut.quaternion, k);
      this.poseOut.quaternion.copy(this.tmpQ);
    }

    // [v3-T1] Whatever a blend does, the hull stays in the picture: a reseat
    // slerps world orientations while the position swings on a sphere, and
    // across a large arc the two disagree (measured: 78 deg off the hull
    // after an auto-10x flip). The chase pose itself is already framed.
    if (this.mode_ === 'chase' && (this.reseatT < 1 || this.blendT < 1)) this.frameOutput(shipPosition);

    // [v3-T1] Liftoff turn clamp: the blend is sized to stay under the limit;
    // this is the guarantee, for when the poses themselves are moving.
    if (this.turnClamp && this.lastOutSet && step > 1e-6) {
      const ang = this.lastOutQuat.angleTo(this.poseOut.quaternion);
      const max = this.liftoffMaxTurnRate * step;
      if (ang > max) {
        this.tmpQ.copy(this.lastOutQuat).rotateTowards(this.poseOut.quaternion, max);
        this.poseOut.quaternion.copy(this.tmpQ);
      } else if (this.blendT >= 1) {
        this.turnClamp = false;
      }
    }

    this.lastOutRel.copy(this.poseOut.position).sub(shipPosition);
    this.lastOutQuat.copy(this.poseOut.quaternion);
    this.lastOutSet = true;
    this.lastShipPos.copy(shipPosition);

    this.applyShake(step);
    this.commit();
  }

  /** [v3-T1] Turn the output just enough to keep the hull inside chaseFrameMargin. */
  private frameOutput(ship: Vector3): void {
    const q = this.poseOut.quaternion;
    const fwd = this.tmpA.set(0, 0, -1).applyQuaternion(q);
    const up = this.tmpB.set(0, 1, 0).applyQuaternion(q);
    const toShip = this.tmpC.copy(ship).sub(this.poseOut.position);
    if (toShip.lengthSq() < 1e-14) return;
    const aspect = this.camera.aspect > 0 ? this.camera.aspect : 16 / 9;
    const halfY = (this.poseOut.fov * Math.PI) / 360;
    constrainAimToFrame(this.tmpD, fwd, toShip, up, halfY, aspect, this.chaseFrameMargin);
    if (this.tmpD.angleTo(fwd) < 1e-6) return;
    this.lookRotation(q, this.poseOut.position, this.tmpD, up);
  }

  /** [v3-T1] Mode blend about the hull: radius linear, direction on the sphere. */
  private blendAboutShip(a: Pose, b: Pose, t: number, ship: Vector3): void {
    const ra = this.tmpA.copy(a.position).sub(ship);
    const rb = this.tmpB.copy(b.position).sub(ship);
    sphericalLerp(this.tmpC, ra, rb, t);
    this.poseOut.position.copy(ship).add(this.tmpC);
    this.tmpQ.copy(a.quaternion).slerp(b.quaternion, t);
    this.poseOut.quaternion.copy(this.tmpQ);
    this.poseOut.fov = a.fov + (b.fov - a.fov) * t;
  }

  dispose(): void {
    for (const off of this.offBus) off();
    this.offBus.length = 0;
    this.camera.fov = this.initialFov;
    this.camera.updateProjectionMatrix();
  }

  // --- internals -----------------------------------------------------------

  /**
   * When the floating origin rebases, every render-space position in the world
   * shifts by the same delta. Our cached spring state is render-space too, so
   * it has to shift with it or the camera lurches on every rebase.
   */
  private followOrigin(ctx: EngineContext): void {
    const off = ctx.origin.offset;
    if (!this.originTracked) {
      this.lastOriginOffset.copy(off);
      this.originTracked = true;
      return;
    }
    if (off.equals(this.lastOriginOffset)) return;
    const d = this.tmpA.copy(off).sub(this.lastOriginOffset);
    this.lastOriginOffset.copy(off);
    // [v3-T1] The chase is hull-relative and needs nothing here.
    this.orbitTarget.sub(d);
    this.cinematicSubject.sub(d);
    this.poseOut.position.sub(d);
    this.lastShipPos.sub(d);
  }

  private snapTo(shipPosition: Vector3, q: Quaternion): void {
    this.anchorRel.copy(this.chaseOffset).applyQuaternion(q);
    this.anchorRelPrev.copy(this.anchorRel);
    this.anchorRelVel.set(0, 0, 0);
    this.chaseR.set(0, 0, 0);
    this.chaseRelVel.set(0, 0, 0);
    this.lagOff.set(0, 0, 0);
    this.camRel.copy(this.anchorRel);
    this.qPrev.copy(q);
    this.omega.set(0, 0, 0);
    this.chaseAim.set(0, 0, -1).applyQuaternion(q);
    this.chaseAimVel.set(0, 0, 0);
    this.chaseUp.set(0, 1, 0).applyQuaternion(q);
    this.chaseUpVel.set(0, 0, 0);
    this.cockpitNudge.set(0, 0, 0);
    this.cockpitNudgeVel.set(0, 0, 0);
    this.accelF.copy(this.motionAccel);
    this.impulseTrauma = 0;
    this.thrustTrauma = 0;
    this.fovSeeded = false;
    this.reseatT = 1;
    // The aim snaps onto its target on the first chase step.
    this.snapAim = true;
    this.lastShipPos.copy(shipPosition);
    this.lastOutSet = false;
  }

  private poseFor(mode: CameraMode): Pose {
    switch (mode) {
      case 'cockpit':
        return this.poseCockpit;
      case 'cinematic':
        return this.poseCinematic;
      case 'orbit':
        return this.poseOrbit;
      case 'chase':
      default:
        return this.poseChase;
    }
  }

  /** Speed ease (velocity aim), fov policy, frame rate — shared by several modes. */
  private updateDerived(dt: number, shipVelocity: Vector3): void {
    const speed = shipVelocity.length();
    // Saturating rather than clamped: works at 0.2 km/s and at 400 km/s.
    const target = 1 - Math.exp(-speed / Math.max(this.speedReference, 1e-3));
    const tau = Math.max(this.fovEaseSeconds, 1e-3) / 3;
    const k = dt > 0 ? 1 - Math.exp(-dt / tau) : 0;
    this.speedEase += (target - this.speedEase) * k;

    // [v3-T1] FOV from the D0 policy: aspect, thrust and cruise spool. Never
    // from speed (v2 sat at its ceiling in every orbit: 110-124 deg wide).
    const fi = this.fovIn;
    fi.aspect = this.camera.aspect > 0 ? this.camera.aspect : 16 / 9;
    fi.thrustFrac = this.thrustFrac;
    fi.cruiseSpool = this.cruiseSpool;
    fi.mode = 'chase';
    const chase = fovPolicy(fi);
    fi.mode = 'cockpit';
    const cockpit = fovPolicy(fi);
    if (!this.fovSeeded) {
      this.fovChase = chase;
      this.fovCockpit = cockpit;
      this.fovSeeded = true;
    } else {
      this.fovChase += (chase - this.fovChase) * k;
      this.fovCockpit += (cockpit - this.fovCockpit) * k;
    }

    if (dt > 1e-6) {
      this.frameHz += (clamp(1 / dt, 10, 1000) - this.frameHz) * 0.1;
      lowPassVec(this.accelF, this.motionAccel, dt, this.chaseAccelTau);
    }
  }

  // -- chase ---------------------------------------------------------------

  /**
   * [v3-T1] The chase, hull-relative.
   *
   *   lens = hull + anchor + r + lag
   *
   * - anchor: the follow offset in the hull's axes. Its velocity (attitude
   *   only) feeds the spring forward, limited to chaseAnchorAccelMax; more
   *   than that is an attitude snap and triggers a blended reseat.
   * - r: the follower spring's deviation, solved in the anchor's frame, so a
   *   steady turn carries the lens round and an onset of turn swings it
   *   late — the gimballed-drone read. Softly bounded by chaseSwingMax.
   * - lag: the trail from proper acceleration (thrust, drag; not gravity),
   *   low-passed and tanh-saturated (chaseLagOffset). v2 differentiated
   *   positions instead, so a lost 8 ms of ship time read as a 4 km/s spike.
   */
  private stepChase(dt: number, shipPosition: Vector3, q: Quaternion, vel: Vector3): void {
    const anchor = this.anchorRel.copy(this.chaseOffset).applyQuaternion(q);
    let snapped = false;
    let reseatFor = this.reseatSeconds;
    if (this.reseatPending > 0) {
      snapped = true;
      reseatFor = this.reseatPending;
      this.reseatPending = -1;
    }

    if (dt > 1e-6) {
      // Hull turn rate from the change of attitude, world axes.
      const dq = this.tmpQ.copy(q).multiply(this.tmpQ2.copy(this.qPrev).invert());
      if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
      const ang = 2 * Math.acos(clamp(dq.w, -1, 1));
      if (ang / dt > this.attitudeSnapRate) {
        snapped = true; // keep last frame's rate
      } else if (ang > 1e-9) {
        this.omega.set(dq.x, dq.y, dq.z).normalize().multiplyScalar(ang / dt);
      } else {
        this.omega.set(0, 0, 0);
      }

      const raw = this.tmpA.copy(anchor).sub(this.anchorRelPrev).divideScalar(dt);
      // The excess is carried (the lens is solved in the anchor's frame), not
      // fed to the spring; it only re-seats the view when the attitude itself
      // snapped (above), since under time compression fast but real turns
      // exceed aMax too.
      const lim = limitAnchorVelocity(this.anchorRelVel, raw, dt, this.chaseAnchorAccelMax, this.anchorLimit);
      this.anchorRelVel.copy(lim.vel);

      // Spring in the anchor's frame: position carried with the anchor, the
      // relative velocity sees only the anchor's (limited) change of velocity.
      const r = this.chaseR;
      const rv = this.tmpB.copy(this.chaseRelVel).sub(this.anchorRelVel);
      this.spring.compute(dt, this.chaseFrequency, this.chaseDamping);
      this.spring.stepToZero(r, rv);
      const rl = r.length();
      if (rl > 1e-12) r.multiplyScalar((this.chaseSwingMax * Math.tanh(rl / this.chaseSwingMax)) / rl);
      this.chaseRelVel.copy(this.anchorRelVel).add(rv);

      chaseLagOffset(this.accelF, TWO_PI * this.chaseFrequency, this.chaseLagMax, this.lagOff);
    }
    this.anchorRelPrev.copy(anchor);
    this.qPrev.copy(q);

    if (snapped) {
      this.beginReseat(reseatFor);
      this.chaseR.set(0, 0, 0);
      this.chaseRelVel.copy(this.anchorRelVel);
    }

    const camRel = this.camRel.copy(anchor).add(this.chaseR).add(this.lagOff);

    // Aim: nose vector eased towards the velocity vector, so a ship travelling
    // sideways is framed sideways and the drift is legible.
    const nose = this.tmpA.set(0, 0, -1).applyQuaternion(q);
    const speed = vel.length();
    let align = this.velocityAlign * this.speedEase;
    if (align > 1e-3 && speed > 1e-5) {
      const vdir = this.tmpB.copy(vel).divideScalar(speed);
      // Cap how far the aim may leave the nose (MAX_VELOCITY_AIM_ANGLE).
      const cosT = Math.max(-1, Math.min(1, nose.dot(vdir)));
      const theta = Math.acos(cosT);
      if (theta > 1e-4) align = Math.min(align, MAX_VELOCITY_AIM_ANGLE / theta);
      nose.lerp(vdir, align);
      const l = nose.length();
      // Flying backwards makes the two directions cancel. Rather than let the
      // aim spin through a singularity, give up on the blend for that frame.
      if (l > 0.05) nose.divideScalar(l);
      else nose.set(0, 0, -1).applyQuaternion(q);
    }

    // Wanted aim, hull-relative: the look-ahead point minus the lens.
    const wantAim = this.tmpD.copy(nose).multiplyScalar(this.chaseLookAhead).sub(camRel);
    const al = wantAim.length();
    if (al > 1e-9) wantAim.divideScalar(al);
    const shipUp = this.tmpB.set(0, 1, 0).applyQuaternion(q);
    if (this.chaseAimPitchBias !== 0) {
      const right = this.tmpC.crossVectors(wantAim, shipUp);
      if (right.lengthSq() > 1e-12) wantAim.applyAxisAngle(right.normalize(), this.chaseAimPitchBias);
    }

    if (snapped || this.snapAim) {
      this.chaseAim.copy(wantAim);
      this.chaseAimVel.set(0, 0, 0);
      this.chaseUp.copy(shipUp);
      this.chaseUpVel.set(0, 0, 0);
      this.snapAim = false;
    } else if (dt > 1e-6) {
      // Feed-forward: the wanted aim turns with the hull at omega. The spring
      // only smooths the difference, so a held turn does not lag.
      const wantVel = this.tmpC.crossVectors(this.omega, wantAim);
      // Error against where the target was at the START of the step (the
      // analytic spring assumes the target moves at wantVel through it).
      const e = this.tmpA.copy(this.chaseAim).sub(wantAim).addScaledVector(wantVel, dt);
      const ev = this.chaseAimVel.sub(wantVel);
      this.spring.compute(dt, this.chaseAimFrequency, this.chaseOrientationDamping);
      this.spring.stepToZero(e, ev);
      this.chaseAim.copy(wantAim).add(e);
      this.chaseAimVel.add(wantVel);
      const l = this.chaseAim.length();
      if (l > 1e-9) this.chaseAim.divideScalar(l);

      // Roll lags slowest of all. Rolling the ship and watching the horizon
      // follow a beat later is most of the "heavy machine" read. Pitch and
      // yaw are fed forward (they would otherwise drag the up 40 deg behind a
      // full-rate pitch); roll about the nose is not.
      const nz = this.tmpA.set(0, 0, -1).applyQuaternion(q);
      const wpy = this.tmpD.copy(this.omega).addScaledVector(nz, -this.omega.dot(nz));
      const upVel = this.tmpC.crossVectors(wpy, shipUp);
      const eu = this.tmpA.copy(this.chaseUp).sub(shipUp).addScaledVector(upVel, dt);
      const euv = this.chaseUpVel.sub(upVel);
      this.spring2.compute(dt, this.chaseFrequency * this.chaseRollLagRatio, 1.0);
      this.spring2.stepToZero(eu, euv);
      this.chaseUp.copy(shipUp).add(eu);
      this.chaseUpVel.add(upVel);
      const ul = this.chaseUp.length();
      if (ul > 1e-9) this.chaseUp.divideScalar(ul);
    }

    // Keep the hull in frame: 60 % of the half-frame, softly from 40 %.
    const toShip = this.tmpA.copy(camRel).negate();
    constrainAimToFrame(
      this.chaseAim,
      this.chaseAim,
      toShip,
      this.chaseUp,
      (this.fovChase * Math.PI) / 360,
      this.fovIn.aspect,
      this.chaseFrameMargin,
    );

    this.poseChase.position.copy(shipPosition).add(camRel);
    this.lookRotation(
      this.poseChase.quaternion,
      this.poseChase.position,
      this.chaseAim,
      this.tmpB.copy(this.chaseUp),
    );
    this.poseChase.fov = this.fovChase;
  }

  /** [v3-T1] Start a blended reseat from last frame's output. */
  private beginReseat(seconds: number): void {
    if (!this.lastOutSet) return;
    this.reseatRel.copy(this.lastOutRel);
    this.reseatQuat.copy(this.lastOutQuat);
    this.reseatDur = Math.max(seconds, 1e-3);
    this.reseatT = 0;
  }

  // -- cockpit -------------------------------------------------------------

  private stepCockpit(
    dt: number,
    shipPosition: Vector3,
    q: Quaternion,
    ctx: EngineContext,
  ): void {
    // Acceleration expressed in the hull's own axes, then negated: burn forward
    // and the viewpoint sinks back into the seat.
    // [v3-T1] Proper acceleration, filtered — not a finite difference of the
    // velocity, which read 0-200 % of the thrust frame to frame.
    const local = this.tmpA.copy(this.accelF).applyQuaternion(
      this.tmpQ.copy(q).invert(),
    );
    const target = this.tmpB.copy(local).multiplyScalar(-this.cockpitAccelGain);
    const tl = target.length();
    if (tl > this.cockpitMaxNudge) target.multiplyScalar(this.cockpitMaxNudge / tl);

    if (dt > 1e-6) {
      this.spring.compute(dt, this.cockpitFrequency, this.cockpitDamping);
      this.spring.step(this.cockpitNudge, this.cockpitNudgeVel, target);
    }

    // Idle breathing: two incommensurate slow sines so it never looks looped.
    const a = this.cockpitBreathAmplitude;
    const bx = Math.sin(this.time * 0.61 + 2.1) * a * 0.4;
    const by = Math.sin(this.time * 0.93) * a + Math.sin(this.time * 1.37 + 1.1) * a * 0.55;

    const offs = this.tmpC.copy(this.cockpitOffset).add(this.cockpitNudge);
    offs.x += bx;
    offs.y += by;
    this.poseCockpit.position.copy(offs).applyQuaternion(q).add(shipPosition);

    this.stepHeadLook(dt, ctx);
    this.tmpE.set(this.headPitch, this.headYaw, 0, 'YXZ');
    this.poseCockpit.quaternion.copy(q).multiply(this.tmpQ2.setFromEuler(this.tmpE));

    this.poseCockpit.fov = this.fovCockpit;
  }

  private stepHeadLook(dt: number, ctx: EngineContext): void {
    let held = false;
    for (let i = 0; i < this.headLookKeys.length; i++) {
      if (ctx.input.isDown(this.headLookKeys[i])) {
        held = true;
        break;
      }
    }
    this.headLookActive_ = held;

    let yawTarget = 0;
    let pitchTarget = 0;
    if (held) {
      // Integrate the steering axes instead of reading them: holding the look
      // key sweeps the head round rather than jumping it to an angle.
      yawTarget = clamp(
        this.headYaw + ctx.input.axes.yaw * this.headLookSpeed * dt,
        -this.headYawLimit,
        this.headYawLimit,
      );
      pitchTarget = clamp(
        this.headPitch + ctx.input.axes.pitch * this.headLookSpeed * dt,
        -this.headPitchLimit,
        this.headPitchLimit,
      );
    }

    if (dt <= 1e-6) return;
    // Snapping back to forward on release would be the one hard cut in the rig,
    // so the return runs on its own, slower spring.
    const f = held ? this.headLookFrequency : this.headReturnFrequency;
    this.spring.compute(dt, f, 1.0);
    this.spring.stepScalar(this.headYaw, this.headYawVel, yawTarget);
    this.headYaw = this.spring.outPos;
    this.headYawVel = this.spring.outVel;
    this.spring.stepScalar(this.headPitch, this.headPitchVel, pitchTarget);
    this.headPitch = this.spring.outPos;
    this.headPitchVel = this.spring.outVel;
  }

  // -- cinematic -----------------------------------------------------------

  /**
   * Purely analytic: position is a closed-form function of `cinematicTime`, so
   * N fixed-step frames always produce the same frame N. No springs, no state,
   * nothing to settle — which is exactly what a reproducible screenshot needs.
   */
  private stepCinematic(shipPosition: Vector3): void {
    const subject = this.cinematicSubjectSet ? this.cinematicSubject : shipPosition;
    const t = this.cinematicTime;

    const az = t * this.cinematicRate;
    // Slow, incommensurate drifts on elevation and dolly keep the move alive
    // without ever reading as a loop.
    const el = this.cinematicElevation + Math.sin(t * 0.037) * 0.16;
    const dist = this.cinematicRadius * this.cinematicDistanceScale * (1 + Math.sin(t * 0.023) * 0.07);

    const ce = Math.cos(el);
    const pos = this.poseCinematic.position;
    pos.set(Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce).multiplyScalar(dist).add(subject);

    const dir = this.tmpA.copy(subject).sub(pos);
    const l = dir.length();
    if (l > 1e-9) dir.divideScalar(l);
    else dir.set(0, 0, -1);

    // A slow dutch roll. Barely perceptible, and it is what stops a locked-off
    // orbit from looking like a 3D turntable render.
    const roll = Math.sin(t * 0.019) * 0.038;
    const up = this.tmpB.set(Math.sin(roll), Math.cos(roll), 0);

    this.lookRotation(this.poseCinematic.quaternion, pos, dir, up);
    // Compose off-centre: the subject sits on the lower-left third and the
    // empty upper-right is where the star and its flare belong.
    this.tmpE.set(this.cinematicComposePitch, this.cinematicComposeYaw, 0, 'YXZ');
    this.poseCinematic.quaternion.multiply(this.tmpQ.setFromEuler(this.tmpE));
    this.poseCinematic.fov = this.cinematicFov;
  }

  // -- orbit ---------------------------------------------------------------

  private stepOrbit(
    dt: number,
    shipPosition: Vector3,
    shipOrientation: Quaternion,
    ctx: EngineContext,
  ): void {
    if (!this.orbitTargetSet) {
      this.orbitDistance = 0.2;
      this.orbitDistanceCur = 0.2;
      this.orbitTargetSet = true;
    }
    if (this.landedSource && this.hasReferenceUp) {
      this.stepLanded(dt, shipPosition, shipOrientation, ctx, this.landedSource);
      return;
    }
    if (this.landedHold && this.landedReleaseT < 1 && this.hasReferenceUp) {
      // Releasing (setLandedFrame): the composition keeps running for one
      // transition. Another mode's blend carries the view away from it on its
      // own; staying in orbit, the rig blends to the plain orbit itself.
      const first = this.landedReleaseT === 0;
      this.landedReleaseT = Math.min(1, this.landedReleaseT + dt / Math.max(this.landedReleaseSeconds, 1e-3));
      this.stepLanded(dt, shipPosition, shipOrientation, ctx, this.landedHold);
      if (this.mode_ !== 'orbit') return;
      // Start the plain orbit on the landed eye's bearing, so the hand-over
      // is a short tilt rather than a swing round the hull.
      if (first) this.seedOrbitAngles(shipPosition);
      this.poseRelease.copy(this.poseOrbit);
      this.stepPlainOrbit(dt, shipPosition, shipOrientation, ctx);
      // Into the scratch pose: lerpFrom's slerp copies its first argument
      // into the target before reading the second, so it must not alias `b`.
      this.poseRelease.lerpFrom(this.poseRelease, this.poseOrbit, smootherstep(this.landedReleaseT));
      this.poseOrbit.copy(this.poseRelease);
      return;
    }
    this.landedHold = null;
    this.landedSeeded = false;
    this.stepPlainOrbit(dt, shipPosition, shipOrientation, ctx);
  }

  /** Orbit azimuth/elevation that put the plain orbit where poseOrbit is now. */
  private seedOrbitAngles(shipPosition: Vector3): void {
    const up = this.tmpA.copy(this.referenceUp).normalize();
    const seed = Math.abs(up.y) > 0.95 ? this.tmpB.set(1, 0, 0) : this.tmpB.set(0, 1, 0);
    const right = this.tmpC.copy(seed).cross(up).normalize();
    const fwd = this.tmpD.copy(up).cross(right).normalize();
    const off = this.tmpB.copy(this.poseOrbit.position).sub(shipPosition);
    const d = off.length();
    if (d < 1e-9) return;
    const az = Math.atan2(off.dot(right), off.dot(fwd));
    const el = Math.asin(clamp(off.dot(up) / d, -1, 1));
    this.orbitAzimuth = this.orbitAzimuthCur = az;
    this.orbitElevation = this.orbitElevationCur = el;
    this.orbitAzimuthVel = this.orbitElevationVel = 0;
  }

  private stepPlainOrbit(
    dt: number,
    shipPosition: Vector3,
    shipOrientation: Quaternion,
    ctx: EngineContext,
  ): void {

    // The target FOLLOWS the ship. It used to be captured once behind the latch
    // above, which is wrong in a game where render space is rebased by the
    // floating origin and the world itself travels at tens of km/s: the target
    // went stale within a frame and the camera ended up staring at empty space
    // beside a landed hull. Azimuth, elevation and distance are still the
    // player's to steer; only the point they orbit is pinned to the subject.
    this.orbitTarget.copy(shipPosition);

    // Only steer from raw input while this view is actually on screen.
    if (this.mode_ === 'orbit' && dt > 0) {
      this.orbitAzimuth -= ctx.input.axes.yaw * this.orbitInputSpeed * dt;
      this.orbitElevation = clamp(
        this.orbitElevation + ctx.input.axes.pitch * this.orbitInputSpeed * dt,
        -1.45,
        1.45,
      );
    }

    if (dt > 1e-6) {
      this.spring.compute(dt, this.orbitFrequency, this.orbitDamping);
      this.spring.stepScalar(this.orbitAzimuthCur, this.orbitAzimuthVel, this.orbitAzimuth);
      this.orbitAzimuthCur = this.spring.outPos;
      this.orbitAzimuthVel = this.spring.outVel;
      this.spring.stepScalar(this.orbitElevationCur, this.orbitElevationVel, this.orbitElevation);
      this.orbitElevationCur = this.spring.outPos;
      this.orbitElevationVel = this.spring.outVel;
      this.spring.stepScalar(this.orbitDistanceCur, this.orbitDistanceVel, this.orbitDistance);
      this.orbitDistanceCur = this.spring.outPos;
      this.orbitDistanceVel = this.spring.outVel;
    }

    // Build the offset in a frame based on the reference up when there is one.
    //
    // The spherical offset used to be laid out on the WORLD axes, so
    // "elevation" meant "above the system's ecliptic" and on a planet it could
    // put the camera underground: measured on a landed hull, the rig sat at
    // ground level pitched 60 degrees UP, with a near slope filling the frame
    // and the true horizon 60 degrees below the bottom edge. Anchoring the
    // frame to the local vertical makes elevation mean what it says, and a
    // floor on it keeps the lens above the surface looking down at the hull.
    let el = this.orbitElevationCur;
    const pos = this.poseOrbit.position;
    const dist = Math.max(this.orbitDistanceCur, 1e-4);

    if (this.hasReferenceUp) {
      el = Math.max(el, ORBIT_MIN_SURFACE_ELEVATION);
      const up = this.tmpA.copy(this.referenceUp).normalize();
      // Any two directions perpendicular to up will do; pick one that does not
      // degenerate when up happens to align with a world axis.
      const seed = Math.abs(up.y) > 0.95 ? this.tmpB.set(1, 0, 0) : this.tmpB.set(0, 1, 0);
      const right = this.tmpC.copy(seed).cross(up).normalize();
      const fwd = this.tmpD.copy(up).cross(right).normalize();
      const ceL = Math.cos(el);
      pos
        .copy(right)
        .multiplyScalar(Math.sin(this.orbitAzimuthCur) * ceL * dist)
        .addScaledVector(fwd, Math.cos(this.orbitAzimuthCur) * ceL * dist)
        .addScaledVector(up, Math.sin(el) * dist)
        .add(this.orbitTarget);
    } else {
      const ce = Math.cos(el);
      pos
        .set(Math.sin(this.orbitAzimuthCur) * ce, Math.sin(el), Math.cos(this.orbitAzimuthCur) * ce)
        .multiplyScalar(dist)
        .add(this.orbitTarget);
    }

    const dir = this.tmpA.copy(this.orbitTarget).sub(pos);
    const l = dir.length();
    if (l > 1e-9) dir.divideScalar(l);
    else dir.set(0, 0, -1);
    // Level against the local vertical when the integrator has supplied one,
    // the ship's own up otherwise. World Y is neither, on a planet.
    if (this.hasReferenceUp) this.tmpB.copy(this.referenceUp);
    else this.tmpB.set(0, 1, 0).applyQuaternion(shipOrientation);
    if (Math.abs(this.tmpB.dot(dir)) > 0.999) this.tmpB.set(0, 1, 0);
    this.lookRotation(this.poseOrbit.quaternion, pos, dir, this.tmpB);
    this.poseOrbit.fov = this.orbitFov;
  }

  // -- landed --------------------------------------------------------------

  /**
   * The composed landed frame. The composition is pure (landedFraming.ts);
   * this only springs towards it. Everything is ship-relative: render space
   * sweeps past at orbital speed between rebases, and a spring on absolute
   * positions would trail the hull by kilometres.
   */
  private stepLanded(
    dt: number,
    shipPosition: Vector3,
    shipOrientation: Quaternion,
    ctx: EngineContext,
    source: LandedFrameSource,
  ): void {
    const up = this.tmpA.copy(this.referenceUp).normalize();
    // Cylindrical basis about the local vertical. The reference azimuth is
    // world X laid onto the horizon (world Z where X is vertical); it turns
    // only as fast as the world does, so angles stay continuous.
    //
    // Carried from frame to frame (last frame's reference laid onto this
    // frame's horizon), not re-derived from world X: near X that projection
    // spins through 180 degrees and the fallback switch jumps outright, and
    // the eye — held at an angle in this basis — whipped round the hull with
    // it (review-landed). World X only seeds it.
    const ref = this.landedRef;
    if (this.landedSeeded) ref.addScaledVector(up, -ref.dot(up));
    if (!this.landedSeeded || ref.lengthSq() < 1e-4) {
      ref.set(1, 0, 0).addScaledVector(up, -up.x);
      if (ref.lengthSq() < 1e-4) ref.set(0, 0, 1).addScaledVector(up, -up.z);
    }
    ref.normalize();
    const side = this.landedSide.crossVectors(up, ref);

    if (!this.landedSeeded) {
      // Start from wherever the camera is now, so touchdown is a move, not a
      // cut. "Now" has to mean THIS frame's pose: the ship sweeps ~1 km through
      // render space per frame between rebases, so last frame's camera
      // position minus this frame's ship position is a kilometre wrong. The
      // other modes have already been stepped this frame; the orbit pose has
      // not, so it is never the seed.
      const fromMode = this.blendT < 1 ? this.blendFrom : this.mode_;
      const seed = fromMode === 'orbit' ? this.poseChase : this.poseFor(fromMode);
      const off = this.tmpB.copy(seed.position).sub(shipPosition);
      this.landedH = off.dot(up);
      off.addScaledVector(up, -this.landedH);
      this.landedR = Math.max(off.length(), 1e-3);
      this.landedAz = Math.atan2(off.dot(side), off.dot(ref));
      this.landedLook.set(0, 0, -1).applyQuaternion(seed.quaternion);
      this.landedAzVel = this.landedRVel = this.landedHVel = 0;
      this.landedLookVel.set(0, 0, 0);
      this.landedTarget.copy(seed.position).sub(shipPosition);
      this.landedTime = 0;
      this.landedYaw = 0;
      this.landedPitch = 0;
      this.landedSeeded = true;
    }

    this.landedTime += dt;
    if (this.mode_ === 'orbit' && dt > 0) {
      this.landedYaw -= ctx.input.axes.yaw * this.orbitInputSpeed * 0.6 * dt;
      this.landedPitch = clamp(
        this.landedPitch + ctx.input.axes.pitch * this.orbitInputSpeed * 0.4 * dt,
        -this.landedPitchLimit,
        this.landedPitchLimit,
      );
    }

    const li = this.landedIn;
    li.up.copy(up);
    li.sunDir.copy(source.sunDir);
    li.shipForward.set(0, 0, -1).applyQuaternion(shipOrientation);
    li.skyWeight = source.skyWeight;
    li.time = this.landedTime;
    li.yaw = this.landedYaw;
    li.pitch = this.landedPitch;
    // Sampled where the eye is heading, a frame late: the spot depends on the
    // composition and the composition on the spot. Terrain does not move.
    li.groundRise = source.groundRiseAt(this.landedTarget);
    li.halfFovY = (this.landedFov * Math.PI) / 360;
    const f = composeLandedFrame(li, this.landedOut);
    this.landedTarget.copy(f.offset);

    // Target in cylindrical coordinates, azimuth unwrapped to the near side.
    const tH = f.offset.dot(up);
    const tx = f.offset.dot(ref);
    const ty = f.offset.dot(side);
    const tR = Math.hypot(tx, ty);
    let tAz = Math.atan2(ty, tx);
    tAz = this.landedAz + Math.atan2(Math.sin(tAz - this.landedAz), Math.cos(tAz - this.landedAz));

    if (dt > 1e-6) {
      this.spring.compute(dt, this.landedFrequency, 1.0);
      this.spring.stepScalar(this.landedAz, this.landedAzVel, tAz);
      this.landedAz = this.spring.outPos;
      this.landedAzVel = this.spring.outVel;
      this.spring.stepScalar(this.landedR, this.landedRVel, tR);
      this.landedR = this.spring.outPos;
      this.landedRVel = this.spring.outVel;
      this.spring.stepScalar(this.landedH, this.landedHVel, tH);
      this.landedH = this.spring.outPos;
      this.landedHVel = this.spring.outVel;

      this.spring2.compute(dt, this.landedLookFrequency, 1.0);
      this.spring2.step(this.landedLook, this.landedLookVel, f.look);
      const l = this.landedLook.length();
      if (l > 1e-9) this.landedLook.divideScalar(l);
      else this.landedLook.copy(f.look);
    }

    // The spring lags the terrain sample; never let the eye sink into it.
    const h = Math.max(this.landedH, li.groundRise + LANDED_CLEARANCE * 0.5);
    const pos = this.poseOrbit.position;
    pos
      .copy(ref)
      .multiplyScalar(Math.cos(this.landedAz) * this.landedR)
      .addScaledVector(side, Math.sin(this.landedAz) * this.landedR)
      .addScaledVector(up, h)
      .add(shipPosition);
    // [v3-T1] The reveal swings the eye round the hull at 0.22 Hz and the look
    // at 0.28 Hz; keep the hull in the picture while they disagree.
    constrainAimToFrame(
      this.landedLook,
      this.landedLook,
      this.tmpC.copy(shipPosition).sub(pos),
      up,
      (this.landedFov * Math.PI) / 360,
      this.camera.aspect > 0 ? this.camera.aspect : 16 / 9,
      0.8,
    );
    this.tmpB.copy(up);
    this.lookRotation(this.poseOrbit.quaternion, pos, this.landedLook, this.tmpB);
    this.poseOrbit.fov = this.landedFov;
  }

  // -- shake ---------------------------------------------------------------

  private applyShake(dt: number): void {
    if (this.impulseTrauma > 0) {
      this.impulseTrauma = Math.max(0, this.impulseTrauma - this.impulseDecay * dt);
    }

    // Continuous rumble under thrust — [v3-T1] from the engine's output only.
    // Drag, gear and gravity are not the hull straining.
    const want = this.thrustFrac * this.shakeThrustCeiling;
    this.thrustTrauma += (want - this.thrustTrauma) * (dt > 0 ? 1 - Math.exp(-dt / 0.12) : 0);

    const trauma = clamp(this.impulseTrauma + this.thrustTrauma, 0, 1);
    if (trauma <= 1e-4) return;

    // Squared envelope: a shake that fades linearly is obvious in its last
    // third. Squared, the tail disappears before you can name the moment.
    const env = trauma * trauma;
    const t = this.time;
    // [v3-T1] Band-limited to what this frame rate can show (<= 25 Hz).
    const hz = this.frameHz;

    const tr = this.tmpA.set(
      shakeNoise(t, 1, hz) * this.shakeTranslation * env,
      shakeNoise(t, 2, hz) * this.shakeTranslation * env,
      shakeNoise(t, 3, hz) * this.shakeTranslation * env * 0.6,
    );
    // Translate in camera-local axes so shake reads the same at any heading.
    tr.applyQuaternion(this.poseOut.quaternion);
    this.poseOut.position.add(tr);

    this.tmpE.set(
      shakeNoise(t, 4, hz) * this.shakeRotation * env,
      shakeNoise(t, 5, hz) * this.shakeRotation * env,
      shakeNoise(t, 6, hz) * this.shakeRotation * this.shakeRollScale * env,
      'YXZ',
    );
    this.poseOut.quaternion.multiply(this.tmpQ.setFromEuler(this.tmpE));
  }

  // -- output --------------------------------------------------------------

  private lookRotation(out: Quaternion, eye: Vector3, dir: Vector3, up: Vector3): void {
    const target = this.tmpLook.copy(eye).add(dir);
    // Degenerate when the view axis is parallel to `up` — nudge rather than
    // let setFromRotationMatrix produce NaNs that poison every later frame.
    if (Math.abs(dir.dot(up)) > 0.9999) {
      up.x += 0.01;
      const l = up.length();
      if (l > 1e-9) up.divideScalar(l);
    }
    this.tmpM.lookAt(eye, target, up);
    out.setFromRotationMatrix(this.tmpM);
  }

  private commit(): void {
    this.camera.position.copy(this.poseOut.position);
    this.camera.quaternion.copy(this.poseOut.quaternion);
    if (Math.abs(this.camera.fov - this.poseOut.fov) > 0.02) {
      this.camera.fov = this.poseOut.fov;
      this.camera.updateProjectionMatrix();
    }
    // Renderers running in lateUpdate read camera.matrixWorld to build their
    // ViewState, so it must be current *now*, not at render time.
    this.camera.updateMatrixWorld();
  }
}

// ---------------------------------------------------------------------------
// Review shot
// ---------------------------------------------------------------------------

/**
 * Registers `camera-cinematic`. The rig drives itself here from a stationary
 * synthetic subject at the render origin, so the shot reviews *composition* —
 * lens length, subject placement, dutch roll — independently of whatever the
 * ship and the flight model happen to be doing.
 */
export function registerCameraShots(rig: CameraRig): void {
  const subject = new Vector3(0, 0, 0);
  const stillOrientation = new Quaternion();
  const stillVelocity = new Vector3();

  registerShot({
    name: 'camera-cinematic',
    description:
      'Cinematic orbit: a 40mm-equivalent lens circling the ship with the subject ' +
      'on the lower-left third and a slow dutch roll. Judge the framing and the ' +
      'weight of the move, not the subject.',
    apply(ctx) {
      // 0.03 km is the ship; the rig scales its orbit radius from this.
      rig.setCinematicSubject(subject, 0.03);
      rig.setMode('cinematic', true);
      rig.resetCinematic();
      rig.update(0, subject, stillOrientation, stillVelocity, ctx);
    },
    update(dt, ctx) {
      rig.update(dt, subject, stillOrientation, stillVelocity, ctx);
    },
  });
}
