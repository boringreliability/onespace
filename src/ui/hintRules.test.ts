/**
 * NAV ADVISORY — the one-line hint that replaces a tutorial.
 *
 * After boot the only text on screen used to be "ALL SYSTEMS NOMINAL". Nothing
 * said "click to fly", and every chart released the pointer without saying it
 * needed taking back. The line shows the single next useful action, and each
 * action stops being advised once the pilot has done it a couple of times —
 * a hint that never goes away is HUD noise.
 */

import { describe, expect, it } from 'vitest';

import {
  HINT_COUNTS_KEY,
  HINT_RETIRE_AFTER,
  HINT_TEXT,
  type HintCounts,
  type HintState,
  isRetired,
  loadHintCounts,
  recordUse,
  saveHintCounts,
  selectHint,
} from './hintRules';

const base: HintState = {
  pointerLocked: true,
  overlayOpen: false,
  paused: false,
  busy: false,
  hasTarget: false,
  cruising: false,
};
const none: HintCounts = {};

/** Every retirable hint already used enough. */
const allUsed: HintCounts = Object.fromEntries(
  Object.entries(HINT_RETIRE_AFTER).map(([k, n]) => [k, n]),
) as HintCounts;

describe('selectHint — what to say', () => {
  it('Given the pointer is not captured, Then the hint is CLICK TO TAKE THE CONTROLS', () => {
    expect(selectHint({ ...base, pointerLocked: false }, none)).toBe('click');
    expect(HINT_TEXT.click).toBe('CLICK TO TAKE THE CONTROLS');
  });

  it('Given a chart has just closed and left the pointer released, Then the hint is click — even for a veteran', () => {
    expect(selectHint({ ...base, pointerLocked: false }, allUsed)).toBe('click');
  });

  it('Given a chart, the codex or the pause overlay is up, Then there is no hint (the overlay speaks for itself)', () => {
    expect(selectHint({ ...base, pointerLocked: false, overlayOpen: true }, none)).toBeNull();
    expect(selectHint({ ...base, pointerLocked: false, paused: true }, none)).toBeNull();
  });

  it('Given a jump or a recovery in progress, Then there is no hint', () => {
    expect(selectHint({ ...base, busy: true }, none)).toBeNull();
  });

  it('Given a new pilot with the controls taken, Then the first hint is throttle and steering', () => {
    expect(selectHint(base, none)).toBe('fly');
    expect(HINT_TEXT.fly).toBe('W/S — THROTTLE · MOUSE — STEER');
  });

  it('Given flying is learnt, Then scan, then chart, then pause are advised in that order', () => {
    let c: HintCounts = { fly: HINT_RETIRE_AFTER.fly };
    expect(selectHint(base, c)).toBe('scan');
    c = { ...c, scan: HINT_RETIRE_AFTER.scan };
    expect(selectHint(base, c)).toBe('chart');
    c = { ...c, chart: HINT_RETIRE_AFTER.chart };
    expect(selectHint(base, c)).toBe('pause');
    expect(HINT_TEXT.scan).toBe('T — SCAN');
    expect(HINT_TEXT.chart).toBe('M — CHART');
    expect(HINT_TEXT.pause).toBe('ESC — PAUSE');
  });

  it('Given a target is selected and flying is learnt, Then cruise is advised ahead of scan', () => {
    const c: HintCounts = { fly: HINT_RETIRE_AFTER.fly };
    expect(selectHint({ ...base, hasTarget: true }, c)).toBe('cruise');
    expect(HINT_TEXT.cruise).toBe('G — CRUISE');
  });

  it('Given no target, Then cruise is never advised', () => {
    const c: HintCounts = { ...allUsed, cruise: 0 };
    expect(selectHint({ ...base, hasTarget: false }, c)).not.toBe('cruise');
  });

  it('Given the ship is already cruising, Then cruise is not advised', () => {
    const c: HintCounts = { fly: HINT_RETIRE_AFTER.fly };
    expect(selectHint({ ...base, hasTarget: true, cruising: true }, c)).not.toBe('cruise');
  });

  it('Given every hint retired and the controls taken, Then the line is empty', () => {
    expect(selectHint({ ...base, hasTarget: true }, allUsed)).toBeNull();
  });
});

describe('retirement', () => {
  it('Given each retirable hint, Then it retires after 2 or 3 uses', () => {
    for (const n of Object.values(HINT_RETIRE_AFTER)) {
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(3);
    }
  });

  it('Given click, Then it never retires (it is a state, not a lesson)', () => {
    expect('click' in HINT_RETIRE_AFTER).toBe(false);
    expect(isRetired({ click: 999 } as HintCounts, 'click')).toBe(false);
  });

  it('Given a hint used one fewer time than its limit, Then it is not retired; one more, Then it is', () => {
    const n = HINT_RETIRE_AFTER.scan;
    let c: HintCounts = {};
    for (let i = 0; i < n - 1; i++) c = recordUse(c, 'scan');
    expect(isRetired(c, 'scan')).toBe(false);
    c = recordUse(c, 'scan');
    expect(isRetired(c, 'scan')).toBe(true);
  });

  it('Given an action done before its hint ever showed, Then it still counts towards retirement', () => {
    let c: HintCounts = {};
    c = recordUse(c, 'chart');
    c = recordUse(c, 'chart');
    c = recordUse(c, 'chart');
    expect(selectHint({ ...base }, { ...c, fly: 9, scan: 9 })).toBe('pause');
  });

  it('Given recordUse, Then it returns a new object and leaves the old one alone', () => {
    const c: HintCounts = { scan: 1 };
    const next = recordUse(c, 'scan');
    expect(c).toEqual({ scan: 1 });
    expect(next).toEqual({ scan: 2 });
  });
});

describe('persistence — localStorage, defensively', () => {
  class MemoryStorage {
    map = new Map<string, string>();
    getItem(k: string): string | null {
      return this.map.get(k) ?? null;
    }
    setItem(k: string, v: string): void {
      this.map.set(k, v);
    }
  }
  const throwing = {
    getItem(): string | null {
      throw new Error('SecurityError');
    },
    setItem(): void {
      throw new Error('QuotaExceededError');
    },
  };

  it('Given saved counts, When reloaded, Then they round-trip', () => {
    const s = new MemoryStorage();
    saveHintCounts(s, { fly: 3, scan: 1 });
    expect(loadHintCounts(s)).toEqual({ fly: 3, scan: 1 });
    expect(s.map.has(HINT_COUNTS_KEY)).toBe(true);
  });

  it('Given no storage at all (private window), Then load returns empty counts and save does not throw', () => {
    expect(loadHintCounts(null)).toEqual({});
    expect(() => saveHintCounts(null, { fly: 1 })).not.toThrow();
  });

  it('Given storage that throws, Then load returns empty counts and save does not throw', () => {
    expect(loadHintCounts(throwing)).toEqual({});
    expect(() => saveHintCounts(throwing, { fly: 1 })).not.toThrow();
  });

  it('Given corrupt or hostile JSON, Then load keeps only known hint ids with finite non-negative counts', () => {
    const s = new MemoryStorage();
    s.setItem(HINT_COUNTS_KEY, '{not json');
    expect(loadHintCounts(s)).toEqual({});
    s.setItem(
      HINT_COUNTS_KEY,
      JSON.stringify({ fly: 2, scan: 'x', chart: -1, pause: 1e999, __proto__: { a: 1 }, evil: 5 }),
    );
    expect(loadHintCounts(s)).toEqual({ fly: 2 });
    s.setItem(HINT_COUNTS_KEY, '[1,2,3]');
    expect(loadHintCounts(s)).toEqual({});
  });
});
