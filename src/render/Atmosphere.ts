/**
 * Atmosphere — single-scattering Rayleigh + Mie on a raymarched shell.
 *
 * A back-face sphere of radius `planet.radius + atmosphere.thickness` is
 * intersected analytically in the fragment shader and marched. For every view
 * sample a second ray is marched towards the star to get the sun transmittance,
 * the two densities are weighted by `os_phaseRayleigh` / `os_phaseMie`, and the
 * result is integrated with the view-ray transmittance. Rayleigh uses
 * `atmosphere.scaleHeight`; Mie uses a fifth of it, which is the entire reason
 * haze hugs the ground while the blue reaches to space.
 *
 * WHAT IS PRECOMPUTED, AND WHY IT IS WORTH A TEXTURE
 * -------------------------------------------------
 * One 128x64 (64x32 on the low tiers) RGBA16F table is built on the CPU in the
 * constructor. Each texel holds *two scalars*: the Rayleigh and Mie column
 * densities from a point at radius `r` looking at cos-zenith `mu`, out to the
 * top of the atmosphere. Storing optical depth rather than transmittance is
 * deliberate — a Venus-like column reaches exp(-70), which is not a half-float,
 * whereas a column density of 780 is one exactly. Per-channel transmittance is
 * then `exp(-(betaR*odR + betaM*odM))`, evaluated in float32 in the shader, so
 * a methane world and an oxygen world differ purely through their coefficients.
 *
 * The parameterisation is Bruneton & Neyret's (2008): `uR = sqrt((r-Rg)/(Rt-Rg))`
 * concentrates rows near the ground where the density actually changes, and the
 * `atan` mapping on `mu` spends half the table within ten degrees of the horizon
 * where the slant path explodes. The CPU builder and the GLSL sampler use the
 * same two lines; if you touch one, touch the other.
 *
 * That table buys two things:
 *
 *  1. **Per-channel aerial-perspective extinction at full resolution.** The
 *     background needs `dst * T(A->B)`, and `T(A->B) = T(A->top) / T(B->top)`
 *     for any two points on one ray. Two table fetches replace a march, so the
 *     extinction of terrain, stars and cloud tops is computed at *full* res and
 *     stays razor sharp across a mountain silhouette even though the scattering
 *     itself is marched at half res.
 *  2. **The sun-transmittance fast path.** When `quality.atmosphereLightSteps`
 *     resolves to zero — the `low` tier, or a planet under ~220 px — the inner
 *     loop collapses to one fetch. It is not an approximation of the march; for
 *     a spherically symmetric shell it is the converged answer the march is
 *     trying to reach.
 *
 * Kept per-pixel: the whole view march (positions, phase, ordering against the
 * depth buffer, the transmittance early-out) and, above the low tier, the
 * secondary sun march itself. The march is kept because it is the only path
 * that resolves the *penumbra* — the softened planet shadow that makes the
 * terminator a band rather than a cut — at the sample rather than at table
 * resolution, and because it is where cloud or terrain shadowing would be
 * plugged in later. Its steps grow geometrically so eight taps still land
 * mostly inside the first scale height.
 *
 * COMPOSITING: TWO DRAWS, NOT ONE
 * -------------------------------
 * The correct composite is `dst * T + I` with `T` *per channel* — and per
 * channel is the whole point, because Rayleigh eats blue four times faster than
 * red. There is no WebGL2 blend mode that multiplies the destination by an
 * arbitrary source vector and adds another in one pass, so this draws the shell
 * twice:
 *
 *   1. extinction  `blendSrc: Zero, blendDst: OneMinusSrcColor`, writing `1-T`
 *                  -> `dst * T`, exact, full resolution, LUT-driven.
 *   2. inscatter   `blendSrc: One,  blendDst: One`, writing `I`
 *                  -> `+ I`, upsampled from the half-res march.
 *
 * Two extra draw calls for physically correct aerial perspective is a trade
 * worth making. Both draws depth-test identically so they can never disagree.
 *
 * PERFORMANCE
 * -----------
 * The march runs at `resolutionScale` (0.5 by default, 0.35 low / 0.7 ultra) of
 * the drawing buffer into an RGBA16F target; the two composite draws are full
 * resolution. Budget at 1080p `high` with the shell filling the frame: ~24 view
 * steps x ~8 growing light steps at quarter the pixels, plus two nearly
 * fragment-free full-res draws. The upsample is a *joint bilateral* filter
 * keyed on the same depth texture the march used, so half res does not smear
 * haze across a ridge line; without a depth texture it degrades to bilinear.
 *
 * DEPTH
 * -----
 * `setDepthTexture()` is optional. With it, the march and the extinction both
 * stop at the terrain and the result is aerial perspective. Without it, both
 * fall back to the analytic planet sphere: the limb glow and the sky are still
 * right, mountains just get sea-level haze. See the method for the wiring rules
 * — in particular, it must not be the depth buffer currently being rendered
 * into.
 */

import {
  AddEquation,
  BackSide,
  ClampToEdgeWrapping,
  Color,
  CustomBlending,
  DataTexture,
  DataUtils,
  FrontSide,
  Group,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NearestFilter,
  NoBlending,
  NoColorSpace,
  Object3D,
  OneFactor,
  OneMinusSrcColorFactor,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  ZeroFactor,
  type IUniform,
  type Texture,
} from 'three';

import type { EngineContext } from '@/core/Engine';
import type { QualitySettings } from '@/core/Config';
import type { AtmosphereSpec, PlanetSpec } from '@/gen/types';
import { registerShot } from '@/game/Shots';
import { registerShaderChunks } from '@/shaders/chunks';
import type { ViewState } from '@/render/ViewState';

/**
 * Draw order. Above the cloud deck (8) and the ring plane (12): forward-
 * scattered haze has to wash over cloud tops at the limb, and a ring seen
 * through 100 km of air must pick up the same haze the ground does.
 */
export const ATMOSPHERE_RENDER_ORDER = 16;

/** Mie's scale height as a fraction of Rayleigh's. Earth is 1.2 km against 8.5. */
const MIE_SCALE_HEIGHT_RATIO = 0.2;

/**
 * Mie extinction over Mie scattering. Aerosols absorb as well as scatter, and
 * without the surplus a thick haze layer never darkens what is behind it.
 */
const MIE_EXTINCTION_RATIO = 1.1;

/**
 * `ViewState.sunColor` is documented as linear RGB times intensity, and the
 * surface shaders in this project use it directly as `albedo * sunColor * NdotL`
 * — i.e. they fold the Lambertian 1/pi into the constant. Scattering integrals
 * are in true irradiance, so multiplying by pi puts sky radiance on the same
 * scale as the lit ground it has to sit next to. Get this wrong and a correct
 * atmosphere still reads as a dark smear against a bright planet.
 */
const IRRADIANCE_FROM_SUNCOLOR = Math.PI;

/** Isotropic phase, 1/(4pi). */
const ISOTROPIC_PHASE = 0.079577472;

/** Geometric growth of the sun-march step. Mirrored in GLSL below. */
const LIGHT_GROWTH = 1.55;

/** `tan(1.386)` — the constant in Bruneton's mu mapping. Mirrored in GLSL. */
const MU_MAP_TAN = Math.tan(1.386);

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const SHELL_VS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLocal;
varying vec3 vView;
void main() {
  vLocal = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // View-space position doubles as the ray direction (the camera is the view
  // origin), which is how the log-depth buffer gets turned back into a distance
  // *along this ray* rather than along the camera axis.
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

/**
 * Shared geometry, table lookups and ray clipping. Included by both the march
 * and the extinction pass so the two can never disagree about where the
 * atmosphere starts and stops — a disagreement of one pixel there shows up as a
 * bright or dark seam along the whole terminator.
 */
const FIELD_GLSL = /* glsl */ `
uniform sampler2D uLut;
uniform sampler2D uDepthTex;
uniform vec3  uCameraLocal;
uniform vec3  uSunDir;
uniform vec3  uBetaR;        // Rayleigh scattering, 1/km, per channel
uniform float uBetaM;        // Mie scattering, 1/km
uniform float uBetaMExt;     // Mie extinction, 1/km
uniform float uHR;           // Rayleigh scale height, km
uniform float uHM;           // Mie scale height, km
uniform float uRPlanet;
uniform float uRAtmo;
uniform float uLogFar;       // log2(camera.far + 1) — the log-depth decoder
uniform float uHasDepth;

varying vec3 vLocal;
varying vec3 vView;

/**
 * Table lookup: (Rayleigh, Mie) column density from (r, mu) to the top of the
 * atmosphere. Bruneton & Neyret 2008 mapping — sqrt in altitude, atan in mu.
 * 5.334981 is tan(1.386); the -0.1975 floor is the horizon for r ~ Rt, below
 * which the ray is inside the planet and the table has nothing to say.
 */
vec2 at_lutOD(float r, float mu) {
  float uR = sqrt(clamp((r - uRPlanet) / max(uRAtmo - uRPlanet, 1e-4), 0.0, 1.0));
  float uMu = 0.5 * (atan(max(mu, -0.1975) * 5.334981) / 1.1 + (1.0 - 0.26));
  return texture2D(uLut, vec2(uMu, uR)).rg;
}

/** Transmittance from (r, mu) to space. */
vec3 at_lutT(float r, float mu) {
  vec2 od = at_lutOD(clamp(r, uRPlanet, uRAtmo), mu);
  return exp(-(uBetaR * od.x + uBetaMExt * od.y));
}

/**
 * Transmittance along a finite segment: start at A, travel d km along rd.
 * Two table fetches instead of a march, because for points on one ray
 * T(A->B) = T(A->space) / T(B->space). When the ray dips through the ground the
 * roles swap and both lookups are taken on the reversed ray — that branch is
 * not optional, it is what keeps a downward-looking orbital ray finite.
 */
vec3 at_segmentT(vec3 A, vec3 rd, float d) {
  float r = length(A);
  float mu = dot(A, rd) / max(r, 1e-4);
  r = clamp(r, uRPlanet, uRAtmo);
  float rd2 = sqrt(max(d * d + 2.0 * r * mu * d + r * r, 1e-8));
  float mud = clamp((r * mu + d) / rd2, -1.0, 1.0);
  rd2 = clamp(rd2, uRPlanet, uRAtmo);

  bool ground = (mu < 0.0) && (r * r * (mu * mu - 1.0) + uRPlanet * uRPlanet >= 0.0);
  vec2 a = ground ? at_lutOD(rd2, -mud) : at_lutOD(r, mu);
  vec2 b = ground ? at_lutOD(r, -mu)    : at_lutOD(rd2, mud);
  vec2 od = max(a - b, vec2(0.0));
  return clamp(exp(-(uBetaR * od.x + uBetaMExt * od.y)), 0.0, 1.0);
}

/**
 * Clip the ray to the lit span of atmosphere in front of whatever the scene
 * already drew. Returns false when there is nothing left to integrate.
 *
 * 'resolution' is the size of the buffer this shader is writing into; the depth
 * texture is always full resolution and is addressed in normalised uv, so the
 * half-res march and the full-res composite read exactly the same texels.
 */
bool at_span(vec3 ro, vec3 rd, vec2 resolution, out float t0, out float t1) {
  vec2 ta = os_raySphere(ro, rd, uRAtmo);
  if (ta.x > ta.y || ta.y <= 0.0) return false;
  t0 = max(ta.x, 0.0);
  t1 = ta.y;

  // The solid body. Always applied, depth texture or not: it is the fallback
  // that keeps the shell correct over the disc when no depth is supplied, and
  // a cheap early clip when one is.
  vec2 tp = os_raySphere(ro, rd, uRPlanet);
  if (tp.x <= tp.y && tp.y > 0.0) t1 = min(t1, max(tp.x, 0.0));

  if (uHasDepth > 0.5) {
    float d = texture2D(uDepthTex, gl_FragCoord.xy / resolution).x;
    // 1.0 is the cleared far value — nothing was drawn, the ray runs to space.
    if (d < 0.999999) {
      // Logarithmic depth (ARCHITECTURE section 3): d = log2(1+w)/log2(far+1),
      // where w is distance along the camera axis. Divide by the cosine to the
      // camera axis to convert it into distance along *this* ray.
      float w = exp2(d * uLogFar) - 1.0;
      t1 = min(t1, w / max(-normalize(vView).z, 1e-4));
    }
  }
  return t1 > t0;
}
`;

/**
 * The march. Rendered offscreen at `resolutionScale`, never straight to the
 * screen, and it writes in-scattered radiance only — the extinction of whatever
 * is behind it is a separate, sharper, full-resolution pass.
 */
const MARCH_FS = /* glsl */ `
#include <common>
#include <onespace_color>
#include <onespace_atmosphere>
${FIELD_GLSL}

uniform vec3  uSunColor;
uniform vec3  uGroundAlbedo;
uniform vec2  uResolution;
uniform float uG;             // Mie anisotropy
uniform float uIntensity;
uniform float uMultiScatter;
uniform float uGroundBounce;
uniform float uTermSoft;
uniform int   uSteps;
uniform int   uLightSteps;

#define LIGHT_GROWTH 1.55

/**
 * Redistribute a uniform 0..1 along the ray so that samples pile up at 'c',
 * the fraction of the span at which the ray is closest to the planet centre.
 *
 * That point is where the air is densest, and it is *always* where the budget
 * belongs: on a limb ray it is the tangent point in the middle of a thousand
 * kilometre chord; on a ray from the ground looking up it is the camera itself;
 * on a ray from orbit onto the disc it is the terrain the ray terminates on.
 * One warp covers all three, which is why there is no separate "am I inside"
 * branch. Two quadratic halves, exact at both ends, zero derivative at c.
 */
float at_warp(float x, float c) {
  if (x < c) {
    float v = (c - x) / max(c, 1e-4);
    return c * (1.0 - v * v);
  }
  float v = (x - c) / max(1.0 - c, 1e-4);
  return c + (1.0 - c) * v * v;
}

/**
 * Exact integral of os_density over one segment, given the altitude at each
 * end and assuming it ramps linearly between them.
 *
 * This matters more than it looks. Density halves every 5.9 km on Earth, and a
 * two dozen step march inevitably lands segments several scale heights long in
 * the middle of the profile — where a midpoint sample is wrong by fifteen per
 * cent. Blue-noise jitter then converts that systematic error into per-pixel
 * *noise*, and because the segment layout is anchored to whatever the depth
 * buffer said, the noise tracks the terrain and comes out as a moire crawling
 * over the ground. Integrating the exponential in closed form removes the
 * error rather than dithering it, and costs one extra exp per step.
 */
float at_segDensity(float altA, float altB, float H, float ds) {
  float a = max(altA, 0.0);
  float b = max(altB, 0.0);
  float ea = os_density(a, H);
  float eb = os_density(b, H);
  float d = a - b;
  // Flat segment (and the ray's tangent point, where altitude is stationary):
  // the closed form is 0/0 there, and the trapezoid is exact to first order.
  if (abs(d) < 1e-4 * H) return 0.5 * (ea + eb) * ds;
  return H * ds * (eb - ea) / d;
}

/**
 * Sun transmittance at p, including the planet's own shadow.
 *
 * The shadow test is done in cos(phi) rather than in perpendicular distance:
 * the distance form collapses the entire penumbra into a couple of degrees and
 * the terminator reads as a razor cut across the sky instead of as dusk.
 */
vec3 at_sunTransmittance(vec3 p, float r) {
  float mu = dot(p, uSunDir) / r;
  // cos of the direction that just grazes the planet limb from here.
  float cosTerm = -sqrt(max(0.0, 1.0 - (uRPlanet * uRPlanet) / (r * r)));
  float vis = smoothstep(cosTerm - uTermSoft, cosTerm + uTermSoft, mu);
  if (vis <= 0.002) return vec3(0.0);

  if (uLightSteps <= 0) return at_lutT(r, mu) * vis;

  // Secondary march to the top of the atmosphere. Steps grow geometrically:
  // density falls off exponentially *upwards*, so half the budget belongs in
  // the first scale height and the tail only has to not be missed entirely.
  // With uniform steps, eight taps on a 300 km slant put the first sample
  // 37 km up and the near field — which carries most of the optical depth —
  // is never sampled at all.
  float tTop = max(os_raySphere(p, uSunDir, uRAtmo).y, 0.0);
  float n = float(uLightSteps);
  float ds = tTop * (LIGHT_GROWTH - 1.0) / (pow(LIGHT_GROWTH, n) - 1.0);
  float t = 0.0;
  float odR = 0.0;
  float odM = 0.0;
  // Bound by a uniform, never a literal: a literal lets the driver unroll this
  // into the view march and inline several hundred exp() per pixel.
  for (int i = 0; i < uLightSteps; i++) {
    float alt = length(p + uSunDir * (t + ds * 0.5)) - uRPlanet;
    odR += os_density(alt, uHR) * ds;
    odM += os_density(alt, uHM) * ds;
    t += ds;
    ds *= LIGHT_GROWTH;
  }
  return exp(-(uBetaR * odR + uBetaMExt * odM)) * vis;
}

void main() {
  vec3 ro = uCameraLocal;
  vec3 rd = normalize(vLocal - ro);

  float t0, t1;
  if (!at_span(ro, rd, uResolution, t0, t1)) discard;

  // Blue-noise offset of the whole segment grid. Everything downstream tiles
  // the span exactly, so this dithers *where the boundaries fall* rather than
  // adding noise to the result: at a dozen steps across a 500 km chord a fixed
  // grid quantises the limb into visible rings, and the grain this leaves in
  // their place is below what the grade's own film grain already carries.
  float jitter = os_igNoise(gl_FragCoord.xy) - 0.5;

  float span = t1 - t0;
  float n = float(uSteps);
  // Closest approach to the planet centre, clamped into the marched span.
  float c = clamp((clamp(-dot(ro, rd), t0, t1) - t0) / max(span, 1e-6), 0.0, 1.0);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  vec3 sumIso = vec3(0.0);
  float odR = 0.0;
  float odM = 0.0;
  float prev = 0.0;
  float altA = length(ro + rd * t0) - uRPlanet;

  for (int i = 0; i < uSteps; i++) {
    // Segment boundaries, not sample points. The last one is pinned to the end
    // of the span so the jittered grid still tiles it exactly — no density is
    // counted twice, and none falls off the end.
    float xb = (i == uSteps - 1) ? 1.0 : clamp((float(i) + 1.0 + jitter) / n, 0.0, 1.0);
    float next = span * at_warp(xb, c);
    float ds = next - prev;
    float tA = t0 + prev;
    prev = next;
    float altB = length(ro + rd * (t0 + next)) - uRPlanet;
    float alt0 = altA;
    altA = altB;
    if (ds <= 1e-7) continue;

    float dR = at_segDensity(alt0, altB, uHR, ds);
    float dM = at_segDensity(alt0, altB, uHM, ds);

    // Sample the *lighting* at the altitude whose density equals the segment's
    // mean — the segment's centre of scattering mass, which on a steep segment
    // is well below its midpoint. Placing it there rather than at the middle is
    // what keeps the terminator from stepping as the segment layout shifts.
    float altE = -uHR * log(clamp(dR / ds, 1e-20, 1.0));
    float u = abs(alt0 - altB) < 1e-3 ? 0.5 : clamp((alt0 - altE) / (alt0 - altB), 0.0, 1.0);

    vec3 p = ro + rd * (tA + ds * u);
    float r = max(length(p), uRPlanet);

    // Half the step's own extinction before the sample and half after. Using
    // the whole step either way biases every optical depth by half a step,
    // which at a dozen steps is a visible brightness shift at the limb.
    odR += dR * 0.5;
    odM += dM * 0.5;
    vec3 viewT = exp(-(uBetaR * odR + uBetaMExt * odM));
    odR += dR * 0.5;
    odM += dM * 0.5;

    // Nothing beyond here can reach the camera. On a thick world this kills
    // most of the march the moment the ray enters the lower atmosphere.
    if (max(viewT.r, max(viewT.g, viewT.b)) < 0.0015) break;

    vec3 direct = uSunColor * at_sunTransmittance(p, r);

    sumR += dR * viewT * direct;
    sumM += dM * viewT * direct;

    // Everything that has scattered more than once, plus light bounced off the
    // ground, arrives from every direction at once — so it goes in an isotropic
    // bucket rather than through a phase function. Single scattering alone
    // leaves the sky far too dark away from the sun and gives a shadowed limb
    // nothing at all; the ground term is what stops low haze reading as blue
    // smoke over an ochre desert.
    vec3 iso = direct * uMultiScatter
             + direct * uGroundAlbedo * (uGroundBounce * max(dot(p / r, uSunDir), 0.0));
    sumIso += (uBetaR * dR + vec3(uBetaM * dM)) * viewT * iso;
  }

  float cosT = dot(rd, uSunDir);
  vec3 col = (sumR * uBetaR * os_phaseRayleigh(cosT)
            + sumM * (uBetaM * os_phaseMie(cosT, uG))
            + sumIso * ${ISOTROPIC_PHASE.toFixed(9)})
           * uIntensity;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

/**
 * Extinction. Draws the shell with `Zero / OneMinusSrcColor`, so writing `1-T`
 * multiplies the framebuffer by the per-channel transmittance of the air in
 * front of it. Full resolution and analytic: two table fetches, no march.
 *
 * This is the pass that makes a landscape read as a landscape — distant ridges
 * lose their contrast and their red before the haze is even added on top — and
 * it is also what dims a star seen through the limb.
 */
const EXTINCT_FS = /* glsl */ `
#include <common>
#include <onespace_atmosphere>
#include <logdepthbuf_pars_fragment>
${FIELD_GLSL}

uniform vec2 uResolution;

void main() {
  #include <logdepthbuf_fragment>
  vec3 ro = uCameraLocal;
  vec3 rd = normalize(vLocal - ro);

  float t0, t1;
  if (!at_span(ro, rd, uResolution, t0, t1)) discard;

  vec3 T = at_segmentT(ro + rd * t0, rd, t1 - t0);
  // NOT a colour: this is a blend factor, so it must never see the output
  // colour-space transform. See the blend setup on the material.
  gl_FragColor = vec4(clamp(vec3(1.0) - T, 0.0, 1.0), 0.0);
}
`;

/**
 * In-scatter resolve. Additive, full resolution, upsampled from the half-res
 * march with a joint bilateral filter keyed on the scene depth the march itself
 * sampled — the four taps are exactly the four low-res pixels, so a tap that
 * landed on a distant valley cannot leak its haze onto the ridge in front.
 */
const INSCATTER_FS = /* glsl */ `
#include <common>
#include <onespace_color>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uScatterTex;
uniform sampler2D uDepthTex;
uniform vec2  uResolution;
uniform vec2  uMarchRes;
uniform float uHasDepth;
varying vec3 vLocal;
varying vec3 vView;

void main() {
  #include <logdepthbuf_fragment>
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec3 c;

  if (uHasDepth > 0.5) {
    float dc = texture2D(uDepthTex, uv).x;
    vec2 p = uv * uMarchRes - 0.5;
    vec2 base = floor(p);
    vec2 f = p - base;
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    for (int j = 0; j < 2; j++) {
      for (int i = 0; i < 2; i++) {
        vec2 o = vec2(float(i), float(j));
        vec2 tuv = (base + o + 0.5) / uMarchRes;
        float bw = mix(1.0 - f.x, f.x, o.x) * mix(1.0 - f.y, f.y, o.y);
        // The buffer is logarithmic, so a fixed epsilon here is a roughly
        // constant *ratio* of distances at every scale — one exponent works
        // from a cockpit strut to a limb 20 000 km away. 150 keeps a 1%
        // depth difference at full weight and rejects a doubling outright.
        float w = bw * exp(-abs(texture2D(uDepthTex, tuv).x - dc) * 150.0);
        sum += texture2D(uScatterTex, tuv).rgb * w;
        wsum += w;
      }
    }
    c = sum / max(wsum, 1e-4);
  } else {
    c = texture2D(uScatterTex, uv).rgb;
  }

  gl_FragColor = vec4(max(c, 0.0), 0.0);
  #include <colorspace_fragment>
  // Identity into PostFX's linear HDR target; the real work is on the direct-
  // to-canvas path, where a sky gradient across 1080 rows crosses barely thirty
  // 8-bit codes and bands in rings without this.
  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`;

// ---------------------------------------------------------------------------
// Transmittance table (CPU, once, at construction)
// ---------------------------------------------------------------------------

/**
 * Column density from (r, mu) to the top of the atmosphere, for every texel of
 * the table. `r` is a radius in km, `mu` the cosine of the angle between the
 * local vertical and the ray.
 *
 * Red = Rayleigh column, green = Mie column, both in km (density is
 * dimensionless, 1 at the surface). Multiplying by the scattering coefficients
 * in the shader is what makes the table planet-independent per channel.
 *
 * Cost: `width * height * steps` exponential pairs — 128*64*32 is about a
 * quarter of a million, well under a millisecond, and it happens once when a
 * planet is created rather than per frame.
 */
function buildTransmittanceLut(
  rGround: number,
  rTop: number,
  hR: number,
  hM: number,
  width: number,
  height: number,
  steps: number,
): DataTexture {
  const data = new Uint16Array(width * height * 4);
  const span = rTop - rGround;

  for (let row = 0; row < height; row++) {
    // Inverse of the GLSL mapping. Squaring in altitude packs rows into the
    // first scale height, where all of the density is.
    const uR = (row + 0.5) / height;
    const r = rGround + uR * uR * span;

    for (let col = 0; col < width; col++) {
      const uMu = (col + 0.5) / width;
      const mu = clamp(Math.tan((2 * uMu - 1 + 0.26) * 1.1) / MU_MAP_TAN, -1, 1);

      // Distance from (r, mu) to the top boundary. For downward rays this
      // segment passes through the planet; that is intentional and matches the
      // reversed-ray branch of at_segmentT, which is the only consumer.
      const disc = r * r * (mu * mu - 1) + rTop * rTop;
      const d = -r * mu + Math.sqrt(Math.max(disc, 0));

      let odR = 0;
      let odM = 0;
      const dt = d / steps;
      for (let k = 0; k < steps; k++) {
        const t = dt * (k + 0.5);
        const ri = Math.sqrt(Math.max(r * r + t * t + 2 * r * t * mu, 0));
        // Clamped at the surface, exactly as os_density does, so a sample that
        // has burrowed into the planet contributes surface density rather than
        // an exponential blow-up.
        const alt = Math.max(0, ri - rGround);
        odR += Math.exp(-alt / hR);
        odM += Math.exp(-alt / hM);
      }

      const i = (row * width + col) * 4;
      data[i] = DataUtils.toHalfFloat(odR * dt);
      data[i + 1] = DataUtils.toHalfFloat(odM * dt);
      data[i + 2] = 0;
      data[i + 3] = DataUtils.toHalfFloat(1);
    }
  }

  const tex = new DataTexture(data, width, height, RGBAFormat, HalfFloatType);
  tex.name = 'atmosphere:transmittance';
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.colorSpace = NoColorSpace;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

type Uniforms = Record<string, IUniform>;

export class AtmosphereRenderer {
  readonly object3d: Object3D;

  /**
   * Resolution of the march relative to the drawing buffer. The two composite
   * draws are always full resolution, so this only softens the scattering
   * itself — which is a smooth field. Initialised from the tier.
   */
  resolutionScale: number;

  /** Artistic gain on top of `spec.atmosphere.intensity`. */
  exposure = 1;

  /**
   * Weight of the isotropic second-order term. 0 is physically "single
   * scattering only" and looks it: a black night side and a sky that dies
   * thirty degrees from the sun.
   */
  multiScatter = 0.5;

  /** Weight of the ground-bounce term feeding the same isotropic bucket. */
  groundBounce = 0.35;

  private readonly rPlanet: number;
  private readonly rAtmo: number;
  private readonly hullRadius: number;
  /** `spec.intensity` folded with the irradiance conversion, before `exposure`. */
  private readonly baseIntensity: number;

  private readonly geometry: SphereGeometry;
  private readonly marchMaterial: ShaderMaterial;
  private readonly extinctMaterial: ShaderMaterial;
  private readonly inscatterMaterial: ShaderMaterial;
  private readonly extinctMesh: Mesh;
  private readonly inscatterMesh: Mesh;
  private readonly marchMesh: Mesh;
  private readonly marchScene = new Scene();
  private readonly scatterRT: WebGLRenderTarget;
  private readonly lut: DataTexture;
  private readonly blankDepth: DataTexture;

  private readonly shared: Uniforms;
  private readonly mu: Uniforms;
  private readonly eu: Uniforms;
  private readonly iu: Uniforms;

  // Preallocated scratch. update() allocates nothing.
  private readonly camLocal = new Vector3(0, 0, 1);
  private readonly sunDir = new Vector3(0, 0, 1);
  private readonly sunColor = new Color(1, 1, 1);
  private readonly bufSize = new Vector2(1, 1);
  private readonly marchRes = new Vector2(2, 2);
  private readonly fullRes = new Vector2(2, 2);
  private readonly prevClear = new Color();

  private disposed = false;

  constructor(planet: PlanetSpec, quality: QualitySettings) {
    const spec: AtmosphereSpec | null = planet.atmosphere;
    if (!spec) {
      throw new Error(`AtmosphereRenderer: ${planet.name} has no atmosphere`);
    }
    registerShaderChunks();

    this.rPlanet = planet.radius;
    this.rAtmo = planet.radius + spec.thickness;
    this.baseIntensity = spec.intensity * IRRADIANCE_FROM_SUNCOLOR;

    // A tessellated sphere sits *inside* the analytic one it is standing in
    // for; inflate by the sagitta of the widest ring so the hull can never clip
    // the limb it is supposed to be drawing. 96x48 keeps that inflation to two
    // parts in a thousand, which matters on a thin atmosphere where a lazier
    // tessellation would push the hull further out than the air itself.
    const segY = 48;
    this.hullRadius = this.rAtmo / Math.cos(Math.PI / segY);
    this.geometry = new SphereGeometry(this.hullRadius, 96, segY);

    // --- table -------------------------------------------------------------
    const fine = quality.tier === 'high' || quality.tier === 'ultra';
    this.lut = buildTransmittanceLut(
      this.rPlanet,
      this.rAtmo,
      spec.scaleHeight,
      spec.scaleHeight * MIE_SCALE_HEIGHT_RATIO,
      fine ? 128 : 64,
      fine ? 64 : 32,
      fine ? 32 : 24,
    );

    // A 1x1 stand-in so the depth sampler is always bound to something known.
    // Relying on the driver's default texture for an unused sampler is how you
    // get one vendor rendering black.
    this.blankDepth = new DataTexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      RGBAFormat,
      UnsignedByteType,
    );
    this.blankDepth.name = 'atmosphere:no-depth';
    this.blankDepth.minFilter = NearestFilter;
    this.blankDepth.magFilter = NearestFilter;
    this.blankDepth.colorSpace = NoColorSpace;
    this.blankDepth.needsUpdate = true;

    this.resolutionScale =
      quality.tier === 'low' ? 0.35 : quality.tier === 'ultra' ? 0.7 : 0.5;

    // HDR. The forward Mie lobe at the terminator is two orders of magnitude
    // above the zenith sky in the same frame; 8 bits cannot hold both ends and
    // the grade needs the headroom to roll the bright one off.
    this.scatterRT = new WebGLRenderTarget(2, 2, {
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
    this.scatterRT.texture.colorSpace = NoColorSpace;
    this.scatterRT.texture.name = 'atmosphere:scatter';

    // --- uniforms ----------------------------------------------------------
    // These objects are shared by reference between materials, so one write in
    // update() reaches every pass that reads them.
    this.shared = {
      uLut: { value: this.lut },
      uDepthTex: { value: this.blankDepth },
      uCameraLocal: { value: this.camLocal },
      uSunDir: { value: this.sunDir },
      uBetaR: {
        value: new Vector3(spec.rayleigh[0], spec.rayleigh[1], spec.rayleigh[2]),
      },
      uBetaM: { value: spec.mie },
      uBetaMExt: { value: spec.mie * MIE_EXTINCTION_RATIO },
      uHR: { value: spec.scaleHeight },
      uHM: { value: spec.scaleHeight * MIE_SCALE_HEIGHT_RATIO },
      uRPlanet: { value: this.rPlanet },
      uRAtmo: { value: this.rAtmo },
      uLogFar: { value: 40 },
      uHasDepth: { value: 0 },
    };

    // Half of the palette's mid tone: bare ground reflects a fraction of what
    // hits it, and the fog over a basalt plain must not glow like snow.
    const alb = planet.palette.mid;

    this.mu = {
      ...this.shared,
      uResolution: { value: this.marchRes },
      uSunColor: { value: this.sunColor },
      uGroundAlbedo: { value: new Vector3(alb[0] * 0.5, alb[1] * 0.5, alb[2] * 0.5) },
      uG: { value: clamp(spec.mieAnisotropy, -0.95, 0.95) },
      uIntensity: { value: this.baseIntensity },
      uMultiScatter: { value: this.multiScatter },
      uGroundBounce: { value: this.groundBounce },
      // Half-width of the shadow penumbra in cos(phi). Scaled by how deep the
      // air is relative to the body: the reason a terminator is soft at all is
      // that air bends and scatters light around the limb, so a thick
      // atmosphere earns a long dusk and an airless rock would earn none.
      uTermSoft: {
        value: clamp((spec.thickness / planet.radius) * 2.2, 0.008, 0.12),
      },
      uSteps: { value: 16 },
      uLightSteps: { value: 6 },
    };

    this.eu = {
      ...this.shared,
      uResolution: { value: this.fullRes },
    };

    this.iu = {
      uScatterTex: { value: this.scatterRT.texture },
      uDepthTex: this.shared.uDepthTex,
      uHasDepth: this.shared.uHasDepth,
      uResolution: { value: this.fullRes },
      uMarchRes: { value: this.marchRes },
    };

    // --- materials ---------------------------------------------------------
    this.marchMaterial = new ShaderMaterial({
      name: 'os.atmosphere.march',
      uniforms: this.mu,
      vertexShader: SHELL_VS,
      fragmentShader: MARCH_FS,
      blending: NoBlending,
      depthWrite: false,
      depthTest: false,
      side: FrontSide,
      toneMapped: false,
    });

    // dst *= T. `1 - T` goes out in the colour channels and the blend does the
    // rest; there is no other way to get a per-channel destination multiply out
    // of a WebGL2 fixed-function blend.
    this.extinctMaterial = new ShaderMaterial({
      name: 'os.atmosphere.extinction',
      uniforms: this.eu,
      vertexShader: SHELL_VS,
      fragmentShader: EXTINCT_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: FrontSide,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: ZeroFactor,
      blendDst: OneMinusSrcColorFactor,
      toneMapped: false,
    });

    // dst += I.
    this.inscatterMaterial = new ShaderMaterial({
      name: 'os.atmosphere.inscatter',
      uniforms: this.iu,
      vertexShader: SHELL_VS,
      fragmentShader: INSCATTER_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: FrontSide,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      toneMapped: false,
    });

    const root = new Group();
    root.name = `atmosphere:${planet.id}`;

    this.extinctMesh = new Mesh(this.geometry, this.extinctMaterial);
    this.extinctMesh.renderOrder = ATMOSPHERE_RENDER_ORDER;
    this.extinctMesh.frustumCulled = false;

    this.inscatterMesh = new Mesh(this.geometry, this.inscatterMaterial);
    // Strictly after the extinction: the haze is added to a background that has
    // already been attenuated, never the other way round.
    this.inscatterMesh.renderOrder = ATMOSPHERE_RENDER_ORDER + 1;
    this.inscatterMesh.frustumCulled = false;

    root.add(this.extinctMesh, this.inscatterMesh);
    this.object3d = root;

    // The offscreen twin. Shares the geometry and is handed the group's world
    // matrix each frame so it covers exactly the pixels the composite will.
    this.marchMesh = new Mesh(this.geometry, this.marchMaterial);
    this.marchMesh.frustumCulled = false;
    this.marchMesh.matrixAutoUpdate = false;
    this.marchScene.add(this.marchMesh);
    this.marchScene.matrixWorldAutoUpdate = false;
  }

  /**
   * Hand the renderer the scene depth buffer. Optional, and the single most
   * valuable thing the integrator can wire up: without it the shell falls back
   * to a smooth sphere at `planet.radius`, which costs aerial perspective over
   * terrain and lets the sky draw over anything in the cockpit.
   *
   * Rules:
   *  - It must be the depth attachment of the buffer the scene was rendered
   *    into, at full drawing-buffer resolution, addressed in normalised uv.
   *  - It must NOT be the depth buffer currently bound for writing — that is a
   *    feedback loop. Use a depth prepass, or the read buffer of a ping-pong
   *    pair (this is what `PostFX`'s two HDR targets already give you).
   *  - The decoder assumes `logarithmicDepthBuffer: true`, which `Engine` sets.
   *    `camera.far` is read from the context every frame, so changing it is
   *    free.
   *
   * Pass `null` to go back to the analytic fallback.
   */
  setDepthTexture(depth: Texture | null): void {
    this.shared.uDepthTex.value = depth ?? this.blankDepth;
    this.shared.uHasDepth.value = depth ? 1 : 0;
  }

  /** The precomputed column-density table, for anyone who wants to inspect it. */
  getTransmittanceLut(): Texture {
    return this.lut;
  }

  update(dt: number, ctx: EngineContext, view: ViewState): void {
    // Re-binding freed GPU handles is a use-after-free, not a graceful
    // degradation.
    if (this.disposed) return;

    const q = ctx.quality;
    const u = this.mu;

    this.camLocal.copy(view.cameraLocal);
    this.sunDir.copy(view.sunDirection);
    this.sunColor.copy(view.sunColor);
    this.shared.uLogFar.value = Math.log2(ctx.camera.far + 1);

    u.uIntensity.value = this.baseIntensity * Math.max(0, this.exposure);
    u.uMultiScatter.value = this.multiScatter;
    u.uGroundBounce.value = this.groundBounce;

    // --- target sizing -----------------------------------------------------
    ctx.renderer.getDrawingBufferSize(this.bufSize);
    this.fullRes.copy(this.bufSize);
    const scale = clamp(this.resolutionScale, 0.25, 1);
    const rtW = Math.max(2, Math.round(this.bufSize.x * scale));
    const rtH = Math.max(2, Math.round(this.bufSize.y * scale));
    if (this.marchRes.x !== rtW || this.marchRes.y !== rtH) {
      this.marchRes.set(rtW, rtH);
      this.scatterRT.setSize(rtW, rtH);
    }

    // --- LOD ---------------------------------------------------------------
    const inside = view.distance < this.hullRadius;
    const standoff = Math.max(view.distance - this.rAtmo, 1e-3);
    const pixelKm =
      (2 * Math.tan(view.fovY * 0.5) * standoff) /
      Math.max(view.viewportHeight * scale, 1);
    const screenPx = inside ? 1e9 : (2 * this.rAtmo) / Math.max(pixelKm, 1e-9);

    // Fraction of the march buffer's height the shell covers. A planet that is
    // a tenth of the frame does not deserve the same step count as one filling
    // it — and at these sizes nobody can see the difference anyway.
    const cover = Math.min(1, screenPx / Math.max(view.viewportHeight * scale, 1));
    const lod = inside ? 1 : clamp(cover * 1.5, 0.35, 1);

    u.uSteps.value = clamp(Math.round(q.atmosphereSteps * lod), 6, 64);
    // Zero switches the inner loop to the table. That is the low tier and the
    // far LOD; it is also the correct answer for a spherical shell, so the only
    // thing lost is the sampled penumbra.
    u.uLightSteps.value =
      q.tier === 'low' || screenPx < 220
        ? 0
        : clamp(Math.round(q.atmosphereLightSteps * lod), 2, 16);

    // --- face selection ----------------------------------------------------
    // Outside the hull: front faces, depth-tested, so a moon or a hull strut in
    // front of the planet occludes us for free. Inside: the front faces are
    // behind the camera, so we take the back wall and rely on the analytic
    // clip and the depth texture instead — which is exactly why supplying the
    // depth texture matters most when the ship is in the air.
    const side = inside ? BackSide : FrontSide;
    this.marchMaterial.side = side;
    this.extinctMaterial.side = side;
    this.inscatterMaterial.side = side;
    this.extinctMaterial.depthTest = !inside;
    this.inscatterMaterial.depthTest = !inside;

    // Below a couple of pixels there is nothing to say; skip the render target
    // rather than spend a pass on it.
    const visible = screenPx > 2.5;
    this.extinctMesh.visible = visible;
    this.inscatterMesh.visible = visible;
    if (!visible) return;

    // --- offscreen march ---------------------------------------------------
    const r = ctx.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.getClearColor(this.prevClear);
    const prevAlpha = r.getClearAlpha();
    // Explicit: a post pipeline may well have left autoClear off, and stale
    // scatter from last frame would smear across the limb.
    r.autoClear = true;
    r.setClearColor(0x000000, 0);

    // matrixWorld is stale during update() — the renderer refreshes it later —
    // so walk the parent chain ourselves before mirroring it onto the twin.
    this.object3d.updateWorldMatrix(true, false);
    this.marchMesh.matrixWorld.copy(this.object3d.matrixWorld);

    r.setRenderTarget(this.scatterRT);
    r.render(this.marchScene, ctx.camera);

    r.setRenderTarget(prevTarget);
    r.setClearColor(this.prevClear, prevAlpha);
    r.autoClear = prevAutoClear;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.extinctMesh.visible = false;
    this.inscatterMesh.visible = false;

    // One geometry (shared by all three meshes), three materials, one render
    // target (which frees its own texture), and the two data textures.
    this.geometry.dispose();
    this.marchMaterial.dispose();
    this.extinctMaterial.dispose();
    this.inscatterMaterial.dispose();
    this.scatterRT.dispose();
    this.lut.dispose();
    this.blankDepth.dispose();

    this.marchScene.remove(this.marchMesh);
    this.object3d.remove(this.extinctMesh, this.inscatterMesh);
    this.shared.uDepthTex.value = null;
    this.shared.uLut.value = null;
    this.iu.uScatterTex.value = null;
  }
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

// Module scratch: shots run once per capture, but ARCHITECTURE section 5 is
// about habit as much as about hot loops.
const shotSun = new Vector3();
const shotCentre = new Vector3();
const shotUp = new Vector3();
const shotSide = new Vector3();
const shotDir = new Vector3();
const shotAim = new Vector3();
const shotEye = new Vector3();
const shotAzimuth = new Vector3();
const shotLook = new Vector3();

/**
 * Hero shots for the scattering shell.
 *
 * @param planet   the spec the renderer was built from.
 * @param body     the object whose world position is the planet centre — pass
 *                 `atmosphereRenderer.object3d`, or the node it is parented to.
 * @param sunLocal unit vector from the planet towards its star, in the space
 *                 `ViewState.sunDirection` uses. Defaults to a three-quarter
 *                 key if the integrator has not placed a star yet.
 */
export function registerAtmosphereShots(
  planet: PlanetSpec,
  body: Object3D,
  sunLocal?: Vector3,
): void {
  const sun = (sunLocal ? shotSun.copy(sunLocal) : shotSun.set(1, 0.16, 0.34))
    .normalize()
    .clone();

  /** An orthonormal frame with `sun` as one axis, stable for any sun direction. */
  const frame = (): { side: Vector3; up: Vector3 } => {
    const worldUp = Math.abs(sun.y) > 0.9 ? shotUp.set(1, 0, 0) : shotUp.set(0, 1, 0);
    const side = shotSide.crossVectors(worldUp, sun).normalize();
    const up = shotUp.crossVectors(sun, side).normalize();
    return { side, up };
  };

  registerShot({
    name: 'atmosphere-limb',
    description:
      'Backlit limb against black space with the star just off the top-right corner. ' +
      'Tests the rim glow, its blue-to-orange gradient through the terminator, the ' +
      'sharpness of the shadow penumbra and the absence of banding in the falloff.',
    apply(ctx) {
      body.updateWorldMatrix(true, false);
      const centre = body.getWorldPosition(shotCentre);
      const { side, up } = frame();

      // 112 degrees off the sun axis. Not 150: a fully backlit planet gives a
      // thin twilight arc and nothing else, because every sample dense enough
      // to scatter has a sun ray grazing the same dense air and arrives with
      // its blue already gone. At 112 the terminator sits inside the disc, so
      // one frame carries the whole gradient — white-blue where the sun is
      // high over the limb, through cyan, into the sodium band at the
      // terminator, then black.
      const a = (112 * Math.PI) / 180;
      const dir = shotDir
        .copy(sun)
        .multiplyScalar(Math.cos(a))
        .addScaledVector(side, Math.sin(a))
        .addScaledVector(up, 0.20)
        .normalize();

      const eye = shotEye
        .copy(centre)
        .addScaledVector(dir, planet.radius * 1.62);
      ctx.camera.position.copy(eye);

      // Aim past the lit limb rather than at the body. The disc then leaves
      // the frame on the dark side, the glowing edge sits a third of the way
      // in with black space beyond it, and the star lands ~55 degrees off the
      // axis — outside a 94 degree frame, so it rakes the limb without ever
      // showing its own disc. An empty black frame is a failure state
      // (ARCHITECTURE section 6); a limb cutting across it is not.
      const sunPerp = shotAzimuth
        .copy(sun)
        .addScaledVector(dir, -sun.dot(dir))
        .normalize();
      const aim = shotAim
        .copy(centre)
        .addScaledVector(sunPerp, planet.radius * 0.58)
        .addScaledVector(up, planet.radius * -0.22);
      // Rolling puts the limb on a diagonal, which is the difference between a
      // diagram and a photograph.
      ctx.camera.up.copy(up).applyAxisAngle(dir, (-28 * Math.PI) / 180);
      ctx.camera.lookAt(aim);
      ctx.camera.updateMatrixWorld();
    },
  });

  registerShot({
    name: 'atmosphere-sunset',
    description:
      'On the deck at the terminator, star a degree and a half below the horizon. ' +
      'Tests the sodium band, the blue-to-black zenith gradient, ground fog and the ' +
      'aerial perspective stealing contrast from distant relief.',
    apply(ctx) {
      body.updateWorldMatrix(true, false);
      const centre = body.getWorldPosition(shotCentre);
      const { side } = frame();

      // Stand where the star is 1.5 degrees below the local horizon: past
      // sunset, so the disc itself is out of frame and everything on screen is
      // light that has come the long way round through the lower atmosphere.
      // That is the geometry that produces the band; with the sun above the
      // horizon its own glare simply eats it.
      const a = ((90 + 1.5) * Math.PI) / 180;
      const zenith = shotDir
        .copy(sun)
        .multiplyScalar(Math.cos(a))
        .addScaledVector(side, Math.sin(a))
        .normalize();

      // Clear of the tallest relief the terrain sampler can produce, so the
      // camera is in the air rather than inside a mountain.
      const altitude = planet.terrain.amplitude * 0.9 + 2;
      const eye = shotEye.copy(centre).addScaledVector(zenith, planet.radius + altitude);
      ctx.camera.position.copy(eye);

      // Look along the horizon towards the afterglow, pitched up four degrees
      // so the ground takes the lower third and the gradient gets the rest.
      const azimuth = shotAzimuth
        .copy(sun)
        .addScaledVector(zenith, -sun.dot(zenith))
        .normalize();
      const look = shotLook
        .copy(azimuth)
        .multiplyScalar(Math.cos(0.07))
        .addScaledVector(zenith, Math.sin(0.07))
        .normalize();
      // Roll the horizon a couple of degrees off level; dead level reads as a
      // test chart, and the composition rules in ARCHITECTURE section 6 want
      // the frame to look photographed.
      ctx.camera.up.copy(zenith).applyAxisAngle(look, (3 * Math.PI) / 180);
      // Aim a planet-radius down the look vector: far enough that the pitch is
      // exact and the horizon does not drift with altitude.
      ctx.camera.lookAt(shotAim.copy(eye).addScaledVector(look, planet.radius));
      ctx.camera.updateMatrixWorld();
    },
  });
}
