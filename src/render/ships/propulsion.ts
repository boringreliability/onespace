/**
 * oneSpace — ship propulsion and VFX.
 *
 * Everything that burns, puffs or blinks: main-drive nozzles, exhaust plumes,
 * RCS jets, navigation/beacon/docking lights and the re-entry wake. It reads a
 * `ShipBlueprint` and nothing else, and it visualises what the blueprint says
 * rather than inventing hardware.
 *
 * THE FIVE DECISIONS THIS FILE IS BUILT ON
 *
 * 1. **The plume is extruded in the vertex shader.** Every plume vertex is
 *    authored at the nozzle mouth and pushed out along the exhaust axis by
 *    per-instance attributes. Length, width, taper, wobble and shock spacing
 *    are therefore free to animate: no geometry is ever rebuilt, and a 5 km
 *    torch and a 0.4 m attitude jet share one buffer.
 *
 * 2. **Drive technology is a SHAPE, not a tint.** A fusion torch is a long
 *    collimated column off a deep bell; an ion drive is a flat perforated grid
 *    with a wide, faint, diverging fan and no shock structure at all; a
 *    reaction plate is a disc with no nozzle that flashes in discrete
 *    detonations. If the only difference between two drives were their colour
 *    this file would have failed its brief.
 *
 * 3. **Two materials, four draw calls — a HARD bound, not a typical case.**
 *    BRIEF §6 allows three materials per ship and `ShipMaterial.ts` owns one of
 *    them, so propulsion owns exactly two: an opaque nozzle material (the only
 *    thing here that needs `DoubleSide` + `gl_FrontFacing`) and ONE additive
 *    material shared by plumes, jets, lights and the wake, branching on a
 *    per-instance `iKind`. Everything is instanced; a ten-engine capital costs
 *    the same number of draw calls as a single-engine courier.
 *
 *    The bound per rung is now structural rather than incidental:
 *
 *      LOD0  nozzles + fittings + plume + emitter quads  = 4  (+1 re-entry wake)
 *      LOD1  nozzles + plume + emitter quads             = 3  (+1 re-entry wake)
 *      LOD2  nozzles + plume + emitter quads             = 3
 *      LOD3  plume + emitter quads                       = 2
 *
 *    Four is the FLOOR at LOD0, and the reason is worth writing down because it
 *    is the reason not to keep pushing: the opaque pair and the additive pair
 *    each need two different geometries (a bell and a cup; a cone shell and a
 *    quad), and an `InstancedMesh` draws exactly one. Folding either pair into
 *    a single masked buffer was measured on the hero and rejected — see
 *    `mergeNozzleShapes`.
 *
 * 4. **Nothing is authored in metres.** Nozzle geometry is built in a unit
 *    envelope (exit radius 1, length 1) and scaled per instance, and every
 *    noise frequency in the nozzle shader is evaluated in that unit space. A
 *    4 km capital's bell therefore gets the same corrugation pitch *relative
 *    to itself* as a courier's, instead of the 133×-too-fine grain that
 *    kilometre-space constants would give it.
 *
 * 5. **Emitters carry a screen-space floor.** A navigation light on a 4 km
 *    hull is a sub-pixel object at any range you would actually look at the
 *    ship from. Each emitter quad is expanded in the vertex shader so it never
 *    falls below a few pixels, which is what makes a capital read as inhabited
 *    instead of as an unlit slab.
 *
 * 6. **Propulsion has its own LOD ladder, on the hull's thresholds.** It used
 *    to build one set of meshes and draw them from arm's length to the horizon,
 *    which put 3.4–11.9 k triangles on a LOD2 ship whose whole budget is 3 k.
 *    Four rungs are built lazily from one staged set of instance data — the
 *    same bells in the same places, tessellated differently and packed into
 *    fewer meshes — and only the drawing one is parented. `setLod` is the
 *    entry point; see `rungPlan` for what each rung sheds and why.
 *
 * SCENE CONTRACT. The scene is linear HDR and `PostFX` owns the tone map:
 * every material here is `toneMapped: false` with no `<tonemapping_fragment>`,
 * no `<colorspace_fragment>` and no `os_dither`. All four `logdepthbuf` chunks
 * are present in every program — the engine runs a logarithmic depth buffer and
 * a material that omits them sorts wrongly against every planet in the game.
 *
 * UNITS: kilometres, seconds, linear RGB. Ship-local frame is -Z forward,
 * +Y up, +X starboard; an engine's `frame.forward` is the EXHAUST direction.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Object3D,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';

import type { EngineContext } from '@/core/Engine';
import type { QualitySettings, QualityTier } from '@/core/Config';
import type { ViewState } from '@/render/ViewState';
import { registerShaderChunks } from '@/shaders/chunks';
// Human-scale reference, read as a VALUE and not only as a type: nozzle
// subdivision is derived from it. See `nozzleScale`.
import { DECK_HEIGHT_KM } from '@/gen/ships/types';
import type {
  EnginePod,
  Frame,
  NozzleStyle,
  RcsGroup,
  ShipBlueprint,
  TechnologyProfile,
} from '@/gen/ships/types';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * What the pilot is asking the drive to do, this frame.
 *
 * Deliberately separate from `ViewState`: `ViewState` says where the camera and
 * the star are, this says what the ship is doing. `Ship.ts`'s `ShipState` is
 * the ancestor of this type and is a genuinely good little contract; this adds
 * the two things a *generated* ship needs that the hero ship did not — an
 * angular command (so the blueprint's `RcsGroup` couples can be honoured rather
 * than guessed from geometry) and a power flag (so lights come up with the bus
 * rather than being permanently on).
 *
 * NOTE FOR THE INTEGRATOR: this type is declared here because nothing in
 * `gen/ships/types.ts` declares it and that layer is published/append-only. If
 * it belongs upstream, move it there and re-export from here.
 */
export interface ShipDriveState {
  /** Main engine demand, 0..1. */
  readonly throttle: number;
  /** Overdrive on top of throttle, 0..1. Shifts the plume white-hot. */
  readonly boost: number;
  /** Re-entry heating, 0..1. Drives the plasma wake. */
  readonly heating: number;
  /**
   * Commanded TRANSLATION in ship-local space, roughly -1..1 per axis.
   * A thruster fires when it belongs to a group this vector demands.
   */
  readonly translation: Vector3;
  /**
   * Commanded ROTATION, roughly -1..1 per axis: x = pitch, y = yaw, z = roll.
   * Gimballed main nozzles track pitch and yaw from this too.
   */
  readonly angular: Vector3;
  /** Main bus live. Navigation lights, beacons and throat glow fade with it. */
  readonly powered: boolean;
}

/** A reusable, mutable `ShipDriveState` so the caller's frame loop allocates nothing. */
export class MutableShipDriveState implements ShipDriveState {
  throttle = 0;
  boost = 0;
  heating = 0;
  readonly translation = new Vector3();
  readonly angular = new Vector3();
  powered = true;
}

/**
 * Slots in the fake plume-lighting uniform block.
 *
 * One slot per engine POD, not per nozzle: a cluster of four bells is one light
 * source at any distance you can see the hull glow from, and the eight largest
 * pods are the only ones whose wash is legible anyway. `Ship.ts` had exactly
 * two (`uEngineA`/`uEngineB`) and broke on any ship that was not a twin.
 */
export const ENGINE_GLOW_MAX = 8;

/**
 * GLSL for the hull material to include.
 *
 * "Plumes must light the hull around them" — but a real light per engine is a
 * shadow-mapped, per-fragment cost for something the eye reads as a gradient.
 * This is the gradient: an analytic wash from up to eight column sources,
 * ~10 ALU each, with the falloff length supplied as a uniform so it tracks the
 * plume's own length instead of being a hard-coded metre count (the mistake
 * `Ship.ts` made with `exp(-d * 260.0)`, an e-folding of 3.85 m baked against a
 * 30 m hull).
 *
 * `chunks.ts` is integrator-owned so this cannot be registered as a real
 * `#include` chunk. Concatenate it into the hull fragment shader and alias
 * `ShipPropulsion.engineGlowUniforms` into the hull material's uniform object
 * BY REFERENCE — the values are refreshed in place every frame and must never
 * be copied.
 */
export const ENGINE_GLOW_GLSL = /* glsl */ `
#ifndef SHIP_ENGINE_GLOW_MAX
#define SHIP_ENGINE_GLOW_MAX ${ENGINE_GLOW_MAX}
#endif
uniform vec4  uEngineGlow[SHIP_ENGINE_GLOW_MAX];      // xyz = mouth, w = strength
uniform vec3  uEngineGlowDir[SHIP_ENGINE_GLOW_MAX];   // unit exhaust axis
uniform vec3  uEngineGlowColor;
uniform float uEngineGlowRange;                       // e-folding length, km

/** Radiance added to a hull fragment by the drive plumes. P and N are ship-local. */
vec3 shipEngineGlow(vec3 P, vec3 N) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < SHIP_ENGINE_GLOW_MAX; i++) {
    vec4 g = uEngineGlow[i];
    if (g.w <= 1e-5) continue;
    vec3 d = g.xyz - P;
    float dist = max(length(d), 1e-7);
    vec3 L = d / dist;
    // A plume is a column lying aft of the mouth, so plating that faces INTO
    // the column is washed and plating on the far side of the ship is not.
    // Without this term the whole hull lifts uniformly and reads as ambient.
    float side = clamp(dot(-L, uEngineGlowDir[i]) * 0.5 + 0.5, 0.0, 1.0);
    sum += uEngineGlowColor * g.w
         * exp(-dist / max(uEngineGlowRange, 1e-7))
         * max(dot(N, L), 0.0)
         * mix(0.30, 1.0, side);
  }
  return sum;
}
`;

/** The uniform object `ENGINE_GLOW_GLSL` expects. Alias it; never copy it. */
export interface EngineGlowUniforms {
  readonly uEngineGlow: { value: Float32Array };
  readonly uEngineGlowDir: { value: Float32Array };
  readonly uEngineGlowColor: { value: Color };
  readonly uEngineGlowRange: { value: number };
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

interface Budget {
  /** Radial segments round a nozzle. Screen-space property: does NOT grow with the hull. */
  readonly nozzleSeg: number;
  /** Radial segments round a plume shell. */
  readonly plumeSeg: number;
  /** Axial steps along a plume shell. */
  readonly plumeSteps: number;
  /** Nested shells. Two is the minimum that reads as a core inside a envelope. */
  readonly plumeLayers: number;
  readonly wakeSeg: number;
  readonly wakeSteps: number;
  /** Emissive quads never fall below this on screen. */
  readonly minLightPixels: number;
}

const BUDGETS: Record<QualityTier, Budget> = {
  // plumeSeg is the one number in this table that must not be economised.
  // A shell has no interior detail: its silhouette IS the effect, and at 8–14
  // segments a plume seen anywhere near its own axis is a visible polygon.
  low: { nozzleSeg: 10, plumeSeg: 12, plumeSteps: 6, plumeLayers: 1, wakeSeg: 12, wakeSteps: 8, minLightPixels: 2.2 },
  medium: { nozzleSeg: 14, plumeSeg: 16, plumeSteps: 8, plumeLayers: 2, wakeSeg: 16, wakeSteps: 10, minLightPixels: 2.4 },
  high: { nozzleSeg: 18, plumeSeg: 20, plumeSteps: 9, plumeLayers: 2, wakeSeg: 24, wakeSteps: 13, minLightPixels: 2.6 },
  ultra: { nozzleSeg: 24, plumeSeg: 24, plumeSteps: 11, plumeLayers: 2, wakeSeg: 28, wakeSteps: 15, minLightPixels: 2.6 },
};

/**
 * What propulsion draws at one rung of the LOD ladder.
 *
 * This file used to have no idea what LOD the ship was at: it built one set of
 * meshes in the constructor and drew them from arm's length to the horizon.
 * Measured over ten seeds, its triangle contribution was the SAME NUMBER at
 * LOD0, LOD1, LOD2 and LOD3 — 3.4 k to 11.9 k — against a LOD2 budget of 3 k
 * for the whole ship (BRIEF §6), so propulsion alone was 1.8× to 4.8× over on
 * every seed and the hull's ladder was being thrown away.
 *
 * The rungs shed, in this order, the things whose absence you cannot see at
 * the distance the rung serves:
 *
 *   LOD1  the bolted hardware — thrust frames, turbopumps, yokes, gantry pads.
 *         It is a lattice of 3–7 segment tubes and it is ~60% of a bell's
 *         triangles; below a few hundred pixels of hull it is one grey smudge.
 *         Plume drops to a single shell, which changes its DEPTH, not its size.
 *         ALSO every fitting — the RCS cups and the lamp housings. This used to
 *         happen at LOD2 and it was a rung too late. Measured across 21 hulls
 *         (hero, 8 roles × medium/capital, 3 factions) at each hull's own LOD1
 *         threshold of `lengthKm * 25`, 1080p and a 50° vertical field: the
 *         LARGEST fitting on ANY of them is 0.78 px across and the smallest is
 *         0.02 px. Every one is sub-pixel, most by more than an order of
 *         magnitude, while the bells beside them are 1.1–7.7 px and stay. The
 *         emitters are untouched — the lamps and the jets live in the quad mesh
 *         and carry a screen-space pixel floor, so a distant ship still lights
 *         and still puffs; what goes is the machined body behind them. Worth
 *         one draw call and ~2.2 k triangles at the rung whose whole-ship
 *         budget is 25 k and whose hull already spends 19.7 k of it.
 *   LOD2  the engine wash cards, the re-entry wake, and every nozzle profile
 *         but the dominant one: one simplified bell serves the whole ship.
 *   LOD3  the nozzles themselves. At impostor range the drive IS the plume and
 *         a handful of navigation lights, which is exactly what the brief says
 *         should carry the read at thirty pixels.
 */
interface RungPlan {
  /** Draw nozzle hardware at all. */
  readonly nozzles: boolean;
  readonly nozzleSeg: number;
  /** Frames, pumps, yokes, ribs, blocks: 2 full, 1 outline only, 0 none. */
  readonly nozzleDetail: number;
  /** One simplified nozzle mesh for the whole ship instead of one per style. */
  readonly mergeStyles: boolean;
  readonly plumeSeg: number;
  readonly plumeSteps: number;
  readonly plumeLayers: number;
  /**
   * How many fittings (RCS cups, then lamp housings) survive. -1 keeps all of
   * them, 0 none. A capital's fitting list runs to hundreds and each one is a
   * closed cup of 8 × (seg/2) triangles, so this is the second-largest item in
   * the budget after the bells themselves — and, because the fittings are the
   * only thing in this file that needs a SECOND opaque geometry, it is also a
   * whole draw call. Non-zero at LOD0 only; see the rung table above for the
   * pixel measurement that put the cut there.
   */
  readonly fixtureLimit: number;
  /**
   * How many emissive quads survive. -1 keeps all of them; a finite limit keeps
   * the HEAD of the buffer, which is where the navigation lights live — the RCS
   * jets and the wash cards are staged behind them precisely so a cap drops
   * those two first.
   */
  readonly quadLimit: number;
  readonly wake: boolean;
}

function rungPlan(b: Budget, level: number, crowded: boolean): RungPlan {
  if (level <= 0) {
    return {
      nozzles: true,
      nozzleSeg: b.nozzleSeg,
      nozzleDetail: 2,
      mergeStyles: false,
      // A shell has no interior detail: its silhouette IS the effect, and at
      // 8–14 segments a plume seen anywhere near its own axis is a visible
      // polygon. Segments are the cheapest thing in this budget.
      plumeSeg: crowded ? Math.max(10, b.plumeSeg >> 1) : b.plumeSeg,
      plumeSteps: crowded ? Math.max(5, ((b.plumeSteps * 2) / 3) | 0) : b.plumeSteps,
      plumeLayers: crowded ? 1 : b.plumeLayers,
      fixtureLimit: -1,
      quadLimit: -1,
      wake: true,
    };
  }
  if (level === 1) {
    return {
      nozzles: true,
      nozzleSeg: Math.max(8, Math.round(b.nozzleSeg * 0.6)),
      nozzleDetail: 1,
      mergeStyles: false,
      plumeSeg: Math.max(10, Math.round(b.plumeSeg * (crowded ? 0.5 : 0.68))),
      plumeSteps: Math.max(4, Math.round(b.plumeSteps * 0.6)),
      plumeLayers: 1,
      // Sub-pixel on every hull measured at this rung's own threshold. See the
      // rung table on `RungPlan`.
      fixtureLimit: 0,
      quadLimit: -1,
      wake: true,
    };
  }
  if (level === 2) {
    return {
      nozzles: true,
      nozzleSeg: 5,
      nozzleDetail: 0,
      mergeStyles: true,
      plumeSeg: 6,
      plumeSteps: crowded ? 2 : 3,
      plumeLayers: 1,
      fixtureLimit: 0,
      quadLimit: 24,
      wake: false,
    };
  }
  return {
    nozzles: false,
    nozzleSeg: 5,
    nozzleDetail: 0,
    mergeStyles: true,
    plumeSeg: 5,
    plumeSteps: 2,
    plumeLayers: 1,
    fixtureLimit: 0,
    quadLimit: 12,
    wake: false,
  };
}

/**
 * Base plume radiance, before the per-surface division.
 *
 * A ray through the column crosses two faces per nested shell and every one of
 * them adds, so the number that actually reaches the framebuffer is this over
 * `layers * 2`. That division used to be baked into the per-instance attribute,
 * which made it impossible for two LOD rungs with different shell counts to
 * share one staged batch; it is now the `uPlumeGain` uniform, pushed with the
 * rest of the per-ship values. Adding a shell must make the column DEEPER, not
 * brighter.
 */
const PLUME_RADIANCE = 0.62;

/**
 * Above this many nozzles the plume tessellation is halved.
 *
 * A ten-pod capital with four bells each is 40 plume instances of pure additive
 * overdraw. The silhouette of one plume in a rank of forty is not what anyone
 * is looking at; the rank as a whole is.
 */
const PLUME_CROWD_THRESHOLD = 10;

/**
 * Distinct nozzle PROFILES one merged nozzle mesh keeps.
 *
 * The nozzles used to be split into one `InstancedMesh` per distinct
 * `NozzleStyle`, which made propulsion's draw-call count a function of the
 * blueprint's engine doctrine — 1 for every ship the generator makes today,
 * but 6 for a hull that mixed them, and nothing anywhere bounded it. That is
 * the one place in this file where a per-ship property could buy a draw call,
 * and BRIEF §6 is a hard ceiling of 12 for the whole ship.
 *
 * It is now always exactly one mesh: the profiles present are concatenated into
 * one buffer and each instance selects its own with `iShape` (see
 * `mergeNozzleShapes`). The cap is on how many profiles that buffer holds,
 * because a masked vertex is still a shaded vertex and a masked triangle is
 * still a triangle `renderer.info` counts — and `ShipMesh.propulsionTriangles`
 * subtracts that count from the greeble budget, so unbounded masking would take
 * detail off the hull to save a call. Two is what a mixed hull actually needs:
 * a yard's own doctrine plus the one odd drive a wreck was repaired with.
 * Instances of any rarer style are drawn with the dominant profile.
 */
const MAX_NOZZLE_SHAPES = 2;

/** Hard cap on emissive fixtures. A super-capital's navlight list can be long. */
const MAX_LIGHTS = 320;

/** Hard cap on drawn RCS nozzles. */
const MAX_JETS = 128;

/** Reference hull length the temporal constants were authored against, km. */
const REFERENCE_LENGTH_KM = 0.03;

/** Additive kinds, matched by the shared shader's `iKind` branch. */
const KIND_PLUME = 0;
const KIND_JET = 1;
const KIND_LIGHT = 2;
const KIND_WAKE = 3;
const KIND_WASH = 4;

/**
 * How much wider than its lens a fixture's spill card is.
 *
 * A navigation light has to do two jobs that want opposite radiances: the lens
 * has to stay UNDER the tone map's white point or it clips to white and loses
 * the one thing that makes it a navigation light (its colour), and the spill
 * has to land on the plating around it. One quad cannot do both, so the quad is
 * sized for the spill and the lens is a small bright disc inside it.
 */
const LIGHT_HALO_SCALE = 7.0;

/** At most this many RCS nozzles pointing the same way may fire at once. */
const MAX_JETS_PER_DIRECTION = 2;

/** Emissive blink patterns, matched by the shared fragment shader. */
const PATTERN_STEADY = 0;
const PATTERN_STROBE = 1;
const PATTERN_BEACON = 2;
const PATTERN_GUIDE = 3;

/** Drive technology, as a float the shader can branch on. */
const DRIVE_TECH: Record<TechnologyProfile['drive'], number> = {
  chemical: 0,
  ion: 1,
  'fusion-torch': 2,
  plasma: 3,
  'reaction-plate': 4,
};

/**
 * Plume proportion per drive technology: `[lengthMultiplier, exitFit]`.
 *
 * The blueprint gives `lengthRatio` per pod, which varies the drive within a
 * culture. These multipliers are what keep the five technologies apart when two
 * factions happen to land on similar ratios — an ion drive must never be able
 * to look like a short fat chemical plume, whatever the seed says.
 *
 * THE SECOND NUMBER USED TO BE GIRTH AND IS NOW A BOUNDARY CONDITION. At
 * `fusion-torch: 0.6` the column left a bell of radius R as a tube of radius
 * 0.6 R: 40% narrower than the hardware it came out of, with a visible step at
 * the exit plane. A plume has exactly one boundary condition — it leaves the
 * exit plane AT the exit radius — so this number now only trims the last few
 * percent (a magnetic nozzle necks slightly, a grid's beam starts just inside
 * the grid) and every technology's real girth difference is carried by its
 * EXPANSION RATE instead. See `PLUME_EXPANSION`.
 */
const PLUME_SHAPE: Record<TechnologyProfile['drive'], readonly [number, number]> = {
  chemical: [1.0, 0.96],
  ion: [1.35, 0.88],
  'fusion-torch': [1.35, 1.00],
  plasma: [1.0, 0.98],
  'reaction-plate': [0.22, 1.30],
};

/** Every RCS group, in the order the per-frame demand array uses. */
const RCS_GROUP_ORDER: readonly RcsGroup[] = [
  'pitch+', 'pitch-', 'yaw+', 'yaw-', 'roll+', 'roll-',
  'x+', 'x-', 'y+', 'y-', 'z+', 'z-',
];

// ---------------------------------------------------------------------------
// Small maths (module scope — never called from update())
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Frame-rate independent exponential approach; `rate` is e-foldings per second. */
function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

// ---------------------------------------------------------------------------
// Geometry accumulator
// ---------------------------------------------------------------------------

/**
 * One merged indexed buffer.
 *
 * Normals are authored per vertex rather than accumulated from faces: every
 * surface here is a surface of revolution whose exact normal is known
 * analytically, and a face-averaged normal on a nozzle lip rounds off the one
 * hard edge that tells you the bell is made of sheet.
 */
class Buf {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly at: number[] = [];
  readonly part: number[] = [];
  readonly idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, t: number, part: number): number {
    const i = this.count;
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.at.push(t);
    this.part.push(part);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /**
   * `aShape` is always present and always zero here.
   *
   * Both meshes on the nozzle material must present the same attribute set or
   * three.js compiles a second program for the one that is missing an
   * attribute, and BRIEF §6 counts materials per ship. The fittings are a
   * single profile, so theirs is a run of zeros; `mergeNozzleShapes` is the
   * only thing that writes a non-zero one.
   */
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('aT', new BufferAttribute(new Float32Array(this.at), 1));
    g.setAttribute('aPart', new BufferAttribute(new Float32Array(this.part), 1));
    g.setAttribute('aShape', new BufferAttribute(new Float32Array(this.count), 1));
    g.setIndex(this.idx);
    return g;
  }
}

/**
 * A ring of `seg` vertices at axial `z`, radius `r`.
 *
 * `slope` is dr/dz of the surface passing through the ring, so the outward
 * normal in the (radial, axial) plane is (1, -slope) normalised. Passing it in
 * rather than differencing adjacent rings is what keeps a hard lip hard.
 */
function ring(b: Buf, seg: number, z: number, r: number, slope: number, t: number, part: number): number {
  const base = b.count;
  const inv = 1 / Math.hypot(1, slope);
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    const cx = Math.cos(a);
    const sy = Math.sin(a);
    b.v(cx * r, sy * r, z, cx * inv, sy * inv, -slope * inv, t, part);
  }
  return base;
}

/** Bridge two rings of equal segment count into a quad band, outward-facing. */
function band(b: Buf, lo: number, hi: number, seg: number): void {
  for (let s = 0; s < seg; s++) {
    const s1 = (s + 1) % seg;
    b.quad(lo + s, lo + s1, hi + s1, hi + s);
  }
}

/**
 * Flat annulus at `z` between `r0` and `r1`, facing `sign` along Z.
 *
 * The one primitive a nozzle cannot be closed without: an annular throat (a
 * plug nozzle, an aerospike) has a hole in the middle that a disc cannot fill
 * and that a band leaves open to space.
 */
function annulus(b: Buf, seg: number, z: number, r0: number, r1: number, t0: number, t1: number, part: number, sign = 1): void {
  const lo = b.count;
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    b.v(Math.cos(a) * r0, Math.sin(a) * r0, z, 0, 0, sign, t0, part);
  }
  const hi = b.count;
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    b.v(Math.cos(a) * r1, Math.sin(a) * r1, z, 0, 0, sign, t1, part);
  }
  for (let s = 0; s < seg; s++) {
    const s1 = (s + 1) % seg;
    if (sign > 0) b.quad(lo + s, lo + s1, hi + s1, hi + s);
    else b.quad(lo + s, hi + s, hi + s1, lo + s1);
  }
}

/**
 * Flat disc whose `aT` carries the NORMALISED RADIUS rather than a constant.
 *
 * Injector plates and working faces are radial objects: their pattern, and the
 * hot spot at their centre, are functions of radius, and a disc that reports a
 * constant `aT` gives the fragment nothing to build either from.
 */
function radialDisc(b: Buf, seg: number, z: number, r: number, part: number, sign = 1): void {
  const c = b.v(0, 0, z, 0, 0, sign, 0, part);
  const base = b.count;
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    b.v(Math.cos(a) * r, Math.sin(a) * r, z, 0, 0, sign, 1, part);
  }
  for (let s = 0; s < seg; s++) {
    const s1 = (s + 1) % seg;
    if (sign > 0) b.tri(c, base + s, base + s1);
    else b.tri(c, base + s1, base + s);
  }
}

/** Flat disc at `z`, radius `r`, facing `sign` along Z. Grid faces, plate faces, caps. */
function disc(b: Buf, seg: number, z: number, r: number, t: number, part: number, sign = 1): void {
  const c = b.v(0, 0, z, 0, 0, sign, t, part);
  const base = b.count;
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    b.v(Math.cos(a) * r, Math.sin(a) * r, z, 0, 0, sign, t, part);
  }
  for (let s = 0; s < seg; s++) {
    const s1 = (s + 1) % seg;
    if (sign > 0) b.tri(c, base + s, base + s1);
    else b.tri(c, base + s1, base + s);
  }
}

/** A capped tube between two points. Turbopumps, feed pipes, stiffener ribs. */
function tube(
  b: Buf,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r: number, seg: number, part: number,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1e-9;
  const fx = dx / len;
  const fy = dy / len;
  const fz = dz / len;
  // Any perpendicular will do; pick the one furthest from the axis so the
  // cross product never degenerates on an axis-aligned tube.
  let ux = 0;
  let uy = 0;
  let uz = 1;
  if (Math.abs(fz) > 0.9) {
    ux = 1;
    uy = 0;
    uz = 0;
  }
  const rx = uy * fz - uz * fy;
  const ry = uz * fx - ux * fz;
  const rz = ux * fy - uy * fx;
  const rl = Math.hypot(rx, ry, rz) || 1e-9;
  const r0x = rx / rl;
  const r0y = ry / rl;
  const r0z = rz / rl;
  const u0x = fy * r0z - fz * r0y;
  const u0y = fz * r0x - fx * r0z;
  const u0z = fx * r0y - fy * r0x;

  const lo = b.count;
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    const cx = Math.cos(a);
    const sy = Math.sin(a);
    const nx = r0x * cx + u0x * sy;
    const ny = r0y * cx + u0y * sy;
    const nz = r0z * cx + u0z * sy;
    b.v(ax + nx * r, ay + ny * r, az + nz * r, nx, ny, nz, 0, part);
  }
  const hi = b.count;
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    const cx = Math.cos(a);
    const sy = Math.sin(a);
    const nx = r0x * cx + u0x * sy;
    const ny = r0y * cx + u0y * sy;
    const nz = r0z * cx + u0z * sy;
    b.v(bx + nx * r, by + ny * r, bz + nz * r, nx, ny, nz, 1, part);
  }
  band(b, lo, hi, seg);
  // Caps. Flat and hard: a capped tube with smoothed ends reads as a sausage.
  const ca = b.v(ax, ay, az, -fx, -fy, -fz, 0, part);
  const cb = b.v(bx, by, bz, fx, fy, fz, 1, part);
  for (let s = 0; s < seg; s++) {
    const s1 = (s + 1) % seg;
    b.tri(ca, lo + s1, lo + s);
    b.tri(cb, hi + s, hi + s1);
  }
}

// ---------------------------------------------------------------------------
// Nozzle geometry — one unit envelope per style
// ---------------------------------------------------------------------------
//
// Authoring space: axis +Z, throat at z = 0, exit plane at z = 1, exit radius 1.
// The instance carries `iSize = (exitRadius, exitRadius, bellLength)` so the
// vertex shader scales it; `instanceMatrix` stays a RIGID transform so normals
// survive `mat3(instanceMatrix)` without an inverse-transpose.
//
// `aPart`:  0 = wall (front face = outside, back face = throat interior)
//           1 = surface the exhaust washes over (spike, plug) — glows
//           2 = hardware (rims, pumps, pipes, ribs, thrust frame) — never glows
//           3 = emissive face (ion grid, reaction plate)
//           4 = injector face — the CLOSED floor of the throat; `aT` = radius
//
// EVERY STYLE IS CLOSED. A nozzle you can see space through is not a nozzle,
// it is a cut pipe, and until this file grew part 4 every bell, aerospike and
// plug in the fleet was open at its throat end and showed the starfield behind
// the ship straight down its own axis.

const PART_WALL = 0;
const PART_WASHED = 1;
const PART_HARDWARE = 2;
const PART_FACE = 3;
const PART_THROAT = 4;

/**
 * The pitch a serviceable engine structure is laid out on, in kilometres.
 *
 * BRIEF §7's first rule — "detail scales with the ship, not with a constant" —
 * and `types.ts`'s human-scale note ("every detail that tells the eye how big a
 * ship is is a multiple of one of these, never a hand-tuned constant") are the
 * same rule, and the engine cage was the largest thing on a Kessler hull still
 * breaking it: `n = 4` longerons, `hoops = 2`, `rings = 6`, `ribs = 6`, at every
 * bell size the blueprint can produce. Exit radius over beam spans p10 0.064 to
 * p90 0.149, so the same cage was being scaled across a 2.3x range of absolute
 * size and the tail assembly was recognisably one object on every hull in the
 * family plate.
 *
 * THE REVIEW ASKED FOR `structure.bayAspect` AND THAT IS NOT REACHABLE HERE.
 * `bayAspect` lives on the FAMILY spec in `families.ts`, not on `ShipBlueprint`;
 * the blueprint bakes it into `bayLen` per spine chain and never republishes the
 * ratio, and `ShipBlueprint` carries only a `familyId`. Reading a hull-section
 * bay would also make the derivation non-monotonic in bell size, which is
 * exactly what the review's own acceptance test asserts against. So the pitch is
 * taken from the same absolute human-scale reference `families.ts` derives
 * `bayAspect` against: a bay you can get a gantry and a crew into is a couple of
 * decks across. That is the quantity the rule is really about — a longeron every
 * ~4 m of cage circumference on any ship, rather than four longerons on every
 * ship.
 */
const SERVICE_PITCH_KM = DECK_HEIGHT_KM * 1.6; // ≈ 4.2 m

/**
 * Circumferential spacing of the cage's longitudinal members.
 *
 * Tighter than the bay it braces, and not for a visual reason: a bay is sized by
 * what a crew and a gantry hook need to get through, and a longeron is sized by
 * the load coming out of the bell's flange ring, which is a ring load and wants
 * more feet under it than the axial stations do. Keeping the two separate is
 * also what gives the small end of the fleet any resolution at all — at one
 * pitch for both, every bell under two metres landed on the clamp floor and the
 * couriers went back to sharing a cage.
 */
const LONGERON_PITCH_KM = SERVICE_PITCH_KM * 0.78; // ≈ 3.2 m

/**
 * How finely one nozzle is subdivided, derived from its ABSOLUTE size.
 *
 * Every count here used to be a literal in the builder that consumed it. They
 * are gathered into one object because they must move together: a bell with ten
 * longerons and six profile rings looks like two different objects welded to
 * each other.
 *
 * This is a per-SHIP quantity, not a per-instance one, because the nozzle
 * geometry is one merged buffer shared by every instance on the hull (see
 * `mergeNozzleShapes`) — a per-pod count would need a buffer per pod and a draw
 * call per buffer. Pods of one ship differ by a few percent of a radius; ships
 * differ by 2.3x, and it is the between-ship difference the family plate shows.
 */
interface NozzleScale {
  /** Longitudinal members of the thrust frame. */
  readonly longerons: number;
  /** Bracing hoops along the cage. */
  readonly hoops: number;
  /** Straight tube segments per hoop. Roundness, not structure. */
  readonly hoopSeg: number;
  /** Profile rings along the bell wall. */
  readonly bellRings: number;
  /** Profile rings along an aerospike's central spike. */
  readonly spikeRings: number;
  /** Profile rings along an annular nozzle's outer wall. */
  readonly annularRings: number;
  /** Radial stiffeners on a reaction plate. */
  readonly ribs: number;
  /** Turbopumps round an open-cycle bell. */
  readonly pumps: number;
  /** Injector blocks round an aerospike throat. */
  readonly blocks: number;
}

/**
 * @param exitRadiusKm  the bell's absolute exit radius
 * @param bellLengthKm  the bell's absolute length, throat to exit plane
 *
 * Every count is a length over `SERVICE_PITCH_KM` and every clamp is a range,
 * so the LOD path can drop rungs out of the RESULT (see `thrustFrame`) instead
 * of substituting a smaller literal — which is what made LOD1 a different cage
 * rather than a coarser one.
 */
function nozzleScale(exitRadiusKm: number, bellLengthKm: number): NozzleScale {
  const bay = SERVICE_PITCH_KM;
  const r = Math.max(exitRadiusKm, 1e-6);
  const len = Math.max(bellLengthKm, 1e-6);
  // The cage stands off the bell at ~1.13 R and runs from z = -0.78 to z = 0.43
  // in units of bell length; both numbers come from `thrustFrame`'s envelope.
  const cageCirc = 2 * Math.PI * 1.13 * r;
  const cageLen = 1.21 * len;

  // Three is a floor because two longerons is not a cage, and eleven is a
  // ceiling because `ShipMesh` charges propulsion's submitted triangles against
  // the hull's LOD1 greeble allowance and an unbounded count would strip the
  // greebles off a big hull to draw bracing nobody can resolve.
  const longerons = Math.round(clamp(cageCirc / LONGERON_PITCH_KM, 3, 11));
  const hoops = Math.round(clamp(cageLen / bay + 1, 2, 4));
  return {
    longerons,
    hoops,
    // Bounded by the longeron count so the cage reads as one lattice, but
    // floored at 8 because a hoop is a circle and a hexagonal one is a nut.
    hoopSeg: Math.round(clamp(longerons, 8, 12)),
    // Finer pitch than the structure: this is curvature, not load path.
    bellRings: Math.round(clamp(len / (bay * 0.42) + 3, 4, 12)),
    spikeRings: Math.round(clamp(len / (bay * 0.42) + 2, 4, 10)),
    annularRings: Math.round(clamp(len / (bay * 0.42) + 1, 3, 8)),
    ribs: Math.round(clamp((2 * Math.PI * 0.94 * r) / (bay * 1.35), 3, 12)),
    pumps: Math.round(clamp(cageCirc / (bay * 2.6), 2, 6)),
    blocks: Math.round(clamp((2 * Math.PI * 0.98 * r) / (bay * 0.95), 4, 12)),
  };
}

/**
 * Combustion chamber and injector, forward of the throat.
 *
 * This is what closes a bell. The chamber converges from the injector plane
 * down to the throat, so a camera looking up the bell sees a contracting
 * passage ending in a lit plate — a throat — instead of a hole. It lives at
 * NEGATIVE z, i.e. forward of the frame origin, because the blueprint anchors
 * an engine frame at its throat; on a flush-mounted drive it is inside the
 * hull and costs nothing, and on a pod standing off a frame it is the
 * plumbing you are supposed to see.
 */
function chamber(b: Buf, seg: number, throat: number): void {
  const zc = -0.55 * Math.max(throat, 0.20);
  const rc = throat * 1.62;
  const slope = (throat - rc) / -zc; // dr/dz, negative: converging aft
  const c0 = ring(b, seg, zc, rc, slope, 0, PART_WALL);
  const c1 = ring(b, seg, 0, throat, slope, 0, PART_WALL);
  band(b, c0, c1, seg);
  // The injector plate faces AFT, into the chamber, because that is the face
  // the exhaust and the camera both see.
  radialDisc(b, seg, zc, rc, PART_THROAT, 1);
  // Chamber jacket: the coolant wrap that says this end is machinery.
  const j0 = ring(b, seg, zc * 0.95, rc * 1.16, 0, 0, PART_HARDWARE);
  const j1 = ring(b, seg, zc * 0.25, rc * 1.10, 0, 0, PART_HARDWARE);
  band(b, j0, j1, seg);
}

/**
 * An external thrust structure standing the bell off its mounting plane.
 *
 * KESSLER DOCTRINE, `families.ts`: "the drives stand off the tail on an open
 * thrust frame, because a crew with a gantry must be able to change one." That
 * sentence describes a silhouette, and until this existed nothing in the render
 * produced it — the bells sat flush against the plating with no visible way to
 * unbolt one.
 *
 * The member COUNTS come from `sc`, i.e. from the bell's absolute size over a
 * service pitch, not from literals. A courier's cage is three bars and two
 * hoops; a freighter's is ten and four. That difference is the whole reason the
 * five hulls on the family plate stopped sharing one tail assembly.
 */
function thrustFrame(b: Buf, sc: NozzleScale, full: boolean): void {
  const n = sc.longerons;
  const zA = -0.78;
  const zB = 0.30;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / n;
    const a2 = ((i + 1) / n) * Math.PI * 2 + Math.PI / n;
    const cx = Math.cos(a);
    const sy = Math.sin(a);
    tube(b, cx * 1.13, sy * 1.13, zA, cx * 1.06, sy * 1.06, zB, 0.058, 5, PART_HARDWARE);
    if (!full) continue;
    tube(b, cx * 1.13, sy * 1.13, zA, Math.cos(a2) * 1.06, Math.sin(a2) * 1.06, zB, 0.030, 4, PART_HARDWARE);
    // The pad a gantry hook actually grabs.
    tube(b, cx * 1.06, sy * 1.06, zB, cx * 0.84, sy * 0.84, zB + 0.13, 0.052, 5, PART_HARDWARE);
  }
  // The LONGERONS AND THE FORWARD HOOP SURVIVE A RUNG LONGER than the diagonals
  // and the pads. The cage round the bells is part of the Kessler silhouette and
  // `ship-lod1`'s brief rejects a silhouette that changes at all; the bracing
  // inside it is 0.2 m tube on a 139 m hull, which is what that brief means by
  // "sub-metre hardware may go".
  //
  // LOD sheds FROM THE DERIVED COUNT rather than substituting a literal. The
  // longerons — the members that carry the silhouette — keep their full derived
  // count at every rung, so a big cage still reads as a big cage at LOD1; only
  // the bracing thins, and it thins proportionally rather than to a constant.
  // Hoops go to one at LOD1 whatever the ship: `ShipMesh` charges propulsion's
  // triangles against the hull's LOD1 greeble allowance, and a hoop is
  // `hoopSeg` capped tubes, i.e. the most expensive thing per pixel here.
  const hoops = full ? sc.hoops : 1;
  const k = full ? sc.hoopSeg : Math.max(5, Math.round(sc.hoopSeg * 0.5));
  // A single hoop sits at the FORWARD station, which is where the two-hoop cage
  // put its first one — so dropping to one hoop moves nothing that was there.
  const zHoop0 = zA + 0.07;
  const zHoop1 = zB - 0.06;
  for (let h = 0; h < hoops; h++) {
    const s = hoops === 1 ? 0 : h / (hoops - 1);
    const z = zHoop0 + s * (zHoop1 - zHoop0);
    const r = 1.12 + s * (1.06 - 1.12);
    for (let i = 0; i < k; i++) {
      const a0 = (i / k) * Math.PI * 2;
      const a1 = ((i + 1) / k) * Math.PI * 2;
      tube(b, Math.cos(a0) * r, Math.sin(a0) * r, z, Math.cos(a1) * r, Math.sin(a1) * r, z, 0.028, 4, PART_HARDWARE);
    }
  }
}

/** The expansion bell itself, without chamber, frame or turbomachinery. */
function bellProfile(b: Buf, seg: number, throat: number, sc: NozzleScale): void {
  // Size-derived, but never finer along the axis than the ring is around it: a
  // twelve-ring profile on a five-segment ring is a pentagonal prism with a lot
  // of extra bands, and `ship-lod2`'s whole budget is 3 k for the entire ship.
  const rings = Math.max(4, Math.min(sc.bellRings, seg));
  let prevIdx = -1;
  let prevR = 0;
  let prevZ = 0;
  for (let i = 0; i < rings; i++) {
    const s = i / (rings - 1);
    const z = s;
    // A real bell expands fast off the throat then straightens: the exponent
    // below 1 is what gives the profile its shoulder. A straight cone reads as
    // a party hat.
    const r = throat + (1 - throat) * Math.pow(s, 0.55);
    const slope = i === 0 ? (1 - throat) * 4 : (r - prevR) / Math.max(z - prevZ, 1e-6);
    const idx = ring(b, seg, z, r, slope, s, PART_WALL);
    if (prevIdx >= 0) band(b, prevIdx, idx, seg);
    prevIdx = idx;
    prevR = r;
    prevZ = z;
  }
  // A rolled lip. It costs one band and it is the difference between sheet
  // metal and a rendering of a cone.
  const lip = ring(b, seg, 1.035, 1.055, -0.9, 1, PART_WALL);
  band(b, prevIdx, lip, seg);
}

/** Classic expansion bell on an open thrust frame. Chemical, fusion, plasma. */
function buildBell(seg: number, throat: number, detail: number, sc: NozzleScale): Buf {
  const b = new Buf();
  bellProfile(b, seg, throat, sc);
  chamber(b, seg, throat);
  // The frame is a lattice of 3–7 segment tubes and roughly sixty percent of
  // this bell's triangles. It is also the first thing that stops resolving.
  if (detail > 0) thrustFrame(b, sc, detail >= 2);
  return b;
}

/**
 * Ion grid: a lit throat recessed flush into the skin. No bell, nothing proud.
 *
 * SILLANE DOCTRINE, `families.ts`: "The drives are recessed. You never see a
 * bell, only a lit throat inside a moulded port," and "there is no external
 * structure of any kind." So the port is a moulded land in the plating with a
 * single shallow step, and the grid is a CLOSED face at the bottom of it.
 */
function buildGrid(seg: number, throat: number, detail: number): Buf {
  const b = new Buf();
  const rBack = Math.max(throat, 0.80);
  const g0 = ring(b, seg, 0.30, rBack, 0.55, 0.3, PART_WALL);
  const g1 = ring(b, seg, 0.72, 0.94, 0.25, 0.72, PART_WALL);
  const g2 = ring(b, seg, 1.0, 1.0, 0.0, 1, PART_WALL);
  band(b, g0, g1, seg);
  band(b, g1, g2, seg);
  // The accelerator grid, set back inside the port so it self-shadows and so
  // the recess wall reads as depth rather than as a rim round a hole.
  radialDisc(b, seg, 0.30, rBack, PART_FACE, 1);
  // The moulded land round the port. A step and a flat, no bolted flange:
  // Sillane does not have fasteners on the outside of anything.
  if (detail > 0) {
    annulus(b, seg, 1.0, 1.0, 1.24, 1, 1, PART_HARDWARE, 1);
    const l0 = ring(b, seg, 1.0, 1.24, 0, 1, PART_HARDWARE);
    const l1 = ring(b, seg, 0.90, 1.32, 0, 1, PART_HARDWARE);
    band(b, l0, l1, seg);
  }
  return b;
}

/** Aerospike: annular throat round a truncated central spike. */
function buildAerospike(seg: number, throat: number, detail: number, sc: NozzleScale): Buf {
  const b = new Buf();
  const s0 = ring(b, seg, 0.0, 1.0, -0.1, 0, PART_WALL);
  const s1 = ring(b, seg, 0.22, 0.97, -0.1, 0.2, PART_WALL);
  band(b, s0, s1, seg);
  // The annular throat, closed between the spike root and the outer wall.
  annulus(b, seg, 0.02, Math.max(throat, 0.8), 1.0, 0.0, 0.75, PART_THROAT, 1);
  // The spike. The exhaust clings to it, so it is `PART_WASHED` and glows from
  // the root outward — that gradient is the whole read of an aerospike.
  const spikeRings = Math.max(4, Math.min(sc.spikeRings, seg));
  let prev = -1;
  for (let i = 0; i < spikeRings; i++) {
    const s = i / (spikeRings - 1);
    const z = 0.1 + s * 0.85;
    const r = Math.max(throat, 0.8) * (1 - s) + 0.09 * s;
    const idx = ring(b, seg, z, r, -0.85, s, PART_WASHED);
    if (prev >= 0) band(b, prev, idx, seg);
    prev = idx;
  }
  disc(b, seg, 0.95, 0.09, 1, PART_WASHED);
  // Injector blocks round the throat. Small, but they break the ring's
  // silhouette so it is not a bare washer.
  // Size-derived, then capped by the ring tessellation so the blocks can never
  // out-resolve the throat they are bolted to. LOD halves the derived count
  // rather than replacing it with 4.
  const blocks = detail <= 0
    ? 0
    : Math.min(Math.max(4, seg >> 1), detail >= 2 ? sc.blocks : Math.max(3, sc.blocks >> 1));
  for (let i = 0; i < blocks; i++) {
    const a = (i / blocks) * Math.PI * 2;
    const cx = Math.cos(a);
    const sy = Math.sin(a);
    tube(b, cx * 0.92, sy * 0.92, 0.02, cx * 1.04, sy * 1.04, 0.16, 0.07, 5, PART_HARDWARE);
  }
  return b;
}

/** Annular: exhaust in the gap between an outer wall and a central plug. */
function buildAnnular(seg: number, throat: number, sc: NozzleScale): Buf {
  const b = new Buf();
  const rings = Math.max(3, Math.min(sc.annularRings, seg));
  let prev = -1;
  for (let i = 0; i < rings; i++) {
    const s = i / (rings - 1);
    const r = Math.max(throat, 0.62) + (1 - Math.max(throat, 0.62)) * Math.pow(s, 0.7);
    const idx = ring(b, seg, s, r, 0.45, s, PART_WALL);
    if (prev >= 0) band(b, prev, idx, seg);
    prev = idx;
  }
  // The annular throat, closed between the plug and the wall.
  annulus(b, seg, 0.02, 0.42, Math.max(throat, 0.62), 0.0, 0.7, PART_THROAT, 1);
  // The plug. Blunt, domed, and washed by the annular flow.
  const p0 = ring(b, seg, 0.02, 0.42, 0, 0, PART_WASHED);
  const p1 = ring(b, seg, 0.62, 0.40, 0, 0.6, PART_WASHED);
  const p2 = ring(b, seg, 0.80, 0.28, -0.7, 0.85, PART_WASHED);
  band(b, p0, p1, seg);
  band(b, p1, p2, seg);
  disc(b, seg, 0.8, 0.28, 1, PART_WASHED);
  return b;
}

/**
 * Open cycle: a short bell wearing its turbomachinery, hung off a pylon.
 *
 * OSSUARY DOCTRINE, `families.ts`: mounting `podded`, "the drive with its
 * cowling gone, because the cowling was the first thing sold." So it gets the
 * bell and the chamber but explicitly NOT the Kessler thrust frame — a scavenger
 * does not fabricate a gantry-serviceable structure, it welds a yoke onto
 * whatever the pod came off.
 */
function buildOpenCycle(seg: number, throat: number, detail: number, sc: NozzleScale): Buf {
  const b = new Buf();
  bellProfile(b, seg, throat, sc);
  chamber(b, seg, throat);
  if (detail <= 0) return b;
  // The yoke and at least two pumps stay: a scavenger drive hanging off a pylon
  // with its plumbing showing IS the Ossuary silhouette, not a decoration on it.
  // How MANY pumps is a function of how much bell there is to feed.
  const pumps = detail >= 2 ? sc.pumps : Math.max(2, sc.pumps >> 1);
  for (let i = 0; i < pumps; i++) {
    const a = (i / pumps) * Math.PI * 2 + 0.4;
    const cx = Math.cos(a);
    const sy = Math.sin(a);
    const pr = Math.max(throat, 0.4) + 0.2;
    // Turbopump body, then the feed line curving back into the bell wall. Two
    // primitives that say "this drive was designed to be opened".
    tube(b, cx * pr, sy * pr, 0.02, cx * pr, sy * pr, 0.42, 0.17, 6, PART_HARDWARE);
    tube(b, cx * pr, sy * pr, 0.40, cx * (pr + 0.34), sy * (pr + 0.34), 0.82, 0.055, 5, PART_HARDWARE);
  }
  // The yoke. Two members forward-outboard to a cross tube: a pod held clear of
  // the hull on a pylon, which is a different silhouette from a bell in a frame
  // and a different one again from a port in the skin.
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    tube(b, s * 0.92, -0.18, -0.05, s * 1.10, -0.66, -0.95, 0.070, 5, PART_HARDWARE);
  }
  tube(b, -1.10, -0.66, -0.95, 1.10, -0.66, -0.95, 0.052, 5, PART_HARDWARE);
  tube(b, 0, -0.66, -0.95, 0, -1.05, -1.20, 0.085, 6, PART_HARDWARE);
  return b;
}

/** Reaction plate: a disc that is struck, not a nozzle that flows. */
function buildPlate(seg: number, _throat: number, detail: number, sc: NozzleScale): Buf {
  const b = new Buf();
  const r0 = ring(b, seg, 0.0, 1.0, 0, 0, PART_HARDWARE);
  const r1 = ring(b, seg, 1.0, 1.0, 0, 1, PART_HARDWARE);
  band(b, r0, r1, seg);
  // Forward face is structure; aft face is the working surface and flashes.
  disc(b, seg, 1.0, 1.0, 1, PART_FACE);
  disc(b, seg, 0.0, 1.0, 0, PART_HARDWARE, -1);
  // Radial stiffeners on the forward face. A flat disc with nothing on it
  // reads as a decal; the ribs are what make it a structural member.
  // One stiffener per fixed arc of rim, so a 20 m plate is not a 2 m plate
  // photographed closer. LOD halves the derived count.
  const ribs = detail <= 0 ? 0 : detail >= 2 ? sc.ribs : Math.max(3, sc.ribs >> 1);
  for (let i = 0; i < ribs; i++) {
    const a = (i / ribs) * Math.PI * 2;
    const cx = Math.cos(a);
    const sy = Math.sin(a);
    tube(b, cx * 0.16, sy * 0.16, -0.02, cx * 0.94, sy * 0.94, -0.02, 0.075, 4, PART_HARDWARE);
  }
  return b;
}

/**
 * One small fitting, shared by every RCS nozzle and every light on the ship.
 *
 * Unit envelope: axis +Z, mouth at z = 1 radius 1, root at z = 0 radius 0.72,
 * closed at the root. It is the answer to two separate review findings that
 * turn out to be the same omission — an RCS jet that erupts out of bare plating
 * with no thruster behind it, and a navigation light that is a bare glowing
 * point with no housing. Both are emitters this file drew without ever drawing
 * the hardware they come out of.
 *
 * One geometry, one instanced mesh, the nozzle material: no new draw call for
 * the lights and no new material for either.
 */
function buildFixture(seg: number): Buf {
  const b = new Buf();
  const s = Math.max(5, seg >> 1);
  const r0 = ring(b, s, 0.0, 0.72, 0.28, 0, PART_HARDWARE);
  const r1 = ring(b, s, 0.62, 0.90, 0.30, 0.6, PART_HARDWARE);
  const r2 = ring(b, s, 1.0, 1.0, 0.0, 1, PART_HARDWARE);
  band(b, r0, r1, s);
  band(b, r1, r2, s);
  // A lip, so the mouth is a rim and not a cut edge at any size.
  const lip = ring(b, s, 1.02, 1.10, -0.8, 1, PART_HARDWARE);
  band(b, r2, lip, s);
  // Closed at the root. This fitting is bolted to plating; nothing sees through it.
  disc(b, s, 0.0, 0.72, 0, PART_HARDWARE, -1);
  // The throat plate, one step inside the mouth: a cup with a visible floor
  // rather than a cone with a hole in it.
  radialDisc(b, s, 0.34, 0.78, PART_HARDWARE, 1);
  return b;
}

/**
 * `detail` is the LOD switch for BOLTED HARDWARE only: 2 full, 1 reduced,
 * 0 none.
 *
 * Every style keeps its full profile and its closed throat at every rung: the
 * profile is the silhouette and the closed throat is the difference between a
 * nozzle and a hole you can see the starfield through. What thins out is the
 * lattice hung off it — the thrust frame, the turbopumps and their feed lines,
 * the injector blocks, the plate's stiffeners, the moulded land round an ion
 * port. All of it is 3–7 segment tubes and it is the majority of the triangle
 * count.
 *
 * At 1 the OUTLINE of that hardware survives and only its bracing goes, because
 * `ship-lod1`'s brief rejects any change to the silhouette; at 0 it is gone,
 * which is `ship-lod2`, where the whole hull is eight sections around.
 */
function buildNozzle(style: NozzleStyle, seg: number, throat: number, detail: number, sc: NozzleScale): Buf {
  switch (style) {
    case 'bell':
      return buildBell(seg, throat, detail, sc);
    case 'aerospike':
      return buildAerospike(seg, throat, detail, sc);
    case 'annular':
      return buildAnnular(seg, throat, sc);
    case 'grid':
      return buildGrid(seg, throat, detail);
    case 'open-cycle':
      return buildOpenCycle(seg, throat, detail, sc);
    case 'plate':
      return buildPlate(seg, throat, detail, sc);
  }
}

/**
 * Every profile a rung draws, concatenated into ONE indexed buffer.
 *
 * Each vertex is tagged with the profile it came from; each instance names the
 * profile it wants; the vertex shader pushes the mismatches outside the clip
 * volume so the triangle is rejected before rasterisation. One draw call serves
 * a hull whose pods mix doctrines, and — the point — the count no longer
 * depends on the blueprint at all.
 *
 * WHY THIS IS NOT ALSO DONE TO THE FITTINGS, which would take LOD0 from four
 * draw calls to three. Masking costs a shaded vertex and a counted triangle per
 * instance per profile it is NOT drawing, so it is only affordable where the
 * instance count is small. The nozzles are 1–12 instances of an ~790-triangle
 * profile; the fittings are 30+ instances of a 72-triangle one. Measured on the
 * hero at LOD0: nozzles-only is 33 instances × 858 tri = 28.3 k submitted
 * against 4.5 k drawn, i.e. +23.8 k triangles — and `ShipMesh.propulsionTriangles`
 * subtracts propulsion's submitted count from the LOD1 greeble allowance, which
 * on that rung is `25 k − 19.7 k hull − 2.7 k propulsion ≈ 2.6 k`. The masked
 * version would drive it negative and strip every greeble off the hull at LOD1
 * to save one draw call. Two opaque meshes it is.
 */
function mergeNozzleShapes(bufs: readonly Buf[]): BufferGeometry {
  let vTotal = 0;
  for (const b of bufs) vTotal += b.count;

  const pos = new Float32Array(vTotal * 3);
  const nrm = new Float32Array(vTotal * 3);
  const at = new Float32Array(vTotal);
  const part = new Float32Array(vTotal);
  const shape = new Float32Array(vTotal);
  const idx: number[] = [];

  let base = 0;
  for (let s = 0; s < bufs.length; s++) {
    const b = bufs[s];
    pos.set(b.pos, base * 3);
    nrm.set(b.nrm, base * 3);
    at.set(b.at, base);
    part.set(b.part, base);
    shape.fill(s, base, base + b.count);
    for (let k = 0; k < b.idx.length; k++) idx.push(b.idx[k] + base);
    base += b.count;
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('aT', new BufferAttribute(at, 1));
  g.setAttribute('aPart', new BufferAttribute(part, 1));
  g.setAttribute('aShape', new BufferAttribute(shape, 1));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------------------
// Additive geometry — one attribute layout for every emissive family
// ---------------------------------------------------------------------------
//
// position / normal / uv / aT / aLayer, always all five, so all four meshes can
// share one program with no attribute-presence permutation.

function additiveGeometry(pos: Float32Array, nrm: Float32Array, uv: Float32Array, t: Float32Array, layer: Float32Array, idx: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setAttribute('aT', new BufferAttribute(t, 1));
  g.setAttribute('aLayer', new BufferAttribute(layer, 1));
  g.setIndex(idx);
  return g;
}

/** Unit quad in the XY plane, -0.5..0.5, uv 0..1. Lights and RCS jets. */
function buildQuadGeometry(): BufferGeometry {
  return additiveGeometry(
    new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    new Float32Array(4),
    new Float32Array(4),
    [0, 1, 2, 0, 2, 3],
  );
}

/**
 * Nested cone shells with every vertex at the origin.
 *
 * `normal` carries the radial direction and `aT` the axial parameter; the
 * vertex shader does the extruding. This is the technique worth copying
 * wholesale from `Ship.ts`: it makes length, width, taper and wobble free to
 * animate, and it is why a plume never needs a geometry rebuild.
 */
function buildShellGeometry(seg: number, steps: number, layers: number, ySquash: number): BufferGeometry {
  const verts = layers * (steps + 1) * seg;
  const pos = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const t = new Float32Array(verts);
  const layer = new Float32Array(verts);
  const idx: number[] = [];

  let v = 0;
  for (let l = 0; l < layers; l++) {
    const base = v;
    for (let r = 0; r <= steps; r++) {
      const tt = r / steps;
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        nrm[v * 3] = Math.cos(a);
        nrm[v * 3 + 1] = Math.sin(a) * ySquash;
        nrm[v * 3 + 2] = 0;
        uv[v * 2] = s / seg;
        uv[v * 2 + 1] = tt;
        t[v] = tt;
        // 0 = the cool envelope, 1 = the hot core. A ONE-shell plume is neither,
        // so it gets a value between them and comes out the size and colour of
        // the pair it replaces. The old value here was 1, which gave every
        // single-shell rung — every `low` tier, every crowded capital — a plume
        // 40% shorter and 56% narrower than the same ship at `high`. That is a
        // quality setting changing the SIZE of an object, which is a bug.
        layer[v] = layers > 1 ? l : 0.55;
        v++;
      }
    }
    for (let r = 0; r < steps; r++) {
      for (let s = 0; s < seg; s++) {
        const s1 = (s + 1) % seg;
        const a = base + r * seg + s;
        const bb = base + r * seg + s1;
        const c = base + (r + 1) * seg + s1;
        const d = base + (r + 1) * seg + s;
        idx.push(a, bb, c, a, c, d);
      }
    }
  }
  return additiveGeometry(pos, nrm, uv, t, layer, idx);
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const NOZZLE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute float aT;
attribute float aPart;
attribute float aShape;   // which profile in the merged buffer this vertex is

attribute vec3  iSize;    // (exitRadius, exitRadius, bellLength) km
attribute vec3  iCore;    // plume core colour, for the throat glow
attribute float iTech;
attribute float iSeed;
attribute float iShape;   // which profile this instance draws
attribute float iSoot;    // how much exhaust deposit this instance lives in

varying vec3  vLocal;     // UNIT-nozzle space — every noise frequency lives here
varying vec3  vPos;       // ship-local km, for the view vector
varying vec3  vNrm;
varying float vT;
varying float vPart;
varying vec3  vCore;
varying float vTech;
varying float vSeed;
varying float vSoot;

void main() {
  vec3 lp = position * iSize;
  // Inverse-transpose of a diagonal scale is the reciprocal scale. This is the
  // whole reason instanceMatrix is kept rigid and the size rides an attribute:
  // a non-uniform scale inside instanceMatrix would silently skew every normal.
  vec3 ln = normalize(normal / iSize);

  vec4 local = instanceMatrix * vec4(lp, 1.0);
  vLocal = position;
  vPos = local.xyz;
  vNrm = mat3(instanceMatrix) * ln;
  vT = aT;
  vPart = aPart;
  vCore = iCore;
  vTech = iTech;
  vSeed = iSeed;
  vSoot = iSoot;

  gl_Position = projectionMatrix * modelViewMatrix * local;
  #include <logdepthbuf_vertex>

  // ---- profile mask ------------------------------------------------------
  // One buffer holds every nozzle profile the ship uses, so one draw call
  // serves a hull that mixes doctrines (see mergeNozzleShapes). A vertex
  // belonging to a profile this instance is not drawing is pushed outside the
  // clip volume on all three axes; all three vertices of such a triangle get
  // the same position, so the primitive is trivially rejected before raster and
  // never reaches a fragment. Written AFTER logdepthbuf_vertex on purpose —
  // that chunk edits gl_Position, and a discarded primitive has no depth to be
  // wrong about.
  if (abs(aShape - iShape) > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const NOZZLE_FRAG = /* glsl */ `
#include <common>
#include <onespace_noise>
#include <logdepthbuf_pars_fragment>

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uFill;
uniform vec3  uCameraLocal;
uniform float uThrottle;
uniform float uGlowDepth;
uniform float uTime;
uniform float uTimeScale;
uniform float uPower;

varying vec3  vLocal;
varying vec3  vPos;
varying vec3  vNrm;
varying float vT;
varying float vPart;
varying vec3  vCore;
varying float vTech;
varying float vSeed;
varying float vSoot;

void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNrm);
  vec3 V = normalize(uCameraLocal - vPos);
  float NoL = max(dot(N, uSunDir), 0.0);
  float NoV = max(dot(N, V), 1e-4);
  float t = uTime * uTimeScale;

  // Every frequency below is in CYCLES PER NOZZLE, evaluated in unit space, so
  // a 4 m bell and a 400 m bell get the same corrugation count rather than the
  // same corrugation pitch. This is the fix for the nine kilometre-space noise
  // constants the reference ship bakes against a 30 m hull.
  vec3 q = vLocal + vSeed;
  float soot = smoothstep(0.20, 0.92, os_fbm(q * 5.5, 3, 2.3, 0.55) * 0.5 + 0.5);

  // AN ION DRIVE LEAVES NO CARBON. Every deposit term below is scaled by this,
  // so a Sillane port keeps the clean cool land its doctrine calls for while a
  // chemical or fusion bell blackens. vTech: 0 chemical, 1 ion, 2 fusion
  // torch, 3 plasma, 4 reaction plate — see DRIVE_TECH.
  float depTech = mix(1.0, 0.22, step(0.5, vTech) * step(vTech, 1.5));

  vec3 col;

  if (vPart < 0.5) {
    if (gl_FrontFacing) {
      // ---- outside of the bell ---------------------------------------------
      //
      // aT runs 0 AT THE THROAT to 1 AT THE EXIT LIP (see bellProfile), and
      // that axis — not a noise field — is what this surface is made of.
      //
      // A bell is the most heat- and soot-loaded surface on a ship. The gas is
      // hottest and cleanest where it is still confined, so the metal there
      // tempers: straw over the shoulder, blued back towards the throat. It is
      // coldest at the lip, where the flow has already expanded, and that is
      // where unburnt product condenses out — so the lip is carbon and stays
      // carbon. Luminance therefore RISES from lip to throat.
      //
      // Until this round it did the exact opposite: the warm tint was mixed in
      // *towards* vT = 1 and the value peaked at the lip, which drew a clean,
      // bright, bilaterally banded cone. Measured off ship-engine-close, the
      // bell exterior came out at (214, 194, 166) — the brightest and warmest
      // non-emissive surface on the whole ship, sixty points above the mid-hull,
      // while a plume burned in the same frame. That is worse than no wear at
      // all: it tells the viewer these engines have never fired.
      float dep = smoothstep(0.08, 0.80, vT);
      dep = clamp(dep * mix(0.88, 1.08, soot) * depTech, 0.0, 1.0);

      // Phase-modulating the corrugation varies its pitch and a per-rib hash
      // varies its depth, so some rings are crisp and some are half beaten
      // flat — a pure sine gives every ring the same everything. Its amplitude
      // now DIES INTO THE DEPOSIT: soot fills a corrugation. Banding that is as
      // crisp at the lip as at the shoulder is what made the review read the
      // pattern as decoration rather than as a heat gradient.
      float wob = os_fbm(q * 9.0, 2, 2.2, 0.5);
      float ribPhase = vT * 46.0 + 2.1 * wob;
      float ribId = floor(ribPhase / 6.2831853);
      float ribJ = fract(sin(ribId * 91.7 + 3.1 + vSeed) * 43758.5453);
      float rib = (0.5 + 0.5 * sin(ribPhase)) * mix(0.25, 1.0, ribJ);
      rib = mix(0.5, rib, mix(1.0, 0.35, dep));

      // THE VALUE CEILING, and it is the point of this branch. ShipMaterial
      // authors its reference plate at ~0.058 and its VALUE_CEILING lets only
      // bare steel and the faction accent go above that. The brightest this
      // surface can reach is 0.044 — below the plate it bolts to. Round three
      // over-corrected an earlier "the bell is a cut pipe" finding by lifting
      // the whole cone to 0.132, i.e. 2.3x the plate; the actual fix for that
      // finding is CONTRAST WITHIN THE BELL, which is what the ramp below is,
      // not a uniformly brighter cone.
      vec3 blued  = vec3(0.036, 0.040, 0.054);   // heat-blued steel, throat end
      vec3 straw  = vec3(0.046, 0.038, 0.023);   // straw temper over the shoulder
      vec3 carbon = vec3(0.0115, 0.0108, 0.0100); // deposit, at and past the lip
      vec3 base = mix(blued, straw, smoothstep(0.04, 0.38, vT) * depTech);
      base = mix(base, carbon, dep);
      base *= mix(0.80, 1.10, rib);

      float ao = 0.72 + 0.28 * rib;
      col = base * (uSunColor * NoL + uFill * 1.3) * ao;
      // Grazing sheen: the cheapest thing that stops metal reading as clay. On
      // a cone it peaks exactly ON THE SILHOUETTE, which is why it drew the
      // bone-white rim round every bell in ship-star-rimlight. Carbon has no
      // lining, so it is now killed by the deposit rather than only thinned by
      // the noise.
      col += uSunColor * pow(1.0 - NoV, 4.0)
           * smoothstep(-0.3, 0.3, dot(N, uSunDir))
           * 0.038 * (1.0 - 0.85 * dep) * (1.0 - 0.5 * soot);
      // The plume does light the outside of the lip — through a millimetre of
      // soot. Rationed for the same reason the sheen is: the wash has to lose
      // to the geometry, not the other way round.
      col += vCore * uThrottle * 0.13 * smoothstep(0.72, 1.0, vT) * (1.0 - 0.55 * dep);
    } else {
      // ---- throat interior -------------------------------------------------
      // METAL first, light source second. This branch used to be pure emission,
      // so at zero throttle every term in it vanished and an unlit bell was a
      // black void with a bright ring — which is exactly what the fleet frame
      // shows. A bell is a mirror trap: its inside catches fill from the whole
      // aft hemisphere, not from N alone, hence the fill multiplier.
      vec3 wall = mix(vec3(0.048, 0.044, 0.040), vec3(0.017, 0.015, 0.014), soot);
      col = wall * (uFill * 3.6 + uSunColor * NoL * 0.30) * (0.32 + 0.68 * vT);

      // THE THROAT IS THE HOT END. The old term was smoothstep(1-d, 1, vT):
      // it peaked at the exit LIP and was zero at the throat, which put the
      // brightest pixel of the whole drive outside the bell, left the throat
      // black, and drew the thin bright rim the review measured. uGlowDepth is
      // now how far AFT of the throat the glow reaches as the drive spools.
      float depth = 1.0 - smoothstep(0.0, uGlowDepth, vT);
      float turb = 0.75 + 0.25 * os_snoise(q * 4.0 + vec3(0.0, 0.0, -t * 7.0));
      // HALVED, and deliberately. This is an OPAQUE surface filling the mouth of
      // the bell, so whatever radiance it carries is what the shot's subject —
      // the nozzle geometry — is rendered at. At 2.3 + 0.70 it sat three times
      // the tone map's white point across the whole visible throat, which meant
      // the bell interior was a flat white disc and the corrugation, the lip and
      // the injector behind it were all gone. At 1.15 + 0.34 it is still fifteen
      // times the lit plating beside it, which is all "the throat is visibly
      // hotter than the outside of the bell" ever needed.
      col += vCore * depth * (0.08 + 1.15 * uThrottle) * turb * uPower;
      col += vec3(1.0, 0.93, 0.86) * depth * pow(uThrottle, 3.0) * 0.34;
    }
  } else if (vPart < 1.5) {
    // Spike or plug: metal the exhaust washes over. It is hot at the root and
    // cools along its length, and that gradient is the read on the whole style.
    float wash = pow(clamp(vT, 0.0, 1.0), 0.7);
    vec3 base = mix(vec3(0.030, 0.026, 0.022), vec3(0.016, 0.014, 0.013), soot);
    col = base * (uSunColor * NoL + uFill * 1.3);
    col += uSunColor * pow(1.0 - NoV, 4.0) * smoothstep(-0.3, 0.3, dot(N, uSunDir)) * 0.02;
    col += vCore * uThrottle * (0.15 + 1.4 * wash) * uPower;
  } else if (vPart < 2.5) {
    // Hardware: pumps, flanges, ribs, thrust frame, light housings. Never
    // glows — if the plumbing lit up as brightly as the throat the eye would
    // lose the throat.
    //
    // THE DEPOSIT FALLS OFF THE BELL ONTO WHAT SURROUNDS IT. vLocal.z is the
    // unit-nozzle axis: 0 at the throat, 1 at the exit plane, and the cage runs
    // -0.78 to 0.43 along it. So the tubes standing beside the mouth are carbon
    // and the forward end of the cage, where a gantry crew works, is merely
    // dirty. Without this the frame was a clean white lattice bolted around a
    // firing engine.
    //
    // vSoot says how much of that this instance lives in, because deposit is
    // a property of WHERE A PART SITS and this mesh's one fitting geometry is
    // both an RCS cup (which blackens round its own mouth) and a navigation
    // lamp cowl on clean plating amidships (which does not).
    float aft = smoothstep(-0.55, 0.62, vLocal.z) * vSoot * depTech;
    // Ceiling dropped from 0.086 to 0.056, i.e. from 1.5x the hull's reference
    // plate to just under it. A thrust frame nobody can see is not a thrust
    // frame — but a thrust frame brighter than every plate on the ship is a
    // light fitting, and it read as one in every frame of round four.
    vec3 base = mix(vec3(0.056, 0.053, 0.050), vec3(0.026, 0.024, 0.023), soot * 0.7);
    base = mix(base, vec3(0.0135, 0.0128, 0.0120), aft * 0.88);
    col = base * (uSunColor * NoL + uFill * 1.25);
    col += uSunColor * pow(1.0 - NoV, 4.0) * smoothstep(-0.3, 0.3, dot(N, uSunDir))
         * 0.030 * (1.0 - 0.8 * aft);
  } else if (vPart < 3.5) {
    // The emissive working face. Two completely different objects share this
    // branch because both are flat and neither is a bell.
    float rad = length(vLocal.xy);
    vec3 base = vec3(0.020, 0.019, 0.018) * (uSunColor * NoL + uFill * 1.2);
    if (vTech > 3.5) {
      // Reaction plate: discrete detonations, not a flow. The pulse is what
      // stops it reading as a lamp.
      float rings = 0.5 + 0.5 * sin(rad * 46.0);
      float pulse = pow(0.5 + 0.5 * sin(t * 7.0 + vSeed * 6.2831), 8.0);
      col = base + vCore * uPower * (0.04 + uThrottle * (0.4 + 2.6 * pulse)) * mix(0.55, 1.0, rings);
    } else {
      // Ion accelerator grid: a perforated plate whose holes are the emitter.
      vec2 cell = fract(vLocal.xy * 11.0) - 0.5;
      float hole = 1.0 - smoothstep(0.17, 0.33, length(cell));
      float edge = 1.0 - smoothstep(0.80, 0.95, rad);
      float shimmer = 0.85 + 0.15 * os_snoise(vec3(vLocal.xy * 6.0, t * 0.9));
      // The idle floor is raised because a recessed drive's whole read is that
      // you see a LIT THROAT and never a bell. At 0.10 the face was dark enough
      // that the port read as an empty hole in the skin.
      col = base + vCore * hole * edge * shimmer * uPower * (0.28 + 1.55 * uThrottle);
    }
  } else {
    // ---- injector face: the closed floor of the throat ---------------------
    // The single most damaging thing an unlit nozzle can do is show the
    // starfield through its own axis. This face is the reason it no longer can.
    float r = clamp(vT, 0.0, 1.0);
    float el = 0.5 + 0.5 * sin(r * 34.0 + vSeed * 6.2831);
    vec3 base = mix(vec3(0.062, 0.057, 0.052), vec3(0.022, 0.020, 0.018), soot * 0.8)
              * mix(0.55, 1.0, el);
    // It faces aft into a cavity, so the key almost never reaches it: what
    // makes it legible cold is fill plus its own concentric machining.
    col = base * (uFill * 3.2 + uSunColor * NoL * 0.22);
    float hot = pow(1.0 - r, 1.6);
    // Same reasoning as the throat interior above: this is opaque hardware, and
    // hardware that tone maps to flat white has stopped being hardware.
    col += vCore * uPower * (0.05 + 1.50 * uThrottle) * hot * mix(0.72, 1.0, el);
    col += vec3(1.0, 0.94, 0.88) * pow(uThrottle, 2.2) * hot * 0.50;
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * One additive program for plumes, RCS jets, emissive fixtures and the wake.
 *
 * They share an attribute layout and branch on `iKind`. Every instance in a
 * given mesh has the same kind, so the branch is fully coherent per draw and
 * costs nothing; what it buys is the material budget (BRIEF §6 allows three per
 * ship and the hull needs one).
 */
/**
 * The one law the vertex and fragment stages must agree on.
 *
 * A rocket exhaust leaving a throat into vacuum has nothing to push against, so
 * it expands: to first order its radius grows LINEARLY with axial distance,
 *
 *     r(s) = r_exit * (1 + k*s)
 *
 * and the same luminosity is therefore smeared over an area growing as r², so
 * its surface brightness falls as
 *
 *     L(s) = L0 / (1 + k*s)²
 *
 * on geometry alone, before any cooling. Both stages compute `k` from the same
 * `iTech` attribute rather than passing it, so the radius the vertex shader
 * builds and the falloff the fragment shader applies can never drift apart —
 * which is the failure that produced a constant-radius tube of constant
 * brightness running the full width of the frame.
 *
 * `k` is the whole technology read now that girth is no longer a per-tech
 * multiplier: an ion beam diverges hard and faintly, a magnetic nozzle holds
 * its column together, and the difference is 3.2 against 2.0 rather than two
 * cylinders of different diameter.
 */
const PLUME_EXPANSION = /* glsl */ `
float osPlumeExpansion(float tech) {
  if (tech < 0.5) return 2.3;   // chemical      — under-expanded, blooms fast
  if (tech < 1.5) return 3.2;   // ion           — a wide, faint, diverging fan
  if (tech < 2.5) return 2.0;   // fusion torch  — the most collimated of them
  if (tech < 3.5) return 2.1;   // plasma        — pinched, but still expanding
  return 5.4;                   // reaction plate — a pancake, not a column
}
`;

const ADDITIVE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${PLUME_EXPANSION}

attribute float aT;
attribute float aLayer;

attribute float iKind;
attribute vec3  iColor;   // core / fixture colour
attribute vec3  iEdge;    // envelope colour
attribute vec4  iSizeA;   // (length|halfWidth, width|halfHeight, intensity, phase)
attribute vec4  iSizeB;   // (diamonds|pattern, flicker|chaseIndex, tech, spare)
attribute float iDrive;   // dynamic: throttle | jet level | bus power

uniform float uTime;
uniform float uTimeScale;
uniform float uThrottle;
uniform float uBoost;
uniform float uHeat;
uniform float uPixelAngle;    // radians per pixel: km/px = viewDepth * this
uniform float uMinPixels;

varying vec3  vCol;
varying vec3  vEdge;
varying vec2  vUv;
varying float vT;
varying float vKind;
varying float vDrive;
varying vec4  vA;
varying vec4  vB;
varying vec3  vNrm;
varying vec3  vPos;

void main() {
  vCol = iColor;
  vEdge = iEdge;
  vUv = uv;
  vT = aT;
  vKind = iKind;
  vDrive = iDrive;
  vA = iSizeA;
  vB = iSizeB;
  vNrm = vec3(0.0, 0.0, 1.0);
  vPos = instanceMatrix[3].xyz;

  float t = uTime * uTimeScale;

  if (iKind < 0.5) {
    // ------------------------------------------------------------------ plume
    float tech = iSizeB.z;
    // iSizeA holds the FULL-THROTTLE column. A drive at idle is a short, thin
    // stub of flame, not a full plume that merely dims — an unlit plume of full
    // length is the classic tell that the effect is a texture.
    float grow = 0.15 + 0.85 * uThrottle + 0.55 * uBoost;
    // Boost buys LENGTH and colour temperature; it must never buy girth. A
    // column that fattens under boost is a balloon, and the +0.20*uBoost that
    // used to be here is half of why the plume left the bell wider than the
    // bell — a mushroom the review measured at 40% of the hull beam.
    //
    // The floor is 0.78, not 0.62: this scales the radius AT THE EXIT PLANE,
    // and a drive at cruise still fills the throat it is flowing through.
    float fat = 0.78 + 0.22 * uThrottle;
    // The core is a shell NESTED IN the envelope, sharing its origin, its axis
    // and its expansion law — a shorter, narrower cone of the same shape, not a
    // second column. At 0.60/0.44 it was a thread down the middle of a much
    // fatter cone, which is why the pair read as two objects rather than as one
    // column with a hot centre.
    float len = iSizeA.x * grow * mix(1.0, 0.78, aLayer);
    float wid = iSizeA.y * fat * mix(1.0, 0.62, aLayer);

    // ---- expansion -------------------------------------------------------
    // r(s) = r_exit * (1 + k*s). EVERY technology widens; what differs is how
    // fast. The profiles that used to be here all fell monotonically from ~1.0
    // — the column could never be wider than the exit plane — so a jet four
    // nozzle diameters downstream was still exactly as wide as its throat.
    // Over four nozzle diameters this now reaches ~1.7×, and ~2.4× over the
    // visible length.
    float k = osPlumeExpansion(tech);
    float grew = 1.0 + k * aT;

    float prof;
    if (tech < 0.5) {
      // chemical — a short over-pressure flare right at the lip, riding on the
      // expansion rather than replacing it
      prof = grew * (1.0 + 0.10 * smoothstep(0.0, 0.05, aT) * (1.0 - smoothstep(0.05, 0.28, aT)));
    } else if (tech < 1.5) {
      // ion — starts just inside the grid, then diverges hard and faintly
      prof = grew * 0.86;
    } else if (tech < 2.5) {
      // fusion torch — necks down off the exit plane before it opens out
      prof = grew * mix(0.94, 1.0, smoothstep(0.0, 0.07, aT));
    } else if (tech < 3.5) {
      // plasma — a magnetic nozzle beads the column into pinches. They ride ON
      // the expansion; at 0.34 each pinch was a separate closed bulb, which is
      // what the review counted as "plume bodies with no bell behind them".
      prof = grew * (1.0 + 0.13 * sin(aT * 9.0 + iSizeA.w * 6.2831));
    } else {
      // reaction plate — a pancake hugging the plate, not a column
      prof = (1.0 + k * pow(aT, 0.45)) * (1.0 - smoothstep(0.20, 1.0, aT));
    }
    // The column CLOSES. The radiance falloff already reaches zero here, but a
    // shell whose last ring still has radius is a polygon waiting to be seen
    // edge-on, and "ends in a hard edge" is one of this shot's stated failures.
    prof *= 1.0 - 0.42 * smoothstep(0.86, 1.0, aT);

    // A drive is never perfectly steady, and a rank of six that wobbles in
    // lockstep reads as one animated object rather than six machines.
    //
    // AMPLITUDE AND FREQUENCY ARE BOTH CAPPED. Unclamped, flicker reaches
    // 0.55 on an Ossuary drive and the old gain (0.4 + throttle + boost) hit
    // 2.05 at burn: the radius swung by ±113% at four cycles per column, i.e.
    // the column pinched to zero and ballooned four times along its length.
    // Those were the "lumpy nodules" and the phantom extra plumes — one
    // instance per nozzle drawing four separate bulbs.
    float wob = 1.0 + clamp(iSizeB.y, 0.0, 1.0) * 0.20 * aT
                    * sin(aT * 11.0 + t * 11.0 + iSizeA.w * 6.2831)
                    * (0.45 + 0.55 * uThrottle);

    vec3 lp = vec3(normal.xy * (prof * wid * wob), aT * len);
    vec4 local = instanceMatrix * vec4(lp, 1.0);
    vNrm = mat3(instanceMatrix) * vec3(normal.xy, 0.0);
    // SHIP-LOCAL, to match uCameraLocal. This object carries no transform of
    // its own relative to the hull, so no modelMatrix is needed anywhere here —
    // which also keeps the effect independent of where the floating origin has
    // put the ship this frame.
    vPos = local.xyz;
    vB.w = aLayer;
    gl_Position = projectionMatrix * modelViewMatrix * local;

  } else if (iKind < 1.5) {
    // -------------------------------------------------------------- RCS jet
    // The axis is a REAL 3D segment transformed into view space and only then
    // projected. Billboarding purely in screen space makes a thruster firing
    // at the camera collapse to nothing instead of to a disc.
    vec3 c = instanceMatrix[3].xyz;
    vec3 dir = normalize(instanceMatrix[2].xyz);
    float lvl = iDrive;
    // iSizeA.x is authored from the thruster's own mouth radius. The length
    // multiplier used to reach 2.7, giving a column thirty-five nozzle
    // DIAMETERS long — the "row of birthday candles" the review saw. A cold-gas
    // puff is a few diameters, not tens.
    float len = iSizeA.x * (0.45 + 1.35 * lvl);
    float wid = iSizeA.y * (0.35 + 0.45 * lvl);

    // Starts AT the mouth, not 8% down the column: the root has to sit inside
    // the fitting it comes out of or the jet floats free of the hull.
    vec4 mvBase = modelViewMatrix * vec4(c, 1.0);
    vec4 mvTip = modelViewMatrix * vec4(c + dir * len, 1.0);
    vec4 mv = mix(mvBase, mvTip, uv.y);

    vec2 axis = mvTip.xy - mvBase.xy;
    float al = length(axis);
    axis = al > 1e-7 ? axis / al : vec2(1.0, 0.0);
    vec2 perp = vec2(-axis.y, axis.x);

    // Narrow at the throat, spreading as it expands — plus a small flare right
    // at the root, which is the gas hitting the plate it was fired across. That
    // flare is the emissive contribution onto the plating the jet emerges from.
    float pixKm = max(-mv.z, 0.0) * uPixelAngle;
    float halfW = wid * (0.55 + 1.25 * uv.y + 0.85 * pow(max(1.0 - uv.y, 0.0), 3.0));
    halfW = max(halfW, uMinPixels * pixKm * 0.5);
    mv.xy += perp * ((uv.x - 0.5) * 2.0 * halfW);

    gl_Position = projectionMatrix * mv;

  } else if (iKind < 2.5) {
    // --------------------------------------------------------- light fixture
    vec3 c = instanceMatrix[3].xyz;
    vec4 mv = modelViewMatrix * vec4(c, 1.0);
    float pixKm = max(-mv.z, 0.0) * uPixelAngle;
    // The LENS: a small disc that never falls below a couple of pixels.
    float lens = max(max(iSizeA.x, iSizeA.y), uMinPixels * pixKm * 0.5);
    // The card is sized for the SPILL, which is several times the lens. Splitting
    // the two is what lets the lens stay under the tone map's white point and
    // keep its colour while the spill still reaches the plating around it.
    float hw = lens * max(iSizeB.z, 1.0);

    // Camera-facing: a fixture seen at a glancing angle must DIM (which the
    // fragment does from the fitting's own normal) rather than shear into a
    // line, which is what a hull-plane quad does.
    mv.xy += vec2(position.x * 2.0 * hw, position.y * 2.0 * hw);
    // Pulled towards the camera by the LENS size only. Pushing it by the whole
    // spill card would lift a 17-pixel halo clear of the hull it is lying on.
    mv.z += lens;

    vNrm = mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0);
    vPos = instanceMatrix[3].xyz;
    gl_Position = projectionMatrix * mv;

  } else if (iKind < 3.5) {
    // ------------------------------------------------------------ plasma wake
    float prof = pow(aT, 0.45);
    // A perfect cone of revolution reads as a traffic cone, not as ionised gas
    // being torn off a hull.
    float rag = 1.0 + 0.30 * sin(normal.x * 3.0 + aT * 7.0 + t * 0.7)
                          * sin(normal.y * 5.0 - aT * 4.0 - t * 1.1);
    vec3 lp = vec3(normal.xy * (prof * iSizeA.y * uHeat * rag), aT * iSizeA.x * uHeat);
    vec4 local = instanceMatrix * vec4(lp, 1.0);
    vNrm = mat3(instanceMatrix) * vec3(normal.xy, 0.0);
    vPos = local.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * local;

  } else {
    // ------------------------------------------------------- engine wash card
    // ARCHITECTURE §6 and BRIEF §7 both require the drive to be the second
    // light source in the scene. The correct home for that is the hull shader
    // and it exists there in principle (ENGINE_GLOW_GLSL, above, is written
    // for exactly this) but nothing in src/ currently includes it, so at
    // full burn the plating beside a nozzle is no brighter than plating a hull
    // length away and the drive reads as a decal stuck behind the ship.
    //
    // Until the hull material takes the analytic version, the wash is carried
    // here: a camera-facing card sitting AT the nozzle mouth, additive over
    // everything drawn behind it, which is the thrust structure and the aft
    // third of the hull. It is not pushed towards the camera, so anything
    // forward of the mouth still occludes it correctly.
    //
    // IT MUST NOT BECOME A LOBE. This card is centred on the POD, i.e. between
    // the bells of a cluster, so anything big enough to have an outline reads
    // as one more plume sitting behind and offset from the real ones — which is
    // half of "two bells read as four plumes". It is now sized to the cluster
    // rather than to two and a half times the cluster, and it barely grows with
    // throttle: light on plating does not have a silhouette.
    vec3 c = instanceMatrix[3].xyz;
    vec4 mv = modelViewMatrix * vec4(c, 1.0);
    float pixKm = max(-mv.z, 0.0) * uPixelAngle;
    float rad = max(iSizeA.x * (0.62 + 0.38 * (uThrottle + uBoost * 0.5)),
                    uMinPixels * pixKm * 6.0);
    mv.xy += position.xy * 2.0 * rad;
    vPos = c;
    gl_Position = projectionMatrix * mv;
  }

  #include <logdepthbuf_vertex>
}
`;

const ADDITIVE_FRAG = /* glsl */ `
#include <common>
#include <onespace_noise>
#include <onespace_color>
#include <logdepthbuf_pars_fragment>
${PLUME_EXPANSION}

uniform vec3  uCameraLocal;
uniform float uTime;
uniform float uTimeScale;
uniform float uThrottle;
uniform float uBoost;
uniform float uHeat;
/** 1 / (shells * 2): how many additive surfaces a ray crosses at this rung. */
uniform float uPlumeGain;

varying vec3  vCol;
varying vec3  vEdge;
varying vec2  vUv;
varying float vT;
varying float vKind;
varying float vDrive;
varying vec4  vA;
varying vec4  vB;
varying vec3  vNrm;
varying vec3  vPos;

void main() {
  #include <logdepthbuf_fragment>
  float t = uTime * uTimeScale;
  vec3 col;

  if (vKind < 0.5) {
    // ------------------------------------------------------------------ plume
    vec3 N = normalize(vNrm);
    vec3 V = normalize(uCameraLocal - vPos);
    // A column of gas is optically thin, so the radiance along a ray is the
    // chord it cuts, and for a shell of revolution |N·V| is 1 where the ray
    // passes down the column's centre and 0 where it grazes the silhouette.
    //
    // THE SILHOUETTE IS NOW FEATHERED IN RADIUS, not left to the chord. The
    // chord alone is still 0.79 at HALF the radius and 0.44 at 80% of it, so
    // with the column's core well above the tone map's shoulder every one of
    // those values landed on the same display white and the shell ended on its
    // own polygon. rN is the normalised distance from the axis; the ramp over
    // its outer 45% is what makes the edge die out instead of stopping.
    float ndv = abs(dot(N, V));
    float rN = sqrt(max(1.0 - ndv * ndv, 0.0));
    float shell = pow(ndv, 1.6) * (1.0 - smoothstep(0.55, 1.0, rN));
    float tech = vB.z;
    float layer = vB.w;
    float heat = clamp(uThrottle * 0.30 + uBoost * 0.85, 0.0, 1.0);

    // ---- axial falloff ---------------------------------------------------
    // Geometric dilution first: the same light spread over an area growing as
    // r², with r the SAME (1 + k*s) the vertex shader built the column from.
    // Then cooling on top, because gas that has expanded has also dropped in
    // temperature and stops radiating. Together these fall to ~18% of the
    // throat value four nozzle diameters downstream and to zero at the tip,
    // where pow(1-s, 2.2) alone was still at 60% four diameters out — a jet
    // that neither expanded nor cooled, i.e. a fluorescent tube.
    float k = osPlumeExpansion(tech);
    float grew = 1.0 + k * vT;
    float dilute = 1.0 / (grew * grew);
    float axial;
    if (tech > 0.5 && tech < 1.5) {
      // An ion beam has no hot root: it brightens away from the grid and then
      // thins out over a very long distance.
      axial = dilute * pow(max(1.0 - vT, 0.0), 1.15) * smoothstep(0.0, 0.20, vT);
    } else {
      axial = dilute * pow(max(1.0 - vT, 0.0), 1.45 - 0.25 * heat);
    }

    // Radiance, not opacity. uPlumeGain divides by the number of shell surfaces
    // a ray crosses (two faces per nested layer, all additive), so adding a
    // layer makes the column DEEPER, not brighter, and two LOD rungs with
    // different shell counts read the same.
    float I = vA.z * uPlumeGain * vDrive
            * smoothstep(0.0, 0.15, uThrottle + uBoost)
            * (0.26 + uThrottle * 0.60 + uBoost * 0.32);

    vec3 base = mix(vEdge, vCol, layer);
    base = mix(base, vec3(1.0, 0.96, 0.92), heat * 0.55);
    col = base * shell * axial * I;

    // THE THROAT IS THE ONLY THING HERE ALLOWED ABOVE 1.0 SCENE-LINEAR.
    // e-folding in ~3% of the column, so what blooms is the emitter and not
    // twelve percent of the frame. The column body was carrying this radiance
    // for its whole visible length, which is why its falloff lived entirely
    // above the grade's shoulder and never reached the screen.
    // An ion drive is excepted: there is nothing burning at its grid, and the
    // whole read of the technology is that it brightens AWAY from the emitter.
    float hotRoot = (tech > 0.5 && tech < 1.5) ? 0.0 : 1.0;
    col += base * exp(-vT * 34.0) * shell * I * 2.2 * hotRoot
         * smoothstep(0.05, 0.55, uThrottle + uBoost);

    // Shock diamonds. vB.x is the blueprint's diamond COUNT, so the sine runs
    // exactly that many periods over the column however long it is — and they
    // only exist once the flow is over-expanded, which is why they arrive at
    // high throttle and are absent from ion and plate drives entirely.
    if (vB.x > 0.5) {
      float sd = pow(max(sin(vT * 6.2831853 * vB.x - t * 2.0) * 0.5 + 0.5, 0.0), 14.0);
      sd *= exp(-vT * 3.6) * smoothstep(0.42, 0.90, uThrottle + uBoost * 0.5);
      // MULTIPLIED BY shell. Without it every diamond was a full-width band
      // painted right out to the polygon edge — a hard-edged bright rung across
      // a column whose own body was feathered, which is the "sausage-chain seam
      // along each" the review measured. A shock lives inside the gas.
      col += mix(base, vec3(1.0), 0.5) * sd * shell * (0.3 + layer) * I * 1.4;
    }

    if (tech > 3.5) {
      // The plate's wash is pulsed to match the face flashing behind it.
      col *= 0.35 + 1.9 * pow(0.5 + 0.5 * sin(t * 7.0 + vA.w * 6.2831), 8.0);
    } else if (tech < 1.5 && tech > 0.5) {
      // No white core on an ion drive: there is nothing burning.
    } else {
      col += vec3(1.0, 0.96, 0.90) * layer * pow(max(1.0 - vT, 0.0), 4.5)
           * shell * I * 0.5;
    }

  } else if (vKind < 1.5) {
    // -------------------------------------------------------------- RCS jet
    // Soft at the wall AND soft at the tip. The old smoothstep(0.15, 1.0) held
    // the core at full radiance across the middle 30% of the width, and at 5.5x
    // the white point the whole bar clipped solid with a blunt flat end — the
    // same "ends in a hard edge" failure the brief rejects for the main plume.
    float r = abs(vUv.x - 0.5) * 2.0;
    float axialJ = clamp(1.0 - vUv.y, 0.0, 1.0);
    float a = pow(clamp(1.0 - r, 0.0, 1.0), 1.9) * pow(axialJ, 2.4) * vDrive;
    col = mix(vCol, vec3(1.0), pow(axialJ, 3.0) * 0.7) * a * vA.z;

  } else if (vKind < 2.5) {
    // --------------------------------------------------------- light fixture
    // Two lobes with two jobs. The LENS carries the hue and must stay near the
    // white point — a fixture at 11–15x radiance tone maps to pure white and
    // stops being a port light or a starboard light at all, which is why the
    // review found "a bare white sphere". The SPILL is faint and wide and is
    // what puts light on the plating the fitting is bolted to.
    vec2 d = vUv - 0.5;
    float r = length(d) * 2.0;
    float lensR = max(vB.z, 1.0);
    float a = pow(clamp(1.0 - r * lensR, 0.0, 1.0), 2.2)
            + pow(clamp(1.0 - r, 0.0, 1.0), 3.0) * 0.20;

    float ph = vA.w;
    float k;
    if (vB.x < 0.5) {
      // Steady position light. It breathes very slightly; a mathematically
      // constant emitter is the one thing on a hull that never looks real.
      k = 0.92 + 0.08 * sin(t * 1.3 + ph * 6.2831);
    } else if (vB.x < 1.5) {
      // Anti-collision strobe: a hard double flash. The floor is deliberately
      // not zero — at zero, most still frames of a ship have no lights at all.
      float c = fract(t * 0.62 + ph);
      k = 0.13 + 2.6 * max(exp(-pow((c - 0.02) / 0.022, 2.0)),
                           exp(-pow((c - 0.11) / 0.022, 2.0)));
    } else if (vB.x < 2.5) {
      // Rotating beacon: it ramps through, it never snaps.
      k = mix(0.18, 1.0, pow(clamp(sin(t * 1.15 + ph * 6.2831), 0.0, 1.0), 3.0));
    } else {
      // Docking guide: a chase running round the collar towards the port.
      float c = fract(t * 0.9 - vB.y * 0.11);
      k = 0.18 + 1.7 * exp(-pow(c / 0.075, 2.0));
    }

    // The fitting has a housing: a lamp on the far side of the hull must not
    // shine through it. vNrm is the fixture's own outward normal.
    float facing = max(dot(normalize(vNrm), normalize(uCameraLocal - vPos)), 0.0);
    col = vCol * a * k * vA.z * vDrive * pow(facing, 0.7);

  } else if (vKind < 3.5) {
    // ------------------------------------------------------------ plasma wake
    vec3 N = normalize(vNrm);
    vec3 V = normalize(uCameraLocal - vPos);
    float shell = pow(abs(dot(N, V)), 1.1);
    // Driven by the ring direction rather than by uv.x: uv wraps at the seam
    // and leaves a stationary bright stripe down one side of the cone.
    vec2 ringDir = normalize(vNrm.xy + 1e-6);
    float n = os_fbm(vec3(ringDir * 6.0, vT * 5.0 - t * 2.2) + vec3(0.0, 0.0, t * 0.35), 4, 2.3, 0.55);
    float fil = 0.12 + 0.88 * smoothstep(0.25, 0.85, n * 0.5 + 0.5);
    float fade = pow(max(1.0 - vT, 0.0), 2.6) * smoothstep(0.0, 0.1, vT);
    vec3 hot = os_blackbody(mix(1800.0, 4600.0, uHeat * (1.0 - vT * 0.6)));
    // The far tail cools into ionised violet rather than fading to grey.
    hot = mix(hot, vec3(0.45, 0.24, 0.8), smoothstep(0.35, 1.0, vT) * 0.8);
    col = hot * shell * fade * fil * uHeat * uHeat * vA.z;

  } else {
    // ------------------------------------------------------- engine wash card
    // Squared in throttle, so it is genuinely absent when the drive is cold and
    // climbs faster than the plume does. No shock structure, no silhouette, no
    // detail of any kind: it is light on plating, and anything you can see the
    // EDGE of has stopped being light and become an object.
    vec2 d = vUv - 0.5;
    float r = length(d) * 2.0;
    // Steeper than 2.6: the wash has to hug the mouth. A shallow falloff over a
    // card this size puts a readable disc edge out in open space beside the
    // bells, and anything you can see the EDGE of has stopped being light and
    // become an object.
    float f = pow(clamp(1.0 - r, 0.0, 1.0), 3.6);
    float thr = clamp(uThrottle + uBoost * 0.5, 0.0, 1.0);
    col = vCol * f * vA.z * vDrive * thr * thr;
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

const _fwd = new Vector3();
const _up = new Vector3();
const _right = new Vector3();

/**
 * Rigid basis from a blueprint `Frame`: local +Z = `forward`, +Y = `up`.
 *
 * Re-orthogonalised on the way in. A blueprint frame is supposed to be
 * orthonormal, but one degenerate frame in a generated fleet would otherwise
 * produce a NaN matrix and take the whole instanced mesh with it.
 */
function frameMatrix(f: Frame, out: Matrix4): Matrix4 {
  _fwd.set(f.forward[0], f.forward[1], f.forward[2]);
  if (_fwd.lengthSq() < 1e-18) _fwd.set(0, 0, 1);
  _fwd.normalize();
  _up.set(f.up[0], f.up[1], f.up[2]);
  _up.addScaledVector(_fwd, -_up.dot(_fwd));
  if (_up.lengthSq() < 1e-14) {
    _up.set(0, 1, 0).addScaledVector(_fwd, -_fwd.y);
    if (_up.lengthSq() < 1e-14) _up.set(1, 0, 0).addScaledVector(_fwd, -_fwd.x);
  }
  _up.normalize();
  // right = up × forward, matching `frameRight()` in the blueprint contract.
  _right.crossVectors(_up, _fwd);
  return out.makeBasis(_right, _up, _fwd);
}

// ---------------------------------------------------------------------------
// Per-instance staging
// ---------------------------------------------------------------------------

/** Everything the additive material needs per instance, before upload. */
class AdditiveBatch {
  readonly matrix: Float32Array;
  readonly kind: Float32Array;
  readonly color: Float32Array;
  readonly edge: Float32Array;
  readonly sizeA: Float32Array;
  readonly sizeB: Float32Array;
  readonly drive: Float32Array;
  count = 0;

  constructor(readonly capacity: number) {
    this.matrix = new Float32Array(capacity * 16);
    this.kind = new Float32Array(capacity);
    this.color = new Float32Array(capacity * 3);
    this.edge = new Float32Array(capacity * 3);
    this.sizeA = new Float32Array(capacity * 4);
    this.sizeB = new Float32Array(capacity * 4);
    this.drive = new Float32Array(capacity);
  }

  push(m: Matrix4, kind: number, col: Color, edge: Color, a: readonly number[], b: readonly number[], drive: number): number {
    const i = this.count;
    if (i >= this.capacity) return -1;
    m.toArray(this.matrix, i * 16);
    this.kind[i] = kind;
    this.color[i * 3] = col.r;
    this.color[i * 3 + 1] = col.g;
    this.color[i * 3 + 2] = col.b;
    this.edge[i * 3] = edge.r;
    this.edge[i * 3 + 1] = edge.g;
    this.edge[i * 3 + 2] = edge.b;
    for (let k = 0; k < 4; k++) {
      this.sizeA[i * 4 + k] = a[k];
      this.sizeB[i * 4 + k] = b[k];
    }
    this.drive[i] = drive;
    this.count = i + 1;
    return i;
  }

  /** Attach every instanced attribute to a geometry and return the drive attribute. */
  attach(g: BufferGeometry, dynamicDrive: boolean): InstancedBufferAttribute {
    g.setAttribute('iKind', new InstancedBufferAttribute(this.kind.subarray(0, this.count), 1));
    g.setAttribute('iColor', new InstancedBufferAttribute(this.color.subarray(0, this.count * 3), 3));
    g.setAttribute('iEdge', new InstancedBufferAttribute(this.edge.subarray(0, this.count * 3), 3));
    g.setAttribute('iSizeA', new InstancedBufferAttribute(this.sizeA.subarray(0, this.count * 4), 4));
    g.setAttribute('iSizeB', new InstancedBufferAttribute(this.sizeB.subarray(0, this.count * 4), 4));
    const drv = new InstancedBufferAttribute(this.drive.subarray(0, this.count), 1);
    if (dynamicDrive) drv.setUsage(DynamicDrawUsage);
    g.setAttribute('iDrive', drv);
    return drv;
  }
}

/**
 * An `AdditiveBatch` that also stages the fittings the emitters sit in.
 *
 * A lamp and its housing are one object that happens to need two programs, and
 * they were being authored in two places — which is how the housing came to not
 * be authored at all. Staging them together makes it impossible to add a
 * fixture without adding the hardware it is bolted into.
 */
class LightBatch extends AdditiveBatch {
  readonly housingMatrix: Float32Array;
  readonly housingSize: Float32Array;
  housingCount = 0;

  constructor(capacity: number) {
    super(capacity);
    this.housingMatrix = new Float32Array(capacity * 16);
    this.housingSize = new Float32Array(capacity);
  }

  housing(m: Matrix4, size: number): void {
    const i = this.housingCount;
    if (i >= this.capacity) return;
    m.toArray(this.housingMatrix, i * 16);
    this.housingSize[i] = size;
    this.housingCount = i + 1;
  }
}

/** One drawn nozzle. Kept flat so the gimbal loop touches no objects. */
interface NozzleSlot {
  readonly plumeSlot: number;
  readonly gimbal: number;
}

/**
 * Everything about the drawn nozzles that does NOT depend on the LOD rung.
 *
 * Staged once in the constructor and gathered per rung. The instance data — a
 * nozzle's place, its size and its seed — is a property of the ship; only the
 * mesh it is packed into and the tessellation of that mesh belong to a rung.
 */
interface NozzleStage {
  /** Per nozzle, in drawing order. */
  readonly style: NozzleStyle[];
  /** n × 3: (exitRadius, exitRadius, bellLength) km. */
  readonly size: Float32Array;
  /** n × 16, rigid. */
  readonly matrix: Float32Array;
  readonly seed: Float32Array;
  readonly count: number;
}

/** The same, for the small fittings: RCS cups and lamp housings. */
interface FixtureStage {
  readonly size: Float32Array;
  readonly matrix: Float32Array;
  readonly seed: Float32Array;
  readonly count: number;
}

/**
 * One built rung of the propulsion LOD ladder.
 *
 * The instanced ATTRIBUTE buffers are shared across every rung — they are
 * subarray views onto the staged data, so four rungs cost four sets of
 * geometry and one set of instance data. In particular `iDrive`, which is
 * rewritten every frame, is one Float32Array with one view per rung, so the
 * per-frame write is a single linear run whatever rung is showing.
 */
interface PropulsionRung {
  readonly level: number;
  readonly group: Group;
  readonly geometries: BufferGeometry[];
  /**
   * ONE mesh, or none at the impostor rung — never a list.
   *
   * It used to be one per distinct `NozzleStyle`, which is why the gimbal path
   * needed a (mesh, slot) indirection per nozzle. Every profile now lives in
   * one buffer selected per instance, so instance `i` IS nozzle `i` in the
   * staging order and the indirection is gone with the meshes it existed for.
   */
  readonly nozzleMesh: InstancedMesh | null;
  readonly fixtureMesh: InstancedMesh | null;
  readonly plumeMesh: InstancedMesh | null;
  readonly quadMesh: InstancedMesh | null;
  readonly wakeMesh: InstancedMesh | null;
  readonly plumeDrive: InstancedBufferAttribute | null;
  readonly quadDrive: InstancedBufferAttribute | null;
  readonly plumeGain: number;
  /** Drawn triangles at this rung, for the review manifest. */
  readonly triangles: number;
  /** Visible draw calls at this rung. */
  readonly drawCalls: number;
}

// ---------------------------------------------------------------------------
// Shared programs
// ---------------------------------------------------------------------------

/**
 * Refcounted material cache, mirroring `ShipMaterial.ts`'s `acquireProgram`.
 *
 * BRIEF §6: "materials per ship ≤ 3, shared across ships of a family." These
 * two were being constructed in the constructor, so a six-ship formation
 * compiled twelve propulsion programs that differed in nothing at all — every
 * value that varies per ship (`uTimeScale`, `uMinPixels`, the fill colour, the
 * throttle, the clock) is a uniform, and every value that varies per nozzle
 * (`iCore`, `iTech`, `iSeed`, `iSizeA`) is already an instanced attribute.
 *
 * KEYED ON TIER ALONE, deliberately. The review asked for `(tier, drive)`, but
 * neither program branches on drive at COMPILE time — the drive arrives as the
 * per-instance `iTech` float that both fragment shaders switch on. Adding it to
 * the key would split the cache for a mixed-technology formation and buy
 * nothing. The stated verification (five ships of one faction ⇒ ≤ 6 distinct
 * materials) passes either way; this key also collapses a mixed fleet.
 */
interface PropulsionProgram {
  readonly key: string;
  readonly nozzle: ShaderMaterial;
  readonly additive: ShaderMaterial;
  refs: number;
}

const PROGRAM_CACHE = new Map<string, PropulsionProgram>();

function acquireProgram(quality: QualitySettings): PropulsionProgram {
  const key = quality.tier;
  const hit = PROGRAM_CACHE.get(key);
  if (hit) {
    hit.refs++;
    return hit;
  }

  // Every uniform here is a PLACEHOLDER. The owning ship pushes its own values
  // in `onBeforeRender` immediately before each of its draws, exactly as
  // `ShipMesh.pushUniforms` does for the hull — which is what makes sharing one
  // program between ships at different throttles legal.
  const nozzle = new ShaderMaterial({
    name: `ship-nozzle:${key}`,
    uniforms: {
      uSunDir: { value: new Vector3(0, 0, 1) },
      uSunColor: { value: new Color(1, 1, 1) },
      uFill: { value: new Color(0.010, 0.014, 0.022) },
      uCameraLocal: { value: new Vector3() },
      uThrottle: { value: 0 },
      uGlowDepth: { value: 0.2 },
      uTime: { value: 0 },
      uTimeScale: { value: 1 },
      uPower: { value: 0 },
    },
    vertexShader: NOZZLE_VERT,
    fragmentShader: NOZZLE_FRAG,
    // One shell serves as both the outside of the bell and its throat; the
    // fragment branches on gl_FrontFacing. Half the triangles of two shells.
    side: DoubleSide,
    // PostFX owns the tone map. The scene target is linear HDR.
    toneMapped: false,
  });

  const additive = new ShaderMaterial({
    name: `ship-additive:${key}`,
    uniforms: {
      uCameraLocal: { value: new Vector3() },
      uTime: { value: 0 },
      uTimeScale: { value: 1 },
      uThrottle: { value: 0 },
      uBoost: { value: 0 },
      uHeat: { value: 0 },
      uPixelAngle: { value: 0.001 },
      uMinPixels: { value: 2.5 },
      uPlumeGain: { value: 0.25 },
    },
    vertexShader: ADDITIVE_VERT,
    fragmentShader: ADDITIVE_FRAG,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    // The vertex shader reorients these quads and shells in view space, so
    // their winding flips with orientation. Culling eats them.
    side: DoubleSide,
    toneMapped: false,
  });

  const prog: PropulsionProgram = { key, nozzle, additive, refs: 1 };
  PROGRAM_CACHE.set(key, prog);
  return prog;
}

function releaseProgram(prog: PropulsionProgram): void {
  if (--prog.refs > 0) return;
  PROGRAM_CACHE.delete(prog.key);
  prog.nozzle.dispose();
  prog.additive.dispose();
}

/**
 * Live entries in the propulsion program cache.
 *
 * Exported for the budget check: after every `ShipPropulsion` has been disposed
 * this must be zero, and a formation of N ships of one tier must hold it at 1.
 */
export function propulsionProgramCacheSize(): number {
  return PROGRAM_CACHE.size;
}

// ---------------------------------------------------------------------------
// ShipPropulsion
// ---------------------------------------------------------------------------

export class ShipPropulsion {
  readonly object3d: Object3D;

  /**
   * Alias these into the hull material's uniform object BY REFERENCE and pair
   * them with `ENGINE_GLOW_GLSL`. They are refreshed in place every frame.
   */
  readonly engineGlowUniforms: EngineGlowUniforms;

  /**
   * Planetshine, linear RGB, ship-local. `ViewState` carries the key light but
   * has no fill term, and a nozzle lit by the key alone is pure black on its
   * shadow side. Defaults to the project's authored value; the integrator may
   * overwrite it per frame. Flagged in the report as a `ViewState` gap.
   */
  readonly fillColor = new Color(0.010, 0.014, 0.022);

  private readonly group = new Group();

  // --- GPU resources, every one of which dispose() frees ---------------------
  /** Shared, refcounted. Released — never disposed — in `dispose()`. */
  private readonly program: PropulsionProgram;
  private readonly nozzleMat: ShaderMaterial;
  private readonly additiveMat: ShaderMaterial;

  /**
   * One built rung of the LOD ladder, or null until it is first asked for.
   *
   * Built lazily and then kept, exactly as `ShipMesh` keeps its hull LODs: a
   * ship that never recedes never pays for the rungs it never shows, and a ship
   * crossing a threshold pays once rather than every crossing.
   */
  private readonly rungs: Array<PropulsionRung | null> = [null, null, null, null];
  private activeRung: PropulsionRung | null = null;
  private lod = -1;
  /**
   * True once the owner has called `setLod`.
   *
   * Until then this object picks its own rung from the blueprint's ladder and
   * the camera distance, which is the same contract `LodLevel.minDistanceKm`
   * publishes to everyone else. That fallback is what makes a FLEET cheap today
   * without a change in another agent's file; an explicit `setLod` — one line in
   * `ShipMesh.setLod` — takes it over and keeps propulsion on exactly the rung
   * the hull is on, which is what the forced-LOD review shots need.
   */
  private lodLocked = false;
  /** minDistanceKm per rung, from `bp.renderProfile.lods`. */
  private readonly lodDistance: Float32Array;

  // --- the ACTIVE rung's meshes, aliased so the frame path stays flat --------
  private nozzleMesh: InstancedMesh | null = null;
  private fixtureMesh: InstancedMesh | null = null;
  private plumeMesh: InstancedMesh | null = null;
  private quadMesh: InstancedMesh | null = null;
  private wakeMesh: InstancedMesh | null = null;
  /** 1 / (shells * 2) for the active rung. See `PLUME_RADIANCE`. */
  private plumeGain = 0.25;

  // --- per-frame state, all preallocated ------------------------------------
  private time = 0;
  private vThrottle = 0;
  private vBoost = 0;
  private vHeat = 0;
  private vPower = 0;
  private vGimbalPitch = 0;
  private vGimbalYaw = 0;

  private readonly nozzles: NozzleSlot[] = [];
  private readonly nozzleQuat: Quaternion[] = [];
  private readonly nozzlePos: Vector3[] = [];
  /** Bell length per nozzle, km. The plume anchors this far aft of the throat. */
  private readonly nozzleBell: number[] = [];
  private readonly hasGimbal: boolean;

  private readonly jetCount: number;
  private readonly jetBase: number;
  private readonly jetDir: Float32Array;
  private readonly jetLevel: Float32Array;
  private readonly jetPhase: Float32Array;
  private readonly jetGroupStart: Uint32Array;
  private readonly jetGroupIndex: Uint8Array;
  /**
   * Which of the six principal exhaust directions each nozzle points down, its
   * rank inside that set, and how many share it.
   *
   * A flight computer picks a MINIMAL set of thrusters to satisfy a command; it
   * does not open every valve that could contribute. Firing all of them at once
   * is both a much larger acceleration than was asked for and, on screen, the
   * "row of identical birthday candles all pointing the same way" the review
   * measured. These three arrays are what let `updateJets` pick two.
   */
  private readonly jetBucket: Uint8Array;
  private readonly jetRank: Uint8Array;
  private readonly jetBucketSize = new Uint8Array(6);
  /** Wash-card instances in the shared quad mesh: one per engine pod. */
  private readonly washBase: number;
  private readonly washCount: number;
  private readonly groupDemand = new Float32Array(RCS_GROUP_ORDER.length);
  private quadDriveAttr: InstancedBufferAttribute | null = null;
  private plumeDriveAttr: InstancedBufferAttribute | null = null;
  /**
   * Per-nozzle lever arms (x, y) normalised by the hull's half-beam.
   *
   * A multi-engine ship does not only gimbal to turn — it throttles its engines
   * differentially, and a rank of bells where the outboard one visibly comes up
   * under a yaw input is the read that says the drive is being flown.
   */
  private readonly nozzleLever: Float32Array;
  private readonly differentialGain: number;

  /** Engine-glow staging: pod mouth, exhaust axis, base strength. */
  private readonly glowCount: number;
  private readonly glowStrength: Float32Array;
  private readonly glowRangeBase: number;

  private readonly timeScale: number;
  private readonly minLightPixels: number;

  /**
   * Per-ship values for the SHARED programs, pushed in `onBeforeRender`.
   *
   * The two materials are now cached across every ship of a tier, so nothing
   * that varies per ship may live in `material.uniforms` between frames — it
   * would be whichever ship updated last. `ShipMesh.pushUniforms` does exactly
   * this for the hull; this is the same contract on this side of the fence.
   */
  private lastView: ViewState | null = null;
  private pixelAngle = 0.001;
  private uThrottle = 0;
  private uGlowDepth = 0.2;

  // --- rung-independent staging, gathered by buildRung() ---------------------
  private readonly budget: Budget;
  private readonly crowded: boolean;
  /** Mean throat/exit ratio, baked into every rung's nozzle geometry. */
  private readonly throatRatio: number;
  /** Subdivision derived from the bells' absolute size. See `nozzleScale`. */
  private readonly nozzleScale: NozzleScale;
  /**
   * The nozzle styles this ship uses, most-used first.
   *
   * `[0]` is the dominant style — the one a merged rung draws for everything —
   * and the first `MAX_NOZZLE_SHAPES` entries are the profiles a fine rung
   * keeps in its buffer. Ordering by tally is what makes the truncation cheap:
   * the styles that lose their own profile are the ones on the fewest pods.
   */
  private readonly styleOrder: readonly NozzleStyle[];
  private readonly nozzleStage: NozzleStage;
  private readonly fixtureStage: FixtureStage;
  private readonly plumeStage: AdditiveBatch;
  private readonly quadStage: AdditiveBatch;
  private readonly wakeStage: AdditiveBatch | null;
  private readonly nozzleCore: Float32Array;
  private readonly nozzleTech: Float32Array;
  private readonly nozzleSoot: Float32Array;
  private readonly fixtureCore: Float32Array;
  private readonly fixtureTech: Float32Array;
  private readonly fixtureSoot: Float32Array;

  // scratch — never allocated in update()
  private readonly _m4 = new Matrix4();
  private readonly _m4b = new Matrix4();
  private readonly _q = new Quaternion();
  private readonly _qg = new Quaternion();
  private readonly _v = new Vector3();
  private readonly _scale = new Vector3(1, 1, 1);
  private readonly _axisX = new Vector3(1, 0, 0);
  private readonly _axisY = new Vector3(0, 1, 0);

  /**
   * @param lod  Which rung to build first. Omit and this object picks its own
   *             from the camera distance until `setLod` is called; pass the
   *             level `ShipMesh` is showing and it stays locked to the hull.
   */
  constructor(bp: ShipBlueprint, quality: QualitySettings, lod?: number) {
    registerShaderChunks();

    const budget = BUDGETS[quality.tier];
    this.budget = budget;
    this.minLightPixels = budget.minLightPixels;
    this.object3d = this.group;
    this.group.name = `propulsion:${bp.id}`;

    // The ladder the hull is on, so propulsion can shed on the same thresholds
    // rather than inventing its own.
    this.lodDistance = new Float32Array([0, Infinity, Infinity, Infinity]);
    const ladder = bp.renderProfile.lods;
    for (let i = 0; i < 4; i++) {
      const rung = ladder[Math.min(i, ladder.length - 1)];
      this.lodDistance[i] = rung ? rung.minDistanceKm : Infinity;
    }

    const L = Math.max(bp.dimensions.lengthKm, 1e-5);
    // Big machines move slowly. Every temporal constant in this file was
    // authored against a 30 m hull; scaling them by the ship's own size is what
    // stops a 4 km capital's valves chattering like a courier's.
    this.timeScale = clamp(Math.pow(REFERENCE_LENGTH_KM / L, 0.35), 0.22, 1.7);

    const tech = DRIVE_TECH[bp.technologyProfile.drive];
    const shape = PLUME_SHAPE[bp.technologyProfile.drive];

    // ---- materials --------------------------------------------------------
    const glow: EngineGlowUniforms = {
      uEngineGlow: { value: new Float32Array(ENGINE_GLOW_MAX * 4) },
      uEngineGlowDir: { value: new Float32Array(ENGINE_GLOW_MAX * 3) },
      uEngineGlowColor: { value: new Color(bp.palette.engineGlow[0], bp.palette.engineGlow[1], bp.palette.engineGlow[2]) },
      uEngineGlowRange: { value: L * 0.15 },
    };
    this.engineGlowUniforms = glow;

    const coreColor = new Color(bp.palette.engineCore[0], bp.palette.engineCore[1], bp.palette.engineCore[2]);
    const glowColor = new Color(bp.palette.engineGlow[0], bp.palette.engineGlow[1], bp.palette.engineGlow[2]);

    // Shared and refcounted. Nothing per-ship is baked in: see `acquireProgram`.
    this.program = acquireProgram(quality);
    this.nozzleMat = this.program.nozzle;
    this.additiveMat = this.program.additive;

    // ---- engines ----------------------------------------------------------
    const pods = bp.engines;
    let nozzleTotal = 0;
    for (const p of pods) nozzleTotal += Math.max(1, Math.round(p.nozzle.count));

    // Mean throat ratio. Baked into the geometry rather than carried per
    // instance: the deviation between pods of one ship is a few percent of a
    // radius, and a per-instance profile costs a vertex-shader reconstruction
    // of every normal to buy something nobody can see.
    let throatSum = 0;
    for (const p of pods) throatSum += clamp(p.nozzle.throatRadius / Math.max(p.nozzle.exitRadius, 1e-9), 0.18, 0.82);
    const throat = pods.length > 0 ? throatSum / pods.length : 0.42;

    this.throatRatio = throat;

    // Cage, hoop, rib and ring counts, from the ABSOLUTE size of the bells this
    // ship actually carries. Weighted by nozzle count rather than by pod, so a
    // hull with one huge pod and six small ones is subdivided for the six the
    // eye spends its time on — the geometry is shared by every instance and
    // there is exactly one of it (see `NozzleScale`).
    let exitW = 0;
    let lenW = 0;
    let wSum = 0;
    for (const p of pods) {
      const w = Math.max(1, Math.round(p.nozzle.count));
      const e = Math.max(p.nozzle.exitRadius, 1e-6);
      exitW += e * w;
      lenW += Math.max(p.nozzle.length, e * 0.12) * w;
      wSum += w;
    }
    this.nozzleScale = wSum > 0
      ? nozzleScale(exitW / wSum, lenW / wSum)
      : nozzleScale(0.002, 0.003);

    const crowded = nozzleTotal > PLUME_CROWD_THRESHOLD;
    this.crowded = crowded;

    // Staged in DRAWING ORDER, once, and gathered into whichever mesh layout a
    // rung wants. A nozzle's place, size and seed are properties of the ship;
    // only the tessellation and the packing belong to the rung.
    const nzStyle: NozzleStyle[] = [];
    const nzSize = new Float32Array(nozzleTotal * 3);
    const nzMatrix = new Float32Array(nozzleTotal * 16);
    const nzSeed = new Float32Array(nozzleTotal);
    let nzCount = 0;
    const styleTally = new Map<NozzleStyle, number>();
    const plumeBatch = new AdditiveBatch(nozzleTotal);

    const glowPos: number[] = [];
    const glowDir: number[] = [];
    const glowW: number[] = [];
    /** Wash cards: (x, y, z, radius) per pod, at the mouth of the cluster. */
    const wash: number[] = [];

    const m = new Matrix4();
    const local = new Matrix4();
    const world = new Matrix4();
    const q = new Quaternion();
    const pos = new Vector3();
    const edgeColor = new Color();
    const podCore = new Color();

    for (let pi = 0; pi < pods.length; pi++) {
      const pod = pods[pi];
      frameMatrix(pod.frame, m);
      m.setPosition(pod.frame.origin[0], pod.frame.origin[1], pod.frame.origin[2]);

      const count = Math.max(1, Math.round(pod.nozzle.count));
      const exit = Math.max(pod.nozzle.exitRadius, 1e-6);
      let bellLen = Math.max(pod.nozzle.length, exit * 0.12);
      // A grid or a plate has no bell to be long. If the family's bell aspect
      // says otherwise the family is describing a drive it does not have.
      if (pod.nozzle.style === 'grid') bellLen = Math.min(bellLen, exit * 0.5);
      if (pod.nozzle.style === 'plate') bellLen = Math.min(bellLen, exit * 0.24);

      // Bells in a cluster that overlap is a visible bug, not a style. The
      // blueprint's clusterRadius is trusted unless it cannot possibly work.
      const clusterR = count > 1 ? Math.max(pod.nozzle.clusterRadius, exit * 1.15) : 0;

      podCore.setRGB(pod.plume.coreColor[0], pod.plume.coreColor[1], pod.plume.coreColor[2]);
      edgeColor.setRGB(pod.plume.edgeColor[0], pod.plume.edgeColor[1], pod.plume.edgeColor[2]);

      styleTally.set(pod.nozzle.style, (styleTally.get(pod.nozzle.style) ?? 0) + count);

      const plumeLen = exit * Math.max(pod.plume.lengthRatio, 0.5) * shape[0];
      // The column leaves the exit plane AT the exit radius. `shape[1]` is now
      // only the small per-technology trim on that boundary condition; the
      // width difference between an ion fan and a fusion column is carried by
      // `osPlumeExpansion` in the shader, not by starting one of them narrow.
      const plumeWid = exit * shape[1];

      for (let n = 0; n < count; n++) {
        const a = (n / count) * Math.PI * 2;
        local.identity().setPosition(Math.cos(a) * clusterR, Math.sin(a) * clusterR, 0);
        world.multiplyMatrices(m, local);

        const idx = nzCount++;
        nzStyle.push(pod.nozzle.style);
        nzSize[idx * 3] = exit;
        nzSize[idx * 3 + 1] = exit;
        nzSize[idx * 3 + 2] = bellLen;
        world.toArray(nzMatrix, idx * 16);
        nzSeed[idx] = ((pod.seed >>> 0) % 1024) * 0.031 + n * 0.37;

        // The plume starts at the EXIT plane, not at the throat the frame is
        // anchored to — otherwise it is drawn inside its own bell.
        local.identity().setPosition(Math.cos(a) * clusterR, Math.sin(a) * clusterR, bellLen);
        this._m4.multiplyMatrices(m, local);
        const plumeSlot = plumeBatch.push(
          this._m4,
          KIND_PLUME,
          podCore,
          edgeColor,
          // The per-surface division is `uPlumeGain` now, so one staged batch
          // serves rungs with one shell and rungs with two.
          [plumeLen, plumeWid, PLUME_RADIANCE, ((pod.seed >>> 0) % 997) / 997],
          [Math.max(0, Math.round(pod.plume.diamonds)), clamp01(pod.plume.flicker), tech, 0],
          1,
        );

        this.nozzles.push({ plumeSlot, gimbal: Math.max(0, pod.nozzle.gimbalLimit) });
        this.nozzleBell.push(bellLen);
        world.decompose(pos, q, this._v);
        this.nozzlePos.push(pos.clone());
        this.nozzleQuat.push(q.clone());
      }

      // One glow slot per pod: a cluster of four bells is one light source at
      // any range the hull wash is legible from.
      pos.set(pod.frame.origin[0], pod.frame.origin[1], pod.frame.origin[2]);
      this._v.set(pod.frame.forward[0], pod.frame.forward[1], pod.frame.forward[2]).normalize();
      pos.addScaledVector(this._v, bellLen + plumeLen * 0.35);
      glowPos.push(pos.x, pos.y, pos.z);
      glowDir.push(this._v.x, this._v.y, this._v.z);
      glowW.push(exit);

      // The wash card sits at the EXIT PLANE of the cluster, not out in the
      // plume: the plating it has to brighten is the plating immediately around
      // the bells. Its radius covers the whole cluster plus a margin.
      //
      // 1.9, not 2.6. This card is centred BETWEEN the bells of a cluster, so
      // at two and a half cluster radii it had an outline of its own out in
      // open space beside them and read as one more plume — part of what the
      // review counted when two bells produced four bright lobes. Sized to the
      // cluster it stays what it is: light on the plating around the mouths.
      wash.push(
        pod.frame.origin[0] + this._v.x * bellLen,
        pod.frame.origin[1] + this._v.y * bellLen,
        pod.frame.origin[2] + this._v.z * bellLen,
        (clusterR + exit) * 1.9,
      );
    }

    this.nozzleStage = { style: nzStyle, size: nzSize, matrix: nzMatrix, seed: nzSeed, count: nzCount };
    this.plumeStage = plumeBatch;
    // Most-used first. A merged rung draws every nozzle with `styleOrder[0]`,
    // so it has to be the one the most nozzles actually use or the silhouette
    // changes at the swap; a fine rung keeps the first MAX_NOZZLE_SHAPES of
    // them and draws the rest with `[0]` for the same reason.
    const order = [...styleTally.entries()].sort((a, b) => b[1] - a[1]).map(([style]) => style);
    this.styleOrder = order.length > 0 ? order : ['bell'];

    this.hasGimbal = this.nozzles.some((n) => n.gimbal > 1e-4);
    // A gimballed drive does most of the vectoring with the bell, so its
    // differential trim is subtle; a fixed drive has nothing else to turn with.
    this.differentialGain = this.hasGimbal ? 0.22 : 0.75;

    const halfBeam = Math.max(bp.dimensions.beamKm * 0.5, 1e-6);
    this.nozzleLever = new Float32Array(this.nozzles.length * 2);
    for (let i = 0; i < this.nozzles.length; i++) {
      this.nozzleLever[i * 2] = clamp(this.nozzlePos[i].x / halfBeam, -1, 1);
      this.nozzleLever[i * 2 + 1] = clamp(this.nozzlePos[i].y / halfBeam, -1, 1);
    }

    // Sort glow slots by exit radius so a manoeuvring thruster pod never evicts
    // a main drive from the eight available slots.
    const glowOrder = glowW.map((w, i) => i).sort((a, b) => glowW[b] - glowW[a]);
    this.glowCount = Math.min(ENGINE_GLOW_MAX, glowOrder.length);
    this.glowStrength = new Float32Array(ENGINE_GLOW_MAX);
    let maxExit = 1e-9;
    for (const w of glowW) maxExit = Math.max(maxExit, w);
    for (let i = 0; i < this.glowCount; i++) {
      const src = glowOrder[i];
      glow.uEngineGlow.value[i * 4] = glowPos[src * 3];
      glow.uEngineGlow.value[i * 4 + 1] = glowPos[src * 3 + 1];
      glow.uEngineGlow.value[i * 4 + 2] = glowPos[src * 3 + 2];
      glow.uEngineGlowDir.value[i * 3] = glowDir[src * 3];
      glow.uEngineGlowDir.value[i * 3 + 1] = glowDir[src * 3 + 1];
      glow.uEngineGlowDir.value[i * 3 + 2] = glowDir[src * 3 + 2];
      // Normalised against the largest bell so the wash reads the same on a
      // courier and a capital; absolute radiance is the throttle's job.
      this.glowStrength[i] = glowW[src] / maxExit;
    }
    this.glowRangeBase = pods.length > 0 ? this.meanPlumeLength(pods, shape[0]) : L * 0.1;

    this.nozzleCore = this.repeatColor(coreColor, nzCount);
    this.nozzleTech = new Float32Array(nzCount).fill(tech);
    // Every main-drive instance stands in its own exhaust, so all of it.
    this.nozzleSoot = new Float32Array(nzCount).fill(1);

    // ---- lights, RCS jets and engine wash, one merged instanced quad -------
    const lights = this.collectLights(bp);
    const thrusters = bp.thrusters.slice(0, MAX_JETS);
    this.jetCount = thrusters.length;
    this.jetBase = lights.count;
    this.washCount = wash.length / 4;
    this.washBase = lights.count + this.jetCount;

    const quadBatch = new AdditiveBatch(lights.count + this.jetCount + this.washCount);
    // Copy the staged lights across first so the jets occupy a contiguous tail
    // and the per-frame level write is one linear run.
    quadBatch.matrix.set(lights.matrix.subarray(0, lights.count * 16));
    quadBatch.kind.set(lights.kind.subarray(0, lights.count));
    quadBatch.color.set(lights.color.subarray(0, lights.count * 3));
    quadBatch.edge.set(lights.edge.subarray(0, lights.count * 3));
    quadBatch.sizeA.set(lights.sizeA.subarray(0, lights.count * 4));
    quadBatch.sizeB.set(lights.sizeB.subarray(0, lights.count * 4));
    quadBatch.drive.set(lights.drive.subarray(0, lights.count));
    quadBatch.count = lights.count;

    this.jetDir = new Float32Array(this.jetCount * 3);
    this.jetLevel = new Float32Array(this.jetCount);
    this.jetPhase = new Float32Array(this.jetCount);
    this.jetGroupStart = new Uint32Array(this.jetCount + 1);
    this.jetBucket = new Uint8Array(this.jetCount);
    this.jetRank = new Uint8Array(this.jetCount);
    /** Fitting instances: an RCS cup per thruster, a housing per light. */
    const fixSize: number[] = [];
    const fixMatrix: number[] = [];
    const fixSeed: number[] = [];
    const groupFlat: number[] = [];
    const jetColor = new Color(bp.palette.navStrobe[0], bp.palette.navStrobe[1], bp.palette.navStrobe[2]);
    // A cold-gas jet is not a running light: bias it towards the drive's cold
    // accent so it belongs to the propulsion story, not the signalling one.
    jetColor.lerp(new Color(0.52, 0.70, 1.0), 0.65);

    for (let i = 0; i < this.jetCount; i++) {
      const th = thrusters[i];
      frameMatrix(th.frame, m);
      this._v.set(th.frame.forward[0], th.frame.forward[1], th.frame.forward[2]).normalize();
      const r = Math.max(th.radius, L * 1e-4);

      // The FITTING sits on the plating; the jet starts at the fitting's mouth.
      // Before this the jet was simply offset off the hull and there was no
      // thruster anywhere, which is why the review found one firing in open
      // space with nothing behind it.
      const cup = Math.max(th.radius, L * 1.4e-4);
      // frameMatrix() writes a BASIS: it clears the translation, so the fitting
      // has to be planted on the socket before its matrix is taken.
      m.setPosition(th.frame.origin[0], th.frame.origin[1], th.frame.origin[2]);
      for (let k = 0; k < 16; k++) fixMatrix.push(m.elements[k]);
      fixSize.push(cup, cup, cup * 1.35);
      fixSeed.push(((this.hashString(th.id) >>> 0) % 1024) * 0.031);

      const standoff = cup * 1.35;
      m.setPosition(
        th.frame.origin[0] + this._v.x * standoff,
        th.frame.origin[1] + this._v.y * standoff,
        th.frame.origin[2] + this._v.z * standoff,
      );
      this.jetDir[i * 3] = this._v.x;
      this.jetDir[i * 3 + 1] = this._v.y;
      this.jetDir[i * 3 + 2] = this._v.z;
      // Deterministic, from the thruster's own identity: two ships of one seed
      // must stutter identically.
      this.jetPhase[i] = ((this.hashString(th.id) >>> 0) % 4096) / 4096;

      // Which of the six principal directions this nozzle exhausts down, and
      // its rank among the nozzles that share it.
      const ax = Math.abs(this._v.x);
      const ay = Math.abs(this._v.y);
      const az = Math.abs(this._v.z);
      const bucket = ax >= ay && ax >= az
        ? (this._v.x > 0 ? 0 : 1)
        : ay >= az
          ? (this._v.y > 0 ? 2 : 3)
          : (this._v.z > 0 ? 4 : 5);
      this.jetBucket[i] = bucket;
      this.jetRank[i] = Math.min(255, this.jetBucketSize[bucket]);
      if (this.jetBucketSize[bucket] < 255) this.jetBucketSize[bucket]++;

      // length 9r (about eight mouth diameters at full valve), width 1.1r,
      // radiance 2.0. The previous 26r / 3.2r / 5.5 gave a bar thirty-five
      // diameters long, three times wider than the nozzle it came out of, and
      // at five times the white point so it clipped solid end to end.
      quadBatch.push(m, KIND_JET, jetColor, jetColor, [r * 9, r * 1.1, 2.0, this.jetPhase[i]], [0, 0, 0, 0], 0);

      this.jetGroupStart[i] = groupFlat.length;
      for (const g of th.groups) {
        const gi = RCS_GROUP_ORDER.indexOf(g);
        if (gi >= 0) groupFlat.push(gi);
      }
    }
    this.jetGroupStart[this.jetCount] = groupFlat.length;
    this.jetGroupIndex = new Uint8Array(groupFlat);

    // ---- engine wash cards -------------------------------------------------
    for (let i = 0; i < this.washCount; i++) {
      m.identity().setPosition(wash[i * 4], wash[i * 4 + 1], wash[i * 4 + 2]);
      quadBatch.push(m, KIND_WASH, glowColor, glowColor, [wash[i * 4 + 3], 0, 0.45, 0], [0, 0, 0, 0], 1);
    }

    // ---- light housings ----------------------------------------------------
    // Same fitting geometry, same instanced mesh, same material: a lamp bolted
    // into a cowl instead of a bare emissive point floating off the plating.
    for (let i = 0; i < lights.housingCount; i++) {
      for (let k = 0; k < 16; k++) fixMatrix.push(lights.housingMatrix[i * 16 + k]);
      const s = lights.housingSize[i];
      fixSize.push(s, s, s * 0.9);
      fixSeed.push(i * 0.19);
    }

    const fixCount = fixSize.length / 3;
    this.fixtureStage = {
      size: new Float32Array(fixSize),
      matrix: new Float32Array(fixMatrix),
      seed: new Float32Array(fixSeed),
      count: fixCount,
    };
    this.fixtureCore = this.repeatColor(coreColor, fixCount);
    this.fixtureTech = new Float32Array(fixCount).fill(tech);
    // How much exhaust deposit a fitting lives in. Deposit is a property of
    // WHERE A PART SITS, not of its shape, and this mesh's one geometry serves
    // two completely different jobs: an RCS cup fires cold gas out of its own
    // mouth and blackens round it; a navigation lamp is bolted to clean plating
    // amidships and never sees combustion products at all. Without this the
    // soot falloff added for the engine cage would have carbon-blacked every
    // running light on the ship. Staged in the same order as `fixSize`: cups
    // first, cowls after.
    this.fixtureSoot = new Float32Array(fixCount);
    for (let i = 0; i < fixCount; i++) this.fixtureSoot[i] = i < this.jetCount ? 0.55 : 0.10;
    this.quadStage = quadBatch;

    // ---- re-entry wake ----------------------------------------------------
    if (bp.technologyProfile.atmosphereCapable) {
      const wakeBatch = new AdditiveBatch(1);
      const aft = bp.dimensions.bounds.max[2];
      m.identity().setPosition(0, 0, aft * 0.95);
      wakeBatch.push(m, KIND_WAKE, coreColor, coreColor, [L * 3.8, bp.dimensions.beamKm * 0.75, 0.6, 0], [0, 0, 0, 0], 1);
      this.wakeStage = wakeBatch;
    } else {
      this.wakeStage = null;
    }

    // Build the rung we are going to show and nothing else. The rest arrive
    // when the ship first recedes far enough to need them.
    this.setLod(lod === undefined ? 0 : (clamp(Math.round(lod), 0, 3) as 0 | 1 | 2 | 3));
    if (lod === undefined) this.lodLocked = false;
  }

  // -------------------------------------------------------------------------
  // LOD
  // -------------------------------------------------------------------------

  /** Which rung is currently drawn. -1 before the first `setLod`. */
  get lodLevel(): number {
    return this.lod;
  }

  /** Drawn triangles and visible draw calls at the active rung. */
  stats(): { lod: number; triangles: number; drawCalls: number } {
    const r = this.activeRung;
    return { lod: this.lod, triangles: r?.triangles ?? 0, drawCalls: r?.drawCalls ?? 0 };
  }

  /**
   * Put propulsion on the same rung as the hull.
   *
   * `ShipMesh.setLod` should forward to this — one line — after which this
   * object stops choosing for itself. Until it does, `update()` picks the rung
   * from the camera distance against the blueprint's own ladder, which is right
   * for a fleet and wrong for a forced-LOD review shot.
   */
  setLod(level: 0 | 1 | 2 | 3): void {
    this.lodLocked = true;
    if (level === this.lod) return;
    const rung = this.rungs[level] ?? (this.rungs[level] = this.buildRung(level));
    // DETACHED, not merely hidden. `ShipMesh` measures this module's triangle
    // budget by traversing `object3d`, and `Object3D.traverse` walks into
    // invisible subtrees, so an inactive rung left parented would be counted
    // against the ship it is deliberately not drawing. A parent-pointer swap
    // costs nothing and makes every external measurement of this object true.
    if (this.activeRung) this.activeRung.group.removeFromParent();
    this.group.add(rung.group);
    this.activeRung = rung;
    this.lod = level;

    // Rebind the frame path. Everything below this line reads the ACTIVE rung
    // and nothing walks the scene graph per frame.
    this.nozzleMesh = rung.nozzleMesh;
    this.fixtureMesh = rung.fixtureMesh;
    this.plumeMesh = rung.plumeMesh;
    this.quadMesh = rung.quadMesh;
    this.wakeMesh = rung.wakeMesh;
    this.plumeDriveAttr = rung.plumeDrive;
    this.quadDriveAttr = rung.quadDrive;
    this.plumeGain = rung.plumeGain;
    // The instanced attributes are shared views onto one staged buffer, so the
    // values written for the previous rung are already correct here; they just
    // have to be re-uploaded against this rung's attribute objects.
    if (rung.plumeDrive) rung.plumeDrive.needsUpdate = true;
    if (rung.quadDrive) rung.quadDrive.needsUpdate = true;
    if (this.hasGimbal) this.applyGimbal();
  }

  /**
   * Build one rung. Called at most four times per ship, never from `update()`.
   */
  private buildRung(level: number): PropulsionRung {
    const plan = rungPlan(this.budget, level, this.crowded);
    const group = new Group();
    group.name = `propulsion-lod${level}`;
    const geometries: BufferGeometry[] = [];
    const stage = this.nozzleStage;
    const n = stage.count;
    let triangles = 0;

    const triCount = (g: BufferGeometry, instances: number): number => {
      const idx = g.getIndex();
      return ((idx ? idx.count : g.getAttribute('position').count) / 3) * instances;
    };

    // ---- nozzles ----------------------------------------------------------
    // EXACTLY ONE MESH, whatever the ship. Every profile the hull uses lives in
    // one buffer and each instance selects its own; instance `i` is nozzle `i`
    // in the staging order, so nothing downstream needs a slot map.
    let nozzleMesh: InstancedMesh | null = null;
    if (plan.nozzles && n > 0) {
      const shapes = plan.mergeStyles
        ? this.styleOrder.slice(0, 1)
        : this.styleOrder.slice(0, MAX_NOZZLE_SHAPES);

      const shapeIdx = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        // Anything past the cap falls back to the dominant profile, which is
        // index 0 by construction — never to a hole where a nozzle should be.
        const s = shapes.indexOf(stage.style[i]);
        shapeIdx[i] = s < 0 ? 0 : s;
      }

      const bufs: Buf[] = [];
      for (const style of shapes) {
        bufs.push(buildNozzle(style, plan.nozzleSeg, this.throatRatio, plan.nozzleDetail, this.nozzleScale));
      }
      const geo = mergeNozzleShapes(bufs);
      // Straight views onto the staged arrays: the instance order IS the ship
      // order, so there is nothing to gather.
      geo.setAttribute('iSize', new InstancedBufferAttribute(stage.size, 3));
      geo.setAttribute('iCore', new InstancedBufferAttribute(this.nozzleCore, 3));
      geo.setAttribute('iTech', new InstancedBufferAttribute(this.nozzleTech, 1));
      geo.setAttribute('iSeed', new InstancedBufferAttribute(stage.seed, 1));
      geo.setAttribute('iShape', new InstancedBufferAttribute(shapeIdx, 1));
      geo.setAttribute('iSoot', new InstancedBufferAttribute(this.nozzleSoot, 1));
      nozzleMesh = new InstancedMesh(geo, this.nozzleMat, n);
      nozzleMesh.instanceMatrix.array.set(stage.matrix);
      nozzleMesh.instanceMatrix.needsUpdate = true;
      if (this.hasGimbal) nozzleMesh.instanceMatrix.setUsage(DynamicDrawUsage);
      // The ship is the near subject and the integrator culls it as a whole;
      // per-mesh culling here would only fight the vertex-shader extrusion.
      nozzleMesh.frustumCulled = false;
      nozzleMesh.renderOrder = 0;
      nozzleMesh.onBeforeRender = this.pushNozzle;
      // Submitted, not drawn: on a mixed-doctrine hull the masked profiles are
      // in this number, because they are in the number the renderer reports and
      // in the number `ShipMesh` charges against the ship's triangle budget.
      triangles += triCount(geo, n);
      geometries.push(geo);
      group.add(nozzleMesh);
    }

    // ---- fittings ---------------------------------------------------------
    let fixtureMesh: InstancedMesh | null = null;
    const fix = this.fixtureStage;
    // The RCS cups are staged ahead of the lamp housings, so a cap drops the
    // cowls off distant lamps — which still light, they just stop having a
    // machined body — before it takes a thruster away from a firing jet.
    const fixCount = plan.fixtureLimit < 0 ? fix.count : Math.min(fix.count, plan.fixtureLimit);
    if (fixCount > 0) {
      const geo = buildFixture(plan.nozzleSeg).geometry();
      geo.setAttribute('iSize', new InstancedBufferAttribute(fix.size, 3));
      geo.setAttribute('iCore', new InstancedBufferAttribute(this.fixtureCore, 3));
      geo.setAttribute('iTech', new InstancedBufferAttribute(this.fixtureTech, 1));
      geo.setAttribute('iSeed', new InstancedBufferAttribute(fix.seed, 1));
      // One profile, so both shape channels are zero and the mask never fires.
      // Present because the program is shared with the nozzle mesh.
      geo.setAttribute('iShape', new InstancedBufferAttribute(new Float32Array(fixCount), 1));
      geo.setAttribute('iSoot', new InstancedBufferAttribute(this.fixtureSoot, 1));
      fixtureMesh = new InstancedMesh(geo, this.nozzleMat, fixCount);
      fixtureMesh.instanceMatrix.array.set(fix.matrix.subarray(0, fixCount * 16));
      fixtureMesh.instanceMatrix.needsUpdate = true;
      fixtureMesh.frustumCulled = false;
      fixtureMesh.renderOrder = 0;
      fixtureMesh.onBeforeRender = this.pushNozzle;
      triangles += triCount(geo, fixCount);
      geometries.push(geo);
      group.add(fixtureMesh);
    }

    // ---- plumes -----------------------------------------------------------
    let plumeMesh: InstancedMesh | null = null;
    let plumeDrive: InstancedBufferAttribute | null = null;
    const plumes = this.plumeStage;
    if (plumes.count > 0) {
      const geo = buildShellGeometry(plan.plumeSeg, plan.plumeSteps, plan.plumeLayers, 1);
      plumeDrive = plumes.attach(geo, true);
      plumeMesh = new InstancedMesh(geo, this.additiveMat, plumes.count);
      plumeMesh.instanceMatrix.array.set(plumes.matrix.subarray(0, plumes.count * 16));
      plumeMesh.instanceMatrix.needsUpdate = true;
      if (this.hasGimbal) plumeMesh.instanceMatrix.setUsage(DynamicDrawUsage);
      plumeMesh.frustumCulled = false;
      // After the opaque nozzle so the column's root sits inside a bell that
      // has already written depth.
      plumeMesh.renderOrder = 3;
      plumeMesh.onBeforeRender = this.pushAdditive;
      plumeMesh.visible = false;
      triangles += triCount(geo, plumes.count);
      geometries.push(geo);
      group.add(plumeMesh);
    }

    // ---- lights, RCS jets and engine wash ---------------------------------
    let quadMesh: InstancedMesh | null = null;
    let quadDrive: InstancedBufferAttribute | null = null;
    const quads = this.quadStage;
    const quadCount = plan.quadLimit < 0
      ? quads.count
      : Math.min(quads.count, Math.max(0, Math.min(plan.quadLimit, this.jetBase)));
    if (quadCount > 0) {
      const geo = buildQuadGeometry();
      quadDrive = quads.attach(geo, true);
      quadMesh = new InstancedMesh(geo, this.additiveMat, quadCount);
      quadMesh.instanceMatrix.array.set(quads.matrix.subarray(0, quadCount * 16));
      quadMesh.instanceMatrix.needsUpdate = true;
      quadMesh.frustumCulled = false;
      quadMesh.renderOrder = 4;
      quadMesh.onBeforeRender = this.pushAdditive;
      triangles += triCount(geo, quadCount);
      geometries.push(geo);
      group.add(quadMesh);
    }

    // ---- re-entry wake ----------------------------------------------------
    let wakeMesh: InstancedMesh | null = null;
    if (plan.wake && this.wakeStage) {
      const geo = buildShellGeometry(this.budget.wakeSeg, this.budget.wakeSteps, 1, 0.8);
      this.wakeStage.attach(geo, false);
      wakeMesh = new InstancedMesh(geo, this.additiveMat, 1);
      wakeMesh.instanceMatrix.array.set(this.wakeStage.matrix.subarray(0, 16));
      wakeMesh.instanceMatrix.needsUpdate = true;
      wakeMesh.frustumCulled = false;
      wakeMesh.renderOrder = 5;
      wakeMesh.onBeforeRender = this.pushAdditive;
      wakeMesh.visible = false;
      triangles += triCount(geo, 1);
      geometries.push(geo);
      group.add(wakeMesh);
    }

    // NOT parented here: `setLod` attaches exactly the rung that is drawing.
    return {
      level,
      group,
      geometries,
      nozzleMesh,
      fixtureMesh,
      plumeMesh,
      quadMesh,
      wakeMesh,
      plumeDrive,
      quadDrive,
      plumeGain: 1 / (plan.plumeLayers * 2),
      triangles,
      // EVERY mesh the rung can put on screen at once, including the wake. The
      // plume is hidden at idle and the wake below re-entry heat, but a budget
      // that only holds while the ship is coasting is not a budget — and this
      // number is what the review manifest reports propulsion as costing.
      // Structurally 4, 3, 3, 2 down the ladder, plus the wake on an
      // atmosphere-capable hull at LOD0 and LOD1.
      drawCalls: (nozzleMesh ? 1 : 0) + (fixtureMesh ? 1 : 0) + (plumeMesh ? 1 : 0)
        + (quadMesh ? 1 : 0) + (wakeMesh ? 1 : 0),
    };
  }

  // -------------------------------------------------------------------------
  // Shared-program uniform push
  // -------------------------------------------------------------------------

  /**
   * Write this ship's values into the shared nozzle program, immediately before
   * one of this ship's draws. Allocation-free and idempotent.
   */
  private readonly pushNozzle = (): void => {
    const u = this.nozzleMat.uniforms;
    u.uTime.value = this.time;
    u.uTimeScale.value = this.timeScale;
    u.uThrottle.value = this.uThrottle;
    u.uGlowDepth.value = this.uGlowDepth;
    u.uPower.value = this.vPower;
    u.uFill.value = this.fillColor;
    const v = this.lastView;
    if (!v) return;
    // Aliased by reference: ViewState's vectors are refilled in place by the
    // integrator every frame, so copying them would be pure waste.
    u.uSunDir.value = v.sunDirection;
    u.uSunColor.value = v.sunColor;
    u.uCameraLocal.value = v.cameraLocal;
  };

  /** The same, for the shared additive program. */
  private readonly pushAdditive = (): void => {
    const u = this.additiveMat.uniforms;
    u.uTime.value = this.time;
    u.uTimeScale.value = this.timeScale;
    u.uThrottle.value = this.vThrottle;
    u.uBoost.value = this.vBoost;
    u.uHeat.value = this.vHeat;
    u.uMinPixels.value = this.minLightPixels;
    // Per-RUNG, not per-ship: the number of additive surfaces a ray crosses
    // changes when the plume drops from two nested shells to one.
    u.uPlumeGain.value = this.plumeGain;
    // One number carries every screen-space decision in this file, exactly as
    // Planet.ts does: km per pixel at distance d is d * uPixelAngle.
    u.uPixelAngle.value = this.pixelAngle;
    if (this.lastView) u.uCameraLocal.value = this.lastView.cameraLocal;
  };

  // -------------------------------------------------------------------------
  // Construction helpers
  // -------------------------------------------------------------------------

  private meanPlumeLength(pods: readonly EnginePod[], lenMul: number): number {
    let sum = 0;
    for (const p of pods) sum += p.nozzle.exitRadius * Math.max(p.plume.lengthRatio, 0.5) * lenMul;
    return sum / Math.max(pods.length, 1);
  }

  private repeatColor(c: Color, n: number): Float32Array {
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      a[i * 3] = c.r;
      a[i * 3 + 1] = c.g;
      a[i * 3 + 2] = c.b;
    }
    return a;
  }

  /** FNV-1a. Deterministic phases from ids, so no `Math.random()` ever appears. */
  private hashString(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /**
   * Navigation lights, beacons and docking guides, per the faction's palette.
   *
   * Side convention is read from the fixture's own position, because that is
   * the one navigation-light rule every culture in the game shares: port is one
   * colour, starboard is the other, and the strobes are neither. Everything
   * else — which hue, how bright — comes from `bp.palette`.
   */
  private collectLights(bp: ShipBlueprint): LightBatch {
    const port = new Color(bp.palette.navPort[0], bp.palette.navPort[1], bp.palette.navPort[2]);
    const stbd = new Color(bp.palette.navStarboard[0], bp.palette.navStarboard[1], bp.palette.navStarboard[2]);
    const strobe = new Color(bp.palette.navStrobe[0], bp.palette.navStrobe[1], bp.palette.navStrobe[2]);
    const beacon = new Color(bp.palette.beacon[0], bp.palette.beacon[1], bp.palette.beacon[2]);

    const fixtures = bp.modules.filter((mod) => mod.present && (mod.kind === 'navlight' || mod.kind === 'beacon'));
    let guides = 0;
    for (const d of bp.dockingPoints) guides += Math.max(0, Math.round(d.guideLightCount));

    const batch = new LightBatch(Math.min(MAX_LIGHTS, fixtures.length + guides));
    const m = new Matrix4();
    const local = new Matrix4();
    const world = new Matrix4();

    // A fixture is a piece of hardware a person installs, so its physical size
    // comes from a human dimension band — never from the ship's length. The
    // shader's pixel floor is what keeps it visible on a capital.
    const lo = 0.00022;
    const hi = 0.0014;

    // INTENSITIES ARE THE LENS'S, not the whole card's. At the previous 4.0–5.4,
    // against a fragment profile that itself peaked at 2.8, every fixture landed
    // at 11–15x the tone map's white point and clipped to pure white: a red port
    // light, a green starboard light and a white strobe all rendered as the same
    // featureless dot. A lamp has to stay near the threshold to keep its hue.
    for (const mod of fixtures) {
      frameMatrix(mod.frame, m);
      this._v.set(mod.frame.forward[0], mod.frame.forward[1], mod.frame.forward[2]).normalize();
      const size = clamp(Math.max(mod.halfExtents[0], mod.halfExtents[1]) || lo, lo, hi);
      // The housing is bolted flush; the lens sits at its mouth. Planted
      // first: frameMatrix() leaves the translation at the origin.
      m.setPosition(mod.frame.origin[0], mod.frame.origin[1], mod.frame.origin[2]);
      batch.housing(m, size * 1.5);
      m.setPosition(
        mod.frame.origin[0] + this._v.x * size * 1.35,
        mod.frame.origin[1] + this._v.y * size * 1.35,
        mod.frame.origin[2] + this._v.z * size * 1.35,
      );

      const x = mod.frame.origin[0];
      const lateral = Math.abs(x) > bp.dimensions.beamKm * 0.06;
      let col = strobe;
      let pattern = PATTERN_STROBE;
      let intensity = 2.3;
      if (mod.kind === 'beacon') {
        col = beacon;
        pattern = PATTERN_BEACON;
        intensity = 2.6;
      } else if (lateral) {
        col = x < 0 ? port : stbd;
        pattern = PATTERN_STEADY;
        intensity = 2.0;
      }
      const phase = ((this.hashString(mod.id) >>> 0) % 4096) / 4096;
      batch.push(m, KIND_LIGHT, col, col, [size, size, intensity, phase], [pattern, 0, LIGHT_HALO_SCALE, 0], 1);
    }

    // Docking guides: a ring round the collar, phase-sequenced into a chase
    // running towards the port. The HUD homes on these, so they are the one
    // light group that must read as a group and not as scattered dots.
    for (const d of bp.dockingPoints) {
      const n = Math.max(0, Math.round(d.guideLightCount));
      if (n === 0) continue;
      frameMatrix(d.frame, m);
      m.setPosition(d.frame.origin[0], d.frame.origin[1], d.frame.origin[2]);
      const ring = d.diameter * 0.5;
      const size = clamp(d.diameter * 0.045, lo, hi);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        local.identity().setPosition(Math.cos(a) * ring, Math.sin(a) * ring, size);
        world.multiplyMatrices(m, local);
        // A guide ring is a run of small lamps in one moulding, not a ring of
        // separate fittings: no housing instance each, or a big collar costs
        // twenty of them.
        batch.push(world, KIND_LIGHT, strobe, strobe, [size, size, 1.7, i / n], [PATTERN_GUIDE, i, LIGHT_HALO_SCALE * 0.7, 0], 1);
      }
    }
    return batch;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, ctx: EngineContext, view: ViewState, state: ShipDriveState): void {
    this.time += dt;

    // Until the owner takes over, pick the rung off the same ladder the hull
    // uses. `LodLevel.minDistanceKm` is the published contract for what level a
    // ship is at, and honouring it here is what stops a fleet drawn at 3 km
    // paying arm's-length prices for thrust frames nobody can resolve.
    if (!this.lodLocked) {
      // ±8% of hysteresis about every threshold. Without it a ship parked on a
      // boundary swaps rung every frame, and a swap changes the number of
      // additive shells — which the eye reads as the drive flickering.
      let want = 0;
      for (let i = 3; i >= 1; i--) {
        if (view.distance >= this.lodDistance[i] * (this.lod >= i ? 0.92 : 1.08)) {
          want = i;
          break;
        }
      }
      if (want !== this.lod) {
        this.setLod(want as 0 | 1 | 2 | 3);
        this.lodLocked = false;
      }
    }

    // Nothing snaps. A drive spools, heat builds and bleeds, the bus comes up.
    // The spool rate is scaled with the hull so a capital takes visibly longer
    // to answer the throttle than a courier does.
    const spool = 3.0 * this.timeScale;
    this.vThrottle = damp(this.vThrottle, clamp01(state.throttle), spool, dt);
    this.vBoost = damp(this.vBoost, clamp01(state.boost), 2.2 * this.timeScale, dt);
    this.vHeat = damp(this.vHeat, clamp01(state.heating), 1.5, dt);
    this.vPower = damp(this.vPower, state.powered ? 1 : 0, 1.8, dt);

    const th = this.vThrottle;
    const boost = this.vBoost;
    const drive = clamp01(th + boost * 0.35);
    this.lastView = view;
    this.pixelAngle = (2 * Math.tan(view.fovY * 0.5)) / Math.max(view.viewportHeight, 1);
    this.uThrottle = drive;
    // How far AFT of the throat the interior glow reaches. Same numeric band as
    // before, opposite meaning: the glow now starts hot at the throat and runs
    // out towards the lip as the drive spools, instead of starting at the lip.
    this.uGlowDepth = 0.14 + drive * 0.80;

    // ---- engine glow ------------------------------------------------------
    const glowArr = this.engineGlowUniforms.uEngineGlow.value;
    for (let i = 0; i < this.glowCount; i++) {
      glowArr[i * 4 + 3] = this.glowStrength[i] * drive * this.vPower * 2.2;
    }
    // The wash reaches as far as the column that makes it.
    this.engineGlowUniforms.uEngineGlowRange.value = this.glowRangeBase * (0.35 + drive * 0.9);

    if (this.plumeMesh) this.plumeMesh.visible = drive > 0.008 && this.vPower > 0.02;

    // ---- gimbal -----------------------------------------------------------
    if (this.hasGimbal) {
      this.vGimbalPitch = damp(this.vGimbalPitch, clamp(state.angular.x, -1, 1), 6 * this.timeScale, dt);
      this.vGimbalYaw = damp(this.vGimbalYaw, clamp(state.angular.y, -1, 1), 6 * this.timeScale, dt);
      this.applyGimbal();
    }

    this.updateDifferentialThrust(state);

    // ---- RCS --------------------------------------------------------------
    this.updateJets(dt, state);

    // ---- re-entry ---------------------------------------------------------
    if (this.wakeMesh) this.wakeMesh.visible = this.vHeat > 0.01;
  }

  /**
   * Deflect the main nozzles.
   *
   * Two or three degrees of visible gimbal under a hard pitch input is one of
   * the cheapest reads there is on a ship being *flown* rather than animated,
   * and the plume has to follow the bell or the illusion inverts immediately.
   */
  private applyGimbal(): void {
    const rung = this.activeRung;
    if (!rung) return;
    // Nozzle `i` is instance `i` — every profile shares one mesh and the
    // instance order is the staging order, so there is no slot map to consult.
    // At the impostor rung there is no mesh at all and only the plume moves.
    const mesh = rung.nozzleMesh;
    const arr = mesh ? (mesh.instanceMatrix.array as Float32Array) : null;
    for (let i = 0; i < this.nozzles.length; i++) {
      const n = this.nozzles[i];
      if (n.gimbal <= 1e-4) continue;
      // Thrust opposes exhaust, so a nose-up command swings the bells the other
      // way. The sign is the whole point of doing this at all.
      this._qg.setFromAxisAngle(this._axisX, -this.vGimbalPitch * n.gimbal);
      this._q.copy(this.nozzleQuat[i]).multiply(this._qg);
      this._qg.setFromAxisAngle(this._axisY, -this.vGimbalYaw * n.gimbal);
      this._q.multiply(this._qg);
      this._m4.compose(this.nozzlePos[i], this._q, this._scale);
      if (arr) this._m4.toArray(arr, i * 16);
      if (this.plumeMesh && n.plumeSlot >= 0) {
        // The plume anchors at the exit plane, which moves when the bell swings.
        this._m4b.identity().setPosition(0, 0, this.nozzleBell[i]);
        this._m4b.premultiply(this._m4);
        this._m4b.toArray(this.plumeMesh.instanceMatrix.array as Float32Array, n.plumeSlot * 16);
      }
    }
    if (mesh) mesh.instanceMatrix.needsUpdate = true;
    if (this.plumeMesh) this.plumeMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Differential thrust across the engine rank.
   *
   * Thrust is -Z at each nozzle's own station, so the torque a nozzle makes
   * about +X goes as -y and about +Y as +x. Trimming each plume by that lever
   * arm means a pitch-up command visibly favours the LOWER bells — physically
   * right, and free, because the plume already carries a per-instance drive.
   */
  private updateDifferentialThrust(state: ShipDriveState): void {
    const attr = this.plumeDriveAttr;
    if (!attr) return;
    const arr = attr.array as Float32Array;
    const p = clamp(state.angular.x, -1, 1);
    const w = clamp(state.angular.y, -1, 1);
    const g = this.differentialGain;
    for (let i = 0; i < this.nozzles.length; i++) {
      const slot = this.nozzles[i].plumeSlot;
      if (slot < 0) continue;
      const trim = -this.nozzleLever[i * 2 + 1] * p + this.nozzleLever[i * 2] * w;
      arr[slot] = clamp(1 + g * trim, 0.12, 1.7);
    }
    attr.needsUpdate = true;
  }

  /**
   * RCS: which nozzle fires, and how.
   *
   * Demand comes from the blueprint's own `RcsGroup` membership rather than
   * from a dot product against the commanded vector, which means a nozzle that
   * the generator placed to produce a COUPLE fires on a rotation command even
   * though its exhaust does not oppose any translation. That is most of the
   * difference between a ship that manoeuvres and a ship that slides.
   */
  private updateJets(dt: number, state: ShipDriveState): void {
    if (!this.quadMesh || !this.quadDriveAttr) return;
    const levels = this.quadDriveAttr.array as Float32Array;

    // Lights occupy the head of the buffer and follow the bus. Written before
    // the early-out: a ship with no RCS still has navigation lights.
    for (let i = 0; i < this.jetBase; i++) levels[i] = this.vPower;
    // The wash cards live in the tail and follow the bus too; the shader does
    // the throttle curve so a cold drive washes nothing at all.
    for (let i = 0; i < this.washCount; i++) levels[this.washBase + i] = this.vPower;
    if (this.jetCount === 0) {
      this.quadDriveAttr.needsUpdate = true;
      return;
    }

    const d = this.groupDemand;
    const t = state.translation;
    const a = state.angular;
    d[0] = Math.max(0, a.x);
    d[1] = Math.max(0, -a.x);
    d[2] = Math.max(0, a.y);
    d[3] = Math.max(0, -a.y);
    d[4] = Math.max(0, a.z);
    d[5] = Math.max(0, -a.z);
    d[6] = Math.max(0, t.x);
    d[7] = Math.max(0, -t.x);
    d[8] = Math.max(0, t.y);
    d[9] = Math.max(0, -t.y);
    d[10] = Math.max(0, t.z);
    d[11] = Math.max(0, -t.z);

    const tmag = Math.min(1, Math.hypot(t.x, t.y, t.z));
    // Valves on a big ship are big valves: the chatter slows with the hull.
    const dutyFreq = 17 * this.timeScale;
    const attack = 38 * this.timeScale;
    const decay = 7.5 * this.timeScale;
    // Which slice of each direction's nozzles has the valve this second. The
    // window walks round the set so the firing pair moves rather than a fixed
    // two doing all the work — and so a still frame never catches every nozzle
    // on a face open at once.
    const window = Math.floor(this.time * 1.7 * this.timeScale) * MAX_JETS_PER_DIRECTION;

    for (let i = 0; i < this.jetCount; i++) {
      let target = 0;
      const g0 = this.jetGroupStart[i];
      const g1 = this.jetGroupStart[i + 1];
      if (g1 > g0) {
        for (let g = g0; g < g1; g++) {
          const v = d[this.jetGroupIndex[g]];
          if (v > target) target = v;
        }
      } else if (tmag > 1e-4) {
        // Fallback for a blueprint that left `groups` empty: thrust is opposite
        // the exhaust, so the firing nozzle is the one pointing away from where
        // the pilot asked to go.
        const align = -(this.jetDir[i * 3] * t.x + this.jetDir[i * 3 + 1] * t.y + this.jetDir[i * 3 + 2] * t.z) / tmag;
        if (align > 0.3) target = Math.min(1, (align - 0.3) / 0.5) * tmag;
      }

      if (target > 0) {
        // A flight computer opens a MINIMAL set of valves, not every valve that
        // could contribute. Firing all six nozzles on a face is both far more
        // acceleration than was commanded and — the review's actual complaint —
        // six identical bars pointing the same way in one frame.
        const bucket = this.jetBucket[i];
        const size = this.jetBucketSize[bucket];
        if (size > MAX_JETS_PER_DIRECTION) {
          const phase = (this.jetRank[i] + window) % size;
          if (phase >= MAX_JETS_PER_DIRECTION) target = 0;
        }
      }
      if (target > 0) {
        // Cold-gas thrusters are bang-bang valves. They stutter; they never
        // hold. Replacing this with a smooth ramp is the single change that
        // makes a ship stop looking flown.
        const duty = Math.sin(this.time * dutyFreq + this.jetPhase[i] * 6.2831853);
        target *= duty > -0.15 ? 1 : 0.1;
      }
      // Fast attack, slow decay: that asymmetry IS the puff.
      const rate = target > this.jetLevel[i] ? attack : decay;
      this.jetLevel[i] = damp(this.jetLevel[i], target, rate, dt);
      levels[this.jetBase + i] = this.jetLevel[i];
    }
    this.quadDriveAttr.needsUpdate = true;
  }

  // -------------------------------------------------------------------------

  dispose(): void {
    // Every rung that was ever built, not just the one showing.
    for (let i = 0; i < this.rungs.length; i++) {
      const rung = this.rungs[i];
      if (!rung) continue;
      for (const g of rung.geometries) g.dispose();
      rung.nozzleMesh?.dispose();
      rung.fixtureMesh?.dispose();
      rung.plumeMesh?.dispose();
      rung.quadMesh?.dispose();
      rung.wakeMesh?.dispose();
      rung.group.clear();
      rung.group.removeFromParent();
      this.rungs[i] = null;
    }
    this.activeRung = null;
    this.nozzleMesh = null;
    this.fixtureMesh = null;
    this.plumeMesh = null;
    this.quadMesh = null;
    this.wakeMesh = null;
    this.plumeDriveAttr = null;
    this.quadDriveAttr = null;
    this.lod = -1;

    // Shared and refcounted: the last ship of a tier to go disposes the pair.
    // Disposing them here unconditionally would pull the program out from under
    // every other ship in the formation.
    releaseProgram(this.program);

    this.lastView = null;
    this.group.clear();
  }
}
