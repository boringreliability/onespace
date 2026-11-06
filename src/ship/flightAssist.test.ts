/**
 * Flight assist, two levels (GAMEPLAY P2 / F4).
 *
 * FA-ON: the throttle lever means *desired forward speed* relative to the
 * parent, and the flight computer flies the ship there — main drive, retro and
 * RCS, every one of them inside its own authority. It must FLY the physics,
 * never lie about it: the per-step change of velocity is bounded by the thrust
 * the hull actually has, so there is no velocity teleport anywhere.
 *
 * FA-OFF: the Newtonian model as it was. The coasting-orbit and landing tests
 * in soi.test.ts run on a default FlightModel, which is FA-OFF, and are the
 * main proof that this path was not disturbed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { bus } from '@/core/EventBus';
import { DEFAULT_SHIP_CONFIG, FlightModel, assistTargetSpeed } from './FlightModel';

const C = DEFAULT_SHIP_CONFIG;
const MAIN = (C.mainThrust / C.mass) * 1e-3; // km/s²
const RETRO = (C.brakeThrust / C.mass) * 1e-3;
const RCS = (C.rcsThrust / C.mass) * 1e-3;
const H = 1 / 120; // one physics substep per frame, so per-frame Δv is per-step Δv

/** Deep space (mu 0), at rest, nose along -Z (identity orientation). */
function deepSpace(assist: boolean): FlightModel {
  const fm = new FlightModel(C);
  fm.flightAssist = assist;
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0 });
  fm.teleport(new Vector3(0, 0, 0), new Vector3(0, 0, 0), new Quaternion());
  return fm;
}

function run(fm: FlightModel, seconds: number, dt = H): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) fm.update(dt);
}

const quiet: Array<() => void> = [];
afterEach(() => {
  while (quiet.length) quiet.pop()!();
});

// ---------------------------------------------------------------------------

describe('assistTargetSpeed: throttle lever → set speed', () => {
  const VMAX = C.topSpeed;

  it('Given the lever at 0, Then the set speed is exactly 0 (all stop)', () => {
    expect(assistTargetSpeed(0, VMAX)).toBe(0);
  });

  it('Given the lever at 1, Then the set speed is the ceiling', () => {
    expect(assistTargetSpeed(1, VMAX)).toBeCloseTo(VMAX, 9);
  });

  it('Given the lever swept 0→1, Then the set speed rises strictly monotonically', () => {
    let prev = -1;
    for (let t = 0; t <= 1.000001; t += 0.01) {
      const v = assistTargetSpeed(t, VMAX);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('Given the bottom tenth of the lever, Then it spans landing speeds (≤ 100 m/s), i.e. fine control near 0', () => {
    expect(assistTargetSpeed(0.1, VMAX)).toBeLessThanOrEqual(0.1);
    expect(assistTargetSpeed(0.1, VMAX)).toBeGreaterThan(0.005);
  });

  it('Given mid-lever, Then the set speed is in the orbital band (1-5 km/s)', () => {
    const v = assistTargetSpeed(0.5, VMAX);
    expect(v).toBeGreaterThan(1);
    expect(v).toBeLessThan(5);
  });

  it('Given a lever value out of range or not finite, Then it is clamped (NaN → 0)', () => {
    expect(assistTargetSpeed(-0.5, VMAX)).toBe(0);
    expect(assistTargetSpeed(Number.NaN, VMAX)).toBe(0);
    expect(assistTargetSpeed(7, VMAX)).toBeCloseTo(VMAX, 9);
  });
});

// ---------------------------------------------------------------------------

describe('retro authority', () => {
  it('Given the default ship, Then the retro drive is at least as strong as the main drive (B4 asymmetry removed)', () => {
    expect(RETRO).toBeGreaterThanOrEqual(MAIN);
  });

  it('Given the default ship, Then RCS authority is 0.1 km/s² (raised 2× so drift dies in seconds, not a minute)', () => {
    expect(RCS).toBeCloseTo(0.1, 9);
  });

  it('Given FA-OFF at 2 km/s, When the brake is held, Then the ship stops in about v/a_retro seconds', () => {
    const fm = deepSpace(false);
    fm.teleport(new Vector3(), new Vector3(0, 0, -2), new Quaternion());
    fm.command.brake = true;
    run(fm, 2 / RETRO + 0.5);
    expect(fm.speed).toBeLessThan(1e-3);
  });
});

// ---------------------------------------------------------------------------

describe('flight assist toggle', () => {
  it('Given a new FlightModel, Then FA is OFF (headless physics is Newtonian) and attitude hold is ON', () => {
    // The class default keeps every orbit, landing and traffic test plain
    // Newtonian. The game switches FA-ON for the player's ship in Pilot.
    const fm = new FlightModel();
    expect(fm.flightAssist).toBe(false);
    expect(fm.attitudeHold).toBe(true);
  });

  it('Given FA is toggled, Then it logs exactly once per change and not on a no-op', () => {
    const texts: string[] = [];
    quiet.push(bus.on('log', ({ text }) => texts.push(text)));
    const fm = new FlightModel();
    fm.flightAssist = true;
    fm.flightAssist = true;
    fm.flightAssist = false;
    expect(texts.length).toBe(2);
    expect(texts[0]).toMatch(/ASSIST/);
    expect(texts[1]).toMatch(/ASSIST/);
  });

  it('Given attitude hold off, When a spin is started and released, Then it keeps rotating (vacuum)', () => {
    const fm = new FlightModel();
    fm.attitudeHold = false;
    fm.command.pitch = 1;
    run(fm, 1);
    const spun = fm.angularVelocity.length();
    fm.command.pitch = 0;
    run(fm, 5);
    expect(fm.angularVelocity.length()).toBeCloseTo(spun, 6);
  });

  it('Given attitude hold on, When a spin is released, Then it bleeds off within about a second', () => {
    const fm = new FlightModel();
    fm.command.pitch = 1;
    run(fm, 3);
    const held = fm.angularVelocity.length();
    fm.command.pitch = 0;
    run(fm, 1);
    expect(fm.angularVelocity.length()).toBeLessThan(held * 0.1);
  });
});

// ---------------------------------------------------------------------------

describe('FA-ON: speed hold', () => {
  it('Given FA-ON at rest, When the lever is set to mid, Then the ship reaches v_set along the nose and holds it', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0.5;
    const vset = assistTargetSpeed(0.5, C.topSpeed);
    expect(fm.assistTargetKmS).toBeCloseTo(0, 9); // nothing has run yet

    run(fm, vset / MAIN + 10);
    expect(fm.assistTargetKmS).toBeCloseTo(vset, 6);
    expect(fm.speed).toBeCloseTo(vset, 2);
    // Along the nose, not merely the right magnitude.
    expect(fm.velocity.clone().normalize().dot(fm.forward)).toBeGreaterThan(0.9999);

    run(fm, 30);
    expect(Math.abs(fm.speed - vset) / vset).toBeLessThan(0.01);
  });

  it('Given FA-ON at overspeed along the nose, When the lever asks for less, Then retro brings it down to v_set without undershooting much', () => {
    const fm = deepSpace(true);
    fm.teleport(new Vector3(), new Vector3(0, 0, -6), new Quaternion());
    fm.command.throttle = 0.5;
    const vset = assistTargetSpeed(0.5, C.topSpeed);

    let min = Infinity;
    const n = Math.round(((6 - vset) / RETRO + 15) / H);
    for (let i = 0; i < n; i++) {
      fm.update(H);
      min = Math.min(min, fm.speed);
    }
    expect(Math.abs(fm.speed - vset) / vset).toBeLessThan(0.01);
    expect(min).toBeGreaterThan(vset * 0.97);
  });

  it('Given FA-ON with sideways drift, Then RCS damps the lateral velocity away while forward speed holds', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0.5;
    const vset = assistTargetSpeed(0.5, C.topSpeed);
    fm.teleport(new Vector3(), new Vector3(0.5, -0.3, -vset), new Quaternion());

    run(fm, 0.5 / RCS + 10);
    const lateral = Math.hypot(fm.velocity.dot(fm.right), fm.velocity.dot(fm.up));
    expect(lateral).toBeLessThan(0.005);
    expect(Math.abs(fm.speed - vset) / vset).toBeLessThan(0.01);
  });

  it('Given FA-ON with the lever at exactly 0 (the detent), Then it coasts: no translational thrust, velocity exactly constant', () => {
    const fm = deepSpace(true);
    const v0 = new Vector3(0.4, -0.1, -3);
    fm.teleport(new Vector3(), v0, new Quaternion());
    fm.command.throttle = 0;
    run(fm, 10);
    expect(fm.velocity.x).toBe(v0.x);
    expect(fm.velocity.y).toBe(v0.y);
    expect(fm.velocity.z).toBe(v0.z);
    expect(fm.assistState).toBe('coast');
    expect(fm.assistTargetKmS).toBe(0);
  });

  it('Given FA-ON coasting, When the lever comes off the detent, Then it starts holding speed', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0;
    run(fm, 1);
    expect(fm.assistState).toBe('coast');
    fm.command.throttle = 0.01;
    run(fm, 1);
    expect(fm.assistState).toBe('hold');
    expect(fm.assistTargetKmS).toBeCloseTo(assistTargetSpeed(0.01, C.topSpeed), 9);
  });

  it('Given FA-ON holding speed, When the nose is turned 90°, Then the velocity swings round to follow the new nose', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0.4;
    const vset = assistTargetSpeed(0.4, C.topSpeed);
    run(fm, vset / MAIN + 10);

    // Point the nose along -X. The old velocity is now pure lateral drift.
    fm.orientation.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    run(fm, vset / RCS + 20);
    const along = fm.velocity.clone().normalize().dot(fm.forward);
    expect(along).toBeGreaterThan(Math.cos((1 * Math.PI) / 180));
    expect(Math.abs(fm.speed - vset) / vset).toBeLessThan(0.02);
  });

  it('Given FA-ON with the brake held, Then the set speed is overridden to 0 and the ship stops', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 1;
    fm.teleport(new Vector3(), new Vector3(0, 0, -2), new Quaternion());
    fm.command.brake = true;
    run(fm, 2 / RETRO + 10);
    expect(fm.speed).toBeLessThan(1e-3);
    expect(fm.assistState).toBe('stop');
    expect(fm.assistTargetKmS).toBe(0);
  });

  it('Given FA-ON drifting sideways, When the brake is held, Then the stop kills every axis, not just the nose', () => {
    const fm = deepSpace(true);
    fm.teleport(new Vector3(), new Vector3(1, -1, 0.5), new Quaternion());
    fm.command.throttle = 0;
    fm.command.brake = true;
    run(fm, 1 / RCS + 10);
    expect(fm.speed).toBeLessThan(1e-3);
  });

  it('Given FA-OFF, Then the assist state reads off whatever the lever and brake say', () => {
    const fm = deepSpace(false);
    fm.command.throttle = 0.5;
    fm.command.brake = true;
    run(fm, 0.1);
    expect(fm.assistState).toBe('off');
    expect(fm.assistTargetKmS).toBe(0);
  });

  it('Given FA-ON and a strafe command, Then the pilot’s strafe wins on that axis (the computer does not fight the stick)', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0;
    fm.command.strafeX = 1;
    run(fm, 2);
    expect(fm.velocity.dot(fm.right)).toBeGreaterThan(RCS * 2 * 0.8);
  });

  it('Given FA-ON from rest, Then the engine readout is honest: near full while accelerating, near idle once holding', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0.5;
    const vset = assistTargetSpeed(0.5, C.topSpeed);
    run(fm, 2);
    expect(fm.throttle).toBeGreaterThan(0.8);
    run(fm, vset / MAIN + 15);
    expect(fm.throttle).toBeLessThan(0.05);
  });
});

describe('FA-ON: thrust limits (no velocity teleport)', () => {
  /**
   * Run a scenario one substep per frame and check every step's Δv against
   * the hull's authority, resolved into body axes. In deep space there is no
   * gravity or drag, so Δv/h IS the thrust acceleration.
   */
  function worstAccel(setup: (fm: FlightModel) => void, seconds: number): { fwd: number; back: number; lat: number } {
    const fm = deepSpace(true);
    setup(fm);
    let fwd = 0;
    let back = 0;
    let lat = 0;
    const prev = new Vector3();
    const dv = new Vector3();
    for (let i = 0; i < Math.round(seconds / H); i++) {
      prev.copy(fm.velocity);
      fm.update(H);
      dv.copy(fm.velocity).sub(prev).multiplyScalar(1 / H);
      const f = dv.dot(fm.forward);
      fwd = Math.max(fwd, f);
      back = Math.max(back, -f);
      lat = Math.max(lat, Math.abs(dv.dot(fm.right)), Math.abs(dv.dot(fm.up)));
    }
    return { fwd, back, lat };
  }

  it('Given FA-ON accelerating from rest, Then no step exceeds the main drive', () => {
    const w = worstAccel((fm) => {
      fm.command.throttle = 0.8;
    }, 20);
    expect(w.fwd).toBeLessThanOrEqual(MAIN * (1 + 1e-6));
    expect(w.fwd).toBeGreaterThan(MAIN * 0.5); // and it did actually use it
  });

  it('Given FA-ON braking from overspeed, Then no step exceeds the retro drive', () => {
    const w = worstAccel((fm) => {
      fm.teleport(new Vector3(), new Vector3(0, 0, -8), new Quaternion());
      fm.command.throttle = 0;
      fm.command.brake = true;
    }, 20);
    expect(w.back).toBeLessThanOrEqual(RETRO * (1 + 1e-6));
    expect(w.back).toBeGreaterThan(RETRO * 0.5);
  });

  it('Given FA-ON killing drift, Then no step exceeds RCS on either lateral axis', () => {
    const w = worstAccel((fm) => {
      fm.teleport(new Vector3(), new Vector3(2, 2, 0), new Quaternion());
      fm.command.throttle = 0;
      fm.command.brake = true;
    }, 20);
    expect(w.lat).toBeLessThanOrEqual(RCS * (1 + 1e-6));
    expect(w.lat).toBeGreaterThan(RCS * 0.5);
  });
});

describe('FA-ON: gravity and the ground', () => {
  const MU = 398600;
  const R = 6371;

  function nearEarth(assist: boolean, v = new Vector3()): FlightModel {
    const fm = new FlightModel(C);
    fm.flightAssist = assist;
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: MU, radius: R });
    fm.teleport(new Vector3(0, 7000, 0), v, new Quaternion());
    fm.command.throttle = 0;
    return fm;
  }

  it('Given FA-ON at rest near an Earth-mass parent with the lever at 0, Then it coasts (falls freely, exactly as FA-OFF would)', () => {
    const on = nearEarth(true);
    const off = nearEarth(false);
    run(on, 30);
    run(off, 30);
    // g at 7000 km is ~8.1 m/s²; 30 s of free fall is ~0.24 km/s.
    expect(on.speed).toBeGreaterThan(0.2);
    expect(on.verticalSpeed).toBeLessThan(0);
    expect(on.position.equals(off.position)).toBe(true);
    expect(on.velocity.equals(off.velocity)).toBe(true);
  });

  it('Given FA-ON in a circular orbit with the lever at 0, Then the orbit survives hands-off (spawn and cruise-drop depend on it)', () => {
    const probe = nearEarth(true);
    const v = probe.orbitalVelocityAt(new Vector3(0, 7000, 0));
    const fm = nearEarth(true, v);
    let rMin = Infinity;
    let rMax = 0;
    for (let i = 0; i < 120 * 120; i++) {
      fm.update(H);
      const r = fm.position.length();
      rMin = Math.min(rMin, r);
      rMax = Math.max(rMax, r);
    }
    expect((rMax - rMin) / 7000).toBeLessThan(1e-4);
  });

  it('Given FA-ON at rest near an Earth-mass parent with the brake held, Then the computer holds station against gravity', () => {
    const fm = nearEarth(true);
    fm.command.brake = true;
    run(fm, 30);
    expect(fm.speed).toBeLessThan(0.01);
    expect(Math.abs(fm.position.length() - 7000)).toBeLessThan(1);
    expect(fm.assistState).toBe('stop');
  });

  it('Given FA-ON in a hold near a parent, Then gravity is compensated so the set speed is held along the nose', () => {
    const fm = nearEarth(true);
    fm.command.throttle = 0.2;
    const vset = assistTargetSpeed(0.2, C.topSpeed);
    run(fm, 30);
    expect(Math.abs(fm.speed - vset) / vset).toBeLessThan(0.02);
    expect(fm.velocity.clone().normalize().dot(fm.forward)).toBeGreaterThan(0.999);
  });

  it('Given FA-ON landed with the lever at 0, Then it stays on the ground (the computer does not hover the ship off its gear)', () => {
    const fm = new FlightModel(C);
    fm.flightAssist = true;
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: MU, radius: R });
    fm.setGroundSampler((p) => p.length() - R);
    fm.teleport(new Vector3(0, R + 0.002, 0), new Vector3(0, 0, 0), new Quaternion());
    fm.command.throttle = 0;
    run(fm, 10, 1 / 60);
    expect(fm.grounded).toBe(true);
    expect(Math.abs(fm.altitude)).toBeLessThan(0.01);
  });
});

describe('FA-ON: framerate and cruise', () => {
  it('Given the same command, When FA-ON runs at 30 and 120 fps, Then the result is identical (fixed substep)', () => {
    const a = deepSpace(true);
    const b = deepSpace(true);
    a.command.throttle = 0.6;
    b.command.throttle = 0.6;
    run(a, 5, 1 / 120);
    run(b, 5, 1 / 30);
    expect(Math.abs(a.speed - b.speed) / a.speed).toBeLessThan(1e-6);
  });

  it('Given the cruise drive engaged, Then FA-ON changes nothing: cruise is its own force model', () => {
    const on = deepSpace(true);
    const off = deepSpace(false);
    for (const fm of [on, off]) {
      fm.command.throttle = 1;
      fm.setCruise(1e4);
      run(fm, 5, 1 / 60);
    }
    expect(on.velocity.distanceTo(off.velocity)).toBe(0);
    expect(on.position.distanceTo(off.position)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('FA-OFF: Newtonian, unchanged', () => {
  it('Given FA-OFF coasting with the lever at 0, Then velocity is exactly constant (no hidden damping)', () => {
    const fm = deepSpace(false);
    const v0 = new Vector3(0.3, -0.2, -1.7);
    fm.teleport(new Vector3(), v0, new Quaternion());
    fm.command.throttle = 0;
    run(fm, 10);
    expect(fm.velocity.x).toBe(v0.x);
    expect(fm.velocity.y).toBe(v0.y);
    expect(fm.velocity.z).toBe(v0.z);
  });

  it('Given FA-OFF at full lever from rest for 10 s, Then speed matches a·t to within the limiter loss (throttle is thrust, not speed)', () => {
    const fm = deepSpace(false);
    fm.command.throttle = 1;
    run(fm, 4); // spool up, as the self-test does
    fm.teleport(new Vector3(), new Vector3(), new Quaternion());
    fm.command.throttle = 1;
    // teleport does not touch the spooled engine, so this is a clean burn.
    run(fm, 10);
    const ideal = MAIN * 10;
    expect(Math.abs(fm.speed - ideal) / ideal).toBeLessThan(0.03);
  });

  it('Given FA toggled on and back off before flight, Then the trajectory is bit-identical to a never-toggled ship', () => {
    const a = deepSpace(false);
    const b = deepSpace(false);
    b.flightAssist = true;
    b.flightAssist = false;
    for (const fm of [a, b]) {
      fm.command.throttle = 0.7;
      fm.command.yaw = 0.3;
      fm.command.strafeY = -0.5;
    }
    run(a, 8);
    run(b, 8);
    expect(b.position.equals(a.position)).toBe(true);
    expect(b.velocity.equals(a.velocity)).toBe(true);
    expect(b.orientation.equals(a.orientation)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Review p1a: findings, and tests for the survivors of the mutation run
// ---------------------------------------------------------------------------

describe('review p1a: the coast detent cuts the drive', () => {
  it('Given FA-ON accelerating at full main drive, When the lever goes to the detent, Then from the next substep there is no thrust at all (no spool tail)', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0.6;
    run(fm, 2); // far below v_set: the computer has the main drive pinned
    expect(fm.throttle).toBeGreaterThan(0.9);

    fm.command.throttle = 0;
    run(fm, H);
    const v = fm.velocity.clone();
    run(fm, 3);
    expect(fm.velocity.equals(v)).toBe(true);
    expect(fm.throttle).toBe(0);
    expect(fm.assistState).toBe('coast');
  });

  it('Given FA-ON hovering on the brake with the nose up, When the brake is released at lever 0, Then it falls freely at once (the hover thrust does not linger)', () => {
    const fm = new FlightModel(C);
    fm.flightAssist = true;
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 398600, radius: 6371 });
    const noseUp = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    fm.teleport(new Vector3(0, 7000, 0), new Vector3(), noseUp);
    fm.command.brake = true;
    run(fm, 5);
    expect(fm.throttle).toBeGreaterThan(0); // the main drive carries the hover

    fm.command.brake = false;
    run(fm, H);
    expect(fm.throttle).toBe(0);
    const vz0 = fm.verticalSpeed;
    run(fm, 1);
    // g at 7000 km is ~8.1 m/s². A hover decaying over the 0.7 s spool would
    // lose well under half of that in the first second.
    expect(vz0 - fm.verticalSpeed).toBeGreaterThan(0.0078);
  });
});

describe('review p1a: mutation survivors', () => {
  it('Given a non-positive or NaN ceiling, Then the set speed is 0, never NaN', () => {
    expect(assistTargetSpeed(0.5, 0)).toBe(0);
    expect(assistTargetSpeed(0.5, -1)).toBe(0);
    expect(assistTargetSpeed(0.5, Number.NaN)).toBe(0);
  });

  it('Given FA-ON holding station on the brake near an Earth-mass parent, Then gravity is cancelled, not merely damped (no steady sag)', () => {
    const fm = new FlightModel(C);
    fm.flightAssist = true;
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 398600, radius: 6371 });
    fm.teleport(new Vector3(0, 7000, 0), new Vector3(), new Quaternion());
    fm.command.brake = true;
    run(fm, 30);
    // Without the feed-forward the P-loop settles at v = g·τ ≈ 4 m/s downward.
    expect(fm.speed).toBeLessThan(1e-5);
    expect(Math.abs(fm.position.length() - 7000)).toBeLessThan(0.005);
  });

  it('Given FA-ON landed with the brake held, Then the computer spends no thrust holding the ship against its own gear', () => {
    const R = 6371;
    const fm = new FlightModel(C);
    fm.flightAssist = true;
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 398600, radius: R });
    fm.setGroundSampler((p) => p.length() - R);
    fm.teleport(new Vector3(0, R + 0.002, 0), new Vector3(), new Quaternion());
    run(fm, 5, 1 / 60);
    expect(fm.grounded).toBe(true);
    fm.command.brake = true;
    run(fm, 5, 1 / 60);
    expect(fm.grounded).toBe(true);
    // Thrust-only proper acceleration: ~0 when the gear carries the weight,
    // ~0.83 g if the computer cancels gravity on the ground as well.
    expect(fm.gForce).toBeLessThan(0.05);
  });

  it('Given FA-ON at full lever near the ceiling, Then the main drive is still faded by the speed limiter', () => {
    const fm = deepSpace(true);
    fm.teleport(new Vector3(), new Vector3(0, 0, -0.9 * C.topSpeed), new Quaternion());
    fm.command.throttle = 1;
    const before = fm.velocity.length();
    run(fm, H);
    const gained = fm.velocity.length() - before;
    const limiter = 1 - Math.pow(0.9, C.speedFalloffExponent);
    expect(gained).toBeGreaterThan(0);
    expect(gained).toBeLessThanOrEqual(MAIN * limiter * H * 1.0001);
  });

  it('Given FA-ON and a lateral (X) strafe, Then the pilot’s strafe wins on that axis too', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0.2;
    fm.command.strafeX = 1;
    run(fm, 2);
    // Full RCS to the right for 2 s, unopposed by the computer.
    expect(fm.velocity.dot(fm.right)).toBeGreaterThan(RCS * 2 * 0.99);
  });

  it('Given FA-ON in a hold, When FA is switched off, Then the readouts say off at once, before the next update', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0.3;
    run(fm, 1);
    expect(fm.assistState).toBe('hold');
    quiet.push(bus.on('log', () => {}));
    fm.flightAssist = false;
    expect(fm.assistState).toBe('off');
    expect(fm.assistTargetKmS).toBe(0);
  });

  it('Given FA-ON in a hold, When the lever goes to the detent, Then the set-speed readout is 0', () => {
    const fm = deepSpace(true);
    fm.command.throttle = 0.3;
    run(fm, 1);
    expect(fm.assistTargetKmS).toBeGreaterThan(0);
    fm.command.throttle = 0;
    run(fm, H);
    expect(fm.assistTargetKmS).toBe(0);
  });
});
