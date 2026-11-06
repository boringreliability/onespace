/**
 * The Yard's catalogue: which faction / role / size combinations exist, and
 * how the controls step through them. Pure data over `families.ts`.
 */

import { describe, expect, it } from 'vitest';

import { FACTIONS, ROLE_IDS, roleById, tryFactionById } from '@/gen/ships/families';
import { parseRoute } from '@/core/Route';
import {
  DEFAULT_SELECTION,
  cycle,
  isLegal,
  legalize,
  nextSeed,
  prevSeed,
  rolesFor,
  selectionFromRoute,
  sizesFor,
  stepFaction,
  stepRole,
  stepSeed,
  stepSize,
  toRouteShip,
  toShipParams,
  withYardRoute,
  type YardSelection,
} from './catalog';

describe('catalog — legal combinations', () => {
  it('Given sillane, When its roles are listed, Then none of its neverBuilds roles is among them', () => {
    const sillane = tryFactionById('sillane')!;
    const roles = rolesFor('sillane');
    expect(roles.length).toBeGreaterThan(0);
    for (const r of sillane.neverBuilds) expect(roles).not.toContain(r);
  });

  it('Given every faction, When its roles are listed, Then they are in ROLE_IDS order and exclude only neverBuilds', () => {
    for (const f of FACTIONS) {
      const expected = ROLE_IDS.filter((r) => !f.neverBuilds.includes(r));
      expect(rolesFor(f.id)).toEqual(expected);
    }
  });

  it('Given an unknown faction, When its roles are listed, Then the list is empty', () => {
    expect(rolesFor('<script>')).toEqual([]);
  });

  it("Given tug, When its sizes are listed, Then they equal the role's own sizes", () => {
    expect(sizesFor('tug')).toEqual(roleById('tug').sizeClasses);
  });

  it('Given the default selection, Then it is legal', () => {
    expect(isLegal(DEFAULT_SELECTION)).toBe(true);
  });

  it('Given sillane with miner (never built), When legalized, Then the role is replaced by a legal one', () => {
    const s = legalize({ seed: 7, factionId: 'sillane', role: 'miner' });
    expect(s.factionId).toBe('sillane');
    expect(rolesFor('sillane')).toContain(s.role);
    expect(sizesFor(s.role)).toContain(s.sizeClass);
    expect(s.seed).toBe(7);
  });

  it('Given a role with a size it is never built in, When legalized, Then a legal size is chosen', () => {
    const tugSizes = sizesFor('tug');
    const illegal = (['shuttle', 'light', 'medium', 'heavy', 'capital', 'super-capital'] as const).find(
      (z) => !tugSizes.includes(z),
    );
    expect(illegal).toBeDefined();
    const s = legalize({ seed: 1, factionId: 'kessler', role: 'tug', sizeClass: illegal });
    expect(tugSizes).toContain(s.sizeClass);
  });

  it('Given a legal size that includes medium, When legalized without a size, Then medium is preferred', () => {
    expect(sizesFor('freighter')).toContain('medium');
    expect(legalize({ seed: 1, factionId: 'kessler', role: 'freighter' }).sizeClass).toBe('medium');
  });
});

describe('catalog — seeds', () => {
  it('Given seed 0xffffffff, When nextSeed, Then the result is 0', () => {
    expect(nextSeed(0xffffffff)).toBe(0);
  });

  it('Given seed 0, When prevSeed, Then the result is 0xffffffff', () => {
    expect(prevSeed(0)).toBe(0xffffffff);
  });

  it('Given any seed, When next then prev, Then it round-trips as an unsigned 32-bit value', () => {
    for (const s of [0, 1, 0x5a17c0de, 0x7fffffff, 0x80000000, 0xfffffffe]) {
      expect(prevSeed(nextSeed(s))).toBe(s);
      expect(nextSeed(s)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('catalog — stepping the controls', () => {
  it('Given a list, When cycling past the end, Then it wraps to the start (and back)', () => {
    expect(cycle(['a', 'b', 'c'], 'c', 1)).toBe('a');
    expect(cycle(['a', 'b', 'c'], 'a', -1)).toBe('c');
    expect(cycle(['a', 'b', 'c'], 'b', 1)).toBe('c');
  });

  it('Given a value not in the list, When cycling, Then the first (or last) item is returned', () => {
    expect(cycle(['a', 'b'], 'z', 1)).toBe('a');
    expect(cycle(['a', 'b'], 'z', -1)).toBe('b');
  });

  it('Given kessler freighter, When the faction steps to one that never builds the role, Then the role is legalized', () => {
    // Walk every faction in both directions from every legal role: every result must be legal.
    for (const f of FACTIONS) {
      for (const role of rolesFor(f.id)) {
        const s: YardSelection = legalize({ seed: 3, factionId: f.id, role });
        expect(isLegal(stepFaction(s, 1))).toBe(true);
        expect(isLegal(stepFaction(s, -1))).toBe(true);
      }
    }
  });

  it('Given a selection, When the role steps, Then it moves within the faction’s legal roles and keeps seed and faction', () => {
    const s = stepRole(DEFAULT_SELECTION, 1);
    const roles = rolesFor(DEFAULT_SELECTION.factionId);
    expect(s.role).toBe(roles[(roles.indexOf(DEFAULT_SELECTION.role) + 1) % roles.length]);
    expect(s.factionId).toBe(DEFAULT_SELECTION.factionId);
    expect(s.seed).toBe(DEFAULT_SELECTION.seed);
    expect(isLegal(s)).toBe(true);
  });

  it('Given a selection, When the size steps, Then it stays within the role’s sizes', () => {
    let s = DEFAULT_SELECTION;
    for (let i = 0; i < 10; i++) {
      s = stepSize(s, 1);
      expect(sizesFor(s.role)).toContain(s.sizeClass);
    }
  });

  it('Given a selection, When the seed steps, Then only the seed changes', () => {
    const s = stepSeed(DEFAULT_SELECTION, -1);
    expect(s).toEqual({ ...DEFAULT_SELECTION, seed: prevSeed(DEFAULT_SELECTION.seed) });
  });
});

describe('catalog — route and params', () => {
  it('Given no route ship, When a selection is made from it, Then it is the default', () => {
    expect(selectionFromRoute(undefined)).toEqual(DEFAULT_SELECTION);
  });

  it('Given a parsed yard URL, When a selection is made from it, Then every field is taken', () => {
    const r = parseRoute('?mode=yard&ship=c0ffee&faction=ossuary&role=salvager&size=heavy');
    const s = selectionFromRoute(r.ship);
    expect(s).toEqual({ seed: 0xc0ffee, factionId: 'ossuary', role: 'salvager', sizeClass: 'heavy' });
  });

  it('Given a route naming an illegal combination, When a selection is made, Then it is legalized, not rejected', () => {
    const r = parseRoute('?mode=yard&ship=1&faction=sillane&role=miner');
    expect(isLegal(selectionFromRoute(r.ship))).toBe(true);
  });

  it('Given a selection, When it becomes ShipParams and a RouteShip, Then the four fields carry over', () => {
    const p = toShipParams(DEFAULT_SELECTION);
    expect(p).toEqual({
      seed: DEFAULT_SELECTION.seed,
      factionId: DEFAULT_SELECTION.factionId,
      role: DEFAULT_SELECTION.role,
      sizeClass: DEFAULT_SELECTION.sizeClass,
    });
    expect(toRouteShip(DEFAULT_SELECTION)).toEqual(p);
  });

  it('Given a search with dev params, When the yard route is written in, Then dev params survive and the ship parses back', () => {
    const s = withYardRoute('?tier=low&dpr=1', DEFAULT_SELECTION);
    const q = new URLSearchParams(s);
    expect(q.get('tier')).toBe('low');
    expect(q.get('dpr')).toBe('1');
    const r = parseRoute(s);
    expect(r.mode).toBe('yard');
    expect(selectionFromRoute(r.ship)).toEqual(DEFAULT_SELECTION);
  });

  it('Given a yard search, When the route is cleared (null), Then every yard field is gone and the rest stays', () => {
    const s = withYardRoute('?mode=yard&ship=1&faction=kessler&role=tug&size=medium&gen=1&tier=high', null);
    const q = new URLSearchParams(s);
    for (const k of ['mode', 'ship', 'faction', 'role', 'size', 'gen']) expect(q.has(k)).toBe(false);
    expect(q.get('tier')).toBe('high');
  });

  it('Given an empty search, When the route is cleared, Then the result is the empty string', () => {
    expect(withYardRoute('', null)).toBe('');
  });
});
