/**
 * v4 mining — rocks and ship on one clock (review fix round 1, binding ruling).
 *
 * Belt positions are a function of the orbit clock; the ship's are wherever
 * the FlightModel's integration has got to. Two things kept them apart:
 *
 *  (a) Universe's slice loop advanced the orbit clock BEFORE the slice's
 *      guidance (`beforeSlice`), so the approach computer saw the rock one
 *      slice ahead of the ship (~0.3 km at a field's ~18 km/s — the whole
 *      standoff). Ruling: beforeSlice(h) runs first, at slice start.
 *  (b) FlightModel integrates in fixed substeps and carries the remainder
 *      (≤ 1/120 s): the ship's state is up to that far BEHIND the orbit clock
 *      (≤ 0.15 km at 18 km/s) on any display that is not a multiple of
 *      120 Hz. Ruling: everything that compares the ship with a Belt position
 *      (approach guidance and engage, Mining's gate, Targeting's range) uses
 *      the ship at orbit time: position + velocity × the time it is behind.
 *  (c) The stopgap option `orbitClockLeadsSlice` goes.
 *  (d) Pause suspends an approach (as auto-land); unpausing resumes it.
 *  (e) The approach counts as the autopilot flying (flightActivity).
 *  (f) Space during formation stops relative to the companion.
 *
 * "Truth" in these tests is the ship at orbit time, computed from the
 * FlightModel's own carry (its private accumulator), never from what the
 * module under test reads.
 *
 * Rigs: a REAL Universe (init → Fyss; its renderer-bound steps stubbed — the
 * slice loop, orbits and ship parenting are real) for the approach, and the
 * real Belt + FlightModel, run in Universe's order, for Mining and Targeting.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import type { ActionName, InputAxes } from '@/core/Input';
import { flightActivity } from '@/core/flightActivity';
import { FIELD_RADIUS_KM } from '@/gen/belt';
import { DEFAULT_SHIP_CONFIG, FlightModel } from '@/ship/FlightModel';
import { Cargo, CARGO_CAPACITY_KG } from '@/ship/cargo';
import { EXHAUST_VELOCITY_KMS, PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
import type { HudTarget } from '@/ui/Hud';
import { AutoPilot, type AutoPilotOptions } from './AutoPilot';
import { Belt, beltTargetName } from './Belt';
import { FlightSense, type FlightSenseOptions } from './FlightSense';
import { FLIGHT_PRESETS } from './flightPreset';
import { Mining, type MiningWorld } from './Mining';
import { Targeting, type TargetingOptions } from './Targeting';
import { Universe } from './Universe';
import { WorldState } from './worldState';
import { beltRig, fyssBelt, nodeCtx } from './testing/beltFixture';

const FIELD_K = 398;
const DROP_KM = FIELD_RADIUS_KM + 30;
const PARKED_LOG = 'PARKED · 0.3 KM — B TO MINE';
const LEG_LIMIT_S = 600;

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  bus.emit('target:changed', { id: null, name: null });
});

function facing(dir: Vector3): Quaternion {
  return new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir.clone().normalize());
}

/** Seconds the FlightModel's state is behind the clock it was advanced to (its carry). */
function carryS(fm: FlightModel): number {
  return (fm as unknown as { accumulator: number }).accumulator;
}

/** The ship's world position at ORBIT time (state + world velocity × carry). */
function shipAtOrbitTime(fm: FlightModel, parentWorldVel: Vector3 | null = null): Vector3 {
  const v = fm.velocity.clone();
  if (parentWorldVel) v.add(parentWorldVel);
  return fm.worldPosition.clone().addScaledVector(v, carryS(fm));
}

class StubInput {
  readonly axes: InputAxes = { pitch: 0, yaw: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0, strafeZ: 0 };
  readonly heldActions = new Set<ActionName>();
  readonly stickDeflection = { x: 0, y: 0 };
  private presses = new Set<ActionName>();
  press(a: ActionName): void {
    this.presses.add(a);
  }
  pressed(a: ActionName): boolean {
    return this.presses.has(a);
  }
  held(a: ActionName): boolean {
    return this.heldActions.has(a);
  }
  down(): boolean {
    return false;
  }
  isDown(): boolean {
    return false;
  }
  setThrottle(v: number): void {
    this.axes.throttle = v;
  }
  endFrame(): void {
    this.presses.clear();
  }
}

// ---------------------------------------------------------------------------
// A real Universe at field 398's drop point
// ---------------------------------------------------------------------------

/** Universe steps that need a GPU; everything else in update() runs for real. */
const RENDER_STEPS = ['streamRenderers', 'updateBodies', 'updateStar', 'publishMotionReference', 'refreshAtmosphere'];

/**
 * `trailing`: instead of the radial drop point, put the ship 40 km off the
 * first rock's surface straight BEHIND it along the field's motion, so the
 * line of sight runs along the orbit velocity and any clock skew between rock
 * and ship lands squarely on the standoff distance (and on the r + 0.2 km
 * margin) instead of off to the side.
 */
function universeRig(opts: { trailing?: boolean } = {}) {
  const input = new StubInput();
  const ctx = nodeCtx({ input });
  const u = new Universe();
  u.init(ctx);
  const raw = u as unknown as Record<string, unknown>;
  for (const k of RENDER_STEPS) raw[k] = () => undefined;

  const worldState = new WorldState({ orbitSeconds: () => u.orbitSeconds, wallMs: () => 1_700_000_000_000 });
  const belt = new Belt({ universe: u, worldState });
  belt.update(0, ctx);
  const fieldId = `field:${fyssBelt().systemId}:${FIELD_K}`;
  const centre = new Vector3();
  const fieldVel = new Vector3();
  expect(belt.fieldWorld(fieldId, centre)).toBe(true);
  expect(belt.fieldVelocity(fieldId, fieldVel)).toBe(true);

  // The star frame (fields have no SOI), co-moving ~30 km past the edge.
  (u as unknown as { setShipParent(b: null): void }).setShipParent(null);
  const fm = u.flight;
  const pos = centre.clone().add(centre.clone().normalize().multiplyScalar(DROP_KM));
  fm.teleport(pos, fieldVel, facing(centre.clone().sub(pos)));
  if (!fm.propellant) fm.attachPropellant(new Propellant(PROBE_TANK_CAPACITY_KG, 0.6), EXHAUST_VELOCITY_KMS);
  fm.flightAssist = true;
  belt.update(0, ctx);
  const rockId = belt.firstRockTarget(fieldId, fm.worldPosition)!;
  expect(rockId).not.toBeNull();
  if (opts.trailing) {
    const rw = new Vector3();
    expect(belt.asteroidWorld(rockId, rw)).toBe(true);
    const back = fieldVel.clone().normalize().multiplyScalar(-(belt.asteroidSpec(rockId)!.radiusKm + 40));
    const p2 = rw.clone().add(back);
    fm.teleport(p2, fieldVel, facing(rw.clone().sub(p2)));
    belt.update(0, ctx);
  }

  const warp = { phase: 'idle' };
  const targeting = { targetId: null as string | null };
  offs.push(bus.on('target:changed', (e) => (targeting.targetId = e.id)));
  const ap = new AutoPilot({
    universe: u,
    warp,
    cruise: { busy: false },
    preset: () => FLIGHT_PRESETS.survey,
    belt,
  } as AutoPilotOptions);
  ap.init();
  offs.push(() => ap.dispose());
  u.beforeSlice = (h) => ap.sliceStep(h);

  const noop = (): void => undefined;
  const fs = new FlightSense({
    universe: u,
    cruise: { drive: { phase: 'idle', capKmS: 0 } },
    traffic: { loudest: () => null, vesselVelocity: () => false, vesselWorld: () => false },
    targeting,
    audio: { setCruise: noop, setRcs: noop, setVesselProximity: noop, setHullStress: noop },
    sky: { setDriveField: noop },
    belt,
  } as unknown as FlightSenseOptions);
  fs.update(0, ctx);

  const logs: string[] = [];
  offs.push(bus.on('log', ({ text }) => logs.push(text)));

  const r = {
    u,
    fm,
    ap,
    belt,
    input,
    logs,
    fieldId,
    /** One engine frame of `dt` in registry order: Universe (slices), Pilot, Belt, AutoPilot, FlightSense. */
    frame(dt: number): void {
      u.update(dt, ctx);
      fm.applyInput(input.axes, input.held('boost'), input.held('brake'));
      belt.update(dt, ctx);
      ap.update(dt, ctx);
      fs.update(dt, ctx);
      input.endFrame();
    },
    /** The rock a field arrival targets from the drop point (Cruise: Belt.firstRockTarget). */
    firstRock(): string {
      return rockId;
    },
    /** Surface distance, centre distance, radius and relative speed — the ship at ORBIT time. */
    rock(id: string) {
      const w = new Vector3();
      const v = new Vector3();
      expect(belt.asteroidWorld(id, w)).toBe(true);
      expect(belt.asteroidVelocity(id, v)).toBe(true);
      const radiusKm = belt.asteroidSpec(id)!.radiusKm;
      const centreKm = w.distanceTo(shipAtOrbitTime(fm));
      return { surfaceKm: centreKm - radiusKm, centreKm, radiusKm, relKmS: fm.velocity.clone().sub(v).length() };
    },
  };
  return r;
}

type URig = ReturnType<typeof universeRig>;

/** Frame-time sequences: dt for frame i. */
const RATES: Array<[string, (i: number) => number, number]> = [
  ['60 Hz', () => 1 / 60, 1],
  ['144 Hz', () => 1 / 144, 1],
  ['uneven (alternating 1/50 s and 1/90 s)', (i) => (i % 2 === 0 ? 1 / 50 : 1 / 90), 1],
  ['10× time at 60 Hz', () => 1 / 60, 10],
];

/** L on the first rock, then fly until PARKED (or the limit). */
function flyToPark(r: URig, dtOf: (i: number) => number, rate: number) {
  const id = r.firstRock();
  bus.emit('target:changed', { id, name: beltTargetName(id) });
  r.input.press('land');
  r.frame(dtOf(0));
  expect(r.ap.active, `L did not engage: ${r.logs.join(' | ')}`).toBe(true);
  r.u.simRate = rate as typeof r.u.simRate;
  const start = r.rock(id);
  let closestCentreKm = Number.POSITIVE_INFINITY;
  let t = 0;
  for (let i = 1; t < LEG_LIMIT_S && !r.logs.includes(PARKED_LOG); i++) {
    const dt = dtOf(i);
    r.frame(dt);
    t += dt * rate;
    closestCentreKm = Math.min(closestCentreKm, r.rock(id).centreKm);
  }
  r.u.simRate = 1 as typeof r.u.simRate;
  return { id, start, closestCentreKm, end: r.rock(id) };
}

describe('one clock: Universe runs slice guidance at slice start (ruling a)', () => {
  it('Given a real Universe, When a frame runs at 1× and at 10×, Then beforeSlice(h) sees the orbit clock at the START of its slice (not already advanced by h)', () => {
    const r = universeRig();
    const seen: Array<{ at: number; h: number }> = [];
    r.u.beforeSlice = (h) => seen.push({ at: r.u.orbitSeconds, h });
    const t0 = r.u.orbitSeconds;
    r.u.update(1 / 60, nodeCtx());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.at).toBeCloseTo(t0, 12);

    seen.length = 0;
    r.u.simRate = 10 as typeof r.u.simRate;
    const t1 = r.u.orbitSeconds;
    r.u.update(1 / 60, nodeCtx());
    expect(seen.length).toBeGreaterThan(1);
    let at = t1;
    for (const s of seen) {
      expect(s.at).toBeCloseTo(at, 12);
      at += s.h;
    }
    expect(r.u.orbitSeconds).toBeCloseTo(at, 12);
  });
});

describe('one clock: L parks at the same place at any frame rate (real Universe slice loop)', () => {
  for (const [label, dtOf, rate] of RATES) {
    it(`Given L on the first rock from 40 km straight behind it along the orbit at ${label}, Then it parks 0.25–0.35 km off the surface (ship at orbit time), < 0.002 km/s relative, never within r + 0.2 km`, () => {
      const r = universeRig({ trailing: true });
      const leg = flyToPark(r, dtOf, rate);
      expect(r.logs, `no PARKED within ${LEG_LIMIT_S} s`).toContain(PARKED_LOG);
      expect(leg.end.surfaceKm).toBeGreaterThanOrEqual(0.25);
      expect(leg.end.surfaceKm).toBeLessThanOrEqual(0.35);
      expect(leg.end.relKmS).toBeLessThan(0.002);
      expect(leg.closestCentreKm).toBeGreaterThanOrEqual(leg.start.radiusKm + 0.2);
    });
  }
});

describe('one clock: pause, activity', () => {
  it('Given an approach under way, When the game is paused (frozen) for 2 s and resumed, Then the approach is suspended, not dropped, and still parks within 0.25–0.35 km', () => {
    const r = universeRig();
    const id = r.firstRock();
    bus.emit('target:changed', { id, name: beltTargetName(id) });
    r.input.press('land');
    r.frame(1 / 60);
    for (let i = 0; i < 300; i++) r.frame(1 / 60);
    expect(r.ap.active).toBe(true);
    const before = r.rock(id).surfaceKm;
    r.u.frozen = true;
    for (let i = 0; i < 120; i++) r.frame(1 / 60);
    expect(r.ap.active).toBe(true);
    expect(r.logs).not.toContain('AUTOPILOT DISENGAGED');
    expect(Math.abs(r.rock(id).surfaceKm - before)).toBeLessThan(1e-6);
    r.u.frozen = false;
    for (let t = 0; t < LEG_LIMIT_S && !r.logs.includes(PARKED_LOG); t += 1 / 60) r.frame(1 / 60);
    expect(r.logs).toContain(PARKED_LOG);
    const end = r.rock(id);
    expect(end.surfaceKm).toBeGreaterThanOrEqual(0.25);
    expect(end.surfaceKm).toBeLessThanOrEqual(0.35);
  });

  it('Given an approach under way, Then flightActivity.autopilot is true (the governor and camera see the autopilot flying); after PARKED it is false', () => {
    const r = universeRig();
    const id = r.firstRock();
    bus.emit('target:changed', { id, name: beltTargetName(id) });
    r.input.press('land');
    r.frame(1 / 60);
    r.frame(1 / 60);
    expect(r.ap.active).toBe(true);
    expect(flightActivity.autopilot).toBe(true);
    for (let t = 0; t < LEG_LIMIT_S && !r.logs.includes(PARKED_LOG); t += 1 / 60) r.frame(1 / 60);
    r.frame(1 / 60);
    expect(flightActivity.autopilot).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mining and Targeting at 144 Hz: the carry must not move the gates
// ---------------------------------------------------------------------------

/**
 * The ship coasting co-moving with a rock, `km` off its surface, on the side
 * `side` (+1: ahead of the rock along the field's motion, −1: trailing),
 * stepped in Universe's order (clock, then physics) at 144 Hz.
 */
function coastRig(km: number, side: 1 | -1) {
  const b = beltRig();
  b.frame();
  const field = b.belt.nearestField()!;
  const ast = field.asteroids[0]!;
  const w = new Vector3();
  const v = new Vector3();
  expect(b.belt.asteroidWorld(ast.id, w)).toBe(true);
  expect(b.belt.asteroidVelocity(ast.id, v)).toBe(true);
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: fyssBelt().starMu });
  const pos = w.clone().addScaledVector(v.clone().normalize(), side * (ast.radiusKm + km));
  fm.teleport(pos, v, facing(w.clone().sub(pos)));
  fm.attachPropellant(new Propellant(PROBE_TANK_CAPACITY_KG, 0.6), EXHAUST_VELOCITY_KMS);
  b.world.flight.worldPosition.copy(fm.worldPosition);
  b.frame();
  const truthSurfaceKm = (): number => {
    b.belt.asteroidWorld(ast.id, w);
    return w.distanceTo(shipAtOrbitTime(fm)) - ast.radiusKm;
  };
  const step = (dt: number): void => {
    b.world.orbitSeconds += dt; // Universe: the clock…
    fm.update(dt); // …then the physics, which carries the remainder
    b.world.flight.worldPosition.copy(fm.worldPosition);
    b.frame();
  };
  return { b, fm, ast, step, truthSurfaceKm };
}

function miningOn(rig: ReturnType<typeof coastRig>) {
  const world = {
    paused: false,
    frozen: false,
    simulatedSeconds: 1 / 144,
    cargo: new Cargo(CARGO_CAPACITY_KG),
    flight: rig.fm,
    shipParent: null,
  } as unknown as MiningWorld;
  const mining = new Mining({
    universe: world,
    belt: rig.b.belt,
    worldState: rig.b.worldState,
    targeting: { targetId: rig.ast.id },
    cruise: { busy: false },
    warp: { phase: 'idle' },
  });
  const ctx = { input: { pressed: () => false }, elapsed: 0 } as unknown as EngineContext;
  mining.init?.(ctx);
  offs.push(() => mining.dispose?.());
  return { mining, ctx };
}

describe('one clock: Mining’s range gate does not move with the physics carry (144 Hz)', () => {
  it('Given a ship coasting 0.45 km off a rock’s surface, trailing it along the orbit, Then Mining sees it IN RANGE on every frame at 144 Hz', () => {
    const rig = coastRig(0.45, -1);
    const { mining, ctx } = miningOn(rig);
    let carrySeen = 0;
    const out: number[] = [];
    for (let i = 0; i < 288; i++) {
      rig.step(1 / 144);
      mining.update(1 / 144, ctx);
      carrySeen = Math.max(carrySeen, carryS(rig.fm));
      expect(Math.abs(rig.truthSurfaceKm() - 0.45)).toBeLessThan(0.01);
      if (!mining.asteroidInRange) out.push(i);
    }
    expect(carrySeen, 'the rig never carried time — not a 144 Hz test').toBeGreaterThan(1 / 400);
    expect(out, 'frames on which a ship 0.45 km off the surface read OUT OF RANGE').toEqual([]);
  });

  it('Given a ship coasting 0.55 km off a rock’s surface, ahead of it along the orbit, Then Mining sees it OUT OF RANGE on every frame at 144 Hz', () => {
    const rig = coastRig(0.55, 1);
    const { mining, ctx } = miningOn(rig);
    const wrong: number[] = [];
    for (let i = 0; i < 288; i++) {
      rig.step(1 / 144);
      mining.update(1 / 144, ctx);
      expect(Math.abs(rig.truthSurfaceKm() - 0.55)).toBeLessThan(0.01);
      if (mining.asteroidInRange) wrong.push(i);
    }
    expect(wrong, 'frames on which a ship 0.55 km off the surface read IN RANGE').toEqual([]);
  });
});

describe('one clock: Targeting’s range to a rock does not move with the physics carry (144 Hz)', () => {
  for (const [km, side] of [
    [0.45, -1],
    [0.55, 1],
  ] as const) {
    it(`Given a ship coasting ${km} km off the targeted rock’s surface (${side < 0 ? 'trailing' : 'ahead'}), Then the HUD range reads ${km} km (± 0.01) on every frame at 144 Hz`, () => {
      const rig = coastRig(km, side);
      const hudLog: HudTarget[] = [];
      const universe = {
        paused: false,
        flight: rig.fm,
        shipParent: null,
        system: rig.b.world.system,
        orbitSeconds: 0,
        allBodies: () => [],
      };
      const targeting = new Targeting({
        universe,
        traffic: null,
        hud: { setTarget: (t: HudTarget | null) => t && hudLog.push({ ...t }), setContacts: () => undefined },
        belt: rig.b.belt,
      } as unknown as TargetingOptions);
      offs.push(() => targeting.dispose());
      const ctx = nodeCtx({ input: { pressed: () => false, down: () => false } });
      targeting.init(ctx);
      bus.emit('target:changed', { id: rig.ast.id, name: null });
      const bad: Array<[number, number]> = [];
      for (let i = 0; i < 288; i++) {
        rig.step(1 / 144);
        targeting.update(1 / 144, ctx);
        const h = hudLog[hudLog.length - 1];
        expect(h?.id).toBe(rig.ast.id);
        if (Math.abs(h!.distanceKm - km) > 0.01) bad.push([i, h!.distanceKm]);
      }
      expect(bad.slice(0, 5), `${bad.length} frames off by > 10 m`).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// (c) the stopgap is gone; (f) Space in formation
// ---------------------------------------------------------------------------

describe('one clock: no stopgap', () => {
  it('Given the source tree, Then no module mentions `orbitClockLeadsSlice`', () => {
    const root = fileURLToPath(new URL('../', import.meta.url)); // src/
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && readFileSync(p, 'utf8').includes('orbitClockLeadsSlice')) {
          hits.push(relative(root, p));
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});

describe('formation: Space stops relative to the companion (ruling R-rocks a, pinned)', () => {
  it('Given FA on and a formation reference, When Space is held for 20 s, Then the ship ends at the reference velocity (not at rest in the parent frame)', () => {
    offs.push(bus.on('log', () => undefined));
    const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
    fm.flightAssist = true;
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0 });
    fm.teleport(new Vector3(), new Vector3(0.3, 0, 0.2), new Quaternion());
    const ref = new Vector3(0.1, -0.05, 0);
    fm.assistReferenceVelocity = ref;
    fm.command.brake = true;
    for (let i = 0; i < 20 * 120; i++) fm.update(1 / 120);
    expect(fm.assistState).toBe('stop');
    expect(fm.velocity.distanceTo(ref)).toBeLessThan(1e-3);
  });
});
