/**
 * The landed frame — where the camera stands once the ship is down.
 *
 * Touchdown used to hand the camera to the generic orbit view: 200 m out,
 * pitched 20 degrees down at the hull. Measured on the home world, that put
 * the horizon on the top tenth of the frame and spent the other nine tenths on
 * the ground between 70 and 500 m — the one band of distances the terrain has
 * no detail for — so the payoff of the loop read as "a flat grey field".
 *
 * The composition here is a photographer's, not an inspector's:
 *
 *  - LOW. Eye at roughly hull-top height, 70 m off. A 30 m hull seen from its
 *    own height has a silhouette against the sky; seen from above it is a
 *    decal on the ground.
 *  - ALONG THE GROUND, TOWARDS THE STAR'S SIDE OF THE SKY. The look azimuth is
 *    the star's, turned 32 degrees off it: the bright half of the sky, the
 *    forward-scattering haze and — when the star is low — the star itself are
 *    in frame (ARCHITECTURE section 6: "there is always a light source in or
 *    just outside frame"), and the hull is raked from three-quarter behind,
 *    which gives it a lit edge and a dark body instead of a flat front.
 *  - HULL OPPOSITE THE STAR. The star sits on one side of the look axis and
 *    the hull on the other, so the frame balances.
 *  - MORE SKY WHERE THERE IS SKY. A world with air gets the horizon below the
 *    middle; an airless one, whose sky is black, gives the ground the frame.
 *  - IT DRIFTS. Two slow, incommensurate sines on azimuth and pitch, a few
 *    degrees over a minute — the move is felt, never seen. The rig's springs
 *    smooth everything this returns, so nothing here has to be continuous in
 *    anything but time.
 *
 * Pure and allocation-free: the rig calls it every frame.
 */

import { Vector3 } from 'three';

/** Eye height above the hull's own ground, km. Roughly the top of a 30 m hull. */
export const LANDED_HEIGHT = 0.009;
/** Minimum clearance over the ground at the eye spot, km. */
export const LANDED_CLEARANCE = 0.004;
/** Eye-to-hull distance, km. A little over two hull lengths. */
export const LANDED_DISTANCE = 0.07;
/** How far the look azimuth is turned off the star's, radians (32 degrees). */
export const SUN_AZIMUTH_OFFSET = 0.56;
/** Where the hull sits horizontally off the look axis, radians, on the side away from the star. */
const HULL_BEARING = 0.21;
/** Look pitch for an airless world and for a full sky, radians. */
const PITCH_AIRLESS = -6 * (Math.PI / 180);
const PITCH_SKY = 2.5 * (Math.PI / 180);
/** Fraction of the vertical half-field the hull may sit below the frame centre. */
const HULL_FRAME_FRACTION = 0.72;

export interface LandedFramingInput {
  /** Local vertical, unit. */
  readonly up: Vector3;
  /** Unit direction towards the star. */
  readonly sunDir: Vector3;
  /** Hull nose. Only used when the star is straight overhead and has no azimuth. */
  readonly shipForward: Vector3;
  /** 0 for an airless world, 1 for a full sky. Decides how much frame the sky gets. */
  readonly skyWeight: number;
  /** Seconds since touchdown. Drives the drift. */
  readonly time: number;
  /** The pilot's own yaw and pitch on top of the composition, radians. */
  readonly yaw: number;
  readonly pitch: number;
  /** How far the terrain at the eye spot stands above the hull's ground, km. */
  readonly groundRise: number;
  /** Vertical half field of view, radians. */
  readonly halfFovY: number;
}

export interface LandedFraming {
  /** Eye position relative to the hull, km. */
  readonly offset: Vector3;
  /** Unit view direction. */
  readonly look: Vector3;
}

const e1 = new Vector3();
const e2 = new Vector3();
const lookH = new Vector3();
const bearing = new Vector3();

export function composeLandedFrame(i: LandedFramingInput, out: LandedFraming): LandedFraming {
  const up = i.up;

  // Azimuth reference: the star's, or the hull's when the star is overhead and
  // has none. The second basis vector is up x e1, so the whole frame turns with
  // the world's vertical and never with world Y.
  e1.copy(i.sunDir).addScaledVector(up, -i.sunDir.dot(up));
  if (e1.lengthSq() < 0.05 * 0.05) {
    e1.copy(i.shipForward).addScaledVector(up, -i.shipForward.dot(up));
    if (e1.lengthSq() < 1e-8) {
      // Degenerate twice over (nose straight up under a zenith sun). Any
      // horizontal direction will do; this one is stable for a given up.
      e1.set(up.y, -up.x, 0);
      if (e1.lengthSq() < 1e-8) e1.set(0, up.z, -up.y);
    }
    e1.normalize();
    // Composed as if the star sat on the nose: the offset below then turns
    // the look 32 degrees off the hull heading, as it would off a star.
  } else {
    e1.normalize();
  }
  e2.crossVectors(up, e1);

  const t = i.time;
  const drift = 0.1 * Math.sin(t * 0.031) + 0.05 * Math.sin(t * 0.0137 + 1.3);
  const az = SUN_AZIMUTH_OFFSET + drift + i.yaw;
  lookH.copy(e1).multiplyScalar(Math.cos(az)).addScaledVector(e2, Math.sin(az));

  // The hull, on the side of the look axis away from the star.
  const b = az + HULL_BEARING;
  bearing.copy(e1).multiplyScalar(Math.cos(b)).addScaledVector(e2, Math.sin(b));

  const height = Math.max(LANDED_HEIGHT, i.groundRise + LANDED_CLEARANCE);
  out.offset.copy(bearing).multiplyScalar(-LANDED_DISTANCE).addScaledVector(up, height);

  const sky = Math.min(1, Math.max(0, i.skyWeight));
  let pitch = PITCH_AIRLESS + (PITCH_SKY - PITCH_AIRLESS) * sky;
  pitch += 0.02 * Math.sin(t * 0.023 + 0.7) + i.pitch;
  // Never pitch so high that the hull drops out of the bottom of the frame —
  // which a raised eye over rising ground would otherwise do.
  const hullBelow = Math.atan2(height, LANDED_DISTANCE);
  pitch = Math.min(pitch, -hullBelow + i.halfFovY * HULL_FRAME_FRACTION);
  pitch = Math.max(-0.6, Math.min(0.6, pitch));

  out.look.copy(lookH).multiplyScalar(Math.cos(pitch)).addScaledVector(up, Math.sin(pitch)).normalize();
  return out;
}
