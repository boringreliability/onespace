/**
 * v4 sub-plan 2 (mining), Task 7 — cruise to a belt field.
 *
 * Selecting the BELT node on the system chart locks `field:<system>:<k>`.
 * Cruise must close on it like on a body of radius FIELD_RADIUS_KM: resolve
 * the id through the Belt (`new Cruise({ universe, belt })`, the Belt's
 * `fieldWorld`), steer to the limb of its arrival sphere, and drop for
 * ARRIVAL when the gap to the field's EDGE falls below
 * `arrivalClearanceKm(FIELD_RADIUS_KM)` — outside the cluster, never in its
 * middle. A field is not a mass, so `nearestGapKm` (bodies and the star) does
 * not slow the drive near it; the field's own gap must, or the drive (whose
 * ceiling is ~0.35 × clearance, here ~10^7 km/s) steps straight through it.
 *
 * World: the real start system (Fyss), the ship 200 000 km off field 398 in
 * the star's frame (no planet near), a real Belt and a real FlightModel. The
 * world stub is the handful of `Universe` members Cruise reads, as in
 * `Cruise.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import type { ActionName } from '@/core/Input';
import { FIELD_RADIUS_KM } from '@/gen/belt';
import { SOLAR_RADIUS } from '@/gen/types';
import { CRUISE_DEFAULTS, arrivalClearanceKm, cruiseCapKmS, holdClearanceKm } from '@/ship/CruiseDrive';
import { noseErrorRad } from '@/ship/cruiseSteer';
import { DEFAULT_SHIP_CONFIG, FlightModel, type ParentBody } from '@/ship/FlightModel';
import { beltRig, fieldCentre, fieldVelocity, fyssBelt, fyssField, startSystem } from '@/game/testing/beltFixture';
import { Cruise, type CruiseWorld } from './Cruise';

const H = 1 / 60;
const FIELD_K = 398;
const START_GAP_KM = 200_000;

/** Centre distance at which a field arrival drops: its edge plus the arrival clearance. */
const ARRIVE_CENTRE_KM = FIELD_RADIUS_KM + arrivalClearanceKm(FIELD_RADIUS_KM);

function facing(dir: Vector3): Quaternion {
  return new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir.clone().normalize());
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  bus.emit('target:changed', { id: null, name: null });
});

interface FieldRig {
  cruise: Cruise;
  flight: FlightModel;
  centre: Vector3;
  fieldId: string;
  axes: { pitch: number; yaw: number; roll: number; throttle: number; strafeX: number; strafeY: number; strafeZ: number };
  press: Set<ActionName>;
  brake: boolean;
  logs: string[];
  step: (seconds?: number) => void;
  /** The field centre on the rig's clock now (= `centre` unless `liveClock`). */
  centreNow: () => Vector3;
  /** The field centre's velocity (star frame, km/s) on the rig's clock now. */
  fieldVelNow: () => Vector3;
}

interface FieldRigOptions {
  /** Pass the Belt to Cruise (default true). */
  readonly withBelt?: boolean;
  /** A planet this far beyond the field (on the far side from the ship), km centre to centre. */
  readonly planetBeyondKm?: number;
  /** Where the ship starts, relative to the field centre (default +Y × START_GAP_KM). */
  readonly offset?: Vector3;
  /**
   * Advance the orbit clock with the sim (the field moves at its orbital
   * speed), and start the ship co-moving with the field. Default false: the
   * clock stays at t = 0 and the field stands still.
   */
  readonly liveClock?: boolean;
}

const PLANET_R = 7_240;

/** The ship `START_GAP_KM` above field 398 (along +Y), nose `nose`. */
function fieldRig(nose: (toField: Vector3) => Vector3, opts: FieldRigOptions = {}): FieldRig {
  const withBelt = opts.withBelt ?? true;
  const sys = startSystem();
  const field = fyssField(FIELD_K);
  const centre = fieldCentre(field, 0);
  const starR = sys.stars[0]!.radius * SOLAR_RADIUS;

  const star: ParentBody = { position: new Vector3(), velocity: new Vector3(), mu: fyssBelt().starMu, radius: starR };
  const flight = new FlightModel(DEFAULT_SHIP_CONFIG);
  flight.setParent(star);
  const pos = centre.clone().add(opts.offset ?? new Vector3(0, START_GAP_KM, 0));
  const v0 = opts.liveClock ? fieldVelocity(field, 0) : new Vector3();
  flight.teleport(pos, v0, facing(nose(centre.clone().sub(pos))));

  // Optional planet beyond the field: the nearest body, farther than the field.
  const planet =
    opts.planetBeyondKm === undefined
      ? null
      : (() => {
          const at = centre.clone().add(new Vector3(0, -opts.planetBeyondKm!, 0));
          const frame: ParentBody = { position: at, velocity: new Vector3(), mu: 9.8e-3 * PLANET_R * PLANET_R, radius: PLANET_R };
          return { spec: { id: 'body:Far World', name: 'Far World', radius: PLANET_R }, world: at, frame, soiRadius: 5e5, parent: null };
        })();
  const gapOf = (p: Vector3): number =>
    Math.min(p.length() - starR, planet ? p.distanceTo(planet.world) - PLANET_R : Number.POSITIVE_INFINITY);

  const world = {
    flight,
    paused: false,
    frozen: false,
    nearestGapKm: gapOf(pos),
    nearest: planet,
    allBodies: () => (planet ? [planet] : []),
    system: sys,
  } as unknown as CruiseWorld;

  // The real Belt, on the same clock (t = 0) the field centre was taken at.
  const b = beltRig(sys);
  b.world.flight.worldPosition.copy(pos);
  b.frame();

  const cruise = withBelt ? new Cruise({ universe: world, belt: b.belt }) : new Cruise({ universe: world });
  cruise.init();

  const axes = { pitch: 0, yaw: 0, roll: 0, throttle: 1, strafeX: 0, strafeY: 0, strafeZ: 0 };
  const press = new Set<ActionName>();
  const logs: string[] = [];
  const offLog = bus.on('log', (e) => logs.push(e.text));
  let elapsed = 0;
  const ctx = {
    input: { axes, pressed: (a: ActionName) => press.has(a), held: () => false },
    get elapsed() {
      return elapsed;
    },
  } as unknown as EngineContext;

  const r: FieldRig = {
    cruise,
    flight,
    centre,
    fieldId: field.id,
    axes,
    press,
    brake: false,
    logs,
    centreNow: () => {
      const out = new Vector3();
      b.belt.fieldWorld(field.id, out);
      return out;
    },
    fieldVelNow: () => {
      const out = new Vector3();
      b.belt.fieldVelocity(field.id, out);
      return out;
    },
    step: (seconds = H) => {
      for (let t = 0; t < seconds - 1e-9; t += H) {
        if (opts.liveClock) b.world.orbitSeconds += H;
        flight.update(H); // Universe
        (world as { nearestGapKm: number }).nearestGapKm = gapOf(flight.worldPosition);
        b.world.flight.worldPosition.copy(flight.worldPosition);
        b.frame();
        flight.applyInput(axes, false, r.brake); // Pilot
        cruise.update(H, ctx);
        press.clear();
        elapsed += H;
      }
    },
  };
  cleanup = () => {
    cruise.dispose();
    offLog();
  };
  return r;
}

describe('cruise to a belt field', () => {
  it('Given G (cruise) toward a field target, Then the drop distance respects FIELD_RADIUS_KM (no drop into the cluster’s middle)', () => {
    const r = fieldRig((toField) => toField);
    bus.emit('target:changed', { id: r.fieldId, name: `BELT · Fyss ${FIELD_K}` });
    r.press.add('cruise');

    let dropAtKm = Number.NaN;
    let minKm = Number.POSITIVE_INFINITY;
    let worstStepOverGap = 0;
    let idleAfter = 0;
    for (let i = 0; i < 60 * 60 && idleAfter < 60; i++) {
      const before = r.cruise.drive.phase;
      const prev = r.flight.worldPosition.clone();
      const gapBefore = prev.distanceTo(r.centre) - FIELD_RADIUS_KM;
      r.step(H);
      const d = r.flight.worldPosition.distanceTo(r.centre);
      minKm = Math.min(minKm, d);
      if (before === 'cruise') {
        // The drive cannot tunnel: one frame never covers the gap to the edge.
        worstStepOverGap = Math.max(worstStepOverGap, r.flight.worldPosition.distanceTo(prev) / Math.max(gapBefore, 1e-9));
      }
      if (before === 'cruise' && r.cruise.drive.phase === 'dropping') {
        dropAtKm = d;
        expect(r.cruise.drive.dropReason).toBe('arrival');
      }
      if (!Number.isNaN(dropAtKm) && r.cruise.drive.phase === 'idle') idleAfter++;
    }

    expect(Number.isNaN(dropAtKm), 'the drive never dropped for the field').toBe(false);
    expect(worstStepOverGap).toBeLessThan(1);
    // Dropped as it crossed the field's arrival sphere: edge + arrival clearance
    // (~740 km from the centre), not at the bare clearance from the centre.
    expect(dropAtKm).toBeLessThan(ARRIVE_CENTRE_KM);
    expect(dropAtKm).toBeGreaterThan(0.97 * ARRIVE_CENTRE_KM);
    // Through the bleed and a second after it, the ship stays outside the cluster.
    expect(minKm).toBeGreaterThan(FIELD_RADIUS_KM);
    // R21: the arrival is announced under the field's display name.
    expect(r.logs.some((t) => /^ORBIT — BELT · FYSS 398$/i.test(t))).toBe(true);
  });

  it('Given a field target and a planet farther away, Then cruise does not overshoot the field (speed limited by the field\'s gap)', () => {
    // The planet sits 3 000 000 km beyond the field: its gap (and the star's)
    // would let the drive run at ~10^6 km/s — 17 000 km a frame, far past a
    // 740 km arrival sphere. The field's own gap has to govern.
    const r = fieldRig((toField) => toField, { planetBeyondKm: 3_000_000 });
    const start = r.flight.worldPosition.clone();
    const outward = start.clone().sub(r.centre).normalize();
    bus.emit('target:changed', { id: r.fieldId, name: `BELT · Fyss ${FIELD_K}` });
    r.press.add('cruise');

    let engagedFrames = 0;
    let worstCapOverLaw = 0;
    let minAlong = Number.POSITIVE_INFINITY;
    let dropReason: string | null = null;
    for (let i = 0; i < 60 * 60 && dropReason === null; i++) {
      const before = r.cruise.drive.phase;
      r.step(H);
      // Signed distance along the ship's side of the field: < 0 is past it.
      minAlong = Math.min(minAlong, r.flight.worldPosition.clone().sub(r.centre).dot(outward));
      if (r.cruise.drive.phase === 'cruise') {
        engagedFrames++;
        const edgeGap = r.flight.worldPosition.distanceTo(r.centre) - FIELD_RADIUS_KM;
        worstCapOverLaw = Math.max(worstCapOverLaw, r.cruise.drive.capKmS / (CRUISE_DEFAULTS.rate * edgeGap));
      }
      if (before === 'cruise' && r.cruise.drive.phase === 'dropping') dropReason = r.cruise.drive.dropReason;
    }
    expect(engagedFrames).toBeGreaterThan(0);
    // The ceiling follows the field's gap, not the planet's or the star's.
    expect(worstCapOverLaw).toBeLessThan(1.05);
    expect(dropReason).toBe('arrival');
    // Never past the field, never into it.
    expect(minAlong).toBeGreaterThan(FIELD_RADIUS_KM);
  });

  it('Given target:changed for a field id, When cruise is engaged hands-off, Then the nose is flown onto the limb of the field’s arrival sphere', () => {
    // Nose square to the line of sight: the drive has to turn to the field.
    const r = fieldRig((toField) => new Vector3(1, 0, 0).projectOnPlane(toField.clone().normalize()).normalize());
    bus.emit('target:changed', { id: r.fieldId, name: `BELT · Fyss ${FIELD_K}` });
    r.axes.throttle = 0;
    r.brake = true; // hold position; this measures the turn
    const before = noseErrorRad(r.flight, r.centre);
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.1);
    expect(r.cruise.drive.engaged).toBe(true);
    r.step(4);
    const after = noseErrorRad(r.flight, r.centre);
    const limb = Math.asin((0.9 * ARRIVE_CENTRE_KM) / r.flight.worldPosition.distanceTo(r.centre));
    expect(before).toBeGreaterThan(80 * (Math.PI / 180));
    expect(Math.abs(after - limb)).toBeLessThan(1 * (Math.PI / 180));
  });

  it('Given a field target but no Belt wired into Cruise, Then it is ignored rather than steered at', () => {
    const r = fieldRig((toField) => new Vector3(1, 0, 0).projectOnPlane(toField.clone().normalize()).normalize(), { withBelt: false });
    bus.emit('target:changed', { id: r.fieldId, name: `BELT · Fyss ${FIELD_K}` });
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.1);
    expect(r.flight.command.pitch).toBe(0);
    expect(r.flight.command.yaw).toBe(0);
  });
});

/** Unit vectors of the field's own frame at t = 0: prograde, radial-out, orbit normal. */
function fieldFrame(): { v: Vector3; r: Vector3; n: Vector3 } {
  const f = fyssField(FIELD_K);
  const r = fieldCentre(f, 0).normalize();
  const v = fieldVelocity(f, 0).normalize();
  const n = new Vector3().crossVectors(r, v).normalize();
  return { v, r, n };
}

describe('cruise to a belt field — never stuck (R22 §1)', () => {
  it('Given the ship inside the targeted field, When G is pressed, Then the cap is > 0 and the ship leaves the field', () => {
    // 10 km from the centre, nose outward.
    const r = fieldRig((toField) => toField.clone().negate(), { offset: new Vector3(0, 10, 0) });
    bus.emit('target:changed', { id: r.fieldId, name: `BELT · Fyss ${FIELD_K}` });
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.1);
    expect(r.cruise.drive.phase).toBe('cruise');
    r.step(0.25);
    expect(r.cruise.drive.capKmS).toBeGreaterThan(0);
    let farthest = 0;
    for (let i = 0; i < 3 * 60; i++) {
      r.step(H);
      farthest = Math.max(farthest, r.flight.worldPosition.distanceTo(r.centre));
    }
    expect(farthest).toBeGreaterThan(FIELD_RADIUS_KM);
  });

  it("Given the ship at the field's edge, When G, Then it doesn't crawl below the hold-clearance cap", () => {
    // 1 km outside the edge, nose outward: departing, the field's 1 km gap must not set the ceiling.
    const out = new Vector3(0, 1, 0);
    const r = fieldRig((toField) => toField.clone().negate(), { offset: out.multiplyScalar(FIELD_RADIUS_KM + 1) });
    bus.emit('target:changed', { id: r.fieldId, name: `BELT · Fyss ${FIELD_K}` });
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.1);
    expect(r.cruise.drive.phase).toBe('cruise');
    const floor = cruiseCapKmS(holdClearanceKm(FIELD_RADIUS_KM));
    let lowest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 60 && r.cruise.drive.phase === 'cruise'; i++) {
      r.step(H);
      if (r.cruise.drive.phase === 'cruise') lowest = Math.min(lowest, r.cruise.drive.capKmS);
    }
    expect(lowest).toBeGreaterThanOrEqual(floor);
  });
});

describe('cruise to a belt field — arrive standing still (R22 §2, §3)', () => {
  const frame = fieldFrame();
  const approaches: Array<[string, Vector3]> = [
    ['in-plane retrograde (ship ahead, flying against the field)', frame.v.clone()],
    ['in-plane prograde (ship behind, chasing the field)', frame.v.clone().negate()],
    ['radial from outside', frame.r.clone()],
    ['radial from inside (sunward)', frame.r.clone().negate()],
    ['polar from north', frame.n.clone()],
    ['polar from south', frame.n.clone().negate()],
  ];

  /** Fly from `dir × START_GAP_KM` to the field; returns the rig at the handover frame, or null. */
  function arrive(dir: Vector3): FieldRig {
    const r = fieldRig((toField) => toField, { offset: dir.clone().multiplyScalar(START_GAP_KM), liveClock: true });
    bus.emit('target:changed', { id: r.fieldId, name: `BELT · Fyss ${FIELD_K}` });
    r.press.add('cruise');
    let dropped = false;
    for (let i = 0; i < 90 * 60; i++) {
      const before = r.cruise.drive.phase;
      r.step(H);
      if (before === 'cruise' && r.cruise.drive.phase === 'dropping') {
        dropped = true;
        expect(r.cruise.drive.dropReason).toBe('arrival');
      }
      if (dropped && r.cruise.drive.phase === 'idle') return r;
    }
    throw new Error(`no field arrival within 90 s (phase ${r.cruise.drive.phase})`);
  }

  for (const [label, dir] of approaches) {
    it(`Given an arrival ${label}, Then right after the drop |v_ship − v_field| < 0.01 km/s and the ship stays ≥ FIELD_RADIUS_KM from the centre for 60 s with no input`, () => {
      const r = arrive(dir);
      // The star is the parent and stands still: flight.velocity is the world velocity.
      const rel = r.flight.velocity.clone().sub(r.fieldVelNow()).length();
      expect(rel).toBeLessThan(0.01);
      let closest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 60 * 60; i++) {
        r.step(H);
        closest = Math.min(closest, r.flight.worldPosition.distanceTo(r.centreNow()));
      }
      expect(closest).toBeGreaterThanOrEqual(FIELD_RADIUS_KM);
    });
  }

  it('Given a field drop, Then the nose points at the field centre after the settle (within 5°)', () => {
    const r = arrive(frame.r.clone());
    r.step(4); // the settle is ≤ ~1.5 s; leave it room
    expect(noseErrorRad(r.flight, r.centreNow())).toBeLessThan(5 * (Math.PI / 180));
  });
});

