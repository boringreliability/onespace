/**
 * Showroom — the isolated review mode for the procedural ship engine.
 *
 * A ship that has only ever been seen flying past a planet has not been
 * reviewed. It has been glimpsed. Every criterion in BRIEF §8 — silhouette,
 * readable role, form hierarchy, scale, wear that tells a story, DNA across
 * seeds — is a judgement about the hull *on its own*, under lighting the critic
 * chose, at a distance the critic chose. That is what this module is: a black
 * room with a turntable, a key light, and a human standing next to the hull.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A SEPARATE MODULE AND NOT A FLAG ON THE UNIVERSE
 *
 * The showroom never runs while the game is flying. `update()` returns on the
 * first line unless `enter()` has been called, and `enter()` is only ever
 * called from a review shot's `apply()`. A review fixture that keeps ticking
 * during play is a fixture that costs frames, holds GPU memory and eventually
 * gets drawn by accident — the `Gallery` in `registry.ts` learned that lesson
 * and hides itself for the same reason.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS AND WHAT IT BORROWS
 *
 * It owns: the review scene graph, the deterministic ship set, the camera
 * rigs, the lighting presets, the scale references, and ONE `ShaderMaterial`
 * used for silhouette overrides and for the placeholder blockout.
 *
 * It borrows: the ship mesh assembly, through the `ShipVisual` interface and
 * the `ShipVisualFactory` below. The renderer is written by other hands
 * (`render/ships/*`). Until one is registered, the showroom draws a *massing
 * model* built from the blueprint's own volumes so the harness, the shots and
 * the manifest can be exercised end to end. The blockout disappears the
 * instant a real factory is installed.
 */
import {
  Box3,
  BufferGeometry,
  Color,
  Euler,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Material,
  Mesh,
  NormalBlending,
  Object3D,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';

import type { EngineContext, GameModule } from '@/core/Engine';
import { config, type QualitySettings, type QualityTier } from '@/core/Config';
import { MutableViewState, type ViewState } from '@/render/ViewState';

import { generateShip, type ShipParams } from '@/gen/ships/blueprint';
import {
  CONTAINER_LENGTH_KM,
  DECK_HEIGHT_KM,
  HUMAN_HEIGHT_KM,
  frameRight,
  frameToShip,
  type Aabb,
  type EnginePod,
  type Frame,
  type PrimaryVolume,
  type ShipBlueprint,
  type ShipModule,
  type ShipRole,
} from '@/gen/ships/types';

// ===========================================================================
// The contract with the ship renderer
//
// These three declarations are the ONLY coupling between the review harness
// and `render/ships/*`. They are stated here, rather than imported, because
// the showroom had to be written before the renderer existed and must not
// break when it lands. The integrator wires them together with one call to
// `setShipVisualFactory`.
// ===========================================================================

/**
 * What the drive is doing this frame.
 *
 * Field-for-field identical to `ShipState` in `src/ship/Ship.ts`, deliberately:
 * the two are structurally assignable, so a renderer can accept either and the
 * player's hero ship and a generated hull can be driven by the same code.
 * `ShipState` is a good little contract (ANALYSIS §4.3) and it survives here
 * under a name that does not collide with it.
 */
export interface ShipDriveState {
  /** Main engine demand, 0..1. */
  readonly throttle: number;
  /** Overdrive on top of throttle, 0..1. Shifts the plume white-hot. */
  readonly boost: number;
  /** Re-entry heating, 0..1. Drives leading-edge glow and the plasma wake. */
  readonly heating: number;
  /** Commanded translation in SHIP-LOCAL space, roughly -1..1 per axis. */
  readonly rcs: Vector3;
}

/**
 * One assembled, drivable ship mesh.
 *
 * `update` follows ARCHITECTURE §10: the renderer is blind and receives its
 * light, its camera and its screen-space metrics in the `ViewState`, expressed
 * in its own local space. `state` rides alongside rather than inside it,
 * because how hard the engines are burning is not a property of the view.
 */
export interface ShipVisual {
  readonly object3d: Object3D;
  update(dt: number, ctx: EngineContext, view: ViewState, state: ShipDriveState): void;
  /** 0 = finest, 3 = impostor. */
  setLod(level: 0 | 1 | 2 | 3): void;
  dispose(): void;
  /**
   * OPTIONAL, and a gap in the published contract rather than a nicety.
   *
   * `ViewState` carries a sun direction and a sun colour and nothing else, but
   * the reference hull shader takes `uFill` — planetshine, not ambient — and
   * ANALYSIS §4.1 lists it as required. Until `ViewState` grows a fill term,
   * a renderer that wants one exposes it here and the showroom drives it. A
   * renderer that does not implement this still satisfies the interface, and
   * `ship-planetshine` will simply have nothing to show.
   */
  setFillLight?(color: Color): void;
}

/**
 * How the showroom turns a blueprint into a mesh.
 *
 * The integrator calls `setShipVisualFactory((bp, q) => new ShipMesh(bp, q))`
 * once, at registration time, after the ship renderer is constructible. Every
 * cached visual is rebuilt on the next `configure` when the factory changes,
 * so this can be called before or after the shots are registered.
 */
export type ShipVisualFactory = (blueprint: ShipBlueprint, quality: QualitySettings) => ShipVisual;

let shipVisualFactory: ShipVisualFactory | null = null;
/** Generation counter, so cached blockouts are discarded when a real mesh arrives. */
let factoryGeneration = 0;

export function setShipVisualFactory(factory: ShipVisualFactory | null): void {
  shipVisualFactory = factory;
  factoryGeneration++;
}

export function hasShipVisualFactory(): boolean {
  return shipVisualFactory !== null;
}

// ===========================================================================
// The one material this file owns
// ===========================================================================

/**
 * Flat matte surface with a rim, used for two jobs.
 *
 * **Silhouette review.** BRIEF §8 asks for the hull to be judged "as a black
 * shape with no materials". Left literally black it is also invisible, so the
 * form is carried by a rim term alone — the outline, and nothing that a
 * surface could hide behind. `uKeyMix` at 0 kills the diffuse term entirely.
 *
 * **The blockout stand-in.** With `uKeyMix` at 1 the same program shades the
 * placeholder massing model. One material, two configurations, one program.
 *
 * Everything is in view space so the shader works unchanged on an
 * `InstancedMesh` — the ship renderer will certainly use them for greebles,
 * and an override material that silently mis-transforms instanced geometry
 * would produce a silhouette shot of a ship that is not the ship.
 *
 * `toneMapped: false` and no `<colorspace_fragment>`: the scene is linear HDR
 * and PostFX owns the grade. `Ship.ts` tone-maps itself and that is the bug
 * ANALYSIS §4.2 tells us not to inherit.
 */
const SILHOUETTE_VERT = /* glsl */ `
precision highp float;
// <common> supplies isPerspectiveMatrix(), which logdepthbuf_vertex calls. The
// engine runs a logarithmic depth buffer; a material without these chunks
// writes linear depth and sorts wrongly against every planet in the game.
#include <common>
#include <logdepthbuf_pars_vertex>

// Per-vertex diffuse reflectance, 0..1. Geometry built by this file supplies
// it; geometry borrowed from the ship renderer (silhouette override) does not,
// and an absent attribute reads 0 — which the fragment stage folds back to 1.
attribute float aAlbedo;

varying vec3 vNormalView;
varying vec3 vEyeDir;
varying float vAlbedo;

void main() {
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>

  vNormalView = transformedNormal;
  vEyeDir = -mvPosition.xyz;
  vAlbedo = aAlbedo;
}
`;

const SILHOUETTE_FRAG = /* glsl */ `
precision highp float;
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3  uSunDirView;
uniform vec3  uFillDirView;
uniform vec3  uKeyColor;
uniform vec3  uFillColor;
uniform vec3  uBaseColor;
uniform vec3  uRimColor;
uniform float uRimPower;
uniform float uKeyMix;

varying vec3 vNormalView;
varying vec3 vEyeDir;
varying float vAlbedo;

void main() {
  #include <logdepthbuf_fragment>

  vec3 N = normalize(vNormalView);
  // The blockout is a shell of quads and the reviewer will see its inside
  // through open caps; a back face with an outward normal reads as a hole.
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(vEyeDir);

  float ndl = max(dot(N, uSunDirView), 0.0);
  float ndf = max(dot(N, uFillDirView), 0.0);

  // Reflectance. uKeyColor is the star with its intensity already folded in
  // — 3.0 for the standard key — so a surface that reflects it at unity is
  // three times over white and blooms. That is exactly what the freight
  // container did: it was the brightest object in every scale frame and the
  // one thing in it that could not be obeying the scene's light. Anything
  // without the attribute (borrowed ship geometry under the silhouette
  // override, where uKeyMix is 0 anyway) falls back to unity.
  float albedo = vAlbedo <= 0.0 ? 1.0 : vAlbedo;

  // The rim is gated by the key. A rim that runs the whole way round an
  // outline is a glow, and a glow says nothing about which way the form turns
  // — which is the single thing a silhouette shot exists to show.
  float wrap = smoothstep(-0.55, 0.35, dot(N, uSunDirView));
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), uRimPower) * (0.14 + 0.86 * wrap);

  vec3 col = uBaseColor
           + uKeyColor * (ndl * uKeyMix * albedo)
           + uFillColor * (0.18 + 0.82 * ndf) * uKeyMix * albedo
           + uRimColor * rim;

  gl_FragColor = vec4(col, 1.0);
}
`;

function makeSilhouetteMaterial(): ShaderMaterial {
  const m = new ShaderMaterial({
    vertexShader: SILHOUETTE_VERT,
    fragmentShader: SILHOUETTE_FRAG,
    uniforms: {
      uSunDirView: { value: new Vector3(0, 0, 1) },
      uFillDirView: { value: new Vector3(0, -1, 0) },
      uKeyColor: { value: new Color(0, 0, 0) },
      uFillColor: { value: new Color(0, 0, 0) },
      // Never exactly zero: PostFX meters a tap below 2.5e-3 scene-linear as
      // void and drops it to 2% weight, which would make the auto-exposure
      // open up and turn a silhouette frame into grey soup.
      uBaseColor: { value: new Color(0.004, 0.0045, 0.006) },
      uRimColor: { value: new Color(0.34, 0.38, 0.46) },
      uRimPower: { value: 2.6 },
      uKeyMix: { value: 1 },
    },
    toneMapped: false,
  });
  // The ship renderer's geometry has no `aAlbedo`, and an unbound attribute
  // reads whatever the generic vertex attribute was last left at. Pin it to
  // full reflectance so borrowing this material for the silhouette override
  // can never darken a hull by accident.
  (m.defaultAttributeValues as Record<string, number[]>).aAlbedo = [1];
  return m;
}

// ===========================================================================
// The blockout stand-in
// ===========================================================================

/** Corner signs of a rectangular ring, wound so that side quads face outward. */
const RING_CORNERS: readonly (readonly [number, number])[] = [
  [1, 1],
  [1, -1],
  [-1, -1],
  [-1, 1],
];

/** One cross-section of a prism, in its frame's local axes. Kilometres. */
interface PrismRing {
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly along: number;
}

/**
 * Accumulates faceted triangles into one non-indexed buffer.
 *
 * Non-indexed on purpose: `computeVertexNormals()` then produces a genuine
 * per-face normal because no vertex is shared, so the massing model comes out
 * hard-edged with no flat-shading flag — the same trick `HullBuilder` in
 * `Ship.ts` gets for free by pushing four fresh vertices per box face.
 */
class BlockoutBuilder {
  private readonly pos: number[] = [];
  private readonly alb: number[] = [];
  private albedo = 1;
  private readonly a: [number, number, number] = [0, 0, 0];
  private readonly b: [number, number, number] = [0, 0, 0];
  private readonly c: [number, number, number] = [0, 0, 0];

  /** Diffuse reflectance applied to every triangle pushed from here on. */
  setAlbedo(v: number): void {
    this.albedo = v;
  }

  tri(p: readonly number[], q: readonly number[], r: readonly number[]): void {
    this.pos.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
    this.alb.push(this.albedo, this.albedo, this.albedo);
  }

  /** A closed prism through `rings`, capped at both ends. */
  prism(frame: Frame, rings: readonly PrismRing[]): void {
    if (rings.length < 2) return;
    const corner = (ring: PrismRing, k: number, out: [number, number, number]): number[] => {
      const [sx, sy] = RING_CORNERS[k]!;
      _local[0] = ring.offsetX + sx * ring.halfWidth;
      _local[1] = ring.offsetY + sy * ring.halfHeight;
      _local[2] = ring.along;
      return frameToShip(frame, _local, out);
    };

    for (let i = 0; i < rings.length - 1; i++) {
      const ra = rings[i]!;
      const rb = rings[i + 1]!;
      for (let k = 0; k < 4; k++) {
        const k1 = (k + 1) & 3;
        corner(ra, k, this.a);
        corner(rb, k, this.b);
        corner(rb, k1, this.c);
        this.tri(this.a, this.b, this.c);
        corner(ra, k, this.a);
        corner(rb, k1, this.b);
        corner(ra, k1, this.c);
        this.tri(this.a, this.b, this.c);
      }
    }

    const first = rings[0]!;
    const last = rings[rings.length - 1]!;
    for (const [i0, i1, i2] of [
      [0, 1, 2],
      [0, 2, 3],
    ] as const) {
      corner(first, i0, this.a);
      corner(first, i1, this.b);
      corner(first, i2, this.c);
      this.tri(this.a, this.b, this.c);
    }
    for (const [i0, i1, i2] of [
      [0, 2, 1],
      [0, 3, 2],
    ] as const) {
      corner(last, i0, this.a);
      corner(last, i1, this.b);
      corner(last, i2, this.c);
      this.tri(this.a, this.b, this.c);
    }
  }

  get triangleCount(): number {
    return this.pos.length / 9;
  }

  toGeometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aAlbedo', new Float32BufferAttribute(this.alb, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * One axis-aligned box in a frame's local space, centred on `(cx, cy, cz)`.
 *
 * The prism primitive is a swept cross-section and expresses a box awkwardly;
 * every piece of hardware on the scale reference is a box, so it gets a name.
 */
function boxIn(
  b: BlockoutBuilder,
  frame: Frame,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
): void {
  b.prism(frame, [
    { halfWidth: hx, halfHeight: hy, offsetX: cx, offsetY: cy, along: cz - hz },
    { halfWidth: hx, halfHeight: hy, offsetX: cx, offsetY: cy, along: cz + hz },
  ]);
}

const _local: [number, number, number] = [0, 0, 0];

/** Run length of a volume, km. An arc is measured along its own arclength. */
function runLength(v: PrimaryVolume): number {
  return v.path.kind === 'linear' ? v.path.length : Math.abs(v.path.radius * v.path.sweep);
}

/**
 * A placeholder `ShipVisual`: the blueprint's masses as faceted boxes.
 *
 * This is a *massing model*, not a ship, and it is here for exactly one
 * reason — so that the shot list, the capture harness and the manifest can be
 * built, run and debugged before `render/ships/*` exists. It reads the same
 * blueprint the real renderer will read, so a shot that frames a nozzle here
 * frames the same nozzle there.
 *
 * It deliberately does NOT try to be good. A curved section is drawn as a
 * rectangle, an arc path is drawn straight, and greebles do not exist. If a
 * critic is ever shown one of these frames, the answer is "the renderer is not
 * wired up", not "the ship is boxy".
 */
class BlockoutVisual implements ShipVisual {
  readonly object3d = new Group();
  readonly triangles: number;
  private readonly geometry: BufferGeometry;
  private readonly mesh: Mesh;

  constructor(bp: ShipBlueprint, material: Material) {
    const b = new BlockoutBuilder();

    for (const v of bp.primaryVolumes) {
      const len = runLength(v);
      const rings: PrismRing[] = v.stations.map((s) => ({
        halfWidth: Math.max(s.halfWidth, 1e-6),
        halfHeight: Math.max(s.halfHeight, 1e-6),
        offsetX: s.offset[0],
        offsetY: s.offset[1],
        along: s.t * len,
      }));
      b.prism(v.frame, rings);
    }

    for (const m of bp.modules) {
      if (!m.present) continue;
      // A module that carries its own volume is already drawn above; drawing
      // it twice puts a box inside a box and doubles the triangle count.
      if (m.volumeId !== null) continue;
      b.prism(m.frame, moduleRings(m));
    }

    for (const e of bp.engines) {
      for (let i = 0; i < Math.max(1, e.nozzle.count); i++) b.prism(e.frame, nozzleRings(e, i));
    }

    this.geometry = b.toGeometry();
    this.triangles = b.triangleCount;
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.name = `blockout:${bp.id}`;
    this.object3d.name = `ship-blockout:${bp.id}`;
    this.object3d.add(this.mesh);
  }

  update(): void {
    // A massing model has nothing to animate. The real visual will.
  }

  setLod(level: 0 | 1 | 2 | 3): void {
    // There is one level of detail here; the honest thing is to vanish at
    // impostor range rather than pretend a billboard exists.
    this.mesh.visible = level < 3;
  }

  dispose(): void {
    this.geometry.dispose();
    // The material is owned and shared by the Showroom, not by the visual.
  }
}

function moduleRings(m: ShipModule): PrismRing[] {
  const h = m.halfExtents;
  const hw = Math.max(h[0], 1e-6);
  const hh = Math.max(h[1], 1e-6);
  const hl = Math.max(h[2], 1e-6);
  return [
    { halfWidth: hw, halfHeight: hh, offsetX: 0, offsetY: 0, along: -hl },
    { halfWidth: hw, halfHeight: hh, offsetX: 0, offsetY: 0, along: hl },
  ];
}

/** Throat-to-exit taper of one nozzle in a pod, in the pod's own frame. */
function nozzleRings(e: EnginePod, index: number): PrismRing[] {
  const n = e.nozzle;
  const count = Math.max(1, n.count);
  const angle = count > 1 ? (index / count) * Math.PI * 2 : 0;
  const ox = count > 1 ? Math.cos(angle) * n.clusterRadius : 0;
  const oy = count > 1 ? Math.sin(angle) * n.clusterRadius : 0;
  const t = Math.max(n.throatRadius, 1e-6);
  const x = Math.max(n.exitRadius, t * 1.05);
  return [
    { halfWidth: t, halfHeight: t, offsetX: ox, offsetY: oy, along: 0 },
    { halfWidth: x, halfHeight: x, offsetX: ox, offsetY: oy, along: Math.max(n.length, 1e-5) },
  ];
}

// ===========================================================================
// Scale references
// ===========================================================================

/**
 * A person and a freight container, at the sizes `types.ts` publishes.
 *
 * BRIEF §8 asks that "scale is readable". Scale is not readable from a hull on
 * its own — a 30 m courier and a 4 km capital are the same picture until
 * something of known size is standing next to one. These two objects are that
 * something, and their dimensions come from `HUMAN_HEIGHT_KM`,
 * `DECK_HEIGHT_KM` and `CONTAINER_LENGTH_KM` rather than from taste.
 */
function buildScaleReference(): BufferGeometry {
  const b = new BlockoutBuilder();
  const h = HUMAN_HEIGHT_KM;

  // Reflectance, not brightness. Both props are lit by `uKeyColor`, which is
  // the star with `sunIntensity` already folded in — 3.0 for the standard key.
  // A prop that reflects that at unity is 3x over white, blooms, and ends up
  // the brightest object in a frame whose entire job is to be a neutral ruler.
  // These are the values the things themselves have: a dirty white EVA suit,
  // painted container steel, bare alloy fittings.
  const SUIT = 0.34;
  const VISOR = 0.03;
  const PACK = 0.2;
  const SKIN = 0.18;
  const BOX_STEEL = 0.18;
  const BOX_FRAME = 0.27;
  const BOX_DOOR = 0.13;

  // -- the figure ----------------------------------------------------------
  // Frame run axis is +Y, so `along` is height and the figure stands on y = 0.
  const F: Frame = { origin: [0, 0, 0], forward: [0, 1, 0], up: [0, 0, 1] };
  const limb = (cx: number, cz: number, hw: number, hd: number, y0: number, y1: number): void => {
    b.prism(F, [
      { halfWidth: hw, halfHeight: hd, offsetX: cx, offsetY: cz, along: y0 },
      { halfWidth: hw, halfHeight: hd, offsetX: cx, offsetY: cz, along: y1 },
    ]);
  };

  b.setAlbedo(SUIT);
  limb(-h * 0.085, 0, h * 0.062, h * 0.055, h * 0.045, h * 0.47); // legs
  limb(h * 0.085, 0, h * 0.062, h * 0.055, h * 0.045, h * 0.47);
  limb(0, 0, h * 0.155, h * 0.088, h * 0.45, h * 0.8); // torso
  limb(-h * 0.205, 0, h * 0.05, h * 0.052, h * 0.5, h * 0.78); // upper arms
  limb(h * 0.205, 0, h * 0.05, h * 0.052, h * 0.5, h * 0.78);
  limb(-h * 0.225, h * 0.09, h * 0.045, h * 0.05, h * 0.44, h * 0.56); // forearms, bent
  limb(h * 0.225, h * 0.09, h * 0.045, h * 0.05, h * 0.44, h * 0.56);
  limb(0, 0, h * 0.09, h * 0.088, h * 0.8, h * 0.86); // neck ring
  limb(0, h * 0.008, h * 0.098, h * 0.098, h * 0.86, h * 1.0); // helmet
  b.setAlbedo(SKIN);
  limb(-h * 0.085, h * 0.055, h * 0.062, h * 0.045, 0, h * 0.045); // boots
  limb(h * 0.085, h * 0.055, h * 0.062, h * 0.045, 0, h * 0.045);
  b.setAlbedo(PACK);
  limb(0, -h * 0.135, h * 0.135, h * 0.055, h * 0.5, h * 0.85); // life support pack
  b.setAlbedo(VISOR);
  limb(0, h * 0.098, h * 0.07, h * 0.012, h * 0.885, h * 0.965); // visor

  // -- the container -------------------------------------------------------
  // A standard freight box beside the figure, on the side AWAY from the hull
  // so it cannot end up buried in plating: the other unit the eye knows.
  //
  // It carries its own hardware — ISO corner castings, side corrugation, a
  // door end — because a calibration prop with no feature of its own calibrates
  // nothing. The container is the thing the reviewer measures the hull's plate
  // pitch against, so its 275 mm corrugation pitch and 1/8-length door leaves
  // are the actual ruler markings.
  const cl = CONTAINER_LENGTH_KM;
  const hw = DECK_HEIGHT_KM * 0.47;
  const hh = DECK_HEIGHT_KM * 0.5;
  const hl = cl * 0.5;
  const C: Frame = { origin: [-cl * 0.55, hh, 0], forward: [0, 0, 1], up: [0, 1, 0] };

  b.setAlbedo(BOX_STEEL);
  boxIn(b, C, 0, 0, 0, hw, hh, hl);

  // Corrugation: a 0.275 m pitch of 0.045 m ribs down both long walls. At any
  // framing where the figure is legible these read as banding, which is what
  // sets the eye's expectation for the hull's own plate pitch.
  const pitch = 0.000275;
  const ribs = Math.floor((hl * 2 - pitch) / pitch);
  const rib = pitch * 0.34;
  const proud = 0.000045;
  for (let i = 0; i < ribs; i++) {
    const z = -hl + pitch * (i + 1);
    boxIn(b, C, -(hw + proud), 0, z, proud, hh * 0.86, rib);
    boxIn(b, C, hw + proud, 0, z, proud, hh * 0.86, rib);
  }

  b.setAlbedo(BOX_FRAME);
  // Top and bottom rails, then the eight corner castings, 0.178 m cubes.
  for (const sy of [-1, 1] as const) {
    boxIn(b, C, -hw, sy * hh, 0, proud * 2.4, proud * 2.4, hl);
    boxIn(b, C, hw, sy * hh, 0, proud * 2.4, proud * 2.4, hl);
    boxIn(b, C, 0, sy * hh, -hl, hw, proud * 2.4, proud * 2.4);
    boxIn(b, C, 0, sy * hh, hl, hw, proud * 2.4, proud * 2.4);
  }
  const cast = 0.000089;
  for (const sx of [-1, 1] as const) {
    for (const sy of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        boxIn(b, C, sx * (hw - cast * 0.4), sy * (hh - cast * 0.4), sz * (hl - cast * 0.4), cast, cast, cast);
      }
    }
  }

  // The door end: two leaves inset behind their frame, four locking bars with
  // handles. This is the end that tells you which way round the box is, and
  // the handles are the only thing on either prop at hand scale.
  b.setAlbedo(BOX_DOOR);
  boxIn(b, C, -hw * 0.45, 0, hl + proud, hw * 0.43, hh * 0.9, proud);
  boxIn(b, C, hw * 0.45, 0, hl + proud, hw * 0.43, hh * 0.9, proud);
  b.setAlbedo(BOX_FRAME);
  for (const sx of [-0.66, -0.22, 0.22, 0.66]) {
    boxIn(b, C, hw * sx, 0, hl + proud * 2.6, proud * 0.9, hh * 0.88, proud * 0.9);
    boxIn(b, C, hw * sx, -hh * 0.12, hl + proud * 4.2, proud * 0.9, hh * 0.07, proud * 1.4);
  }

  return b.toGeometry();
}

// ===========================================================================
// Geometry the CPU is not allowed to believe
// ===========================================================================

/**
 * True when this geometry's real size lives in a vertex shader rather than in
 * its vertex positions.
 *
 * `render/ships/propulsion.ts` authors nozzle bells, plume columns and thruster
 * quads at unit scale and multiplies `position` by a per-instance `iSize`
 * (`iSizeA`/`iSizeB` for the additive families) in its own vertex shader. Two
 * consequences, both of which have already cost a review round:
 *
 *  - a material swap that does not carry the same attribute draws that geometry
 *    at its authored KILOMETRE, which is what put the camera inside the ship for
 *    all three silhouette frames in round three; and
 *  - `geometry.boundingBox` — and therefore anything built from it, including
 *    `Box3.setFromObject` — reports that same kilometre, so it is not a usable
 *    clearance volume for a camera solver.
 *
 * So this predicate is the single place the showroom decides "the CPU does not
 * know how big this is", and both the silhouette override and the clearance
 * guard consult it. It is a read of the geometry's attribute table, so it costs
 * a hash lookup and needs no cooperation from the renderer.
 */
function isShaderSized(geometry: BufferGeometry | undefined): boolean {
  if (!geometry) return false;
  const attrs = geometry.attributes;
  for (const name in attrs) {
    if (name.startsWith('iSize')) return true;
  }
  return false;
}

// ===========================================================================
// Layout arithmetic
// ===========================================================================

const _posedCorner = new Vector3();

/**
 * The axis-aligned box a hull occupies once the layout's shared pose is on it.
 *
 * Writes the box centre (in the hull's own local frame, rotated) into `centre`
 * and its half-extents into `half`. Both are needed: the extents are what the
 * packing spaces, and the centre is the offset between the hull's origin — the
 * thing the scene graph positions — and the shape the critic sees.
 *
 * Re-boxing on world axes overestimates a rotated box by up to ~40%, which is
 * why the shared pose is applied to the CORNERS rather than to the extents.
 * The overestimate is not free here: it is spacing bought at the cost of pixels
 * on every hull in the plate.
 */
function posedBox(bounds: Aabb, q: Quaternion, centre: Vector3, half: Vector3): void {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < 8; k++) {
    _posedCorner
      .set(
        (k & 1) !== 0 ? bounds.max[0] : bounds.min[0],
        (k & 2) !== 0 ? bounds.max[1] : bounds.min[1],
        (k & 4) !== 0 ? bounds.max[2] : bounds.min[2],
      )
      .applyQuaternion(q);
    if (_posedCorner.x < minX) minX = _posedCorner.x;
    if (_posedCorner.x > maxX) maxX = _posedCorner.x;
    if (_posedCorner.y < minY) minY = _posedCorner.y;
    if (_posedCorner.y > maxY) maxY = _posedCorner.y;
    if (_posedCorner.z < minZ) minZ = _posedCorner.z;
    if (_posedCorner.z > maxZ) maxZ = _posedCorner.z;
  }
  centre.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
  half.set(
    Math.max((maxX - minX) * 0.5, 1e-4),
    Math.max((maxY - minY) * 0.5, 1e-4),
    Math.max((maxZ - minZ) * 0.5, 1e-4),
  );
}

/**
 * Shout when a comparison set drew the same role twice.
 *
 * `console.error` rather than `throw`: `scripts/ship-review.mjs` fails the run
 * on a non-empty console error list, so this is as loud as an assertion, and
 * unlike a throw it still delivers the frame — a critic who can see the broken
 * plate beside the message can tell whether the roles or the hulls collapsed.
 *
 * Read off the generated BLUEPRINT, not off the shot's parameters. A role
 * pinned in the table and quietly re-rolled by the generator (a faction that
 * does not build it, a size band it is never built in) is exactly the case a
 * check on the request would miss.
 */
function reportRoleCollision(entries: readonly CacheEntry[]): void {
  const seen = new Set<ShipRole>();
  for (const e of entries) seen.add(e.blueprint.role);
  if (seen.size === entries.length) return;
  console.error(
    `[showroom] ROLE COLLISION: ${entries.length} hulls, ${seen.size} distinct roles ` +
      `(${entries.map((e) => e.blueprint.role).join(', ')}). A comparison plate with a ` +
      `repeated role cannot separate "same role" from "same ship".`,
  );
}

// ===========================================================================
// Setup description
// ===========================================================================

export type ShowroomAim = 'layout' | 'hull' | 'engine' | 'hardware' | 'scale';

/** A colour or direction as plain numbers, so a shot table stays plain data. */
export type Triple = readonly [number, number, number];

export interface ShowroomSetup {
  /** Deterministic ship set. Pinned fields are the experiment's controls. */
  readonly ships: readonly ShipParams[];
  /** Build the visuals at this tier instead of the running one. */
  readonly quality?: QualityTier;
  /** Replace every surface with the flat matte + rim. */
  readonly silhouette?: boolean;
  /** Force a level. Omit to leave the visual on whatever it decides. */
  readonly lod?: 0 | 1 | 2 | 3;
  readonly drive?: ShipDriveState;
  /** Unit-ish; normalised on the way in. World space. */
  readonly sunDirection?: Triple;
  /** Linear RGB. Multiplied by `sunIntensity` before it reaches the renderer. */
  readonly sunColor?: Triple;
  readonly sunIntensity?: number;
  /** Planetshine, linear RGB. Not ambient — it arrives from a direction. */
  readonly fillColor?: Triple;
  readonly fillDirection?: Triple;
  readonly scaleReference?: boolean;
  /**
   * CLEAR AIR between two neighbouring hulls, as a fraction of the larger of
   * the two's half-extent along the row. 0 is just touching; every positive
   * value is a gap the critic can see.
   *
   * It used to be "a multiple of their own radii", struck against
   * `boundingRadius`, and that is what fused two hulls in the r5 DNA plate —
   * see the packing comment in `configure`. The unit is now the hull's own
   * POSED box, so the same number means the same gap at any yaw.
   */
  readonly spacing?: number;
  /**
   * Fail loudly when two hulls in the set come out with the same `role`.
   *
   * For comparison plates whose experiment is "one control, one variable". A
   * family plate that draws two tankers is not a test of seed variation: the
   * critic cannot tell a repeated ROLE from a repeated SHIP, which is the exact
   * confound the plate exists to expose.
   */
  readonly requireDistinctRoles?: boolean;
  /**
   * Break the set into this many rows, stacked vertically.
   *
   * A single row of five hulls is a 4.4 : 1 shape in a 1.78 : 1 frame, so the
   * fit is forced to solve on width and two thirds of the frame's height goes
   * to black — which is how the DNA test came out with 90 px hulls no critic
   * could read construction language off. Two rows brings the block's aspect
   * close to the frame's and buys every hull roughly 1.7x its linear size for
   * free. Left at 1 for sets whose brief states a reading order.
   */
  readonly rows?: number;
  /** Shared pose applied to every hull, radians. */
  readonly yaw?: number;
  readonly pitch?: number;
  readonly roll?: number;
}

/** One placed hull in the review scene. */
export interface ShowroomSubject {
  readonly blueprint: ShipBlueprint;
  readonly visual: ShipVisual;
  readonly root: Group;
  /** Position in showroom space, km. */
  readonly position: Vector3;
  /** Inverse of the hull's pose, cached so `update()` allocates nothing. */
  readonly inverseQuaternion: Quaternion;
}

export interface ShowroomLayout {
  readonly subjects: readonly ShowroomSubject[];
  /** Radius of a sphere about the origin containing every hull, km. */
  readonly radiusKm: number;
}

const DEFAULT_DRIVE: ShipDriveState = {
  throttle: 0,
  boost: 0,
  heating: 0,
  rcs: new Vector3(0, 0, 0),
};

interface CacheEntry {
  readonly blueprint: ShipBlueprint;
  readonly visual: ShipVisual;
  readonly generation: number;
  readonly tier: QualityTier;
}

// ===========================================================================
// The module
// ===========================================================================

/** World up, read-only. */
const _worldUp = new Vector3(0, 1, 0);

export class Showroom implements GameModule {
  readonly name = 'showroom';
  readonly root = new Group();

  private active = false;
  private built = false;
  private lastFrame = -1;
  private material: ShaderMaterial | null = null;
  private scaleGeometry: BufferGeometry | null = null;
  private scaleMesh: Mesh | null = null;

  private readonly cache = new Map<string, CacheEntry>();
  private subjects: ShowroomSubject[] = [];
  private layoutRadiusKm = 0.05;

  private drive: ShipDriveState = DEFAULT_DRIVE;
  private silhouette = false;
  private readonly savedMaterials = new Map<Mesh, Material | Material[]>();
  private readonly hiddenEmitters: Object3D[] = [];
  /** Scene siblings switched off for the duration of the review. */
  private readonly isolated: Object3D[] = [];
  /** What each isolated sibling's `visible` was before we took it. */
  private readonly isolatedWasVisible: boolean[] = [];
  /** Membership test for the above, so re-sweeps allocate nothing. */
  private readonly isolatedSet = new Set<Object3D>();

  private readonly sunDirection = new Vector3(0.4, 0.74, -0.54).normalize();
  private readonly sunColor = new Color(3.0, 2.79, 2.46);
  private readonly fillColor = new Color(0.01, 0.014, 0.022);
  private readonly fillDirection = new Vector3(0, -1, 0.15).normalize();

  // Preallocated scratch — `update()` must not allocate (BRIEF §6).
  private readonly view = new MutableViewState();
  private readonly camLocal = new Vector3();
  private readonly sunLocal = new Vector3();
  private readonly scratchDir = new Vector3();
  private readonly scratchPoint = new Vector3();
  /** Outward normal of whatever `aim()` last chose, world space. */
  private readonly aimNormalV = new Vector3();
  private readonly clearBox = new Box3();
  private readonly meshBox = new Box3();

  constructor() {
    this.root.name = 'showroom';
    // Never visible during play. A review fixture that is drawn by accident is
    // worse than one that is missing, because the frame looks plausible.
    this.root.visible = false;
  }

  init(ctx: EngineContext): void {
    ctx.scene.add(this.root);
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Take the scene over. Only ever called from a review shot.
   *
   * ISOLATION IS THE POINT. Every other sibling in the scene is switched off:
   * the player's own hull (which `Pilot` deliberately leaves exactly where the
   * last shot put it — `Pilot.ts:80`), the gallery planet, any planet fixture,
   * and the star field. Two of those sit at the origin, which is where the
   * showroom puts its hulls, so without this a ship review frame would quietly
   * contain the hero ship from `Ship.ts` and the critic would review the wrong
   * vessel. The star field goes too: a hull is judged against black space here,
   * and a backdrop that changes with the galaxy seed is not a control.
   *
   * ISOLATION IS BY IDENTITY, NOT BY A VISIBILITY SNAPSHOT. Taking only the
   * siblings that happen to be visible on the frame `enter()` runs looks
   * equivalent and is not: `Pilot` and `ReviewGuard` set their own subject
   * visible again every frame, and a sibling that is switched off at the
   * moment of entry — because the previous shot left it that way — is then
   * never tracked, never re-hidden, and walks back into the frame during the
   * settle. Every sibling is taken, whatever it currently is, its prior state
   * is remembered, and `tick`/`lateUpdate` hold them all down for the whole
   * shot.
   */
  enter(ctx: EngineContext): void {
    this.ensureBuilt();
    this.active = true;
    this.root.visible = true;
    this.isolate(ctx);
  }

  /**
   * Take every scene sibling that is not ours and hold it off.
   *
   * Called from `enter` and again from `tick`, so a fixture that is added to
   * the scene lazily — after the first frame of the shot, during spool-up — is
   * caught on the frame it appears rather than photographed. Allocation-free
   * on the steady-state path: nothing is pushed once the set is complete.
   */
  private isolate(ctx: EngineContext): void {
    const children = ctx.scene.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (child === this.root) continue;
      if (!this.isolatedSet.has(child)) {
        this.isolatedSet.add(child);
        this.isolated.push(child);
        this.isolatedWasVisible.push(child.visible);
      }
      child.visible = false;
    }
  }

  /** Hand the scene back. Leaves the cache intact; shots run back to back. */
  exit(): void {
    this.setSilhouette(false);
    for (let i = 0; i < this.isolated.length; i++) {
      this.isolated[i]!.visible = this.isolatedWasVisible[i]!;
    }
    this.isolated.length = 0;
    this.isolatedWasVisible.length = 0;
    this.isolatedSet.clear();
    this.active = false;
    this.root.visible = false;
  }

  get isActive(): boolean {
    return this.active;
  }

  private ensureBuilt(): void {
    if (this.built) return;
    this.material = makeSilhouetteMaterial();
    this.scaleGeometry = buildScaleReference();
    this.scaleMesh = new Mesh(this.scaleGeometry, this.material);
    this.scaleMesh.name = 'showroom-scale-reference';
    this.scaleMesh.visible = false;
    this.root.add(this.scaleMesh);
    this.built = true;
  }

  // -- configuration --------------------------------------------------------

  /**
   * Build (or reuse) the ship set and lay it out.
   *
   * Allocation-heavy and called once per shot from `apply()`, never per frame.
   * Generation is 25–35 ms per hull, so a five-ship fleet costs ~0.2 s — which
   * is why every visual is cached by its exact parameters and reused across
   * every shot that asks for the same hull.
   */
  configure(ctx: EngineContext, setup: ShowroomSetup): ShowroomLayout {
    this.ensureBuilt();
    this.setSilhouette(false);

    const tier = setup.quality ?? ctx.quality.tier;
    const quality = qualitySettingsFor(tier);

    for (const s of this.subjects) s.root.removeFromParent();
    this.subjects = [];

    const entries = setup.ships.map((p) => this.resolve(p, tier, quality));
    if (setup.requireDistinctRoles === true) reportRoleCollision(entries);

    // Laid out along X, nose forward, in the order given, broken into `rows`
    // rows stacked in Y. Sorting by size would flatter the frame; the fleet
    // shots exist to show the actual spread, so the order is the caller's and
    // stays deterministic.
    //
    // -----------------------------------------------------------------------
    // PACKED ON WHAT THE HULL PRESENTS, NOT ON THE SPHERE AROUND IT
    //
    // `boundingRadius` is a sphere about the hull, so it is the hull's half
    // LENGTH whichever way the hull is turned. The old packing put centre i+1
    // at `spacing * r_i + r_{i+1}`, which means a `spacing` below 1 places the
    // two hulls' own spheres INSIDE each other — at the 0.55 the family plate
    // was authored with, by 45% of the left hull's radius. That is the fused
    // pair and the hull hidden behind the centre ship's engine bells in r5:
    // five seeds went out as three readable shapes, on the one plate whose
    // whole job is to compare five.
    //
    // The 0.55 was itself a compensation. Round three yawed every hull a
    // quarter turn for the fleet frames, and reasoned that a spacing struck
    // against the RADIUS was now buying half a hull of dead space — but a
    // broadside hull presents very nearly its own radius, so the compensation
    // was owed in the other direction. A unit that changes meaning when the
    // pose changes will be mis-tuned every time the pose changes.
    //
    // So the layout measures each hull's own box AFTER the shared pose and
    // packs the BOXES edge to edge with real air between them. `spacing` is
    // that air, as a fraction of the larger neighbour's half-extent: 0 is just
    // touching, and the number means the same thing at any yaw.
    const gap = Math.max(setup.spacing ?? 0.3, 0);
    const rows = Math.max(1, Math.min(Math.round(setup.rows ?? 1), Math.max(entries.length, 1)));
    const perRow = Math.ceil(entries.length / rows);

    const pose = new Quaternion().setFromEuler(
      new Euler(setup.pitch ?? 0, setup.yaw ?? 0, setup.roll ?? 0),
    );
    const boxCentre: Vector3[] = [];
    const boxHalf: Vector3[] = [];
    for (const e of entries) {
      const c = new Vector3();
      const h = new Vector3();
      posedBox(e.blueprint.dimensions.bounds, pose, c, h);
      boxCentre.push(c);
      boxHalf.push(h);
    }

    const px: number[] = new Array(entries.length).fill(0);
    const py: number[] = new Array(entries.length).fill(0);
    // Top and bottom of each row's own boxes, in the hulls' shared pose.
    const rowTop: number[] = [];
    const rowBottom: number[] = [];
    for (let r = 0; r < rows; r++) {
      const from = r * perRow;
      const to = Math.min(from + perRow, entries.length);
      let edge = 0; // X of the right-hand face of the last box placed
      let top = 0;
      let bottom = 0;
      for (let i = from; i < to; i++) {
        const h = boxHalf[i]!;
        const c = boxCentre[i]!;
        if (i > from) edge += gap * Math.max(boxHalf[i - 1]!.x, h.x);
        // Placed by the box's left face, with the hull's own origin offset
        // taken back out: on a hull whose engines hang off the aft plate the
        // origin is nowhere near the middle of its box, and a layout that
        // spaces origins spaces nothing.
        px[i] = edge + h.x - c.x;
        edge += h.x * 2;
        // A row's vertical extent has to include how much of each hull's DEPTH
        // the lens projects into the vertical: the fleet cameras sit a few
        // degrees above the layout plane, so a box that only just cleared at
        // zero elevation touches the one above it on screen. 0.25 covers
        // elevations to about 14 degrees, which is the band both fleet shots
        // are composed in; a steeper fleet camera has to buy its own room with
        // `spacing`.
        const vy = h.y + h.z * 0.25;
        top = i === from ? c.y + vy : Math.max(top, c.y + vy);
        bottom = i === from ? c.y - vy : Math.min(bottom, c.y - vy);
      }
      for (let i = from; i < to; i++) px[i] -= edge * 0.5;
      rowTop.push(top);
      rowBottom.push(bottom);
    }
    // A set of one is not a layout. Centring a row on its BOXES is what buys
    // the fleet plates their even gaps, but for a lone hull it would move the
    // ship off the world origin by its box offset — up to 15 m on the hero —
    // for no gain at all, and fifteen of the nineteen shots are single-hull
    // frames that are not under review. `placeCamera` recentres on the
    // projected box either way, so this changes nothing a lens can see; it
    // just keeps those frames byte-comparable with the round they passed in.
    if (entries.length === 1) px[0] = 0;
    // Rows are stacked top-first, so the reading order of a fleet frame runs
    // left to right and then down, like any other comparison plate. The air
    // between two rows is struck the same way as the air within one — a
    // fraction of the taller neighbour's half-height, measured on the boxes —
    // so a row of tugs under a row of freighters is not crushed against them.
    const rowGap = 0.5;
    const rowOffset: number[] = [];
    let ceiling = 0;
    for (let r = 0; r < rows; r++) {
      const halfH = (rowTop[r]! - rowBottom[r]!) * 0.5;
      if (r > 0) ceiling -= rowGap * Math.max((rowTop[r - 1]! - rowBottom[r - 1]!) * 0.5, halfH);
      rowOffset.push(ceiling - rowTop[r]!);
      ceiling -= rowTop[r]! - rowBottom[r]!;
    }
    // `ceiling` is now the bottom of the last row; the block runs [ceiling, 0].
    const vshift = ceiling * 0.5;
    for (let i = 0; i < entries.length; i++) {
      // Single-row sets keep y = 0 exactly as before. `setScaleReference`
      // places the figure and the container against the hull's own bounds
      // assuming the hull sits where the blueprint puts it, and a fleet fix
      // that quietly moved a single hull in Y would take the scale props off
      // the plating with it.
      py[i] = rows > 1 ? rowOffset[Math.min(Math.floor(i / perRow), rows - 1)]! - vshift : 0;
    }

    let radius = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const group = new Group();
      group.name = `showroom-subject:${e.blueprint.id}`;
      group.position.set(px[i]!, py[i]!, 0);
      group.rotation.set(setup.pitch ?? 0, setup.yaw ?? 0, setup.roll ?? 0);
      group.updateMatrixWorld(true);
      group.add(e.visual.object3d);
      this.root.add(group);

      const inv = new Quaternion().copy(group.quaternion).invert();
      this.subjects.push({
        blueprint: e.blueprint,
        visual: e.visual,
        root: group,
        position: group.position.clone(),
        inverseQuaternion: inv,
      });

      radius = Math.max(radius, group.position.length() + e.blueprint.dimensions.boundingRadius);
      // ALWAYS set the rung, never only when the shot names one.
      //
      // The visual is cached across shots, and shoot.mjs runs shots in global
      // registerShot order rather than this table's order — so ship-lod2 and
      // ship-extreme-distance execute BEFORE the hero frames and leave their
      // decimated hull behind. Measured: ship-hero-close, ship-greeble-close
      // and ship-high-quality were photographs of a 2-triangle impostor, and
      // the silhouette frames were the 2,508-triangle LOD2 hull. Two full
      // review rounds critiqued those frames as if they were LOD0.
      e.visual.setLod(setup.lod ?? 0);
    }
    this.layoutRadiusKm = Math.max(radius, 1e-4);

    this.drive = setup.drive ?? DEFAULT_DRIVE;
    if (setup.sunDirection) this.sunDirection.set(...setup.sunDirection).normalize();
    const sunIntensity = setup.sunIntensity ?? 3.0;
    const sc = setup.sunColor ?? [1.0, 0.93, 0.82];
    this.sunColor.setRGB(sc[0], sc[1], sc[2]).multiplyScalar(sunIntensity);
    const fc = setup.fillColor ?? [0.01, 0.014, 0.022];
    this.fillColor.setRGB(fc[0], fc[1], fc[2]);
    if (setup.fillDirection) this.fillDirection.set(...setup.fillDirection).normalize();
    for (const s of this.subjects) s.visual.setFillLight?.(this.fillColor);

    this.setScaleReference(setup.scaleReference === true, entries[0]?.blueprint ?? null);
    // Unconditional, not `if (setup.silhouette)`. It is a no-op for a shaded
    // shot only because of the `setSilhouette(false)` at the top of this
    // method, and a state machine whose correctness depends on a reset forty
    // lines away is one edit from photographing the previous shot's override.
    this.setSilhouette(setup.silhouette === true);

    return { subjects: this.subjects, radiusKm: this.layoutRadiusKm };
  }

  private resolve(params: ShipParams, tier: QualityTier, quality: QualitySettings): CacheEntry {
    const key = `${JSON.stringify(params)}|${tier}`;
    const hit = this.cache.get(key);
    if (hit && hit.generation === factoryGeneration) return hit;
    if (hit) {
      // A real renderer arrived after this blockout was cached. Throw it away
      // rather than review a stand-in that looks like a finished ship.
      hit.visual.object3d.removeFromParent();
      hit.visual.dispose();
      this.cache.delete(key);
    }

    const blueprint = generateShip(params);
    const visual = shipVisualFactory
      ? shipVisualFactory(blueprint, quality)
      : new BlockoutVisual(blueprint, this.material!);
    const entry: CacheEntry = { blueprint, visual, generation: factoryGeneration, tier };
    this.cache.set(key, entry);
    return entry;
  }

  private setScaleReference(on: boolean, beside: ShipBlueprint | null): void {
    const mesh = this.scaleMesh;
    if (!mesh) return;
    mesh.visible = on;
    if (!on || !beside) return;
    // Stood off the hull's port flank, below the centreline and amidships, so
    // that the camera reads the figure against PLATING rather than against
    // space — a reference silhouetted on black tells you its own size and
    // nothing about the ship's.
    const b = beside.dimensions.bounds;
    mesh.position.set(
      (this.subjects[0]?.position.x ?? 0) - beside.dimensions.beamKm * 0.5 - HUMAN_HEIGHT_KM * 3.0,
      b.min[1] * 0.35,
      0,
    );
  }

  // -- silhouette override --------------------------------------------------

  /**
   * Swap every surface for the flat matte, and stand the emitters down.
   *
   * Done by traversal rather than by asking the visual, because `ShipVisual`
   * deliberately does not expose its internals and a review harness that can
   * only review a cooperative renderer is not a review harness.
   *
   * Additive and transparent meshes — plume, nozzle glow, running lights — are
   * HIDDEN rather than overridden. A plume is not form. Painting one matte
   * black would add a cone to the silhouette that the hull does not have, and
   * the critic would reject a shape the ship never had.
   *
   * ---------------------------------------------------------------------------
   * AND SO IS ANYTHING SIZED BY ITS OWN SHADER
   *
   * The transparency test above is necessary and was not sufficient. The
   * propulsion renderer authors its nozzle bells at UNIT scale — a 1 km radius,
   * because one world unit is one kilometre — and shrinks each instance to its
   * real size inside the vertex shader from a per-instance `iSize` attribute.
   * Those meshes are opaque and `NormalBlending`, so they passed the test, got
   * the override material, and `SILHOUETTE_VERT` has no `iSize` path: every
   * bell drew at its full authored kilometre. The measured span of the
   * "silhouette" of a 62 m freighter was 2301 x 2447 x 2498 m, forty times the
   * hull, and a camera correctly solved to 390 m stood 760 m INSIDE the nearest
   * bell. All three silhouette frames in round three are photographs of the
   * inside of a nozzle.
   *
   * The fix is to skip that geometry entirely, which is what the comment above
   * already intends for emitters: a nozzle bell is propulsion, not form, and
   * BRIEF §8's black shape is the HULL. The test is the presence of an `iSize*`
   * instanced attribute, which is exactly the set of shader-sized geometry and
   * nothing else — the hull buffer and the greeble batches carry none.
   */
  setSilhouette(on: boolean): void {
    if (on === this.silhouette) return;
    this.silhouette = on;
    const mat = this.material;
    if (!mat) return;

    if (on) {
      const uniforms = mat.uniforms;
      uniforms.uKeyMix!.value = 0;
      (uniforms.uRimColor!.value as Color).setRGB(0.42, 0.47, 0.58);
      (uniforms.uBaseColor!.value as Color).setRGB(0.0035, 0.004, 0.0055);
      for (const s of this.subjects) {
        s.visual.object3d.traverse((o) => {
          const mesh = o as Mesh;
          if (!mesh.isMesh) return;
          const current = mesh.material;
          const probe = Array.isArray(current) ? current[0] : current;
          const emitter = probe !== undefined && (probe.transparent || probe.blending !== NormalBlending);
          if (emitter || isShaderSized(mesh.geometry)) {
            if (o.visible) {
              o.visible = false;
              this.hiddenEmitters.push(o);
            }
            return;
          }
          this.savedMaterials.set(mesh, current);
          mesh.material = mat;
        });
      }
    } else {
      for (const [mesh, saved] of this.savedMaterials) mesh.material = saved;
      this.savedMaterials.clear();
      for (const o of this.hiddenEmitters) o.visible = true;
      this.hiddenEmitters.length = 0;
      const uniforms = mat.uniforms;
      uniforms.uKeyMix!.value = 1;
      (uniforms.uRimColor!.value as Color).setRGB(0.34, 0.38, 0.46);
      (uniforms.uBaseColor!.value as Color).setRGB(0.004, 0.0045, 0.006);
    }
  }

  // -- framing helpers used by the shots ------------------------------------

  get layoutRadius(): number {
    return this.layoutRadiusKm;
  }

  /**
   * Outward normal of whatever the last `aim()` chose, world space, or a zero
   * vector when that aim has no preferred side. Read by `apply()`; valid only
   * until the next `aim()`.
   */
  get aimNormal(): Vector3 {
    return this.aimNormalV;
  }

  subject(index: number): ShowroomSubject | null {
    return this.subjects[index] ?? null;
  }

  /**
   * Where a shot should point, in world space, and how big the thing it is
   * pointing at is. Returns the radius; the point is written into `out`.
   *
   * `viewDir` is the shot's own camera direction, world space, and it is an
   * INPUT: a close-up has to pick something the camera can actually see from
   * where the shot stands it.
   */
  aim(aimAt: ShowroomAim, out: Vector3, viewDir?: Vector3): number {
    // Zero means "this aim has no preferred side"; only `hardware` sets one.
    this.aimNormalV.set(0, 0, 0);
    const s = this.subjects[0];
    if (!s || aimAt === 'layout') {
      out.set(0, 0, 0);
      return this.layoutRadiusKm;
    }
    const bp = s.blueprint;
    if (aimAt === 'scale' && this.scaleMesh) {
      // Framed on the reference, not on the hull. A 1.8 m figure beside a
      // 131 m hull framed whole is nine pixels tall, which proves nothing;
      // the shot has to be close enough that the ship's OWN hatches, rails
      // and deck bands can be measured against it.
      //
      // The radius is what sets the frame's metres-per-pixel, and that is the
      // whole shot: at the previous 24.4 m the figure came out an eight-pixel
      // smear, which is smaller than the frame's own grain and cannot be read
      // as a person at all. 11.6 m puts a 1.8 m figure across roughly 60 px of
      // a 1080-line frame with the container still whole beside it. The aim
      // sits between the two props rather than on the figure, so neither is
      // pushed to an edge.
      out.copy(this.scaleMesh.position);
      out.x -= CONTAINER_LENGTH_KM * 0.275;
      return CONTAINER_LENGTH_KM * 0.95;
    }
    if (aimAt === 'engine' && bp.engines.length > 0) {
      out.set(0, 0, 0);
      let widest = 0;
      for (const e of bp.engines) {
        out.x += e.frame.origin[0];
        out.y += e.frame.origin[1];
        out.z += e.frame.origin[2];
        widest = Math.max(widest, e.nozzle.exitRadius * (e.nozzle.count > 1 ? 2.2 : 1.6) + e.nozzle.clusterRadius);
      }
      out.multiplyScalar(1 / bp.engines.length);
      let spread = 0;
      for (const e of bp.engines) {
        const dx = e.frame.origin[0] - out.x;
        const dy = e.frame.origin[1] - out.y;
        const dz = e.frame.origin[2] - out.z;
        spread = Math.max(spread, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
      this.toWorld(s, out);
      return Math.max(spread + widest, bp.dimensions.lengthKm * 0.06);
    }
    if (aimAt === 'hardware') {
      // The shot's direction, brought into the hull's own space, so the picker
      // can ask "is this piece of hardware visible from where the camera
      // stands" rather than just "is it the right kind of part".
      this.scratchDir.copy(viewDir ?? _worldUp).applyQuaternion(s.inverseQuaternion).normalize();
      const r = pickHardwareCluster(bp, this.scratchDir, out, this.aimNormalV);
      if (r > 0) {
        this.toWorld(s, out);
        // The cluster's mounting normal, in world space. `apply()` swings the
        // camera onto this side of the plate: a fixed world direction plus a
        // picked point is how `ship-greeble-close` ended up looking ALONG the
        // plating at a cluster mounted on a face turned away from the lens, and
        // returned a frame that was 93% flat plate with no hardware in it.
        this.aimNormalV.applyQuaternion(s.root.quaternion).normalize();
        // Held between roughly four and twelve metres of frame, whatever the
        // hull's size: a detail shot that frames thirty metres is a hull shot,
        // and a detail shot that frames one metre is a texture swatch.
        return Math.min(Math.max(r, DECK_HEIGHT_KM * 0.8), DECK_HEIGHT_KM * 2.4);
      }
    }
    out.copy(s.position);
    return bp.dimensions.boundingRadius;
  }

  /**
   * The subject's world-space box corners, for the projected fit in
   * `placeCamera`. Returns the number written, or 0 when this aim has no
   * meaningful box and should keep the sphere fit.
   *
   * The corners come from `dimensions.bounds`, which the generator documents
   * as "tight box round every LOD0 PART" — so plume, wake and running-light
   * billboards, which are not parts, are already outside it. A fit that
   * included a burning plume would push the hull to a third of the frame the
   * moment the throttle came up, and the hero shot is taken at cruise.
   */
  aimCorners(aimAt: ShowroomAim, out: Vector3[]): number {
    if (aimAt !== 'hull' && aimAt !== 'layout') return 0;
    const last = aimAt === 'layout' ? this.subjects.length : Math.min(1, this.subjects.length);
    let n = 0;
    for (let si = 0; si < last; si++) {
      const s = this.subjects[si]!;
      const bnd = s.blueprint.dimensions.bounds;
      for (let k = 0; k < 8; k++) {
        let v = out[n];
        if (!v) {
          v = new Vector3();
          out[n] = v;
        }
        v.set(
          (k & 1) !== 0 ? bnd.max[0] : bnd.min[0],
          (k & 2) !== 0 ? bnd.max[1] : bnd.min[1],
          (k & 4) !== 0 ? bnd.max[2] : bnd.min[2],
        );
        // Each hull is rotated by the setup's shared pose, so the corners are
        // taken through the subject's own transform rather than boxed again on
        // world axes — an axis-aligned re-box of a rotated hull is up to 40%
        // too big and would pull every frame back out again.
        v.applyQuaternion(s.root.quaternion).add(s.position);
        n++;
      }
    }
    return n;
  }

  /**
   * The world-space corners of the box that is actually DRAWN this shot.
   *
   * `aimCorners` reads `dimensions.bounds`, which is the generator's promise
   * about the hull. This reads the scene graph, which is what the lens will
   * see. They should agree to a few per cent, and when they do this costs
   * nothing — the guard it feeds in `placeCamera` is not binding. When they do
   * NOT agree, the difference is the failure mode that cost round three: the
   * blueprint said 62 m, the drawn thing was 2.5 km, the fit was solved off the
   * blueprint, and the shutter fired from inside the ship.
   *
   * Two exclusions, both deliberate:
   *  - invisible subtrees, via `traverseVisible`, so the silhouette pass's
   *    hidden emitters do not push the camera back out to a plume's reach; and
   *  - shader-sized geometry (see `isShaderSized`), whose CPU bounds are its
   *    authored kilometre and not its drawn size. Including it would park every
   *    hull frame 1.2 km back. Under `setSilhouette` that geometry is hidden
   *    outright, so on the frames this guard exists to protect it is excluded
   *    twice over.
   *
   * Called once per shot from `apply()`, never per frame.
   */
  clearanceCorners(out: Vector3[]): number {
    const box = this.clearBox.makeEmpty();
    // The subjects were parented after their groups were last updated, so the
    // descendants' `matrixWorld` is one frame stale at this point in `apply()`
    // — and a clearance box built from a stale transform is worse than none.
    this.root.updateMatrixWorld(true);
    for (const s of this.subjects) {
      s.visual.object3d.traverseVisible((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const geom = mesh.geometry;
        if (isShaderSized(geom)) return;
        const inst = o as InstancedMesh;
        if (inst.isInstancedMesh) {
          // Recomputed rather than reused: `boundingBox` is cached on the mesh
          // and the visuals are cached across shots, so a renderer that rewrites
          // its instance matrices for an LOD would otherwise be measured on the
          // previous shot's layout.
          inst.computeBoundingBox();
          if (!inst.boundingBox) return;
          this.meshBox.copy(inst.boundingBox);
        } else {
          if (geom.boundingBox === null) geom.computeBoundingBox();
          if (!geom.boundingBox) return;
          this.meshBox.copy(geom.boundingBox);
        }
        this.meshBox.applyMatrix4(o.matrixWorld);
        box.union(this.meshBox);
      });
    }
    if (box.isEmpty()) return 0;
    for (let k = 0; k < 8; k++) {
      let v = out[k];
      if (!v) {
        v = new Vector3();
        out[k] = v;
      }
      v.set(
        (k & 1) !== 0 ? box.max.x : box.min.x,
        (k & 2) !== 0 ? box.max.y : box.min.y,
        (k & 4) !== 0 ? box.max.z : box.min.z,
      );
    }
    return 8;
  }

  /**
   * Check, on the placed camera, that a comparison plate is actually readable:
   * every hull separate from every other, and every hull inside the frame.
   *
   * The layout guarantees clear air between the hulls in WORLD space, which is
   * the right place to guarantee it — a layout that solved against the camera
   * would have to be re-solved every time a shot was recomposed. But "clear in
   * world space" is only "clear on screen" while the lens stays near square to
   * the layout plane, and nothing else in this file enforces that. So the two
   * are reconciled here, once, after the camera is placed: the same boxes the
   * layout packed are projected through the real projection matrix (roll and
   * all) and the result is printed with the numbers a critic would otherwise
   * have to measure off the PNG.
   *
   * An overlap is a `console.error` because it VOIDS the plate — five hulls
   * that cannot be told apart answer none of the questions the shot asks — and
   * `scripts/ship-review.mjs` fails a run whose console carried errors. The
   * frame margin is printed rather than errored: a hull touching the edge
   * spoils a plate, it does not invalidate it.
   *
   * Called once per shot from `apply()`, never per frame.
   */
  reportLayoutSeparation(ctx: EngineContext, shotName: string): void {
    const n = this.subjects.length;
    if (n < 2) return;
    // Once per shot. Everything else on this path allocates far more.
    const lo: Vector3[] = [];
    const hi: Vector3[] = [];
    let margin = 0;
    for (let si = 0; si < n; si++) {
      const s = this.subjects[si]!;
      const bnd = s.blueprint.dimensions.bounds;
      const min = new Vector3(Infinity, Infinity, Infinity);
      const max = new Vector3(-Infinity, -Infinity, -Infinity);
      for (let k = 0; k < 8; k++) {
        this.scratchPoint
          .set(
            (k & 1) !== 0 ? bnd.max[0] : bnd.min[0],
            (k & 2) !== 0 ? bnd.max[1] : bnd.min[1],
            (k & 4) !== 0 ? bnd.max[2] : bnd.min[2],
          )
          .applyQuaternion(s.root.quaternion)
          .add(s.position)
          .project(ctx.camera);
        min.min(this.scratchPoint);
        max.max(this.scratchPoint);
      }
      lo.push(min);
      hi.push(max);
      margin = Math.max(margin, Math.abs(min.x), Math.abs(max.x), Math.abs(min.y), Math.abs(max.y));
    }

    const collisions: string[] = [];
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        // A 0.002 NDC tolerance — under two pixels — so a shared edge is not
        // reported as a fused pair.
        const gapX = Math.max(lo[a]!.x - hi[b]!.x, lo[b]!.x - hi[a]!.x);
        const gapY = Math.max(lo[a]!.y - hi[b]!.y, lo[b]!.y - hi[a]!.y);
        if (Math.max(gapX, gapY) < 0.002) {
          collisions.push(`${this.subjects[a]!.blueprint.role}#${a}/${this.subjects[b]!.blueprint.role}#${b}`);
        }
      }
    }

    console.info(
      `[showroom] ${shotName} layout hulls=${n} maxNdc=${margin.toFixed(3)} ` +
        `spans=${lo.map((v, i) => `[${v.x.toFixed(2)},${hi[i]!.x.toFixed(2)}]`).join(' ')} ` +
        `overlaps=${collisions.length}`,
    );
    if (collisions.length > 0) {
      console.error(
        `[showroom] LAYOUT OVERLAP in ${shotName}: ${collisions.join(', ')} — the hulls ` +
          `share screen area, so this comparison plate cannot be read.`,
      );
    }
  }

  private toWorld(s: ShowroomSubject, p: Vector3): void {
    p.applyQuaternion(s.root.quaternion).add(s.position);
  }

  /**
   * Advance every hull by `seconds` of simulated time before the shutter.
   *
   * Every visible value on a drive is critically damped towards its command,
   * so a shot captured from rest photographs a powered-down hull no matter
   * what state it asked for. `Ship.ts` learned this the hard way (:2620).
   */
  settle(ctx: EngineContext, seconds: number, step = 0.25): void {
    const n = Math.max(1, Math.round(seconds / step));
    for (let i = 0; i < n; i++) this.tick(step, ctx);
  }

  // -- frame loop -----------------------------------------------------------

  /**
   * The engine drives this as a module; the active shot drives it as well, so
   * that the showroom still works if the integrator wired only one of the two.
   * Whichever gets there first owns the frame — a hull updated twice would
   * damp its throttle at double rate and spool visibly faster than it does in
   * play, which is precisely the kind of difference a review must not have.
   */
  update(dt: number, ctx: EngineContext): void {
    if (!this.active) return;
    if (ctx.frame === this.lastFrame) return;
    this.lastFrame = ctx.frame;
    this.tick(dt, ctx);
  }

  /**
   * Last word on visibility.
   *
   * Modules run in registration order and several of them set their own
   * subject visible again every frame (`ReviewGuard`, `Pilot`). Register the
   * showroom last and this is the final say before the pipeline draws.
   */
  lateUpdate(): void {
    if (!this.active) return;
    for (let i = 0; i < this.isolated.length; i++) this.isolated[i]!.visible = false;
  }

  private tick(dt: number, ctx: EngineContext): void {
    this.isolate(ctx);

    const mat = this.material;
    if (mat) {
      // View-space light directions, so the override material works unchanged
      // on instanced geometry without needing a world position varying.
      const sunView = mat.uniforms.uSunDirView!.value as Vector3;
      sunView.copy(this.sunDirection).transformDirection(ctx.camera.matrixWorldInverse);
      const fillView = mat.uniforms.uFillDirView!.value as Vector3;
      fillView.copy(this.fillDirection).transformDirection(ctx.camera.matrixWorldInverse);
      (mat.uniforms.uKeyColor!.value as Color).copy(this.sunColor);
      (mat.uniforms.uFillColor!.value as Color).copy(this.fillColor);
    }

    const fovY = (ctx.camera.fov * Math.PI) / 180;
    for (let i = 0; i < this.subjects.length; i++) {
      const s = this.subjects[i]!;
      this.camLocal.copy(ctx.camera.position).sub(s.position).applyQuaternion(s.inverseQuaternion);
      this.sunLocal.copy(this.sunDirection).applyQuaternion(s.inverseQuaternion);
      this.view.set(this.camLocal, this.sunLocal, this.sunColor, ctx.elapsed, fovY, ctx.height);
      s.visual.update(dt, ctx, this.view, this.drive);
    }
  }

  // -- teardown -------------------------------------------------------------

  /**
   * Frees, in order: every cached `ShipVisual` (each of which frees its own
   * geometry), the scale-reference geometry, and the shared silhouette
   * material. No textures and no render targets are allocated by this module.
   */
  dispose(): void {
    this.setSilhouette(false);
    for (const s of this.subjects) s.root.removeFromParent();
    this.subjects = [];
    for (const entry of this.cache.values()) {
      entry.visual.object3d.removeFromParent();
      entry.visual.dispose();
    }
    this.cache.clear();
    this.scaleMesh?.removeFromParent();
    this.scaleMesh = null;
    this.scaleGeometry?.dispose();
    this.scaleGeometry = null;
    this.material?.dispose();
    this.material = null;
    this.built = false;
    this.root.removeFromParent();
  }
}

/**
 * Human-scale hardware that a greeble close-up is allowed to land on.
 *
 * Everything here is a thing a crew touches or services, and everything here
 * is roughly a person across. The kinds NOT in this list — radiator panels,
 * cargo pods, habitat cans, bridge towers, mining booms — are primary or
 * secondary MASSES. Pointing a detail shot at one of those frames a few
 * square metres of its face, which is a picture of bare plate whatever the
 * greeble system is doing.
 */
const CREW_HARDWARE: ReadonlySet<ShipModule['kind']> = new Set<ShipModule['kind']>([
  'airlock',
  'docking-collar',
  'service-hatch',
  'ladder',
  'handrail',
  'toolbox',
  'navlight',
  'beacon',
  'emblem-plate',
  'registry-plate',
  'blanking-plate',
  'landing-leg',
  'landing-skid',
  'point-defence',
]);

/** Ranked, so the winner is stable when two clusters are equally dense. */
const CREW_HARDWARE_RANK: readonly ShipModule['kind'][] = [
  'airlock',
  'docking-collar',
  'service-hatch',
  'ladder',
  'handrail',
  'toolbox',
  'landing-leg',
];

const _probe = new Vector3();
const _volLocal: [number, number, number] = [0, 0, 0];
const _volRight: [number, number, number] = [0, 0, 0];

/** Is a ship-local point inside one of the blueprint's primary volumes? */
function insideVolume(v: PrimaryVolume, x: number, y: number, z: number): boolean {
  const f = v.frame;
  frameRight(f, _volRight);
  const dx = x - f.origin[0];
  const dy = y - f.origin[1];
  const dz = z - f.origin[2];
  const lz = dx * f.forward[0] + dy * f.forward[1] + dz * f.forward[2];
  const len = runLength(v);
  if (len <= 0 || lz < 0 || lz > len) return false;
  const lx = dx * _volRight[0] + dy * _volRight[1] + dz * _volRight[2];
  const ly = dx * f.up[0] + dy * f.up[1] + dz * f.up[2];

  const t = lz / len;
  const st = v.stations;
  if (st.length === 0) return false;
  let a = st[0]!;
  let b = st[st.length - 1]!;
  for (let i = 0; i < st.length - 1; i++) {
    if (t >= st[i]!.t && t <= st[i + 1]!.t) {
      a = st[i]!;
      b = st[i + 1]!;
      break;
    }
  }
  const span = b.t - a.t;
  const k = span > 1e-9 ? (t - a.t) / span : 0;
  const hw = a.halfWidth + (b.halfWidth - a.halfWidth) * k;
  const hh = a.halfHeight + (b.halfHeight - a.halfHeight) * k;
  const ox = a.offset[0] + (b.offset[0] - a.offset[0]) * k;
  const oy = a.offset[1] + (b.offset[1] - a.offset[1]) * k;
  return Math.abs(lx - ox) <= hw && Math.abs(ly - oy) <= hh;
}

/**
 * How much of the way out to the camera is clear of the hull's own masses.
 *
 * The `ship-greeble-close` frame came back as a featureless plate, and the
 * blueprint says why: on this hull the airlock, the docking collar and a
 * beacon all sit on the spine at the CENTRE of a ring of six 28 m cargo bays,
 * so a camera standing ten metres off them is inside the bundle and is
 * photographing the inner face of a cargo bay. (That the docking collar is
 * unreachable from outside is a socket-placement problem and belongs to the
 * generator — BRIEF §5 — but a review harness that quietly photographs the
 * inside of a hole has hidden the defect instead of exposing it.)
 *
 * So the close-up will not be aimed at hardware it cannot see: the stand-off
 * ray is sampled against the primary volumes and a buried cluster is scored
 * out. Arcs are treated as straight, the same approximation the blockout makes.
 */
function clearance(bp: ShipBlueprint, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, step: number): number {
  const at = [0.8, 1.6, 2.6, 4.0];
  let clear = 0;
  for (const s of at) {
    const px = ox + dx * step * s;
    const py = oy + dy * step * s;
    const pz = oz + dz * step * s;
    let hit = false;
    for (const v of bp.primaryVolumes) {
      if (insideVolume(v, px, py, pz)) {
        hit = true;
        break;
      }
    }
    if (!hit) clear++;
  }
  return clear / at.length;
}

/**
 * Where a close-up should be pointed, and how much of the hull it should hold.
 *
 * The old version picked the first module of a preferred kind and framed its
 * own half-extents. That is how `ship-greeble-close` ended up aimed at flat
 * plate: the preference list took the first airlock wherever it was, the frame
 * was sized to that one part, and nothing checked that the camera could see it
 * — in a frame whose brief asks the critic to COUNT DISTINCT SILHOUETTES.
 *
 * A greeble shot wants a CLUSTER the camera can see. Every piece of crew
 * hardware is scored on three things: whether the line out to the camera is
 * clear of the hull's own masses, whether its mounting face is turned towards
 * the camera at all, and how many other pieces sit within a few decks of it.
 * Ties break on the rank above and then on blueprint order, so the answer is
 * deterministic for a given seed.
 *
 * `viewDir` points FROM the hull TOWARDS the camera, in ship-local space.
 * Writes the cluster centre, ship-local km, into `out`. Returns the radius the
 * frame should hold, or 0 when the hull has no modules at all.
 */
function pickHardwareCluster(
  bp: ShipBlueprint,
  viewDir: Vector3,
  out: Vector3,
  outNormal?: Vector3,
): number {
  const near = DECK_HEIGHT_KM * 3.0;
  const candidates = bp.modules.filter((m) => m.present && CREW_HARDWARE.has(m.kind));
  const pool = candidates.length > 0 ? candidates : bp.modules.filter((m) => m.present);
  if (pool.length === 0) return 0;

  const dist2 = (a: ShipModule, b: ShipModule): number => {
    const dx = a.frame.origin[0] - b.frame.origin[0];
    const dy = a.frame.origin[1] - b.frame.origin[1];
    const dz = a.frame.origin[2] - b.frame.origin[2];
    return dx * dx + dy * dy + dz * dz;
  };

  let best = pool[0]!;
  let bestScore = -Infinity;
  let bestRank = 99;
  for (const m of pool) {
    let count = 0;
    for (const o of pool) if (o !== m && dist2(m, o) <= near * near) count++;
    const o = m.frame.origin;
    // A mounting face is the outward normal of the socket it sits on, so the
    // dot against the view direction is "is this piece turned towards us".
    const facing = m.frame.up[0] * viewDir.x + m.frame.up[1] * viewDir.y + m.frame.up[2] * viewDir.z;
    const clear = clearance(bp, o[0], o[1], o[2], viewDir.x, viewDir.y, viewDir.z, DECK_HEIGHT_KM * 1.6);
    const rank = CREW_HARDWARE_RANK.indexOf(m.kind);
    const r = rank < 0 ? 90 : rank;
    // Clearance dominates: a cluster of six the camera cannot see is worth
    // less than one bracket it can.
    //
    // `facing` used to be worth at most 1.0 against a population term worth up
    // to 2.2, so a dense cluster on a face turned AWAY from the lens beat a
    // sparser one turned towards it — and the shot came back as plating seen
    // edge-on. Clearance still leads, but a cluster the camera would be looking
    // at the back of now loses on its own: the frame is scored on distinct
    // SILHOUETTES, and a greeble presents none from behind.
    const score = clear * 3.0 + Math.max(facing, -0.4) * 2.4 + Math.min(count, 4) * 0.55 - r * 0.004;
    if (score > bestScore || (score === bestScore && r < bestRank)) {
      best = m;
      bestScore = score;
      bestRank = r;
    }
  }

  out.set(0, 0, 0);
  let n = 0;
  for (const m of pool) {
    if (m !== best && dist2(m, best) > near * near) continue;
    out.x += m.frame.origin[0];
    out.y += m.frame.origin[1];
    out.z += m.frame.origin[2];
    n++;
  }
  out.multiplyScalar(1 / Math.max(n, 1));

  let reach = 0;
  for (const m of pool) {
    if (m !== best && dist2(m, best) > near * near) continue;
    const dx = m.frame.origin[0] - out.x;
    const dy = m.frame.origin[1] - out.y;
    const dz = m.frame.origin[2] - out.z;
    const h = Math.max(m.halfExtents[0], m.halfExtents[1], m.halfExtents[2]);
    reach = Math.max(reach, Math.sqrt(dx * dx + dy * dy + dz * dz) + h * 1.35);
  }
  // Stand the aim point off the plate along the mounting normal, so a frame
  // sized to a single small bracket does not put the lens in the plating.
  _probe.set(best.frame.up[0], best.frame.up[1], best.frame.up[2]);
  if (_probe.lengthSq() > 1e-9) {
    _probe.normalize();
    out.addScaledVector(_probe, Math.max(reach, DECK_HEIGHT_KM * 1.6) * 0.35);
    outNormal?.copy(_probe);
  }
  // Never tighter than about four decks of frame: below that a detail shot is
  // a texture swatch, and nothing human-scale has room to be beside anything.
  return Math.max(reach, DECK_HEIGHT_KM * 1.6);
}

/**
 * The `QualitySettings` for a named tier.
 *
 * `Config` owns the tier table and does not export it; `setTier` is the only
 * accessor and it mutates the global. Borrow and restore, in one place, with
 * this comment attached — rather than let three shots each invent their own
 * way of doing it and leave the game at `low` when the capture ends.
 */
function qualitySettingsFor(tier: QualityTier): QualitySettings {
  const previous = config.quality;
  const wanted = config.setTier(tier);
  config.quality = previous;
  return wanted;
}
