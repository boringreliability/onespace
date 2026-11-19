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

import { MINING_KEYS } from '@/core/Input';
import type { CargoAction, CargoResult } from '@/ship/cargo';

import {
  HINT_COUNTS_KEY,
  HINT_RETIRE_AFTER,
  HINT_TEXT,
  type HintCounts,
  type HintState,
  isRetired,
  loadHintCounts,
  recordCargoAction,
  recordUse,
  saveHintCounts,
  selectHint,
} from './hintRules';

const base: HintState = {
  inFlight: true,
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

describe('review-p1: hints outside flight and pinned constants', () => {
  it('Given the title screen (or the Yard, or a photo overlay) with the pointer free, Then there is no hint — not CLICK TO TAKE THE CONTROLS under the menu', () => {
    expect(selectHint({ ...base, inFlight: false, pointerLocked: false }, none)).toBeNull();
    expect(selectHint({ ...base, inFlight: false }, none)).toBeNull();
  });

  it('Given the retirement limits, Then they are fly 3 and every other hint 2 (pinned, not read back)', () => {
    expect(HINT_RETIRE_AFTER).toEqual({ fly: 3, cruise: 2, scan: 2, chart: 2, pause: 2, mine: 2 });
  });

  it('Given fly used twice, Then fly is still advised; three times, Then it is not', () => {
    expect(selectHint(base, { fly: 2 })).toBe('fly');
    expect(selectHint(base, { fly: 3 })).not.toBe('fly');
  });

  it('Given recordUse on scan, Then the other counts are kept', () => {
    expect(recordUse({ fly: 3 }, 'scan')).toEqual({ fly: 3, scan: 1 });
  });

  it('Given stored counts of 0, 1e999 and 1.7, Then 0 is kept, the overflow is dropped and the fraction is floored', () => {
    const store = (v: string) => ({ getItem: () => v, setItem: () => undefined });
    expect(loadHintCounts(store('{"scan":0}'))).toEqual({ scan: 0 });
    expect(loadHintCounts(store('{"scan":1e999}'))).toEqual({});
    expect(loadHintCounts(store('{"scan":1.7}'))).toEqual({ scan: 1 });
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

// ---------------------------------------------------------------------------
// v4 sub-plan 2, Task 5 — the 'mine' hint. It appears the first time an
// asteroid is targeted within mining range, and retires after 2 COMPLETED
// mines (a refused or aborted B does not count).
// ---------------------------------------------------------------------------

describe("the 'mine' hint", () => {
  const ok = (kind: CargoAction['kind'], good: boolean): { action: CargoAction; result: CargoResult } => ({
    action:
      kind === 'mine' ? { kind: 'mine', asteroidId: 'ast:x:0:1', resource: 'ice', kg: 2_000 } : ({ kind } as CargoAction),
    result: { ok: good, kgIn: good ? 2_000 : 0, kgOut: 0, fuelKg: 0, restoredFrac: 0 },
  });

  it('Given its text, Then it names the mine key: "B — MINE"', () => {
    const label = MINING_KEYS.mine.replace(/^Key/, '');
    expect(HINT_TEXT.mine).toBe(`${label} — MINE`);
  });

  it('Given an asteroid targeted in range, Then the hint is mine — ahead of every lesson, even for a new pilot', () => {
    expect(selectHint({ ...base, hasTarget: true, asteroidInRange: true }, none)).toBe('mine');
    expect(selectHint({ ...base, hasTarget: true, asteroidInRange: true }, { fly: 3 })).toBe('mine');
  });

  it('Given no asteroid in range (or the field omitted), Then mine is never advised', () => {
    expect(selectHint({ ...base, hasTarget: true, asteroidInRange: false }, allUsed)).toBeNull();
    expect(selectHint({ ...base, hasTarget: true }, allUsed)).toBeNull();
    expect(selectHint({ ...base, asteroidInRange: false }, none)).toBe('fly');
  });

  it('Given the pointer free, an overlay, pause or a jump, Then those win over mine as they do over every lesson', () => {
    const s = { ...base, hasTarget: true, asteroidInRange: true };
    expect(selectHint({ ...s, pointerLocked: false }, none)).toBe('click');
    expect(selectHint({ ...s, overlayOpen: true }, none)).toBeNull();
    expect(selectHint({ ...s, paused: true }, none)).toBeNull();
    expect(selectHint({ ...s, busy: true }, none)).toBeNull();
  });

  it('Given 1 completed mine, Then it is still advised; 2, Then it retires', () => {
    const s = { ...base, hasTarget: true, asteroidInRange: true };
    expect(selectHint(s, { ...allUsed, mine: 1 })).toBe('mine');
    expect(isRetired({ mine: 2 }, 'mine')).toBe(true);
    expect(selectHint(s, { ...allUsed, mine: 2 })).toBeNull();
  });

  it('Given cargo:action events, Then only a SUCCESSFUL mine counts towards retirement', () => {
    let c: HintCounts = {};
    c = recordCargoAction(c, ok('mine', true));
    expect(c.mine).toBe(1);
    const same = recordCargoAction(c, ok('mine', false));
    expect(same).toBe(c); // a refused mine: untouched, same object
    expect(recordCargoAction(c, ok('refine', true))).toBe(c);
    expect(recordCargoAction(c, ok('repair', true))).toBe(c);
    c = recordCargoAction(c, ok('mine', true));
    expect(c.mine).toBe(2);
    expect(isRetired(c, 'mine')).toBe(true);
  });

  it('Given saved counts with mine, When reloaded, Then mine round-trips like every other hint', () => {
    let saved = '';
    const store = { getItem: () => saved, setItem: (_k: string, v: string) => void (saved = v) };
    saveHintCounts(store, { mine: 2, fly: 3 });
    expect(loadHintCounts(store)).toEqual({ mine: 2, fly: 3 });
  });
});
