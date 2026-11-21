/**
 * v4 sub-plan 5, Task 4 — the HUD's action block, as rows. Pure: no DOM, no
 * three.js, no bus.
 *
 * `actionRow(kind, state)` turns what `Mining.status(kind)` hands out into what
 * one row prints: label, key, tone, text and bar fill (DESIGN-5 §7.3). Ready is
 * `▸ READY`; blocked is the refusal's log line, with the key that fixes it when
 * one does (`OUT OF RANGE — L TO APPROACH`), shortened where the log line is too
 * long for the panel; running is the kilograms this extraction has given, or
 * the whole seconds left, with a bar.
 *
 * `actionRows(status)` is what the HUD is handed each frame. It reuses three row
 * objects and rebuilds a row's text only when what it shows changed (kind,
 * reason, resource, whole kilogram, whole second): an extraction's text changes
 * with every kilogram, which is the only per-frame string it builds. The rows
 * are overwritten by the next call: read them, do not keep them.
 *
 * ActionState objects are Mining's, preallocated and mutated in place (and a
 * ready/blocked state's numbers live on its prototype): fields are read
 * directly, never copied, kept or compared by identity.
 */

import { MINING_KEYS } from '@/core/Input';
import type { Resource } from '@/gen/belt';
import type { ActionState, MiningKind } from '@/game/Mining';
import { ACTION_HINT, OCCUPIED_TEXT, REFUSAL_LOG, formatKg, type MiningRefusal } from '@/game/miningRules';

export type ActionLabel = 'MINE' | 'REFINE' | 'REPAIR';
export type ActionTone = 'ready' | 'blocked' | 'running';

export interface ActionRow {
  readonly label: ActionLabel;
  readonly key: string;
  readonly tone: ActionTone;
  readonly text: string;
  /** The bar, 0..1, while running; null hides it. */
  readonly fill: number | null;
}

type BlockedReason = Extract<ActionState, { kind: 'blocked' }>['reason'];

export const READY_TEXT = '▸ READY';

const KINDS: readonly [MiningKind, MiningKind, MiningKind] = ['mine', 'refine', 'repair'];

const LABEL: Readonly<Record<MiningKind, ActionLabel>> = { mine: 'MINE', refine: 'REFINE', repair: 'REPAIR' };

/** The key as printed: MINING_KEYS without the `Key` prefix. */
const KEY: Readonly<Record<MiningKind, string>> = {
  mine: MINING_KEYS.mine.replace(/^Key/, ''),
  refine: MINING_KEYS.refine.replace(/^Key/, ''),
  repair: MINING_KEYS.repair.replace(/^Key/, ''),
};

const RESOURCE_NAME: Readonly<Record<Resource, string>> = { ice: 'ICE', metal: 'METAL', silicate: 'SILICATE', rare: 'RARE' };

/** Row texts that are not a REFUSAL_LOG line: cruise and jump log OCCUPIED_TEXT, insufficient is too long for the panel. */
const OVERRIDE: Readonly<Partial<Record<BlockedReason, string>>> = {
  cruise: OCCUPIED_TEXT.cruise,
  jump: OCCUPIED_TEXT.jump,
  insufficient: 'NEED METAL · SILICATE',
};

/** Every blocked reason's row text, built once. */
const BLOCKED_TEXT: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const r of Object.keys(REFUSAL_LOG) as MiningRefusal[]) {
    const hint = ACTION_HINT[r];
    out[r] = hint !== undefined ? `${REFUSAL_LOG[r]} — ${hint}` : REFUSAL_LOG[r];
  }
  for (const r of Object.keys(OVERRIDE) as BlockedReason[]) out[r] = OVERRIDE[r]!;
  return out;
})();

function blockedText(reason: BlockedReason): string {
  return BLOCKED_TEXT[reason] ?? REFUSAL_LOG[reason as MiningRefusal] ?? String(reason).toUpperCase();
}

/** The whole kilograms formatKg prints (its rounding, sign kept). */
function wholeKg(kg: number): number {
  if (!Number.isFinite(kg)) return 0;
  return kg < 0 ? -Math.round(-kg) : Math.round(kg);
}

/** Whole seconds left, rounded up: a running action never shows 0 until it is. */
function wholeS(leftS: number): number {
  return Number.isFinite(leftS) && leftS > 0 ? Math.ceil(leftS) : 0;
}

const SECONDS_TEXT: string[] = [];
function secondsText(s: number): string {
  if (s < 64) return (SECONDS_TEXT[s] ??= `${s} S`);
  return `${s} S`;
}

function mineText(resource: Resource | null, kg: number): string {
  const name = resource !== null ? RESOURCE_NAME[resource] : '';
  return name ? `${name} ${formatKg(kg)} KG` : `${formatKg(kg)} KG`;
}

function clampFill(p: number): number {
  return p > 0 ? (p < 1 ? p : 1) : 0; // NaN → 0
}

function textOf(kind: MiningKind, state: ActionState): string {
  if (state.kind === 'ready') return READY_TEXT;
  if (state.kind === 'blocked') return blockedText(state.reason);
  return kind === 'mine' ? mineText(state.resource, state.shownKg) : secondsText(wholeS(state.leftS));
}

/** One row for one action. A new object per call; nothing in `state` is kept. */
export function actionRow(kind: MiningKind, state: ActionState): ActionRow {
  const running = state.kind === 'running';
  return {
    label: LABEL[kind],
    key: KEY[kind],
    tone: state.kind,
    text: textOf(kind, state),
    fill: running ? clampFill(state.progress) : null,
  };
}

interface MutableRow {
  label: ActionLabel;
  key: string;
  tone: ActionTone;
  text: string;
  fill: number | null;
}

// The three rows handed out by actionRows, and what each one's text was built from.
const ROWS: [MutableRow, MutableRow, MutableRow] = [
  { label: 'MINE', key: KEY.mine, tone: 'blocked', text: '', fill: null },
  { label: 'REFINE', key: KEY.refine, tone: 'blocked', text: '', fill: null },
  { label: 'REPAIR', key: KEY.repair, tone: 'blocked', text: '', fill: null },
];
const builtTone: Array<ActionTone | ''> = ['', '', ''];
const builtReason: Array<BlockedReason | null> = [null, null, null];
const builtResource: Array<Resource | null> = [null, null, null];
const builtNumber: number[] = [Number.NaN, Number.NaN, Number.NaN];

/**
 * The three rows — mine, refine, repair, asked in that order. The returned
 * tuple and its rows are reused by the next call.
 */
export function actionRows(status: (kind: MiningKind) => ActionState): readonly [ActionRow, ActionRow, ActionRow] {
  for (let i = 0; i < 3; i++) {
    const kind = KINDS[i]!;
    const s = status(kind);
    const row = ROWS[i]!;
    const tone = s.kind;
    let reason: BlockedReason | null = null;
    let resource: Resource | null = null;
    let n = 0;
    if (s.kind === 'blocked') reason = s.reason;
    else if (s.kind === 'running') {
      if (kind === 'mine') {
        resource = s.resource;
        n = wholeKg(s.shownKg);
      } else {
        n = wholeS(s.leftS);
      }
    }
    if (tone !== builtTone[i] || reason !== builtReason[i] || resource !== builtResource[i] || n !== builtNumber[i]) {
      builtTone[i] = tone;
      builtReason[i] = reason;
      builtResource[i] = resource;
      builtNumber[i] = n;
      row.text = textOf(kind, s);
    }
    row.tone = tone;
    row.fill = tone === 'running' ? clampFill(s.progress) : null;
  }
  return ROWS;
}

/** VEL's tone: 'ok' when a rock is targeted and the ship is slow enough to mine it. */
export function speedTone(ok: boolean | null): 'ok' | 'normal' {
  return ok === true ? 'ok' : 'normal';
}
