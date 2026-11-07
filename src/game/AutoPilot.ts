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
 * frame) and after Cruise (which also reads L, to stop cruising), so what the
 * computer writes into `FlightModel.command` is what the next integration
 * flies.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import type { InputAxes } from '@/core/Input';
import { shotOwnsScene } from '@/game/Shots';
import { activeFlightPreset, type FlightPresetSpec } from '@/game/flightPreset';
import type { FlightModel } from '@/ship/FlightModel';
import {
  Autopilot,
  autopilotRefusal,
  pilotIntervened,
  type AutopilotGoal,
  type AutopilotPhase,
  type AutopilotRefusal,
} from '@/ship/autopilot';

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
    };
    readonly frame: { readonly mu: number };
  } | null;
}

/** The subset of `Input` used here; `Input` satisfies it. */
interface ControlInput {
  readonly axes: InputAxes;
  pressed(a: 'land' | 'zeroThrottle'): boolean;
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
}

export const AUTOPILOT_DISENGAGED = 'AUTOPILOT DISENGAGED';

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
  /** The parent the leg is flown against; a change of SOI ends the leg. */
  private parent: AutoPilotWorld['shipParent'] = null;
  private lastPhase: AutopilotPhase = 'idle';
  private readonly offs: Array<() => void> = [];

  /** Last frame's axes, so a takeover is a *change*, not a residue. */
  private readonly prev: InputAxes = { pitch: 0, yaw: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0, strafeZ: 0 };
  private readonly keys = { throttleKeys: false, brake: false, boost: false, zeroThrottle: false };
  private readonly world = { radiusKm: 1, mu: 0, atmosphereTopKm: 0 };

  constructor(opts: AutoPilotOptions) {
    this.universe = opts.universe;
    this.warp = opts.warp;
    this.preset = opts.preset ?? activeFlightPreset;
  }

  /** True while the computer has the controls — time compression reads it. */
  get active(): boolean {
    return this.core.active;
  }
  get goal(): AutopilotGoal | null {
    return this.core.goal;
  }

  init(): void {
    // Anything that moves the ship out from under the leg ends it.
    const end = (): void => this.disengage(true);
    this.offs.push(
      bus.on('ship:crashed', end),
      bus.on('ship:recovered', end), // RETURN TO ORBIT keeps the parent: nothing else ends the leg
      bus.on('system:entered', end),
      bus.on('warp:engaged', end),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  update(_dt: number, ctx: EngineContext): void {
    if (shotOwnsScene() || this.universe.paused || this.universe.frozen) return;
    const input: ControlInput = ctx.input;
    const flight = this.universe.flight;

    if (this.core.active) {
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
        this.fly(flight);
      }
    } else if (input.pressed('land')) {
      this.tryEngage(input, flight);
    }

    copyAxes(input.axes, this.prev);
  }

  private tryEngage(input: ControlInput, flight: FlightModel): void {
    const parent = this.universe.shipParent;
    const preset = this.preset();
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

    this.parent = parent;
    this.syncWorld();
    const goal: AutopilotGoal = flight.grounded ? 'orbit' : 'land';
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
  }

  private fly(flight: FlightModel): void {
    this.syncWorld();
    const result = this.core.step(flight, this.world);
    if (result === 'landed') {
      this.disengage(false);
      bus.emit('log', { text: 'AUTOPILOT OFF — LANDED', tone: 'good' });
      return;
    }
    if (result === 'orbit') {
      const name = this.parent?.spec.name.toUpperCase() ?? '';
      this.disengage(false);
      bus.emit('log', { text: `AUTOPILOT OFF — ORBIT ${name}`, tone: 'good' });
      return;
    }
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
  }

  /** Hand back. `announce` = the pilot (or the world) took it, not completion. */
  private disengage(announce: boolean): void {
    if (!this.core.active) return;
    this.core.disengage(this.universe.flight);
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
