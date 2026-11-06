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
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { Vector3 } from 'three';
import {
  CruiseDrive,
  arrivalClearanceKm,
  holdClearanceKm,
  type CruiseArrival,
  type CruiseBlock,
  type CruiseInputs,
} from '@/ship/CruiseDrive';
import { circularSpeed, insertIntoOrbit } from '@/ship/cruiseOrbit';
import { steerToward } from '@/ship/cruiseSteer';
import type { Universe } from '@/game/Universe';
import { shotOwnsScene } from '@/game/Shots';
import { SOLAR_RADIUS } from '@/gen/types';

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

export interface CruiseOptions {
  readonly universe: CruiseWorld;
}

export class Cruise implements GameModule {
  readonly name = 'cruise';

  readonly drive = new CruiseDrive();
  private readonly universe: CruiseWorld;

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
  };

  constructor(opts: CruiseOptions) {
    this.universe = opts.universe;
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
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  private target(): Body | null {
    const id = this.targetId;
    if (id === null) return null;
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

    // What the drive is closing on: the locked target, else the nearest body.
    const target = this.target();
    const toward = target ?? this.universe.nearest;
    let arrival: CruiseArrival | null = null;
    let limbKm = 0;
    if (toward) {
      const rel = this.sRel.subVectors(toward.world, flight.worldPosition);
      const radius = toward.spec.radius;
      const a = this.arrivalIn;
      a.clearanceKm = rel.length() - radius;
      a.radiusKm = radius;
      a.soiRadiusKm = toward.soiRadius;
      a.closing = flight.forward.dot(rel) > 0;
      arrival = a;
      limbKm = LIMB_FRACTION * (radius + arrivalClearanceKm(radius, toward.soiRadius, this.drive.config));
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
    di.exitSpeedKmS = circularSpeed(flight.parent?.mu ?? 0, flight.position.length()) || undefined;
    this.drive.update(dt, di);
    // A drop is an answer, not a pause: whatever started it, the toggle is
    // released so the drive does not spool up again by itself.
    if (wasPhase === 'cruise' && this.drive.phase === 'dropping') {
      this.wanted = false;
      // An obstacle drop used to read only CRUISE DISENGAGED: say why.
      const why = this.drive.dropReason;
      if (why === 'mass' || why === 'atmosphere') {
        bus.emit('log', { text: why === 'mass' ? 'CRUISE DROPPED — MASS LOCK' : 'CRUISE DROPPED — ATMOSPHERE', tone: 'warn' });
      }
    }

    if (wasEngaged && !this.drive.engaged) {
      // The handover. In orbit if there is anything to orbit, else the
      // legacy sublight exit along the nose.
      if (insertIntoOrbit(flight)) {
        this.heldLever = ctx.input.axes.throttle;
        if (this.drive.dropReason === 'arrival' && toward) {
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

    // Steering to the locked target, while charging and while carried — not
    // during the drop, whose direction is the insertion's business.
    if (target && (this.drive.phase === 'spooling' || this.drive.phase === 'cruise')) {
      // review-p1: the straight line to the target often runs through the
      // world being orbited (the playtest's Vassa sat behind Remit 31). The
      // drive then flew into it and dropped for MASS at 0.3 R, unexplained.
      // While a world is in the way, skirt it along the tangent of a sphere
      // safely above its hold threshold; once the line is clear, aim as before.
      const occ = this.occluder(target);
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
    const ship = this.universe.flight.worldPosition;
    const toT = this.sRel.subVectors(target.world, ship);
    const dT = toT.length();
    if (dT < 1e-9) return null;
    const ux = toT.x / dT;
    const uy = toT.y / dT;
    const uz = toT.z / dT;
    const bx = b.world.x - ship.x;
    const by = b.world.y - ship.y;
    const bz = b.world.z - ship.z;
    const along = bx * ux + by * uy + bz * uz;
    if (along <= 0 || along >= dT) return null;
    const perp2 = bx * bx + by * by + bz * bz - along * along;
    const safe = b.spec.radius + OCCLUDER_HOLD_MARGIN * holdClearanceKm(b.spec.radius, this.drive.config);
    return perp2 < safe * safe ? b : null;
  }

  /** Stop wanting it, and let go this frame rather than easing out. */
  private cancel(): void {
    this.wanted = false;
    this.heldLever = null;
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
