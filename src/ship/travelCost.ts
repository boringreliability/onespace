/**
 * v4 sub-plan 1 (propellant), Task 4 — what cruise and jumps cost.
 *
 * Pure: the price list and the till. Cruise pays for its spool and for each
 * frame's distance; MapMode pays for a jump before `warp.engage`; StarMap
 * shows the price (`jumpPropellantRow`) beside JUMP EST.
 */

import { bus } from '@/core/EventBus';
import { AU } from '@/gen/types';
import type { Propellant } from './propellant';
import { applyBeacon, applyCannibalize } from './emergency';

export type PropellantAction =
  | { kind: 'cruise-spool' }
  | { kind: 'cruise-leg'; distanceKm: number }
  | { kind: 'jump'; distanceLy: number }
  /** `timesUsed`: cannibalizations so far (prices the loss); omitted = 0. */
  /** The tank only: the hold burns through `applyCargoAction('cannibalize-cargo')` (R19). */
  | { kind: 'cannibalize'; part: 'tank'; timesUsed?: number }
  | { kind: 'beacon' }
  /** A jump the warp rejected: its price goes back. */
  | { kind: 'jump-refund'; kg: number }
  /** A spool that never became cruise: its price goes back. */
  | { kind: 'spool-refund'; kg: number };

export interface ActionResult {
  ok: boolean;
  /** kg actually taken from the tank (for a refund: actually put back). */
  kg: number;
  /**
   * `capacity`: the tank cannot carry a cannibalization's loss; `not-empty`: only a
   * dry tank is cannibalized.
   */
  reason?: 'insufficient' | 'nothing-left' | 'capacity' | 'not-empty';
}

const JUMP_BASE = 0.04;
const JUMP_PER_LY = 0.004;
const JUMP_MAX = 0.3;
/** Spool price, fraction of capacity. */
const SPOOL_FRACTION = 0.005;
/** Cruise price, fraction of capacity per AU. */
const CRUISE_FRACTION_PER_AU = 0.01;

/** Fraction of capacity a jump costs: 0.04 + 0.004·ly, clamped to [0.04, 0.3] (D2). */
export function jumpPropellantFraction(distanceLy: number): number {
  const ly = Number.isFinite(distanceLy) ? distanceLy : 0;
  return Math.min(JUMP_MAX, Math.max(JUMP_BASE, JUMP_BASE + JUMP_PER_LY * ly));
}

/** kg to spool the cruise drive: 0.5 % of capacity. */
export function cruiseSpoolKg(capacityKg: number): number {
  return SPOOL_FRACTION * Math.max(0, capacityKg);
}

/** kg for `distanceKm` of cruise: 1 % of capacity per AU, linear. */
export function cruiseLegKg(distanceKm: number, capacityKg: number): number {
  if (!(distanceKm > 0)) return 0;
  return (CRUISE_FRACTION_PER_AU * Math.max(0, capacityKg) * distanceKm) / AU;
}

export function canAfford(p: Propellant, kg: number): boolean {
  return p.massKg >= kg;
}

/** All-or-nothing: pays `kg` in full, or takes nothing. */
function payAll(p: Propellant, kg: number): ActionResult {
  if (!canAfford(p, kg) || (kg > 0 && p.empty)) return { ok: false, kg: 0, reason: p.empty ? 'nothing-left' : 'insufficient' };
  return { ok: true, kg: p.consume(kg) };
}

/**
 * The one way the game changes the tank (P3): apply the named action and
 * announce it once on the bus (`propellant:action`), refused or not.
 *
 * `announce: false` is for cruise legs only: Cruise bills the tank every
 * frame but announces the leg once per segment (`announceAction`), so the
 * bus is not flooded at 60 Hz.
 */
export function applyAction(
  p: Propellant,
  a: PropellantAction,
  opts: { announce?: boolean } = {},
): ActionResult {
  const r = apply(p, a);
  if (opts.announce !== false) announceAction(a, r);
  return r;
}

/** The single `propellant:action` emit. */
export function announceAction(a: PropellantAction, r: ActionResult): void {
  bus.emit('propellant:action', { action: a, ok: r.ok, kg: r.kg });
}

/** A refund puts back up to `kg` (clamped to the free space); `kg` reports what fit. */
function refund(p: Propellant, kg: number): ActionResult {
  return { ok: true, kg: p.add(kg) };
}

function apply(p: Propellant, a: PropellantAction): ActionResult {
  switch (a.kind) {
    case 'jump-refund':
    case 'spool-refund':
      return refund(p, a.kg);
    case 'cruise-spool':
      return payAll(p, cruiseSpoolKg(p.baseCapacityKg)); // R17: prices are fractions of BASE capacity
    case 'jump':
      return payAll(p, jumpPropellantFraction(a.distanceLy) * p.baseCapacityKg);
    case 'cruise-leg': {
      const bill = cruiseLegKg(a.distanceKm, p.baseCapacityKg);
      if (bill <= 0) return { ok: true, kg: 0 };
      const taken = p.consume(bill);
      return taken < bill ? { ok: false, kg: taken, reason: 'nothing-left' } : { ok: true, kg: taken };
    }
    case 'cannibalize':
      return applyCannibalize(p, a.timesUsed ?? 0);
    case 'beacon':
      return applyBeacon(p);
  }
}

export interface JumpPropellantRow {
  text: string;
  tone: 'normal' | 'warn';
  affordable: boolean;
}

/**
 * The chart's PROPELLANT row for a jump of `distanceLy`. The price is kg of
 * BASE capacity (R17); it is SHOWN as a share of the CURRENT tank, the unit of
 * the HUD's tank %, so the two numbers compare directly after a cannibalization.
 */
export function jumpPropellantRow(p: Propellant, distanceLy: number): JumpPropellantRow {
  const kg = jumpPropellantFraction(distanceLy) * p.baseCapacityKg;
  const affordable = canAfford(p, kg);
  const cap = p.capacityKg;
  const shown = cap > 0 ? Math.round((kg / cap) * 100) : 0;
  return { text: `PROPELLANT ${shown} %`, tone: affordable ? 'normal' : 'warn', affordable };
}
