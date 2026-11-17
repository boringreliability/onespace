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

  it('Given a guest (a save bound to an account that is signed out), Then no account line and no DELETE ACCOUNT, but the status still shows', () => {
    expect(pauseAccountView({ kind: 'guest' }, SYNC_REAUTH_TEXT)).toEqual({ line: null, syncLine: SYNC_REAUTH_TEXT, deleteAccount: false });
    expect(pauseAccountView({ kind: 'guest' }, null)).toEqual({ line: null, syncLine: null, deleteAccount: false });
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
