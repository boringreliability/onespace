/**
 * v3 T3, phase A items 5-6 — the cruise drive's transitions, frame by frame.
 *
 * B1: on the frame the drive engaged the ship went 5 → 0 → 15.8 km/s; the
 *     spool→cruise frame handed FlightModel a ceiling of 0, and the hard clamp
 *     did the rest.
 * Mechanism 3 (PLAN §1): the orbit insertion changed the velocity's direction
 *     by ~30° on one frame (`insertIntoOrbit`), and D53's opening attitude was
 *     a second teleport on the same frame (`Cruise.ts`).
 *
 * Now: during 'dropping' the drive turns nose (and with it the carried
 * velocity) onto the insertion tangent, ≤ 3° per frame, so only a < 2°
 * remainder is left for the handover; D53's opening attitude (facing the
 * world) is still the END state, reached by a bounded slew after it.
 *
 * Same rig as `Cruise.test.ts`: the real FlightModel, a stub world, and the
 * engine's frame order (Universe integrates, Pilot copies the stick, Cruise).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import type { ActionName } from '@/core/Input';
import { openingAttitude } from '@/game/recovery';
import { CRUISE_DEFAULTS, CruiseDrive, cruiseCapKmS, type CruiseInputs } from '@/ship/CruiseDrive';
import { DEFAULT_SHIP_CONFIG, FlightModel, type ParentBody } from '@/ship/FlightModel';
import { Cruise, type CruiseWorld } from './Cruise';

const R = 7_240;
const MU = 9.8e-3 * R * R;
const OPENING_ALT = 4_474;
const DEG = Math.PI / 180;

function facing(dir: Vector3): Quaternion {
  return new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir.clone().normalize());
}

interface Rig {
  cruise: Cruise;
  flight: FlightModel;
  axes: { pitch: number; yaw: number; roll: number; throttle: number; strafeX: number; strafeY: number; strafeZ: number };
  press: Set<ActionName>;
  logs: string[];
  brake: boolean;
  H: number;
  /** One frame; returns nothing — sample `flight` after it. */
  frame: () => void;
  step: (seconds: number) => void;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  bus.emit('target:changed', { id: null, name: null });
});

function build(pos: Vector3, nose: Vector3, H = 1 / 60, vel = new Vector3()): Rig {
  const frame: ParentBody = { position: new Vector3(), velocity: new Vector3(), mu: MU, radius: R };
  const flight = new FlightModel(DEFAULT_SHIP_CONFIG);
  flight.setParent(frame);
  flight.teleport(pos, vel, facing(nose));
  const body = { spec: { name: 'Remit 31', radius: R }, world: frame.position, frame, soiRadius: 1e6, parent: null };
  const world = {
    flight,
    paused: false,
    frozen: false,
    nearestGapKm: pos.length() - R,
    nearest: body,
    shipParent: body,
    allBodies: () => [body],
    system: { stars: [{ name: 'Sol', radius: 1 }] },
  } as unknown as CruiseWorld;
  const axes = { pitch: 0, yaw: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0, strafeZ: 0 };
  const press = new Set<ActionName>();
  let elapsed = 0;
  const ctx = {
    input: { axes, pressed: (a: ActionName) => press.has(a), held: () => false },
    get elapsed() {
      return elapsed;
    },
  } as unknown as EngineContext;
  const logs: string[] = [];
  const offLog = bus.on('log', (e) => logs.push(e.text));
  const cruise = new Cruise({ universe: world });
  cruise.init();
  cleanups.push(() => {
    cruise.dispose();
    offLog();
  });
  const r: Rig = {
    cruise,
    flight,
    axes,
    press,
    logs,
    brake: false,
    H,
    frame: () => {
      flight.update(H);
      (world as { nearestGapKm: number }).nearestGapKm = flight.position.length() - R;
      flight.applyInput(axes, false, r.brake);
      cruise.update(H, ctx);
      press.clear();
      elapsed += H;
    },
    step: (seconds: number) => {
      for (let t = 0; t < seconds - 1e-9; t += H) r.frame();
    },
  };
  return r;
}

/** Angle between two directions, rad. Zero vectors count as 0 (nothing to compare). */
function dirAngle(a: Vector3, b: Vector3): number {
  if (a.lengthSq() < 1e-18 || b.lengthSq() < 1e-18) return 0;
  return a.angleTo(b);
}

interface Trace {
  maxVelStep: number;
  maxQuatStep: number;
  /** Δ velocity direction on the frame cruise let go. */
  handoverStep: number;
  inserted: boolean;
  /** Frames between the drop starting and the handover. */
  dropFrames: number;
}

/**
 * Fly frames from now until `afterS` seconds past the handover, recording the
 * per-frame change in velocity direction and in orientation.
 */
function traceArrival(r: Rig, afterS: number, maxS = 120): Trace {
  const t: Trace = { maxVelStep: 0, maxQuatStep: 0, handoverStep: Number.NaN, inserted: false, dropFrames: 0 };
  const prevV = r.flight.velocity.clone();
  const prevQ = r.flight.orientation.clone();
  let after = -1;
  let dropping = false;
  for (let i = 0; i < maxS / r.H; i++) {
    const wasCruising = r.flight.cruising;
    r.frame();
    const dv = dirAngle(prevV, r.flight.velocity);
    const dq = prevQ.angleTo(r.flight.orientation);
    if (r.cruise.drive.phase === 'dropping') dropping = true;
    if (dropping || t.inserted) {
      t.maxVelStep = Math.max(t.maxVelStep, dv);
      t.maxQuatStep = Math.max(t.maxQuatStep, dq);
    }
    if (dropping && !t.inserted) t.dropFrames++;
    if (wasCruising && !r.flight.cruising) {
      t.inserted = true;
      t.handoverStep = dv;
      after = 0;
    }
    prevV.copy(r.flight.velocity);
    prevQ.copy(r.flight.orientation);
    if (after >= 0) {
      after += r.H;
      if (after >= afterS) break;
    }
  }
  return t;
}

// ---------------------------------------------------------------------------
// B1
// ---------------------------------------------------------------------------

describe('B1: the cruise engage frame', () => {
  it('Given the drive finishing its spool, When it enters cruise, Then the ceiling on that same frame is the law’s (> 0), not 0', () => {
    const d = new CruiseDrive();
    const i: CruiseInputs = { requested: true, clearanceKm: 4_474, grounded: false, atmosphericDensity: 0, nearestRadiusKm: R };
    let transitionCap = Number.NaN;
    for (let k = 0; k < 400 && Number.isNaN(transitionCap); k++) {
      const before = d.phase;
      d.update(1 / 60, i);
      if (before === 'spooling' && d.phase === 'cruise') transitionCap = d.capKmS;
    }
    expect(transitionCap).toBeGreaterThan(0);
    expect(transitionCap).toBeCloseTo(cruiseCapKmS(4_474), 6);
  });

  it('Given the opening orbit with the lever at the detent, When G engages the drive, Then the speed never drops on any frame through the spool and engage — 5 → 0 → 15.8 km/s is gone', () => {
    const p = new Vector3(R + OPENING_ALT, 0, 0);
    const r = build(p, new Vector3(0, 0, 1));
    r.flight.teleport(p, r.flight.orbitalVelocityAt(p), facing(new Vector3(0, 0, 1)));
    r.press.add('cruise');
    let prev = r.flight.velocity.length();
    let worstDrop = 0;
    let minSpeed = Infinity;
    for (let i = 0; i < (CRUISE_DEFAULTS.spoolTime + 1) * 60; i++) {
      r.frame();
      const s = r.flight.velocity.length();
      worstDrop = Math.max(worstDrop, prev - s);
      minSpeed = Math.min(minSpeed, s);
      prev = s;
    }
    expect(r.cruise.drive.phase).toBe('cruise');
    expect(minSpeed).toBeGreaterThan(1);
    expect(worstDrop).toBeLessThan(1e-4); // 0.1 m/s: orbit rounding, not a 5 km/s drop
  });
});

// ---------------------------------------------------------------------------
// The flown insertion
// ---------------------------------------------------------------------------

/** Cruise from 200 000 km at the locked target until it arrives. */
function lockedArrival(H: number): Rig {
  const r = build(new Vector3(200_000, 0, 0), new Vector3(0, 0, 1), H);
  bus.emit('target:changed', { id: 'body:Remit 31', name: 'Remit 31' });
  r.brake = true;
  r.press.add('cruise');
  r.step(CRUISE_DEFAULTS.spoolTime + 4); // charge, and turn on the spot
  r.brake = false;
  r.axes.throttle = 0;
  return r;
}

describe('the insertion is flown, not cut', () => {
  for (const fps of [60, 30]) {
    it(`Given a locked-target arrival at ${fps} fps, When the drive drops and inserts, Then velocity direction and orientation each change ≤ 3° per frame, the handover itself < 2°`, () => {
      const r = lockedArrival(1 / fps);
      const t = traceArrival(r, 5);
      expect(t.inserted).toBe(true);
      expect(r.cruise.drive.dropReason).toBe('arrival');
      expect(t.maxVelStep).toBeLessThanOrEqual(3 * DEG);
      expect(t.maxQuatStep).toBeLessThanOrEqual(3 * DEG);
      expect(t.handoverStep).toBeLessThan(2 * DEG);
    });
  }

  it('Given a dead-radial arrival with no target (nose straight at the world: 90° to turn), When the drive drops, Then the turn still stays ≤ 3° per frame and the handover < 2° — the drop waits for the nose rather than snapping it', () => {
    const r = build(new Vector3(3.5 * R, 0, 0), new Vector3(-1, 0, 0));
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.2);
    expect(r.cruise.drive.engaged).toBe(true);
    const t = traceArrival(r, 4);
    expect(t.inserted).toBe(true);
    expect(t.maxVelStep).toBeLessThanOrEqual(3 * DEG);
    expect(t.maxQuatStep).toBeLessThanOrEqual(3 * DEG);
    expect(t.handoverStep).toBeLessThan(2 * DEG);
  });

  it('Given the handover, Then the ship is still left in a circular orbit (e < 0.01) — flying the turn costs the insertion nothing', () => {
    const r = lockedArrival(1 / 60);
    traceArrival(r, 0.1);
    const p = r.flight.position;
    const v = r.flight.velocity;
    const hVec = new Vector3().crossVectors(p, v);
    const eVec = new Vector3().crossVectors(v, hVec).divideScalar(MU).sub(p.clone().normalize());
    expect(eVec.length()).toBeLessThan(0.01);
    expect(r.logs).toContain('ORBIT — REMIT 31');
  });

  it('Given an arrival, When the settle after the handover completes, Then D53 holds: the attitude IS the opening attitude (facing the world), within 1°', () => {
    const r = lockedArrival(1 / 60);
    traceArrival(r, 4);
    const want = openingAttitude(r.flight.velocity, r.flight.position, new Quaternion());
    expect(r.flight.orientation.angleTo(want)).toBeLessThan(1 * DEG);
    expect(r.cruise.busy).toBe(false);
  });

  it('Given the settle towards the opening attitude, When the pilot moves the stick, Then the settle lets go at once — the pilot’s rotation is not fought', () => {
    const r = lockedArrival(1 / 60);
    traceArrival(r, 0.1);
    expect(r.cruise.busy).toBe(true); // still settling
    r.axes.pitch = 0.6;
    r.frame();
    expect(r.cruise.busy).toBe(false);
    expect(r.flight.command.pitch).toBe(0.6);
  });

  it('Given the drive idle after the settle, Then Cruise is not busy (the L queue keys on this)', () => {
    const r = build(new Vector3(R + OPENING_ALT, 0, 0), new Vector3(0, 0, 1));
    r.frame();
    expect(r.cruise.busy).toBe(false);
  });
});

describe('CruiseDrive: the drop waits for the nose', () => {
  it('Given a drop whose nose is not yet on the tangent (aligned false), When the bleed runs out, Then the drive holds at the exit speed instead of letting go', () => {
    const d = new CruiseDrive();
    const i: CruiseInputs & { aligned?: boolean } = {
      requested: true,
      clearanceKm: 1e6,
      grounded: false,
      atmosphericDensity: 0,
      nearestRadiusKm: R,
      exitSpeedKmS: 5,
    };
    for (let k = 0; k < 200; k++) d.update(1 / 60, i);
    expect(d.phase).toBe('cruise');
    (i as { requested: boolean }).requested = false;
    i.aligned = false;
    for (let k = 0; k < Math.ceil((CRUISE_DEFAULTS.dropTime + 0.5) * 60); k++) d.update(1 / 60, i);
    expect(d.phase).toBe('dropping');
    expect(d.capKmS).toBeCloseTo(5, 3);
    i.aligned = true;
    d.update(1 / 60, i);
    d.update(1 / 60, i);
    expect(d.phase).toBe('idle');
  });

  it('Given a drop that never aligns, Then the hold is bounded — the drive lets go anyway within 3 s past the bleed', () => {
    const d = new CruiseDrive();
    const i: CruiseInputs & { aligned?: boolean } = {
      requested: true,
      clearanceKm: 1e6,
      grounded: false,
      atmosphericDensity: 0,
      nearestRadiusKm: R,
      exitSpeedKmS: 5,
      aligned: false,
    };
    for (let k = 0; k < 200; k++) d.update(1 / 60, i);
    (i as { requested: boolean }).requested = false;
    for (let k = 0; k < Math.ceil((CRUISE_DEFAULTS.dropTime + 3) * 60); k++) d.update(1 / 60, i);
    expect(d.phase).toBe('idle');
  });
});
