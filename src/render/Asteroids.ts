/**
 * The asteroids, seen (v4 sub-plan 2, Task 4) — the renderer.
 *
 * Each frame the Belt is asked for the asteroids within ASTEROID_DRAW_KM of
 * the ship; the MAX_ASTEROID_INSTANCES nearest are kept and written as one
 * instance matrix each into one of ASTEROID_VARIANTS InstancedMeshes (the
 * variant is `seed % 8`, the scale is the radius in km, and a slow spin comes
 * from the seed). Eight shared geometries from `asteroidShape`, eight draw
 * calls, whatever the field holds.
 *
 * Positions are uploaded in RENDER space: the belt's world position (float64,
 * star frame) through `ctx.origin.toRenderXYZ`, rewritten every frame, so a
 * floating-origin rebase moves every rock the same frame it happens (Universe
 * rebases before this module updates).
 *
 * Distant fields are not drawn at all in this task (decision recorded for
 * DECISIONS): past 400 km an asteroid of ≤ 0.6 km is under a pixel anyway.
 *
 * Light: the one key light (render/keyLight.ts), Lambert plus a weak ambient
 * of the same light, and a Blinn specular whose strength the composition sets.
 * The composition also gives the tint: ice light blue-grey, metal darker with
 * a stronger highlight, silicate brown-grey.
 *
 * Scene contract (as Dust): linear HDR, toneMapped false, no colorspace or
 * dither, all four logdepthbuf chunks.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';

import type { EngineContext, GameModule } from '@/core/Engine';
import type { Mode } from '@/core/Modes';
import type { AsteroidSpec } from '@/gen/belt';
import type { StarSystemSpec } from '@/gen/types';
import { shotOwnsScene } from '@/game/Shots';
import { asteroidShape } from './asteroidShape';
import { keyLightAt } from './keyLight';

/** Shared variant geometries, one InstancedMesh (one draw call) each. */
export const ASTEROID_VARIANTS = 8;
/** Instances drawn at most, nearest first. */
export const MAX_ASTEROID_INSTANCES = 256;
/** Asteroids farther than this from the ship are not drawn. */
export const ASTEROID_DRAW_KM = 400;

const ACTIVE: readonly Mode[] = ['title', 'flight', 'map'];

/** Seeds of the eight variant shapes (fixed: the variant is chosen by seed % 8). */
const VARIANT_SEED_BASE = 0xa57e0000;

/** Spin periods, seconds of orbit time: slow tumbles. */
const SPIN_MIN_S = 600;
const SPIN_MAX_S = 7_200;

/** Ambient as a fraction of the key light: the night side is nearly black. */
const AMBIENT = 0.04;
/** The star's light before the key-light level (same base as Traffic's hulls). */
const SUN_BASE: readonly [number, number, number] = [1, 0.96, 0.9];

/** Linear albedo and specular strength per resource. Rare ores read as metal. */
const ICE = { r: 0.55, g: 0.62, b: 0.7, spec: 0.12 };
const METAL = { r: 0.15, g: 0.15, b: 0.16, spec: 0.55 };
const SILICATE = { r: 0.3, g: 0.26, b: 0.22, spec: 0.04 };

/** What this renderer reads of the Belt. `Belt` satisfies it. */
export interface AsteroidSource {
  asteroidsNear(world: { x: number; y: number; z: number }, maxKm: number, out: string[]): number;
  asteroidWorld(id: string, out: { x: number; y: number; z: number }): boolean;
  asteroidSpec(id: string): AsteroidSpec | null;
}

/** What it reads of the universe. `Universe` satisfies it. */
export interface AsteroidsWorld {
  readonly system: StarSystemSpec | null | undefined;
  readonly orbitSeconds: number;
  readonly flight: { readonly worldPosition: { readonly x: number; readonly y: number; readonly z: number } };
}

export interface AsteroidsOptions {
  readonly belt: AsteroidSource;
  readonly universe: AsteroidsWorld;
}

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute vec4 aSurface;   // rgb linear albedo, a specular strength

varying vec3 vNormal;
varying vec3 vWorld;
varying vec4 vSurface;

void main() {
  mat4 inst = mat4(1.0);
  #ifdef USE_INSTANCING
  inst = instanceMatrix;
  #endif
  vec4 wp = modelMatrix * inst * vec4(position, 1.0);
  vWorld = wp.xyz;
  // Uniform scale: the rotation part is enough for the normal.
  vNormal = normalize(mat3(modelMatrix * inst) * normal);
  vSurface = aSurface;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3  uSunDir;     // unit, world axes, towards the star
uniform vec3  uSunColor;   // key light, linear HDR
uniform float uAmbient;

varying vec3 vNormal;
varying vec3 vWorld;
varying vec4 vSurface;

void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vWorld);
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 h = normalize(uSunDir + v);
  float spec = vSurface.a * pow(max(dot(n, h), 0.0), 24.0) * ndl;
  vec3 c = uSunColor * (vSurface.rgb * (ndl + uAmbient) + spec);
  gl_FragColor = vec4(c, 1.0);
}
`;

export class Asteroids implements GameModule {
  readonly name = 'asteroids';
  readonly activeIn = ACTIVE;
  readonly root = new Group();
  readonly meshes: readonly InstancedMesh[];

  private readonly belt: AsteroidSource;
  private readonly universe: AsteroidsWorld;
  private readonly material: ShaderMaterial;
  private readonly geometries: BufferGeometry[] = [];
  private readonly surfaces: InstancedBufferAttribute[] = [];

  // Per-frame scratch, grown rarely (amortised), never per frame.
  private readonly near: string[] = [];
  private readonly order: number[] = [];
  private dist = new Float64Array(MAX_ASTEROID_INSTANCES * 2);
  private world = new Float64Array(MAX_ASTEROID_INSTANCES * 6);
  private readonly counts = new Int32Array(ASTEROID_VARIANTS);
  private readonly byDistance = (a: number, b: number): number => this.dist[a]! - this.dist[b]!;

  private readonly w = { x: 0, y: 0, z: 0 };
  private readonly p = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();
  private readonly axis = new Vector3();
  private readonly m = new Matrix4();

  constructor(opts: AsteroidsOptions) {
    this.belt = opts.belt;
    this.universe = opts.universe;

    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uSunDir: { value: new Vector3(0, 0, 1) },
        uSunColor: { value: new Vector3(1, 1, 1) },
        uAmbient: { value: AMBIENT },
      },
      toneMapped: false,
    });

    // All eight up front: 642 vertices each, well under a millisecond apiece.
    const meshes: InstancedMesh[] = [];
    for (let v = 0; v < ASTEROID_VARIANTS; v++) {
      const shape = asteroidShape((VARIANT_SEED_BASE + v) >>> 0);
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(shape.positions, 3));
      g.setAttribute('normal', new BufferAttribute(shape.normals, 3));
      g.setIndex(new BufferAttribute(shape.index, 1));
      const surface = new InstancedBufferAttribute(new Float32Array(MAX_ASTEROID_INSTANCES * 4), 4);
      surface.setUsage(DynamicDrawUsage);
      g.setAttribute('aSurface', surface);
      // Each variant can hold every instance: a field may be all one shape.
      const mesh = new InstancedMesh(g, this.material, MAX_ASTEROID_INSTANCES);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.count = 0;
      mesh.name = `asteroids-${v}`;
      // Instances move every frame; the bounding sphere would always be stale.
      mesh.frustumCulled = false;
      this.geometries.push(g);
      this.surfaces.push(surface);
      meshes.push(mesh);
      this.root.add(mesh);
    }
    this.meshes = meshes;
    this.root.name = 'asteroids';
    this.root.visible = false;
  }

  init(ctx: EngineContext): void {
    ctx.scene.add(this.root);
  }

  onModeChange(_from: Mode, to: Mode): void {
    if (!ACTIVE.includes(to)) this.root.visible = false;
  }

  update(_dt: number, ctx: EngineContext): void {
    // A review shot owns the scene (same rule as Traffic).
    if (shotOwnsScene()) {
      this.root.visible = false;
      return;
    }
    const ship = this.universe.flight.worldPosition;
    const n = this.belt.asteroidsNear(ship, ASTEROID_DRAW_KM, this.near);
    this.reserve(n);

    // Where each one is now, and how far from the ship.
    const dist = this.dist;
    const world = this.world;
    const order = this.order;
    order.length = 0;
    for (let i = 0; i < n; i++) {
      if (!this.belt.asteroidWorld(this.near[i]!, this.w)) continue;
      world[i * 3] = this.w.x;
      world[i * 3 + 1] = this.w.y;
      world[i * 3 + 2] = this.w.z;
      const dx = this.w.x - ship.x;
      const dy = this.w.y - ship.y;
      const dz = this.w.z - ship.z;
      dist[i] = dx * dx + dy * dy + dz * dz;
      order.push(i);
    }
    if (order.length > MAX_ASTEROID_INSTANCES) order.sort(this.byDistance);
    const keep = Math.min(order.length, MAX_ASTEROID_INSTANCES);

    const t = Number.isFinite(this.universe.orbitSeconds) ? this.universe.orbitSeconds : 0;
    const counts = this.counts;
    counts.fill(0);
    let total = 0;
    for (let k = 0; k < keep; k++) {
      const i = order[k]!;
      const spec = this.belt.asteroidSpec(this.near[i]!);
      if (!spec) continue;
      const seed = spec.seed >>> 0;
      const v = seed % ASTEROID_VARIANTS;
      const slot = counts[v]!;

      ctx.origin.toRenderXYZ(world[i * 3]!, world[i * 3 + 1]!, world[i * 3 + 2]!, this.p);
      spinOf(seed, t, this.axis, this.q);
      this.s.setScalar(spec.radiusKm);
      this.m.compose(this.p, this.q, this.s);
      this.meshes[v]!.setMatrixAt(slot, this.m);
      writeSurface(spec, this.surfaces[v]!.array as Float32Array, slot * 4);

      counts[v] = slot + 1;
      total++;
    }

    for (let v = 0; v < ASTEROID_VARIANTS; v++) {
      const mesh = this.meshes[v]!;
      mesh.count = counts[v]!;
      if (mesh.count > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        this.surfaces[v]!.needsUpdate = true;
      }
    }
    this.root.visible = total > 0;
    if (total === 0) return;

    // The key light at the ship: every rock within 400 km sees the same star.
    const u = this.material.uniforms;
    const r = Math.hypot(ship.x, ship.y, ship.z);
    if (r > 0) u.uSunDir!.value.set(-ship.x / r, -ship.y / r, -ship.z / r);
    const level = keyLightAt(this.universe.system?.stars[0]?.luminosity ?? 1, r);
    u.uSunColor!.value.set(SUN_BASE[0] * level, SUN_BASE[1] * level, SUN_BASE[2] * level);
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const mesh of this.meshes) mesh.dispose();
    this.material.dispose();
  }

  /** Grow the scratch to hold `n` asteroids. Allocates only past the high-water mark. */
  private reserve(n: number): void {
    if (n <= this.dist.length) return;
    let cap = this.dist.length;
    while (cap < n) cap *= 2;
    this.dist = new Float64Array(cap);
    this.world = new Float64Array(cap * 3);
  }
}

/** A slow tumble from the seed: a fixed axis, a fixed period, angle by orbit time. */
function spinOf(seed: number, t: number, axis: Vector3, out: Quaternion): Quaternion {
  const h1 = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  const h2 = Math.imul(h1 ^ (h1 >>> 13), 0xc2b2ae35) >>> 0;
  const h3 = Math.imul(h2 ^ (h2 >>> 16), 0x27d4eb2f) >>> 0;
  const z = (h1 / 4294967296) * 2 - 1;
  const phi = (h2 / 4294967296) * Math.PI * 2;
  const rr = Math.sqrt(1 - z * z);
  axis.set(rr * Math.cos(phi), rr * Math.sin(phi), z);
  const period = SPIN_MIN_S + (SPIN_MAX_S - SPIN_MIN_S) * (h3 / 4294967296);
  // Phase from the seed too, so equal periods do not tumble in step.
  const angle = ((t / period + h3 / 65536) % 1) * Math.PI * 2;
  return out.setFromAxisAngle(axis, angle);
}

/** Tint and specular from the composition, by mass fraction. */
function writeSurface(spec: AsteroidSpec, out: Float32Array, at: number): void {
  const c = spec.composition;
  const ice = Math.max(0, c.ice);
  const metal = Math.max(0, c.metal) + Math.max(0, c.rare);
  const sil = Math.max(0, c.silicate);
  const sum = ice + metal + sil;
  const fi = sum > 0 ? ice / sum : 0;
  const fm = sum > 0 ? metal / sum : 0;
  const fs = sum > 0 ? sil / sum : 1;
  out[at] = fi * ICE.r + fm * METAL.r + fs * SILICATE.r;
  out[at + 1] = fi * ICE.g + fm * METAL.g + fs * SILICATE.g;
  out[at + 2] = fi * ICE.b + fm * METAL.b + fs * SILICATE.b;
  out[at + 3] = fi * ICE.spec + fm * METAL.spec + fs * SILICATE.spec;
}
