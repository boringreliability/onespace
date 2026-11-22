/**
 * The mode machine. v1 had no modes: seven modules each asked a global
 * `shotOwnsScene()` flag, a separate `Universe.paused` existed beside it, and
 * all seventeen modules ticked every frame — including while the showroom was
 * up. One machine, one table of legal transitions, tested here.
 */

import { describe, expect, it } from 'vitest';
import { ModeMachine, type BaseMode, type Mode } from './Modes';

describe('ModeMachine', () => {
  it('Given a fresh machine, Then it starts in boot with no overlay', () => {
    const m = new ModeMachine();
    expect(m.current).toBe('boot');
    expect(m.base).toBe('boot');
    expect(m.overlay).toBe(null);
  });

  it('Given title, When go(flight), Then current is flight and listeners hear (title, flight)', () => {
    const m = new ModeMachine('title');
    const heard: Array<[Mode, Mode]> = [];
    m.onChange((from, to) => heard.push([from, to]));
    m.go('flight');
    expect(m.current).toBe('flight');
    expect(heard).toEqual([['title', 'flight']]);
  });

  it('Given map, When go(yard) which is not a legal transition, Then it throws and stays in map', () => {
    const m = new ModeMachine('map');
    expect(m.can('yard')).toBe(false);
    expect(() => m.go('yard')).toThrow();
    expect(m.current).toBe('map');
  });

  it('Given the same mode, When go(it), Then it is a silent no-op', () => {
    const m = new ModeMachine('flight');
    let n = 0;
    m.onChange(() => n++);
    m.go('flight');
    expect(n).toBe(0);
  });

  it('Given yard, When push(photo) then pop(), Then it is back in yard after exactly two events', () => {
    const m = new ModeMachine('yard');
    const heard: Array<[Mode, Mode]> = [];
    m.onChange((from, to) => heard.push([from, to]));
    m.push('photo');
    expect(m.current).toBe('photo');
    expect(m.base).toBe('yard');
    expect(m.overlay).toBe('photo');
    m.pop();
    expect(m.current).toBe('yard');
    expect(m.overlay).toBe(null);
    expect(heard).toEqual([
      ['yard', 'photo'],
      ['photo', 'yard'],
    ]);
  });

  it('Given an overlay already up, When push(photo) again, Then it throws', () => {
    const m = new ModeMachine('flight');
    m.push('photo');
    expect(() => m.push('photo')).toThrow();
  });

  it('Given an overlay is up, When go() is called, Then it throws — pop first', () => {
    const m = new ModeMachine('flight');
    m.push('photo');
    expect(() => m.go('map')).toThrow();
  });

  it('Given no overlay, When pop(), Then it throws', () => {
    expect(() => new ModeMachine('flight').pop()).toThrow();
  });

  it('Given a base mode that cannot host an overlay (map, title, boot), When push(photo), Then it throws', () => {
    for (const base of ['map', 'title', 'boot'] as const) {
      expect(() => new ModeMachine(base).push('photo')).toThrow();
    }
  });

  it('Given photo is overlay-only, When go(photo), Then it throws', () => {
    expect(() => new ModeMachine('flight').go('photo')).toThrow();
  });

  it('Given an unsubscribed listener, Then it hears nothing further', () => {
    const m = new ModeMachine('title');
    let n = 0;
    const off = m.onChange(() => n++);
    off();
    m.go('flight');
    expect(n).toBe(0);
  });

  it('Given the transition table, Then every non-boot mode can eventually reach flight', () => {
    // A mode with no way back to flight is a soft-lock.
    for (const start of ['title', 'map', 'yard', 'review'] as const) {
      const m = new ModeMachine(start);
      expect(m.can('flight')).toBe(true);
    }
  });
});

// v4 sub-plan 6, Task 4 (phase A) — the resources screen is a base mode
// (DESIGN-6 §7.1; plan 6 Task 4): flight ↔ resources only, plus review (a
// review shot can be taken from it, and clearing the shot hands it back). Time
// stands still in it like the Yard; no overlay sits on it. `'resources'` is
// not in `Mode` yet: it is spelled through a cast so the type check stays clean.
describe('ModeMachine — the resources screen (plan 6 task 4)', () => {
  const RES = 'resources' as string as Mode;
  const RES_BASE = 'resources' as string as BaseMode;

  it('Given flight, When go(resources) and then go(flight), Then both are legal and listeners hear both', () => {
    const m = new ModeMachine('flight');
    const heard: Array<[Mode, Mode]> = [];
    m.onChange((from, to) => heard.push([from, to]));
    expect(m.can(RES)).toBe(true);
    m.go(RES);
    expect(m.base).toBe(RES);
    expect(m.can('flight')).toBe(true);
    m.go('flight');
    expect(heard).toEqual([
      ['flight', RES],
      [RES, 'flight'],
    ]);
  });

  it('Given resources, When go(review), Then it is legal; and review can hand resources back', () => {
    const m = new ModeMachine(RES_BASE);
    expect(m.can('review')).toBe(true);
    m.go('review');
    expect(m.can(RES)).toBe(true);
    m.go(RES);
    expect(m.base).toBe(RES);
  });

  for (const from of ['map', 'yard', 'title', 'boot'] as const) {
    it(`Given ${from}, When go(resources), Then it throws and stays in ${from} (the screen opens from flight only)`, () => {
      const m = new ModeMachine(from);
      expect(m.can(RES)).toBe(false);
      expect(() => m.go(RES)).toThrow();
      expect(m.base).toBe(from);
    });
  }

  for (const to of ['map', 'yard', 'title', 'boot'] as const) {
    it(`Given resources, When go(${to}), Then it throws (back to flight first)`, () => {
      const m = new ModeMachine(RES_BASE);
      expect(m.can(to)).toBe(false);
      expect(() => m.go(to)).toThrow();
      expect(m.base).toBe(RES);
    });
  }

  it('Given resources, When push(photo), Then it throws: no overlay on the screen', () => {
    const m = new ModeMachine(RES_BASE);
    expect(() => m.push('photo')).toThrow();
    expect(m.overlay).toBe(null);
  });

  it('Given a photo overlay on flight, When go(resources), Then it throws (pop first)', () => {
    const m = new ModeMachine('flight');
    m.push('photo');
    expect(m.can(RES)).toBe(false);
    expect(() => m.go(RES)).toThrow();
  });

  it('Given resources, Then it can reach flight (no soft-lock)', () => {
    expect(new ModeMachine(RES_BASE).can('flight')).toBe(true);
  });
});
