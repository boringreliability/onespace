/** The title screen's menu as a pure reducer. DOM lives in Title.ts. */

export const TITLE_ITEMS = ['undock', 'yard', 'settings'] as const;
export type TitleItem = (typeof TITLE_ITEMS)[number];

export interface TitleState {
  readonly index: number;
  readonly seedError: string | null;
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
  | { kind: 'reseed'; seed: number };

export function initialTitle(): TitleState {
  return { index: 0, seedError: null };
}

/** Hex, optional 0x, 1-8 digits, surrounding whitespace allowed. */
export function parseSeedField(text: string): number | null {
  const m = /^\s*(?:0x)?([0-9a-f]{1,8})\s*$/i.exec(text);
  return m ? parseInt(m[1]!, 16) >>> 0 : null;
}

function activate(item: TitleItem): TitleEffect {
  if (item === 'undock') return { kind: 'go', mode: 'flight' };
  if (item === 'yard') return { kind: 'go', mode: 'yard' };
  return { kind: 'settings' };
}

export function titleStep(s: TitleState, e: TitleEvent): { state: TitleState; effect: TitleEffect } {
  const n = TITLE_ITEMS.length;
  switch (e.kind) {
    case 'up':
      return { state: { ...s, index: (s.index - 1 + n) % n }, effect: { kind: 'none' } };
    case 'down':
      return { state: { ...s, index: (s.index + 1) % n }, effect: { kind: 'none' } };
    case 'enter':
      return { state: s, effect: activate(TITLE_ITEMS[s.index]!) };
    case 'click':
      if (!Number.isInteger(e.index) || e.index < 0 || e.index >= n) return { state: s, effect: { kind: 'none' } };
      return { state: { ...s, index: e.index }, effect: activate(TITLE_ITEMS[e.index]!) };
    case 'seed': {
      const seed = parseSeedField(e.text);
      if (seed === null) {
        return { state: { ...s, seedError: 'A SEED IS 1-8 HEX DIGITS' }, effect: { kind: 'none' } };
      }
      return { state: { ...s, seedError: null }, effect: { kind: 'reseed', seed } };
    }
  }
}
