/**
 * v4 sub-plan 1 (propellant), Task 6 — the emergency exit, wired.
 *
 * Only an EMPTY tank offers it ("EMERGENCY · H" on the NAV ADVISORY line).
 * H opens the choice, 1 cannibalizes the tank, 2 fires the beacon; H again
 * closes it. Nothing is ever applied without the pilot's pick. The rules are
 * pure (`ship/emergency.ts`); this module owns the keys, the line and the
 * bookkeeping. A hull without a tank is inert.
 *
 * `timesUsed` lives here (get/set) — sub-plan 3 saves and restores it.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { EMERGENCY_KEYS } from '@/core/Input';
import { applyBeacon, applyCannibalize, cannibalizeYield } from '@/ship/emergency';
import type { Propellant } from '@/ship/propellant';

export type EmergencyChoice = 'cannibalize' | 'beacon';

/** What the module reads and drives of the universe. `Universe` satisfies it. */
export interface EmergencyWorld {
  readonly flight: {
    readonly propellant: Propellant | null;
    /** Zeroed after the beacon, as RecoveryCut does: arrive coasting. */
    readonly command?: { throttle: number };
  };
  readonly paused: boolean;
  recoverToOrbit(): void;
}

export interface EmergencyOptions {
  readonly universe: EmergencyWorld;
}

/** 'KeyH' → 'H', 'Digit1' → '1'. */
function keyLabel(code: string): string {
  return code.replace(/^Key/, '').replace(/^Digit/, '');
}

export const EMERGENCY_PROMPT = `EMERGENCY · ${keyLabel(EMERGENCY_KEYS.open)}`;

export class Emergency implements GameModule {
  readonly name = 'emergency';

  private uses = 0;
  private choosing = false;

  constructor(private readonly opts: EmergencyOptions) {}

  /** Cannibalizations so far. Settable so a save can restore it. */
  get timesUsed(): number {
    return this.uses;
  }

  set timesUsed(n: number) {
    this.uses = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  private get tank(): Propellant | null {
    return this.opts.universe.flight.propellant;
  }

  /** The tank exists and is dry: the only time the exit is offered. */
  private get stranded(): boolean {
    const t = this.tank;
    return t !== null && t.empty;
  }

  /** "EMERGENCY · H" while the tank is empty, else null. */
  get prompt(): string | null {
    return this.stranded ? EMERGENCY_PROMPT : null;
  }

  /** The choice is open. */
  get open(): boolean {
    return this.choosing && this.stranded;
  }

  /** What may be picked; [] unless the tank is empty. Cannibalize only when the tank can pay. */
  get offers(): EmergencyChoice[] {
    const t = this.tank;
    if (!t || !t.empty) return [];
    return cannibalizeYield(t, this.uses) ? ['cannibalize', 'beacon'] : ['beacon'];
  }

  /** The NAV ADVISORY line: the menu while choosing, the prompt otherwise. */
  get line(): string | null {
    if (!this.stranded) return null;
    if (!this.choosing) return EMERGENCY_PROMPT;
    const parts: string[] = [];
    for (const o of this.offers) {
      parts.push(
        o === 'cannibalize'
          ? `${keyLabel(EMERGENCY_KEYS.cannibalize)} · CANNIBALIZE TANK`
          : `${keyLabel(EMERGENCY_KEYS.beacon)} · BEACON`,
      );
    }
    return parts.join('   ');
  }

  init(): void {
    this.choosing = false;
  }

  update(_dt: number, ctx: EngineContext): void {
    const input = ctx.input;
    const tank = this.tank;
    if (!tank || !tank.empty || this.opts.universe.paused) {
      if (!tank || !tank.empty) this.choosing = false;
      return;
    }

    if (input.pressed('emergency')) {
      this.choosing = !this.choosing;
      return;
    }
    if (!this.choosing) return;

    if (input.pressed('emergencyCannibalize')) {
      if (!applyCannibalize(tank, this.uses).ok) return; // refused: the beacon still answers
      this.uses++;
      this.choosing = false;
      bus.emit('log', { text: 'TANK CANNIBALIZED', tone: 'warn' });
      bus.emit('emergency:used', { kind: 'cannibalize' });
    } else if (input.pressed('emergencyBeacon')) {
      this.choosing = false;
      this.opts.universe.recoverToOrbit();
      applyBeacon(tank);
      // Arrive coasting (RecoveryCut does the same).
      input.setThrottle(0);
      const cmd = this.opts.universe.flight.command;
      if (cmd) cmd.throttle = 0;
      // Cruise, autopilot and time compression let go on this.
      bus.emit('ship:recovered', { cause: 'beacon' });
      bus.emit('log', { text: 'RECOVERED · BEACON', tone: 'good' });
      bus.emit('emergency:used', { kind: 'beacon' });
    }
  }
}
