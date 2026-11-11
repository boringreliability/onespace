/**
 * Formation assist (v3 T4, PLAN G): FA-hold referenced to a target's
 * velocity. The flight model gains one optional reference; this is the rest.
 */

import type { Vector3 } from 'three';

/** Toggle while a vessel (or, v4, an asteroid) is targeted. Free in every other binding. */
export const FORMATION_KEY = 'KeyK';
/** Beyond this a contact is not "in formation", it is somewhere else. */
export const FORMATION_RANGE_KM = 50;

/** The FA hold target: nose · vset, plus the reference when there is one. */
export function formationHoldVelocity(forward: Vector3, vset: number, reference: Vector3 | null, out: Vector3): Vector3 {
  out.copy(forward).multiplyScalar(vset);
  if (reference) out.add(reference);
  return out;
}

export function mayHoldFormation(s: {
  readonly fa: boolean;
  readonly targetIsVessel: boolean;
  /** [v4-mining] An asteroid holds formation like a vessel: same gates. */
  readonly targetIsAsteroid?: boolean;
  readonly distanceKm: number;
  readonly cruise: boolean;
  /**
   * [v4-mining] The ship is in a belt field's frame (game/fieldFrame.ts): an
   * asteroid then holds formation at any distance (the rocks share the
   * field's velocity). Vessels keep FORMATION_RANGE_KM.
   */
  readonly inFieldFrame?: boolean;
}): boolean {
  if (!s.fa || s.cruise || !Number.isFinite(s.distanceKm)) return false;
  if (s.targetIsVessel) return s.distanceKm <= FORMATION_RANGE_KM;
  if (s.targetIsAsteroid === true) return s.inFieldFrame === true || s.distanceKm <= FORMATION_RANGE_KM;
  return false;
}
