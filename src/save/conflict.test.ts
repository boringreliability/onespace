/**
 * v4 sub-plan 4, Task 3 (phase A) — the conflict rule (DESIGN-4 §5.3).
 *
 * Two devices diverged on the SAME game (same saveId). The player keeps one
 * snapshot (position, log, actions, hold, tank); the unchosen branch's net
 * change against the shared base (`shipDigest(unchosen) - base`) is folded in
 * in its UNFAVOURABLE direction only: a net fall in tank or any resource is
 * subtracted, a net rise in capacity loss is added, net gains are ignored,
 * emergency counters add, depletion is the union. Tank and hold clamp to >= 0
 * and capacity loss to <= 1. Pure; shared by client and server.
 *
 * Schema mapping: brief `tankKg` = ship.propellant.massKg; `capacityLossFrac`
 * = ship.propellant.capacityLossFrac; cargo = ship.cargo (per Resource);
 * `emergencyTimesUsed` = ship.emergencyTimesUsed; wall clock = savedAt.wallMs.
 */

import { describe, expect, it } from 'vitest';

import type { Resource } from '@/gen/belt';

import { cardSummary, resolveSameGame, sameGame, shipDigest, type ShipDigest } from './conflict';
import golden from './fixtures/v1-golden.json';
import { SaveV1Schema, type SaveV1 } from './schema';

const RESOURCES: readonly Resource[] = ['ice', 'metal', 'silicate', 'rare'];
const ZERO_CARGO = { ice: 0, metal: 0, silicate: 0, rare: 0 };
const OTHER_ID = '11111111-2222-4333-8444-555555555555';

interface Over {
  saveId?: string;
  revision?: number;
  tank?: number;
  loss?: number;
  cargo?: Partial<Record<Resource, number>>;
  emergency?: number;
  entries?: SaveV1['world']['entries'];
  grounded?: boolean;
  parentId?: string | null;
  wallMs?: number;
}

/** A save built from the golden one: every field the rule reads is set explicitly. */
function save(o: Over = {}): SaveV1 {
  const s = structuredClone(golden) as unknown as SaveV1;
  if (o.saveId !== undefined) s.saveId = o.saveId;
  s.revision = o.revision ?? 5;
  s.ship.propellant.massKg = o.tank ?? 12_000;
  s.ship.propellant.capacityLossFrac = o.loss ?? 0;
  s.ship.cargo = { ...ZERO_CARGO, ...o.cargo };
  s.ship.emergencyTimesUsed = o.emergency ?? 0;
  s.world.entries = o.entries ?? [];
  if (o.grounded !== undefined) s.player.flight.grounded = o.grounded;
  if (o.parentId !== undefined) s.player.parentId = o.parentId;
  if (o.wallMs !== undefined) s.savedAt.wallMs = o.wallMs;
  return s;
}

function digest(o: Partial<ShipDigest> & { cargo?: Partial<Record<Resource, number>> } = {}): ShipDigest {
  return {
    tankKg: o.tankKg ?? 12_000,
    capacityLossFrac: o.capacityLossFrac ?? 0,
    cargo: { ...ZERO_CARGO, ...o.cargo },
    emergencyTimesUsed: o.emergencyTimesUsed ?? 0,
  };
}

function mined(id: string, resource: Resource, kg: number, wallMs: number, orbitSeconds = wallMs / 1000) {
  return { id, by: 'local' as const, resource, kg, wallMs, orbitSeconds };
}

const A1 = 'ast:gx-a:0:0';
const A2 = 'ast:gx-a:0:1';
const A3 = 'ast:gx-b:2:7';

describe('shipDigest, sameGame', () => {
  it('Given a save, When digested, Then tank, capacity loss, hold and emergency count are read from the ship', () => {
    const s = save({ tank: 9_000.5, loss: 0.125, cargo: { ice: 1, metal: 2, silicate: 3, rare: 4 }, emergency: 2 });
    expect(shipDigest(s)).toEqual({
      tankKg: 9_000.5,
      capacityLossFrac: 0.125,
      cargo: { ice: 1, metal: 2, silicate: 3, rare: 4 },
      emergencyTimesUsed: 2,
    });
  });

  it('Given a digest, When the save changes afterwards, Then the digest is a copy and does not follow', () => {
    const s = save({ cargo: { ice: 7 } });
    const d = shipDigest(s);
    s.ship.cargo.ice = 99;
    expect(d.cargo.ice).toBe(7);
  });

  it('Given two saves with the same saveId, Then sameGame is true even if everything else differs', () => {
    expect(sameGame(save({ revision: 3, tank: 1 }), save({ revision: 9, tank: 2 }))).toBe(true);
  });

  it('Given two saves with different saveId, Then sameGame is false', () => {
    expect(sameGame(save(), save({ saveId: OTHER_ID }))).toBe(false);
  });
});

describe('resolveSameGame — the rule', () => {
  it('Given the unchosen tank fell 12 000 -> 9 000 against base and the chosen is at 11 000, Then the result is 8 000 kg', () => {
    const out = resolveSameGame(save({ tank: 11_000 }), save({ tank: 9_000 }), digest({ tankKg: 12_000 }));
    expect(out.ship.propellant.massKg).toBe(8_000);
  });

  it('Given the unchosen tank only rose against base, Then the gain is ignored', () => {
    const out = resolveSameGame(save({ tank: 11_000 }), save({ tank: 14_000 }), digest({ tankKg: 12_000 }));
    expect(out.ship.propellant.massKg).toBe(11_000);
  });

  it('Given a hop that was paid and refunded in the unchosen branch (unchosen == base), Then the chosen is unchanged', () => {
    const base = digest({ tankKg: 12_000, cargo: { ice: 100 }, capacityLossFrac: 0.05, emergencyTimesUsed: 1 });
    const unchosen = save({ tank: 12_000, cargo: { ice: 100 }, loss: 0.05, emergency: 1 });
    const chosen = save({ tank: 10_500, cargo: { ice: 400, metal: 50 }, loss: 0.08, emergency: 1 });
    const out = resolveSameGame(chosen, unchosen, base);
    expect(out.ship).toEqual(chosen.ship);
  });

  it('Given a repair in the unchosen branch (metal -600, silicate -400, loss -0.05), Then metal and silicate are subtracted (silicate clamped at 0) and the loss gain is ignored', () => {
    const base = digest({ cargo: { metal: 1_000, silicate: 600 }, capacityLossFrac: 0.1 });
    const unchosen = save({ cargo: { metal: 400, silicate: 200 }, loss: 0.05 });
    const chosen = save({ cargo: { metal: 1_000, silicate: 200 }, loss: 0.1 });
    const out = resolveSameGame(chosen, unchosen, base);
    expect(out.ship.cargo.metal).toBe(400);
    expect(out.ship.cargo.silicate).toBe(0);
    expect(out.ship.propellant.capacityLossFrac).toBeCloseTo(0.1, 12);
  });

  it('Given a refining in the unchosen branch (ice -2 000, tank +1 500), Then ice is subtracted and the tank is unchanged', () => {
    const base = digest({ tankKg: 10_000, cargo: { ice: 3_000 } });
    const unchosen = save({ tank: 11_500, cargo: { ice: 1_000 } });
    const chosen = save({ tank: 9_000, cargo: { ice: 3_000 } });
    const out = resolveSameGame(chosen, unchosen, base);
    expect(out.ship.cargo.ice).toBe(1_000);
    expect(out.ship.propellant.massKg).toBe(9_000);
  });

  it('Given the unchosen branch fired a beacon (emergency +1, tank to 5 %, hold emptied), Then the counter is +1, the tank falls by its net fall and each resource is subtracted, all clamped at 0', () => {
    const base = digest({ tankKg: 12_000, cargo: { ice: 500, metal: 300, silicate: 100, rare: 10 } });
    const unchosen = save({ tank: 600, cargo: {}, emergency: 1 });
    const chosen = save({ tank: 12_000, cargo: { ice: 800, metal: 100, silicate: 100, rare: 0 }, emergency: 0 });
    const out = resolveSameGame(chosen, unchosen, base);
    expect(out.ship.emergencyTimesUsed).toBe(1);
    expect(out.ship.propellant.massKg).toBe(600); // 12 000 - 11 400
    expect(out.ship.cargo).toEqual({ ice: 300, metal: 0, silicate: 0, rare: 0 });
  });

  it('Given a tank fall bigger than the chosen tank, Then the tank is clamped at 0, never negative', () => {
    const out = resolveSameGame(save({ tank: 2_000 }), save({ tank: 100 }), digest({ tankKg: 12_000 }));
    expect(out.ship.propellant.massKg).toBe(0);
  });

  it("Given emergency counters on both branches, Then the unchosen branch's increase over base is added to the chosen count", () => {
    const out = resolveSameGame(save({ emergency: 2 }), save({ emergency: 2 }), digest({ emergencyTimesUsed: 1 }));
    expect(out.ship.emergencyTimesUsed).toBe(3);
  });

  it('Given an unchosen branch with no new emergency use, Then the chosen counter is unchanged', () => {
    const out = resolveSameGame(save({ emergency: 2 }), save({ emergency: 1 }), digest({ emergencyTimesUsed: 1 }));
    expect(out.ship.emergencyTimesUsed).toBe(2);
  });

  it('Given the unchosen capacity loss rose 0.2 against base, Then 0.2 is added to the chosen loss', () => {
    const out = resolveSameGame(save({ loss: 0.1 }), save({ loss: 0.25 }), digest({ capacityLossFrac: 0.05 }));
    expect(out.ship.propellant.capacityLossFrac).toBeCloseTo(0.3, 12);
  });

  it('Given the added capacity loss would pass 1, Then the loss is clamped at 1', () => {
    const out = resolveSameGame(save({ loss: 0.85 }), save({ loss: 0.3 }), digest({ capacityLossFrac: 0.1 }));
    expect(out.ship.propellant.capacityLossFrac).toBe(1);
  });

  it('Given the chosen has only ice and the unchosen spent metal (net -500), Then metal is 0, never negative', () => {
    const base = digest({ cargo: { metal: 500 } });
    const out = resolveSameGame(save({ cargo: { ice: 2_000 } }), save({ cargo: { metal: 0 } }), base);
    expect(out.ship.cargo.metal).toBe(0);
    expect(out.ship.cargo.ice).toBe(2_000);
  });

  it('Given large net falls on every resource, Then every resource in the result is >= 0 and finite', () => {
    const base = digest({ cargo: { ice: 9_000, metal: 9_000, silicate: 9_000, rare: 9_000 } });
    const out = resolveSameGame(save({ cargo: { ice: 10, metal: 20, silicate: 0, rare: 5 } }), save({ cargo: {} }), base);
    for (const r of RESOURCES) {
      expect(out.ship.cargo[r], r).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(out.ship.cargo[r]), r).toBe(true);
    }
    expect(out.ship.cargo).toEqual(ZERO_CARGO);
  });

  it('Given net gains on every resource in the unchosen branch, Then the chosen hold is unchanged', () => {
    const base = digest({ cargo: { ice: 100, metal: 100, silicate: 100, rare: 100 } });
    const chosen = save({ cargo: { ice: 5, metal: 6, silicate: 7, rare: 8 } });
    const out = resolveSameGame(chosen, save({ cargo: { ice: 900, metal: 900, silicate: 900, rare: 900 } }), base);
    expect(out.ship.cargo).toEqual(chosen.ship.cargo);
  });
});

describe('resolveSameGame — depletion (world entries) is the union', () => {
  it('Given disjoint asteroids on the two branches, Then the result holds both sets', () => {
    const chosen = save({ entries: [mined(A1, 'ice', 100, 1_000)] });
    const unchosen = save({ entries: [mined(A2, 'metal', 50, 2_000)] });
    const out = resolveSameGame(chosen, unchosen, digest());
    expect(out.world.entries.map((e) => [e.id, e.resource, e.kg])).toEqual([
      [A1, 'ice', 100],
      [A2, 'metal', 50],
    ]);
  });

  it('Given the same (id, resource) on both branches, Then the larger kg is kept — once, not summed — whichever branch was chosen', () => {
    const a = save({ entries: [mined(A1, 'ice', 100, 1_000)] });
    const b = save({ entries: [mined(A1, 'ice', 300, 2_000)] });
    const out = resolveSameGame(a, b, digest());
    expect(out.world.entries).toHaveLength(1);
    expect(out.world.entries[0]!.kg).toBe(300);
    const reverse = resolveSameGame(b, a, digest());
    expect(reverse.world.entries).toHaveLength(1);
    expect(reverse.world.entries[0]!.kg).toBe(300);
  });

  it('Given one asteroid mined for two resources on different branches, Then (id, resource) is the key — both entries stay', () => {
    const chosen = save({ entries: [mined(A1, 'ice', 100, 1_000)] });
    const unchosen = save({ entries: [mined(A1, 'metal', 40, 2_000)] });
    const out = resolveSameGame(chosen, unchosen, digest());
    expect(out.world.entries.map((e) => [e.id, e.resource, e.kg])).toEqual([
      [A1, 'ice', 100],
      [A1, 'metal', 40],
    ]);
  });

  it("Given the union, Then it is one entry per (id, resource) (C6), in first-seen order: chosen first, then the unchosen's new ones", () => {
    const chosen = save({ entries: [mined(A2, 'ice', 10, 1_000), mined(A1, 'ice', 20, 1_100)] });
    const unchosen = save({ entries: [mined(A3, 'rare', 1, 900), mined(A1, 'ice', 5, 3_000), mined(A2, 'ice', 8, 800)] });
    const out = resolveSameGame(chosen, unchosen, digest());
    expect(out.world.entries.map((e) => [e.id, e.resource, e.kg])).toEqual([
      [A2, 'ice', 10],
      [A1, 'ice', 20],
      [A3, 'rare', 1],
    ]);
  });

  it('Given a (id, resource) on both branches, Then the entry carries the newest clocks of the two (C6), kg the larger', () => {
    const chosen = save({ entries: [mined(A1, 'ice', 100, 1_000, 10)] });
    const unchosen = save({ entries: [mined(A1, 'ice', 60, 5_000, 50)] });
    const e = resolveSameGame(chosen, unchosen, digest()).world.entries[0]!;
    expect(e.kg).toBe(100);
    expect(e.wallMs).toBe(5_000);
    expect(e.orbitSeconds).toBe(50);
  });
});

describe('resolveSameGame — revision, identity, what is kept, purity', () => {
  it('Given revisions 5 and 9, When resolved either way, Then revision is max + 1 = 10', () => {
    expect(resolveSameGame(save({ revision: 5 }), save({ revision: 9 }), digest()).revision).toBe(10);
    expect(resolveSameGame(save({ revision: 9 }), save({ revision: 5 }), digest()).revision).toBe(10);
  });

  it("Given the chosen snapshot, Then saveId and universeId are the chosen's", () => {
    const chosen = save();
    const out = resolveSameGame(chosen, save(), digest());
    expect(out.saveId).toBe(chosen.saveId);
    expect(out.universeId).toBe(chosen.universeId);
    expect(out.world.universeId).toBe(chosen.universeId);
  });

  it("Given the chosen snapshot, Then position (player), log and actions are kept unchanged — the unchosen's are not merged in", () => {
    const chosen = save({ grounded: true, parentId: 'gx-1mwhji--377.-3.266.1:p3' });
    const unchosen = save({ grounded: false, parentId: 'gx-1mwhji--377.-3.266.1:p9', tank: 1 });
    unchosen.log.entries = [];
    unchosen.actions = [];
    const before = structuredClone(chosen);
    const out = resolveSameGame(chosen, unchosen, digest());
    expect(out.player).toEqual(before.player);
    expect(out.log).toEqual(before.log);
    expect(out.actions).toEqual(before.actions);
    expect(out.actions.length).toBeGreaterThan(0);
  });

  it('Given any resolved result, Then it passes SaveV1Schema.parse', () => {
    const base = digest({ tankKg: 12_000, cargo: { ice: 500, metal: 300 }, emergencyTimesUsed: 0 });
    const out = resolveSameGame(
      save({ tank: 11_000, cargo: { ice: 800 }, loss: 0.9, entries: [mined(A1, 'ice', 100, 1_000)] }),
      save({ tank: 600, cargo: {}, loss: 0.5, emergency: 1, revision: 8, entries: [mined(A2, 'metal', 5, 2_000)] }),
      base,
    );
    expect(() => SaveV1Schema.parse(out)).not.toThrow();
  });

  it('Given the inputs, When resolved, Then neither input nor the base is mutated, and the result shares no structure with them', () => {
    const chosen = save({ tank: 11_000, cargo: { ice: 800 }, entries: [mined(A1, 'ice', 100, 1_000)] });
    const unchosen = save({ tank: 600, emergency: 1, revision: 8, entries: [mined(A2, 'metal', 5, 2_000)] });
    const base = digest({ cargo: { ice: 500 } });
    const [c0, u0, b0] = [structuredClone(chosen), structuredClone(unchosen), structuredClone(base)];
    const out = resolveSameGame(chosen, unchosen, base);
    expect(chosen).toEqual(c0);
    expect(unchosen).toEqual(u0);
    expect(base).toEqual(b0);
    expect(out).not.toBe(chosen);
    expect(out.ship).not.toBe(chosen.ship);
    expect(out.world.entries).not.toBe(chosen.world.entries);
    expect(out.actions).not.toBe(chosen.actions);
    out.ship.cargo.ice = 12345;
    out.actions.length = 0;
    expect(chosen).toEqual(c0);
  });

  it('Given two different games, Then it throws', () => {
    expect(() => resolveSameGame(save(), save({ saveId: OTHER_ID }), digest())).toThrow();
  });
});

describe('cardSummary — the conflict screen', () => {
  it('Given a grounded save, Then place is "landed <parent name>"', () => {
    const s = save({ grounded: true, parentId: 'gx-1mwhji--377.-3.266.1:p2' });
    expect(cardSummary(s, 20_000).place).toBe('landed gx-1mwhji--377.-3.266.1:p2');
  });

  it('Given a flying save, Then place is "orbit <parent name>"', () => {
    const s = save({ grounded: false, parentId: 'gx-1mwhji--377.-3.266.1:p2' });
    expect(cardSummary(s, 20_000).place).toBe('orbit gx-1mwhji--377.-3.266.1:p2');
  });

  it("Given a save, Then tankFrac = tank / capacityKg, cargoKg = Σ hold, savedAtWallMs = savedAt.wallMs, systemName = the system's name", () => {
    const s = save({ tank: 5_000, cargo: { ice: 100, metal: 200, silicate: 300, rare: 0.5 }, wallMs: 1_800_000_123_456 });
    s.player.system.name = 'Kesh';
    const c = cardSummary(s, 20_000);
    expect(c.tankFrac).toBeCloseTo(0.25, 12);
    expect(c.cargoKg).toBeCloseTo(600.5, 9);
    expect(c.savedAtWallMs).toBe(1_800_000_123_456);
    expect(c.systemName).toBe('Kesh');
  });
});
