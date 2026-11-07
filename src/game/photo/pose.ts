/**
 * Photo mode's camera pose, in the frame of the camera it was entered on.
 *
 * The fly-cam (flycam.ts) is yaw/pitch about a +Y "up". v2-p2 used WORLD Y,
 * but flight levels its camera against the LOCAL vertical (the planet below),
 * so the flight camera's roll against world Y is anything — and on P the
 * frame snapped by that angle (measured: a horizon at the bottom of the frame
 * became a planet on the left edge). ARCHITECTURE §6: nothing snaps.
 *
 * So the fly-cam runs in the entry camera's own frame instead: it starts at
 * the origin with yaw = pitch = 0, and this maps it out to the world. At
 * entry the pose is the entry pose exactly; a horizontal drag turns about the
 * entry view's up, which is the screen's vertical — the axis a player expects.
 */

import { Euler, Quaternion, Vector3 } from 'three';
import type { FlyCamState } from './flycam';

export class PhotoFrame {
  private readonly origin = new Vector3();
  private readonly basis = new Quaternion();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly local = new Quaternion();

  /** Anchor the frame on the camera photo mode was entered from. */
  anchor(position: Vector3, quaternion: Quaternion): void {
    this.origin.copy(position);
    this.basis.copy(quaternion);
  }

  /** World pose of fly-cam state `c` (whose position is frame-local). Allocates nothing. */
  pose(c: FlyCamState, outPosition: Vector3, outQuaternion: Quaternion): void {
    outPosition.set(c.position[0], c.position[1], c.position[2]).applyQuaternion(this.basis).add(this.origin);
    this.euler.set(c.pitch, c.yaw, 0, 'YXZ');
    this.local.setFromEuler(this.euler);
    outQuaternion.copy(this.basis).multiply(this.local);
  }
}
