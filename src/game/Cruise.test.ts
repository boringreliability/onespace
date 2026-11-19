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
import { EXHAUST_VELOCITY_KMS, PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
import { AU } from '@/gen/types';
import { Cruise, lineBlockedBy, type CruiseWorld } from './Cruise';

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
  /** Space held (the pilot's brake). */
  brake: boolean;
  /** Physics slices per frame (Universe's time-compression slicing); 1 = real time. */
  slices: number;
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
      for (let s = 0; s < r.slices; s++) flight.update(H); // Universe
      (world as { nearestGapKm: number }).nearestGapKm = flight.position.length() - R;
      flight.applyInput(axes, false, r.brake); // Pilot
      cruise.update(H, ctx);
      press.clear();
      elapsed += H;
    }
  };

  const r: Rig = { cruise, flight, world, axes, press, logs, step, brake: false, slices: 1 };
  rig = r;
  return r;
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
    // Hold position; this measures the turn. Since review-p1 the lever's
    // detent rides the ceiling under cruise, so holding still is the brake.
    r.axes.throttle = 0;
    r.brake = true;
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
    r.brake = true;
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 4); // charge and turn on the spot
    r.brake = false;
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

// ---------------------------------------------------------------------------
// review-p1: seams between the tracks, found by the first-10-minutes playtest
// ---------------------------------------------------------------------------

describe('review-p1: the lever at its coast detent under cruise', () => {
  it('Given the opening orbit with the lever at the coast detent (0, as spawn, recovery and arrival leave it), When G is pressed, Then the drive actually carries the ship — not CRUISE ENGAGED at 0 m/s', () => {
    // Playtest: G from the opening orbit engaged and then hung motionless for
    // 240 s with VEL 0 — stepCruise flies `cap × lever`, and FA-ON makes 0 the
    // resting lever.
    const r = opening();
    r.axes.throttle = 0;
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 1.5);
    expect(r.cruise.drive.phase).toBe('cruise');
    expect(r.flight.velocity.length()).toBeGreaterThan(100);
  });

  it('Given cruise engaged at the detent, When Space is held, Then the drive holds the ship still so the nose can be turned on the spot', () => {
    const r = opening();
    r.axes.throttle = 0;
    r.brake = true;
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 3);
    expect(r.cruise.drive.engaged).toBe(true);
    expect(r.flight.velocity.length()).toBeLessThan(1);
  });

  it('Given cruise engaged with the lever at 25 %, Then the lever still chooses a fraction of the ceiling (only the detent means NAV hold)', () => {
    const r = opening();
    r.axes.throttle = 0.25;
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.1);
    r.step(1);
    expect(r.flight.command.throttle).toBe(0.25);
  });
});

describe('review-p1: cruise against pause, the galaxy chart and recovery', () => {
  it('Given cruise engaged at speed, When the galaxy chart pauses the universe and closes again, Then the drive is still carrying the ship — it never leaves a cruise-speed Newtonian velocity behind', () => {
    const r = opening();
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 1);
    expect(r.flight.velocity.length()).toBeGreaterThan(100);
    (r.world as { paused: boolean }).paused = true;
    r.step(H);
    (r.world as { paused: boolean }).paused = false;
    // Before the fix the pause cancelled the drive with setCruise(null), which
    // keeps the velocity: thousands of km/s under ordinary physics.
    expect(r.flight.cruising).toBe(true);
    expect(r.cruise.drive.engaged).toBe(true);
  });

  it('Given the drive spooling, When the pause sheet freezes the world for 3 s, Then the spool does not advance behind the sheet', () => {
    const r = opening();
    r.press.add('cruise');
    r.step(0.5);
    expect(r.cruise.drive.phase).toBe('spooling');
    const p = r.cruise.drive.progress;
    (r.world as { frozen: boolean }).frozen = true;
    r.step(3);
    expect(r.cruise.drive.phase).toBe('spooling');
    expect(r.cruise.drive.progress).toBe(p);
    (r.world as { frozen: boolean }).frozen = false;
  });

  it('Given cruise engaged, When the ship is recovered to orbit (RETURN TO ORBIT, crash, star), Then the drive is cold and stays cold — the recovery orbit is not flown out of', () => {
    // Playtest: after RETURN TO ORBIT mid-cruise the drive was still 'cruise'
    // and the ship left the orbit it had just been given (e = 0.997).
    const r = opening();
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.5);
    expect(r.cruise.drive.engaged).toBe(true);
    bus.emit('ship:recovered', { cause: 'requested' });
    expect(r.cruise.drive.phase).toBe('idle');
    expect(r.flight.cruising).toBe(false);
    r.step(1);
    expect(r.cruise.drive.phase).toBe('idle');
    expect(r.flight.cruising).toBe(false);
  });
});

describe('review-p1: arriving in a new system', () => {
  it('Given the lever left at 100 % through a jump, When the new system is entered, Then the engine is held at idle (FA-ON would otherwise speed-hold out of the arrival orbit) until the lever moves', () => {
    const r = opening();
    r.axes.throttle = 1;
    r.flight.command.throttle = 1;
    bus.emit('system:entered', { system: {} as never });
    // At once: the next physics step runs before Pilot and Cruise.
    expect(r.flight.command.throttle).toBe(0);
    r.step(H);
    expect(r.flight.command.throttle).toBe(0);
    r.step(1);
    expect(r.flight.command.throttle).toBe(0);
    r.axes.throttle = 0.9;
    r.step(H);
    expect(r.flight.command.throttle).toBe(0.9);
  });
});

describe('review-p1: a target behind the world being orbited', () => {
  /**
   * Two bodies: the home world at the origin (the parent) and a target far
   * behind it on the −X axis. The ship opens on +X, so the straight line to
   * the target runs through the home world — the playtest's Vassa/Remit 31.
   */
  function behind(): { cruise: Cruise; flight: FlightModel; logs: string[]; run: (s: number, onFrame?: () => void) => string[] } {
    const frame: ParentBody = { position: new Vector3(), velocity: new Vector3(), mu: MU, radius: R };
    const flight = new FlightModel(DEFAULT_SHIP_CONFIG);
    flight.setParent(frame);
    flight.teleport(new Vector3(R + OPENING_ALT, 0, 0), new Vector3(), facing(new Vector3(0, 0, 1)));
    const home = { spec: { name: 'Remit 31', id: 'remit', radius: R }, world: frame.position, frame, soiRadius: 1e6, parent: null };
    const far = { spec: { name: 'Vassa', id: 'vassa', radius: 5_000 }, world: new Vector3(-2e7, 0, 0), frame, soiRadius: 1e6, parent: null };
    const bodies = [home, far];
    const world = {
      flight, paused: false, frozen: false, nearestGapKm: 0, nearest: home, shipParent: home,
      allBodies: () => bodies, system: { stars: [{ name: 'Sol', radius: 0 }] },
    } as unknown as CruiseWorld & { nearestGapKm: number; nearest: unknown };
    const axes = { pitch: 0, yaw: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0, strafeZ: 0 };
    const press = new Set<ActionName>();
    const ctx = { input: { axes, pressed: (a: ActionName) => press.has(a), held: () => false }, elapsed: 0 } as unknown as EngineContext;
    const logs: string[] = [];
    const off = bus.on('log', (e) => logs.push(e.text));
    const cruise = new Cruise({ universe: world });
    cruise.init();
    bus.emit('target:changed', { id: 'body:Vassa', name: 'Vassa' });
    press.add('cruise');
    const reasons: string[] = [];
    const run = (seconds: number, onFrame?: () => void): string[] => {
      for (let t = 0; t < seconds; t += H) {
        flight.update(H);
        const p = flight.worldPosition;
        let best = Infinity;
        for (const b of bodies) {
          const g = p.distanceTo(b.world) - b.spec.radius;
          if (g < best) {
            best = g;
            (world as { nearest: unknown }).nearest = b;
          }
        }
        world.nearestGapKm = best;
        flight.applyInput(axes, false, false);
        const before = cruise.drive.phase;
        cruise.update(H, ctx);
        press.clear();
        if (before === 'cruise' && cruise.drive.phase === 'dropping') reasons.push(cruise.drive.dropReason ?? '?');
        onFrame?.();
        if (reasons.length) break;
      }
      return reasons;
    };
    cleanups.push(() => {
      cruise.dispose();
      off();
    });
    return { cruise, flight, logs, run };
  }
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  it('Given the target exactly behind the home world, When G is pressed with the lever at the detent, Then the drive skirts the world and arrives at the target — no MASS drop at the world in the way', () => {
    const r = behind();
    const reasons = r.run(120);
    expect(reasons).toEqual(['arrival']);
    expect(r.flight.worldPosition.distanceTo(new Vector3(-2e7, 0, 0))).toBeLessThan(5_000 * 4);
    expect(r.logs.some((t) => t.includes('MASS'))).toBe(false);
  });

  // v3 polish (D22b): the readout said ETA 0:40 for a 79 s trip while the
  // drive skirted Remit 31. Cruise now says when it is skirting, and which world.
  it('Given the target behind the home world, When the drive carries the ship, Then `skirting` names the home world while it is in the way and clears (null) once the line is clear, before arrival', () => {
    const r = behind();
    expect(r.cruise.skirting).toBeNull(); // idle: nothing to skirt
    const seen: Array<string | null> = [];
    r.run(120, () => {
      if (r.cruise.drive.phase === 'spooling' || r.cruise.drive.phase === 'cruise') seen.push(r.cruise.skirting);
    });
    expect(seen[0]).toBe('Remit 31');
    const firstClear = seen.indexOf(null);
    expect(firstClear).toBeGreaterThan(0);
    // Once clear it stays clear — and the drive still had a stretch of cruise to count down.
    expect(seen.slice(firstClear).every((x) => x === null)).toBe(true);
    expect(seen.length - firstClear).toBeGreaterThan(30);
    expect(r.cruise.drive.phase === 'dropping' || r.cruise.drive.phase === 'idle').toBe(true);
    expect(r.cruise.skirting).toBeNull();
  });
});

describe('lineBlockedBy — the occluder test, pure (v3 polish)', () => {
  const ship = new Vector3(10_000, 0, 0);
  const target = new Vector3(-2e7, 0, 0);
  it('Given a world on the line nearer than the target, Then blocked', () => {
    expect(lineBlockedBy(ship, target, new Vector3(0, 0, 0), 7_500)).toBe(true);
  });
  it('Given the same world passed by more than its safe radius, Then clear', () => {
    expect(lineBlockedBy(ship, target, new Vector3(0, 8_000, 0), 7_500)).toBe(false);
  });
  it('Given a world behind the ship or beyond the target, Then clear', () => {
    expect(lineBlockedBy(ship, target, new Vector3(20_000, 0, 0), 7_500)).toBe(false);
    expect(lineBlockedBy(ship, target, new Vector3(-3e7, 0, 0), 7_500)).toBe(false);
  });
  it('Given the ship on the target, Then clear (no line to block)', () => {
    expect(lineBlockedBy(target, target, new Vector3(0, 0, 0), 7_500)).toBe(false);
  });
});

describe('v2 merge: leaving the home world, and the arrival frame', () => {
  it('Given the opening orbit with the nose 30° down (the opening attitude), When G is pressed with no target, Then the drive carries the ship away instead of dropping for "arrival" at the world it is leaving', () => {
    // review-p1: the home world counted as "closing" inside 2 R, so G from
    // the opening frame span up for 2 s and dropped at once — ORBIT — REMIT 31.
    const pos = new Vector3(R + OPENING_ALT, 0, 0);
    const nose = new Vector3(0, 0, 1).multiplyScalar(Math.cos(Math.PI / 6)).add(new Vector3(-Math.sin(Math.PI / 6), 0, 0));
    const r = build(pos, nose);
    r.axes.throttle = 0;
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 3);
    expect(r.cruise.drive.dropReason).not.toBe('arrival');
    expect(r.logs.some((t) => t.startsWith('ORBIT —'))).toBe(false);
  });

  it('Given a ship that has left and comes back to the same world, When it closes inside the arrival sphere, Then arrival is armed again', () => {
    const r = build(new Vector3(6 * R, 0, 0), new Vector3(-1, 0, 0));
    r.axes.throttle = 0;
    r.press.add('cruise');
    r.step(40);
    expect(r.logs.some((t) => t.startsWith('ORBIT —'))).toBe(true);
  });

  it('Given an arrival into orbit, Then the ship faces the world (nose pitched down towards the limb), not empty sky', () => {
    // review-p1: the arrival "money shot" kept the approach attitude and the
    // world was off-screen. Insertion applies the opening attitude.
    const r = build(new Vector3(3.5 * R, 0, 0), new Vector3(-1, 0, 0));
    r.axes.throttle = 0;
    r.press.add('cruise');
    r.step(15);
    expect(r.logs.some((t) => t.startsWith('ORBIT —'))).toBe(true);
    const nose = r.flight.forward.clone().normalize();
    const down = r.flight.position.clone().normalize().negate();
    const v = r.flight.velocity.clone().normalize();
    expect(nose.dot(down)).toBeCloseTo(Math.sin(Math.PI / 6), 2);
    expect(nose.dot(v)).toBeCloseTo(Math.cos(Math.PI / 6), 2);
  });
});

// ---------------------------------------------------------------------------
// v4 sub-plan 1 (propellant), Task 4: cruise is paid for out of the tank
// ---------------------------------------------------------------------------

describe('v4-fuel: cruise is paid for out of the tank', () => {
  const CAP = PROBE_TANK_CAPACITY_KG;
  /** 0.5 % of capacity (travelCost.cruiseSpoolKg). */
  const SPOOL_KG = 0.005 * CAP;

  /**
   * The opening orbit with `kg` in a probe tank. FA-OFF at the coast detent,
   * so the main drive draws nothing of its own and every kg that leaves the
   * tank is the cruise bill. (The detent still carries the ship under cruise.)
   */
  function fuelled(kg: number): Rig {
    const r = opening();
    const p = new Propellant(CAP, 0);
    p.add(kg);
    r.flight.attachPropellant(p, EXHAUST_VELOCITY_KMS);
    r.flight.flightAssist = false;
    r.axes.throttle = 0;
    return r;
  }

  const seen: Array<{ text: string; tone?: string }> = [];
  let offSeen: (() => void) | null = null;
  beforeEach(() => {
    seen.length = 0;
    offSeen = bus.on('log', (e) => seen.push(e));
  });
  afterEach(() => {
    offSeen?.();
    offSeen = null;
  });

  it('Given an empty tank, When cruise is requested, Then it does not spool and logs "CRUISE · NO PROPELLANT"', () => {
    const r = fuelled(0);
    const phases = new Set<string>();
    r.press.add('cruise');
    for (let i = 0; i < Math.round((CRUISE_DEFAULTS.spoolTime + 0.5) / H); i++) {
      r.step(H);
      phases.add(r.cruise.drive.phase);
    }
    expect([...phases]).toEqual(['idle']);
    expect(r.flight.cruising).toBe(false);
    expect(r.logs).toContain('CRUISE · NO PROPELLANT');
  });

  it('Given a full tank, When cruise is requested, Then the spool is paid up front: 0.5 % of capacity leaves the tank on the request frame', () => {
    const r = fuelled(CAP);
    r.press.add('cruise');
    r.step(H);
    expect(r.cruise.drive.phase).toBe('spooling');
    expect(r.flight.propellant!.massKg).toBeCloseTo(CAP - SPOOL_KG, 6);
  });

  it('Given cruise in progress, Then it is paid frame by frame for the distance travelled: 1 % of capacity per AU', () => {
    const r = fuelled(CAP);
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.5);
    expect(r.cruise.drive.phase).toBe('cruise');
    const kg0 = r.flight.propellant!.massKg;
    const last = r.flight.worldPosition.clone();
    let km = 0;
    for (let i = 0; i < 4 * 60; i++) {
      r.step(H);
      expect(r.cruise.drive.phase).toBe('cruise');
      km += r.flight.worldPosition.distanceTo(last);
      last.copy(r.flight.worldPosition);
    }
    const paid = kg0 - r.flight.propellant!.massKg;
    const expected = (0.01 * CAP * km) / AU;
    expect(km).toBeGreaterThan(1_000);
    expect(paid).toBeGreaterThan(0);
    expect(Math.abs(paid - expected) / expected).toBeLessThan(0.1);
  });

  it("Given cruise in progress and a tank that runs dry, Then the drive drops out through its normal 'dropping' phase (no teleport) and logs it", () => {
    // The spool price plus ~1 500 km of cruise at 1 % / AU of 20 000 kg.
    const r = fuelled(SPOOL_KG + 0.002);
    r.press.add('cruise');
    const seq: string[] = [];
    let maxStepKm = 0;
    let maxSpeedKmS = 0;
    const last = r.flight.worldPosition.clone();
    for (let i = 0; i < 20 * 60; i++) {
      r.step(H);
      const ph = r.cruise.drive.phase;
      if (seq[seq.length - 1] !== ph) seq.push(ph);
      maxStepKm = Math.max(maxStepKm, r.flight.worldPosition.distanceTo(last));
      maxSpeedKmS = Math.max(maxSpeedKmS, r.flight.velocity.length());
      last.copy(r.flight.worldPosition);
      if (seq.length >= 4 && ph === 'idle') break;
    }
    expect(seq).toEqual(['spooling', 'cruise', 'dropping', 'idle']);
    expect(r.flight.propellant!.empty).toBe(true);
    // No teleport: no frame moves the ship further than the fastest speed seen carries it.
    expect(maxStepKm).toBeLessThanOrEqual(maxSpeedKmS * H * 1.5 + 1e-6);
    const dry = seen.find((e) => e.text.startsWith('CRUISE') && e.text.includes('PROPELLANT'));
    expect(dry).toBeDefined();
    expect(dry!.tone).toBe('warn');
    // A drop is an answer: the drive does not spool up again on an empty tank.
    r.step(3);
    expect(r.cruise.drive.phase).toBe('idle');
  });

  it('Given a spool that never reaches cruise (the toggle released mid-charge), Then the spool price is refunded', () => {
    const r = fuelled(CAP);
    r.press.add('cruise');
    r.step(0.5);
    expect(r.cruise.drive.phase).toBe('spooling');
    expect(r.flight.propellant!.massKg).toBeCloseTo(CAP - SPOOL_KG, 6);
    r.press.add('cruise'); // G again: abort the charge
    r.step(H);
    expect(r.cruise.drive.phase).toBe('idle');
    expect(r.flight.propellant!.massKg).toBeCloseTo(CAP, 6);
    r.step(1);
    expect(r.flight.propellant!.massKg).toBeCloseTo(CAP, 6);
  });

  it('Given a spool that reaches cruise, Then the spool price stays paid (no refund on a later drop)', () => {
    const r = fuelled(CAP);
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.2);
    expect(r.cruise.drive.phase).toBe('cruise');
    r.press.add('cruise'); // release: cruise → dropping → idle
    r.step(5);
    expect(r.cruise.drive.phase).toBe('idle');
    expect(r.flight.propellant!.massKg).toBeLessThan(CAP - SPOOL_KG + 1e-9);
  });

  it('Given the same cruise distance at 1× and 100×, Then the same kg is charged (the bill is by sim distance)', () => {
    /** kg per km over `frames` cruise frames with `slices` physics slices per frame. */
    const rate = (slices: number, frames: number): { kgPerKm: number; km: number } => {
      const r = fuelled(CAP);
      r.press.add('cruise');
      r.step(CRUISE_DEFAULTS.spoolTime + 0.5);
      expect(r.cruise.drive.phase).toBe('cruise');
      r.slices = slices;
      const kg0 = r.flight.propellant!.massKg;
      const last = r.flight.worldPosition.clone();
      let km = 0;
      for (let i = 0; i < frames; i++) {
        r.step(H);
        km += r.flight.worldPosition.distanceTo(last);
        last.copy(r.flight.worldPosition);
      }
      expect(r.cruise.drive.phase).toBe('cruise');
      const out = { kgPerKm: (kg0 - r.flight.propellant!.massKg) / km, km };
      r.cruise.dispose();
      offLog?.();
      return out;
    };
    // The same 200 sim-frames: 200 frames at 1×, or 2 frames of 100 slices.
    const real = rate(1, 200);
    const fast = rate(100, 2);
    expect(fast.km / real.km).toBeGreaterThan(0.5); // about the same distance flown
    expect(fast.km / real.km).toBeLessThan(2);
    const perKm = (0.01 * CAP) / AU;
    expect(Math.abs(real.kgPerKm - perKm) / perKm).toBeLessThan(1e-3);
    expect(Math.abs(fast.kgPerKm - real.kgPerKm) / real.kgPerKm).toBeLessThan(0.01);
  });

  it('Given no tank attached (a bare hull), Then cruise is not charged and engages as before', () => {
    const r = opening();
    expect(r.flight.propellant).toBeFalsy();
    r.press.add('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.3);
    expect(r.cruise.drive.phase).toBe('cruise');
  });

  // -------------------------------------------------------------------------
  // Final whole-branch review, I4 — every tank change is a named action, and
  // the cruise leg is announced per leg segment, not per frame.
  // -------------------------------------------------------------------------

  describe('final review I4 — named actions from cruise', () => {
    type Seen = { action: { kind: string; kg?: number }; ok: boolean; kg: number; tankDeltaKg: number };
    let actions: Seen[] = [];
    let offAction: (() => void) | null = null;
    beforeEach(() => {
      actions = [];
      offAction = bus.on('propellant:action', (e: Seen) => actions.push(e));
    });
    afterEach(() => {
      offAction?.();
      offAction = null;
    });
    const of = (kind: string): Seen[] => actions.filter((e) => e.action.kind === kind);

    it('Given a spool released mid-charge, Then the refund is applied as a named action (spool-refund, the spool price) and propellant:action is emitted', () => {
      const r = fuelled(CAP);
      r.press.add('cruise');
      r.step(0.5);
      r.press.add('cruise'); // G again: abort the charge
      r.step(H);
      const refunds = of('spool-refund');
      expect(refunds).toHaveLength(1);
      expect(refunds[0]!.ok).toBe(true);
      expect(refunds[0]!.action.kg).toBeCloseTo(SPOOL_KG, 6);
      expect(refunds[0]!.kg).toBeCloseTo(SPOOL_KG, 6);
      expect(r.flight.propellant!.massKg).toBeCloseTo(CAP, 6);
    });

    it('Given a spool cut short by a recovery, Then that refund is a named action too', () => {
      const r = fuelled(CAP);
      r.press.add('cruise');
      r.step(0.5);
      expect(r.cruise.drive.phase).toBe('spooling');
      bus.emit('ship:recovered', { cause: 'requested' });
      r.step(H);
      expect(of('spool-refund')).toHaveLength(1);
      expect(r.flight.propellant!.massKg).toBeCloseTo(CAP, 6);
    });

    it('Given a cruise leg, Then propellant:action is not emitted every frame (at most one per second of cruise)', () => {
      const r = fuelled(CAP);
      r.press.add('cruise');
      r.step(CRUISE_DEFAULTS.spoolTime + 0.5);
      expect(r.cruise.drive.phase).toBe('cruise');
      actions = [];
      const frames = 4 * 60; // 4 s at 60 fps
      r.step(frames * H);
      expect(r.cruise.drive.phase).toBe('cruise');
      expect(of('cruise-leg').length).toBeLessThanOrEqual(5);
      expect(of('cruise-leg').length).toBeLessThan(frames / 10);
    });

    it('Given a cruise leg flown and dropped out of, Then the emitted cruise-leg kg add up to what left the tank for the leg', () => {
      const r = fuelled(CAP);
      r.press.add('cruise');
      r.step(H); // the spool is paid on this frame; the leg has not begun
      // Start counting at the segment's start: a window opened mid-segment
      // would catch kg billed before kg0 in the first announcement.
      const kg0 = r.flight.propellant!.massKg;
      actions = [];
      r.step(CRUISE_DEFAULTS.spoolTime + 0.5);
      expect(r.cruise.drive.phase).toBe('cruise');
      r.step(3);
      r.press.add('cruise'); // release: cruise → dropping → idle
      r.step(5);
      expect(r.cruise.drive.phase).toBe('idle');
      const billed = kg0 - r.flight.propellant!.massKg;
      const announced = of('cruise-leg').reduce((s, e) => s + e.kg, 0);
      expect(billed).toBeGreaterThan(0);
      expect(of('cruise-leg').length).toBeGreaterThan(0);
      expect(Math.abs(announced - billed) / billed).toBeLessThan(1e-6);
      // Nothing else touched the tank in that stretch.
      expect(actions.every((e) => e.action.kind === 'cruise-leg')).toBe(true);
    });

    // R7 (2): a save must see every kg the leg has billed as cruise, never as
    // thrust — so the leg billed since the last announcement can be flushed on
    // demand, once, without being announced again later.
    describe('R7: flushLeg() — the pending leg, announced on demand', () => {
      /** Into cruise, then 0.4 s into a fresh segment (less than the 1 s announce period). */
      function midSegment(): { r: Rig; kgAtLastAnnounce: number } {
        const r = fuelled(CAP);
        r.press.add('cruise');
        r.step(CRUISE_DEFAULTS.spoolTime + 0.5);
        expect(r.cruise.drive.phase).toBe('cruise');
        // Wait for an announcement, so a segment starts on a known frame.
        actions = [];
        for (let i = 0; i < 120 && of('cruise-leg').length === 0; i++) r.step(H);
        expect(of('cruise-leg').length).toBe(1);
        const kgAtLastAnnounce = r.flight.propellant!.massKg;
        actions = [];
        r.step(0.4);
        expect(of('cruise-leg')).toHaveLength(0);
        return { r, kgAtLastAnnounce };
      }

      it('Given 0.4 s of leg billed but not yet announced, When flushLeg(), Then one cruise-leg is announced with exactly the kg billed since the last announcement', () => {
        const { r, kgAtLastAnnounce } = midSegment();
        const billed = kgAtLastAnnounce - r.flight.propellant!.massKg;
        expect(billed).toBeGreaterThan(0);
        r.cruise.flushLeg();
        const legs = of('cruise-leg');
        expect(legs).toHaveLength(1);
        expect(Math.abs(legs[0]!.kg - billed)).toBeLessThan(1e-9);
        expect(Math.abs(legs[0]!.tankDeltaKg + billed)).toBeLessThan(1e-9);
      });

      it('Given a flushLeg(), When flushLeg() is called again at once, Then nothing more is announced', () => {
        const { r } = midSegment();
        r.cruise.flushLeg();
        r.cruise.flushLeg();
        expect(of('cruise-leg')).toHaveLength(1);
      });

      it('Given a flush mid-segment and the cruise flown on and dropped out of, Then all cruise-leg kg add up to the tank\'s drop — nothing counted twice, nothing lost', () => {
        const { r, kgAtLastAnnounce } = midSegment();
        r.cruise.flushLeg();
        r.step(1.7);
        r.cruise.flushLeg();
        r.step(0.3);
        r.press.add('cruise');
        r.step(5);
        expect(r.cruise.drive.phase).toBe('idle');
        const billed = kgAtLastAnnounce - r.flight.propellant!.massKg;
        const announced = of('cruise-leg').reduce((s, e) => s + e.kg, 0);
        expect(Math.abs(announced - billed) / billed).toBeLessThan(1e-9);
        const delta = of('cruise-leg').reduce((s, e) => s + e.tankDeltaKg, 0);
        expect(Math.abs(delta + billed) / billed).toBeLessThan(1e-9);
      });

      it('Given no cruise at all, When flushLeg(), Then nothing is announced', () => {
        const r = fuelled(CAP);
        r.cruise.flushLeg();
        expect(actions).toEqual([]);
      });
    });
  });
});

