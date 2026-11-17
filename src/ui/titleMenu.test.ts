import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AccountView } from './accountMenu';
import {
  TITLE_ITEMS,
  initialTitle,
  parseSeedField,
  titleAccountLine,
  titleItems,
  titleKey,
  titleLabel,
  titleStep,
  type TitleItem,
  type TitleState,
} from './titleMenu';

describe('titleStep', () => {
  it('Given a fresh title, Then UNDOCK is selected', () => {
    expect(TITLE_ITEMS[initialTitle().index]).toBe('undock');
  });

  it('Given UNDOCK, When down, Then THE YARD; When down past the end, Then it wraps', () => {
    let s = initialTitle();
    s = titleStep(s, { kind: 'down' }).state;
    expect(TITLE_ITEMS[s.index]).toBe('yard');
    for (let i = 0; i < TITLE_ITEMS.length - 1; i++) s = titleStep(s, { kind: 'down' }).state;
    expect(TITLE_ITEMS[s.index]).toBe('undock');
  });

  it('Given UNDOCK, When up, Then it wraps to the last item', () => {
    const s = titleStep(initialTitle(), { kind: 'up' }).state;
    expect(s.index).toBe(TITLE_ITEMS.length - 1);
  });

  it('Given UNDOCK, When enter, Then the effect is flight', () => {
    expect(titleStep(initialTitle(), { kind: 'enter' }).effect).toEqual({ kind: 'go', mode: 'flight' });
  });

  it('Given THE YARD, When enter, Then the effect is yard', () => {
    const s = titleStep(initialTitle(), { kind: 'down' }).state;
    expect(titleStep(s, { kind: 'enter' }).effect).toEqual({ kind: 'go', mode: 'yard' });
  });

  it('Given a click on an item, Then it is selected and activated in one step', () => {
    const r = titleStep(initialTitle(), { kind: 'click', index: 1 });
    expect(r.state.index).toBe(1);
    expect(r.effect).toEqual({ kind: 'go', mode: 'yard' });
  });

  it('Given a click on an index out of range, Then nothing happens', () => {
    const r = titleStep(initialTitle(), { kind: 'click', index: 99 });
    expect(r.effect).toEqual({ kind: 'none' });
    expect(r.state.index).toBe(0);
  });

  it('Given a valid seed submitted, Then the effect reloads with that seed', () => {
    expect(titleStep(initialTitle(), { kind: 'seed', text: '1A2B3C4D' }).effect).toEqual({
      kind: 'reseed',
      seed: 0x1a2b3c4d,
    });
  });

  it('Given an invalid seed submitted, Then it is refused with a reason and nothing reloads', () => {
    const r = titleStep(initialTitle(), { kind: 'seed', text: 'not a seed' });
    expect(r.effect.kind).toBe('none');
    expect(r.state.seedError).toBeTruthy();
  });

  it('Given the reducer, Then it never mutates the state it was given', () => {
    const s = initialTitle();
    const frozen = JSON.stringify(s);
    titleStep(s, { kind: 'down' });
    titleStep(s, { kind: 'seed', text: 'zz' });
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

describe('parseSeedField', () => {
  it('Given hex with or without 0x and spaces, Then it parses', () => {
    expect(parseSeedField('5c0117')).toBe(0x5c0117);
    expect(parseSeedField(' 0x5C0117 ')).toBe(0x5c0117);
  });

  it('Given anything else, Then it is null', () => {
    for (const bad of ['', 'xyz', '123456789', '-1', '1.5', '0x']) expect(parseSeedField(bad)).toBeNull();
  });
});

describe('titleKey (review-p2)', () => {
  it.each([
    ['ArrowUp', 'up'],
    ['KeyW', 'up'],
    ['ArrowDown', 'down'],
    ['KeyS', 'down'],
    ['Enter', 'enter'],
    ['Space', 'enter'],
  ] as const)('Given %s on the title, Then it is the %s event and the browser default is suppressed', (code, kind) => {
    expect(titleKey({ code })).toEqual({ event: { kind }, preventDefault: true });
  });

  it('Given any other plain key (a flight key), Then it does nothing but is still kept from the browser', () => {
    expect(titleKey({ code: 'KeyD' })).toEqual({ event: null, preventDefault: true });
  });

  it.each([
    { code: 'KeyR', metaKey: true },
    { code: 'KeyR', ctrlKey: true },
    { code: 'KeyL', metaKey: true },
    { code: 'ArrowLeft', altKey: true },
    { code: 'KeyW', metaKey: true },
  ])('Given the browser chord %o, Then the browser keeps its default and the menu does not move', (k) => {
    expect(titleKey(k)).toEqual({ event: null, preventDefault: false });
  });
});

// =============================================================================
// v4 sub-plan 3 (local save), Task 6 — CONTINUE and NEW GAME.
//
// The menu is dynamic: `initialTitle({ hasSave })` carries its own `items`.
//  - with a save:    ['continue', 'newgame', 'yard', 'settings'] — CONTINUE first;
//  - without a save: ['undock', 'yard', 'settings'] — v3's menu, unchanged
//    (`TITLE_ITEMS` stays that list, and `initialTitle()` means no save).
// NEW GAME over a save needs two presses: the first ARMS it (effect
// `{ kind: 'newgame', confirmed: false }`, label `NEW GAME — PRESS AGAIN TO
// OVERWRITE`), the second confirms (`confirmed: true`). Anything else in
// between — moving, another item, a seed — disarms it.
// =============================================================================

describe('title menu with a save (v4 Task 6)', () => {
  const withSave = () => initialTitle({ hasSave: true });
  const at = (s: TitleState, item: TitleItem): TitleState => {
    const i = s.items.indexOf(item);
    expect(i).toBeGreaterThanOrEqual(0);
    return { ...s, index: i };
  };

  it('Given a save, Then the items are CONTINUE, NEW GAME, THE YARD, SETTINGS and CONTINUE is selected', () => {
    const s = withSave();
    expect(s.items).toEqual(['continue', 'newgame', 'yard', 'settings']);
    expect(titleItems(true)).toEqual(['continue', 'newgame', 'yard', 'settings']);
    expect(s.items[s.index]).toBe('continue');
    expect(s.armed).toBe(false);
  });

  it("Given no save, Then it is v3's menu: UNDOCK, THE YARD, SETTINGS, UNDOCK selected, and UNDOCK still flies at once", () => {
    for (const s of [initialTitle(), initialTitle({ hasSave: false })]) {
      expect(s.items).toEqual(['undock', 'yard', 'settings']);
      expect(s.items[s.index]).toBe('undock');
      expect(titleStep(s, { kind: 'enter' }).effect).toEqual({ kind: 'go', mode: 'flight' });
    }
    expect(titleItems(false)).toEqual([...TITLE_ITEMS]);
  });

  it('Given a save, When enter on CONTINUE, Then the effect is continue', () => {
    expect(titleStep(withSave(), { kind: 'enter' }).effect).toEqual({ kind: 'continue' });
  });

  it('Given a save, When NEW GAME is pressed once, Then it is only armed (confirmed false) and its label asks for a second press', () => {
    const s0 = at(withSave(), 'newgame');
    expect(titleLabel(s0, 'newgame')).toBe('NEW GAME');
    const r = titleStep(s0, { kind: 'enter' });
    expect(r.effect).toEqual({ kind: 'newgame', confirmed: false });
    expect(r.state.armed).toBe(true);
    expect(titleLabel(r.state, 'newgame')).toBe('NEW GAME — PRESS AGAIN TO OVERWRITE');
  });

  it('Given NEW GAME armed, When it is pressed again, Then the effect is newgame confirmed', () => {
    const armed = titleStep(at(withSave(), 'newgame'), { kind: 'enter' }).state;
    expect(titleStep(armed, { kind: 'enter' }).effect).toEqual({ kind: 'newgame', confirmed: true });
  });

  it('Given NEW GAME clicked twice, Then the first click arms and the second confirms', () => {
    const i = withSave().items.indexOf('newgame');
    const first = titleStep(withSave(), { kind: 'click', index: i });
    expect(first.effect).toEqual({ kind: 'newgame', confirmed: false });
    expect(titleStep(first.state, { kind: 'click', index: i }).effect).toEqual({ kind: 'newgame', confirmed: true });
  });

  it('Given NEW GAME armed, When the selection moves away and back, Then it is disarmed and needs two presses again', () => {
    let s = titleStep(at(withSave(), 'newgame'), { kind: 'enter' }).state;
    s = titleStep(s, { kind: 'down' }).state;
    expect(s.armed).toBe(false);
    s = titleStep(s, { kind: 'up' }).state;
    expect(s.items[s.index]).toBe('newgame');
    expect(titleLabel(s, 'newgame')).toBe('NEW GAME');
    expect(titleStep(s, { kind: 'enter' }).effect).toEqual({ kind: 'newgame', confirmed: false });
  });

  it('Given NEW GAME armed, When another item is clicked or a seed submitted, Then it is disarmed', () => {
    const armed = titleStep(at(withSave(), 'newgame'), { kind: 'enter' }).state;
    const clicked = titleStep(armed, { kind: 'click', index: armed.items.indexOf('settings') });
    expect(clicked.effect).toEqual({ kind: 'settings' });
    expect(clicked.state.armed).toBe(false);
    expect(titleStep(armed, { kind: 'seed', text: 'zz' }).state.armed).toBe(false);
  });

  it('Given a save, When THE YARD or SETTINGS is chosen, Then they behave as in v3', () => {
    expect(titleStep(at(withSave(), 'yard'), { kind: 'enter' }).effect).toEqual({ kind: 'go', mode: 'yard' });
    expect(titleStep(at(withSave(), 'settings'), { kind: 'enter' }).effect).toEqual({ kind: 'settings' });
  });

  it('Given a save, When down past SETTINGS, Then it wraps to CONTINUE (four items)', () => {
    let s = withSave();
    for (let i = 0; i < 4; i++) s = titleStep(s, { kind: 'down' }).state;
    expect(s.items[s.index]).toBe('continue');
  });

  it('Given a save, When a click names index 4 (one past the end), Then nothing happens', () => {
    const r = titleStep(withSave(), { kind: 'click', index: 4 });
    expect(r.effect).toEqual({ kind: 'none' });
    expect(r.state.index).toBe(0);
  });

  it('Given labels, Then CONTINUE, UNDOCK, THE YARD and SETTINGS read as before', () => {
    const s = withSave();
    expect(titleLabel(s, 'continue')).toBe('CONTINUE');
    expect(titleLabel(s, 'yard')).toBe('THE YARD');
    expect(titleLabel(s, 'settings')).toBe('SETTINGS');
    expect(titleLabel(initialTitle(), 'undock')).toBe('UNDOCK');
  });

  it('Given the reducer with a save, Then it never mutates the state it was given (arming included)', () => {
    const s = at(withSave(), 'newgame');
    const frozen = JSON.stringify(s);
    titleStep(s, { kind: 'enter' });
    titleStep(s, { kind: 'down' });
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

// =============================================================================
// v4 sub-plan 4 (backend), Task 6 — sign in with Discord, the account (R51–R53).
//
// `initialTitle({ hasSave, account })` takes the account the menu shows
// (src/ui/accountMenu.ts `AccountView`):
//  - guest     → 'signin' is the LAST item, label `SIGN IN WITH DISCORD`,
//                enter → effect `{ kind: 'signin' }` (Title.ts navigates to
//                SIGN_IN_PATH, /api/auth/discord);
//  - signed-in → 'account' is the LAST item, label `SIGN OUT`, enter →
//                effect `{ kind: 'signout' }`; `titleAccountLine(s)` is the
//                line `SIGNED IN AS <name>` (name truncated to 32, R52);
//  - hidden    → (a reader tab, R51; and the default when `account` is
//                omitted) no sign-in or account item at all — the menus
//                above are unchanged.
// Event `{ kind: 'account', account }` swaps the account items after a sign
// out (R53) or a deleted account; the selection stays in range, NEW GAME
// disarms. Sign-in is never a requirement: CONTINUE / UNDOCK act the same.
// =============================================================================

describe('title menu — sign in and the account (v4-net Task 6)', () => {
  const GUEST: AccountView = { kind: 'guest' };
  const DENNIS: AccountView = { kind: 'signed-in', name: 'Dennis' };
  const HIDDEN: AccountView = { kind: 'hidden' };
  const at = (s: TitleState, item: TitleItem): TitleState => {
    const i = s.items.indexOf(item);
    expect(i).toBeGreaterThanOrEqual(0);
    return { ...s, index: i };
  };

  it('Given a guest without a save, Then SIGN IN WITH DISCORD is the last item, after the v3 menu', () => {
    const s = initialTitle({ account: GUEST });
    expect(s.items).toEqual(['undock', 'yard', 'settings', 'signin']);
    expect(titleItems(false, GUEST)).toEqual(['undock', 'yard', 'settings', 'signin']);
    expect(titleLabel(s, 'signin')).toBe('SIGN IN WITH DISCORD');
    expect(titleAccountLine(s)).toBeNull();
  });

  it('Given a guest with a save, Then SIGN IN WITH DISCORD is last, after SETTINGS', () => {
    const s = initialTitle({ hasSave: true, account: GUEST });
    expect(s.items).toEqual(['continue', 'newgame', 'yard', 'settings', 'signin']);
    expect(titleItems(true, GUEST)).toEqual(['continue', 'newgame', 'yard', 'settings', 'signin']);
  });

  it('Given a guest, When enter on SIGN IN WITH DISCORD, Then the effect is signin', () => {
    expect(titleStep(at(initialTitle({ account: GUEST }), 'signin'), { kind: 'enter' }).effect).toEqual({ kind: 'signin' });
  });

  it('Given a guest, When SIGN IN WITH DISCORD is clicked, Then it is selected and the effect is signin in one step', () => {
    const s = initialTitle({ hasSave: true, account: GUEST });
    const r = titleStep(s, { kind: 'click', index: s.items.indexOf('signin') });
    expect(r.state.items[r.state.index]).toBe('signin');
    expect(r.effect).toEqual({ kind: 'signin' });
  });

  it('Given signed in as Dennis, Then the line reads SIGNED IN AS Dennis and the last item is SIGN OUT (no sign-in item)', () => {
    for (const hasSave of [false, true]) {
      const s = initialTitle({ hasSave, account: DENNIS });
      expect(s.items[s.items.length - 1]).toBe('account');
      expect(s.items).not.toContain('signin');
      expect(titleLabel(s, 'account')).toBe('SIGN OUT');
      expect(titleAccountLine(s)).toBe('SIGNED IN AS Dennis');
    }
    expect(titleItems(true, DENNIS)).toEqual(['continue', 'newgame', 'yard', 'settings', 'account']);
  });

  it('Given signed in, When enter on SIGN OUT, Then the effect is signout', () => {
    expect(titleStep(at(initialTitle({ account: DENNIS }), 'account'), { kind: 'enter' }).effect).toEqual({ kind: 'signout' });
  });

  it('R52: Given a 40-character Discord name, Then the account line shows its first 32 characters', () => {
    const name = 'abcdefghij'.repeat(4);
    expect(titleAccountLine(initialTitle({ account: { kind: 'signed-in', name } }))).toBe(`SIGNED IN AS ${name.slice(0, 32)}`);
  });

  it('R51: Given a reader tab (hidden), Then no sign-in or account item at all, and no account line', () => {
    for (const hasSave of [false, true]) {
      const s = initialTitle({ hasSave, account: HIDDEN });
      expect(s.items).toEqual(hasSave ? ['continue', 'newgame', 'yard', 'settings'] : ['undock', 'yard', 'settings']);
      expect(titleAccountLine(s)).toBeNull();
    }
  });

  it.each([
    ['a guest', GUEST],
    ['signed in', DENNIS],
    ['hidden', HIDDEN],
  ] as const)('Sign-in is never a requirement: Given %s, Then UNDOCK (no save) and CONTINUE (a save) are first, selected, and act at once', (_who, account) => {
    const fresh = initialTitle({ account });
    expect(fresh.items[fresh.index]).toBe('undock');
    expect(titleStep(fresh, { kind: 'enter' }).effect).toEqual({ kind: 'go', mode: 'flight' });
    const saved = initialTitle({ hasSave: true, account });
    expect(saved.items[saved.index]).toBe('continue');
    expect(titleStep(saved, { kind: 'enter' }).effect).toEqual({ kind: 'continue' });
  });

  it('Given NEW GAME armed, When SIGN IN WITH DISCORD is clicked, Then NEW GAME is disarmed (like any other item)', () => {
    const armed = titleStep(at(initialTitle({ hasSave: true, account: GUEST }), 'newgame'), { kind: 'enter' }).state;
    expect(armed.armed).toBe(true);
    const clicked = titleStep(armed, { kind: 'click', index: armed.items.indexOf('signin') });
    expect(clicked.effect).toEqual({ kind: 'signin' });
    expect(clicked.state.armed).toBe(false);
  });

  it('Given a guest with a save, When down past SIGN IN, Then it wraps to CONTINUE (five items)', () => {
    let s = initialTitle({ hasSave: true, account: GUEST });
    for (let i = 0; i < 5; i++) s = titleStep(s, { kind: 'down' }).state;
    expect(s.items[s.index]).toBe('continue');
  });

  it('R53: Given signed in with SIGN OUT selected, When the account becomes guest (the sign-out succeeded), Then SIGN IN WITH DISCORD takes its place, the selection stays in range, and there is no effect', () => {
    const s = at(initialTitle({ hasSave: true, account: DENNIS }), 'account');
    const r = titleStep(s, { kind: 'account', account: GUEST });
    expect(r.effect).toEqual({ kind: 'none' });
    expect(r.state.items).toEqual(['continue', 'newgame', 'yard', 'settings', 'signin']);
    expect(r.state.index).toBeLessThan(r.state.items.length);
    expect(titleAccountLine(r.state)).toBeNull();
  });

  it('Given a guest with SIGN IN selected, When the account becomes hidden, Then the sign-in item goes and the selection is clamped into range', () => {
    const s = at(initialTitle({ account: GUEST }), 'signin');
    const r = titleStep(s, { kind: 'account', account: HIDDEN });
    expect(r.state.items).toEqual(['undock', 'yard', 'settings']);
    expect(r.state.index).toBe(2);
  });

  it('Given NEW GAME armed, When the account changes, Then NEW GAME is disarmed', () => {
    const armed = titleStep(at(initialTitle({ hasSave: true, account: DENNIS }), 'newgame'), { kind: 'enter' }).state;
    expect(titleStep(armed, { kind: 'account', account: GUEST }).state.armed).toBe(false);
  });

  it('Given the reducer with an account, Then it never mutates the state it was given', () => {
    const s = at(initialTitle({ hasSave: true, account: DENNIS }), 'account');
    const frozen = JSON.stringify(s);
    titleStep(s, { kind: 'enter' });
    titleStep(s, { kind: 'account', account: GUEST });
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

describe('Title.ts — the account effects (source)', () => {
  const src = (): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Title.ts'), 'utf8');

  it("Given the signin effect, Then Title navigates to SIGN_IN_PATH (the server's /api/auth/discord) — a full page load, not a fetch", () => {
    const s = src();
    expect(s).toMatch(/case 'signin'/);
    expect(s).toMatch(/SIGN_IN_PATH/);
    expect(s).toMatch(/location\.(assign\(|href\s*=)/);
  });

  it('Given the signout effect, Then Title runs runSignOut and feeds the result back as an account event (R53)', () => {
    const s = src();
    expect(s).toMatch(/case 'signout'/);
    expect(s).toMatch(/runSignOut\(/);
    expect(s).toMatch(/kind:\s*'account'/);
  });
});
