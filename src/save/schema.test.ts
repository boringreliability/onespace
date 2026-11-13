/**
 * The save format, v1 (v4 sub-plan 3, Task 1).
 *
 * A save is the one thing in a seeded universe that cannot be regenerated, so
 * its shape is a whitelist: every field named, every number finite, nothing
 * extra let through. The golden fixture is built from the real opening — Fyss,
 * parked at Remit 31 — and real action shapes (`propellant:action`,
 * `cargo:action`, `emergency:used`, `recordMined`, aggregated thrust).
 */

import { describe, expect, it } from 'vitest';

import golden from './fixtures/v1-golden.json';
import { ActionEntrySchema, CURRENT_FORMAT, SaveV1Schema, type SaveV1 } from './schema';

/** A fresh, mutable copy of the golden save for each test. */
function goldenCopy(): SaveV1 {
  return structuredClone(golden) as unknown as SaveV1;
}

describe('SaveV1Schema — the golden save', () => {
  it('Given the current format constant, Then it is 1', () => {
    expect(CURRENT_FORMAT).toBe(1);
  });

  it('Given the golden v1 save, Then it parses and round-trips through JSON unchanged', () => {
    const parsed = SaveV1Schema.parse(goldenCopy());
    expect(parsed).toEqual(golden);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(golden);
    // And a second pass is a fixed point.
    expect(SaveV1Schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(golden);
  });

  it('Given an unknown extra field anywhere (top level, ship, flight), Then the whitelist rejects it', () => {
    const top = { ...goldenCopy(), cheat: true };
    expect(SaveV1Schema.safeParse(top).success).toBe(false);

    const ship = goldenCopy();
    (ship.ship as Record<string, unknown>).shields = 100;
    expect(SaveV1Schema.safeParse(ship).success).toBe(false);

    const flight = goldenCopy();
    (flight.player.flight as Record<string, unknown>).target = 'x';
    expect(SaveV1Schema.safeParse(flight).success).toBe(false);
  });

  it('Given a non-unit quaternion [0, 0, 0, 2], Then it is normalised to [0, 0, 0, 1] after parsing', () => {
    const s = goldenCopy();
    s.player.flight.orientation = [0, 0, 0, 2];
    expect(SaveV1Schema.parse(s).player.flight.orientation).toEqual([0, 0, 0, 1]);
  });

  it('Given a save with 6 000 actions, Then the schema accepts it (compaction is Task 3’s job, not the schema’s)', () => {
    const s = goldenCopy();
    const base = golden.actions;
    s.actions = Array.from({ length: 6000 }, (_, i) => ({
      ...structuredClone(base[i % base.length]),
      seq: i + 1,
    })) as SaveV1['actions'];
    const r = SaveV1Schema.safeParse(s);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.actions).toHaveLength(6000);
  });
});

describe('ActionEntrySchema — the payload is checked against its source', () => {
  it('Given every action in the golden save, Then each parses on its own', () => {
    for (const a of golden.actions) expect(ActionEntrySchema.safeParse(a).success).toBe(true);
  });

  it('Given a cargo payload filed under source "propellant", Then it is rejected', () => {
    const cargo = golden.actions.find((a) => a.source === 'cargo')!;
    expect(ActionEntrySchema.safeParse({ ...cargo, source: 'propellant' }).success).toBe(false);
  });

  describe('R7: a propellant payload carries tankDeltaKg — the signed change it made to the tank', () => {
    function propellantEntry(): Record<string, unknown> & { payload: Record<string, unknown> } {
      return structuredClone(golden.actions.find((a) => a.source === 'propellant')!) as never;
    }

    it('Given a spend (negative), a refund or a cannibalize gain (positive) and zero, Then each is accepted', () => {
      for (const d of [-310.25, 40, 600, 0]) {
        const e = propellantEntry();
        e.payload.tankDeltaKg = d;
        expect(ActionEntrySchema.safeParse(e).success, String(d)).toBe(true);
      }
    });

    it('Given a propellant payload WITHOUT tankDeltaKg, Then it is rejected (the books need it)', () => {
      const e = propellantEntry();
      delete e.payload.tankDeltaKg;
      expect(ActionEntrySchema.safeParse(e).success).toBe(false);
    });

    for (const [what, v] of [
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['a string', '-40'],
    ] as const) {
      it(`Given tankDeltaKg ${what}, Then it is rejected`, () => {
        const e = propellantEntry();
        e.payload.tankDeltaKg = v;
        expect(ActionEntrySchema.safeParse(e).success).toBe(false);
      });
    }
  });

  it('Given an unknown source, Then it is rejected', () => {
    const thrust = golden.actions.find((a) => a.source === 'thrust')!;
    expect(ActionEntrySchema.safeParse({ ...thrust, source: 'teleport' }).success).toBe(false);
  });

  it('Given a mined entry without `by` (P2), Then it is invalid', () => {
    const mined = structuredClone(golden.actions.find((a) => a.source === 'mined')!);
    delete (mined.payload as { by?: string }).by;
    expect(ActionEntrySchema.safeParse(mined).success).toBe(false);
  });
});

describe('ActionEntrySchema — the checkpoint entry (compaction of the oldest actions)', () => {
  function checkpoint() {
    return {
      seq: 5001,
      source: 'checkpoint',
      payload: {
        upToSeq: 5000,
        // R8: the NET effect of everything folded — signed where it can fall.
        tankNetKg: -4210.5,
        capacityLossNetFrac: 0.04,
        cargoNetKg: { ice: -600, metal: 340.25, silicate: 95, rare: 2.5 },
        minedByAsteroid: {
          'ast:gx-1mwhji--377.-3.266.1:398:12': { ice: 1800, metal: 410, silicate: 0, rare: 0 },
          'ast:gx-1mwhji--377.-3.266.1:398:13': { ice: 0, metal: 0, silicate: 95, rare: 3 },
        },
        emergency: { cannibalize: 1, cannibalizeCargo: 0, beacon: 2 },
        lastCannibalizeTimesUsed: 1,
      },
      wallMs: 1762891200000,
      orbitSeconds: 5412.25,
    };
  }

  it('Given a valid checkpoint, Then it parses unchanged — and a save carrying one is valid', () => {
    const r = ActionEntrySchema.safeParse(checkpoint());
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(checkpoint());

    const s = goldenCopy();
    s.actions = [checkpoint(), ...s.actions] as SaveV1['actions'];
    expect(SaveV1Schema.safeParse(s).success).toBe(true);
  });

  type CP = ReturnType<typeof checkpoint>['payload'];
  type Loose = Record<string, unknown>;
  const breaks: Array<{ what: string; mutate: (p: CP) => void }> = [
    { what: 'NaN tankNetKg', mutate: (p) => (p.tankNetKg = Number.NaN) },
    { what: 'Infinity tankNetKg', mutate: (p) => (p.tankNetKg = Number.POSITIVE_INFINITY) },
    { what: 'NaN capacityLossNetFrac', mutate: (p) => (p.capacityLossNetFrac = Number.NaN) },
    { what: '-Infinity cargoNetKg.metal', mutate: (p) => (p.cargoNetKg.metal = Number.NEGATIVE_INFINITY) },
    { what: 'unknown resource in cargoNetKg', mutate: (p) => ((p.cargoNetKg as Loose).gold = 1) },
    { what: 'negative mined kg for an asteroid', mutate: (p) => (Object.values(p.minedByAsteroid)[0]!.ice = -1) },
    { what: 'NaN mined kg for an asteroid', mutate: (p) => (Object.values(p.minedByAsteroid)[0]!.rare = Number.NaN) },
    { what: 'an unknown resource for an asteroid', mutate: (p) => ((Object.values(p.minedByAsteroid)[0] as Loose).gold = 1) },
    { what: 'an asteroid missing a resource', mutate: (p) => delete (Object.values(p.minedByAsteroid)[0] as Loose).rare },
    { what: 'an empty asteroid id', mutate: (p) => ((p.minedByAsteroid as Loose)[''] = { ice: 1, metal: 0, silicate: 0, rare: 0 }) },
    { what: 'negative emergency.beacon', mutate: (p) => (p.emergency.beacon = -1) },
    { what: 'fractional emergency.cannibalize', mutate: (p) => (p.emergency.cannibalize = 1.5) },
    { what: 'negative lastCannibalizeTimesUsed', mutate: (p) => (p.lastCannibalizeTimesUsed = -1) },
    { what: 'fractional lastCannibalizeTimesUsed', mutate: (p) => (p.lastCannibalizeTimesUsed = 0.5) },
    { what: 'fractional upToSeq', mutate: (p) => (p.upToSeq = 2.5) },
    { what: 'negative upToSeq', mutate: (p) => (p.upToSeq = -1) },
    { what: 'no tankNetKg', mutate: (p) => delete (p as Loose).tankNetKg },
    { what: 'no minedByAsteroid', mutate: (p) => delete (p as Loose).minedByAsteroid },
    { what: 'the old gross field propellantKg', mutate: (p) => ((p as Loose).propellantKg = 10) },
    { what: 'the old gross field cargoKg', mutate: (p) => ((p as Loose).cargoKg = { ice: 0, metal: 0, silicate: 0, rare: 0 }) },
  ];

  it('Given a checkpoint whose net values fall (negative tank, cargo and loss), Then it is accepted — net effects are signed', () => {
    const c = checkpoint();
    c.payload.tankNetKg = -1;
    c.payload.capacityLossNetFrac = -0.04;
    c.payload.cargoNetKg.ice = -2_000;
    expect(ActionEntrySchema.safeParse(c).success).toBe(true);
  });

  it('Given a checkpoint with no asteroids mined (an empty minedByAsteroid), Then it is accepted', () => {
    const c = checkpoint();
    (c.payload as Loose).minedByAsteroid = {};
    expect(ActionEntrySchema.safeParse(c).success).toBe(true);
  });

  for (const b of breaks) {
    it(`Given a checkpoint with ${b.what}, Then it is rejected`, () => {
      const c = checkpoint();
      b.mutate(c.payload);
      expect(ActionEntrySchema.safeParse(c).success).toBe(false);
    });
  }
});

describe('SaveV1Schema — constraints pinned by mutation testing (Task 7)', () => {
  type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const looseCopy = () => goldenCopy() as unknown as Loose;
  const rejects = (s: unknown) => SaveV1Schema.safeParse(s).success === false;
  const accepts = (s: unknown) => SaveV1Schema.safeParse(s).success === true;

  it('S1: Given a universeId with junk before or after the pattern, or an empty seed part, When parsed, Then it is rejected', () => {
    for (const id of ['xgx-abc:v1', 'gx-abc:v1x', 'gx-:v1']) {
      const s = looseCopy();
      s.universeId = id;
      s.world.universeId = id;
      expect(rejects(s), id).toBe(true);
    }
  });

  it('S2: Given a log entry with key "", visits 0 or visits 1.5, When parsed, Then it is rejected', () => {
    for (const [field, v] of [['key', ''], ['visits', 0], ['visits', 1.5]] as const) {
      const s = looseCopy();
      s.log.entries[0][field] = v;
      expect(rejects(s), `${field}=${String(v)}`).toBe(true);
    }
  });

  it('S3: Given a world entry whose `by` is "remote", When parsed, Then it is rejected', () => {
    const s = looseCopy();
    s.world.entries[0].by = 'remote';
    expect(rejects(s)).toBe(true);
  });

  it('S4: Given an action entry with seq 1.5, When parsed, Then it is rejected', () => {
    const thrust = golden.actions.find((a) => a.source === 'thrust')!;
    expect(ActionEntrySchema.safeParse({ ...thrust, seq: 1.5 }).success).toBe(false);
  });

  it('S5: Given a negative cruise-leg distance, jump-refund kg or spool-refund kg, When parsed, Then each is rejected; a cannibalize without timesUsed is accepted', () => {
    const propellant = (action: Record<string, unknown>) => ({
      seq: 1,
      source: 'propellant',
      payload: { action, ok: true, kg: 1, tankDeltaKg: 0 },
      wallMs: 1,
      orbitSeconds: 1,
    });
    for (const action of [
      { kind: 'cruise-leg', distanceKm: -1 },
      { kind: 'jump-refund', kg: -1 },
      { kind: 'spool-refund', kg: -1 },
    ]) {
      expect(ActionEntrySchema.safeParse(propellant(action)).success, action.kind).toBe(false);
    }
    expect(ActionEntrySchema.safeParse(propellant({ kind: 'cannibalize', part: 'tank' })).success).toBe(true);
  });

  it('S6: Given an emergency timesUsed or ship.emergencyTimesUsed of -1 or 1.5, When parsed, Then each is rejected', () => {
    const emergency = (timesUsed: number) => ({
      seq: 1,
      source: 'emergency',
      payload: { kind: 'cannibalize', timesUsed },
      wallMs: 1,
      orbitSeconds: 1,
    });
    for (const v of [-1, 1.5]) {
      expect(ActionEntrySchema.safeParse(emergency(v)).success, `payload ${v}`).toBe(false);
      const s = looseCopy();
      s.ship.emergencyTimesUsed = v;
      expect(rejects(s), `ship ${v}`).toBe(true);
    }
  });

  it('S7: Given bad system seed, system id, parentId or capacityLossFrac, When parsed, Then the bad ones are rejected and the boundaries pass', () => {
    const bad: Array<[string, (s: Loose) => void]> = [
      ['seed -1', (s) => (s.player.system.seed = -1)],
      ['seed 1.5', (s) => (s.player.system.seed = 1.5)],
      ['system id ""', (s) => (s.player.system.id = '')],
      ['parentId ""', (s) => (s.player.parentId = '')],
      ['capacityLossFrac -0.1', (s) => (s.ship.propellant.capacityLossFrac = -0.1)],
      ['capacityLossFrac 1.1', (s) => (s.ship.propellant.capacityLossFrac = 1.1)],
    ];
    for (const [what, mutate] of bad) {
      const s = looseCopy();
      mutate(s);
      expect(rejects(s), what).toBe(true);
    }
    const good: Array<[string, (s: Loose) => void]> = [
      ['parentId null', (s) => (s.player.parentId = null)],
      ['capacityLossFrac 0', (s) => (s.ship.propellant.capacityLossFrac = 0)],
      ['capacityLossFrac 1', (s) => (s.ship.propellant.capacityLossFrac = 1)],
    ];
    for (const [what, mutate] of good) {
      const s = looseCopy();
      mutate(s);
      expect(accepts(s), what).toBe(true);
    }
  });

  it('S8: Given an unknown key inside savedAt or inside world, When parsed, Then it is rejected', () => {
    const a = looseCopy();
    a.savedAt.extra = 1;
    expect(rejects(a)).toBe(true);
    const b = looseCopy();
    b.world.extra = 1;
    expect(rejects(b)).toBe(true);
  });
});
