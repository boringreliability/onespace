/**
 * Sky — everything that is infinitely far away.
 *
 * Three draw calls, in this order:
 *
 *   1. BACKDROP   an inverted unit sphere carrying the galactic band. The band
 *                 is not a texture and not a painted gradient: it is a short
 *                 line-of-sight integral through an analytic disc + bulge +
 *                 spiral-arm emissivity, with a *separate* dust density that
 *                 both extinguishes and reddens the light behind it. That
 *                 integral is what produces the Great Rift for free — the dark
 *                 lane down the middle of the band is the near side of the
 *                 dust disc eating the far side of the star disc, exactly as
 *                 in the real sky. Procedural fBm/worley then breaks the
 *                 result up so it never reads as an analytic function.
 *
 *   2. GALAXIES   a few dozen 2–3 px elliptical smudges. Cheap, and the single
 *                 highest depth-per-byte feature in the whole renderer.
 *
 *   3. STARS      up to `quality.galaxyStarBudget` points, drawn with a real
 *                 point spread function (tight gaussian core + airy-ish skirt
 *                 + 4-point diffraction spikes on the brightest few percent).
 *                 Magnitudes follow a power law and colours follow a
 *                 Malmquist-biased IMF, so the field is overwhelmingly faint
 *                 red dwarfs with a handful of blue-white beacons — the
 *                 distribution, not the count, is what makes a sky read as
 *                 real.
 *
 * RENDER STATE. Everything here is `depthTest:false`, `depthWrite:false`,
 * `frustumCulled:false` and has a very negative `renderOrder`. Note that the
 * star and galaxy materials use additive blending but are declared
 * `transparent:false` *on purpose*: that keeps them in three's opaque queue,
 * which is sorted by renderOrder and drawn before the transparent queue. If
 * they were `transparent:true` they would be drawn after every planet in the
 * scene and, having no depth test, would paint straight over it.
 */

import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  Object3D,
  Points,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type IUniform,
} from 'three';

import type { EngineContext } from '@/core/Engine';
import type { QualitySettings } from '@/core/Config';
import type { GalaxySpec } from '@/gen/types';
import { hashSeed, Rng } from '@/math/rng';
import { registerShot } from '@/game/Shots';
import type { ViewState } from './ViewState';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Radius of the sky shell in km. Far beyond anything the game draws, but
 * comfortably inside the camera's 1e12 far plane so nothing is clipped at the
 * projection stage. The exact value is cosmetic: the shell follows the camera,
 * so it produces no parallax at any distance.
 */
const SKY_RADIUS = 1e9;

/** Sorted first, before anything else in the opaque queue. */
const ORDER_BACKDROP = -1000;
const ORDER_GALAXIES = -960;
const ORDER_STARS = -950;

/**
 * Main-sequence temperature brackets, coolest first. The sky is sampled from
 * these rather than from `SpectralClass` directly because what we need is a
 * continuous temperature to feed a blackbody, not a label.
 */
const CLASS_TEMPS: ReadonlyArray<readonly [number, number]> = [
  [2450, 3700], // M
  [3700, 5200], // K
  [5200, 6000], // G
  [6000, 7500], // F
  [7500, 10000], // A
  [10000, 28000], // B
  [28000, 41000], // O
];

/** Volume-limited IMF: what the faint background of any sky is actually made of. */
const IMF_FAINT: readonly number[] = [0.765, 0.121, 0.076, 0.03, 0.006, 0.0013, 0.00003];

/**
 * Flux-limited counts: the bright naked-eye sky is dominated by intrinsically
 * luminous stars seen from a long way away. This Malmquist bias is the reason
 * Rigel, Sirius and Deneb are blue-white while 3/4 of all stars are red dwarfs
 * you cannot see at all. Blending between the two by apparent flux is what
 * makes the colour distribution look right rather than merely varied.
 */
const IMF_BRIGHT: readonly number[] = [0.02, 0.1, 0.1, 0.14, 0.28, 0.31, 0.05];

// ---------------------------------------------------------------------------
// CPU-side colour helpers (mirrors os_blackbody in shaders/chunks.ts)
// ---------------------------------------------------------------------------

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Blackbody colour, 1000–41000 K. Deliberately the same approximation as
 * `os_blackbody` so a star rendered as a sky point and the same star rendered
 * as a Star surface agree on their hue.
 */
function blackbody(kelvin: number, out: Color): Color {
  const t = kelvin / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 1;
    g = clamp01(0.39008157 * Math.log(t) - 0.63184144);
    b = t <= 19 ? 0 : clamp01(0.54320679 * Math.log(t - 10) - 1.19625408);
  } else {
    r = clamp01(1.29293618 * Math.pow(t - 60, -0.1332047592));
    g = clamp01(1.12989086 * Math.pow(t - 60, -0.0755148492));
    b = 1;
  }
  return out.setRGB(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const BACKDROP_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  // Object space: +Y is the galactic pole, +X points at the galactic centre.
  // Scale-invariant, so the shell can be any radius.
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BACKDROP_FRAG = /* glsl */ `
#include <onespace_noise>
#include <onespace_color>

varying vec3 vDir;

uniform float uBrightness;
uniform vec3  uCoreColor;
uniform vec3  uArmColor;
uniform vec3  uDustColor;
uniform vec3  uVoidColor;
uniform vec3  uNoiseOffset;
uniform float uObsRadius;     // observer distance from the galactic centre, disc radii
uniform float uScaleR;        // radial scale length of the star disc
uniform float uScaleH;        // vertical scale height of the star disc
uniform float uBulge;         // bulge weight
uniform float uBulgeR;        // bulge scale radius
uniform float uArmCount;
uniform float uArmTwist;
uniform float uArmContrast;
uniform float uArmStrength;   // 0 for ellipticals — no arms at all
uniform float uDustK;         // extinction coefficient
uniform float uGain;
uniform float uLaneStrength;
uniform int   uSteps;
uniform int   uOctaves;

/**
 * Wavelength-dependent extinction. Blue is scattered out of the line of sight
 * roughly twice as efficiently as red, which is why the inner Milky Way looks
 * like tarnished brass rather than white.
 */
const vec3 EXTINCTION = vec3(0.78, 1.0, 1.38);
const float MAX_T = 2.35;

void main() {
  // Re-normalise: vDir is a unit vector at each vertex but the interpolant
  // between them is a chord, not an arc, so it is ~0.2% short in the middle of
  // every quad of the 64x32 shell. That error is not uniform — it is zero at
  // the vertices and peaks at the centres — so it rescales the noise lookups
  // discontinuously across quad edges and prints the sphere's own tessellation
  // faintly across the band.
  vec3 dir = normalize(vDir);

  // Observer sits inside the disc, offset from the centre along -X so that +X
  // is the direction of the galactic centre.
  vec3 obs = vec3(-uObsRadius, 0.0, 0.0);

  // Per-pixel jitter on the march. Without it the quadratic step spacing
  // prints visible shells across the band. It must be WHITE noise: an
  // interleaved-gradient dither has visible structure at this amplitude and
  // prints a halftone screen straight across the brightest part of the band.
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);

  vec3 lum = vec3(0.0);
  vec3 tau = vec3(0.0);
  float invN = 1.0 / float(max(uSteps, 1));

  for (int i = 0; i < 64; i++) {
    if (i >= uSteps) break;
    // Quadratic spacing: the disc is thin, so almost all of the structure is
    // within the first few percent of the ray. Uniform steps alias it away.
    float u0 = (float(i) + jitter) * invN;
    float u1 = (float(i) + 1.0 + jitter) * invN;
    float t  = MAX_T * u0 * u0;
    float dt = MAX_T * (u1 * u1 - u0 * u0);

    vec3 p = obs + dir * t;
    float r = length(p.xz);
    float ay = abs(p.y);

    float discD = exp(-r / uScaleR) * exp(-ay / uScaleH);

    // Logarithmic spiral phase. Tangent points — where the ray runs along an
    // arm rather than across it — integrate to far more light, which is what
    // puts the bright knots at particular galactic longitudes.
    //
    // Both terms of the phase diverge at the centre: log(r) runs away, and
    // theta sweeps through pi inside a single march step. Unchecked, the
    // cosine goes through several cycles per step over the ~20 degrees around
    // the galactic centre, and the per-pixel march jitter turns that aliasing
    // into hash noise smeared over the single brightest region of the frame.
    // Real spirals have no arms inside the bar radius anyway, so freezing the
    // radial term and fading the modulation out there is the physically honest
    // fix as well as the cheap one.
    float rSafe = max(r, max(uBulgeR * 0.85, 0.03));
    float theta = atan(p.z, p.x);
    float phase = uArmCount * (theta + log(rSafe) / max(uArmTwist, 0.06));
    float arms = 0.5 + 0.5 * cos(phase);
    arms = pow(arms, 1.0 + 4.5 * uArmContrast);
    float armFade = smoothstep(0.0, uBulgeR * 2.2, r);
    float armF = mix(1.0, 0.30 + 2.1 * arms, uArmStrength * armFade);

    // The bulge is a boxy/peanut bar, not a ball: squashing it towards the
    // plane keeps it part of the band instead of a radial fog centred on the
    // camera, which is what an isotropic gaussian looks like from inside.
    vec3 pb = vec3(p.x, p.y * 2.6, p.z);
    float bulgeD = exp(-dot(pb, pb) / (uBulgeR * uBulgeR)) * uBulge;
    float emitD = discD * armF + bulgeD;

    // Old, metal-rich populations sit in the bulge and inner disc and are
    // intrinsically redder than the arms. Colouring by *radius* as well as by
    // bulge weight is what stops the band averaging out to neutral grey: the
    // inner few kpc glow amber, the outer arms stay steel-blue, and the frame
    // gets its one warm accent against a cold field.
    float bulgeMix = clamp(bulgeD / (bulgeD + discD * 0.55 + 1e-5), 0.0, 1.0);
    float inner = smoothstep(uScaleR * 2.4, uScaleR * 0.35, r);
    vec3 emitC = mix(uArmColor, uCoreColor, max(inner, bulgeMix));

    // Dust hugs the midplane far more tightly than the stars do.
    float dustD = exp(-r / (uScaleR * 1.2)) * exp(-ay / (uScaleH * 0.42));

    lum += emitC * emitD * exp(-tau) * dt;
    tau += uDustK * dustD * EXTINCTION * dt;
  }

  lum *= uGain;

  // --- procedural break-up -------------------------------------------------
  // The integral above is smooth and analytic. Everything that stops it
  // reading as an equation happens here. Every frequency below is chosen in
  // *angular* terms: dir is a unit vector, so a frequency of f gives features
  // about (57/f) degrees across. Anything below f≈6 reads as wallpaper.
  vec3 nd = dir * 2.4 + uNoiseOffset;

  // Large unresolved star clouds, domain-warped so they braid rather than blob.
  float clump = os_fbm(os_warp(nd, 0.40), uOctaves, 2.1, 0.55);
  // ~1° grain falling to ~0.2° on the top tiers: the "not quite resolved"
  // texture of a star cloud. This is the only thing in the backdrop that still
  // has structure at a 40° field, so its octave count has to come off the
  // quality tier rather than being pinned — at 3 octaves the finest feature in
  // the band is 10 px and it goes soft the moment the shot tightens.
  float grain = os_fbm(nd * 11.0, min(uOctaves, 4), 2.3, 0.5);

  lum *= max(0.0, 1.0 + 0.75 * clump + 0.30 * grain);

#ifdef OS_SKY_LANES
  // Dust lanes.
  //
  // Three formulations were tried here and two are wrong, so they are worth
  // naming: worley cells give a honeycomb, and any level set of a noise field
  // (ridged noise, or 1-abs(fbm)) gives constant-width curves that read as
  // contour lines on a map. Dust is neither. It is a *density field*: blobs
  // and streaks with soft edges and wildly varying opacity.
  //
  // So: a domain-warped fBm, biased so only its upper third is opaque, sheared
  // flat in latitude because the disc shears its own dust, and applied as a
  // transmittance rather than a mask so nothing has an edge.
  vec3 lnd = vec3(nd.x, nd.y * 1.8, nd.z);
  float dcloud = os_fbm(os_warp(lnd * 1.5 + 5.13, 0.45), min(uOctaves, 5), 2.3, 0.55);
  // Dust and young stars live in the same places, so the clump field doubles
  // as the "where is the dust thick" field — one fBm instead of two.
  float tauLane = uLaneStrength * 2.6 * max(0.0, dcloud * 1.9 + clump * 0.35 - 0.32);

  // Worley only as ~1.7° granulation, never as structure.
  vec2 w = os_worley(dir * 34.0 + 2.71);
  float micro = smoothstep(0.05, 0.55, w.x);

  lum *= exp(-tauLane) * (0.87 + 0.13 * micro);
  // The lanes are not holes — dust forward-scatters a trace of light back.
  lum += uDustColor * (1.0 - exp(-tauLane)) * 0.03 * dot(lum, vec3(0.33));
#endif

  // --- galactic cirrus -----------------------------------------------------
  // High-latitude dust sheets, lit from below by the integrated light of the
  // whole disc. This is the wispy structure that fills the "empty" half of any
  // long-exposure sky, and it is the answer to the one real composition
  // failure this module had: off the band, every pixel was the void colour at
  // ~3/255 and half the frame was a dead flat field.
  //
  // Sheared 2.2x flat in latitude because galactic rotation shears the sheets
  // flat, which also makes the wisps run parallel to the band instead of
  // crossing it. Base frequency is 8.6 — ~6.6 degrees — because anything below
  // ~6 reads as wallpaper: at 5.6 these were quarter-frame brown blobs in the
  // 40-degree shot rather than filaments.
  vec3 cd = vec3(dir.x * 8.6, dir.y * 19.0, dir.z * 8.6) + 17.3;
  // Bias hard: roughly the top tenth of the field survives the threshold, so
  // the cirrus covers a small fraction of the sky brightly rather than all of
  // it faintly. Dust is rationed like every other colour here — at a softer
  // bias this reads as a blanket of grey cotton over the whole frame.
  float cirrus = max(0.0, os_fbm(cd, min(uOctaves, 4), 2.35, 0.52) * 2.2 - 0.74);
  float cirrusLat = mix(0.18, 1.0, 1.0 - smoothstep(0.12, 0.85, abs(dir.y)));
  // Ash, not orange. Painting this in raw uDustColor puts a faint warm wash
  // over the entire off-band sky, which puts a second warm mass on screen and
  // steals the one saturated accent the band is supposed to own. Pulling it
  // most of the way back to the steel base keeps the amber unique to the core.
  vec3 cirrusC = mix(vec3(0.40, 0.46, 0.58), uDustColor, 0.45);
  lum += cirrusC * (cirrus * cirrusLat * 0.042);

  // --- void ---------------------------------------------------------------
  // Intergalactic background: near black, faintly steel-blue, never flat.
  float voidN = os_fbm(dir * 1.7 + 31.7, 3, 2.1, 0.5);
  vec3 base = uVoidColor * (0.7 + 0.6 * (voidN * 0.5 + 0.5));

  vec3 col = base + lum * uBrightness;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
  #include <colorspace_fragment>
  // Dither AFTER the output transform: a 1/255 step is only meaningful in the
  // space the framebuffer actually quantises. This is the difference between a
  // nebulous band and six visible contour rings.
  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`;

const STAR_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aFlux;
attribute float aSize;
attribute float aSpike;
attribute vec2 aTwinkle;

uniform float uPixelScale;
uniform float uBrightness;
uniform float uTwinkle;
uniform float uTime;

varying vec3 vColor;
varying float vSize;
varying float vSpike;

void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

  float flux = aFlux;
  vec3 col = aColor;

  // Scintillation. In vacuum uTwinkle is 0 and stars are rock steady; the
  // integrator raises it as the camera descends into an atmosphere.
  if (uTwinkle > 0.001) {
    float s = sin(uTime * aTwinkle.y + aTwinkle.x) * 0.62
            + sin(uTime * aTwinkle.y * 2.31 + aTwinkle.x * 2.7) * 0.38;
    // Faint stars scintillate harder — less flux to average the wavefront out.
    float amp = uTwinkle * (0.40 + 0.34 * (1.0 - clamp(flux * 3.0, 0.0, 1.0)));
    flux *= max(0.12, 1.0 + s * amp);
    // Atmospheric dispersion splits the image: the prismatic red/blue flicker.
    col = mix(col, col * vec3(1.0 - 0.28 * s, 1.0, 1.0 + 0.32 * s), uTwinkle * 0.85);
  }

  // Point size is in framebuffer pixels, so it must track the pixel ratio if
  // the star is to keep a constant angular size at any resolution.
  gl_PointSize = clamp(aSize * uPixelScale, 1.0, 64.0);
  vSize = gl_PointSize;
  vSpike = aSpike;
  vColor = col * flux * uBrightness;
}
`;

const STAR_FRAG = /* glsl */ `
#include <onespace_color>

varying vec3 vColor;
varying float vSize;
varying float vSpike;

/**
 * Core sigma in PIXELS, not in point-coord units. Keeping the PSF fixed in
 * pixels and letting flux drive the quad size is what a real optical system
 * does: every star has the same tiny core, the bright ones simply push more of
 * that core above the display threshold. Sizing the gaussian to the quad
 * instead is the classic "fat blurry blobs" failure.
 */
const float SIGMA = 0.62;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float rp = length(d) * vSize;          // pixels from the centre

  float core = exp(-0.5 * rp * rp / (SIGMA * SIGMA));
  // Airy-ish skirt. Tiny amplitude, long tail — this is what gives a bright
  // star its halo instead of a hard edge.
  float halo = 0.055 * exp(-rp * 0.62);
  float psf = core + halo;

  if (vSpike > 0.0) {
    vec2 ap = abs(d) * vSize;
    // Axial falloff must die inside the quad. At 0.30 the spike of a
    // magnitude-0 star is still worth ~30/255 where gl_PointCoord runs out,
    // and a point sprite has no way to draw past its own edge: every beacon in
    // the sky ends its four spikes in a hard square stub. 0.42 puts the same
    // spike below the 8-bit floor by the quad edge and still reads as a
    // ~12 px arm at 1080p.
    float sx = exp(-ap.y * ap.y * 1.55) * exp(-ap.x * 0.42);
    float sy = exp(-ap.x * ap.x * 1.55) * exp(-ap.y * 0.42);
    psf += (sx + sy) * vSpike * 0.90;
  }

  // Belt and braces on the same problem: feather everything to zero at the
  // quad boundary in the square metric (so the round core is untouched). This
  // is what keeps the spikes clean when the driver clamps gl_PointSize — at a
  // pixel ratio of 2 the biggest stars hit the 64 px ceiling and the sprite is
  // smaller than the PSF asked for.
  psf *= 1.0 - smoothstep(0.30, 0.5, max(abs(d.x), abs(d.y)));

  vec3 col = vColor * psf;
  if (max(col.r, max(col.g, col.b)) < 0.0008) discard;

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`;

const GALAXY_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aAngle;
attribute float aAxis;

uniform float uPixelScale;
uniform float uBrightness;

varying vec3 vColor;
varying float vAngle;
varying float vAxis;

void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uPixelScale, 2.0, 48.0);
  vColor = aColor * uBrightness;
  vAngle = aAngle;
  vAxis = aAxis;
}
`;

const GALAXY_FRAG = /* glsl */ `
#include <onespace_color>

varying vec3 vColor;
varying float vAngle;
varying float vAxis;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float c = cos(vAngle);
  float s = sin(vAngle);
  vec2 q = vec2(c * d.x - s * d.y, s * d.x + c * d.y);
  q.y /= max(vAxis, 0.12);               // squash the disc into an ellipse
  float r = length(q) * 2.0;

  // de Vaucouleurs-ish: a diffuse envelope with a much tighter nucleus.
  float envelope = exp(-r * r * 5.2);
  float nucleus = exp(-r * r * 62.0);
  float v = envelope * 0.5 + nucleus * 1.5;

  vec3 col = vColor * v;
  if (max(col.r, max(col.g, col.b)) < 0.0006) discard;

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`;

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

export class Sky {
  /** Add this to the scene yourself — Sky never touches ctx.scene. */
  readonly object3d: Object3D;

  /** Number of star points actually built. */
  readonly starCount: number;

  private readonly group: Group;
  private readonly backdrop: Mesh;
  private readonly stars: Points;
  private readonly galaxies: Points;

  private readonly backdropMat: ShaderMaterial;
  private readonly starMat: ShaderMaterial;
  private readonly galaxyMat: ShaderMaterial;

  // Shared uniform cells: one object referenced by several materials, so a
  // write costs one assignment rather than a loop.
  private readonly uTime: IUniform<number> = { value: 0 };
  private readonly uBrightness: IUniform<number> = { value: 1 };
  private readonly uTwinkle: IUniform<number> = { value: 0 };
  private readonly uPixelScale: IUniform<number> = { value: 1 };

  private brightnessTarget = 1;
  private twinkleTarget = 0;

  /**
   * When true the shell is re-centred on the camera every frame, which is what
   * makes it behave as if it were at infinity. Turn it off only if you parent
   * the sky to something that already follows the camera.
   */
  followCamera = true;

  // Preallocated scratch — update() must never allocate.
  private readonly tmpColor = new Color();

  constructor(galaxy: GalaxySpec, quality: QualitySettings) {
    this.group = new Group();
    this.group.frustumCulled = false;
    this.object3d = this.group;

    const rng = new Rng(hashSeed(galaxy.seed, 'sky'));

    // --- backdrop ---------------------------------------------------------
    const steps = clamp(Math.round(quality.nebulaSteps * 0.62), 16, 56);
    const octaves = quality.tier === 'low' ? 3 : quality.tier === 'medium' ? 4 : quality.tier === 'high' ? 5 : 6;

    // Ellipticals have no disc and no arms; irregulars have a fat, chaotic one.
    const shape = galaxy.shape;
    const armStrength =
      shape === 'elliptical' ? 0 : shape === 'irregular' ? 0.4 : shape === 'ring' ? 0.7 : 1;
    // An elliptical has no thin disc, so its glow covers the WHOLE sky rather
    // than a 15° stripe. At spiral gain that fills the frame with fog and
    // destroys the contrast the whole art direction rests on — it has to be
    // very much dimmer to occupy that much more solid angle — a frame with no
    // black left in it has lost the contrast the whole art direction rests on.
    // It is
    // also essentially dust-free: gas-poor, so no lanes and no reddening.
    const isElliptical = shape === 'elliptical';
    const gain = isElliptical ? 0.0075 : shape === 'irregular' ? 0.085 : 0.105;
    const laneStrength = isElliptical ? 0.1 : shape === 'irregular' ? 0.8 : 1;
    // thickness/radius is the honest aspect ratio of the disc; ellipticals are
    // forced spheroidal so the band becomes a broad glow instead of a stripe.
    const scaleH =
      shape === 'elliptical'
        ? 0.55
        : clamp((galaxy.thicknessLy / Math.max(galaxy.radiusLy, 1)) * 1.6, 0.012, 0.30);

    const geoBackdrop = new SphereGeometry(1, 64, 32);
    this.backdropMat = new ShaderMaterial({
      name: 'os-sky-backdrop',
      side: BackSide,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      toneMapped: false,
      defines: quality.tier === 'low' ? {} : { OS_SKY_LANES: '1' },
      uniforms: {
        uBrightness: this.uBrightness,
        uCoreColor: { value: new Color(...galaxy.coreColor) },
        uArmColor: { value: new Color(...galaxy.armColor) },
        uDustColor: { value: new Color(...galaxy.dustColor) },
        // Near-black steel blue. Noir base: the void is never grey.
        uVoidColor: { value: new Color(0.0006, 0.0010, 0.0019) },
        uNoiseOffset: {
          value: new Vector3(rng.range(-40, 40), rng.range(-40, 40), rng.range(-40, 40)),
        },
        uObsRadius: { value: rng.range(0.5, 0.66) },
        uScaleR: { value: isElliptical ? 0.42 : 0.20 },
        uScaleH: { value: scaleH },
        uBulge: { value: clamp(galaxy.bulgeFraction * 3.0, 0.12, 2.0) },
        uBulgeR: { value: isElliptical ? 0.5 : 0.17 },
        uArmCount: { value: Math.max(1, galaxy.armCount) },
        uArmTwist: { value: Math.max(0.06, galaxy.armTwist) },
        uArmContrast: { value: clamp01(galaxy.armContrast) },
        uArmStrength: { value: armStrength },
        uDustK: { value: isElliptical ? 0.35 : 4.0 },
        uGain: { value: gain },
        uLaneStrength: { value: laneStrength },
        uSteps: { value: steps },
        uOctaves: { value: octaves },
      },
      vertexShader: BACKDROP_VERT,
      fragmentShader: BACKDROP_FRAG,
    });
    this.backdrop = new Mesh(geoBackdrop, this.backdropMat);
    this.backdrop.scale.setScalar(SKY_RADIUS);
    this.backdrop.frustumCulled = false;
    this.backdrop.renderOrder = ORDER_BACKDROP;
    this.group.add(this.backdrop);

    // --- stars ------------------------------------------------------------
    const count = Math.max(1000, Math.floor(quality.galaxyStarBudget));
    this.starCount = count;
    const starGeo = this.buildStars(count, rng.fork('stars'), scaleH);
    this.starMat = new ShaderMaterial({
      name: 'os-sky-stars',
      depthTest: false,
      depthWrite: false,
      // See the file header: additive but NOT transparent, so it stays in the
      // opaque queue and is drawn before every planet in the scene.
      transparent: false,
      blending: AdditiveBlending,
      toneMapped: false,
      uniforms: {
        uBrightness: this.uBrightness,
        uPixelScale: this.uPixelScale,
        uTwinkle: this.uTwinkle,
        uTime: this.uTime,
      },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
    });
    this.stars = new Points(starGeo, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = ORDER_STARS;
    this.group.add(this.stars);

    // --- distant galaxies --------------------------------------------------
    const galaxyGeo = this.buildGalaxies(rng.fork('galaxies'));
    this.galaxyMat = new ShaderMaterial({
      name: 'os-sky-galaxies',
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: AdditiveBlending,
      toneMapped: false,
      uniforms: {
        uBrightness: this.uBrightness,
        uPixelScale: this.uPixelScale,
      },
      vertexShader: GALAXY_VERT,
      fragmentShader: GALAXY_FRAG,
    });
    this.galaxies = new Points(galaxyGeo, this.galaxyMat);
    this.galaxies.frustumCulled = false;
    this.galaxies.renderOrder = ORDER_GALAXIES;
    this.group.add(this.galaxies);
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  private buildStars(count: number, rng: Rng, scaleH: number): BufferGeometry {
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const flux = new Float32Array(count);
    const size = new Float32Array(count);
    const spike = new Float32Array(count);
    const twinkle = new Float32Array(count * 2);

    const c = this.tmpColor;
    // Concentration of the faint field towards the galactic plane. Derived
    // from the disc aspect ratio so a thick, chaotic galaxy gets a thick,
    // chaotic star band and the points agree with the backdrop behind them.
    const latScale = clamp(scaleH * 3.2, 0.05, 0.55);
    const weights = new Float64Array(CLASS_TEMPS.length);

    for (let i = 0; i < count; i++) {
      // --- apparent flux -------------------------------------------------
      // dN/dF ~ F^-2.4. A uniform brightness field is the single loudest tell
      // of a fake sky; this makes 95% of the field a faint granular wash and
      // leaves a few dozen genuine beacons.
      const f = rng.power(0.0022, 1, -2.4);

      // --- direction ------------------------------------------------------
      // The brightest fraction of a percent are nearby stars and are
      // essentially isotropic; the faint bulk is the distant disc population
      // and hugs the band, which is why star density visibly rises into it.
      let x: number;
      let y: number;
      let z: number;
      if (f > 0.12 || rng.next() > 0.72) {
        const s = rng.onSphere();
        x = s[0];
        y = s[1];
        z = s[2];
      } else {
        // Laplace in sin(b): a cusped, exponential-winged latitude profile.
        const u = rng.next();
        const sb = clamp(-latScale * Math.log(1 - u) * (rng.chance(0.5) ? 1 : -1), -0.999, 0.999);
        // Longitude biased towards the galactic centre (+X), where the line of
        // sight passes through the most disc.
        const l = rng.chance(0.45) ? rng.gaussian(0, 0.95) : rng.range(-Math.PI, Math.PI);
        const cb = Math.sqrt(Math.max(0, 1 - sb * sb));
        x = cb * Math.cos(l);
        y = sb;
        z = cb * Math.sin(l);
      }
      pos[i * 3] = x * SKY_RADIUS;
      pos[i * 3 + 1] = y * SKY_RADIUS;
      pos[i * 3 + 2] = z * SKY_RADIUS;

      // --- temperature ------------------------------------------------------
      const bias = Math.min(1, Math.pow(f / 0.25, 0.6));
      let total = 0;
      for (let k = 0; k < CLASS_TEMPS.length; k++) {
        const w = IMF_FAINT[k] * (1 - bias) + IMF_BRIGHT[k] * bias;
        weights[k] = w;
        total += w;
      }
      let pick = rng.next() * total;
      let cls = 0;
      for (let k = 0; k < CLASS_TEMPS.length; k++) {
        pick -= weights[k];
        if (pick <= 0) {
          cls = k;
          break;
        }
        cls = k;
      }
      const bracket = CLASS_TEMPS[cls];
      let temp = rng.range(bracket[0], bracket[1]);

      // A minority of the bright stars are red giants, not hot dwarfs. Without
      // them every beacon in the sky is blue-white and the frame loses its
      // amber accents — Betelgeuse, Antares and Aldebaran do a lot of work.
      if (f > 0.12 && rng.chance(0.20)) temp = rng.range(3000, 4400);

      blackbody(temp, c);
      // Normalise to unit peak so aFlux alone controls brightness.
      const m = Math.max(c.r, c.g, c.b, 1e-4);
      c.setRGB(c.r / m, c.g / m, c.b / m);
      // Faint stars read as colourless to the eye; bright ones show their hue.
      const wash = 0.46 - 0.31 * Math.sqrt(f);
      col[i * 3] = c.r + (1 - c.r) * wash;
      col[i * 3 + 1] = c.g + (1 - c.g) * wash;
      col[i * 3 + 2] = c.b + (1 - c.b) * wash;

      // --- PSF footprint ---------------------------------------------------
      // Quad size only has to contain the visible part of a fixed PSF, so it
      // grows slowly with flux.
      const sp = f > 0.05 ? clamp((f - 0.05) / 0.45, 0, 1) : 0;
      flux[i] = f;
      spike[i] = sp * sp;
      size[i] = clamp((2.6 + 16 * Math.pow(f, 0.38)) * (1 + 0.55 * sp), 3, 30);

      twinkle[i * 2] = rng.range(0, Math.PI * 2);
      twinkle[i * 2 + 1] = rng.range(1.6, 5.4);
    }

    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('aColor', new Float32BufferAttribute(col, 3));
    g.setAttribute('aFlux', new Float32BufferAttribute(flux, 1));
    g.setAttribute('aSize', new Float32BufferAttribute(size, 1));
    g.setAttribute('aSpike', new Float32BufferAttribute(spike, 1));
    g.setAttribute('aTwinkle', new Float32BufferAttribute(twinkle, 2));
    // No bounding sphere is ever needed: frustumCulled is false.
    g.boundingSphere = null;
    return g;
  }

  private buildGalaxies(rng: Rng): BufferGeometry {
    const n = rng.int(55, 90);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const angle = new Float32Array(n);
    const axis = new Float32Array(n);

    let written = 0;
    // A generous attempt budget: the zone-of-avoidance rejection below throws
    // away roughly a fifth of candidates.
    for (let attempt = 0; attempt < n * 12 && written < n; attempt++) {
      const [x, y, z] = rng.onSphere();
      // Zone of avoidance: our own galaxy's dust hides everything behind the
      // band. Leaving the band clear of smudges is a detail almost nobody
      // renders and it reads as authenticity even when nobody can name why.
      if (Math.abs(y) < 0.21) continue;

      pos[written * 3] = x * SKY_RADIUS;
      pos[written * 3 + 1] = y * SKY_RADIUS;
      pos[written * 3 + 2] = z * SKY_RADIUS;

      // Mostly old ellipticals (ivory, slightly warm); a few blue spirals.
      const spiral = rng.chance(0.3);
      const b = rng.power(0.014, 0.22, -1.6);
      if (spiral) {
        col[written * 3] = b * 0.80;
        col[written * 3 + 1] = b * 0.90;
        col[written * 3 + 2] = b * 1.0;
        axis[written] = rng.range(0.16, 0.7);
      } else {
        col[written * 3] = b * 1.0;
        col[written * 3 + 1] = b * 0.93;
        col[written * 3 + 2] = b * 0.83;
        axis[written] = rng.range(0.45, 0.95);
      }
      size[written] = rng.range(6, 15) * (1 + (rng.chance(0.14) ? 0.9 : 0));
      angle[written] = rng.range(0, Math.PI);
      written++;
    }

    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('aColor', new Float32BufferAttribute(col, 3));
    g.setAttribute('aSize', new Float32BufferAttribute(size, 1));
    g.setAttribute('aAngle', new Float32BufferAttribute(angle, 1));
    g.setAttribute('aAxis', new Float32BufferAttribute(axis, 1));
    g.setDrawRange(0, written);
    g.boundingSphere = null;
    return g;
  }

  // -------------------------------------------------------------------------
  // Public controls
  // -------------------------------------------------------------------------

  /** Orient the sky. The galactic pole is local +Y, the galactic centre local +X. */
  setRotation(q: Quaternion): void {
    this.group.quaternion.copy(q);
  }

  /**
   * Master brightness, 0..1+. Daylight and thick atmosphere drive this to 0 to
   * wash the stars out. Damped internally, so it is safe to snap.
   */
  setBrightness(v: number): void {
    this.brightnessTarget = Math.max(0, v);
  }

  /**
   * Atmospheric scintillation, 0 in vacuum. Drive it from the local air
   * density — stars only twinkle when there is something for them to twinkle
   * through.
   */
  setTwinkle(v: number): void {
    this.twinkleTarget = clamp01(v);
  }

  /** Immediately match the targets, skipping the damping. Use on teleports. */
  snap(): void {
    this.uBrightness.value = this.brightnessTarget;
    this.uTwinkle.value = this.twinkleTarget;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, ctx: EngineContext, view: ViewState): void {
    // Re-centre on the camera. Objects at infinity have no parallax; doing it
    // here rather than with a huge radius also keeps every vertex well inside
    // float32's comfortable range.
    if (this.followCamera) this.group.position.copy(ctx.camera.position);

    this.uTime.value = view.time;
    // gl_PointSize is in framebuffer pixels, so the PSF must follow the pixel
    // ratio (which already folds in renderScale and the adaptive controller).
    this.uPixelScale.value = ctx.renderer.getPixelRatio();

    // Critically damped, frame-rate independent. Nothing snaps.
    const kB = 1 - Math.exp(-4.5 * dt);
    const kT = 1 - Math.exp(-2.2 * dt);
    this.uBrightness.value += (this.brightnessTarget - this.uBrightness.value) * kB;
    this.uTwinkle.value += (this.twinkleTarget - this.uTwinkle.value) * kT;
  }

  dispose(): void {
    this.backdrop.geometry.dispose();
    this.stars.geometry.dispose();
    this.galaxies.geometry.dispose();
    this.backdropMat.dispose();
    this.starMat.dispose();
    this.galaxyMat.dispose();
    this.group.clear();
  }
}

// ---------------------------------------------------------------------------
// Hero shots
// ---------------------------------------------------------------------------

// Preallocated so the shot allocates nothing per frame.
const SHOT_Q = new Quaternion();
const SHOT_DIR = new Vector3();
const SHOT_ROLL_AXIS = new Vector3(0, 0, 1);
const SHOT_IDENTITY = new Quaternion();
let shotFov = 55;

/**
 * Aim the camera at a galactic longitude/latitude and roll it.
 *
 * The band is deliberately not level: a horizon-parallel band reads as a
 * matte painting, a diagonal one reads as a spacecraft with attitude.
 */
function aim(ctx: EngineContext, longitude: number, latitude: number, roll: number, fov: number): void {
  const cb = Math.cos(latitude);
  SHOT_DIR.set(cb * Math.cos(longitude), Math.sin(latitude), cb * Math.sin(longitude));
  ctx.camera.position.set(0, 0, 0);
  ctx.camera.up.set(0, 1, 0);
  ctx.camera.lookAt(SHOT_DIR);
  ctx.camera.rotateOnAxis(SHOT_ROLL_AXIS, roll);
  SHOT_Q.copy(ctx.camera.quaternion);
  shotFov = fov;
  hold(ctx);
}

/**
 * Re-assert the whole camera state, every frame while a shot is active.
 *
 * Other modules in the scene drive the camera (the bootstrap placeholder spins
 * `rotation.y`; a camera rig will damp towards the ship). A shot is a contract
 * that the frame is reproducible, so it has to win — including the field of
 * view, which `apply()` alone cannot defend.
 */
function hold(ctx: EngineContext): void {
  ctx.camera.position.set(0, 0, 0);
  ctx.camera.quaternion.copy(SHOT_Q);
  if (ctx.camera.fov !== shotFov) {
    ctx.camera.fov = shotFov;
    ctx.camera.updateProjectionMatrix();
  }
}

export function registerSkyShots(sky: Sky): void {
  registerShot({
    name: 'sky-galactic-band',
    description:
      'Looking along the galactic plane, 17° off the core and rolled 19°. ' +
      'Judges the band, the dust lanes cut into it, the extinction-reddened ' +
      'bulge and the star magnitude/colour distribution in a single frame.',
    apply(ctx) {
      sky.setRotation(SHOT_IDENTITY);
      sky.setBrightness(1);
      sky.setTwinkle(0); // vacuum: rock steady
      sky.snap();
      // Core off to one side, plane just below centre so the rift cuts the
      // lower third and the frame is never a flat black field.
      aim(ctx, 0.30, 0.055, -0.33, 55);
    },
    update(_dt, ctx) {
      hold(ctx);
    },
  });

  registerShot({
    name: 'sky-galactic-core',
    description:
      'Straight down the barrel at the galactic bulge. Maximum band luminance ' +
      'and maximum extinction — the test for banding, dither quality and the ' +
      'amber/steel colour split.',
    apply(ctx) {
      sky.setRotation(SHOT_IDENTITY);
      sky.setBrightness(1);
      sky.setTwinkle(0);
      sky.snap();
      aim(ctx, 0.03, 0.015, 0.20, 46);
    },
    update(_dt, ctx) {
      hold(ctx);
    },
  });

  registerShot({
    name: 'sky-star-field',
    description:
      'Tight 40° field on the shoulder of the band, with atmospheric ' +
      'scintillation running — the close-up test for the point spread ' +
      'function, the diffraction spikes, the blackbody colour spread and the ' +
      'distant-galaxy smudges against near-black.',
    apply(ctx) {
      sky.setRotation(SHOT_IDENTITY);
      sky.setBrightness(1);
      sky.setTwinkle(0.7);
      sky.snap();
      aim(ctx, 0.95, 0.105, 0.30, 40);
    },
    update(_dt, ctx) {
      hold(ctx);
    },
  });
}
