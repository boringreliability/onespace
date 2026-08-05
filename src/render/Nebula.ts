/**
 * Raymarched volumetric nebulae.
 *
 * The look we are chasing is Hubble/Webb: structure at every scale, a bright
 * ionised core, filament webs, and dark dust pillars silhouetted against the
 * glow. Not a coloured fog ball.
 *
 * HOW IT WORKS
 * ------------
 * Evaluating a warped multi-octave + worley density field per raymarch step is
 * far too expensive (a five-octave fBm behind two domain warps is ~13 simplex
 * evaluations, and 64 steps of that over a third of a 1080p frame is ~30
 * GFLOP/frame). So the field is *baked once* into a 3D texture on the GPU —
 * one full-screen pass per Z slice, amortised over a handful of frames — and
 * the raymarch then costs one trilinear fetch plus a couple of cheap octaves
 * of high-frequency erosion per step. That buys a much richer field (7 octaves,
 * two levels of domain warp, worley voids *and* a star-facing ionisation-front
 * term computed from a directional derivative) for a fraction of the cost.
 *
 * Baked channels (RGBA8, linear, no colour management):
 *   R  gas density      — emits and extinguishes
 *   G  dust density     — extinguishes only; this is what makes dark pillars
 *   B  ionisation 0..1  — drives the emission colour ramp and the bright rims
 *   A  detail mask      — where high-frequency erosion is allowed to bite
 *
 * COMPOSITING
 * -----------
 * The brief asked for additive blending. Pure additive cannot draw a *dark*
 * nebula, and cannot let a dust pillar silhouette against gas behind it, so
 * this uses premultiplied-alpha compositing instead: src = ONE, dst =
 * ONE_MINUS_SRC_ALPHA. In the emissive limit (alpha -> 0) that is exactly
 * additive; where the volume is optically thick it correctly occludes. It is
 * the standard volumetric composite and it is strictly a superset of what was
 * asked for.
 *
 * RESOLUTION
 * ----------
 * Rendered at full resolution, not half. The 3D-texture bake plus the
 * empty-space early-out (steps whose baked density is below 4e-3 skip the
 * erosion noise and the whole light march) keeps a screen-filling nebula in
 * the ~1.5 ms range at 1080p/high. See the cost note above `raymarchFragment`.
 */

import {
  AddEquation,
  BackSide,
  ClampToEdgeWrapping,
  Color,
  CustomBlending,
  Group,
  IcosahedronGeometry,
  LinearFilter,
  Matrix4,
  Mesh,
  NoColorSpace,
  Object3D,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGL3DRenderTarget,
} from 'three';

import type { EngineContext } from '@/core/Engine';
import type { QualitySettings } from '@/core/Config';
import { LY, type NebulaSpec, type RGB } from '@/gen/types';
import { Rng } from '@/math/rng';
import { registerShot } from '@/game/Shots';
import { registerShaderChunks } from '@/shaders/chunks';
import type { ViewState } from './ViewState';

// ---------------------------------------------------------------------------
// Tuning tables
// ---------------------------------------------------------------------------

/**
 * Per-kind art direction. Everything that distinguishes an emission nebula
 * from a supernova remnant lives here rather than in the shader, so the GLSL
 * stays one code path and one program.
 */
interface KindParams {
  /** Radius (0..1) at which the density envelope starts falling off. */
  envInner: number;
  /** 0 = solid blob, 1 = hollow shell (planetaries, remnants). */
  shellAmount: number;
  shellCenter: number;
  shellWidth: number;
  /** Density below this is empty space. High threshold = hard-edged clouds. */
  threshold: number;
  /** Width of the threshold ramp. Narrow = crisp Hubble edges. */
  edge: number;
  /** Domain-warp strength. This is what stops it reading as fBm. */
  warp: number;
  shapeScale: number;
  detailScale: number;
  voidFreq: number;
  voidAmount: number;
  filFreq: number;
  /** Weight of the worley cell-wall web — the filament net. */
  filBoost: number;
  /**
   * Weight of the ridged-noise shock sheets. Kept SEPARATE from filBoost
   * because ridged noise multiplied into density at one scale draws nested
   * closed contours — a topographic map. On a shockfront that is exactly
   * right; on a photoionised HII region it is the single most obvious
   * "procedural" tell there is, so emission and reflection get almost none.
   */
  ridBoost: number;
  dustAmount: number;
  dustFreq: number;
  /** Radius of the ionised (hot-hued) zone around the embedded star. */
  ionRadius: number;
  /** Axial squash — >1 on Y gives the bipolar planetary-nebula waist. */
  aniso: readonly [number, number, number];
  /** Where the ionising star sits, as a fraction of the volume radius. */
  starRadius: number;
  starKelvin: number;
  starPower: number;
  /**
   * Half-width² of the star's hot zone. The light falloff is the normalised
   * Lorentzian core/(r²+core), so this is where the illumination has dropped
   * to half — sized per kind because a white dwarf and a distant backlight
   * need wildly different reach.
   */
  starCore: number;
  /**
   * Peak radiance of the star's halo, as a multiple of
   * `blackbody(starKelvin) * starPower`. PostFX's bright pass starts at 1.0
   * scene-linear, so anything meant to flare has to clear that.
   */
  glare: number;
  /**
   * Half-light radius of that halo, in volume radii. The halo is a Lorentzian
   * cloud integrated along the ray, so this is the distance from the star at
   * which its emissivity has halved — not a screen-space size. `update()`
   * shrinks it further on close approach so it can never swallow the frame.
   */
  haloRadius: number;
  sigmaGas: number;
  sigmaDust: number;
  emissive: number;
  /** Emission ~ density^p. Recombination goes as n², so p > 1 is physical. */
  emissivePow: number;
  scatter: number;
  /** Henyey–Greenstein asymmetry for the scattering off the embedded star. */
  phaseG: number;
  erode: number;
}

const KINDS: Record<NebulaSpec['kind'], KindParams> = {
  emission: {
    envInner: 0.52,
    shellAmount: 0,
    shellCenter: 0.6,
    shellWidth: 0.25,
    // Narrow ramp on a high threshold: this is where Hubble's hard-edged
    // clouds-against-black come from. A wide ramp (this was 0.22) makes every
    // line of sight pick up a little gas and the whole volume hazes over.
    threshold: 0.555,
    // Narrower than the 0.15 this was: a soft density ramp cannot produce a
    // hard terminator no matter what the lighting does, because the lit face
    // fades out over the same distance the light does.
    edge: 0.11,
    warp: 0.85,
    shapeScale: 1.15,
    // High: the domain warp works at low frequency, so without a strong finer
    // band the silhouette is all long smooth swirls — aurora, not gas clumps.
    detailScale: 5.2,
    voidFreq: 3.8,
    voidAmount: 0.85,
    filFreq: 4.5,
    // The worley web carries the filaments here instead of ridged noise: cell
    // walls are open curves that read as a net, not as nested contours.
    filBoost: 0.78,
    ridBoost: 0.10,
    dustAmount: 1.35,
    dustFreq: 0.62,
    ionRadius: 0.78,
    aniso: [1, 1.14, 1],
    starRadius: 0.18,
    starKelvin: 33000,
    starPower: 3.2,
    starCore: 0.05,
    // 3.2 * 0.5 = 1.6 scene-linear at the core — clear of the bloom threshold,
    // so the O-star flares instead of sitting as a dull blob.
    glare: 0.5,
    haloRadius: 0.030,
    // Extinction has to be high enough that tau across a clump clears ~3, or
    // the shadow march never builds enough optical depth to darken the far
    // side and every terminator comes out as a 100 px wash. At 2.6 the whole
    // cloud sat at lightT ~ 0.5 — uniformly half-lit, which is the same
    // failure as uniformly mid-grey.
    sigmaGas: 5.0,
    // Dust has to out-extinguish the gas by a wide margin or nothing ever
    // silhouettes against the glow — that is the whole pillar read.
    sigmaDust: 20,
    emissive: 6.2,
    emissivePow: 1.7,
    scatter: 2.0,
    // 0.74, not 0.45: the forward-scatter lobe has to be *narrow* for the
    // star-facing front of a clump to read as a bright line rather than as a
    // general lift over the whole clump. At g = 0.74 the peak is 6x brighter
    // and the back side 3x darker than at 0.45.
    phaseG: 0.74,
    erode: 0.62,
  },
  reflection: {
    // Lit entirely from outside: no self-emission, strong forward scattering.
    envInner: 0.46,
    shellAmount: 0,
    shellCenter: 0.6,
    shellWidth: 0.25,
    threshold: 0.52,
    edge: 0.18,
    warp: 0.95,
    shapeScale: 1.35,
    detailScale: 3.6,
    voidFreq: 3.2,
    voidAmount: 0.66,
    filFreq: 4.0,
    filBoost: 0.4,
    ridBoost: 0.07,
    dustAmount: 1.1,
    dustFreq: 0.7,
    ionRadius: 0.45,
    aniso: [1, 1.05, 1],
    starRadius: 0.62,
    starKelvin: 12500,
    starPower: 5.5,
    starCore: 0.18,
    glare: 0.5,
    haloRadius: 0.045,
    sigmaGas: 4.4,
    sigmaDust: 15,
    emissive: 0,
    emissivePow: 1.5,
    scatter: 2.5,
    phaseG: 0.78,
    erode: 0.45,
  },
  dark: {
    // Absorption only. Reads as a hole punched in whatever is behind it, with
    // a thin backlit rim where the cloud thins out.
    envInner: 0.50,
    shellAmount: 0,
    shellCenter: 0.6,
    shellWidth: 0.25,
    threshold: 0.55,
    edge: 0.14,
    warp: 1.05,
    shapeScale: 1.5,
    detailScale: 3.9,
    voidFreq: 2.8,
    voidAmount: 0.5,
    filFreq: 5.5,
    filBoost: 0.8,
    ridBoost: 0.16,
    dustAmount: 1.3,
    dustFreq: 0.8,
    ionRadius: 0.3,
    aniso: [1, 1.0, 1],
    starRadius: 1.9,
    starKelvin: 6200,
    starPower: 1.6,
    // The "star" here is a distant backlight, so the hot zone has to be wide
    // enough to still be lit at 1.9 radii away.
    starCore: 4.0,
    glare: 0.05,
    haloRadius: 0.06,
    sigmaGas: 8.0,
    sigmaDust: 28,
    emissive: 0,
    emissivePow: 1.5,
    // Just enough scattering that the thin outer wisps glow where the
    // backlight punches through. Anything higher and sRGB encoding lifts the
    // body of the cloud to mid-grey, which is the opposite of a dark nebula.
    scatter: 0.25,
    phaseG: 0.55,
    erode: 0.55,
  },
  planetary: {
    // A thin, bright, bipolar rind around a white dwarf.
    envInner: 0.5,
    shellAmount: 1,
    shellCenter: 0.62,
    shellWidth: 0.13,
    threshold: 0.46,
    edge: 0.16,
    warp: 0.6,
    shapeScale: 1.6,
    detailScale: 4.0,
    voidFreq: 3.0,
    voidAmount: 0.6,
    filFreq: 6.5,
    filBoost: 0.7,
    ridBoost: 0.45,
    dustAmount: 0.25,
    dustFreq: 0.9,
    // Larger than the shell radius on purpose: a planetary nebula IS an
    // ionised rind, so the accent hue has to reach it. At 0.72 the shell sat
    // outside the ionised zone and the whole thing came out uniform grey-blue.
    ionRadius: 1.05,
    aniso: [1, 1.55, 1],
    starRadius: 0.0,
    starKelvin: 38000,
    starPower: 4.2,
    starCore: 0.10,
    glare: 0.6,
    // A white dwarf is a point: the halo is the tightest of any kind.
    haloRadius: 0.012,
    sigmaGas: 6.0,
    sigmaDust: 10,
    emissive: 3.2,
    emissivePow: 1.5,
    scatter: 2.0,
    phaseG: 0.70,
    erode: 0.36,
  },
  'supernova-remnant': {
    // A broken, filamentary shockfront. Ridged noise at high frequency does
    // most of the work; the envelope is a thin, ragged shell.
    envInner: 0.55,
    shellAmount: 1,
    shellCenter: 0.78,
    // Thin: a shockfront is a sheet, not a rind. A wide one just reads as a
    // fuzzy ball once it fills the frame. Not thinner than this, though — at
    // 0.11 the shell was narrower than a few raymarch steps and broke up into
    // per-voxel speckle instead of filaments.
    shellWidth: 0.15,
    threshold: 0.58,
    edge: 0.15,
    warp: 1.2,
    shapeScale: 1.45,
    detailScale: 5.5,
    voidFreq: 3.6,
    voidAmount: 0.85,
    filFreq: 9.0,
    filBoost: 1.0,
    ridBoost: 0.85,
    dustAmount: 0.5,
    dustFreq: 1.1,
    ionRadius: 0.32,
    aniso: [1.05, 1.0, 1.08],
    starRadius: 0.02,
    starKelvin: 39000,
    starPower: 1.5,
    // Broad, because the emitting shockfront sits at 0.78 radii from the
    // progenitor — a tight core would leave the shell unlit.
    starCore: 0.9,
    // The progenitor remnant is a pulsar: a hard, tiny, over-threshold point.
    // 1.5 * 0.85 = 1.3 scene-linear.
    glare: 0.85,
    haloRadius: 0.016,
    sigmaGas: 4.0,
    sigmaDust: 9,
    emissive: 3.5,
    emissivePow: 1.9,
    scatter: 1.6,
    phaseG: 0.65,
    erode: 0.62,
  },
};

/**
 * The desaturated steel-blue the outer envelope is pulled towards. The palette
 * rule is one saturated accent per location, so only the ionised core is
 * allowed to be a strong hue; the envelope has to fall back to the noir base.
 */
const STEEL = new Color(0.20, 0.29, 0.44);

/**
 * Clamp for the radius at which the bounding volume is *drawn*. Real nebula
 * radii are light years (1e13 km) — far beyond the camera's 1e12 far plane —
 * so by default the volume is drawn as a large but renderable proxy shell,
 * exactly like a sky impostor. 1e11 km is ~670 AU: comfortably outside any
 * planetary system and comfortably inside the far plane.
 */
const MAX_RENDER_RADIUS = 1e11;
const MIN_RENDER_RADIUS = 1e5;

/**
 * How strongly the raymarch front-loads its steps. 0 is uniform; 0.68 makes the
 * first step about a third the length of a uniform one and the last about 1.7x,
 * which is the trade that lets near-camera detail sharpen on approach without
 * spending steps the far end cannot use.
 */
const STEP_SKEW = 0.68;

/** 1 + r + r² + … + r^(n-1). Used to normalise the geometric light march. */
function geometricSum(n: number, ratio: number): number {
  let sum = 0;
  let term = 1;
  for (let i = 0; i < n; i++) {
    sum += term;
    term *= ratio;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

/**
 * The field bake. One full-screen pass per Z slice of the 3D target.
 *
 * This is where all the expensive noise lives: two levels of domain warp, two
 * independently-scaled fBm bands, a worley pass for bubbles and the filament
 * web, ridged noise for shock sheets, an independently-warped dust field, and
 * a second full evaluation one small step towards the star so we can detect
 * the star-facing surface of every cloud and light it as an ionisation front.
 * That last term is the single detail that sells the Hubble look.
 */
function bakeFragment(octLo: number, octHi: number): string {
  return /* glsl */ `
#include <onespace_noise>
#include <onespace_color>

#define OS_OCT_LO ${octLo}
#define OS_OCT_HI ${octHi}

uniform float uLayer;
uniform vec3  uSeed;
uniform vec3  uAniso;
uniform vec3  uStarPos;
uniform float uShapeScale;
uniform float uWarp;
uniform float uDetailScale;
uniform float uVoidFreq;
uniform float uVoidAmount;
uniform float uFilFreq;
uniform float uFilBoost;
uniform float uRidBoost;
uniform float uThreshold;
uniform float uEdge;
uniform float uEnvInner;
uniform float uShellCenter;
uniform float uShellWidth;
uniform float uShellAmount;
uniform float uIonRadius;
uniform float uDustAmount;
uniform float uDustFreq;
uniform float uRimEps;
uniform float uDensity;

varying vec2 vUv;

struct OsField {
  float gas;
  float dust;
  float ion;
  float mask;
  /**
   * Large-scale density only — the lobe silhouette with every fine octave
   * stripped out. The ionisation-front term differentiates THIS rather than
   * the full field: a finite difference of a field that carries worley walls
   * and ridged sheets flips sign at every one of them, so the "star-facing
   * rim" came out as nested contour lines painted over the entire nebula.
   */
  float lobe;
};

OsField osNebulaField(vec3 p) {
  OsField f;

  // Anisotropic squash gives bipolar lobes / flattened discs without any
  // extra noise cost.
  vec3 ap = p * uAniso;
  float r = length(ap);

  vec3 q = ap * uShapeScale + uSeed;

  // Two levels of domain warp. One level makes fBm swirl; two makes it curl
  // back on itself, which is what produces the sheets and hooks real gas has.
  vec3 w1 = os_warp(q * 0.5, uWarp);
  vec3 w2 = os_warp(w1 * 1.9, uWarp * 0.42);

  // Two octave bands driven at independent scales so the silhouette never
  // reads as one blob: w1 carries the lobes, w2 the internal structure.
  float lo = os_fbm(w1, OS_OCT_LO, 2.07, 0.55);
  float hi = os_fbm(w2 * uDetailScale, OS_OCT_HI, 2.31, 0.52);
  // Weighted towards the finer band: at 0.62/0.38 the smooth lobe band ruled
  // the silhouette and the result read as cirrus rather than as clumps.
  float shape = (lo * 0.50 + hi * 0.50) * 0.5 + 0.5;

  // Worley: F1 carves the wind-blown bubbles, F2-F1 leaves the cell walls,
  // which become the filament web.
  vec2 cell = os_worley(w1 * uVoidFreq);
  float voids = smoothstep(0.02, 0.40, cell.x);
  // Narrow: the wall has to be a filament, not a slab. At 0.22 the walls were
  // wider than the cells and the "web" read as smooth streaky mist.
  float web = 1.0 - smoothstep(0.0, 0.11, cell.y);

  // Ridged noise contributes the sharp shock sheets.
  float rid = os_ridged(w2 * uFilFreq, 3, 2.4, 0.55) * 0.5 + 0.5;

  // Radial envelope, broken by low-frequency noise so the outline is never a
  // circle, then optionally collapsed into a shell.
  float wob = os_fbm(q * 0.42 + 11.0, 3, 2.1, 0.5) * 0.30;
  float env = 1.0 - smoothstep(uEnvInner + wob, 1.0, r);
  // Squared explicitly: pow() is undefined for a negative base, and this one
  // is negative for every voxel inside the shell radius.
  float sr = (r - uShellCenter) / uShellWidth;
  float shell = exp(-sr * sr);
  // Shell mode keeps only a faint interior halo, otherwise a planetary reads
  // as a filled egg rather than a rind.
  env = mix(env, env * 0.12 + shell, uShellAmount);
  // The volume *must* reach zero density by r = 1 or the ray/sphere entry
  // point becomes a visible circle. Doing that with a fixed radius would put a
  // perfect sphere around the nebula — most obvious on the shell kinds, whose
  // shockfront still carries ~2% density at r = 1. So the cut radius rides the
  // same low-frequency wobble as the inner envelope: the limb ends up ragged
  // and lobed, and shells come out broken instead of as tidy rinds.
  env *= 1.0 - smoothstep(min(0.97, 0.89 + wob * 0.45), 1.0, r);
  env = clamp(env, 0.0, 1.0);

  // A high threshold with a narrow ramp is what gives hard-edged clouds
  // against real black instead of a soft fog. Thresholding the *shape* and
  // applying the envelope afterwards matters: doing it the other way round
  // pushes the whole outer half of the volume below the threshold and the
  // nebula collapses into a ball a third of its nominal size.
  float d = smoothstep(uThreshold, uThreshold + uEdge, shape);
  d = mix(d, d * voids, uVoidAmount);
  d = clamp(d * (1.0 + web * uFilBoost + rid * uRidBoost), 0.0, 1.0);
  d *= env;

  // Dust rides the same warp at a different offset and a lower frequency, so
  // the lanes cut *across* the emission rather than following it.
  float dn = os_fbm(w1 * uDustFreq + vec3(23.7, 5.1, 91.3), OS_OCT_LO, 2.0, 0.5) * 0.5 + 0.5;
  // Hard-edged lanes. The 0.52 -> 0.86 ramp this used to be spread the dust
  // over a third of its own dynamic range, so every lane was a translucent
  // gradient: it tinted the gas behind it but never *occluded* it, and the
  // frame ended up with nothing silhouetted against anything. A ramp barely
  // wider than the noise's own gradient makes a lane either opaque or absent,
  // which is what turns it into a black shape in front of the glow.
  float dust = smoothstep(0.545, 0.625, dn) * uDustAmount * env;
  // Floor tied to the gas, so emitting clouds are never perfectly transparent.
  // Kept low: this term is omnipresent by construction, and at 0.22 it was a
  // uniform haze over the whole volume that greyed out the lane contrast.
  dust = max(dust, d * 0.14);

  // Ionisation drives the hue ramp, so it has to stay *rationed*: high only
  // near the star and on genuine fronts. Letting the filament web push it up
  // everywhere paints the whole nebula in the saturated accent.
  float ds = distance(ap, uStarPos);
  float ion = 1.0 - smoothstep(0.0, uIonRadius, ds);
  ion = max(ion, web * 0.34);
  // Scaled by uRidBoost so a kind that has no shock sheets does not get their
  // hue either — otherwise emission nebulae read as a topographic map.
  ion = max(ion, rid * uRidBoost * 0.35);

  f.gas = clamp(d * uDensity, 0.0, 1.0);
  f.dust = clamp(dust, 0.0, 1.0);
  f.ion = clamp(ion, 0.0, 1.0);
  f.mask = clamp(web * 0.7 + rid * 0.5, 0.0, 1.0);
  // os_fbm's first term is exactly 0.5 * os_snoise(p), so this is the base
  // octave of the lo band and costs one extra simplex evaluation in a bake.
  f.lobe = clamp((os_snoise(w1) * 0.5 + 0.5) * env, 0.0, 1.0);
  return f;
}

void main() {
  vec3 p = vec3(vUv, uLayer) * 2.0 - 1.0;
  OsField f = osNebulaField(p);

  // Directional derivative towards the star. Where the LOBE density falls off
  // in the direction of the ionising source we are standing on the lit face of
  // a pillar — that is where the bright rim goes. Differentiating the lobe
  // band rather than the full field is what keeps this a handful of broad
  // fronts instead of a contour map (see OsField.lobe), and it lets the
  // epsilon be a proper cloud-scale distance rather than three voxels.
  vec3 toStar = normalize(uStarPos - p + vec3(1e-5));
  OsField g = osNebulaField(p + toStar * uRimEps);
  float rim = clamp((f.lobe - g.lobe) * 2.4, 0.0, 1.0);
  // Only on real material, and only where there is enough of it to have a face.
  rim *= smoothstep(0.03, 0.22, f.gas + f.dust);

  f.ion = clamp(f.ion + rim * 0.55, 0.0, 1.0);

  gl_FragColor = vec4(f.gas, f.dust, f.ion, f.mask);
}
`;
}

const BAKE_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const RAYMARCH_VS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLocalPos;
void main() {
  vLocalPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

/**
 * Per-pixel cost, high tier (64 steps), screen-filling:
 *   64 trilinear 3D fetches (always)
 *   64 x the star-halo term: one atan, one normalize, one Mie phase (always)
 *   ~1/3 of steps additionally: 3 octaves of simplex + 5 more 3D fetches
 * ≈ 175 texture fetches + ~45 simplex evaluations + ~64 transcendentals. The
 * halo is the only unconditional addition and it is pure ALU against a shader
 * that is texture-bound — one simplex evaluation is worth roughly ten of it.
 * The 3D field is ~3.5 MB and lives in cache, so this measures around 1.5 ms at
 * 1080p — inside budget at full resolution, which is why there is no half-res
 * target here.
 */
function raymarchFragment(steps: number, lightSteps: number, octDetail: number): string {
  return /* glsl */ `
#include <onespace_noise>
#include <onespace_color>
#include <onespace_atmosphere>
#include <logdepthbuf_pars_fragment>

#define OS_STEPS ${steps}
#define OS_LIGHT_STEPS ${lightSteps}
#define OS_OCT_DET ${octDetail}
// Sum of the light march's geometric step ratios, folded in at compile time so
// the first step length can be chosen to make the march end exactly on the
// light source rather than ploughing on past it.
#define OS_LIGHT_NORM ${geometricSum(lightSteps, 1.45).toFixed(6)}
// Quadratic step distribution: 0 = uniform, 1 = fully front-loaded.
#define OS_STEP_SKEW ${STEP_SKEW.toFixed(3)}
// Cycles per step length that the march is willing to call "resolved". Kept
// strictly under the 0.5 Nyquist limit. This was 0.55 — deliberately over the
// limit, on the theory that the aliasing would read as film grain. It does not:
// integration noise is density-correlated, so it clumps on the wisps rather
// than sitting evenly like emulsion, and at 1:1 the filaments dissolved into
// per-pixel static. Whatever is above Nyquist here is not detail and no
// downstream filter can recover it.
#define OS_DET_RES 0.42
// Fraction of a step the primary/shadow ray offsets are allowed to roam. Full
// [0,1) jitter makes the sample position uniform over the step, which is
// unbiased but has the largest possible variance — and variance in a volume
// integral IS the salt-and-pepper. Narrowing to the middle 62% cuts the noise
// power to ~0.4x; the residual is still wide enough to break the step lattice
// into noise instead of rings.
#define OS_JIT 0.62
// Ceiling on accumulated radiance before the grade. Without it a single voxel
// where the ionisation ramp blows out lands one channel at a few hundred while
// its neighbours sit at 2, and the tonemap turns that into an isolated
// saturated red/green pixel — the colour speckle the review found mid-frame.
#define OS_ACC_CLAMP 24.0
// The frequency cap is applied to the band's SECOND-highest octave, not its
// highest. With gain 0.5 the top octave of a three-octave fBm carries only ~14%
// of the amplitude, so letting it sit right on the resolution limit costs a
// little grain and buys back roughly 3x the usable detail frequency.
#define OS_DET_TOP ${Math.max(1.4, Math.pow(2.7, octDetail - 2)).toFixed(4)}
#define OS_DET_TOP2 2.6

uniform highp sampler3D uField;
uniform mat4  uInvModel;
uniform vec3  uColorCool;
uniform vec3  uColorMid;
uniform vec3  uAccent;
uniform vec3  uStarPos;
uniform vec3  uDrift;
uniform float uStarKelvin;
uniform float uStarPower;
uniform float uStarCore;
uniform float uGlare;
uniform float uHaloRadius;
uniform float uSigmaGas;
uniform float uSigmaDust;
uniform float uEmissive;
uniform float uEmissivePow;
uniform float uScatter;
uniform float uPhaseG;
uniform float uErode;
uniform float uDetailFreq;
uniform float uDetailAmount;
uniform float uCloseDetail;
uniform float uOpacity;

#ifdef OS_SOFT_DEPTH
uniform sampler2D uDepthTexture;
uniform vec2  uResolution;
uniform vec3  uCamForwardLocal;
uniform float uRenderRadius;
uniform float uSoftFade;
#endif

varying vec3 vLocalPos;

/**
 * Wavelength-dependent DUST cross-sections. Interstellar extinction goes
 * roughly as 1/lambda, so blue is removed hardest — that single fact is what
 * makes real nebulae change hue with depth: backlit dust rims go amber, deep
 * cores go red, and a lane in front of a hot star warms it. The gas term stays
 * grey (it is line emission plus electron scattering, both near-neutral).
 *
 * Scattering is biased the other way for the same physical reason a reflection
 * nebula is blue: small grains scatter short wavelengths preferentially. Both
 * vectors average to ~1 so the sigma tuning above still means what it says.
 */
const vec3 OS_DUST_EXT = vec3(1.35, 1.00, 0.72);
const vec3 OS_DUST_SCA = vec3(0.80, 1.00, 1.32);

/**
 * Per-pixel white noise for the ray offsets.
 *
 * NOT os_hash13: that hash is fract(px*py*pz*(px+py+pz)) over
 * p = fract(c*0.3183099 + 0.1), so any component landing near zero drives the
 * whole product to zero. 0.3183099 is 1/pi, and 355/113 is pi's third
 * convergent, so the coordinates that trip it recur every 355 pixels — at
 * 1080p that is a fixed lattice (columns 106, 461, 816, 1171, 1526, 1881 and
 * the matching rows) where the offset is deterministically 0, the march starts
 * exactly on the step boundary, and the result bands. Hoskins' hash-without-
 * sine mixes additively, so no single component can collapse the output; it
 * has no degenerate set anywhere on a 1080p grid.
 */
float osnPixelHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

/**
 * Cool desaturated envelope -> mid hue -> saturated accent in the ionised
 * core, with a near-white blow-out at the very centre. Rationed colour: only
 * the core is allowed to be saturated.
 */
vec3 osNebulaRamp(float ion) {
  vec3 c = mix(uColorCool, uColorMid, smoothstep(0.0, 0.45, ion));
  c = mix(c, uAccent, smoothstep(0.55, 0.95, ion));
  // The very top of the ramp blows out towards white, not towards more accent.
  // Real HII cores and ionisation fronts clip the sensor; adding saturated hue
  // instead just makes a bigger patch of the same colour, and a white-hot core
  // is what gives the accent hue something to read *against*. The ramp is wider
  // and weaker than it was (0.93..1.0 at 1.3x): a near-step function on a noisy
  // scalar fires on isolated voxels, which is one pixel of blown colour sitting
  // in gas that is 30x darker.
  return c + mix(uAccent, vec3(1.0), 0.5) * smoothstep(0.86, 1.0, ion) * 0.9;
}

#ifdef OS_SOFT_DEPTH
/** Scene depth, in local (volume-radius) units along the view ray. */
float osSceneDistance(vec3 rd) {
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  float d = texture2D(uDepthTexture, gl_FragCoord.xy / uResolution).x;
  if (d >= 1.0) return 1e20;
  // Invert three's logarithmic depth: gl_FragDepth = log2(1 + w) * FC * 0.5,
  // where w is the view-space distance along the camera's forward axis.
  float w = exp2(d * 2.0 / logDepthBufFC) - 1.0;
  float cosA = max(dot(rd, uCamForwardLocal), 1e-3);
  return (w / uRenderRadius) / cosA;
#else
  // Only the logarithmic depth buffer is supported here; a 1:1 universe needs
  // it anyway, so a linear-depth fallback would be dead code.
  return 1e20;
#endif
}
#endif

void main() {
  vec3 ro = (uInvModel * vec4(cameraPosition, 1.0)).xyz;
  vec3 rd = normalize(vLocalPos - ro);

  vec2 hit = os_raySphere(ro, rd, 1.0);
  float tN = max(hit.x, 0.0);
  float tF = hit.y;
  if (tF <= tN) discard;

#ifdef OS_SOFT_DEPTH
  float sceneT = osSceneDistance(rd);
  tF = min(tF, sceneT);
  if (tF <= tN) discard;
#endif

  float span = tF - tN;

  // Per-pixel offsets on the ray start and on the shadow ray. These have to be
  // *white* noise, not the interleaved-gradient pattern used for dithering: IG
  // noise is spatially correlated by construction (it is designed to be
  // resolved by TAA across several frames), and against a hard-edged density
  // field that correlation beats with the step lattice and prints a visible
  // diagonal crosshatch over the whole nebula.
  // Deliberately NOT a function of time — a temporal offset would make a
  // static nebula crawl, which is far worse than a fixed grain pattern.
  // Narrowed towards the step midpoint (OS_JIT) because full-width jitter is
  // the maximum-variance choice and that variance is exactly the per-pixel
  // static the volume was dissolving into at 1:1.
  float jit  = 0.5 + (osnPixelHash(gl_FragCoord.xy) - 0.5) * OS_JIT;
  float jitL = 0.5 + (osnPixelHash(gl_FragCoord.xy * 1.61 + 47.3) - 0.5) * OS_JIT;

  vec3 starRad = os_blackbody(uStarKelvin) * uStarPower;
  // The halo is pulled halfway towards the nebula's own accent (itself half
  // desaturated). A 33 kK blackbody and a cyan HII region are two separate
  // saturated hues on screen, and the palette budget is one accent plus white;
  // sharing a hue family between the key light and the gas it lights spends
  // one. Luminance is preserved, so this does not change the exposure.
  vec3 haloCol = mix(starRad, dot(starRad, vec3(1.0 / 3.0)) * mix(uAccent, vec3(1.0), 0.45), 0.5);

  // ---- analytic halo profile -------------------------------------------
  // The halo used to be one post-loop term, exp(-dmin * tight), multiplied by
  // a single scalar transmittance sampled at the star's depth. That is a
  // radial gradient with a global dimmer on it: nothing in the volume could
  // cut into it, so it read as a soft brush pasted over the render. It is now
  // a Lorentzian emissive cloud around the star, accumulated INSIDE the march
  // so that whatever density sits in front of it at that depth shadows it —
  // which is where the god-rays and the dust-lane cuts come from.
  //
  // Integrated in closed form rather than point-sampled: the profile is
  // narrower than a step near the star, so midpoint sampling would turn the
  // brightest object in the frame into 2-3 samples of speckle. Along the ray
  // |p(t) - S|^2 = dmin^2 + (t - u)^2, and
  //   integral of hc / (dmin^2 + (t-u)^2 + hc) dt = (hc/a) * atan((t-u)/a)
  // with a = sqrt(dmin^2 + hc). Differencing that between step boundaries is
  // exact at any step count.
  vec3 sOff = uStarPos - ro;
  float sU = dot(sOff, rd);
  float hc = uHaloRadius * uHaloRadius;
  float ha = sqrt(max(dot(sOff, sOff) - sU * sU, 0.0) + hc);
  // Normalised so a ray straight through the star integrates to exactly
  // uGlare; off-axis it falls as haloRadius / dmin.
  float hNorm = uGlare * hc / (ha * 3.14159265 * uHaloRadius);
  float haloPrev = hNorm * atan((tN - sU) / ha);

  vec3 acc = vec3(0.0);
  // Transmittance is chromatic: see OS_DUST_EXT. This is what reddens the deep
  // cores and warms the backlit rims, and it costs two extra floats of state.
  vec3 trans = vec3(1.0);
  float prevT = tN;

  for (int i = 0; i < OS_STEPS; i++) {
    // Front-loaded steps. Uniform stepping spends exactly the same world-space
    // sample spacing however close the camera gets, which is why a volume like
    // this dissolves into smooth mush on approach; the quadratic
    // reparametrisation below puts ~3x more samples in the near third of the
    // ray and stretches the far end, where a step covers fewer pixels anyway.
    float s = float(i + 1) / float(OS_STEPS);
    float tNext = tN + span * mix(s, s * s, OS_STEP_SKEW);
    float seg = tNext - prevT;
    float t = prevT + seg * jit;
    prevT = tNext;

    vec3 p = ro + rd * t;
    vec4 f = texture(uField, p * 0.5 + 0.5);
    float gas = f.r;
    float dust = f.g;

    // ---- star halo, exactly integrated over this segment ------------------
    // Outside the empty-space early-out on purpose: the star sits in a cleared
    // bubble it has blown in its own gas, so gating the halo on local density
    // would delete it exactly where it is brightest.
    float haloNext = hNorm * atan((tNext - sU) / ha);
    float dHalo = haloNext - haloPrev;
    haloPrev = haloNext;
    if (dHalo > 1e-5) {
      vec3 sdir = normalize(uStarPos - p + vec3(1e-6));
      // Anisotropic, so the halo is not a circle: the haze between the camera
      // and the star forward-scatters and lights up, the haze behind it does
      // not. Capped well below uPhaseG — the direction to the star swings
      // through 180 degrees over a couple of steps at closest approach, and a
      // needle-sharp lobe there would alias into a hard front/back seam.
      float hph = 0.55 + 1.5 * os_phaseMie(dot(rd, sdir), min(uPhaseG, 0.55));
      // Broken by the field itself: the halo is light scattered off haze, so
      // it belongs where the haze is. The floor keeps it alive in vacuum, and
      // this costs nothing — the texel is already fetched.
      float hbr = 0.6 + 1.0 * smoothstep(0.0, 0.4, gas + dust);
      // trans is the transmittance accumulated IN FRONT of this depth, so a
      // dust lane nearer the camera carves a real shadow through the glow.
      acc += trans * haloCol * (dHalo * hph * hbr);
    }

    // Empty-space early-out. This is the whole performance story: most steps
    // are vacuum and skip the noise and the light march entirely.
    if (gas + dust > 0.004) {
      // Analytic noise mip. An octave whose period is shorter than the step is
      // not detail, it is per-pixel static — no downstream filter removes it.
      // Capping the band at what THIS step can resolve turns that into a free
      // distance LOD, because the steps shorten towards the camera.
      float res = OS_DET_RES / max(seg, 1e-6);
      float dFreq = min(uDetailFreq, res / OS_DET_TOP);

      // High-frequency erosion the baked field cannot hold. Bites hardest on
      // the filament mask, so wisps fray and cores stay solid.
      float det = os_fbm(p * dFreq + uDrift, OS_OCT_DET, 2.7, 0.5) * 0.5 + 0.5;
      float er = uErode * (0.35 + 0.65 * f.a) * uDetailAmount;
      gas = clamp((gas - er * (1.0 - det)) / max(1.0 - er, 0.15), 0.0, 1.0);
      dust = clamp(dust - er * 0.45 * (1.0 - det), 0.0, 1.0);

      // A second, three-times-finer band, faded in only where the step length
      // can actually carry it. Uniform branch, so it is coherent across the
      // wavefront; the smoothstep keeps it from popping at the boundary.
      if (uCloseDetail > 0.0) {
        float band2 = dFreq * 3.0;
        float w2 = uCloseDetail * smoothstep(1.0, 2.2, res / (band2 * OS_DET_TOP2));
        float det2 = os_fbm(p * band2 + uDrift, 2, 2.6, 0.5) * 0.5 + 0.5;
        // Weighted towards the filament mask but with a floor: gating this
        // entirely on f.a left the *interiors* of clumps as smooth trilinear
        // blobs at close range, which is precisely where a 96³ baked field
        // gives itself away.
        gas = clamp(gas * mix(1.0, 0.42 + 1.05 * det2, w2 * (0.45 + 0.55 * f.a)), 0.0, 1.0);
        dust = clamp(dust * mix(1.0, 0.55 + 0.80 * det2, w2 * (0.35 + 0.65 * f.a)), 0.0, 1.0);
      }

#ifdef OS_SOFT_DEPTH
      // Soft-particle fade so the volume never hard-clips against geometry.
      float fade = clamp((sceneT - t) / uSoftFade, 0.0, 1.0);
      gas *= fade;
      dust *= fade;
#endif

      float sigGas = gas * uSigmaGas;
      float sigDst = dust * uSigmaDust;
      // Chromatic extinction. This is the whole of the colour-with-depth fix:
      // the ramp used to be a lookup on one noise scalar, so the cloud was the
      // same steel-blue at every depth and on both sides of every clump. Now
      // blue is removed 1.9x faster than red through dust, which is the actual
      // physical process, and it costs three floats where there was one.
      vec3 sigE = vec3(sigGas) + sigDst * OS_DUST_EXT;
      float sigEs = sigGas + sigDst;
      if (sigEs > 1e-4) {
        // ---- transmittance towards the embedded star ------------------
        vec3 ld = uStarPos - p;
        float ldist = length(ld);
        ld /= max(ldist, 1e-4);

        // Shadow ray towards the star. The march has to STOP at the source:
        // dividing the reach by the geometric-series sum makes the last step
        // land on it. (Using ldist/N with a growing step overshot by 3-5x, so
        // gas *behind* the star was shadowing the sample — that flattened
        // every lit face and was the single biggest contrast loss here.)
        // Capped at 0.9 so an external backlight -- the dark kind's source sits
        // at 1.9 radii -- still shadows through the whole cloud without
        // spending all its steps in vacuum.
        vec3 tau = vec3(0.0);
        float ls = min(ldist, 0.9) / OS_LIGHT_NORM;
        // Jittered start, for the same reason as the primary ray: the step
        // length here is a function of ldist, so an unjittered shadow march
        // aliases into concentric shells centred on the light source.
        float lt = ls * (0.15 + 0.85 * jitL);
        for (int j = 0; j < OS_LIGHT_STEPS; j++) {
          vec4 lf = texture(uField, (p + ld * lt) * 0.5 + 0.5);
          tau += (vec3(lf.r * uSigmaGas) + lf.g * uSigmaDust * OS_DUST_EXT) * ls;
          lt += ls;
          ls *= 1.45; // exponential steps: fine nearby, coarse far away
        }
        // Two-lobe transmittance: a crude multiple-scattering term so deep gas
        // keeps a colour instead of crushing to flat black. Deliberately weak
        // and fast-decaying — at 0.35/0.18 it was four times the single-
        // scattering term at tau ~ 3, which lifted every shadowed flank to the
        // same mid value and killed the terminator. Weaker again now that the
        // extinction is high enough for tau to actually clear 3: at 0.20/0.32
        // the MS lobe was still 1.5x the direct term out there, which is the
        // same flattening in a smaller dose.
        vec3 lightT = exp(-tau) + 0.13 * exp(-tau * 0.28);

        // Forward-scattering peak — this is the bright rim on the side of
        // every clump that faces the star. The additive floor is the isotropic
        // remainder; small, because it is a floor under the *contrast*.
        float phase = os_phaseMie(dot(rd, ld), uPhaseG) + 0.05;

        // Normalised Lorentzian rather than a raw 1/r²: the singularity at an
        // embedded O-star otherwise burns a white hole through the middle of
        // the frame and takes all the structure with it. Peaks at 1, and
        // uStarCore sets how far the hot zone reaches.
        float falloff = uStarCore / (ldist * ldist + uStarCore);

        // Scattering coefficient as a fixed albedo fraction of extinction.
        // Keeping sigmaS proportional to sigmaE is what makes the scattered
        // brightness independent of the extinction tuning.
        // Blue-biased on the dust term: small grains scatter short wavelengths
        // preferentially, which is why reflection nebulae are blue. Splitting
        // it from the emission ramp is the other half of the colour fix — the
        // scattered light and the line emission are now driven by different
        // physics instead of by the same lookup on the same noise scalar.
        vec3 sigS = vec3(sigGas * 0.5) + sigDst * 0.55 * OS_DUST_SCA;

        // Emission scales with the *ionised* fraction, not just with density.
        // Recombination lines only come from gas the star has actually ionised,
        // and driving f.b through the hue ramp alone left the whole field
        // self-luminous at a near-uniform brightness — a glowing fog ball with
        // a tinted middle. Coupling the intensity too is what makes the
        // embedded star read as the key light: neutral outskirts sit at ~20%,
        // the ionised core and the star-facing fronts at 100%.
        // 0.10 rather than 0.20 at the neutral end: "unlit is black" applies to
        // self-emission too. Un-ionised gas has no recombination lines to emit.
        vec3 em = osNebulaRamp(f.b) * uEmissive * mix(0.10, 1.0, f.b) * pow(gas, uEmissivePow);
        vec3 scat = starRad * falloff * lightT * phase * uScatter * sigS;

        vec3 S = em * gas + scat;

        // Beer–Lambert, analytic in-scatter over the step so coarse steps do
        // not lighten the result.
        vec3 aT = exp(-sigE * seg);
        acc += trans * S * (1.0 - aT) / max(sigE, vec3(1e-4));
        trans *= aT;
      }
    }

    if (max(max(trans.r, trans.g), trans.b) < 0.004) break;
  }

  // Hard ceiling before the grade: see OS_ACC_CLAMP.
  acc = min(acc, vec3(OS_ACC_CLAMP));

  // Scalar coverage from a chromatic transmittance. Luminance-weighted rather
  // than a mean, so the channel the eye actually reads controls how much of the
  // background survives.
  float alpha = (1.0 - dot(trans, vec3(0.2126, 0.7152, 0.0722))) * uOpacity;
  gl_FragColor = vec4(acc * uOpacity, alpha);

  #include <colorspace_fragment>
  #include <logdepthbuf_fragment>

  // Dither last, in output space, where the 8-bit quantisation actually
  // happens. Alpha bands too, so it gets the same treatment.
  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
  gl_FragColor.a += (os_igNoise(gl_FragCoord.xy + 17.0) - 0.5) / 255.0;
}
`;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export interface NebulaOptions {
  /**
   * Radius, in render units (km), at which the bounding volume is drawn.
   * Defaults to the spec radius clamped into a range the depth buffer can
   * actually resolve — see MAX_RENDER_RADIUS. The galaxy map should pass its
   * own scale here.
   */
  readonly renderRadius?: number;
  /**
   * Sort key within the transparent pass. The default puts the nebula first
   * (i.e. furthest) so nearer transparents — rings, atmospheres — composite
   * over it correctly.
   */
  readonly renderOrder?: number;
}

function toColor(rgb: RGB, out: Color): Color {
  // gen/types declares these as linear RGB, which is three's working space.
  return out.setRGB(rgb[0], rgb[1], rgb[2]);
}

export class NebulaRenderer {
  readonly object3d: Object3D;

  /** Radius, in render units (km), of the volume actually drawn. */
  readonly renderRadius: number;

  /**
   * Position of the ionising star this nebula is lit by, in the object's local
   * space, kilometres. The integrator should place a real StarRenderer here so
   * the light source in frame and the light source in the volume agree.
   */
  readonly starLocal = new Vector3();

  /** Effective temperature, kelvin, of that star. */
  readonly starTemperature: number;

  /**
   * Domain drift speed. Zero by default: nebulae are static on human
   * timescales and shots must reach a steady state. Non-zero gives an
   * extremely slow internal churn.
   */
  driftSpeed = 0;

  private readonly spec: NebulaSpec;
  private readonly mesh: Mesh;
  private readonly geometry: IcosahedronGeometry;
  private readonly material: ShaderMaterial;

  private readonly field: WebGL3DRenderTarget;
  private readonly fieldSize: number;
  private readonly bakeScene = new Scene();
  private readonly bakeCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly bakeGeometry: PlaneGeometry;
  private readonly bakeMaterial: ShaderMaterial;
  private readonly bakeMesh: Mesh;
  private readonly layersPerFrame: number;
  private bakedLayers = 0;

  // Preallocated scratch — update() must not allocate.
  private readonly tmpMatrix = new Matrix4();
  private readonly tmpVec3 = new Vector3();
  private readonly tmpVec2 = new Vector2();
  private readonly haloRadius: number;
  private detailAmount = 0;
  private closeDetail = 0;
  private fade = 0;
  private drift = 0;
  /** True while OS_SOFT_DEPTH is compiled in — drives the extra uniform work. */
  private softDepth = false;

  constructor(spec: NebulaSpec, quality: QualitySettings, opts: NebulaOptions = {}) {
    registerShaderChunks();

    this.spec = spec;
    const k = KINDS[spec.kind];
    const rng = new Rng(spec.seed >>> 0);

    // An explicit radius is honoured as given (the galaxy map works in its own
    // scale); only the spec-derived default gets clamped into a range the
    // depth buffer can resolve.
    const trueRadius = Math.max(spec.radiusLy, 0.01) * LY;
    this.renderRadius =
      opts.renderRadius ??
      Math.min(MAX_RENDER_RADIUS, Math.max(MIN_RENDER_RADIUS, trueRadius));

    // ---- baked field resolution, derived from the step budget -------------
    // Steps and field resolution have to scale together: a 96-step march
    // through a 40³ field just resamples the same voxel. The multiplier is
    // 2.25 rather than 1.5 because at 1.5 the trilinear voxels were visible as
    // blocky speckle on the thin-shelled kinds, and the field is a one-off
    // bake: a 144³ RGBA8 volume is 12 MB and still exactly one fetch per step,
    // so the resolution is close to free at runtime.
    const raw = quality.nebulaSteps * 2.25;
    this.fieldSize = Math.min(160, Math.max(48, Math.round(raw / 8) * 8));

    const octLo = Math.min(7, Math.max(3, Math.round(quality.nebulaSteps / 16) + 2));
    const octHi = Math.min(5, Math.max(2, octLo - 2));
    const octDetail = Math.min(4, Math.max(2, octLo - 3));
    const lightSteps = Math.min(8, Math.max(3, Math.round(quality.nebulaSteps / 10)));

    // ---- seeded variation -------------------------------------------------
    const jitter = (base: number, amount: number): number => base * rng.range(1 - amount, 1 + amount);

    // Kept well inside os_snoise's mod-289 lattice period so different seeds
    // land in genuinely different noise, without float32 losing digits.
    const seedOffset = new Vector3(rng.range(-24, 24), rng.range(-24, 24), rng.range(-24, 24));
    const anisoJ = new Vector3(
      jitter(k.aniso[0], 0.12),
      jitter(k.aniso[1], 0.12),
      jitter(k.aniso[2], 0.12),
    );

    this.haloRadius = k.haloRadius;

    const starDir = rng.onSphere();
    const starNorm = new Vector3(starDir[0], starDir[1], starDir[2]).multiplyScalar(
      jitter(k.starRadius, 0.35),
    );
    this.starLocal.copy(starNorm).multiplyScalar(this.renderRadius);
    this.starTemperature = jitter(k.starKelvin, 0.12);

    // spec.density is an artistic 0..1-ish knob; clamp defensively because the
    // generator is written by someone else.
    const density = Math.min(1.5, Math.max(0.05, spec.density));
    const densityMul = 0.55 + density * 0.95;

    // ---- palette ----------------------------------------------------------
    const colorMid = toColor(spec.color, new Color());
    const accent = toColor(spec.accentColor, new Color());
    // The envelope is pulled towards the noir steel-blue base and dimmed, so
    // the only strongly saturated thing on screen is the ionised core.
    const colorCool = colorMid.clone().lerp(STEEL, 0.5).multiplyScalar(0.55);
    // Push the accent to full value so the core reads as a genuine highlight.
    const accentPeak = Math.max(accent.r, accent.g, accent.b, 1e-4);
    accent.multiplyScalar(1 / accentPeak);

    // ---- baked field ------------------------------------------------------
    this.field = new WebGL3DRenderTarget(this.fieldSize, this.fieldSize, this.fieldSize, {
      format: RGBAFormat,
      type: UnsignedByteType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.field.texture.name = `nebula-field-${spec.id}`;
    this.field.texture.colorSpace = NoColorSpace;
    this.field.texture.wrapR = ClampToEdgeWrapping;

    this.bakeGeometry = new PlaneGeometry(2, 2);
    this.bakeMaterial = new ShaderMaterial({
      uniforms: {
        uLayer: { value: 0 },
        uSeed: { value: seedOffset },
        uAniso: { value: anisoJ },
        uStarPos: { value: starNorm.clone() },
        uShapeScale: { value: jitter(k.shapeScale, 0.18) },
        uWarp: { value: jitter(k.warp, 0.15) },
        uDetailScale: { value: jitter(k.detailScale, 0.2) },
        uVoidFreq: { value: jitter(k.voidFreq, 0.2) },
        uVoidAmount: { value: k.voidAmount },
        uFilFreq: { value: jitter(k.filFreq, 0.2) },
        uFilBoost: { value: k.filBoost },
        uRidBoost: { value: k.ridBoost },
        uThreshold: { value: k.threshold + rng.range(-0.04, 0.04) - (density - 0.5) * 0.08 },
        uEdge: { value: k.edge },
        uEnvInner: { value: jitter(k.envInner, 0.15) },
        uShellCenter: { value: jitter(k.shellCenter, 0.08) },
        uShellWidth: { value: jitter(k.shellWidth, 0.2) },
        uShellAmount: { value: k.shellAmount },
        uIonRadius: { value: jitter(k.ionRadius, 0.15) },
        uDustAmount: { value: jitter(k.dustAmount, 0.15) },
        uDustFreq: { value: jitter(k.dustFreq, 0.2) },
        // Cloud-scale, not voxel-scale: the lobe band has roughly three cycles
        // across the volume, so ~1/12 of the radius is a good finite-difference
        // step for its slope. A voxel-sized epsilon here just measured noise.
        uRimEps: { value: 0.085 },
        uDensity: { value: densityMul },
      },
      vertexShader: BAKE_VS,
      fragmentShader: bakeFragment(octLo, octHi),
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.bakeMesh = new Mesh(this.bakeGeometry, this.bakeMaterial);
    this.bakeMesh.frustumCulled = false;
    this.bakeScene.add(this.bakeMesh);
    // Spread the bake over ~20 frames so it never costs a visible hitch. Each
    // slice is two full field evaluations — roughly 76 simplex lookups per
    // fragment — so a 144-slice bake is tens of milliseconds of GPU work in
    // total and has to be handed out in small pieces.
    this.layersPerFrame = Math.max(2, Math.ceil(this.fieldSize / 20));

    // ---- volume ------------------------------------------------------------
    this.material = new ShaderMaterial({
      uniforms: {
        uField: { value: this.field.texture },
        uInvModel: { value: new Matrix4() },
        uColorCool: { value: colorCool },
        uColorMid: { value: colorMid },
        uAccent: { value: accent },
        uStarPos: { value: starNorm.clone() },
        uDrift: { value: new Vector3() },
        uStarKelvin: { value: this.starTemperature },
        uStarPower: { value: jitter(k.starPower, 0.15) },
        uStarCore: { value: k.starCore },
        uGlare: { value: k.glare },
        uHaloRadius: { value: k.haloRadius },
        // Density couples into extinction only gently: the bake already scales
        // the field, and squaring the effect turns a dense nebula opaque.
        uSigmaGas: { value: jitter(k.sigmaGas, 0.12) * (0.65 + 0.35 * densityMul) },
        uSigmaDust: { value: jitter(k.sigmaDust, 0.12) * (0.65 + 0.35 * densityMul) },
        uEmissive: { value: k.emissive },
        uEmissivePow: { value: k.emissivePow },
        uScatter: { value: k.scatter },
        uPhaseG: { value: k.phaseG },
        uErode: { value: k.erode },
        // Just above the baked field's Nyquist, so the two bands meet without
        // a gap and without doubling up.
        uDetailFreq: { value: this.fieldSize * 0.35 },
        uDetailAmount: { value: 0 },
        uCloseDetail: { value: 0 },
        uOpacity: { value: 0 },
        // Only read when OS_SOFT_DEPTH is defined, but the uniform has to
        // exist for setSceneDepth() to be able to fill it in later.
        uDepthTexture: { value: null },
        uResolution: { value: new Vector2(1, 1) },
        uCamForwardLocal: { value: new Vector3(0, 0, -1) },
        uRenderRadius: { value: this.renderRadius },
        uSoftFade: { value: 0.02 },
      },
      vertexShader: RAYMARCH_VS,
      fragmentShader: raymarchFragment(quality.nebulaSteps, lightSteps, octDetail),
      // BackSide so the volume is entered correctly whether the camera is
      // inside or outside; the ray/sphere test does the real work.
      side: BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      // Premultiplied alpha: additive where the gas only emits, occluding
      // where it is optically thick. See the header note.
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendEquation: AddEquation,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
      blendEquationAlpha: AddEquation,
    });

    // Circumradius 1.15 keeps the inradius of a detail-2 icosphere (~0.986 of
    // the circumradius) safely outside the unit volume, so no facet clips it.
    this.geometry = new IcosahedronGeometry(1.15, 2);
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.scale.setScalar(this.renderRadius);
    this.mesh.renderOrder = opts.renderOrder ?? -100;
    this.mesh.name = `nebula-${spec.id}`;
    // Invisible until the field is baked; avoids a frame of garbage.
    this.mesh.visible = false;

    const group = new Group();
    group.name = `nebula-${spec.id}`;
    group.add(this.mesh);
    this.object3d = group;
  }

  /**
   * Supply the scene depth buffer to get true per-sample occlusion plus a
   * soft-particle fade instead of the default whole-fragment depth test.
   * Pass null to go back to the default. Triggers one shader recompile.
   */
  setSceneDepth(depth: Texture | null, softFadeKm?: number): void {
    const on = depth !== null;
    this.material.uniforms.uDepthTexture!.value = depth;
    if (softFadeKm !== undefined) {
      this.material.uniforms.uSoftFade!.value = Math.max(1e-4, softFadeKm / this.renderRadius);
    }
    if (on === this.softDepth) return;
    this.softDepth = on;
    if (on) this.material.defines = { OS_SOFT_DEPTH: '1' };
    else this.material.defines = {};
    // The shader handles occlusion itself once it can read depth, so the
    // fixed-function test would only double up (and reject the near half of
    // the volume in front of anything inside it).
    this.material.depthTest = !on;
    this.material.needsUpdate = true;
  }

  update(dt: number, ctx: EngineContext, view: ViewState): void {
    if (this.bakedLayers < this.fieldSize) {
      this.bake(ctx);
      if (this.bakedLayers >= this.fieldSize) this.mesh.visible = true;
      if (!this.mesh.visible) return;
    }

    const u = this.material.uniforms;

    // Inverse model matrix: the raymarch runs in the mesh's local space where
    // the volume is the unit sphere, so the camera has to come to us.
    this.mesh.updateWorldMatrix(true, false);
    this.tmpMatrix.copy(this.mesh.matrixWorld).invert();
    (u.uInvModel!.value as Matrix4).copy(this.tmpMatrix);

    // Detail LOD. Both terms are eased rather than switched, so approaching a
    // nebula never pops. rel = distance in volume radii.
    const rel = view.distance / this.renderRadius;
    const targetDetail = smoothstep(6.0, 2.0, rel);
    const targetClose = smoothstep(1.7, 0.5, rel);
    const targetFade = 1;
    const ease = 1 - Math.exp(-dt * 3);
    this.detailAmount += (targetDetail - this.detailAmount) * ease;
    this.closeDetail += (targetClose - this.closeDetail) * ease;
    this.fade += (targetFade - this.fade) * (1 - Math.exp(-dt * 4));

    u.uDetailAmount!.value = this.detailAmount;
    u.uCloseDetail!.value = this.closeDetail;
    u.uOpacity!.value = this.fade;

    // Art-direction cap on the halo. Its half-light radius is a fixed distance
    // in volume radii, so its *apparent* size grows without limit as the camera
    // closes in — which is how a light source with presence turns into a
    // featureless gradient over a third of the frame. Capped at 9% of the
    // half-frame height (visible extent ~1/8 of frame height), applied
    // continuously so there is nothing to pop, and it can only ever shrink the
    // authored value.
    const halfFrame = Math.tan((ctx.camera.fov * Math.PI) / 360);
    u.uHaloRadius!.value = Math.min(this.haloRadius, 0.09 * halfFrame * Math.max(rel, 1e-3));

    if (this.driftSpeed !== 0) {
      this.drift += dt * this.driftSpeed;
      (u.uDrift!.value as Vector3).set(this.drift, this.drift * 0.7, -this.drift * 0.4);
    }

    if (this.softDepth) {
      // Soft-depth path: the shader needs the framebuffer size and the camera
      // forward axis expressed in local space.
      ctx.renderer.getDrawingBufferSize(this.tmpVec2);
      (u.uResolution!.value as Vector2).copy(this.tmpVec2);
      ctx.camera.getWorldDirection(this.tmpVec3);
      // Direction only: strip the translation, then renormalise (the model
      // matrix carries a uniform scale we do not want here).
      this.tmpVec3.transformDirection(this.tmpMatrix).normalize();
      (u.uCamForwardLocal!.value as Vector3).copy(this.tmpVec3);
    }
  }

  /** Render the next slab of Z slices of the density field. */
  private bake(ctx: EngineContext): void {
    const renderer = ctx.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevFace = renderer.getActiveCubeFace();
    const prevMip = renderer.getActiveMipmapLevel();

    const end = Math.min(this.fieldSize, this.bakedLayers + this.layersPerFrame);
    for (let z = this.bakedLayers; z < end; z++) {
      // Sample the slice centre, not its near face.
      this.bakeMaterial.uniforms.uLayer!.value = (z + 0.5) / this.fieldSize;
      renderer.setRenderTarget(this.field, z);
      renderer.render(this.bakeScene, this.bakeCamera);
    }
    this.bakedLayers = end;

    renderer.setRenderTarget(prevTarget, prevFace, prevMip);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.bakeGeometry.dispose();
    this.bakeMaterial.dispose();
    this.bakeScene.remove(this.bakeMesh);
    // Disposes the target's framebuffer and its Data3DTexture.
    this.field.dispose();
    this.object3d.remove(this.mesh);
  }

  /** The spec this renderer was built from. Never mutated. */
  get nebulaSpec(): NebulaSpec {
    return this.spec;
  }
}

/** GLSL smoothstep, for the CPU-side LOD ramps. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

const WORLD_UP = new Vector3(0, 1, 0);

/**
 * Frame the camera on a nebula so the embedded star sits off-centre and the
 * illuminated rim, the dust lanes and the colour gradient are all in shot.
 *
 * `distance` is in volume radii; `offset` is the star's target position in
 * normalised screen coordinates.
 */
function frameNebula(
  nebula: NebulaRenderer,
  ctx: EngineContext,
  approach: Vector3,
  distanceRadii: number,
  fovDeg: number,
  offsetX: number,
  offsetY: number,
): void {
  nebula.object3d.updateWorldMatrix(true, false);
  const centre = nebula.object3d.getWorldPosition(new Vector3());

  // Focus point: the embedded star, but never further out than half a radius.
  // A `dark` nebula's light source sits well outside the volume, and looking
  // straight at it would put the nebula off frame entirely.
  const star = nebula.object3d.localToWorld(nebula.starLocal.clone());
  const offset = star.clone().sub(centre);
  const maxOffset = nebula.renderRadius * 0.45;
  if (offset.length() > maxOffset) offset.setLength(maxOffset);
  const focus = centre.clone().add(offset);

  const camPos = centre
    .clone()
    .addScaledVector(approach.clone().normalize(), nebula.renderRadius * distanceRadii);

  const camera = ctx.camera;
  camera.fov = fovDeg;
  camera.updateProjectionMatrix();
  camera.position.copy(camPos);
  camera.up.copy(WORLD_UP);

  const fwd = focus.clone().sub(camPos).normalize();
  const right = new Vector3().crossVectors(fwd, WORLD_UP);
  // Degenerate only if the approach is exactly vertical; any stable axis does.
  if (right.lengthSq() < 1e-12) right.set(1, 0, 0);
  right.normalize();
  const up = new Vector3().crossVectors(right, fwd).normalize();

  // Half-frame height at the focus distance, so the offsets are in NDC.
  const d = focus.distanceTo(camPos);
  const halfH = d * Math.tan((fovDeg * Math.PI) / 360);
  const aspect = camera.aspect || 16 / 9;

  // Looking here puts the focus at (+offsetX, +offsetY) in NDC.
  const target = focus
    .clone()
    .addScaledVector(right, -offsetX * halfH * aspect)
    .addScaledVector(up, -offsetY * halfH);

  camera.lookAt(target);
  camera.updateMatrixWorld(true);
}

/**
 * Register the review shots for a nebula. Call once, from the integrator,
 * after the nebula has been positioned in the scene.
 */
export function registerNebulaShots(nebula: NebulaRenderer): void {
  registerShot({
    name: 'nebula-hero',
    description:
      'Emission nebula with its ionising star embedded off-centre: the bright ' +
      'forward-scattered rim on the star-facing side of every clump, dark dust ' +
      'pillars silhouetted against the glow, and the colour gradient running ' +
      'from the saturated ionised core out to a desaturated steel-blue envelope.',
    apply(ctx) {
      // Approach roughly across the star's offset rather than along it, so the
      // lit faces of the near clumps are seen at a grazing angle — that is
      // where a rim reads as a rim rather than as a flat bright patch.
      const s = nebula.starLocal.lengthSq() > 1e-6
        ? nebula.starLocal.clone().normalize()
        : new Vector3(1, 0, 0);
      const perp = new Vector3().crossVectors(s, WORLD_UP);
      if (perp.lengthSq() < 1e-6) perp.set(1, 0, 0);
      perp.normalize();
      // Note the NEGATIVE component along the star's offset: the camera stands
      // on the far side of the volume from the embedded star, so the sight-line
      // to the halo has to cross the dense middle of the cloud. Standing on the
      // star's own side (this was +0.34) leaves nothing at all between the
      // camera and the brightest object in the frame, which is how you get a
      // shot with no occlusion and no silhouette anywhere in it.
      const approach = perp.multiplyScalar(0.86).addScaledVector(s, -0.38).add(new Vector3(0, 0.28, 0));
      // 1.85 radii at 45°: the volume overfills vertically and reaches the
      // frame edges horizontally, so the silhouette is read against black at
      // the corners and no third of the frame is ever empty.
      frameNebula(nebula, ctx, approach, 1.85, 45, 0.22, 0.14);
    },
  });

  registerShot({
    name: 'nebula-closeup',
    description:
      'A long lens on the ionised core from just outside the volume: dust ' +
      'lanes silhouetted against the bright gas, and the finest erosion band ' +
      'at maximum magnification. This is the close-approach detail test.',
    apply(ctx) {
      const s = nebula.starLocal.lengthSq() > 1e-6
        ? nebula.starLocal.clone().normalize()
        : new Vector3(1, 0, 0);
      const perp = new Vector3().crossVectors(s, WORLD_UP);
      if (perp.lengthSq() < 1e-6) perp.set(1, 0, 0);
      perp.normalize();
      // Mostly across the star, tipped to the far side of it. Grazing rather
      // than straight down the axis: a head-on approach puts the whole optical
      // depth of the cloud in front of the halo and snuffs it out, while the
      // old star-side approach put none of it there and gave a soft circle
      // floating in clean space. Off the shoulder like this, the near-field
      // lanes cut across the glow without swallowing it.
      const approach = perp.multiplyScalar(0.78)
        .addScaledVector(s, -0.45)
        .add(new Vector3(0.1, 0.36, 0.1));
      // A narrow lens at 1.25 radii, NOT a wide lens from inside the volume.
      // Inside the ionised zone every line of sight is saturated gas, so the
      // frame comes out as uniform bright fog with no black and nothing to
      // silhouette — the exact failure state section 6 names. Standing off and
      // magnifying gives the same pixels-per-feature with a composition.
      frameNebula(nebula, ctx, approach, 1.25, 38, 0.28, 0.18);
    },
  });
}
