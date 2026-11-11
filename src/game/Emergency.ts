/**
 * v4 sub-plan 1 (propellant), Task 6 — the emergency exit, wired.
 *
 * Only an EMPTY tank offers it ("EMERGENCY · H" on the NAV ADVISORY line).
 * H opens the choice; three ways out: 3 burns the cargo (from 1 000 kg),
 * 1 cannibalizes the tank, 2 fires the beacon (which jettisons the hold and
 * writes a logbook note); H again closes it. Nothing is ever applied without
 * the pilot's pick. The rules are
 * pure (`ship/emergency.ts`); this module owns the keys, the line and the
 * bookkeeping. A hull without a tank is inert.
 *
 * R16: prompt, line and keys all ask one gate, `emergencyMayAct` — never while
 * paused or frozen, during a recovery cut, or mid-warp — and the gate is asked
 * again at the moment 1 / 2 is pressed. Hints shows `line`, so what is on
 * screen and what the keys do cannot drift apart.
 *
 * `timesUsed` lives here (get/set) — sub-plan 3 saves and restores it.
 *
 * [v4-mining] Task 6 — the exit knows the cargo. 3 burns the whole hold for
 * 3 % of BASE tank capacity (`cannibalize-cargo`), offered FIRST when the hold
 * holds ≥ 1 000 kg: 3, 1, 2. The beacon pays through `payBeacon` — the tank
 * price, the hold jettisoned, a BEACON RECOVERY note — shared with RecoveryCut.
 *
 * Final review I2 (DESIGN §5.4, "tydelig prompt"): with cargo aboard the
 * beacon says what it costs — `2 · BEACON · LOSE 6 099 KG CARGO`.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { EMERGENCY_KEYS } from '@/core/Input';
import { CANNIBALIZE_CARGO_MIN_KG, applyCargoAction, type Cargo } from '@/ship/cargo';
import { formatKg } from './miningRules';
import { cannibalizeYield, emergencyMayAct, payBeacon, type BeaconLog } from '@/ship/emergency';
import { applyAction } from '@/ship/travelCost';
import type { Propellant } from '@/ship/propellant';

export type EmergencyChoice = 'cannibalize-cargo' | 'cannibalize' | 'beacon';

/** What the module reads and drives of the universe. `Universe` satisfies it. */
export interface EmergencyWorld {
  readonly flight: {
    readonly propellant: Propellant | null;
    /** Zeroed after the beacon, as RecoveryCut does: arrive coasting. */
    readonly command?: { throttle: number };
  };
  /** [v4-mining] The hold: burned by 3, jettisoned by the beacon. Absent: no hold (v4-fuel stubs). */
  readonly cargo?: Cargo;
  /** The system the ship is in; named in the beacon's logbook note. */
  readonly system?: { readonly name: string };
  readonly paused: boolean;
  /** Pause sheet, recovery cut or an overlay holds the world (ui/Pause.ts). */
  readonly frozen: boolean;
  recoverToOrbit(): void;
}

export interface EmergencyOptions {
  readonly universe: EmergencyWorld;
  readonly recovery: { readonly active: boolean };
  readonly warp: { readonly phase: string };
  /** [v4-mining] The ship's log: the beacon writes its note here (registry passes it). */
  readonly log?: BeaconLog;
}

/** 'KeyH' → 'H', 'Digit1' → '1'. */
function keyLabel(code: string): string {
  return code.replace(/^Key/, '').replace(/^Digit/, '');
}

export const EMERGENCY_PROMPT = `EMERGENCY · ${keyLabel(EMERGENCY_KEYS.open)}`;

const OFFER_TEXT: Readonly<Record<EmergencyChoice, string>> = {
  'cannibalize-cargo': `${keyLabel(EMERGENCY_KEYS.cannibalizeCargo)} · CANNIBALIZE CARGO`,
  cannibalize: `${keyLabel(EMERGENCY_KEYS.cannibalize)} · CANNIBALIZE TANK`,
  beacon: `${keyLabel(EMERGENCY_KEYS.beacon)} · BEACON`,
};

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

  /** R16: the one gate — a dry tank, and nothing else owns the ship. */
  private get stranded(): boolean {
    const { universe, recovery, warp } = this.opts;
    return emergencyMayAct({
      paused: universe.paused,
      frozen: universe.frozen,
      recoveryActive: recovery.active,
      warpPhase: warp.phase,
      tank: this.tank,
    });
  }

  /** "EMERGENCY · H" while the tank is empty, else null. */
  get prompt(): string | null {
    return this.stranded ? EMERGENCY_PROMPT : null;
  }

  /** The choice is open. */
  get open(): boolean {
    return this.choosing && this.stranded;
  }

  /** The hold can be burned: ≥ 1 000 kg aboard and a tank that can take anything. */
  private get cargoBurnable(): boolean {
    const c = this.opts.universe.cargo;
    const t = this.tank;
    return !!c && !!t && c.totalKg >= CANNIBALIZE_CARGO_MIN_KG && t.capacityKg > 0;
  }

  /**
   * What may be picked, in menu order; [] unless the gate holds. The cargo
   * first (it costs the tank nothing), the tank only when it can pay, the
   * beacon always.
   */
  get offers(): EmergencyChoice[] {
    const t = this.tank;
    if (!t || !this.stranded) return [];
    const o: EmergencyChoice[] = [];
    if (this.cargoBurnable) o.push('cannibalize-cargo');
    if (cannibalizeYield(t, this.uses)) o.push('cannibalize');
    o.push('beacon');
    return o;
  }

  /** The NAV ADVISORY line: the menu while choosing, the prompt otherwise. */
  get line(): string | null {
    if (!this.stranded) return null;
    if (!this.choosing) return EMERGENCY_PROMPT;
    return this.offers.map((o) => this.offerText(o)).join('   ');
  }

  /** One menu entry. The beacon names the hold it will jettison (I2). */
  private offerText(o: EmergencyChoice): string {
    const kg = this.opts.universe.cargo?.totalKg ?? 0;
    if (o === 'beacon' && kg > 0) return `${OFFER_TEXT.beacon} · LOSE ${formatKg(kg)} KG CARGO`;
    return OFFER_TEXT[o];
  }

  init(): void {
    this.choosing = false;
  }

  update(_dt: number, ctx: EngineContext): void {
    const input = ctx.input;
    const tank = this.tank;
    // Closed whenever the gate fails: a choice opened before a jump or a cut
    // does not survive it.
    if (!tank || !this.stranded) {
      this.choosing = false;
      return;
    }

    if (input.pressed('emergency')) {
      this.choosing = !this.choosing;
      return;
    }
    if (!this.choosing) return;

    // Re-check at the moment of the pick (R16): nothing between the gate above
    // and here may have changed it, but the pick is what must never slip.
    if (!this.stranded) return;
    if (input.pressed('emergencyCannibalizeCargo')) {
      // Only when offered: below 1 000 kg the key is silent, not a refusal.
      if (!this.cargoBurnable || !this.opts.universe.cargo) return;
      const r = applyCargoAction(this.opts.universe.cargo, tank, { kind: 'cannibalize-cargo' });
      if (!r.ok) return;
      this.choosing = false;
      bus.emit('log', { text: 'CARGO CANNIBALIZED', tone: 'warn' });
      bus.emit('emergency:used', { kind: 'cannibalize-cargo' });
    } else if (input.pressed('emergencyCannibalize')) {
      const r = applyAction(tank, { kind: 'cannibalize', part: 'tank', timesUsed: this.uses });
      if (!r.ok) return; // refused: the beacon still answers
      this.uses++;
      this.choosing = false;
      bus.emit('log', { text: 'TANK CANNIBALIZED', tone: 'warn' });
      bus.emit('emergency:used', { kind: 'cannibalize', timesUsed: this.uses });
    } else if (input.pressed('emergencyBeacon')) {
      this.choosing = false;
      const { universe, log } = this.opts;
      universe.recoverToOrbit();
      // The tank price, the hold, the note — before ship:recovered (Mining
      // aborts on it, applying nothing, and must find the hold settled).
      payBeacon(tank, universe.cargo ?? null, log ?? null, universe.system?.name ?? '—');
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
