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

  it("Given a scan:complete with kind 'asteroid' (v4 sub-plan 2), Then it is filed once as a note under scan:<ast id>, not as a world or a contact", () => {
    const log = open();
    const rock: ScanResult = { targetId: 'ast:s1:398:4', name: 'asteroid 398-4', lines: ['ice ...... 4 200 kg'], kind: 'asteroid' };
    bus.emit('scan:complete', rock);
    bus.emit('scan:complete', rock);
    const notes = log.byKind('note');
    expect(notes.length).toBe(1);
    expect(notes[0]!.key).toBe('scan:ast:s1:398:4');
    expect(notes[0]!.visits).toBe(2);
    expect(log.byKind('world').length).toBe(0);
    expect(log.byKind('contact').length).toBe(0);
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

// ---------------------------------------------------------------------------
// Final whole-branch review, I3(a) — living assays. An asteroid's note is an
// assay, and an assay goes stale as the rock is mined: a re-scan REPLACES the
// body (keys `scan:ast:…`), keeps the first `at`, counts the visit, and is not
// announced as a new discovery. Every other kind keeps its first body.
// ---------------------------------------------------------------------------

describe('re-scanning an asteroid updates its assay (final review I3a)', () => {
  const rock = (left: number): ScanResult => ({
    targetId: 'ast:s1:398:4',
    name: 'asteroid 398-4',
    lines: [`ice ...... 4 200 kg · ${left} left`],
    kind: 'asteroid',
  });

  /** Every "LOGGED — …" line the log announces while `fn` runs. */
  function announced(fn: () => void): string[] {
    const texts: string[] = [];
    const off = bus.on('log', ({ text }) => {
      if (text.startsWith('LOGGED —')) texts.push(text);
    });
    fn();
    off();
    return texts;
  }

  it('Given an asteroid scanned, then mined and scanned again, Then its one note carries the NEW body, the FIRST at, and visits 2', () => {
    const log = open();
    log.update(100);
    bus.emit('scan:complete', rock(4_200));
    const at = log.byKind('note')[0]!.at;
    log.update(3_600);
    bus.emit('scan:complete', rock(2_200));
    const notes = log.byKind('note');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.key).toBe('scan:ast:s1:398:4');
    expect(notes[0]!.body).toEqual(['ice ...... 4 200 kg · 2200 left']);
    expect(notes[0]!.at).toBe(at);
    expect(notes[0]!.visits).toBe(2);
  });

  it('Given an asteroid re-scanned, Then only the first scan announces "LOGGED —"', () => {
    open();
    const texts = announced(() => {
      bus.emit('scan:complete', rock(4_200));
      bus.emit('scan:complete', rock(2_200));
      bus.emit('scan:complete', rock(200));
    });
    expect(texts).toEqual(['LOGGED — ASTEROID 398-4']);
  });

  it('Given an asteroid re-scanned, Then the new body is what a reload finds', () => {
    const log = open();
    bus.emit('scan:complete', rock(4_200));
    bus.emit('scan:complete', rock(2_200));
    log.dispose();
    const again = open();
    const note = again.byKind('note').find((e) => e.key === 'scan:ast:s1:398:4');
    expect(note?.body).toEqual(['ice ...... 4 200 kg · 2200 left']);
    expect(note?.visits).toBe(2);
  });

  it('Given an asteroid re-scanned, Then its note keeps its place in the log (not moved to the top)', () => {
    const log = open();
    bus.emit('scan:complete', rock(4_200));
    bus.emit('scan:complete', scan('p1', 'Ghent'));
    bus.emit('scan:complete', rock(2_200));
    expect(log.all().map((e) => e.key)).toEqual(['scan:p1', 'scan:ast:s1:398:4']);
  });

  it('Given a world scanned twice with different lines, Then it keeps its FIRST body (only asteroid assays are replaced)', () => {
    const log = open();
    bus.emit('scan:complete', { targetId: 'p1', name: 'Ghent', lines: ['class .......... rocky'] });
    bus.emit('scan:complete', { targetId: 'p1', name: 'Ghent', lines: ['class .......... ocean'] });
    const world = log.byKind('world')[0]!;
    expect(world.body).toEqual(['class .......... rocky']);
    expect(world.visits).toBe(2);
  });

  it('Given a hull scanned twice with different lines, Then it keeps its FIRST body', () => {
    const log = open();
    bus.emit('scan:complete', { targetId: 'h1', name: 'kestrel', lines: ['hauler'], kind: 'vessel' });
    bus.emit('scan:complete', { targetId: 'h1', name: 'kestrel', lines: ['courier'], kind: 'vessel' });
    expect(log.byKind('contact')[0]!.body).toEqual(['hauler']);
  });
});

describe('v4 save — export / import, sink and the legacy key', () => {
  const KEY = 'onespace.log.v1';

  /** A log with an arrival, a world and a landing (visited twice), and some mission time. */
  function played(): ShipLog {
    const log = open();
    bus.emit('system:entered', { system: system('s1', 'Fyss') });
    log.update(1234.5);
    bus.emit('scan:complete', scan('p1', 'Remit 31'));
    bus.emit('planet:landed', { planet: planet('p1', 'Remit 31') });
    bus.emit('planet:landed', { planet: planet('p1', 'Remit 31') });
    return log;
  }

  it('Given a played log, When exportState → importState into a fresh log, Then the state is identical', () => {
    const a = played();
    const s = a.exportState();
    expect(s.time).toBeCloseTo(1234.5, 9);
    expect(s.entries).toHaveLength(3);
    a.dispose();

    store.map.clear();
    const b = open();
    b.importState(s);
    expect(b.exportState()).toEqual(s);
    expect(b.all()).toEqual(a.all());
    expect(b.summary()).toEqual(a.summary());
  });

  it('Given an import, Then no log event is sent (no LOGGED line for what was already logged)', () => {
    const s = played().exportState();
    bus.clear();
    store.map.clear();
    const lines: string[] = [];
    bus.on('log', ({ text }) => lines.push(text));
    const b = open();
    b.importState(s);
    expect(lines).toEqual([]);
  });

  it('Given an imported log, When the same world is landed on again, Then it is a revisit (visits++), not a new entry', () => {
    const s = played().exportState();
    bus.clear();
    store.map.clear();
    const b = open();
    b.importState(s);
    bus.emit('planet:landed', { planet: planet('p1', 'Remit 31') });
    const landings = b.byKind('landing');
    expect(landings).toHaveLength(1);
    expect(landings[0]!.visits).toBe(3);
  });

  it('Given an export, Then it is a copy: recording afterwards does not change it', () => {
    const log = played();
    const s = log.exportState();
    bus.emit('system:entered', { system: system('s2', 'Ost') });
    expect(s.entries).toHaveLength(3);
  });

  it('Given a sink, When the log records, upserts or clears, Then every write goes to the sink and localStorage is untouched', () => {
    const log = open();
    const writes: Array<{ time: number; entries: readonly unknown[] }> = [];
    log.setSink((state) => writes.push(state));
    bus.emit('system:entered', { system: system('s1', 'Fyss') });
    bus.emit('scan:complete', { targetId: 'ast:x', name: 'rock', lines: ['ice 3 t'], kind: 'asteroid' });
    bus.emit('scan:complete', { targetId: 'ast:x', name: 'rock', lines: ['ice 1 t'], kind: 'asteroid' });
    log.clear();
    expect(store.map.has(KEY)).toBe(false);
    expect(writes.length).toBeGreaterThanOrEqual(4);
    expect(writes[0]!.entries).toHaveLength(1);
    expect(writes.at(-1)!.entries).toHaveLength(0);
  });

  it('Given a sink, When an import happens, Then localStorage is still untouched', () => {
    const s = played().exportState();
    store.map.clear();
    const b = open();
    b.setSink(() => undefined);
    b.importState(s);
    bus.emit('system:entered', { system: system('s9', 'Nine') });
    expect(store.map.has(KEY)).toBe(false);
  });

  it('Given the sink is removed (null), When the log records, Then it writes to localStorage again', () => {
    const log = open();
    log.setSink(() => undefined);
    log.setSink(null);
    bus.emit('system:entered', { system: system('s1', 'Fyss') });
    expect(store.map.has(KEY)).toBe(true);
  });

  it('Given an old onespace.log.v1, When legacyState() is read, Then it returns its time and entries and leaves the key in place', () => {
    const a = played();
    const expected = a.exportState();
    a.dispose();
    const raw = store.map.get(KEY);
    expect(raw).toBeDefined();

    bus.clear();
    const b = new ShipLog();
    const legacy = b.legacyState();
    expect(legacy).not.toBeNull();
    expect(legacy!.time).toBeCloseTo(expected.time, 9);
    expect(legacy!.entries).toEqual(expected.entries);
    expect(store.map.get(KEY)).toBe(raw);
  });

  it('Given no (or a corrupt, or a wrong-version) onespace.log.v1, Then legacyState() is null', () => {
    expect(new ShipLog().legacyState()).toBeNull();
    store.map.set(KEY, '{not json');
    expect(new ShipLog().legacyState()).toBeNull();
    store.map.set(KEY, JSON.stringify({ version: 99, time: 1, entries: [] }));
    expect(new ShipLog().legacyState()).toBeNull();
  });
});
