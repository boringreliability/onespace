/**
 * Keplerian orbital mechanics.
 *
 * Given an OrbitSpec and a time, where is the body? Two-body Keplerian motion
 * is exact, cheap and — crucially — *stateless*: position is a pure function of
 * time, so nothing drifts, nothing needs saving, and rewinding the clock puts
 * every world back exactly where it was. An n-body integrator would be more
 * physical and would ruin all three of those properties.
 *
 * Frame convention: the invariable plane is XZ and Y is up, matching render
 * space. Textbook orbital elements assume Z-up, so the final assignment swaps
 * the last two axes — that swap is the only thing here that is not standard.
 */

import type { OrbitSpec } from './types';

export interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Solve Kepler's equation M = E - e·sin(E) for the eccentric anomaly E.
 *
 * Newton–Raphson converges quadratically for the eccentricities we generate
 * (e < 0.9), so five iterations is well past machine precision. The starting
 * guess matters more than the iteration count: for near-circular orbits E ≈ M,
 * but for eccentric ones that guess can converge to the wrong branch, hence the
 * e-weighted correction term.
 */
export function solveKepler(meanAnomaly: number, eccentricity: number): number {
  const M = normaliseAngle(meanAnomaly);
  const e = eccentricity;

  // Starting guess. The sin(M) term leans E towards periapsis, where the body
  // actually spends least time — that is what fixes convergence at high e.
  let E = e < 0.8 ? M + e * Math.sin(M) : Math.PI;

  for (let i = 0; i < 6; i++) {
    const f = E - e * Math.sin(E) - M;
    const fPrime = 1 - e * Math.cos(E);
    const delta = f / fPrime;
    E -= delta;
    if (Math.abs(delta) < 1e-12) break;
  }
  return E;
}

/** Wrap to [0, 2π). */
function normaliseAngle(a: number): number {
  const twoPi = Math.PI * 2;
  const r = a % twoPi;
  return r < 0 ? r + twoPi : r;
}

/**
 * Position of a body on its orbit at `timeSeconds`, in kilometres, relative to
 * whatever it orbits. Allocation-free when `out` is supplied — this is called
 * for every body every frame.
 */
export function orbitalPosition(
  orbit: OrbitSpec,
  timeSeconds: number,
  out: MutableVec3 = { x: 0, y: 0, z: 0 },
): MutableVec3 {
  const {
    semiMajorAxis: a,
    eccentricity: e,
    inclination: inc,
    longitudeOfAscendingNode: raan,
    argumentOfPeriapsis: argp,
    meanAnomalyAtEpoch: M0,
    period,
  } = orbit;

  // A zero period would divide by zero; treat it as a body pinned at epoch.
  const M = period > 0 ? M0 + (Math.PI * 2 * timeSeconds) / period : M0;
  const E = solveKepler(M, e);

  // True anomaly from eccentric anomaly. The half-angle form is used rather
  // than acos(...) because it is well-conditioned across the whole orbit and
  // gets the quadrant right without a sign test.
  const halfE = E * 0.5;
  const nu =
    2 *
    Math.atan2(Math.sqrt(1 + e) * Math.sin(halfE), Math.sqrt(1 - e) * Math.cos(halfE));

  const r = a * (1 - e * Math.cos(E));

  const u = argp + nu; // argument of latitude
  const cosU = Math.cos(u);
  const sinU = Math.sin(u);
  const cosRaan = Math.cos(raan);
  const sinRaan = Math.sin(raan);
  const cosInc = Math.cos(inc);
  const sinInc = Math.sin(inc);

  const xEq = r * (cosRaan * cosU - sinRaan * sinU * cosInc);
  const yEq = r * (sinRaan * cosU + cosRaan * sinU * cosInc);
  const zEq = r * (sinU * sinInc);

  // Textbook Z-up -> render-space Y-up.
  out.x = xEq;
  out.y = zEq;
  out.z = yEq;
  return out;
}

/**
 * Orbital velocity at `timeSeconds`, km/s. Derived from the vis-viva equation
 * and the flight-path angle rather than by differencing positions, which would
 * be noisy at small timesteps.
 *
 * `mu` is the gravitational parameter of the primary in km³/s².
 */
export function orbitalVelocity(
  orbit: OrbitSpec,
  timeSeconds: number,
  mu: number,
  out: MutableVec3 = { x: 0, y: 0, z: 0 },
): MutableVec3 {
  const { semiMajorAxis: a, eccentricity: e, inclination: inc } = orbit;
  const { longitudeOfAscendingNode: raan, argumentOfPeriapsis: argp } = orbit;
  const M = orbit.period > 0 ? orbit.meanAnomalyAtEpoch + (Math.PI * 2 * timeSeconds) / orbit.period : orbit.meanAnomalyAtEpoch;
  const E = solveKepler(M, e);

  const halfE = E * 0.5;
  const nu =
    2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(halfE), Math.sqrt(1 - e) * Math.cos(halfE));
  const r = a * (1 - e * Math.cos(E));

  // Perifocal velocity components.
  const p = a * (1 - e * e);
  const h = Math.sqrt(mu * p);
  const vr = (mu / h) * e * Math.sin(nu); // radial
  const vt = h / r; // transverse

  const u = argp + nu;
  const cosU = Math.cos(u);
  const sinU = Math.sin(u);
  const cosRaan = Math.cos(raan);
  const sinRaan = Math.sin(raan);
  const cosInc = Math.cos(inc);
  const sinInc = Math.sin(inc);

  // Radial and transverse unit vectors in the equatorial frame.
  const rx = cosRaan * cosU - sinRaan * sinU * cosInc;
  const ry = sinRaan * cosU + cosRaan * sinU * cosInc;
  const rz = sinU * sinInc;

  const tx = -cosRaan * sinU - sinRaan * cosU * cosInc;
  const ty = -sinRaan * sinU + cosRaan * cosU * cosInc;
  const tz = cosU * sinInc;

  const vxEq = vr * rx + vt * tx;
  const vyEq = vr * ry + vt * ty;
  const vzEq = vr * rz + vt * tz;

  out.x = vxEq;
  out.y = vzEq;
  out.z = vyEq;
  return out;
}
