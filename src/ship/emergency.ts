/**
 * v4 sub-plan 1 (propellant), Task 6 — the emergency exit, as rules.
 *
 * Pure. Two ways out of an empty tank, both paid for:
 * - cannibalize: strip part of the tank for a little propellant — +3 % of
 *   BASE capacity, for a permanent loss of 0.08 · 1.5^timesUsed of BASE
 *   capacity. Refused when the capacity left cannot carry the loss.
 * - beacon: recovered to a safe orbit with 5 % of the CURRENT capacity.
 *
 * The tank is changed only through capacityLossFrac / consume / add.
 */

import { applyCargoAction, type Cargo } from './cargo';
import type { Propellant } from './propellant';
import { applyAction, type ActionResult } from './travelCost';

/** Propellant gained by cannibalizing, fraction of BASE capacity. */
export const CANNIBALIZE_GAIN_FRAC = 0.03;
/** First cannibalization's permanent loss, fraction of BASE capacity. */
const LOSS_FIRST = 0.08;
/** Each further cannibalization costs this much more than the last. */
const LOSS_GROWTH = 1.5;
/** The beacon leaves the tank at this fraction of CURRENT capacity. */
export const BEACON_FILL_FRAC = 0.05;

/** What the one gate reads (R16): the keys and the NAV ADVISORY line both ask it. */
export interface EmergencyGate {
  readonly paused: boolean;
  readonly frozen: boolean;
  readonly recoveryActive: boolean;
  readonly warpPhase: string;
  readonly tank: Propellant | null;
}

/**
 * The exit may be offered and taken: a tank exists and is empty, and nothing
 * else owns the ship — not paused, not frozen, no recovery cut, warp idle.
 */
export function emergencyMayAct(g: EmergencyGate): boolean {
  return (
    !g.paused &&
    !g.frozen &&
    !g.recoveryActive &&
    g.warpPhase === 'idle' &&
    g.tank !== null &&
    g.tank.empty
  );
}

/** Uses so far; anything but a finite non-negative number counts as 0. */
function uses(timesUsed: number): number {
  return Number.isFinite(timesUsed) && timesUsed > 0 ? Math.floor(timesUsed) : 0;
}

/** Permanent loss of the next cannibalization, fraction of BASE capacity: 0.08 · 1.5^n. */
export function cannibalizeLossFrac(timesUsed: number): number {
  return LOSS_FIRST * LOSS_GROWTH ** uses(timesUsed);
}

/**
 * What cannibalizing would give and cost. Null when the capacity left cannot
 * carry the loss — equality included: a zero tank holds nothing. Pure.
 */
export function cannibalizeYield(
  p: Propellant,
  timesUsed: number,
): { gainKg: number; lossFrac: number } | null {
  const lossFrac = cannibalizeLossFrac(timesUsed);
  const remaining = 1 - p.capacityLossFrac;
  if (!(remaining > lossFrac)) return null;
  return { gainKg: CANNIBALIZE_GAIN_FRAC * p.baseCapacityKg, lossFrac };
}

/**
 * Cannibalize the tank: the loss first, then the gain into the smaller tank
 * (`add` clamps, so a badly shrunk tank keeps less than 3 %). Refused (tank not
 * empty, or the loss cannot be carried) → untouched.
 */
export function applyCannibalize(p: Propellant, timesUsed: number): ActionResult {
  // Only a dry tank is stripped (R16 minor 3): with propellant aboard it is not an emergency.
  if (!p.empty) return { ok: false, kg: 0, reason: 'not-empty' };
  const y = cannibalizeYield(p, timesUsed);
  if (!y) return { ok: false, kg: 0, reason: 'capacity' };
  p.capacityLossFrac = p.capacityLossFrac + y.lossFrac;
  p.add(y.gainKg);
  return { ok: true, kg: 0 };
}

/** The beacon's fill: the tank is SET to 5 % of current capacity (not topped up). */
export function applyBeacon(p: Propellant): ActionResult {
  p.consume(p.massKg);
  p.add(BEACON_FILL_FRAC * p.capacityKg);
  return { ok: true, kg: 0 };
}

/** Title of the logbook note every beacon writes. */
export const BEACON_NOTE_TITLE = 'BEACON RECOVERY';
const BEACON_KEY = /^beacon:(\d+)$/;

/** What payBeacon needs of the ship's log (`ShipLog` satisfies it). */
export interface BeaconLog {
  all(): readonly { readonly key: string }[];
  record(e: {
    key: string;
    kind: 'note';
    system: string;
    title: string;
    body: readonly string[];
  }): void;
}

/**
 * The next beacon's number: the highest `beacon:<n>` the log holds, + 1 (R19).
 * The counter lives in the log, so it is saved with it. Max, not count: the log
 * drops its oldest entries, and a count would then reuse a surviving key.
 */
function nextBeacon(log: BeaconLog): number {
  let n = 0;
  for (const e of log.all()) {
    const m = BEACON_KEY.exec(e.key);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return n + 1;
}

/**
 * [v4-mining] Task 6 — the beacon's whole price, in ONE place: Emergency key 2
 * and RecoveryCut's RETURN TO ORBIT with a tank (D11) both pay through here.
 * The tank is set to 5 % (the beacon action), the whole hold is jettisoned
 * (one `jettison-all`, announced even when the hold is empty) and the log gets
 * a 'BEACON RECOVERY' note under its own key. `system`: where it happened, from
 * the caller. Callers announce `ship:recovered` AFTER this, so whatever lets go
 * on it (Mining aborts, applying nothing) already sees the empty hold.
 *
 * A hull without a hold (null) has nothing to jettison; without a log
 * (null) no note is written — the tank price is paid regardless.
 */
export function payBeacon(
  tank: Propellant,
  cargo: Cargo | null,
  log: BeaconLog | null,
  system: string,
): void {
  applyAction(tank, { kind: 'beacon' });
  const kg = cargo ? Math.round(applyCargoAction(cargo, tank, { kind: 'jettison-all' }).kgOut) : 0;
  if (!log) return;
  log.record({
    key: `beacon:${nextBeacon(log)}`,
    kind: 'note',
    system,
    title: BEACON_NOTE_TITLE,
    body: [
      'distress beacon answered · returned to a safe orbit',
      kg > 0 ? `hold jettisoned · ${kg} kg` : 'hold empty · nothing jettisoned',
    ],
  });
}
