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
        propellantKg: 4210.5,
        cargoKg: { ice: 1200, metal: 340.25, silicate: 95, rare: 2.5 },
        minedKg: { ice: 1800, metal: 410, silicate: 95, rare: 3 },
        emergency: { cannibalize: 1, cannibalizeCargo: 0, beacon: 2 },
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

  const breaks: Array<{ what: string; mutate: (p: ReturnType<typeof checkpoint>['payload']) => void }> = [
    { what: 'NaN propellantKg', mutate: (p) => (p.propellantKg = Number.NaN) },
    { what: 'Infinity propellantKg', mutate: (p) => (p.propellantKg = Number.POSITIVE_INFINITY) },
    { what: 'negative propellantKg', mutate: (p) => (p.propellantKg = -1) },
    { what: 'negative cargoKg.metal', mutate: (p) => (p.cargoKg.metal = -0.5) },
    { what: 'NaN minedKg.rare', mutate: (p) => (p.minedKg.rare = Number.NaN) },
    { what: 'negative emergency.beacon', mutate: (p) => (p.emergency.beacon = -1) },
    { what: 'fractional emergency.cannibalize', mutate: (p) => (p.emergency.cannibalize = 1.5) },
    { what: 'fractional upToSeq', mutate: (p) => (p.upToSeq = 2.5) },
    { what: 'negative upToSeq', mutate: (p) => (p.upToSeq = -1) },
    { what: 'unknown resource in cargoKg', mutate: (p) => ((p.cargoKg as Record<string, number>).gold = 1) },
  ];

  for (const b of breaks) {
    it(`Given a checkpoint with ${b.what}, Then it is rejected`, () => {
      const c = checkpoint();
      b.mutate(c.payload);
      expect(ActionEntrySchema.safeParse(c).success).toBe(false);
    });
  }
});
