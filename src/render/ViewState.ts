/**
 * The per-frame view packet handed to every renderer.
 *
 * Renderers are deliberately blind: they cannot see the camera, the scene
 * graph, the ship or each other. Everything they are allowed to know arrives
 * in this struct, expressed in *their own local space*. That is what makes it
 * possible to review a planet, a star and a nebula independently.
 */

import { Color, Vector3 } from 'three';

export interface ViewState {
  /** Camera position in this object's LOCAL space, kilometres. */
  readonly cameraLocal: Vector3;
  /** Unit vector from this object's centre towards the dominant star. */
  readonly sunDirection: Vector3;
  /** Linear RGB of the dominant star, pre-multiplied by its intensity. */
  readonly sunColor: Color;
  /** Distance from camera to this object's centre, kilometres. */
  readonly distance: number;
  /** Seconds since boot. Use this for animation — never `Date.now()`. */
  readonly time: number;
  /** Vertical field of view in radians — for screen-space error LOD metrics. */
  readonly fovY: number;
  /** Framebuffer height in pixels — the other half of the LOD metric. */
  readonly viewportHeight: number;
}

/**
 * A reusable, mutable ViewState. The integrator keeps one per rendered object
 * and refills it each frame; renderers must treat it as read-only and must not
 * retain references to its vectors beyond the current frame.
 */
export class MutableViewState implements ViewState {
  readonly cameraLocal = new Vector3();
  readonly sunDirection = new Vector3(0, 0, 1);
  readonly sunColor = new Color(1, 1, 1);
  distance = 0;
  time = 0;
  fovY = 1;
  viewportHeight = 1080;

  set(
    cameraLocal: Vector3,
    sunDirection: Vector3,
    sunColor: Color,
    time: number,
    fovY: number,
    viewportHeight: number,
  ): this {
    this.cameraLocal.copy(cameraLocal);
    this.sunDirection.copy(sunDirection).normalize();
    this.sunColor.copy(sunColor);
    this.distance = cameraLocal.length();
    this.time = time;
    this.fovY = fovY;
    this.viewportHeight = viewportHeight;
    return this;
  }
}
