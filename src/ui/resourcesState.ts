/**
 * v4 sub-plan 6, Task 3 — the resources screen as rules (DESIGN-6 §7.1, §7.3,
 * §7.6). Pure: no DOM, no three.js, no bus. The DOM (src/ui/Resources.ts) and
 * the mode, gating and the key's binding in flight are Task 4's.
 *
 * `resourcesView(state)` is what the screen shows: the header, all four hold
 * lines in RESOURCE_ORDER (zero lines too), the USES rows and the footer.
 * A hold line's `text` is the name and the kilograms only; the ▸ (selected)
 * and ◉ (beam) marks are its flags, for the DOM to draw.
 *
 * `resourcesKey(key, state)` turns a keydown into an event:
 *  - ↑ / ↓ move the selection (a held arrow repeats); at either end nothing.
 *    From a corrupt selection (counted as ice) ↑ selects ice, ↓ rare.
 *  - Enter (or NumpadEnter, the same key: open choice 3): the beam takes the
 *    selected resource (held: nothing). Neither is bound in flight (D14). The
 *    choice does not depend on the hold — choosing what the hold lacks is the
 *    point.
 *  - O: throw out JETTISON_STEP_KG of the selected resource — always the step;
 *    the cargo rule throws out min(kg, held) and its result's kgOut is what the
 *    log reports. Shift+O: exactly what is held. Nothing of it (below what the
 *    line shows as 1 KG: dust, NaN, negative) gives no event. Held: nothing.
 *  - I (RESOURCES_KEY) or Esc: close (held: nothing). Shift changes only O.
 *  - Ctrl / Meta / Alt chords, and the function keys the game does not bind
 *    (all but F2, the screenshot), are the browser's: no event, default kept.
 *  - Every other key: no event, kept from the browser — and the DOM keeps it
 *    from the flight (Review Focus 5).
 * A selection or beam outside the four counts as ice, the default.
 */

import { RESOURCES_KEY, actionForKey } from '@/core/Input';
import type { Resource } from '@/gen/belt';
import type { ActionState, MiningKind } from '@/game/Mining';
import { formatKg } from '@/game/miningRules';
import { JETTISON_STEP_KG, REPAIR_METAL_KG, REPAIR_SILICATE_KG } from '@/ship/cargo';
import { actionRow, type ActionLabel, type ActionTone } from './actionRows';

/** The screen's line order: the beam's old order (DESIGN-6 §7.1). The HUD keeps its own. */
export const RESOURCE_ORDER: readonly Resource[] = Object.freeze(['ice', 'rare', 'metal', 'silicate'] as const);

/** The default selection and beam, and what a value outside the four counts as. */
const DEFAULT_RESOURCE: Resource = 'ice';

const NAME: Readonly<Record<Resource, string>> = { ice: 'ICE', rare: 'RARE', metal: 'METAL', silicate: 'SILICATE' };

/** Throws out the step (Shift: all) of the selected resource. Only on this screen, never in flight (§7.3). */
const JETTISON_CODE = 'KeyO';

/** The keys as the footer prints them. */
const RESOURCES_LETTER = RESOURCES_KEY.replace(/^Key/, '');
const JETTISON_LETTER = JETTISON_CODE.replace(/^Key/, '');

/**
 * Below this an amount shows as 0 KG (formatKg rounds 0.5 up to 1): "nothing
 * of it", so O and Shift+O do nothing.
 */
const SHOWN_MIN_KG = 0.5;

export interface Use {
  /** The action whose HUD row gives this row's status. */
  readonly kind: Extract<MiningKind, 'refine' | 'repair'>;
  readonly label: ActionLabel;
  readonly cost: string;
}

/**
 * What the hold can become today (§7.6): a table, not a recipe engine — it
 * performs nothing. Its status is the HUD row's (`actionRow`), never its own.
 */
export const USES: readonly Use[] = Object.freeze([
  Object.freeze({ kind: 'refine', label: 'REFINE', cost: `${NAME.ice} → PROPELLANT` } as const),
  Object.freeze({
    kind: 'repair',
    label: 'REPAIR',
    cost: `${formatKg(REPAIR_METAL_KG)} ${NAME.metal} + ${formatKg(REPAIR_SILICATE_KG)} SIL`,
  } as const),
]);

export const RESOURCES_FOOTER =
  `↑↓ SELECT   ENTER BEAM TAKES THIS   ${JETTISON_LETTER} JETTISON ${formatKg(JETTISON_STEP_KG)} KG   ` +
  `SHIFT+${JETTISON_LETTER} ALL   ${RESOURCES_LETTER} CLOSE`;

export interface ResourcesView {
  header: string;
  hold: ReadonlyArray<{ resource: Resource; text: string; selected: boolean; beam: boolean }>;
  uses: ReadonlyArray<{ label: string; cost: string; status: string; tone: ActionTone }>;
  footer: string;
}

export interface ResourcesViewInput {
  readonly cargo: Readonly<Record<Resource, number>>;
  readonly capacityKg: number;
  readonly selected: Resource;
  readonly beam: Resource;
  readonly refine: ActionState;
  readonly repair: ActionState;
}

export type ResourcesEvent =
  | { kind: 'select'; resource: Resource }
  | { kind: 'beam'; resource: Resource }
  | { kind: 'jettison'; resource: Resource; kg: number }
  | { kind: 'close' };

export interface ResourcesKeyInput {
  readonly code: string;
  readonly shift: boolean;
  readonly repeat: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
}

export interface ResourcesKeyState {
  readonly selected: Resource;
  readonly cargo: Readonly<Record<Resource, number>>;
}

export interface ResourcesKeyResult {
  event: ResourcesEvent | null;
  preventDefault: boolean;
}

/** The index in RESOURCE_ORDER; a value outside the four counts as ice. */
function indexOf(r: Resource): number {
  const i = RESOURCE_ORDER.indexOf(r);
  return i >= 0 ? i : RESOURCE_ORDER.indexOf(DEFAULT_RESOURCE);
}

/** One of the four: the value itself, or ice for anything else. */
function oneOfFour(r: Resource): Resource {
  return RESOURCE_ORDER[indexOf(r)]!;
}

/** What the hold holds of it: a finite amount above zero, or 0. */
function heldKg(cargo: Readonly<Record<Resource, number>>, r: Resource): number {
  const kg = cargo[r];
  return Number.isFinite(kg) && kg > 0 ? kg : 0;
}

export function resourcesView(s: ResourcesViewInput): ResourcesView {
  const selected = oneOfFour(s.selected);
  const beam = oneOfFour(s.beam);
  let total = 0;
  const hold = RESOURCE_ORDER.map((resource) => {
    const kg = heldKg(s.cargo, resource);
    total += kg;
    return { resource, text: `${NAME[resource]} ${formatKg(kg)} KG`, selected: resource === selected, beam: resource === beam };
  });
  const uses = USES.map((u) => {
    // The HUD's own rule (actionRow), so the screen and the HUD cannot say different things.
    const row = actionRow(u.kind, u.kind === 'refine' ? s.refine : s.repair);
    return { label: u.label, cost: u.cost, status: row.text, tone: row.tone };
  });
  return {
    header: `HOLD ${formatKg(total)} / ${formatKg(s.capacityKg)} KG`,
    hold,
    uses,
    footer: RESOURCES_FOOTER,
  };
}

const NONE: Readonly<ResourcesKeyResult> = Object.freeze({ event: null, preventDefault: true });
const BROWSER: Readonly<ResourcesKeyResult> = Object.freeze({ event: null, preventDefault: false });

const FUNCTION_KEY = /^F(?:[1-9]|1[0-2])$/;

function act(event: ResourcesEvent): ResourcesKeyResult {
  return { event, preventDefault: true };
}

export function resourcesKey(k: ResourcesKeyInput, s: ResourcesKeyState): ResourcesKeyResult {
  // The browser's shortcuts keep working: chords, and the function keys the game does not bind.
  if (k.ctrl || k.meta || k.alt) return { ...BROWSER };
  if (FUNCTION_KEY.test(k.code) && actionForKey(k.code) === undefined) return { ...BROWSER };

  const i = indexOf(s.selected);
  if (k.code === 'ArrowDown' || k.code === 'ArrowUp') {
    // A held arrow repeats; at either end it stays (no event). The event is sent
    // whenever the target differs from the value given, so a corrupt selection
    // (counted as ice) becomes one of the four on either arrow.
    const to = Math.min(Math.max(k.code === 'ArrowDown' ? i + 1 : i - 1, 0), RESOURCE_ORDER.length - 1);
    const target = RESOURCE_ORDER[to]!;
    if (target === s.selected) return { ...NONE };
    return act({ kind: 'select', resource: target });
  }
  // A held key never acts.
  if (k.repeat) return { ...NONE };

  const selected = RESOURCE_ORDER[i]!;
  switch (k.code) {
    case 'Enter':
    case 'NumpadEnter':
      return act({ kind: 'beam', resource: selected });
    case RESOURCES_KEY:
    case 'Escape':
      return act({ kind: 'close' });
    case JETTISON_CODE: {
      const held = heldKg(s.cargo, selected);
      if (held < SHOWN_MIN_KG) return { ...NONE };
      return act({ kind: 'jettison', resource: selected, kg: k.shift ? held : JETTISON_STEP_KG });
    }
    default:
      return { ...NONE };
  }
}
