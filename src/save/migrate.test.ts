/**
 * Migration (v4 sub-plan 3, Task 1).
 *
 * `migrate` is the only door a stored save comes through. Two properties
 * matter more than the rest, and both are silent when broken: it must never
 * throw (a bad save on boot is a message, not a crash), and it must never
 * swallow what it cannot read — an unknown or broken save comes back as an
 * error the caller keeps (`onespace.save.corrupt.<wallMs>`), untouched.
 *
 * `legacyLogToV1` imports the pre-save logbook (`onespace.log.v1`,
 * `{version: 1, time, entries}`) once, into the first save.
 */

import { describe, expect, it } from 'vitest';

import golden from './fixtures/v1-golden.json';
import legacy from './fixtures/v0-legacy-log.json';
import { legacyLogToV1, migrate } from './migrate';
import { SaveV1Schema, type SaveV1 } from './schema';

function goldenCopy(): SaveV1 {
  return structuredClone(golden) as unknown as SaveV1;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/** `issues` carries `<dotted.path>: <message>` (array indices as segments). */
function hasPath(issues: string[], path: string): boolean {
  return issues.some((i) => i.startsWith(`${path}:`));
}

const ctx = {
  universeId: 'gx-1mwhji:v1',
  system: golden.player.system,
  now: { wallMs: 1762891200000, orbitSeconds: 0 },
};

describe('migrate — a v1 save', () => {
  it('Given the golden v1 save, Then migrate returns it unchanged, from format 1', () => {
    const r = migrate(goldenCopy());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migratedFrom).toBe(1);
    expect(r.save).toEqual(golden);
    expect(JSON.parse(JSON.stringify(r.save))).toEqual(golden);
  });

  it('Given a deep-frozen golden save, Then migrate neither throws nor needs to write into it', () => {
    const frozen = deepFreeze(goldenCopy());
    expect(() => migrate(frozen)).not.toThrow();
    expect(migrate(frozen).ok).toBe(true);
  });

  const breaks: Array<{ what: string; path: string; mutate: (s: SaveV1) => void }> = [
    { what: 'NaN mass', path: 'ship.propellant.massKg', mutate: (s) => (s.ship.propellant.massKg = Number.NaN) },
    { what: 'negative cargo', path: 'ship.cargo.ice', mutate: (s) => (s.ship.cargo.ice = -1) },
    {
      what: 'unknown resource',
      path: 'world.entries.0.resource',
      mutate: (s) => ((s.world.entries[0] as { resource: string }).resource = 'gold'),
    },
    {
      what: 'missing universeId',
      path: 'universeId',
      mutate: (s) => delete (s as Partial<SaveV1>).universeId,
    },
    { what: 'revision 0', path: 'revision', mutate: (s) => (s.revision = 0) },
    {
      what: 'quaternion of length 0',
      path: 'player.flight.orientation',
      mutate: (s) => (s.player.flight.orientation = [0, 0, 0, 0]),
    },
  ];

  for (const b of breaks) {
    it(`Given the golden save with ${b.what}, Then migrate reports invalid with the path ${b.path} and never throws`, () => {
      const s = goldenCopy();
      b.mutate(s);
      let r: ReturnType<typeof migrate> | undefined;
      expect(() => (r = migrate(s))).not.toThrow();
      expect(r!.ok).toBe(false);
      if (r!.ok) return;
      expect(r!.reason).toBe('invalid');
      expect(hasPath(r!.issues, b.path)).toBe(true);
    });
  }

  it('Given garbage (null, undefined, a string, a number, an array, {}), Then migrate reports not-ok and never throws', () => {
    for (const raw of [null, undefined, 'save', 42, [], {}]) {
      let r: ReturnType<typeof migrate> | undefined;
      expect(() => (r = migrate(raw))).not.toThrow();
      expect(r!.ok).toBe(false);
    }
  });
});

describe('migrate — an unknown format is never silently discarded', () => {
  it('Given format 99, Then unknown-format, and the raw save is handed back untouched for the caller to keep', () => {
    const raw = { ...goldenCopy(), format: 99 };
    const before = structuredClone(raw);
    const r = migrate(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unknown-format');
    expect(r.issues.join('\n')).toContain('99');
    expect(raw).toEqual(before);
  });
});

describe('legacyLogToV1 — the old localStorage logbook', () => {
  it('Given the legacy {version:1,time,entries} log, Then legacyLogToV1 yields the same entries and time', () => {
    const log = legacyLogToV1(structuredClone(legacy), ctx);
    expect(log).not.toBeNull();
    expect(log!.time).toBe(legacy.time);
    expect(log!.entries).toEqual(legacy.entries);
  });

  it('Given the imported legacy log placed into a save, Then the save is valid', () => {
    const s = goldenCopy();
    s.log = legacyLogToV1(structuredClone(legacy), ctx)!;
    expect(SaveV1Schema.safeParse(s).success).toBe(true);
  });

  it('Given a legacy log with no time (as ShipLog.load tolerated), Then time is 0 and the entries are kept', () => {
    const { time: _t, ...noTime } = structuredClone(legacy);
    const log = legacyLogToV1(noTime, ctx);
    expect(log).not.toBeNull();
    expect(log!.time).toBe(0);
    expect(log!.entries).toEqual(legacy.entries);
  });

  it('Given garbage (null, a string, version 2, entries not an array, an entry of an unknown kind), Then null and no throw', () => {
    const badKind = structuredClone(legacy);
    (badKind.entries[0] as { kind: string }).kind = 'treasure';
    const garbage: unknown[] = [
      null,
      undefined,
      'onespace.log.v1',
      { ...structuredClone(legacy), version: 2 },
      { version: 1, time: 3, entries: 'none' },
      badKind,
    ];
    for (const g of garbage) {
      expect(() => legacyLogToV1(g, ctx)).not.toThrow();
      expect(legacyLogToV1(g, ctx)).toBeNull();
    }
  });
});
