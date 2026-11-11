/**
 * v4 mining — L parks you at a rock (owner decision 3): the approach computer.
 *
 * It flies WITH the flight assist, not around it. Inside a belt field's frame
 * FA's reference is the field's velocity (game/fieldFrame.ts, owned by
 * FlightSense), which every rock of the field shares — so "nose · lever" is
 * already a closing velocity relative to the rock. The computer only
 *
 *  - points the nose at the standoff point (APPROACH_STANDOFF_KM off the
 *    rock's surface, on the line of sight fixed at engage), and
 *  - sets the lever so FA holds the profile speed
 *        v(d) = min(APPROACH_MAX_KMS, √(2·a·d), d / APPROACH_FINAL_S)
 *    with a = APPROACH_BRAKE_MARGIN × the hull's retro braking, × massScaleNow.
 *
 * FA's RCS kills the lateral error, its retro brakes; real thrust, real
 * propellant. The standoff point lies between the ship and the rock, so the
 * straight path never comes nearer the rock than the standoff. The last
 * segment (d / APPROACH_FINAL_S) closes like an overdamped spring, so the
 * leg ends at the point instead of through it. No allocation in step().
 */

import { Vector3 } from 'three';

import { ASSIST_V0, type FlightModel } from './FlightModel';
import { steerToward } from './cruiseSteer';
import { EXHAUST_VELOCITY_KMS } from './propellant';

/** Where the computer parks: km off the rock's surface. */
export const APPROACH_STANDOFF_KM = 0.3;
/** Closing-speed ceiling relative to the rock, km/s. */
export const APPROACH_MAX_KMS = 0.5;
/** Fraction of the delivered retro braking the profile plans on. */
export const APPROACH_BRAKE_MARGIN = 0.5;
/** Time constant of the final linear segment, s (overdamped against FA's lag). */
export const APPROACH_FINAL_S = 6;
/** Parked: within this of the standoff point, km… */
export const APPROACH_PARK_TOL_KM = 0.02;
/** …and slower than this relative to the rock, km/s. */
export const APPROACH_PARK_REL_KMS = 0.0015;
/** Closer than this to the point the nose is left where it is (no 180° flips). */
const STEER_STOP_KM = 0.05;
/** Below this distance to go the phase reads 'final' (1× time). */
export const APPROACH_FINAL_KM = 2;
/** Δv margin of the propellant estimate. */
const DV_FACTOR = 1.5;

const M_TO_KM = 1e-3;

/** FA lever (0..1) that makes FA hold `speedKmS` (inverse of assistTargetSpeed). */
export function assistLeverFor(speedKmS: number, vmax: number): number {
  if (!(speedKmS > 0) || !(vmax > 0)) return 0;
  if (speedKmS >= vmax) return 1;
  return Math.log(1 + speedKmS / ASSIST_V0) / Math.log(1 + vmax / ASSIST_V0);
}

/** The profile speed `d` km before the standoff point, km/s. */
export function approachSpeed(dKm: number, brakeKmS2: number): number {
  if (!(dKm > 0)) return 0;
  const a = Math.max(0, APPROACH_BRAKE_MARGIN * brakeKmS2);
  return Math.min(APPROACH_MAX_KMS, Math.sqrt(2 * a * dKm), dKm / APPROACH_FINAL_S);
}

/** The hull's delivered retro braking now, km/s² (massScaleNow: the tank's mass). */
export function deliveredBrake(flight: FlightModel): number {
  return (flight.config.brakeThrust / flight.config.mass) * M_TO_KM * flight.massScaleNow;
}

/** Propellant (kg) an approach of `distanceKm` from rest relative to the rock should take, with margin. */
export function approachEstimateKg(flight: FlightModel, distanceKm: number, relSpeedKmS: number): number {
  const top = Math.min(APPROACH_MAX_KMS, Math.sqrt(Math.max(0, deliveredBrake(flight) * APPROACH_BRAKE_MARGIN * distanceKm)));
  const dv = DV_FACTOR * (2 * top + Math.max(0, relSpeedKmS));
  const m0 = flight.config.mass + (flight.propellant?.massKg ?? 0) + Math.max(0, flight.extraMassKg);
  return m0 * (1 - Math.exp(-dv / EXHAUST_VELOCITY_KMS));
}

export type ApproachResult = 'flying' | 'parked';

const sPoint = new Vector3();
const sRel = new Vector3();

export class Approach {
  private _active = false;
  private savedFa = false;
  /** Standoff point relative to the rock's centre, world axes (fixed at engage). */
  private readonly offset = new Vector3();
  private _toGoKm = Number.POSITIVE_INFINITY;

  get active(): boolean {
    return this._active;
  }
  /** Distance to the standoff point at the last step, km. */
  get toGoKm(): number {
    return this._toGoKm;
  }

  /**
   * Take the controls: FA on (the computer flies through it), the standoff
   * point fixed on today's line of sight. `rockWorld`, `radiusKm`: the rock.
   */
  engage(flight: FlightModel, rockWorld: Vector3, radiusKm: number): void {
    if (!this._active) this.savedFa = flight.flightAssist;
    this._active = true;
    flight.flightAssist = true;
    this.offset.subVectors(flight.worldPosition, rockWorld);
    const d = this.offset.length();
    if (d < 1e-9) this.offset.copy(flight.forward).negate();
    this.offset.normalize().multiplyScalar(radiusKm + APPROACH_STANDOFF_KM);
    this._toGoKm = Math.max(0, d - radiusKm - APPROACH_STANDOFF_KM);
  }

  /** Hand back: the pilot's FA, every channel zeroed (the lever at the detent). */
  disengage(flight: FlightModel): void {
    if (!this._active) return;
    this._active = false;
    const c = flight.command;
    c.pitch = 0;
    c.yaw = 0;
    c.roll = 0;
    c.throttle = 0;
    c.strafeX = 0;
    c.strafeY = 0;
    c.strafeZ = 0;
    c.boost = false;
    c.brake = false;
    flight.flightAssist = this.savedFa;
  }

  /**
   * One slice of guidance. `rockWorld`: the rock's centre now; `relVel`: the
   * ship's velocity relative to the rock (km/s). Writes the command.
   */
  step(flight: FlightModel, rockWorld: Vector3, relVel: Vector3): ApproachResult {
    if (!this._active) return 'flying';
    sPoint.addVectors(rockWorld, this.offset);
    sRel.subVectors(sPoint, flight.worldPosition);
    const d = sRel.length();
    this._toGoKm = d;
    if (d <= APPROACH_PARK_TOL_KM && relVel.length() < APPROACH_PARK_REL_KMS) return 'parked';

    const c = flight.command;
    c.pitch = 0;
    c.yaw = 0;
    c.roll = 0;
    c.strafeX = 0;
    c.strafeY = 0;
    c.strafeZ = 0;
    c.boost = false;
    c.brake = false;
    if (d > STEER_STOP_KM) steerToward(flight, sPoint);
    // Only the part of the distance along the nose is flown by the lever; FA's
    // RCS takes the rest. A nose still swinging round asks for nothing.
    const along = flight.forward.dot(sRel);
    const v = along > 0 ? approachSpeed(Math.min(d, along), deliveredBrake(flight)) : 0;
    c.throttle = assistLeverFor(v, flight.config.topSpeed);
    return 'flying';
  }
}
