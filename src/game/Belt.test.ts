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

import { FIELDS_PER_BELT, FIELD_RADIUS_KM, nearestFieldIndex, type Resource } from '@/gen/belt';
import { orbitalPosition, orbitalVelocity } from '@/gen/orbit';
import { AU } from '@/gen/types';
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
