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
 * CAMERA-RELATIVE (ruling R15). Render space reaches ~10 000 km from zero
 * before the floating origin rebases, and float32 there steps by ~1 m: had
 * the GPU composed `viewMatrix * modelMatrix * instanceMatrix` with render-
 * absolute translations, a 50 m spinning rock would shimmer by half a metre.
 * So each instance translation is `asteroidWorld − cameraWorld`, taken in
 * float64 on the CPU (|t| ≤ ~400 km: float32 there steps by ~3 cm, so
 * ≈ ±1.5 cm of rounding, invisible on a rock seen from that far), and the
 * root Group sits at the camera's render position as a pure translation:
 * three.js builds `modelViewMatrix` on the CPU in float64, where that
 * translation cancels the view's to within rounding of the camera itself.
 * The shader is `projectionMatrix * modelViewMatrix * instanceMatrix`.
 *
 * Two phases: `update` picks the rocks and assigns slots (after Universe has
 * rebased and the Belt has re-memoised); `lateUpdate` writes the matrices
 * and moves the root, after every camera writer (as Dust pins its cube).
 *
 * Distant fields are not drawn at all in this task (decision recorded for
 * DECISIONS): past 400 km an asteroid of ≤ 0.6 km is under a pixel anyway.
 *
 * Light: the one key light (render/keyLight.ts), Lambert plus a weak ambient
 * of the same light, and a Blinn specular. The composition sets the surface
 * through `asteroidSurface` (final review I1): albedo, specular strength and
 * metalness; the highlight is tinted by the albedo as metalness rises
 * (F0 ≈ albedo) and never peaks above ~1.5× the diffuse, so a metal rock
 * reads as grey stone with a terminator, not a clipped white disc. Ice is
 * light blue-grey, metal a neutral grey, silicate brown-grey. The sun direction is in world
 * (= render) axes; the root is a pure translation, so instance-rotated
 * normals are in those axes too, and the view vector is the negated
 * camera-relative position.
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
import { ASTEROID_SPEC_EXPONENT, asteroidSurface } from './asteroidSurface';
import { keyLightAt } from './keyLight';

/** Shared variant geometries, one InstancedMesh (one draw call) each. */
export const ASTEROID_VARIANTS = 8;
/** Instances drawn at most, nearest first. */
export const MAX_ASTEROID_INSTANCES = 256;
/** Asteroids farther than this from the ship are not drawn. */
export const ASTEROID_DRAW_KM = 1_500;

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
attribute float aMetal;    // metalness: 0 white highlight … 1 tinted by the albedo

varying vec3 vNormal;      // world (= render) axes
varying vec3 vRel;         // camera-relative position, world axes, km
varying vec4 vSurface;
varying float vMetal;

void main() {
  // The root is a pure translation to the camera, so the instance matrix
  // alone is camera-relative position and world-axis rotation.
  vec4 rel = instanceMatrix * vec4(position, 1.0);
  vRel = rel.xyz;
  // Uniform scale: the rotation part is enough for the normal.
  vNormal = normalize(mat3(instanceMatrix) * normal);
  vSurface = aSurface;
  vMetal = aMetal;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
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
varying vec3 vRel;
varying vec4 vSurface;
varying float vMetal;

void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vNormal);
  vec3 v = normalize(-vRel);
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 h = normalize(uSunDir + v);
  float spec = vSurface.a * pow(max(dot(n, h), 0.0), ${ASTEROID_SPEC_EXPONENT.toFixed(1)}) * ndl;
  // F0 ≈ albedo for metal: the highlight takes the rock's own colour.
  vec3 albedo = vSurface.rgb;
  vec3 specColor = mix(vec3(1.0), albedo / max(max(albedo.r, albedo.g), max(albedo.b, 1e-4)), vMetal);
  vec3 c = uSunColor * (albedo * (ndl + uAmbient) + specColor * spec);
  gl_FragColor = vec4(c, 1.0);
}
`;

export class Asteroids implements GameModule {
  readonly name = 'asteroids';
  readonly activeIn = ACTIVE;
  /** Holds the meshes; a pure translation to the camera's render position. */
  readonly root = new Group();
  readonly meshes: readonly InstancedMesh[];

  private readonly belt: AsteroidSource;
  private readonly universe: AsteroidsWorld;
  private readonly material: ShaderMaterial;
  private readonly geometries: BufferGeometry[] = [];
  private readonly surfaces: InstancedBufferAttribute[] = [];
  private readonly metals: InstancedBufferAttribute[] = [];
  /** One reusable update range per mesh (three clears the list after upload). */
  private readonly matrixRanges: Array<{ start: number; count: number }> = [];
  private readonly surfaceRanges: Array<{ start: number; count: number }> = [];
  private readonly metalRanges: Array<{ start: number; count: number }> = [];
  /** The asteroid id in each slot of each variant, so an unchanged slot is not re-uploaded. */
  private readonly slotIds: Array<Array<string | null>> = [];

  // Per-frame scratch, grown rarely (amortised), never per frame.
  private readonly near: string[] = [];
  private readonly order: number[] = [];
  private dist = new Float64Array(MAX_ASTEROID_INSTANCES * 2);
  private world = new Float64Array(MAX_ASTEROID_INSTANCES * 6);
  private readonly counts = new Int32Array(ASTEROID_VARIANTS);
  private readonly byDistance = (a: number, b: number): number => this.dist[a]! - this.dist[b]!;

  // The rocks kept by update, for lateUpdate: index into near/world, variant, slot, seed, radius.
  private kept = 0;
  private readonly keptIndex = new Int32Array(MAX_ASTEROID_INSTANCES);
  private readonly keptVariant = new Int32Array(MAX_ASTEROID_INSTANCES);
  private readonly keptSlot = new Int32Array(MAX_ASTEROID_INSTANCES);
  private readonly keptSeed = new Uint32Array(MAX_ASTEROID_INSTANCES);
  private readonly keptRadius = new Float64Array(MAX_ASTEROID_INSTANCES);

  private readonly w = { x: 0, y: 0, z: 0 };
  private readonly cam = new Vector3();
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

    // All eight up front: 642 vertices each, ~0.2 ms apiece.
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
      const metal = new InstancedBufferAttribute(new Float32Array(MAX_ASTEROID_INSTANCES), 1);
      metal.setUsage(DynamicDrawUsage);
      g.setAttribute('aMetal', metal);
      // Each variant can hold every instance: a field may be all one shape.
      const mesh = new InstancedMesh(g, this.material, MAX_ASTEROID_INSTANCES);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.count = 0;
      mesh.name = `asteroids-${v}`;
      // Instances move every frame; the bounding sphere would always be stale.
      mesh.frustumCulled = false;
      this.geometries.push(g);
      this.surfaces.push(surface);
      this.metals.push(metal);
      this.matrixRanges.push({ start: 0, count: 0 });
      this.surfaceRanges.push({ start: 0, count: 0 });
      this.metalRanges.push({ start: 0, count: 0 });
      this.slotIds.push(new Array<string | null>(MAX_ASTEROID_INSTANCES).fill(null));
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

  /** Which rocks, and which slot each one takes. */
  update(_dt: number, _ctx: EngineContext): void {
    // The ranges from the last frame were read by its render; this frame
    // starts empty and gathers exactly the slots it changes (final review, a).
    for (let v = 0; v < ASTEROID_VARIANTS; v++) {
      this.surfaceRanges[v]!.count = 0;
      this.metalRanges[v]!.count = 0;
    }
    // A review shot owns the scene (same rule as Traffic).
    if (shotOwnsScene()) {
      this.kept = 0;
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

    const counts = this.counts;
    counts.fill(0);
    let total = 0;
    for (let k = 0; k < keep; k++) {
      const i = order[k]!;
      const id = this.near[i]!;
      const spec = this.belt.asteroidSpec(id);
      if (!spec) continue;
      const seed = spec.seed >>> 0;
      const v = seed % ASTEROID_VARIANTS;
      const slot = counts[v]!;
      const ids = this.slotIds[v]!;
      if (ids[slot] !== id) {
        // A new occupant: its tint goes up; an unchanged slot uploads nothing.
        ids[slot] = id;
        writeSurface(spec, this.surfaces[v]!.array as Float32Array, this.metals[v]!.array as Float32Array, slot);
        grow(this.surfaceRanges[v]!, slot * 4, 4);
        grow(this.metalRanges[v]!, slot, 1);
      }
      this.keptIndex[total] = i;
      this.keptVariant[total] = v;
      this.keptSlot[total] = slot;
      this.keptSeed[total] = seed;
      this.keptRadius[total] = spec.radiusKm;
      counts[v] = slot + 1;
      total++;
    }
    this.kept = total;

    for (let v = 0; v < ASTEROID_VARIANTS; v++) {
      const mesh = this.meshes[v]!;
      mesh.count = counts[v]!;
      const r = this.surfaceRanges[v]!;
      if (r.count > 0) {
        const surface = this.surfaces[v]!;
        surface.updateRanges.length = 0;
        surface.updateRanges.push(r);
        surface.needsUpdate = true;
        const metal = this.metals[v]!;
        metal.updateRanges.length = 0;
        metal.updateRanges.push(this.metalRanges[v]!);
        metal.needsUpdate = true;
      }
    }
    this.root.visible = total > 0;
    if (total === 0) return;

    // The key light at the ship: every rock within 400 km sees the same star.
    const u = this.material.uniforms;
    const d = Math.hypot(ship.x, ship.y, ship.z);
    if (d > 0) u.uSunDir!.value.set(-ship.x / d, -ship.y / d, -ship.z / d);
    const level = keyLightAt(this.universe.system?.stars[0]?.luminosity ?? 1, d);
    u.uSunColor!.value.set(SUN_BASE[0] * level, SUN_BASE[1] * level, SUN_BASE[2] * level);
  }

  /** After every camera writer: matrices relative to the camera, root at the camera. */
  lateUpdate(_dt: number, ctx: EngineContext): void {
    if (!this.root.visible || this.kept === 0) return;

    ctx.camera.getWorldPosition(this.cam);
    this.root.position.copy(this.cam);
    // Camera in world space, float64.
    const off = ctx.origin.offset;
    const cx = off.x + this.cam.x;
    const cy = off.y + this.cam.y;
    const cz = off.z + this.cam.z;

    const t = Number.isFinite(this.universe.orbitSeconds) ? this.universe.orbitSeconds : 0;
    const world = this.world;
    for (let k = 0; k < this.kept; k++) {
      const i = this.keptIndex[k]!;
      this.p.set(world[i * 3]! - cx, world[i * 3 + 1]! - cy, world[i * 3 + 2]! - cz);
      spinOf(this.keptSeed[k]!, t, this.axis, this.q);
      this.s.setScalar(this.keptRadius[k]!);
      this.m.compose(this.p, this.q, this.s);
      this.meshes[this.keptVariant[k]!]!.setMatrixAt(this.keptSlot[k]!, this.m);
    }

    for (let v = 0; v < ASTEROID_VARIANTS; v++) {
      const mesh = this.meshes[v]!;
      const attr = mesh.instanceMatrix;
      attr.updateRanges.length = 0;
      if (mesh.count === 0) continue;
      const r = this.matrixRanges[v]!;
      r.start = 0;
      r.count = mesh.count * 16;
      attr.updateRanges.push(r);
      attr.needsUpdate = true;
    }
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

/** Widen a range to cover [at, at + n). */
function grow(r: { start: number; count: number }, at: number, n: number): void {
  if (r.count === 0) {
    r.start = at;
    r.count = n;
    return;
  }
  const end = Math.max(r.start + r.count, at + n);
  r.start = Math.min(r.start, at);
  r.count = end - r.start;
}

/** Albedo, specular strength and metalness of one slot, from `asteroidSurface`. */
function writeSurface(spec: AsteroidSpec, surface: Float32Array, metal: Float32Array, slot: number): void {
  const s = asteroidSurface(spec.composition);
  const at = slot * 4;
  surface[at] = s.albedo[0];
  surface[at + 1] = s.albedo[1];
  surface[at + 2] = s.albedo[2];
  surface[at + 3] = s.spec;
  metal[slot] = s.metalness;
}
