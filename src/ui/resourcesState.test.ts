/**
 * v4 sub-plan 6, Task 3 (phase A) — the resources screen as rules
 * (DESIGN-6 §7.1, §7.3, §7.6). Pure: no DOM, no bus. The screen's state
 * becomes lines (`resourcesView`), a key becomes an event (`resourcesKey`).
 * The DOM (src/ui/Resources.ts) is Task 4's.
 *
 * Assumed surface (src/ui/resourcesState.ts):
 *
 *   RESOURCE_ORDER: readonly Resource[]           // ['ice', 'rare', 'metal', 'silicate']
 *   USES: ReadonlyArray<{ label: string; cost: string; … }>
 *      // [ { REFINE, 'ICE → PROPELLANT' }, { REPAIR, '600 METAL + 400 SIL' } ],
 *      // the numbers read from REPAIR_METAL_KG / REPAIR_SILICATE_KG
 *   interface ResourcesView {
 *     header: string;                              // `HOLD 6 250 / 8 000 KG`
 *     hold: ReadonlyArray<{ resource; text; selected; beam }>;
 *     uses: ReadonlyArray<{ label; cost; status; tone: 'ready' | 'blocked' | 'running' }>;
 *     footer: string;
 *   }
 *   resourcesView(s: { cargo; capacityKg; selected; beam; refine: ActionState; repair: ActionState }): ResourcesView
 *   type ResourcesEvent =
 *     | { kind: 'select'; resource } | { kind: 'beam'; resource }
 *     | { kind: 'jettison'; resource; kg } | { kind: 'close' }
 *   resourcesKey(k: { code; shift; repeat; ctrl?; meta?; alt? }, s: { selected; cargo }):
 *     { event: ResourcesEvent | null; preventDefault: boolean }
 *
 * Choices this file pins (phase A, for the owner's approval):
 *  - A hold line's `text` is the name and the kilograms only (`ICE  5 000 KG`,
 *    spacing free); the ▸ and ◉ marks are the `selected` / `beam` flags.
 *  - An arrow that cannot move (down from silicate, up from ice) gives no event.
 *  - `KeyO` always carries JETTISON_STEP_KG, also when less is held: the cargo
 *    rule throws out min(kg, held), and the log reports what really left.
 *    `Shift+KeyO` carries exactly what is held.
 *  - "Nothing of it" means what the line shows: below what formatKg prints as
 *    1 (dust, NaN, negative) O and Shift+O give no event.
 *  - Shift changes only O. A held key (repeat) still moves the selection, but
 *    never beams, jettisons or closes.
 *  - Ctrl / Meta / Alt chords and the function keys other than the game's F2
 *    are the browser's: no event, preventDefault false (as titleKey /
 *    conflictKey do for chords). Every other key gives no event but is kept
 *    from the browser — and the DOM keeps it from the flight (Review Focus 5).
 *  - A selection or beam outside the four counts as ice, the default.
 *
 * The module does not exist yet: it is loaded by a path the type checker does
 * not follow, and every test first asserts the export it needs, so a failure
 * says what is missing and `npm run typecheck` stays clean.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { Resource } from '@/gen/belt';
import type { ActionState } from '@/game/Mining';
import { formatKg } from '@/game/miningRules';
import { CARGO_CAPACITY_KG, JETTISON_STEP_KG, REPAIR_METAL_KG, REPAIR_SILICATE_KG } from '@/ship/cargo';
import { actionRow } from './actionRows';

// -----------------------------------------------------------------------------
// The module under test, loaded without the type checker following the path.

type Cargo4 = Readonly<Record<Resource, number>>;
type Tone = 'ready' | 'blocked' | 'running';

interface HoldLine {
  resource: Resource;
  text: string;
  selected: boolean;
  beam: boolean;
}
interface UseLine {
  label: string;
  cost: string;
  status: string;
  tone: Tone;
}
interface View {
  header: string;
  hold: readonly HoldLine[];
  uses: readonly UseLine[];
  footer: string;
}
interface ViewInput {
  cargo: Cargo4;
  capacityKg: number;
  selected: Resource;
  beam: Resource;
  refine: ActionState;
  repair: ActionState;
}
type Event =
  | { kind: 'select'; resource: Resource }
  | { kind: 'beam'; resource: Resource }
  | { kind: 'jettison'; resource: Resource; kg: number }
  | { kind: 'close' };
interface KeyIn {
  code: string;
  shift: boolean;
  repeat: boolean;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
}
interface KeyOut {
  event: Event | null;
  preventDefault: boolean;
}

interface Mod {
  RESOURCE_ORDER?: readonly Resource[];
  USES?: ReadonlyArray<{ label: string; cost: string }>;
  resourcesView?: (s: ViewInput) => View;
  resourcesKey?: (k: KeyIn, s: { selected: Resource; cargo: Cargo4 }) => KeyOut;
}

const MODULE = './resourcesState';
let mod: Mod = {};
let loadError: unknown = null;

beforeAll(async () => {
  try {
    mod = (await import(/* @vite-ignore */ MODULE)) as Mod;
  } catch (e) {
    loadError = e;
  }
});

function need<K extends keyof Mod>(name: K): NonNullable<Mod[K]> {
  expect(loadError, 'src/ui/resourcesState.ts must exist').toBeNull();
  expect(mod[name], `resourcesState must export ${name}`).toBeDefined();
  return mod[name] as NonNullable<Mod[K]>;
}

// -----------------------------------------------------------------------------
// Helpers.

const SCREEN_ORDER: readonly Resource[] = ['ice', 'rare', 'metal', 'silicate'];
const NAME: Readonly<Record<Resource, string>> = { ice: 'ICE', rare: 'RARE', metal: 'METAL', silicate: 'SILICATE' };

const FOOTER = '↑↓ SELECT   ENTER BEAM TAKES THIS   O JETTISON 250 KG   SHIFT+O ALL   I CLOSE';

const idle = { progress: 0, shownKg: 0, leftS: 0, resource: null } as const;
const ready: ActionState = { kind: 'ready', ...idle };
const blocked = (reason: Extract<ActionState, { kind: 'blocked' }>['reason']): ActionState => ({ kind: 'blocked', reason, ...idle });
const timed = (leftS: number, progress: number): ActionState => ({ kind: 'running', progress, shownKg: 0, leftS, resource: null });

const cargo = (o: Partial<Record<Resource, number>> = {}): Cargo4 => ({ ice: 0, rare: 0, metal: 0, silicate: 0, ...o });

/** The sketch in DESIGN-6 §7.1. */
const SKETCH = cargo({ ice: 5000, rare: 250, metal: 1000, silicate: 0 });

const input = (o: Partial<ViewInput> = {}): ViewInput => ({
  cargo: cargo(),
  capacityKg: CARGO_CAPACITY_KG,
  selected: 'ice',
  beam: 'ice',
  refine: ready,
  repair: ready,
  ...o,
});

const key = (code: string, o: Partial<KeyIn> = {}): KeyIn => ({ code, shift: false, repeat: false, ...o });
const NONE: KeyOut = { event: null, preventDefault: true };
const BROWSER: KeyOut = { event: null, preventDefault: false };

/** `^ NAME  1 234 KG $`, spacing free. */
const lineRe = (r: Resource, kg: number): RegExp => new RegExp(`^\\s*${NAME[r]}\\s+${formatKg(kg)} KG\\s*$`);

/** A resource that is not one of the four (a corrupt value from outside the types). */
const GOLD = 'gold' as unknown as Resource;

// Key codes built, not typed, so no binding is spelled out here.
const letter = (c: string): string => `Key${c}`;
const LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
const SCREEN_LETTERS = ['I', 'O'];
const OTHER_KEYS: readonly string[] = [
  ...LETTERS.filter((c) => !SCREEN_LETTERS.includes(c)).map(letter),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'Tab',
  'ShiftLeft',
  'Comma',
  'Period',
  'F2',
];
/** Function keys left to the browser (reload, fullscreen, devtools …); F2 is the game's screenshot. */
const BROWSER_F_KEYS: readonly string[] = Array.from({ length: 12 }, (_, i) => `F${i + 1}`).filter((f) => f !== 'F2');

// =============================================================================
//  The order and the table
// =============================================================================

describe('RESOURCE_ORDER and USES', () => {
  it('Given the screen, Then the order is ice, rare, metal, silicate (the beam\'s old order)', () => {
    expect(need('RESOURCE_ORDER')).toEqual(['ice', 'rare', 'metal', 'silicate']);
  });

  it('Given the USES table, Then it has two rows: REFINE / ICE → PROPELLANT and REPAIR / 600 METAL + 400 SIL, the numbers read from the repair constants', () => {
    // Preconditions: the spec's numbers are today's constants.
    expect(REPAIR_METAL_KG).toBe(600);
    expect(REPAIR_SILICATE_KG).toBe(400);
    const uses = need('USES');
    expect(uses).toHaveLength(2);
    expect(uses[0]!.label).toBe('REFINE');
    expect(uses[0]!.cost).toBe('ICE → PROPELLANT');
    expect(uses[1]!.label).toBe('REPAIR');
    expect(uses[1]!.cost).toBe(`${formatKg(REPAIR_METAL_KG)} METAL + ${formatKg(REPAIR_SILICATE_KG)} SIL`);
    expect(uses[1]!.cost).toBe('600 METAL + 400 SIL');
  });
});

// =============================================================================
//  resourcesView — what the screen shows
// =============================================================================

describe('resourcesView — HOLD', () => {
  it('Given the sketch\'s hold (silicate 0 kg), Then all four resources are shown in RESOURCE_ORDER, with their kilograms', () => {
    const v = need('resourcesView')(input({ cargo: SKETCH }));
    expect(SKETCH.silicate).toBe(0); // precondition: a zero line is in it
    expect(v.hold.map((l) => l.resource)).toEqual(SCREEN_ORDER);
    for (const l of v.hold) expect(l.text, l.resource).toMatch(lineRe(l.resource, SKETCH[l.resource]));
    expect(v.hold[0]!.text).toMatch(/^\s*ICE\s+5 000 KG\s*$/);
    expect(v.hold[1]!.text).toMatch(/^\s*RARE\s+250 KG\s*$/);
    expect(v.hold[2]!.text).toMatch(/^\s*METAL\s+1 000 KG\s*$/);
    expect(v.hold[3]!.text).toMatch(/^\s*SILICATE\s+0 KG\s*$/);
  });

  it('Given an empty hold, Then all four lines are still there, each at 0 KG', () => {
    const v = need('resourcesView')(input());
    expect(v.hold.map((l) => l.resource)).toEqual(SCREEN_ORDER);
    for (const l of v.hold) expect(l.text, l.resource).toMatch(lineRe(l.resource, 0));
  });

  it('Given a hold line, Then its text carries no ▸ or ◉: the marks are the selected / beam flags', () => {
    const v = need('resourcesView')(input({ cargo: SKETCH, selected: 'metal', beam: 'metal' }));
    for (const l of v.hold) expect(l.text, l.resource).not.toMatch(/[▸◉]/);
  });

  it.each([
    ['ice', 'ice'],
    ['metal', 'rare'],
    ['silicate', 'ice'],
    ['rare', 'silicate'],
  ] as const)('Given selected %s and beam %s, Then exactly one line is selected and exactly one is the beam, each the named one', (selected, beam) => {
    const v = need('resourcesView')(input({ cargo: SKETCH, selected, beam }));
    const sel = v.hold.filter((l) => l.selected);
    const bm = v.hold.filter((l) => l.beam);
    expect(sel).toHaveLength(1);
    expect(bm).toHaveLength(1);
    expect(sel[0]!.resource).toBe(selected);
    expect(bm[0]!.resource).toBe(beam);
  });

  it('Given the beam on a resource the hold has none of (rare, 0 kg), Then that line is still the beam', () => {
    const v = need('resourcesView')(input({ cargo: cargo({ ice: 3000 }), beam: 'rare' }));
    const rare = v.hold.find((l) => l.resource === 'rare')!;
    expect(rare.text).toMatch(lineRe('rare', 0));
    expect(rare.beam).toBe(true);
  });

  it('Given a selection and a beam outside the four (a corrupt value), Then the one selected line and the one beam line are ice, the default', () => {
    const v = need('resourcesView')(input({ cargo: SKETCH, selected: GOLD, beam: GOLD }));
    expect(v.hold.filter((l) => l.selected).map((l) => l.resource)).toEqual(['ice']);
    expect(v.hold.filter((l) => l.beam).map((l) => l.resource)).toEqual(['ice']);
  });

  it('Given cargo values that are NaN or negative, Then those lines show 0 KG and the header does not count them', () => {
    const v = need('resourcesView')(input({ cargo: cargo({ ice: Number.NaN, rare: -50, metal: 1000, silicate: -0.4 }) }));
    expect(v.hold.find((l) => l.resource === 'ice')!.text).toMatch(lineRe('ice', 0));
    expect(v.hold.find((l) => l.resource === 'rare')!.text).toMatch(lineRe('rare', 0));
    expect(v.hold.find((l) => l.resource === 'silicate')!.text).toMatch(lineRe('silicate', 0));
    expect(v.hold.find((l) => l.resource === 'metal')!.text).toMatch(lineRe('metal', 1000));
    expect(v.header).toBe('HOLD 1 000 / 8 000 KG');
  });

  it('Given dust (0.3 kg ice), Then the line shows 0 KG, as formatKg prints it', () => {
    expect(formatKg(0.3)).toBe('0'); // precondition
    const v = need('resourcesView')(input({ cargo: cargo({ ice: 0.3 }) }));
    expect(v.hold[0]!.text).toMatch(/^\s*ICE\s+0 KG\s*$/);
  });
});

describe('resourcesView — header and footer', () => {
  it('Given the sketch\'s hold, Then the header is HOLD 6 250 / 8 000 KG', () => {
    expect(CARGO_CAPACITY_KG).toBe(8000); // precondition
    expect(need('resourcesView')(input({ cargo: SKETCH })).header).toBe('HOLD 6 250 / 8 000 KG');
  });

  it('Given an empty hold, Then the header is HOLD 0 / 8 000 KG', () => {
    expect(need('resourcesView')(input()).header).toBe('HOLD 0 / 8 000 KG');
  });

  it('Given a full hold, Then the header is HOLD 8 000 / 8 000 KG', () => {
    const full = cargo({ ice: 5000, rare: 500, metal: 1500, silicate: 1000 });
    expect(full.ice + full.rare + full.metal + full.silicate).toBe(CARGO_CAPACITY_KG); // precondition
    expect(need('resourcesView')(input({ cargo: full })).header).toBe('HOLD 8 000 / 8 000 KG');
  });

  it('Given another capacity, Then the header reads the capacity it is handed, not the constant', () => {
    expect(need('resourcesView')(input({ capacityKg: 4000, cargo: cargo({ metal: 250 }) })).header).toBe('HOLD 250 / 4 000 KG');
  });

  it('Given any state, Then the footer is the spec\'s line, word for word, and its jettison step is JETTISON_STEP_KG', () => {
    expect(JETTISON_STEP_KG).toBe(250); // precondition
    const view = need('resourcesView');
    for (const s of [input(), input({ cargo: SKETCH, selected: 'silicate', beam: 'rare', refine: timed(3, 0.5) })]) {
      const v = view(s);
      expect(v.footer).toBe(FOOTER);
      expect(v.footer).toContain(`O JETTISON ${formatKg(JETTISON_STEP_KG)} KG`);
    }
  });
});

describe('resourcesView — USES has the HUD\'s status', () => {
  /** One example per tone, per row. */
  const EXAMPLES: ReadonlyArray<{ tone: Tone; refine: ActionState; repair: ActionState }> = [
    { tone: 'ready', refine: ready, repair: ready },
    { tone: 'blocked', refine: blocked('tank-full'), repair: blocked('insufficient') },
    { tone: 'running', refine: timed(5.2, 0.35), repair: timed(9.01, 0.1) },
  ];

  it.each(EXAMPLES)('Given refine and repair $tone, Then each USES row\'s status and tone are what actionRow gives the HUD for the same state', ({ tone, refine, repair }) => {
    // Preconditions: the example is the tone it claims.
    expect(actionRow('refine', refine).tone).toBe(tone);
    expect(actionRow('repair', repair).tone).toBe(tone);
    const v = need('resourcesView')(input({ refine, repair }));
    expect(v.uses).toHaveLength(2);
    expect(v.uses[0]!.label).toBe('REFINE');
    expect(v.uses[0]!.status).toBe(actionRow('refine', refine).text);
    expect(v.uses[0]!.tone).toBe(actionRow('refine', refine).tone);
    expect(v.uses[1]!.label).toBe('REPAIR');
    expect(v.uses[1]!.status).toBe(actionRow('repair', repair).text);
    expect(v.uses[1]!.tone).toBe(actionRow('repair', repair).tone);
  });

  it('Given the sketch\'s states (refine TANK FULL, repair ready), Then the rows say TANK FULL and ▸ READY, as the sketch does', () => {
    expect(actionRow('refine', blocked('tank-full')).text).toBe('TANK FULL'); // precondition: the HUD says it
    const v = need('resourcesView')(input({ cargo: SKETCH, refine: blocked('tank-full'), repair: ready }));
    expect(v.uses.map((u) => [u.label, u.status, u.tone])).toEqual([
      ['REFINE', 'TANK FULL', 'blocked'],
      ['REPAIR', '▸ READY', 'ready'],
    ]);
  });

  it('Given refine and repair in different states, Then each row reads its own action (no swap)', () => {
    const refine = blocked('nothing-to-refine');
    const repair = timed(4, 0.6);
    expect(actionRow('refine', refine).text).not.toBe(actionRow('repair', repair).text); // precondition
    const v = need('resourcesView')(input({ refine, repair }));
    expect(v.uses[0]!.status).toBe(actionRow('refine', refine).text);
    expect(v.uses[1]!.status).toBe(actionRow('repair', repair).text);
    expect(v.uses[0]!.tone).toBe('blocked');
    expect(v.uses[1]!.tone).toBe('running');
  });

  it.each([
    ['refine', 'tank-full'],
    ['refine', 'nothing-to-refine'],
    ['refine', 'no-tank'],
    ['refine', 'busy'],
    ['refine', 'cruise'],
    ['refine', 'jump'],
    ['repair', 'insufficient'],
    ['repair', 'nothing-to-repair'],
    ['repair', 'no-tank'],
    ['repair', 'busy'],
  ] as const)('Given %s blocked by %s, Then the USES row says what the HUD row says', (kind, reason) => {
    const st = blocked(reason);
    const v = need('resourcesView')(input(kind === 'refine' ? { refine: st } : { repair: st }));
    const row = v.uses[kind === 'refine' ? 0 : 1]!;
    expect(row.status).toBe(actionRow(kind, st).text);
    expect(row.tone).toBe('blocked');
  });

  it('Given any state, Then the USES rows\' labels and costs are the USES table\'s, in its order', () => {
    const uses = need('USES');
    const v = need('resourcesView')(input({ cargo: SKETCH, refine: timed(1, 0.9), repair: blocked('busy') }));
    expect(v.uses.map((u) => [u.label, u.cost])).toEqual(uses.map((u) => [u.label, u.cost]));
  });
});

describe('resourcesView — pure', () => {
  it('Given frozen input, When the view is built twice, Then it does not throw, changes nothing, and gives equal views', () => {
    const view = need('resourcesView');
    const s = Object.freeze(input({ cargo: Object.freeze({ ...SKETCH }), selected: 'metal', beam: 'rare', refine: blocked('tank-full'), repair: timed(2, 0.8) }));
    const before = JSON.stringify(s);
    const a = view(s);
    const b = view(s);
    expect(JSON.stringify(s)).toBe(before);
    expect(a).toEqual(b);
  });
});

// =============================================================================
//  resourcesKey — what each key does
// =============================================================================

describe('resourcesKey — ↑↓ select', () => {
  const hold = SKETCH;

  it.each([
    ['ice', 'rare'],
    ['rare', 'metal'],
    ['metal', 'silicate'],
  ] as const)('Given %s selected, When ArrowDown, Then select %s', (from, to) => {
    expect(need('resourcesKey')(key('ArrowDown'), { selected: from, cargo: hold })).toEqual({ event: { kind: 'select', resource: to }, preventDefault: true });
  });

  it.each([
    ['silicate', 'metal'],
    ['metal', 'rare'],
    ['rare', 'ice'],
  ] as const)('Given %s selected, When ArrowUp, Then select %s', (from, to) => {
    expect(need('resourcesKey')(key('ArrowUp'), { selected: from, cargo: hold })).toEqual({ event: { kind: 'select', resource: to }, preventDefault: true });
  });

  it('Given silicate selected (the last), When ArrowDown, Then it stays on silicate: no event, kept from the browser', () => {
    expect(need('resourcesKey')(key('ArrowDown'), { selected: 'silicate', cargo: hold })).toEqual(NONE);
  });

  it('Given ice selected (the first), When ArrowUp, Then it stays on ice: no event, kept from the browser', () => {
    expect(need('resourcesKey')(key('ArrowUp'), { selected: 'ice', cargo: hold })).toEqual(NONE);
  });

  it('Given a held arrow (repeat) or Shift with an arrow, Then the selection still moves', () => {
    const k = need('resourcesKey');
    expect(k(key('ArrowDown', { repeat: true }), { selected: 'ice', cargo: hold })).toEqual({ event: { kind: 'select', resource: 'rare' }, preventDefault: true });
    expect(k(key('ArrowUp', { shift: true }), { selected: 'silicate', cargo: hold })).toEqual({ event: { kind: 'select', resource: 'metal' }, preventDefault: true });
  });

  it('Given a selection outside the four (a corrupt value), Then it counts as ice: ArrowDown selects rare, ArrowUp selects ice', () => {
    const k = need('resourcesKey');
    expect(k(key('ArrowDown'), { selected: GOLD, cargo: hold })).toEqual({ event: { kind: 'select', resource: 'rare' }, preventDefault: true });
    expect(k(key('ArrowUp'), { selected: GOLD, cargo: hold })).toEqual({ event: { kind: 'select', resource: 'ice' }, preventDefault: true });
  });
});

describe('resourcesKey — Enter: the beam takes this', () => {
  it.each(SCREEN_ORDER)('Given %s selected and an empty hold, When Enter, Then beam %s (the choice does not depend on the hold)', (r) => {
    expect(need('resourcesKey')(key('Enter'), { selected: r, cargo: cargo() })).toEqual({ event: { kind: 'beam', resource: r }, preventDefault: true });
  });

  it('Given a held Enter (repeat), Then no event — a held key never acts — but it is kept from the browser', () => {
    expect(need('resourcesKey')(key('Enter', { repeat: true }), { selected: 'rare', cargo: SKETCH })).toEqual(NONE);
  });

  it('Given a selection outside the four, When Enter, Then beam ice', () => {
    expect(need('resourcesKey')(key('Enter'), { selected: GOLD, cargo: SKETCH })).toEqual({ event: { kind: 'beam', resource: 'ice' }, preventDefault: true });
  });
});

describe('resourcesKey — O jettisons', () => {
  const O = letter('O');

  it.each(SCREEN_ORDER)('Given 5 000 kg %s selected, When O, Then jettison JETTISON_STEP_KG (250) of it', (r) => {
    expect(JETTISON_STEP_KG).toBe(250); // precondition
    expect(need('resourcesKey')(key(O), { selected: r, cargo: cargo({ [r]: 5000 }) })).toEqual({
      event: { kind: 'jettison', resource: r, kg: JETTISON_STEP_KG },
      preventDefault: true,
    });
  });

  it('Given less than the step held (100 kg metal), When O, Then the event still carries the step: the cargo rule throws out min(kg, held)', () => {
    expect(100).toBeLessThan(JETTISON_STEP_KG); // precondition
    expect(need('resourcesKey')(key(O), { selected: 'metal', cargo: cargo({ metal: 100 }) })).toEqual({
      event: { kind: 'jettison', resource: 'metal', kg: JETTISON_STEP_KG },
      preventDefault: true,
    });
  });

  it.each([
    [5000, 5000],
    [100, 100],
    [1234.5, 1234.5],
  ])('Given %d kg ice selected, When Shift+O, Then jettison exactly what is held (%d kg)', (held, kg) => {
    expect(need('resourcesKey')(key(O, { shift: true }), { selected: 'ice', cargo: cargo({ ice: held }) })).toEqual({
      event: { kind: 'jettison', resource: 'ice', kg },
      preventDefault: true,
    });
  });

  it('Given 0 kg of the selected resource and plenty of the others, When O or Shift+O, Then no event (the selected one is judged, not the hold)', () => {
    const hold = cargo({ ice: 3000, metal: 2000, silicate: 1000 });
    expect(hold.rare).toBe(0); // precondition
    const k = need('resourcesKey');
    expect(k(key(O), { selected: 'rare', cargo: hold })).toEqual(NONE);
    expect(k(key(O, { shift: true }), { selected: 'rare', cargo: hold })).toEqual(NONE);
  });

  it('Given dust below what the line shows (0.3 kg silicate, shown as 0 KG), When O or Shift+O, Then no event', () => {
    expect(formatKg(0.3)).toBe('0'); // precondition: the line says 0 KG
    const k = need('resourcesKey');
    const hold = cargo({ silicate: 0.3 });
    expect(k(key(O), { selected: 'silicate', cargo: hold })).toEqual(NONE);
    expect(k(key(O, { shift: true }), { selected: 'silicate', cargo: hold })).toEqual(NONE);
  });

  it('Given just enough to show (0.6 kg silicate, shown as 1 KG), When O / Shift+O, Then the step / exactly 0.6 kg', () => {
    expect(formatKg(0.6)).toBe('1'); // precondition: the line says 1 KG
    const k = need('resourcesKey');
    const hold = cargo({ silicate: 0.6 });
    expect(k(key(O), { selected: 'silicate', cargo: hold })).toEqual({ event: { kind: 'jettison', resource: 'silicate', kg: JETTISON_STEP_KG }, preventDefault: true });
    expect(k(key(O, { shift: true }), { selected: 'silicate', cargo: hold })).toEqual({ event: { kind: 'jettison', resource: 'silicate', kg: 0.6 }, preventDefault: true });
  });

  it.each([
    ['NaN', Number.NaN],
    ['negative', -50],
  ])('Given a %s amount of the selected resource, When O or Shift+O, Then no event', (_label, held) => {
    const k = need('resourcesKey');
    const hold = cargo({ ice: held });
    expect(k(key(O), { selected: 'ice', cargo: hold })).toEqual(NONE);
    expect(k(key(O, { shift: true }), { selected: 'ice', cargo: hold })).toEqual(NONE);
  });

  it('Given a held O or Shift+O (repeat), Then never a jettison — but kept from the browser', () => {
    const k = need('resourcesKey');
    const hold = cargo({ ice: 5000 });
    expect(k(key(O, { repeat: true }), { selected: 'ice', cargo: hold })).toEqual(NONE);
    expect(k(key(O, { repeat: true, shift: true }), { selected: 'ice', cargo: hold })).toEqual(NONE);
  });
});

describe('resourcesKey — I and Esc close', () => {
  const I = letter('I');

  it.each([
    ['I', key(I)],
    ['Escape', key('Escape')],
    ['Shift+I', key(I, { shift: true })],
  ])('Given %s, Then close', (_label, k) => {
    expect(need('resourcesKey')(k, { selected: 'metal', cargo: SKETCH })).toEqual({ event: { kind: 'close' }, preventDefault: true });
  });

  it('Given a held I or Escape (repeat), Then never close — but kept from the browser', () => {
    const k = need('resourcesKey');
    expect(k(key(I, { repeat: true }), { selected: 'ice', cargo: SKETCH })).toEqual(NONE);
    expect(k(key('Escape', { repeat: true }), { selected: 'ice', cargo: SKETCH })).toEqual(NONE);
  });
});

describe('resourcesKey — nothing else reaches the flight (Review Focus 5)', () => {
  it('Given the list of other keys, Then it is broad and holds none of the screen\'s own keys (precondition)', () => {
    expect(OTHER_KEYS).toHaveLength(24 + 10 + 8);
    for (const own of [letter('I'), letter('O'), 'ArrowUp', 'ArrowDown', 'Enter', 'Escape']) expect(OTHER_KEYS).not.toContain(own);
    expect(OTHER_KEYS).toContain(letter('J')); // the jump key
    expect(OTHER_KEYS).toContain(letter('W')); // thrust
  });

  it.each(OTHER_KEYS)('Given %s — plain, with Shift, or held — Then no event, but kept from the browser', (code) => {
    const k = need('resourcesKey');
    const s = { selected: 'ice' as Resource, cargo: SKETCH };
    expect(k(key(code), s)).toEqual(NONE);
    expect(k(key(code, { shift: true }), s)).toEqual(NONE);
    expect(k(key(code, { repeat: true }), s)).toEqual(NONE);
  });
});

describe('resourcesKey — the browser keeps its own shortcuts', () => {
  it.each([
    ['Ctrl+O', key(letter('O'), { ctrl: true })],
    ['Meta+O', key(letter('O'), { meta: true })],
    ['Ctrl+Shift+O', key(letter('O'), { ctrl: true, shift: true })],
    ['Meta+I', key(letter('I'), { meta: true })],
    ['Ctrl+R', key(letter('R'), { ctrl: true })],
    ['Meta+R', key(letter('R'), { meta: true })],
    ['Meta+W', key(letter('W'), { meta: true })],
    ['Ctrl+Enter', key('Enter', { ctrl: true })],
    ['Alt+ArrowDown', key('ArrowDown', { alt: true })],
    ['Alt+Escape', key('Escape', { alt: true })],
  ])('Given the browser chord %s, Then no event and the browser keeps its default (no jettison, no close, no move)', (_label, k) => {
    expect(need('resourcesKey')(k, { selected: 'ice', cargo: cargo({ ice: 5000 }) })).toEqual(BROWSER);
  });

  it.each(BROWSER_F_KEYS)('Given %s (a browser function key), Then no event and the browser keeps its default', (code) => {
    expect(need('resourcesKey')(key(code), { selected: 'ice', cargo: SKETCH })).toEqual(BROWSER);
  });
});

describe('resourcesKey — the selection is always one of the four, and the input is not touched', () => {
  const SELECTIONS: readonly Resource[] = [...SCREEN_ORDER, GOLD, '' as unknown as Resource, 'ICE' as unknown as Resource];
  const CODES: readonly KeyIn[] = [key('ArrowUp'), key('ArrowDown'), key('Enter'), key(letter('O')), key(letter('O'), { shift: true })];

  it('Given every selection (valid or corrupt) and every key that names a resource, Then any resource in the event is one of the four', () => {
    const k = need('resourcesKey');
    const full = cargo({ ice: 2000, rare: 2000, metal: 2000, silicate: 2000 });
    let named = 0;
    for (const selected of SELECTIONS) {
      for (const c of CODES) {
        const out = k(c, { selected, cargo: full });
        if (out.event && 'resource' in out.event) {
          named++;
          expect(SCREEN_ORDER, `${String(selected)} / ${c.code}`).toContain(out.event.resource);
        }
      }
    }
    expect(named).toBeGreaterThan(0); // precondition: the loop judged something
  });

  it('Given frozen input, When a key is read, Then nothing in it is changed', () => {
    const k = need('resourcesKey');
    const s = Object.freeze({ selected: 'metal' as Resource, cargo: Object.freeze({ ...SKETCH }) });
    const before = JSON.stringify(s);
    for (const c of CODES) k(Object.freeze(c), s);
    expect(JSON.stringify(s)).toBe(before);
  });
});

// =============================================================================
// v4 sub-plan 6 — open choice 2 (phase A, for the owner's approval; Task 3
// review m-4): the header's total is the sum of the numbers the four lines
// show, not the rounded sum of the raw kilograms. Refining draws ice
// continuously, so fractions are normal: ice 100.4 + metal 100.4 showed
// `ICE 100 KG`, `METAL 100 KG` under `HOLD 201 / 8 000 KG`. Amounts below
// 0.5 kg show as 0 KG (and count as empty: dim line, O does nothing); with
// this rule they add 0 to the header too. The approved header tests above
// all use whole numbers and are unchanged by it.
// =============================================================================

describe('open choice 2 — the hold\'s total is the sum of the numbers shown', () => {
  /** The number a line or the header prints, spaces removed ("1 234" → 1234). */
  const shown = (s: string, re: RegExp): number => {
    const m = re.exec(s);
    expect(m, s).not.toBeNull();
    return Number(m![1]!.replace(/ /g, ''));
  };
  const lineKg = (text: string): number => shown(text, /([\d ]+) KG\s*$/);
  const headerKg = (header: string): number => shown(header, /^HOLD ([\d ]+) \//);

  it('Given ice 100.4 kg and metal 100.4 kg, Then the lines show 100 and 100 and the header is HOLD 200 / 8 000 KG', () => {
    const v = need('resourcesView')(input({ cargo: cargo({ ice: 100.4, metal: 100.4 }) }));
    expect(v.hold[0]!.text).toMatch(/^\s*ICE\s+100 KG\s*$/);
    expect(v.hold[2]!.text).toMatch(/^\s*METAL\s+100 KG\s*$/);
    expect(v.header).toBe('HOLD 200 / 8 000 KG');
  });

  it('Given ice 100.6 kg and metal 100.6 kg, Then the lines show 101 and 101 and the header is HOLD 202 / 8 000 KG (rounding up adds up too)', () => {
    const v = need('resourcesView')(input({ cargo: cargo({ ice: 100.6, metal: 100.6 }) }));
    expect(v.hold[0]!.text).toMatch(/^\s*ICE\s+101 KG\s*$/);
    expect(v.hold[2]!.text).toMatch(/^\s*METAL\s+101 KG\s*$/);
    expect(v.header).toBe('HOLD 202 / 8 000 KG');
  });

  it('Given dust on all four lines (0.4 kg each, each shown as 0 KG and counted as empty), Then the header is HOLD 0 / 8 000 KG — not 2', () => {
    expect(formatKg(0.4)).toBe('0'); // precondition: the line says 0 KG
    const v = need('resourcesView')(input({ cargo: cargo({ ice: 0.4, rare: 0.4, metal: 0.4, silicate: 0.4 }) }));
    for (const l of v.hold) expect(l.text, l.resource).toMatch(lineRe(l.resource, 0));
    expect(v.header).toBe('HOLD 0 / 8 000 KG');
  });

  it('Given 0.5 kg ice (shown as 1 KG: formatKg rounds a half up), Then the header is HOLD 1 / 8 000 KG', () => {
    expect(formatKg(0.5)).toBe('1'); // precondition
    expect(need('resourcesView')(input({ cargo: cargo({ ice: 0.5 }) })).header).toBe('HOLD 1 / 8 000 KG');
  });

  it.each<[string, Partial<Record<Resource, number>>]>([
    ['fractions below a half', { ice: 1234.4, rare: 0.3, metal: 999.2, silicate: 10.4 }],
    ['fractions above a half', { ice: 1234.6, rare: 0.7, metal: 999.8, silicate: 10.5 }],
    ['mixed', { ice: 4321.49, rare: 12.51, metal: 0.49, silicate: 2000.5 }],
    ['one line only', { metal: 777.7 }],
  ])('Given a hold with %s, Then the header\'s number is exactly the sum of the four lines\' numbers', (_what, o) => {
    const v = need('resourcesView')(input({ cargo: cargo(o) }));
    const sum = v.hold.reduce((a, l) => a + lineKg(l.text), 0);
    expect(headerKg(v.header)).toBe(sum);
  });

  it('Guard: Given whole numbers (the sketch\'s hold) and an empty hold, Then the header is what it was: HOLD 6 250 / 8 000 KG and HOLD 0 / 8 000 KG', () => {
    const view = need('resourcesView');
    expect(view(input({ cargo: SKETCH })).header).toBe('HOLD 6 250 / 8 000 KG');
    expect(view(input()).header).toBe('HOLD 0 / 8 000 KG');
  });

  it('Guard: Given a full hold in whole numbers, or full with one fraction below a half (ice 7 999.6 + rare 0.4), Then the header is HOLD 8 000 / 8 000 KG', () => {
    const view = need('resourcesView');
    expect(view(input({ cargo: cargo({ ice: 5000, rare: 500, metal: 1500, silicate: 1000 }) })).header).toBe('HOLD 8 000 / 8 000 KG');
    expect(view(input({ cargo: cargo({ ice: 7999.6, rare: 0.4 }) })).header).toBe('HOLD 8 000 / 8 000 KG');
  });

  it('Consequence, for the owner: Given a hold exactly full whose lines each round up (ice 5 000.6 + metal 1 999.7 + silicate 999.7 = 8 000 kg), Then the lines show 5 001, 2 000 and 1 000 and the header says HOLD 8 001 / 8 000 KG — more than the capacity', () => {
    const v = need('resourcesView')(input({ cargo: cargo({ ice: 5000.6, metal: 1999.7, silicate: 999.7 }) }));
    expect(v.hold[0]!.text).toMatch(/^\s*ICE\s+5 001 KG\s*$/);
    expect(v.hold[2]!.text).toMatch(/^\s*METAL\s+2 000 KG\s*$/);
    expect(v.hold[3]!.text).toMatch(/^\s*SILICATE\s+1 000 KG\s*$/);
    expect(v.header).toBe('HOLD 8 001 / 8 000 KG');
  });

  it('Guard: Given NaN and negative amounts beside 1 000 kg metal, Then they add nothing: HOLD 1 000 / 8 000 KG', () => {
    const v = need('resourcesView')(input({ cargo: cargo({ ice: Number.NaN, rare: -50, metal: 1000, silicate: -0.4 }) }));
    expect(v.header).toBe('HOLD 1 000 / 8 000 KG');
  });
});
