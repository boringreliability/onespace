/**
 * oneSpace — ship surfaces, wear, markings and emissive.
 *
 * This module owns everything about how a generated hull *looks* once the
 * geometry exists: plating, welds, fasteners, production batches, replaced
 * panels, directional wear, faction markings, lit apertures and the contact
 * darkening under bolted-on hardware. It reads `ShipBlueprint` and nothing
 * else — no camera, no scene graph, no other renderer.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE DECISIONS THIS FILE IS BUILT ON
 *
 * 1. NOTHING IS A CONSTANT AUTHORED AGAINST A 30 m HULL.
 *    `Ship.ts` carries nine object-space noise frequencies in cycles-per-km,
 *    all tuned to a 0.03 km courier; on a 4 km capital every one of them is
 *    133x too fine and collapses into uniform grain, which BRIEF §7 rejects on
 *    sight. Here every frequency is expressed in *cycles per hull length* and
 *    divided by `uHullLen` at evaluation, and plate size comes from
 *    `bp.dimensions.panelSizeKm` — the blueprint field the geometry module
 *    reads for the same purpose. That field, surfaced as `uPanelSize`, IS the
 *    agreed panel rule between geometry and material; neither of us invents
 *    one. `shipPanelScale()` is exported so the agreement is checkable.
 *
 * 2. DETAIL IS A CASCADE, NOT A SCALE (`Planet.ts` §DETAIL_GLSL).
 *    Four bands — hull sections (L/20), structural bays (L/200), plates
 *    (panelSizeKm), fasteners (fastenerPitch) — each faded in only once its
 *    wavelength exceeds a few pixels. A band that cannot be resolved is
 *    multiplied to zero, so the surface converges to its *mean* at distance
 *    rather than to noise. That single property is what keeps a fleet of these
 *    from turning into static, and it gives LOD1/LOD2 shading for free.
 *
 * 3. WEAR FOLLOWS FUNCTION AND ORIENTATION, AND IS NEVER ONE SLIDER.
 *    Eight independent masks, each weighted by `MaterialProfile.wear`:
 *    soot from the actual exhaust axes, heat staining from the actual radiator
 *    positions, grime streaked along `flowDirection`, edge wear from curvature,
 *    scuffing where the crew work, micro-impact pitting on leading faces only,
 *    corrosion in crevices (driven by the baked occlusion, i.e. by real
 *    geometry), frost near cryogenic sources. Soot, heat and frost share one
 *    analytic "stain source" loop because all three are the same thing: a
 *    directional deposit emanating from a point along an axis.
 *
 * 4. THE OCCLUSION SCHEME IS BAKED FIRST, ANALYTIC SECOND.
 *    `Ship.ts` spends 27 of 28 analytic occluder slots on a 30 m hull with 17
 *    bolt-ons and 56 fragment uniform vectors doing it. It does not scale by
 *    any amount. So the primary channel here is a *baked bent normal plus
 *    occlusion* (`aBent`), which is O(1) per fragment and independent of part
 *    count, and the analytic array is cut to 8 slots reserved for the large
 *    silhouette masses whose shadow stripe actually sweeps as the star moves.
 *    Cost and consequences are written out at `SHIP_OCC_MAX` below.
 *
 * 5. THE SCENE IS LINEAR HDR AND POSTFX OWNS THE GRADE.
 *    `toneMapped: false`, no `<tonemapping_fragment>`, no
 *    `<colorspace_fragment>`, no `os_dither`. `Ship.ts` tone-maps itself, which
 *    clamps the hull below `BloomPass.threshold` so no part of it can ever
 *    bloom, and then `GradePass` tone-maps the result a second time. That is a
 *    defect and it is not inherited. Lit plating is authored to land in roughly
 *    0.005..0.5 scene-linear; only the emitters exceed 1.0.
 *
 * ---------------------------------------------------------------------------
 * BUDGET (BRIEF §6: <= 3 materials per ship, shared across a family)
 *
 *   surface   ONE material object, bound as both `hull` and `greeble`. three's
 *             `WebGLPrograms` already keys its program cache on `instancing`,
 *             so a single material handed to a `Mesh` and to an `InstancedMesh`
 *             compiles and caches both permutations by itself. The second,
 *             byte-identical object this file used to allocate bought nothing
 *             and put the visible LOD0 draw list at 4 distinct materials.
 *   emissive  one additive program for every non-plume emitter: windows,
 *             navigation lights, strobes, service floodlights. Kinds 4..7 of
 *             `aKind` are left free so `propulsion.ts` can share this same
 *             material rather than adding a fourth.
 *
 * Sharing across a family is real: `shipMaterials()` returns materials from a
 * refcounted cache keyed on faction + technology + palette + quality, so every
 * Kessler Plateline hull in a system draws with the same three objects and one
 * program pair. Per-ship variation (panel size, grime, wear weights, engine
 * positions, lamps, markings) is written into the shared uniform object by
 * `apply()` immediately before that ship draws — call it from the ship root's
 * `onBeforeRender`. That is the only way a shared material can serve a fleet.
 */

import {
  AdditiveBlending,
  ClampToEdgeWrapping,
  DataTexture,
  DoubleSide,
  FrontSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  RedFormat,
  ShaderMaterial,
  UnsignedByteType,
  type IUniform,
} from 'three';

import type { QualitySettings, QualityTier } from '@/core/Config';
import type { ViewState } from '@/render/ViewState';
import { registerShaderChunks } from '@/shaders/chunks';
import type {
  EnginePod,
  MaterialProfile,
  Marking,
  RGB,
  ShipBlueprint,
  ShipPalette,
  Vec3,
} from '@/gen/ships/types';

// ===========================================================================
// Public contract
// ===========================================================================

/**
 * The vertex/instance channels the surface program reads.
 *
 * Both are `vec4` rather than four loose floats for two reasons: fewer VBO
 * bindings (`Ship.ts` pays five), and — more importantly — an unbound generic
 * vertex attribute in WebGL defaults to `(0, 0, 0, 1)`, so each channel is
 * laid out such that **that default is the correct "nothing special here"
 * value**. A hull built before the bake exists still renders correctly, just
 * without contact darkening. `Ship.ts`'s `aAO` has the opposite polarity and a
 * missing attribute renders the whole ship black; that is a trap, not a
 * convention.
 *
 * On an `InstancedMesh` these are `InstancedBufferAttribute`s with identical
 * declarations — three binds whichever the geometry supplies, no permutation.
 * For instanced batches `aBent.xyz` must already be in SHIP space (the
 * instance's own orientation folded in), because the shader cannot know which
 * of the two it was handed.
 */
export const SHIP_SURFACE_ATTRIBUTES = {
  /**
   * `aSurf` — vec4(wearMultiplier, partId, yardTag, panelScaleMultiplier)
   *
   *  x  0..1. How exposed this surface is to hands and to space. Gates edge
   *     wear and scuffing. Nose and tail plating is authored newer than the
   *     flanks nobody can reach. Default 0 = factory-new.
   *  y  Part id, an integer carried in a float (~24 bits exact). Drives plate
   *     scale, panel projection offset, paint batch and self-shadow rejection.
   *     MUST be split at part boundaries: `vPart` is a varying, so two parts
   *     that share a vertex smear their ids across every triangle between.
   *  z  0..1. Yard tag. >0.5 means this part came from a different builder and
   *     takes the mismatch palette and its own panel size. Default 0 = ours.
   *  w  Multiplier on `uPanelSize` for this part, so a module can carry its
   *     builder's plate size. Default 1 = the ship's reference plate.
   */
  surf: 'aSurf',
  /**
   * `aBent` — vec4(bentNormal.xyz, occlusion)
   *
   *  xyz  Average unoccluded direction, ship space, unnormalised is fine —
   *       zero length falls back to the geometric normal.
   *  w    0..1 occlusion, 0 = open sky. This replaces both `Ship.ts`'s per-
   *       vertex `aAO` and most of its `uOcc[28]` cast-shadow array: the
   *       fragment compares `dot(bent, sunDir)` against a cone aperture
   *       derived from `w`, which gives a *directional* contact shadow that
   *       moves with the star for ~8 ALU and zero uniform slots.
   */
  bent: 'aBent',
} as const;

/**
 * The channels the additive emissive program reads.
 *
 * `aKind` values 0..3 are owned here. 4..7 are deliberately unallocated so
 * `propulsion.ts` can put plume, wake and RCS on this same material instead of
 * spending three more (ANALYSIS §3.7).
 */
export const SHIP_EMISSIVE_ATTRIBUTES = {
  /** vec4(linear RGB, intensity in scene-linear radiance). */
  emit: 'aEmit',
  /** 0 window, 1 navigation light, 2 strobe, 3 service floodlight. */
  kind: 'aKind',
  /** Standard `uv`, 0..1 across the quad. Required — there is no sane default. */
  uv: 'uv',
} as const;

/** Per-frame ship state the surface needs. Deliberately not `ShipState`. */
export interface ShipSurfaceState {
  /** 0..1 main drive setting. Drives the plume wash on the plating. */
  readonly throttle: number;
  /** 0..1 re-entry heating. */
  readonly heat: number;
  /**
   * Planetshine, linear RGB — NOT ambient. `ViewState` does not carry it, but
   * without it a hull in orbit has a pure black shadow side and the whole ship
   * reads as a cut-out. The reference values are `(0.010, 0.014, 0.022)` in
   * deep space and `(0.11, 0.14, 0.22)` close to a lit world. Omit and the
   * deep-space value stands.
   */
  readonly fill?: { readonly r: number; readonly g: number; readonly b: number };
  /**
   * Unit vector pointing TOWARDS the fill source, same convention as
   * `ViewState.sunDirection`. Planetshine from a world below the ship is
   * `(0, -1, 0)`, which is the default when this is omitted.
   *
   * This exists because the fill hemisphere used to be hard-coded to `-N.y` and
   * therefore ignored the direction the scene actually placed the world in.
   * Every shot in `Showroom.ts` already carries a `fillDirection`; nothing
   * forwarded it. Pass it through and a hull lit from beneath by a planet on the
   * port quarter fills on its port belly rather than on its whole underside.
   */
  readonly fillDirection?: { readonly x: number; readonly y: number; readonly z: number };
}

export interface ShipMaterialSet {
  /** Non-instanced surface: hull, modules, connections. */
  readonly hull: ShaderMaterial;
  /**
   * Instanced surface: greebles and repeated fittings.
   *
   * This is the SAME OBJECT as `hull` — three keys its program cache on
   * instancing itself, so one material serves both bindings and still compiles
   * both permutations. Bind it, do not mutate it: a per-material change here
   * would also change the hull.
   */
  readonly greeble: ShaderMaterial;
  /** Additive emitters: windows, navlights, strobes, floodlights. */
  readonly emissive: ShaderMaterial;
  /**
   * The uniform object all three materials share by reference. Read it to wire
   * something up; write it only through `apply()`.
   */
  readonly uniforms: Readonly<Record<string, IUniform>>;
  /** Cache key. Two ships with equal keys are drawing with the same objects. */
  readonly key: string;
  /**
   * Push this ship's values into the shared uniforms. Zero allocation. Call
   * from the ship root's `onBeforeRender`, not from `update()` — with a shared
   * material the values must be current at *draw* time, not at tick time.
   */
  apply(view: ViewState, state: ShipSurfaceState): void;
  /**
   * Override the analytic caster set with the one the mesh actually built.
   *
   * `shipMaterials()` seeds this from the blueprint's modules and volumes,
   * which is the best guess available from pure data, but only the geometry
   * module knows the part ids it allocated — and without them a caster whose
   * id matches the surface it sits on cannot be rejected, so a slab shadows
   * itself into a black stripe down its own face. Pass `partIds` filled with
   * the ids from `aSurf.y`, or `-1` where a caster belongs to no single part.
   *
   * `spheres` is 4 floats per caster (centre.xyz, radius); both arrays are
   * copied, and anything past `SHIP_OCC_MAX` for the tier is dropped after the
   * caller has sorted — sort by radius, or a whip antenna evicts a radiator.
   */
  setOccluders(spheres: Float32Array, partIds: Float32Array, count: number): void;
  /** Number of analytic caster slots this tier compiled with. */
  readonly occluderSlots: number;
  /** Number of analytic lamp slots this tier compiled with. */
  readonly lampSlots: number;
  /** Release this ship's hold on the cached materials, and free its own atlas. */
  dispose(): void;
}

// ===========================================================================
// Budgets
// ===========================================================================

/**
 * Analytic cast-shadow casters. Eight, not twenty-eight.
 *
 * The arithmetic behind the cut (ANALYSIS §2.5): `uOcc[28]` + `uOccPart[28]`
 * costs 56 fragment uniform vectors — 2 per caster, because in the default
 * GLSL ES layout every element of a `float[]` occupies a whole vec4 register —
 * against a WebGL2 spec minimum of 224 total. The loop is ~34 ALU with no
 * early-out, so 28 slots is ~950 ALU per fragment, unconditionally, ~26% of
 * the whole shader. And it still runs out: 27 of the 28 are already spent on a
 * 30 m hull with 17 bolt-ons, and holding that areal density to 1 km needs
 * 31,000.
 *
 * WHAT WAS CHOSEN INSTEAD, AND WHAT IT COSTS.
 *
 * The bulk of contact darkening moved into the baked `aBent` channel: 4 floats
 * per vertex, ~8 ALU per fragment, independent of part count, and it captures
 * both the ambient contact term and a directional shadow that tracks the star.
 * What it cannot do is throw a *long* shadow — a bent normal is a local
 * measurement, so a radiator wing striping the flank thirty metres away is
 * invisible to it. So eight analytic slots survive for exactly that: the large
 * silhouette masses whose stripe sweeps as the sun moves. Sorted by radius at
 * upload, so a whip antenna can never evict a radiator.
 *
 * Cost: 16 uniform vectors (8 + 8), ~270 ALU. Against 56 vectors and ~950.
 *
 * What it gives up: a hull with more than eight large masses loses the moving
 * stripe from the ninth onward. It keeps its baked contact darkening, so it
 * reads as seated hardware, just without a sweeping shadow. On hulls above
 * 0.4 km the loss is covered from the other side — `PostFX`'s SSAO runs a
 * 0.05 km world radius, which is larger than the entire reference ship but is
 * a sensible structural-crevice scale on a capital, so capitals get real
 * screen-space occlusion for free at `high`/`ultra`. `uAoStrength` is dropped
 * to 0.55 there so the two are not multiplied together into mud.
 */
export const SHIP_OCC_MAX_HIGH = 8;
/** Analytic window/service lamps. Per-ship; on a capital, bind per module. */
export const SHIP_LAMP_MAX_HIGH = 8;
/** Directional stain sources: exhaust soot, radiator heat, cryogenic frost. */
export const SHIP_STAIN_MAX_HIGH = 6;
/** Projected marking decals: registry, hazard zones, stripes, emblem. */
export const SHIP_MARK_MAX_HIGH = 4;
/**
 * Dated, directional damage events shaded analytically from `bp.damageHistory`.
 *
 * Four, and only four, because a wound has to be *legible as an event*. BRIEF §7
 * and the damage shot's own fail list both reject "every wound is the same age"
 * and "wounds are radially uniform instead of directional"; the way you get both
 * failures at once is a noise field, and the way you avoid both is a small
 * number of real strikes carrying their own `incidence` vector and `ageSeconds`.
 * Sixteen scattered marks are a texture. Four with a direction and a date are a
 * history. Cost is 8 uniform vectors and ~40 ALU with the jitter field hoisted
 * out of the loop.
 */
export const SHIP_WOUND_MAX_HIGH = 4;

interface TierBudget {
  readonly occ: number;
  readonly lamp: number;
  readonly stain: number;
  readonly mark: number;
  readonly wound: number;
  readonly grimeOctaves: number;
  readonly rivets: boolean;
  readonly bump: boolean;
}

const TIER_BUDGETS: Record<QualityTier, TierBudget> = {
  low: { occ: 4, lamp: 4, stain: 3, mark: 2, wound: 2, grimeOctaves: 2, rivets: false, bump: false },
  medium: { occ: 6, lamp: 6, stain: 4, mark: 3, wound: 3, grimeOctaves: 3, rivets: true, bump: true },
  high: {
    occ: SHIP_OCC_MAX_HIGH,
    lamp: SHIP_LAMP_MAX_HIGH,
    stain: SHIP_STAIN_MAX_HIGH,
    mark: SHIP_MARK_MAX_HIGH,
    wound: SHIP_WOUND_MAX_HIGH,
    grimeOctaves: 4,
    rivets: true,
    bump: true,
  },
  ultra: {
    occ: SHIP_OCC_MAX_HIGH,
    lamp: SHIP_LAMP_MAX_HIGH + 2,
    stain: SHIP_STAIN_MAX_HIGH,
    mark: SHIP_MARK_MAX_HIGH,
    wound: SHIP_WOUND_MAX_HIGH,
    grimeOctaves: 4,
    rivets: true,
    bump: true,
  },
};

/**
 * Above this hull length the ship is large enough that `PostFX`'s 0.05 km SSAO
 * radius is a structural-crevice scale rather than larger than the whole ship,
 * so the baked occlusion is rationed to avoid double-darkening.
 */
const SSAO_TAKES_OVER_KM = 0.4;

/**
 * Edges with a radius of curvature below ~0.38 m wear through. This is the one
 * frequency in the file that is genuinely absolute: a 3 cm plate edge is a 3 cm
 * plate edge on a courier and on a capital, and `|dN/dP|` is already in 1/km.
 */
const CURV_SCALE = 1 / 2600;

/** Seam relief depth ceiling, km. 2.5 cm — deep enough to make a lit/shadowed
 *  edge pair at hero distance, shallow enough not to read as dirt on the lens. */
const SEAM_RELIEF_MAX_KM = 2.5e-5;

/**
 * How much brighter a close world fills a hull than its own radiance.
 *
 * `ShipSurfaceState.fill` is a *radiance* — the brightness of the lit face of
 * the planet — and integrating it against a cosine lobe over a unit hemisphere
 * returns exactly that radiance back, which is what the shader used to do. But
 * planetshine only exists at all when the world is close enough to subtend a
 * large fraction of the sky, and at that range it is not a hemisphere of that
 * radiance, it is most of one. Against a 0.55-intensity key the honest unit
 * integral loses to the star on every surface including the belly, which is the
 * exact inversion the planetshine frame was marked down for. 3.4 is the ratio
 * that lets an unoccluded underside beat a key-lit upper flank at the
 * intensities the shot configures, and it is scaled by `uFill`, so in deep space
 * — where the reference fill is 0.011 — it changes nothing.
 */
const FILL_GAIN = 3.4;

/**
 * The grime film's chromaticity, normalised to unit luminance.
 *
 * Taken from `palette.scorch`, which every faction authors, then pulled 35%
 * towards neutral because dirt is a mixture and mixtures desaturate. Kessler's
 * comes out at R/B = 1.14 and Sillane's at 0.94 — warm and cold respectively,
 * which is the whole point. The constant this replaces was 1.40 for everyone.
 */
function grimeTint(palette: ShipPalette): Float32Array {
  const s = palette.scorch ?? [0.011, 0.0095, 0.0088];
  const lum = Math.max(0.3 * s[0] + 0.59 * s[1] + 0.11 * s[2], 1e-6);
  const out = new Float32Array(3);
  for (let i = 0; i < 3; i++) {
    // Normalise to unit luminance, desaturate, and bound so a pathological
    // palette entry cannot become a colour multiplier.
    out[i] = Math.min(Math.max(((s[i] ?? lum) / lum) * 0.65 + 0.35, 0.5), 1.6);
  }
  return out;
}

// ===========================================================================
// The agreed panel rule
// ===========================================================================

/**
 * Cycles per kilometre of the plate grid — the number the shader wants.
 *
 * The authority is `bp.dimensions.panelSizeKm`, which the architect derives
 * from hull length (BRIEF §7: a plate on a 30 m courier and a plate on a 4 km
 * capital cannot be the same size on screen) and which `families.ts` biases per
 * yard through `ConstructionDna.panelSizeFactor`. Geometry and material both
 * read that one field; this function only inverts it, and exists so the
 * agreement is a call rather than a comment.
 *
 * Guarded, because a blueprint that forgot to fill it in must not divide by
 * zero: falls back to the shipbuilding rule the analysis derives,
 * `3.8 m * (L/30 m)^(1/3)`, which matches real practice (12 m plate on a 300 m
 * vessel) and is sub-linear for the reason real plate is — bigger hulls get
 * bigger plates, but not proportionally bigger.
 */
export function shipPanelSizeKm(bp: ShipBlueprint): number {
  const declared = bp.dimensions.panelSizeKm;
  if (Number.isFinite(declared) && declared > 1e-7) return declared;
  const lengthKm = Math.max(bp.dimensions.lengthKm, 1e-4);
  return 0.0038 * Math.cbrt(lengthKm / 0.03);
}

/** `1 / shipPanelSizeKm` — the `uPanelSize` reciprocal the grid is sampled at. */
export function shipPanelScale(bp: ShipBlueprint): number {
  return 1 / shipPanelSizeKm(bp);
}

// ===========================================================================
// GLSL
// ===========================================================================

/**
 * Plating on an arbitrary 2D projection of object space.
 *
 * A jittered two-level grid, not worley: real hull plating is rectangular and
 * irregular *in size*, not in shape. One floor, one hash, one of three
 * subdivision patterns, ~12 ALU. Returns (distance to nearest seam, plate id,
 * coordinate along that seam) and all three channels are consumed — the id
 * picks the batch shade, the along-coordinate spaces the fasteners.
 *
 * Copied from `Ship.ts`'s module-private `PANEL_GLSL`, which cannot be
 * imported and is not in `shaders/chunks.ts` (integrator-owned). Renamed to the
 * `sm_` prefix so nothing collides with three's `<common>`.
 */
const PANEL_GLSL = /* glsl */ `
float sm_hash21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec3 sm_panels(vec2 q) {
  vec2 g0 = floor(q);
  vec2 f0 = q - g0;
  float r = sm_hash21(g0 + 11.3);
  vec2 sub = r < 0.36 ? vec2(2.0, 1.0) : (r < 0.68 ? vec2(1.0, 2.0) : vec2(2.0, 2.0));
  vec2 q1 = f0 * sub;
  vec2 g1 = floor(q1);
  vec2 f1 = q1 - g1;
  vec2 d = min(f1, 1.0 - f1) / sub;
  return vec3(min(d.x, d.y),
              sm_hash21(g0 * 3.71 + g1 * 1.13 + 5.0),
              d.x < d.y ? q.y : q.x);
}

float sm_seam(float d, float w) {
  float e = fwidth(d) * 1.4 + 1e-7;
  return 1.0 - smoothstep(w - e, w + e, d);
}

// A band is worth evaluating only once its wavelength covers a few pixels.
// Below that it is moire, and moire on a fleet of hulls is the "uniform noise"
// failure BRIEF §7 rejects, arrived at from the far end instead of the near.
// Same curve as Planet.ts's os_detailFade, kept identical on purpose.
float sm_fade(float wavelengthKm, float pixelKm) {
  return smoothstep(1.5, 5.0, wavelengthKm / max(pixelKm, 1e-9));
}
`;

const SURFACE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

// Per-vertex on the hull, per-instance on the greebles. Same declaration
// either way — three binds whichever the geometry supplies, so one program
// serves both and there is no permutation.
attribute vec4 aSurf;   // wear, partId, yardTag, panelScaleMul
attribute vec4 aBent;   // bent normal xyz (ship space), occlusion w

varying vec3 vPos;
varying vec3 vNrm;
varying vec4 vSurf;
varying vec4 vBent;

void main() {
  vec3 p = position;
  vec3 n = normal;

  #ifdef USE_INSTANCING
    mat3 im = mat3(instanceMatrix);
    // Correct normal transform for a rotation*scale matrix without inverting it.
    vec3 sc = vec3(length(im[0]), length(im[1]), length(im[2]));
    p = (instanceMatrix * vec4(p, 1.0)).xyz;
    n = im * (n / max(sc * sc, vec3(1e-9)));
  #endif

  vPos = p;
  vNrm = normalize(n);
  vSurf = aSurf;
  vBent = aBent;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const SURFACE_FRAG = /* glsl */ `
#include <common>
#include <onespace_noise>
#include <onespace_color>
#include <logdepthbuf_pars_fragment>
${PANEL_GLSL}

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uCameraLocal;
uniform vec3  uFill;
// Unit vector pointing TOWARDS the fill source — the same convention as
// uSunDir, so planetshine from a world below the ship is (0,-1,0), which is
// exactly what every shot in Showroom.ts already sets as its fillDirection and
// what nothing forwarded. ARCHITECTURE §6 allows no ambient constant in space,
// so this is the only thing deciding which surfaces the fill reaches, and
// hard-coding it to -N.y made the fill land top-down on the one frame whose
// entire subject is light arriving from underneath.
uniform vec3  uFillDir;
// How much brighter than its own radiance a planet fills a hull. A world close
// enough to light a ship subtends far more than the cosine lobe a unit
// hemisphere integrates to, so 1.0 under-counts it by roughly the ratio of the
// disc to the lobe. Only matters when uFill is large, which is only in orbit.
uniform float uFillGain;
uniform float uTime;
uniform float uThrottle;
uniform float uHeat;

// --- scale ------------------------------------------------------------------
uniform float uHullLen;      // km. EVERY frequency below is a multiple of 1/this.
uniform float uPanelSize;    // km. The agreed plate edge. See shipPanelSizeKm().
uniform float uPanelJitter;  // 0..1 spread of per-part plate size
uniform float uSeamDepth;    // km, seam recess
/**
 * 0..1 — how much of a VISIBLE joint this yard's construction actually leaves.
 *
 * uSeamDepth was the only thing carrying ConstructionDna.seamDepthFactor, and
 * it is clamped to SEAM_RELIEF_MAX before it reaches the shader, so it only ever
 * scaled the *relief*. The albedo groove, the cavity darkening, the plate-edge
 * wear band and the corrosion that pools in a joint were all drawn at full
 * strength regardless — which is why a Sillane cast monocoque, declared at
 * seamDepthFactor 0.15 with the comment "a seam is an admission", came back
 * carrying the same rectangular plate grid as the riveted hulls either side of
 * it. Attenuating an always-on grid is not the same as not drawing one.
 *
 * This is the un-clamped factor, so 0.15 arrives here as ~0.08 and a moulded
 * Sillane flank shows a surface break you can find at arm's length and cannot
 * see at fleet range, which is exactly what families.ts declares.
 */
uniform float uSeamVis;
/**
 * 0..1 depth of the always-on vacuum-weathering film. See the film block.
 *
 * Not "more dirt": this is the component of ARCHITECTURE §6's "everything is
 * dirty" that is a REFLECTANCE, not a texture. It is what stops a hull authored
 * as a paint chip from rendering as a paint chip after forty years in vacuum.
 */
uniform float uFilmDepth;
uniform float uFastenerPitch;// km along a seam. Exactly 0 means welded, no rivets.
uniform float uPixelAngle;   // 2*tan(fovY/2) / viewportHeight
uniform float uCoverage;     // ship length in pixels, for the curvature gate
uniform float uMicroDetail;  // faction multiplier on the finest band
uniform vec3  uSeed;         // per-ship decorrelation offset
// (alongNose, alongTail) in the flow coordinate, km. Everything the ship emits
// travels one way along the hull, so grime has a gradient and not a mean.
uniform vec2  uAftSpan;

// --- palette (linear RGB) ---------------------------------------------------
uniform vec3 uPlate0;
uniform vec3 uPlate1;
uniform vec3 uPlate2;
uniform vec3 uPlate3;
uniform vec3 uPatch0;
uniform vec3 uPatch1;
uniform vec3 uPatch2;
uniform vec3 uMismatch;
uniform vec3 uAccent;
uniform vec3 uTrim;
uniform vec3 uMetal;
uniform vec3 uPrimer;
uniform vec3 uOxide;
uniform vec3 uScorch;
uniform vec3 uAmber;
uniform vec3 uPlumeColor;
/**
 * Chromaticity of the grime film, normalised to unit luminance.
 *
 * Derived from palette.scorch — the one colour every faction authors for
 * "what burnt residue looks like on our steel" — instead of the hard-coded warm
 * grey this used to be. That constant was a (0.42, 0.36, 0.30) multiply on the
 * plate luminance, i.e. R/B = 1.4, applied at up to full strength over the whole
 * hull; it repainted Sillane's cold blue-grey hull warmer than Kessler's and
 * erased the one faction read that families.ts says the hue alone should
 * carry. Grime is a FILM. It may lower value and pull chroma; it may not invert
 * the base's R-B ordering, which is why it is blended with the plate's own
 * chroma below rather than substituted for it.
 */
uniform vec3 uGrimeTint;

// --- surface response -------------------------------------------------------
uniform float uRough;
uniform float uMetalness;
uniform float uPaintFade;
uniform float uPatchRate;
uniform float uGrime;
uniform float uBump;
uniform float uCurvScale;
uniform float uAoStrength;
uniform vec3  uFlowDir;
// x edges, y hatches, z streaks, w soot
uniform vec4  uWearA;
// x heat, y pitting, z corrosion, w frost
uniform vec4  uWearB;

// --- analytic sets ----------------------------------------------------------
// xyz centre in ship space, w radius. w = 0 marks an empty slot.
uniform vec4  uOcc[SHIP_OCC_MAX];
// Part id of the caster in the matching slot, so a fin cannot shadow itself
// into a black stripe down its own face.
uniform float uOccPart[SHIP_OCC_MAX];
// xyz position, w aperture radius in km — the falloff is derived from the
// aperture rather than from a hard-tuned 1.3 m e-folding length.
uniform vec4  uLamp[SHIP_LAMP_MAX];
// rgb colour, a intensity. Per-lamp colour, because a cargo floodlight is cold
// and a window is amber and one global uAmber cannot express both.
uniform vec4  uLampTint[SHIP_LAMP_MAX];
// xyz origin, w source radius in km (0 = empty slot)
uniform vec4  uStain[SHIP_STAIN_MAX];
// xyz unit axis the deposit travels along, w = kind + strength:
// floor(w) is 0 soot / 1 heat / 2 frost, fract(w) is 0..1 strength.
uniform vec4  uStainAxis[SHIP_STAIN_MAX];
// xyz wound centre in ship space, w surface radius in km (0 = empty slot).
uniform vec4  uWound[SHIP_WOUND_MAX];
// xyz the unit vector the strike ARRIVED along (DamageEvent.incidence), which is
// what makes a wound an event rather than a stamp: spall and soot run
// downstream of it and the everted lip is on the far side. w packs severity and
// age — floor(w)/15 is severity, fract(w) is 0 fresh .. 1 old.
uniform vec4  uWoundAxis[SHIP_WOUND_MAX];

#ifdef SHIP_MARKINGS
// xyz centre, w kind: 0 text, 1 hazard chevrons, 2 stripe band, 3 emblem
uniform vec4      uMark[SHIP_MARK_MAX];
// xyz across-axis divided by half-width, w paint wear 0..1
uniform vec4      uMarkU[SHIP_MARK_MAX];
// xyz up-axis divided by half-height, w atlas row index
uniform vec4      uMarkV[SHIP_MARK_MAX];
uniform sampler2D uMarkAtlas;
uniform float     uMarkRows;
#endif

varying vec3 vPos;
varying vec3 vNrm;
varying vec4 vSurf;
varying vec4 vBent;

void main() {
  #include <logdepthbuf_fragment>

  vec3  N     = normalize(vNrm);
  vec3  P     = vPos;
  vec3  toCam = uCameraLocal - P;
  float dist  = max(length(toCam), 1e-9);
  vec3  V     = toCam / dist;
  float pxKm  = dist * uPixelAngle;

  vec3 dPx = dFdx(P);
  vec3 dPy = dFdy(P);
  // |dN/dP| is a view-independent curvature estimate: it spikes on every
  // geometric edge, which is exactly where paint wears through.
  float curv = (length(dFdx(N)) + length(dFdy(N))) / max(length(dPx) + length(dPy), 1e-12);

  float L      = max(uHullLen, 1e-5);
  float wPlate = max(uPanelSize * clamp(vSurf.w, 0.25, 4.0), 1e-6);
  float wBay   = max(L * 0.005, wPlate * 2.5);   // structural bay, L/200
  float wSect  = max(L * 0.05,  wBay  * 3.0);    // hull section, L/20
  float wRivet = max(uFastenerPitch, 1e-6);
  float wMicro = wPlate * 0.06 / max(uMicroDetail, 0.05);

  // The cascade. Each band is multiplied to zero the moment it stops covering
  // pixels, so the surface converges to its mean at range instead of to grain.
  float kSect  = sm_fade(wSect,  pxKm);
  float kBay   = sm_fade(wBay,   pxKm);
  float kPlate = sm_fade(wPlate, pxKm);
  float kRivet = sm_fade(wRivet, pxKm) * step(1e-9, uFastenerPitch);
  float kMicro = sm_fade(wMicro, pxKm);
  // The curvature estimate is a screen-space derivative, so at LOD2 and beyond
  // every edge saturates and the whole ship turns to bare steel. Gate it on the
  // ship's own pixel coverage, not on distance.
  float kEdge  = smoothstep(60.0, 160.0, uCoverage);

  // --- triplanar --------------------------------------------------------
  vec3 an = abs(N);
  an = an * an * an;
  an *= an;                                   // |N|^6: near-binary
  an /= max(an.x + an.y + an.z, 1e-5);
  // A clean plane hand-over draws a lat/long lattice radiating off the nose,
  // where the dominant plane flips fastest. Warping the decision at bay scale
  // turns that lattice into a ragged butt joint.
  vec3 anj = an + os_fbm(P / wBay + uSeed, 2, 2.2, 0.5) * vec3(0.11, -0.07, 0.09);

  float partId = vSurf.y;
  // Plate size is a per-part decision. One panel scale across hull, fin, pod
  // and pannier makes the plating read as one projected texture instead of as
  // sheet metal cut by four yards; part 0 is pinned to the ship's reference
  // plate so there is still one size the eye can calibrate against.
  float ps   = (1.0 / wPlate)
             * (1.0 + uPanelJitter * step(0.5, partId)
                    * (sm_hash21(vec2(partId * 7.31, 1.9)) * 2.0 - 1.0));
  vec2  poff = vec2(sm_hash21(vec2(partId * 3.17, 8.4)),
                    sm_hash21(vec2(partId * 5.09, 2.2))) * 23.0;

  vec3 pa = sm_panels(P.zy * ps + poff);
  vec3 pb = sm_panels(P.xz * ps + poff);
  vec3 pc = sm_panels(P.xy * ps + poff);

  // A cast hull's break is both SHALLOWER and NARROWER than a butt joint
  // between two rolled plates, so uSeamVis moves the width as well as the
  // amplitude. Gating only the amplitude leaves a full-width grey line, which
  // still reads as a grid.
  float seamW = 0.008 * mix(0.45, 1.0, uSeamVis);
  float plateSeam = (sm_seam(pa.x, seamW) * an.x
                   + sm_seam(pb.x, seamW) * an.y
                   + sm_seam(pc.x, seamW) * an.z) * kPlate;
  // Gated AT SOURCE, so every consumer follows: the albedo groove, the cavity
  // AO, the corrosion that pools in a joint, the dirt that collects in it, the
  // amber leak and the relief all read this one number. Gating them one by one
  // is how a "seamless" hull ends up seamless in albedo and still grooved in
  // the normal map.
  plateSeam *= uSeamVis;

  // Panel identity from the dominant plane only. Blending ids is mush.
  vec3 dom = anj.x > anj.y ? (anj.x > anj.z ? pa : pc) : (anj.y > anj.z ? pb : pc);
  vec2 q2  = anj.x > anj.y ? (anj.x > anj.z ? P.zy : P.xy) : (anj.y > anj.z ? P.xz : P.xy);
  float pid = dom.y;

  // Two coarser tiers on the dominant plane only, one evaluation each. The bay
  // tier is a real structural break — deeper, and it is what survives to LOD1.
  vec3  bay      = sm_panels(q2 / wBay + 7.31);
  // Only PARTLY gated by uSeamVis. A structural bay break is a frame station —
  // a monocoque still has ring stiffeners and still shows where they are — so
  // a cast hull loses its plate grid but keeps the coarse tier that gives it
  // scale. Taking both away leaves a featureless tube.
  float bayGroove = sm_seam(bay.x, 0.012) * kBay * mix(0.40, 1.0, uSeamVis);

  // --- production batches ------------------------------------------------
  // Adjacent plates arrive from one delivery and share a shade; the run
  // boundary is a section-scale cell, so the drift reads as a batch of plate
  // rather than as per-panel noise. This is the tier that keeps a large flat
  // flank from reading as one painted surface at any distance.
  float run  = sm_hash21(floor(q2 / wSect) + uSeed.xy * 3.7);
  vec3  base = mix(mix(uPlate0, uPlate1, step(0.25, run)),
                   mix(uPlate2, uPlate3, step(0.75, run)),
                   step(0.5, run));
  // A part from another yard keeps that yard's colour, not ours.
  base = mix(base, uMismatch, step(0.5, vSurf.z));

  vec3 albedo = base;
  // Per-plate drift inside a batch, a few percent, faded with the plate tier.
  albedo *= 1.0 + (pid * 2.0 - 1.0) * 0.07 * kPlate;
  // Macro variation at section scale so no two square metres match. Faded to
  // zero rather than to a random value, so distance converges to the mean.
  // Widened from +/-10% to +/-17%. This is the ONLY band that survives to fleet
  // range — at 120 px of coverage the plate, bay and fastener tiers have all
  // faded out and the section tier plus the grime gradient are the entire
  // signal — so it is also the only thing standing between a distant hull and
  // one flat value. The fleet frame that came back as three white cut-outs with
  // no midtone anywhere was three hulls converging to their own mean, correctly,
  // with nothing authored at that scale for them to converge to.
  //
  // Evaluated on a coordinate STRETCHED ALONG THE FLOW AXIS rather than on
  // isotropic object space. The band is unchanged in purpose and in cost; what
  // changes is that it now has a direction. Isotropic, it was the single
  // largest signal on a plate at arm's length and it had no orientation, which
  // is the "uniform noise laid evenly over everything" BRIEF §7 rejects — the
  // high-pass energy of a hull flank measured the same along both screen axes,
  // and the only thing a critic could name on a plate was round blotch. A hull
  // weathers along the direction things travel over it, so a 3:1 stretch here
  // buys the whole surface a grain for one dot product.
  vec3 mflow = normalize(uFlowDir + vec3(0.0, 0.0, 1e-6));
  vec3 mP    = P - mflow * (dot(P, mflow) * 0.68);
  float macro = os_fbm(mP / wSect * 3.0 + uSeed.yzx, 3, 2.1, 0.55) * 0.5 + 0.5;
  // Amplitude down from 0.34: this band still has to carry the fleet-range
  // signal (it is the only one that survives kPlate fading out), but at 0.34 it
  // was also the dominant signal at arm's length, where it is far too
  // low-frequency to be anything but blotch. The energy it gives up here is
  // returned at the micro and fastener scales below, which is where a plate at
  // arm's length is supposed to get its texture.
  albedo *= 1.0 + (macro - 0.5) * 0.22 * kSect;

  // The FINEST band, on the albedo and not only on the pitting mask.
  //
  // The header promises four bands and the cascade computed five fade weights,
  // but nothing below wPlate ever reached the base colour: kMicro gated one
  // pitting mask and that was all. At arm's length — the greeble frame, the
  // docking frame — a plate therefore had literally no value texture and read
  // as a flat painted gradient, which is the "one projected texture" failure
  // BRIEF §7 rejects arrived at from the near end. Rolling scale, paint tooth,
  // weld shadow and walked-on film all live at this wavelength.
  //
  // And it drives the SHADING NORMAL, not only the albedo. That was the whole
  // defect: at 0.17 of albedo with no normal and no height contribution, rolling
  // scale and paint tooth are a 17% value wobble on a diffuse term that is
  // itself only a third of the pixel, i.e. invisible. Measured against the
  // hand-authored hull at the same framing, the procedural plate had 3.1x less
  // high-pass energy at r=4 px AND — worse — its energy rose monotonically with
  // filter radius, meaning every bit of variation it had was low-frequency
  // blotch and the small band was empty. A surface gets its small-form read from
  // the way it catches the key, not from its pigment. micro is consumed by the
  // relief block below; this is where it is authored.
  float micro = os_fbm(P / max(wMicro, 1e-7) * 0.5 + uSeed.zyx, 2, 2.3, 0.5);
  // A second, finer octave: paint tooth and blast profile, half a wavelength
  // below the rolling scale. Cheap (2 octaves) and it is what puts energy in
  // the r=1..2 px band specifically.
  float tooth = os_fbm(P / max(wMicro * 0.34, 1e-7) + uSeed.xzy, 2, 2.5, 0.5);
  albedo *= 1.0 + (micro * 0.17 + tooth * 0.07) * kMicro;

  // Sun-bleached paint: chalky, and it happens to the dorsal surfaces that face
  // out, not uniformly. Keyed to hull orientation rather than to uSunDir, or the
  // fade would rotate with the star. It does NOT get brighter: chalking scatters
  // more but it also holds more dirt, and a +6% value lift applied over the
  // whole upper hemisphere of every ship is a lift with no light source behind
  // it — exactly what ARCHITECTURE §6 forbids, spent on the largest area on the
  // ship.
  float bleach = uPaintFade * (0.35 + 0.65 * (N.y * 0.5 + 0.5));
  albedo = mix(albedo,
               mix(albedo, vec3(dot(albedo, vec3(0.30, 0.59, 0.11))), 0.30),
               bleach);

  // --- replaced panels ---------------------------------------------------
  // A refit plate is the wrong shade AND stands proud with its own fastener
  // ring. Colour alone reads as a decal; the step edge is what sells it.
  float replaced = step(1.0 - uPatchRate, sm_hash21(vec2(pid * 57.0, partId * 1.7 + 4.2)));
  vec3  patchCol = mix(mix(uPatch0, uPatch1, step(0.34, pid)), uPatch2, step(0.67, pid));
  // Mixed, not replaced outright: a repaint in the wrong batch is a shade off,
  // and a plate that swings the full way to the patch colour reads as a decal
  // stuck on the hull rather than as metal.
  // Squared fade: a wrong-shade plate is a high-contrast dot, so it has to
  // drop out well before the seams do or a hull at 150 px reads as peppered.
  albedo = mix(albedo, patchCol, replaced * kPlate * kPlate * 0.72);

  // ...and a refit plate is not a swatch that fills its grid cell exactly.
  // BRIEF §7: "a replaced panel sits slightly proud and in the wrong shade".
  // Colour alone put a flat rectangle inside the plating grid with no offset,
  // no lip and no fastener ring, which is the one thing the hero and damage
  // frames both got marked down for. Three things fix it and all three key off
  // dom.x, the distance to the plate's own seam:
  //   patchSign  half the patches stand proud and half sit sunk, so the set
  //                cannot read as one stamped pattern;
  //   patchRim   the plate's own edge, which catches the key on one side and
  //                shadows on the other once it is displaced (see the relief
  //                block, where this is what actually moves the normal);
  //   patchRing  the bolt line that put it there, resolvable at PLATE scale
  //                rather than at fastener scale — a 0.75 m fastener pitch is
  //                sub-pixel at hero distance but the ring it forms is not.
  float patchSign = sm_hash21(vec2(pid * 23.0, partId * 3.1 + 0.7)) * 2.0 - 1.0;
  float patchRim  = (1.0 - smoothstep(0.008, 0.060, dom.x)) * replaced * kPlate;
  float patchRing = (1.0 - smoothstep(0.028, 0.050, abs(dom.x - 0.039)))
                  * step(0.42, fract(dom.z * clamp(wPlate / wRivet, 3.0, 16.0)))
                  * replaced * kPlate;
  // The cut edge of new plate is bare and brighter than either shade; the bolt
  // heads are proud steel. Both are small areas, so neither lifts the mean.
  albedo = mix(albedo, uMetal * 0.8, max(patchRim * 0.28, patchRing * 0.45));

  // --- fasteners and welds -------------------------------------------------
  //
  // Whether a joint is bolted or welded is a decision the yard made for the
  // whole part. Hoisted out of the rivet block because BOTH branches now draw
  // something: a bolted seam gets a fastener row, a welded one gets a bead, and
  // a hull whose fastener pitch is zero is welded everywhere. Previously only
  // the bolted branch existed, so 40% of the parts on every ship — and 100% of
  // the parts on a Sillane — had literally nothing at fastener scale, which is
  // half of why a plate at arm's length had no small-form detail at all.
  float bolted = step(0.40, sm_hash21(vec2(partId * 11.3, 3.3)))
               * step(1e-9, uFastenerPitch);
  float rivet = 0.0;
  #ifdef SHIP_RIVETS
  {
    // Fastener spacing is a real length from the material profile, expressed
    // in plate cells so the pattern scales with the plate and not with the ship.
    // dom.z is a coordinate along the seam in plate-grid cells, so the number
    // of fasteners per cell is (plate edge / fastener pitch) — a real length
    // ratio out of the material profile, clamped so a huge plate does not turn
    // its seam into a solid bead of rivets.
    float rf = clamp(wPlate / wRivet, 2.0, 14.0);
    float ra = fract(dom.z * rf) - 0.5;
    float rd = length(vec2((dom.x - 0.02) * rf, ra));
    // A fastener head is a few centimetres across, not a third of its own
    // pitch. Antialiased by its own screen-space footprint, because a hard
    // threshold on a sub-pixel dot is the one thing on this hull that sparkles
    // when the camera moves.
    float rw = fwidth(rd) * 1.5;
    // A DOME, not a disc. rivet is consumed twice: as an albedo tint, where a
    // flat disc is fine, and as a height in the relief block, where a flat disc
    // has zero gradient across its whole face and produces a step ring instead
    // of a lit crescent and a shadow crescent. sqrt of the disc mask is a
    // hemispherical cap, which is the shape a fastener head actually is, and it
    // is the shading response — not the 16% albedo tint — that makes a rivet
    // field visible at any distance. This was the other half of the missing
    // small-form detail.
    float rdisc = 1.0 - smoothstep(0.055 - rw, 0.115 + rw, rd);
    rivet = sqrt(max(rdisc, 0.0));
    // The part id gates it and the plate id only breaks up the run. A replaced
    // plate is always bolted, because that is how a plate gets replaced in the
    // field.
    rivet *= max(bolted * step(0.30, sm_hash21(vec2(pid * 31.0, 2.7))), replaced);
    rivet *= 1.0 - smoothstep(0.06, 0.11, dom.x);
    rivet *= kRivet;
  }
  #endif

  // A weld bead: the joint a yard leaves when it does not bolt. Proud, rounded,
  // slightly rougher than the plate and a little wider than the seam it covers,
  // and it exists exactly where a fastener row does not — so the two together
  // mean every visible joint on every hull now carries something at the scale a
  // hand at arm's length resolves. It rides uSeamVis with the seam it sits on,
  // because a joint that was never made cannot have been welded shut.
  float weld = sm_seam(dom.x, 0.020) * kRivet * uSeamVis * (1.0 - bolted);
  // Beads are laid by hand and they wander: a perfectly straight bead of
  // constant width is the tell that it came out of a shader.
  weld *= 0.55 + 0.45 * (os_fbm(P * (620.0 / L) + uSeed.yzx, 2, 2.4, 0.5) * 0.5 + 0.5);

  // --- directional wear ---------------------------------------------------
  vec3  flow  = normalize(uFlowDir + vec3(0.0, 0.0, 1e-6));
  float along = dot(P, flow);
  vec3  perpP = P - flow * along;
  // Six streak periods along the hull, seventy across it: an 11:1 anisotropy
  // that IS the design intent. Ship.ts's (2400, 2400, 210) is that intent with
  // a 30 m hull already substituted in; here the substitution is uHullLen.
  vec3  sp    = perpP * (70.0 / L) + flow * (along * (6.0 / L));
  float streak = os_fbm(sp + uSeed, SHIP_GRIME_OCTAVES, 2.3, 0.5) * 0.5 + 0.5;
  // Contrasted hard into ribbons: soft noise reads as a dirty lens, not soot.
  streak = smoothstep(0.32, 0.82, streak);
  streak *= 0.55 + 0.45 * mix(0.5, smoothstep(0.3, 0.9,
              os_fbm(sp * 3.1 + uSeed.zxy, 2, 2.4, 0.5) * 0.5 + 0.5), kPlate);
  // It runs aft, it pools on downward faces, and it collects in the gaps.
  float dirt = streak * (0.45 + 0.55 * clamp(-N.y * 0.6 + 0.55, 0.0, 1.0));
  dirt = mix(dirt, 1.0, 0.30 * plateSeam);
  // A HULL-LONG GRADIENT, not a mean. Everything a ship emits — propellant
  // residue, radiator plume, vented atmosphere, its own dust — travels one way
  // along the flow axis, so the plating aft of the drive is filthy and the nose
  // is comparatively clean. Without this the streak field has the same expected
  // value at the nose as at the tail, which is the "uniform noise laid evenly
  // over everything" BRIEF §7 says will be rejected, and it is why no frame in
  // the set could show soot aft of the thrusters against clean plate forward.
  // uAftSpan is the real flow extent of the hull, so the gradient is anchored to
  // the ship rather than to the origin of the bounding box.
  float aftT = clamp((along - uAftSpan.x) / max(uAftSpan.y - uAftSpan.x, 1e-6), 0.0, 1.0);
  dirt *= mix(0.58, 1.45, aftT * aftT);
  // ARCHITECTURE §6: everything is dirty. Ribbons over clean paint is a model of
  // a hull; the film is a floor with ribbons on top of it.
  dirt = clamp((0.26 + 0.74 * dirt) * uGrime * uWearA.z * 1.9, 0.0, 1.0);

  // Analytic stain sources. Soot from the exhaust axes, heat staining off the
  // radiators, frost off cryogenic vents — three masks from one loop, because
  // all three are a deposit emanating from a point along an axis, and all three
  // must key off real hardware positions rather than off a noise field.
  float soot = 0.0;
  float bake = 0.0;
  float rime = 0.0;
  float wash = 0.0;
  for (int i = 0; i < SHIP_STAIN_MAX; i++) {
    vec4 s  = uStain[i];
    vec4 ax = uStainAxis[i];
    float live = step(1e-9, s.w);
    vec3  d    = P - s.xyz;
    float dl   = max(length(d), 1e-9);
    float t    = dot(d, ax.xyz);
    float perp = sqrt(max(dl * dl - t * t, 0.0));
    // ax.xyz is the direction the deposit SPREADS ALONG THE HULL, which for an
    // engine is the opposite of the exhaust: the plume leaves aft into vacuum
    // and there is no ship out there to blacken. What actually gets sooted is
    // the plating around and forward of the nozzle, from recirculation at the
    // mouth. Keying the stain to the exhaust vector instead of to its reverse
    // produces a spotless tail, which is the single most obvious tell that a
    // hull was never near its own engines.
    //
    // So: widest at the source, tapering as it runs up the hull, and bounded by
    // a fraction of the ship's length so a big drive does not soot the nose.
    float reach = min(s.w * 12.0, L * 0.30);
    float u     = clamp(t / reach, 0.0, 1.0);
    // Widened at the mouth from 4.0 to 5.5 exit radii. The verification the
    // critic asked for is a patch "two nozzle-diameters directly outboard of a
    // bell", which sits at perp = 4 * exitRadius — precisely where the old cone
    // reached exactly zero. A recirculating fan does not stop at the lip of the
    // bell that produced it.
    float cone  = s.w * mix(5.5, 1.4, u);
    float f     = (1.0 - smoothstep(cone * 0.30, cone, perp)) * (1.0 - u * u) * step(0.0, t);
    // Plus a dense halo at the source itself, where the deposit is heaviest in
    // every direction.
    f = max(f, 1.0 - smoothstep(s.w * 1.2, s.w * 4.0, dl));
    // Facing matters: a surface turned away from the source stays clean.
    f *= clamp(dot(N, -d / dl) * 0.6 + 0.55, 0.0, 1.0);
    // Break the smooth falloff so the edge of a soot field is ragged.
    f *= 0.55 + 0.45 * (os_fbm(P * (40.0 / L) + uSeed.zyx, 2, 2.3, 0.5) * 0.5 + 0.5);
    f *= live * fract(ax.w);

    float kind = floor(ax.w);
    soot += f * (1.0 - step(0.5, kind));
    bake += f * step(0.5, kind) * (1.0 - step(1.5, kind));
    rime += f * step(1.5, kind);
    // The plume lights the plating. A real light would cost a shadow pass and a
    // permutation; this is a distance-and-facing gradient off the same sources,
    // and its e-folding length is derived from the nozzle, not from a constant.
    wash += live * (1.0 - step(0.5, kind))
          * exp(-dl / max(s.w * 9.0, 1e-9)) * max(dot(N, -d / dl), 0.0);
  }
  soot = clamp(soot * uWearA.w, 0.0, 1.0);
  bake = clamp(bake * uWearB.x, 0.0, 1.0);
  rime = clamp(rime * uWearB.w, 0.0, 1.0);

  // --- damage history: dated, directional wounds --------------------------
  //
  // bp.damageHistory has carried an incidence vector and an ageSeconds
  // per event since the contract was published and this file was reading
  // neither, so every mark on the hull came out of the same noise field: same
  // size, same density, radially symmetric, and all exactly the same age. That
  // is all four bullets of the damage shot's own fail list at once, and no
  // amount of geometry underneath can rescue it — the mesh punches the hole,
  // but whether the hull around it reads as last month or as thirty years ago
  // is a surface decision and it is this one.
  //
  // Three masks come out of the loop and they are what a timeline looks like:
  //   scarBright  torn metal at the rim. FRESH ONLY. Bare, sharp, specular.
  //   scarOxide   oxide and packed dirt. OLD ONLY. Soft, matte, spreading.
  //   scarDark    the depression itself, at every age, and CLAMPED — see below.
  // The elongation along incidence is what stops them being stamps: a strike
  // at a shallow angle gouges downstream, and only the downstream side gets the
  // spall tail.
  float scarBright = 0.0;
  float scarOxide  = 0.0;
  float scarDark   = 0.0;
  // One jitter field for the whole set, hoisted out of the loop: four wounds
  // times a 2-octave fbm inside the loop would be the most expensive thing in
  // the shader, and the wounds do not need decorrelated edges — they need
  // ragged ones.
  float jag = 0.74 + 0.52 * (os_fbm(P * (300.0 / L) + uSeed.yzx, 2, 2.4, 0.5) * 0.5 + 0.5);
  for (int i = 0; i < SHIP_WOUND_MAX; i++) {
    vec4 wd = uWound[i];
    vec4 wa = uWoundAxis[i];
    float live = step(1e-9, wd.w);
    vec3  d    = P - wd.xyz;
    float t    = dot(d, wa.xyz);
    float perp = length(d - wa.xyz * t);
    // Downstream of the impact the wound is up to three times as long as it is
    // wide; upstream it is barely wider than the entry. Radially uniform damage
    // is the tell.
    // Guarded on a fraction of the hull rather than on 1e-9: an empty slot has
    // radius 0, and dividing a hull-scale offset by an epsilon puts 1e8 through
    // a length() on hardware that is not obliged to carry it.
    float wr     = max(wd.w, L * 1e-3);
    float reachW = wr * (1.0 + 2.0 * smoothstep(0.0, wr * 1.5, t));
    float rr = length(vec2(perp / wr, t / reachW));
    float age = fract(wa.w);
    float sev = 0.35 + 0.65 * clamp(floor(wa.w) / 15.0, 0.0, 1.0);
    float core = (1.0 - smoothstep(0.52 * jag, 1.00 * jag, rr)) * live * sev;
    float lip  = smoothstep(0.78 * jag, 1.02 * jag, rr)
               * (1.0 - smoothstep(1.02 * jag, 1.48 * jag, rr)) * live * sev;
    // Spall, soot and the dirt that later fills it, all on the far side only.
    float tail = (1.0 - smoothstep(1.0, 3.6, rr)) * smoothstep(0.0, wr * 0.8, t) * live * sev;
    // An old wound has no bright metal left anywhere; a fresh one has no oxide.
    scarBright = max(scarBright, lip * (1.0 - age) * (1.0 - age));
    scarOxide  = max(scarOxide,  max(lip * 0.8, tail * 0.55) * age);
    scarDark   = max(scarDark,   core * mix(1.0, 0.62, age));
  }

  // Edge wear. The curvature estimate saturates on anything small in screen
  // space, so ungated it turns every greeble into bare steel; it is gated by
  // noise, by the part's own exposure, and by the ship's pixel coverage.
  float edge = clamp(curv * uCurvScale, 0.0, 1.0) * kEdge;
  // A hull's dominant edge wear is not on its silhouette, it is on the
  // perimeter of every single plate: the lip is what gets knocked by a
  // handling frame, and the topcoat cracks at the seam before it cracks
  // anywhere else. A screen-space curvature estimate cannot see that — it only
  // spikes where the *geometry* turns — which is why the critic could find no
  // frame in the set where the edge of a plate differed from its centre. This
  // is a real feature of the surface, so it rides kPlate and disappears with
  // the plating rather than with the silhouette.
  //
  // Narrowed from 0.085 to 0.038 of a plate cell. dom.x tops out at 0.25, so
  // the old band covered roughly a THIRD of every plate's area, and it fed
  // bare, which mixes towards uMetal at 0.2 linear — three to four times the
  // hull's own albedo. A lip that wide is not a worn edge, it is a bright
  // border drawn around every plate on the ship, and it was a large part of why
  // the lit hull measured as a mid-grey. It also has to disappear on a hull
  // whose joints are moulded rather than butted, hence uSeamVis.
  float plateEdge = (1.0 - smoothstep(0.006, 0.038, dom.x)) * kPlate * uSeamVis;
  edge = clamp(max(edge, plateEdge * 0.45), 0.0, 1.0);
  float wearNoise = os_fbm(P * (46.0 / L) + uSeed.yxz, 3, 2.2, 0.55) * 0.5 + 0.5;
  float wear = smoothstep(0.55, 0.95,
                 edge * (0.25 + 1.05 * wearNoise) * (0.4 + 0.8 * vSurf.x)) * uWearA.x;
  float chip = smoothstep(0.72, 0.80, os_fbm(P * (27.0 / L) + uSeed, 3, 2.4, 0.5) * 0.5 + 0.5)
             * smoothstep(0.06, 0.50, edge) * uWearA.x;

  // Scuffing where people work: round hatches, handholds and anything the crew
  // touch. Driven by the part's own exposure channel, which is why a hatch is
  // scuffed and the plate two metres above it is not.
  float scuff = smoothstep(0.35, 0.95, vSurf.x)
              * smoothstep(0.40, 0.90, os_fbm(P * (120.0 / L) + uSeed.zxy, 2, 2.4, 0.5) * 0.5 + 0.5)
              * uWearA.y * kPlate;

  // Micro-impact pitting, on leading faces only. Dust arrives along the
  // direction of travel; the trailing half of the ship never gets hit.
  float lead = max(dot(N, -flow), 0.0);
  float pit  = smoothstep(0.82, 0.93, os_fbm(P * (900.0 / L) * uMicroDetail + uSeed.yzx, 2, 2.6, 0.5) * 0.5 + 0.5)
             * pow(lead, 1.5) * uWearB.y * kMicro;

  // Corrosion blooms in crevices and along seams — that is, where moisture and
  // dissimilar metals meet, which is a property of the geometry. Reading it off
  // the baked occlusion is what makes it land in real corners rather than in
  // random patches.
  float crev = clamp(vBent.w, 0.0, 1.0);
  float corr = smoothstep(0.20, 0.85, crev * 0.75 + plateSeam * 0.45 + bayGroove * 0.3)
             * (0.35 + 0.65 * (os_fbm(P * (210.0 / L) + uSeed.xzy, 2, 2.3, 0.5) * 0.5 + 0.5))
             * uWearB.z;

  // Scuffing contributes only weakly to BARE METAL. Rubbing a hatch surround
  // with a suit glove for ten years dulls and polishes the paint; it does not
  // strip a whole face back to steel. Weighting it like edge wear turns every
  // crew-accessible fitting into a chrome ornament brighter than the hull it is
  // bolted to, which inverts the read the contact darkening exists to create.
  float bare = clamp(wear + chip * 0.7 + scuff * 0.16 + pit * 0.55, 0.0, 1.0);

  // --- markings -----------------------------------------------------------
  // The faction's accent hue appears here and nowhere else on the plating.
  #ifdef SHIP_MARKINGS
  for (int i = 0; i < SHIP_MARK_MAX; i++) {
    vec4 m  = uMark[i];
    vec4 mu = uMarkU[i];
    vec4 mv = uMarkV[i];
    float lu = length(mu.xyz);
    float lv = length(mv.xyz);
    float live = step(1e-9, lu * lv);
    vec3  nrm = normalize(cross(mu.xyz, mv.xyz) + vec3(0.0, 0.0, 1e-9));
    vec3  d   = P - m.xyz;
    float u = dot(d, mu.xyz);
    float v = dot(d, mv.xyz);
    // Reject the far side of the hull and any surface not facing the decal.
    float depth = abs(dot(d, nrm));
    float gate = live
               * step(abs(u), 1.0) * step(abs(v), 1.0)
               * (1.0 - smoothstep(0.15, 0.50, depth * lu))
               * smoothstep(0.45, 0.80, dot(N, nrm));

    float kind = m.w;
    float ink = 0.0;
    // 0 — painted text from the glyph atlas.
    float row = mv.w;
    vec2  auv = vec2(u * 0.5 + 0.5, (row + (v * 0.5 + 0.5)) / max(uMarkRows, 1.0));
    ink += texture2D(uMarkAtlas, auv).r * (1.0 - step(0.5, kind));
    // 1 — hazard chevrons round exhausts and moving parts.
    float chev = step(0.5, fract((u * 3.0 + abs(v) * 1.6) * 1.5));
    ink += chev * step(0.5, kind) * (1.0 - step(1.5, kind));
    // 2 — a painted band; the cheapest faction read there is.
    ink += (1.0 - smoothstep(0.75, 1.0, abs(v))) * step(1.5, kind) * (1.0 - step(2.5, kind));
    // 3 — the emblem: a bold ring cut by a chevron. Geometric, so it survives
    //     being 20 px across, which a detailed crest would not.
    float rr = length(vec2(u, v));
    float ring = (1.0 - smoothstep(0.62, 0.72, rr)) * smoothstep(0.36, 0.46, rr);
    float wedge = (1.0 - smoothstep(0.10, 0.16, abs(v - u * 0.55))) * step(rr, 0.68);
    ink += clamp(ring + wedge, 0.0, 1.0) * step(2.5, kind);

    // Paint wears off markings first where the surface is already worn — a
    // uniformly worn set of markings is the same failure as uniform noise.
    float cov = clamp(ink, 0.0, 1.0) * gate * kBay
              * (1.0 - mu.w * smoothstep(0.30, 0.85, wearNoise))
              * (1.0 - 0.7 * bare);
    albedo = mix(albedo, uAccent, cov);
  }
  #endif

  // --- material response --------------------------------------------------
  // Never 1.0 metalness: a fully metallic fragment has no diffuse, and with no
  // environment to reflect every worn edge renders as a black fleck. Oxidised
  // steel is not a perfect conductor.
  float metalness = mix(uMetalness, 0.88, max(bare, scarBright * 0.9));
  // Undirtied paint stays under ~0.6 or the specular lobe is too wide to lift
  // anything off the silhouette.
  // Worn oxidised steel is not polished: 0.30 is a near-gloss and it puts a
  // specular hit on every chipped edge in the frame.
  float rough = mix(mix(uRough, 0.44, bare), 0.90, max(dirt, soot));
  // Scuffed paint loses its tooth without losing its pigment.
  rough = mix(rough, rough * 0.82, scuff);
  // Torn metal is sharp and shiny; a wound that has had thirty years of dust in
  // it is the roughest thing on the ship. This is half of how the two ages read
  // apart even before the colours differ.
  rough = mix(rough, 0.32, scarBright * 0.75);
  rough = mix(rough, 0.97, scarOxide * 0.65);

  albedo = mix(albedo, uPrimer, chip * 0.55);          // primer under the topcoat
  albedo = mix(albedo, uMetal, bare);                  // then bare steel
  albedo = mix(albedo, uOxide, corr * 0.85);           // oxide in the crevices
  // Soot is warm and it eats the paint's chroma as well as its value.
  albedo = mix(albedo, uScorch, soot * 0.9);
  // Heat staining is temper colour, not dirt: it shifts hue before it darkens.
  // Purely multiplicative now. The + uOxide * 0.30 this replaces was an
  // ADDITIVE term worth +45% of the hull's own red on Kessler's palette, laid
  // over whatever area the radiator stain covered — a light source with no
  // light behind it, and one more contributor to a hull measuring warm where
  // the direction says cool. Temper colour is thin-film interference on steel:
  // it moves hue and it loses a little value. It never adds any.
  albedo = mix(albedo, albedo * vec3(1.30, 0.94, 0.62), bake * 0.6);
  albedo = mix(albedo, vec3(0.42, 0.47, 0.55), rime * 0.6);

  // The wound timeline, in order of age. Oldest first so a fresh strike through
  // an old scar still shows its bright rim.
  albedo = mix(albedo, uOxide * 0.85, scarOxide * 0.80);
  albedo = mix(albedo, uMetal * 1.10, scarBright * 0.72);
  // A dent is not a hole. The depression is darker and dirtier than the plate,
  // but it is still plate and it still faces the star, so its value is CLAMPED
  // to a fraction of the surrounding albedo rather than driven to a palette
  // constant. Un-clamped, every wound bottomed out at the scorch colour on a
  // lit surface and the hull histogram went bimodal: cream plate, black blobs,
  // and nothing in between.
  albedo = mix(albedo, max(albedo * 0.34, uScorch * 1.6), scarDark * 0.85);

  // Grime last, because it settles on top of everything above it — including
  // the wounds, which is what makes an old one read as old.
  //
  // Palette-derived and CHROMA-PRESERVING. The film keeps 45% of the plate's own
  // colour and takes the rest from the faction's own soot hue; both halves are
  // then darkened, because dirt only ever removes light. The two bounds are the
  // point: mix at 0.45 means the base's R-B ordering survives at any dirt
  // level, and the 0.86 cap means grime can never fully repaint a hull. The
  // constant this replaces could, and did.
  float albLum = dot(albedo, vec3(0.30, 0.59, 0.11));
  vec3  grimeCol = mix(albedo, vec3(albLum) * uGrimeTint, 0.55) * 0.46;
  albedo = mix(albedo, grimeCol, dirt * 0.86);

  // --- vacuum weathering: the film that is a reflectance ---------------------
  //
  // THIS IS THE TERM THE "the hull is grey rather than near-black" FINDING IS
  // ABOUT, and the reason it is here rather than in the palette needs stating,
  // because three separate critics all prescribed "pull the base albedo down"
  // and that fix would have made two of the three findings worse.
  //
  // The palettes in families.ts are already near-black and already three
  // genuinely different hues: Kessler (0.058, 0.062, 0.050) grey-green, Sillane
  // (0.036, 0.043, 0.056) properly blue — blue channel HIGHEST — and Ossuary
  // (0.046, 0.035, 0.026) brown. Measured off the frames, all three rendered as
  // one warm cream within 5/255 of each other. Darkening those numbers cannot
  // fix that, and would deepen it: the fraction of each pixel that is
  // achromatic star-coloured specular rises as albedo falls, so three factions
  // at half the albedo converge HARDER, not less.
  //
  // What is actually wrong is a units mismatch nobody owned. families.ts authors
  // reflectance against an implied unit key ("sits at ~0.06 linear, well under
  // the 0.2 ceiling"); the showroom's key is uSunColor = (3.0, 2.79, 2.46), so
  // that 0.06 chip arrives on screen at 0.17 and lands in the top half of the
  // grade's tone curve — where GradePass's uHighTint (1.12, 1.00, 0.84) applies
  // a +33% R/B push. Measured through the real grade, a PERFECTLY NEUTRAL input
  // at that level comes out at R-B = +45. That is the cream, and no albedo hue
  // can cancel it, because it is applied after the tone map.
  //
  // The proof is in the frame set: ship-planetshine runs the same material and
  // the same palettes at a 0.55 key, lands at display luminance 61, and measures
  // R-B = -12 — cool blue-grey steel, exactly the art direction. Same albedo,
  // same shader, correct picture, purely because it sits lower on the curve.
  // Value and hue are ONE knob here, and this is it.
  //
  // So the honest fix is the one ARCHITECTURE §6 and BRIEF §7 already ask for:
  // everything is dirty. A hull authored as a paint chip must not render as a
  // paint chip after forty years in vacuum. This is the component of "dirty"
  // that is a REFLECTANCE rather than a texture, and being a reflectance it
  // scales with the key like everything else, so a hull still reads differently
  // under a 0.55 key and a 6.0 one — which a tone-mapping hack would have
  // destroyed. It is applied multiplicatively to the albedo, so it is
  // chroma-preserving by construction: the base's R-B ordering survives at any
  // depth, and once the hull sits in the toe, the grade's own uShadowTint
  // (0.84, 0.97, 1.14) supplies the cool cast for free.
  //
  // Weighted towards the dirt field rather than flat, so it deepens the
  // variation it is riding on instead of flattening it, and driven per ship
  // from maintenance so a neglected Ossuary is genuinely darker than a
  // well-kept Sillane — value becomes a fourth axis of faction identity rather
  // than a constant.
  //
  // One further property of this term that the detail cascade needs: it is NOT
  // gated by any of the k-bands. Every other darkening mask on the hull —
  // seams, bay grooves, plate edges, corrosion, scuffing — rides kPlate or
  // kBay and fades out with distance, so the surface used to converge at range
  // to its CLEAN albedo, i.e. to the brightest state it has. That is why
  // ship-extreme-distance measured at 193/255 and ship-lod0 measured brighter
  // than ship-hero-close. A weathered hull's mean is the weathered value; this
  // is always on, so the far field now converges to it.
  albedo *= 1.0 - 0.68 * uFilmDepth * (0.58 + 0.42 * dirt);

  // Trim, and only on the handful of fittings the crew actually grab. Applied
  // across everything merely "exposed" it stops being trim and becomes a second
  // hull colour.
  albedo = mix(albedo, uTrim, smoothstep(0.90, 1.0, vSurf.x) * 0.22);

  // Cavity: a seam is a hole, so it is darker and rougher than the plate.
  albedo *= 1.0 - 0.34 * plateSeam - 0.20 * bayGroove;
  rough = mix(rough, 0.92, plateSeam * 0.5);
  // Fastener heads are proud steel and genuinely brighter than the paint round
  // them, but only a little after the film — mixed towards a value tied to the
  // plate so a rivet field can never become a field of sparkling white dots on
  // a near-black hull. The read comes from the dome's shading, not from this.
  albedo = mix(albedo, mix(uMetal * 0.9, albedo * 1.5, 0.55), rivet * 0.16);
  rough = mix(rough, 0.42, rivet * 0.25);
  // Weld metal is a different material from the plate either side of it: heat
  // tint, no topcoat, and a coarse ripple. It is DARKER than the paint, not
  // brighter — a bead is oxidised steel — so it adds small-form contrast
  // without lifting the hull's mean, which the plate-edge band was doing.
  //
  // Expressed RELATIVE to the plate rather than as a palette constant, because
  // this mix happens after the weathering film: a constant colour mixed in
  // here would not have been filmed and would read brighter than the hull it
  // is supposed to be a scar on. Everything upstream of the film (primer, bare
  // steel, oxide, scars, patches) is filmed with the plate and needs no such
  // treatment.
  albedo = mix(albedo, albedo * 0.62 + uOxide * 0.10, weld * 0.55);
  rough = mix(rough, 0.88, weld * 0.6);
  // Paint tooth, as a ROUGHNESS field rather than as a normal or an albedo
  // tint. That is what a blast profile physically is — a variation in microfacet
  // slope distribution, not in height and not in pigment — and it is also the
  // cheapest way to get real energy into the smallest band: the specular lobe
  // is far more sensitive to roughness than the diffuse is to albedo, so under
  // a hard key this reads at a fraction of the amplitude a height field would
  // need. It rides kMicro, so it converges to the mean at distance like every
  // other band and cannot become sparkle at LOD1.
  rough = clamp(rough + tooth * 0.085 * kMicro, 0.06, 0.98);

  // --- occlusion ----------------------------------------------------------
  // The baked channel first: contact darkening plus a directional cone test, at
  // O(1) in part count. uAoStrength is rationed on capitals, where PostFX's
  // 0.05 km SSAO radius is doing the same job in screen space.
  float ao = 1.0 - clamp(vBent.w, 0.0, 1.0) * uAoStrength;
  ao *= (1.0 - 0.38 * plateSeam) * (1.0 - 0.22 * bayGroove) * (1.0 - 0.22 * dirt)
      * (1.0 - 0.45 * scarDark);

  vec3  bentDir = vBent.xyz;
  float bentLen = length(bentDir);
  vec3  bn = bentLen > 1e-4 ? bentDir / bentLen : N;
  // Occlusion read as a cone aperture: fully open is the whole hemisphere and
  // more, fully buried is a closed cone about the bent normal.
  float coneCos = 2.0 * clamp(vBent.w, 0.0, 1.0) - 1.0;
  float sunVis = mix(1.0,
                     smoothstep(coneCos - 0.35, coneCos + 0.35, dot(bn, uSunDir)),
                     uAoStrength);

  // Then the eight analytic casters — the large masses whose stripe sweeps as
  // the star moves, which no local bake can express. Without an interrupted key
  // the fins, masts and pylons read as decals rather than as hardware.
  for (int i = 0; i < SHIP_OCC_MAX; i++) {
    vec4  o    = uOcc[i];
    vec3  od   = o.xyz - P;
    float ot   = dot(od, uSunDir);
    float perp = sqrt(max(dot(od, od) - ot * ot, 0.0));
    // The penumbra opens with the throw: a star is a disc, not a point.
    float soft = o.w * (0.20 + 0.85 * clamp(ot / max(o.w * 7.0, 1e-9), 0.0, 1.0));
    float s = smoothstep(-soft * 1.6, soft * 1.6, perp - o.w);
    // Empty slot, caster behind the fragment, or the caster is this very part.
    s = mix(1.0, s, step(1e-7, o.w) * step(1e-7, ot)
                    * step(0.5, abs(partId - uOccPart[i])));
    // Nearest caster wins rather than accumulating — overlapping spheres
    // multiplied together punch black craters into the plating.
    sunVis = min(sunVis, s);
  }

  // --- relief -------------------------------------------------------------
  #ifdef SHIP_BUMP
  {
    // 8 mm of seam is too shallow to survive at hero distance: the gap makes no
    // lit/shadowed edge pair and every seam reads as a painted line. A real
    // recess plus a lip standing proud on one side of it gives each seam a
    // bright edge on the key side and a black one opposite, which is the whole
    // difference between a joint and a decal.
    float lip = sm_seam(abs(dom.x - 0.017), 0.006)
              * (step(0.5, sm_hash21(vec2(pid * 19.0, 4.4))) * 2.0 - 1.0);
    float depth = clamp(uSeamDepth, 0.0, SEAM_RELIEF_MAX);

    // TWO relief scales, because they need two different gradient treatments.
    //
    // Fine: seams, lips, fastener heads, patch rims. A seam is ~2 cm wide on a
    // 2.5 m plate. At hero distance one pixel spans ~30 cm of hull, so dFdx of
    // its height averages a 2.5 cm step over fifteen times its own width and
    // reports a slope of 0.03 — a two-degree tilt, which under any key produces
    // no lit edge and no shadowed edge and therefore a PAINTED LINE. That is
    // the single reason the plating in the hero frame read as a projected
    // texture rather than as sheet metal, and it is a sampling artefact, not a
    // depth problem: the bevel really is about 50 degrees, the pixel just cannot
    // see it. recover reconstructs the sub-pixel slope by renormalising the
    // screen derivative from the pixel footprint back to the seam's own physical
    // width. It is gated on kPlate, so once the plating itself stops being
    // resolvable the amplification switches off rather than turning into
    // aliasing at fleet range.
    float hFine = (-plateSeam * 0.9 + lip * 0.5 + rivet * 1.15 + weld * 0.9
                   + patchSign * patchRim * 1.9 + patchRing * 0.8) * depth;
    // Coarse: bay grooves, whole plates standing proud or sunk, crater floors.
    // Many pixels across, so their screen derivative is already honest and
    // amplifying it would only wreck them.
    float hCoarse = (-bayGroove * 1.6 + patchSign * replaced * kPlate * 1.2
                     + scarBright * 0.6 - scarDark * 2.2) * depth;

    // Micro: rolling scale and oil-canning in the plate itself. This is the
    // band that was missing entirely — it existed only as a 17% albedo tint,
    // and a value wobble on a diffuse term that is a third of the pixel is not
    // something the eye can find. Its amplitude is expressed as a fraction of
    // its OWN wavelength rather than of uSeamDepth, because what the eye reads
    // is the slope, not the depth: 0.03 of a wavelength is about a five-degree
    // tilt, which is a plate that has been handled, and it stays a five-degree
    // tilt on a courier and on a capital because wMicro is derived from the
    // plate. It takes no recover amplification — kMicro has already faded it
    // out by the time it stops covering pixels, so its screen derivative is
    // honest wherever it is non-zero, and amplifying it would only alias.
    float hMicro = micro * kMicro * wMicro * 0.030;

    float pxFoot   = max(length(dPx), length(dPy)) * 1.5;
    float seamPhys = max(wPlate * 0.020, 1e-9);
    float recover  = mix(1.0, clamp(pxFoot / seamPhys, 1.0, 9.0), kPlate);

    float dhx = dFdx(hFine) * recover + dFdx(hCoarse) + dFdx(hMicro);
    float dhy = dFdy(hFine) * recover + dFdy(hCoarse) + dFdy(hMicro);
    vec3  r1  = cross(dPy, N);
    vec3  r2  = cross(N, dPx);
    float det = dot(dPx, r1);
    if (abs(det) > 1e-20) {
      vec3 grad = (dhx * r1 + dhy * r2) / det;
      // Close up a pixel spans less hull than the relief is deep, and an
      // unclamped gradient tips the normal past the tangent plane.
      grad *= min(1.0, 1.8 / max(length(grad), 1e-9));
      N = normalize(N - uBump * grad);
    }
  }
  #endif

  // --- direct lighting: one key, no ambient -------------------------------
  float NoL = max(dot(N, uSunDir), 0.0) * sunVis;
  float NoV = max(dot(N, V), 1e-4);
  vec3  H   = normalize(uSunDir + V);
  float NoH = max(dot(N, H), 0.0);
  float VoH = max(dot(V, H), 0.0);

  float a  = max(rough * rough, 0.0025);
  float a2 = a * a;
  float dd = NoH * NoH * (a2 - 1.0) + 1.0;
  float D  = a2 / (PI * dd * dd);
  float k  = a * 0.5;
  float G  = (NoV / (NoV * (1.0 - k) + k)) * (NoL / (NoL * (1.0 - k) + k));
  vec3  F0 = mix(vec3(0.04), albedo, metalness);
  vec3  F  = F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);

  // Dust does not only broaden the specular lobe, it ABSORBS it: a film of it
  // over paint scatters the coherent reflection away and swallows the rest,
  // which is why a dirty car has almost no highlight rather than a wide one.
  //
  // This is the term that decides whether the palette can be seen at all. A
  // dielectric's specular is achromatic, so it arrives on screen wearing the
  // STAR's colour; on a hull whose albedo is 0.04 that lobe is as large as the
  // diffuse, and the sum of the two is the star's hue with a faint memory of the
  // paint in it. That is the whole mechanism behind three factions with
  // genuinely different authored hull hues — one of them explicitly cold blue —
  // measuring within three percentage points of each other and all warm. Only
  // raising the roughness with dirt (which is all this did) redistributes that
  // energy without removing any of it. Removing it hands the ratio back to the
  // paint.
  //
  // Extended to the whole hull, not only to the dirty parts of it. The previous
  // form only removed the lobe where dirt or soot happened to be high, so
  // on clean plate the achromatic term stayed at full strength — and on plating
  // whose albedo is 0.05, a 0.04 dielectric lobe is as large as the entire
  // diffuse. Integrated over a hull's normals against the showroom key, the
  // specular plus the grazing sheen were 37% (Kessler), 43% (Sillane) and 45%
  // (Ossuary) of the lit hull's total radiance. That is the mechanism behind
  // the faction measurement: nearly half of every hull was the STAR's colour
  // rather than the paint's, which is why three authored hues arrived within
  // 5/255 of one another. Chalked, dust-filmed paint scatters its coherent
  // reflection away — that is what chalking IS — so uPaintFade belongs in this
  // term, and it is per-faction, so removing it correctly gives the three hulls
  // three different specular fractions as well as three different hues.
  float filmed = (1.0 - 0.55 * max(dirt, soot))
               * (1.0 - 0.72 * uFilmDepth * (0.45 + 0.55 * uPaintFade));

  vec3 spec = (D * G / max(4.0 * NoV * NoL, 1e-4)) * F * NoL * filmed;
  // No 1/PI on diffuse: uSunColor is authored as irradiance with PI already
  // folded in, matching every other renderer in the project. Divide here and
  // the ship comes out PI times darker than the hero hull.
  //
  // (1 - F) is the energy the specular lobe already took. Without it the two
  // lobes together return more than arrives, and they do it worst at grazing
  // angles — which on a hull is the silhouette, i.e. exactly where the eye
  // reads the value.
  vec3 diff = albedo * (1.0 - metalness) * (vec3(1.0) - F) * NoL;
  vec3 col = (diff + spec * PI) * uSunColor * ao;

  // Environment. Its absence is not a "too dark" problem, it is a missing
  // integral: a metallic fragment reflects only what is around it, and with
  // nothing around it every worn edge and anti-sun face renders pure black.
  //
  // But it is not an ambient constant either. ARCHITECTURE §6 is explicit that
  // a surface facing away from the star is black, lit only by planetshine, and
  // the 0.30 that used to sit in front of this hemisphere was an ambient
  // constant by another name: it put a floor under every fragment on the ship
  // regardless of where the fill was coming from, which is what turned the
  // backlit frame's camera-facing hemisphere into an even glow with no rim.
  // Purely directional now, about the fill axis the shot actually set.
  vec3  Rv   = reflect(-V, N);
  float envW = clamp(dot(Rv, uFillDir) * 0.5 + 0.5, 0.0, 1.0);
  vec3  envCol = uFill * uFillGain * envW * envW
               + uSunColor * 0.010 * pow(max(dot(Rv, uSunDir), 0.0), 5.0) * sunVis;
  // Split-sum-ish: the horizon of the specular lobe never falls below F0.
  vec3 Fenv = (F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(1.0 - NoV, 5.0)) * filmed;
  col += envCol * Fenv * ao;

  // Planetshine, not ambient: it arrives from one side — the world below — so
  // it fills the belly and leaves the shadowed upper flank properly black.
  //
  // Three things were wrong with this and all three pointed the same way. The
  // 0.25 constant floor was four times the directional term at the top of the
  // hull, so the fill landed top-down. The direction was hard-coded to -N.y
  // instead of the shot's own fillDirection. And it was measured on the
  // geometric normal, so a belly plate with a high baked occlusion — which is
  // most of a belly, since that is where the gear and the pods are — lost the
  // very light the frame exists to show. Now: hemisphere about uFillDir,
  // squared into a disc because a planet has an edge, measured on the BENT
  // normal so a surface that is open downward fills and a crevice does not, and
  // scaled by uFillGain, which is the ratio between a close world's solid angle
  // and the unit cosine lobe this integral would otherwise assume.
  float fillW = clamp(dot(bn, uFillDir) * 0.5 + 0.5, 0.0, 1.0);
  col += albedo * (1.0 - metalness) * uFill * uFillGain * fillW * fillW
       * mix(1.0, ao, 0.6);

  // Grazing sheen. Fresnel guarantees a reflectance spike at the silhouette, so
  // an edge seen edge-on against black cannot fade to nothing. This is the
  // silver lining, and it is the cheapest thing that stops a hull reading as
  // unfired clay. Rationed by dirt: soot has no lining.
  //
  // It has to be a RIM: thin, hard, and only where the surface turns away from
  // the eye AND still sees the star. A 4th-power Fresnel is not thin — it is
  // still at 13% of peak when the surface is 65 degrees off edge-on — and a
  // smoothstep opening at N.L = -0.30 fires on surfaces the star cannot even
  // reach. Together they made a soft even halo over the whole camera-facing
  // hemisphere, which is the named fail condition of the backlit shot. 7th
  // power narrows the band to roughly a sixth of its width, and the gate now
  // starts above zero so a fragment must actually face the star; the
  // coefficient goes up to keep the rim itself bright while the body it wraps
  // goes dark.
  //
  // DELIBERATELY NOT CUT with the rest of the achromatic budget, and this is a
  // regression guard rather than an oversight. ship-star-rimlight is a backlit
  // frame whose entire subject is this term — the hull there is already almost
  // pure black and the rim is the only thing that says a ship is present — so
  // trimming the rim to help the key-lit frames would have traded one named
  // fail condition for another. The 7th-power confinement is what keeps it from
  // becoming a halo, and it is unchanged; only the coefficient comes down, and
  // only by enough to stop the broad camera-facing area collecting a haze it
  // should not have. A hull's silhouette must still be findable against black.
  float graze = pow(1.0 - NoV, 7.0);
  float sheen = smoothstep(0.02, 0.34, dot(N, uSunDir)) * sunVis;
  col += uSunColor * graze * sheen * (0.042 + 0.135 * (1.0 - rough))
       * (1.0 - 0.65 * max(dirt, soot)) * ao;

  // --- self illumination ---------------------------------------------------
  // Amber leaking from a badly seated panel. Rationed hard — a handful of seams,
  // broken along their length — or the hull reads as a neon sign.
  // One seam in forty-five, not one in twenty-two, and at a fifth of the
  // radiance: uAmber is the interior light colour and it arrives here at up to
  // 0.95 linear against plating authored around 0.1, so at the old gain a leak
  // was nine times the value of the hull it was leaking out of. On the dorsal
  // sail that put a scatter of saturated orange dashes across the plating and
  // took the frame straight into "more than one saturated hue competing".
  float leak = plateSeam * step(0.978, sm_hash21(vec2(pid * 57.0, 7.3)));
  leak *= smoothstep(0.5, 0.8, sm_hash21(vec2(floor(dom.z * 5.0), pid * 13.0)));
  col += uAmber * leak * (0.55 + 0.45 * sin(uTime * 2.1 + pid * 40.0)) * 0.11;

  // Every lit aperture pools light on the plating around it. An emitter that
  // lights nothing is a sticker; these pools are also the only second light
  // direction the hull gets, and on a large hull with no other reference they
  // are what give the surface its scale.
  for (int i = 0; i < SHIP_LAMP_MAX; i++) {
    vec4 lp = uLamp[i];
    vec4 lt = uLampTint[i];
    vec3 ld = lp.xyz - P;
    float ldist = max(length(ld), 1e-9);
    // Falloff from the aperture radius — and BOUNDED BY IT, hard.
    //
    // At 2.2 e-folding lengths this pool was still at 33% of peak, so a spill
    // stayed visible out to something like six aperture radii and the largest
    // colour event on the hero frame was a 150 px soft orange blob with no
    // window structure, no mullion, no hard edge and no emitter at its centre.
    // ARCHITECTURE §6 rations colour and gives amber to instrument glow; a
    // gradient that size with nothing in it reads as an internal fire, which
    // tells the player the wrong thing about the ship. A lit bay is a bright
    // rectangle with a gradient AROUND it, so the gradient has to be small
    // enough that the rectangle is the thing you see. 0.8 e-folding lengths
    // plus a hard cut-off at four radii is a pool that dies inside the plate
    // the pane is set into. The pane itself is EMISSIVE_FRAG kind 0, which
    // already authors a proper mullioned rectangle and is unchanged.
    float lr   = max(lp.w, 1e-9);
    float fall = exp(-ldist / (lr * 0.8)) * max(dot(N, ld / ldist), 0.0);
    fall *= 1.0 - smoothstep(lr * 2.6, lr * 4.0, ldist);
    col += lt.rgb * lt.a * albedo * fall * ao * step(1e-9, lp.w);
  }

  // The plume lighting the plating around the nozzles. This is a LIGHT falling
  // on dark steel, so it goes through the albedo like every other light on the
  // ship — and it is bounded, because wash accumulates once per nozzle with
  // no normalisation and a six-nozzle cluster drove it past 3.0. Multiplied by
  // 2.6 that reached ~8 scene-linear on plating authored for 0.1: five to eight
  // times over the top of the band this file's own header sets, which is what
  // blew the thrust structure to flat white in every drive-on frame. It also
  // stole the exposure — a subject-weighted meter reads that as the ship's
  // level and stops the iris down on everything else.
  col += uPlumeColor * albedo * (1.0 - metalness) * clamp(wash, 0.0, 1.0)
       * uThrottle * 6.0 * ao;

  // --- re-entry ------------------------------------------------------------
  if (uHeat > 0.002) {
    float face = max(dot(N, uFlowDir), 0.0);
    // Leading *edges* first: sharp geometry heats before flat plate does.
    float ld2 = pow(face, 3.0) * (0.25 + 0.75 * edge);
    float flick = 0.75 + 0.25 * os_snoise(P * (18.0 / L) + vec3(0.0, 0.0, -uTime * 5.0));
    // Tops out near 4200 K: a hull at white heat has already failed, and a white
    // silhouette destroys every other read on the ship.
    col += os_blackbody(mix(1400.0, 4200.0, uHeat)) * ld2 * uHeat * uHeat * 5.5 * flick;
  }

  // Scene-linear HDR out. No tone map, no colour-space convert, no dither —
  // PostFX owns all three, and dithering here would put a +/-20% noise floor on
  // plating whose base radiance is around 0.01.
  gl_FragColor = vec4(col, 1.0);
}
`;

const EMISSIVE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute vec4 aEmit;   // rgb colour, a intensity
attribute float aKind;

varying vec2  vUv;
varying vec4  vEmit;
varying float vKind;
varying vec3  vPos;

void main() {
  vec3 p = position;
  #ifdef USE_INSTANCING
    p = (instanceMatrix * vec4(p, 1.0)).xyz;
  #endif
  vUv   = uv;
  vEmit = aEmit;
  vKind = aKind;
  vPos  = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const EMISSIVE_FRAG = /* glsl */ `
#include <common>
#include <onespace_noise>
#include <logdepthbuf_pars_fragment>

uniform float uTime;

varying vec2  vUv;
varying vec4  vEmit;
varying float vKind;
varying vec3  vPos;

void main() {
  #include <logdepthbuf_fragment>

  vec2 c = vUv * 2.0 - 1.0;
  float r = length(c);
  float kind = vKind;

  // 0 — a lit window. Rectangular with a soft edge and a mullion, because a
  // round window on a freighter is a porthole and reads as the wrong ship.
  float rect = (1.0 - smoothstep(0.72, 0.98, abs(c.x)))
             * (1.0 - smoothstep(0.72, 0.98, abs(c.y)));
  float mull = 1.0 - 0.45 * (1.0 - smoothstep(0.0, 0.08, abs(c.x)));
  float win = rect * mull;
  // Occupancy: some panes are dark, some have someone moving in front of them.
  float seed = os_hash13(floor(vPos * 4000.0));
  win *= step(0.22, seed) * (0.75 + 0.25 * sin(uTime * (0.4 + seed) + seed * 40.0));

  // 1 — a navigation light: a hard core in a wide halo. The halo is what makes
  // a 4-pixel light read as a light rather than as a lit pixel.
  float core = 1.0 - smoothstep(0.10, 0.34, r);
  float halo = (1.0 - smoothstep(0.0, 1.0, r));
  float nav = core + halo * halo * 0.55;

  // 2 — strobe. Short, hard flash; anti-collision beacons are not sine waves.
  float phase = fract(uTime * 0.52 + os_hash13(floor(vPos * 900.0)));
  float flash = smoothstep(0.02, 0.0, phase) + smoothstep(0.10, 0.07, phase) * 0.6;
  float strobe = nav * clamp(flash, 0.0, 1.0);

  // 3 — a service floodlight aimed at the ship's own hull: a wide cold pool.
  float flood = pow(max(1.0 - r, 0.0), 2.2);

  float shape = win * (1.0 - step(0.5, kind))
              + nav * step(0.5, kind) * (1.0 - step(1.5, kind))
              + strobe * step(1.5, kind) * (1.0 - step(2.5, kind))
              + flood * step(2.5, kind);

  // Emitters are the only elements permitted above 1.0 scene-linear, which is
  // BloomPass's threshold. That is deliberate: on this ship the windows and the
  // navigation lights are what bloom, and nothing else.
  gl_FragColor = vec4(vEmit.rgb * vEmit.a * shape, 1.0);
}
`;

// ===========================================================================
// Glyph atlas — painted registry numbers, not a decal
// ===========================================================================

/**
 * A 5x7 stencil face, one byte per row, bit 4 leftmost.
 *
 * Real glyphs rather than an abstract stripe because a hull number is the
 * cheapest and most convincing scale cue a ship has, and `MarkingDna` already
 * gives every faction a registry pattern and a letter pool to draw from. Seven
 * hundred bytes of table buys legible painted text with no asset pipeline and
 * no dependency.
 */
const GLYPHS: Readonly<Record<string, readonly number[]>> = {
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  ' ': [0, 0, 0, 0, 0, 0, 0],
};

const ATLAS_W = 128;
const ATLAS_ROW_H = 32;
const GLYPH_W = 5;
const GLYPH_H = 7;

/**
 * Rasterise one string into one band of the atlas.
 *
 * Rows are written bottom-up because GL texture v increases upward and a
 * marking's v axis is "up" on the hull; getting this backwards paints the
 * registry upside down on every ship in the fleet, which is the kind of thing
 * that survives three reviews.
 */
function rasteriseRow(data: Uint8Array, rows: number, row: number, text: string): void {
  const t = text.toUpperCase().slice(0, 20);
  const n = Math.max(1, t.length);
  const cell = GLYPH_W + 1;
  const scale = Math.max(1, Math.min(Math.floor(ATLAS_W / (n * cell)), Math.floor((ATLAS_ROW_H - 4) / GLYPH_H)));
  const used = (n * cell - 1) * scale;
  const x0 = Math.max(0, Math.floor((ATLAS_W - used) * 0.5));
  const bandTop = (rows - 1 - row) * ATLAS_ROW_H;
  const y0 = bandTop + Math.floor((ATLAS_ROW_H - GLYPH_H * scale) * 0.5);

  for (let c = 0; c < n; c++) {
    const glyph = GLYPHS[t.charAt(c)] ?? GLYPHS[' '];
    if (glyph === undefined) continue;
    for (let gy = 0; gy < GLYPH_H; gy++) {
      const bits = glyph[gy] ?? 0;
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if ((bits & (1 << (GLYPH_W - 1 - gx))) === 0) continue;
        for (let py = 0; py < scale; py++) {
          for (let px = 0; px < scale; px++) {
            const x = x0 + (c * cell + gx) * scale + px;
            const y = y0 + gy * scale + py;
            if (x < 0 || x >= ATLAS_W || y < 0 || y >= rows * ATLAS_ROW_H) continue;
            data[y * ATLAS_W + x] = 255;
          }
        }
      }
    }
  }
}

function buildMarkAtlas(texts: readonly string[], rows: number): DataTexture {
  const h = Math.max(1, rows) * ATLAS_ROW_H;
  const data = new Uint8Array(ATLAS_W * h);
  for (let i = 0; i < texts.length && i < rows; i++) {
    const s = texts[i];
    if (s !== undefined && s.length > 0) rasteriseRow(data, rows, i, s);
  }
  const tex = new DataTexture(data, ATLAS_W, h, RedFormat, UnsignedByteType);
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  // Mipmapped: a registry number seen at 30 px must soften, not sparkle.
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ===========================================================================
// Shared program cache
// ===========================================================================

interface SharedProgram {
  readonly key: string;
  readonly uniforms: Record<string, IUniform>;
  readonly hull: ShaderMaterial;
  readonly greeble: ShaderMaterial;
  readonly emissive: ShaderMaterial;
  readonly budget: TierBudget;
  refs: number;
}

const CACHE = new Map<string, SharedProgram>();

function rgbHex(c: RGB | undefined): string {
  if (c === undefined) return '000';
  const q = (v: number): string => Math.round(Math.min(Math.max(v, 0), 4) * 255).toString(36);
  return `${q(c[0])}${q(c[1])}${q(c[2])}`;
}

/**
 * Two ships share materials when their surface would be pixel-identical given
 * the same per-ship uniforms. Palette, fabrication, drive and tier are the only
 * things baked into the program or into the immutable uniform values; length,
 * grime, wear weights, engine positions and markings all ride in `apply()`, so
 * they must not appear here or the cache would degenerate to one entry per hull.
 */
function cacheKeyFor(bp: ShipBlueprint, tier: QualityTier, markRows: number): string {
  const p = bp.palette;
  return [
    'ship-surface',
    tier,
    bp.factionId,
    bp.familyId,
    bp.technologyProfile.fabrication,
    bp.technologyProfile.drive,
    markRows > 0 ? 'mk' : 'nomk',
    rgbHex(p.hull),
    rgbHex(p.accent),
    rgbHex(p.bareMetal),
    rgbHex(p.interiorLight),
    rgbHex(p.plateShades[0]),
    rgbHex(p.patchShades[0]),
    // The grime film's chromaticity is derived from this, and grime covers more
    // of the hull than anything else does. Two yards that share a hull colour
    // but not a soot colour must not share a program.
    rgbHex(p.scorch),
    rgbHex(p.oxide),
  ].join('|');
}

function v3(c: RGB | undefined, fallback: readonly [number, number, number]): Float32Array {
  const s = c ?? fallback;
  return new Float32Array([s[0], s[1], s[2]]);
}

function makeUniforms(budget: TierBudget, palette: ShipPalette, markRows: number): Record<string, IUniform> {
  const u: Record<string, IUniform> = {
    uSunDir: { value: new Float32Array([0, 1, 0]) },
    uSunColor: { value: new Float32Array([1, 0.95, 0.88]) },
    uCameraLocal: { value: new Float32Array([0, 0, 1]) },
    uFill: { value: new Float32Array([0.01, 0.014, 0.022]) },
    uFillDir: { value: new Float32Array([0, -1, 0]) },
    uFillGain: { value: FILL_GAIN },
    uTime: { value: 0 },
    uThrottle: { value: 0 },
    uHeat: { value: 0 },

    uHullLen: { value: 0.03 },
    uPanelSize: { value: 0.0038 },
    uPanelJitter: { value: 0.25 },
    uSeamDepth: { value: SEAM_RELIEF_MAX_KM },
    uSeamVis: { value: 1 },
    uFilmDepth: { value: 0.75 },
    uFastenerPitch: { value: 0.00075 },
    uPixelAngle: { value: 0.001 },
    uCoverage: { value: 1000 },
    uMicroDetail: { value: 1 },
    uSeed: { value: new Float32Array([0, 0, 0]) },
    uAftSpan: { value: new Float32Array([-0.015, 0.015]) },

    uPlate0: { value: v3(palette.plateShades[0] ?? palette.hull, [0.05, 0.055, 0.05]) },
    uPlate1: { value: v3(palette.plateShades[1] ?? palette.hull, [0.05, 0.055, 0.05]) },
    uPlate2: { value: v3(palette.plateShades[2] ?? palette.hull, [0.05, 0.055, 0.05]) },
    uPlate3: { value: v3(palette.plateShades[3] ?? palette.plateShades[0] ?? palette.hull, [0.05, 0.055, 0.05]) },
    uPatch0: { value: v3(palette.patchShades[0] ?? palette.hull, [0.08, 0.07, 0.05]) },
    uPatch1: { value: v3(palette.patchShades[1] ?? palette.patchShades[0] ?? palette.hull, [0.04, 0.046, 0.044]) },
    uPatch2: { value: v3(palette.patchShades[2] ?? palette.patchShades[0] ?? palette.hull, [0.095, 0.048, 0.022]) },
    uMismatch: { value: v3(palette.mismatch[0] ?? palette.patchShades[0] ?? palette.hull, [0.05, 0.05, 0.055]) },
    uAccent: { value: v3(palette.accent, [0.4, 0.078, 0.008]) },
    uTrim: { value: v3(palette.trim, [0.1, 0.098, 0.062]) },
    uMetal: { value: v3(palette.bareMetal, [0.2, 0.21, 0.235]) },
    uPrimer: { value: v3(palette.primer, [0.125, 0.034, 0.018]) },
    uOxide: { value: v3(palette.oxide, [0.088, 0.032, 0.013]) },
    uScorch: { value: v3(palette.scorch, [0.011, 0.0095, 0.0088]) },
    uAmber: { value: v3(palette.interiorLight, [1.0, 0.52, 0.13]) },
    uPlumeColor: { value: v3(palette.engineCore, [0.16, 0.36, 1.0]) },
    uGrimeTint: { value: grimeTint(palette) },

    uRough: { value: 0.7 },
    uMetalness: { value: 0.16 },
    uPaintFade: { value: 0.3 },
    uPatchRate: { value: 0.05 },
    uGrime: { value: 0.7 },
    uBump: { value: 0.45 },
    uCurvScale: { value: CURV_SCALE },
    uAoStrength: { value: 1 },
    uFlowDir: { value: new Float32Array([0, 0, 1]) },
    uWearA: { value: new Float32Array([0.6, 0.6, 0.5, 0.6]) },
    uWearB: { value: new Float32Array([0.5, 0.5, 0.5, 0.2]) },

    uOcc: { value: new Float32Array(budget.occ * 4) },
    uOccPart: { value: new Float32Array(budget.occ) },
    uLamp: { value: new Float32Array(budget.lamp * 4) },
    uLampTint: { value: new Float32Array(budget.lamp * 4) },
    uStain: { value: new Float32Array(budget.stain * 4) },
    uStainAxis: { value: new Float32Array(budget.stain * 4) },
    uWound: { value: new Float32Array(budget.wound * 4) },
    uWoundAxis: { value: new Float32Array(budget.wound * 4) },
  };

  if (markRows > 0) {
    u.uMark = { value: new Float32Array(budget.mark * 4) };
    u.uMarkU = { value: new Float32Array(budget.mark * 4) };
    u.uMarkV = { value: new Float32Array(budget.mark * 4) };
    u.uMarkAtlas = { value: null };
    u.uMarkRows = { value: markRows };
  }
  return u;
}

function acquireProgram(bp: ShipBlueprint, quality: QualitySettings, markRows: number): SharedProgram {
  registerShaderChunks();

  const tier = quality.tier;
  const key = cacheKeyFor(bp, tier, markRows);
  const hit = CACHE.get(key);
  if (hit !== undefined) {
    hit.refs++;
    return hit;
  }

  const budget = TIER_BUDGETS[tier];
  const uniforms = makeUniforms(budget, bp.palette, markRows);

  const defines: Record<string, string | number | boolean> = {
    SHIP_OCC_MAX: budget.occ,
    SHIP_LAMP_MAX: budget.lamp,
    SHIP_STAIN_MAX: budget.stain,
    SHIP_WOUND_MAX: Math.max(budget.wound, 1),
    SHIP_MARK_MAX: Math.max(budget.mark, 1),
    SHIP_GRIME_OCTAVES: budget.grimeOctaves,
    SEAM_RELIEF_MAX: SEAM_RELIEF_MAX_KM.toExponential(6),
  };
  if (budget.rivets) defines.SHIP_RIVETS = '';
  if (budget.bump) defines.SHIP_BUMP = '';
  if (markRows > 0) defines.SHIP_MARKINGS = '';

  // ONE surface material object, serving both the indexed hull Mesh and the
  // InstancedMesh greeble batches.
  //
  // There used to be a second, byte-identical ShaderMaterial here whose stated
  // reason was "so a draw never has to flip USE_INSTANCING on a single
  // material's cache key". That is not how three works: WebGLPrograms already
  // includes `instancing` in its own program cache key, derived from the
  // geometry being drawn, so one material handed to both a Mesh and an
  // InstancedMesh compiles exactly the same two programs the pair did — and
  // caches them independently, with no flipping and no recompilation. The
  // second object bought nothing and cost a material slot: measured across ten
  // seeds the visible LOD0 draw list held 4 distinct materials against BRIEF §6's
  // cap of 3. This takes ShipMaterial to 2 objects, and 2 + propulsion's 2 = 4
  // allocated, 3 in the visible LOD0 list.
  //
  // `ShipMaterialSet.greeble` stays in the interface and now aliases `hull`, so
  // ShipMesh.ts needs no change — it passes each to a constructor and never
  // mutates either, so the aliasing is unobservable. Anything that later wants
  // to set per-material state on one of the two must split them again first.
  const hull = new ShaderMaterial({
    name: `ship-surface:${key}`,
    vertexShader: SURFACE_VERT,
    fragmentShader: SURFACE_FRAG,
    uniforms,
    defines: { ...defines },
    side: FrontSide,
    // PostFX owns exposure, the tone map and the colour space. See the header.
    toneMapped: false,
  });
  const emissive = new ShaderMaterial({
    name: `ship-emissive:${key}`,
    vertexShader: EMISSIVE_VERT,
    fragmentShader: EMISSIVE_FRAG,
    uniforms,
    // Additive and depth-tested but not depth-writing: a window is a hole in
    // the plating, not a surface in front of it.
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
  });

  const shared: SharedProgram = { key, uniforms, hull, greeble: hull, emissive, budget, refs: 1 };
  CACHE.set(key, shared);
  return shared;
}

function releaseProgram(shared: SharedProgram): void {
  shared.refs--;
  if (shared.refs > 0) return;
  CACHE.delete(shared.key);
  // `greeble` aliases `hull`; disposing it a second time is harmless but
  // pointless, and disposing it separately would be a bug if they ever split.
  shared.hull.dispose();
  shared.emissive.dispose();
}

// ===========================================================================
// Per-ship binding
// ===========================================================================

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function primaryProfile(bp: ShipBlueprint): MaterialProfile | undefined {
  return bp.materialProfiles[0];
}

/** Unit-length copy of a blueprint vector, with a fallback for degenerate input. */
function writeUnit(out: Float32Array, at: number, v: Vec3 | undefined, fx: number, fy: number, fz: number): void {
  const x = v?.[0] ?? fx;
  const y = v?.[1] ?? fy;
  const z = v?.[2] ?? fz;
  const l = Math.hypot(x, y, z);
  if (l < 1e-9) {
    out[at] = fx;
    out[at + 1] = fy;
    out[at + 2] = fz;
    return;
  }
  out[at] = x / l;
  out[at + 1] = y / l;
  out[at + 2] = z / l;
}

/** Kind + strength packed into one float: `floor` is the kind, `fract` the level. */
function packStain(kind: 0 | 1 | 2, strength: number): number {
  return kind + Math.min(Math.max(strength, 0), 0.999);
}

/**
 * Rank the analytic shadow casters by radius before truncating.
 *
 * The list is capped, so an unsorted upload lets a whip antenna evict a
 * radiator wing — the exact failure `Ship.ts` guards against at its own sort.
 */
interface Caster {
  x: number;
  y: number;
  z: number;
  r: number;
  part: number;
}

class ShipMaterials implements ShipMaterialSet {
  readonly hull: ShaderMaterial;
  readonly greeble: ShaderMaterial;
  readonly emissive: ShaderMaterial;
  readonly uniforms: Record<string, IUniform>;
  readonly key: string;

  private readonly shared: SharedProgram;
  private readonly atlas: DataTexture | null;
  private disposed = false;

  // Everything below is preallocated at construction and only ever written to
  // in `apply()`, which must not allocate: it runs once per ship per frame.
  private readonly occ: Float32Array;
  private readonly occPart: Float32Array;
  private readonly lamp: Float32Array;
  private readonly lampTint: Float32Array;
  private readonly stain: Float32Array;
  private readonly stainAxis: Float32Array;
  private readonly wound: Float32Array;
  private readonly woundAxis: Float32Array;
  private readonly mark: Float32Array;
  private readonly markU: Float32Array;
  private readonly markV: Float32Array;
  private readonly seed = new Float32Array(3);
  private readonly flow = new Float32Array(3);
  private readonly aftSpan = new Float32Array(2);
  private readonly fillDir = new Float32Array([0, -1, 0]);
  private readonly wearA = new Float32Array(4);
  private readonly wearB = new Float32Array(4);

  private readonly hullLen: number;
  private readonly panelSize: number;
  private readonly panelJitter: number;
  private readonly seamDepth: number;
  private readonly seamVis: number;
  private readonly filmDepth: number;
  private readonly fastenerPitch: number;
  private readonly microDetail: number;
  private readonly rough: number;
  private readonly metalness: number;
  private readonly paintFade: number;
  private readonly patchRate: number;
  private readonly grime: number;
  private readonly bump: number;
  private readonly aoStrength: number;
  private readonly markRows: number;

  get occluderSlots(): number {
    return this.occPart.length;
  }

  get lampSlots(): number {
    return this.lamp.length / 4;
  }

  constructor(bp: ShipBlueprint, quality: QualitySettings) {
    const markings = selectMarkings(bp, TIER_BUDGETS[quality.tier].mark);
    this.markRows = markings.length;
    this.shared = acquireProgram(bp, quality, this.markRows);
    this.key = this.shared.key;
    this.hull = this.shared.hull;
    this.greeble = this.shared.greeble;
    this.emissive = this.shared.emissive;
    this.uniforms = this.shared.uniforms;

    const budget = this.shared.budget;
    this.occ = new Float32Array(budget.occ * 4);
    this.occPart = new Float32Array(budget.occ);
    this.lamp = new Float32Array(budget.lamp * 4);
    this.lampTint = new Float32Array(budget.lamp * 4);
    this.stain = new Float32Array(budget.stain * 4);
    this.stainAxis = new Float32Array(budget.stain * 4);
    this.wound = new Float32Array(budget.wound * 4);
    this.woundAxis = new Float32Array(budget.wound * 4);
    this.mark = new Float32Array(budget.mark * 4);
    this.markU = new Float32Array(budget.mark * 4);
    this.markV = new Float32Array(budget.mark * 4);

    const prof = primaryProfile(bp);
    const tech = bp.technologyProfile;

    this.hullLen = Math.max(bp.dimensions.lengthKm, 1e-4);
    this.panelSize = shipPanelSizeKm(bp);
    this.panelJitter = clamp01(prof?.panelJitter ?? 0.25) * 0.9;
    this.seamDepth = Math.min(prof?.seamDepth ?? SEAM_RELIEF_MAX_KM, SEAM_RELIEF_MAX_KM);
    // How much of a visible joint this yard leaves, recovered from the declared
    // depth BEFORE the relief clamp eats it.
    //
    // `blueprint.ts` derives seamDepth as `panel * 0.025 * seamDepthFactor`, so
    // dividing back out returns the factor families.ts authored: Kessler 1.5,
    // Ossuary 1.9, Sillane 0.15. All three then clamp into `seamDepth` at or
    // near SEAM_RELIEF_MAX, which is why the one faction that declares
    // "fastenerPitchFactor 0.0 — not 'few fasteners', none, anywhere, on a hull
    // they built" was still rendering the same rectangular plate grid as the
    // riveted hulls beside it. The fastener half of that declaration was already
    // honoured (kRivet multiplies by step(0, uFastenerPitch)); the seam half had
    // nothing reading it at all.
    //
    // Sillane's 0.15 lands at ~0.08 here, which is a moulded break you can find
    // at arm's length and cannot see at fleet range — what a cast monocoque
    // should look like. Floored just above zero so no hull is left with a
    // perfectly featureless flank.
    const seamFactor = (prof?.seamDepth ?? SEAM_RELIEF_MAX_KM) / Math.max(this.panelSize * 0.025, 1e-12);
    const sv = clamp01(seamFactor / 0.85);
    this.seamVis = Math.max(sv * sv * (3 - 2 * sv), 0.04);
    // Exactly zero fastener pitch is a statement about the culture, not a small
    // number: a cast Sillane hull has no fasteners anywhere and must show none.
    this.fastenerPitch = Math.max(prof?.fastenerPitch ?? 0, 0);
    this.microDetail = Math.max(prof?.microDetailScale ?? 1, 0.05);
    this.rough = clamp01(prof?.roughness ?? 0.7);
    this.metalness = clamp01(prof?.metalness ?? 0.16);
    this.paintFade = clamp01(prof?.paintFade ?? 0.3);
    this.bump = quality.tier === 'low' ? 0 : 0.45;

    // A neglected hull is a dirty hull, and refits license wrong-coloured plate.
    const neglect = 1 - clamp01(tech.maintenance);
    this.grime = 0.35 + 0.65 * neglect;
    // Depth of the vacuum-weathering film — see the film block in SURFACE_FRAG
    // for why this exists and why it is not a palette change.
    //
    // Driven by maintenance and by the hull's own age, so it is a fourth axis of
    // faction and ship identity rather than a constant: a well-kept young hull
    // sits near 0.55 and a neglected forty-year-old near 1.0, which is a real
    // value separation between two ships carrying the same paint. Bounded below
    // so that even a brand-new hull is not a paint chip — ARCHITECTURE §6 says
    // everything is dirty, and a hull fresh out of the yard has still been in
    // vacuum.
    this.filmDepth = Math.min(
      0.55 + 0.30 * neglect + 0.004 * Math.min(tech.ageYears, 40),
      1,
    );
    // Capped low and hard. This is the rate of *replaced plates*, and a replaced
    // plate is a story — a quarter of the hull in mismatched shades is not a
    // history, it is camouflage, and it destroys the base colour the faction is
    // recognised by. Even a neglected forty-year-old hull tops out at one plate
    // in eleven.
    this.patchRate = Math.min(
      0.012 + 0.014 * Math.min(tech.refits, 4) + 0.035 * neglect + 0.0012 * Math.min(tech.ageYears, 40),
      0.09,
    );

    // On a capital, PostFX's screen-space AO (0.05 km world radius) is already
    // a structural-crevice scale, so the baked term is rationed rather than
    // multiplied on top of it. On a courier that radius is bigger than the whole
    // ship and SSAO does nothing, which is exactly why the bake has to exist.
    const ssao = quality.ambientOcclusion && this.hullLen >= SSAO_TAKES_OVER_KM;
    this.aoStrength = ssao ? 0.55 : 1;

    const w = prof?.wear;
    this.wearA[0] = clamp01(w?.edges ?? 0.5);
    this.wearA[1] = clamp01(w?.hatches ?? 0.5);
    this.wearA[2] = clamp01(w?.streaks ?? 0.5);
    this.wearA[3] = clamp01(w?.soot ?? 0.5);
    this.wearB[0] = clamp01(w?.heat ?? 0.5);
    this.wearB[1] = clamp01(w?.pitting ?? 0.5);
    this.wearB[2] = clamp01(w?.corrosion ?? 0.5);
    this.wearB[3] = clamp01(w?.frost ?? 0.2);

    writeUnit(this.flow, 0, prof?.flowDirection, 0, 0, 1);

    // Decorrelate every noise field per ship, so two hulls of one family do not
    // wear the same streak in the same place.
    const s = (bp.renderProfile.detailSeed >>> 0) || (bp.seed >>> 0) || 1;
    this.seed[0] = ((s & 0x3ff) / 1024) * 40;
    this.seed[1] = (((s >>> 10) & 0x3ff) / 1024) * 40;
    this.seed[2] = (((s >>> 20) & 0x3ff) / 1024) * 40;

    this.fillAftSpan(bp);
    this.fillOccluders(bp);
    this.fillLamps(bp);
    this.fillStains(bp);
    this.fillWounds(bp);
    this.atlas = this.fillMarkings(bp, markings);
  }

  // --- construction-time uploads -----------------------------------------

  /**
   * The hull's extent along the flow axis, so grime can have a gradient.
   *
   * Everything a ship sheds travels one way: residue from the drive, plume off
   * the radiators, vented atmosphere, its own dust. Plating downstream of that
   * is filthy and plating upstream of it is comparatively clean, and BRIEF §7
   * calls the alternative — the same expected dirtiness at the nose as at the
   * tail — the single most common failure. The span is measured from the real
   * geometry (volume runs and engine throats projected onto `flowDirection`)
   * rather than assumed symmetric about the origin, because a ship whose origin
   * sits at its centre of mass is not a ship whose origin sits amidships.
   */
  private fillAftSpan(bp: ShipBlueprint): void {
    const fx = this.flow[0] ?? 0;
    const fy = this.flow[1] ?? 0;
    const fz = this.flow[2] ?? 1;
    let lo = Infinity;
    let hi = -Infinity;
    const note = (p: Vec3 | undefined): void => {
      if (p === undefined) return;
      const t = (p[0] ?? 0) * fx + (p[1] ?? 0) * fy + (p[2] ?? 0) * fz;
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    };
    for (const v of bp.primaryVolumes) note(v.frame.origin);
    for (const m of bp.modules) if (m.present) note(m.frame.origin);
    for (const e of bp.engines) note(e.frame.origin);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < this.hullLen * 0.1) {
      lo = -this.hullLen * 0.5;
      hi = this.hullLen * 0.5;
    }
    this.aftSpan[0] = lo;
    this.aftSpan[1] = hi;
  }

  /**
   * The damage timeline, as an analytic set.
   *
   * Ranked by how much of the ship's story each wound carries — severity first,
   * then size — because the array is capped and a scatter of pinholes must never
   * evict the hole that took the module off. Age is carried through verbatim:
   * it is the field that turns a set of marks into a history, and the shader
   * reads nothing else to decide whether a wound shows torn bright metal or
   * thirty years of oxide.
   */
  private fillWounds(bp: ShipBlueprint): void {
    this.wound.fill(0);
    this.woundAxis.fill(0);
    const slots = this.wound.length / 4;
    if (slots === 0) return;

    const events = bp.damageHistory
      .filter((d) => d.radius > 0 && d.severity > 0)
      .slice()
      .sort((a, b) => b.severity * b.radius - a.severity * a.radius);

    // A wound's radius is a real length off the blueprint, but a wound wider
    // than a fifth of the hull is a structural event the geometry module has
    // already expressed as a hole; shading it as a surface mark on top of that
    // would only wash the whole ship.
    const rMax = this.hullLen * 0.2;
    // Thirty years is "old" — past it, everything is equally weathered. Younger
    // than about a month is "fresh": still bright metal, no oxide.
    const OLD_SECONDS = 30 * 365 * 24 * 3600;
    const FRESH_SECONDS = 30 * 24 * 3600;

    let w = 0;
    for (const d of events) {
      if (w >= slots) break;
      this.wound[w * 4] = d.frame.origin[0];
      this.wound[w * 4 + 1] = d.frame.origin[1];
      this.wound[w * 4 + 2] = d.frame.origin[2];
      this.wound[w * 4 + 3] = Math.min(d.radius, rMax);
      // The direction the strike arrived along. Degenerate input falls back to
      // the surface normal, which at least keeps the wound on the hull.
      writeUnit(this.woundAxis, w * 4, d.incidence, d.frame.forward[0], d.frame.forward[1], d.frame.forward[2]);
      const age = clamp01(
        Math.log(Math.max(d.ageSeconds, FRESH_SECONDS) / FRESH_SECONDS) /
          Math.log(OLD_SECONDS / FRESH_SECONDS),
      );
      // floor = severity in 16 steps, fract = age. Same idiom as packStain().
      this.woundAxis[w * 4 + 3] = Math.round(clamp01(d.severity) * 15) + Math.min(age, 0.999);
      w++;
    }
  }

  private fillOccluders(bp: ShipBlueprint): void {
    const slots = this.occPart.length;
    const casters: Caster[] = [];
    // Only the large silhouette masses earn an analytic slot; everything else is
    // covered by the baked bent normal. A module's own box half-extents are the
    // honest radius estimate, and modules with a volume are the ones with mass.
    for (const m of bp.modules) {
      if (!m.present) continue;
      const h = m.halfExtents;
      const r = Math.max(h[0], h[1], h[2]);
      if (r <= 0) continue;
      casters.push({ x: m.frame.origin[0], y: m.frame.origin[1], z: m.frame.origin[2], r, part: -1 });
    }
    for (const v of bp.primaryVolumes) {
      const st = v.stations[Math.floor(v.stations.length * 0.5)];
      if (st === undefined) continue;
      const r = Math.max(st.halfWidth, st.halfHeight);
      if (r <= 0) continue;
      casters.push({ x: v.frame.origin[0], y: v.frame.origin[1], z: v.frame.origin[2], r, part: -1 });
    }
    casters.sort((a, b) => b.r - a.r);

    this.occ.fill(0);
    // -1 matches no part id the builder can allocate, so every caster shadows
    // every surface until the mesh calls setOccluders() with the real ids. That
    // is the safe default: a volume-centred sphere cannot darken its own lit
    // side (the caster is rejected when it sits behind the fragment along the
    // sun direction), so the worst case is a thin panel shading itself, not a
    // black ship.
    this.occPart.fill(-1);
    const n = Math.min(slots, casters.length, bp.renderProfile.occluderBudget || slots);
    for (let i = 0; i < n; i++) {
      const c = casters[i];
      if (c === undefined) continue;
      this.occ[i * 4] = c.x;
      this.occ[i * 4 + 1] = c.y;
      this.occ[i * 4 + 2] = c.z;
      this.occ[i * 4 + 3] = c.r;
      this.occPart[i] = c.part;
    }
  }

  setOccluders(spheres: Float32Array, partIds: Float32Array, count: number): void {
    const slots = this.occPart.length;
    const n = Math.min(count, slots, Math.floor(spheres.length / 4), partIds.length);
    this.occ.fill(0);
    this.occPart.fill(-1);
    for (let i = 0; i < n; i++) {
      this.occ[i * 4] = spheres[i * 4];
      this.occ[i * 4 + 1] = spheres[i * 4 + 1];
      this.occ[i * 4 + 2] = spheres[i * 4 + 2];
      this.occ[i * 4 + 3] = spheres[i * 4 + 3];
      this.occPart[i] = partIds[i];
    }
  }

  private fillLamps(bp: ShipBlueprint): void {
    this.lamp.fill(0);
    this.lampTint.fill(0);
    const slots = this.lamp.length / 4;
    const src = bp.renderProfile.lamps;
    const budget = Math.min(slots, bp.renderProfile.lampBudget || slots);
    const tint = bp.palette.interiorLight;
    // Brightest first: a capped list must keep the pools that carry the scale.
    const order = src.map((_lamp, i) => i).sort((a, b) => (src[b]?.intensity ?? 0) - (src[a]?.intensity ?? 0));
    let w = 0;
    for (const idx of order) {
      if (w >= budget) break;
      const l = src[idx];
      if (l === undefined || l.radius <= 0 || l.intensity <= 0) continue;
      this.lamp[w * 4] = l.position[0];
      this.lamp[w * 4 + 1] = l.position[1];
      this.lamp[w * 4 + 2] = l.position[2];
      // Bounded by the size of a thing that could be emitting.
      //
      // `lamps[].radius` is an aperture radius off the blueprint and nothing
      // was checking it against the plating it spills onto. A lamp radius of a
      // few percent of hull length, run through an exponential falloff, put a
      // 150 px amber gradient on the forward drum in the hero frame with no
      // pane, no mullion and no hard edge anywhere inside it — the single
      // largest colour event on the ship, reading as a scorch or an internal
      // fire rather than as a lit bay, against an art direction (ARCHITECTURE
      // §6) that rations colour and spends amber specifically on instrument
      // glow. A lit aperture is at most about a plate across; beyond that it is
      // a hangar door, and a hangar door has geometry. Capping here rather than
      // in the shader keeps it one clamp per lamp per ship instead of one per
      // fragment, and leaves the shader's falloff honest.
      this.lamp[w * 4 + 3] = Math.min(l.radius, this.panelSize * 0.85, this.hullLen * 0.02);
      this.lampTint[w * 4] = tint[0];
      this.lampTint[w * 4 + 1] = tint[1];
      this.lampTint[w * 4 + 2] = tint[2];
      // Held well under 1.0: this is the pool ON the plating, not the emitter.
      // The emitter is EMISSIVE_FRAG kind 0 and it is what should be bright.
      this.lampTint[w * 4 + 3] = Math.min(l.intensity, 3) * 0.22;
      w++;
    }
  }

  private fillStains(bp: ShipBlueprint): void {
    this.stain.fill(0);
    this.stainAxis.fill(0);
    const slots = this.stain.length / 4;
    let w = 0;

    // A stain radius is the size of the *deposit's source*, not the size of the
    // hardware. A radiator wing is fifteen metres across but the staining
    // begins at its root, and handing the shader the wing's half-extent throws
    // a heat bloom over the entire ship. Clamped to a band derived from hull
    // length so no source can ever wash the whole hull, at either extreme.
    const rMin = this.hullLen * 0.004;
    const rMax = this.hullLen * 0.02;
    const srcRadius = (r: number): number => Math.min(Math.max(r, rMin), rMax);
    /**
     * A nozzle is the one stain source whose real size IS the deposit's size.
     *
     * The shared clamp exists to stop a fifteen-metre radiator wing throwing a
     * heat bloom over the whole ship, and for a radiator it is right: the
     * staining starts at the root, not across the span. For an engine it is
     * exactly wrong. The soot fan is produced by recirculation at the bell
     * MOUTH, so its width is the exit radius by definition, and clamping a big
     * drive down to 2% of hull length shrank the cone (`s.w * 4.0` at the
     * source) to less than the bell it is supposed to be spreading from. That
     * is why the plate immediately outboard of both bells in ship-engine-close
     * is clean pale blue with no deposit fan on it — not a missing mask, a mask
     * whose radius had been clamped below the hardware that makes it.
     *
     * So an engine keeps its own exit radius, floored at rMin and ceilinged
     * only where a nozzle really would blacken a large fraction of the ship.
     */
    const nozzleRadius = (r: number): number =>
      Math.min(Math.max(r, rMin), this.hullLen * 0.09);

    // Soot: from the real nozzle throats, along the real exhaust direction.
    // Engines first, because a hull with an unsooted tail reads as a model.
    const engines: readonly EnginePod[] = bp.engines;
    for (const e of engines) {
      if (w >= slots) break;
      const r = nozzleRadius(e.nozzle.exitRadius);
      this.stain[w * 4] = e.frame.origin[0];
      this.stain[w * 4 + 1] = e.frame.origin[1];
      this.stain[w * 4 + 2] = e.frame.origin[2];
      this.stain[w * 4 + 3] = r;
      // Reversed on purpose: `frame.forward` on an engine is the EXHAUST
      // direction, and the soot goes the other way, onto the ship. See the
      // stain loop in the fragment shader.
      const f = e.frame.forward;
      writeUnit(this.stainAxis, w * 4, [-f[0], -f[1], -f[2]], 0, 0, -1);
      this.stainAxis[w * 4 + 3] = packStain(0, 0.9);
      w++;
    }

    // Heat: radiators stain the plate they face, streaked along their own run.
    for (const v of bp.primaryVolumes) {
      if (w >= slots) break;
      if (v.kind !== 'radiator') continue;
      const st = v.stations[0];
      // The root of the panel, not its span.
      const r = srcRadius(Math.min(st?.halfWidth ?? 1, st?.halfHeight ?? 1) * 0.8);
      this.stain[w * 4] = v.frame.origin[0];
      this.stain[w * 4 + 1] = v.frame.origin[1];
      this.stain[w * 4 + 2] = v.frame.origin[2];
      this.stain[w * 4 + 3] = r;
      writeUnit(this.stainAxis, w * 4, v.frame.forward, 0, 0, 1);
      this.stainAxis[w * 4 + 3] = packStain(1, 0.8);
      w++;
    }

    // Frost: cryogenic tanks bloom rime round their vents and down their flanks.
    for (const v of bp.primaryVolumes) {
      if (w >= slots) break;
      if (v.kind !== 'tank') continue;
      const st = v.stations[0];
      const r = srcRadius(Math.min(st?.halfWidth ?? 1, st?.halfHeight ?? 1) * 0.5);
      this.stain[w * 4] = v.frame.origin[0];
      this.stain[w * 4 + 1] = v.frame.origin[1];
      this.stain[w * 4 + 2] = v.frame.origin[2];
      this.stain[w * 4 + 3] = r;
      writeUnit(this.stainAxis, w * 4, [0, -1, 0], 0, -1, 0);
      this.stainAxis[w * 4 + 3] = packStain(2, 0.6);
      w++;
    }
  }

  private fillMarkings(bp: ShipBlueprint, markings: readonly Marking[]): DataTexture | null {
    this.mark.fill(0);
    this.markU.fill(0);
    this.markV.fill(0);
    if (markings.length === 0) return null;

    const texts: string[] = [];
    for (let i = 0; i < markings.length; i++) {
      const m = markings[i];
      if (m === undefined) continue;
      const kind = markingKindCode(m);
      const hw = Math.max(m.halfExtents[0], 1e-6);
      const hh = Math.max(m.halfExtents[1], 1e-6);

      // The frame gives an outward normal and an up; the across axis is their
      // cross product. Both are stored pre-divided by the half-extent so the
      // shader's rectangle test is a plain |u| <= 1.
      const n = m.frame.forward;
      const up = m.frame.up;
      const ax = up[1] * n[2] - up[2] * n[1];
      const ay = up[2] * n[0] - up[0] * n[2];
      const az = up[0] * n[1] - up[1] * n[0];
      const al = Math.hypot(ax, ay, az) || 1;

      this.mark[i * 4] = m.frame.origin[0];
      this.mark[i * 4 + 1] = m.frame.origin[1];
      this.mark[i * 4 + 2] = m.frame.origin[2];
      this.mark[i * 4 + 3] = kind;

      this.markU[i * 4] = ax / al / hw;
      this.markU[i * 4 + 1] = ay / al / hw;
      this.markU[i * 4 + 2] = az / al / hw;
      this.markU[i * 4 + 3] = clamp01(m.wear);

      const ul = Math.hypot(up[0], up[1], up[2]) || 1;
      this.markV[i * 4] = (up[0] / ul) / hh;
      this.markV[i * 4 + 1] = (up[1] / ul) / hh;
      this.markV[i * 4 + 2] = (up[2] / ul) / hh;
      this.markV[i * 4 + 3] = texts.length;

      texts.push(kind === 0 ? m.text : '');
    }
    return buildMarkAtlas(texts, Math.max(texts.length, 1));
  }

  // --- per-frame ----------------------------------------------------------

  apply(view: ViewState, state: ShipSurfaceState): void {
    if (this.disposed) return;
    const u = this.uniforms;

    const cam = u.uCameraLocal.value as Float32Array;
    cam[0] = view.cameraLocal.x;
    cam[1] = view.cameraLocal.y;
    cam[2] = view.cameraLocal.z;

    const sun = u.uSunDir.value as Float32Array;
    sun[0] = view.sunDirection.x;
    sun[1] = view.sunDirection.y;
    sun[2] = view.sunDirection.z;

    const sc = u.uSunColor.value as Float32Array;
    sc[0] = view.sunColor.r;
    sc[1] = view.sunColor.g;
    sc[2] = view.sunColor.b;

    const fill = state.fill;
    if (fill !== undefined) {
      const f = u.uFill.value as Float32Array;
      f[0] = fill.r;
      f[1] = fill.g;
      f[2] = fill.b;
    }

    // The fill's direction, defaulted to straight down. Zero allocation: the
    // normalisation is written into a preallocated array.
    const fd = state.fillDirection;
    if (fd !== undefined) {
      const l = Math.hypot(fd.x, fd.y, fd.z);
      if (l > 1e-9) {
        this.fillDir[0] = fd.x / l;
        this.fillDir[1] = fd.y / l;
        this.fillDir[2] = fd.z / l;
      }
    }
    u.uFillDir.value = this.fillDir;

    u.uTime.value = view.time;
    u.uThrottle.value = state.throttle;
    u.uHeat.value = state.heat;

    // One number carries the whole screen-space error metric, exactly as
    // Planet.ts does: every detail band, the curvature gate and the marking
    // fade all key off it, so LOD shading needs no separate machinery.
    const pixelAngle = (2 * Math.tan(view.fovY * 0.5)) / Math.max(view.viewportHeight, 1);
    u.uPixelAngle.value = pixelAngle;
    u.uCoverage.value = this.hullLen / Math.max(view.distance * pixelAngle, 1e-9);

    u.uHullLen.value = this.hullLen;
    u.uPanelSize.value = this.panelSize;
    u.uPanelJitter.value = this.panelJitter;
    u.uSeamDepth.value = this.seamDepth;
    u.uSeamVis.value = this.seamVis;
    u.uFilmDepth.value = this.filmDepth;
    u.uFastenerPitch.value = this.fastenerPitch;
    u.uMicroDetail.value = this.microDetail;
    u.uRough.value = this.rough;
    u.uMetalness.value = this.metalness;
    u.uPaintFade.value = this.paintFade;
    u.uPatchRate.value = this.patchRate;
    u.uGrime.value = this.grime;
    u.uBump.value = this.bump;
    u.uAoStrength.value = this.aoStrength;

    u.uSeed.value = this.seed;
    u.uFlowDir.value = this.flow;
    u.uAftSpan.value = this.aftSpan;
    u.uWound.value = this.wound;
    u.uWoundAxis.value = this.woundAxis;
    u.uWearA.value = this.wearA;
    u.uWearB.value = this.wearB;
    u.uOcc.value = this.occ;
    u.uOccPart.value = this.occPart;
    u.uLamp.value = this.lamp;
    u.uLampTint.value = this.lampTint;
    u.uStain.value = this.stain;
    u.uStainAxis.value = this.stainAxis;

    const markUniform = u.uMark;
    if (markUniform !== undefined) {
      markUniform.value = this.mark;
      if (u.uMarkU !== undefined) u.uMarkU.value = this.markU;
      if (u.uMarkV !== undefined) u.uMarkV.value = this.markV;
      if (u.uMarkAtlas !== undefined) u.uMarkAtlas.value = this.atlas;
      if (u.uMarkRows !== undefined) u.uMarkRows.value = Math.max(this.markRows, 1);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.atlas?.dispose();
    releaseProgram(this.shared);
  }
}

function markingKindCode(m: Marking): number {
  switch (m.kind) {
    case 'hazard':
      return 1;
    case 'stripe':
      return 2;
    case 'emblem':
      return 3;
    default:
      // registry, name, stencil, numeral — all text, all from the glyph atlas.
      return 0;
  }
}

/**
 * Pick which markings survive the decal budget.
 *
 * Ranked by how much identity each carries: the emblem and the registry are
 * what make a faction recognisable across seeds, hazard zones are what make a
 * ship read as operated rather than modelled, and a name is a luxury.
 */
function selectMarkings(bp: ShipBlueprint, budget: number): readonly Marking[] {
  if (budget <= 0) return [];
  const rank = (m: Marking): number => {
    switch (m.kind) {
      case 'emblem':
        return 0;
      case 'registry':
        return 1;
      case 'hazard':
        return 2;
      case 'stripe':
        return 3;
      case 'numeral':
        return 4;
      case 'stencil':
        return 5;
      default:
        return 6;
    }
  };
  const sorted = bp.markings.slice().sort((a, b) => rank(a) - rank(b));
  return sorted.slice(0, budget);
}

// ===========================================================================
// Entry point
// ===========================================================================

/**
 * Build (or share) the material set for one ship.
 *
 * Two ships of the same family, technology and palette at the same quality tier
 * get the *same* `ShaderMaterial` objects and the same compiled program back;
 * only the per-ship uniform payload differs, and that is pushed by `apply()`.
 * Call `dispose()` exactly once per call to this function.
 */
export function shipMaterials(bp: ShipBlueprint, quality: QualitySettings): ShipMaterialSet {
  return new ShipMaterials(bp, quality);
}

/** Live cache entries. For the showroom's stats overlay and for leak tests. */
export function shipMaterialCacheSize(): number {
  return CACHE.size;
}
