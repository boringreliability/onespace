/**
 * v4 mining — L parks you at a rock (owner playtest, binding decision 3).
 *
 * With an ASTEROID targeted (not landed, not in cruise or a jump), L starts an
 * approach autopilot instead of auto-land: it flies to APPROACH_STANDOFF_KM
 * (0.3 km) off the rock's SURFACE along the line of sight, on a speed profile
 * relative to the rock of min(APPROACH_MAX_KMS = 0.5, √(2·a·d)) — a = the
 * hull's delivered braking acceleration (with margin, × massScaleNow) — and
 * ends with relative speed < 0.002 km/s. It logs `APPROACH — <ROCK NAME>` at
 * the start and `PARKED · 0.3 KM — B TO MINE` on arrival, after which mayMine
 * passes (0.5 km, 0.005 km/s). Real thrust: propellant is consumed. It never
 * passes through the rock (centre distance ≥ radius + 0.2 km throughout).
 * The pilot always wins, as with the landing autopilot: stick input, a
 * target change or a jump disengage it. Planet targets still auto-land.
 *
 * Hand-back (this file's reading of "holds there"): on arrival the computer
 * hands back with FA as the pilot had it and the lever at its detent; the
 * field frame (fieldFrame.test.ts) then holds the ship on the field, which
 * the rocks share — so the ship stays parked without anyone writing a second
 * FA reference.
 *
 * World: the real start system (Fyss), field 398 on a live orbit clock, a
 * real Belt, a real FlightModel parented to the star (as after a field drop)
 * with a real tank, and the real AutoPilot + FlightSense in registry order.
 * AutoPilot learns the target from `target:changed`, as Cruise does.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import type { ActionName, InputAxes } from '@/core/Input';
import { FIELD_RADIUS_KM } from '@/gen/belt';
import { SOLAR_RADIUS } from '@/gen/types';
import { DEFAULT_SHIP_CONFIG, FlightModel, type ParentBody } from '@/ship/FlightModel';
import { EXHAUST_VELOCITY_KMS, PROBE_TANK_CAPACITY_KG, Propellant, START_FILL } from '@/ship/propellant';
import { beltTargetName } from '@/game/Belt';
import { mayMine } from '@/game/miningRules';
import { beltRig, fieldCentre, fieldVelocity, fyssBelt, fyssField, startSystem } from '@/game/testing/beltFixture';
import { AUTOPILOT_DISENGAGED, AUTOPILOT_PROPELLANT_LOW, AutoPilot, type AutoPilotOptions, type AutoPilotWorld } from './AutoPilot';
import { FlightSense, type FlightSenseOptions } from './FlightSense';
import { FLIGHT_PRESETS } from './flightPreset';

const H = 1 / 60;
const FIELD_K = 398;
/** Where a field drop leaves the ship: ~30 km past the edge (Cruise.field.test.ts). */
const DROP_KM = FIELD_RADIUS_KM + 30;
/** Owner decision 3. */
const APPROACH_STANDOFF_KM = 0.3;
const APPROACH_MAX_KMS = 0.5;
const PARKED_LOG = 'PARKED · 0.3 KM — B TO MINE';
/** Generous: ≤ ~190 km at ≤ 0.5 km/s is ≤ ~400 s; the leg must end well inside this. */
const LEG_LIMIT_S = 900;

class StubInput {
  readonly axes: InputAxes = { pitch: 0, yaw: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0, strafeZ: 0 };
  readonly down = new Set<string>();
  readonly heldActions = new Set<ActionName>();
  private presses = new Set<ActionName>();
  lever = 0;
  press(a: ActionName): void {
    this.presses.add(a);
  }
  pressed(a: ActionName): boolean {
    return this.presses.has(a);
  }
  held(a: ActionName): boolean {
    return this.heldActions.has(a);
  }
  isDown(code: string): boolean {
    return this.down.has(code);
  }
  setThrottle(v: number): void {
    this.lever = v;
    this.axes.throttle = v;
  }
  endFrame(): void {
    this.presses.clear();
  }
}

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  bus.emit('target:changed', { id: null, name: null });
});

function facing(dir: Vector3): Quaternion {
  return new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir.clone().normalize());
}

/** The ship at field 398's drop point, co-moving, FA on, a real tank; AutoPilot + FlightSense wired. */
function approachRig(opts: { tankKg?: number } = {}) {
  const sys = startSystem();
  const field = fyssField(FIELD_K);
  const starR = sys.stars[0]!.radius * SOLAR_RADIUS;
  const b = beltRig(sys);

  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  const star: ParentBody = { position: new Vector3(), velocity: new Vector3(), mu: fyssBelt().starMu, radius: starR };
  fm.setParent(star);
  const centre0 = fieldCentre(field, 0);
  const pos = centre0.clone().add(centre0.clone().normalize().multiplyScalar(DROP_KM));
  fm.teleport(pos, fieldVelocity(field, 0), facing(centre0.clone().sub(pos)));
  fm.attachPropellant(new Propellant(PROBE_TANK_CAPACITY_KG, START_FILL), EXHAUST_VELOCITY_KMS);
  if (opts.tankKg !== undefined) fm.propellant!.massKg = opts.tankKg;
  fm.flightAssist = true;

  // One stub of Universe for both modules: the star frame (no parent body).
  const world = { flight: fm, paused: false, frozen: false, shipParent: null };
  const warp = { phase: 'idle' };
  const cruise = { busy: false };
  const targeting = { targetId: null as string | null };
  offs.push(bus.on('target:changed', (e) => (targeting.targetId = e.id)));

  const ap = new AutoPilot({
    universe: world as unknown as AutoPilotWorld,
    warp,
    cruise,
    preset: () => FLIGHT_PRESETS.survey,
    belt: b.belt,
  } as AutoPilotOptions);
  ap.init();
  offs.push(() => ap.dispose());

  const noop = (): void => undefined;
  const fs = new FlightSense({
    universe: world,
    cruise: { drive: { phase: 'idle', capKmS: 0 } },
    traffic: { loudest: () => null, vesselVelocity: () => false, vesselWorld: () => false },
    targeting,
    audio: { setCruise: noop, setRcs: noop, setVesselProximity: noop, setHullStress: noop },
    sky: { setDriveField: noop },
    belt: b.belt,
  } as unknown as FlightSenseOptions);

  const input = new StubInput();
  const ctx = { input, elapsed: 0 } as unknown as EngineContext;
  const logs: string[] = [];
  offs.push(bus.on('log', ({ text }) => logs.push(text)));

  b.world.flight.worldPosition.copy(fm.worldPosition);
  b.frame();
  fs.update(H, ctx);

  const r = {
    fm,
    ap,
    b,
    field,
    warp,
    input,
    logs,
    /** One engine frame in registry order: Universe (slices), Pilot, Belt, AutoPilot, FlightSense. */
    tick(n = 1): void {
      for (let i = 0; i < n; i++) {
        ap.sliceStep(H);
        fm.update(H);
        b.world.orbitSeconds += H;
        fm.applyInput(input.axes, input.held('boost'), input.held('brake'));
        b.world.flight.worldPosition.copy(fm.worldPosition);
        b.frame();
        ap.update(H, ctx);
        fs.update(H, ctx);
        input.endFrame();
      }
    },
    /** The rock a field arrival targets (Cruise: Belt.firstRockTarget). */
    firstRock(): string {
      const id = b.belt.firstRockTarget(field.id, fm.worldPosition);
      expect(id).not.toBeNull();
      return id!;
    },
    target(id: string | null): void {
      bus.emit('target:changed', { id, name: id ? beltTargetName(id) : null });
    },
    /** Surface distance, centre distance, radius and |v_ship − v_rock| for a rock, now. */
    rock(id: string) {
      const w = new Vector3();
      const v = new Vector3();
      expect(b.belt.asteroidWorld(id, w)).toBe(true);
      expect(b.belt.asteroidVelocity(id, v)).toBe(true);
      const radiusKm = b.belt.asteroidSpec(id)!.radiusKm;
      const centreKm = w.distanceTo(fm.worldPosition);
      return { surfaceKm: centreKm - radiusKm, centreKm, radiusKm, relKmS: fm.velocity.clone().sub(v).length() };
    },
    gate(id: string) {
      const k = r.rock(id);
      return mayMine({
        paused: false,
        frozen: false,
        cruise: fm.cruising,
        warpPhase: warp.phase,
        targetIsAsteroid: true,
        surfaceRangeKm: k.surfaceKm,
        relSpeedKmS: k.relKmS,
        holdFreeKg: 10_000,
        remainingKg: 10_000,
      });
    },
  };
  return r;
}

type Rig = ReturnType<typeof approachRig>;

function engageOn(r: Rig, id: string): void {
  r.target(id);
  r.input.press('land');
  r.tick();
}

describe('L with an asteroid targeted: the approach autopilot', () => {
  it('Given a field drop and a rock targeted, When L, Then the approach autopilot engages (not auto-land, no NO WORLD refusal) and logs `APPROACH — <ROCK NAME>`', () => {
    const r = approachRig();
    const id = r.firstRock();
    engageOn(r, id);
    expect(r.logs).not.toContain('AUTOPILOT DENIED — NO WORLD IN RANGE');
    expect(r.ap.active).toBe(true);
    expect(r.ap.goal as string).toBe('approach');
    expect(r.logs).toContain(`APPROACH — ${beltTargetName(id)!.toUpperCase()}`);
  });

  it('Given L on a rock from the drop point, Then it parks 0.3 km off the surface (within [0.25, 0.35]) at < 0.002 km/s relative, never closer than radius + 0.2 km, never faster than 0.5 km/s relative, logs PARKED, burns propellant, and mayMine passes', () => {
    const r = approachRig();
    const id = r.firstRock();
    const start = r.rock(id);
    expect(start.surfaceKm, 'the drop leaves the first rock tens of km away').toBeGreaterThan(5);
    const tank0 = r.fm.propellant!.massKg;
    engageOn(r, id);
    expect(r.ap.active).toBe(true);

    let closestCentreKm = Number.POSITIVE_INFINITY;
    let fastestKmS = 0;
    let t = 0;
    while (!r.logs.includes(PARKED_LOG) && t < LEG_LIMIT_S) {
      r.tick();
      t += H;
      const k = r.rock(id);
      closestCentreKm = Math.min(closestCentreKm, k.centreKm);
      fastestKmS = Math.max(fastestKmS, k.relKmS);
    }
    expect(r.logs, `no "${PARKED_LOG}" within ${LEG_LIMIT_S} s`).toContain(PARKED_LOG);
    const end = r.rock(id);
    expect(end.surfaceKm).toBeGreaterThanOrEqual(APPROACH_STANDOFF_KM - 0.05);
    expect(end.surfaceKm).toBeLessThanOrEqual(APPROACH_STANDOFF_KM + 0.05);
    expect(end.relKmS).toBeLessThan(0.002);
    expect(closestCentreKm).toBeGreaterThanOrEqual(start.radiusKm + 0.2);
    expect(fastestKmS).toBeLessThanOrEqual(APPROACH_MAX_KMS * 1.05);
    expect(r.fm.propellant!.massKg).toBeLessThan(tank0);
    expect(r.gate(id)).toEqual({ ok: true });
  });

  it('Given the ship parked by L, Then the computer has handed back (FA as before, lever at the detent) and the ship stays parked for 30 s hands-off — mayMine still passes', () => {
    const r = approachRig();
    const id = r.firstRock();
    engageOn(r, id);
    for (let t = 0; t < LEG_LIMIT_S && !r.logs.includes(PARKED_LOG); t += H) r.tick();
    expect(r.logs).toContain(PARKED_LOG);
    r.tick();
    expect(r.ap.active).toBe(false);
    expect(r.fm.flightAssist).toBe(true);
    expect(r.input.axes.throttle).toBe(0);
    r.tick(30 * 60);
    const k = r.rock(id);
    expect(k.surfaceKm).toBeGreaterThanOrEqual(0.2);
    expect(k.surfaceKm).toBeLessThanOrEqual(0.4);
    expect(r.gate(id)).toEqual({ ok: true });
  });
});

describe('the approach: the pilot always wins', () => {
  it('Given an approach under way, When the stick is deflected, Then it disengages that frame with AUTOPILOT DISENGAGED', () => {
    const r = approachRig();
    engageOn(r, r.firstRock());
    r.tick(120);
    expect(r.ap.active).toBe(true);
    r.input.axes.pitch = 0.5;
    r.tick();
    expect(r.ap.active).toBe(false);
    expect(r.logs).toContain(AUTOPILOT_DISENGAGED);
  });

  it('Given an approach under way, When the target changes (another rock, or none), Then it disengages', () => {
    const r = approachRig();
    const id = r.firstRock();
    engageOn(r, id);
    r.tick(120);
    expect(r.ap.active).toBe(true);
    const other = r.field.asteroids.find((a) => a.id !== id)!.id;
    r.target(other);
    r.tick();
    expect(r.ap.active).toBe(false);
    expect(r.logs).toContain(AUTOPILOT_DISENGAGED);

    const r2 = approachRig();
    engageOn(r2, r2.firstRock());
    r2.tick(60);
    expect(r2.ap.active).toBe(true);
    r2.target(null);
    r2.tick();
    expect(r2.ap.active).toBe(false);
  });

  it('Given an approach under way, When a jump starts, Then it disengages', () => {
    const r = approachRig();
    engageOn(r, r.firstRock());
    r.tick(60);
    expect(r.ap.active).toBe(true);
    r.warp.phase = 'spooling';
    r.tick();
    expect(r.ap.active).toBe(false);
  });

  it('Given a nearly empty tank (1 kg), When L on a rock, Then it refuses with AUTOPILOT · PROPELLANT LOW and nothing engages', () => {
    const r = approachRig({ tankKg: 1 });
    engageOn(r, r.firstRock());
    expect(r.ap.active).toBe(false);
    expect(r.logs).toContain(AUTOPILOT_PROPELLANT_LOW);
    expect(r.logs.some((l) => l.startsWith('APPROACH —'))).toBe(false);
  });
});

describe('L with a planet targeted still auto-lands', () => {
  it('Given orbit around a world with that world targeted (and the Belt wired), When L, Then it engages a LANDING, not an approach', () => {
    const R = 1_000;
    const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
    const frame = { position: new Vector3(), velocity: new Vector3(), mu: 1_500, radius: R };
    fm.setParent(frame);
    fm.setGroundSampler((p) => p.length() - R);
    fm.flightAssist = true;
    const p = new Vector3(1.6 * R, 0, 0);
    fm.teleport(p, fm.orbitalVelocityAt(p), new Quaternion());
    fm.update(H);
    const world = { flight: fm, paused: false, frozen: false, shipParent: { spec: { name: 'Fyss I', radius: R, atmosphere: null }, frame } };
    const ap = new AutoPilot({
      universe: world,
      warp: { phase: 'idle' },
      cruise: { busy: false },
      preset: () => FLIGHT_PRESETS.survey,
      belt: beltRig().belt,
    } as AutoPilotOptions);
    ap.init();
    offs.push(() => ap.dispose());
    const logs: string[] = [];
    offs.push(bus.on('log', ({ text }) => logs.push(text)));
    bus.emit('target:changed', { id: 'body:Fyss I', name: 'Fyss I' });
    const input = new StubInput();
    input.press('land');
    ap.sliceStep(H);
    fm.update(H);
    fm.applyInput(input.axes, false, false);
    ap.update(H, { input, elapsed: 0 } as unknown as EngineContext);
    expect(ap.active).toBe(true);
    expect(ap.goal).toBe('land');
    expect(logs).toContain('AUTOPILOT ENGAGED — LANDING ON FYSS I');
    expect(logs.some((l) => l.startsWith('APPROACH —'))).toBe(false);
  });
});
