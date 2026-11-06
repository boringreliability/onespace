/**
 * The safety net, pure half: where a recovered ship goes, which way it faces,
 * when the star counts as hit, and the fade that hides the cut.
 *
 * No DOM and no Universe here — `Universe.recoverToOrbit()` and
 * `game/RecoveryCut.ts` are the impure callers. The principle (PLAN fase 1):
 * helpers may fly the physics for the player but never lie about it; respawn
 * is the one sanctioned exception, and it is a CUT, so it happens behind black.
 */

import { Matrix4, Quaternion, Vector3 } from 'three';

import { SOLAR_RADIUS } from '@/gen/types';

/**
 * Height of the recovery orbit above the surface, in body radii.
 *
 * 0.6 R puts the ship at 1.6 R from the centre — the same standoff the game
 * opens at, so a recovery returns to a view the player has already seen.
 */
export const RESPAWN_ALTITUDE_RADII = 0.6;

export interface OrbitState {
  /** Parent-relative position, km. */
  readonly position: Vector3;
  /** Parent-relative velocity, km/s. */
  readonly velocity: Vector3;
  /** Ship attitude: nose (-Z) prograde, roof (+Y) radially out. */
  readonly orientation: Quaternion;
}

const ZERO = new Vector3();
const WORLD_UP = new Vector3(0, 1, 0);
const WORLD_X = new Vector3(1, 0, 0);

/**
 * A circular orbit `altitudeRadii` above the point the ship came down on.
 * Velocity is √(μ/r), perpendicular to the radius, and in the direction
 * closest to the ecliptic — the same convention as
 * `FlightModel.orbitalVelocityAt`, so recovery and spawn agree.
 *
 * Allocates: called once per recovery, never per frame.
 */
export function circularOrbitState(
  radialDir: Vector3,
  bodyRadiusKm: number,
  mu: number,
  altitudeRadii = RESPAWN_ALTITUDE_RADII,
): OrbitState {
  const dir = radialDir.clone();
  // A zero radial (ship exactly at the centre, or no information) gets a fixed
  // direction rather than a NaN that would quietly poison the integrator.
  const lsq = dir.lengthSq();
  if (!(lsq > 1e-18) || !Number.isFinite(lsq)) dir.set(1, 0, 0);
  dir.normalize();

  const r = bodyRadiusKm * (1 + altitudeRadii);
  const position = dir.clone().multiplyScalar(r);

  const tangent = new Vector3().crossVectors(WORLD_UP, dir);
  if (tangent.lengthSq() < 1e-12) tangent.crossVectors(WORLD_X, dir);
  tangent.normalize();

  const speed = mu > 0 && r > 0 ? Math.sqrt(mu / r) : 0;
  const velocity = tangent.clone().multiplyScalar(speed);

  // Attitude from the tangent, not the velocity: with μ = 0 the speed is zero
  // but there is still a sensible way to face.
  const orientation = progradeAttitude(tangent, dir);
  return { position, velocity, orientation };
}

/**
 * Nose along `velocity`, roof as close to `upHint` as the nose allows.
 *
 * The opening spawn used to point the nose at the planet's centre, so the
 * first press of W was a dive (GAMEPLAY F8). Prograde with the roof radially
 * out is a level horizon and a throttle that does what it says.
 */
export function progradeAttitude(
  velocity: Vector3,
  upHint: Vector3,
  out = new Quaternion(),
): Quaternion {
  const fwd = velocity.clone();
  if (!(fwd.lengthSq() > 1e-18)) return out.identity();
  fwd.normalize();

  // Orthogonalise the hint against the nose; fall back through world axes if
  // they are parallel, otherwise the basis degenerates and the roll snaps.
  const up = upHint.clone().addScaledVector(fwd, -fwd.dot(upHint));
  if (up.lengthSq() < 1e-12) up.copy(WORLD_UP).addScaledVector(fwd, -fwd.y);
  if (up.lengthSq() < 1e-12) up.copy(WORLD_X).addScaledVector(fwd, -fwd.x);
  up.normalize();

  // Matrix4.lookAt builds a basis whose -Z points from eye to target — and -Z
  // is the ship's nose (see Universe.placeShipOnArrival).
  const m = new Matrix4().lookAt(ZERO, fwd, up);
  return out.setFromRotationMatrix(m).normalize();
}

/**
 * Nose pitch below prograde for the opening frame. At 1.6 R the limb is
 * acos(1/1.6) ≈ 51° below the orbital horizon; 30° down puts it ~21° below
 * the nose — inside the chase camera's ±31° view, low in the frame — while
 * the nose stays cos 30° ≈ 87 % prograde, so W is not a dive.
 */
export const OPENING_PITCH_DOWN_RAD = (30 * Math.PI) / 180;

/** Prograde, pitched down towards the world by OPENING_PITCH_DOWN_RAD, roof out. */
export function openingAttitude(
  velocity: Vector3,
  radialOut: Vector3,
  out = new Quaternion(),
): Quaternion {
  const v = velocity.clone();
  if (!(v.lengthSq() > 1e-18)) return progradeAttitude(velocity, radialOut, out);
  v.normalize();
  // The "down" direction in the orbit plane: −radial with its prograde part removed.
  const down = radialOut.clone().normalize().multiplyScalar(-1);
  down.addScaledVector(v, -down.dot(v));
  if (down.lengthSq() < 1e-12) return progradeAttitude(velocity, radialOut, out);
  down.normalize();
  const nose = v
    .multiplyScalar(Math.cos(OPENING_PITCH_DOWN_RAD))
    .addScaledVector(down, Math.sin(OPENING_PITCH_DOWN_RAD));
  return progradeAttitude(nose, radialOut, out);
}

/**
 * Has the ship reached the photosphere? The star used to have no collision at
 * all, so you could fly straight through it (GAMEPLAY F7).
 *
 * A star with no usable radius is never hit — headless review scenes have one.
 */
export function insideStar(distanceToCentreKm: number, starRadiusKm: number): boolean {
  if (!(starRadiusKm > 0)) return false;
  return distanceToCentreKm <= starRadiusKm;
}

/**
 * A star's radius in kilometres. `StarSpec.radius` is in SOLAR radii; every
 * use of it in a km context has to go through this.
 */
export function starRadiusKm(star: { readonly radius: number } | undefined | null): number {
  const r = star?.radius ?? 0;
  return Number.isFinite(r) && r > 0 ? r * SOLAR_RADIUS : 0;
}

// ---------------------------------------------------------------------------
// The cut
// ---------------------------------------------------------------------------

/** Seconds to fade to black. */
const FADE_OUT = 0.6;
/** Seconds held at black around the move. */
const HOLD = 0.35;
/** Seconds to fade back in. */
const FADE_IN = 0.9;

function smooth(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/**
 * Fade out, move the ship once at full black, fade in.
 *
 * `step()` returns true on exactly one frame: the one where the caller must
 * teleport. A second `start()` while running is ignored — a crash event and a
 * star contact can both arrive for the same accident.
 */
export class RecoveryTimeline {
  private t = 0;
  private running = false;
  private fired = false;

  get active(): boolean {
    return this.running;
  }

  /** 0 = clear, 1 = black. */
  get blackout(): number {
    if (!this.running) return 0;
    if (this.t < FADE_OUT) return smooth(this.t / FADE_OUT);
    if (this.t < FADE_OUT + HOLD) return 1;
    return 1 - smooth((this.t - FADE_OUT - HOLD) / FADE_IN);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.fired = false;
    this.t = 0;
  }

  /** Advance; true exactly once, at full black. */
  step(dt: number): boolean {
    if (!this.running) return false;
    this.t += Math.max(0, dt);
    let fire = false;
    if (!this.fired && this.t >= FADE_OUT) {
      // Pin to the black plateau for the frame that moves the ship, so the
      // move is never visible even on a long frame.
      this.t = Math.min(this.t, FADE_OUT + HOLD * 0.5);
      this.fired = true;
      fire = true;
    }
    if (this.t >= FADE_OUT + HOLD + FADE_IN) {
      this.running = false;
      this.t = 0;
    }
    return fire;
  }
}
