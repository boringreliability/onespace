/**
 * v3 T4 / PLAN G — SEE IN FLIGHT.
 *
 * A Yard button sends the player to `?mode=flight&ship=<link>`, and that exact
 * hull is spawned as the co-orbital contact beside them. The link is the same
 * whitelisted ship the Yard already shares; what is new is that a FLIGHT route
 * carrying a ship names a companion. Pinned to the generation: a hull from an
 * older generator is not this ship, and spawning a different one silently is
 * exactly the bug review-p2 found in the Yard.
 */

import { describe, expect, it } from 'vitest';
import { companionShip, parseRoute, seeInFlightSearch } from './Route';
import { SHIP_GENERATION_VERSION } from '@/gen/ships/types';

const GEN = `gen=${SHIP_GENERATION_VERSION}`;

describe('companionShip: a flight route with a ship names the companion', () => {
  it('Given ?mode=flight&ship=…&gen=current, Then the companion is exactly that ship', () => {
    const r = parseRoute(`?mode=flight&ship=5a17c0de&faction=kessler&role=freighter&size=medium&${GEN}`);
    expect(companionShip(r)).toEqual({ seed: 0x5a17c0de, factionId: 'kessler', role: 'freighter', sizeClass: 'medium' });
  });

  it('Given a yard route with a ship, Then there is no companion (the Yard shows it, flight does not spawn it)', () => {
    expect(companionShip(parseRoute(`?mode=yard&ship=1&${GEN}`))).toBeNull();
  });

  it('Given no mode at all (a bare ?ship=), Then there is no companion (only an explicit flight link spawns)', () => {
    expect(companionShip(parseRoute(`?ship=1&${GEN}`))).toBeNull();
  });

  it('Given a flight route without a ship, Then there is no companion', () => {
    expect(companionShip(parseRoute('?mode=flight'))).toBeNull();
  });

  it('Given an older or garbled generation, Then there is no companion (never a different hull under the same link)', () => {
    expect(companionShip(parseRoute('?mode=flight&ship=1&gen=0'))).toBeNull();
    expect(companionShip(parseRoute('?mode=flight&ship=1&gen=x'))).toBeNull();
  });

  it('Given hostile fields, Then they are dropped by the existing whitelist and the seed alone survives', () => {
    const c = companionShip(parseRoute(`?mode=flight&ship=ff&faction=%3Cscript%3E&role=dreadnought&${GEN}`));
    expect(c).toEqual({ seed: 0xff });
  });
});

describe('seeInFlightSearch: the Yard button’s URL', () => {
  const ship = { seed: 0x5a17c0de, factionId: 'kessler', role: 'freighter', sizeClass: 'medium' } as const;

  it('Given a Yard selection, Then the search is a flight route pinned to this generation', () => {
    const q = new URLSearchParams(seeInFlightSearch('', ship));
    expect(q.get('mode')).toBe('flight');
    expect(q.get('ship')).toBe('5a17c0de');
    expect(q.get('gen')).toBe(String(SHIP_GENERATION_VERSION));
  });

  it('Given the search, Then it round-trips to the same companion', () => {
    expect(companionShip(parseRoute(seeInFlightSearch('', ship)))).toEqual(ship);
  });

  it('Given developer overrides in the current URL (?tier, ?dpr, ?dev, ?seed), Then they survive', () => {
    const q = new URLSearchParams(seeInFlightSearch('?tier=high&dpr=1.5&seed=1a2b&dev&mode=yard&ship=2', ship));
    expect(q.get('tier')).toBe('high');
    expect(q.get('dpr')).toBe('1.5');
    expect(q.get('seed')).toBe('1a2b');
    expect(q.has('dev')).toBe(true);
    expect(q.get('mode')).toBe('flight');
    expect(q.get('ship')).toBe('5a17c0de');
  });
});
