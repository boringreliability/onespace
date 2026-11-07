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
      flight.applyInput(axes, false, r.brake); // Pilot
      cruise.update(H, ctx);
      press.clear();
      elapsed += H;
    }
  };

  const r: Rig = { cruise, flight, world, axes, press, logs, step, brake: false };
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

