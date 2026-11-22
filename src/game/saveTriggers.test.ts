/**
 * v4 sub-plan 3 (local save), Task 5 — what triggers a save now. Pure.
 *
 * Global Constraints, "Autosave (§5.2)":
 *  - `emergency`, `hidden` and `manual` always save (the exit is paid for;
 *    a hidden tab may never come back; the pilot asked);
 *  - `landed`, `mined` and `system` save only when at least
 *    AUTOSAVE_MIN_GAP_S = 5 s have passed since the last save;
 *  - `interval` saves every AUTOSAVE_INTERVAL_S = 120 s (of play).
 *
 * `sinceLastS` is seconds since the last save; before the first save it is
 * +Infinity (nothing saved yet: every reason may save).
 */

import { describe, expect, it } from 'vitest';

import { AUTOSAVE_INTERVAL_S, AUTOSAVE_MIN_GAP_S, shouldAutosave, type SaveReason } from './saveTriggers';

const ALWAYS: readonly SaveReason[] = ['emergency', 'hidden', 'manual', 'leave'];
const GAPPED: readonly SaveReason[] = ['landed', 'mined', 'system'];

describe('saveTriggers — the constants are the Global Constraints', () => {
  it('Given the module, Then AUTOSAVE_INTERVAL_S is 120 and AUTOSAVE_MIN_GAP_S is 5', () => {
    expect(AUTOSAVE_INTERVAL_S).toBe(120);
    expect(AUTOSAVE_MIN_GAP_S).toBe(5);
  });
});

describe('shouldAutosave — emergency, hidden, manual and leave (R15) always save', () => {
  for (const reason of ALWAYS) {
    it(`Given a save 0 s ago, When the reason is '${reason}', Then it saves (no gap applies)`, () => {
      expect(shouldAutosave({ sinceLastS: 0, reason })).toBe(true);
    });

    it(`Given a save 4.999 s ago, When the reason is '${reason}', Then it saves`, () => {
      expect(shouldAutosave({ sinceLastS: 4.999, reason })).toBe(true);
    });
  }
});

describe('shouldAutosave — landed, mined and system wait for the 5 s gap', () => {
  for (const reason of GAPPED) {
    it(`Given a save 4.999 s ago, When the reason is '${reason}', Then it does not save`, () => {
      expect(shouldAutosave({ sinceLastS: 4.999, reason })).toBe(false);
    });

    it(`Given a save exactly 5 s ago, When the reason is '${reason}', Then it saves (≥, not >)`, () => {
      expect(shouldAutosave({ sinceLastS: AUTOSAVE_MIN_GAP_S, reason })).toBe(true);
    });

    it(`Given a save 0 s ago, When the reason is '${reason}', Then it does not save`, () => {
      expect(shouldAutosave({ sinceLastS: 0, reason })).toBe(false);
    });
  }
});

describe('shouldAutosave — interval saves every 120 s', () => {
  it('Given a save 119.999 s ago, When the interval asks, Then it does not save', () => {
    expect(shouldAutosave({ sinceLastS: 119.999, reason: 'interval' })).toBe(false);
  });

  it('Given a save exactly 120 s ago, When the interval asks, Then it saves', () => {
    expect(shouldAutosave({ sinceLastS: AUTOSAVE_INTERVAL_S, reason: 'interval' })).toBe(true);
  });

  it('Given a save 6 s ago (past the gap, far short of the interval), When the interval asks, Then it does not save', () => {
    expect(shouldAutosave({ sinceLastS: 6, reason: 'interval' })).toBe(false);
  });
});

describe('shouldAutosave — before the first save', () => {
  it('Given nothing saved yet (sinceLastS = +Infinity), Then every reason saves', () => {
    for (const reason of [...ALWAYS, ...GAPPED, 'interval'] as const) {
      expect(shouldAutosave({ sinceLastS: Number.POSITIVE_INFINITY, reason }), reason).toBe(true);
    }
  });

  it('Given a NaN or negative sinceLastS (a broken clock), Then a gapped reason does not save — only the always-reasons do', () => {
    for (const bad of [Number.NaN, -1]) {
      for (const reason of GAPPED) expect(shouldAutosave({ sinceLastS: bad, reason }), `${reason} ${bad}`).toBe(false);
      expect(shouldAutosave({ sinceLastS: bad, reason: 'interval' })).toBe(false);
      for (const reason of ALWAYS) expect(shouldAutosave({ sinceLastS: bad, reason }), `${reason} ${bad}`).toBe(true);
    }
  });
});

// v4 sub-plan 6, Task 4 (phase A) — a jettison asks for a save (DESIGN-6 §7.3):
// SaveReason 'jettison', with the same rule as 'mined' (AUTOSAVE_MIN_GAP_S).
// Not in SaveReason yet: spelled through a cast so the type check stays clean.
describe("shouldAutosave — 'jettison' waits for the 5 s gap, as 'mined' does (plan 6 task 4)", () => {
  const JETTISON = 'jettison' as string as SaveReason;

  it("Given a save 4.999 s ago, When the reason is 'jettison', Then it does not save", () => {
    expect(shouldAutosave({ sinceLastS: 4.999, reason: JETTISON })).toBe(false);
  });

  it("Given a save exactly 5 s ago, When the reason is 'jettison', Then it saves (≥, not >)", () => {
    expect(shouldAutosave({ sinceLastS: AUTOSAVE_MIN_GAP_S, reason: JETTISON })).toBe(true);
  });

  it("Given nothing saved yet (+Infinity), When the reason is 'jettison', Then it saves", () => {
    expect(shouldAutosave({ sinceLastS: Number.POSITIVE_INFINITY, reason: JETTISON })).toBe(true);
  });

  it("Given a broken clock (NaN or negative), When the reason is 'jettison', Then it does not save", () => {
    for (const bad of [Number.NaN, -1]) expect(shouldAutosave({ sinceLastS: bad, reason: JETTISON }), String(bad)).toBe(false);
  });

  it("Given any sinceLastS, Then 'jettison' answers exactly as 'mined'", () => {
    for (const s of [0, 1, 4.999, 5, 6, 119, 120, 1e9, Number.POSITIVE_INFINITY, Number.NaN, -1]) {
      expect(shouldAutosave({ sinceLastS: s, reason: JETTISON }), String(s)).toBe(shouldAutosave({ sinceLastS: s, reason: 'mined' }));
    }
  });
});
