/**
 * The ship's log.
 *
 * Two properties here are worth more than the rest put together, and both are
 * silent when broken: revisiting a world must not duplicate its entry, and the
 * log must survive a reload. A duplicated entry looks like a feature until the
 * list is a hundred copies of the same moon; a log that fails to persist looks
 * exactly like a log the player never wrote in.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '@/core/EventBus';
import { ShipLog } from './Log';
import type { PlanetSpec, ScanResult, StarSystemSpec } from '@/gen/types';

/** A localStorage that behaves like the real one, including throwing when full. */
class MemoryStorage {
  map = new Map<string, string>();
  full = false;
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.full) throw new Error('QuotaExceededError');
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

let store: MemoryStorage;

beforeEach(() => {
  store = new MemoryStorage();
  vi.stubGlobal('localStorage', store);
  bus.clear();
});

/** Only the fields the log reads. The log must not need more than this. */
function system(id: string, name: string): StarSystemSpec {
  return {
    id,
    name,
    stars: [{ spectralClass: 'K' }],
    planets: [{}, {}],
    blurb: 'a quiet place nobody charted twice',
  } as unknown as StarSystemSpec;
}

function planet(id: string, name: string): PlanetSpec {
  return { id, name, type: 'rocky', gravity: 4.2, blurb: 'dust and old light' } as PlanetSpec;
}

function scan(targetId: string, name: string, kind?: 'world' | 'vessel'): ScanResult {
  return { targetId, name, lines: ['class .......... rocky'], kind };
}

function open(): ShipLog {
  const log = new ShipLog();
  log.init();
  return log;
}

describe('recording', () => {
  it('starts empty', () => {
    expect(open().all()).toEqual([]);
  });

  it('records a system on arrival', () => {
    const log = open();
    bus.emit('system:entered', { system: system('s1', 'Vess Anhur') });
    const all = log.all();
    expect(all.length).toBe(1);
    expect(all[0]!.title).toBe('Vess Anhur');
    expect(all[0]!.kind).toBe('arrival');
  });

  it('records a scanned world under the system it was scanned in', () => {
    const log = open();
    bus.emit('system:entered', { system: system('s1', 'Vess Anhur') });
    bus.emit('scan:complete', scan('p1', 'Vess Anhur ii'));
    const world = log.byKind('world')[0]!;
    expect(world.title).toBe('Vess Anhur ii');
    expect(world.system).toBe('Vess Anhur');
  });

  it('files a scanned hull as a contact, not as a world', () => {
    const log = open();
    bus.emit('scan:complete', scan('h1', 'kestrel', 'vessel'));
    expect(log.byKind('contact').length).toBe(1);
    expect(log.byKind('world').length).toBe(0);
  });

  it('treats a scan with no kind as a world', () => {
    // The showroom fixtures predate the field. They must not become contacts.
    const log = open();
    bus.emit('scan:complete', scan('p1', 'somewhere'));
    expect(log.byKind('world').length).toBe(1);
  });

  it('records a landing separately from the scan of the same world', () => {
    const log = open();
    bus.emit('scan:complete', scan('p1', 'Ghent'));
    bus.emit('planet:landed', { planet: planet('p1', 'Ghent') });
    expect(log.byKind('world').length).toBe(1);
    expect(log.byKind('landing').length).toBe(1);
  });

  it('keeps the entries newest first', () => {
    const log = open();
    bus.emit('scan:complete', scan('a', 'first'));
    bus.emit('scan:complete', scan('b', 'second'));
    expect(log.all().map((e) => e.title)).toEqual(['second', 'first']);
  });
});

describe('revisiting', () => {
  it('does not duplicate a world scanned twice', () => {
    const log = open();
    bus.emit('scan:complete', scan('p1', 'Ghent'));
    bus.emit('scan:complete', scan('p1', 'Ghent'));
    bus.emit('scan:complete', scan('p1', 'Ghent'));
    expect(log.all().length).toBe(1);
  });

  it('counts the visits instead', () => {
    const log = open();
    bus.emit('scan:complete', scan('p1', 'Ghent'));
    bus.emit('scan:complete', scan('p1', 'Ghent'));
    expect(log.all()[0]!.visits).toBe(2);
  });

  it('keeps the timestamp of the first visit', () => {
    const log = open();
    bus.emit('scan:complete', scan('p1', 'Ghent'));
    const first = log.all()[0]!.at;
    log.update(3600);
    bus.emit('scan:complete', scan('p1', 'Ghent'));
    expect(log.all()[0]!.at).toBe(first);
  });

  it('does not reorder an entry when it is revisited', () => {
    // A revisit that jumped to the top would make the log a recency list, and
    // the point of a log is the order things were found in.
    const log = open();
    bus.emit('scan:complete', scan('a', 'first'));
    bus.emit('scan:complete', scan('b', 'second'));
    bus.emit('scan:complete', scan('a', 'first'));
    expect(log.all().map((e) => e.title)).toEqual(['second', 'first']);
  });
});

describe('summary', () => {
  it('counts each kind', () => {
    const log = open();
    bus.emit('system:entered', { system: system('s1', 'A') });
    bus.emit('scan:complete', scan('p1', 'w1'));
    bus.emit('scan:complete', scan('p2', 'w2'));
    bus.emit('scan:complete', scan('h1', 'hull', 'vessel'));
    bus.emit('planet:landed', { planet: planet('p1', 'w1') });
    expect(log.summary()).toEqual({
      systems: 1,
      worlds: 2,
      landings: 1,
      contacts: 1,
      entries: 5,
    });
  });
});

describe('persistence', () => {
  it('survives a reload', () => {
    const a = open();
    bus.emit('system:entered', { system: system('s1', 'Vess Anhur') });
    bus.emit('scan:complete', scan('p1', 'Ghent'));

    bus.clear();
    const b = open();
    expect(b.all().map((e) => e.title)).toEqual(['Ghent', 'Vess Anhur']);
    expect(a.summary()).toEqual(b.summary());
  });

  it('carries mission time across the reload', () => {
    const a = open();
    a.update(7200);
    bus.emit('scan:complete', scan('p1', 'Ghent'));
    const stamp = a.stampOf(a.all()[0]!);

    bus.clear();
    const b = open();
    expect(b.stampOf(b.all()[0]!)).toBe(stamp);
  });

  it('does not re-announce every entry when it loads', () => {
    const a = open();
    bus.emit('scan:complete', scan('p1', 'Ghent'));
    bus.emit('scan:complete', scan('p2', 'Sarn'));

    bus.clear();
    const announced: string[] = [];
    bus.on('log', ({ text }) => announced.push(text));
    open();
    expect(announced).toEqual([]);
  });

  it('starts clean rather than throwing on corrupt storage', () => {
    store.map.set('onespace.log.v1', '{not json at all');
    expect(() => open()).not.toThrow();
    expect(open().all()).toEqual([]);
  });

  it('ignores a log written by an incompatible version', () => {
    store.map.set('onespace.log.v1', JSON.stringify({ version: 99, entries: [{ key: 'x' }] }));
    expect(open().all()).toEqual([]);
  });

  it('keeps working when storage refuses to write', () => {
    // A full quota must never break the frame loop; the universe regenerates
    // without the log, and losing the log is better than losing the game.
    const log = open();
    store.full = true;
    expect(() => bus.emit('scan:complete', scan('p1', 'Ghent'))).not.toThrow();
    expect(log.all().length).toBe(1);
  });
});

describe('lifecycle', () => {
  it('stops recording once disposed', () => {
    const log = open();
    log.dispose();
    bus.emit('scan:complete', scan('p1', 'Ghent'));
    expect(log.all()).toEqual([]);
  });
});
