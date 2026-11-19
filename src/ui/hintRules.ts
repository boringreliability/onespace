/**
 * NAV ADVISORY — which single hint to show, and when a hint has been learnt.
 * Pure; `ui/Hints.ts` owns the DOM and the counting.
 *
 * Order, first match wins:
 *   not in flight/overlay/pause/busy → nothing (the overlay speaks for itself)
 *   pointer not captured → CLICK (never retires: it is a state, not a lesson)
 *   [v4-mining] mine (an asteroid targeted within mining range) — ahead of
 *     every lesson: it is a situation, not a curriculum step
 *   fly → cruise (only with a target, not already cruising) → scan → chart → pause
 */

import { MINING_KEYS } from '@/core/Input';
import type { CargoAction, CargoResult } from '@/ship/cargo';

export type HintId = 'click' | 'fly' | 'cruise' | 'scan' | 'chart' | 'pause' | 'mine';
export type RetirableHintId = Exclude<HintId, 'click'>;

export const HINT_TEXT: Readonly<Record<HintId, string>> = {
  click: 'CLICK TO TAKE THE CONTROLS',
  fly: 'W/S — THROTTLE · MOUSE — STEER',
  cruise: 'G — CRUISE',
  scan: 'T — SCAN',
  chart: 'M — CHART',
  pause: 'ESC — PAUSE',
  mine: `${MINING_KEYS.mine.replace(/^Key/, '')} — MINE`,
};

/** Uses after which a hint stops being shown. */
export const HINT_RETIRE_AFTER: Readonly<Record<RetirableHintId, number>> = {
  fly: 3,
  cruise: 2,
  scan: 2,
  chart: 2,
  pause: 2,
  /** [v4-mining] Retires after 2 COMPLETED mines (`recordCargoAction`). */
  mine: 2,
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
 * [v4-mining] Counts a `cargo:action` towards the 'mine' hint: only a
 * successful mine counts. Anything else returns `counts` itself.
 */
export function recordCargoAction(
  counts: HintCounts,
  e: { readonly action: CargoAction; readonly result: CargoResult },
): HintCounts {
  return e.action.kind === 'mine' && e.result.ok ? recordUse(counts, 'mine') : counts;
}

export function selectHint(state: HintState, counts: HintCounts): HintId | null {
  if (!state.inFlight || state.overlayOpen || state.paused || state.busy) return null;
  if (!state.pointerLocked) return 'click';
  if (state.asteroidInRange === true && !isRetired(counts, 'mine')) return 'mine';
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
