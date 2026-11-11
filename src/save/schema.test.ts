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
});
