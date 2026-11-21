/**
 * v4 sub-plan 5, Task 1 — extraction as rules. An extraction takes one
 * resource and stops when it runs out: it accrues kilograms at a fixed rate,
 * hands them out in bites, and ends with one of nine reasons, each with its own
 * log line. Pure: no three.js, no bus. accrue/nextBiteKg/commitBite/shownKg
 * run every frame and must not allocate.
 */

import type { Resource } from '@/gen/belt';
import { MINE_MIN_KG, REFUSAL_LOG, formatKg, minedLog } from '@/game/miningRules';

/** Kilograms mined per sim second. */
export const MINE_RATE_KG_S = 150;
/** Most one bite takes, kg. */
export const MINE_BITE_KG = 250;

export interface Extraction {
  asteroidId: string;
  resource: Resource;
  /** Kilograms already handed to the hold. */
  minedKg: number;
  /** Kilograms accrued but not yet handed out as a bite. */
  carryKg: number;
}

export function startExtraction(asteroidId: string, resource: Resource): Extraction {
  return { asteroidId, resource, minedKg: 0, carryKg: 0 };
}

/** Negative, NaN or infinite time counts as 0. */
export function accrue(e: Extraction, simSeconds: number): void {
  if (Number.isFinite(simSeconds) && simSeconds > 0) e.carryKg += MINE_RATE_KG_S * simSeconds;
}

/** Size of the next bite: min(MINE_BITE_KG, room, rest); under MINE_MIN_KG there is none. */
function biteSize(holdFreeKg: number, remainingKg: number): number {
  const size = Math.min(MINE_BITE_KG, holdFreeKg, remainingKg);
  return size >= MINE_MIN_KG ? size : 0;
}

/** The bite due now (inclusive), else 0. */
export function nextBiteKg(e: Extraction, holdFreeKg: number, remainingKg: number): number {
  const size = biteSize(holdFreeKg, remainingKg);
  return size > 0 && e.carryKg >= size ? size : 0;
}

export function commitBite(e: Extraction, kg: number): void {
  e.minedKg += kg;
  e.carryKg -= kg;
}

/** minedKg plus the begun part of the next bite, for the HUD's smooth number. */
export function shownKg(e: Extraction, holdFreeKg: number, remainingKg: number): number {
  const size = biteSize(holdFreeKg, remainingKg);
  return e.minedKg + (size > 0 ? Math.min(e.carryKg, size) : 0);
}

export type ExtractionEnd =
  | 'stopped'
  | 'hold-full'
  | 'resource-depleted'
  | 'rock-depleted'
  | 'range'
  | 'speed'
  | 'no-target'
  | 'busy'
  | 'interrupted';

const STOPPED = 'MINING STOPPED';

export function extractionLog(end: ExtractionEnd, minedKg: number, resource: Resource): string {
  const some = minedKg >= MINE_MIN_KG;
  const tail = some ? ` · ${formatKg(minedKg)} KG ${resource.toUpperCase()}` : '';
  switch (end) {
    case 'stopped':
      return some ? minedLog(minedKg, resource) : STOPPED;
    case 'hold-full':
      return some ? `${minedLog(minedKg, resource)} — ${REFUSAL_LOG['hold-full']}` : STOPPED;
    case 'resource-depleted':
      return some ? `${minedLog(minedKg, resource)} — ${resource.toUpperCase()} ${REFUSAL_LOG.depleted}` : STOPPED;
    case 'rock-depleted':
      return some ? `${minedLog(minedKg, resource)} — ${REFUSAL_LOG.depleted}` : STOPPED;
    case 'range':
    case 'speed':
    case 'no-target':
      return `${STOPPED} — ${REFUSAL_LOG[end]}${tail}`;
    default:
      return `${STOPPED}${tail}`;
  }
}
