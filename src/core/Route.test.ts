/**
 * URL parameters. Every value is whitelisted: anything not recognised is
 * dropped, never passed through, so a crafted link cannot put arbitrary data
 * into the engine.
 */

import { describe, expect, it } from 'vitest';
import { bootPlan, newGameSearch, parseDevParams, parseRoute, seeInFlightSearch } from './Route';

describe('parseDevParams', () => {
  it('Given no query, Then nothing is overridden', () => {
    expect(parseDevParams('')).toEqual({});
  });

  it('Given ?tier=low, Then the tier is low', () => {
    expect(parseDevParams('?tier=low')).toEqual({ tier: 'low' });
  });

  it('Given every real tier, Then each is accepted', () => {
    for (const t of ['low', 'medium', 'high', 'ultra'] as const) {
      expect(parseDevParams(`?tier=${t}`).tier).toBe(t);
    }
  });

  it('Given an unknown or hostile tier, Then it is dropped', () => {
    for (const bad of ['potato', 'HIGH', '<script>', '', 'high;drop']) {
      expect(parseDevParams(`?tier=${encodeURIComponent(bad)}`).tier).toBeUndefined();
    }
  });

  it('Given ?dpr=1 or ?dpr=0.5, Then it is taken', () => {
    expect(parseDevParams('?dpr=1').dpr).toBe(1);
    expect(parseDevParams('?dpr=0.5').dpr).toBe(0.5);
  });

  it('Given a dpr that is not a sane positive number, Then it is dropped', () => {
    for (const bad of ['abc', '-1', '0', '9', 'NaN', 'Infinity', '1e3', '']) {
      expect(parseDevParams(`?dpr=${bad}`).dpr).toBeUndefined();
    }
  });

  it('Given both and some noise, Then both are taken and the noise ignored', () => {
    expect(parseDevParams('?foo=bar&tier=medium&dpr=1.25&x')).toEqual({
      tier: 'medium',
      dpr: 1.25,
    });
  });

  // --- review-p0: the range check hid a loose regex --------------------------
  // Every one of these parses with Number() to a value inside (0, 3], so only
  // the strict-decimal pattern stands between them and the engine.

  it('Given dpr written with an exponent, a sign, a space or a bare dot, Then it is dropped', () => {
    for (const bad of ['1e0', '2e-1', '1.5E0', '%2B1', '+1', '%201', '1.', '.5', '0x1', '1%20']) {
      expect(parseDevParams(`?dpr=${bad}`).dpr, bad).toBeUndefined();
    }
  });

  it('Given ?dpr=3, Then the inclusive upper bound is taken; just over, Then it is dropped', () => {
    expect(parseDevParams('?dpr=3').dpr).toBe(3);
    expect(parseDevParams('?dpr=3.01').dpr).toBeUndefined();
  });
});

// =============================================================================
// v4 sub-plan 3 (local save), Task 6 — `?new=1` and what a boot starts.
//
//  - `?new=1` is a new route key, whitelisted like the rest: exactly `1` sets
//    `route.newGame = true`; any other value is dropped with a warning.
//  - `bootPlan(route, hasSave)` → `{ mode, start }`: which mode to boot into
//    (as main.ts decided before: flight and yard from a link, else the title)
//    and whether the boot CONTINUES the save or starts a NEW game. A save is
//    continued unless `?new=1` says otherwise; `?mode=flight` with a save
//    continues it.
//  - `newGameSearch(search)`: where a confirmed NEW GAME goes — a reload into
//    a new game in flight (`new=1&mode=flight`), keeping only the developer
//    overrides (tier, dpr, seed, dev) as SEE IN FLIGHT does.
// =============================================================================

describe('parseRoute — ?new (v4 Task 6)', () => {
  it('Given ?new=1, Then the route asks for a new game, with no warning', () => {
    const r = parseRoute('?new=1');
    expect(r.newGame).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('Given ?new with any other value, Then it is dropped with a warning (whitelist: exactly 1)', () => {
    for (const bad of ['0', 'true', 'yes', '', '11', '1;drop', '%3Cscript%3E']) {
      const r = parseRoute(`?new=${bad}`);
      expect(r.newGame, bad).toBeUndefined();
      expect(r.warnings.length, bad).toBe(1);
    }
  });

  it('Given no ?new, Then the route says nothing about a new game', () => {
    expect(parseRoute('?mode=flight').newGame).toBeUndefined();
    expect(parseRoute('')).toEqual({ warnings: [] });
  });

  it('Given SEE IN FLIGHT from a URL that carries ?new=1, Then the new link does not carry it (never start a new game from a ship link)', () => {
    const out = new URLSearchParams(seeInFlightSearch('?new=1&tier=low', { seed: 1 }));
    expect(out.has('new')).toBe(false);
    expect(out.get('tier')).toBe('low');
  });
});

describe('bootPlan (v4 Task 6)', () => {
  const plan = (search: string, hasSave: boolean) => bootPlan(parseRoute(search), hasSave);

  it('Given ?mode=flight and a save, Then flight, continuing the save', () => {
    expect(plan('?mode=flight', true)).toEqual({ mode: 'flight', start: 'continue' });
  });

  it('Given ?mode=flight and no save, Then flight in a new game', () => {
    expect(plan('?mode=flight', false)).toEqual({ mode: 'flight', start: 'new' });
  });

  it('Given ?mode=flight&new=1 and a save, Then flight in a new game (the save is not continued)', () => {
    expect(plan('?mode=flight&new=1', true)).toEqual({ mode: 'flight', start: 'new' });
  });

  it('Given no query and a save, Then the title over the saved world (CONTINUE)', () => {
    expect(plan('', true)).toEqual({ mode: 'title', start: 'continue' });
  });

  it('Given no query and no save, Then the title over a new game', () => {
    expect(plan('', false)).toEqual({ mode: 'title', start: 'new' });
  });

  it('Given ?new=1 alone and a save, Then the title over a new game', () => {
    expect(plan('?new=1', true)).toEqual({ mode: 'title', start: 'new' });
  });

  it('Given ?mode=yard and a save, Then the Yard, the save continued behind it', () => {
    expect(plan('?mode=yard', true)).toEqual({ mode: 'yard', start: 'continue' });
  });

  it('Given ?mode=map or ?mode=review, Then the title as before (not boot targets for a player)', () => {
    expect(plan('?mode=map', true)).toEqual({ mode: 'title', start: 'continue' });
    expect(plan('?mode=review', false)).toEqual({ mode: 'title', start: 'new' });
  });
});

describe('newGameSearch (v4 Task 6)', () => {
  it('Given a plain URL, Then a confirmed NEW GAME reloads into ?new=1&mode=flight', () => {
    const r = parseRoute(newGameSearch(''));
    expect(r.newGame).toBe(true);
    expect(r.mode).toBe('flight');
  });

  it('Given developer overrides and a ship link, Then only tier, dpr, seed and dev are kept', () => {
    const out = new URLSearchParams(
      newGameSearch('?tier=low&dpr=1&seed=1a2b&dev&mode=yard&ship=5a17&faction=kessler&foo=bar'),
    );
    expect(Object.fromEntries(out)).toEqual({ tier: 'low', dpr: '1', seed: '1a2b', dev: '', new: '1', mode: 'flight' });
  });
});

