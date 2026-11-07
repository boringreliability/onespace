/**
 * Freeze flight on the way out, hand it back exactly on the way in.
 *
 * Leaving flight for the Yard (or a review shot) stops every flight module —
 * the gating in `core/tick.ts` does that — but the CAMERA is shared, and the
 * Yard and the shots move it. What has to come back, and why each piece:
 *
 *  - position / quaternion: the rig damps from the camera it finds, so a
 *    camera left at the Yard's orbit would swing back across the system;
 *  - up: several shots (rings, clouds) re-aim `camera.up`, and `lookAt`
 *    uses it, so a borrowed up-vector rolls the cockpit;
 *  - fov + projection matrix: the Yard runs a 20-38° lens, flight runs 62°;
 *  - exposure bias: the Yard fades the iris down to hide a hull swap, and
 *    PostFX has no getter for it, so the caller states the flight value;
 *  - fixedDt: `__osSettle` leaves the engine in fixed-step mode, which in
 *    play is slow motion (SHOWROOM.md §1.5). Real time is ALWAYS resumed;
 *  - pointer lock: recorded only. The browser allows a re-lock only from a
 *    user gesture, and Input already re-locks on the next canvas click.
 *
 * A snapshot is consumed by `restore`; a second restore is a no-op, so a
 * stray double exit cannot put the camera back somewhere stale.
 */

import { Quaternion, Vector3, type PerspectiveCamera } from 'three';
import type { BaseMode, Mode } from '@/core/Modes';

/**
 * Modes whose camera IS the flight camera: the title runs flight behind the
 * menu, and boot has stepped it once (Engine.prewarm). Entering the Yard from
 * any of them must snapshot it (review-p2: only `flight` did, so a Yard
 * opened from the title or a link handed back a camera parked at the hull).
 */
export function snapshotsFlightFrom(from: Mode): boolean {
  return from === 'flight' || from === 'title' || from === 'boot';
}

/** Modes that get the flight camera back when the Yard hands over to them. */
export function restoresFlightTo(to: BaseMode): boolean {
  return to === 'flight' || to === 'title';
}

/** The slice of `Engine` this needs. */
export interface FlightClock {
  fixedDt: number | null;
  resumeRealtime(): void;
}

export interface FlightRestoreHooks {
  setExposureBias?(v: number): void;
}

export class FlightSnapshot {
  private readonly position = new Vector3();
  private readonly quaternion = new Quaternion();
  private readonly up = new Vector3();
  private fov = 62;
  private exposureBias = 1;
  private pointerLocked = false;
  private has = false;

  get captured(): boolean {
    return this.has;
  }

  get wasPointerLocked(): boolean {
    return this.pointerLocked;
  }

  capture(camera: PerspectiveCamera, state: { exposureBias: number; pointerLocked: boolean }): void {
    this.position.copy(camera.position);
    this.quaternion.copy(camera.quaternion);
    this.up.copy(camera.up);
    this.fov = camera.fov;
    this.exposureBias = state.exposureBias;
    this.pointerLocked = state.pointerLocked;
    this.has = true;
  }

  /**
   * Put flight back. Returns whether there was anything to restore; real time
   * is resumed either way, because a fixed step left behind by a review settle
   * is wrong in every mode a player can reach.
   */
  restore(camera: PerspectiveCamera, clock: FlightClock, hooks: FlightRestoreHooks = {}): boolean {
    clock.resumeRealtime();
    if (!this.has) return false;
    camera.position.copy(this.position);
    camera.quaternion.copy(this.quaternion);
    camera.up.copy(this.up);
    camera.fov = this.fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    hooks.setExposureBias?.(this.exposureBias);
    this.has = false;
    return true;
  }
}
