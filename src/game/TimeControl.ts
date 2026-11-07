/**
 * Time compression, wired (v2 phase 4, GAMEPLAY P6): `,` and `.` step
 * 1× / 10× / 100× when it is legal, and anything that makes it illegal — a
 * hand on the controls, a burn, cruise, a jump, the autopilot — drops it to
 * 1× on that frame.
 *
 * The rules are pure (`game/timeCompression.ts`, tested; this file is not
 * named after it because macOS file systems are case-insensitive). The scale itself
 * lives in exactly one place, `Universe.simRate`, and only the simulation
 * reads it: the renderers, the camera rig and every UI fade keep real dt, so
 * 100× is the world moving faster, not the game.
 *
 * Registered after Pilot, AutoPilot and Cruise, so the command and the
 * autopilot state it judges are this frame's.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { shotOwnsScene } from '@/game/Shots';
import type { Universe } from '@/game/Universe';
import type { Hud } from '@/ui/Hud';
import { orbitApsides, type Apsides } from '@/ship/autopilot';
import {
  compressionBlock,
  pilotTouching,
  stepTimeRate,
  type CompressionBlock,
  type CompressionInputs,
  type TimeRate,
} from '@/game/timeCompression';

export interface TimeControlOptions {
  readonly universe: Universe;
  readonly warp: { readonly phase: string };
  readonly autopilot: { readonly active: boolean };
  readonly hud?: Hud | null;
}

const BLOCK_TEXT: Record<CompressionBlock, string> = {
  'no-world': 'NO WORLD',
  cruise: 'IN CRUISE',
  warp: 'JUMP IN PROGRESS',
  autopilot: 'AUTOPILOT FLYING',
  thrust: 'ENGINES NOT IDLE',
  unstable: 'ORBIT NOT STABLE',
};

/**
 * Terrain the periapsis must clear when there is no air to clear: 2 % of the
 * radius plus 10 km. Generated relief is a few km; the margin is for the
 * worst of it plus room to wake up at 1× before anything is close.
 */
function terrainMarginKm(radiusKm: number): number {
  return 0.02 * radiusKm + 10;
}

export class TimeControl implements GameModule {
  readonly name = 'time-compression';

  private rate: TimeRate = 1;
  private readonly opts: TimeControlOptions;
  private readonly apsides: Apsides = { periapsis: 0, apoapsis: 0, eccentricity: 0 };
  private readonly inputs: { -readonly [K in keyof CompressionInputs]: CompressionInputs[K] } = {
    hasWorld: false,
    grounded: false,
    cruising: false,
    warpIdle: true,
    autopilotActive: false,
    engineOutput: 0,
    commandIdle: true,
    periapsisKm: 0,
    apoapsisKm: 0,
    safeRadiusKm: 0,
    soiRadiusKm: 0,
  };
  private readonly offs: Array<() => void> = [];

  constructor(opts: TimeControlOptions) {
    this.opts = opts;
  }

  /** The factor in force, for anything that wants to show it. */
  get timeRate(): TimeRate {
    return this.rate;
  }

  init(): void {
    // A jump or a new system is never something to fast-forward into.
    const reset = (): void => this.set(1, null);
    this.offs.push(bus.on('system:entered', reset), bus.on('warp:engaged', reset), bus.on('ship:crashed', reset));
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.opts.universe.simRate = 1;
  }

  update(_dt: number, ctx: EngineContext): void {
    const u = this.opts.universe;
    if (shotOwnsScene() || u.paused || u.frozen) return;
    const input = ctx.input;

    const block = this.judge(u);
    const touching =
      pilotTouching(input.axes, input.held('brake'), input.held('boost')) ||
      input.pressed('land') ||
      input.pressed('cruise') ||
      input.pressed('warp');

    if (this.rate > 1 && (touching || block !== null)) {
      this.set(1, touching ? 'CONTROLS' : BLOCK_TEXT[block!]);
    }

    if (input.pressed('timeFaster')) {
      if (touching) this.refuse('HANDS ON THE CONTROLS');
      else if (block !== null) this.refuse(BLOCK_TEXT[block]);
      else this.set(stepTimeRate(this.rate, 1), null);
    }
    if (input.pressed('timeSlower')) this.set(stepTimeRate(this.rate, -1), null);
  }

  private judge(u: Universe): CompressionBlock | null {
    const f = u.flight;
    const parent = u.shipParent;
    const s = this.inputs;
    const c = f.command;
    s.hasWorld = parent !== null;
    s.grounded = f.grounded;
    s.cruising = f.cruising;
    s.warpIdle = this.opts.warp.phase === 'idle';
    s.autopilotActive = this.opts.autopilot.active;
    s.engineOutput = f.throttle;
    s.commandIdle =
      c.throttle === 0 && c.strafeX === 0 && c.strafeY === 0 && c.strafeZ === 0 && !c.brake && !c.boost;
    if (parent) {
      orbitApsides(f.position, f.velocity, parent.frame.mu, this.apsides);
      s.periapsisKm = this.apsides.periapsis;
      s.apoapsisKm = this.apsides.apoapsis;
      const R = parent.spec.radius;
      s.safeRadiusKm = R + Math.max(parent.spec.atmosphere?.thickness ?? 0, terrainMarginKm(R));
      s.soiRadiusKm = parent.soiRadius;
    }
    return compressionBlock(s);
  }

  private refuse(why: string): void {
    bus.emit('log', { text: `TIME COMPRESSION DENIED — ${why}`, tone: 'warn' });
  }

  /** Apply a rate; `dropped` names why it fell back to 1×, if it did. */
  private set(rate: TimeRate, dropped: string | null): void {
    if (rate === this.rate) return;
    this.rate = rate;
    this.opts.universe.simRate = rate;
    this.opts.hud?.setTimeRate(rate);
    bus.emit('log', {
      text: dropped ? `TIME ×1 — ${dropped}` : `TIME ×${rate}`,
      tone: dropped ? 'warn' : 'normal',
    });
  }
}
