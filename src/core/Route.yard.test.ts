/**
 * The game route: which mode to boot into, which ship to show, which universe.
 * Whitelisted like the dev params — a link can only name things that exist.
 */

import { describe, expect, it } from 'vitest';
import { parseRoute, serializeRoute, type Route } from './Route';
import { SHIP_GENERATION_VERSION } from '@/gen/ships/types';

describe('parseRoute', () => {
  it('Given no query, Then the route is empty (default boot)', () => {
    expect(parseRoute('')).toEqual({ warnings: [] });
  });

  it('Given a full yard URL, Then it yields the ship params exactly', () => {
    const r = parseRoute('?mode=yard&ship=5a17c0de&faction=kessler&role=freighter&size=medium');
    expect(r.mode).toBe('yard');
    expect(r.ship).toEqual({ seed: 0x5a17c0de, factionId: 'kessler', role: 'freighter', sizeClass: 'medium' });
    expect(r.warnings).toEqual([]);
  });

  it('Given a hostile or unknown faction or role, Then the field is dropped with a warning', () => {
    const r = parseRoute('?mode=yard&ship=1&faction=%3Cscript%3E&role=dreadnought');
    expect(r.ship).toEqual({ seed: 1 });
    expect(r.warnings.length).toBe(2);
  });

  it('Given a seed that is not 1-8 hex digits, Then no ship seed is taken', () => {
    for (const bad of ['zz', '1ffffffff', '', '-1', '0x12', '12 34']) {
      const r = parseRoute(`?mode=yard&ship=${encodeURIComponent(bad)}`);
      expect(r.ship).toBeUndefined();
    }
  });

  it('Given an unknown mode, Then it is dropped (boot decides)', () => {
    expect(parseRoute('?mode=godmode').mode).toBeUndefined();
    expect(parseRoute('?mode=photo').mode).toBeUndefined(); // overlay-only, never a boot target
  });

  it('Given ?seed= for the universe, Then it is parsed as hex', () => {
    expect(parseRoute('?seed=1a2b3c4d').universeSeed).toBe(0x1a2b3c4d);
    expect(parseRoute('?seed=nope').universeSeed).toBeUndefined();
  });

  it('Given gen equal to the current version, Then the ship is not stale', () => {
    expect(parseRoute(`?mode=yard&ship=1&gen=${SHIP_GENERATION_VERSION}`).staleGeneration).toBe(false);
  });

  it('Given an older gen, Then staleGeneration is true', () => {
    expect(parseRoute('?mode=yard&ship=1&gen=0').staleGeneration).toBe(true);
  });

  it('Given a gen from a future build or not a number, Then the ship is flagged as not this standard (never silently re-pinned)', () => {
    // review-p2: gen=999999999 and gen=x were treated as current and the Yard
    // rewrote the link to the current version — a different ship, unflagged.
    expect(parseRoute('?mode=yard&ship=1&gen=999999999').staleGeneration).toBe(true);
    expect(parseRoute(`?mode=yard&ship=1&gen=${SHIP_GENERATION_VERSION + 1}`).staleGeneration).toBe(true);
    const bad = parseRoute('?mode=yard&ship=1&gen=x');
    expect(bad.staleGeneration).toBe(true);
    expect(bad.warnings.length).toBe(1);
  });

  it('Given no gen at all (a hand-typed link), Then it is taken as current', () => {
    expect(parseRoute('?mode=yard&ship=1').staleGeneration).toBe(false);
  });

  it('Given ?shot=name, Then the shot name is passed through only if it is a plain identifier', () => {
    expect(parseRoute('?shot=ship-hero-close').shot).toBe('ship-hero-close');
    expect(parseRoute('?shot=%3Cimg%3E').shot).toBeUndefined();
  });

  it('Given ?dev, Then dev is on', () => {
    expect(parseRoute('?dev').dev).toBe(true);
    expect(parseRoute('').dev).toBeUndefined();
  });
});

describe('serializeRoute', () => {
  it('Given a valid route, Then parse(serialize(r)) round-trips', () => {
    const r: Route = {
      mode: 'yard',
      ship: { seed: 0xdeadbeef, factionId: 'sillane', role: 'survey', sizeClass: 'light' },
      universeSeed: 0x1234,
      warnings: [],
    };
    const back = parseRoute(serializeRoute(r));
    expect(back.mode).toBe(r.mode);
    expect(back.ship).toEqual(r.ship);
    expect(back.universeSeed).toBe(r.universeSeed);
    expect(back.staleGeneration).toBe(false);
  });

  it('Given a ship, Then the serialised link pins the current generation version', () => {
    const s = serializeRoute({ mode: 'yard', ship: { seed: 1 }, warnings: [] });
    expect(s).toContain(`gen=${SHIP_GENERATION_VERSION}`);
  });
});
