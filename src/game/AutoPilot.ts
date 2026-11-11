/**
 * The `L` key (v2 phase 4, GAMEPLAY P4): auto-land in flight, auto-orbit on
 * the ground.
 *
 * The flying is `ship/autopilot.ts` (pure, tested against the real
 * FlightModel); this module owns the key, the refusals, the hand-back and the
 * log. Its one hard rule: the pilot always wins. Any stick, lever, strafe,
 * brake or boost input disengages on the frame it appears, and L again does
 * too — "AUTOPILOT DISENGAGED".
 *
 * Registered after Pilot (which copies the stick into the command every
 * frame) and after Cruise (which also reads L, to stop cruising).
 *
 * v3 (T3, PLAN §2 D): the FLYING happens per sim slice. Universe's slice loop
 * calls `sliceStep(h)` before each slice it integrates, so at 10× the
 * computer writes a fresh command every slice rather than one for the whole
 * frame — the same leg at 10× as at 1× (`ship/autopilotPacing.test.ts`).
 * `update()` keeps the frame-rate jobs: the key, the pilot's hands, the
 * refusals, the queue and the log. And L during cruise is QUEUED: the drive
 * drops (Cruise reads L too), and the landing engages once cruise is idle.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { flightActivity } from '@/core/flightActivity'; // [v3-T1]
import type { InputAxes } from '@/core/Input';
import { shotOwnsScene } from '@/game/Shots';
import { activeFlightPreset, type FlightPresetSpec } from '@/game/flightPreset';
import { Vector3 } from 'three';
import type { FlightModel } from '@/ship/FlightModel';
import { spinAngularVelocity } from '@/ship/surfaceSpin';
import {
  Autopilot,
  autopilotRefusal,
  pilotIntervened,
  type AutopilotGoal,
  type AutopilotPhase,
  type AutopilotRefusal,
} from '@/ship/autopilot';
import { autoLandVerdict, landingEstimateKg } from '@/ui/propellantReadout';
import { beltTargetName, type Belt } from '@/game/Belt';
import { APPROACH_FINAL_KM, Approach, approachEstimateKg } from '@/ship/approach';

/**
 * The part of Universe this module reads — structural, so node tests can
 * stub it and Universe satisfies it as it stands.
 */
export interface AutoPilotWorld {
  readonly flight: FlightModel;
  readonly paused: boolean;
  readonly frozen: boolean;
  readonly shipParent: {
    readonly spec: {
      readonly name: string;
      readonly radius: number;
      readonly atmosphere: { readonly thickness: number } | null;
      /** v3 polish (D22a): the world turns, and the landing flies with its ground. Absent = still. */
      readonly rotationPeriod?: number;
      readonly axialTilt?: number;
    };
    readonly frame: { readonly mu: number };
    /** [v4-mining] World velocity of the parent (the approach's rock velocity is made relative to it). */
    readonly worldVelocity?: { readonly x: number; readonly y: number; readonly z: number };
  } | null;
}

/** The subset of `Input` used here; `Input` satisfies it. */
interface ControlInput {
  readonly axes: InputAxes;
  pressed(a: 'land' | 'zeroThrottle' | 'cruise' | 'warp'): boolean;
  held(a: 'brake' | 'boost'): boolean;
  isDown(code: string): boolean;
  setThrottle(v: number): void;
}

export interface AutoPilotOptions {
  readonly universe: AutoPilotWorld;
  /** The jump drive; a jump in progress refuses and disengages. */
  readonly warp: { readonly phase: string };
  /** Which preset is in force. Defaults to the persisted session preset. */
  readonly preset?: () => FlightPresetSpec;
  /**
   * v3: the cruise module, for the L queue. `busy` while the drive is doing
   * anything or the post-insertion settle is still turning the ship.
   * Omitted = only `flight.cruising` counts.
   */
  readonly cruise?: { readonly busy: boolean };
  /**
   * [v4-mining] With an asteroid targeted, L parks at it (ship/approach.ts)
   * instead of landing. The target comes from `target:changed`. Absent: v3.
   */
  readonly belt?: Pick<Belt, 'asteroidWorld' | 'asteroidVelocity' | 'asteroidSpec'> | null;
}

export const AUTOPILOT_DISENGAGED = 'AUTOPILOT DISENGAGED';
export const AUTOPILOT_QUEUED = 'AUTOPILOT QUEUED — LANDING AFTER CRUISE';
export const AUTOPILOT_QUEUE_CANCELLED = 'AUTOPILOT QUEUE CANCELLED';
/** v4 fuel: L refused, the tank holds less than half the landing estimate. */
export const AUTOPILOT_PROPELLANT_LOW = 'AUTOPILOT · PROPELLANT LOW';
/** v4 fuel: L engaged, but the tank holds less than the landing estimate. */
export const AUTOPILOT_PROPELLANT_MARGINAL = 'AUTOPILOT · PROPELLANT MARGINAL';
/** v4 fuel: the tank ran dry mid-leg; the computer lets go. */
export const AUTOPILOT_OFF_PROPELLANT = 'AUTOPILOT OFF · PROPELLANT';
/** [v4-mining] L on a rock: the approach has arrived. */
export const APPROACH_PARKED = 'PARKED · 0.3 KM — B TO MINE';
/** [v4-mining] L on a rock outside its field's frame (FA is not referenced to the rock). */
export const APPROACH_DENIED_FIELD = 'AUTOPILOT DENIED — NOT IN THE FIELD';

export function approachLog(rockName: string): string {
  return `APPROACH — ${rockName.toUpperCase()}`;
}

function refusalText(r: AutopilotRefusal, preset: FlightPresetSpec): string {
  switch (r) {
    case 'preset':
      return `AUTOPILOT NOT FITTED — ${preset.label} PRESET`;
    case 'cruise':
      return 'AUTOPILOT DENIED — IN CRUISE';
    case 'warp':
      return 'AUTOPILOT DENIED — JUMP IN PROGRESS';
    case 'no-world':
      return 'AUTOPILOT DENIED — NO WORLD IN RANGE';
  }
}

const PHASE_TEXT: Partial<Record<AutopilotPhase, string>> = {
  descent: 'AUTOPILOT — SUICIDE BURN',
  final: 'AUTOPILOT — FINAL DESCENT',
  ascent: 'AUTOPILOT — ASCENT',
  circularise: 'AUTOPILOT — CIRCULARISING',
};

export class AutoPilot implements GameModule {
  readonly name = 'autopilot';

  private readonly core = new Autopilot();
  private readonly universe: AutoPilotWorld;
  private readonly warp: { readonly phase: string };
  private readonly preset: () => FlightPresetSpec;
  private readonly cruise: { readonly busy: boolean } | null;
  // --- [v4-mining] L on a rock ---------------------------------------------
  private readonly approach = new Approach();
  private readonly belt: AutoPilotOptions['belt'] | null;
  private targetId: string | null = null;
  /** The rock the approach is flying to. */
  private approachId: string | null = null;
  private readonly rockWorld = new Vector3();
  private readonly rockVel = new Vector3();
  /** v3: L was pressed during cruise; engage when cruise is idle. */
  private _queued = false;
  /** Set by `sliceStep` when the leg completed inside a slice. */
  private completed: 'landed' | 'orbit' | null = null;
  /** The parent the leg is flown against; a change of SOI ends the leg. */
  private parent: AutoPilotWorld['shipParent'] = null;
  private lastPhase: AutopilotPhase = 'idle';
  private readonly offs: Array<() => void> = [];

  /** Last frame's axes, so a takeover is a *change*, not a residue. */
  private readonly prev: InputAxes = { pitch: 0, yaw: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0, strafeZ: 0 };
  private readonly keys = { throttleKeys: false, brake: false, boost: false, zeroThrottle: false };
  private readonly world = { radiusKm: 1, mu: 0, atmosphereTopKm: 0, spinRadS: new Vector3() };

  constructor(opts: AutoPilotOptions) {
    this.universe = opts.universe;
    this.warp = opts.warp;
    this.preset = opts.preset ?? activeFlightPreset;
    this.cruise = opts.cruise ?? null;
    this.belt = opts.belt ?? null;
  }

  /** True while the computer has the controls — time compression reads it. */
  get active(): boolean {
    return this.core.active || this.approach.active;
  }
  get goal(): AutopilotGoal | null {
    return this.approach.active ? 'approach' : this.core.goal;
  }
  /** The leg's phase ('idle' when nothing flies) — TimeControl's rate reads it. */
  get phase(): AutopilotPhase {
    if (this.approach.active) return this.approach.toGoKm > APPROACH_FINAL_KM ? 'approach' : 'approach-final';
    return this.core.phase;
  }
  /** A landing is waiting for cruise to finish. */
  get queued(): boolean {
    return this._queued;
  }

  init(): void {
    // Anything that moves the ship out from under the leg ends it.
    const end = (): void => {
      this.cancelQueue(false);
      this.disengage(true);
    };
    this.offs.push(
      bus.on('ship:crashed', end),
      bus.on('ship:recovered', end), // RETURN TO ORBIT keeps the parent: nothing else ends the leg
      bus.on('system:entered', end),
      bus.on('warp:engaged', end),
      bus.on('target:changed', (e) => {
        this.targetId = e.id;
      }),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  /**
   * One sim slice of guidance (v3): Universe calls this before integrating
   * each slice. Writes the command; a completed leg is handed back here.
   */
  sliceStep(h: number): void {
    if (this.approach.active) {
      this.approachSlice();
      return;
    }
    if (!this.core.active) return;
    if (this.releaseIfStarved()) return;
    // review-v3b: Universe re-parents after each slice; at 10× the rest of
    // the frame must not be flown with the old world against the new frame.
    if (this.universe.shipParent !== this.parent) {
      this.disengage(true);
      return;
    }
    const flight = this.universe.flight;
    this.syncWorld();
    const result = this.core.step(flight, this.world, h);
    if (result === 'landed' || result === 'orbit') {
      const name = this.parent?.spec.name.toUpperCase() ?? '';
      this.disengage(false);
      bus.emit('log', {
        text: result === 'landed' ? 'AUTOPILOT OFF — LANDED' : `AUTOPILOT OFF — ORBIT ${name}`,
        tone: 'good',
      });
      this.completed = result;
    }
  }

  update(_dt: number, ctx: EngineContext): void {
    flightActivity.autopilot = this.active; // [v3-T1] governor holds rises while flying ([v4-mining] the approach too)
    if (shotOwnsScene() || this.universe.paused || this.universe.frozen) return;
    const input: ControlInput = ctx.input;
    const flight = this.universe.flight;
    this.completed = null;

    if (this._queued) {
      this.updateQueue(input, flight);
    } else if (this.active && this.releaseIfStarved()) {
      // v4 fuel: the tank ran dry — handed back, nothing else to judge.
    } else if (this.approach.active) {
      // [v4-mining] The approach flies THROUGH FA: FA turned off is a takeover.
      const k = this.keys;
      k.throttleKeys = input.isDown('KeyW') || input.isDown('KeyS');
      k.brake = input.held('brake');
      k.boost = input.held('boost');
      k.zeroThrottle = input.pressed('zeroThrottle');
      if (
        input.pressed('land') ||
        pilotIntervened(input.axes, this.prev, k) ||
        !flight.flightAssist ||
        !this.preset().autopilot ||
        this.warp.phase !== 'idle' ||
        flight.cruising ||
        this.universe.shipParent !== this.parent ||
        this.targetId !== this.approachId
      ) {
        this.disengage(true);
      }
    } else if (this.core.active) {
      const k = this.keys;
      k.throttleKeys = input.isDown('KeyW') || input.isDown('KeyS');
      k.brake = input.held('brake');
      k.boost = input.held('boost');
      k.zeroThrottle = input.pressed('zeroThrottle');

      // The leg flies FA-OFF. FA found ON means someone else set it this
      // frame — Z (Pilot runs first) or the pause sheet's preset — and the
      // computer must not keep flying raw thrust through the assist.
      const faTaken = flight.flightAssist;
      const preset = this.preset();
      if (
        input.pressed('land') ||
        pilotIntervened(input.axes, this.prev, k) ||
        faTaken ||
        !preset.autopilot ||
        this.warp.phase !== 'idle' ||
        flight.cruising ||
        this.universe.shipParent !== this.parent
      ) {
        this.disengage(true);
        // Whoever turned FA on wins over the FA saved at engage; a preset
        // that removed the autopilot brings its own FA default.
        if (faTaken) flight.flightAssist = true;
        else if (!preset.autopilot) flight.flightAssist = preset.flightAssist;
      } else {
        this.announcePhase();
      }
    } else if (input.pressed('land')) {
      this.tryEngage(input, flight);
    }

    copyAxes(input.axes, this.prev);
  }

  private cruiseBusy(flight: FlightModel): boolean {
    return flight.cruising || (this.cruise?.busy ?? false);
  }

  /** v3: L in cruise waits here; L again, G, a jump or an event cancels it. */
  private updateQueue(input: ControlInput, flight: FlightModel): void {
    if (input.pressed('land') || input.pressed('cruise') || this.warp.phase !== 'idle' || !this.preset().autopilot) {
      this.cancelQueue(true);
      return;
    }
    if (this.cruiseBusy(flight)) return;
    this._queued = false;
    this.tryEngage(input, flight, true);
  }

  private cancelQueue(announce: boolean): void {
    if (!this._queued) return;
    this._queued = false;
    if (announce) bus.emit('log', { text: AUTOPILOT_QUEUE_CANCELLED, tone: 'warn' });
  }

  private tryEngage(input: ControlInput, flight: FlightModel, fromQueue = false): void {
    const parent = this.universe.shipParent;
    const preset = this.preset();
    // [v4-mining] An asteroid targeted, in flight and out of cruise: park at it.
    if (!flight.grounded && !this.cruiseBusy(flight) && this.isRock(this.targetId)) {
      this.tryApproach(input, flight, this.targetId!);
      return;
    }
    // v3: in cruise the landing waits for the drive instead of refusing.
    if (!fromQueue && preset.autopilot && this.cruiseBusy(flight) && this.warp.phase === 'idle') {
      this._queued = true;
      bus.emit('log', { text: AUTOPILOT_QUEUED, tone: 'normal' });
      return;
    }
    const refusal = autopilotRefusal({
      presetAllows: preset.autopilot,
      cruising: flight.cruising,
      warpIdle: this.warp.phase === 'idle',
      hasWorld: parent !== null,
      distanceRadii: parent ? flight.position.length() / parent.spec.radius : Number.NaN,
    });
    if (refusal !== null || !parent) {
      bus.emit('log', { text: refusalText(refusal ?? 'no-world', preset), tone: 'warn' });
      return;
    }

    const goal: AutopilotGoal = flight.grounded ? 'orbit' : 'land';
    // v4 fuel: a landing checks the tank first. No tank = v3, no check; no
    // pre-check for the climb to orbit (ruling R14).
    let marginal = false;
    const tank = flight.propellant;
    if (goal === 'land' && tank !== null) {
      const verdict = autoLandVerdict(tank.massKg, landingEstimateKg(flight));
      if (verdict === 'refuse') {
        bus.emit('log', { text: AUTOPILOT_PROPELLANT_LOW, tone: 'warn' });
        return;
      }
      marginal = verdict === 'marginal';
    }

    this.parent = parent;
    this.syncWorld();
    this.core.engage(goal, flight, this.world);
    this.lastPhase = this.core.phase;
    // The lever goes to the coast detent, so the hand-back — at the end or on
    // a takeover — never inherits a speed hold the pilot set minutes ago.
    input.setThrottle(0);
    bus.emit('log', {
      text: goal === 'land'
        ? `AUTOPILOT ENGAGED — LANDING ON ${parent.spec.name.toUpperCase()}`
        : 'AUTOPILOT ENGAGED — TO ORBIT',
      tone: 'good',
    });
    if (marginal) bus.emit('log', { text: AUTOPILOT_PROPELLANT_MARGINAL, tone: 'warn' });
  }

  /** [v4-mining] A rock the Belt knows. */
  private isRock(id: string | null): boolean {
    return id !== null && id.startsWith('ast:') && !!this.belt && this.belt.asteroidSpec(id) !== null;
  }

  /**
   * [v4-mining] The rock's centre and its velocity, parent-relative, at the
   * SHIP's time: the Belt places it on the orbit clock, which the integrated
   * state trails by `flight.timeBehindS` (the substep carry — up to ~0.25 km
   * at a field's speed), so it is moved back by that much.
   */
  private readRock(id: string): boolean {
    const belt = this.belt;
    if (!belt || !belt.asteroidWorld(id, this.rockWorld) || !belt.asteroidVelocity(id, this.rockVel)) return false;
    const behind = this.universe.flight.timeBehindS;
    if (behind > 0) this.rockWorld.addScaledVector(this.rockVel, -behind);
    const pv = this.universe.shipParent?.worldVelocity;
    if (pv) this.rockVel.set(this.rockVel.x - pv.x, this.rockVel.y - pv.y, this.rockVel.z - pv.z);
    return true;
  }

  /** [v4-mining] L with a rock targeted: the refusals, the tank check, engage. */
  private tryApproach(input: ControlInput, flight: FlightModel, id: string): void {
    const preset = this.preset();
    const refusal = autopilotRefusal({
      presetAllows: preset.autopilot,
      cruising: flight.cruising,
      warpIdle: this.warp.phase === 'idle',
      hasWorld: true,
      distanceRadii: 0,
    });
    if (refusal !== null) {
      bus.emit('log', { text: refusalText(refusal, preset), tone: 'warn' });
      return;
    }
    const spec = this.belt!.asteroidSpec(id);
    if (!spec || !this.readRock(id)) return;
    // The computer flies through FA, whose reference must be the rock's
    // velocity: the field frame (or formation on it). Outside it, refuse.
    const ref = flight.assistReferenceVelocity;
    if (!ref || ref.distanceTo(this.rockVel) > 1e-3) {
      bus.emit('log', { text: APPROACH_DENIED_FIELD, tone: 'warn' });
      return;
    }
    let marginal = false;
    const tank = flight.propellant;
    if (tank !== null) {
      const surfaceKm = this.rockWorld.distanceTo(flight.worldPosition) - spec.radiusKm;
      const relKmS = this.rockVel.distanceTo(flight.velocity);
      const verdict = autoLandVerdict(tank.massKg, approachEstimateKg(flight, surfaceKm, relKmS));
      if (verdict === 'refuse') {
        bus.emit('log', { text: AUTOPILOT_PROPELLANT_LOW, tone: 'warn' });
        return;
      }
      marginal = verdict === 'marginal';
    }
    this.parent = this.universe.shipParent;
    this.approachId = id;
    this.approach.engage(flight, this.rockWorld, spec.radiusKm);
    this.lastPhase = this.phase;
    input.setThrottle(0);
    bus.emit('log', { text: approachLog(beltTargetName(id) ?? id), tone: 'good' });
    if (marginal) bus.emit('log', { text: AUTOPILOT_PROPELLANT_MARGINAL, tone: 'warn' });
  }

  /** [v4-mining] One slice of the approach; parks and hands back on arrival. */
  private approachSlice(): void {
    if (this.releaseIfStarved()) return;
    const flight = this.universe.flight;
    const id = this.approachId;
    if (this.universe.shipParent !== this.parent || id === null || !this.readRock(id)) {
      this.disengage(true);
      return;
    }
    // rockVel becomes the ship's velocity relative to the rock.
    this.rockVel.set(flight.velocity.x - this.rockVel.x, flight.velocity.y - this.rockVel.y, flight.velocity.z - this.rockVel.z);
    if (this.approach.step(flight, this.rockWorld, this.rockVel) === 'parked') {
      this.disengage(false);
      bus.emit('log', { text: APPROACH_PARKED, tone: 'good' });
    }
  }

  /**
   * v4 fuel: the tank ran dry (thrust was wanted and the engine starved), so
   * the computer lets go with its own log. It never re-engages by itself.
   */
  private releaseIfStarved(): boolean {
    if (!this.universe.flight.thrustStarved) return false;
    this.disengage(false);
    bus.emit('log', { text: AUTOPILOT_OFF_PROPELLANT, tone: 'warn' });
    return true;
  }

  private announcePhase(): void {
    if (this.approach.active) return;
    const phase = this.core.phase;
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      const text = PHASE_TEXT[phase];
      if (text) bus.emit('log', { text, tone: 'normal' });
    }
  }

  private syncWorld(): void {
    const p = this.parent;
    if (!p) return;
    this.world.radiusKm = p.spec.radius;
    this.world.mu = p.frame.mu;
    this.world.atmosphereTopKm = p.spec.atmosphere?.thickness ?? 0;
    spinAngularVelocity(p.spec.rotationPeriod ?? 0, p.spec.axialTilt ?? 0, this.world.spinRadS);
  }

  /** Hand back. `announce` = the pilot (or the world) took it, not completion. */
  private disengage(announce: boolean): void {
    if (!this.active) return;
    if (this.approach.active) {
      this.approach.disengage(this.universe.flight);
      this.approachId = null;
    } else {
      this.core.disengage(this.universe.flight);
    }
    this.parent = null;
    this.lastPhase = 'idle';
    if (announce) bus.emit('log', { text: AUTOPILOT_DISENGAGED, tone: 'warn' });
  }
}

function copyAxes(from: InputAxes, to: InputAxes): void {
  to.pitch = from.pitch;
  to.yaw = from.yaw;
  to.roll = from.roll;
  to.throttle = from.throttle;
  to.strafeX = from.strafeX;
  to.strafeY = from.strafeY;
  to.strafeZ = from.strafeZ;
}
