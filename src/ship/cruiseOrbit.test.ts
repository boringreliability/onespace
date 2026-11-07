/**
 * v2 phase 1 — arriving in orbit instead of a crater.
 *
 * v1 dropped the ship at 3 000 km clearance doing 60 km/s along the nose:
 * fifty seconds to the surface and 750 s of brake to stop. GAMEPLAY.md B4
 * measured it — 37.9 km/s at 519 km, 316× the crash limit.
 *
 * The drop now ends in a circular orbit about the ship's SOI parent at the
 * point where it lets go: speed √(μ/r), direction the tangential part of the
 * ship's own motion, i.e. in the plane of (r, v). That is a cheat, and the one
 * CRUISE.md already accepted — it has only moved from "bleed to 60 km/s" to
 * "bleed to orbit".
 *
 * These tests run the real `FlightModel` and real gravity after the drop, and
 * judge the result by the orbit it leaves behind, not by the velocity alone.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { DEFAULT_SHIP_CONFIG, FlightModel, entersSoi, type ParentBody } from './FlightModel';
import {
  CRUISE_DEFAULTS,
  CruiseDrive,
  arrivalClearanceKm,
  cruiseEtaSeconds,
  holdClearanceKm,
} from './CruiseDrive';
import { circularExitVelocity, circularSpeed, insertIntoOrbit } from './cruiseOrbit';

interface World {
  readonly name: string;
  readonly radius: number;
  readonly mu: number;
  readonly soi: number;
  readonly atmosphereTop: number;
}

/** Remit 31: R and atmosphere from GAMEPLAY.md, μ from ~1 g at the surface. */
const REMIT: World = { name: 'Remit 31', radius: 7_240, mu: 9.8e-3 * 7_240 ** 2, soi: 1e6, atmosphereTop: 187 };
const MOON: World = { name: 'a moon', radius: 1_000, mu: 1_500, soi: 6e4, atmosphereTop: 0 };
const GIANT: World = { name: 'a gas giant', radius: 79_000, mu: 1.27e8, soi: 5e7, atmosphereTop: 1_500 };

/** Nose (-Z) along `dir`. */
function facing(dir: Vector3): Quaternion {
  return new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir.clone().normalize());
}

/** Osculating periapsis and apoapsis of a parent-relative state. */
function apsides(r: Vector3, v: Vector3, mu: number): { rp: number; ra: number; e: number } {
  const rm = r.length();
  const energy = v.lengthSq() / 2 - mu / rm;
  const a = -mu / (2 * energy);
  const h = new Vector3().crossVectors(r, v).length();
  const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)));
  return { rp: a * (1 - e), ra: a * (1 + e), e };
}

interface Arrival {
  fm: FlightModel;
  frame: ParentBody;
  /** Clearance at the frame the drive let go. */
  handoverGapKm: number;
  /** Velocity direction just before the handover — the plane the orbit must keep. */
  normalBefore: Vector3;
  /** Closest clearance while the drive carried the ship. */
  closestUnderDrive: number;
  /** Seconds from 'cruise' to the start of the drop. */
  cruiseSeconds: number;
  reason: string | null;
}

/**
 * Fly the drive at a body from `startGap`, nose `offsetDeg` off the centre
 * line, until it hands over. Mirrors what `Cruise.ts` feeds the drive.
 */
function arrive(w: World, opts: { startGap?: number; offsetDeg?: number; h?: number } = {}): Arrival {
  const startGap = opts.startGap ?? 2e6;
  const h = opts.h ?? 1 / 60;
  const frame: ParentBody = { position: new Vector3(), velocity: new Vector3(), mu: w.mu, radius: w.radius };
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  fm.setParent(frame);
  const pos = new Vector3(w.radius + startGap, 0, 0);
  const toBody = pos.clone().negate().normalize();
  const off = ((opts.offsetDeg ?? 0) * Math.PI) / 180;
  const nose = toBody.clone().applyAxisAngle(new Vector3(0, 1, 0), off);
  fm.teleport(pos, new Vector3(), facing(nose));
  fm.command.throttle = 1;

  const drive = new CruiseDrive();
  let closestUnderDrive = Infinity;
  let handoverGapKm = NaN;
  let cruiseStart = -1;
  let cruiseSeconds = NaN;
  let reason: string | null = null;
  const normalBefore = new Vector3();
  let t = 0;

  for (let i = 0; i < Math.ceil(120 / h); i++) {
    const r = fm.position.length();
    const gap = r - w.radius;
    const wasEngaged = drive.engaged;
    if (wasEngaged) closestUnderDrive = Math.min(closestUnderDrive, gap);
    const wasPhase = drive.phase;
    drive.update(h, {
      requested: reason === null,
      clearanceKm: gap,
      grounded: false,
      atmosphericDensity: 0,
      nearestRadiusKm: w.radius,
      arrival: {
        clearanceKm: gap,
        radiusKm: w.radius,
        soiRadiusKm: w.soi,
        closing: fm.forward.dot(fm.position) < 0,
      },
      exitSpeedKmS: circularSpeed(w.mu, r),
    });
    if (drive.phase === 'cruise' && cruiseStart < 0) cruiseStart = t;
    if (wasPhase === 'cruise' && drive.phase === 'dropping') {
      reason = drive.dropReason;
      cruiseSeconds = t - cruiseStart;
    }
    if (wasEngaged && !drive.engaged) {
      handoverGapKm = gap;
      normalBefore.crossVectors(fm.position, fm.velocity).normalize();
      expect(insertIntoOrbit(fm)).toBe(true);
      break;
    }
    fm.setCruise(drive.engaged ? drive.capKmS : null);
    fm.update(h);
    t += h;
  }

  return { fm, frame, handoverGapKm, normalBefore, closestUnderDrive, cruiseSeconds, reason };
}

/** Coast under gravity with the engine off, tracking the lowest altitude. */
function coast(fm: FlightModel, radius: number, seconds: number): number {
  fm.command.throttle = 0;
  fm.command.brake = false;
  let lowest = Infinity;
  const h = 1 / 60;
  for (let i = 0; i < Math.ceil(seconds / h); i++) {
    fm.update(h);
    lowest = Math.min(lowest, fm.position.length() - radius);
  }
  return lowest;
}

describe('orbit insertion on arrival', () => {
  for (const w of [REMIT, MOON, GIANT]) {
    describe(`at ${w.name} (R ${w.radius} km)`, () => {
      it('Given a straight dive at the centre, When the drive drops, Then it drops for arrival at about 3 R', () => {
        const a = arrive(w);
        expect(a.reason).toBe('arrival');
        expect(a.handoverGapKm).toBeGreaterThan(1.5 * w.radius);
        expect(a.handoverGapKm).toBeLessThanOrEqual(arrivalClearanceKm(w.radius, w.soi) * 1.0001);
      });

      it('Given the drop, Then |v| is the circular speed √(μ/r) within 2 %', () => {
        const { fm } = arrive(w);
        const vc = Math.sqrt(w.mu / fm.position.length());
        expect(Math.abs(fm.velocity.length() - vc) / vc).toBeLessThan(0.02);
      });

      it('Given the drop, Then v is perpendicular to the radius vector', () => {
        const { fm } = arrive(w);
        const cos = fm.velocity.clone().normalize().dot(fm.position.clone().normalize());
        expect(Math.abs(cos)).toBeLessThan(0.02);
      });

      it('Given the drop, Then the osculating periapsis is well above the surface and the atmosphere', () => {
        const { fm } = arrive(w);
        const { rp, e } = apsides(fm.position, fm.velocity, w.mu);
        expect(e).toBeLessThan(0.05);
        expect(rp - w.radius).toBeGreaterThan(Math.max(w.atmosphereTop, 0.5 * w.radius));
      });

      it('Given the drop, When 30 minutes of real gravity elapse with the engine off, Then the ship never descends below 90 % of its drop altitude', () => {
        const { fm, handoverGapKm } = arrive(w);
        const lowest = coast(fm, w.radius, 30 * 60);
        expect(lowest).toBeGreaterThan(0.9 * handoverGapKm);
        expect(Number.isFinite(fm.position.length())).toBe(true);
      });
    });
  }

  it('Given an oblique approach, Then the orbit lies in the plane of (r, v) the ship arrived in', () => {
    // 10° off the centre line from 60 000 km: closest straight-line approach
    // ~1.6 R, so the ship crosses 3 R closing and well clear of the hold.
    const a = arrive(REMIT, { startGap: 60_000, offsetDeg: 10 });
    expect(a.reason).toBe('arrival');
    const normalAfter = new Vector3().crossVectors(a.fm.position, a.fm.velocity).normalize();
    expect(normalAfter.dot(a.normalBefore)).toBeGreaterThan(0.999);
  });

  it('Given a ship whose velocity is exactly radial, Then the exit velocity is still finite, circular and tangential', () => {
    const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: REMIT.mu, radius: REMIT.radius });
    const pos = new Vector3(3 * REMIT.radius, 0, 0);
    fm.teleport(pos, new Vector3(-50, 0, 0), facing(new Vector3(-1, 0, 0)));
    const v = circularExitVelocity(fm, new Vector3());
    expect(Number.isFinite(v.length())).toBe(true);
    expect(v.length()).toBeCloseTo(Math.sqrt(REMIT.mu / pos.length()), 6);
    expect(Math.abs(v.clone().normalize().dot(pos.clone().normalize()))).toBeLessThan(1e-9);
  });

  it('Given no parent (μ = 0, deep space), Then insertion declines and the legacy sublight exit stands', () => {
    const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0 });
    fm.teleport(new Vector3(1e6, 0, 0), new Vector3(-60, 0, 0), facing(new Vector3(-1, 0, 0)));
    const before = fm.velocity.clone();
    expect(insertIntoOrbit(fm)).toBe(false);
    expect(fm.velocity.equals(before)).toBe(true);
  });

  it('Given an insertion, Then the flight model has left cruise', () => {
    const { fm } = arrive(REMIT);
    expect(fm.cruising).toBe(false);
  });
});

describe('frames: the drop happens in the target’s SOI, in the target’s frame', () => {
  it('Given an approach that starts in the star’s frame towards a planet moving at 30 km/s, When the drive drops, Then the parent is the planet and v is circular relative to it', () => {
    const star: ParentBody = { position: new Vector3(), velocity: new Vector3(), mu: 1.327e11 };
    const planet: ParentBody = {
      position: new Vector3(1.496e8, 0, 0),
      velocity: new Vector3(0, 0, 30),
      mu: REMIT.mu,
      radius: REMIT.radius,
    };
    const soi = 1.496e8 * Math.pow(REMIT.mu / star.mu, 0.4);

    const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
    fm.setParent(star);
    const start = new Vector3(1.496e8 + 5e6, 0, 0);
    fm.teleport(start, new Vector3(), facing(new Vector3(-1, 0, 0)));
    fm.command.throttle = 1;
    const drive = new CruiseDrive();
    const h = 1 / 60;
    let parentAtDrop: ParentBody | null = null;
    let dropped = false;
    const rel = new Vector3();

    for (let i = 0; i < 60 * 120 && !dropped; i++) {
      planet.position.addScaledVector(planet.velocity, h);
      rel.subVectors(fm.worldPosition, planet.position);
      const gap = rel.length() - REMIT.radius;
      const wasEngaged = drive.engaged;
      drive.update(h, {
        requested: true,
        clearanceKm: gap,
        grounded: false,
        atmosphericDensity: 0,
        nearestRadiusKm: REMIT.radius,
        arrival: { clearanceKm: gap, radiusKm: REMIT.radius, soiRadiusKm: soi, closing: fm.forward.dot(rel) < 0 },
        exitSpeedKmS: circularSpeed(fm.parent?.mu ?? 0, fm.position.length()),
      });
      if (wasEngaged && !drive.engaged) {
        parentAtDrop = fm.parent;
        insertIntoOrbit(fm);
        dropped = true;
        break;
      }
      fm.setCruise(drive.engaged ? drive.capKmS : null);
      fm.update(h);
      // Universe.updateShipParent, reduced to the one transition this needs.
      if (fm.parent === star && entersSoi(rel.subVectors(fm.worldPosition, planet.position).length(), soi)) {
        fm.rebase(planet);
      }
    }

    expect(dropped).toBe(true);
    expect(parentAtDrop).toBe(planet);
    const vc = Math.sqrt(REMIT.mu / fm.position.length());
    // Relative to the planet: a few km/s, not the 30 km/s of the planet's own motion.
    expect(Math.abs(fm.velocity.length() - vc) / vc).toBeLessThan(0.02);
    const { rp } = apsides(fm.position, fm.velocity, REMIT.mu);
    expect(rp).toBeGreaterThan(REMIT.radius * 1.5);
  });
});

describe('the safety invariant, through the arrival', () => {
  for (const h of [1 / 120, 1 / 60, 1 / 30]) {
    it(`Given h = ${h.toFixed(4)} s, Then the drive never carried the ship below half the hold clearance`, () => {
      const a = arrive(REMIT, { h });
      expect(a.closestUnderDrive).toBeGreaterThan(holdClearanceKm(REMIT.radius) * 0.5);
      expect(a.closestUnderDrive).toBeGreaterThan(REMIT.radius);
    });
  }
});

describe('the ETA the chart quotes', () => {
  it('Given a dive from 2 000 000 km, Then the time under cruise matches cruiseEtaSeconds within 3 s', () => {
    const a = arrive(REMIT);
    const eta = cruiseEtaSeconds(REMIT.radius + 2e6, REMIT.radius, REMIT.soi);
    expect(Math.abs(a.cruiseSeconds - eta)).toBeLessThan(3);
  });

  it('Given the defaults, Then spool and drop together stay under 3 s, so the quoted figure is the trip', () => {
    expect(CRUISE_DEFAULTS.spoolTime + CRUISE_DEFAULTS.dropTime).toBeLessThan(3);
  });
});
