/**
 * v4 sub-plan 2, Task 5 — mining, as rules. Pure: no three.js, no bus.
 *
 * `mayMine` is the one gate (as `emergencyMayAct`, R16): Mining asks it on the
 * press and once every frame of an extraction, before that frame's bites
 * (plan 5: the pace is MINE_RATE_KG_S / MINE_BITE_KG in extraction.ts).
 * Precedence, first failure wins: busy → no-target → range → speed →
 * hold-full → depleted. Every limit is inclusive; NaN never passes.
 *
 * Plan 6 Task 2 (DESIGN-6 §7.2): the beam takes the resource the player
 * chose and nothing else. A rock without it is refused 'not-here', ranked
 * after everything the gate checks; Mining decides it (`hasResource`) after
 * `mayMine` passes, so the gate itself is unchanged. Its text is built from
 * the resource (`notHereText`): `NO RARE HERE`.
 */

import type { Resource } from '@/gen/belt';
import { REPAIR_METAL_KG, REPAIR_SILICATE_KG, type CargoResult } from '@/ship/cargo';

/** Mining reach, km from the asteroid's SURFACE. */
export const MINE_RANGE_KM = 0.5;
/** Most speed relative to the asteroid a mine tolerates, km/s. */
export const MINE_MAX_REL_KMS = 0.005;
/**
 * R18: less than this many kg of a resource is dust: it would log as
 * "MINED · 0 KG". A rock with less of every resource is depleted.
 */
export const MINE_MIN_KG = 0.5;
/** One refine, sim seconds. */
export const REFINE_ACTION_S = 8;
/** One repair, sim seconds. */
export const REPAIR_ACTION_S = 10;

/**
 * `'not-here'` (plan 6): the rock lacks the chosen resource. `mayMine` never
 * returns it — Mining decides it after the gate passes (`hasResource`), so it
 * ranks last.
 */
export type MayMineReason = 'no-target' | 'range' | 'speed' | 'hold-full' | 'depleted' | 'busy' | 'not-here';

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
  'not-here': NO('not-here'),
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
  // R18 / final review (c): less room than MINE_MIN_KG is full — the same line
  // that makes a rock depleted — so an accepted press never ends in HOLD FULL,
  // "MINED · 0 KG" or a dust record. An extraction's bite size uses it too.
  if (!(s.holdFreeKg >= MINE_MIN_KG)) return REFUSED['hold-full'];
  if (!(s.remainingKg >= MINE_MIN_KG)) return REFUSED.depleted;
  return OK;
}

/**
 * The rock has `r` to mine: at least MINE_MIN_KG of it (R18: less is dust;
 * NaN and negatives are nothing). Only answers for the player's choice — no
 * function picks a resource for the player (DESIGN-6 §7.2).
 */
export function hasResource(remaining: Readonly<Record<Resource, number>>, r: Resource): boolean {
  return remaining[r] >= MINE_MIN_KG;
}

/** The refusal when the rock lacks the chosen resource: `NO RARE HERE`. */
export function notHereText(r: Resource): string {
  return `NO ${r.toUpperCase()} HERE`;
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

/**
 * One log line per refusal reason, the gate's and the hold's. `'not-here'` is
 * not in it: its text names the beam's resource, `notHereText(beam)` (see
 * `refusalText`). The `'not-here'?: never` member only says so to the type
 * checker — indexing by any MiningRefusal compiles, and that key is never there.
 */
export const REFUSAL_LOG: Readonly<Record<Exclude<MiningRefusal, 'not-here'>, string>> & { readonly 'not-here'?: never } = {
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

/** The log line (and row text) for any refusal; `'not-here'` names the beam's resource. */
export function refusalText(reason: MiningRefusal, beam: Resource): string {
  return reason === 'not-here' ? notHereText(beam) : REFUSAL_LOG[reason];
}

/**
 * What a press refused for cruise or a jump logs, and what the action row
 * shows for those two states (DESIGN-5 §7.3): `BUSY` means only that another
 * action is running. Not refusals of the gate (`mayMine` says 'busy' for both).
 * [v4-resources] `recovery`: the resources screen refused while the beacon's
 * recovery runs (ui/Resources.ts); the action rows never show it.
 */
export const OCCUPIED_TEXT = { cruise: 'IN CRUISE', jump: 'IN JUMP', recovery: 'IN RECOVERY' } as const;

/** The next key for a refusal the player can act on. */
export const ACTION_HINT: Readonly<Partial<Record<MiningRefusal, string>>> = {
  range: 'L TO APPROACH',
  speed: 'SPACE TO STOP',
};
