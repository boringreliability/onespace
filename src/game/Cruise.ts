/**
 * The cruise drive, wired into the game.
 *
 * `CruiseDrive` owns the rules and knows nothing about the world; this owns the
 * key, reads the clearance out of `Universe`, and pushes the resulting ceiling
 * into `FlightModel`. One module, one owner — the same shape as `Scanner`, and
 * for the same reason: a feature split across two modules that each do half of
 * it is how this project has lost its days.
 *
 * Toggle rather than hold. A crossing takes half a minute and nobody should
 * have to keep a finger down for it.
 *
 * v2 phase 1 adds three things, all fed through the same two channels — the
 * drive's inputs and `FlightModel.command`:
 *
 * - **A radius-relative envelope.** The clearance arrives with the radius of
 *   the body it belongs to, so the opening orbit (0.62 R) can engage.
 * - **Arrival.** Closing on the locked target (else the nearest body), the
 *   drive drops at ~3 R and `insertIntoOrbit` leaves the ship in a circular
 *   orbit about its SOI parent. The lever is then held at idle until the pilot
 *   moves it, or the main drive would push the ship straight out of that orbit.
 * - **Steering.** With a target locked (`target:changed`), the nose is flown
 *   to the limb of the arrival sphere while spooling and cruising. Any pilot
 *   rotation input passes straight through.
 *
 * v3 (T3, PLAN §1 mechanism 3 and §2 A6): the insertion is flown, not cut.
 * It used to change the velocity's direction by ~30° (90° on a dead-radial
 * arrival) on one frame and teleport the attitude on the same frame. Now:
 *
 * - **During the drop** the nose — and with it the velocity the drive
 *   carries — is turned onto the insertion tangent at ≤ DROP_SLEW_RAD_S and
 *   ≤ 3° a frame, scheduled to arrive before the bleed ends. The drive is
 *   told `aligned` and waits (bounded) if the turn is not done, so the
 *   handover itself is a < 2° remainder.
 * - **After an arrival** D53's opening attitude (facing the world) is still
 *   the end state, reached by a settle at ≤ SETTLE_RATE_RAD_S with a rounded
 *   start and stop instead of a teleport. The pilot's stick ends it at once.
 *
 * Both turns are kinematic: part of the cruise model's one declared cheat
 * (`cruiseOrbit.ts`), which already bleeds 500c to orbital speed in 0.9 s.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { flightActivity } from '@/core/flightActivity'; // [v3-T1]
import { Matrix4, Quaternion, Vector3 } from 'three';
import { openingAttitude } from '@/game/recovery';

/** Sentinel: arrival is armed (the departure body no longer matters). */
const NOBODY: object = {};
import {
  CruiseDrive,
  arrivalClearanceKm,
  holdClearanceKm,
  type CruiseArrival,
  type CruiseBlock,
  type CruiseInputs,
} from '@/ship/CruiseDrive';
import { circularExitVelocity, circularSpeed, insertIntoOrbit } from '@/ship/cruiseOrbit';
import { steerToward } from '@/ship/cruiseSteer';
import type { Universe } from '@/game/Universe';
import { shotOwnsScene } from '@/game/Shots';
import { SOLAR_RADIUS } from '@/gen/types';
import { FIELD_RADIUS_KM } from '@/gen/belt';
import type { Belt } from '@/game/Belt';
import { beltFieldName } from '@/game/Belt';
import { announceAction, applyAction, canAfford, cruiseSpoolKg } from '@/ship/travelCost'; // [v4-fuel]

/** [v4-fuel] A long cruise leg is announced (`propellant:action`) at most this often, s. */
const LEG_ANNOUNCE_S = 1;

/** What the pilot is told when the drive refuses. */
const REFUSAL: Record<CruiseBlock, string> = {
  landed: 'CRUISE DENIED — ON THE GROUND',
  atmosphere: 'CRUISE DENIED — ATMOSPHERE',
  mass: 'CRUISE DENIED — MASS TOO CLOSE',
};

/** The part of `Universe` this module reads. Narrow, so it can be stubbed in node. */
export type CruiseWorld = Pick<
  Universe,
  'flight' | 'paused' | 'frozen' | 'nearestGapKm' | 'nearest' | 'allBodies' | 'system'
>;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type Body = ReturnType<Universe['allBodies']>[number];

/** Body ids on the bus are `body:<spec.name>` (track B owns emitting them). */
function bodyIdOf(b: Body): string {
  return `body:${b.spec.name}`;
}

/**
 * The limb the steering aims at, as a fraction of the arrival radius: the
 * straight line then passes inside the arrival sphere, so it is crossed while
 * still closing, at ~64° from radial — within ~26° of tangential.
 */
const LIMB_FRACTION = 0.9;

/**
 * Clearance the steering keeps from a world that stands between the ship and
 * its target, in multiples of that world's hold threshold — far enough above
 * the threshold that skirting it never trips a MASS drop.
 */
const OCCLUDER_HOLD_MARGIN = 1.5;

const DEG = Math.PI / 180;
/** v3: fastest the drop turns the nose onto the tangent, rad/s. */
const DROP_SLEW_RAD_S = 90 * DEG;
/** v3: never more than this per frame, whatever the frame rate (PLAN acceptance). */
const MAX_TURN_PER_FRAME = 2.9 * DEG; // a hair under the 3° the acceptance allows
/** v3: the handover waits until velocity and nose are this close to the tangent. */
const ALIGN_TOL = 0.75 * DEG;
/** v3: the post-arrival settle's top rate and its angular acceleration. */
const SETTLE_RATE_RAD_S = 40 * DEG;
const SETTLE_ACCEL_RAD_S2 = 60 * DEG;
/** Stick deflection that counts as the pilot taking the attitude back. */
const STICK_DEADZONE = 0.02;

const NOSE = new Vector3(0, 0, -1);
const ZERO3 = new Vector3();

export interface CruiseOptions {
  readonly universe: CruiseWorld;
  /**
   * [v4-mining] Resolves `field:` nav targets. Without it (or without a belt
   * in the system) a field target is ignored, exactly as before.
   */
  readonly belt?: Pick<Belt, 'fieldWorld'> | null;
}

/**
 * v3 polish (D22b): does the straight line from `ship` to `target` pass
 * inside a sphere of `safeKm` about `body`, with the body between them?
 * Pure; the geometry `Cruise.occluder` steers by and the readout reports.
 */
export function lineBlockedBy(ship: Vector3, target: Vector3, body: Vector3, safeKm: number): boolean {
  const tx = target.x - ship.x;
  const ty = target.y - ship.y;
  const tz = target.z - ship.z;
  const dT = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (dT < 1e-9) return false;
  const bx = body.x - ship.x;
  const by = body.y - ship.y;
  const bz = body.z - ship.z;
  const along = (bx * tx + by * ty + bz * tz) / dT;
  if (along <= 0 || along >= dT) return false;
  const perp2 = bx * bx + by * by + bz * bz - along * along;
  return perp2 < safeKm * safeKm;
}

export class Cruise implements GameModule {
  readonly name = 'cruise';

  readonly drive = new CruiseDrive();
  private readonly universe: CruiseWorld;
  private readonly belt: Pick<Belt, 'fieldWorld'> | null;
  /**
   * [v4-mining] A locked belt field, as the drive sees a target: a body of
   * radius FIELD_RADIUS_KM with no SOI. One object, reused (no allocation per
   * frame; `departedFrom` compares by identity).
   */
  private readonly fieldBody = {
    spec: { id: '', name: '', radius: FIELD_RADIUS_KM },
    world: new Vector3(),
    soiRadius: Number.POSITIVE_INFINITY,
    parent: null,
  };
  /** The field id `fieldBody`'s name was built for. */
  private fieldNamedFor: string | null = null;

  /** The toggle. Distinct from the drive's phase, which lags it by the spool. */
  private wanted = false;
  /** Last phase seen, so transitions are announced once rather than every frame. */
  private lastPhase = this.drive.phase;
  /** Rate-limits the refusal message; holding the key should not spam the log. */
  private refusedAt = -1e9;
  /** The locked target's id, from `target:changed`; resolved against the bodies each frame. */
  private targetId: string | null = null;
  /**
   * Lever position at the moment of an orbit insertion. While the lever stays
   * there the engine is held at idle; moving it hands the throttle back.
   */
  private heldLever: number | null = null;
  /**
   * Set by `system:entered`: the next frame captures the lever and holds the
   * engine at idle, exactly as after an orbit insertion. A jump arrives in an
   * orbit too, and FA-ON's speed hold would fly the ship out of it.
   */
  private holdOnNextFrame = false;
  private readonly offs: Array<() => void> = [];
  private readonly sRel = new Vector3();
  // Preallocated drive inputs (ARCHITECTURE §5: no allocation in update()).
  /** The body the drive was engaged beside, or NOBODY once that no longer matters. */
  private departedFrom: object | null = null;
  private readonly arrivalQuat = new Quaternion();
  // v3: the flown insertion.
  private readonly dropQuat = new Quaternion();
  private readonly sExit = new Vector3();
  private readonly sUp = new Vector3();
  private readonly sMat = new Matrix4();
  private readonly sFwd = new Vector3();
  /** Post-arrival settle towards `arrivalQuat` is running. */
  private settling = false;
  private settleRate = 0;
  /** The insertion orbit's plane normal, fixed when the drop starts. */
  private readonly dropNormal = new Vector3();
  private dropPlaneSet = false;
  /** [v4-fuel] Where the ship was at the last cruise frame, to bill the distance. */
  private readonly lastCruisePos = new Vector3();
  private haveLastCruisePos = false;
  /** [v4-fuel] The tank ran dry this frame: the drop that follows says so. */
  private ranDry = false;
  /** [v4-fuel] Spool price paid for the charge in progress; refunded if it never reaches cruise. */
  private spoolPaidKg = 0;

  /**
   * [v4-fuel] The cruise leg segment being billed. The tank is billed every
   * frame (exact, by sim distance); the `propellant:action` for it is
   * announced once per segment — when cruise ends, or every LEG_ANNOUNCE_S.
   */
  private legKm = 0;
  private legKg = 0;
  private legOk = true;
  private legAge = 0;

  private refundSpool(): void {
    const tank = this.universe.flight.propellant;
    if (tank && this.spoolPaidKg > 0) applyAction(tank, { kind: 'spool-refund', kg: this.spoolPaidKg });
    this.spoolPaidKg = 0;
  }

  /** Announce the leg billed so far as one named action, and start a new segment. */
  private flushLeg(): void {
    if (this.legKm > 0 || this.legKg > 0) {
      announceAction({ kind: 'cruise-leg', distanceKm: this.legKm }, { ok: this.legOk, kg: this.legKg });
    }
    this.legKm = 0;
    this.legKg = 0;
    this.legOk = true;
    this.legAge = 0;
  }

  private readonly arrivalIn: Mutable<CruiseArrival> = {
    clearanceKm: 0,
    radiusKm: 0,
    soiRadiusKm: 0,
    closing: false,
  };
  private readonly driveIn: Mutable<CruiseInputs> = {
    requested: false,
    clearanceKm: 0,
    grounded: false,
    atmosphericDensity: 0,
    nearestRadiusKm: 0,
    arrival: null,
    exitSpeedKmS: undefined,
    limitKm: undefined,
    arrivalFirst: false,
  };

  constructor(opts: CruiseOptions) {
    this.universe = opts.universe;
    this.belt = opts.belt ?? null;
  }

  init(): void {
    // Leaving a system, or being put somewhere by the chart, must not leave a
    // drive running against a world that no longer exists.
    this.offs.push(
      bus.on('system:entered', () => {
        this.cancel();
        this.holdOnNextFrame = true;
        // Physics runs before Pilot and this module next frame; without this
        // that step still flies the old lever into the arrival orbit.
        this.universe.flight.command.throttle = 0;
      }),
      bus.on('warp:engaged', () => this.cancel()),
      // review-p1: the recovery cut teleports the ship into an orbit; a drive
      // left running carries it straight back out (playtest: e = 0.997).
      bus.on('ship:recovered', () => this.cancel()),
      bus.on('target:changed', (e) => {
        this.targetId = e.id;
      }),
    );
  }

  dispose(): void {
    this.flushLeg();
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  /**
   * v3: the drive is doing something, or the ship is still being turned to
   * face the world after an arrival. The autopilot's L queue waits on it.
   */
  get busy(): boolean {
    return this.drive.phase !== 'idle' || this.settling;
  }

  /**
   * v3 polish (D22b): the world the drive is steering round to reach the
   * locked target, or null while the line is clear (or nothing is steered).
   * The cruise readout shows it instead of an ETA it cannot honestly give.
   */
  get skirting(): string | null {
    return this._skirting;
  }
  private _skirting: string | null = null;

  /**
   * The insertion attitude: nose along the tangent the handover will use,
   * roof radial-out. False when there is nothing to orbit (no turn to fly).
   */
  private insertionAttitude(out: Quaternion): boolean {
    const flight = this.universe.flight;
    this.sUp.copy(flight.position).normalize();
    if (!this.dropPlaneSet) {
      // The orbit plane is chosen ONCE, at the start of the drop, from the
      // velocity as it was. Re-deriving it every frame from a velocity that
      // the turn itself is moving made the target chase the nose (measured:
      // a 90° turn still circling after 2.5 s).
      circularExitVelocity(flight, this.sExit);
      if (this.sExit.lengthSq() === 0) return false;
      this.dropNormal.crossVectors(this.sUp, this.sExit);
      if (this.dropNormal.lengthSq() < 1e-24) return false;
      this.dropNormal.normalize();
      this.dropPlaneSet = true;
    }
    // Prograde in that plane where the ship is now; roof radial-out.
    this.sFwd.crossVectors(this.dropNormal, this.sUp).normalize();
    this.sMat.lookAt(ZERO3, this.sFwd, this.sUp);
    out.setFromRotationMatrix(this.sMat).normalize();
    return true;
  }

  /** Turn the hull towards `target` by at most `maxStep` rad; returns the angle left. */
  private turnToward(target: Quaternion, maxStep: number): number {
    const flight = this.universe.flight;
    const q = flight.orientation;
    const angle = q.angleTo(target);
    if (angle <= maxStep || angle < 1e-9) q.copy(target);
    else q.slerp(target, maxStep / angle);
    q.normalize();
    // The turn is the drive's; nothing else spins the hull meanwhile.
    flight.angularVelocity.set(0, 0, 0);
    return Math.max(0, angle - maxStep);
  }

  private pilotOnStick(ctx: EngineContext): boolean {
    const a = ctx.input.axes;
    return Math.abs(a.pitch) > STICK_DEADZONE || Math.abs(a.yaw) > STICK_DEADZONE || Math.abs(a.roll) > STICK_DEADZONE;
  }

  private target(): Body | null {
    const id = this.targetId;
    if (id === null) return null;
    // [v4-mining] A belt field: closed on like a body of radius FIELD_RADIUS_KM.
    if (id.startsWith('field:')) return this.fieldTarget(id);
    // A loop, not `.find(closure)`: this runs every frame.
    const bodies = this.universe.allBodies();
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]!;
      if (b.spec.id === id || (id.startsWith('body:') && id.length === b.spec.name.length + 5 && id.endsWith(b.spec.name))) {
        return b;
      }
    }
    return null;
  }

  /** [v4-mining] The locked field as a target, or null (no belt, unknown id). */
  private fieldTarget(id: string): Body | null {
    const fb = this.fieldBody;
    if (!this.belt || !this.belt.fieldWorld(id, fb.world)) return null;
    if (this.fieldNamedFor !== id) {
      // Allocates once per new target, never per frame.
      this.fieldNamedFor = id;
      fb.spec.id = id;
      fb.spec.name = beltFieldName(this.universe.system?.name ?? '', Number(id.slice(id.lastIndexOf(':') + 1)));
    }
    return fb as unknown as Body;
  }

  /**
   * Radius of whatever `nearestGapKm` is measured to: the nearest body, or the
   * star when that is closer. Universe folds the star into the gap without
   * saying so; comparing the two gaps recovers which it was.
   */
  private nearestRadiusKm(): number {
    const u = this.universe;
    const b = u.nearest;
    const starR = (u.system.stars[0]?.radius ?? 0) * SOLAR_RADIUS;
    if (!b) return starR;
    const bodyGap = this.sRel.subVectors(u.flight.worldPosition, b.world).length() - b.spec.radius;
    return u.nearestGapKm < bodyGap - Math.max(1, bodyGap * 1e-6) ? starR : b.spec.radius;
  }

  update(dt: number, ctx: EngineContext): void {
    // [v3-T1] camera FOV breathing + governor hold read this (core/flightActivity.ts).
    flightActivity.cruise = this.busy; flightActivity.cruiseSpool = this.drive.phase === 'idle' ? 0 : this.drive.progress;
    if (shotOwnsScene()) {
      if (this.wanted) this.cancel();
      return;
    }
    // review-p1: the galaxy chart (`paused`) and the pause sheet or recovery
    // fade (`frozen`) stop the world; the drive stands still with it. It used
    // to CANCEL here, and setCruise(null) keeps the velocity — a cruise-speed
    // state vector (10^3–10^5 km/s) handed to Newtonian flight on close.
    if (this.universe.paused || this.universe.frozen) return;

    const flight = this.universe.flight;

    if (ctx.input.pressed('cruise')) {
      this.wanted = !this.wanted;
      if (this.wanted) this.refusedAt = -1e9;
    }
    // Landing, or asking for an interstellar jump, means you are done cruising.
    if (ctx.input.pressed('land') || ctx.input.pressed('warp')) this.wanted = false;

    // [v4-fuel] Cruise is paid for out of the tank (a hull without one flies free).
    const tank = flight.propellant;
    if (tank) {
      // The distance flown under cruise since last frame (the physics step that
      // just ran). Running dry releases the toggle: the drive drops normally.
      if (this.drive.phase === 'cruise' && this.haveLastCruisePos) {
        const km = flight.worldPosition.distanceTo(this.lastCruisePos);
        const leg = applyAction(tank, { kind: 'cruise-leg', distanceKm: km }, { announce: false });
        this.legKm += km;
        this.legKg += leg.kg;
        this.legAge += dt;
        if (!leg.ok) {
          this.legOk = false;
          this.wanted = false;
          this.ranDry = true;
        }
        if (!leg.ok || this.legAge >= LEG_ANNOUNCE_S) this.flushLeg();
      }
      // Refuse to spool what cannot be paid for.
      if (this.wanted && this.drive.phase === 'idle' && !canAfford(tank, cruiseSpoolKg(tank.baseCapacityKg))) {
        this.wanted = false;
        if (ctx.elapsed - this.refusedAt > 3) {
          this.refusedAt = ctx.elapsed;
          bus.emit('log', { text: 'CRUISE · NO PROPELLANT', tone: 'warn' });
        }
      }
    }

    // What the drive is closing on: the locked target, else the nearest body.
    const target = this.target();
    const toward = target ?? this.universe.nearest;
    let arrival: CruiseArrival | null = null;
    let limbKm = 0;
    // [v4-mining] A field is no mass: its gap limits the ceiling, not the envelope.
    const toField = target !== null && target === (this.fieldBody as unknown as Body);
    let limitKm: number | undefined;
    if (toward) {
      const rel = this.sRel.subVectors(toward.world, flight.worldPosition);
      const radius = toward.spec.radius;
      const a = this.arrivalIn;
      a.clearanceKm = rel.length() - radius;
      a.radiusKm = radius;
      a.soiRadiusKm = toward.soiRadius;
      a.closing = flight.forward.dot(rel) > 0;
      // Arrival at the world the drive was engaged beside is only armed once
      // the ship has been out past the arrival sphere. Otherwise G from the
      // opening orbit (nose 30° down, so "closing") dropped at once — 2 s of
      // spool for an ORBIT log at the world the pilot was leaving.
      const arriveKm = arrivalClearanceKm(radius, toward.soiRadius, this.drive.config);
      if (this.drive.phase === 'idle') {
        // Not running: the next engage records where it starts from.
        this.departedFrom = null;
      } else {
        if (this.departedFrom === null) this.departedFrom = toward;
        if (toward !== this.departedFrom || a.clearanceKm > arriveKm * 1.05) this.departedFrom = NOBODY;
      }
      arrival = this.departedFrom === toward ? null : a;
      limbKm = LIMB_FRACTION * (radius + arrivalClearanceKm(radius, toward.soiRadius, this.drive.config));
      if (toField) limitKm = a.clearanceKm;
    }

    const wasEngaged = this.drive.engaged;
    const wasPhase = this.drive.phase;
    const di = this.driveIn;
    di.requested = this.wanted;
    di.clearanceKm = this.universe.nearestGapKm;
    di.grounded = flight.grounded;
    di.atmosphericDensity = flight.atmosphericDensity;
    di.nearestRadiusKm = this.nearestRadiusKm();
    di.arrival = arrival;
    di.limitKm = limitKm;
    di.arrivalFirst = toField;
    di.exitSpeedKmS = circularSpeed(flight.parent?.mu ?? 0, flight.position.length()) || undefined;
    // v3: during the drop, is the carried velocity (and the nose) on the
    // insertion tangent yet? The drive waits for it.
    let haveDropTarget = false;
    di.aligned = undefined;
    if (this.drive.phase !== 'dropping') this.dropPlaneSet = false;
    if (this.drive.phase === 'dropping') {
      haveDropTarget = this.insertionAttitude(this.dropQuat);
      if (haveDropTarget) {
        this.sFwd.copy(NOSE).applyQuaternion(this.dropQuat);
        const velOff = flight.velocity.lengthSq() > 1e-18 ? flight.velocity.angleTo(this.sFwd) : 0;
        di.aligned = velOff < ALIGN_TOL && flight.orientation.angleTo(this.dropQuat) < ALIGN_TOL;
      }
    }
    this.drive.update(dt, di);
    // [v4-fuel] The spool is paid when the drive actually starts to spool
    // (affordability was checked above, so a blocked request costs nothing).
    if (tank && wasPhase !== 'spooling' && this.drive.phase === 'spooling') {
      const paid = applyAction(tank, { kind: 'cruise-spool' });
      if (paid.ok) {
        this.spoolPaidKg = paid.kg;
      } else {
        this.wanted = false;
        this.drive.reset();
        flight.setCruise(null);
      }
    }
    // R12: a charge that never became cruise (released, mass-lock) is refunded;
    // once the drive engages the spool is spent.
    if (this.drive.phase === 'cruise') this.spoolPaidKg = 0;
    else if (wasPhase === 'spooling' && this.drive.phase === 'idle') this.refundSpool();
    if (this.drive.phase === 'cruise') {
      this.lastCruisePos.copy(flight.worldPosition);
      this.haveLastCruisePos = true;
    } else {
      this.haveLastCruisePos = false;
      this.flushLeg(); // the segment ends with cruise
    }
    // A drop is an answer, not a pause: whatever started it, the toggle is
    // released so the drive does not spool up again by itself.
    if (wasPhase === 'cruise' && this.drive.phase === 'dropping') {
      this.wanted = false;
      // An obstacle drop used to read only CRUISE DISENGAGED: say why.
      const why = this.drive.dropReason;
      if (this.ranDry) {
        bus.emit('log', { text: 'CRUISE DROPPED — NO PROPELLANT', tone: 'warn' });
      } else if (why === 'mass' || why === 'atmosphere') {
        bus.emit('log', { text: why === 'mass' ? 'CRUISE DROPPED — MASS LOCK' : 'CRUISE DROPPED — ATMOSPHERE', tone: 'warn' });
      }
    }
    if (this.drive.phase !== 'cruise') this.ranDry = false;

    if (wasEngaged && !this.drive.engaged) {
      // The handover. In orbit if there is anything to orbit, else the
      // legacy sublight exit along the nose.
      // v3: along the tangent the drop has been flying to, when it had one.
      if (insertIntoOrbit(flight, this.dropPlaneSet ? this.sFwd.crossVectors(this.dropNormal, this.sUp.copy(flight.position).normalize()) : undefined)) {
        this.dropPlaneSet = false;
        this.heldLever = ctx.input.axes.throttle;
        if (this.drive.dropReason === 'arrival' && toward) {
          // Face the world, as the opening frame does: the insertion kept the
          // approach attitude and the arrival — the game's money shot — was
          // framed on empty sky (review-p1, ARCHITECTURE §6). v3: reached by
          // a settle over the next ~1.5 s, not a teleport on this frame.
          openingAttitude(flight.velocity, flight.position, this.arrivalQuat);
          this.settling = true;
          this.settleRate = 0;
          bus.emit('log', { text: `ORBIT — ${toward.spec.name.toUpperCase()}`, tone: 'good' });
        }
      } else {
        flight.setCruise(null);
      }
    } else {
      // The flight model is told the ceiling, not the phase. It has no opinion
      // about why it is allowed to go fast.
      flight.setCruise(this.drive.engaged ? this.drive.capKmS : null);
    }

    // v3: fly the nose onto the insertion tangent while the drop bleeds.
    if (this.drive.phase === 'dropping') {
      if (!haveDropTarget) haveDropTarget = this.insertionAttitude(this.dropQuat);
      if (haveDropTarget) {
        const c = this.drive.config;
        // Time left in the bleed, less two frames so the velocity (which
        // follows the nose one integration later) is on it too.
        const left = Math.max(this.drive.progress * c.dropTime - 2 * dt, dt);
        const angle = flight.orientation.angleTo(this.dropQuat);
        const scheduled = (angle * dt) / left;
        // The last degrees ease in (a third of what is left), so the frame the
        // drive lets go never follows a full-rate step.
        const step = Math.min(Math.max(scheduled, 0.25 * DROP_SLEW_RAD_S * dt), DROP_SLEW_RAD_S * dt, MAX_TURN_PER_FRAME, 0.35 * angle + 0.1 * DEG);
        this.turnToward(this.dropQuat, step);
        flight.command.pitch = 0;
        flight.command.yaw = 0;
        flight.command.roll = 0;
      }
    }

    // v3: the post-arrival settle to the opening attitude (D53's end state).
    if (this.settling) {
      if (this.pilotOnStick(ctx) || this.drive.phase !== 'idle' || flight.cruising) {
        this.settling = false;
      } else {
        const angle = flight.orientation.angleTo(this.arrivalQuat);
        // Rounded start (accel-limited) and stop (√ of the angle left).
        const stopRate = Math.sqrt(2 * SETTLE_ACCEL_RAD_S2 * angle);
        this.settleRate = Math.min(this.settleRate + SETTLE_ACCEL_RAD_S2 * dt, SETTLE_RATE_RAD_S, Math.max(stopRate, 0.5 * DEG));
        const left = this.turnToward(this.arrivalQuat, Math.min(this.settleRate * dt, MAX_TURN_PER_FRAME));
        if (left < 0.01 * DEG) this.settling = false;
      }
    }

    // Steering to the locked target, while charging and while carried — not
    // during the drop, whose direction is the insertion's business.
    this._skirting = null;
    if (target && (this.drive.phase === 'spooling' || this.drive.phase === 'cruise')) {
      // review-p1: the straight line to the target often runs through the
      // world being orbited (the playtest's Vassa sat behind Remit 31). The
      // drive then flew into it and dropped for MASS at 0.3 R, unexplained.
      // While a world is in the way, skirt it along the tangent of a sphere
      // safely above its hold threshold; once the line is clear, aim as before.
      const occ = this.occluder(target);
      this._skirting = occ ? occ.spec.name : null;
      if (occ) {
        steerToward(flight, occ.world, occ.spec.radius + OCCLUDER_HOLD_MARGIN * holdClearanceKm(occ.spec.radius, this.drive.config));
      } else {
        steerToward(flight, target.world, limbKm);
      }
    }

    // NAV hold (review-p1). Under cruise the flight model flies `ceiling ×
    // lever`, and since FA-ON the lever's resting place is its coast detent:
    // spawn, recovery and every arrival leave it at exactly 0. G then engaged
    // a drive that carried the ship at 0 m/s, forever. At the detent the drive
    // rides the ceiling; any other lever position still picks a fraction of
    // it, and Space at the detent still holds the ship still to turn on the spot.
    if (this.drive.engaged && flight.command.throttle <= 0 && !flight.command.brake) {
      flight.command.throttle = 1;
    }

    if (this.holdOnNextFrame) {
      this.holdOnNextFrame = false;
      if (this.drive.phase === 'idle') this.heldLever = ctx.input.axes.throttle;
    }

    // Engine held at idle after an insertion until the lever moves. Runs after
    // Pilot, which has already copied the lever into the command this frame.
    if (this.heldLever !== null) {
      if (ctx.input.axes.throttle !== this.heldLever || this.drive.phase !== 'idle') {
        this.heldLever = null;
      } else {
        flight.command.throttle = 0;
      }
    }

    this.announce(ctx);
  }

  /**
   * The nearest world, if it stands between the ship and `target`: nearer
   * than the target along the line of sight, and the line passing inside its
   * safe sphere. Only the nearest is checked — it is the one a fast drive
   * would hit first, and the check stays O(1) per frame.
   */
  private occluder(target: Body): Body | null {
    const b = this.universe.nearest;
    if (!b || b === target) return null;
    const safe = b.spec.radius + OCCLUDER_HOLD_MARGIN * holdClearanceKm(b.spec.radius, this.drive.config);
    return lineBlockedBy(this.universe.flight.worldPosition, target.world, b.world, safe) ? b : null;
  }

  /** Stop wanting it, and let go this frame rather than easing out. */
  private cancel(): void {
    this.wanted = false;
    this.heldLever = null;
    this.settling = false;
    this._skirting = null;
    this.haveLastCruisePos = false;
    this.flushLeg();
    this.ranDry = false;
    // A charge cut short (jump, new system, recovery) never became cruise.
    if (this.drive.phase === 'spooling') this.refundSpool();
    this.spoolPaidKg = 0;
    this.drive.reset();
    this.universe.flight.setCruise(null);
    this.lastPhase = 'idle';
  }

  private announce(ctx: EngineContext): void {
    const d = this.drive;

    if (d.phase !== this.lastPhase) {
      if (d.phase === 'spooling') {
        bus.emit('log', { text: 'CRUISE — SPOOLING', tone: 'normal' });
      } else if (d.phase === 'cruise') {
        bus.emit('log', { text: 'CRUISE ENGAGED', tone: 'good' });
        bus.emit('camera:shake', { intensity: 0.35, duration: 0.5 });
      } else if (d.phase === 'idle' && this.lastPhase === 'dropping') {
        bus.emit('log', { text: 'CRUISE DISENGAGED', tone: 'normal' });
      }
      this.lastPhase = d.phase;
    }

    // The drop is latched inside the drive so the shake fires once even though
    // the phase change and the drop can land on the same frame.
    if (d.takeDropEvent()) {
      bus.emit('camera:shake', { intensity: 0.6, duration: 0.8 });
    }

    // Refusals are only worth saying when the pilot actually asked.
    if (this.wanted && d.phase === 'idle' && d.blocked !== null) {
      if (ctx.elapsed - this.refusedAt > 3) {
        this.refusedAt = ctx.elapsed;
        bus.emit('log', { text: REFUSAL[d.blocked], tone: 'warn' });
      }
      // A refusal is an answer, not a queue: drop the request so the drive
      // does not engage by itself the moment the obstacle clears.
      this.wanted = false;
    }
  }
}
