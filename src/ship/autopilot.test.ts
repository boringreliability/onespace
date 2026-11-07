/**
 * v2 phase 4 (GAMEPLAY P4) — auto-land and auto-orbit on `L`.
 *
 * The autopilot is a computer at the controls, not a cut: it may only write
 * `FlightModel.command` — stick, throttle, strafe, boost — exactly as the
 * pilot can. Every test here therefore runs the REAL FlightModel with real
 * gravity, real terrain contact and (where the world has one) real drag, and
 * judges the result by what the flight model itself reports: the touchdown
 * event it emits, and the orbit it leaves behind.
 *
 * Terrain is deliberately NOT the sphere. The worlds below carry a plateau a
 * few kilometres above the datum, so a descent profile keyed to `|r| − R`
 * would meet the ground at the speed it planned to have 3-5 km higher — a
 * hard landing or a crash. Only a profile keyed to the ground sampler lands
 * clean.
 *
 * Durations are printed (console.info) so the report can quote them.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import { DEFAULT_SHIP_CONFIG, FlightModel, type ParentBody } from './FlightModel';
import {
  Autopilot,
  FINAL_ALTITUDE_KM,
  FINAL_MAX_DESCENT_KMS,
  ORBIT_TARGET_RADII,
  autopilotRefusal,
  descentSpeedKmS,
  orbitApsides,
  type AutopilotWorld,
} from './autopilot';
import { openingAttitude } from '@/game/recovery';

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

interface TestWorld extends AutopilotWorld {
  readonly name: string;
  /** Surface pressure handed to the drag model, as Universe does; 0 = vacuum. */
  readonly pressure: number;
  readonly scaleHeightKm: number;
  /** Plateau height above the datum, km — the trap for a sphere-keyed profile. */
  readonly plateauKm: number;
  /** Amplitude of the rolling relief on top of the plateau, km. */
  readonly reliefKm: number;
}

/** Remit 31 (the opening world): R 7 240 km, ~1 g, 187 km of air (GAMEPLAY B3). */
const REMIT: TestWorld = {
  name: 'Remit 31',
  radiusKm: 7_240,
  mu: 9.8e-3 * 7_240 ** 2,
  atmosphereTopKm: 187,
  pressure: 1,
  scaleHeightKm: 14.6,
  plateauKm: 3.5,
  reliefKm: 1.5,
};

/** A thick-air world: Vhessvaem-like scale height (72 km), 4 bar. */
const THICK: TestWorld = {
  name: 'thick atmosphere',
  radiusKm: 6_000,
  mu: 9.8e-3 * 6_000 ** 2,
  atmosphereTopKm: 1_000,
  pressure: 4,
  scaleHeightKm: 72,
  plateauKm: 2,
  reliefKm: 1,
};

/** A small airless moon: R 1 000 km, 1.5 m/s² at the surface. */
const MOON: TestWorld = {
  name: 'small moon',
  radiusKm: 1_000,
  mu: 1_500,
  atmosphereTopKm: 0,
  pressure: 0,
  scaleHeightKm: 1,
  plateauKm: 4,
  reliefKm: 2,
};

/** Terrain radius along a unit direction: datum + plateau + smooth relief. */
function terrainRadius(w: TestWorld, dir: Vector3): number {
  const relief =
    w.reliefKm * 0.5 * (1 + Math.sin(dir.x * 7.1 + dir.y * 3.3) * Math.cos(dir.z * 5.7 - dir.y * 2.1));
  return w.radiusKm + w.plateauKm + relief;
}

/** Highest terrain anywhere on the world, km above the datum. */
function terrainCeilingKm(w: TestWorld): number {
  return w.plateauKm + w.reliefKm;
}

interface Rig {
  fm: FlightModel;
  frame: ParentBody;
  w: TestWorld;
}

const dirScratch = new Vector3();

function rig(w: TestWorld): Rig {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  const frame: ParentBody = { position: new Vector3(), velocity: new Vector3(), mu: w.mu, radius: w.radiusKm };
  fm.setParent(frame);
  fm.setGroundSampler((p) => {
    const d = p.length();
    dirScratch.copy(p).divideScalar(d);
    return d - terrainRadius(w, dirScratch);
  });
  return { fm, frame, w };
}

/** The opening orbit: 1.6 R, circular, nose prograde pitched 30° down (Universe). */
function openingOrbit(r: Rig): void {
  const pos = new Vector3(-0.8, 0.35, -0.5).normalize().multiplyScalar(r.w.radiusKm * 1.6);
  const vel = r.fm.orbitalVelocityAt(pos);
  const q = openingAttitude(vel, pos, new Quaternion());
  r.fm.teleport(pos, vel, q);
}

/** Universe's drag model: exp(−alt/H)·pressure against the sphere. */
function applyAtmosphere(r: Rig): void {
  if (r.w.pressure <= 0) {
    r.fm.setAtmosphere(0);
    return;
  }
  const alt = r.fm.position.length() - r.w.radiusKm;
  r.fm.setAtmosphere(Math.exp(-Math.max(0, alt) / r.w.scaleHeightKm) * r.w.pressure);
}

const FRAME = 1 / 60;

interface Flight {
  result: string;
  seconds: number;
  /** Worst vertical descent rate seen below FINAL_ALTITUDE_KM, km/s (positive = down). */
  worstFinalDescent: number;
  /** Worst |Δv/dt − gravity − drag| beyond what the hull's actuators can deliver, km/s². */
  worstUnexplained: number;
  touchdowns: Array<{ vertical: number; speed: number }>;
  crashes: number;
}

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

/**
 * One frame as the game runs it: the autopilot writes the command (it runs
 * after Pilot), then Universe integrates and hands in the air density.
 */
function fly(r: Rig, ap: Autopilot, maxSeconds: number): Flight {
  const out: Flight = {
    result: 'flying',
    seconds: 0,
    worstFinalDescent: 0,
    worstUnexplained: 0,
    touchdowns: [],
    crashes: 0,
  };
  offs.push(
    bus.on('ship:touchdown', ({ vertical, speed }) => out.touchdowns.push({ vertical, speed })),
    bus.on('ship:crashed', () => {
      out.crashes++;
    }),
  );

  const c = DEFAULT_SHIP_CONFIG;
  // Everything the hull can push with at once, km/s²: boosted main + all three
  // RCS axes. Anything beyond this (plus gravity and drag) is a teleport.
  const authority =
    (c.mainThrust / c.mass) * 1e-3 * c.boostMultiplier + Math.sqrt(3) * (c.rcsThrust / c.mass) * 1e-3;
  const prevV = new Vector3();
  const dv = new Vector3();

  const n = Math.ceil(maxSeconds / FRAME);
  for (let i = 0; i < n; i++) {
    applyAtmosphere(r);
    out.result = ap.step(r.fm, r.w);
    if (out.result !== 'flying') break;

    prevV.copy(r.fm.velocity);
    const wasGrounded = r.fm.grounded;
    const speedBefore = r.fm.speed;
    r.fm.update(FRAME);
    out.seconds += FRAME;

    // Physics only: the change in velocity must be gravity + drag + what the
    // actuators can do. Contact with the ground is a force too, so frames that
    // touch it are exempt.
    if (!wasGrounded && !r.fm.grounded && out.touchdowns.length === 0) {
      dv.subVectors(r.fm.velocity, prevV).divideScalar(FRAME).sub(r.fm.gravityAccel);
      const drag = c.dragCoefficient * r.fm.atmosphericDensity * speedBefore * speedBefore;
      out.worstUnexplained = Math.max(out.worstUnexplained, dv.length() - authority - drag);
    }

    if (r.fm.altitude < FINAL_ALTITUDE_KM && !r.fm.grounded) {
      out.worstFinalDescent = Math.max(out.worstFinalDescent, -r.fm.verticalSpeed);
    }
  }
  return out;
}

function report(label: string, f: Flight): void {
  console.info(
    `[autopilot] ${label}: ${f.result} after ${f.seconds.toFixed(0)} s` +
      (f.touchdowns[0] ? ` · touchdown ${(f.touchdowns[0].vertical * 1000).toFixed(2)} m/s` : ''),
  );
}

/** Seconds a player may be asked to watch the computer fly, per leg. */
const LEG_LIMIT_S = 600;

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

describe('auto-land from orbit (P4)', () => {
  for (const w of [REMIT, THICK, MOON]) {
    it(`Given the opening orbit at 1.6 R over ${w.name}, When L engages the autopilot hands-off, Then it touches down CLEAN (< 2 m/s) inside ${LEG_LIMIT_S} s, without a crash`, () => {
      const r = rig(w);
      openingOrbit(r);
      const ap = new Autopilot();
      ap.engage('land', r.fm, w);

      const f = fly(r, ap, LEG_LIMIT_S);
      report(`land ${w.name}`, f);

      expect(f.crashes).toBe(0);
      expect(f.result).toBe('landed');
      expect(f.touchdowns.length).toBeGreaterThanOrEqual(1);
      // The first contact is the one Pilot grades: < 2 m/s is "CLEAN".
      expect(f.touchdowns[0]!.vertical).toBeLessThan(0.002);
      expect(r.fm.grounded).toBe(true);
    });

    it(`Given the same descent over ${w.name}, Then below ${FINAL_ALTITUDE_KM} km of TERRAIN altitude it never descends faster than ${FINAL_MAX_DESCENT_KMS * 1000} m/s`, () => {
      const r = rig(w);
      openingOrbit(r);
      const ap = new Autopilot();
      ap.engage('land', r.fm, w);
      const f = fly(r, ap, LEG_LIMIT_S);
      expect(f.worstFinalDescent).toBeLessThanOrEqual(FINAL_MAX_DESCENT_KMS * 1.05);
    });

    it(`Given the same descent over ${w.name}, Then every frame's Δv is explained by gravity, drag and the hull's own actuators — no velocity teleports (a teleport is ≥ 60 km/s² in one frame; slack 1 m/s² covers drag changing inside the frame)`, () => {
      const r = rig(w);
      openingOrbit(r);
      const ap = new Autopilot();
      ap.engage('land', r.fm, w);
      const f = fly(r, ap, LEG_LIMIT_S);
      expect(f.worstUnexplained).toBeLessThan(1e-3);
    });
  }

  it('Given an autopilot landing, Then the flight model stays Newtonian for the leg and FA is restored to what the pilot had when it ends', () => {
    const r = rig(MOON);
    openingOrbit(r);
    r.fm.flightAssist = true; // the player's default
    const ap = new Autopilot();
    ap.engage('land', r.fm, MOON);
    expect(r.fm.flightAssist).toBe(false);
    fly(r, ap, LEG_LIMIT_S);
    ap.disengage(r.fm);
    expect(r.fm.flightAssist).toBe(true);
    expect(r.fm.command.throttle).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Orbit
// ---------------------------------------------------------------------------

/** Land a rig first (hands-off), so the orbit leg starts from a real touchdown. */
function landed(w: TestWorld): Rig {
  const r = rig(w);
  openingOrbit(r);
  const ap = new Autopilot();
  ap.engage('land', r.fm, w);
  fly(r, ap, LEG_LIMIT_S);
  ap.disengage(r.fm);
  // Settle on the gear for a few seconds, engines cold.
  for (let i = 0; i < 180; i++) {
    applyAtmosphere(r);
    r.fm.update(FRAME);
  }
  return r;
}

describe('auto-orbit from the ground (P4)', () => {
  for (const w of [REMIT, THICK, MOON]) {
    it(`Given the ship on the ground on ${w.name}, When L engages, Then it flies (not teleports) to a circular orbit near ${ORBIT_TARGET_RADII} R whose periapsis clears the atmosphere and the terrain, inside ${LEG_LIMIT_S} s`, () => {
      const r = landed(w);
      expect(r.fm.grounded).toBe(true);

      const ap = new Autopilot();
      ap.engage('orbit', r.fm, w);
      const f = fly(r, ap, LEG_LIMIT_S);
      report(`orbit ${w.name}`, f);

      expect(f.crashes).toBe(0);
      expect(f.result).toBe('orbit');
      expect(f.worstUnexplained).toBeLessThan(1e-3);

      const o = orbitApsides(r.fm.position, r.fm.velocity, w.mu, { periapsis: 0, apoapsis: 0, eccentricity: 0 });
      const floor = w.radiusKm + Math.max(w.atmosphereTopKm, terrainCeilingKm(w));
      expect(o.periapsis).toBeGreaterThan(floor);
      expect(o.eccentricity).toBeLessThan(0.05);
      const target = w.radiusKm * ORBIT_TARGET_RADII;
      expect(o.apoapsis).toBeGreaterThan(target * 0.9);
      expect(o.apoapsis).toBeLessThan(target * 1.1);
    });
  }

  it('Given a completed auto-orbit, When the ship then coasts hands-off for a full orbit with FA restored, Then it never dips below the atmosphere', () => {
    const w = REMIT;
    const r = landed(w);
    r.fm.flightAssist = true;
    const ap = new Autopilot();
    ap.engage('orbit', r.fm, w);
    fly(r, ap, LEG_LIMIT_S);
    ap.disengage(r.fm);
    expect(r.fm.flightAssist).toBe(true);

    const rr = r.fm.position.length();
    const period = 2 * Math.PI * Math.sqrt((rr * rr * rr) / w.mu);
    let lowest = Infinity;
    const H = 1 / 15;
    for (let t = 0; t < period; t += H) {
      applyAtmosphere(r);
      r.fm.command.throttle = 0; // FA coast detent: hands off
      r.fm.update(H);
      lowest = Math.min(lowest, r.fm.position.length() - w.radiusKm);
    }
    expect(lowest).toBeGreaterThan(w.atmosphereTopKm);
  });
});

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

describe('descent profile', () => {
  const brake = 0.25;
  it('Given altitude 0, Then the profile asks for a touchdown speed under the CLEAN limit (2 m/s) but above zero', () => {
    const v = descentSpeedKmS(0, brake);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(0.002);
  });

  it(`Given any altitude below ${FINAL_ALTITUDE_KM} km, Then the profile never exceeds ${FINAL_MAX_DESCENT_KMS * 1000} m/s`, () => {
    for (let h = 0; h <= FINAL_ALTITUDE_KM; h += 0.01) {
      expect(descentSpeedKmS(h, brake)).toBeLessThanOrEqual(FINAL_MAX_DESCENT_KMS + 1e-12);
    }
  });

  it('Given rising altitude, Then the profile never decreases (a monotone suicide-burn envelope)', () => {
    let last = 0;
    for (let h = 0; h < 10_000; h += 0.37) {
      const v = descentSpeedKmS(h, brake);
      expect(v).toBeGreaterThanOrEqual(last - 1e-12);
      last = v;
    }
  });

  it('Given the profile above the final segment, Then stopping from it at the brake rate is possible before the final segment (v² ≤ 2·a·Δh + v_final²)', () => {
    for (const h of [2.5, 10, 100, 1_000, 4_000]) {
      const v = descentSpeedKmS(h, brake);
      expect(v * v).toBeLessThanOrEqual(2 * brake * (h - FINAL_ALTITUDE_KM) + FINAL_MAX_DESCENT_KMS ** 2 + 1e-9);
    }
  });

  it('Given NaN or negative altitude, Then the profile still returns the touchdown speed, never NaN', () => {
    expect(Number.isFinite(descentSpeedKmS(Number.NaN, brake))).toBe(true);
    expect(descentSpeedKmS(-5, brake)).toBe(descentSpeedKmS(0, brake));
  });
});

describe('orbitApsides', () => {
  it('Given a circular state, Then periapsis = apoapsis = r and e ≈ 0', () => {
    const mu = 1_500;
    const p = new Vector3(1_600, 0, 0);
    const v = new Vector3(0, 0, -Math.sqrt(mu / 1_600));
    const o = orbitApsides(p, v, mu, { periapsis: 0, apoapsis: 0, eccentricity: 0 });
    expect(o.periapsis).toBeCloseTo(1_600, 6);
    expect(o.apoapsis).toBeCloseTo(1_600, 6);
    expect(o.eccentricity).toBeLessThan(1e-9);
  });

  it('Given an escape state, Then apoapsis is Infinity', () => {
    const mu = 1_500;
    const p = new Vector3(1_600, 0, 0);
    const v = new Vector3(0, 0, -2 * Math.sqrt(mu / 1_600));
    const o = orbitApsides(p, v, mu, { periapsis: 0, apoapsis: 0, eccentricity: 0 });
    expect(o.apoapsis).toBe(Number.POSITIVE_INFINITY);
    expect(o.eccentricity).toBeGreaterThanOrEqual(1);
  });

  it('Given a ship standing still (radial fall), Then periapsis is 0 — it is going to hit', () => {
    const o = orbitApsides(new Vector3(2_000, 0, 0), new Vector3(), 1_500, { periapsis: 1, apoapsis: 0, eccentricity: 0 });
    expect(o.periapsis).toBeCloseTo(0, 6);
  });
});

describe('autopilot refusals', () => {
  const ok = { presetAllows: true, cruising: false, warpIdle: true, hasWorld: true, distanceRadii: 1.6 };

  it('Given a SURVEY ship in orbit near a world, Then nothing refuses', () => {
    expect(autopilotRefusal(ok)).toBeNull();
  });
  it('Given a preset without an autopilot, Then it refuses with "preset" before anything else', () => {
    expect(autopilotRefusal({ ...ok, presetAllows: false, cruising: true })).toBe('preset');
  });
  it('Given the cruise drive engaged, Then it refuses with "cruise"', () => {
    expect(autopilotRefusal({ ...ok, cruising: true })).toBe('cruise');
  });
  it('Given a jump in progress, Then it refuses with "warp"', () => {
    expect(autopilotRefusal({ ...ok, warpIdle: false })).toBe('warp');
  });
  it('Given no parent world (the star frame), Then it refuses with "no-world"', () => {
    expect(autopilotRefusal({ ...ok, hasWorld: false })).toBe('no-world');
  });
  it('Given a world far beyond landing range, Then it refuses with "no-world"', () => {
    expect(autopilotRefusal({ ...ok, distanceRadii: 50 })).toBe('no-world');
    expect(autopilotRefusal({ ...ok, distanceRadii: Number.NaN })).toBe('no-world');
  });
});
