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

import type { Propellant } from './propellant';
import type { ActionResult } from './travelCost';

/** Propellant gained by cannibalizing, fraction of BASE capacity. */
export const CANNIBALIZE_GAIN_FRAC = 0.03;
/** First cannibalization's permanent loss, fraction of BASE capacity. */
const LOSS_FIRST = 0.08;
/** Each further cannibalization costs this much more than the last. */
const LOSS_GROWTH = 1.5;
/** The beacon leaves the tank at this fraction of CURRENT capacity. */
export const BEACON_FILL_FRAC = 0.05;

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
 * (`add` clamps, so a badly shrunk tank keeps less than 3 %). Refused → untouched.
 */
export function applyCannibalize(p: Propellant, timesUsed: number): ActionResult {
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
