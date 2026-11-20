/**
 * v4 sub-plan 2, Task 3 — the belt becomes playable state.
 *
 * Task 1 made the belt a pure function of the seed. This module puts it in the
 * game: which field the ship is in, where each asteroid is NOW on the orbit
 * clock (world frame: km, float64, star at the origin), how fast it moves, and
 * how much is left in it once the player has mined it (WorldState, P2).
 *
 * The start: a new game opens with the tank at START_FILL and an empty hold,
 * and the hold's mass is felt by the flight model every step.
 *
 * Fixture: the real start system (Fyss) from a real `Universe.init`.
 */

import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';

import { FIELDS_PER_BELT, FIELD_RADIUS_KM, nearestFieldIndex, type AsteroidSpec, type FieldSpec, type Resource } from '@/gen/belt';
import { orbitalPosition, orbitalVelocity } from '@/gen/orbit';
import { AU } from '@/gen/types';
import { MINE_MIN_KG } from '@/game/miningRules';
import { Universe } from '@/game/Universe';
import { CARGO_CAPACITY_KG, applyCargoAction } from '@/ship/cargo';
import { PROBE_TANK_CAPACITY_KG, START_FILL } from '@/ship/propellant';
import { cruiseLegKg, cruiseSpoolKg } from '@/ship/travelCost';
import {
  beltRig,
  fieldCentre,
  fieldVelocity,
  fyssBelt,
  fyssField,
  fyssOrbits,
  nodeCtx,
  startSystem,
  startUniverse,
} from './testing/beltFixture';

const RESOURCES: readonly Resource[] = ['ice', 'metal', 'silicate', 'rare'];
const DAY = 86_400;
const CAP = PROBE_TANK_CAPACITY_KG;

function expectNear(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, tol: number, msg?: string): void {
  expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), msg).toBeLessThanOrEqual(tol);
}

// ---------------------------------------------------------------------------
// The start
// ---------------------------------------------------------------------------

describe('Universe — the start and the hold', () => {
  it('Given the start (new game), Then the tank is at START_FILL (0.6) and cargo is empty', () => {
    expect(START_FILL).toBe(0.6);
    const u = new Universe();
    const tank = u.flight.propellant!;
    expect(tank).not.toBeNull();
    expect(tank.fraction).toBeCloseTo(START_FILL, 12);
    expect(tank.massKg).toBeCloseTo(START_FILL * CAP, 6);
    expect(u.cargo.capacityKg).toBe(CARGO_CAPACITY_KG);
    expect(u.cargo.totalKg).toBe(0);
    // And it is still so after init places the ship in the start system.
    const started = startUniverse();
    expect(started.system.name).toBe('Fyss');
    expect(started.flight.propellant!.fraction).toBeCloseTo(START_FILL, 12);
    expect(started.cargo.totalKg).toBe(0);
  });

  it('Given 4 t ice in the hold, Then flight.extraMassKg = 4 000 (synced every step, also back to 0 after a jettison)', () => {
    const u = new Universe();
    const r = applyCargoAction(u.cargo, u.flight.propellant, { kind: 'mine', asteroidId: 'ast:x:0:0', resource: 'ice', kg: 4_000 });
    expect(r.ok).toBe(true);
    // A frozen frame (pause overlay) still steps the universe's bookkeeping;
    // a full update needs a GPU, and the sync must not depend on one.
    u.frozen = true;
    u.update(1 / 60, nodeCtx());
    expect(u.flight.extraMassKg).toBe(4_000);

    applyCargoAction(u.cargo, u.flight.propellant, { kind: 'jettison-all' });
    u.update(1 / 60, nodeCtx());
    expect(u.flight.extraMassKg).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe('Belt — the nearest field and its asteroids', () => {
  it("Given Fyss's belt, When the ship sits at field k's position, Then nearestField().index = k and asteroidsNear returns that field's asteroids within FIELD_RADIUS_KM", () => {
    const r = beltRig();
    r.frame();
    expect(r.belt.belt).toEqual(fyssBelt());
    const out: string[] = [];
    for (const k of [0, 137, 398, FIELDS_PER_BELT - 1]) {
      for (const t of [0, 3 * DAY]) {
        const f = fyssField(k);
        r.world.orbitSeconds = t;
        r.world.flight.worldPosition.copy(fieldCentre(f, t));
        r.frame();
        const near = r.belt.nearestField();
        expect(near, `k=${k} t=${t}`).not.toBeNull();
        expect(near!.index).toBe(k);
        expect(near!.id).toBe(f.id);

        out.push('stale');
        const n = r.belt.asteroidsNear(r.world.flight.worldPosition, FIELD_RADIUS_KM, out);
        expect(n).toBe(out.length);
        const want = f.asteroids
          .filter((a) => Math.hypot(...a.offsetKm) <= FIELD_RADIUS_KM)
          .map((a) => a.id)
          .sort();
        expect([...out].sort(), `k=${k} t=${t}`).toEqual(want);
      }
    }
  });

  it('Given a tight radius around one asteroid, Then asteroidsNear returns only that one', () => {
    const r = beltRig();
    const f = fyssField(398);
    r.world.flight.worldPosition.copy(fieldCentre(f, 0));
    r.frame();
    const a = f.asteroids[5]!;
    const at = new Vector3();
    expect(r.belt.asteroidWorld(a.id, at)).toBe(true);
    const out: string[] = [];
    expect(r.belt.asteroidsNear(at, a.radiusKm + 1e-3, out)).toBe(1);
    expect(out).toEqual([a.id]);
  });

  it('Given an asteroid id, Then asteroidSpec returns its generated spec; an unknown id gives null', () => {
    const r = beltRig();
    const f = fyssField(398);
    r.world.flight.worldPosition.copy(fieldCentre(f, 0));
    r.frame();
    for (const a of [f.asteroids[0]!, f.asteroids[f.asteroids.length - 1]!]) {
      expect(r.belt.asteroidSpec(a.id)).toEqual(a);
    }
    // Far from the ship: still resolvable from its id alone.
    const far = fyssField(17).asteroids[2]!;
    expect(r.belt.asteroidSpec(far.id)).toEqual(far);
    for (const bad of ['ast:nope:1:1', `ast:${startSystem().id}:${FIELDS_PER_BELT}:0`, `ast:${startSystem().id}:398:999`, 'body:Vassa']) {
      expect(r.belt.asteroidSpec(bad), bad).toBeNull();
    }
  });

  it('Given the ship stays in field k over many frames, Then nearestField() keeps returning the same memoised FieldSpec (no rebuild per frame)', () => {
    const r = beltRig();
    const f = fyssField(137);
    r.world.flight.worldPosition.copy(fieldCentre(f, 0));
    r.frame();
    const first = r.belt.nearestField();
    expect(first?.index).toBe(137);
    for (let i = 0; i < 30; i++) {
      r.world.flight.worldPosition.x += 0.5;
      r.frame();
      expect(r.belt.nearestField()).toBe(first);
    }
  });
});

describe('Belt — positions and velocities on the orbit clock', () => {
  it('Given orbitSeconds advances 600 s, Then asteroidWorld moves along orbitalPosition, and asteroidWorld minus fieldWorld stays the fixed offset', () => {
    const r = beltRig();
    const f = fyssField(398);
    const a = f.asteroids[3]!;
    const t0 = 2 * DAY;
    r.world.orbitSeconds = t0;
    r.world.flight.worldPosition.copy(fieldCentre(f, t0));
    r.frame();

    const ast0 = new Vector3();
    const fld0 = new Vector3();
    expect(r.belt.asteroidWorld(a.id, ast0)).toBe(true);
    expect(r.belt.fieldWorld(f.id, fld0)).toBe(true);
    expectNear(fld0, fieldCentre(f, t0), 1e-6);

    r.world.orbitSeconds = t0 + 600;
    r.frame();
    const ast1 = new Vector3();
    const fld1 = new Vector3();
    expect(r.belt.asteroidWorld(a.id, ast1)).toBe(true);
    expect(r.belt.fieldWorld(f.id, fld1)).toBe(true);

    const c1 = orbitalPosition(f.orbit, t0 + 600);
    expectNear(fld1, c1, 1e-6);
    expectNear(ast1, { x: c1.x + a.offsetKm[0], y: c1.y + a.offsetKm[1], z: c1.z + a.offsetKm[2] }, 1e-6);
    // It moved: ~10–20 km/s for 600 s is thousands of km.
    expect(ast1.distanceTo(ast0)).toBeGreaterThan(1_000);
    // The offset in the field is fixed.
    const off = { x: a.offsetKm[0], y: a.offsetKm[1], z: a.offsetKm[2] };
    expectNear(ast0.clone().sub(fld0), off, 1e-6);
    expectNear(ast1.clone().sub(fld1), off, 1e-6);
  });

  it("Given an asteroid, Then asteroidVelocity is its field's orbital velocity about the star (star frame, km/s)", () => {
    const r = beltRig();
    const f = fyssField(398);
    const t = 5 * DAY;
    r.world.orbitSeconds = t;
    r.world.flight.worldPosition.copy(fieldCentre(f, t));
    r.frame();
    const v = new Vector3();
    expect(r.belt.asteroidVelocity(f.asteroids[1]!.id, v)).toBe(true);
    const want = orbitalVelocity(f.orbit, t, fyssBelt().starMu);
    expectNear(v, want, 1e-9);
    expect(v.length()).toBeGreaterThan(5);
    expect(fieldVelocity(f, t).distanceTo(v)).toBeLessThan(1e-9);
  });

  it('Given a floating-origin rebase, Then world positions are unchanged (world is float64 star frame)', () => {
    const r = beltRig();
    const f = fyssField(398);
    const a = f.asteroids[0]!;
    r.world.flight.worldPosition.copy(fieldCentre(f, 0));
    r.frame();
    const before = new Vector3();
    const fBefore = new Vector3();
    r.belt.asteroidWorld(a.id, before);
    r.belt.fieldWorld(f.id, fBefore);

    r.ctx.origin.setTo(fieldCentre(f, 0).add(new Vector3(12_345, -678, 9_012)));
    r.frame();
    const after = new Vector3();
    const fAfter = new Vector3();
    expect(r.belt.asteroidWorld(a.id, after)).toBe(true);
    expect(r.belt.fieldWorld(f.id, fAfter)).toBe(true);
    expect(after.equals(before)).toBe(true);
    expect(fAfter.equals(fBefore)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Depletion
// ---------------------------------------------------------------------------

describe('Belt × WorldState — what is left', () => {
  it("Given 3 kg mined from an asteroid, Then remainingKg falls by 3 kg and depleted is recorded with by='local' and both clocks", () => {
    const r = beltRig(startSystem(), 1_800_000_000_000);
    const f = fyssField(398);
    const a = f.asteroids.find((x) => x.composition.ice >= 1_000)!;
    r.world.orbitSeconds = 4_321;
    r.world.flight.worldPosition.copy(fieldCentre(f, 4_321));
    r.frame();
    for (const res of RESOURCES) expect(r.belt.remainingKg(a.id, res)).toBe(a.composition[res]);

    r.worldState.recordMined(a.id, 'ice', 3, 'local');
    expect(r.belt.remainingKg(a.id, 'ice')).toBeCloseTo(a.composition.ice - 3, 9);
    expect(r.belt.remainingKg(a.id, 'metal')).toBe(a.composition.metal);
    expect(r.worldState.depleted(a.id).ice).toBe(3);
    const e = r.worldState.entries();
    expect(e[e.length - 1]).toMatchObject({ id: a.id, by: 'local', orbitSeconds: 4_321, wallMs: 1_800_000_000_000 });
  });

  it('Given more mined than the asteroid held, Then remainingKg is 0, never negative; an unknown asteroid has 0 left', () => {
    const r = beltRig();
    const f = fyssField(398);
    const a = f.asteroids[0]!;
    r.world.flight.worldPosition.copy(fieldCentre(f, 0));
    r.frame();
    expect(a.composition.silicate).toBeGreaterThan(0);
    expect(r.belt.remainingKg(a.id, 'silicate')).toBe(a.composition.silicate);
    r.worldState.recordMined(a.id, 'silicate', a.composition.silicate + 50, 'local');
    expect(r.belt.remainingKg(a.id, 'silicate')).toBe(0);
    expect(r.belt.remainingKg('ast:nope:1:1', 'ice')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// No belt
// ---------------------------------------------------------------------------

describe('Belt — inert without a belt', () => {
  it('Given a system without a belt, Then Belt is inert: belt null, no field, no asteroid, nothing near', () => {
    const bare = { ...startSystem(), hasAsteroidBelt: false };
    for (const sys of [bare, null]) {
      const r = beltRig(sys);
      r.frame();
      expect(r.belt.belt).toBeNull();
      expect(r.belt.nearestField()).toBeNull();
      const v = new Vector3(7, 7, 7);
      const fyssAst = fyssField(398).asteroids[0]!.id;
      expect(r.belt.fieldWorld(fyssField(398).id, v)).toBe(false);
      expect(r.belt.asteroidWorld(fyssAst, v)).toBe(false);
      expect(r.belt.asteroidVelocity(fyssAst, v)).toBe(false);
      expect(r.belt.asteroidSpec(fyssAst)).toBeNull();
      expect(r.belt.remainingKg(fyssAst, 'ice')).toBe(0);
      const out = ['stale'];
      expect(r.belt.asteroidsNear(v, 1e9, out)).toBe(0);
      expect(out).toEqual([]);
    }
  });

  it('Given the system changes from Fyss to a beltless one, Then the belt and the nearest field are dropped', () => {
    const r = beltRig();
    r.world.flight.worldPosition.copy(fieldCentre(fyssField(3), 0));
    r.frame();
    expect(r.belt.nearestField()).not.toBeNull();
    r.world.system = { ...startSystem(), id: 'sys-bare', hasAsteroidBelt: false };
    r.frame();
    expect(r.belt.belt).toBeNull();
    expect(r.belt.nearestField()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

describe('Belt — the opening trip is affordable', () => {
  it('Given START_FILL at the opening orbit, Then a round trip (cruise spool + legs) from Remit 31 to the nearest field and back costs ≤ 10 % of base capacity', () => {
    const sys = startSystem();
    const remit = sys.planets.find((p) => p.name.startsWith('Remit 31'));
    expect(remit, 'Remit 31 in the start system').toBeDefined();
    // The new game opens in orbit about Remit 31.
    expect(startUniverse().shipParent?.spec.name).toBe(remit!.name);

    const home = orbitalPosition(remit!.orbit, 0);
    const k = nearestFieldIndex(fyssOrbits(), home, 0);
    const field = orbitalPosition(fyssField(k).orbit, 0);
    const dKm = Math.hypot(field.x - home.x, field.y - home.y, field.z - home.z);
    const roundTripKg = 2 * (cruiseSpoolKg(CAP) + cruiseLegKg(dKm, CAP));

    // Measured at the time of writing: field 398, 0.156 AU, 1.31 % of base.
    expect(dKm / AU).toBeLessThan(0.5);
    expect(roundTripKg).toBeLessThanOrEqual(0.1 * CAP);
    expect(START_FILL * CAP - roundTripKg).toBeGreaterThan(0.5 * CAP);
  });
});

// ---------------------------------------------------------------------------
// Wear and destroyed rocks (v4 sub-plan 5, Task 2)
// ---------------------------------------------------------------------------

type Rig = ReturnType<typeof beltRig>;

const totalKg = (a: AsteroidSpec): number => RESOURCES.reduce((s, r) => s + a.composition[r], 0);

/** Put the ship at the centre of field `f` (t = 0) and run a frame, so `f` is the memoised nearest field. */
function atField(r: Rig, f: FieldSpec): void {
  r.world.orbitSeconds = 0;
  r.world.flight.worldPosition.copy(fieldCentre(f, 0));
  r.frame();
}

/** Mine every kilogram of every resource out of `a` (wear is then exactly 1). */
function mineEmpty(r: Rig, a: AsteroidSpec): void {
  for (const res of RESOURCES) r.worldState.recordMined(a.id, res, a.composition[res], 'local');
}

/** Mine `a` down to `keepKg` of each resource (a resource holding less is mined empty). Dust stays. */
function mineDownTo(r: Rig, a: AsteroidSpec, keepKg: number): void {
  for (const res of RESOURCES) r.worldState.recordMined(a.id, res, Math.max(0, a.composition[res] - keepKg), 'local');
}

/** Mine exactly `kg` out of `a`, taking from the resources in turn. */
function mineKg(r: Rig, a: AsteroidSpec, kg: number): void {
  let left = kg;
  for (const res of RESOURCES) {
    const take = Math.min(left, a.composition[res]);
    r.worldState.recordMined(a.id, res, take, 'local');
    left -= take;
  }
  expect(left, 'the rock held enough to mine kg').toBe(0);
}

/** Leave at least 0.5 kg of `res` in `a` (nudged so float rounding cannot leave 0.4999…) and mine all the rest. */
function mineAllButBoundary(r: Rig, a: AsteroidSpec, keep: Resource): void {
  for (const res of RESOURCES) {
    if (res !== keep) {
      r.worldState.recordMined(a.id, res, a.composition[res], 'local');
      continue;
    }
    const x = a.composition[res];
    let m = x - MINE_MIN_KG;
    while (x - m < MINE_MIN_KG) m -= x * Number.EPSILON;
    r.worldState.recordMined(a.id, res, m, 'local');
  }
}

/** The ship's position: where `id` is now. */
function at(r: Rig, id: string): Vector3 {
  const v = new Vector3();
  expect(r.belt.asteroidWorld(id, v), id).toBe(true);
  return v;
}

describe('Belt — wear', () => {
  it('Given an untouched rock, Then wear is 0', () => {
    // Given a field with the ship in it
    const r = beltRig();
    const f = fyssField(398);
    atField(r, f);
    // Then
    expect(r.belt.wear(f.asteroids[0]!.id)).toBe(0);
    expect(r.belt.wear(fyssField(17).asteroids[2]!.id)).toBe(0);
  });

  it('Given 2 000 kg mined from a rock, Then wear is 2000 / its original total mass', () => {
    const r = beltRig();
    const f = fyssField(398);
    atField(r, f);
    const a = f.asteroids.find((x) => totalKg(x) > 5_000)!;
    expect(a, 'a rock above 5 t in field 398').toBeDefined();
    // When
    mineKg(r, a, 2_000);
    // Then
    expect(r.belt.wear(a.id)).toBeCloseTo(2_000 / totalKg(a), 9);
  });

  it('Given a rock mined in steps, Then wear grows with every step and stays within 0..1', () => {
    const r = beltRig();
    const f = fyssField(398);
    atField(r, f);
    const a = f.asteroids.find((x) => x.composition.ice >= 1_000)!;
    let last = r.belt.wear(a.id);
    for (let i = 0; i < 4; i++) {
      r.worldState.recordMined(a.id, 'ice', 250, 'local');
      const w = r.belt.wear(a.id);
      expect(w).toBeGreaterThan(last);
      expect(w).toBeLessThanOrEqual(1);
      last = w;
    }
  });

  it('Given a rock mined empty, Then wear is exactly 1; more mined than it held does not push it past 1', () => {
    const r = beltRig();
    const f = fyssField(398);
    atField(r, f);
    const a = f.asteroids[0]!;
    mineEmpty(r, a);
    expect(r.belt.wear(a.id)).toBe(1);
    r.worldState.recordMined(a.id, 'silicate', 50, 'local');
    expect(r.belt.wear(a.id)).toBe(1);
  });

  it('Given a rock with dust (0.4 kg of each resource) left, Then wear is within 1e-3 of 1', () => {
    const r = beltRig();
    const f = fyssField(398);
    atField(r, f);
    const a = f.asteroids.find((x) => totalKg(x) > 5_000)!;
    mineDownTo(r, a, 0.4);
    expect(r.belt.wear(a.id)).toBeLessThan(1);
    expect(1 - r.belt.wear(a.id)).toBeLessThan(1e-3);
  });

  it('Given an unknown id, a rock outside the belt, or no belt, Then wear is 0', () => {
    const r = beltRig();
    atField(r, fyssField(398));
    for (const bad of ['ast:nope:1:1', `ast:${startSystem().id}:${FIELDS_PER_BELT}:0`, `ast:${startSystem().id}:398:999`, 'body:Vassa', '']) {
      expect(r.belt.wear(bad), bad).toBe(0);
    }
    const bare = beltRig({ ...startSystem(), hasAsteroidBelt: false });
    bare.frame();
    expect(bare.belt.wear(fyssField(398).asteroids[0]!.id)).toBe(0);
  });
});

describe('Belt — when a rock is destroyed', () => {
  it('Given 0.4 kg of every resource left, Then the rock is destroyed; with 0.5 kg of one resource left it is not', () => {
    const r = beltRig();
    const f = fyssField(398);
    atField(r, f);
    const a = f.asteroids.find((x) => x.composition.ice >= 1_000)!;
    const b = f.asteroids.filter((x) => x.composition.ice >= 1_000)[1]!;
    expect(r.belt.isDestroyed(a.id)).toBe(false);
    // When: 0.4 kg of each left
    mineDownTo(r, a, 0.4);
    // Then
    expect(r.belt.isDestroyed(a.id)).toBe(true);
    // When: the other rock keeps exactly the line (MINE_MIN_KG) of one resource
    mineAllButBoundary(r, b, 'ice');
    expect(r.belt.remainingKg(b.id, 'ice')).toBeGreaterThanOrEqual(MINE_MIN_KG);
    // Then
    expect(r.belt.isDestroyed(b.id)).toBe(false);
  });

  it.each(RESOURCES)('Given only %s is left (above the line) and the rest mined empty, Then the rock is not destroyed', (res) => {
    const r = beltRig();
    const f = fyssField(398);
    atField(r, f);
    const a = f.asteroids.find((x) => x.composition[res] >= 1_000)!;
    expect(a, `a rock with ${res} ≥ 1 t`).toBeDefined();
    for (const o of RESOURCES) if (o !== res) r.worldState.recordMined(a.id, o, a.composition[o], 'local');
    expect(r.belt.isDestroyed(a.id)).toBe(false);
  });

  it('Given an untouched or unknown rock, Then isDestroyed is false', () => {
    const r = beltRig();
    atField(r, fyssField(398));
    expect(r.belt.isDestroyed(fyssField(398).asteroids[0]!.id)).toBe(false);
    expect(r.belt.isDestroyed('ast:nope:1:1')).toBe(false);
    expect(r.belt.isDestroyed('body:Vassa')).toBe(false);
  });

  it('Given a destroyed rock, Then remainingKg keeps returning the true remainder (a number below 0.5), for Mining to refuse on', () => {
    const r = beltRig();
    const f = fyssField(398);
    atField(r, f);
    const a = f.asteroids.find((x) => x.composition.ice >= 1_000)!;
    mineDownTo(r, a, 0.4);
    expect(r.belt.isDestroyed(a.id)).toBe(true);
    for (const res of RESOURCES) {
      const left = r.belt.remainingKg(a.id, res);
      expect(left, res).toBeLessThan(MINE_MIN_KG);
      expect(left, res).toBeCloseTo(Math.min(0.4, a.composition[res]), 6);
    }
    // And a rock mined empty answers exactly 0.
    const e = f.asteroids[1]!;
    mineEmpty(r, e);
    for (const res of RESOURCES) expect(r.belt.remainingKg(e.id, res)).toBe(0);
  });

  it('Given a destroyed rock, Then asteroidSpecRaw still returns its original spec; an intact rock too; an unknown id gives null', () => {
    const r = beltRig();
    const f = fyssField(398);
    atField(r, f);
    const [gone, intact] = [f.asteroids[0]!, f.asteroids[1]!];
    const farGone = fyssField(17).asteroids[2]!;
    mineEmpty(r, gone);
    mineEmpty(r, farGone);
    expect(r.belt.asteroidSpecRaw(gone.id)).toEqual(gone);
    expect(r.belt.asteroidSpecRaw(farGone.id)).toEqual(farGone);
    expect(r.belt.asteroidSpecRaw(intact.id)).toEqual(intact);
    for (const bad of ['ast:nope:1:1', `ast:${startSystem().id}:${FIELDS_PER_BELT}:0`, `ast:${startSystem().id}:398:999`, 'body:Vassa']) {
      expect(r.belt.asteroidSpecRaw(bad), bad).toBeNull();
    }
  });
});

describe('Belt — a destroyed rock is gone from every lookup (one test per lookup)', () => {
  /** Field 398 with the ship in it; rock 0 destroyed, rock 1 its intact neighbour. */
  function destroyedNearby() {
    const r = beltRig();
    const f = fyssField(398);
    atField(r, f);
    const [gone, intact] = [f.asteroids[0]!, f.asteroids[1]!];
    mineEmpty(r, gone);
    return { r, f, gone, intact };
  }

  it('Given a destroyed rock near the ship, Then asteroidSpec returns null for it (as for an unknown id) and the spec for its neighbour', () => {
    const { r, gone, intact } = destroyedNearby();
    expect(r.belt.asteroidSpec(gone.id)).toBeNull();
    expect(r.belt.asteroidSpec(intact.id)).toEqual(intact);
  });

  it('Given a destroyed rock far from the ship (resolved from its id), Then asteroidSpec returns null for it and the spec for its neighbour', () => {
    const { r } = destroyedNearby();
    const far = fyssField(17).asteroids;
    mineEmpty(r, far[2]!);
    expect(r.belt.asteroidSpec(far[2]!.id)).toBeNull();
    expect(r.belt.asteroidSpec(far[3]!.id)).toEqual(far[3]);
  });

  it('Given a destroyed rock, Then asteroidWorld returns false for it and true for its neighbour', () => {
    const { r, gone, intact } = destroyedNearby();
    const v = new Vector3();
    expect(r.belt.asteroidWorld(gone.id, v)).toBe(false);
    expect(r.belt.asteroidWorld(intact.id, v)).toBe(true);
    // Far rock, too.
    const far = fyssField(17).asteroids;
    mineEmpty(r, far[2]!);
    expect(r.belt.asteroidWorld(far[2]!.id, v)).toBe(false);
    expect(r.belt.asteroidWorld(far[3]!.id, v)).toBe(true);
  });

  it('Given a destroyed rock, Then asteroidVelocity returns false for it and true for its neighbour', () => {
    const { r, gone, intact } = destroyedNearby();
    const v = new Vector3();
    expect(r.belt.asteroidVelocity(gone.id, v)).toBe(false);
    expect(r.belt.asteroidVelocity(intact.id, v)).toBe(true);
    const far = fyssField(17).asteroids;
    mineEmpty(r, far[2]!);
    expect(r.belt.asteroidVelocity(far[2]!.id, v)).toBe(false);
    expect(r.belt.asteroidVelocity(far[3]!.id, v)).toBe(true);
  });

  it('Given a destroyed rock, Then asteroidsNear leaves it out and still lists its neighbour', () => {
    const r = beltRig();
    const f = fyssField(398);
    atField(r, f);
    const [gone, intact] = [f.asteroids[0]!, f.asteroids[1]!];
    const centre = r.world.flight.worldPosition.clone();
    const out: string[] = [];
    // Before: both are in range.
    r.belt.asteroidsNear(centre, 2 * FIELD_RADIUS_KM, out);
    expect(out).toContain(gone.id);
    expect(out).toContain(intact.id);
    const before = out.length;
    // When
    mineEmpty(r, gone);
    const n = r.belt.asteroidsNear(centre, 2 * FIELD_RADIUS_KM, out);
    // Then
    expect(out).not.toContain(gone.id);
    expect(out).toContain(intact.id);
    expect(n).toBe(out.length);
    expect(n).toBe(before - 1);
  });

  it('Given a destroyed rock, Then asteroidsNearSurface leaves it out even when the ship sits on it, and still lists its neighbour', () => {
    const r = beltRig();
    const f = fyssField(398);
    atField(r, f);
    const [gone, intact] = [f.asteroids[0]!, f.asteroids[1]!];
    const onIt = at(r, gone.id);
    const out: string[] = [];
    r.belt.asteroidsNearSurface(onIt, 2 * FIELD_RADIUS_KM, out);
    expect(out).toContain(gone.id);
    expect(out).toContain(intact.id);
    const before = out.length;
    // When
    mineEmpty(r, gone);
    const n = r.belt.asteroidsNearSurface(onIt, 2 * FIELD_RADIUS_KM, out);
    // Then
    expect(out).not.toContain(gone.id);
    expect(out).toContain(intact.id);
    expect(n).toBe(out.length);
    expect(n).toBe(before - 1);
  });

  it('Given the nearest ice-rich rock is destroyed, Then firstRockTarget returns another rock, never the destroyed one', () => {
    const r = beltRig();
    const f = fyssField(398);
    atField(r, f);
    const icy = f.asteroids.find((x) => x.composition.ice >= 1_000)!;
    const onIt = at(r, icy.id);
    expect(r.belt.firstRockTarget(f.id, onIt)).toBe(icy.id);
    // When
    mineEmpty(r, icy);
    // Then
    const next = r.belt.firstRockTarget(f.id, onIt);
    expect(next).not.toBeNull();
    expect(next).not.toBe(icy.id);
    expect(r.belt.asteroidSpec(next!)).not.toBeNull();
  });

  it('Given no ice-rich rock is left, When the nearest rock is destroyed, Then the fall-back to any rock skips it and picks the nearest intact one', () => {
    const r = beltRig();
    const f = fyssField(398);
    atField(r, f);
    // Given: ice is gone everywhere (no rock is ice-rich) but nothing else is mined.
    for (const a of f.asteroids) r.worldState.recordMined(a.id, 'ice', a.composition.ice, 'local');
    const target = f.asteroids[0]!;
    const onIt = at(r, target.id);
    expect(r.belt.firstRockTarget(f.id, onIt)).toBe(target.id);
    // When: the nearest rock is destroyed
    mineEmpty(r, target);
    // Then: the nearest intact rock by surface distance
    const surface = (a: AsteroidSpec): number => at(r, a.id).distanceTo(onIt) - a.radiusKm;
    const want = f.asteroids.filter((a) => a.id !== target.id).sort((a, b) => surface(a) - surface(b))[0]!;
    expect(r.belt.firstRockTarget(f.id, onIt)).toBe(want.id);
  });

  it('Given a field where every rock is destroyed, Then the first target (ice-rich lookup and its fall-back) is null; a neighbouring field still gives a rock', () => {
    const r = beltRig();
    const f = fyssField(398);
    atField(r, f);
    for (const a of f.asteroids) mineEmpty(r, a);
    for (const a of f.asteroids) for (const res of RESOURCES) expect(r.belt.remainingKg(a.id, res)).toBe(0);
    expect(r.belt.firstRockTarget(f.id, r.world.flight.worldPosition)).toBeNull();
    expect(r.belt.firstRockTarget(f.id, r.world.flight.worldPosition, 0)).toBeNull();
    const other = fyssField(397);
    expect(r.belt.firstRockTarget(other.id, r.world.flight.worldPosition)).not.toBeNull();
  });
});

describe('Belt × WorldState — a reloaded world with a fully mined rock', () => {
  /** A played world: rock 0 of field 398 mined empty, its neighbour untouched. */
  function savedEntries() {
    const played = beltRig();
    const f = fyssField(398);
    atField(played, f);
    mineEmpty(played, f.asteroids[0]!);
    return { f, entries: played.worldState.entries() };
  }

  it('Given a fresh game, When WorldState.restore loads a fully mined rock, Then the rock is absent from every lookup and its neighbour is not (Belt has no bus: it cannot emit, so this asserts absence only)', () => {
    const { f, entries } = savedEntries();
    const [gone, intact] = [f.asteroids[0]!, f.asteroids[1]!];
    const r = beltRig();
    r.worldState.restore(entries);
    atField(r, f);
    // Then
    expect(r.belt.isDestroyed(gone.id)).toBe(true);
    expect(r.belt.wear(gone.id)).toBe(1);
    const v = new Vector3();
    expect(r.belt.asteroidSpec(gone.id)).toBeNull();
    expect(r.belt.asteroidWorld(gone.id, v)).toBe(false);
    expect(r.belt.asteroidVelocity(gone.id, v)).toBe(false);
    const out: string[] = [];
    r.belt.asteroidsNear(r.world.flight.worldPosition, 2 * FIELD_RADIUS_KM, out);
    expect(out).not.toContain(gone.id);
    expect(out).toContain(intact.id);
    r.belt.asteroidsNearSurface(r.world.flight.worldPosition, 2 * FIELD_RADIUS_KM, out);
    expect(out).not.toContain(gone.id);
    expect(out).toContain(intact.id);
    expect(r.belt.firstRockTarget(f.id, r.world.flight.worldPosition)).not.toBe(gone.id);
    expect(r.belt.asteroidSpec(intact.id)).toEqual(intact);
    // And the original is still readable for the break-up.
    expect(r.belt.asteroidSpecRaw(gone.id)).toEqual(gone);
  });

  it('Given a Belt that has already built its memo (rock present), When the world is restored with that rock mined empty, Then the rock is absent at once, without another update', () => {
    const { f, entries } = savedEntries();
    const gone = f.asteroids[0]!;
    const r = beltRig();
    atField(r, f);
    expect(r.belt.asteroidSpec(gone.id)).toEqual(gone);
    // When
    r.worldState.restore(entries);
    // Then: no frame in between
    expect(r.belt.asteroidSpec(gone.id)).toBeNull();
    expect(r.belt.isDestroyed(gone.id)).toBe(true);
    // And restoring an empty world brings the rock back.
    r.worldState.restore([]);
    expect(r.belt.asteroidSpec(gone.id)).toEqual(gone);
    expect(r.belt.wear(gone.id)).toBe(0);
  });
});
