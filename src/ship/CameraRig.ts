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

export type CameraMode = 'cockpit' | 'chase' | 'cinematic' | 'orbit';

/** The order `cycleMode()` walks. Chase first: it is the default flight view. */
const MODE_ORDER: readonly CameraMode[] = ['chase', 'cockpit', 'orbit', 'cinematic'];

/** Radians the chase aim may deviate from the nose towards the velocity. ~11 deg. */
const MAX_VELOCITY_AIM_ANGLE = 0.19;

const TWO_PI = Math.PI * 2;
const EPS = 1e-4;

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

// ---------------------------------------------------------------------------
// Noise for shake
// ---------------------------------------------------------------------------

/** Cheap 1-D hash. Adequate for shake; never used for world generation. */
function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** Smoothed value noise in -1..1. */
function valueNoise1(x: number, seed: number): number {
  const o = seed * 57.31;
  const i = Math.floor(x + o);
  const f = x + o - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i);
  const b = hash1(i + 1);
  return (a + (b - a) * u) * 2 - 1;
}

/**
 * Three octaves at deliberately irrational frequency ratios. A shake built from
 * sines — or from octaves at exact powers of two — beats audibly and reads as a
 * machine wobble; these never come back into phase.
 */
function shakeNoise(t: number, seed: number): number {
  return (
    valueNoise1(t * 11.0, seed) * 0.62 +
    valueNoise1(t * 23.7, seed + 7) * 0.26 +
    valueNoise1(t * 51.3, seed + 19) * 0.12
  );
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
   * Orientation runs slower than position — this ratio is the whole reason a
   * chase cam feels like a gimballed drone rather than a stick welded to the
   * hull. Below ~0.6 it starts to feel seasick.
   */
  chaseOrientationLagRatio = 0.42;

  /** Damping ratio of the aim spring. Slightly over-damped: aim never rings. */
  chaseOrientationDamping = 1.15;

  /** How slowly camera roll follows hull roll. Slowest system in the rig. */
  chaseRollLagRatio = 0.26;

  /** Follow offset in ship-local space, km. +Z is behind (three.js looks -Z). */
  readonly chaseOffset = new Vector3(0, 0.0085, 0.052);

  /** Hard ceiling on trailing distance, km, so the ship never leaves frame. */
  chaseMaxLag = 0.045;

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

  // --- tuning: fov breathing ----------------------------------------------

  /** Base and wide-open vertical fov, degrees, for the flight views. */
  fovBase = 62;
  fovWide = 78;
  /** Cockpit sits closer to the glass, so it runs wider. */
  cockpitFovBase = 68;
  cockpitFovWide = 84;
  /**
   * Speed at which the fov is ~63% of the way open. A saturating curve is used
   * rather than a clamped ratio so the effect degrades gracefully whether the
   * ship is doing 0.2 km/s in orbit or 400 km/s across a system.
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
  /** Acceleration (km/s^2) at which the continuous thrust rumble is at full. */
  shakeAccelReference = 0.35;
  /** Ceiling on the continuous component so thrust never masks a real impact. */
  shakeThrustCeiling = 0.3;

  // --- tuning: transitions -------------------------------------------------

  /** Mode cross-fade duration, seconds. Never cut. */
  transitionSeconds = 0.6;

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

  // chase state (render space)
  private readonly chasePos = new Vector3();
  private readonly chaseVel = new Vector3();
  private readonly chaseAnchor = new Vector3();
  private readonly chaseAnchorPrev = new Vector3();
  private readonly chaseAnchorVel = new Vector3();
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

  // cinematic state
  private readonly cinematicSubject = new Vector3();
  private cinematicSubjectSet = false;
  private cinematicRadius = 0.03;

  // derived per-frame values
  private readonly prevShipVel = new Vector3();
  private readonly accel = new Vector3();
  private readonly accelSmooth = new Vector3();
  private speedEase = 0;

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
    this.fovBase = camera.fov;
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
      this.snapTo(shipPosition, shipOrientation, shipVelocity);
      this.initialised = true;
    }

    const step = Math.max(dt, 0);
    this.time += step;
    this.cinematicTime += step;

    // A warp or a scale change teleports the ship. Chasing that across a spring
    // would take minutes and look like a bug, so re-seat instead.
    if (this.chasePos.distanceToSquared(shipPosition) > 2500) {
      this.snapTo(shipPosition, shipOrientation, shipVelocity);
    }

    this.updateDerived(step, shipVelocity);
    this.stepChase(step, shipPosition, shipOrientation, shipVelocity);
    this.stepCockpit(step, shipPosition, shipOrientation, ctx);
    this.stepCinematic(shipPosition);
    this.stepOrbit(step, shipPosition, ctx);

    // Cross-fade. Every mode's pose is solved every frame — they are a handful
    // of springs each — so a transition is a plain interpolation with no state
    // to warm up and no direction it cannot be reversed in.
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + step / Math.max(this.transitionSeconds, 1e-3));
    }
    const to = this.poseFor(this.mode_);
    if (this.blendT >= 1) {
      this.poseOut.copy(to);
    } else {
      this.poseOut.lerpFrom(this.poseFor(this.blendFrom), to, smootherstep(this.blendT));
    }

    this.applyShake(step);
    this.commit();
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
    this.chasePos.sub(d);
    this.chaseAnchor.sub(d);
    this.chaseAnchorPrev.sub(d);
    this.orbitTarget.sub(d);
    this.cinematicSubject.sub(d);
    this.poseOut.position.sub(d);
  }

  private snapTo(shipPosition: Vector3, q: Quaternion, vel: Vector3): void {
    this.chaseAnchor.copy(this.chaseOffset).applyQuaternion(q).add(shipPosition);
    this.chaseAnchorPrev.copy(this.chaseAnchor);
    this.chaseAnchorVel.set(0, 0, 0);
    this.chasePos.copy(this.chaseAnchor);
    this.chaseVel.set(0, 0, 0);
    this.chaseAim.set(0, 0, -1).applyQuaternion(q);
    this.chaseAimVel.set(0, 0, 0);
    this.chaseUp.set(0, 1, 0).applyQuaternion(q);
    this.chaseUpVel.set(0, 0, 0);
    this.cockpitNudge.set(0, 0, 0);
    this.cockpitNudgeVel.set(0, 0, 0);
    this.prevShipVel.copy(vel);
    this.accel.set(0, 0, 0);
    this.accelSmooth.set(0, 0, 0);
    this.impulseTrauma = 0;
    this.thrustTrauma = 0;
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

  /** Acceleration, speed and the eased fov factor — shared by several modes. */
  private updateDerived(dt: number, shipVelocity: Vector3): void {
    if (dt > 1e-6) {
      this.accel.copy(shipVelocity).sub(this.prevShipVel).divideScalar(dt);
      // Finite-differenced acceleration is noisy; a short low-pass keeps the
      // cockpit nudge and the thrust rumble from buzzing on a jittery frame.
      const k = 1 - Math.exp(-dt / 0.08);
      this.accelSmooth.lerp(this.accel, k);
    }
    this.prevShipVel.copy(shipVelocity);

    const speed = shipVelocity.length();
    // Saturating rather than clamped: works at 0.2 km/s and at 400 km/s.
    const target = 1 - Math.exp(-speed / Math.max(this.speedReference, 1e-3));
    const tau = Math.max(this.fovEaseSeconds, 1e-3) / 3;
    this.speedEase += (target - this.speedEase) * (dt > 0 ? 1 - Math.exp(-dt / tau) : 0);
  }

  // -- chase ---------------------------------------------------------------

  private stepChase(dt: number, shipPosition: Vector3, q: Quaternion, vel: Vector3): void {
    this.chaseAnchorPrev.copy(this.chaseAnchor);
    this.chaseAnchor.copy(this.chaseOffset).applyQuaternion(q).add(shipPosition);

    if (dt > 1e-6) {
      this.chaseAnchorVel.copy(this.chaseAnchor).sub(this.chaseAnchorPrev).divideScalar(dt);

      // Solve the spring in the anchor's frame. `r` is where the camera sits
      // relative to where it *should* sit; `rv` is how fast that gap is
      // changing. Because rv is measured against the anchor's velocity, a
      // constant cruise leaves the gap at zero while a change in the anchor's
      // velocity injects exactly the pseudo-force that shoves the camera back.
      const r = this.tmpA.copy(this.chasePos).sub(this.chaseAnchorPrev);
      const rv = this.tmpB.copy(this.chaseVel).sub(this.chaseAnchorVel);

      this.spring.compute(dt, this.chaseFrequency, this.chaseDamping);
      this.spring.stepToZero(r, rv);

      // Ceiling on the trail, or a violent burn would put the ship off screen.
      const len = r.length();
      if (len > this.chaseMaxLag) {
        r.multiplyScalar(this.chaseMaxLag / len);
        // Kill only the outward part of the relative velocity: the camera may
        // still recover inward, it just cannot fall further behind.
        const radial = rv.dot(r) / (this.chaseMaxLag * this.chaseMaxLag);
        if (radial > 0) rv.addScaledVector(r, -radial);
      }

      this.chasePos.copy(this.chaseAnchor).add(r);
      this.chaseVel.copy(this.chaseAnchorVel).add(rv);
    }

    // Aim: nose vector eased towards the velocity vector, so a ship travelling
    // sideways is framed sideways and the drift is legible.
    const nose = this.tmpA.set(0, 0, -1).applyQuaternion(q);
    const speed = vel.length();
    let align = this.velocityAlign * this.speedEase;
    if (align > 1e-3 && speed > 1e-5) {
      const vdir = this.tmpB.copy(vel).divideScalar(speed);
      // Cap how far the aim may leave the nose.
      //
      // The blend exists so thrust-induced drift is legible. In ORBIT the
      // velocity is permanently perpendicular to a nose pointed at the world
      // below, so an uncapped 0.55 blend swings the aim ~30 degrees and parks
      // the ship a quarter of the screen off-centre for as long as you are in
      // orbit — with the HUD boresight still dead ahead. Limit the deviation
      // so the subject never leaves the middle third; drift still reads,
      // the ship stays framed.
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

    const aimPoint = this.tmpC.copy(nose).multiplyScalar(this.chaseLookAhead).add(shipPosition);
    const wantAim = this.tmpD.copy(aimPoint).sub(this.chasePos);
    const al = wantAim.length();
    if (al > 1e-9) wantAim.divideScalar(al);

    if (dt > 1e-6) {
      this.spring.compute(
        dt,
        this.chaseFrequency * this.chaseOrientationLagRatio,
        this.chaseOrientationDamping,
      );
      this.spring.step(this.chaseAim, this.chaseAimVel, wantAim);
      const l = this.chaseAim.length();
      if (l > 1e-9) this.chaseAim.divideScalar(l);

      // Roll lags slowest of all. Rolling the ship and watching the horizon
      // follow a beat later is most of the "heavy machine" read.
      const wantUp = this.tmpA.set(0, 1, 0).applyQuaternion(q);
      this.spring2.compute(dt, this.chaseFrequency * this.chaseRollLagRatio, 1.0);
      this.spring2.step(this.chaseUp, this.chaseUpVel, wantUp);
      const ul = this.chaseUp.length();
      if (ul > 1e-9) this.chaseUp.divideScalar(ul);
    }

    this.poseChase.position.copy(this.chasePos);
    this.lookRotation(this.poseChase.quaternion, this.chasePos, this.chaseAim, this.chaseUp);
    this.poseChase.fov = this.fovBase + (this.fovWide - this.fovBase) * this.speedEase;
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
    const local = this.tmpA.copy(this.accelSmooth).applyQuaternion(
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

    this.poseCockpit.fov =
      this.cockpitFovBase + (this.cockpitFovWide - this.cockpitFovBase) * this.speedEase;
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

  private stepOrbit(dt: number, shipPosition: Vector3, ctx: EngineContext): void {
    if (!this.orbitTargetSet) {
      this.orbitDistance = 0.2;
      this.orbitDistanceCur = 0.2;
      this.orbitTargetSet = true;
    }
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

    const ce = Math.cos(this.orbitElevationCur);
    const pos = this.poseOrbit.position;
    pos
      .set(Math.sin(this.orbitAzimuthCur) * ce, Math.sin(this.orbitElevationCur), Math.cos(this.orbitAzimuthCur) * ce)
      .multiplyScalar(Math.max(this.orbitDistanceCur, 1e-4))
      .add(this.orbitTarget);

    const dir = this.tmpA.copy(this.orbitTarget).sub(pos);
    const l = dir.length();
    if (l > 1e-9) dir.divideScalar(l);
    else dir.set(0, 0, -1);
    this.lookRotation(this.poseOrbit.quaternion, pos, dir, this.tmpB.set(0, 1, 0));
    this.poseOrbit.fov = this.orbitFov;
  }

  // -- shake ---------------------------------------------------------------

  private applyShake(dt: number): void {
    if (this.impulseTrauma > 0) {
      this.impulseTrauma = Math.max(0, this.impulseTrauma - this.impulseDecay * dt);
    }

    // Continuous rumble under thrust, tracking the smoothed acceleration.
    const accelMag = this.accelSmooth.length();
    const want =
      clamp(accelMag / Math.max(this.shakeAccelReference, 1e-6), 0, 1) * this.shakeThrustCeiling;
    this.thrustTrauma += (want - this.thrustTrauma) * (dt > 0 ? 1 - Math.exp(-dt / 0.12) : 0);

    const trauma = clamp(this.impulseTrauma + this.thrustTrauma, 0, 1);
    if (trauma <= 1e-4) return;

    // Squared envelope: a shake that fades linearly is obvious in its last
    // third. Squared, the tail disappears before you can name the moment.
    const env = trauma * trauma;
    const t = this.time;

    const tr = this.tmpA.set(
      shakeNoise(t, 1) * this.shakeTranslation * env,
      shakeNoise(t, 2) * this.shakeTranslation * env,
      shakeNoise(t, 3) * this.shakeTranslation * env * 0.6,
    );
    // Translate in camera-local axes so shake reads the same at any heading.
    tr.applyQuaternion(this.poseOut.quaternion);
    this.poseOut.position.add(tr);

    this.tmpE.set(
      shakeNoise(t, 4) * this.shakeRotation * env,
      shakeNoise(t, 5) * this.shakeRotation * env,
      shakeNoise(t, 6) * this.shakeRotation * this.shakeRollScale * env,
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
