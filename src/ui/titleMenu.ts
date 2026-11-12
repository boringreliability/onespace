/** The title screen's menu as a pure reducer. DOM lives in Title.ts. */

/** v3's menu: no save to continue. */
export const TITLE_ITEMS = ['undock', 'yard', 'settings'] as const;
/** [v4-save] With a save: CONTINUE first, NEW GAME behind a confirmation. */
export const TITLE_ITEMS_WITH_SAVE = ['continue', 'newgame', 'yard', 'settings'] as const;
export type TitleItem = (typeof TITLE_ITEMS)[number] | (typeof TITLE_ITEMS_WITH_SAVE)[number];

export const NEW_GAME_CONFIRM_TEXT = 'NEW GAME — PRESS AGAIN TO OVERWRITE';

const LABELS: Record<TitleItem, string> = {
  continue: 'CONTINUE',
  newgame: 'NEW GAME',
  undock: 'UNDOCK',
  yard: 'THE YARD',
  settings: 'SETTINGS',
};

export interface TitleState {
  readonly index: number;
  readonly seedError: string | null;
  /** The menu as shown: with or without a save. */
  readonly items: readonly TitleItem[];
  /** NEW GAME was pressed once; the next press confirms. */
  readonly armed: boolean;
}

export function titleItems(hasSave: boolean): readonly TitleItem[] {
  return hasSave ? TITLE_ITEMS_WITH_SAVE : TITLE_ITEMS;
}

/** The label an item shows in this state (NEW GAME asks for its second press). */
export function titleLabel(s: TitleState, item: TitleItem): string {
  return item === 'newgame' && s.armed ? NEW_GAME_CONFIRM_TEXT : LABELS[item];
}

export type TitleEvent =
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'enter' }
  | { kind: 'click'; index: number }
  | { kind: 'seed'; text: string };

export type TitleEffect =
  | { kind: 'none' }
  | { kind: 'go'; mode: 'flight' | 'yard' }
  | { kind: 'settings' }
  | { kind: 'reseed'; seed: number }
  | { kind: 'continue' }
  | { kind: 'newgame'; confirmed: boolean };

export interface TitleKeyInput {
  readonly code: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
}

/**
 * A keydown on the title. The title swallows every key while shown (so W on
 * the menu never throttles the ship behind it), but a modifier chord is the
 * browser's: Cmd+R must reload, Cmd+L reach the address bar (review-p2 — the
 * title used to preventDefault them all). Such a chord is still kept from the
 * game, just not from the browser.
 */
export function titleKey(k: TitleKeyInput): { event: TitleEvent | null; preventDefault: boolean } {
  if (k.metaKey || k.ctrlKey || k.altKey) return { event: null, preventDefault: false };
  const event: TitleEvent | null =
    k.code === 'ArrowUp' || k.code === 'KeyW'
      ? { kind: 'up' }
      : k.code === 'ArrowDown' || k.code === 'KeyS'
        ? { kind: 'down' }
        : k.code === 'Enter' || k.code === 'Space'
          ? { kind: 'enter' }
          : null;
  return { event, preventDefault: true };
}

export function initialTitle(opts: { hasSave?: boolean } = {}): TitleState {
  return { index: 0, seedError: null, items: titleItems(opts.hasSave === true), armed: false };
}

/** Hex, optional 0x, 1-8 digits, surrounding whitespace allowed. */
export function parseSeedField(text: string): number | null {
  const m = /^\s*(?:0x)?([0-9a-f]{1,8})\s*$/i.exec(text);
  return m ? parseInt(m[1]!, 16) >>> 0 : null;
}

function activate(s: TitleState, index: number): { state: TitleState; effect: TitleEffect } {
  const item = s.items[index]!;
  if (item === 'newgame') {
    // Two presses: the first arms, the second (on the same, still armed item) confirms.
    const confirmed = s.armed && s.index === index;
    return { state: { ...s, index, armed: !confirmed }, effect: { kind: 'newgame', confirmed } };
  }
  const state = { ...s, index, armed: false };
  if (item === 'continue') return { state, effect: { kind: 'continue' } };
  if (item === 'undock') return { state, effect: { kind: 'go', mode: 'flight' } };
  if (item === 'yard') return { state, effect: { kind: 'go', mode: 'yard' } };
  return { state, effect: { kind: 'settings' } };
}

export function titleStep(s: TitleState, e: TitleEvent): { state: TitleState; effect: TitleEffect } {
  const n = s.items.length;
  switch (e.kind) {
    case 'up':
      return { state: { ...s, index: (s.index - 1 + n) % n, armed: false }, effect: { kind: 'none' } };
    case 'down':
      return { state: { ...s, index: (s.index + 1) % n, armed: false }, effect: { kind: 'none' } };
    case 'enter':
      return activate(s, s.index);
    case 'click':
      if (!Number.isInteger(e.index) || e.index < 0 || e.index >= n) return { state: s, effect: { kind: 'none' } };
      return activate(s, e.index);
    case 'seed': {
      const seed = parseSeedField(e.text);
      if (seed === null) {
        return { state: { ...s, seedError: 'A SEED IS 1-8 HEX DIGITS', armed: false }, effect: { kind: 'none' } };
      }
      return { state: { ...s, seedError: null, armed: false }, effect: { kind: 'reseed', seed } };
    }
  }
}
