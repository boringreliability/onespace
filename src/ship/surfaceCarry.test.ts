/**
 * A landed ship turns with its world (phase-4 finding).
 *
 * The planet mesh rotates by its spin, but the parent frame does not, so a
 * grounded ship held still in that frame had the drawn ground slide beneath
 * it at ~0.5 km/s — and at 100× time compression, visibly. Universe hands the
 * per-frame spin delta to `carryWithSurface`, which moves a grounded ship
 * with the surface and leaves an airborne one alone.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { DEFAULT_SHIP_CONFIG, FlightModel } from './FlightModel';

// Earth-like, as in flightAssist.test.ts: a ship 2 m up settles onto its gear.
const R = 6371;
const MU = 398600;

function landed(): FlightModel {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: MU, radius: R });
  fm.setGroundSampler((rel) => rel.length() - R);
  fm.teleport(new Vector3(0, R + 0.002, 0), new Vector3(), new Quaternion());
  for (let i = 0; i < 600 && !fm.grounded; i++) fm.update(1 / 60);
  return fm;
}

const quarterTurnY = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);

describe('carryWithSurface', () => {
  it('Given a grounded ship, When the world turns a quarter, Then its position and attitude turn with it', () => {
    const fm = landed();
    expect(fm.grounded).toBe(true);
    const p0 = fm.position.clone();
    const q0 = fm.orientation.clone();
    fm.carryWithSurface(quarterTurnY);
    expect(fm.position.distanceTo(p0.clone().applyQuaternion(quarterTurnY))).toBeLessThan(1e-9);
    expect(fm.orientation.angleTo(q0.clone().premultiply(quarterTurnY))).toBeLessThan(1e-9);
    expect(fm.grounded).toBe(true);
  });

  it('Given an airborne ship, When the world turns, Then nothing moves', () => {
    const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: MU });
    fm.teleport(new Vector3(0, 5 * R, 0), new Vector3(1, 0, 0), new Quaternion());
    const p0 = fm.position.clone();
    fm.carryWithSurface(quarterTurnY);
    expect(fm.position.equals(p0)).toBe(true);
  });

  it('Given a grounded ship carried, Then its altitude above the surface is unchanged', () => {
    const fm = landed();
    const r0 = fm.position.length();
    fm.carryWithSurface(quarterTurnY);
    expect(fm.position.length()).toBeCloseTo(r0, 9);
  });
});

describe('review-p4: everything that is drawn or read turns with the ship', () => {
  /** Landed with a yawed, pitched hull, so body-frame and world-frame turns differ. */
  function landedTilted(): FlightModel {
    const fm = landed();
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0.3, 0).normalize(), 0.7);
    fm.teleport(fm.position.clone(), new Vector3(), q);
    for (let i = 0; i < 120 && !fm.grounded; i++) fm.update(1 / 60);
    return fm;
  }

  it('Given a tilted grounded hull, When the world turns, Then its attitude turns in the PARENT frame (delta · q), not its own body frame', () => {
    const fm = landedTilted();
    expect(fm.grounded).toBe(true);
    const q0 = fm.orientation.clone();
    fm.carryWithSurface(quarterTurnY);
    expect(fm.orientation.angleTo(q0.clone().premultiply(quarterTurnY))).toBeLessThan(1e-9);
  });

  it('Given a grounded hull, When the world turns, Then the RENDER position and attitude turn too — no one-frame snap of the drawn hull', () => {
    const fm = landedTilted();
    const rp0 = fm.renderPosition.clone();
    const rq0 = fm.renderOrientation.clone();
    fm.carryWithSurface(quarterTurnY);
    expect(fm.renderPosition.distanceTo(rp0.applyQuaternion(quarterTurnY))).toBeLessThan(1e-9);
    expect(fm.renderOrientation.angleTo(rq0.premultiply(quarterTurnY))).toBeLessThan(1e-9);
  });

  it('Given a grounded hull, When the world turns, Then the body axes and world positions read by the camera, HUD and autopilot are already the turned ones', () => {
    const fm = landedTilted();
    const f0 = fm.forward.clone();
    fm.carryWithSurface(quarterTurnY);
    expect(fm.forward.distanceTo(f0.applyQuaternion(quarterTurnY))).toBeLessThan(1e-9);
    expect(fm.worldPosition.distanceTo(fm.position)).toBeLessThan(1e-9); // parent at the origin
    expect(fm.renderWorldPosition.distanceTo(fm.renderPosition)).toBeLessThan(1e-9);
  });
});
