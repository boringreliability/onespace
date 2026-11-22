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
 * WEAR (plan 5, Task 5). Each rock carries `aWear = wearVisual(belt.wear(id))`
 * and `aSeed` (a fraction from its seed). The shader opens dark, hollow pits
 * on cells of a Worley lattice in the rock's own space, offset by the seed:
 * each cell's pit has a seeded threshold and opens once the look passes it,
 * widening as the look rises — so the scars grow in number and size, lie the
 * same for every player, and at wear 0 the shader takes exactly the old path.
 * The hollow is a derivative bump (the pit's depth as a height field) plus,
 * as the rock empties, a dent of the vertices themselves.
 *
 * BREAK-UP. On `'asteroid:destroyed'` for a rock this renderer drew last
 * update, the rock is replaced for BREAKUP_S of orbit time by PIECES rock
 * fragments (one shared InstancedMesh, `breakup`, at most MAX_BREAKUPS at
 * once: one extra draw call, only while one runs). The layout comes from the
 * seed; the pieces drift apart, tumble, shrink a little and go dark. They
 * ride with the field: the anchor is the rock's last position plus its
 * velocity (`asteroidVelocity`, cached per slot) times the orbit time since,
 * which over 2.5 s is the field's orbit to well under a metre. A rock that is
 * gone at load or restore is simply not drawn — no event, no break-up.
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
import { bus } from '@/core/EventBus';
import { FLIGHT_PAUSED, type Mode } from '@/core/Modes';
import type { AsteroidSpec, Resource } from '@/gen/belt';
import { AU, type StarSystemSpec } from '@/gen/types';
import { registerShot, shotOwnsScene } from '@/game/Shots';
import { asteroidShape } from './asteroidShape';
import { ASTEROID_SPEC_EXPONENT, asteroidSurface, wearVisual } from './asteroidSurface';
import { keyLightAt } from './keyLight';

/** Shared variant geometries, one InstancedMesh (one draw call) each. */
export const ASTEROID_VARIANTS = 8;
/** Instances drawn at most, nearest first. */
export const MAX_ASTEROID_INSTANCES = 256;
/** Asteroids farther than this from the ship are not drawn. */
export const ASTEROID_DRAW_KM = 1_500;
/** How long a mined-out rock takes to break up and fade, seconds of orbit time. */
export const BREAKUP_S = 2.5;
/** Break-ups drawn at once; one more in the same window is ignored. */
export const MAX_BREAKUPS = 4;

const ACTIVE: readonly Mode[] = ['title', 'flight', 'map'];

/** Seeds of the eight variant shapes (fixed: the variant is chosen by seed % 8). */
const VARIANT_SEED_BASE = 0xa57e0000;
/** Seed of the one fragment shape every break-up piece is drawn with. */
const PIECE_SHAPE_SEED = 0xa57e0f00;

/** Spin periods, seconds of orbit time: slow tumbles. */
const SPIN_MIN_S = 600;
const SPIN_MAX_S = 7_200;

/** Ambient as a fraction of the key light: the night side is nearly black. */
const AMBIENT = 0.04;
/** The star's light before the key-light level (same base as Traffic's hulls). */
const SUN_BASE: readonly [number, number, number] = [1, 0.96, 0.9];

/** Pieces per break-up; the first BIG_PIECES are the large chunks. */
const PIECES = 10;
const BIG_PIECES = 3;
/** Per-piece layout record, in `pieceData`: off xyz, vel xyz, size, axis xyz, spin, phase, scar seed. */
const PIECE_STRIDE = 13;
/** A slot's cached velocity is re-read from the Belt after this much orbit time. */
const VEL_REFRESH_S = 10;

/** What this renderer reads of the Belt. `Belt` satisfies it. */
export interface AsteroidSource {
  asteroidsNear(world: { x: number; y: number; z: number }, maxKm: number, out: string[]): number;
  asteroidWorld(id: string, out: { x: number; y: number; z: number }): boolean;
  asteroidSpec(id: string): AsteroidSpec | null;
  /** World velocity now (km/s); false for an unknown or destroyed rock. */
  asteroidVelocity(id: string, out: { x: number; y: number; z: number }): boolean;
  /** The spec even of a destroyed rock (its break-up); null for an unknown id. */
  asteroidSpecRaw(id: string): AsteroidSpec | null;
  /** Mined mass / original mass, 0..1. */
  wear(id: string): number;
  isDestroyed(id: string): boolean;
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

/**
 * The scars, shared by both shader stages. `p` is the rock's own (nominal
 * radius 1) position, `seed` its seed fraction, `wear` the look 0..1.
 * Returns the pit depth 0..1 at p. Hash without sine (Hoskins), so the
 * lattice is the same on every GPU to within float rounding.
 */
const SCAR_GLSL = /* glsl */ `
vec3 scarHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float scarDepth(vec3 p, float seed, float wear) {
  vec3 q = p * 2.6 + vec3(17.13, 31.71, 11.37) * (seed * 64.0);
  vec3 cell = floor(q);
  float depth = 0.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 c = cell + vec3(float(x), float(y), float(z));
    vec3 k = scarHash(c + 71.3);
    // The look at which this pit opens: skewed low, so the first bites show.
    float opensAt = k.x * k.x * 0.9;
    if (wear <= opensAt) continue;
    vec3 h = scarHash(c);
    float open = clamp((wear - opensAt) / (1.0 - opensAt), 0.0, 1.0);
    float r = (0.2 + 0.62 * sqrt(open)) * (0.7 + 0.5 * k.y);
    float d = length(q - (c + 0.15 + 0.7 * h));
    // A bowl: flat-ish floor, steep wall.
    float pit = 1.0 - smoothstep(r * 0.35, r, d);
    depth = max(depth, pit * (0.6 + 0.4 * k.z));
  }
  return depth;
}
`;

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute vec4 aSurface;   // rgb linear albedo, a specular strength
attribute float aMetal;    // metalness: 0 white highlight … 1 tinted by the albedo
attribute float aSeed;     // the rock's (or piece's) seed as a fraction: where its scars lie
#ifdef BREAKUP
attribute float aFade;     // 1 at the break, 0 when gone
varying float vFade;
// A piece is the inside of an emptied rock: scarred through, and cut deeper.
#define WEAR_IN 0.85
#define DENT 0.3
#else
attribute float aWear;     // wearVisual(belt.wear): 0 untouched … 1 emptied
#define WEAR_IN aWear
#define DENT 0.16
#endif
varying float vWear;
varying float vSeed;
varying vec3 vObj;         // the rock's own position, nominal radius 1
varying float vRadius;     // km
${SCAR_GLSL}

varying vec3 vNormal;      // world (= render) axes
varying vec3 vRel;         // camera-relative position, world axes, km
varying vec4 vSurface;
varying float vMetal;

void main() {
  vec3 pos = position;
#ifdef BREAKUP
  vFade = aFade;
#endif
  vWear = WEAR_IN;
  vSeed = aSeed;
  vObj = position;
  vRadius = length(instanceMatrix[0].xyz);
  // An emptied rock is eaten in, not only painted: the pits dent the outline.
  if (vWear > 0.0) pos *= 1.0 - DENT * vWear * scarDepth(position, aSeed, vWear);
  // The root is a pure translation to the camera, so the instance matrix
  // alone is camera-relative position and world-axis rotation.
  vec4 rel = instanceMatrix * vec4(pos, 1.0);
  vRel = rel.xyz;
  // Uniform scale: the rotation part is enough for the normal.
  vNormal = normalize(mat3(instanceMatrix) * normal);
  vSurface = aSurface;
  vMetal = aMetal;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
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
#ifdef BREAKUP
varying float vFade;
#endif
varying float vWear;
varying float vSeed;
varying vec3 vObj;
varying float vRadius;
${SCAR_GLSL}

void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vNormal);
  vec3 albedo = vSurface.rgb;
  float specK = vSurface.a;
  // The position derivatives are taken outside any branch (uniform control
  // flow). The scar's own derivatives sit inside the wear branch, which is
  // safe because the wear is constant across an instance.
  vec3 sx = dFdx(vRel);
  vec3 sy = dFdy(vRel);
  // Wear 0 skips all of this: an untouched rock is drawn exactly as before.
  if (vWear > 0.0) {
    float pit = scarDepth(vObj, vSeed, vWear);
    // Hollow: the pit is a height field below the surface (km), bumped
    // through screen derivatives (Mikkelsen), so its far wall catches the
    // light and its near wall falls into shadow.
    float h = -pit * vRadius * 0.09;
    vec3 r1 = cross(sy, n);
    vec3 r2 = cross(n, sx);
    float det = dot(sx, r1);
    float hx = dFdx(h);
    float hy = dFdy(h);
    if (abs(det) > 0.0) {
      vec3 grad = sign(det) * (hx * r1 + hy * r2);
      n = normalize(abs(det) * n - grad);
    }
    // Dark: fresh-cut floors are soot and shadow, and the whole rock dulls.
    albedo *= mix(1.0, 0.22, pit) * (1.0 - 0.25 * vWear);
    specK *= 1.0 - 0.8 * pit;
  }
  vec3 v = normalize(-vRel);
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 hv = normalize(uSunDir + v);
  float spec = specK * pow(max(dot(n, hv), 0.0), ${ASTEROID_SPEC_EXPONENT.toFixed(1)}) * ndl;
  // F0 ≈ albedo for metal: the highlight takes the rock's own colour.
  vec3 specColor = mix(vec3(1.0), albedo / max(max(albedo.r, albedo.g), max(albedo.b, 1e-4)), vMetal);
  vec3 c = uSunColor * (albedo * (ndl + uAmbient) + specColor * spec);
#ifdef BREAKUP
  c *= vFade;
#endif
  gl_FragColor = vec4(c, 1.0);
}
`;

/** A review-only staging of one rock (see `registerAsteroidShots`). */
export interface AsteroidReviewRock {
  readonly seed: number;
  readonly radiusKm: number;
  readonly composition: Readonly<Record<Resource, number>>;
  /** Mined fraction, as `Belt.wear`. */
  readonly wear: number;
  /** Camera-relative position, km, world axes. */
  readonly at: { readonly x: number; readonly y: number; readonly z: number };
  /** Orbit time for the spin. */
  readonly t: number;
  /** Seconds into a break-up instead of the whole rock, or null. */
  readonly breakupAge: number | null;
  /** Unit direction towards the star, world axes, and the key-light level. */
  readonly sun: { readonly x: number; readonly y: number; readonly z: number };
  readonly light: number;
}

export class Asteroids implements GameModule {
  readonly name = 'asteroids';
  readonly activeIn = ACTIVE;
  /** Holds the meshes; a pure translation to the camera's render position. */
  readonly root = new Group();
  readonly meshes: readonly InstancedMesh[];
  /** The pieces of every running break-up: the one drawable besides the eight. */
  readonly breakup: InstancedMesh;

  private readonly belt: AsteroidSource;
  private readonly universe: AsteroidsWorld;
  private readonly material: ShaderMaterial;
  private readonly pieceMaterial: ShaderMaterial;
  private readonly geometries: BufferGeometry[] = [];
  private readonly surfaces: InstancedBufferAttribute[] = [];
  private readonly metals: InstancedBufferAttribute[] = [];
  private readonly wears: InstancedBufferAttribute[] = [];
  private readonly seeds: InstancedBufferAttribute[] = [];
  /** One reusable update range per mesh (three clears the list after upload). */
  private readonly matrixRanges: Array<{ start: number; count: number }> = [];
  private readonly surfaceRanges: Array<{ start: number; count: number }> = [];
  private readonly metalRanges: Array<{ start: number; count: number }> = [];
  private readonly seedRanges: Array<{ start: number; count: number }> = [];
  private readonly wearRanges: Array<{ start: number; count: number }> = [];
  /** The asteroid id in each slot of each variant, so an unchanged slot is not re-uploaded. */
  private readonly slotIds: Array<Array<string | null>> = [];
  /** Each slot's velocity (km/s, xyz) and the orbit time it was read at. */
  private readonly slotVel: Float64Array[] = [];
  private readonly slotVelT: Float64Array[] = [];

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
  /** Orbit time of the last update: when `world` was taken. */
  private keptT = 0;
  /** The system the last update saw; a change drops every break-up. */
  private system: StarSystemSpec | null | undefined = undefined;

  // Break-ups: one record per slot, all preallocated.
  private readonly bId: Array<string | null> = new Array<string | null>(MAX_BREAKUPS).fill(null);
  private readonly bT0 = new Float64Array(MAX_BREAKUPS);
  private readonly bTAnchor = new Float64Array(MAX_BREAKUPS);
  private readonly bAnchor = new Float64Array(MAX_BREAKUPS * 3);
  private readonly bVel = new Float64Array(MAX_BREAKUPS * 3);
  private readonly bRadius = new Float64Array(MAX_BREAKUPS);
  private readonly bSurface = new Float32Array(MAX_BREAKUPS * 5);
  private readonly pieceData = new Float64Array(MAX_BREAKUPS * PIECES * PIECE_STRIDE);
  /** Bounding radius of the piece geometry, so a piece's extent is radius × size. */
  private readonly pieceRadius: number;
  private readonly pieceSurface: InstancedBufferAttribute;
  private readonly pieceMetal: InstancedBufferAttribute;
  private readonly pieceFade: InstancedBufferAttribute;
  private readonly pieceSeed: InstancedBufferAttribute;
  private readonly pieceRange = { start: 0, count: 0 };
  private readonly pieceRange4 = { start: 0, count: 0 };
  private readonly pieceRange16 = { start: 0, count: 0 };
  private readonly offDestroyed: () => void;
  private disposed = false;
  /** The break-up program has been handed to the renderer to compile. */
  private warmed = false;

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
    // The same light (the uniform objects are shared), fragments' own path.
    this.pieceMaterial = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.material.uniforms,
      defines: { BREAKUP: 1 },
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
      const surface = dynamicAttr(g, 'aSurface', 4, MAX_ASTEROID_INSTANCES);
      const metal = dynamicAttr(g, 'aMetal', 1, MAX_ASTEROID_INSTANCES);
      const wear = dynamicAttr(g, 'aWear', 1, MAX_ASTEROID_INSTANCES);
      const seed = dynamicAttr(g, 'aSeed', 1, MAX_ASTEROID_INSTANCES);
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
      this.wears.push(wear);
      this.seeds.push(seed);
      this.matrixRanges.push({ start: 0, count: 0 });
      this.surfaceRanges.push({ start: 0, count: 0 });
      this.metalRanges.push({ start: 0, count: 0 });
      this.seedRanges.push({ start: 0, count: 0 });
      this.wearRanges.push({ start: 0, count: 0 });
      this.slotIds.push(new Array<string | null>(MAX_ASTEROID_INSTANCES).fill(null));
      this.slotVel.push(new Float64Array(MAX_ASTEROID_INSTANCES * 3));
      this.slotVelT.push(new Float64Array(MAX_ASTEROID_INSTANCES).fill(Number.NaN));
      meshes.push(mesh);
      this.root.add(mesh);
    }
    this.meshes = meshes;

    // The break-up: one fragment shape, created once (a mesh made at the
    // event would draw a uuid from Math.random and allocate mid-game).
    const piece = asteroidShape(PIECE_SHAPE_SEED);
    const pg = new BufferGeometry();
    pg.setAttribute('position', new BufferAttribute(piece.positions, 3));
    pg.setAttribute('normal', new BufferAttribute(piece.normals, 3));
    pg.setIndex(new BufferAttribute(piece.index, 1));
    pg.computeBoundingSphere();
    this.pieceRadius = pg.boundingSphere!.radius;
    const pieceCap = MAX_BREAKUPS * PIECES;
    this.pieceSurface = dynamicAttr(pg, 'aSurface', 4, pieceCap);
    this.pieceMetal = dynamicAttr(pg, 'aMetal', 1, pieceCap);
    this.pieceFade = dynamicAttr(pg, 'aFade', 1, pieceCap);
    this.pieceSeed = dynamicAttr(pg, 'aSeed', 1, pieceCap);
    const breakup = new InstancedMesh(pg, this.pieceMaterial, pieceCap);
    breakup.instanceMatrix.setUsage(DynamicDrawUsage);
    breakup.count = 0;
    breakup.visible = false;
    breakup.name = 'asteroids-breakup';
    breakup.frustumCulled = false;
    this.geometries.push(pg);
    this.breakup = breakup;
    this.root.add(breakup);

    this.root.name = 'asteroids';
    this.root.visible = false;
    this.offDestroyed = bus.on('asteroid:destroyed', this.onDestroyed);
  }

  init(ctx: EngineContext): void {
    ctx.scene.add(this.root);
  }

  /**
   * The break-up's program is its own (BREAKUP define) and `breakup` is hidden
   * until an event, so the engine's prewarm never sees it. Compile it once,
   * the first time a belt comes into view: `compile` walks all descendants,
   * hidden or not, so handing it the mesh builds the program with the scene's
   * own state. No draw call, no per-frame cost. A missing renderer (tests) is
   * tolerated; a failure only means the first break-up compiles lazily.
   */
  private warmBreakup(ctx: EngineContext): void {
    this.warmed = true;
    const r = ctx.renderer as Partial<Pick<EngineContext['renderer'], 'compile' | 'compileAsync'>> | undefined;
    try {
      if (typeof r?.compileAsync === 'function') {
        r.compileAsync(this.breakup, ctx.camera, ctx.scene).catch(() => {});
      } else if (typeof r?.compile === 'function') {
        r.compile(this.breakup, ctx.camera, ctx.scene);
      }
    } catch {
      /* compiles lazily at the first break-up */
    }
  }

  onModeChange(_from: Mode, to: Mode): void {
    // [v4-resources] Not on the resources screen: flight paused, the field stays
    // in view behind the sheet (it sleeps there) and does not pop back on close.
    if (!ACTIVE.includes(to) && !FLIGHT_PAUSED.includes(to)) this.root.visible = false;
  }

  /** Which rocks, and which slot each one takes. */
  update(_dt: number, ctx: EngineContext): void {
    // The ranges from the last frame were read by its render; this frame
    // starts empty and gathers exactly the slots it changes (final review, a).
    for (let v = 0; v < ASTEROID_VARIANTS; v++) {
      this.surfaceRanges[v]!.count = 0;
      this.metalRanges[v]!.count = 0;
      this.seedRanges[v]!.count = 0;
      this.wearRanges[v]!.count = 0;
    }
    // A review shot owns the scene (same rule as Traffic).
    if (shotOwnsScene()) {
      this.kept = 0;
      this.root.visible = false;
      return;
    }
    // Another system (or none): the break-ups belonged to the old one.
    const sys = this.universe.system;
    if (sys !== this.system) {
      this.system = sys;
      this.dropBreakups();
    }
    const t = this.orbitNow();
    this.keptT = t;
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
      const fresh = ids[slot] !== id;
      if (fresh) {
        // A new occupant: its tint and seed go up; an unchanged slot uploads nothing.
        ids[slot] = id;
        writeSurface(spec, this.surfaces[v]!.array as Float32Array, this.metals[v]!.array as Float32Array, slot);
        (this.seeds[v]!.array as Float32Array)[slot] = seedFraction(seed);
        grow(this.surfaceRanges[v]!, slot * 4, 4);
        grow(this.metalRanges[v]!, slot, 1);
        grow(this.seedRanges[v]!, slot, 1);
      }
      // The wear look, uploaded only when it (or the occupant) changed.
      const look = Math.fround(wearVisual(this.belt.wear(id)));
      const wear = this.wears[v]!.array as Float32Array;
      if (fresh || wear[slot] !== look) {
        wear[slot] = look;
        grow(this.wearRanges[v]!, slot, 1);
      }
      // Its velocity, for a break-up to ride with the field; re-read now and then.
      const velT = this.slotVelT[v]!;
      if (fresh || !(Math.abs(t - velT[slot]!) < VEL_REFRESH_S)) {
        const vel = this.slotVel[v]!;
        const ok = this.belt.asteroidVelocity(id, this.w);
        vel[slot * 3] = ok ? this.w.x : 0;
        vel[slot * 3 + 1] = ok ? this.w.y : 0;
        vel[slot * 3 + 2] = ok ? this.w.z : 0;
        velT[slot] = t;
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
      if (this.surfaceRanges[v]!.count > 0) {
        upload(this.surfaces[v]!, this.surfaceRanges[v]!);
        upload(this.metals[v]!, this.metalRanges[v]!);
        upload(this.seeds[v]!, this.seedRanges[v]!);
      }
      if (this.wearRanges[v]!.count > 0) upload(this.wears[v]!, this.wearRanges[v]!);
    }

    // Break-ups run out on the orbit clock (a frozen clock freezes them).
    const pieces = this.expireBreakups(t);
    this.breakup.visible = pieces > 0;
    this.root.visible = total > 0 || pieces > 0;
    if (!this.root.visible) return;
    if (!this.warmed) this.warmBreakup(ctx);

    // The key light at the ship: every rock within 400 km sees the same star.
    const u = this.material.uniforms;
    const d = Math.hypot(ship.x, ship.y, ship.z);
    if (d > 0) u.uSunDir!.value.set(-ship.x / d, -ship.y / d, -ship.z / d);
    const level = keyLightAt(this.universe.system?.stars[0]?.luminosity ?? 1, d);
    u.uSunColor!.value.set(SUN_BASE[0] * level, SUN_BASE[1] * level, SUN_BASE[2] * level);
  }

  /** After every camera writer: matrices relative to the camera, root at the camera. */
  lateUpdate(_dt: number, ctx: EngineContext): void {
    if (!this.root.visible) return;

    ctx.camera.getWorldPosition(this.cam);
    this.root.position.copy(this.cam);
    // Camera in world space, float64.
    const off = ctx.origin.offset;
    const cx = off.x + this.cam.x;
    const cy = off.y + this.cam.y;
    const cz = off.z + this.cam.z;

    const t = this.orbitNow();
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

    this.writePieces(t, cx, cy, cz);
  }

  dispose(): void {
    this.disposed = true;
    this.offDestroyed();
    this.dropBreakups();
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const mesh of this.meshes) mesh.dispose();
    this.breakup.dispose();
    this.material.dispose();
    this.pieceMaterial.dispose();
  }

  /**
   * REVIEW ONLY (`registerAsteroidShots`): draw exactly one rock — whole at
   * its wear, or `breakupAge` seconds into its break-up — at a camera-
   * relative position, through the same slots, attributes and piece layout
   * the game uses. The module is asleep in review mode, so nothing else
   * writes these meshes while a shot holds them. `null` clears the stage.
   */
  stageForReview(rock: AsteroidReviewRock | null, ctx: EngineContext): void {
    this.dropBreakups();
    for (const mesh of this.meshes) mesh.count = 0;
    for (const ids of this.slotIds) ids.fill(null);
    this.kept = 0;
    if (!rock) {
      this.root.visible = false;
      return;
    }
    ctx.camera.getWorldPosition(this.cam);
    this.root.position.copy(this.cam);
    this.root.visible = true;
    const u = this.material.uniforms;
    u.uSunDir!.value.set(rock.sun.x, rock.sun.y, rock.sun.z).normalize();
    u.uSunColor!.value.set(SUN_BASE[0] * rock.light, SUN_BASE[1] * rock.light, SUN_BASE[2] * rock.light);
    const seed = rock.seed >>> 0;
    const spec: AsteroidSpec = { id: 'review', offsetKm: [0, 0, 0], radiusKm: rock.radiusKm, seed, composition: rock.composition };
    if (rock.breakupAge === null) {
      const v = seed % ASTEROID_VARIANTS;
      writeSurface(spec, this.surfaces[v]!.array as Float32Array, this.metals[v]!.array as Float32Array, 0);
      (this.seeds[v]!.array as Float32Array)[0] = seedFraction(seed);
      (this.wears[v]!.array as Float32Array)[0] = wearVisual(rock.wear);
      for (const a of [this.surfaces[v]!, this.metals[v]!, this.seeds[v]!, this.wears[v]!]) {
        a.clearUpdateRanges();
        a.needsUpdate = true;
      }
      spinOf(seed, rock.t, this.axis, this.q);
      this.p.set(rock.at.x, rock.at.y, rock.at.z);
      this.s.setScalar(rock.radiusKm);
      this.m.compose(this.p, this.q, this.s);
      const mesh = this.meshes[v]!;
      mesh.count = 1;
      mesh.setMatrixAt(0, this.m);
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.needsUpdate = true;
      return;
    }
    // A break-up anchored so that, `breakupAge` seconds on, the rock's centre is `at`.
    const off = ctx.origin.offset;
    this.startBreakup(0, 'review', spec, off.x + this.cam.x + rock.at.x, off.y + this.cam.y + rock.at.y, off.z + this.cam.z + rock.at.z, 0, 0, 0, rock.t - rock.breakupAge, rock.t - rock.breakupAge);
    this.breakup.visible = true;
    this.writePieces(rock.t, off.x + this.cam.x, off.y + this.cam.y, off.z + this.cam.z);
  }

  // -------------------------------------------------------------------------

  /** A rock was mined empty: break up the one this renderer drew last update. */
  private readonly onDestroyed = (e: { asteroidId: string }): void => {
    if (this.disposed) return;
    const id = e.asteroidId;
    // Where it was drawn: nowhere means no break-up (beyond the draw distance,
    // unknown, or not yet looked at).
    let k = 0;
    while (k < this.kept && this.near[this.keptIndex[k]!] !== id) k++;
    if (k >= this.kept) return;
    if (!this.belt.isDestroyed(id)) return;
    let free = -1;
    for (let b = 0; b < MAX_BREAKUPS; b++) {
      if (this.bId[b] === id) return; // already breaking up
      if (free < 0 && this.bId[b] === null) free = b;
    }
    // The rock is gone either way; past the cap it just goes without pieces.
    const i = this.keptIndex[k]!;
    const v = this.keptVariant[k]!;
    const slot = this.keptSlot[k]!;
    this.keptRadius[k] = 0; // not drawn whole in the lateUpdate of this frame
    if (free < 0) return;
    const spec = this.belt.asteroidSpecRaw(id);
    if (!spec) return;
    const vel = this.slotVel[v]!;
    this.startBreakup(
      free,
      id,
      spec,
      this.world[i * 3]!,
      this.world[i * 3 + 1]!,
      this.world[i * 3 + 2]!,
      vel[slot * 3]!,
      vel[slot * 3 + 1]!,
      vel[slot * 3 + 2]!,
      this.keptT,
      this.orbitNow(),
    );
    this.breakup.visible = true;
    this.root.visible = true;
  };

  /** Fill break-up slot `b`: anchor, velocity, surface, and the seeded piece layout. */
  private startBreakup(
    b: number,
    id: string,
    spec: AsteroidSpec,
    ax: number,
    ay: number,
    az: number,
    vx: number,
    vy: number,
    vz: number,
    tAnchor: number,
    t0: number,
  ): void {
    this.bId[b] = id;
    this.bT0[b] = t0;
    this.bTAnchor[b] = tAnchor;
    this.bAnchor[b * 3] = ax;
    this.bAnchor[b * 3 + 1] = ay;
    this.bAnchor[b * 3 + 2] = az;
    this.bVel[b * 3] = vx;
    this.bVel[b * 3 + 1] = vy;
    this.bVel[b * 3 + 2] = vz;
    this.bRadius[b] = spec.radiusKm;
    const s = asteroidSurface(spec.composition); // at the event, never per frame
    const sf = this.bSurface;
    sf[b * 5] = s.albedo[0];
    sf[b * 5 + 1] = s.albedo[1];
    sf[b * 5 + 2] = s.albedo[2];
    sf[b * 5 + 3] = s.spec;
    sf[b * 5 + 4] = s.metalness;
    layoutPieces(spec.seed >>> 0, this.pieceData, b * PIECES * PIECE_STRIDE);
  }

  /** End the break-ups whose time is up (or whose clock ran backwards); returns the pieces left. */
  private expireBreakups(t: number): number {
    let pieces = 0;
    for (let b = 0; b < MAX_BREAKUPS; b++) {
      if (this.bId[b] === null) continue;
      const age = t - this.bT0[b]!;
      if (age >= BREAKUP_S || age < 0) this.bId[b] = null;
      else pieces += PIECES;
    }
    if (pieces === 0) this.breakup.count = 0;
    return pieces;
  }

  private dropBreakups(): void {
    this.bId.fill(null);
    this.breakup.count = 0;
    this.breakup.visible = false;
  }

  /** Every running break-up's pieces, packed from instance 0, camera-relative. */
  private writePieces(t: number, cx: number, cy: number, cz: number): void {
    const mesh = this.breakup;
    let n = 0;
    const surf = this.pieceSurface.array as Float32Array;
    const metal = this.pieceMetal.array as Float32Array;
    const fade = this.pieceFade.array as Float32Array;
    const pseed = this.pieceSeed.array as Float32Array;
    const pd = this.pieceData;
    for (let b = 0; b < MAX_BREAKUPS; b++) {
      if (this.bId[b] === null) continue;
      const age = Math.max(0, t - this.bT0[b]!);
      const u = Math.min(1, age / BREAKUP_S);
      // Dark first, then smaller: the pieces sink into the black, not pop.
      const bright = 1 - smoothstep(0.25, 1, u);
      const shrink = 1 - 0.55 * smoothstep(0.5, 1, u);
      const r = this.bRadius[b]!;
      // The rock's centre now: its last position, carried on with the field.
      const since = t - this.bTAnchor[b]!;
      const ox = this.bAnchor[b * 3]! + this.bVel[b * 3]! * since - cx;
      const oy = this.bAnchor[b * 3 + 1]! + this.bVel[b * 3 + 1]! * since - cy;
      const oz = this.bAnchor[b * 3 + 2]! + this.bVel[b * 3 + 2]! * since - cz;
      for (let j = 0; j < PIECES; j++) {
        const at = (b * PIECES + j) * PIECE_STRIDE;
        this.p.set(
          ox + r * (pd[at]! + pd[at + 3]! * age),
          oy + r * (pd[at + 1]! + pd[at + 4]! * age),
          oz + r * (pd[at + 2]! + pd[at + 5]! * age),
        );
        this.axis.set(pd[at + 7]!, pd[at + 8]!, pd[at + 9]!);
        this.q.setFromAxisAngle(this.axis, pd[at + 11]! + pd[at + 10]! * age);
        this.s.setScalar((r * pd[at + 6]! * shrink) / this.pieceRadius);
        this.m.compose(this.p, this.q, this.s);
        mesh.setMatrixAt(n, this.m);
        surf[n * 4] = this.bSurface[b * 5]!;
        surf[n * 4 + 1] = this.bSurface[b * 5 + 1]!;
        surf[n * 4 + 2] = this.bSurface[b * 5 + 2]!;
        surf[n * 4 + 3] = this.bSurface[b * 5 + 3]!;
        metal[n] = this.bSurface[b * 5 + 4]!;
        fade[n] = bright;
        pseed[n] = pd[at + 12]!;
        n++;
      }
    }
    mesh.count = n;
    if (n === 0) return;
    this.pieceRange16.count = n * 16;
    this.pieceRange4.count = n * 4;
    this.pieceRange.count = n;
    upload(mesh.instanceMatrix, this.pieceRange16);
    upload(this.pieceSurface, this.pieceRange4);
    upload(this.pieceMetal, this.pieceRange);
    upload(this.pieceFade, this.pieceRange);
    upload(this.pieceSeed, this.pieceRange);
  }

  private orbitNow(): number {
    const t = this.universe.orbitSeconds;
    return Number.isFinite(t) ? t : 0;
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

/** A per-instance attribute of `count` items, dynamic, added to `g`. */
function dynamicAttr(g: BufferGeometry, name: string, itemSize: number, count: number): InstancedBufferAttribute {
  const a = new InstancedBufferAttribute(new Float32Array(count * itemSize), itemSize);
  a.setUsage(DynamicDrawUsage);
  g.setAttribute(name, a);
  return a;
}

/** Flag `attr` for upload of exactly `range`. */
function upload(attr: { updateRanges: Array<{ start: number; count: number }>; needsUpdate: boolean }, range: { start: number; count: number }): void {
  attr.updateRanges.length = 0;
  attr.updateRanges.push(range);
  attr.needsUpdate = true;
}

/** 32-bit integer hash → [0, 1). */
function hash01(seed: number, a: number, b: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(a + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(b + 0x2545f491, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** The seed as a fraction for the shader's scar lattice (float32-exact: 24 bits). */
function seedFraction(seed: number): number {
  return (Math.imul(seed ^ 0x5bd1e995, 0x01000193) >>> 8) / 16777216;
}

function smoothstep(a: number, b: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

/**
 * The pieces of a break-up from the seed, into `out` at `at` (PIECES records
 * of PIECE_STRIDE): start offset and drift (radii, radii/s), size (radii),
 * tumble axis, rate and phase, and the seed of its scars. The mean offset and drift are taken out, so
 * the cloud stays centred on where the rock would be. No allocation.
 */
function layoutPieces(seed: number, out: Float64Array, at: number): void {
  let mox = 0;
  let moy = 0;
  let moz = 0;
  let mvx = 0;
  let mvy = 0;
  let mvz = 0;
  for (let j = 0; j < PIECES; j++) {
    const o = at + j * PIECE_STRIDE;
    // A direction on the sphere.
    const z = hash01(seed, j, 0) * 2 - 1;
    const phi = hash01(seed, j, 1) * Math.PI * 2;
    const rr = Math.sqrt(1 - z * z);
    const dx = rr * Math.cos(phi);
    const dy = rr * Math.sin(phi);
    const dz = z;
    const size = j < BIG_PIECES ? 0.34 + 0.12 * hash01(seed, j, 2) : 0.1 + 0.15 * hash01(seed, j, 2);
    const start = 0.2 + 0.3 * hash01(seed, j, 3);
    // Small pieces fly faster: about 0.3 … 1.5 radii a second.
    const speed = (0.22 + 0.25 * hash01(seed, j, 4)) / Math.sqrt(size);
    out[o] = dx * start;
    out[o + 1] = dy * start;
    out[o + 2] = dz * start;
    out[o + 3] = dx * speed;
    out[o + 4] = dy * speed;
    out[o + 5] = dz * speed;
    out[o + 6] = size;
    const az = hash01(seed, j, 5) * 2 - 1;
    const aphi = hash01(seed, j, 6) * Math.PI * 2;
    const ar = Math.sqrt(1 - az * az);
    out[o + 7] = ar * Math.cos(aphi);
    out[o + 8] = ar * Math.sin(aphi);
    out[o + 9] = az;
    out[o + 10] = (0.4 + 1.4 * hash01(seed, j, 7)) * (hash01(seed, j, 8) < 0.5 ? -1 : 1);
    out[o + 11] = hash01(seed, j, 9) * Math.PI * 2;
    out[o + 12] = hash01(seed, j, 10);
    mox += out[o]!;
    moy += out[o + 1]!;
    moz += out[o + 2]!;
    mvx += out[o + 3]!;
    mvy += out[o + 4]!;
    mvz += out[o + 5]!;
  }
  for (let j = 0; j < PIECES; j++) {
    const o = at + j * PIECE_STRIDE;
    out[o] = out[o]! - mox / PIECES;
    out[o + 1] = out[o + 1]! - moy / PIECES;
    out[o + 2] = out[o + 2]! - moz / PIECES;
    out[o + 3] = out[o + 3]! - mvx / PIECES;
    out[o + 4] = out[o + 4]! - mvy / PIECES;
    out[o + 5] = out[o + 5]! - mvz / PIECES;
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

// ---------------------------------------------------------------------------
// Review shots (plan 5, Task 5): one rock, close up, at four wears and mid
// break-up. The module sleeps in review mode, so each shot stages the rock
// through `stageForReview` and nothing else touches the meshes meanwhile.
// ---------------------------------------------------------------------------

let shotsRegistered = false;

/** The one rock every wear shot shows: a silicate rock with some ice and metal. */
const REVIEW_SEED = 0x51d3a;
const REVIEW_RADIUS_KM = 0.3;
const REVIEW_COMPOSITION: Readonly<Record<Resource, number>> = { ice: 1.2e7, metal: 4e6, silicate: 4.4e7, rare: 0 };
/** Camera-relative position: 1.25 km ahead of a camera that looks down −z. */
const REVIEW_AT = { x: 0, y: 0, z: -1.25 };
/** A raking key from the upper left, a little behind the camera. */
const REVIEW_SUN = { x: -0.72, y: 0.42, z: 0.55 };
/** Where the camera stands (render km): away from every other shot's fixture. */
const REVIEW_CAM = new Vector3(4_000, 0, 0);

export function registerAsteroidShots(asteroids: Asteroids): void {
  if (shotsRegistered) return;
  shotsRegistered = true;
  const light = keyLightAt(1, 2.6 * AU);

  const stage = (ctx: EngineContext, wear: number, breakupAge: number | null): void => {
    ctx.camera.fov = 30;
    ctx.camera.updateProjectionMatrix();
    ctx.camera.position.copy(REVIEW_CAM);
    ctx.camera.quaternion.identity();
    ctx.camera.updateMatrixWorld(true);
    asteroids.stageForReview(
      {
        seed: REVIEW_SEED,
        radiusKm: REVIEW_RADIUS_KM,
        composition: REVIEW_COMPOSITION,
        wear,
        at: REVIEW_AT,
        t: 1_000,
        breakupAge,
        sun: REVIEW_SUN,
        light,
      },
      ctx,
    );
  };
  const teardown = (ctx: EngineContext): void => asteroids.stageForReview(null, ctx);

  const wears: ReadonlyArray<readonly [string, number, string]> = [
    ['asteroid-wear-0', 0, 'untouched: exactly the plan-2 look, no scars'],
    ['asteroid-wear-3', 0.03, 'the first bites (about 2 000 kg of 65 000): a few small dark pits must already read'],
    ['asteroid-wear-40', 0.4, 'well worked: many pits, wider, the rock dulled'],
    ['asteroid-wear-95', 0.95, 'nearly empty: pitted all over, dark, the outline eaten in'],
  ];
  for (const [name, wear, what] of wears) {
    registerShot({
      name,
      description: `The same rock (seed ${REVIEW_SEED}, 0.3 km) close up under a raking key at ${Math.round(wear * 100)} % wear — ${what}.`,
      apply: (ctx) => stage(ctx, wear, null),
      teardown,
    });
  }
  registerShot({
    name: 'asteroid-breakup',
    description:
      'The same rock mined empty, 40 % through its break-up: rock fragments with its own surface drifting apart, tumbling, already dimming towards black. No glow.',
    apply: (ctx) => stage(ctx, 1, BREAKUP_S * 0.4),
    teardown,
  });
}
