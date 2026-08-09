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
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { CruiseDrive, type CruiseBlock } from '@/ship/CruiseDrive';
import type { Universe } from '@/game/Universe';
import { shotOwnsScene } from '@/game/Shots';

/** What the pilot is told when the drive refuses. */
const REFUSAL: Record<CruiseBlock, string> = {
  landed: 'CRUISE DENIED — ON THE GROUND',
  atmosphere: 'CRUISE DENIED — ATMOSPHERE',
  mass: 'CRUISE DENIED — MASS TOO CLOSE',
};

export interface CruiseOptions {
  readonly universe: Universe;
}

export class Cruise implements GameModule {
  readonly name = 'cruise';

  readonly drive = new CruiseDrive();
  private readonly universe: Universe;

  /** The toggle. Distinct from the drive's phase, which lags it by the spool. */
  private wanted = false;
  /** Last phase seen, so transitions are announced once rather than every frame. */
  private lastPhase = this.drive.phase;
  /** Rate-limits the refusal message; holding the key should not spam the log. */
  private refusedAt = -1e9;

  constructor(opts: CruiseOptions) {
    this.universe = opts.universe;
  }

  init(): void {
    // Leaving a system, or being put somewhere by the chart, must not leave a
    // drive running against a world that no longer exists.
    bus.on('system:entered', () => this.cancel());
    bus.on('warp:engaged', () => this.cancel());
  }

  update(dt: number, ctx: EngineContext): void {
    if (shotOwnsScene() || this.universe.paused) {
      if (this.wanted) this.cancel();
      return;
    }

    const flight = this.universe.flight;

    if (ctx.input.pressed('cruise')) {
      this.wanted = !this.wanted;
      if (this.wanted) this.refusedAt = -1e9;
    }
    // Landing, or asking for an interstellar jump, means you are done cruising.
    if (ctx.input.pressed('land') || ctx.input.pressed('warp')) this.wanted = false;

    this.drive.update(dt, {
      requested: this.wanted,
      clearanceKm: this.universe.nearestGapKm,
      grounded: flight.grounded,
      atmosphericDensity: flight.atmosphericDensity,
    });

    // The flight model is told the ceiling, not the phase. It has no opinion
    // about why it is allowed to go fast.
    flight.setCruise(this.drive.engaged ? this.drive.capKmS : null);

    this.announce(ctx);
  }

  /** Stop wanting it, and let go this frame rather than easing out. */
  private cancel(): void {
    this.wanted = false;
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
