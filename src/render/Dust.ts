/**
 * Orbital dust (v3 T4, PLAN E1) — the renderer.
 *
 * ~2,400 short streaks in a 400 m cube that wraps around the camera. The
 * cube's contents are fixed in the LOCAL CIRCULAR-ORBIT frame (see
 * `dustKinematics.ts`): coasting in orbit they hang still, a burn makes them
 * stream in proportion to Δv, and each streak is as long as the relative
 * speed times a shutter. Fine dust scatters forward, so it lights up when you
 * look towards the star and is all but invisible looking away, and not at all
 * in a planet's shadow (§6: one key light, nothing self-lit).
 *
 * One InstancedBufferGeometry, one draw call. The wrap happens in the vertex
 * shader from a single offset uniform, so nothing is written per instance per
 * frame. The offset is integrated from relative velocity and never reads a
 * position, so a floating-origin rebase cannot move the field.
 *
 * Scene contract (as propulsion.ts): linear HDR, toneMapped false, no
 * colorspace or dither, all four logdepthbuf chunks.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';

import type { EngineContext, GameModule } from '@/core/Engine';
import type { Mode } from '@/core/Modes';
import { Rng } from '@/math/rng';
import type { Universe } from '@/game/Universe';
import {
  DUST_COUNT,
  DUST_CUBE_M,
  DUST_SHUTTER_S,
  DustDrift,
  dustEnabled,
  dustRelativeVelocity,
  inPlanetShadow,
  streakLengthM,
} from './dustKinematics';

const ACTIVE: readonly Mode[] = ['title', 'flight', 'map'];
/** Overall brightness, linear HDR. Dim: dust is texture, not a light show. */
const DUST_INTENSITY = 0.55;
/** Seconds for the field to fade in or out (cruise, warp, shadow). */
const FADE_S = 0.6;

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute vec4 aSeed;      // xyz position in the unit cube, w brightness jitter
uniform vec3  uOffset;     // field offset, unit cube (offset / size)
uniform float uSize;       // cube edge, km
uniform vec3  uStreak;     // streak vector, km, world axes (tail = head - uStreak)
uniform vec2  uResolution;
uniform float uMinPx;

varying float vFade;
varying float vBright;
varying vec3  vDir;
varying float vU;

void main() {
  vec3 p = (fract(aSeed.xyz + uOffset) - 0.5) * uSize;
  // Fade towards the cube faces so the wrap never pops, and very near the
  // lens so a streak never fills the frame.
  float r = length(p) / (0.5 * uSize);
  vFade = (1.0 - smoothstep(0.55, 0.98, r)) * smoothstep(0.004, 0.02, length(p));
  vBright = aSeed.w;
  vDir = normalize(p);

  // modelMatrix is a pure translation to the camera.
  vec4 a = viewMatrix * modelMatrix * vec4(p, 1.0);
  vec4 b = viewMatrix * modelMatrix * vec4(p - uStreak, 1.0);
  vec4 ca = projectionMatrix * a;
  vec4 cb = projectionMatrix * b;
  if (ca.w <= 1e-6 || cb.w <= 1e-6) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vFade = 0.0;
    return;
  }
  vec2 na = ca.xy / ca.w;
  vec2 nb = cb.xy / cb.w;
  vec2 d = (nb - na) * uResolution * 0.5;     // pixels
  float len = length(d);
  vec2 dir = len > 1e-3 ? d / len : vec2(1.0, 0.0);
  float extra = max(uMinPx - len, 0.0);
  // Energy: a long streak spreads the same light over more pixels.
  vBright *= mix(1.0, uMinPx / max(len, uMinPx), 0.6);

  float t = position.x;                       // 0 head .. 1 tail
  vU = position.y;
  vec4 c = mix(ca, cb, t);
  vec2 along = dir * extra * (t - 0.5);       // pad a dot to uMinPx
  vec2 side = vec2(-dir.y, dir.x) * position.y * 0.75; // ±0.75 px
  c.xy += (along + side) * 2.0 / uResolution * c.w;
  gl_Position = c;
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3  uSunDir;     // unit, world axes, towards the star
uniform vec3  uColor;
uniform float uIntensity;

varying float vFade;
varying float vBright;
varying vec3  vDir;
varying float vU;

void main() {
  #include <logdepthbuf_fragment>
  // Henyey-Greenstein forward scatter, g = 0.7, normalised to 1 at the star.
  float g = 0.7;
  float c = dot(vDir, uSunDir);
  float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5);
  float hg1 = (1.0 - g * g) / pow(1.0 - g, 3.0);
  float phase = hg / hg1;
  float edge = 1.0 - abs(vU);
  float a = vFade * phase * uIntensity * vBright * edge;
  if (a < 0.0005) discard;
  gl_FragColor = vec4(uColor * a, 1.0);
}
`;

export interface DustOptions {
  readonly universe: Universe;
  /** True while a jump is running. */
  readonly warping: () => boolean;
}

export class Dust implements GameModule {
  readonly name = 'dust';
  readonly activeIn = ACTIVE;
  readonly mesh: Mesh;

  private readonly material: ShaderMaterial;
  private readonly geometry: InstancedBufferGeometry;
  private readonly drift = new DustDrift(DUST_CUBE_M);
  private readonly universe: Universe;
  private readonly warping: () => boolean;
  private level = 0;

  private readonly rel = new Vector3();
  private readonly spin = new Vector3();
  private readonly rShip = new Vector3();
  private readonly toStar = new Vector3();

  constructor(opts: DustOptions) {
    this.universe = opts.universe;
    this.warping = opts.warping;

    const g = new InstancedBufferGeometry();
    // One quad: x = 0 head / 1 tail, y = -1 / +1 side.
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3),
    );
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(DUST_COUNT * 4);
    const rng = new Rng(0xd057);
    for (let i = 0; i < DUST_COUNT; i++) {
      seeds[i * 4] = rng.next();
      seeds[i * 4 + 1] = rng.next();
      seeds[i * 4 + 2] = rng.next();
      // Mostly faint, a few motes catching the light.
      seeds[i * 4 + 3] = 0.25 + 0.75 * Math.pow(rng.next(), 3);
    }
    g.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 4));
    g.instanceCount = DUST_COUNT;
    this.geometry = g;

    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uOffset: { value: new Vector3() },
        uSize: { value: DUST_CUBE_M / 1000 },
        uStreak: { value: new Vector3() },
        uResolution: { value: new Vector2(1920, 1080) },
        uMinPx: { value: 1.6 },
        uSunDir: { value: new Vector3(0, 0, 1) },
        uColor: { value: new Vector3(0.78, 0.74, 0.68) },
        uIntensity: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    this.mesh = new Mesh(g, this.material);
    this.mesh.name = 'dust';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  init(ctx: EngineContext): void {
    ctx.scene.add(this.mesh);
  }

  onModeChange(_from: Mode, to: Mode): void {
    if (!ACTIVE.includes(to)) this.mesh.visible = false;
  }

  update(dt: number, ctx: EngineContext): void {
    const u = this.material.uniforms;
    const flight = this.universe.flight;
    const parent = this.universe.shipParent;

    const on =
      !this.universe.paused &&
      dustEnabled({ cruise: flight.cruising, warp: this.warping() });

    // Frame of reference: the parent's circular orbit, or its co-rotating air.
    let spin: Vector3 | null = null;
    let lit = 1;
    this.toStar.copy(flight.worldPosition).multiplyScalar(-1);
    const starDist = this.toStar.length();
    if (starDist > 0) this.toStar.divideScalar(starDist);
    if (parent) {
      const air = parent.spec.atmosphere;
      const alt = flight.position.length() - parent.spec.radius;
      if (air && alt < air.thickness && parent.spec.rotationPeriod !== 0) {
        const w = (2 * Math.PI) / parent.spec.rotationPeriod;
        const t = parent.spec.axialTilt;
        spin = this.spin.set(Math.sin(t), Math.cos(t), 0).normalize().multiplyScalar(w);
      }
      this.rShip.copy(flight.position);
      if (inPlanetShadow(this.rShip, this.toStar, parent.spec.radius)) lit = 0;
    }
    dustRelativeVelocity(flight.position, flight.velocity, parent ? parent.frame.mu : null, spin, this.rel);
    // Simulated time: under time compression the field moves as the ship does.
    const simDt = this.universe.simulatedSeconds > 0 ? this.universe.simulatedSeconds : 0;
    this.drift.advance(this.rel, simDt);

    const target = on ? lit : 0;
    const k = Math.min(1, dt / FADE_S);
    this.level += (target - this.level) * k;
    if (Math.abs(target - this.level) < 1e-3) this.level = target;
    this.mesh.visible = this.level > 0.002;
    if (!this.mesh.visible) return;

    // The shutter is applied in render time: a 10× compressed burn reads as a
    // 10× faster stream, which is what the eye is told is happening.
    const speed = this.rel.length();
    const compress = dt > 0 ? simDt / dt : 1;
    const len = streakLengthM(speed * compress, DUST_SHUTTER_S);
    // The dust moves -rel past the camera, so a mote was at p + rel·shutter when
    // the shutter opened: the tail trails along +rel (tail = head - uStreak).
    if (speed > 1e-9) u.uStreak!.value.copy(this.rel).multiplyScalar(-len / 1000 / speed);
    else u.uStreak!.value.set(0, 0, 0);

    u.uOffset!.value.copy(this.drift.offsetM).divideScalar(DUST_CUBE_M);
    u.uSunDir!.value.copy(this.toStar);
    u.uIntensity!.value = DUST_INTENSITY * this.level;
    const px = ctx.renderer.getPixelRatio();
    u.uResolution!.value.set(ctx.width * px, ctx.height * px);
    u.uMinPx!.value = 1.6 * px;
  }

  /** After every camera writer (the rig, the photo overlay): pin the cube to the lens. */
  lateUpdate(_dt: number, ctx: EngineContext): void {
    if (this.mesh.visible) ctx.camera.getWorldPosition(this.mesh.position);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
