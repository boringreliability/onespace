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
