/**
 * v2 phase 1 — the cruise module, wired: the opening orbit, the locked target
 * and the orbit insertion, as the game runs them frame by frame.
 *
 * The world is a stub of the handful of `Universe` members `Cruise` reads
 * (`CruiseWorld`), so this runs in node. The flight model is the real one.
 * Each frame reproduces the engine's order: Universe integrates, Pilot copies
 * the stick into `flight.command`, then Cruise runs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import type { ActionName } from '@/core/Input';
import { DEFAULT_SHIP_CONFIG, FlightModel, type ParentBody } from '@/ship/FlightModel';
import { CRUISE_DEFAULTS } from '@/ship/CruiseDrive';
import { noseErrorRad } from '@/ship/cruiseSteer';
import { Cruise, type CruiseWorld } from './Cruise';

const R = 7_240;
const MU = 9.8e-3 * R * R;
const OPENING_ALT = 4_474;
const H = 1 / 60;

interface Rig {
  cruise: Cruise;
  flight: FlightModel;
  world: CruiseWorld;
  axes: { pitch: number; yaw: number; roll: number; throttle: number; strafeX: number; strafeY: number; strafeZ: number };
  press: Set<ActionName>;
  logs: string[];
  step: (seconds?: number) => void;
}

function facing(dir: Vector3): Quaternion {
  return new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir.clone().normalize());
}

let offLog: (() => void) | null = null;
let rig: Rig | null = null;

function build(pos: Vector3, nose: Vector3): Rig {
  const frame: ParentBody = { position: new Vector3(), velocity: new Vector3(), mu: MU, radius: R };
  const flight = new FlightModel(DEFAULT_SHIP_CONFIG);
  flight.setParent(frame);
  flight.teleport(pos, new Vector3(), facing(nose));

  const body = {
    spec: { name: 'Remit 31', radius: R },
    world: frame.position,
    frame,
    soiRadius: 1e6,
    parent: null,
  };
  const world = {
    flight,
    paused: false,
    nearestGapKm: pos.length() - R,
    nearest: body,
    shipParent: body,
    allBodies: () => [body],
    system: { stars: [{ name: 'Sol', radius: 1 }] },
  } as unknown as CruiseWorld;

  const axes = { pitch: 0, yaw: 0, roll: 0, throttle: 1, strafeX: 0, strafeY: 0, strafeZ: 0 };
  const press = new Set<ActionName>();
  let elapsed = 0;
  const ctx = {
    input: {
      axes,
      pressed: (a: ActionName) => press.has(a),
      held: () => false,
    },
    get elapsed() {
      return elapsed;
    },
  } as unknown as EngineContext;

  const logs: string[] = [];
  offLog = bus.on('log', (e) => logs.push(e.text));

  const cruise = new Cruise({ universe: world });
  cruise.init();

  const step = (seconds = H): void => {
    for (let t = 0; t < seconds - 1e-9; t += H) {
      flight.update(H); // Universe
      (world as { nearestGapKm: number }).nearestGapKm = flight.position.length() - R;
      flight.applyInput(axes, false, false); // Pilot
      cruise.update(H, ctx);
      press.clear();
      elapsed += H;
    }
  };

  rig = { cruise, flight, world, axes, press, logs, step };
  return rig;
}

beforeEach(() => {
  rig = null;
});

afterEach(() => {
  rig?.cruise.dispose();
  offLog?.();
  offLog = null;
  bus.emit('target:changed', { id: null, name: null });
});

/** The opening orbit: 4 474 km up on +X, nose prograde (+Z). */
function opening(): Rig {
  return build(new Vector3(R + OPENING_ALT, 0, 0), new Vector3(0, 0, 1));
}

describe('engaging from the opening orbit', () => {
  it('Given the opening orbit (alt 4 474 km over R 7 240 km), When G is pressed, Then CRUISE ENGAGED — and no MASS TOO CLOSE', () => {
    const r = opening();
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.3);
    expect(r.cruise.drive.phase).toBe('cruise');
    expect(r.logs).toContain('CRUISE ENGAGED');
    expect(r.logs.some((t) => t.includes('MASS TOO CLOSE'))).toBe(false);
  });
});

describe('steering to the locked target', () => {
  it('Given target:changed for body:Remit 31 from 200 000 km, When cruise is engaged hands-off, Then the nose is flown onto the limb of the arrival sphere', () => {
    // Approved change to the first draft: the steering aims at the tangent to
    // a sphere of 0.9 × 3 R about the target, not at its centre, so the nose
    // settles asin(0.9·3R / d) off the centre line — ~5.6° from here.
    const r = build(new Vector3(200_000, 0, 0), new Vector3(0, 0, 1));
    bus.emit('target:changed', { id: 'body:Remit 31', name: 'Remit 31' });
    r.axes.throttle = 0; // hold position; this measures the turn
    const centre = r.world.allBodies()[0]!.world;
    const before = noseErrorRad(r.flight, centre);
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.1);
    expect(r.cruise.drive.engaged).toBe(true);
    r.step(4);
    const after = noseErrorRad(r.flight, centre);
    const limb = Math.asin((0.9 * 3 * R) / r.flight.position.length());
    expect(before).toBeGreaterThan(80 * (Math.PI / 180));
    expect(Math.abs(after - limb)).toBeLessThan(1 * (Math.PI / 180));
  });

  it('Given a locked target, When the drive arrives, Then the approach meets the arrival sphere within 30° of tangential', () => {
    const r = build(new Vector3(200_000, 0, 0), new Vector3(0, 0, 1));
    bus.emit('target:changed', { id: 'body:Remit 31', name: 'Remit 31' });
    r.axes.throttle = 0;
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 4); // charge and turn on the spot
    r.axes.throttle = 1;
    let fromTangential = NaN;
    for (let i = 0; i < 60 * 60 && Number.isNaN(fromTangential); i++) {
      const before = r.cruise.drive.phase;
      r.step(H);
      if (before === 'cruise' && r.cruise.drive.phase === 'dropping') {
        const rHat = r.flight.position.clone().normalize();
        fromTangential = Math.asin(Math.min(1, Math.abs(r.flight.forward.dot(rHat))));
        expect(r.cruise.drive.dropReason).toBe('arrival');
      }
    }
    expect(fromTangential).toBeLessThan(30 * (Math.PI / 180));
  });

  it('Given no target (or a cleared one), When cruise is engaged, Then the nose is left alone — it flies where it points', () => {
    const r = opening();
    bus.emit('target:changed', { id: 'body:Remit 31', name: 'Remit 31' });
    bus.emit('target:changed', { id: null, name: null });
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.1);
    expect(r.flight.command.pitch).toBe(0);
    expect(r.flight.command.yaw).toBe(0);
  });

  it('Given a target id that matches no body, Then it is ignored rather than steered at', () => {
    const r = opening();
    bus.emit('target:changed', { id: 'body:Nowhere', name: 'Nowhere' });
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.1);
    expect(r.flight.command.pitch).toBe(0);
    expect(r.flight.command.yaw).toBe(0);
  });

  it('Given a locked target and the pilot on the stick, Then the pilot’s rotation passes straight through', () => {
    const r = opening();
    bus.emit('target:changed', { id: 'body:Remit 31', name: 'Remit 31' });
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.1);
    r.axes.pitch = 0.4;
    r.step(H);
    expect(r.flight.command.pitch).toBe(0.4);
    expect(r.flight.command.yaw).toBe(0);
  });
});

describe('arriving through the module', () => {
  it('Given a ship at 3.5 R diving at the planet, When the drive drops on arrival, Then the ship is left in a circular orbit and the toggle is released', () => {
    const pos = new Vector3(3.5 * R, 0, 0);
    const r = build(pos, new Vector3(-1, 0, 0));
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.2);
    expect(r.cruise.drive.engaged).toBe(true);
    r.step(8);

    expect(r.cruise.drive.phase).toBe('idle');
    expect(r.flight.cruising).toBe(false);
    const rr = r.flight.position.length();
    const vc = Math.sqrt(MU / rr);
    expect(Math.abs(r.flight.velocity.length() - vc) / vc).toBeLessThan(0.03);
    const cos = r.flight.velocity.clone().normalize().dot(r.flight.position.clone().normalize());
    expect(Math.abs(cos)).toBeLessThan(0.03);

    // Arrival is an answer, not a loop: the drive does not spool up again.
    r.step(3);
    expect(r.cruise.drive.phase).toBe('idle');
  });

  it('Given the lever still at 100 % after an arrival, Then the engine is held at idle so the orbit survives — until the pilot moves the lever', () => {
    // GAMEPLAY.md "brake": the lever stays where it was when W is released, so
    // without this the main drive pushes the ship straight out of the orbit
    // it was just handed.
    const r = build(new Vector3(3.5 * R, 0, 0), new Vector3(-1, 0, 0));
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.2);
    r.step(8);
    expect(r.cruise.drive.phase).toBe('idle');
    expect(r.axes.throttle).toBe(1);
    expect(r.flight.command.throttle).toBe(0);

    const { rp } = (() => {
      const p = r.flight.position;
      const v = r.flight.velocity;
      const e = v.lengthSq() / 2 - MU / p.length();
      const a = -MU / (2 * e);
      const hh = new Vector3().crossVectors(p, v).length();
      const ecc = Math.sqrt(Math.max(0, 1 + (2 * e * hh * hh) / (MU * MU)));
      return { rp: a * (1 - ecc) };
    })();
    expect(rp).toBeGreaterThan(1.5 * R);

    r.axes.throttle = 0.5;
    r.step(H);
    expect(r.flight.command.throttle).toBe(0.5);
  });
});
