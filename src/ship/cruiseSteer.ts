/**
 * Supercruise steering — the ship's computer flying the nose to a locked target.
 *
 * A PD loop on the nose error, acting only through `FlightModel.command`: the
 * same channel as the stick, so the computer cannot do anything a pilot could
 * not (PLAN.md: helpers may fly the physics, never lie about it). Any pilot
 * rotation input wins on the frame it appears — the caller runs after Pilot has
 * copied the stick into the command, and this function leaves a non-zero stick
 * untouched.
 *
 * Tuning ([v3-T2], re-derived for the rate-command plant). With attitude hold
 * on the stick is a rate demand, so the loop is u = K·e/ωmax (`steerRates`, saturated jointly):
 * a constant-rate slew at the axis maximum far out, critically damped against
 * the rate loop's τ_down near in. With attitude hold off the hull is
 * Newtonian, θ̈ = α·u, and u = Kp·e − Kd·θ̇ with Kp = ωn²/α, Kd = 2ωn/α is
 * critically damped at ωn. α comes from the ship's own config.
 *
 * Limb aim. Aimed at the centre, a ship arrives diving radially and the orbit
 * insertion has to turn its velocity 90°. Given `limbRadiusKm`, the nose is
 * aimed along the tangent to a sphere of that radius instead — offset towards
 * the side the nose already leans (falling back to the ecliptic prograde when
 * it leans nowhere) — so the approach meets the arrival sphere obliquely and
 * the insertion is a small correction rather than a right angle.
 */

import { Quaternion, Vector3 } from 'three';
import type { FlightModel } from './FlightModel';
import { eclipticTangent } from './cruiseOrbit';
import { steerRates, type AxisCommand } from './rateCommand';

/** Natural frequency of the closed loop, rad/s. ~2 s to settle a large turn. */
const OMEGA_N = 2;
/** Stick deflection below which the pilot is considered hands-off. */
export const PILOT_DEADZONE = 0.02;
/** Inside the limb sphere, aim this close to tangential (but still closing). */
const MAX_LIMB_ANGLE = (85 * Math.PI) / 180;
/** Weight of the ecliptic side in the limb offset; see `cruiseOrbit.ts`. */
const ECLIPTIC_BLEND = 0.05;

const M_TO_KM = 1e-3;

const sLos = new Vector3();
const sPerp = new Vector3();
const sSide = new Vector3();
const sAim = new Vector3();
const sBody = new Vector3();
const sInv = new Quaternion();
const sRates: AxisCommand = { pitch: 0, yaw: 0, roll: 0 };

/** Angle between the nose and the direction to `targetWorld`, radians. */
export function noseErrorRad(flight: FlightModel, targetWorld: Vector3): number {
  sLos.subVectors(targetWorld, flight.worldPosition);
  const len = sLos.length();
  if (len < 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1, flight.forward.dot(sLos) / len)));
}

/**
 * World direction the nose should point, into `out`: the target itself, or —
 * with a limb radius — the tangent to that sphere about it.
 */
export function aimDirection(
  flight: FlightModel,
  targetWorld: Vector3,
  limbRadiusKm: number,
  out: Vector3,
): Vector3 {
  out.subVectors(targetWorld, flight.worldPosition);
  const d = out.length();
  if (d < 1e-9) return out.copy(flight.forward);
  out.multiplyScalar(1 / d);
  if (!(limbRadiusKm > 0)) return out;

  const theta = Math.min(Math.asin(Math.min(1, limbRadiusKm / d)), MAX_LIMB_ANGLE);
  // Side: where the nose already leans off the line of sight, so the aim is
  // self-consistent rather than chosen afresh each frame.
  sPerp.copy(flight.forward).addScaledVector(out, -flight.forward.dot(out));
  eclipticTangent(sSide.copy(out).negate(), sSide);
  sPerp.addScaledVector(sSide, ECLIPTIC_BLEND);
  sPerp.addScaledVector(out, -sPerp.dot(out));
  if (sPerp.lengthSq() < 1e-18) sPerp.copy(sSide);
  sPerp.normalize();
  return out.multiplyScalar(Math.cos(theta)).addScaledVector(sPerp, Math.sin(theta));
}

/**
 * Write pitch/yaw into `flight.command` to bring the nose onto the target.
 *
 * Returns 'pilot', changing nothing, when the pilot is touching any rotation
 * axis. Never writes roll.
 */
export function steerToward(
  flight: FlightModel,
  targetWorld: Vector3,
  limbRadiusKm = 0,
): 'steer' | 'pilot' {
  const cmd = flight.command;
  if (
    Math.abs(cmd.pitch) > PILOT_DEADZONE ||
    Math.abs(cmd.yaw) > PILOT_DEADZONE ||
    Math.abs(cmd.roll) > PILOT_DEADZONE
  ) {
    return 'pilot';
  }

  aimDirection(flight, targetWorld, limbRadiusKm, sAim);
  // Into body axes, where the nose is (0, 0, -1).
  sInv.copy(flight.orientation).invert();
  sBody.copy(sAim).applyQuaternion(sInv);

  // Axis-angle error: nose × d = (d.y, -d.x, 0), scaled to the full angle.
  const cosA = -sBody.z;
  const sx = sBody.y;
  const sy = -sBody.x;
  const sinA = Math.hypot(sx, sy);
  const angle = Math.atan2(sinA, cosA);
  let ex: number;
  let ey: number;
  if (sinA > 1e-9) {
    ex = (sx / sinA) * angle;
    ey = (sy / sinA) * angle;
  } else if (cosA < 0) {
    ex = angle; // dead astern: any axis will do; pitch up
    ey = 0;
  } else {
    ex = 0;
    ey = 0;
  }

  // [v3-T2] BEGIN steering gains
  const c = flight.config;
  if (flight.attitudeHold) {
    // Rate-command plant: ask for a rate proportional to the error (see
    // `STEER_RATE_GAIN`). Body Y carries the hull's yaw sign; divide it out.
    steerRates(ex, ey, 0, sRates);
    cmd.pitch = sRates.pitch;
    cmd.yaw = sRates.yaw / c.yawAxisSign;
    return 'steer';
  }
  // Newtonian (attitude hold off): u is torque, θ̈ = α·u, so the PD closes to
  // θ̈ + α·Kd·θ̇ + α·Kp·θ = 0 — critically damped at Kp = ωn²/α, Kd = 2ωn/α.
  const alphaP = (c.rcsTorque.pitch / c.inertia.pitch) * M_TO_KM;
  const alphaY = (c.rcsTorque.yaw / c.inertia.yaw) * M_TO_KM;
  const w = flight.angularVelocity;
  const kpP = (OMEGA_N * OMEGA_N) / alphaP;
  const kdP = (2 * OMEGA_N) / alphaP;
  const kpY = (OMEGA_N * OMEGA_N) / alphaY;
  const kdY = (2 * OMEGA_N) / alphaY;

  // Torque about body Y is yaw·alpha·yawAxisSign, so divide the sign back out.
  cmd.pitch = clampUnit(kpP * ex - kdP * w.x);
  cmd.yaw = clampUnit((kpY * ey - kdY * w.y) / c.yawAxisSign);
  // [v3-T2] END steering gains
  return 'steer';
}

function clampUnit(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v;
}
