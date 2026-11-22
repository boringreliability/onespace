/**
 * Pause.
 *
 * `Esc` used to do one thing: the browser's own pointer-lock release. There
 * was no pause and no menu. The awkward part is that Esc arrives two ways —
 * as a lost pointer lock (the browser eats the key while the pointer is
 * captured) and as a keydown (when it is not) — and sometimes as both, a few
 * milliseconds apart. One press must open the overlay, not open and close it.
 *
 * The charts and the codex also own Esc (it closes them), and they release the
 * pointer on purpose when they open. Neither of those is a request to pause.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ESC_DEBOUNCE_MS,
  PAUSE_CLOSED,
  pauseContextFor,
  pauseStep,
  returnToOrbitLabel,
  type PauseContext,
  type PauseState,
} from './pauseState';
// v4-net Task 6 (phase A): new pauseState exports.
import {
  DELETE_ACCOUNT_CONFIRM_TEXT,
  DELETE_ACCOUNT_TEXT,
  DELETE_DISARMED,
  deleteAccountLabel,
  deleteAccountStep,
  initialSyncNotice,
  pauseAccountView,
  syncNoticeStep,
  type DeleteAccountState,
  type SyncNoticeWatch,
} from './pauseState';
import { SYNC_CONFLICT_TEXT, SYNC_OFFLINE_TEXT, SYNC_REAUTH_TEXT, type SyncStatus } from '@/net/SyncClient';
// v4 sub-plan 5, Task 8 (phase A): the sheet's key lines come from the key map.
import * as pauseStateModule from './pauseState';
import { EMERGENCY_KEYS, MINING_KEYS, RESOURCES_KEY, actionForKey } from '@/core/Input';
import { FORMATION_KEY } from '@/ship/formation';

const flying: PauseContext = { overlayOpen: false, busy: false };
const inChart: PauseContext = { overlayOpen: true, busy: false };
const warping: PauseContext = { overlayOpen: false, busy: true };

const openAt = (t: number): PauseState => ({ open: true, openedAt: t });

describe('pauseStep — opening', () => {
  it('Given flight with the pointer captured, When the pointer lock is lost, Then the game pauses', () => {
    const r = pauseStep(PAUSE_CLOSED, { type: 'lockLost', t: 1000 }, flying);
    expect(r.state.open).toBe(true);
    expect(r.effect).toBe('none');
  });

  it('Given flight without the pointer, When Esc is pressed, Then the game pauses', () => {
    const r = pauseStep(PAUSE_CLOSED, { type: 'escKey', t: 1000 }, flying);
    expect(r.state.open).toBe(true);
  });

  it('Given a chart or the codex is open, When the pointer lock is lost, Then nothing pauses (they released it on purpose)', () => {
    const r = pauseStep(PAUSE_CLOSED, { type: 'lockLost', t: 1000 }, inChart);
    expect(r.state.open).toBe(false);
  });

  it('Given a chart or the codex is open, When Esc is pressed, Then nothing pauses (Esc closes the chart)', () => {
    const r = pauseStep(PAUSE_CLOSED, { type: 'escKey', t: 1000 }, inChart);
    expect(r.state.open).toBe(false);
  });

  it('Given a jump or a recovery in progress, When Esc arrives either way, Then nothing pauses', () => {
    expect(pauseStep(PAUSE_CLOSED, { type: 'lockLost', t: 1 }, warping).state.open).toBe(false);
    expect(pauseStep(PAUSE_CLOSED, { type: 'escKey', t: 1 }, warping).state.open).toBe(false);
  });
});

describe('pauseStep — one press is one press', () => {
  it('Given the pause was just opened by a lost lock, When the same Esc arrives as a keydown, Then it stays open', () => {
    const r = pauseStep(openAt(1000), { type: 'escKey', t: 1000 + ESC_DEBOUNCE_MS - 1 }, flying);
    expect(r.state.open).toBe(true);
  });

  it('Given the pause is open, When the pointer lock is reported lost again, Then it stays open (idempotent)', () => {
    const r = pauseStep(openAt(1000), { type: 'lockLost', t: 5000 }, flying);
    expect(r.state).toEqual(openAt(1000));
  });

  it('Given the pause has been open a while, When Esc is pressed, Then it closes and asks for nothing (the hint says click)', () => {
    const r = pauseStep(openAt(1000), { type: 'escKey', t: 1000 + ESC_DEBOUNCE_MS + 1 }, flying);
    expect(r.state.open).toBe(false);
    expect(r.effect).toBe('none');
  });
});

describe('pauseStep — the buttons', () => {
  it('Given the pause is open, When RESUME is clicked, Then it closes and recaptures the pointer', () => {
    const r = pauseStep(openAt(0), { type: 'resume' }, flying);
    expect(r.state.open).toBe(false);
    expect(r.effect).toBe('requestLock');
  });

  it('Given the pause is open, When RETURN TO ORBIT is clicked, Then it closes and asks for a respawn', () => {
    const r = pauseStep(openAt(0), { type: 'returnToOrbit' }, flying);
    expect(r.state.open).toBe(false);
    expect(r.effect).toBe('respawn');
  });

  it('Given the pause is closed, When a stray RESUME or RETURN arrives, Then nothing happens', () => {
    expect(pauseStep(PAUSE_CLOSED, { type: 'resume' }, flying)).toEqual({
      state: PAUSE_CLOSED,
      effect: 'none',
    });
    expect(pauseStep(PAUSE_CLOSED, { type: 'returnToOrbit' }, flying)).toEqual({
      state: PAUSE_CLOSED,
      effect: 'none',
    });
  });

  it('Given any step, Then the input state is not mutated', () => {
    const s = openAt(10);
    pauseStep(s, { type: 'resume' }, flying);
    expect(s).toEqual(openAt(10));
  });
});

describe('pauseContextFor — pause belongs to flight (review-p2)', () => {
  it('Given flight is shown, When the pointer lock is lost, Then the pause opens', () => {
    const ctx = pauseContextFor({ flightShown: true, menuOpen: false, busy: false });
    expect(pauseStep(PAUSE_CLOSED, { type: 'lockLost', t: 5 }, ctx).state.open).toBe(true);
  });

  it('Given the Yard or photo mode just released the pointer, When the lock-loss arrives, Then the pause stays closed', () => {
    const ctx = pauseContextFor({ flightShown: false, menuOpen: false, busy: false });
    expect(pauseStep(PAUSE_CLOSED, { type: 'lockLost', t: 5 }, ctx).state.open).toBe(false);
  });

  it('Given a chart or the codex is up, Then it counts as an overlay', () => {
    expect(pauseContextFor({ flightShown: true, menuOpen: true, busy: false }).overlayOpen).toBe(true);
  });

  it('Given a jump or recovery, Then busy is passed through', () => {
    expect(pauseContextFor({ flightShown: true, menuOpen: false, busy: true }).busy).toBe(true);
  });

  it('Given the pause is open and flight is no longer shown, When Esc arrives, Then it still closes', () => {
    const ctx = pauseContextFor({ flightShown: false, menuOpen: false, busy: false });
    expect(pauseStep(openAt(0), { type: 'escKey', t: ESC_DEBOUNCE_MS + 1 }, ctx).state.open).toBe(false);
  });
});

// Final whole-branch review, I1: with a tank, RETURN TO ORBIT costs what the
// beacon costs, and the sheet says so before the pilot picks it. Pause.ts
// writes the button from this label; the DOM does not run in node.
describe('final review I1 — the RETURN TO ORBIT label tells the price', () => {
  it('Given a tank attached, Then the button reads RETURN TO ORBIT · COSTS AS BEACON', () => {
    expect(returnToOrbitLabel(true)).toBe('RETURN TO ORBIT · COSTS AS BEACON');
  });

  it('Given no tank (a v3 hull), Then the button reads RETURN TO ORBIT, as before', () => {
    expect(returnToOrbitLabel(false)).toBe('RETURN TO ORBIT');
  });
});

// Final whole-branch review, I2 (v4-mining): the paid RETURN TO ORBIT pays as
// the beacon pays — the hold included (RecoveryCut → payBeacon). With cargo
// aboard the sheet says so; with an empty hold, or no tank (free, the hold is
// kept), the label is unchanged.
describe('final review I2 — the RETURN TO ORBIT label says it loses the cargo', () => {
  it('Given a tank and 6 099 kg aboard, Then the button reads RETURN TO ORBIT · COSTS AS BEACON · LOSES CARGO', () => {
    expect(returnToOrbitLabel(true, 6_099)).toBe('RETURN TO ORBIT · COSTS AS BEACON · LOSES CARGO');
  });

  it('Given a tank and an empty hold, Then the button reads RETURN TO ORBIT · COSTS AS BEACON, as before', () => {
    expect(returnToOrbitLabel(true, 0)).toBe('RETURN TO ORBIT · COSTS AS BEACON');
  });

  it('Given no tank, Then the button reads RETURN TO ORBIT whatever the hold holds (the free return keeps the cargo)', () => {
    expect(returnToOrbitLabel(false, 6_099)).toBe('RETURN TO ORBIT');
    expect(returnToOrbitLabel(false, 0)).toBe('RETURN TO ORBIT');
  });

  it('Given Pause.ts, Then it writes the button from the hold as well as the tank (returnToOrbitLabel gets the cargo)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Pause.ts'), 'utf8');
    const calls = src.match(/returnToOrbitLabel\(([^;]*)\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => /cargo/.test(c)), calls.join(' | ')).toBe(true);
  });
});

// v4 sub-plan 3 (local save), Task 5: SAVE in the pause sheet. The sheet stays
// open (the pilot reads SAVED in the log behind it); the caller saves.
describe('v4-save — the SAVE button', () => {
  it('Given the pause is open, When SAVE is clicked, Then the effect is save and the sheet stays open (same state)', () => {
    const s = openAt(1_000);
    const r = pauseStep(s, { type: 'save' }, flying);
    expect(r.effect).toBe('save');
    expect(r.state).toEqual(s);
  });

  it('Given the pause is closed, When a stray SAVE arrives, Then nothing happens', () => {
    expect(pauseStep(PAUSE_CLOSED, { type: 'save' }, flying)).toEqual({ state: PAUSE_CLOSED, effect: 'none' });
  });

  it('Given the pause is open while busy (a recovery started behind it), When SAVE is clicked, Then it still asks for a save (busy only blocks opening)', () => {
    expect(pauseStep(openAt(0), { type: 'save' }, warping).effect).toBe('save');
  });

  it("Given Pause.ts, Then it has a SAVE button that dispatches { type: 'save' } and acts on the save effect", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Pause.ts'), 'utf8');
    expect(/this\.button\([^,]+,\s*'SAVE'/.test(src), 'a SAVE button').toBe(true);
    expect(/type:\s*'save'/.test(src), "dispatch({ type: 'save' })").toBe(true);
    expect(/effect\s*===\s*'save'/.test(src), "acts on effect 'save'").toBe(true);
  });
});

// =============================================================================
// v4 sub-plan 4 (backend), Task 6 — the account in the pause sheet (R51, R54)
// and the sync status (SyncClient.statusText()) under the account line.
//
// Assumed surface (src/ui/pauseState.ts):
//   DELETE_ACCOUNT_TEXT         === 'DELETE ACCOUNT'
//   DELETE_ACCOUNT_CONFIRM_TEXT === 'DELETE ACCOUNT — PRESS AGAIN TO CONFIRM'
//   interface DeleteAccountState { readonly armed: boolean }; DELETE_DISARMED
//   deleteAccountStep(s, e: { kind: 'press' } | { kind: 'other' } | { kind: 'closed' }):
//     { state; effect: { kind: 'none' } | { kind: 'deleteAccount'; confirmed: boolean } }
//     — the first press arms (confirmed false), the second confirms; any other
//       button and the sheet closing disarm it, exactly as NEW GAME on the title.
//   deleteAccountLabel(s): string
//   pauseAccountView(account: AccountView, syncText: string | null):
//     { line: string | null; syncLine: string | null; deleteAccount: boolean }
//   initialSyncNotice(status: SyncStatus, text: string | null): SyncNoticeWatch
//   syncNoticeStep(w, status, text): { watch: SyncNoticeWatch; notice: string | null }
//     — a status change logs its text ONCE (boot already logged the first);
//       'pending' (a retry in flight) does not count as a change; a status
//       with no text (synced, off) clears it, so the next outage logs again.
// =============================================================================

describe('v4-net Task 6 — DELETE ACCOUNT needs two presses, like NEW GAME (R54)', () => {
  it('Given the texts, Then they are verbatim', () => {
    expect(DELETE_ACCOUNT_TEXT).toBe('DELETE ACCOUNT');
    expect(DELETE_ACCOUNT_CONFIRM_TEXT).toBe('DELETE ACCOUNT — PRESS AGAIN TO CONFIRM');
    expect(deleteAccountLabel(DELETE_DISARMED)).toBe('DELETE ACCOUNT');
  });

  it('Given disarmed, When DELETE ACCOUNT is pressed once, Then it is only armed (confirmed false) and asks for a second press', () => {
    const r = deleteAccountStep(DELETE_DISARMED, { kind: 'press' });
    expect(r.effect).toEqual({ kind: 'deleteAccount', confirmed: false });
    expect(r.state.armed).toBe(true);
    expect(deleteAccountLabel(r.state)).toBe('DELETE ACCOUNT — PRESS AGAIN TO CONFIRM');
  });

  it('Given armed, When pressed again, Then the effect is deleteAccount confirmed and it disarms', () => {
    const armed = deleteAccountStep(DELETE_DISARMED, { kind: 'press' }).state;
    const r = deleteAccountStep(armed, { kind: 'press' });
    expect(r.effect).toEqual({ kind: 'deleteAccount', confirmed: true });
    expect(r.state.armed).toBe(false);
  });

  it.each(['other', 'closed'] as const)('Given armed, When %s (another button, the sheet closing), Then it is disarmed and needs two presses again', (kind) => {
    const armed = deleteAccountStep(DELETE_DISARMED, { kind: 'press' }).state;
    const r = deleteAccountStep(armed, { kind });
    expect(r.effect).toEqual({ kind: 'none' });
    expect(r.state.armed).toBe(false);
    expect(deleteAccountStep(r.state, { kind: 'press' }).effect).toEqual({ kind: 'deleteAccount', confirmed: false });
  });

  it('Given the reducer, Then it never mutates the state it was given', () => {
    const s: DeleteAccountState = { armed: true };
    deleteAccountStep(s, { kind: 'press' });
    deleteAccountStep(s, { kind: 'other' });
    expect(s).toEqual({ armed: true });
  });
});

describe('v4-net Task 6 — the account line and the sync status in the sheet (R51)', () => {
  it('Given signed in and in sync, Then the account line, no status line, and DELETE ACCOUNT is offered', () => {
    expect(pauseAccountView({ kind: 'signed-in', name: 'Dennis' }, null)).toEqual({
      line: 'SIGNED IN AS Dennis',
      syncLine: null,
      deleteAccount: true,
    });
  });

  it.each<[SyncStatus, string]>([
    ['offline', SYNC_OFFLINE_TEXT],
    ['reauth', SYNC_REAUTH_TEXT],
    ['conflict', SYNC_CONFLICT_TEXT],
  ])('Given status %s, Then its text sits under the account line', (_status, text) => {
    expect(pauseAccountView({ kind: 'signed-in', name: 'Dennis' }, text)).toEqual({
      line: 'SIGNED IN AS Dennis',
      syncLine: text,
      deleteAccount: true,
    });
  });

  it('Given the status texts, Then they are the SyncClient constants, verbatim', () => {
    expect(SYNC_OFFLINE_TEXT).toBe('OFFLINE — SAVED LOCALLY');
    expect(SYNC_REAUTH_TEXT).toBe('SIGN IN AGAIN TO SYNC');
    expect(SYNC_CONFLICT_TEXT).toBe('SYNC CONFLICT — CHOOSE ON NEXT START');
  });

  it('Ruling R57: Given a guest (even a save bound to a signed-out account), Then no account line, no sync line and no DELETE ACCOUNT', () => {
    expect(pauseAccountView({ kind: 'guest' }, SYNC_REAUTH_TEXT)).toEqual({ line: null, syncLine: null, deleteAccount: false });
    expect(pauseAccountView({ kind: 'guest' }, SYNC_OFFLINE_TEXT)).toEqual({ line: null, syncLine: null, deleteAccount: false });
    expect(pauseAccountView({ kind: 'guest' }, null)).toEqual({ line: null, syncLine: null, deleteAccount: false });
  });

  it('Ruling R57: Given Pause.ts, Then it never offers sign-in (the title only)', () => {
    const s = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Pause.ts'), 'utf8');
    expect(s).not.toMatch(/SIGN_IN_TEXT|SIGN_IN_PATH|SIGN IN WITH DISCORD/);
  });

  it('Given a reader tab (hidden), Then no account line and no DELETE ACCOUNT', () => {
    expect(pauseAccountView({ kind: 'hidden' }, null)).toEqual({ line: null, syncLine: null, deleteAccount: false });
  });

  it('R52: Given a 40-character name, Then the line shows the first 32', () => {
    const name = 'abcdefghij'.repeat(4);
    expect(pauseAccountView({ kind: 'signed-in', name }, null).line).toBe(`SIGNED IN AS ${name.slice(0, 32)}`);
  });
});

describe('v4-net Task 6 — a sync status change is logged once', () => {
  const step = (w: SyncNoticeWatch, status: SyncStatus, text: string | null) => syncNoticeStep(w, status, text);

  it('Given the boot status (already in the boot notices), When it is seen again every frame, Then nothing is logged', () => {
    let w = initialSyncNotice('offline', SYNC_OFFLINE_TEXT);
    for (let i = 0; i < 5; i++) {
      const r = step(w, 'offline', SYNC_OFFLINE_TEXT);
      expect(r.notice).toBeNull();
      w = r.watch;
    }
  });

  it('Given synced, When it goes offline, Then the offline text is logged once — not again on later frames', () => {
    const r = step(initialSyncNotice('synced', null), 'offline', SYNC_OFFLINE_TEXT);
    expect(r.notice).toBe(SYNC_OFFLINE_TEXT);
    expect(step(r.watch, 'offline', SYNC_OFFLINE_TEXT).notice).toBeNull();
  });

  it('Given offline, When a retry is in flight (pending) and fails again (offline), Then nothing is logged again', () => {
    const w = step(initialSyncNotice('synced', null), 'offline', SYNC_OFFLINE_TEXT).watch;
    const p = step(w, 'pending', null);
    expect(p.notice).toBeNull();
    expect(step(p.watch, 'offline', SYNC_OFFLINE_TEXT).notice).toBeNull();
  });

  it('Given offline, When it syncs and later goes offline again, Then the second outage is logged too', () => {
    let w = step(initialSyncNotice('synced', null), 'offline', SYNC_OFFLINE_TEXT).watch;
    w = step(w, 'synced', null).watch;
    expect(step(w, 'offline', SYNC_OFFLINE_TEXT).notice).toBe(SYNC_OFFLINE_TEXT);
  });

  it('Given offline, When it turns to reauth or conflict, Then the new text is logged once', () => {
    const w = step(initialSyncNotice('synced', null), 'offline', SYNC_OFFLINE_TEXT).watch;
    const r = step(w, 'reauth', SYNC_REAUTH_TEXT);
    expect(r.notice).toBe(SYNC_REAUTH_TEXT);
    expect(step(r.watch, 'reauth', SYNC_REAUTH_TEXT).notice).toBeNull();
    expect(step(w, 'conflict', SYNC_CONFLICT_TEXT).notice).toBe(SYNC_CONFLICT_TEXT);
  });

  it('Given a status with no text (synced, off, pending), Then nothing is ever logged for it', () => {
    const w = initialSyncNotice('offline', SYNC_OFFLINE_TEXT);
    expect(step(w, 'synced', null).notice).toBeNull();
    expect(step(w, 'off', null).notice).toBeNull();
    expect(step(w, 'pending', null).notice).toBeNull();
  });
});

describe('v4-net Task 6 — Pause.ts wires the account (source)', () => {
  const src = (): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Pause.ts'), 'utf8');

  it('Given Pause.ts, Then DELETE ACCOUNT goes through deleteAccountStep/deleteAccountLabel and the confirmed effect runs runDeleteAccount', () => {
    const s = src();
    expect(s).toMatch(/deleteAccountStep\(/);
    expect(s).toMatch(/deleteAccountLabel\(/);
    expect(s).toMatch(/runDeleteAccount\(/);
  });

  it('Given Pause.ts, Then the account and sync lines come from pauseAccountView, and status changes go through syncNoticeStep', () => {
    const s = src();
    expect(s).toMatch(/pauseAccountView\(/);
    expect(s).toMatch(/syncNoticeStep\(/);
  });
});

// =============================================================================
// Task 6 fix round 1 — R61: an auto-repeated key never arms and never
// confirms DELETE ACCOUNT (the press event carries `repeat`); R62a: the
// pointer entering another item disarms it, as on the title.
// =============================================================================

describe('Ruling R61 — a held key never arms or confirms DELETE ACCOUNT', () => {
  it('Ruling R61: Given disarmed, When a repeated press arrives, Then the state is unchanged and there is no effect', () => {
    const r = deleteAccountStep(DELETE_DISARMED, { kind: 'press', repeat: true });
    expect(r.state).toEqual(DELETE_DISARMED);
    expect(r.effect).toEqual({ kind: 'none' });
  });

  it('Ruling R61: Given armed, When a repeated press arrives, Then it stays armed and nothing is confirmed', () => {
    const armed = deleteAccountStep(DELETE_DISARMED, { kind: 'press' }).state;
    const r = deleteAccountStep(armed, { kind: 'press', repeat: true });
    expect(r.state).toEqual({ armed: true });
    expect(r.effect).toEqual({ kind: 'none' });
  });

  it('Ruling R61: Given a confirmed delete that failed (disarmed again), When Enter is held (repeated presses), Then it stays disarmed and no further delete is asked for', () => {
    let s = deleteAccountStep(DELETE_DISARMED, { kind: 'press' }).state;
    const confirm = deleteAccountStep(s, { kind: 'press' });
    expect(confirm.effect).toEqual({ kind: 'deleteAccount', confirmed: true });
    s = confirm.state; // the delete failed: a notice, nothing changed
    expect(s.armed).toBe(false);
    const effects: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      const r = deleteAccountStep(s, { kind: 'press', repeat: true });
      effects.push(r.effect);
      s = r.state;
    }
    expect(s.armed).toBe(false);
    expect(effects.every((e) => (e as { kind: string }).kind === 'none')).toBe(true);
  });

  it('Ruling R61: Given a non-repeated press (repeat false or absent), Then it arms as before', () => {
    expect(deleteAccountStep(DELETE_DISARMED, { kind: 'press', repeat: false }).effect).toEqual({ kind: 'deleteAccount', confirmed: false });
  });

  it('Ruling R61: Given Pause.ts, Then its key handler suppresses repeated Enter / NumpadEnter / Space (preventDefault), so a held key cannot click a focused button again', () => {
    const s = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Pause.ts'), 'utf8');
    expect(s).toMatch(/'NumpadEnter'/);
    expect(s).toMatch(/'Enter'/);
    expect(s).toMatch(/'Space'/);
    const i = s.indexOf("'NumpadEnter'");
    const near = s.slice(Math.max(0, i - 300), i + 300);
    expect(near).toMatch(/\.repeat\b/);
    expect(near).toMatch(/preventDefault\(\)/);
  });
});

describe('Ruling R62a — the pointer entering another item disarms DELETE ACCOUNT', () => {
  it('Ruling R62a: Given armed, When the pointer enters another item (an other event), Then it is disarmed', () => {
    const armed = deleteAccountStep(DELETE_DISARMED, { kind: 'press' }).state;
    const r = deleteAccountStep(armed, { kind: 'other' });
    expect(r.state.armed).toBe(false);
    expect(deleteAccountLabel(r.state)).toBe('DELETE ACCOUNT');
  });

  it('Ruling R62a: Given Pause.ts, Then the other buttons wire mouseenter/pointerenter to the other event', () => {
    const s = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Pause.ts'), 'utf8');
    expect(s).toMatch(/addEventListener\(\s*'(mouseenter|pointerenter)'[\s\S]{0,240}kind:\s*'other'/);
  });
});

// =============================================================================
// v4 sub-plan 5 (mining you can see), Task 8 — where the keys are looked up
// (DESIGN-5 §7.7). The sheet listed neither B, U, N, K nor H, and said L only
// lands and goes to orbit, though L also flies to a targeted rock.
//
// Assumed surface (src/ui/pauseState.ts; Pause.ts renders it):
//   interface PauseKeyMap {
//     readonly mining: { mine; refine; repair: string };              // MINING_KEYS
//     readonly emergency: { open; cannibalize; beacon; cannibalizeCargo: string }; // EMERGENCY_KEYS
//     readonly formation: string;                                      // FORMATION_KEY
//   }
//   pauseControls(keys?: PauseKeyMap): ReadonlyArray<readonly [key: string, text: string]>
//     — the sheet's key lines; omitted `keys` = the game's own map. The key
//       column is the code without its `Key` / `Digit` prefix ('KeyB' → 'B').
// =============================================================================

interface PauseKeyMapV5 {
  readonly mining: { readonly mine: string; readonly refine: string; readonly repair: string };
  readonly emergency: {
    readonly open: string;
    readonly cannibalize: string;
    readonly beacon: string;
    readonly cannibalizeCargo: string;
  };
  readonly formation: string;
}
type ControlLine = readonly [string, string];
const pauseV5 = pauseStateModule as unknown as {
  pauseControls?: (keys?: PauseKeyMapV5) => ReadonlyArray<ControlLine>;
};
function controls(keys?: PauseKeyMapV5): ReadonlyArray<ControlLine> {
  expect(typeof pauseV5.pauseControls, 'pauseState exports pauseControls').toBe('function');
  return pauseV5.pauseControls!(keys);
}
/** 'KeyB' → 'B', 'Digit1' → '1': what the sheet prints for a key code (as Emergency.ts does). */
const keyLabel = (code: string): string => code.replace(/^Key/, '').replace(/^Digit/, '');
const emergencyKeyColumn = (e: PauseKeyMapV5['emergency']): string =>
  `${keyLabel(e.open)} · ${keyLabel(e.cannibalize)} / ${keyLabel(e.beacon)} / ${keyLabel(e.cannibalizeCargo)}`;
const lineFor = (lines: ReadonlyArray<ControlLine>, key: string): ControlLine | undefined => lines.find(([k]) => k === key);

describe('plan 5 Task 8 — the pause sheet lists every key (§7.7)', () => {
  it('Given the sheet, Then it lists B mine, U refine, N repair, K formation hold and H emergency exit with 1 / 2 / 3', () => {
    const lines = controls();
    const expected: ReadonlyArray<readonly [string, RegExp]> = [
      [keyLabel(MINING_KEYS.mine), /^MINE\b/],
      [keyLabel(MINING_KEYS.refine), /^REFINE\b/],
      [keyLabel(MINING_KEYS.repair), /^REPAIR\b/],
      [keyLabel(FORMATION_KEY), /^FORMATION HOLD\b/],
      [emergencyKeyColumn(EMERGENCY_KEYS), /^EMERGENCY EXIT\b/],
    ];
    for (const [key, text] of expected) {
      const line = lineFor(lines, key);
      expect(line, `a line for ${key}`).toBeDefined();
      expect(line![1], key).toMatch(text);
    }
    // What the game binds today, so the test reads as the spec does.
    expect(expected.map(([k]) => k)).toEqual(['B', 'U', 'N', 'K', 'H · 1 / 2 / 3']);
  });

  it('Given the sheet, Then L reads AUTOPILOT — LAND · TO ORBIT · APPROACH TARGET, and L is the key bound to the autopilot', () => {
    expect(actionForKey('KeyL')).toBe('land');
    expect(lineFor(controls(), 'L')).toEqual(['L', 'AUTOPILOT — LAND · TO ORBIT · APPROACH TARGET']);
  });

  it('Given a different key map, When the sheet is built from it, Then every new line follows the map (the keys are read, not typed by hand)', () => {
    const moved: PauseKeyMapV5 = {
      mining: { mine: 'KeyP', refine: 'KeyO', repair: 'KeyI' },
      emergency: { open: 'KeyQ', cannibalize: 'Digit7', beacon: 'Digit8', cannibalizeCargo: 'Digit9' },
      formation: 'KeyY',
    };
    const lines = controls(moved);
    expect(lineFor(lines, 'P')?.[1]).toMatch(/^MINE\b/);
    expect(lineFor(lines, 'O')?.[1]).toMatch(/^REFINE\b/);
    expect(lineFor(lines, 'I')?.[1]).toMatch(/^REPAIR\b/);
    expect(lineFor(lines, 'Y')?.[1]).toMatch(/^FORMATION HOLD\b/);
    expect(lineFor(lines, 'Q · 7 / 8 / 9')?.[1]).toMatch(/^EMERGENCY EXIT\b/);
    // The game's own keys are gone from those lines: nothing was written in by hand.
    const keys = lines.map(([k]) => k);
    for (const own of ['B', 'U', 'N', 'K', 'H · 1 / 2 / 3']) expect(keys, own).not.toContain(own);
    // Omitting the map is the game's map.
    const game: PauseKeyMapV5 = { mining: MINING_KEYS, emergency: EMERGENCY_KEYS, formation: FORMATION_KEY };
    expect(controls(game)).toEqual(controls());
  });

  it('Given the sheet, Then every line it had before Task 8 is still there, in the same order, and no key is listed twice', () => {
    const before: ReadonlyArray<ControlLine> = [
      ['MOUSE · ARROWS', 'PITCH AND YAW'],
      ['Q / E', 'ROLL'],
      ['W / S · WHEEL', 'THROTTLE'],
      ['X', 'THROTTLE ZERO'],
      ['A D · R F', 'LATERAL · VERTICAL THRUST'],
      ['SHIFT · SPACE', 'BOOST · BRAKE'],
      ['Z', 'FLIGHT ASSIST'],
      ['TAB', 'CYCLE TARGET'],
      ['G', 'CRUISE'],
      ['T', 'SCAN'],
      ['M', 'CHART (WHEEL OUT FOR THE GALAXY)'],
      ['J', 'JUMP TO THE CHARTED SYSTEM'],
      ['C', 'CODEX'],
      ['V', 'CAMERA'],
      ['F2', 'SCREENSHOT'],
      ['ESC', 'PAUSE'],
      ['L', 'AUTOPILOT — LAND · TO ORBIT · APPROACH TARGET'], // the one text Task 8 changes
      [', / .', 'TIME COMPRESSION (GROUND · STABLE ORBIT)'],
    ];
    const lines = controls();
    const at = before.map((b) => lines.findIndex((l) => l[0] === b[0] && l[1] === b[1]));
    expect(at.filter((i) => i < 0), JSON.stringify(before.filter((_, j) => at[j] < 0))).toEqual([]);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(lines.length).toBe(before.length + 5);
    expect(new Set(lines.map(([k]) => k)).size).toBe(lines.length);
  });

  it('Given Pause.ts, Then it renders the key lines from pauseControls and keeps no list of its own', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Pause.ts'), 'utf8');
    expect(src).toMatch(/pauseControls\(/);
    expect(src).not.toMatch(/const\s+CONTROLS\b/);
    expect(src).not.toMatch(/AUTOPILOT — LAND/);
  });
});

// =============================================================================
// v4 sub-plan 6 (resources), Task 5 — where the resources key is looked up
// (DESIGN-6 §7.5). The sheet gets one line for I: `I` / `RESOURCES — HOLD,
// BEAM, JETTISON`, read from RESOURCES_KEY (core/Input), not typed by hand.
//
// Assumed surface (src/ui/pauseState.ts):
//   PauseKeyMap gains `readonly resources?: string` (RESOURCES_KEY). It is
//   optional, so a map built before Task 5 (the Task 8 tests above pass one)
//   still builds a sheet; a missing `resources` reads RESOURCES_KEY.
//
// End state: 24 lines (the Task 8 sheet's 23 + this one). The Task 8 test
// above that counts `before.length + 5` (pauseState.test.ts:566) is the one
// approved assertion that must change, to `+ 6`, once this is implemented.
// =============================================================================

interface PauseKeyMapV6 extends PauseKeyMapV5 {
  readonly resources?: string;
}
const pauseV6 = pauseStateModule as unknown as {
  pauseControls?: (keys?: PauseKeyMapV6) => ReadonlyArray<ControlLine>;
};
function controlsV6(keys?: PauseKeyMapV6): ReadonlyArray<ControlLine> {
  expect(typeof pauseV6.pauseControls, 'pauseState exports pauseControls').toBe('function');
  return pauseV6.pauseControls!(keys);
}
const RESOURCES_TEXT = 'RESOURCES — HOLD, BEAM, JETTISON';
const GAME_MAP_V6: PauseKeyMapV6 = {
  mining: MINING_KEYS,
  emergency: EMERGENCY_KEYS,
  formation: FORMATION_KEY,
  resources: RESOURCES_KEY,
};

/** The sheet as Task 8 left it (23 lines), in its order. */
const TASK8_SHEET: ReadonlyArray<ControlLine> = [
  ['MOUSE · ARROWS', 'PITCH AND YAW'],
  ['Q / E', 'ROLL'],
  ['W / S · WHEEL', 'THROTTLE'],
  ['X', 'THROTTLE ZERO'],
  ['A D · R F', 'LATERAL · VERTICAL THRUST'],
  ['SHIFT · SPACE', 'BOOST · BRAKE'],
  ['Z', 'FLIGHT ASSIST'],
  ['TAB', 'CYCLE TARGET'],
  ['K', 'FORMATION HOLD'],
  ['G', 'CRUISE'],
  ['T', 'SCAN'],
  ['M', 'CHART (WHEEL OUT FOR THE GALAXY)'],
  ['J', 'JUMP TO THE CHARTED SYSTEM'],
  ['C', 'CODEX'],
  ['V', 'CAMERA'],
  ['F2', 'SCREENSHOT'],
  ['ESC', 'PAUSE'],
  ['L', 'AUTOPILOT — LAND · TO ORBIT · APPROACH TARGET'],
  [', / .', 'TIME COMPRESSION (GROUND · STABLE ORBIT)'],
  ['B', 'MINE (AGAIN TO STOP)'],
  ['U', 'REFINE ICE TO PROPELLANT'],
  ['N', 'REPAIR THE TANK'],
  ['H · 1 / 2 / 3', 'EMERGENCY EXIT (EMPTY TANK)'],
];

/**
 * Every key code a player can press that the game might bind, with what the
 * sheet prints for it. Letters and digits are built, not spelled out.
 */
const SHEET_LABEL: ReadonlyArray<readonly [code: string, label: string]> = [
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).map((c) => [`Key${c}`, c] as const),
  ...Array.from({ length: 10 }, (_, i) => [`Digit${i}`, String(i)] as const),
  ...Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `F${i + 1}`] as const),
  ['ShiftLeft', 'SHIFT'],
  ['ShiftRight', 'SHIFT'],
  ['Space', 'SPACE'],
  ['Tab', 'TAB'],
  ['Escape', 'ESC'],
  ['Comma', ','],
  ['Period', '.'],
  ['Enter', 'ENTER'],
  ['Backspace', 'BACKSPACE'],
  ['Minus', '-'],
  ['Equal', '='],
  ['Slash', '/'],
  ['Semicolon', ';'],
  ['Quote', "'"],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Backquote', '`'],
  ['Backslash', '\\'],
];
/** The key column's tokens: 'H · 1 / 2 / 3' → H, 1, 2, 3; ', / .' → ',', '.'. */
const keyTokens = (lines: ReadonlyArray<ControlLine>): Set<string> =>
  new Set(lines.flatMap(([k]) => k.split(/\s+/).filter((t) => t !== '·' && t !== '/' && t !== '')));

describe('plan 6 Task 5 — the pause sheet names the resources key (DESIGN-6 §7.5)', () => {
  it("Given Input, Then the resources key is I and it is bound to 'resources' (so the sheet's line names the real key)", () => {
    expect(keyLabel(RESOURCES_KEY)).toBe('I');
    expect(actionForKey(RESOURCES_KEY)).toBe('resources');
  });

  it('Given the sheet, Then it has the line I — RESOURCES — HOLD, BEAM, JETTISON', () => {
    expect(lineFor(controlsV6(), keyLabel(RESOURCES_KEY))).toEqual(['I', RESOURCES_TEXT]);
  });

  it('Given the sheet, Then the resources text appears on exactly one line', () => {
    expect(controlsV6().filter(([, t]) => t === RESOURCES_TEXT)).toHaveLength(1);
  });

  it('Given a key map with the resources key moved, When the sheet is built from it, Then the line follows the map (read, not typed)', () => {
    const lines = controlsV6({ ...GAME_MAP_V6, resources: 'KeyP' });
    expect(lineFor(lines, 'P')).toEqual(['P', RESOURCES_TEXT]);
    expect(lines.find(([k, t]) => k === 'I' && t === RESOURCES_TEXT)).toBeUndefined();
    expect(lines.filter(([, t]) => t === RESOURCES_TEXT)).toHaveLength(1);
  });

  it('Given the game map with RESOURCES_KEY, Then the sheet equals the one built with no map', () => {
    expect(controlsV6(GAME_MAP_V6)).toEqual(controlsV6());
  });

  it('Given a key map built before Task 5 (no resources field), Then the sheet still builds and reads RESOURCES_KEY', () => {
    const old: PauseKeyMapV6 = { mining: MINING_KEYS, emergency: EMERGENCY_KEYS, formation: FORMATION_KEY };
    expect(() => controlsV6(old)).not.toThrow();
    expect(lineFor(controlsV6(old), 'I')).toEqual(['I', RESOURCES_TEXT]);
  });

  it('Given the sheet, Then it is the Task 8 sheet in the same order plus the I line: 24 lines, no key listed twice', () => {
    const lines = controlsV6();
    const at = TASK8_SHEET.map((b) => lines.findIndex((l) => l[0] === b[0] && l[1] === b[1]));
    expect(at.filter((i) => i < 0), JSON.stringify(TASK8_SHEET.filter((_, j) => at[j] < 0))).toEqual([]);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(lines).toHaveLength(TASK8_SHEET.length + 1);
    expect(lines).toHaveLength(24);
    const extra = lines.filter((_, i) => !at.includes(i));
    expect(extra).toEqual([['I', RESOURCES_TEXT]]);
    expect(new Set(lines.map(([k]) => k)).size).toBe(lines.length);
  });

  it('Given every key Input binds to an action, Then the sheet names that key somewhere in its key column', () => {
    const tokens = keyTokens(controlsV6());
    const bound = SHEET_LABEL.filter(([code]) => actionForKey(code) !== undefined);
    // The list reaches every bound key we know of, so the rule is not vacuous.
    expect(bound.map(([c]) => c)).toEqual(expect.arrayContaining([RESOURCES_KEY, MINING_KEYS.mine, EMERGENCY_KEYS.open, 'Escape', 'Comma']));
    const missing = bound.filter(([, label]) => !tokens.has(label)).map(([code]) => code);
    expect(missing).toEqual([]);
  });

  it('Given Pause.ts, Then it does not write the resources line itself (it renders pauseControls) — guard', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Pause.ts'), 'utf8');
    expect(src).not.toMatch(/RESOURCES — HOLD/);
  });
});
