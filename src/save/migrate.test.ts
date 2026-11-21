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

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import golden from './fixtures/v1-golden.json';
import legacy from './fixtures/v0-legacy-log.json';
import { legacyLogToV1, migrate } from './migrate';
import { replay, zeroState } from './replay';
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
  it('Given the golden v1 save, Then migrate lifts it to format 2 (beamResource ice, nothing else changed), from format 1', () => {
    const r = migrate(goldenCopy());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migratedFrom).toBe(1);
    expect(r.save).toEqual({ ...golden, format: 2, ship: { ...golden.ship, beamResource: 'ice' } });
    expect(JSON.parse(JSON.stringify(r.save))).toEqual({ ...golden, format: 2, ship: { ...golden.ship, beamResource: 'ice' } });
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
  it('Given format 99, Then newer-build, and the raw save is handed back untouched for the caller to keep', () => {
    const raw = { ...goldenCopy(), format: 99 };
    const before = structuredClone(raw);
    const r = migrate(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('newer-build');
    expect(r.issues.join('\n')).toContain('99');
    expect(raw).toEqual(before);
  });
});

describe('migrate — a v1 save from a newer build is named, not just "invalid" (R4)', () => {
  // Policy: ANY change to the v1 shape — an added optional field included —
  // needs a new format number and an UPGRADES step. So a format-1 save whose
  // only fault is fields this build does not know was written by a newer build.
  const extras: Array<{ what: string; key: string; mutate: (s: Record<string, unknown> & SaveV1) => void }> = [
    { what: 'an extra top-level field', key: 'pets', mutate: (s) => (s.pets = []) },
    {
      what: 'an extra field inside ship',
      key: 'shields',
      mutate: (s) => ((s.ship as Record<string, unknown>).shields = 100),
    },
    {
      what: 'an extra field inside an action payload',
      key: 'note',
      mutate: (s) => ((s.actions[2]!.payload as Record<string, unknown>).note = 'x'),
    },
  ];

  for (const e of extras) {
    it(`Given a format-1 save with only ${e.what}, Then newer-build, the issues name the key, and the raw save is untouched`, () => {
      const s = goldenCopy() as Record<string, unknown> & SaveV1;
      e.mutate(s);
      const before = structuredClone(s);
      let r: ReturnType<typeof migrate> | undefined;
      expect(() => (r = migrate(s))).not.toThrow();
      expect(r!.ok).toBe(false);
      if (r!.ok) return;
      expect(r!.reason).toBe('newer-build');
      expect(r!.issues.some((i) => i.includes(e.key))).toBe(true);
      expect(s).toEqual(before);
    });
  }

  it('Given a format-1 save with an extra field AND a broken value (revision 0), Then invalid — not newer-build', () => {
    const s = goldenCopy() as Record<string, unknown> & SaveV1;
    s.pets = [];
    s.revision = 0;
    const r = migrate(s);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid');
    expect(hasPath(r.issues, 'revision')).toBe(true);
  });

  it('Given a format-1 save with an unknown enum value (not an extra key), Then invalid — not newer-build', () => {
    const s = goldenCopy();
    (s.world.entries[0] as { resource: string }).resource = 'gold';
    const r = migrate(s);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid');
  });
});

describe('migrate — the ids (P4)', () => {
  const ids: Array<{ what: string; path: string; mutate: (s: SaveV1) => void }> = [
    { what: 'a non-UUID saveId ("save-1")', path: 'saveId', mutate: (s) => (s.saveId = 'save-1') },
    { what: 'an empty saveId', path: 'saveId', mutate: (s) => (s.saveId = '') },
    { what: 'universeId gx-1:v2 (wrong version suffix)', path: 'universeId', mutate: (s) => (s.universeId = 'gx-1:v2') },
    {
      what: 'an upper-case universeId GX-1MWHJI:v1',
      path: 'universeId',
      mutate: (s) => (s.universeId = 'GX-1MWHJI:v1'),
    },
    {
      what: 'a universeId without the :v1 suffix',
      path: 'universeId',
      mutate: (s) => (s.universeId = 'gx-1mwhji'),
    },
    {
      what: 'a world from another universe (gx-2:v1 ≠ gx-1mwhji:v1)',
      path: 'world.universeId',
      mutate: (s) => (s.world.universeId = 'gx-2:v1'),
    },
  ];

  for (const b of ids) {
    it(`Given ${b.what}, Then invalid with the path ${b.path}`, () => {
      const s = goldenCopy();
      b.mutate(s);
      const r = migrate(s);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('invalid');
      expect(hasPath(r.issues, b.path)).toBe(true);
    });
  }
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

describe('migrate — messages and reasons pinned by mutation testing (Task 7)', () => {
  it('M1: Given null, [] or a string, When migrated, Then reason is invalid and issues is exactly the not-an-object message', () => {
    for (const raw of [null, [], 'save']) {
      const r = migrate(raw);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe('invalid');
      expect(r.issues).toEqual(['(root): not an object']);
    }
  });

  it('M2: Given format 1.5, When migrated, Then reason is invalid and the issue names format and integer', () => {
    const r = migrate({ ...goldenCopy(), format: 1.5 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid');
    expect(r.issues[0]!.startsWith('format:')).toBe(true);
    expect(r.issues[0]).toContain('integer');
  });

  it('M3: Given format 0 or -1, When migrated, Then reason is unknown-format with the "unknown format N" message', () => {
    for (const f of [0, -1]) {
      const r = migrate({ ...goldenCopy(), format: f });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe('unknown-format');
      expect(r.issues).toEqual([`format: unknown format ${f}`]);
    }
  });

  it('M4: Given an object whose format getter throws, When migrated, Then it does not throw and is invalid with the error message', () => {
    const o: Record<string, unknown> = {};
    Object.defineProperty(o, 'format', {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => migrate(o)).not.toThrow();
    const r = migrate(o);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid');
    expect(r.issues[0]).toBe('(root): boom');
  });

  it('M5: Given the golden save plus a top-level unknown key, When migrated, Then reason is newer-build and an issue is labelled (root)', () => {
    const r = migrate({ ...goldenCopy(), cheat: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('newer-build');
    expect(r.issues.some((i) => i.startsWith('(root):'))).toBe(true);
  });
});

// =============================================================================
// v4 sub-plan 6, Task 1 (phase A) — save format 2 and its upgrade.
//
// Assumed API (docs/v4/plan-6-resources.md, Task 1 Interfaces):
//   CURRENT_FORMAT = 2; UPGRADES[1] sets `format: 2` and `ship.beamResource:
//   'ice'` and changes nothing else; a format number ABOVE CURRENT_FORMAT is
//   `newer-build`, one below OLDEST_FORMAT still `unknown-format`.
// Review Focus 1: every format 1 fixture in src/save/fixtures/ (the golden
// save, and v1-long-checkpoint.json: a 1 001-entry log a format 1 build
// compacted to a checkpoint + 249 entries) comes out with the same hold, tank,
// capacity loss and world, and `migrate` never writes into its input.
// =============================================================================

type LooseSave = Record<string, unknown> & {
  format: unknown;
  ship: Record<string, unknown> & Omit<SaveV1['ship'], 'beamResource'>;
  actions: Array<{ source: string; payload: Record<string, unknown> }>;
  world: SaveV1['world'];
};

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Every fixture file that is a save claiming format 1 (the legacy logbook has no `format`). */
function formatOneFixtures(): Array<{ name: string; raw: LooseSave }> {
  return readdirSync(FIXTURE_DIR)
    .filter((n) => n.endsWith('.json'))
    .map((n) => ({ name: n, raw: JSON.parse(readFileSync(join(FIXTURE_DIR, n), 'utf8')) as LooseSave }))
    .filter((f) => f.raw.format === 1);
}

const JETTISON = {
  seq: 13,
  source: 'cargo',
  payload: {
    action: { kind: 'jettison', resource: 'ice', kg: 250 },
    result: { ok: true, kgIn: 0, kgOut: 250, fuelKg: 0, restoredFrac: 0 },
  },
  wallMs: 1762891300000,
  orbitSeconds: 5500,
};

/** The golden save written as format 2 (beam on metal, a jettison after its log). */
function goldenV2(): LooseSave {
  const s = goldenCopy() as unknown as LooseSave;
  s.format = 2;
  s.ship = { ...s.ship, beamResource: 'metal' };
  s.actions = [...s.actions, structuredClone(JETTISON)];
  return s;
}

describe('migrate — format 1 is lifted to format 2 (plan 6 task 1, Review Focus 1)', () => {
  it('Given the fixtures folder, Then it holds at least two format 1 saves, one with a checkpoint and a long log (the precondition of the upgrade tests)', () => {
    const fx = formatOneFixtures();
    expect(fx.map((f) => f.name).sort()).toEqual(expect.arrayContaining(['v1-golden.json', 'v1-long-checkpoint.json']));
    const long = fx.find((f) => f.name === 'v1-long-checkpoint.json')!.raw;
    expect(long.actions.length).toBeGreaterThanOrEqual(200);
    expect(long.actions[0]!.source).toBe('checkpoint');
    for (const f of fx) expect(SaveV1Schema.safeParse(f.raw).success, f.name).toBe(true);
  });

  for (const f of formatOneFixtures()) {
    describe(f.name, () => {
      it(`Given ${f.name} (format 1), When migrated, Then it is format 2, migratedFrom 1, beamResource "ice", and nothing else changed`, () => {
        const before = SaveV1Schema.parse(structuredClone(f.raw));
        const r = migrate(structuredClone(f.raw));
        expect(r.ok, r.ok ? '' : r.issues.join('; ')).toBe(true);
        if (!r.ok) return;
        expect(r.migratedFrom).toBe(1);
        const out = structuredClone(r.save) as unknown as LooseSave;
        expect(out.format).toBe(2);
        expect(out.ship.beamResource).toBe('ice');
        delete out.ship.beamResource;
        out.format = 1;
        expect(out).toEqual(before);
      });

      it(`Given ${f.name}, When migrated, Then hold, tank mass, capacity loss and world entries are exactly as before`, () => {
        const before = SaveV1Schema.parse(structuredClone(f.raw));
        const r = migrate(structuredClone(f.raw));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect((r.save as { format: unknown }).format, 'the save was lifted to format 2').toBe(2);
        expect(r.save.ship.cargo).toEqual(before.ship.cargo);
        expect(r.save.ship.propellant.massKg).toBe(before.ship.propellant.massKg);
        expect(r.save.ship.propellant.capacityLossFrac).toBe(before.ship.propellant.capacityLossFrac);
        expect(r.save.ship.emergencyTimesUsed).toBe(before.ship.emergencyTimesUsed);
        expect(r.save.world).toEqual(before.world);
      });

      it(`Given ${f.name}, When its log is replayed before and after the upgrade, Then the hold, tank, capacity loss and depletion are the same — no action was rewritten`, () => {
        const before = SaveV1Schema.parse(structuredClone(f.raw));
        const r = migrate(structuredClone(f.raw));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect((r.save as { format: unknown }).format, 'the save was lifted to format 2').toBe(2);
        expect(r.save.actions).toEqual(before.actions);
        const s0 = { ...zeroState(), tank: { ...before.ship.propellant } };
        const a = replay(s0, before.actions);
        const b = replay(s0, r.save.actions);
        expect(b.tank).toEqual(a.tank);
        expect(b.cargo).toEqual(a.cargo);
        expect(JSON.parse(JSON.stringify(b.depletion))).toEqual(JSON.parse(JSON.stringify(a.depletion)));
        expect(b.emergency).toEqual(a.emergency);
      });

      it(`Given ${f.name} deep-frozen, When migrated, Then migrate neither throws nor writes into its input, and the input still equals the file`, () => {
        const pristine = structuredClone(f.raw);
        const frozen = deepFreeze(structuredClone(f.raw));
        let r: ReturnType<typeof migrate> | undefined;
        expect(() => (r = migrate(frozen))).not.toThrow();
        expect(r!.ok, r!.ok ? '' : r!.issues.join('; ')).toBe(true);
        expect(r!.ok && (r!.save as { format: unknown }).format, 'the save was lifted to format 2').toBe(2);
        expect(frozen).toEqual(pristine);
        expect(frozen.format).toBe(1);
        expect('beamResource' in frozen.ship).toBe(false);
      });
    });
  }

  it('Given the long fixture, When migrated, Then its checkpoint is carried over unchanged and still leads the log', () => {
    const raw = formatOneFixtures().find((x) => x.name === 'v1-long-checkpoint.json')!.raw;
    const r = migrate(structuredClone(raw));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.save as { format: unknown }).format, 'the save was lifted to format 2').toBe(2);
    expect(r.save.actions[0]).toEqual(SaveV1Schema.parse(structuredClone(raw)).actions[0]);
    expect(r.save.actions[0]!.source).toBe('checkpoint');
  });
});

describe('migrate — format 2 itself (plan 6 task 1)', () => {
  it('Given a format 2 save with a jettison and beamResource "metal", When migrated, Then it comes back unchanged, migratedFrom 2', () => {
    const s = goldenV2();
    const r = migrate(structuredClone(s));
    expect(r.ok, r.ok ? '' : r.issues.join('; ')).toBe(true);
    if (!r.ok) return;
    expect(r.migratedFrom).toBe(2);
    expect(r.save).toEqual(s);
  });

  it('Given a format 2 save, When migrated twice (the result fed back in), Then it is a fixed point', () => {
    const r1 = migrate(goldenV2());
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = migrate(JSON.parse(JSON.stringify(r1.save)));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.save).toEqual(r1.save);
    expect(r2.migratedFrom).toBe(2);
  });

  it('Given a format 2 save with only an extra key, Then newer-build (R4 holds for the current format), and the raw save is untouched', () => {
    const s = { ...goldenV2(), pets: [] };
    const before = structuredClone(s);
    const r = migrate(s);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('newer-build');
    expect(r.issues.some((i) => i.includes('pets'))).toBe(true);
    expect(s).toEqual(before);
  });

  it('Given a format 2 save whose beamResource is "gold", Then invalid with the path ship.beamResource', () => {
    const s = goldenV2();
    s.ship.beamResource = 'gold';
    const r = migrate(s);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid');
    expect(hasPath(r.issues, 'ship.beamResource')).toBe(true);
  });
});

describe('migrate — the new action never stands in a format 1 save (plan 6 task 1, R4)', () => {
  // These pass today already (format 1 cannot hold either); they guard the
  // upgrade: lifting first and checking against format 2 would let both in.
  it('Given a save that says format 1 but holds a jettison entry, Then invalid — the upgrade does not make it valid', () => {
    const s = goldenCopy() as unknown as LooseSave;
    s.actions = [...s.actions, structuredClone(JETTISON)];
    const r = migrate(s);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid');
  });

  it('Given a save that says format 1 but carries ship.beamResource "rare", Then it is refused — the upgrade never overwrites it with "ice"', () => {
    const s = goldenCopy() as unknown as LooseSave;
    s.ship = { ...s.ship, beamResource: 'rare' };
    const r = migrate(s);
    expect(r.ok).toBe(false);
  });
});

describe('migrate — a save from a newer version is named as one (plan 6 task 1)', () => {
  for (const f of [3, 99]) {
    it(`Given format ${f}, Then newer-build (not unknown-format), the issue names ${f}, and the raw save is untouched`, () => {
      const raw = { ...goldenV2(), format: f };
      const before = structuredClone(raw);
      const r = migrate(raw);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('newer-build');
      expect(r.issues.join('\n')).toContain(String(f));
      expect(raw).toEqual(before);
    });
  }

  it('Given format 0 or -1 (below the oldest), Then still unknown-format', () => {
    for (const f of [0, -1]) {
      const r = migrate({ ...goldenCopy(), format: f });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe('unknown-format');
    }
  });

  it('Given format 3 with garbage inside (the content is never read), Then still newer-build', () => {
    const r = migrate({ format: 3, ship: 'whatever' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('newer-build');
  });
});

// =============================================================================
// v4 sub-plan 6 — review fix for I-1 (task-2-review.md): migrate is idempotent.
//
// A pending resolve (R69) stores its device body verbatim, and at a boot
// conflict that body IS the boot's migrated local. SyncClient compares it with
// the next boot's `migrate(raw)` after lifting it again (`lifted()`), so
// `migrate(migrate(x))` must be bit-for-bit `migrate(x)` — or the same game
// state counts as progress and the player meets the conflict screen again.
// The golden fixture's orientation [0.5, -0.5, 0.5, 0.5] normalises exactly
// and hid this: these tests use orientations that do not.
// =============================================================================

/** mulberry32: a tiny deterministic PRNG (no Math.random in tests). */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Quat4 = [number, number, number, number];

/** Orientations picked by hand: off-unit, tiny and huge (above QUAT_MIN_LENGTH 1e-9), negative, exact. */
const HAND_PICKED: Quat4[] = [
  [1, 2, 3, 4],
  [0.1, 0.2, 0.3, 0.4],
  [-1, -2, -3, -4],
  [0.3, -0.7, 0.2, -0.1],
  [1e-8, 2e-8, 3e-8, 4e-8],
  [3e-9, -4e-9, 5e-9, 1e-9],
  [1e8, -2e8, 3e8, -4e8],
  [1.5e300, -2e300, 1e300, 3e300],
  [0.5, -0.5, 0.5, 0.5], // the fixture's: exactly unit
  [0, 0, 0, 1],
  [0.6, 0.8, 0, 0],
  // normalise([1, 2, 3, 4]) — unit within an ulp, and dividing it by its length again changes it
  [0.18257418583505536, 0.3651483716701107, 0.5477225575051661, 0.7302967433402214],
  [1 + 2 * Number.EPSILON, 0, 0, 0],
  [1 - Number.EPSILON, 0, 0, 0],
];

/** 2 000 orientations from a fixed seed, components in [-1, 1) scaled by 10^[-6, 6). */
function sweep(n = 2_000, seed = 0x5eed): Quat4[] {
  const rnd = mulberry32(seed);
  const out: Quat4[] = [];
  while (out.length < n) {
    const scale = 10 ** (rnd() * 12 - 6);
    const q: Quat4 = [(rnd() * 2 - 1) * scale, (rnd() * 2 - 1) * scale, (rnd() * 2 - 1) * scale, (rnd() * 2 - 1) * scale];
    if (Math.hypot(...q) > 1e-8) out.push(q);
  }
  return out;
}

/** The golden save (format 1) with `q` as its orientation. */
function formatOneWith(q: Quat4): SaveV1 {
  const s = goldenCopy();
  s.player.flight.orientation = [...q];
  return s;
}

/** The golden save written as format 2 (beam on ice) with `q` as its orientation. */
function formatTwoWith(q: Quat4): LooseSave {
  const s = formatOneWith(q) as unknown as LooseSave;
  s.format = 2;
  s.ship = { ...s.ship, beamResource: 'ice' };
  return s;
}

/** The orientations for which `migrate(migrate(x)).save` is not deep-equal `migrate(x).save`. */
function notIdempotent(qs: Quat4[], make: (q: Quat4) => unknown): Array<{ q: Quat4; once: unknown; twice: unknown }> {
  const bad: Array<{ q: Quat4; once: unknown; twice: unknown }> = [];
  for (const q of qs) {
    const once = migrate(make(q));
    if (!once.ok) throw new Error(`migrate refused ${JSON.stringify(q)}: ${once.issues.join('; ')}`);
    // Fed back in as storage hands it back: through JSON (exact for doubles).
    const twice = migrate(JSON.parse(JSON.stringify(once.save)));
    if (!twice.ok) throw new Error(`migrate refused its own output for ${JSON.stringify(q)}: ${twice.issues.join('; ')}`);
    if (JSON.stringify(twice.save) !== JSON.stringify(once.save)) {
      bad.push({ q, once: once.save.player.flight.orientation, twice: twice.save.player.flight.orientation });
    }
  }
  return bad;
}

describe('Review fix I-1 (plan 6) — migrate is idempotent: a migrated save migrates to itself, bit for bit', () => {
  it('Given the deterministic sweep, Then it holds 2 000 orientations, all of them above the zero-length floor (the precondition of the sweep tests)', () => {
    const qs = sweep();
    expect(qs).toHaveLength(2_000);
    expect(qs.every((q) => Math.hypot(...q) > 1e-8)).toBe(true);
    // Deterministic: the same seed gives the same orientations.
    expect(sweep()).toEqual(qs);
  });

  it.each<[string, (q: Quat4) => unknown]>([
    ['format 2', formatTwoWith],
    ['format 1 (lifted on the first pass)', formatOneWith],
  ])(
    'Given a %s save with each hand-picked orientation (off-unit, tiny, huge, negative, exactly unit, unit within an ulp), When its migrated save is migrated again, Then the second result is deep-equal the first',
    (_fmt, make) => {
      expect(notIdempotent(HAND_PICKED, make)).toEqual([]);
    },
  );

  it.each<[string, (q: Quat4) => unknown]>([
    ['format 2', formatTwoWith],
    ['format 1 (lifted on the first pass)', formatOneWith],
  ])('Given a %s save with each of 2 000 seeded orientations, When its migrated save is migrated again, Then the second result is deep-equal the first for every one', (_fmt, make) => {
    const bad = notIdempotent(sweep(), make);
    expect(bad.length, `${bad.length} of 2 000 orientations change on the second pass; first: ${JSON.stringify(bad[0])}`).toBe(0);
  });

  it('Given a format 1 save with orientation [1, 2, 3, 4], When it is migrated, migrated again and a third time, Then all three results are deep-equal (a fixed point from the first pass on)', () => {
    const r1 = migrate(formatOneWith([1, 2, 3, 4]));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = migrate(JSON.parse(JSON.stringify(r1.save)));
    const r3 = r2.ok ? migrate(JSON.parse(JSON.stringify(r2.save))) : r2;
    expect(r2.ok && r3.ok).toBe(true);
    if (!r2.ok || !r3.ok) return;
    expect(r2.save).toEqual(r1.save);
    expect(r3.save).toEqual(r1.save);
    expect(r2.migratedFrom).toBe(2);
  });
});
