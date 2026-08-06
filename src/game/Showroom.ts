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
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
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
import { registerShot } from '@/game/Shots';
import { MutableViewState, type ViewState } from '@/render/ViewState';
import { hashSeed } from '@/math/rng';

import { generateShip, type ShipParams } from '@/gen/ships/blueprint';
import {
  CONTAINER_LENGTH_KM,
  DECK_HEIGHT_KM,
  HUMAN_HEIGHT_KM,
  frameToShip,
  type EnginePod,
  type Frame,
  type PrimaryVolume,
  type ShipBlueprint,
  type ShipModule,
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

varying vec3 vNormalView;
varying vec3 vEyeDir;

void main() {
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>

  vNormalView = transformedNormal;
  vEyeDir = -mvPosition.xyz;
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

void main() {
  #include <logdepthbuf_fragment>

  vec3 N = normalize(vNormalView);
  // The blockout is a shell of quads and the reviewer will see its inside
  // through open caps; a back face with an outward normal reads as a hole.
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(vEyeDir);

  float ndl = max(dot(N, uSunDirView), 0.0);
  float ndf = max(dot(N, uFillDirView), 0.0);

  // The rim is gated by the key. A rim that runs the whole way round an
  // outline is a glow, and a glow says nothing about which way the form turns
  // — which is the single thing a silhouette shot exists to show.
  float wrap = smoothstep(-0.55, 0.35, dot(N, uSunDirView));
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), uRimPower) * (0.14 + 0.86 * wrap);

  vec3 col = uBaseColor
           + uKeyColor * (ndl * uKeyMix)
           + uFillColor * (0.18 + 0.82 * ndf) * uKeyMix
           + uRimColor * rim;

  gl_FragColor = vec4(col, 1.0);
}
`;

function makeSilhouetteMaterial(): ShaderMaterial {
  return new ShaderMaterial({
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
  private readonly a: [number, number, number] = [0, 0, 0];
  private readonly b: [number, number, number] = [0, 0, 0];
  private readonly c: [number, number, number] = [0, 0, 0];

  tri(p: readonly number[], q: readonly number[], r: readonly number[]): void {
    this.pos.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
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
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
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
  /** A vertical box: the frame's run axis is +Y, so `along` is height. */
  const box = (cx: number, hw: number, hd: number, y0: number, y1: number): void => {
    b.prism({ origin: [cx, 0, 0], forward: [0, 1, 0], up: [0, 0, 1] }, [
      { halfWidth: hw, halfHeight: hd, offsetX: 0, offsetY: 0, along: y0 },
      { halfWidth: hw, halfHeight: hd, offsetX: 0, offsetY: 0, along: y1 },
    ]);
  };

  // A suited figure: legs, torso, arms, helmet. Six boxes is enough for a
  // human read at a glance and nothing here should draw attention to itself.
  box(-h * 0.09, h * 0.055, h * 0.06, 0, h * 0.48);
  box(h * 0.09, h * 0.055, h * 0.06, 0, h * 0.48);
  box(0, h * 0.15, h * 0.085, h * 0.46, h * 0.83);
  box(-h * 0.2, h * 0.045, h * 0.05, h * 0.5, h * 0.82);
  box(h * 0.2, h * 0.045, h * 0.05, h * 0.5, h * 0.82);
  box(0, h * 0.085, h * 0.085, h * 0.83, h * 1.0);

  // A standard freight container beside it, on the side AWAY from the hull so
  // it cannot end up buried in plating: the other unit the eye knows.
  const cl = CONTAINER_LENGTH_KM;
  b.prism(
    { origin: [-cl * 0.55, 0, 0], forward: [0, 0, 1], up: [0, 1, 0] },
    [
      { halfWidth: DECK_HEIGHT_KM * 0.46, halfHeight: DECK_HEIGHT_KM * 0.5, offsetX: 0, offsetY: DECK_HEIGHT_KM * 0.5, along: -cl * 0.5 },
      { halfWidth: DECK_HEIGHT_KM * 0.46, halfHeight: DECK_HEIGHT_KM * 0.5, offsetX: 0, offsetY: DECK_HEIGHT_KM * 0.5, along: cl * 0.5 },
    ],
  );

  return b.toGeometry();
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
  /** Gap between hulls as a multiple of their own radii. 1 = just touching. */
  readonly spacing?: number;
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
   */
  enter(ctx: EngineContext): void {
    this.ensureBuilt();
    if (!this.active) {
      for (const child of ctx.scene.children) {
        if (child === this.root || !child.visible) continue;
        child.visible = false;
        this.isolated.push(child);
      }
    }
    this.active = true;
    this.root.visible = true;
  }

  /** Hand the scene back. Leaves the cache intact; shots run back to back. */
  exit(): void {
    this.setSilhouette(false);
    for (const o of this.isolated) o.visible = true;
    this.isolated.length = 0;
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

    // Laid out along X, nose forward, in the order given. Sorting by size
    // would flatter the frame; the fleet shots exist to show the actual
    // spread, so the order is the caller's and stays deterministic.
    const gap = setup.spacing ?? 1.35;
    let cursor = 0;
    const centres: number[] = [];
    for (const e of entries) {
      const r = Math.max(e.blueprint.dimensions.boundingRadius, 1e-4);
      cursor += r;
      centres.push(cursor);
      cursor += r * gap;
    }
    const span = centres.length > 0 ? centres[centres.length - 1]! + entries[entries.length - 1]!.blueprint.dimensions.boundingRadius : 0;
    const shift = span * 0.5;

    let radius = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const group = new Group();
      group.name = `showroom-subject:${e.blueprint.id}`;
      group.position.set(centres[i]! - shift, 0, 0);
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

      radius = Math.max(radius, Math.abs(group.position.x) + e.blueprint.dimensions.boundingRadius);
      if (setup.lod !== undefined) e.visual.setLod(setup.lod);
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
    if (setup.silhouette) this.setSilhouette(true);

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
          if (probe && (probe.transparent || probe.blending !== NormalBlending)) {
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

  subject(index: number): ShowroomSubject | null {
    return this.subjects[index] ?? null;
  }

  /**
   * Where a shot should point, in world space, and how big the thing it is
   * pointing at is. Returns the radius; the point is written into `out`.
   */
  aim(aimAt: ShowroomAim, out: Vector3): number {
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
      out.copy(this.scaleMesh.position);
      return CONTAINER_LENGTH_KM * 2.0;
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
      const m = pickCloseUpModule(bp);
      if (m) {
        out.set(m.frame.origin[0], m.frame.origin[1], m.frame.origin[2]);
        this.toWorld(s, out);
        const h = Math.max(m.halfExtents[0], m.halfExtents[1], m.halfExtents[2]);
        // Held between roughly four and twelve metres of frame, whatever the
        // hull's size: a detail shot that frames thirty metres is a hull shot,
        // and a detail shot that frames one metre is a texture swatch.
        return Math.min(Math.max(h * 2.2, DECK_HEIGHT_KM * 0.8), DECK_HEIGHT_KM * 2.4);
      }
    }
    out.copy(s.position);
    return bp.dimensions.boundingRadius;
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
    for (let i = 0; i < this.isolated.length; i++) this.isolated[i]!.visible = false;

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
 * A module a close-up should be pointed at.
 *
 * Crew hardware first: a ladder, a handrail or an airlock is the detail that
 * proves a ship is inhabited and is the correct subject for a greeble shot.
 * Falls back to whatever the generator placed first so the shot never fails.
 */
function pickCloseUpModule(bp: ShipBlueprint): ShipModule | null {
  const preferred: readonly ShipModule['kind'][] = [
    'airlock',
    'docking-collar',
    'service-hatch',
    'ladder',
    'handrail',
    'toolbox',
  ];
  for (const kind of preferred) {
    const m = bp.modules.find((x) => x.present && x.kind === kind);
    if (m) return m;
  }
  return bp.modules.find((m) => m.present) ?? bp.modules[0] ?? null;
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

// ===========================================================================
// The review shots
//
// Every shot is deterministic: a pinned seed, a pinned faction and role where
// the comparison demands it, a camera expressed as a direction and a fraction
// of the frame rather than as a coordinate, and a fixed settle time.
//
// The descriptions are not documentation. They are the brief handed to the
// critic agents, and each one states WHAT TO LOOK AT and WHAT COUNTS AS A
// FAILURE, because a critic given only a picture will review the lighting.
// ===========================================================================

/** The hull almost every shot is about. One hull, many conditions. */
const HERO_SHIP: ShipParams = {
  seed: 0x5a17c0de,
  factionId: 'kessler',
  role: 'freighter',
  sizeClass: 'medium',
  ageYears: 18,
  maintenance: 0.62,
  damageLevel: 0.3,
};

/** A hull whose whole story is what has happened to it. */
const WRECK_SHIP: ShipParams = {
  seed: 0x00dd5eed,
  factionId: 'ossuary',
  role: 'salvager',
  sizeClass: 'medium',
  ageYears: 62,
  maintenance: 0.08,
  damageLevel: 0.95,
};

/**
 * Five seeds from one yard, size band pinned and role left free.
 *
 * Pinning the size class is what makes the frame judgeable: `generateFleet`
 * walks every role, which spans 27 m to 400 m and leaves the small hulls at
 * seven pixels. The DNA question is "do these look related", and that cannot
 * be answered about something too small to see.
 */
const FAMILY_FLEET: readonly ShipParams[] = [0, 1, 2, 3, 4].map((i) => ({
  seed: hashSeed(0x4c17f11e, `showroom/family/${i}`),
  factionId: 'kessler',
  sizeClass: 'medium' as const,
}));

/**
 * One hull per faction with every other variable held constant.
 *
 * Same seed, same role, same size class. Any difference in the frame is
 * faction DNA and nothing else — which is the only way the contrast test
 * proves anything.
 */
const FACTION_FLEET: readonly ShipParams[] = ['kessler', 'sillane', 'ossuary'].map((factionId) => ({
  seed: 0x00c0ffee,
  factionId,
  role: 'freighter' as const,
  sizeClass: 'medium' as const,
}));

const CRUISE: ShipDriveState = {
  throttle: 0.68,
  // Light on the boost: it is what shifts the plume white, and the plume is
  // the only cold accent on the hull.
  boost: 0.12,
  heating: 0,
  // Mostly a down-translation, so the dorsal thrusters fire broadside to the
  // camera. A thruster firing straight at the lens is not a detail.
  rcs: new Vector3(-0.24, -0.7, 0),
};

const BURN: ShipDriveState = {
  throttle: 1.0,
  boost: 0.65,
  heating: 0,
  rcs: new Vector3(0, 0, 0),
};

const COLD: ShipDriveState = {
  throttle: 0,
  boost: 0,
  heating: 0,
  rcs: new Vector3(0, 0, 0),
};

/** Key light for everything that is not a lighting test. */
const KEY_LIGHT = {
  sunDirection: [0.4, 0.74, -0.54] as Triple,
  sunColor: [1.0, 0.93, 0.82] as Triple,
  sunIntensity: 3.0,
  fillColor: [0.011, 0.015, 0.024] as Triple,
  fillDirection: [0.1, -1, 0.2] as Triple,
};

interface CameraSpec {
  /** Direction from the subject to the camera, in world space. */
  readonly dir: Triple;
  readonly fovDeg: number;
  /** Fraction of the frame's shorter half-extent the subject fills. */
  readonly fill?: number;
  /** Instead of `fill`: put the subject at this many pixels across. */
  readonly targetPixels?: number;
  /** Where the ship's centre lands in NDC. Dead centre is a turntable render. */
  readonly offsetX?: number;
  readonly offsetY?: number;
  /** Roll about the view axis. Buys a diagonal without moving the camera. */
  readonly roll?: number;
  readonly aimAt?: ShowroomAim;
}

interface ShowroomShotDef {
  readonly name: string;
  readonly description: string;
  readonly setup: ShowroomSetup;
  readonly camera: CameraSpec;
  /** Seconds of simulated drive spool before the shutter. */
  readonly settle?: number;
}

const SHOT_DEFS: readonly ShowroomShotDef[] = [
  // -- silhouette ----------------------------------------------------------
  {
    name: 'ship-silhouette-side',
    description:
      'The hero hull dead abeam, every surface replaced with a flat matte and lit by a rim ' +
      'only. LOOK AT: the profile as a drawing. Does it have a distinguishable top and ' +
      'bottom? Are there two or three masses of clearly different size, or one mass with ' +
      'bumps? Does the load path read — does the eye follow structure from the engines to ' +
      'the nose? FAILS IF: the outline is a lozenge, a tube or a wedge; the profile is ' +
      'near-symmetric about its long axis; the only things breaking the line are small ' +
      'hardware; you cannot tell which end is the front.',
    setup: { ships: [HERO_SHIP], silhouette: true, drive: COLD, ...KEY_LIGHT, sunDirection: [0.62, 0.55, -0.56] },
    camera: { dir: [1, 0.03, 0], fovDeg: 20, fill: 0.84, aimAt: 'hull' },
  },
  {
    name: 'ship-silhouette-front',
    description:
      'The hero hull head on, flat matte, rim only. LOOK AT: the cross-section. Is it a ' +
      'circle, or does it have a keel, a shoulder, a chine, a flat belly? Is the beam ' +
      'distribution deliberate — wide low and narrow high, or the reverse? Do outboard ' +
      'masses (radiators, nacelles, booms) read as a frontal shape rather than as ' +
      'clutter? FAILS IF: the frontal silhouette is a circle or a rounded rectangle; the ' +
      'ship is bilaterally identical AND vertically identical; nothing distinguishes this ' +
      'nose from any other nose in the fleet.',
    setup: { ships: [HERO_SHIP], silhouette: true, drive: COLD, ...KEY_LIGHT, sunDirection: [0.72, 0.42, -0.55] },
    camera: { dir: [0.06, 0.09, -1], fovDeg: 20, fill: 0.8, aimAt: 'hull' },
  },
  {
    name: 'ship-silhouette-three-quarter',
    description:
      'The hero hull from a high rear three-quarter, flat matte, rim only. LOOK AT: whether ' +
      'the form still reads when the side and front reads are combined — this is the angle ' +
      'that exposes a ship built as two unrelated drawings. Does the plan view have ' +
      'structure? Do masses overlap in a way that composes, or do they merge into one blob? ' +
      'FAILS IF: the three-quarter reads flatter than the side view; the hull becomes an ' +
      'undifferentiated mass; the engines are not legible as the aft termination of the ' +
      'structure.',
    setup: { ships: [HERO_SHIP], silhouette: true, drive: COLD, ...KEY_LIGHT, sunDirection: [-0.35, 0.68, 0.64] },
    camera: { dir: [0.72, 0.34, 0.6], fovDeg: 22, fill: 0.8, roll: 0.22, aimAt: 'hull' },
  },

  // -- surface -------------------------------------------------------------
  {
    name: 'ship-hero-close',
    description:
      'The frame the ship engine wants to be judged on: rear three-quarter, raking key, ' +
      'drive at cruise, composed on a diagonal. LOOK AT: whether it looks ENGINEERED. ' +
      'Panels sized to the hull rather than to a constant; wear concentrated on edges, ' +
      'around hatches and aft of thrusters rather than laid evenly; a hard terminator with ' +
      'hardware casting across plating; colour rationed to near-black steel plus one accent ' +
      'and the amber of the instruments. FAILS IF: noise is uniform over the whole hull; ' +
      'the plating reads as one projected texture across parts that should come from ' +
      'different yards; the hull is grey rather than near-black; there is more than one ' +
      'saturated hue competing.',
    setup: { ships: [HERO_SHIP], drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.714, 0.333, 0.616], fovDeg: 22, fill: 0.74, offsetX: 0.16, offsetY: 0.12, roll: 0.34, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-engine-close',
    description:
      'The drive cluster at full burn, filling the frame. LOOK AT: whether the propulsion ' +
      'is believable hardware. Bell or grid geometry appropriate to the drive technology; ' +
      'the throat visibly hotter than the outside of the bell; a plume that fades at its ' +
      'own silhouette rather than ending in a hard edge; soot on the plating aft of the ' +
      'nozzles and nowhere else; thrust structure that could actually carry the load. ' +
      'FAILS IF: the plume is a solid cone or a flat sprite; exhaust intersects the hull; ' +
      'the nozzles are bolted to nothing; the glow blooms into a shapeless white mass.',
    setup: { ships: [HERO_SHIP], drive: BURN, ...KEY_LIGHT, sunDirection: [0.55, 0.5, -0.67] },
    camera: { dir: [0.62, 0.36, 0.7], fovDeg: 34, fill: 0.72, offsetX: 0.1, aimAt: 'engine' },
    settle: 4,
  },
  {
    name: 'ship-greeble-close',
    description:
      'Crew hardware at arm\'s length — a frame roughly four decks across, so anything ' +
      'human-scale is unmissable. LOOK AT: whether the small forms are ASSEMBLIES rather than boxes and ' +
      'cylinders. Count distinct silhouettes: fewer than four and the scatter will read as ' +
      'tiling. Look for hatches with lips, brackets with gussets, pipes with flanges, ' +
      'handrails a person could hold. Check the contact shadow under each piece — detail ' +
      'that does not darken the plate beneath it reads as a decal. FAILS IF: two silhouettes ' +
      'repeat across the frame; nothing is at human scale; the detail floats.',
    setup: { ships: [HERO_SHIP], drive: CRUISE, ...KEY_LIGHT, sunDirection: [0.32, 0.62, -0.72] },
    camera: { dir: [0.66, 0.46, 0.6], fovDeg: 38, fill: 0.7, roll: 0.15, aimAt: 'hardware' },
    settle: 3,
  },

  // -- lighting ------------------------------------------------------------
  {
    name: 'ship-dark-side',
    description:
      'The hull against black space with the key behind it and almost no fill — the ' +
      'hardest frame in the game. LOOK AT: whether the shadow side stays READABLE without ' +
      'becoming either black mud or a flat grey wash. There should be a hard terminator, a ' +
      'grazing sheen along the upper edges, and the ship\'s own running lights and lit ' +
      'windows doing the separating. FAILS IF: the unlit half is a featureless silhouette; ' +
      'or the unlit half is lifted by an ambient term that does not exist in space; or the ' +
      'ship disappears entirely against the background.',
    setup: {
      ships: [HERO_SHIP],
      drive: CRUISE,
      sunDirection: [-0.62, 0.36, -0.7],
      sunColor: [1.0, 0.93, 0.82],
      sunIntensity: 3.0,
      fillColor: [0.004, 0.005, 0.008],
      fillDirection: [0, -1, 0],
    },
    camera: { dir: [0.78, 0.2, 0.59], fovDeg: 24, fill: 0.72, offsetX: -0.12, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-star-rimlight',
    description:
      'Backlit: the star almost directly behind the hull, six times the hero intensity. ' +
      'LOOK AT: the rim. A hard, thin, wrapping highlight that traces the true outline, ' +
      'broken where the form breaks, brightest on edges square to the light. This is the ' +
      'test of whether the grazing sheen term exists and whether the silhouette survives ' +
      'contact with a bright background. FAILS IF: the rim is a soft even glow all the way ' +
      'round; the whole hull washes out; bloom eats the outline; or there is no rim at all ' +
      'and the ship is a black cut-out.',
    setup: {
      ships: [HERO_SHIP],
      drive: CRUISE,
      sunDirection: [-0.16, 0.12, -0.98],
      sunColor: [1.0, 0.95, 0.88],
      sunIntensity: 6.0,
      fillColor: [0.006, 0.008, 0.013],
      fillDirection: [0, -1, 0.1],
    },
    camera: { dir: [0.12, 0.1, 0.98], fovDeg: 24, fill: 0.7, roll: -0.18, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-planetshine',
    description:
      'A weak star and a strong cool fill arriving from below, as it does over a lit ' +
      'world. LOOK AT: whether the belly fills from underneath and the upper flank stays ' +
      'properly dark — planetshine is a hemisphere from one side, not an ambient constant. ' +
      'The undersides of gear, pods and radiators should be the brightest thing in frame. ' +
      'FAILS IF: the fill lands equally on the top and the bottom of the hull; the shadows ' +
      'gain blue on top of the grade\'s own cool shadow tint and go cyan; the hull flattens ' +
      'into a single value.',
    setup: {
      ships: [HERO_SHIP],
      drive: CRUISE,
      sunDirection: [0.44, 0.66, -0.6],
      sunColor: [1.0, 0.93, 0.82],
      sunIntensity: 0.55,
      fillColor: [0.11, 0.14, 0.22],
      fillDirection: [0.05, -1, 0.12],
    },
    camera: { dir: [0.7, 0.12, 0.7], fovDeg: 24, fill: 0.72, offsetY: 0.14, aimAt: 'hull' },
    settle: 3,
  },

  // -- scale ---------------------------------------------------------------
  {
    name: 'ship-docking-scale',
    description:
      'A suited figure (1.8 m) and a standard freight container (12.2 m) standing off the ' +
      'hull\'s port flank, framed on THEM rather than on the ship, with plating filling the ' +
      'background. LOOK AT: whether the ship\'s own detail AGREES with the reference. ' +
      'Hatches should be about the figure\'s height, handrails about waist height, deck ' +
      'bands about 2.6 m apart, windows in rows that match those bands, hull plates a few ' +
      'figures across. FAILS IF: the hull behind the figure has no feature at all whose ' +
      'size can be checked; hatch, window or plate size contradicts the figure; the plating ' +
      'is so coarse or so fine that the hull could be any length; the reference objects are ' +
      'the only human-scale things in frame.',
    setup: { ships: [HERO_SHIP], drive: COLD, scaleReference: true, ...KEY_LIGHT },
    camera: { dir: [-0.88, 0.2, 0.43], fovDeg: 30, fill: 0.72, offsetX: -0.18, offsetY: 0.06, aimAt: 'scale' },
    settle: 2,
  },

  // -- fleets --------------------------------------------------------------
  {
    name: 'ship-fleet-family',
    description:
      'Five seeds from one yard (Kessler), size band pinned, role left free. THE DNA TEST, ' +
      'and it has two halves that pull against each other. LOOK AT: (1) do these five read ' +
      'as coming from the same builder — shared construction language, joint style, ' +
      'proportion habits, radiator architecture, nozzle family; and (2) are they genuinely ' +
      'FIVE SHIPS rather than one ship with the parts moved. FAILS IF: you cannot name a ' +
      'single shared trait; or you can name the shared traits but the hulls differ only in ' +
      'where the bolt-ons landed; or the role of each is unguessable.',
    setup: { ships: FAMILY_FLEET, drive: COLD, spacing: 1.15, ...KEY_LIGHT },
    camera: { dir: [0.12, 0.5, 0.86], fovDeg: 32, fill: 0.9, aimAt: 'layout' },
    settle: 2,
  },
  {
    name: 'ship-fleet-factions',
    description:
      'One hull from each of the three factions, with EVERY other variable held constant: ' +
      'same seed, same role (freighter), same size class. Left to right: Kessler, Sillane, ' +
      'Ossuary. THE CONTRAST TEST — any difference you can see is faction DNA and nothing ' +
      'else. LOOK AT: whether the three are distinguishable at a glance as black shapes, ' +
      'and whether the differences are DOCTRINAL (welded plate versus cast monocoque versus ' +
      'salvage) rather than cosmetic. FAILS IF: the three differ only in paint; or one is ' +
      'obviously the same mesh with a different palette; or the differences are random ' +
      'rather than attributable to how that culture builds.',
    setup: { ships: FACTION_FLEET, drive: COLD, spacing: 1.25, ...KEY_LIGHT },
    camera: { dir: [0.2, 0.42, 0.88], fovDeg: 30, fill: 0.88, aimAt: 'layout' },
    settle: 2,
  },

  // -- history -------------------------------------------------------------
  {
    name: 'ship-damage-history',
    description:
      'A sixty-year-old Ossuary breaker at eight per cent maintenance: heavy damage, heavy ' +
      'repair, several refits. LOOK AT: whether the history is legible AS GEOMETRY and as a ' +
      'TIMELINE. A patch plate should sit proud of the hull, in the wrong shade, with its ' +
      'own fastener ring. A torn-off module should leave mounting stubs. A bent strut should ' +
      'be bent. Fresh damage should be bright metal with sharp edges; old damage should be ' +
      'oxidised, dirt-filled and soft. FAILS IF: the damage is only a texture; every wound ' +
      'is the same age; wounds are radially uniform instead of directional; the repairs are ' +
      'as tidy as the hull.',
    setup: { ships: [WRECK_SHIP], drive: COLD, ...KEY_LIGHT, sunDirection: [0.5, 0.6, -0.62] },
    camera: { dir: [0.68, 0.3, 0.67], fovDeg: 26, fill: 0.8, offsetX: 0.1, roll: 0.14, aimAt: 'hull' },
    settle: 2,
  },

  // -- quality tiers -------------------------------------------------------
  {
    name: 'ship-low-quality',
    description:
      'The hero hull and the hero camera, rebuilt at the LOW quality tier. Compare directly ' +
      'against ship-medium-quality and ship-high-quality. LOOK AT: whether the ship is still ' +
      'the same ship. Silhouette, proportion, the two or three primary masses and the wear ' +
      'STORY must survive; only density of small detail is allowed to go. FAILS IF: the ' +
      'silhouette changes; the hull changes colour or value; wear becomes uniform; the ship ' +
      'becomes unrecognisable as the same vessel.',
    setup: { ships: [HERO_SHIP], quality: 'low', drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.714, 0.333, 0.616], fovDeg: 22, fill: 0.74, offsetX: 0.16, offsetY: 0.12, roll: 0.34, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-medium-quality',
    description:
      'The hero hull and the hero camera at the MEDIUM tier. The middle term of the ' +
      'three-way quality comparison. LOOK AT: that it sits genuinely between low and high ' +
      'rather than matching one of them — a tier that changes nothing is a tier that is not ' +
      'implemented. FAILS IF: indistinguishable from either neighbour; or the step from low ' +
      'is larger than the step to high.',
    setup: { ships: [HERO_SHIP], quality: 'medium', drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.714, 0.333, 0.616], fovDeg: 22, fill: 0.74, offsetX: 0.16, offsetY: 0.12, roll: 0.34, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-high-quality',
    description:
      'The hero hull and the hero camera at the HIGH tier — the reference frame for the ' +
      'quality comparison and the one the budgets in BRIEF §6 are stated against. LOOK AT: ' +
      'the draw-call and triangle counts in the manifest beside this frame (≤ 12 calls, ' +
      '≤ 120k triangles for a medium hull) and whether the picture justifies them. FAILS IF: ' +
      'the budgets are exceeded; or they are met and the frame looks no better than medium.',
    setup: { ships: [HERO_SHIP], quality: 'high', drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.714, 0.333, 0.616], fovDeg: 22, fill: 0.74, offsetX: 0.16, offsetY: 0.12, roll: 0.34, aimAt: 'hull' },
    settle: 3,
  },

  // -- level of detail -----------------------------------------------------
  {
    name: 'ship-lod0',
    description:
      'LOD0 forced, framed so the hull spans most of the frame — the distance band LOD0 ' +
      'actually serves. The control frame for the LOD comparison. LOOK AT: full detail, and ' +
      'note where the detail LIVES so you can tell what LOD1 and LOD2 remove. FAILS IF: ' +
      'detail is spread evenly rather than concentrated where the form needs it.',
    setup: { ships: [HERO_SHIP], lod: 0, drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.7, 0.3, 0.65], fovDeg: 24, fill: 0.8, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-lod1',
    description:
      'LOD1 forced, same camera as ship-lod0 so the two can be flipped between. LOOK AT: ' +
      'what was dropped. At this level the ship should span roughly 120–400 px in play, so ' +
      'sub-metre hardware may go, but the primary and secondary masses must be untouched. ' +
      'FAILS IF: the silhouette changes at all; a mass disappears; the value of the hull ' +
      'shifts; you can identify the transition from this frame alone.',
    setup: { ships: [HERO_SHIP], lod: 1, drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.7, 0.3, 0.65], fovDeg: 24, fill: 0.8, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-lod2',
    description:
      'LOD2 forced, same camera again. This is the ≤ 3k triangle level, shown far closer ' +
      'than it would ever be seen, deliberately: a defect invisible at thirty pixels is ' +
      'still a defect. LOOK AT: whether the SILHOUETTE is preserved — that is the only ' +
      'thing that matters at this level — and whether the surface still holds the hull\'s ' +
      'overall value so it does not flicker brighter or darker when it swaps in. FAILS IF: ' +
      'the outline visibly simplifies; the ship changes brightness; whole masses collapse.',
    setup: { ships: [HERO_SHIP], lod: 2, drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.7, 0.3, 0.65], fovDeg: 24, fill: 0.8, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-extreme-distance',
    description:
      'The hull at impostor range, framed so it spans about thirty pixels of a 1080-line ' +
      'frame — the distance at which the ship becomes one quad. LOOK AT: whether it still ' +
      'reads as a SHIP and not as a bright dot or a grey smear; whether its value is ' +
      'plausible against black space; whether the navigation lights and the drive are what ' +
      'carry the read at this size, as they would in reality. FAILS IF: the ship vanishes; ' +
      'it aliases into a shimmering speck; it is brighter than a nearby star; or it is still ' +
      'drawing full geometry, which the manifest\'s triangle count will show.',
    setup: { ships: [HERO_SHIP], lod: 3, drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.7, 0.26, 0.66], fovDeg: 24, targetPixels: 30, aimAt: 'hull' },
    settle: 3,
  },
];

/**
 * Name and critic brief for every showroom shot, as plain data.
 *
 * Exported so `scripts/ship-review.mjs` can build its manifest without booting
 * a browser, and so the strings live in exactly one place. If the two ever
 * disagree, a critic reviews one frame against another frame's brief.
 */
export const SHOWROOM_SHOTS: readonly { readonly name: string; readonly description: string }[] =
  SHOT_DEFS.map((s) => ({ name: s.name, description: s.description }));

/** Every showroom shot name, in capture order. */
export const SHOWROOM_SHOT_NAMES: readonly string[] = SHOT_DEFS.map((s) => s.name);

const _camDir = new Vector3();
const _target = new Vector3();
const _aimPoint = new Vector3();
const _axisX = new Vector3();
const _axisY = new Vector3();
const _axisZ = new Vector3();
const _worldUp = new Vector3(0, 1, 0);

/**
 * Place the camera from a direction and a fraction of the frame.
 *
 * Expressed this way rather than as a coordinate so that every shot is
 * scale-invariant: the same spec frames a 30 m courier and a 4 km capital
 * identically, which is exactly what ANALYSIS §6.7 says the hero rig in
 * `Ship.ts` failed to do.
 */
function placeCamera(ctx: EngineContext, spec: CameraSpec, radiusKm: number, aimPoint: Vector3): void {
  ctx.camera.fov = spec.fovDeg;
  ctx.camera.updateProjectionMatrix();

  const halfV = Math.tan((spec.fovDeg * Math.PI) / 360);
  const halfH = halfV * Math.max(ctx.camera.aspect, 1e-3);
  // Fit against whichever half-extent binds, so a wide subject in a wide frame
  // is not clipped by the vertical fit.
  const bind = Math.min(halfV, halfH);

  let distance: number;
  if (spec.targetPixels !== undefined) {
    // pixels = 2 * radius / distance * (height / (2 * tan(fovY/2)))
    const k = ctx.height / (2 * halfV);
    distance = (2 * radiusKm * k) / Math.max(spec.targetPixels, 1);
  } else {
    distance = radiusKm / Math.max((spec.fill ?? 0.8) * bind, 1e-6);
  }

  _camDir.set(spec.dir[0], spec.dir[1], spec.dir[2]).normalize();
  ctx.camera.position.copy(aimPoint).addScaledVector(_camDir, distance);

  // Aim past the subject by the frame's half-extents at the subject's
  // distance, so the offsets read directly in NDC.
  _axisZ.copy(_camDir);
  _axisX.crossVectors(_worldUp, _axisZ).normalize();
  _axisY.crossVectors(_axisZ, _axisX);
  const hy = distance * halfV;
  const hx = hy * Math.max(ctx.camera.aspect, 1e-3);
  _target
    .copy(aimPoint)
    .addScaledVector(_axisX, -(spec.offsetX ?? 0) * hx)
    .addScaledVector(_axisY, -(spec.offsetY ?? 0) * hy);

  ctx.camera.lookAt(_target);
  // Roll about the camera's own view axis: pure screen-space rotation, so the
  // lighting on the hull is untouched and the ship runs on a diagonal.
  if (spec.roll) ctx.camera.rotateZ(spec.roll);
  ctx.camera.updateMatrixWorld(true);
}

/**
 * Register every showroom shot.
 *
 * The showroom must already be added to the engine as a module — the shots
 * configure it and drive it, but they do not own it, because a shot that owned
 * a five-ship fleet would rebuild it every time the harness switched frames.
 */
export function registerShowroomShots(showroom: Showroom): void {
  for (const def of SHOT_DEFS) {
    registerShot({
      name: def.name,
      description: def.description,
      apply(ctx) {
        showroom.enter(ctx);
        showroom.configure(ctx, def.setup);
        const radius = showroom.aim(def.camera.aimAt ?? 'hull', _aimPoint);
        placeCamera(ctx, def.camera, radius, _aimPoint);
        // Spool before the shutter. Every damped value on a drive starts at
        // zero, so a shot captured cold photographs a powered-down hull no
        // matter which drive state it asked for.
        showroom.settle(ctx, def.settle ?? 1);
      },
      update(dt, ctx) {
        // Nothing else drives these hulls: the pilot has stood down for the
        // duration of the shot, so without this the throttle, the plume and
        // the RCS all stay at their constructor zero.
        showroom.update(dt, ctx);
      },
      teardown() {
        showroom.exit();
      },
    });
  }
}
