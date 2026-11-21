/**
 * NAV ADVISORY — which single hint to show, and when a hint has been learnt.
 * Pure; `ui/Hints.ts` owns the DOM and the counting.
 *
 * Order, first match wins:
 *   not in flight/overlay/pause/busy → nothing (the overlay speaks for itself)
 *   pointer not captured → CLICK (never retires: it is a state, not a lesson)
 *   [v4-mining] mine (an asteroid targeted within mining range) — ahead of
 *     every lesson: it is a situation, not a curriculum step
 *   [v4-mining] approach (an asteroid targeted out of range), then refine
 *     (refine would run: ice aboard, room in the tank) — situations too
 *   fly → cruise (only with a target, not already cruising) → scan → chart → pause
 */

import { MINING_KEYS } from '@/core/Input';

export type HintId = 'click' | 'fly' | 'cruise' | 'scan' | 'chart' | 'pause' | 'mine' | 'approach' | 'refine';
export type RetirableHintId = Exclude<HintId, 'click'>;

export const HINT_TEXT: Readonly<Record<HintId, string>> = {
  click: 'CLICK TO TAKE THE CONTROLS',
  fly: 'W/S — THROTTLE · MOUSE — STEER',
  cruise: 'G — CRUISE',
  scan: 'T — SCAN',
  chart: 'M — CHART',
  pause: 'ESC — PAUSE',
  mine: `${MINING_KEYS.mine.replace(/^Key/, '')} — MINE`,
  /** [v4-mining] L is the autopilot's key; at a targeted rock it approaches. */
  approach: 'L — APPROACH',
  refine: `${MINING_KEYS.refine.replace(/^Key/, '')} — REFINE`,
};

/** Uses after which a hint stops being shown. */
export const HINT_RETIRE_AFTER: Readonly<Record<RetirableHintId, number>> = {
  fly: 3,
  cruise: 2,
  scan: 2,
  chart: 2,
  pause: 2,
  /** [v4-mining] Retires after 2 extractions that mined something (`recordMiningEnded`). */
  mine: 2,
  /** [v4-mining] Retires after 2 approaches the autopilot started (`recordApproach`). */
  approach: 2,
  /** [v4-mining] Retires after 2 completed refines (`recordActionEnded`). */
  refine: 2,
};

export type HintCounts = Partial<Record<RetirableHintId, number>>;

export interface HintState {
  /**
   * The game is in flight (not the title, the Yard or a photo overlay). The
   * line is a flight instrument: on the title it read CLICK TO TAKE THE
   * CONTROLS under the menu (review-p1).
   */
  readonly inFlight: boolean;
  readonly pointerLocked: boolean;
  /** A chart or the codex is up. */
  readonly overlayOpen: boolean;
  readonly paused: boolean;
  /** A jump or a recovery is running. */
  readonly busy: boolean;
  readonly hasTarget: boolean;
  readonly cruising: boolean;
  /** [v4-mining] An asteroid is targeted within mining range (`Mining.asteroidInRange`). */
  readonly asteroidInRange?: boolean;
  /** [v4-mining] An asteroid is targeted out of mining range (`miningHintFacts`). */
  readonly asteroidOutOfRange?: boolean;
  /** [v4-mining] A refine would run now: ice aboard, room in the tank (`miningHintFacts`). */
  readonly refinable?: boolean;
}

export const HINT_COUNTS_KEY = 'os.hints.v1';

const RETIRABLE = Object.keys(HINT_RETIRE_AFTER) as RetirableHintId[];

function isRetirable(id: HintId): id is RetirableHintId {
  return id !== 'click';
}

export function isRetired(counts: HintCounts, id: HintId): boolean {
  if (!isRetirable(id)) return false;
  return (counts[id] ?? 0) >= HINT_RETIRE_AFTER[id];
}

export function recordUse(counts: HintCounts, id: RetirableHintId): HintCounts {
  return { ...counts, [id]: (counts[id] ?? 0) + 1 };
}

/**
 * [v4-mining] Counts a `mining:ended` towards the 'mine' hint (plan 5): one
 * extraction counts once, however many bites it took, and only if it mined
 * something. Otherwise returns `counts` itself.
 */
export function recordMiningEnded(counts: HintCounts, e: { readonly minedKg: number }): HintCounts {
  return e.minedKg > 0 ? recordUse(counts, 'mine') : counts;
}

/**
 * [v4-mining] Counts an `action:ended` towards the 'refine' hint: only a
 * completed refine. An abort, a refused completion or a repair returns
 * `counts` itself.
 */
export function recordActionEnded(
  counts: HintCounts,
  e: { readonly kind: 'refine' | 'repair'; readonly ok: boolean },
): HintCounts {
  return e.kind === 'refine' && e.ok ? recordUse(counts, 'refine') : counts;
}

/**
 * [v4-mining] Counts the frame the autopilot starts an approach (its goal
 * becomes 'approach') towards the 'approach' hint. A refused L or a landing
 * never gets there; every other frame returns `counts` itself.
 */
export function recordApproach(
  counts: HintCounts,
  e: { readonly wasApproaching: boolean; readonly approaching: boolean },
): HintCounts {
  return e.approaching && !e.wasApproaching ? recordUse(counts, 'approach') : counts;
}

/** The part of `Mining.status(kind)` the hints read. */
export type MiningStatusLike =
  | { readonly kind: 'ready' | 'running' }
  | { readonly kind: 'blocked'; readonly reason: string };

/**
 * [v4-mining] The two lesson facts from `Mining.status`: out of range is the
 * mine row blocked for 'range' (the row's OUT OF RANGE — L TO APPROACH);
 * refinable is the refine row 'ready', so the line never says U when U would
 * be refused.
 */
export function miningHintFacts(
  mine: MiningStatusLike,
  refine: MiningStatusLike,
): { asteroidOutOfRange: boolean; refinable: boolean } {
  return {
    asteroidOutOfRange: mine.kind === 'blocked' && mine.reason === 'range',
    refinable: refine.kind === 'ready',
  };
}

export function selectHint(state: HintState, counts: HintCounts): HintId | null {
  if (!state.inFlight || state.overlayOpen || state.paused || state.busy) return null;
  if (!state.pointerLocked) return 'click';
  if (state.asteroidInRange === true && !isRetired(counts, 'mine')) return 'mine';
  if (state.asteroidOutOfRange === true && !isRetired(counts, 'approach')) return 'approach';
  if (state.refinable === true && !isRetired(counts, 'refine')) return 'refine';
  if (!isRetired(counts, 'fly')) return 'fly';
  if (state.hasTarget && !state.cruising && !isRetired(counts, 'cruise')) return 'cruise';
  if (!isRetired(counts, 'scan')) return 'scan';
  if (!isRetired(counts, 'chart')) return 'chart';
  if (!isRetired(counts, 'pause')) return 'pause';
  return null;
}

/**
 * [v4-fuel] The text on the NAV ADVISORY line. `emergencyLine` is the
 * emergency exit's line — already null unless `emergencyMayAct` holds (R16) —
 * and outranks every lesson; an open chart or codex, or leaving flight, still
 * hides the whole line. Otherwise the ordinary hint.
 */
export function advisoryText(state: HintState, counts: HintCounts, emergencyLine: string | null): string | null {
  if (emergencyLine !== null && state.inFlight && !state.overlayOpen) return emergencyLine;
  const id = selectHint(state, counts);
  return id ? HINT_TEXT[id] : null;
}

/** The subset of Storage these functions use, so tests can hand in a fake. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Whitelist parse: only known ids, only finite non-negative numbers. Anything
 * else — corrupt JSON, an array, a hostile key — is dropped, never passed on.
 */
export function loadHintCounts(store: KeyValueStore | null): HintCounts {
  if (!store) return {};
  let raw: string | null;
  try {
    raw = store.getItem(HINT_COUNTS_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const src = parsed as Record<string, unknown>;
  const out: HintCounts = {};
  for (const id of RETIRABLE) {
    if (!Object.prototype.hasOwnProperty.call(src, id)) continue;
    const v = src[id];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[id] = Math.floor(v);
  }
  return out;
}

export function saveHintCounts(store: KeyValueStore | null, counts: HintCounts): void {
  if (!store) return;
  try {
    store.setItem(HINT_COUNTS_KEY, JSON.stringify(counts));
  } catch {
    // Full or blocked storage: the hints come back next session. Harmless.
  }
}
