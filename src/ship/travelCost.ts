/**
 * v4 sub-plan 1 (propellant), Task 4 — what cruise and jumps cost.
 *
 * Pure: the price list and the till. Cruise pays for its spool and for each
 * frame's distance; MapMode pays for a jump before `warp.engage`; StarMap
 * shows the price (`jumpPropellantRow`) beside JUMP EST.
 */

import { AU } from '@/gen/types';
import type { Propellant } from './propellant';
import { applyBeacon, applyCannibalize } from './emergency';

export type PropellantAction =
  | { kind: 'cruise-spool' }
  | { kind: 'cruise-leg'; distanceKm: number }
  | { kind: 'jump'; distanceLy: number }
  /** `timesUsed`: cannibalizations so far (prices the loss); omitted = 0. */
  | { kind: 'cannibalize'; part: 'tank' | 'cargo'; timesUsed?: number }
  | { kind: 'beacon' };

export interface ActionResult {
  ok: boolean;
  /** kg actually taken from the tank. */
  kg: number;
  /** `capacity`: the tank cannot carry a cannibalization's loss; `cargo-reserved`: sub-plan 2. */
  reason?: 'insufficient' | 'nothing-left' | 'capacity' | 'cargo-reserved';
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

export function applyAction(p: Propellant, a: PropellantAction): ActionResult {
  switch (a.kind) {
    case 'cruise-spool':
      return payAll(p, cruiseSpoolKg(p.capacityKg));
    case 'jump':
      return payAll(p, jumpPropellantFraction(a.distanceLy) * p.capacityKg);
    case 'cruise-leg': {
      const bill = cruiseLegKg(a.distanceKm, p.capacityKg);
      if (bill <= 0) return { ok: true, kg: 0 };
      const taken = p.consume(bill);
      return taken < bill ? { ok: false, kg: taken, reason: 'nothing-left' } : { ok: true, kg: taken };
    }
    case 'cannibalize':
      // Cargo cannibalization arrives with cargo (sub-plan 2).
      if (a.part === 'cargo') return { ok: false, kg: 0, reason: 'cargo-reserved' };
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

/** The chart's PROPELLANT row for a jump of `distanceLy`. */
export function jumpPropellantRow(p: Propellant, distanceLy: number): JumpPropellantRow {
  const frac = jumpPropellantFraction(distanceLy);
  const affordable = canAfford(p, frac * p.capacityKg);
  return { text: `PROPELLANT ${Math.round(frac * 100)} %`, tone: affordable ? 'normal' : 'warn', affordable };
}
