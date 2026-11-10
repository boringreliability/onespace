/**
 * v4 sub-plan 2, Task 5 — mining, as rules. Pure: no three.js, no bus.
 *
 * `mayMine` is the one gate (as `emergencyMayAct`, R16): Mining asks it on the
 * press, every frame of the action and again on the completion frame.
 * Precedence, first failure wins: busy → no-target → range → speed →
 * hold-full → depleted. Every limit is inclusive; NaN never passes.
 */

import type { Resource } from '@/gen/belt';
import { CARGO_EPS_KG, REPAIR_METAL_KG, REPAIR_SILICATE_KG, type CargoResult } from '@/ship/cargo';

/** Mining reach, km from the asteroid's SURFACE. */
export const MINE_RANGE_KM = 0.5;
/** Most speed relative to the asteroid a mine tolerates, km/s. */
export const MINE_MAX_REL_KMS = 0.005;
/** One mine, sim seconds. */
export const MINE_ACTION_S = 4;
/** Most one mine yields, kg. */
export const MINE_YIELD_KG = 2_000;
/**
 * R18: less than this many kg of a resource is dust: it would log as
 * "MINED · 0 KG". A rock with less of every resource is depleted.
 */
export const MINE_MIN_KG = 0.5;
/** One refine, sim seconds. */
export const REFINE_ACTION_S = 8;
/** One repair, sim seconds. */
export const REPAIR_ACTION_S = 10;

export type MayMineReason = 'no-target' | 'range' | 'speed' | 'hold-full' | 'depleted' | 'busy';

export interface MineGate {
  readonly paused: boolean;
  readonly frozen: boolean;
  readonly cruise: boolean;
  readonly warpPhase: string;
  readonly targetIsAsteroid: boolean;
  readonly surfaceRangeKm: number;
  readonly relSpeedKmS: number;
  readonly holdFreeKg: number;
  readonly remainingKg: number;
}

export interface MayMineResult {
  ok: boolean;
  reason?: MayMineReason;
}

// Shared answers: the gate runs every frame and must not allocate.
const OK: MayMineResult = Object.freeze({ ok: true });
const NO = (reason: MayMineReason): MayMineResult => Object.freeze({ ok: false, reason });
const REFUSED: Readonly<Record<MayMineReason, MayMineResult>> = {
  busy: NO('busy'),
  'no-target': NO('no-target'),
  range: NO('range'),
  speed: NO('speed'),
  'hold-full': NO('hold-full'),
  depleted: NO('depleted'),
};

/** Nothing else owns the ship: not paused, frozen, cruising or mid-warp. */
export function mayAct(s: { paused: boolean; frozen: boolean; cruise: boolean; warpPhase: string }): boolean {
  return !s.paused && !s.frozen && !s.cruise && s.warpPhase === 'idle';
}

export function mayMine(s: MineGate): MayMineResult {
  if (!mayAct(s)) return REFUSED.busy;
  if (!s.targetIsAsteroid) return REFUSED['no-target'];
  if (!(s.surfaceRangeKm <= MINE_RANGE_KM)) return REFUSED.range;
  if (!(s.relSpeedKmS <= MINE_MAX_REL_KMS)) return REFUSED.speed;
  // R18: the hold's own rule, so an accepted press never ends in HOLD FULL.
  if (!(s.holdFreeKg >= CARGO_EPS_KG)) return REFUSED['hold-full'];
  if (!(s.remainingKg >= MINE_MIN_KG)) return REFUSED.depleted;
  return OK;
}

/** Preference order when nothing (or nothing present) is preferred. */
const ORDER: readonly Resource[] = ['ice', 'rare', 'metal', 'silicate'];

/**
 * The resource a mine takes: `prefer` if present, else ice, rare, metal,
 * silicate. Less than MINE_MIN_KG counts as absent (R18). Null when none is left.
 */
export function chooseResource(remaining: Readonly<Record<Resource, number>>, prefer?: Resource): Resource | null {
  if (prefer !== undefined && remaining[prefer] >= MINE_MIN_KG) return prefer;
  for (const r of ORDER) if (remaining[r] >= MINE_MIN_KG) return r;
  return null;
}

/** Whole kilograms, grouped by thousands with a space: 2000 → "2 000". */
export function formatKg(kg: number): string {
  const n = Math.round(Number.isFinite(kg) ? Math.abs(kg) : 0);
  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ' ';
    out += s[i];
  }
  return kg < 0 && n > 0 ? `-${out}` : out;
}

export const MINING_ABORTED_TEXT = 'MINING ABORTED';
export const REFINING_ABORTED_TEXT = 'REFINING ABORTED';
export const REPAIR_ABORTED_TEXT = 'REPAIR ABORTED';

export function minedLog(kg: number, r: Resource): string {
  return `MINED · ${formatKg(kg)} KG ${r.toUpperCase()}`;
}

export function refinedLog(fuelKg: number): string {
  return `REFINED · ${formatKg(fuelKg)} KG PROPELLANT`;
}

export function repairedLog(restoredFrac: number): string {
  return `REPAIRED · TANK +${Math.round(restoredFrac * 100)} %`;
}

export type MiningRefusal = MayMineReason | NonNullable<CargoResult['reason']>;

/** One log line per refusal reason, the gate's and the hold's. */
export const REFUSAL_LOG: Readonly<Record<MiningRefusal, string>> = {
  busy: 'BUSY',
  'no-target': 'NO ASTEROID TARGETED',
  range: 'OUT OF RANGE',
  speed: 'MATCH SPEED',
  'hold-full': 'HOLD FULL',
  depleted: 'DEPLETED',
  'nothing-to-refine': 'NO ICE',
  'tank-full': 'TANK FULL',
  insufficient: `NEED ${formatKg(REPAIR_METAL_KG)} KG METAL · ${formatKg(REPAIR_SILICATE_KG)} KG SILICATE`,
  'nothing-to-repair': 'TANK UNDAMAGED',
  empty: 'HOLD EMPTY',
  'not-empty': 'TANK NOT EMPTY',
  'no-tank': 'NO TANK',
  invalid: 'INVALID AMOUNT',
};
