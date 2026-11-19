/**
 * v4 sub-plan 1 (propellant), Task 5 — what the HUD says about the tank, and
 * the numbers the autopilot checks before a landing. Pure: no DOM, no bus.
 */

import type { FlightModel } from '@/ship/FlightModel';
import { EXHAUST_VELOCITY_KMS } from '@/ship/propellant';

export type PropellantTone = 'normal' | 'caution' | 'warning';
export type AutoLandVerdict = 'go' | 'marginal' | 'refuse';

/** Below this fraction the tank reads caution. */
export const PROPELLANT_CAUTION = 0.25;
/** Below this fraction the tank reads warning. */
export const PROPELLANT_WARNING = 0.1;

/**
 * Loss factor on the ideal landing Δv (ruling R14). The real auto-land burns
 * far more than the orbit speed: gravity, drag and hover losses are drawn per
 * substep. Calibrated against the measured full-tank auto-land from the
 * opening orbit at Remit (≈ 1395 kg): 14 gives ≈ 1830 kg, ~25 % margin.
 * Pinned by `propellantReadout.test.ts` (the estimate is conservative).
 */
export const AUTOLAND_DV_FACTOR = 14;
/** The FINAL-segment hover allowance, km/s. */
export const AUTOLAND_HOVER_DV_KMS = 0.2;

export function propellantTone(fraction: number): PropellantTone {
  if (!(fraction >= PROPELLANT_WARNING)) return 'warning'; // NaN reads warning
  if (fraction <= PROPELLANT_CAUTION) return 'caution';
  return 'normal';
}

/**
 * Conservative propellant for an auto-land from the current state, kg:
 * Δv = AUTOLAND_DV_FACTOR · (|v rel. parent| + hover), then the rocket
 * equation on the current total mass (dry = the hull's config.mass): m0 · (1 − exp(−Δv/ve)).
 */
export function landingEstimateKg(flight: FlightModel): number {
  const dv = AUTOLAND_DV_FACTOR * (flight.velocity.length() + AUTOLAND_HOVER_DV_KMS);
  const m0 = flight.config.mass + (flight.propellant?.massKg ?? 0) + Math.max(0, flight.extraMassKg);
  return m0 * (1 - Math.exp(-dv / EXHAUST_VELOCITY_KMS));
}

export function autoLandVerdict(have: number, need: number): AutoLandVerdict {
  if (have >= need) return 'go';
  if (have >= 0.5 * need) return 'marginal';
  return 'refuse';
}

/** A starved engine delivers nothing: the throttle readout shows 0. */
export function effectiveThrottle(throttle: number, starved: boolean): number {
  return starved ? 0 : throttle;
}
