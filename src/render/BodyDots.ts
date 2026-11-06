/**
 * Distant worlds as points of light.
 *
 * A body further than the streaming distance (60 radii) has no renderer at
 * all, so at spawn 11 of 13 bodies in the opening system were simply not
 * there: you could not fly towards a planet because there was no planet to
 * see (GAMEPLAY B2). Each one is now a 2 px amber point, dim by default and
 * brighter while it is the nav target. One `Points` object, one draw call,
 * however many bodies the system has.
 *
 * Follows the renderer contract (ARCHITECTURE §10): it never adds itself to
 * the scene and reads no global state. The integrator writes each point's
 * render-space position and wanted brightness with `setDot()`; `update()`
 * eases the brightness so a dot never pops in or out — when a world streams
 * in, its dot fades as the disc appears.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Points,
  PointsMaterial,
  type Object3D,
} from 'three';

import type { QualitySettings } from '@/core/Config';
import type { EngineContext } from '@/core/Engine';
import { registerShot } from '@/game/Shots';
import type { ViewState } from '@/render/ViewState';

export interface BodyDotsSpec {
  /** Most points ever shown. A system has at most a few dozen bodies. */
  readonly capacity: number;
}

/**
 * Amber, pre-desaturated: the instrument glow colour, not a star colour, so a
 * dot reads as "a thing the ship knows about" and never as another sun.
 */
const AMBER: readonly [number, number, number] = [1.0, 0.66, 0.3];
/** Brightness easing rate, 1/s. ~0.4 s to settle. */
const FADE_RATE = 7;
/** Dot diameter in CSS pixels. */
const DOT_CSS_PX = 2;
/**
 * Never smaller than this in framebuffer pixels. The resolution governor can
 * drop the drawing buffer to half the CSS size; a 1-texel point then dies in
 * the upscale and the grain, and the world is invisible again. Measured.
 */
const DOT_MIN_FB_PX = 2;
/**
 * HDR gain. The frame is metered and tone-mapped; a 2 px point at unit
 * radiance lands under the grain. This puts a dim dot at the level of a
 * faint star and a targeted one at a bright star.
 */
const DOT_GAIN = 3.5;

export class BodyDotsRenderer {
  readonly object3d: Object3D;

  private readonly geometry = new BufferGeometry();
  private readonly material: PointsMaterial;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly posAttr: BufferAttribute;
  private readonly colAttr: BufferAttribute;
  /** Brightness wanted by the integrator, and the eased value shown. */
  private readonly want: Float32Array;
  private readonly shown: Float32Array;
  private count = 0;

  constructor(spec: BodyDotsSpec, _quality: QualitySettings) {
    const n = Math.max(1, spec.capacity | 0);
    this.positions = new Float32Array(n * 3);
    this.colors = new Float32Array(n * 3);
    this.want = new Float32Array(n);
    this.shown = new Float32Array(n);
    this.posAttr = new BufferAttribute(this.positions, 3);
    this.colAttr = new BufferAttribute(this.colors, 3);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colAttr);
    this.geometry.setDrawRange(0, 0);

    this.material = new PointsMaterial({
      // Screen pixels, not world units: a world 1e8 km away must not shrink
      // to nothing, and one 60 radii away must not grow into a square.
      size: DOT_CSS_PX,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      // Additive, so a zero-brightness point is exactly invisible and a dot
      // over a lit limb brightens it rather than punching a dark square.
      blending: AdditiveBlending,
      depthWrite: false,
      // Depth-tested: a world behind the planet in front of you is occluded.
      depthTest: true,
    });

    const points = new Points(this.geometry, this.material);
    // Positions change every frame and span the whole system; a stale
    // bounding sphere would cull dots that are plainly on screen.
    points.frustumCulled = false;
    points.renderOrder = -1;
    points.name = 'body-dots';
    this.object3d = points;
  }

  get capacity(): number {
    return this.want.length;
  }

  /** How many slots are live this frame. Slots past it are not drawn. */
  setCount(n: number): void {
    const c = Math.max(0, Math.min(this.want.length, n | 0));
    // Slots dropping out start from dark when they come back.
    for (let i = c; i < this.count; i++) this.shown[i] = 0;
    this.count = c;
    this.geometry.setDrawRange(0, c);
  }

  /** Render-space position (km) and wanted brightness 0..1 for slot `i`. */
  setDot(i: number, x: number, y: number, z: number, brightness: number): void {
    if (i < 0 || i >= this.want.length) return;
    const k = i * 3;
    this.positions[k] = x;
    this.positions[k + 1] = y;
    this.positions[k + 2] = z;
    this.want[i] = brightness < 0 ? 0 : brightness > 1 ? 1 : brightness;
  }

  /** Jump every slot straight to its wanted brightness (system entry, shots). */
  snap(): void {
    for (let i = 0; i < this.count; i++) this.shown[i] = this.want[i]!;
  }

  update(dt: number, ctx: EngineContext, _view: ViewState): void {
    // Size is in framebuffer pixels, which the governor rescales at runtime.
    this.material.size = Math.max(DOT_MIN_FB_PX, DOT_CSS_PX * ctx.renderer.getPixelRatio());
    const a = 1 - Math.exp(-FADE_RATE * dt);
    for (let i = 0; i < this.count; i++) {
      const b = this.shown[i]! + (this.want[i]! - this.shown[i]!) * a;
      this.shown[i] = b;
      const k = i * 3;
      const g = b * DOT_GAIN;
      this.colors[k] = AMBER[0] * g;
      this.colors[k + 1] = AMBER[1] * g;
      this.colors[k + 2] = AMBER[2] * g;
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * 'body-dots': a fixed fan of points ahead of the camera, one targeted, so the
 * size, colour and dim-versus-target contrast can be judged against black.
 */
export function registerBodyDotsShots(dots: BodyDotsRenderer): void {
  const FAN = 7;
  registerShot({
    name: 'body-dots',
    description:
      'Distant worlds as 2 px amber points: six dim, one brighter as the nav target, against open sky.',
    apply(ctx) {
      ctx.camera.position.set(0, 0, 0);
      ctx.camera.quaternion.identity();
      ctx.camera.updateMatrixWorld();
      dots.object3d.visible = true;
      dots.setCount(FAN);
      for (let i = 0; i < FAN; i++) {
        const ang = (i - (FAN - 1) / 2) * 0.12;
        dots.setDot(i, Math.sin(ang) * 1e6, Math.cos(i * 1.7) * 6e4, -Math.cos(ang) * 1e6, i === 2 ? 1 : 0.22);
      }
      dots.snap();
    },
    teardown() {
      dots.setCount(0);
    },
  });
}
