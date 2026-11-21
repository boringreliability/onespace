/**
 * NAV ADVISORY — the one-line hint that replaces a tutorial.
 *
 * After boot the only text on screen used to be "ALL SYSTEMS NOMINAL". Nothing
 * said "click to fly", and every chart released the pointer without saying it
 * needed taking back. The line shows the single next useful action, and each
 * action stops being advised once the pilot has done it a couple of times —
 * a hint that never goes away is HUD noise.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MINING_KEYS, actionForKey } from '@/core/Input';

import * as hintRules from './hintRules';
import {
  HINT_COUNTS_KEY,
  HINT_RETIRE_AFTER,
  HINT_TEXT,
  advisoryText,
  type HintCounts,
  type HintState,
  isRetired,
  loadHintCounts,
  recordMiningEnded,
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
    expect(HINT_RETIRE_AFTER).toEqual({ fly: 3, cruise: 2, scan: 2, chart: 2, pause: 2, mine: 2, approach: 2, refine: 2 });
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
// v4 sub-plan 5, Task 3: a "mine" is an EXTRACTION — it counts on
// `mining:ended` with minedKg > 0, once however many bites it took; one that
// ended with nothing does not count, and a bite (`cargo:action`) never does.
// ---------------------------------------------------------------------------

describe("the 'mine' hint", () => {
  const endedWith = (minedKg: number) => ({ asteroidId: 'ast:x:0:1', resource: 'ice' as const, minedKg, end: 'stopped' as const });

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

  // Plan 5, Task 3: replaces "Given cargo:action events, Then only a SUCCESSFUL mine counts".
  it('Given mining:ended events, Then an extraction that mined something counts once; one that mined 0 kg does not', () => {
    let c: HintCounts = {};
    c = recordMiningEnded(c, endedWith(500)); // two bites, one extraction
    expect(c.mine).toBe(1);
    const same = recordMiningEnded(c, endedWith(0));
    expect(same).toBe(c); // nothing mined: untouched, same object
    c = recordMiningEnded(c, endedWith(250));
    expect(c.mine).toBe(2);
    expect(isRetired(c, 'mine')).toBe(true);
  });

  it('Given a count, Then recordMiningEnded leaves the other counts alone and returns a new object', () => {
    const c: HintCounts = { fly: 3, mine: 1 };
    const next = recordMiningEnded(c, endedWith(250));
    expect(next).toEqual({ fly: 3, mine: 2 });
    expect(c).toEqual({ fly: 3, mine: 1 });
  });

  it('Given plan 5, Then a bite no longer counts: hintRules has no recordCargoAction', () => {
    expect('recordCargoAction' in hintRules).toBe(false);
  });

  it('Given saved counts with mine, When reloaded, Then mine round-trips like every other hint', () => {
    let saved = '';
    const store = { getItem: () => saved, setItem: (_k: string, v: string) => void (saved = v) };
    saveHintCounts(store, { mine: 2, fly: 3 });
    expect(loadHintCounts(store)).toEqual({ mine: 2, fly: 3 });
  });
});

// ---------------------------------------------------------------------------
// v4 sub-plan 5, Task 8 — two more lessons in the pattern of `B — MINE`
// (DESIGN-5 §7.7): `L — APPROACH` when an asteroid is targeted but out of
// mining range, and `U — REFINE` when there is ice in the hold and room in the
// tank. Both retire after 2 uses. Order on the line: the emergency line,
// click, mine, approach, refine, then the rest.
//
// Assumed surface (src/ui/hintRules.ts):
//   HintId gains 'approach' | 'refine'; HINT_TEXT / HINT_RETIRE_AFTER gain both.
//   HintState gains (optional, like asteroidInRange):
//     asteroidOutOfRange?: boolean — an asteroid is targeted and out of range
//     refinable?: boolean          — ice in the hold and room in the tank (U would run)
//   miningHintFacts(mine, refine): { asteroidOutOfRange; refinable }
//     — from `Mining.status('mine')` / `Mining.status('refine')`:
//       out of range = mine blocked for 'range'; refinable = refine 'ready'.
//   recordActionEnded(counts, { kind, ok }): HintCounts
//     — a COMPLETED refine (`action:ended`, kind 'refine', ok) counts once;
//       an abort, a refused completion or a repair returns `counts` itself.
//   recordApproach(counts, { wasApproaching, approaching }): HintCounts
//     — the frame the autopilot starts an approach (its goal becomes
//       'approach') counts once; any other frame returns `counts` itself.
// ---------------------------------------------------------------------------

type StatusLike = { readonly kind: 'ready' | 'running' } | { readonly kind: 'blocked'; readonly reason: string };
const hintsV5 = hintRules as unknown as {
  miningHintFacts?: (mine: StatusLike, refine: StatusLike) => { asteroidOutOfRange: boolean; refinable: boolean };
  recordActionEnded?: (counts: HintCounts, e: { readonly kind: 'refine' | 'repair'; readonly ok: boolean }) => HintCounts;
  recordApproach?: (counts: HintCounts, e: { readonly wasApproaching: boolean; readonly approaching: boolean }) => HintCounts;
};
function fn<K extends keyof typeof hintsV5>(name: K): NonNullable<(typeof hintsV5)[K]> {
  expect(typeof hintsV5[name], `hintRules exports ${name}`).toBe('function');
  return hintsV5[name]!;
}
const TEXT = HINT_TEXT as Readonly<Record<string, string>>;
const RETIRE = HINT_RETIRE_AFTER as Readonly<Record<string, number>>;
/** A state with the new fields (cast: they are not on HintState yet). */
const st = (extra: Partial<HintState> & { asteroidOutOfRange?: boolean; refinable?: boolean }): HintState =>
  ({ ...base, ...extra }) as HintState;
/** Every hint used enough, except the ones named. */
const allUsedBut = (...ids: string[]): HintCounts => {
  const c: Record<string, number> = { ...(allUsed as Record<string, number>), approach: 2, refine: 2 };
  for (const id of ids) c[id] = 0;
  return c as HintCounts;
};
const outOfRange = { hasTarget: true, asteroidOutOfRange: true };

describe("plan 5 Task 8 — the 'approach' lesson (L — APPROACH)", () => {
  it('Given its text, Then it reads "L — APPROACH", and L is the key bound to the autopilot', () => {
    expect(TEXT.approach).toBe('L — APPROACH');
    expect(actionForKey('KeyL')).toBe('land');
  });

  it('Given an asteroid targeted out of range, Then the hint is approach — ahead of the curriculum, even for a new pilot', () => {
    expect(selectHint(st(outOfRange), none)).toBe('approach');
    expect(selectHint(st(outOfRange), { fly: 3 })).toBe('approach');
    expect(selectHint(st(outOfRange), allUsedBut('approach'))).toBe('approach');
  });

  it('Given no asteroid out of range (false or the field omitted), Then approach is never advised', () => {
    expect(selectHint(st({ hasTarget: true, asteroidOutOfRange: false }), allUsedBut('approach'))).toBeNull();
    expect(selectHint(st({ hasTarget: true }), allUsedBut('approach'))).toBeNull();
    expect(selectHint(st({ asteroidOutOfRange: false }), none)).toBe('fly');
  });

  it('Given an asteroid out of range, When the pointer is free, an overlay or pause is up or a jump runs, Then those win as they do over every lesson', () => {
    expect(selectHint(st({ ...outOfRange, pointerLocked: false }), none)).toBe('click');
    expect(selectHint(st({ ...outOfRange, overlayOpen: true }), none)).toBeNull();
    expect(selectHint(st({ ...outOfRange, paused: true }), none)).toBeNull();
    expect(selectHint(st({ ...outOfRange, busy: true }), none)).toBeNull();
  });

  it('Given it retires after 2 uses, When used once, Then it is still advised; twice, Then the next lesson shows', () => {
    expect(RETIRE.approach).toBe(2);
    expect(selectHint(st(outOfRange), { ...allUsedBut('approach'), approach: 1 } as HintCounts)).toBe('approach');
    expect(isRetired({ approach: 2 } as HintCounts, 'approach' as never)).toBe(true);
    expect(selectHint(st(outOfRange), { approach: 2 } as HintCounts)).toBe('fly');
  });

  it('Given the autopilot, When it starts an approach (not approaching → approaching), Then that counts once; every other frame returns the counts untouched', () => {
    const recordApproach = fn('recordApproach');
    let c: HintCounts = { fly: 3 };
    c = recordApproach(c, { wasApproaching: false, approaching: true });
    expect(c).toEqual({ fly: 3, approach: 1 });
    for (const e of [
      { wasApproaching: true, approaching: true }, // still flying it
      { wasApproaching: true, approaching: false }, // parked or broken off
      { wasApproaching: false, approaching: false }, // L refused, or a landing
    ]) {
      expect(recordApproach(c, e), JSON.stringify(e)).toBe(c);
    }
    const before = { ...c };
    c = recordApproach(c, { wasApproaching: false, approaching: true });
    expect(before).toEqual({ fly: 3, approach: 1 }); // a new object, the old one left alone
    expect(isRetired(c, 'approach' as never)).toBe(true);
  });
});

describe("plan 5 Task 8 — the 'refine' lesson (U — REFINE)", () => {
  const refinable = { refinable: true };

  it('Given its text, Then it names the refine key: "U — REFINE"', () => {
    expect(TEXT.refine).toBe(`${MINING_KEYS.refine.replace(/^Key/, '')} — REFINE`);
    expect(TEXT.refine).toBe('U — REFINE');
  });

  it('Given ice in the hold and room in the tank, Then the hint is refine — ahead of the curriculum, even for a new pilot', () => {
    expect(selectHint(st(refinable), none)).toBe('refine');
    expect(selectHint(st(refinable), allUsedBut('refine'))).toBe('refine');
  });

  it('Given nothing to refine (false or the field omitted), Then refine is never advised', () => {
    expect(selectHint(st({ refinable: false }), allUsedBut('refine'))).toBeNull();
    expect(selectHint(st({}), allUsedBut('refine'))).toBeNull();
    expect(selectHint(st({ refinable: false }), none)).toBe('fly');
  });

  it('Given ice to refine, When the pointer is free, an overlay or pause is up or a jump runs, Then those win as they do over every lesson', () => {
    expect(selectHint(st({ ...refinable, pointerLocked: false }), none)).toBe('click');
    expect(selectHint(st({ ...refinable, overlayOpen: true }), none)).toBeNull();
    expect(selectHint(st({ ...refinable, paused: true }), none)).toBeNull();
    expect(selectHint(st({ ...refinable, busy: true }), none)).toBeNull();
  });

  it('Given it retires after 2 uses, When used once, Then it is still advised; twice, Then the next lesson shows', () => {
    expect(RETIRE.refine).toBe(2);
    expect(selectHint(st(refinable), { ...allUsedBut('refine'), refine: 1 } as HintCounts)).toBe('refine');
    expect(isRetired({ refine: 2 } as HintCounts, 'refine' as never)).toBe(true);
    expect(selectHint(st(refinable), { refine: 2 } as HintCounts)).toBe('fly');
  });

  it('Given action:ended events, Then a completed refine counts once; an aborted or refused one, or a repair, returns the counts untouched', () => {
    const recordActionEnded = fn('recordActionEnded');
    let c: HintCounts = { fly: 3 };
    c = recordActionEnded(c, { kind: 'refine', ok: true });
    expect(c).toEqual({ fly: 3, refine: 1 });
    expect(recordActionEnded(c, { kind: 'refine', ok: false })).toBe(c);
    expect(recordActionEnded(c, { kind: 'repair', ok: true })).toBe(c);
    expect(recordActionEnded(c, { kind: 'repair', ok: false })).toBe(c);
    const before = { ...c };
    c = recordActionEnded(c, { kind: 'refine', ok: true });
    expect(before).toEqual({ fly: 3, refine: 1 });
    expect(isRetired(c, 'refine' as never)).toBe(true);
  });
});

describe('plan 5 Task 8 — the order on the line: emergency, click, mine, approach, refine, the rest', () => {
  const everything = { hasTarget: true, asteroidInRange: true, asteroidOutOfRange: true, refinable: true };

  it('Given an emergency line and every lesson wanted, Then the emergency line shows', () => {
    expect(advisoryText(st(everything), none, 'EMERGENCY · H')).toBe('EMERGENCY · H');
    expect(advisoryText(st({ ...everything, pointerLocked: false }), none, 'EMERGENCY · H')).toBe('EMERGENCY · H');
  });

  it('Given no emergency and the pointer free, Then click outranks mine, approach and refine', () => {
    expect(selectHint(st({ ...everything, pointerLocked: false }), none)).toBe('click');
  });

  it('Given mine, approach and refine all wanted, Then mine; mine learnt, Then approach; approach learnt too, Then refine; all three learnt, Then the rest', () => {
    let c: HintCounts = {};
    expect(selectHint(st(everything), c)).toBe('mine');
    c = { ...c, mine: 2 };
    expect(selectHint(st(everything), c)).toBe('approach');
    c = { ...c, approach: 2 } as HintCounts;
    expect(selectHint(st(everything), c)).toBe('refine');
    c = { ...c, refine: 2 } as HintCounts;
    expect(selectHint(st(everything), c)).toBe('fly');
  });

  it('Given an asteroid out of range and ice to refine, Then approach shows before refine', () => {
    expect(selectHint(st({ hasTarget: true, asteroidOutOfRange: true, refinable: true }), none)).toBe('approach');
    expect(advisoryText(st({ hasTarget: true, asteroidOutOfRange: true, refinable: true }), none, null)).toBe('L — APPROACH');
  });

  it('Given an asteroid in range and ice to refine, Then mine shows before refine', () => {
    expect(selectHint(st({ hasTarget: true, asteroidInRange: true, refinable: true }), none)).toBe('mine');
  });

  it('Given every hint retired, approach and refine included, Then the line is empty', () => {
    expect(selectHint(st(everything), allUsedBut())).toBeNull();
  });
});

describe('plan 5 Task 8 — the facts come from Mining.status', () => {
  const ready: StatusLike = { kind: 'ready' };
  const running: StatusLike = { kind: 'running' };
  const blocked = (reason: string): StatusLike => ({ kind: 'blocked', reason });

  it("Given the mine row blocked as OUT OF RANGE, Then an asteroid is out of range; any other mine state, Then it is not", () => {
    const facts = fn('miningHintFacts');
    expect(facts(blocked('range'), ready).asteroidOutOfRange).toBe(true);
    for (const s of [ready, running, blocked('no-target'), blocked('speed'), blocked('hold-full'), blocked('depleted'), blocked('busy'), blocked('cruise'), blocked('jump'), blocked('no-tank')]) {
      expect(facts(s, ready).asteroidOutOfRange, JSON.stringify(s)).toBe(false);
    }
  });

  it('Given the refine row ready, Then there is ice to refine; NO ICE, TANK FULL, no tank, running or otherwise blocked, Then there is not', () => {
    const facts = fn('miningHintFacts');
    expect(facts(blocked('no-target'), ready).refinable).toBe(true);
    for (const s of [running, blocked('nothing-to-refine'), blocked('tank-full'), blocked('no-tank'), blocked('busy'), blocked('cruise'), blocked('jump')]) {
      expect(facts(blocked('no-target'), s).refinable, JSON.stringify(s)).toBe(false);
    }
  });
});

describe('plan 5 Task 8 — the counts keep approach and refine', () => {
  it('Given saved counts with approach and refine, When reloaded, Then they round-trip like every other hint', () => {
    let saved = '';
    const store = { getItem: () => saved, setItem: (_k: string, v: string) => void (saved = v) };
    saveHintCounts(store, { approach: 1, refine: 2, mine: 2 } as HintCounts);
    expect(loadHintCounts(store)).toEqual({ approach: 1, refine: 2, mine: 2 });
  });

  it('Given hostile stored values for approach and refine, Then they are dropped like any other bad count', () => {
    const store = { getItem: () => JSON.stringify({ approach: -1, refine: 'x' }), setItem: () => undefined };
    expect(loadHintCounts(store)).toEqual({});
  });
});

describe('plan 5 Task 8 — Hints.ts wires the two lessons', () => {
  const read = (rel: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), 'utf8');

  it('Given Hints.ts, Then it reads the facts from Mining.status through miningHintFacts and hands both to the advisory', () => {
    const src = read('Hints.ts');
    expect(src).toMatch(/miningHintFacts\(/);
    expect(src).toMatch(/status\(\s*'mine'\s*\)/);
    expect(src).toMatch(/status\(\s*'refine'\s*\)/);
    expect(src).toMatch(/asteroidOutOfRange/);
    expect(src).toMatch(/refinable/);
  });

  it("Given Hints.ts, Then a completed refine is counted on 'action:ended' and a started approach through recordApproach", () => {
    const src = read('Hints.ts');
    expect(src).toMatch(/bus\.on\(\s*'action:ended'[\s\S]{0,200}recordActionEnded\(/);
    expect(src).toMatch(/recordApproach\(/);
  });

  it('Given registry.ts, Then Hints is handed the autopilot (whose goal says an approach started)', () => {
    const src = read('../game/registry.ts');
    expect(src).toMatch(/new Hints\(\{[^}]*\bautopilot\b[^}]*\}\)/);
  });
});
