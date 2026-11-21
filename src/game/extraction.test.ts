/**
 * v4 sub-plan 5, Task 1 (phase A) — extraction as rules. An extraction takes
 * one resource and stops when it runs out: it accrues kilograms at a fixed
 * rate, hands them out in bites, and ends with one of nine reasons, each with
 * its own log line. Pure: no three.js, no bus.
 */

import { describe, expect, it } from 'vitest';

import type { Resource } from '@/gen/belt';
import {
  MINE_BITE_KG,
  MINE_RATE_KG_S,
  accrue,
  commitBite,
  extractionLog,
  nextBiteKg,
  shownKg,
  startExtraction,
  type Extraction,
  type ExtractionEnd,
} from '@/game/extraction';
import { MINE_MIN_KG } from '@/game/miningRules';

const fresh = (): Extraction => startExtraction('ast-1', 'ice');

/**
 * Accrue `dt` for `steps` steps, draining every due bite after each step the
 * way a frame would. Tracks hold space and rock remainder itself.
 */
function run(
  steps: number,
  dt: number,
  holdFreeKg: number,
  remainingKg: number,
): { e: Extraction; bites: number[]; mined: number; free: number; left: number } {
  const e = fresh();
  const bites: number[] = [];
  let free = holdFreeKg;
  let left = remainingKg;
  for (let i = 0; i < steps; i++) {
    accrue(e, dt);
    let kg: number;
    while ((kg = nextBiteKg(e, free, left)) > 0) {
      commitBite(e, kg);
      bites.push(kg);
      free -= kg;
      left -= kg;
    }
  }
  return { e, bites, mined: e.minedKg, free, left };
}

describe('the constants (pinned, from the plan)', () => {
  it('Given the plan, Then 150 kg/s and bites of 250 kg', () => {
    expect(MINE_RATE_KG_S).toBe(150);
    expect(MINE_BITE_KG).toBe(250);
  });
});

describe('startExtraction', () => {
  it('Given an asteroid and a resource, Then nothing mined and nothing carried', () => {
    expect(startExtraction('ast-7', 'rare')).toEqual({
      asteroidId: 'ast-7',
      resource: 'rare',
      minedKg: 0,
      carryKg: 0,
    });
  });
});

describe('accrue', () => {
  it('Given an empty carry, When 2 s pass, Then carryKg is 300 (150 kg/s)', () => {
    const e = fresh();
    accrue(e, 2);
    expect(e.carryKg).toBe(300);
  });

  it('Given accruals, Then they add up on carryKg and never touch minedKg', () => {
    const e = fresh();
    accrue(e, 1);
    accrue(e, 0.5);
    expect(e.carryKg).toBe(225);
    expect(e.minedKg).toBe(0);
  });

  it('Given negative seconds, Then they count as 0', () => {
    const e = fresh();
    accrue(e, 1);
    accrue(e, -5);
    expect(e.carryKg).toBe(150);
  });

  it('Given NaN seconds, Then they count as 0 (carryKg stays a number)', () => {
    const e = fresh();
    accrue(e, 1);
    accrue(e, Number.NaN);
    expect(e.carryKg).toBe(150);
  });

  // Plan 5, Task 3 (Task 1 review, P1): an infinite frame must not make carryKg infinite.
  it('Given infinite seconds, Then they count as 0 (carryKg stays finite and unchanged)', () => {
    const e = fresh();
    accrue(e, 1);
    accrue(e, Number.POSITIVE_INFINITY);
    expect(e.carryKg).toBe(150);
    expect(Number.isFinite(e.carryKg)).toBe(true);
  });
});

describe('commitBite', () => {
  it('Given a carry of 400 kg, When a bite of 250 kg is committed, Then minedKg +250 and carryKg -250', () => {
    const e = fresh();
    accrue(e, 400 / 150);
    commitBite(e, 250);
    expect(e.minedKg).toBe(250);
    expect(e.carryKg).toBeCloseTo(150, 9);
  });

  it('Given two bites, Then minedKg is their sum and carryKg what is left', () => {
    const e = fresh();
    accrue(e, 600 / 150);
    commitBite(e, 250);
    commitBite(e, 100);
    expect(e.minedKg).toBe(350);
    expect(e.carryKg).toBeCloseTo(250, 9);
  });
});

describe('nextBiteKg — pace', () => {
  it('Given an empty hold and a rock of 2 000 kg ice, When 10/6 s have accrued, Then exactly one bite of 250 kg is due', () => {
    const e = fresh();
    accrue(e, 10 / 6);
    expect(nextBiteKg(e, 8_000, 2_000)).toBe(250);
    commitBite(e, 250);
    expect(nextBiteKg(e, 7_750, 1_750)).toBe(0);
  });

  it('Given just under 250 kg carried, Then no bite is due yet', () => {
    const e = fresh();
    accrue(e, 249 / 150);
    expect(nextBiteKg(e, 8_000, 2_000)).toBe(0);
  });

  it('Given 13.34 s in steps of 1/60 s, Then 8 bites of 250 kg are taken, 2 000 kg in all', () => {
    // 13.34 s is 800.4 steps of 1/60 s, so 801 steps cover it.
    const r = run(801, 1 / 60, 8_000, 2_000);
    expect(r.bites).toEqual([250, 250, 250, 250, 250, 250, 250, 250]);
    expect(r.mined).toBe(2_000);
    expect(r.left).toBe(0);
  });

  it('Given a nothing-left rock after the eighth bite, Then more time yields no more bites', () => {
    const r = run(1_200, 1 / 60, 8_000, 2_000);
    expect(r.mined).toBe(2_000);
    expect(r.bites).toHaveLength(8);
  });
});

describe('nextBiteKg — several bites in one frame', () => {
  it('Given one accrue of 3.4 s, Then two bites of 250 kg are due and carryKg is then 10', () => {
    const e = fresh();
    accrue(e, 3.4);
    let free = 8_000;
    let left = 2_000;
    const bites: number[] = [];
    let kg: number;
    while ((kg = nextBiteKg(e, free, left)) > 0) {
      commitBite(e, kg);
      bites.push(kg);
      free -= kg;
      left -= kg;
    }
    expect(bites).toEqual([250, 250]);
    expect(e.carryKg).toBeCloseTo(10, 9);
  });
});

describe('nextBiteKg — the last bite is smaller', () => {
  it('Given 100 kg left in the resource, Then the bite is 100 kg and falls due at carryKg >= 100', () => {
    const e = fresh();
    accrue(e, 99 / 150);
    expect(nextBiteKg(e, 8_000, 100)).toBe(0);
    accrue(e, 1 / 150);
    expect(nextBiteKg(e, 8_000, 100)).toBe(100);
  });

  it('Given 300 kg of room, Then the bites are 250 and then 50', () => {
    const e = fresh();
    accrue(e, 400 / 150);
    expect(nextBiteKg(e, 300, 2_000)).toBe(250);
    commitBite(e, 250);
    expect(nextBiteKg(e, 50, 1_750)).toBe(50);
  });

  it('Given room and rest both under 250 kg, Then the smaller of them sets the bite', () => {
    const e = fresh();
    accrue(e, 400 / 150);
    expect(nextBiteKg(e, 120, 80)).toBe(80);
    expect(nextBiteKg(e, 60, 80)).toBe(60);
  });
});

describe('nextBiteKg — dust', () => {
  it('Given room under 0.5 kg, Then no bite, however much is carried', () => {
    const e = fresh();
    accrue(e, 100);
    expect(nextBiteKg(e, 0.4, 2_000)).toBe(0);
    expect(nextBiteKg(e, 0, 2_000)).toBe(0);
  });

  it('Given rest under 0.5 kg, Then no bite, however much is carried', () => {
    const e = fresh();
    accrue(e, 100);
    expect(nextBiteKg(e, 8_000, 0.4)).toBe(0);
    expect(nextBiteKg(e, 8_000, 0)).toBe(0);
  });

  it('Given exactly MINE_MIN_KG of room or rest, Then a bite of 0.5 kg once 0.5 kg is carried (inclusive)', () => {
    const e = fresh();
    accrue(e, MINE_MIN_KG / 150);
    expect(nextBiteKg(e, MINE_MIN_KG, 2_000)).toBe(MINE_MIN_KG);
    expect(nextBiteKg(e, 8_000, MINE_MIN_KG)).toBe(MINE_MIN_KG);
  });

  it('Given nothing carried yet, Then no bite', () => {
    expect(nextBiteKg(fresh(), 8_000, 2_000)).toBe(0);
  });
});

describe('nextBiteKg — never over', () => {
  const cases: readonly { dt: number; steps: number; free: number; rest: number }[] = [
    { dt: 1 / 60, steps: 3_000, free: 1_300, rest: 5_000 },
    { dt: 1 / 6, steps: 300, free: 8_000, rest: 1_100 },
    { dt: 3.33, steps: 40, free: 777, rest: 777 },
    { dt: 1 / 60, steps: 3_000, free: 250.3, rest: 9_000 },
    { dt: 3.33, steps: 40, free: 10_000, rest: 100 },
  ];
  for (const c of cases) {
    it(`Given steps of ${c.dt} s, room ${c.free} kg and rest ${c.rest} kg, Then the bites never sum past the smaller`, () => {
      const r = run(c.steps, c.dt, c.free, c.rest);
      const cap = Math.min(c.free, c.rest);
      expect(r.mined).toBeLessThanOrEqual(cap);
      expect(r.free).toBeGreaterThanOrEqual(0);
      expect(r.left).toBeGreaterThanOrEqual(0);
    });
  }

  it('Given plenty of time, Then the whole of the smaller limit is taken, bar dust', () => {
    const r = run(3_000, 1 / 60, 1_300, 5_000);
    expect(r.mined).toBe(1_300);
  });
});

describe('shownKg', () => {
  it('Given a fresh extraction, Then 0', () => {
    expect(shownKg(fresh(), 8_000, 2_000)).toBe(0);
  });

  it('Given time passing inside one bite, Then it grows steadily', () => {
    const e = fresh();
    let prev = shownKg(e, 8_000, 2_000);
    for (let i = 0; i < 99; i++) {
      accrue(e, 1 / 60);
      const now = shownKg(e, 8_000, 2_000);
      expect(now).toBeGreaterThan(prev);
      prev = now;
    }
    expect(prev).toBeCloseTo(MINE_RATE_KG_S * (99 / 60), 6);
  });

  it('Given a bite just committed with nothing left over, Then it equals minedKg', () => {
    const e = fresh();
    accrue(e, 10 / 6);
    commitBite(e, nextBiteKg(e, 8_000, 2_000));
    expect(shownKg(e, 7_750, 1_750)).toBeCloseTo(e.minedKg, 6);
    expect(e.minedKg).toBe(250);
  });

  it('Given a long run in steps, Then it never decreases and never passes minedKg plus the next bite', () => {
    const e = fresh();
    let free = 8_000;
    let left = 2_000;
    let prev = 0;
    for (let i = 0; i < 1_000; i++) {
      accrue(e, 1 / 60);
      const s = shownKg(e, free, left);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(s).toBeLessThanOrEqual(e.minedKg + Math.min(MINE_BITE_KG, free, left) + 1e-9);
      prev = s;
      let kg: number;
      while ((kg = nextBiteKg(e, free, left)) > 0) {
        commitBite(e, kg);
        free -= kg;
        left -= kg;
      }
    }
  });

  it('Given a lot carried but only 100 kg of rest, Then it stops at minedKg + 100', () => {
    const e = fresh();
    accrue(e, 10);
    expect(shownKg(e, 8_000, 100)).toBe(100);
    expect(shownKg(e, 60, 8_000)).toBe(60);
  });

  it('Given dust-sized room or rest, Then it is just minedKg', () => {
    const e = fresh();
    accrue(e, 10);
    expect(shownKg(e, 0.4, 2_000)).toBe(0);
    expect(shownKg(e, 8_000, 0.4)).toBe(0);
  });
});

describe('extractionLog — ended by the mining itself', () => {
  it('Given stopped after 1 250 kg ice, Then "MINED · 1 250 KG ICE"', () => {
    expect(extractionLog('stopped', 1_250, 'ice')).toBe('MINED · 1 250 KG ICE');
  });

  it('Given a full hold after 2 000 kg ice, Then "MINED · 2 000 KG ICE — HOLD FULL"', () => {
    expect(extractionLog('hold-full', 2_000, 'ice')).toBe('MINED · 2 000 KG ICE — HOLD FULL');
  });

  it('Given the resource running out at 1 250 kg ice, Then "MINED · 1 250 KG ICE — ICE DEPLETED"', () => {
    expect(extractionLog('resource-depleted', 1_250, 'ice')).toBe('MINED · 1 250 KG ICE — ICE DEPLETED');
  });

  it('Given the rock running out at 500 kg silicate, Then "MINED · 500 KG SILICATE — DEPLETED"', () => {
    expect(extractionLog('rock-depleted', 500, 'silicate')).toBe('MINED · 500 KG SILICATE — DEPLETED');
  });

  it('Given resource-depleted of another resource, Then it names that resource', () => {
    expect(extractionLog('resource-depleted', 800, 'rare')).toBe('MINED · 800 KG RARE — RARE DEPLETED');
    expect(extractionLog('resource-depleted', 800, 'metal')).toBe('MINED · 800 KG METAL — METAL DEPLETED');
  });

  it('Given exactly 0.5 kg mined, Then it counts (inclusive) and the text says "1 KG"', () => {
    expect(extractionLog('stopped', 0.5, 'ice')).toBe('MINED · 1 KG ICE');
  });

  it('Given under 0.5 kg mined, Then "MINING STOPPED" for every one of the four, whatever the suffix would be', () => {
    for (const end of ['stopped', 'hold-full', 'resource-depleted', 'rock-depleted'] as const) {
      expect(extractionLog(end, 0, 'ice'), end).toBe('MINING STOPPED');
      expect(extractionLog(end, 0.49, 'ice'), end).toBe('MINING STOPPED');
    }
  });
});

describe('extractionLog — ended by a refusal', () => {
  it('Given range after 750 kg ice, Then "MINING STOPPED — OUT OF RANGE · 750 KG ICE"', () => {
    expect(extractionLog('range', 750, 'ice')).toBe('MINING STOPPED — OUT OF RANGE · 750 KG ICE');
  });

  it('Given speed with nothing mined, Then "MINING STOPPED — MATCH SPEED"', () => {
    expect(extractionLog('speed', 0, 'ice')).toBe('MINING STOPPED — MATCH SPEED');
  });

  it('Given speed after 1 500 kg metal, Then the amount follows', () => {
    expect(extractionLog('speed', 1_500, 'metal')).toBe('MINING STOPPED — MATCH SPEED · 1 500 KG METAL');
  });

  it('Given no-target, Then "MINING STOPPED — NO ASTEROID TARGETED", with the amount once 0.5 kg is mined', () => {
    expect(extractionLog('no-target', 0, 'ice')).toBe('MINING STOPPED — NO ASTEROID TARGETED');
    expect(extractionLog('no-target', 250, 'rare')).toBe('MINING STOPPED — NO ASTEROID TARGETED · 250 KG RARE');
  });

  it('Given a refusal with dust mined (under 0.5 kg), Then no amount is added', () => {
    expect(extractionLog('range', 0.49, 'ice')).toBe('MINING STOPPED — OUT OF RANGE');
  });
});

describe('extractionLog — busy and interrupted', () => {
  it('Given interrupted after 750 kg ice, Then "MINING STOPPED · 750 KG ICE"', () => {
    expect(extractionLog('interrupted', 750, 'ice')).toBe('MINING STOPPED · 750 KG ICE');
  });

  it('Given interrupted with nothing mined, Then "MINING STOPPED"', () => {
    expect(extractionLog('interrupted', 0, 'ice')).toBe('MINING STOPPED');
  });

  it('Given busy, Then "MINING STOPPED", with the amount once 0.5 kg is mined', () => {
    expect(extractionLog('busy', 0, 'ice')).toBe('MINING STOPPED');
    expect(extractionLog('busy', 2_000, 'silicate')).toBe('MINING STOPPED · 2 000 KG SILICATE');
  });
});

describe('extractionLog — the brief\'s seven examples', () => {
  const rows: readonly [ExtractionEnd, number, Resource, string][] = [
    ['stopped', 1_250, 'ice', 'MINED · 1 250 KG ICE'],
    ['hold-full', 2_000, 'ice', 'MINED · 2 000 KG ICE — HOLD FULL'],
    ['resource-depleted', 1_250, 'ice', 'MINED · 1 250 KG ICE — ICE DEPLETED'],
    ['rock-depleted', 500, 'silicate', 'MINED · 500 KG SILICATE — DEPLETED'],
    ['range', 750, 'ice', 'MINING STOPPED — OUT OF RANGE · 750 KG ICE'],
    ['speed', 0, 'ice', 'MINING STOPPED — MATCH SPEED'],
    ['interrupted', 0, 'ice', 'MINING STOPPED'],
  ];
  for (const [end, kg, res, text] of rows) {
    it(`Given ('${end}', ${kg}, '${res}'), Then "${text}"`, () => {
      expect(extractionLog(end, kg, res)).toBe(text);
    });
  }
});
