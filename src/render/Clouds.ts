/**
 * Clouds — the volumetric cloud shell.
 *
 * A raymarched shell between `planet.radius` and
 * `planet.radius + clouds.altitude * 2`. It is a real participating medium:
 * billowy low-frequency shape noise lays down the cloud masses, a
 * high-frequency worley field *erodes* their edges (that erosion is what
 * produces cauliflower silhouettes instead of blobs), a vertical profile gives
 * flat bottoms and swelling tops, and a second march towards the star does the
 * self-shadowing.
 *
 * THREE DECISIONS WORTH KNOWING ABOUT
 * ----------------------------------
 * 1. A baked equirectangular *weather texture* carries coverage and cloud type.
 *    Weather is a function of direction from the planet centre, not of the 3D
 *    sample position — it is a map, not a volume. Evaluating it per raymarch
 *    sample costs five noise evaluations that barely change along a vertical
 *    ray. Baked once every few frames it costs one texture fetch, and it hands
 *    us the cloud shadow map almost for free.
 *
 * 2. The march runs at *half resolution* into an HDR target and is resolved
 *    through the same shell geometry, so the composite still depth-tests
 *    correctly against everything in front of it. Measured on an M4 Pro at
 *    1080p (marginal cost, nine passes per frame, differenced against an empty
 *    march): 0.2 ms with the deck a third of the frame, 1.6 ms filling it, and
 *    2.5 ms in the worst framing found — full daylight, planet across two
 *    thirds of the frame. The same framings at `resolutionScale = 1` cost
 *    0.6 / 6.8 / 8.5 ms, which is why half is the default. Those numbers
 *    predate the review pass below and are no longer exact: the shape march
 *    gained up to two octaves and the erosion a third band when the camera is
 *    close, while nine `pow()` per lit sample moved out of the loop into
 *    main(). Re-measure before trusting them to the tenth of a millisecond.
 *
 * 3. Every loop bound is a uniform, never a literal. With literal bounds the
 *    driver unrolls the view march into the light march and inlines a thousand
 *    noise evaluations; the shader still compiles and still runs, just four
 *    times slower.
 *
 * The march is kept cheap by: analytic clipping to the outer sphere, the planet
 * body and the vacuum gap below the cloud base (that gap is *jumped*, not
 * marched); a step length of `max(thickness/steps, len/maxSteps)` so a vertical
 * ray costs a dozen samples and only limb rays reach the ceiling; erosion gated
 * on both projected cell size and remaining transmittance so it only runs on
 * the visible front surface; a coarse three-octave density for the light march;
 * and a transmittance early-out.
 */

import {
  BackSide,
  ClampToEdgeWrapping,
  Color,
  FrontSide,
  HalfFloatType,
  LinearFilter,
  Matrix3,
  Mesh,
  NoBlending,
  NoColorSpace,
  NormalBlending,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type IUniform,
  type Texture,
} from 'three';

import type { EngineContext } from '@/core/Engine';
import type { QualitySettings } from '@/core/Config';
import type { CloudSpec, PlanetSpec } from '@/gen/types';
import { Rng } from '@/math/rng';
import { registerShot } from '@/game/Shots';
import { registerShaderChunks } from '@/shaders/chunks';
import type { ViewState } from '@/render/ViewState';

const TAU = Math.PI * 2;

/** Geometric growth of the light-march step. Mirrored in GLSL below. */
const LIGHT_GROWTH = 1.7;

/**
 * Draw order. The planet surface is opaque (order 0); clouds sit above it and
 * *below* the atmosphere, whose forward-scattered haze must wash over the cloud
 * tops at the limb. Atmosphere.ts should use a renderOrder greater than this.
 */
export const CLOUD_RENDER_ORDER = 8;

/**
 * GLSL helper for whoever samples `getShadowTexture()` — normally the planet
 * surface material. Paste it into your fragment shader (it declares no
 * uniforms, so it cannot collide with yours).
 *
 *   `vec2 s = os_cloudShadowSample(uCloudShadow, normalize(planetLocalPos));`
 *   `s.r` — sun transmittance through the cloud deck, 1 = unshadowed.
 *   `s.g` — opacity of the cloud directly overhead, for sky-light occlusion.
 *
 * The normal must be in *planet-local, untilted* space — the same space
 * `ViewState.cameraLocal` is expressed in. The map already carries the current
 * cloud drift rotation, so the reader applies no rotation of its own.
 */
export const CLOUD_SHADOW_SAMPLE_GLSL = /* glsl */ `
vec2 os_cloudShadowSample(sampler2D tex, vec3 n) {
  n = normalize(n);
  vec2 uv = vec2(
    atan(n.x, n.z) * 0.15915494 + 0.5,
    asin(clamp(n.y, -1.0, 1.0)) * 0.31830989 + 0.5
  );
  return texture2D(tex, uv).rg;
}
`;

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

/** Shared by the view march, the light march and the shadow bake. */
const FIELD_GLSL = /* glsl */ `
uniform sampler2D uWeather;
uniform mat3  uRot;          // planet-fixed -> cloud noise frame (carries drift)
uniform vec3  uNoiseOffset;  // per-planet seed offset
uniform vec3  uAdvect;       // slow domain evolution: clouds change, not slide
uniform float uRPlanet;
uniform float uRBase;
uniform float uRTop;
uniform float uShapeFreq;    // cycles per km
uniform float uDetailFreq;
uniform float uErode;
uniform float uFade;         // 0..1 ramp so the deck never pops in
uniform float uUseWorley;    // LOD gate
uniform float uWarpShape;
uniform int   uShapeOct;     // LOD: how far down the shape spectrum to go

float cl_remap(float v, float lo, float hi, float a, float b) {
  return a + (clamp(v, lo, hi) - lo) * (b - a) / max(hi - lo, 1e-5);
}

/** Equirectangular direction -> uv. Must match CLOUD_SHADOW_SAMPLE_GLSL. */
vec2 cl_dirToUv(vec3 d) {
  d = normalize(d);
  return vec2(
    atan(d.x, d.z) * 0.15915494 + 0.5,
    asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5
  );
}

/** r = coverage 0..1, g = cloud type (0 = flat stratus .. 1 = tall cumulus). */
vec2 cl_weather(vec3 p) {
  return texture2D(uWeather, cl_dirToUv(p)).rg;
}

/**
 * Vertical density profile. A cloud is not a slab: it condenses abruptly at the
 * lifting condensation level (hence the famously flat bottoms) and swells and
 * shreds towards the top. 'type' interpolates a thin stratus sheet hugging the
 * base into a tall cumulus tower that fills the shell.
 */
float cl_profile(float h, float type) {
  float bottom = smoothstep(0.0, mix(0.045, 0.13, type), h);
  float ceilingH = mix(0.34, 0.98, type);
  float top = 1.0 - smoothstep(ceilingH * 0.52, ceilingH, h);
  // Anvil swell: mass accumulates towards the top of a convective tower.
  float swell = mix(1.0, 0.45 + 1.15 * h, type);
  return bottom * top * swell;
}

/**
 * os_billow does not fill 0..1 — it clusters around a mean of roughly 0.28 with
 * a spread of about +-0.13. Left raw, a coverage of 0.5 clips off only the rare
 * peaks and the planet gets isolated dots instead of cloud. This recentres the
 * distribution so the coverage remap is linear and 0.5 really is half cover.
 */
float cl_calibrate(float billow01) {
  return smoothstep(0.13, 0.45, billow01);
}

/**
 * Coarse density — three octaves, no swirl, no erosion. Used by the light march
 * and the shadow bake, where features finer than a couple of kilometres cannot
 * possibly be resolved and cost four times what they are worth.
 */
float cl_densityCoarse(vec3 p, float h) {
  vec2 w = cl_weather(p);
  float prof = cl_profile(h, w.y);
  if (prof <= 0.002 || w.x <= 0.004) return 0.0;
  vec3 sp = (uRot * p) * uShapeFreq + uNoiseOffset + uAdvect;
  float base = cl_calibrate(os_billow(sp, 3, 2.07, 0.55) * 0.5 + 0.5);
  return clamp(cl_remap(base, 1.0 - w.x, 1.0, 0.0, 1.0) * prof, 0.0, 1.0) * uFade;
}

/**
 * Full density. 'erode' is a 0..1 weight rather than a flag: the caller fades
 * the expensive worley pass out with depth into the cloud, because only the
 * front surface ever shows its silhouette.
 */
float cl_density(vec3 p, float h, float erode) {
  vec2 w = cl_weather(p);
  float cov = w.x;
  float prof = cl_profile(h, w.y);
  if (prof <= 0.002 || cov <= 0.004) return 0.0;

  vec3 sp = (uRot * p) * uShapeFreq + uNoiseOffset + uAdvect;
  // One-tap domain warp. A full os_warp costs three noise evaluations; a single
  // low-frequency sample sheared along three axes buys most of the swirl for a
  // third of the price, and swirl is the difference between weather and fBm.
  float swirl = os_snoise(sp * 0.45);
  sp += vec3(swirl, swirl * 0.7, -swirl * 0.85) * uWarpShape;

  // Octave count is an LOD uniform, not a literal. The shape band has to reach
  // *down* to the erosion cell size as the camera descends; if it stops at four
  // octaves there is a hole in the spectrum between the ~50 km shape lobe and
  // the erosion, and a close approach reads as one smooth mass with fuzz
  // sprayed on it rather than as a cloudscape.
  float base = cl_calibrate(os_billow(sp, uShapeOct, 2.07, 0.55) * 0.5 + 0.5);
  float d = cl_remap(base, 1.0 - cov, 1.0, 0.0, 1.0) * prof;
  if (d <= 0.0) return 0.0;

  // Erosion. Subtracting a high-frequency worley field from the *edges* of the
  // shape is what turns smooth blobs into cauliflower. Cores (d near 1) are
  // left alone so clouds keep solid, opaque middles.
  if (erode > 0.01 && d < 0.92) {
    // Texture is a function of air mass, not a global constant. Flat stratus
    // sheets are barely eroded and read smooth; convective towers get shredded
    // into cauliflower at a finer cell size. Without this variation every
    // square kilometre of a heavily-covered world gets the same crust, and a
    // full-disc frame reads as cracked paint rather than as weather. The cell
    // scaling stays inside 0.5-1.15 so the anti-aliasing floor set by
    // uDetailFreq still holds at the fine end.
    float airMass = w.y;
    vec3 dp = (uRot * p) * (uDetailFreq * mix(0.50, 1.15, airMass))
            + uNoiseOffset * 3.1 + uAdvect * 4.0;
    float hf;
    if (uUseWorley > 0.5) {
      // Three bands, not one. A single cell size erodes every edge to the same
      // pebbled texture, which is exactly how procedural cloud gives itself
      // away; real edges are big lumps carrying smaller lumps carrying wisps.
      // The coarse band also bridges the octave gap down from the shape noise.
      float coarse = os_billow(dp * 0.30, 2, 2.3, 0.55) * 0.5 + 0.5;
      float cells  = 1.0 - os_worley(dp).x;
      float fine   = os_billow(dp * 3.3, 2, 2.4, 0.5) * 0.5 + 0.5;
      hf = coarse * 0.30 + cells * 0.50 + fine * 0.20;
    } else {
      // Detail cells are sub-pixel at this range; a two-octave billow reads
      // identically and costs a fifth as much.
      hf = os_billow(dp * 1.7, 2, 2.6, 0.5) * 0.5 + 0.5;
    }
    // Tops shred into wisps, bases stay coherent.
    hf = mix(hf, hf * hf, clamp(h * 1.4, 0.0, 1.0));
    d = cl_remap(d, hf * uErode * erode * mix(0.55, 1.40, airMass) * (1.0 - d), 1.0, 0.0, 1.0);
  }
  return clamp(d, 0.0, 1.0) * uFade;
}
`;

const SHELL_VS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

/** The march itself. Rendered offscreen, never straight to the screen. */
const MARCH_FS = /* glsl */ `
#include <common>
#include <onespace_noise>
#include <onespace_color>
#include <onespace_atmosphere>
${FIELD_GLSL}

uniform vec3  uCameraLocal;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uCloudColor;
uniform vec3  uTerminatorTint;
uniform vec3  uAmbientSky;
uniform vec3  uAmbientGround;
uniform float uSigmaE;
uniform float uSigmaL;
uniform float uLightBoost;
uniform float uPhaseG;
uniform float uPowder;
uniform float uTermSoft;
uniform float uStepLen;
uniform float uStepGrowth;
uniform float uInside;
uniform float uLightStepLen;
uniform int   uMaxSteps;
uniform int   uLightSteps;

#define LIGHT_GROWTH 1.7

varying vec3 vLocal;

/** Henyey-Greenstein normalised so isotropic == 1. */
float cl_phase(float c, float g) { return os_phaseMie(c, g) * 12.5663706; }

/**
 * Three lobes: a tight forward lobe (the silver lining on a sun-facing edge),
 * a wider dimmer lobe standing in for multiple scattering — without it clouds
 * read as grey cotton rather than bright white — and a small back lobe so the
 * anti-sun side is not dead flat.
 */
float cl_phaseMulti(float c, float s) {
  float g = uPhaseG * s;
  return cl_phase(c, g) * 0.72 + cl_phase(c, g * 0.35) * 0.46 + cl_phase(c, -0.22 * s) * 0.14;
}

/**
 * How much of the star this sample can see past the planet body. Working in
 * cos(phi) rather than in perpendicular distance matters: the distance
 * formulation collapses the whole penumbra into two degrees and the terminator
 * reads as a razor cut across the deck. 'grazing' peaks mid-penumbra, where the
 * light has crossed the longest slant of atmosphere and comes through red.
 */
float cl_sunVisibility(vec3 p, out float grazing) {
  float r = max(length(p), 1e-3);
  float cosPhi = dot(p, uSunDir) / r;
  float cosTerm = -sqrt(max(0.0, 1.0 - (uRPlanet * uRPlanet) / (r * r)));
  float vis = smoothstep(cosTerm - uTermSoft, cosTerm + uTermSoft, cosPhi);
  grazing = vis * (1.0 - vis) * 4.0;
  return vis;
}

/** Optical depth towards the star. Steps grow so a few taps cover a long slant. */
float cl_lightMarch(vec3 p) {
  float tau = 0.0;
  float t = 0.0;
  // Deliberately not named 'step' — a local of that name shadows the GLSL
  // built-in for the rest of the scope and turns the next step() call into a
  // compile error a long way from here.
  float ds = uLightStepLen;
  for (int i = 0; i < uLightSteps; i++) {
    t += ds;
    vec3 sp = p + uSunDir * t;
    float h = (length(sp) - uRBase) / (uRTop - uRBase);
    if (h > 0.0 && h < 1.0) tau += cl_densityCoarse(sp, h) * ds;
    ds *= LIGHT_GROWTH;
  }
  return tau;
}

void cl_march(
  vec3 ro, vec3 rd, float tStart, float tEnd, float jitter, float cosT, vec3 phase,
  inout vec3 scatter, inout float transmittance, inout float viewTau
) {
  float len = tEnd - tStart;
  if (len <= 0.0) return;

  // Outside the deck the segment is short, so spreading the budget over it is
  // right. Inside, the segment can be 800 km of mostly-empty air; spreading the
  // budget over that smears the near field into fog, so there we keep the near
  // step tight and let the geometric growth reach the horizon instead.
  float stepLen = mix(max(uStepLen, len / float(uMaxSteps)), uStepLen, uInside);
  float t = tStart + stepLen * jitter;
  vec3 lastLit = vec3(0.0);

  for (int i = 0; i < uMaxSteps; i++) {
    if (t >= tEnd || transmittance < 0.05) break;

    vec3 p = ro + rd * t;
    float h = (length(p) - uRBase) / (uRTop - uRBase);
    // The segment this sample stands for is the step we are *on*, not the one
    // we are about to take. With uStepGrowth > 1 the two differ, and using the
    // grown one silently inflates every optical depth by the growth factor.
    float ds = stepLen;
    t += stepLen;
    stepLen *= uStepGrowth;
    if (h <= 0.0 || h >= 1.0) continue;

    // Erosion and self-shadowing are only paid for on the visible front
    // surface. Once the ray is a third of the way through the cloud, nothing
    // behind it can show a silhouette.
    float erode = smoothstep(0.35, 0.75, transmittance);
    float d = cl_density(p, h, erode);
    if (d <= 0.002) continue;

    float sigmaE = d * uSigmaE;
    float sampleT = exp(-sigmaE * ds);
    viewTau += sigmaE * ds;

    float grazing;
    float vis = cl_sunVisibility(p, grazing);

    vec3 lit = vec3(0.0);
    if (vis > 0.002) {
      if (transmittance > 0.22) {
        // Light that has grazed the atmosphere loses energy as well as blue.
        vec3 sunCol = uSunColor * vis * (1.0 - 0.45 * grazing)
                    * mix(vec3(1.0), uTerminatorTint, grazing);
        // uSigmaL is well below uSigmaE on purpose. Single scattering through
        // the true extinction makes every core black; a real cloud is white
        // because light bounces dozens of times. The reduced light-path sigma
        // plus the octaves below is the standard cheap stand-in for that.
        float tau = cl_lightMarch(p) * uSigmaL;
        // Wrenninge-style multiple-scattering octaves: each successive lobe is
        // dimmer, less attenuated and less directional than the last. The three
        // phase values depend only on cosT, which is constant along the ray, so
        // they are evaluated once per pixel in main() — nine pow() per sample
        // was the single most expensive thing in this loop.
        float energy = phase.x * exp(-tau)
                     + 0.4500 * phase.y * exp(-tau * 0.50)
                     + 0.2025 * phase.z * exp(-tau * 0.25);
        lit = sunCol * energy * uLightBoost;
        lastLit = lit;
      } else {
        // Deep inside the cloud the lighting has stopped changing; reuse it and
        // let the extinction below do the darkening.
        lit = lastLit * 0.75;
      }
    }

    // Powder / dark-edge. Thin cloud looking down-sun has not had room to
    // scatter light back out, so its edges go dark instead of glowing.
    float powder = 1.0 - exp(-viewTau * 2.6);
    lit *= mix(1.0, 0.30 + powder * 1.15, uPowder * clamp(0.5 - 0.5 * cosT, 0.0, 1.0));

    // Sky and planetshine. Hard-gated by the terminator: there is no ambient
    // fill in space, so the night side of the deck is black, not grey.
    float day = smoothstep(-0.22, 0.34, dot(normalize(p), uSunDir));
    vec3 amb = mix(uAmbientGround, uAmbientSky, h) * day;

    vec3 S = (lit + amb) * uCloudColor * sigmaE;
    // Analytic in-scattering integration over the step — far less banded than
    // accumulating the sample value directly at these step counts.
    scatter += transmittance * (S - S * sampleT) / max(sigmaE, 1e-7);
    transmittance *= sampleT;
  }
}

void main() {
  vec3 ro = uCameraLocal;
  vec3 rd = normalize(vLocal - uCameraLocal);

  vec2 tTop = os_raySphere(ro, rd, uRTop);
  if (tTop.x > tTop.y || tTop.y <= 0.0) discard;

  float t0 = max(tTop.x, 0.0);
  float t1 = tTop.y;

  // The solid body occludes everything behind it — this is what lets the shell
  // sit correctly on the planet with no scene depth buffer to consult.
  vec2 tP = os_raySphere(ro, rd, uRPlanet);
  bool hitPlanet = (tP.x <= tP.y) && (tP.y > 0.0);
  if (hitPlanet) t1 = min(t1, max(tP.x, 0.0));

  // Everything below the cloud base is vacuum; jump the gap analytically
  // instead of spending samples in it. A limb ray crosses the deck twice and
  // therefore produces two segments.
  vec2 tB = os_raySphere(ro, rd, uRBase);
  bool hitBase = (tB.x <= tB.y) && (tB.y > 0.0);

  float aStart = t0, aEnd = t1;
  float bStart = 0.0, bEnd = -1.0;
  if (hitBase) {
    if (tB.x > t0) {
      aEnd = min(aEnd, tB.x);
      if (!hitPlanet) { bStart = clamp(tB.y, t0, t1); bEnd = t1; }
    } else if (tB.y > t0) {
      aStart = min(tB.y, t1);   // camera is under the deck: climb to the base
    }
  }

  float jitter = os_igNoise(gl_FragCoord.xy);
  float cosT = dot(rd, uSunDir);
  // Constant along the ray: hoisted out of the march (see cl_march).
  vec3 phase = vec3(
    cl_phaseMulti(cosT, 1.00),
    cl_phaseMulti(cosT, 0.60),
    cl_phaseMulti(cosT, 0.36)
  );
  vec3 scatter = vec3(0.0);
  float transmittance = 1.0;
  float viewTau = 0.0;

  cl_march(ro, rd, aStart, aEnd, jitter, cosT, phase, scatter, transmittance, viewTau);
  if (bEnd > bStart) {
    cl_march(ro, rd, bStart, bEnd, jitter, cosT, phase, scatter, transmittance, viewTau);
  }

  // Premultiplied HDR radiance. The composite pass blends it over the frame.
  gl_FragColor = vec4(max(scatter, 0.0), 1.0 - transmittance);
}
`;

/**
 * Composite. Drawn with the same shell geometry, so it depth-tests against the
 * scene exactly where the march ran. The upsample is a plain bilinear fetch:
 * the cloud field has no depth discontinuity of its own, and the only edge in
 * the buffer is the planet silhouette, which the shell geometry already ends
 * at. A depth-aware filter would need a scene depth texture, which the renderer
 * contract does not hand out.
 */
const COMPOSITE_FS = /* glsl */ `
#include <common>
#include <onespace_color>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uCloudTex;
uniform vec2  uResolution;
uniform float uOpacity;
varying vec3 vLocal;

void main() {
  #include <logdepthbuf_fragment>
  vec4 c = texture2D(uCloudTex, gl_FragCoord.xy / uResolution);
  float alpha = c.a * uOpacity;
  if (alpha < 0.0025) discard;
  gl_FragColor = vec4(max(c.rgb, 0.0) * uOpacity, alpha);
  #include <colorspace_fragment>
  // Dither the *composite*, not the march, and do it after the colour-space
  // transform: the quantisation this is hiding happens in output space, and a
  // 1/255 wobble applied in linear becomes a visible crawl in the shadows once
  // the sRGB curve stretches the darks. Straight to an 8-bit framebuffer the
  // deck's terminator gradient bands viciously without this.
  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`;

const QUAD_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Weather bake — an equirectangular map of coverage and cloud type. One cheap
 * 512x256 quad, and the only place the low-frequency, domain-warped
 * "where is the weather" field is ever evaluated.
 */
const WEATHER_FS = /* glsl */ `
#include <common>
#include <onespace_noise>
uniform mat3  uRot;
uniform vec3  uNoiseOffset;
uniform vec3  uAdvect;
uniform float uCoverage;
uniform float uCoverageVar;
uniform float uRegionFreq;
uniform float uWarp;
uniform float uBandFreq;
varying vec2 vUv;

void main() {
  float lon = (vUv.x - 0.5) * 6.28318531;
  float lat = (vUv.y - 0.5) * 3.14159265;
  float cl = cos(lat);
  vec3 dir = vec3(cl * sin(lon), sin(lat), cl * cos(lon));

  vec3 q = uRot * dir * uRegionFreq + uNoiseOffset + uAdvect * 0.35;
  // Domain warp is what makes weather look cyclonic rather than like fBm.
  q = os_warp(q, uWarp);
  float region = os_fbm(q, 3, 2.13, 0.58);

  // Circulation cells: real planets band their cloud into an ITCZ and
  // mid-latitude storm tracks rather than covering evenly.
  float bands = 0.5 + 0.5 * cos(lat * uBandFreq + region * 1.4);

  // Vary the CLEAR fraction multiplicatively, not the coverage additively.
  // Additive variation clamps out the moment the spec asks for an overcast
  // world: at coverage 0.91 more than half the globe pins at 1.0, the shape
  // noise stops contributing anything, and the only structure left is the
  // erosion — which then reads as one uniform cellular crust from pole to pole.
  // That is the single loudest tell of procedural cloud. Working in log-clear
  // space keeps the same *relative* dynamic range at every base coverage, so an
  // overcast world still tears open lanes and a sparse one still forms banks.
  float f = clamp(region * 1.9, -1.0, 1.0) * uCoverageVar * 2.6 + (bands - 0.5) * 1.5;
  float clear = clamp((1.0 - uCoverage) * exp(-f), 0.0, 1.0);
  float cov = 1.0 - clear;
  // A gentler version of the old contrast push — the exponential above already
  // supplies the fronts, and pushing hard on top of it welds them shut again.
  cov = mix(cov, smoothstep(0.05, 0.95, cov), 0.35);

  // Convective towers at low latitude, flat sheets over the poles. Centred and
  // scaled to actually *use* the middle of the range: the previous version
  // pinned at 1.0 across the whole tropics, so cl_profile and the erosion both
  // saw one constant and the planet got a single air mass from limb to limb.
  float type = clamp(
    0.48 + 0.46 * os_fbm(q * 0.55 + 31.7, 3, 2.0, 0.5) + (0.22 - 0.62 * abs(dir.y)),
    0.0, 1.0
  );

  gl_FragColor = vec4(cov, type, 0.0, 1.0);
}
`;

/**
 * Shadow bake — for each surface direction, march the sun ray through the deck
 * and store the transmittance. Deliberately soft and low resolution, which is
 * what a cloud shadow looks like from under it.
 */
const SHADOW_FS = /* glsl */ `
#include <common>
#include <onespace_noise>
#include <onespace_atmosphere>
${FIELD_GLSL}
uniform vec3  uSunDir;
uniform float uSigmaE;
varying vec2 vUv;

void main() {
  float lon = (vUv.x - 0.5) * 6.28318531;
  float lat = (vUv.y - 0.5) * 3.14159265;
  float cl = cos(lat);
  vec3 dir = vec3(cl * sin(lon), sin(lat), cl * cos(lon));

  vec3 mid = dir * ((uRBase + uRTop) * 0.5);
  float over = 1.0 - exp(-cl_densityCoarse(mid, 0.5) * uSigmaE * (uRTop - uRBase));

  float ndl = dot(dir, uSunDir);
  vec3 P = dir * uRPlanet;
  vec2 tT = os_raySphere(P, uSunDir, uRTop);
  vec2 tB = os_raySphere(P, uSunDir, uRBase);
  float t0 = max(tB.y, 0.0);
  float t1 = max(tT.y, 0.0);

  float tau = 0.0;
  float dt = max(t1 - t0, 0.0) * 0.25;
  for (int i = 0; i < 4; i++) {
    vec3 p = P + uSunDir * (t0 + dt * (float(i) + 0.5));
    float h = (length(p) - uRBase) / (uRTop - uRBase);
    if (h > 0.0 && h < 1.0) tau += cl_densityCoarse(p, h) * dt;
  }

  // Below the horizon the surface is unlit anyway; fade to "no shadow" so the
  // reader never sees a seam at the terminator.
  float shadow = mix(1.0, exp(-tau * uSigmaE), smoothstep(-0.02, 0.16, ndl));
  gl_FragColor = vec4(shadow, over, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

type Uniforms = Record<string, IUniform>;

export class CloudRenderer {
  readonly object3d: Object3D;

  /**
   * The shell spins with the planet by default, because the integrator normally
   * parents it to a *non-spinning* body node (a quadtree LOD sphere is
   * camera-relative and rarely rotates its own transform). Set false if you
   * parent this under a node that already applies the planet's rotation.
   */
  applyPlanetSpin = true;

  /** Multiplier on the raymarch step length. >1 is cheaper and softer. */
  stepBias = 1;

  /** Artistic control over how opaque the deck reads. */
  opticalDepthScale = 1;

  /**
   * Resolution of the march relative to the framebuffer. Initialised from the
   * quality tier in the constructor (0.4 low / 0.5 medium-high / 0.6 ultra);
   * 0.5 is the setting the performance numbers above assume. 1 gives
   * noticeably crisper cauliflower on the cloud edges and costs roughly four
   * times as much — fine for a still, not for flight.
   */
  resolutionScale = 0.5;

  private readonly rPlanet: number;
  private readonly rBase: number;
  private readonly rTop: number;
  private readonly layer: number;
  private readonly featureKm: number;
  private readonly detailKm: number;
  private readonly spinRate: number;
  private readonly driftSpin: number;

  private readonly mesh: Mesh;
  private readonly marchMesh: Mesh;
  private readonly geometry: SphereGeometry;
  private readonly marchMaterial: ShaderMaterial;
  private readonly compositeMaterial: ShaderMaterial;
  private readonly marchScene = new Scene();

  private readonly cloudRT: WebGLRenderTarget;
  private readonly weatherRT: WebGLRenderTarget;
  private readonly shadowRT: WebGLRenderTarget;
  private readonly bakeGeometry: PlaneGeometry;
  private readonly weatherMat: ShaderMaterial;
  private readonly shadowMat: ShaderMaterial;
  private readonly weatherScene = new Scene();
  private readonly shadowScene = new Scene();
  private readonly bakeCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly weatherQuad: Mesh;
  private readonly shadowQuad: Mesh;

  /** Shared uniform objects — one write updates every material that reads them. */
  private readonly shared: Uniforms;
  private readonly u: Uniforms;
  private readonly cu: Uniforms;

  // Preallocated scratch. Nothing in update() allocates.
  private readonly rot = new Matrix3();
  private readonly advect = new Vector3();
  private readonly ambSky = new Color();
  private readonly ambGround = new Color();
  private readonly skyTint = new Color();
  private readonly groundTint = new Color();
  private readonly sunDir = new Vector3(0, 0, 1);
  private readonly bufSize = new Vector2(1, 1);
  private readonly prevClear = new Color();
  private readonly rtSize = new Vector2(0, 0);

  private fade = 0;
  private baked = false;
  private disposed = false;
  private frameCounter = 0;
  private readonly weatherInterval: number;
  private readonly shadowInterval: number;

  constructor(planet: PlanetSpec, quality: QualitySettings) {
    if (!planet.clouds) {
      throw new Error(`CloudRenderer: ${planet.name} has no cloud layer`);
    }
    registerShaderChunks();

    const c: CloudSpec = planet.clouds;

    const rng = new Rng(planet.seed ^ 0x0c10d5);
    this.rPlanet = planet.radius;
    // The shell spans radius..radius+2*altitude as specified; the *deck* starts
    // a little above the surface so the vacuum gap can be skipped analytically.
    this.rBase = planet.radius + c.altitude * 0.3;
    this.rTop = planet.radius + c.altitude * 2;
    this.layer = this.rTop - this.rBase;

    // Feature scale tracks the body: a 2000 km moon should not get Earth-sized
    // weather systems, and a gas giant should not get 100 km puffs. On Earth
    // this is a ~480 km cloud mass, which is what a weather system actually is.
    this.featureKm = Math.min(6000, Math.max(35, planet.radius * 0.075 * rng.range(0.82, 1.22)));
    // Floor for the erosion cells; the march raises it with distance so the
    // cauliflower is always a few pixels wide and therefore never aliases.
    this.detailKm = Math.min(140, Math.max(1.2, planet.radius * 0.0012 * rng.range(0.8, 1.25)));
    this.driftSpin = c.drift;
    this.spinRate =
      Number.isFinite(planet.rotationPeriod) && Math.abs(planet.rotationPeriod) > 1e-3
        ? TAU / planet.rotationPeriod
        : 0;

    // --- render targets ----------------------------------------------------
    // Nothing here is a literal: ARCHITECTURE §5 forbids hard-coded resolutions,
    // and the march resolution in particular is the whole performance story.
    this.resolutionScale =
      quality.tier === 'low' ? 0.4 : quality.tier === 'ultra' ? 0.6 : 0.5;
    const shadowW = quality.shadowMapSize > 0 ? Math.min(512, quality.shadowMapSize / 2) : 192;
    const weatherW = quality.tier === 'low' ? 256 : quality.tier === 'ultra' ? 1024 : 512;
    this.weatherRT = makeMapTarget(weatherW, weatherW / 2);
    this.shadowRT = makeMapTarget(shadowW, shadowW / 2);
    // HDR: sunlit tops leave the march well above 1.0 so the grade has
    // something to roll off, and 8 bits would band the shadowed sides.
    this.cloudRT = new WebGLRenderTarget(2, 2, {
      type: HalfFloatType,
      format: RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
    });
    this.cloudRT.texture.colorSpace = NoColorSpace;

    this.weatherInterval = quality.tier === 'low' ? 12 : 6;
    this.shadowInterval = quality.tier === 'low' ? 6 : 3;

    // --- uniforms ----------------------------------------------------------
    const cloudColor = new Color().setRGB(c.color[0], c.color[1], c.color[2]);
    const atmThickness = planet.atmosphere ? planet.atmosphere.thickness : c.altitude * 4;

    this.shared = {
      uWeather: { value: this.weatherRT.texture },
      uRot: { value: this.rot },
      uNoiseOffset: {
        value: new Vector3(rng.range(-160, 160), rng.range(-160, 160), rng.range(-160, 160)),
      },
      uAdvect: { value: this.advect },
      uRPlanet: { value: this.rPlanet },
      uRBase: { value: this.rBase },
      uRTop: { value: this.rTop },
      uShapeFreq: { value: 1 / this.featureKm },
      uDetailFreq: { value: 1 / this.detailKm },
      uErode: { value: 0.34 + c.detail * 0.3 },
      uFade: { value: 0 },
      uUseWorley: { value: 1 },
      uWarpShape: { value: 0.32 + c.detail * 0.34 },
      uShapeOct: { value: 4 },
      uSunDir: { value: this.sunDir },
      // Extinction. 9/layer made *every* cloudy pixel optically thick (tau ~4
      // at only half density), so the whole deck resolved to one opaque white
      // surface with cracks in it and no tonal range at all. 5.5 keeps the
      // cores opaque while letting mid-density cloud read as translucent grey,
      // which is where the modelling lives.
      uSigmaE: { value: 7.5 / this.layer },
    };

    this.u = {
      ...this.shared,
      uCameraLocal: { value: new Vector3(0, 0, this.rTop * 4) },
      uSunColor: { value: new Color(1, 1, 1) },
      uCloudColor: { value: cloudColor },
      // The single rationed accent: light that has grazed the atmosphere on its
      // way to the cloud base comes out sodium orange at the terminator.
      uTerminatorTint: { value: new Color().setRGB(1.0, 0.5, 0.24) },
      uAmbientSky: { value: this.ambSky },
      uAmbientGround: { value: this.ambGround },
      uSigmaL: { value: (9 / this.layer) * 0.4 },
      // Exposure of the deck, and the most delicate number in the file. Too low
      // and sunlit cloud is grey; too high and the whole day side lands in the
      // ACES shoulder together and the deck loses all modelling — a white
      // paper cut-out with black cracks in it. Calibrated so flat-lit tops sit
      // at 0.6-0.9 linear (mid-to-upper grade, still on the straight part of
      // the curve) and only the forward-scattering lobe, which is ~60x the
      // side-scatter value, actually reaches white.
      uLightBoost: { value: 0.42 },
      uPhaseG: { value: 0.82 },
      uPowder: { value: 0.9 },
      // Half-width of the penumbra in cos(phi). Sized from the atmosphere: the
      // reason a terminator is soft at all is that air scatters light around
      // the limb, and thicker air means a longer dusk.
      uTermSoft: {
        value: Math.min(0.13, Math.max(0.012, (atmThickness / planet.radius) * 5)),
      },
      uStepLen: { value: this.layer / 14 },
      uStepGrowth: { value: 1 },
      uInside: { value: 0 },
      uLightStepLen: { value: this.layer * 0.3 },
      uMaxSteps: { value: 40 },
      uLightSteps: { value: 4 },
    };

    this.cu = {
      uCloudTex: { value: this.cloudRT.texture },
      uResolution: { value: this.bufSize },
      uOpacity: { value: 1 },
    };

    // Ambient is deliberately tiny — enough to keep unlit sides off pure black
    // on a planet with air, not enough to flatten the terminator.
    const ambScale = planet.atmosphere ? 0.055 : 0.018;
    this.skyTint.setRGB(0.3 * ambScale, 0.46 * ambScale, 0.95 * ambScale);
    this.groundTint.setRGB(
      planet.palette.mid[0] * ambScale * 0.65,
      planet.palette.mid[1] * ambScale * 0.65,
      planet.palette.mid[2] * ambScale * 0.65,
    );

    // --- shell meshes ------------------------------------------------------
    // The hull is inflated so a 64x32 tessellation never clips inside the
    // analytic sphere the shader actually intersects.
    this.geometry = new SphereGeometry(this.rTop * 1.004, 64, 32);

    this.marchMaterial = new ShaderMaterial({
      uniforms: this.u,
      vertexShader: SHELL_VS,
      fragmentShader: MARCH_FS,
      blending: NoBlending,
      depthWrite: false,
      depthTest: false,
      side: FrontSide,
      toneMapped: false,
    });

    this.compositeMaterial = new ShaderMaterial({
      uniforms: this.cu,
      vertexShader: SHELL_VS,
      fragmentShader: COMPOSITE_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: FrontSide,
      blending: NormalBlending,
      premultipliedAlpha: true,
      toneMapped: false,
    });

    this.mesh = new Mesh(this.geometry, this.compositeMaterial);
    this.mesh.renderOrder = CLOUD_RENDER_ORDER;
    this.mesh.name = `clouds:${planet.id}`;
    this.object3d = this.mesh;

    // A second mesh in a private scene renders the march offscreen. It shares
    // the geometry and carries the composite mesh's world matrix so both cover
    // exactly the same pixels.
    this.marchMesh = new Mesh(this.geometry, this.marchMaterial);
    this.marchMesh.frustumCulled = false;
    this.marchMesh.matrixAutoUpdate = false;
    this.marchScene.add(this.marchMesh);
    this.marchScene.matrixWorldAutoUpdate = false;

    // --- bake passes -------------------------------------------------------
    this.bakeGeometry = new PlaneGeometry(2, 2);

    this.weatherMat = new ShaderMaterial({
      uniforms: {
        uRot: this.shared.uRot,
        uNoiseOffset: this.shared.uNoiseOffset,
        uAdvect: this.shared.uAdvect,
        uCoverage: { value: c.coverage },
        uCoverageVar: { value: 0.3 + c.detail * 0.18 },
        uRegionFreq: { value: 1.15 + rng.range(0, 0.85) },
        uWarp: { value: 0.55 + c.detail * 0.45 },
        uBandFreq: { value: rng.pick([4, 6, 6, 8, 10]) },
      },
      vertexShader: QUAD_VS,
      fragmentShader: WEATHER_FS,
      depthTest: false,
      depthWrite: false,
    });

    this.shadowMat = new ShaderMaterial({
      uniforms: { ...this.shared },
      vertexShader: QUAD_VS,
      fragmentShader: SHADOW_FS,
      depthTest: false,
      depthWrite: false,
    });

    this.weatherQuad = new Mesh(this.bakeGeometry, this.weatherMat);
    this.weatherQuad.frustumCulled = false;
    this.weatherScene.add(this.weatherQuad);

    this.shadowQuad = new Mesh(this.bakeGeometry, this.shadowMat);
    this.shadowQuad.frustumCulled = false;
    this.shadowScene.add(this.shadowQuad);
  }

  /**
   * Soft cloud shadow for the planet surface, in the equirectangular layout
   * documented by {@link CLOUD_SHADOW_SAMPLE_GLSL}. `r` = sun transmittance,
   * `g` = overhead cloud opacity. Null before the first `update()`.
   */
  getShadowTexture(): Texture | null {
    return this.baked && !this.disposed ? this.shadowRT.texture : null;
  }

  update(dt: number, ctx: EngineContext, view: ViewState): void {
    // Freed GPU handles must not be re-bound: a renderer that keeps drawing
    // after dispose() is a use-after-free, not a graceful degradation.
    if (this.disposed) return;
    const u = this.u;
    const q = ctx.quality;

    // Damped fade so the deck materialises rather than pops on the first frame.
    this.fade += (1 - this.fade) * Math.min(1, dt * 3);
    u.uFade.value = this.fade;

    // --- domain animation --------------------------------------------------
    // Drift is relative to the surface; the planet's own spin is optional.
    // Negative: rotating the sampling domain one way makes the clouds appear to
    // travel the other. Wrapped to a turn so float32 keeps its precision.
    const spin = this.applyPlanetSpin ? this.spinRate : 0;
    const angle = -((this.driftSpin + spin) * view.time) % TAU;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    this.rot.set(ca, 0, sa, 0, 1, 0, -sa, 0, ca);

    // Slow advection of the noise domain: clouds evolve instead of sliding as a
    // rigid painted shell. Wrapped so float32 never runs out of mantissa.
    const t = view.time;
    this.advect.set((t * 0.0013) % 1024, (-t * 0.0005) % 1024, (t * 0.0019) % 1024);

    this.sunDir.copy(view.sunDirection);
    (u.uCameraLocal.value as Vector3).copy(view.cameraLocal);
    (u.uSunColor.value as Color).copy(view.sunColor);

    const sunLum =
      view.sunColor.r * 0.2126 + view.sunColor.g * 0.7152 + view.sunColor.b * 0.0722;
    this.ambSky.copy(this.skyTint).multiplyScalar(sunLum);
    this.ambGround.copy(this.groundTint).multiplyScalar(sunLum);

    // --- render target sizing ----------------------------------------------
    ctx.renderer.getDrawingBufferSize(this.bufSize);
    const scale = Math.min(1, Math.max(0.25, this.resolutionScale));
    const rtW = Math.max(2, Math.round(this.bufSize.x * scale));
    const rtH = Math.max(2, Math.round(this.bufSize.y * scale));
    if (this.rtSize.x !== rtW || this.rtSize.y !== rtH) {
      this.rtSize.set(rtW, rtH);
      this.cloudRT.setSize(rtW, rtH);
    }

    // --- view-dependent LOD ------------------------------------------------
    // Projected size of one *march* pixel at the deck, in km. Everything below
    // is pinned to this: detail finer than a pixel is not detail, it is noise,
    // and noise is what makes a procedural planet look like sandpaper.
    const standoff = Math.max(view.distance - this.rTop, this.layer);
    const pixelKm =
      (2 * Math.tan(view.fovY * 0.5) * standoff) / Math.max(view.viewportHeight * scale, 1);
    const screenPx = (2 * this.rPlanet) / Math.max(pixelKm, 1e-6);

    const baseSteps = Math.min(28, Math.max(8, Math.round(q.atmosphereSteps * 0.6)));
    const stepKm = (this.layer / baseSteps) * Math.max(0.35, this.stepBias);
    u.uStepLen.value = stepKm;
    u.uMaxSteps.value = Math.min(64, Math.max(16, Math.round(q.atmosphereSteps * 1.6)));

    // Erosion cell size: a few march pixels wherever the camera is, capped so it
    // never competes with the shape noise, and floored by what the march can
    // actually resolve *along the ray*. Detail finer than the step length is not
    // detail, it is temporal noise. Flooring on the step rather than on a fixed
    // kilometre count is what lets the cauliflower keep getting finer as the
    // camera descends instead of freezing at a planetary constant — the old
    // `max(detailKm, …)` pinned an Earth-sized world at 7.6 km cells whether you
    // were in orbit or two kilometres up.
    const cellKm = Math.min(
      this.featureKm * 0.35,
      Math.max(pixelKm * 3, stepKm * 1.15, this.detailKm * 0.12),
    );
    u.uDetailFreq.value = 1 / cellKm;
    // Shape octaves follow the cells down. Without this the spectrum has a hole
    // between the finest shape lobe (~featureKm/9) and the erosion, and a close
    // approach reads as one smooth mass with fuzz on it. 2.07 is the lacunarity
    // used in cl_density; keep the two in step.
    const wantOct = Math.log(this.featureKm / Math.max(cellKm * 4, 1e-3)) / Math.log(2.07) + 1;
    u.uShapeOct.value = Math.min(6, Math.max(4, Math.round(wantOct)));
    // The worley path costs roughly five times the billow fallback. Spend it
    // only when there is a planet on screen worth spending it on.
    u.uUseWorley.value = q.tier !== 'low' && screenPx > 120 ? 1 : 0;

    // Light march: geometrically spaced taps towards the star. Total slant is
    // 2.6 layer thicknesses, not four — with four the first tap already lands
    // 0.4 of a layer up and only one of them ever falls *inside* the deck, so
    // the self-shadowing degenerates into a single constant and every cloud
    // gets the same grey. 2.6 puts three taps in the layer for an overhead sun
    // and still reaches the deck above for a grazing one, at the same cost.
    const lightSteps = Math.min(6, Math.max(2, Math.round(q.atmosphereLightSteps * 0.5)));
    u.uLightSteps.value = lightSteps;
    u.uLightStepLen.value =
      (this.layer * 2.6 * (LIGHT_GROWTH - 1)) / (Math.pow(LIGHT_GROWTH, lightSteps) - 1);

    u.uSigmaE.value = (7.5 / this.layer) * this.opticalDepthScale;
    u.uSigmaL.value = (u.uSigmaE.value as number) * 0.4;

    const inside = view.distance < this.rTop * 1.002;
    // Close to the deck the ray runs hundreds of kilometres almost tangentially.
    // Spreading a fixed budget over that distance turns the near field — the
    // only part with any resolvable detail — into flat fog, so from here on in
    // we keep the near step tight and let geometric growth reach the horizon.
    const closeIn = view.distance < this.rTop * 1.12;
    u.uStepGrowth.value = closeIn ? 1.12 : 1;
    u.uInside.value = closeIn ? 1 : 0;
    // Outside: front faces, depth-tested, so nearer geometry occludes us
    // correctly. Inside: the front faces are behind the camera, so we take the
    // back wall and lean on the analytic planet clip instead of the depth
    // buffer. Wire a scene depth texture in here if the pipeline ever grows one.
    this.marchMaterial.side = inside ? BackSide : FrontSide;
    this.compositeMaterial.side = this.marchMaterial.side;
    this.compositeMaterial.depthTest = !inside;

    // Below a couple of pixels across there is nothing to say; skip the whole
    // subsystem rather than spend a render target on it. The first frame still
    // runs, so `getShadowTexture()` is never left null once the planet exists.
    this.mesh.visible = screenPx > 2;
    if (!this.mesh.visible && this.baked) return;

    // --- offscreen passes --------------------------------------------------
    this.frameCounter++;
    const first = !this.baked;
    const r = ctx.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.getClearColor(this.prevClear);
    const prevAlpha = r.getClearAlpha();
    // Explicit, because a post pipeline may well have left autoClear off or the
    // clear alpha at 1 — and a cloud buffer cleared to opaque black would paint
    // the whole shell over the planet.
    r.autoClear = true;
    r.setClearColor(0x000000, 0);

    if (first || this.frameCounter % this.weatherInterval === 0) {
      r.setRenderTarget(this.weatherRT);
      r.render(this.weatherScene, this.bakeCamera);
    }
    if (first || this.frameCounter % this.shadowInterval === 0) {
      r.setRenderTarget(this.shadowRT);
      r.render(this.shadowScene, this.bakeCamera);
    }

    // matrixWorld is stale during update() (the renderer refreshes it later),
    // so pull it up the parent chain ourselves before mirroring it onto the
    // offscreen twin. Both meshes then cover exactly the same pixels.
    this.mesh.updateWorldMatrix(true, false);
    this.marchMesh.matrixWorld.copy(this.mesh.matrixWorld);
    r.setRenderTarget(this.cloudRT);
    r.render(this.marchScene, ctx.camera);

    r.setRenderTarget(prevTarget);
    r.setClearColor(this.prevClear, prevAlpha);
    r.autoClear = prevAutoClear;

    this.baked = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.visible = false;
    this.geometry.dispose();
    this.marchMaterial.dispose();
    this.compositeMaterial.dispose();
    this.bakeGeometry.dispose();
    this.weatherMat.dispose();
    this.shadowMat.dispose();
    // WebGLRenderTarget.dispose() releases the framebuffer and its texture.
    this.cloudRT.dispose();
    this.weatherRT.dispose();
    this.shadowRT.dispose();
    this.marchScene.remove(this.marchMesh);
    this.weatherScene.remove(this.weatherQuad);
    this.shadowScene.remove(this.shadowQuad);
  }
}

/** A linear-data equirectangular map target: no mips, no colour transform. */
function makeMapTarget(w: number, h: number): WebGLRenderTarget {
  const rt = new WebGLRenderTarget(Math.round(w), Math.round(h), {
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    // Longitude wraps, latitude clamps — anything else seams at the date line.
    wrapS: RepeatWrapping,
    wrapT: ClampToEdgeWrapping,
  });
  rt.texture.colorSpace = NoColorSpace;
  rt.texture.name = 'clouds:map';
  return rt;
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

const shotSun = new Vector3();
const shotCentre = new Vector3();
const shotUp = new Vector3();
const shotSide = new Vector3();
const shotDir = new Vector3();
const shotAim = new Vector3();

/**
 * Hero shots for the cloud deck.
 *
 * @param planet   the spec the renderer was built from.
 * @param body     the object whose world position is the planet centre — pass
 *                 `cloudRenderer.object3d`, or the node it is parented to.
 * @param sunLocal unit vector from the planet towards its star, in the space
 *                 `ViewState.sunDirection` uses. Defaults to a three-quarter
 *                 key if the integrator has not placed a star yet.
 */
export function registerCloudShots(
  planet: PlanetSpec,
  body: Object3D,
  sunLocal?: Vector3,
): void {
  const sun = (sunLocal ? shotSun.copy(sunLocal) : shotSun.set(1, 0.16, 0.34))
    .normalize()
    .clone();

  const frame = (
    ctx: EngineContext,
    distance: number,
    sunAngleDeg: number,
    elevation: number,
    aimSide: number,
    aimUp: number,
    rollDeg: number,
  ): void => {
    body.updateWorldMatrix(true, false);
    const centre = body.getWorldPosition(shotCentre);

    const worldUp = Math.abs(sun.y) > 0.9 ? shotUp.set(1, 0, 0) : shotUp.set(0, 1, 0);
    const side = shotSide.crossVectors(worldUp, sun).normalize();
    const up = shotUp.crossVectors(sun, side).normalize();

    const a = (sunAngleDeg * Math.PI) / 180;
    const dir = shotDir
      .copy(sun)
      .multiplyScalar(Math.cos(a))
      .addScaledVector(side, Math.sin(a))
      .addScaledVector(up, elevation)
      .normalize();

    ctx.camera.position.copy(centre).addScaledVector(dir, distance);
    const aim = shotAim
      .copy(centre)
      .addScaledVector(side, planet.radius * aimSide)
      .addScaledVector(up, planet.radius * aimUp);
    // Rolling the camera puts the terminator on a diagonal instead of dead
    // vertical, which is the difference between a diagram and a photograph.
    ctx.camera.up.copy(up).applyAxisAngle(dir, (rollDeg * Math.PI) / 180);
    ctx.camera.lookAt(aim);
    ctx.camera.updateMatrixWorld();
  };

  registerShot({
    name: 'clouds-orbit',
    description:
      'The terminator seen from low orbit, running corner to corner: cloud tops ' +
      'catching the last sodium-orange light, undersides in shadow, the day limb ' +
      'blowing to silver along the bottom, and the night side black.',
    apply(ctx) {
      // 0.1 radii of standoff (~640 km over Earth) is the altitude at which the
      // deck stops being a texture and starts being terrain: cloud tops throw
      // shadows across their neighbours and the layer has visible thickness.
      // 98 degrees off the sun axis puts the camera just past the terminator, so
      // it is looking back into the light — the only geometry in which the
      // forward-scattering lobe and the powder-darkened backs both show at once.
      frame(ctx, planet.radius * 1.1, 98, 0.2, 0.55, -0.42, -15);
    },
  });

  registerShot({
    name: 'clouds-full-disc',
    description:
      'Whole disc from high orbit — coverage bands, cyclonic weather systems, ' +
      'the deck reading as a thin skin at the limb, and the eroded cauliflower ' +
      'edges holding up at planetary scale.',
    apply(ctx) {
      // 1.72 radii out puts the disc a little wider than a 62 degree fov, so the
      // limb arcs out of frame and the deck fills two thirds of it.
      frame(ctx, planet.radius * 1.72, 92, 0.18, 0.3, -0.16, -32);
    },
  });
}
