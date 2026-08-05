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
  DoubleSide,
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
/** After the sky, before everything the simulation draws. */
const ORDER_CANOPY = -900;

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

/**
 * Grey optical depth beyond which the extinction stops *reddening* and only
 * darkens.
 *
 * exp(-tau * EXTINCTION) has a blue/red ratio of 1.77 per unit tau, so it
 * diverges: a sightline that crosses two disc scale lengths comes out at
 * tau ~ 3 and its blue channel is 6x more attenuated than its red. Every pixel
 * of the inner galaxy then lands on the same brass hue and the frame is a
 * sepia photograph — which is exactly what happened. The physics runs out
 * before the maths does: past tau ~ 1 you are no longer looking at the far
 * side through the dust at all, you are looking at the near side plus the
 * light the dust scatters, and neither of those keeps getting redder. Capping
 * only the *chromatic* part keeps the rift as black as the integral says while
 * freezing its colour, so amber stays a rationed accent instead of a filter.
 */
const float TAU_CHROMA = 1.25;

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
  // Grey optical depth. Accumulating a scalar and colouring it at use time is
  // both cheaper than a vec3 and the only way to cap the reddening (TAU_CHROMA)
  // without also capping how dark a lane is allowed to get.
  float tau = 0.0;
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
    float q2 = dot(pb, pb) / (uBulgeR * uBulgeR);
    // Envelope PLUS a nuclear concentration. A single gaussian bulge does not
    // integrate to a *core*, it integrates to a plateau: the brightest twenty
    // degrees of the core shot all landed within a few percent of each other,
    // so the frame had a lift where its light source should be and nothing for
    // bloom to catch. Real bulges are cuspy — the nuclear star cluster is
    // orders of magnitude denser than the spheroid around it — and that cusp is
    // the whole difference between a core and a fog.
    //
    // The 8.0 is a resolution floor, not a taste call: it puts the nucleus
    // e-folding radius at uBulgeR/2.83, which is 2-3 march steps wide at the
    // lowest step count. Anything tighter falls between samples and the
    // per-pixel jitter turns the brightest object in the frame into hash noise.
    float bulgeD = uBulge * (exp(-q2) + 11.0 * exp(-q2 * 8.0));
    float emitD = discD * armF + bulgeD;

    // Old, metal-rich populations sit in the bulge and inner disc and are
    // intrinsically redder than the arms. Colouring by *radius* as well as by
    // bulge weight is what stops the band averaging out to neutral grey: the
    // inner few kpc glow amber, the outer arms stay steel-blue, and the frame
    // gets its one warm accent against a cold field.
    float bulgeMix = clamp(bulgeD / (bulgeD + discD * 0.55 + 1e-5), 0.0, 1.0);
    // 0.9 -> 0.25 scale lengths, not 2.4 -> 0.35. The old ramp blended towards
    // uCoreColor across more of the sky than the observer can even see past, so
    // the amber was not an accent, it was the base coat. Confining it to the
    // inner disc is what leaves uArmColor owning the rest of the frame — and
    // uArmColor is a 11000 K population, i.e. the cold half of the palette.
    float inner = smoothstep(uScaleR * 0.9, uScaleR * 0.25, r);
    vec3 emitC = mix(uArmColor, uCoreColor, max(inner, bulgeMix));

    // Dust hugs the midplane far more tightly than the stars do.
    float dustD = exp(-r / (uScaleR * 1.2)) * exp(-ay / (uScaleH * 0.42));

    vec3 te = vec3(tau) + (EXTINCTION - 1.0) * min(tau, TAU_CHROMA);
    lum += emitC * emitD * exp(-te) * dt;
    tau += uDustK * dustD * dt;
  }

  lum *= uGain;

  // --- procedural break-up -------------------------------------------------
  // The integral above is smooth and analytic. Everything that stops it
  // reading as an equation happens here. Every frequency below is chosen in
  // *angular* terms: dir is a unit vector, so a frequency of f gives features
  // about (57/f) degrees across. Anything below f≈6 reads as wallpaper.
  vec3 nd = dir * 2.4 + uNoiseOffset;

  // COMPOSITION SCALE, f<1. ~70 degree features, so the band has an overall
  // *shape* — a heavy half and a thin half, a bright shoulder, a fade — rather
  // than an even glow with texture on it. Everything else in this block lives
  // between f=2 and f=300; with nothing below f=1 the frame reads as noise on a
  // sphere at any distance you stand back from it, which is precisely the
  // failure the detail-at-every-scale rule exists to catch.
  float mass = os_fbm(dir * 0.78 + uNoiseOffset * 0.21, 3, 2.05, 0.5);

  // Large unresolved star clouds, domain-warped so they braid rather than blob.
  float clump = os_fbm(os_warp(nd, 0.40), uOctaves, 2.1, 0.55);
  // ~1° grain falling to ~0.2° on the top tiers: the "not quite resolved"
  // texture of a star cloud. This is the only thing in the backdrop that still
  // has structure at a 40° field, so its octave count has to come off the
  // quality tier rather than being pinned — at 3 octaves the finest feature in
  // the band is 10 px and it goes soft the moment the shot tightens.
  float grain = os_fbm(nd * 11.0, min(uOctaves, 4), 2.3, 0.5);

  // FILAMENT SCALE, f~50 rising to f~340 on the top octave. The zero set of a
  // noise field is a thin curve, so 1 - abs(fbm) scaled up hard is a web of
  // threads a few pixels wide, not another cloud. Applied multiplicatively at
  // low amplitude it never lifts black; it just stops the band being soft mush
  // the moment a shot tightens past 40 degrees. This is the *only* term in the
  // backdrop with structure finer than half a degree.
  float fil = clamp(1.0 - abs(os_fbm(nd * 21.0 + 3.7, min(uOctaves, 3), 2.6, 0.5)) * 3.4, 0.0, 1.0);

  lum *= max(0.0, 1.0 + 0.85 * mass + 0.62 * clump + 0.26 * grain) * (0.84 + 0.30 * fil);

  // Transmittance of the dust lanes, so the cirrus below cannot paint them
  // back in from the front. 1.0 when the lane block is compiled out.
  float laneT = 1.0;

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
  // Confine the lanes to where there is actually dust to make them out of.
  // tau came out of the march above as the grey dust column along this ray,
  // so this costs nothing and it is the difference between lanes that are cut
  // INTO the band — fading out with it at the edges, exactly as the analytic
  // rift does — and a noise field that happens to be laid over the top of it.
  tauLane *= 1.0 - exp(-tau * 1.6);

  // The ~1.7° worley granulation that used to live here is gone. It cost 27
  // hash33 evaluations per fragment to deliver a +-13% multiplier at 1.7°,
  // which is inside the same one-decade band everything else in this shader was
  // already crowded into — it was buying more of the frequency the frame had
  // too much of, at the highest price in the file. The ridged fil term above
  // does the same job an octave and a half finer for three snoise, and paying
  // for it out of this budget keeps the backdrop cheaper than it was.
  laneT = exp(-tauLane);
  lum *= laneT;
  // The lanes are not holes — dust forward-scatters a trace of light back.
  // Deliberately tiny: at any larger weight this is an additive term inside the
  // one part of the frame whose entire job is to be subtractive.
  lum += uDustColor * (1.0 - laneT) * 0.03 * dot(lum, vec3(0.33));
#endif

  // --- galactic cirrus -----------------------------------------------------
  // High-latitude dust sheets, lit from below by the integrated light of the
  // whole disc. This is the wispy structure that fills the "empty" half of any
  // long-exposure sky, and it is the answer to the one real composition
  // failure this module had: off the band, every pixel was the void colour at
  // ~3/255 and half the frame was a dead flat field.
  //
  // Sheared 2.3x flat in latitude because galactic rotation shears the sheets
  // flat, which also makes the wisps run parallel to the band instead of
  // crossing it. Base frequency 6.4 — ~9 degrees — with the warp below doing
  // the work that the old, higher base frequency was trying to do on its own.
  vec3 cd = vec3(dir.x * 6.4, dir.y * 15.0, dir.z * 6.4) + 17.3;
  // WARPED, not plain. A hard threshold on an unwarped fBm produces round blobs
  // at one frequency and one size, and with the 2.2x latitude shear on top they
  // came out as ~250 pale, comma-shaped, near-identical puffs per frame — the
  // single loudest thing in every image this module shipped. It read as lint on
  // the lens. The warp tears the level set into sheets and streaks with a real
  // spread of sizes; that is the fix, not turning the amplitude down.
  float cirrusN = os_fbm(os_warp(cd, 0.55), min(uOctaves, 4), 2.55, 0.54);
  // Cirrus is patchy over tens of degrees: whole quadrants of the real sky have
  // essentially none. Without a mask the threshold fires at a uniform rate
  // everywhere, which is what makes a stochastic field read as texture instead
  // of as structure. Reusing mass inverted costs nothing and says something
  // true as well: the sheets show up where the disc light behind them does not.
  float cirrusMask = smoothstep(0.30, -0.10, mass);
  // Bias hard: roughly the top tenth of the field survives the threshold, so
  // the cirrus covers a small fraction of the sky brightly rather than all of
  // it faintly. Dust is rationed like every other colour here — at a softer
  // bias this reads as a blanket of grey cotton over the whole frame.
  float cirrus = max(0.0, cirrusN * 2.3 - 0.80);
  // HIGH latitude — this factor used to be inverted. It peaked at |b| = 0 and
  // bottomed out at the poles, i.e. it laid a pale wash straight along the
  // brightest part of the band, filled the dust lanes back in from in front and
  // lifted the darkest part of the frame off black, which is the opposite of
  // everything the comment above claims it is for. Cirrus is what you see when
  // you look OUT of the disc, not through it.
  float cirrusLat = mix(0.10, 1.0, smoothstep(0.05, 0.50, abs(dir.y)));
  // Ash, not orange. Painting this in raw uDustColor puts a faint warm wash
  // over the entire off-band sky, which puts a second warm mass on screen and
  // steals the one saturated accent the band is supposed to own. Pulling it
  // most of the way back to the steel base keeps the amber unique to the core.
  vec3 cirrusC = mix(vec3(0.40, 0.46, 0.58), uDustColor, 0.22);
  lum += cirrusC * (cirrus * cirrusLat * cirrusMask * laneT * 0.022);

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
attribute float aProfile;

uniform float uPixelScale;
uniform float uBrightness;

varying vec3 vColor;
varying float vAngle;
varying float vAxis;
varying float vProfile;

void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // Ceiling 14, not 48. At 48 px the clamp was the *modal* size: most sprites
  // saturated it, so a distribution that was meant to be a luminosity function
  // arrived on screen as ninety identical stamps a degree and a half across —
  // one to three full moons each. A distant galaxy is a smudge you have to look
  // for. The one or two per frame that are genuinely large come from the power
  // law in buildGalaxies, not from everything piling up on the limit.
  gl_PointSize = clamp(aSize * uPixelScale, 1.0, 14.0);
  vColor = aColor * uBrightness;
  vAngle = aAngle;
  vAxis = aAxis;
  vProfile = aProfile;
}
`;

const GALAXY_FRAG = /* glsl */ `
#include <onespace_color>

varying vec3 vColor;
varying float vAngle;
varying float vAxis;
varying float vProfile;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float c = cos(vAngle);
  float s = sin(vAngle);
  vec2 q = vec2(c * d.x - s * d.y, s * d.x + c * d.y);
  q.y /= max(vAxis, 0.12);               // squash the disc into an ellipse
  float r = length(q) * 2.0;

  // de Vaucouleurs-ish: a diffuse envelope with a much tighter nucleus.
  // vProfile is the bulge-to-total of this particular object, 0..1. A fixed
  // mix gave every smudge in the sky the same soft-envelope-plus-hot-pip
  // silhouette, which is what makes a scattered field read as one sprite
  // stamped ninety times. Real Sa-to-Sd morphology is a continuum: a nucleated
  // E0 is nearly all nucleus, a late-type disc is nearly all envelope.
  float envelope = exp(-r * r * mix(3.1, 6.4, vProfile));
  float nucleus = exp(-r * r * 62.0);
  float v = envelope * mix(0.85, 0.32, vProfile) + nucleus * mix(0.15, 1.5, vProfile);

  vec3 col = vColor * v;
  if (max(col.r, max(col.g, col.b)) < 0.0006) discard;

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`;

// ---------------------------------------------------------------------------
// Near-field occluder
// ---------------------------------------------------------------------------

const CANOPY_VERT = /* glsl */ `
attribute float aEdge;
varying float vEdge;
varying vec2 vPlate;
void main() {
  vEdge = aEdge;
  vPlate = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CANOPY_FRAG = /* glsl */ `
#include <onespace_noise>
#include <onespace_color>

varying float vEdge;
varying vec2 vPlate;

void main() {
  // The plate is essentially black, and that is the entire point of it. Every
  // other pixel in a sky frame is something ADDED to the void; the darkest
  // region is merely where less was added. A hull plate is subtractive — it
  // cuts a hard silhouette out of the band — and it is the only true black and
  // the only hard edge the frame gets.
  float grime = os_fbm(vec3(vPlate * 9.0, 0.0), 4, 2.2, 0.5) * 0.5 + 0.5;
  vec3 body = vec3(0.0015, 0.0018, 0.0026) * (0.55 + 0.9 * grime);

  // One rim, on the edge that faces the band. Worn away along its length so it
  // reads as a chamfer catching a grazing light rather than as a drawn line.
  float rim = smoothstep(0.88, 0.995, vEdge);
  float wear = 0.45 + 0.55 * (os_fbm(vec3(vPlate.x * 24.0, vPlate.y * 3.0, 4.1), 3, 2.4, 0.5) * 0.5 + 0.5);
  // Steel, not amber. The amber in this frame is rationed to the galactic core;
  // a warm rim here would be a second accent and there is only ever one.
  vec3 col = body + vec3(0.44, 0.52, 0.64) * rim * 0.17 * wear;

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`;

/**
 * Two hull plates in camera space: a canopy sill across the bottom of the
 * frame and a diagonal brace rising out of it to the upper left.
 *
 * Authored at z = -2 in units of the half-frame height at 55 degrees vertical
 * FOV, which is the band shot's field. The sill spans far more width than any
 * plausible aspect ratio needs, so the composition survives a non-16:9 capture;
 * the vertical placement is what is actually load-bearing and that is set by
 * the FOV, not by the aspect.
 */
function buildCanopyGeometry(): BufferGeometry {
  const z = -2;
  const h = 2 * Math.tan((55 * Math.PI) / 360); // half-height of the frame at z

  const pos: number[] = [];
  const uv: number[] = [];
  const edge: number[] = [];

  // p0..p3 wind as two triangles; `e` is the per-corner rim coordinate.
  const quad = (
    p0: [number, number],
    p1: [number, number],
    p2: [number, number],
    p3: [number, number],
    e: [number, number, number, number],
  ): void => {
    const c = [p0, p1, p2, p3];
    const uvs: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      pos.push(c[i]![0], c[i]![1], z);
      uv.push(uvs[i]![0], uvs[i]![1]);
      edge.push(e[i]!);
    }
  };

  // Canopy sill: top edge at 0.80 of the way down the frame, running well off
  // both sides and well below the bottom. Occludes the lower ~10%.
  quad([-7, -0.80 * h], [7, -0.80 * h], [7, -4 * h], [-7, -4 * h], [1, 1, 0, 0]);

  // Diagonal brace out of the lower left, running off the top of the frame.
  const a = { x: -1.34 * h, y: -0.72 * h };
  const b = { x: 0.16 * h, y: 1.62 * h };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const w = 0.082 * h;
  const px = (-dy / len) * w;
  const py = (dx / len) * w;
  quad(
    [a.x - px, a.y - py],
    [a.x + px, a.y + py],
    [b.x + px, b.y + py],
    [b.x - px, b.y - py],
    // The +perp side faces up-right, i.e. towards the galactic centre in the
    // band shot, so that is the side that catches the rim.
    [0, 1, 1, 0],
  );

  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new Float32BufferAttribute(new Float32Array(uv), 2));
  g.setAttribute('aEdge', new Float32BufferAttribute(new Float32Array(edge), 1));
  g.boundingSphere = null;
  return g;
}

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

export class Sky {
  /** Add this to the scene yourself — Sky never touches ctx.scene. */
  readonly object3d: Object3D;

  /** Number of star points actually built. */
  get starCount(): number {
    return this.builtStarCount;
  }

  private readonly group: Group;
  private readonly backdrop: Mesh;
  private readonly stars: Points;
  private readonly galaxies: Points;
  private readonly canopy: Mesh;

  private readonly backdropMat: ShaderMaterial;
  private readonly starMat: ShaderMaterial;
  private readonly galaxyMat: ShaderMaterial;
  private readonly canopyMat: ShaderMaterial;

  private readonly quality: QualitySettings;
  private spec: GalaxySpec;
  private discScaleH = 0.03;
  private builtStarCount = 0;
  private canopyLease = false;

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
    this.quality = quality;
    this.spec = galaxy;

    // --- backdrop ---------------------------------------------------------
    const steps = clamp(Math.round(quality.nebulaSteps * 0.62), 16, 56);
    const octaves = quality.tier === 'low' ? 3 : quality.tier === 'medium' ? 4 : quality.tier === 'high' ? 5 : 6;

    const geoBackdrop = new SphereGeometry(1, 64, 32);
    this.backdropMat = new ShaderMaterial({
      name: 'os-sky-backdrop',
      side: BackSide,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      toneMapped: false,
      defines: quality.tier === 'low' ? {} : { OS_SKY_LANES: '1' },
      // Values are placeholders; writeBackdropUniforms() below owns every one
      // of them, and owns them again every time the spec is swapped.
      uniforms: {
        uBrightness: this.uBrightness,
        uCoreColor: { value: new Color() },
        uArmColor: { value: new Color() },
        uDustColor: { value: new Color() },
        // Near-black steel blue. Noir base: the void is never grey.
        uVoidColor: { value: new Color(0.0006, 0.0010, 0.0019) },
        uNoiseOffset: { value: new Vector3() },
        uObsRadius: { value: 0.55 },
        uScaleR: { value: 0.2 },
        uScaleH: { value: 0.03 },
        uBulge: { value: 0.5 },
        uBulgeR: { value: 0.17 },
        uArmCount: { value: 2 },
        uArmTwist: { value: 0.3 },
        uArmContrast: { value: 0.5 },
        uArmStrength: { value: 1 },
        uDustK: { value: 4.0 },
        uGain: { value: 0.105 },
        uLaneStrength: { value: 1 },
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
    this.stars = new Points(new BufferGeometry(), this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = ORDER_STARS;
    this.group.add(this.stars);

    // --- distant galaxies --------------------------------------------------
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
    this.galaxies = new Points(new BufferGeometry(), this.galaxyMat);
    this.galaxies.frustumCulled = false;
    this.galaxies.renderOrder = ORDER_GALAXIES;
    this.group.add(this.galaxies);

    // --- near-field occluder (shot fixture, hidden by default) --------------
    this.canopyMat = new ShaderMaterial({
      name: 'os-sky-canopy',
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      toneMapped: false,
      uniforms: {},
      vertexShader: CANOPY_VERT,
      fragmentShader: CANOPY_FRAG,
    });
    this.canopy = new Mesh(buildCanopyGeometry(), this.canopyMat);
    this.canopy.frustumCulled = false;
    this.canopy.renderOrder = ORDER_CANOPY;
    this.canopy.visible = false;
    this.group.add(this.canopy);

    this.setGalaxy(galaxy);
  }

  /**
   * Swap the galaxy this sky is a view from.
   *
   * Rebuilds the backdrop uniforms and both point clouds, so it is a few
   * milliseconds of synchronous work — fine in a shot's `apply()`, never in
   * `update()`. It exists because the review shots must not depend on whatever
   * shape the world seed happened to roll: three frames whose stated job is to
   * judge the band, the dust lanes and the amber/steel split are worthless if
   * the seed handed them an elliptical, which has none of those things by
   * construction. Pinning the shot spec is the only way the band code ever gets
   * looked at. See `registerSkyShots`.
   */
  setGalaxy(spec: GalaxySpec): void {
    if (this.spec === spec && this.builtStarCount > 0) return;
    this.spec = spec;
    this.writeBackdropUniforms(spec);

    const rng = new Rng(hashSeed(spec.seed, 'sky'));
    // Deliberately a fraction of the budget, not the whole thing. See the flux
    // floor in buildStars: the budget used to be spent almost entirely on stars
    // below the film-grain threshold, so the count bought pepper rather than a
    // sky. Fewer and brighter reads as more.
    const count = clamp(
      Math.round(this.quality.galaxyStarBudget * 0.24),
      1200,
      Math.max(1200, Math.floor(this.quality.galaxyStarBudget)),
    );
    const starGeo = this.buildStars(count, rng.fork('stars'), this.discScaleH);
    this.stars.geometry.dispose();
    this.stars.geometry = starGeo;
    this.builtStarCount = count;

    const galaxyGeo = this.buildGalaxies(rng.fork('galaxies'));
    this.galaxies.geometry.dispose();
    this.galaxies.geometry = galaxyGeo;
  }

  /**
   * Raise the near-field canopy frame for ONE frame, oriented in camera space.
   *
   * A sky-only frame has nothing in front of it, and §6 is explicit that an
   * empty screen is a failure state: something always occludes. This is the
   * cheapest honest occluder — two unlit hull plates riding the sky group (which
   * already follows the camera), so they behave exactly like structure bolted
   * to the ship.
   *
   * The lease is deliberately one frame long and `update()` drops it. A shot
   * that wants the canopy must re-arm it every frame from its own `update()`,
   * which means it cannot possibly still be up when some other module's shot
   * takes the scene over — a fixture that outlives its shot would put a hull
   * strut across somebody else's hero frame and they would have no idea where
   * it came from.
   */
  setCanopy(orientation?: Quaternion): void {
    this.canopyLease = true;
    if (orientation) this.canopy.quaternion.copy(orientation);
  }

  private writeBackdropUniforms(galaxy: GalaxySpec): void {
    const u = this.backdropMat.uniforms;
    const rng = new Rng(hashSeed(galaxy.seed, 'sky'));

    // Ellipticals have no disc and no arms; irregulars have a fat, chaotic one.
    const shape = galaxy.shape;
    const armStrength =
      shape === 'elliptical' ? 0 : shape === 'irregular' ? 0.4 : shape === 'ring' ? 0.7 : 1;
    // An elliptical has no thin disc, so its glow covers the WHOLE sky rather
    // than a 15° stripe. At spiral gain that fills the frame with fog and
    // destroys the contrast the whole art direction rests on — it has to be
    // very much dimmer to occupy that much more solid angle. It is also
    // essentially dust-free: gas-poor, so no lanes and no reddening.
    const isElliptical = shape === 'elliptical';
    // 0.0024, down from 0.0075, because the nuclear term added to the bulge in
    // BACKDROP_FRAG multiplies the central surface brightness of a pure
    // spheroid by ~4.9x. Holding the *peak* where it was and taking the
    // envelope down with the gain is the trade this shape needs anyway: an
    // elliptical's failure mode is a fog with no black left in the frame, and
    // its light genuinely is concentrated — an R^1/4 profile puts half of it
    // inside one effective radius. Spirals keep their gain: there the disc
    // dominates everything except the innermost few degrees, and the core shot
    // getting brighter is the point.
    const gain = isElliptical ? 0.0024 : shape === 'irregular' ? 0.085 : 0.105;
    const laneStrength = isElliptical ? 0.1 : shape === 'irregular' ? 0.8 : 1;
    // thickness/radius is the honest aspect ratio of the disc; ellipticals are
    // forced spheroidal so the band becomes a broad glow instead of a stripe.
    const scaleH = isElliptical
      ? 0.55
      : clamp((galaxy.thicknessLy / Math.max(galaxy.radiusLy, 1)) * 1.6, 0.012, 0.30);
    this.discScaleH = scaleH;

    (u.uCoreColor!.value as Color).setRGB(...galaxy.coreColor);
    (u.uArmColor!.value as Color).setRGB(...galaxy.armColor);
    (u.uDustColor!.value as Color).setRGB(...galaxy.dustColor);
    (u.uNoiseOffset!.value as Vector3).set(
      rng.range(-40, 40),
      rng.range(-40, 40),
      rng.range(-40, 40),
    );
    u.uObsRadius!.value = rng.range(0.5, 0.66);
    u.uScaleR!.value = isElliptical ? 0.42 : 0.2;
    u.uScaleH!.value = scaleH;
    u.uBulge!.value = clamp(galaxy.bulgeFraction * 3.0, 0.12, 2.0);
    u.uBulgeR!.value = isElliptical ? 0.5 : 0.17;
    u.uArmCount!.value = Math.max(1, galaxy.armCount);
    u.uArmTwist!.value = Math.max(0.06, galaxy.armTwist);
    u.uArmContrast!.value = clamp01(galaxy.armContrast);
    u.uArmStrength!.value = armStrength;
    u.uDustK!.value = isElliptical ? 0.35 : 4.0;
    u.uGain!.value = gain;
    u.uLaneStrength!.value = laneStrength;
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
      // of a fake sky; this makes most of the field a faint granular wash and
      // leaves a few dozen genuine beacons.
      //
      // The faint cut is 0.011, not 0.0022. Below ~0.008 a star's peak lands
      // under the film grain the grade lays over the whole frame, so the bottom
      // 85% of the old distribution was not a faint magnitude bin — it was
      // indistinguishable from sensor noise, and the field jumped straight from
      // pepper to spiked beacon with no ladder in between. Raising the floor
      // and taking the count down with it (see setGalaxy) trades stars nobody
      // can see for magnitude bins the eye can actually read.
      const f = rng.power(0.011, 1, -2.4);

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
      // 0.20, not 0.46: washing the faint majority 46% of the way to white is
      // what left the field a bed of colourless pepper with two or three tinted
      // points in it, and the blackbody spread — the entire reason the IMF
      // blend above exists — never reached the frame. A 20% wash still keeps
      // the faintest stars from looking like coloured confetti.
      const wash = 0.2 - 0.14 * Math.sqrt(f);
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
    // 24, not 55-90. At a 55 degree field about an eighth of the sky is on
    // screen, so this is one to four smudges per frame — which is what a
    // distant-galaxy field is. Anything denser competes with the band for the
    // eye and reads as dust on the lens.
    const n = rng.int(18, 32);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const angle = new Float32Array(n);
    const axis = new Float32Array(n);
    const profile = new Float32Array(n);

    // Vertical optical depth of our own dust disc, in magnitudes-ish. Sets how
    // hard the zone of avoidance bites.
    const TAU_V = 0.55;
    let written = 0;
    for (let attempt = 0; attempt < n * 12 && written < n; attempt++) {
      const [x, y, z] = rng.onSphere();
      // Zone of avoidance, as extinction rather than as a wall. Our own dust
      // sits in a slab, so the path length through it goes as 1/|sin b| and a
      // background galaxy fades out smoothly as it approaches the band. The old
      // hard `|y| < 0.21` reject produced the opposite reading: absent, absent,
      // absent, then abruptly present at full brightness, with the transition
      // landing nowhere near where the band actually looks thick.
      const ay = Math.max(Math.abs(y), 1e-3);
      const att = Math.exp(-TAU_V * (1 / ay - 1));
      if (att < 0.04) continue; // deep in the zone; not worth a vertex

      pos[written * 3] = x * SKY_RADIUS;
      pos[written * 3 + 1] = y * SKY_RADIUS;
      pos[written * 3 + 2] = z * SKY_RADIUS;

      // Mostly old ellipticals; a few blue spirals. Down a factor of ~3 on the
      // old range: these are the most distant objects in the frame and they
      // were arriving brighter than the galaxy they sit in front of.
      const spiral = rng.chance(0.3);
      const b = rng.power(0.0045, 0.075, -1.6);
      // Reddened by our own disc on the way through, with the same wavelength
      // dependence the backdrop uses. Free, and it is why the ones nearest the
      // band are the amber ones.
      const er = Math.pow(att, 0.78);
      const eg = att;
      const eb = Math.pow(att, 1.38);
      if (spiral) {
        col[written * 3] = b * 0.78 * er;
        col[written * 3 + 1] = b * 0.9 * eg;
        col[written * 3 + 2] = b * 1.0 * eb;
        axis[written] = rng.range(0.16, 0.7);
        profile[written] = rng.range(0.0, 0.45);
      } else {
        // Ivory-COOL, not ivory-warm. A warm field of smudges on a warm sky is
        // a second warm mass competing for the one rationed accent; an old
        // stellar population seen at redshift is close enough to neutral that
        // leaning it very slightly cold costs nothing and buys the separation.
        col[written * 3] = b * 0.94 * er;
        col[written * 3 + 1] = b * 0.96 * eg;
        col[written * 3 + 2] = b * 1.0 * eb;
        axis[written] = rng.range(0.45, 0.95);
        profile[written] = rng.range(0.55, 1.0);
      }
      // Power law, not a uniform range. The old rng.range(6,15) had no faint
      // end at all — every object was within a factor of two of every other,
      // which is the definition of a stamp. alpha = -2 puts the mode at 1-2 px
      // and hands one object per few frames a genuinely large envelope.
      size[written] = rng.power(1.2, 9, -2.0);
      angle[written] = rng.range(0, Math.PI);
      written++;
    }

    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('aColor', new Float32BufferAttribute(col, 3));
    g.setAttribute('aSize', new Float32BufferAttribute(size, 1));
    g.setAttribute('aAngle', new Float32BufferAttribute(angle, 1));
    g.setAttribute('aAxis', new Float32BufferAttribute(axis, 1));
    g.setAttribute('aProfile', new Float32BufferAttribute(profile, 1));
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

    // One-frame lease on the shot fixture; see setCanopy().
    this.canopy.visible = this.canopyLease;
    this.canopyLease = false;

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
    this.canopy.geometry.dispose();
    this.backdropMat.dispose();
    this.starMat.dispose();
    this.galaxyMat.dispose();
    this.canopyMat.dispose();
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

/**
 * Integrated colour of a stellar population at `kelvin`, normalised to unit
 * peak and scaled. Same curve as `os_blackbody` and as `gen/galaxy.ts`, so a
 * pinned shot spec is the same kind of object the generator would have made —
 * it is a galaxy that could exist, not a set of hand-picked swatches.
 */
function popColor(kelvin: number, scale: number): [number, number, number] {
  const c = blackbody(kelvin, new Color());
  const m = Math.max(c.r, c.g, c.b, 1e-4);
  return [(c.r / m) * scale, (c.g / m) * scale, (c.b / m) * scale];
}

function shotGalaxy(over: Partial<GalaxySpec> & Pick<GalaxySpec, 'seed' | 'shape'>): GalaxySpec {
  return {
    id: `shot-${over.shape}`,
    name: 'shot fixture',
    radiusLy: 52000,
    thicknessLy: 990,
    armCount: 4,
    armTwist: 0.3,
    armContrast: 0.72,
    bulgeFraction: 0.24,
    starCount: 0,
    coreColor: popColor(3900, 0.92),
    armColor: popColor(11500, 1.0),
    dustColor: [0.6, 0.37, 0.22],
    nebulae: [],
    blurb: '',
    ...over,
  };
}

/**
 * The galaxy the band, core and star-field shots are taken from.
 *
 * PINNED ON PURPOSE. These three frames exist to judge the band, the lanes cut
 * into it, the reddened bulge and the amber/steel split; built from
 * `universe.galaxy` they inherit whatever the world seed rolled, and the world
 * seed rolls an elliptical about a fifth of the time. An elliptical has no
 * disc, no arms, no lanes and a red-and-dead palette by construction — the
 * `isElliptical` branch is *supposed* to produce a formless spheroidal glow. So
 * for three review rounds the band code shipped unlooked-at while the reviewer
 * was handed three near-identical fogs and told they were the band.
 *
 * thicknessLy/radiusLy = 0.019 puts uScaleH at 0.030, which is a band roughly
 * 15 degrees across from inside — the Milky Way's proportions.
 */
const SHOT_SPIRAL: GalaxySpec = shotGalaxy({ seed: 0x5b17, shape: 'barred-spiral' });

/**
 * And the elliptical, judged as itself rather than silently standing in for a
 * band. If this one looks like a formless glow that is the correct answer; the
 * question it asks is whether it is a *dim* formless glow with black around it.
 */
const SHOT_ELLIPTICAL: GalaxySpec = shotGalaxy({
  seed: 0x9c04,
  shape: 'elliptical',
  radiusLy: 128000,
  thicknessLy: 54000,
  armCount: 2,
  armContrast: 0.01,
  bulgeFraction: 0.95,
  coreColor: popColor(4000, 0.95),
  armColor: popColor(4800, 1.0),
  dustColor: [0.55, 0.4, 0.3],
});

export function registerSkyShots(sky: Sky): void {
  registerShot({
    name: 'sky-galactic-band',
    description:
      'Looking along the galactic plane, 17° off the core and rolled 19°, with ' +
      'the canopy sill and a brace in the near field. Judges the band, the dust ' +
      'lanes cut into it, the extinction-reddened bulge, the star ' +
      'magnitude/colour distribution and the silhouette against all of it.',
    apply(ctx) {
      sky.setGalaxy(SHOT_SPIRAL);
      sky.setRotation(SHOT_IDENTITY);
      sky.setBrightness(1);
      sky.setTwinkle(0); // vacuum: rock steady
      sky.snap();
      // Core off to one side, plane just below centre so the rift cuts the
      // lower third and the frame is never a flat black field.
      aim(ctx, 0.30, 0.055, -0.33, 55);
      // Only this shot carries the occluder: the others are deliberately
      // unobstructed measurements of the sky itself.
      sky.setCanopy(SHOT_Q);
    },
    update(_dt, ctx) {
      hold(ctx);
      sky.setCanopy(SHOT_Q);
    },
  });

  registerShot({
    name: 'sky-galactic-core',
    description:
      'Straight down the barrel at the galactic bulge. Maximum band luminance ' +
      'and maximum extinction — the test for banding, dither quality, the ' +
      'nuclear peak and the amber/steel colour split.',
    apply(ctx) {
      sky.setGalaxy(SHOT_SPIRAL);
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
      sky.setGalaxy(SHOT_SPIRAL);
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

  registerShot({
    name: 'sky-elliptical',
    description:
      'The same sky from inside a giant elliptical: no disc, no arms, no lanes, ' +
      'an old red population edge to edge. Judges whether the shape that has no ' +
      'band still leaves the frame most of its black, and whether the star ' +
      'field alone carries a frame with no structure behind it.',
    apply(ctx) {
      sky.setGalaxy(SHOT_ELLIPTICAL);
      sky.setRotation(SHOT_IDENTITY);
      sky.setBrightness(1);
      sky.setTwinkle(0);
      sky.snap();
      aim(ctx, 0.12, 0.09, -0.14, 50);
    },
    update(_dt, ctx) {
      hold(ctx);
    },
  });
}
