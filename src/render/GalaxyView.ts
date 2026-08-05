/**
 * oneSpace — the galaxy map.
 *
 * This is the screen the player stares at while deciding where to spend the
 * next hour, so it has to be two contradictory things at once: an instrument
 * you can read a route off, and a photograph of a hundred billion stars.
 *
 * ---------------------------------------------------------------------------
 * LOCAL SPACE — read this before wiring it up
 * ---------------------------------------------------------------------------
 * Every other renderer in the project works in kilometres. This one does not.
 * `object3d`'s local space is **light years**, matching `gen/galaxy.ts`'s
 * galaxy-local frame exactly:
 *
 *     +Y = galactic north (the thin axis)   XZ = the disc plane
 *
 * A galaxy is 5e17 km across; expressing the map in kilometres would put every
 * vertex a hundred million times outside float32's useful range for no gain.
 * The map is a diorama, not a place — it is never visited by the ship, so it
 * never has to agree with the floating origin. The integrator therefore passes
 * `view.cameraLocal` in **light years**, which is what `object3d.worldToLocal()`
 * naturally produces. Everything else in `ViewState` is used as documented.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR PASSES
 * ---------------------------------------------------------------------------
 *  1. VOLUME   — a raymarch of the same density field `gen/galaxy.ts` samples
 *                its star catalogue from, carrying both unresolved starlight
 *                (emission) and dust (chromatic extinction). This is the pass
 *                that makes a rendered galaxy look photographic rather than
 *                like a particle demo: the dust does not just darken, it
 *                *reddens*, because interstellar extinction goes as 1/λ.
 *  2. NEBULAE  — a handful of instanced billboards, each one a small volume
 *                raymarch of its own so they have parallax and interior
 *                structure instead of being decals.
 *  3. STARS    — up to `quality.galaxyStarBudget` points in one draw call,
 *                blackbody-coloured, with a soft PSF, magnitude-based sizing
 *                and their own line-of-sight dust extinction so stars behind a
 *                lane redden and vanish exactly as the lane does.
 *  4. UI       — grid, route, cursor, reticle. All cyan, all additive. The
 *                contrast between the instrument and the cosmos is the noir.
 *
 * The blow-out problem (160k additive points piling up in the bulge until the
 * core is a clipped white disc) is defended against three separate ways:
 * per-star crowding attenuation computed on the CPU, a compressive
 * magnitude→energy response, and a saturation-aware roll-off in the fragment
 * shader that desaturates towards white instead of clipping one channel.
 */

import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  DoubleSide,
  DstColorFactor,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  Vector4,
  ZeroFactor,
  type IUniform,
  type Material,
  type Object3D,
} from 'three';

import type { EngineContext } from '@/core/Engine';
import type { QualitySettings } from '@/core/Config';
import {
  buildField,
  densityAt,
  generateStarField,
  sampleSystemsNear,
  starFormationAt,
  type GalaxyField,
  type StarSystemStub,
} from '@/gen/galaxy';
import type { GalaxySpec, NebulaSpec, Vec3 } from '@/gen/types';
import { Rng, rngFrom } from '@/math/rng';
import { registerShaderChunks } from '@/shaders/chunks';
import { registerShot } from '@/game/Shots';
import type { ViewState } from './ViewState';

// ---------------------------------------------------------------------------
// Tunables that are not quality budgets — art direction, not performance.
// ---------------------------------------------------------------------------

/** Longest route the ribbon buffers are sized for. Beyond this we truncate. */
const MAX_ROUTE_POINTS = 64;

/** Ceiling on the neighbourhood overlay. `sampleSystemsNear` is capped anyway. */
const MAX_LOCAL_SYSTEMS = 4096;

/**
 * Reference luminosity, log10 L☉, that maps to "energy 1" on the star sizing
 * curve. At galaxy scale the visible light is supergiants (1e3–1e5 L☉); zoomed
 * into a neighbourhood it is ordinary dwarfs. Sliding this reference with zoom
 * is what fades extra star detail in as you approach, without regenerating a
 * single point.
 */
const LOG_LREF_WIDE = 3.4;
const LOG_LREF_CLOSE = 0.25;

/**
 * Interstellar extinction is roughly ∝ 1/λ, so blue light is scattered out of
 * the beam ~1.8× as hard as red. This ratio is the entire reason dust lanes in
 * a photograph are brown rather than grey.
 */
const REDDENING = 'vec3(0.80, 1.00, 1.42)';

const CYAN = new Color(0.06, 0.78, 0.95);

// ---------------------------------------------------------------------------
// Shared GLSL — the density field, mirrored from gen/galaxy.ts
// ---------------------------------------------------------------------------

/**
 * A GLSL transcription of `rawDensity()` / `armPhaseStrength()` from
 * `gen/galaxy.ts`. It must stay term-for-term identical: the haze and the
 * resolved stars are two samplings of *one* field, and any drift shows up
 * immediately as stars sitting where the paint says there is nothing.
 *
 * Specialised per galaxy shape at construction so the fragment shader only
 * carries the branch it actually needs.
 */
function fieldGlsl(field: GalaxyField): string {
  const clumpBlock =
    field.clumps.length > 0
      ? /* glsl */ `
uniform vec4 uClumps[OS_CLUMPS];   // xyz = centre (ly), w = radius (ly)
uniform float uClumpW[OS_CLUMPS];  // weight

float osClumpStrength(vec3 p) {
  float sum = 0.0;
  for (int i = 0; i < OS_CLUMPS; i++) {
    vec3 d = p - uClumps[i].xyz;
    d.y *= 1.6;                    // clumps are flattened with the gas layer
    float k = dot(d, d) / (uClumps[i].w * uClumps[i].w);
    sum += uClumpW[i] * exp(-k);
  }
  return sum;
}
`
      : /* glsl */ `float osClumpStrength(vec3 p) { return 0.0; }`;

  let raw: string;
  switch (field.shape) {
    case 'elliptical':
      raw = /* glsl */ `
float osRawDensity(vec3 p, out float armMask) {
  armMask = 0.0;
  // de Vaucouleurs r^(1/4), triaxial. 7.669 is the Sersic b_n for n = 4.
  vec3 q = vec3(p.x, p.y / uAxisC, p.z / uAxisB);
  float s = max(length(q) / uEffRadius, 0.004);
  return exp(-7.669 * (pow(s, 0.25) - 1.0));
}`;
      break;

    case 'irregular':
      raw = /* glsl */ `
float osRawDensity(vec3 p, out float armMask) {
  vec3 d = vec3(p.x - uOffset.x, p.y, p.z - uOffset.y);
  float r = length(d.xz);
  float base = exp(-r / (uScaleLength * 1.5)) * os_sech2(p.y / (uScaleHeight * 1.8));
  float clump = osClumpStrength(p);
  armMask = clamp(clump, 0.0, 1.0);
  return 0.35 * base + 0.65 * clump;
}`;
      break;

    case 'ring':
      raw = /* glsl */ `
float osRawDensity(vec3 p, out float armMask) {
  float r = length(p.xz);
  float e = (r - uRingRadius) / uRingWidth;
  float ring = exp(-e * e);
  float theta = atan(p.z, p.x);
  float knots = 0.6 + 0.4 * cos(uArmCount * (theta - uBarAngle));
  float rn = r / (uRadius * 0.09);
  float nucleus = exp(-rn * rn);
  float vert = os_sech2(p.y / uScaleHeight);
  float scattered = 0.05 * exp(-r / (uScaleLength * 1.2));
  armMask = clamp(ring * knots, 0.0, 1.0);
  return (0.85 * ring * knots + 1.15 * nucleus + scattered) * vert;
}`;
      break;

    default:
      raw = /* glsl */ `
float osRawDensity(vec3 p, out float armMask) {
  float r = length(p.xz);
  float vert = os_sech2(p.y / uScaleHeight);
  // Capped sharpness: gen allows cos^17 arms, which at map scale render as
  // wires rather than arms. Ten is still a narrow grand-design ridge.
  float arm = osArmStrength(p, 0.0, min(uArmSharp, 10.0), 0.55);
  armMask = arm;
  // Interarm floor. A galaxy whose interarm regions go to literal black reads
  // as ribbons on a table; every disc ever photographed has a smooth stellar
  // sheet between its arms, because the old population does not participate in
  // the density wave. This is the one place the render deliberately departs
  // from gen/galaxy.ts, and it only ever *adds* light where the catalogue is
  // sparse — which is exactly where unresolved starlight should be.
  float armsRaw = 1.0 - uArmContrast + uArmContrast * arm;
  float arms = uInterarmFloor + (1.0 - uInterarmFloor) * armsRaw;
  float d = exp(-r / uScaleLength) * vert * arms;
#ifdef OS_HAS_BAR
  float ca = cos(-uBarAngle);
  float sa = sin(-uBarAngle);
  float u = p.x * ca - p.z * sa;
  float v = (p.x * sa + p.z * ca) / uBarWidth;
  // Flat-topped along the bar, sharp ends: a quartic, not an exponential.
  d += uBarAmp * exp(-pow(abs(u) / uBarLength, 3.5) - v * v)
             * os_sech2(p.y / (uScaleHeight * 1.5));
#endif
  vec3 b = vec3(p.x / uBulgeRadius, p.y / (uBulgeRadius * uBulgeFlatten), p.z / uBulgeRadius);
  d += uBulgeAmp * exp(-0.5 * dot(b, b));
  return d;
}`;
  }

  const young =
    field.shape === 'elliptical'
      ? /* glsl */ `float osYoungField(vec3 p, float armMask) { return 0.0; }`
      : field.shape === 'irregular'
        ? /* glsl */ `float osYoungField(vec3 p, float armMask) {
  return clamp(0.04 + armMask, 0.0, 1.0);
}`
        : field.shape === 'ring'
          ? /* glsl */ `float osYoungField(vec3 p, float armMask) {
  return clamp(armMask * os_sech2(p.y / (uScaleHeight * 0.6)), 0.0, 1.0);
}`
          : /* glsl */ `float osYoungField(vec3 p, float armMask) {
  // gen/galaxy.ts starFormationAt(), minus the whole-galaxy gas scaling the
  // shader applies elsewhere. The diffuse term matters as much as the arm one:
  // even a flocculent disc forms stars throughout its molecular layer, and
  // without it the interarm gaps of a grand-design galaxy go to pure black.
  float r = length(p.xz);
  float gasLayer = os_sech2(p.y / (uScaleHeight * 0.6));
  float radial = smoothstep(0.0, uArmStart * 1.5, r)
               * (1.0 - smoothstep(uRadius * 0.78, uRadius * 1.05, r));
  return clamp(0.11 * gasLayer * radial + armMask, 0.0, 1.0);
}`;

  // Dust traces the cold molecular gas, so it follows the same structure as
  // star formation: the arms, in a layer roughly a third as thick as the
  // stellar disc, shifted to the shock front on the arm's inner edge.
  const dust =
    field.shape === 'elliptical'
      ? /* glsl */ `float osDustDensity(vec3 p) { return 0.0; }`
      : field.shape === 'irregular'
        ? /* glsl */ `
float osDustDensity(vec3 p) {
  float veil = os_sech2(p.y / (uScaleHeight * 0.45));
  return uGasFraction * veil * (0.06 + 0.55 * osClumpStrength(p));
}`
        : field.shape === 'ring'
          ? /* glsl */ `
float osDustDensity(vec3 p) {
  float r = length(p.xz);
  float e = (r - uRingRadius * 0.94) / (uRingWidth * 1.5);
  float theta = atan(p.z, p.x);
  float knots = 0.45 + 0.55 * cos(uArmCount * (theta - uBarAngle) + uDustPhase);
  return uGasFraction * exp(-e * e) * max(knots, 0.0) * os_sech2(p.y / (uScaleHeight * 0.4));
}`
          : /* glsl */ `
float osDustDensity(vec3 p) {
  float r = length(p.xz);
  // Lanes are deliberately narrower than the arms they trace, and never
  // broader than a ridge whatever the galaxy's own arm contrast: a wide soft
  // band of dust reads as haze, a narrow one reads as a lane.
  float lane = osArmStrength(p, uDustPhase, max(uArmSharp * 1.4, 4.5), 0.30);
  float layer = os_sech2(p.y / (uScaleHeight * 0.34));
  float outer = 1.0 - smoothstep(uRadius * 0.78, uRadius * 1.06, r);
  // A thin diffuse veil everywhere plus the concentrated lanes. Without the
  // veil the interarm gaps read as holes punched in the disc.
  float veil = 0.085 * smoothstep(0.0, uArmStart * 0.6, r) * outer;
  // Circumnuclear dust. osArmStrength gates the lanes out of everything
  // inside the bulge, so without this term there is nothing at all in front of
  // the nucleus — and a nucleus with nothing in front of it renders as a
  // featureless white disc. Every spiral photographed has a lane across its
  // core; this is that lane, and it is what turns the blob into a hot mass.
  float rn = r / (uArmStart * 0.85);
  float nuclear = 1.05 * exp(-rn * rn) * smoothstep(0.0, uArmStart * 0.16, r);
  return uGasFraction * ((veil + nuclear) * layer + lane) * exp(-r / (uScaleLength * 2.2));
}`;

  return /* glsl */ `
uniform float uRadius;
uniform float uScaleLength;
uniform float uScaleHeight;
uniform float uArmCount;
uniform float uTanPitch;
uniform float uArmContrast;
uniform float uArmSharp;
uniform float uArmStart;
uniform float uBulgeRadius;
uniform float uBulgeFlatten;
uniform float uBulgeAmp;
uniform float uBarLength;
uniform float uBarWidth;
uniform float uBarAmp;
uniform float uBarAngle;
uniform float uRingRadius;
uniform float uRingWidth;
uniform float uAxisB;
uniform float uAxisC;
uniform float uEffRadius;
uniform float uPeak;
uniform vec2 uOffset;
uniform float uGasFraction;
uniform float uDustPhase;
uniform float uDustAbsorb;
uniform float uInterarmFloor;
uniform float uNoiseFreq;
uniform vec3 uNoiseOff;
uniform float uDetailFreq;
uniform float uDetailAmp;
uniform float uDetailBlend;
uniform vec3 uCameraLocal;

/**
 * sech^2 — the self-gravitating isothermal sheet (Spitzer 1942). Visibly
 * flatter-topped and sharper-edged than a gaussian, which is what gives a disc
 * seen edge-on its knife edge.
 */
float os_sech2(float x) {
  float e = exp(-abs(x));
  float s = 2.0 * e / (1.0 + e * e);
  return s * s;
}

${clumpBlock}

/**
 * Arm modulation, 0..1. A logarithmic spiral has constant pitch angle, so
 * theta_arm(r) = ln(r/r0)/tan(psi); subtracting it from the point's own
 * azimuth gives a phase that is constant *along* an arm.
 */
float osArmStrength(vec3 p, float phaseShift, float sharpExp, float vertScale) {
  if (uArmContrast <= 0.001) return 0.0;
  float r = length(p.xz);
  if (r < 1e-3) return 0.0;
  float theta = atan(p.z, p.x);
  float phase = theta
              - log(max(r, uArmStart * 0.25) / uArmStart) / uTanPitch
              - uBarAngle + phaseShift;
  float m = max(0.5 + 0.5 * cos(uArmCount * phase), 1e-5);
  float s = pow(m, sharpExp);
  s *= smoothstep(uArmStart * 0.7, uArmStart * 1.8, r);
  s *= 1.0 - smoothstep(uRadius * 0.85, uRadius * 1.15, r);
  s *= os_sech2(p.y / (uScaleHeight * vertScale));
  return s;
}

${raw}

${young}

${dust}

/**
 * Optical depth of dust between a point and the camera.
 *
 * The dust lives in a thin slab, so the segment is clipped to that slab before
 * sampling — which is what lets OS_DUST_TAPS taps do the work of thirty. This
 * is evaluated per star, in the vertex shader, so stars behind a lane redden
 * and disappear exactly as the lane does.
 */
float osDustColumn(vec3 p) {
  vec3 seg = uCameraLocal - p;
  float len = length(seg);
  if (len < 1e-3) return 0.0;
  float slab = uScaleHeight * 1.6;
  float dh = seg.y;
  float lo = 0.0;
  float hi = 1.0;
  if (abs(dh) > 1e-4) {
    float ta = (-slab - p.y) / dh;
    float tb = ( slab - p.y) / dh;
    lo = clamp(min(ta, tb), 0.0, 1.0);
    hi = clamp(max(ta, tb), 0.0, 1.0);
  } else if (abs(p.y) > slab) {
    return 0.0;
  }
  if (hi <= lo) return 0.0;
  float sum = 0.0;
  for (int i = 0; i < OS_DUST_TAPS; i++) {
    float f = lo + (hi - lo) * ((float(i) + 0.5) / float(OS_DUST_TAPS));
    sum += osDustDensity(p + seg * f);
  }
  return (sum / float(OS_DUST_TAPS)) * (hi - lo) * len * uDustAbsorb;
}
`;
}

// ---------------------------------------------------------------------------
// The volume pass
// ---------------------------------------------------------------------------

const VOLUME_VERT = /* glsl */ `
uniform vec3 uBound;
varying vec3 vLocal;
void main() {
  vec3 lp = position * uBound;
  vLocal = lp;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(lp, 1.0);
}
`;

function volumeFrag(field: GalaxyField): string {
  return /* glsl */ `
#include <onespace_noise>
#include <onespace_color>
#include <onespace_atmosphere>
${fieldGlsl(field)}

uniform vec3 uBound;
uniform vec3 uCoreColor;
uniform vec3 uArmColor;
uniform vec3 uYoungColor;
uniform vec3 uDustColor;
uniform float uYoungGain;
uniform float uEmission;
uniform float uDustScatter;
uniform float uKnee;
varying vec3 vLocal;

/**
 * Colour of the unresolved starlight. Old, metal-rich, amber in the bulge;
 * cooler and bluer in the disc; and bluest of all *on* the arm ridges, where
 * the O and B stars that only live two million years actually are. That single
 * correlation is what makes a galaxy read as alive rather than embalmed.
 */
vec3 osFieldColor(vec3 p, float armMask) {
  float r = length(p.xz) / uRadius;
  vec3 c = mix(uCoreColor, uArmColor, smoothstep(0.03, 0.30, r));
  vec3 ob = uArmColor * vec3(0.66, 0.84, 1.34);
  c = mix(c, ob, clamp(armMask, 0.0, 1.0) * 0.55 * smoothstep(0.06, 0.26, r));
  // The far outskirts are old, red and thin.
  c = mix(c, uCoreColor * 0.75, smoothstep(0.62, 1.15, r) * 0.4);
  return c;
}

void main() {
  vec3 ro = uCameraLocal;
  vec3 rd = normalize(vLocal - ro);

  // Squash the bounding ellipsoid to a unit sphere to intersect it. rd is not
  // unit length after the squash, so normalise and scale t back afterwards.
  vec3 roE = ro / uBound;
  vec3 rdE = rd / uBound;
  float k = length(rdE);
  vec2 h = os_raySphere(roE, rdE / k, 1.0);
  float t0 = max(h.x / k, 0.0);
  float t1 = h.y / k;
  if (t1 <= t0) discard;

  float span = t1 - t0;

  // Geometrically growing steps: fine where the ray enters (which is the side
  // facing the camera, where detail is resolvable) and coarse on the far side.
  const float K = 1.042;
  float ds = span * (K - 1.0) / (pow(K, float(OS_STEPS)) - 1.0);

  // Static per-pixel jitter. Temporal jitter without TAA is just flicker; a
  // fixed interleaved-gradient offset breaks the step banding and stays put.
  float jitter = os_igNoise(gl_FragCoord.xy);
  float t = t0 + ds * jitter;

  vec3 acc = vec3(0.0);
  vec3 T = vec3(1.0);
  float invPeak = 1.0 / max(uPeak, 1e-6);

  for (int i = 0; i < OS_STEPS; i++) {
    vec3 p = ro + rd * t;

    // Analytic density first — it is a tenth the cost of the noise, so most of
    // the empty steps at wide zoom are rejected before paying for any.
    float armMask;
    float raw = osRawDensity(p, armMask) * invPeak;
    float dustRaw = osDustDensity(p);

    if (raw + dustRaw > 2.5e-4) {
      vec3 np = p * uNoiseFreq + uNoiseOff;
      float n = os_fbm(np, 3, 2.55, 0.62);
      // One more octave, riding just above the fBm's own and crossfading up
      // one further octave as the camera closes.
      //
      // It is only added where this march can actually sample it. The steps
      // grow geometrically, so by the far side of the disc a single step is
      // longer than this octave's wavelength — sampling it there does not
      // produce detail, it produces per-pixel grain, and costs two noise
      // evaluations per step to produce it. Fading the term out on the Nyquist
      // criterion keeps the structure on the near, camera-facing side of the
      // disc where it is resolvable and buys the cost back everywhere else.
      float detFade = clamp((0.6 - ds * uDetailFreq * (1.0 + uDetailBlend)) * 2.5, 0.0, 1.0);
      float det = 0.0;
      if (detFade > 0.02) {
        vec3 dp = p * uDetailFreq + uNoiseOff * 1.7;
        det = mix(os_snoise(dp), os_snoise(dp * 2.0), uDetailBlend) * uDetailAmp * detFade;
      }

      // Turbulent breakup. The floor matters: a fully multiplicative noise
      // punches holes through the disc and it stops reading as a fluid.
      // Hard remap, not a gentle multiply. Arms are knots, spurs and feathers,
      // not smooth bands; a 6:1 turbulent modulation is what shreds them.
      // The ridge term is free — the crests of |fBm| are already filaments, and
      // filaments are what stop turbulence reading as cotton wool.
      float fil = 1.0 - abs(n);
      fil *= fil * fil;
      float turb = clamp(0.26 + 1.15 * smoothstep(-0.5, 0.5, n) + 0.55 * fil + det * 1.5, 0.03, 2.5);
      float sd = raw * turb;
      // The YOUNG population, tracked separately from the mass.
      //
      // Stellar *mass* is only weakly modulated by the arms — for a flocculent
      // disc it is barely 1.7:1, which on its own renders as a featureless
      // smear. What you actually see in a photograph of a spiral is the O and
      // B stars: a fraction of a percent of the mass, ten thousand times the
      // luminosity per unit of it, and they exist only where the density wave
      // passed within the last few million years. So the arms are painted by
      // the star-formation field, not by the mass field, and they come out
      // blue-white against the amber of the old bulge for the same reason.
      float yd = osYoungField(p, armMask) * uYoungGain * turb;
      float dd = dustRaw * clamp(0.20 + 1.55 * smoothstep(-0.20, 0.55, n) + det * 1.3, 0.0, 2.6);

      vec3 sigma = dd * uDustAbsorb * ${REDDENING};
      vec3 emit = (osFieldColor(p, armMask) * sd + uYoungColor * yd) * uEmission;
      // Dust does not only absorb: it scatters a little of the surrounding
      // starlight back at us, which is what stops lanes reading as cutouts.
      emit += uDustColor * dd * (sd + yd) * uDustScatter * uEmission;

      acc += T * emit * ds;
      T *= exp(-sigma * ds);
      if (max(T.r, max(T.g, T.b)) < 0.006) break;
    }

    t += ds;
    ds *= K;
  }

  // Soft knee. The line of sight through a bulge is twenty times longer in
  // dense material than the line of sight through an arm, so the honest
  // integral puts the core an order of magnitude above anything a tone map can
  // hold. Compressing only the top of the range keeps the arms exactly where
  // they were while leaving the core's ±40% turbulence visible instead of
  // clipping it flat — a hot dense mass with structure, not a white disc.
  vec3 acc2 = acc / (1.0 + acc * uKnee);

  float alpha = clamp(1.0 - dot(T, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
  vec3 col = os_dither(acc2, gl_FragCoord.xy);
  gl_FragColor = vec4(col, alpha);
}
`;
}

// ---------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------

function starVert(field: GalaxyField): string {
  return /* glsl */ `
#include <onespace_noise>
#include <onespace_color>
${fieldGlsl(field)}

attribute float aBright;
attribute float aTemp;
attribute float aCrowd;
attribute float aJitter;

uniform float uLogLRef;
uniform float uSizeScale;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uEnergy;
uniform float uPixelRatio;
uniform float uZoom;

varying vec3 vColor;
varying float vSpike;

void main() {
  // Black holes come out of the catalogue with temperature 0 and keep their
  // slot so indices stay stable. Cull them off-screen rather than branching.
  if (aTemp < 100.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vSpike = 0.0;
    return;
  }

  vec3 toStar = position - uCameraLocal;
  float d = max(length(toStar), 1e-3);

  // The catalogue stores log luminosity because the real range is nine
  // decades. Work in magnitudes the whole way: flux, reference and response
  // are all logarithmic, which is exactly how a star chart is drawn.
  float logL = aBright * 9.0 - 4.0;                       // log10 L / L_sun
  float rel = logL - 0.86858896 * log(d) - uLogLRef;      // 2*log10(d) = 0.8686*ln(d)
  // Compression of the catalogue's nine decades of luminosity down to
  // something a screen can hold. This exponent is the single number that
  // decides whether the field has a hierarchy in it. At 0.22 the whole
  // catalogue rendered between 2 and 3 pixels at within a factor of two in
  // brightness: an even speckle with no bright stars in it, which is exactly
  // the "uniform haze with nothing to look at" that gen/galaxy.ts warns the
  // renderer about. 0.30 keeps three decades of separation between an M dwarf
  // and a supergiant, which is what puts the diffraction spikes (they need
  // ~4 px) on the few stars that have earned them and leaves the rest as dust.
  float energy = pow(10.0, rel * 0.30) * aCrowd * aJitter;

  float pxIdeal = uSizeScale * pow(max(energy, 1e-9), 0.30);
  float px = clamp(pxIdeal, uMinPx, uMaxPx);

  // Total emitted energy is intensity * area, so dividing by the *clamped*
  // area conserves it: a star squeezed up to the one-pixel floor gets dimmer
  // by exactly the amount it was widened. Without this the core is a white
  // disc the moment a hundred thousand sub-pixel points pile up in it.
  float intensity = uEnergy * energy / (px * px);

  vec3 bb = os_blackbody(max(aTemp, 1200.0));
  float lum = max(dot(bb, vec3(0.299, 0.587, 0.114)), 0.04);
  // Half-normalise: keeps an M dwarf red without making it as bright as an O
  // star, and keeps an O star blue without making it invisible.
  bb = mix(bb, bb / lum, 0.62);

  vec3 ext = exp(-osDustColumn(position) * ${REDDENING});

  vColor = bb * intensity * ext;
  vSpike = smoothstep(3.0, 9.0, pxIdeal);

  gl_PointSize = px * uPixelRatio;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
}

const STAR_FRAG = /* glsl */ `
#include <onespace_color>
varying vec3 vColor;
varying float vSpike;

void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float r = sqrt(r2);

  // Airy-ish point spread: a tight gaussian core inside a broad wing. Never a
  // square, never a hard disc — a hard-edged star sprite is the single most
  // obvious tell that you are looking at a particle system.
  float core = exp(-r2 * 13.0);
  float wing = exp(-r * 3.4) * 0.28;

  // Four-point diffraction spikes, on the brightest stars only. A real
  // instrument has a spider; the eye reads it as "that one is bright".
  float sx = exp(-abs(d.x) * 30.0) * exp(-abs(d.y) * 2.2);
  float sy = exp(-abs(d.y) * 30.0) * exp(-abs(d.x) * 2.2);
  float spike = (sx + sy) * 0.15 * vSpike;

  float edge = 1.0 - smoothstep(0.82, 1.0, r);
  vec3 c = vColor * (core + wing + spike) * edge;

  // Saturation-aware additive. Once a star's contribution passes 1 the naive
  // thing is to let one channel clip, which shifts its hue before it whites
  // out. Rolling towards luminance instead gives a hot white core with a
  // coloured halo — which is what an over-exposed star actually looks like.
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, vec3(lum), clamp(lum - 1.0, 0.0, 1.0) * 0.6);

  gl_FragColor = vec4(c, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Nebulae
// ---------------------------------------------------------------------------

const NEBULA_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iColor;    // rgb = base colour, a = density
attribute vec4 iAccent;   // rgb = accent colour, a = radius (ly)
attribute vec2 iMeta;     // x = seed, y = kind code

uniform float uPxScale;   // world units per pixel, per unit of view depth
uniform float uMinPx;

varying vec2 vQuad;
varying vec3 vCentre;
varying vec3 vRight;
varying vec3 vUp;
varying float vRadius;
varying vec4 vColor;
varying vec4 vAccent;
varying vec2 vMeta;

void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);

  // Object scale, recovered from the model-view basis so a scaled map still
  // billboards correctly.
  float s = max(length(modelViewMatrix[0].xyz), 1e-6);

  // A 300 ly nebula seen from 120,000 ly is two pixels wide, which is a
  // nonsense on a map you navigate by, so small angular sizes are pushed up.
  //
  // Compressively, though, not clamped. A hard floor renders a 38 ly planetary
  // and a 350 ly star-forming complex at exactly the same size — and since the
  // planetary is the one that is [O III] green, an elliptical (which has
  // nothing but planetaries) came out as four saturated green coins pasted
  // over an amber spheroid, which is both a palette violation and a lie about
  // what is out there. Raising to a power keeps the floor's readability while
  // preserving the ordering, and because surface brightness is untouched, a
  // sprite that stays small stays dim: tiny objects read as faint markers and
  // only genuinely big ones get to be volumes.
  float minWorld = uMinPx * uPxScale * max(-mv.z, 1.0) / s;
  float u = iAccent.a / max(minWorld, 1e-9);
  float radius = u >= 1.0 ? iAccent.a : minWorld * pow(max(u, 1e-6), 0.45);

  mv.xy += position.xy * radius * s;
  gl_Position = projectionMatrix * mv;

  // The *rows* of the model-view rotation are the local-space directions that
  // map to view +X and +Y — the exact basis the quad above was expanded in.
  // Handing them to the fragment shader is what makes the sphere the ray
  // marcher traces line up with the sphere the rasteriser drew.
  vRight = normalize(vec3(modelViewMatrix[0][0], modelViewMatrix[1][0], modelViewMatrix[2][0]));
  vUp    = normalize(vec3(modelViewMatrix[0][1], modelViewMatrix[1][1], modelViewMatrix[2][1]));

  vQuad = position.xy;
  vCentre = iPos;
  vRadius = radius;
  vColor = iColor;
  vAccent = iAccent;
  vMeta = iMeta;
}
`;

const NEBULA_FRAG = /* glsl */ `
#include <onespace_noise>
#include <onespace_color>
#include <onespace_atmosphere>

uniform vec3 uCameraLocal;
uniform float uIntensity;
uniform float uZoom;

varying vec2 vQuad;
varying vec3 vCentre;
varying vec3 vRight;
varying vec3 vUp;
varying float vRadius;
varying vec4 vColor;
varying vec4 vAccent;
varying vec2 vMeta;

void main() {
  float q2 = dot(vQuad, vQuad);
  if (q2 > 1.0) discard;

  // Reconstruct the view ray through this fragment and march the nebula's own
  // sphere. A handful of steps is enough for a soft object and buys real
  // parallax: the interior structure slides as the camera moves instead of
  // sitting on the screen like a decal.
  vec3 target = vCentre + (vRight * vQuad.x + vUp * vQuad.y) * vRadius;
  vec3 ro = uCameraLocal - vCentre;
  vec3 rd = normalize(target - uCameraLocal);

  vec2 hit = os_raySphere(ro, rd, vRadius);
  float t0 = max(hit.x, 0.0);
  float t1 = hit.y;
  if (t1 <= t0) discard;

  float kind = vMeta.y;
  float shell = step(2.5, kind);                 // planetary / remnant
  float filament = step(3.5, kind);              // remnant only
  float seedOff = vMeta.x;

  float ds = (t1 - t0) / float(OS_NEBULA_STEPS);
  // Hash, not the interleaved gradient. IGN is a *regular* diagonal pattern —
  // which is exactly what makes it a good dither at 1/255, and exactly what
  // makes it a bad step jitter here: a ten-step march lets each pixel's phase
  // move the result by several percent, and a several-percent modulation in a
  // regular diagonal pattern reads as a screen door laid over the cloud.
  // White noise at the same amplitude reads as grain, which the grade wants
  // anyway.
  float t = t0 + ds * os_hash13(vec3(gl_FragCoord.xy, 11.0));

  vec3 acc = vec3(0.0);
  float trans = 1.0;
  float invR = 1.0 / vRadius;

  for (int i = 0; i < OS_NEBULA_STEPS; i++) {
    vec3 p = (ro + rd * t) * invR;               // -1..1 inside the sphere
    float rr = length(p);
    if (rr < 1.0) {
      vec3 np = p * 4.6 + seedOff;
      float n = os_fbm(os_warp(np, 0.35), 4, 2.15, 0.55);
      float ridge = os_ridged(np * 1.6 + 3.1, 3, 2.3, 0.5);

      // Shell objects (planetaries, remnants) are hollow: the gas is at the
      // ionisation front, not in the middle.
      float radial = mix(
        exp(-rr * rr * 3.8),
        exp(-pow((rr - 0.72) / 0.24, 2.0)) ,
        shell
      );
      // Hard remap so the cloud has holes and knots rather than a smooth
      // falloff — a soft radial gradient reads as a decal at any resolution.
      float d = radial * clamp(0.12 + 1.55 * smoothstep(-0.35, 0.45, n), 0.0, 1.8);
      d = mix(d, d * clamp(0.35 + 1.1 * (ridge * 0.5 + 0.5), 0.0, 2.0), filament);
      d *= vColor.a;

      if (d > 1e-4) {
        // Accent colour rides the dense cores — that is [O III] in the heart
        // of an H II region. Kept to a tint: the palette allows exactly one
        // saturated hue on screen beside the cyan of the instruments, and a
        // nebula that is pink outside and green inside spends two.
        vec3 c = mix(vColor.rgb, vAccent.rgb, clamp(d * 0.75, 0.0, 0.45));
        acc += trans * c * d * ds * invR * 2.2;
        trans *= exp(-d * ds * invR * 2.6);
        if (trans < 0.01) break;
      }
    }
    t += ds;
  }

  // Soft silhouette so the billboard's own edge never shows. It has to stay a
  // *rim*: taken from 0.4 it is a radial gradient over the whole sprite, and a
  // radial gradient beats anything the raymarch puts inside it — the nebula
  // then reads as a soft coloured disc stuck on the screen, which is the one
  // thing a volumetric pass exists to avoid.
  float edge = 1.0 - smoothstep(0.74, 1.0, sqrt(q2));
  vec3 col = acc * uIntensity * edge * mix(0.6, 1.0, uZoom);
  // Same saturation-aware roll-off the stars use: past unity a nebula should
  // bleach towards white, not clip one channel and shift hue on the way.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum), clamp(lum - 0.85, 0.0, 1.0) * 0.5);
  gl_FragColor = vec4(os_dither(col, gl_FragCoord.xy), 1.0);
}
`;

/** Dark nebulae do not glow: they take light away. Multiplicative pass. */
const NEBULA_DARK_FRAG = /* glsl */ `
#include <onespace_noise>
#include <onespace_color>
#include <onespace_atmosphere>

uniform vec3 uCameraLocal;
uniform float uIntensity;
uniform float uZoom;

varying vec2 vQuad;
varying vec3 vCentre;
varying vec3 vRight;
varying vec3 vUp;
varying float vRadius;
varying vec4 vColor;
varying vec4 vAccent;
varying vec2 vMeta;

void main() {
  float q2 = dot(vQuad, vQuad);
  if (q2 > 1.0) { gl_FragColor = vec4(1.0); return; }

  vec3 target = vCentre + (vRight * vQuad.x + vUp * vQuad.y) * vRadius;
  vec3 ro = uCameraLocal - vCentre;
  vec3 rd = normalize(target - uCameraLocal);

  vec2 hit = os_raySphere(ro, rd, vRadius);
  float t0 = max(hit.x, 0.0);
  float t1 = hit.y;
  if (t1 <= t0) { gl_FragColor = vec4(1.0); return; }

  float ds = (t1 - t0) / float(OS_NEBULA_STEPS);
  float t = t0 + ds * os_hash13(vec3(gl_FragCoord.xy, 11.0));
  float tau = 0.0;
  float invR = 1.0 / vRadius;

  for (int i = 0; i < OS_NEBULA_STEPS; i++) {
    vec3 p = (ro + rd * t) * invR;
    float rr = length(p);
    if (rr < 1.0) {
      float n = os_fbm(os_warp(p * 2.4 + vMeta.x, 0.4), 3, 2.2, 0.55);
      float d = exp(-rr * rr * 2.0) * clamp(0.25 + 1.2 * smoothstep(-0.2, 0.6, n), 0.0, 2.0);
      tau += d * ds * invR;
    }
    t += ds;
  }

  float edge = 1.0 - smoothstep(0.70, 1.0, sqrt(q2));
  vec3 T = exp(-tau * vColor.a * uIntensity * edge * ${REDDENING});
  // Dithered like every other smooth ramp in the project. This one is a
  // *multiplier* on the frame, so the quantisation it would otherwise cause
  // shows up as contour rings around the cloud's soft edge — the most visible
  // place banding can happen, because the edge is where the gradient is
  // shallowest and covers the most pixels.
  gl_FragColor = vec4(clamp(os_dither(T, gl_FragCoord.xy), 0.0, 1.0), 1.0);
}
`;

// ---------------------------------------------------------------------------
// UI: grid, route, cursor, reticle
// ---------------------------------------------------------------------------

const GRID_VERT = /* glsl */ `
varying vec2 vPlane;
varying float vDepth;
varying float vScale;
void main() {
  vec3 lp = vec3(position.x, 0.0, position.y);
  vPlane = position.xy;
  vec4 mv = modelViewMatrix * vec4(lp, 1.0);
  vDepth = -mv.z;
  // View depth is in world units, vPlane is in local units; the ratio makes a
  // pixel-constant line width survive a scaled map.
  vScale = max(length(modelViewMatrix[0].xyz), 1e-6);
  gl_Position = projectionMatrix * mv;
}
`;

const GRID_FRAG = /* glsl */ `
#include <onespace_color>
uniform vec3 uColor;
uniform float uOpacity;
uniform float uRingStep;
uniform float uSpokes;
uniform float uRadius;
uniform float uPxScale;
varying vec2 vPlane;
varying float vDepth;
varying float vScale;

void main() {
  float r = length(vPlane);
  // One line width, in light years, that is constant in *pixels*. Derived from
  // the projection rather than fwidth so it needs no derivative extension and
  // stays exact at grazing angles.
  float w = max(vDepth * uPxScale / vScale, 1e-4) * 1.3;

  float ringPhase = r / uRingStep;
  float dRing = abs(fract(ringPhase + 0.5) - 0.5) * uRingStep;
  float ring = 1.0 - smoothstep(0.0, w, dRing);

  float a = atan(vPlane.y, vPlane.x) / 6.28318530718 * uSpokes;
  float dSpoke = abs(fract(a + 0.5) - 0.5) * (6.28318530718 / uSpokes) * r;
  float spoke = (1.0 - smoothstep(0.0, w, dSpoke)) * smoothstep(0.02, 0.12, r / uRadius);

  // The rim: a heavier dashed circle at the optical radius, so the map has an
  // edge you can read a distance off.
  float dRim = abs(r - uRadius);
  float dash = step(0.5, fract(a * 4.0));
  float rim = (1.0 - smoothstep(0.0, w * 1.6, dRim)) * dash * 2.0;

  float fade = smoothstep(1.30, 1.02, r / uRadius) * smoothstep(0.0, 0.05, r / uRadius);
  float m = (ring * 0.55 + spoke * 0.35 + rim) * fade * uOpacity;
  if (m <= 0.0005) discard;
  gl_FragColor = vec4(os_dither(uColor * m, gl_FragCoord.xy), 1.0);
}
`;

const ROUTE_VERT = /* glsl */ `
attribute vec3 aOther;
attribute float aSide;
attribute float aFlip;
attribute float aDist;

uniform vec2 uViewport;
uniform float uWidthPx;

varying float vDist;
varying float vSide;
varying float vDepth;

void main() {
  vec4 clipA = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec4 clipB = projectionMatrix * modelViewMatrix * vec4(aOther, 1.0);
  float wA = max(clipA.w, 1e-4);
  float wB = max(clipB.w, 1e-4);

  vec2 sA = clipA.xy / wA * uViewport * 0.5;
  vec2 sB = clipB.xy / wB * uViewport * 0.5;
  vec2 dir = sB - sA;
  float l = length(dir);
  dir = l > 1e-5 ? dir / l : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x) * aFlip;

  clipA.xy += nrm * aSide * uWidthPx * clipA.w / uViewport * 2.0;

  vDist = aDist;
  vSide = aSide;
  vDepth = -(modelViewMatrix * vec4(position, 1.0)).z;
  gl_Position = clipA;
}
`;

const ROUTE_FRAG = /* glsl */ `
#include <onespace_color>
uniform vec3 uColor;
uniform float uOpacity;
uniform float uDashPerLy;
uniform float uPhase;
uniform float uFadeRef;
varying float vDist;
varying float vSide;
varying float vDepth;

void main() {
  float dash = fract(vDist * uDashPerLy - uPhase);
  float on = smoothstep(0.62, 0.50, dash);
  // Soft across the ribbon: a hard-edged one-pixel line aliases into a dotted
  // mess the moment the route runs diagonally.
  float across = 1.0 - abs(vSide);
  float profile = smoothstep(0.0, 0.55, across);
  float glow = exp(-abs(vSide) * 2.4) * 0.35;
  float fade = 1.0 / (1.0 + vDepth / max(uFadeRef, 1.0));
  float m = (profile * on + glow * on * 0.6) * fade * uOpacity;
  if (m <= 0.0005) discard;
  gl_FragColor = vec4(os_dither(uColor * m, gl_FragCoord.xy), 1.0);
}
`;

/** Screen-space-sized billboard used by the reticle and the cursor. */
const MARKER_VERT = /* glsl */ `
uniform vec3 uAnchor;
uniform float uPxScale;
uniform float uSizePx;
varying vec2 vQuad;
void main() {
  vec4 mv = modelViewMatrix * vec4(uAnchor, 1.0);
  // mv is already in world-scaled view space, so the pixel scale needs no
  // further correction: the offset and the depth are in the same units.
  float worldPerPx = max(-mv.z, 1.0) * uPxScale;
  mv.xy += position.xy * uSizePx * worldPerPx * 0.5;
  vQuad = position.xy;
  gl_Position = projectionMatrix * mv;
}
`;

const RETICLE_FRAG = /* glsl */ `
#include <onespace_color>
uniform vec3 uColor;
uniform float uOpacity;
uniform float uLock;
varying vec2 vQuad;

void main() {
  vec2 p = vQuad;
  float r = length(p);
  float aa = 0.028;

  // The ring snaps inward and stops spinning as the lock completes, so the
  // shot settles to a fixed frame instead of animating forever.
  float rr = mix(0.94, 0.56, uLock);
  float ring = smoothstep(aa, 0.0, abs(r - rr) - 0.008);
  float ang = atan(p.y, p.x) + (1.0 - uLock) * 2.2;
  float seg = abs(fract(ang / 1.5707963 + 0.5) - 0.5) * 2.0;
  ring *= smoothstep(0.88, 0.52, seg);

  float bars = 0.0;
  bars += smoothstep(0.014, 0.0, abs(p.y))
        * step(rr + 0.13, abs(p.x)) * step(abs(p.x), 0.97);
  bars += smoothstep(0.014, 0.0, abs(p.x))
        * step(rr + 0.13, abs(p.y)) * step(abs(p.y), 0.97);

  float pip = smoothstep(0.055, 0.0, r);

  float m = (ring + bars * 0.85 + pip * 1.6) * smoothstep(0.0, 0.22, uLock) * uOpacity;
  if (m <= 0.0005) discard;
  gl_FragColor = vec4(os_dither(uColor * m, gl_FragCoord.xy), 1.0);
}
`;

const CURSOR_FRAG = /* glsl */ `
#include <onespace_color>
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vQuad;

void main() {
  vec2 p = vQuad;
  float r = length(p);
  float cross = 0.0;
  cross += smoothstep(0.016, 0.0, abs(p.x)) * step(0.22, abs(p.y)) * step(abs(p.y), 0.94);
  cross += smoothstep(0.016, 0.0, abs(p.y)) * step(0.22, abs(p.x)) * step(abs(p.x), 0.94);
  float circ = smoothstep(0.020, 0.0, abs(r - 0.34));
  float m = (cross * 0.85 + circ * 0.7) * uOpacity;
  if (m <= 0.0005) discard;
  gl_FragColor = vec4(os_dither(uColor * m, gl_FragCoord.xy), 1.0);
}
`;

const NODE_VERT = /* glsl */ `
uniform float uPixelRatio;
uniform float uSizePx;
void main() {
  gl_PointSize = uSizePx * uPixelRatio;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const NODE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  // A diamond, not a dot — it reads as "waypoint" instead of "star".
  float m = 1.0 - smoothstep(0.45, 0.72, abs(d.x) + abs(d.y));
  float ring = smoothstep(0.10, 0.0, abs(abs(d.x) + abs(d.y) - 0.62));
  float a = (m * 0.35 + ring) * uOpacity;
  if (a <= 0.002) discard;
  gl_FragColor = vec4(uColor * a, 1.0);
}
`;

// ---------------------------------------------------------------------------

/** Kind → shader code. Order matters: >=2.5 is a shell, >=3.5 is filamentary. */
function nebulaKindCode(kind: NebulaSpec['kind']): number {
  switch (kind) {
    case 'emission':
      return 1;
    case 'reflection':
      return 2;
    case 'planetary':
      return 3;
    case 'supernova-remnant':
      return 4;
    default:
      return 0;
  }
}

export class GalaxyView {
  readonly object3d: Object3D;
  readonly galaxy: GalaxySpec;

  /** The density field the star catalogue was drawn from. Never mutated. */
  private readonly field: GalaxyField;

  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];

  // -- shared uniform cells (one object, referenced by every material) -------
  private readonly uCameraLocal: IUniform<Vector3> = { value: new Vector3() };
  private readonly uDustAbsorb: IUniform<number> = { value: 1 };
  private readonly uNoiseOff: IUniform<Vector3> = { value: new Vector3() };
  private readonly uNoiseFreq: IUniform<number> = { value: 1 };
  private readonly uDetailFreq: IUniform<number> = { value: 1 };
  private readonly uDetailAmp: IUniform<number> = { value: 0 };
  private readonly uDetailBlend: IUniform<number> = { value: 0 };
  private readonly uZoom: IUniform<number> = { value: 0 };
  private readonly uPxScale: IUniform<number> = { value: 0.001 };

  private readonly uEmission: IUniform<number> = { value: 1 };
  /** Pre-zoom-balance values; update() derives the live uniforms from these. */
  private emissionBase = 1;
  private starEnergyBase = 4.2;
  private readonly uLogLRef: IUniform<number> = { value: LOG_LREF_WIDE };
  private readonly uStarEnergy: IUniform<number> = { value: 4.2 };
  private readonly uLocalEnergy: IUniform<number> = { value: 0 };
  private readonly uPixelRatio: IUniform<number> = { value: 1 };
  private readonly uNebulaMinPx: IUniform<number> = { value: 26 };

  private readonly uViewport: IUniform<Vector2> = { value: new Vector2(1920, 1080) };
  private readonly uDashPhase: IUniform<number> = { value: 0 };
  private readonly uRouteFadeRef: IUniform<number> = { value: 1000 };
  private readonly uReticleAnchor: IUniform<Vector3> = { value: new Vector3() };
  private readonly uCursorAnchor: IUniform<Vector3> = { value: new Vector3() };
  private readonly uReticleLock: IUniform<number> = { value: 0 };
  private readonly uGridOpacity: IUniform<number> = { value: 0.1 };

  // -- scene objects --------------------------------------------------------
  private readonly volume: Mesh;
  private readonly stars: Points;
  private readonly localStars: Points;
  private readonly nebulaGlow: Mesh | null;
  private readonly nebulaDark: Mesh | null;
  private readonly grid: Mesh;
  private readonly route: Mesh;
  private readonly routeNodes: Points;
  private readonly cursor: Mesh;
  private readonly reticle: Mesh;

  // -- state ---------------------------------------------------------------
  private readonly systemPositions = new Map<string, Vector3>();
  private highlightId: string | null = null;
  private readonly highlightTarget = new Vector3();
  private readonly cursorTarget = new Vector3();
  private cursorActive = false;
  private routeSegments = 0;
  private routeNodeCount = 0;

  /** Mean spacing between catalogue stars, ly — the natural "neighbourhood". */
  private readonly starSpacing: number;
  private readonly boundY: number;
  private localCount = 0;

  constructor(galaxy: GalaxySpec, quality: QualitySettings, starField?: Float32Array) {
    registerShaderChunks();

    this.galaxy = galaxy;
    this.field = buildField(galaxy);
    const f = this.field;
    const R = f.radius;

    const count = Math.max(0, Math.min(galaxy.starCount, quality.galaxyStarBudget));
    const data = starField ?? generateStarField(galaxy, count);
    const n = Math.floor(data.length / 5);

    const defines: Record<string, string | number> = {
      OS_STEPS: Math.max(20, quality.nebulaSteps),
      OS_NEBULA_STEPS: Math.max(6, Math.round(quality.nebulaSteps * 0.16)),
      OS_DUST_TAPS: quality.tier === 'low' ? 2 : quality.tier === 'ultra' ? 4 : 3,
      OS_CLUMPS: Math.max(1, f.clumps.length),
    };
    if (f.barAmp > 0) defines.OS_HAS_BAR = 1;

    // ---- shared field uniforms (identical objects in every material) ------
    const fieldUniforms: Record<string, IUniform> = {
      uRadius: { value: R },
      uScaleLength: { value: f.scaleLength },
      uScaleHeight: { value: f.scaleHeight },
      uArmCount: { value: f.armCount },
      uTanPitch: { value: f.tanPitch },
      uArmContrast: { value: f.armContrast },
      uArmSharp: { value: f.armSharp },
      uArmStart: { value: f.armStart },
      uBulgeRadius: { value: f.bulgeRadius },
      uBulgeFlatten: { value: f.bulgeFlatten },
      uBulgeAmp: { value: f.bulgeAmp },
      uBarLength: { value: Math.max(f.barLength, 1) },
      uBarWidth: { value: Math.max(f.barWidth, 1) },
      uBarAmp: { value: f.barAmp },
      uBarAngle: { value: f.barAngle },
      uRingRadius: { value: Math.max(f.ringRadius, 1) },
      uRingWidth: { value: Math.max(f.ringWidth, 1) },
      uAxisB: { value: f.axisB },
      uAxisC: { value: f.axisC },
      uEffRadius: { value: Math.max(f.effRadius, 1) },
      uPeak: { value: Math.max(f.peak, 1e-6) },
      uOffset: { value: new Vector2(f.offsetX, f.offsetZ) },
      uGasFraction: { value: f.gasFraction },
      // Dust lanes sit on the inner, trailing edge of the arm — the shock
      // front is upstream of the young stars it triggered.
      uDustPhase: { value: 0.42 },
      uInterarmFloor: { value: 0.22 },
      uDustAbsorb: this.uDustAbsorb,
      uNoiseFreq: this.uNoiseFreq,
      uNoiseOff: this.uNoiseOff,
      uDetailFreq: this.uDetailFreq,
      uDetailAmp: this.uDetailAmp,
      uDetailBlend: this.uDetailBlend,
      uCameraLocal: this.uCameraLocal,
    };

    if (f.clumps.length > 0) {
      const cl: Vector4[] = [];
      const cw: number[] = [];
      for (const c of f.clumps) {
        cl.push(new Vector4(c.x, c.y, c.z, Math.max(c.radius, 1)));
        cw.push(c.weight);
      }
      fieldUniforms.uClumps = { value: cl };
      fieldUniforms.uClumpW = { value: cw };
    }

    // Emission and absorption are *measured*, not guessed.
    //
    // The five galaxy shapes differ by orders of magnitude in how much column
    // density a ray crosses: a razor-thin spiral disc and a de Vaucouleurs
    // spheroid whose profile is singular at the origin cannot share a constant.
    // So the reference column is integrated on the CPU, through the same field
    // the catalogue was sampled from, and the coefficient is solved for. Every
    // seed and every shape then lands at the same exposure.
    this.emissionBase = this.calibrateEmission(f);
    this.uEmission.value = this.emissionBase;
    this.uDustAbsorb.value = this.calibrateDust(f);
    // Base octave ~R/9, so the three-octave fBm spans structure from a tenth of
    // the disc down to a fortieth of it — the scale range real arms break up on.
    this.uNoiseFreq.value = 13 / R;

    const seedRng = rngFrom(galaxy.seed, 'galaxy-view');
    this.uNoiseOff.value.set(
      seedRng.range(-64, 64),
      seedRng.range(-64, 64),
      seedRng.range(-64, 64),
    );

    this.object3d = new Group();
    this.object3d.name = `galaxy-view:${galaxy.id}`;
    this.object3d.matrixAutoUpdate = true;

    // ---- bounds -----------------------------------------------------------
    let ex = R * 1.2;
    let ey = Math.max(f.scaleHeight * 6, R * 0.1);
    let ez = R * 1.2;
    if (n > 0) {
      let mx = 0;
      let my = 0;
      let mz = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 5;
        mx = Math.max(mx, Math.abs(data[o]));
        my = Math.max(my, Math.abs(data[o + 1]));
        mz = Math.max(mz, Math.abs(data[o + 2]));
      }
      ex = Math.max(mx * 1.12, R * 0.3);
      ey = Math.max(my * 1.15, f.scaleHeight * 4);
      ez = Math.max(mz * 1.12, R * 0.3);
    }
    this.boundY = ey;

    const volume = 4.18879 * ex * ey * ez;
    this.starSpacing = Math.min(
      Math.max(Math.cbrt(volume / Math.max(n, 1)), R * 0.002),
      R * 0.06,
    );

    // ---- volume pass ------------------------------------------------------
    const volGeo = new SphereGeometry(1, 48, 24);
    const volMat = new ShaderMaterial({
      defines,
      uniforms: {
        ...fieldUniforms,
        uBound: { value: new Vector3(ex, ey, ez) },
        uCoreColor: { value: new Color(...galaxy.coreColor) },
        uArmColor: { value: new Color(...galaxy.armColor) },
        uDustColor: { value: new Color(...galaxy.dustColor) },
        // Young, hot and blue — but keyed off the galaxy's own arm colour so a
        // red galaxy does not sprout cyan arms.
        uYoungColor: {
          value: new Color(...galaxy.armColor).lerp(new Color(0.52, 0.70, 1.0), 0.7).multiplyScalar(1.1),
        },
        // Flocculent galaxies get weaker arms than grand-design ones, but never
        // none: the map has to stay legible at every seed.
        uYoungGain: { value: 0.22 + 0.5 * galaxy.armContrast },
        uEmission: this.uEmission,
        uDustScatter: { value: 0.25 },
        uKnee: { value: 0.12 },
      },
      vertexShader: VOLUME_VERT,
      fragmentShader: volumeFrag(f),
      side: BackSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // Premultiplied "over": dst = dst*(1-a) + src. The transmittance built
      // up inside the march is what darkens everything behind the dust.
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
      premultipliedAlpha: true,
    });
    this.volume = new Mesh(volGeo, volMat);
    this.volume.frustumCulled = false;
    this.volume.renderOrder = 10;
    this.object3d.add(this.volume);
    this.geometries.push(volGeo);
    this.materials.push(volMat);

    // ---- stars ------------------------------------------------------------
    const pos = new Float32Array(n * 3);
    const bright = new Float32Array(n);
    const temp = new Float32Array(n);
    const jitter = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 5;
      pos[i * 3] = data[o];
      pos[i * 3 + 1] = data[o + 1];
      pos[i * 3 + 2] = data[o + 2];
      bright[i] = data[o + 3];
      temp[i] = data[o + 4];
      // A little per-star scatter so the size ladder never quantises into
      // visible rings of identical points.
      jitter[i] = 0.72 + seedRng.next() * 0.56;
    }
    const crowd = new Float32Array(n);
    this.buildCrowding(pos, n, ex, ey, ez, crowd);

    const starGeo = new BufferGeometry();
    starGeo.setAttribute('position', new BufferAttribute(pos, 3));
    starGeo.setAttribute('aBright', new BufferAttribute(bright, 1));
    starGeo.setAttribute('aTemp', new BufferAttribute(temp, 1));
    starGeo.setAttribute('aCrowd', new BufferAttribute(crowd, 1));
    starGeo.setAttribute('aJitter', new BufferAttribute(jitter, 1));

    const starMat = new ShaderMaterial({
      defines,
      uniforms: {
        ...fieldUniforms,
        uLogLRef: this.uLogLRef,
        uSizeScale: { value: 3.4 },
        uMinPx: { value: 1.0 },
        uMaxPx: { value: 24 },
        uEnergy: this.uStarEnergy,
        uPixelRatio: this.uPixelRatio,
        uZoom: this.uZoom,
      },
      vertexShader: starVert(f),
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.stars = new Points(starGeo, starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = 14;
    this.object3d.add(this.stars);
    this.geometries.push(starGeo);
    this.materials.push(starMat);

    // ---- local systems ----------------------------------------------------
    // The catalogue above is a *painting* of 1e11 stars: a hundred thousand
    // points across fifty thousand light years means a thousand light years
    // between them, so a neighbourhood framed at fifty would be empty sky.
    // The systems you can actually fly to come from `sampleSystemsNear`, which
    // is stateless and meant to be queried while the map is open. Feeding them
    // in through `setLocalSystems()` is what fades the last two orders of
    // magnitude of zoom in — no regeneration of anything.
    const localGeo = new BufferGeometry();
    localGeo.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(MAX_LOCAL_SYSTEMS * 3), 3),
    );
    localGeo.setAttribute('aBright', new BufferAttribute(new Float32Array(MAX_LOCAL_SYSTEMS), 1));
    localGeo.setAttribute('aTemp', new BufferAttribute(new Float32Array(MAX_LOCAL_SYSTEMS), 1));
    const localCrowd = new Float32Array(MAX_LOCAL_SYSTEMS);
    const localJit = new Float32Array(MAX_LOCAL_SYSTEMS);
    localCrowd.fill(1);
    localJit.fill(1);
    localGeo.setAttribute('aCrowd', new BufferAttribute(localCrowd, 1));
    localGeo.setAttribute('aJitter', new BufferAttribute(localJit, 1));
    localGeo.setDrawRange(0, 0);

    const localMat = new ShaderMaterial({
      defines,
      uniforms: {
        ...fieldUniforms,
        uLogLRef: this.uLogLRef,
        uSizeScale: { value: 3.4 },
        uMinPx: { value: 1.0 },
        uMaxPx: { value: 24 },
        uEnergy: this.uLocalEnergy,
        uPixelRatio: this.uPixelRatio,
        uZoom: this.uZoom,
      },
      vertexShader: starVert(f),
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.localStars = new Points(localGeo, localMat);
    this.localStars.frustumCulled = false;
    this.localStars.renderOrder = 15;
    this.localStars.visible = false;
    this.object3d.add(this.localStars);
    this.geometries.push(localGeo);
    this.materials.push(localMat);

    // ---- nebulae ----------------------------------------------------------
    const glowSpecs = galaxy.nebulae.filter((nb) => nb.kind !== 'dark');
    const darkSpecs = galaxy.nebulae.filter((nb) => nb.kind === 'dark');
    this.nebulaGlow = this.buildNebulae(glowSpecs, defines, false);
    this.nebulaDark = this.buildNebulae(darkSpecs, defines, true);
    if (this.nebulaDark) {
      this.nebulaDark.renderOrder = 11;
      this.object3d.add(this.nebulaDark);
    }
    if (this.nebulaGlow) {
      this.nebulaGlow.renderOrder = 12;
      this.object3d.add(this.nebulaGlow);
    }

    // ---- UI ---------------------------------------------------------------
    const gridGeo = new PlaneGeometry(R * 2.7, R * 2.7, 1, 1);
    const gridMat = new ShaderMaterial({
      uniforms: {
        uColor: { value: CYAN.clone() },
        uOpacity: this.uGridOpacity,
        uRingStep: { value: this.niceStep(R / 4) },
        uSpokes: { value: 12 },
        uRadius: { value: R },
        uPxScale: this.uPxScale,
      },
      vertexShader: GRID_VERT,
      fragmentShader: GRID_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    });
    this.grid = new Mesh(gridGeo, gridMat);
    this.grid.frustumCulled = false;
    this.grid.renderOrder = 20;
    this.grid.visible = false;
    this.object3d.add(this.grid);
    this.geometries.push(gridGeo);
    this.materials.push(gridMat);

    // Route ribbon: screen-space-expanded quads, four verts per segment.
    const segs = MAX_ROUTE_POINTS - 1;
    const routeGeo = new BufferGeometry();
    routeGeo.setAttribute('position', new BufferAttribute(new Float32Array(segs * 4 * 3), 3));
    routeGeo.setAttribute('aOther', new BufferAttribute(new Float32Array(segs * 4 * 3), 3));
    const side = new Float32Array(segs * 4);
    const flip = new Float32Array(segs * 4);
    const index = new Uint16Array(segs * 6);
    for (let s = 0; s < segs; s++) {
      const v = s * 4;
      side[v] = -1;
      side[v + 1] = 1;
      side[v + 2] = -1;
      side[v + 3] = 1;
      flip[v] = 1;
      flip[v + 1] = 1;
      flip[v + 2] = -1;
      flip[v + 3] = -1;
      const i6 = s * 6;
      index[i6] = v;
      index[i6 + 1] = v + 1;
      index[i6 + 2] = v + 2;
      index[i6 + 3] = v + 2;
      index[i6 + 4] = v + 1;
      index[i6 + 5] = v + 3;
    }
    routeGeo.setAttribute('aSide', new BufferAttribute(side, 1));
    routeGeo.setAttribute('aFlip', new BufferAttribute(flip, 1));
    routeGeo.setAttribute('aDist', new BufferAttribute(new Float32Array(segs * 4), 1));
    routeGeo.setIndex(new BufferAttribute(index, 1));
    routeGeo.setDrawRange(0, 0);

    const routeMat = new ShaderMaterial({
      uniforms: {
        uColor: { value: CYAN.clone() },
        uOpacity: { value: 1.35 },
        uDashPerLy: { value: 1 },
        uPhase: this.uDashPhase,
        uFadeRef: this.uRouteFadeRef,
        uViewport: this.uViewport,
        uWidthPx: { value: 1.5 },
      },
      vertexShader: ROUTE_VERT,
      fragmentShader: ROUTE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    });
    this.route = new Mesh(routeGeo, routeMat);
    this.route.frustumCulled = false;
    this.route.renderOrder = 21;
    this.route.visible = false;
    this.object3d.add(this.route);
    this.geometries.push(routeGeo);
    this.materials.push(routeMat);

    const nodeGeo = new BufferGeometry();
    nodeGeo.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(MAX_ROUTE_POINTS * 3), 3),
    );
    nodeGeo.setDrawRange(0, 0);
    const nodeMat = new ShaderMaterial({
      uniforms: {
        uColor: { value: CYAN.clone() },
        uOpacity: { value: 1.1 },
        uSizePx: { value: 9 },
        uPixelRatio: this.uPixelRatio,
      },
      vertexShader: NODE_VERT,
      fragmentShader: NODE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.routeNodes = new Points(nodeGeo, nodeMat);
    this.routeNodes.frustumCulled = false;
    this.routeNodes.renderOrder = 22;
    this.routeNodes.visible = false;
    this.object3d.add(this.routeNodes);
    this.geometries.push(nodeGeo);
    this.materials.push(nodeMat);

    const markerGeo = new PlaneGeometry(2, 2, 1, 1);
    this.geometries.push(markerGeo);

    const cursorMat = new ShaderMaterial({
      uniforms: {
        uAnchor: this.uCursorAnchor,
        uPxScale: this.uPxScale,
        uSizePx: { value: 52 },
        uColor: { value: CYAN.clone().multiplyScalar(0.75) },
        uOpacity: { value: 0.9 },
      },
      vertexShader: MARKER_VERT,
      fragmentShader: CURSOR_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.cursor = new Mesh(markerGeo, cursorMat);
    this.cursor.frustumCulled = false;
    this.cursor.renderOrder = 23;
    this.cursor.visible = false;
    this.object3d.add(this.cursor);
    this.materials.push(cursorMat);

    const reticleMat = new ShaderMaterial({
      uniforms: {
        uAnchor: this.uReticleAnchor,
        uPxScale: this.uPxScale,
        uSizePx: { value: 96 },
        uColor: { value: CYAN.clone() },
        uOpacity: { value: 1.4 },
        uLock: this.uReticleLock,
      },
      vertexShader: MARKER_VERT,
      fragmentShader: RETICLE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.reticle = new Mesh(markerGeo, reticleMat);
    this.reticle.frustumCulled = false;
    this.reticle.renderOrder = 24;
    this.reticle.visible = false;
    this.object3d.add(this.reticle);
    this.materials.push(reticleMat);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Teach the view where systems are so `setHighlight()` can find them.
   * `gen/galaxy.ts` generates system positions on demand from a spatial hash,
   * so there is no catalogue to look them up in — whoever ran the query owns
   * the answer and hands it over here. Call it again to extend or replace.
   */
  setSystemPositions(entries: Iterable<readonly [string, Vec3]>, replace = false): void {
    if (replace) this.systemPositions.clear();
    for (const [id, p] of entries) {
      const existing = this.systemPositions.get(id);
      if (existing) existing.set(p[0], p[1], p[2]);
      else this.systemPositions.set(id, new Vector3(p[0], p[1], p[2]));
    }
    if (this.highlightId) this.resolveHighlight();
  }

  /**
   * Hand over the navigable systems around wherever the player is looking —
   * straight from `sampleSystemsNear()`. They are drawn as resolved stars that
   * fade in over the last two orders of magnitude of zoom, and their positions
   * are registered for `setHighlight()` at the same time, so one call wires a
   * whole neighbourhood. Call it again whenever the query point moves; it
   * rewrites in place and allocates nothing on the GPU.
   */
  setLocalSystems(systems: readonly StarSystemStub[]): void {
    const geo = this.localStars.geometry;
    const posAttr = geo.getAttribute('position') as BufferAttribute;
    const brightAttr = geo.getAttribute('aBright') as BufferAttribute;
    const tempAttr = geo.getAttribute('aTemp') as BufferAttribute;
    const pos = posAttr.array as Float32Array;
    const bright = brightAttr.array as Float32Array;
    const temp = tempAttr.array as Float32Array;

    const n = Math.min(systems.length, MAX_LOCAL_SYSTEMS);
    for (let i = 0; i < n; i++) {
      const s = systems[i];
      pos[i * 3] = s.position[0];
      pos[i * 3 + 1] = s.position[1];
      pos[i * 3 + 2] = s.position[2];
      // Same packing the star field uses: normalised log luminosity over the
      // nine decades from a cold white dwarf to a blue supergiant.
      bright[i] =
        s.luminosity > 0
          ? Math.min(1, Math.max(0, (Math.log10(s.luminosity) + 4) / 9))
          : 0;
      temp[i] = s.temperature;
      const existing = this.systemPositions.get(s.id);
      if (existing) existing.set(s.position[0], s.position[1], s.position[2]);
      else
        this.systemPositions.set(
          s.id,
          new Vector3(s.position[0], s.position[1], s.position[2]),
        );
    }
    posAttr.needsUpdate = true;
    brightAttr.needsUpdate = true;
    tempAttr.needsUpdate = true;
    geo.setDrawRange(0, n);
    this.localCount = n;
    this.localStars.visible = n > 0;
    if (this.highlightId) this.resolveHighlight();
  }

  /** Put the lock-on reticle on a system. Null clears it. */
  setHighlight(systemId: string | null): void {
    if (systemId === this.highlightId) return;
    this.highlightId = systemId;
    this.uReticleLock.value = 0;
    this.resolveHighlight();
  }

  /** Free-floating crosshair, galaxy-local light years. Null hides it. */
  setCursor(positionLy: Vec3 | null): void {
    if (!positionLy) {
      this.cursorActive = false;
      this.cursor.visible = false;
      return;
    }
    this.cursorTarget.set(positionLy[0], positionLy[1], positionLy[2]);
    if (!this.cursorActive) this.uCursorAnchor.value.copy(this.cursorTarget);
    this.cursorActive = true;
    this.cursor.visible = true;
  }

  /**
   * Replace the plotted route. Points are galaxy-local light years, in travel
   * order. Passing fewer than two points hides the line.
   */
  setRouteLine(points: readonly Vec3[]): void {
    const geo = this.route.geometry;
    const count = Math.min(points.length, MAX_ROUTE_POINTS);
    this.routeSegments = Math.max(0, count - 1);
    this.routeNodeCount = count;

    if (this.routeSegments === 0) {
      geo.setDrawRange(0, 0);
      this.route.visible = false;
      this.routeNodes.geometry.setDrawRange(0, 0);
      this.routeNodes.visible = false;
      return;
    }

    const posAttr = geo.getAttribute('position') as BufferAttribute;
    const otherAttr = geo.getAttribute('aOther') as BufferAttribute;
    const distAttr = geo.getAttribute('aDist') as BufferAttribute;
    const pos = posAttr.array as Float32Array;
    const other = otherAttr.array as Float32Array;
    const dist = distAttr.array as Float32Array;

    let travelled = 0;
    let longest = 1;
    for (let s = 0; s < this.routeSegments; s++) {
      const a = points[s];
      const b = points[s + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const dA = travelled;
      const dB = travelled + len;
      travelled = dB;
      longest = Math.max(longest, len);

      const v = s * 4;
      for (let j = 0; j < 4; j++) {
        const isA = j < 2;
        const src = isA ? a : b;
        const oth = isA ? b : a;
        const o3 = (v + j) * 3;
        pos[o3] = src[0];
        pos[o3 + 1] = src[1];
        pos[o3 + 2] = src[2];
        other[o3] = oth[0];
        other[o3 + 1] = oth[1];
        other[o3 + 2] = oth[2];
        dist[v + j] = isA ? dA : dB;
      }
    }
    posAttr.needsUpdate = true;
    otherAttr.needsUpdate = true;
    distAttr.needsUpdate = true;
    geo.setDrawRange(0, this.routeSegments * 6);
    this.route.visible = true;

    // ~15 dashes per jump leg, whatever the scale of the route.
    const mat = this.route.material as ShaderMaterial;
    (mat.uniforms.uDashPerLy as IUniform<number>).value = 15 / Math.max(longest, 1);

    const nodeGeo = this.routeNodes.geometry;
    const nodeAttr = nodeGeo.getAttribute('position') as BufferAttribute;
    const nodes = nodeAttr.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const p = points[i];
      nodes[i * 3] = p[0];
      nodes[i * 3 + 1] = p[1];
      nodes[i * 3 + 2] = p[2];
    }
    nodeAttr.needsUpdate = true;
    nodeGeo.setDrawRange(0, count);
    this.routeNodes.visible = true;
  }

  /** The navigational grid on the galactic plane. Off by default. */
  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
  }

  /** Art-direction knobs, exposed so a review pass can tune without a rebuild. */
  setStarExposure(v: number): void {
    this.starEnergyBase = Math.max(0, v);
  }

  setVolumeExposure(v: number): void {
    this.emissionBase = Math.max(0, v) * this.calibrateEmission(this.field);
  }

  setDustDensity(v: number): void {
    this.uDustAbsorb.value = Math.max(0, v) * this.calibrateDust(this.field);
  }

  // -------------------------------------------------------------------------

  update(dt: number, ctx: EngineContext, view: ViewState): void {
    const R = this.field.radius;
    const cam = view.cameraLocal;
    this.uCameraLocal.value.copy(cam);

    // --- zoom -------------------------------------------------------------
    // How far is the camera from what it is *looking at*? That, not the
    // distance to the origin, is the scale everything else keys off. If a
    // target or a cursor is set it is by definition the subject; otherwise
    // fall back to the gap between the camera and the galaxy's own surface,
    // floored at the mean spacing between catalogue stars. One curve, four
    // orders of magnitude, and the star sizes hold at both ends.
    const camLen = Math.max(cam.length(), 1e-3);
    // Ellipsoid parameter of the camera: >1 outside the galaxy's own bounds,
    // <1 inside it. X and Z are the disc plane and share its radius; only Y is
    // the thin axis. (Dividing Z by the thin half-height, as this used to,
    // reported a camera sitting *inside* the disc as being tens of radii
    // outside it, which pinned the zoom curve to 0 and froze the star sizes,
    // the detail octave and the local-catalogue fade at their wide-shot values.)
    const camR = R * 1.2;
    const q = Math.sqrt(
      (cam.x / camR) ** 2 + (cam.y / this.boundY) ** 2 + (cam.z / camR) ** 2,
    );
    let refDist = q > 1 ? camLen * (1 - 1 / q) : 0;
    refDist = Math.max(refDist, this.starSpacing * 2);
    if (this.reticle.visible) {
      refDist = Math.min(refDist, cam.distanceTo(this.highlightTarget));
    } else if (this.cursorActive) {
      refDist = Math.min(refDist, cam.distanceTo(this.cursorTarget));
    }
    refDist = Math.max(refDist, 0.5);

    // 0 at whole-galaxy framing, 1 once a neighbourhood fills the screen.
    const decades = Math.log2(R / refDist);
    const zoom = Math.min(1, Math.max(0, decades / 8));
    this.uZoom.value = zoom;

    // Magnitude reference: the luminosity that renders at unit energy *at the
    // subject distance*. Sliding the luminosity end of it with zoom is what
    // makes supergiants the visible population at galaxy scale and ordinary
    // dwarfs the visible population in a neighbourhood.
    const logLRef = LOG_LREF_WIDE + (LOG_LREF_CLOSE - LOG_LREF_WIDE) * zoom;
    this.uLogLRef.value = logLRef - 2 * Math.log10(refDist);

    // Surface brightness is distance-invariant, so the painted haze looks the
    // same from a hundred thousand light years out as it does from inside the
    // disc — while a point source gains as 1/d^2. Left alone, that means the
    // haze fills the frame at close range and drowns the very systems the
    // player zoomed in to look at. So the two are cross-faded: the painting
    // recedes as the catalogue takes over. It is also simply how a map should
    // behave — the further in you go, the more it becomes an instrument.
    // 0.55, not 0.9: the haze only has to stop *competing* with the catalogue,
    // not disappear. Fading it to a tenth leaves the neighbourhood shot as a
    // black frame with a sprinkle of dots in it, and the galactic core is the
    // backdrop that shot is composed against.
    this.uEmission.value = this.emissionBase * (1 - 0.55 * zoom);
    this.uStarEnergy.value = this.starEnergyBase * (1 + 2.2 * zoom);

    // The neighbourhood overlay only earns its pixels once the catalogue has
    // thinned out; below that it would just double up on the same stars.
    const localFade = Math.min(
      1,
      Math.max(0, (Math.log2(this.starSpacing * 6) - Math.log2(refDist)) / 2.5),
    );
    this.uLocalEnergy.value = this.uStarEnergy.value * localFade;
    this.localStars.visible = this.localCount > 0 && localFade > 0.002;

    // The extra octave sits one step above the fBm's own and crossfades up one
    // more as the camera closes. It deliberately does NOT keep climbing with
    // zoom: the raymarch's step size is set by the span of the *galaxy*, not by
    // the pixel footprint, so it barely improves as you fly in. An octave finer
    // than a few hundred light years is grain at any zoom (the shader's
    // Nyquist fade throws it away), and switching it off at wide framing — as
    // a pixel-footprint schedule does — starves the one shot that most needs
    // the feathering. Constant amplitude, on at every range.
    this.uDetailFreq.value = this.uNoiseFreq.value * 2.4;
    this.uDetailBlend.value = zoom;
    this.uDetailAmp.value = 0.34;

    // --- screen metrics ----------------------------------------------------
    const cssHeight = Math.max(ctx.height, 1);
    this.uPixelRatio.value = Math.max(view.viewportHeight, 1) / cssHeight;
    // World units per CSS pixel, per unit of view depth.
    this.uPxScale.value = (2 * Math.tan(view.fovY * 0.5)) / cssHeight;
    this.uViewport.value.set(Math.max(ctx.width, 1), cssHeight);
    this.uRouteFadeRef.value = Math.max(refDist * 4, 50);

    // --- UI motion (nothing snaps) ----------------------------------------
    this.uDashPhase.value = (this.uDashPhase.value + dt * 0.22) % 1;

    if (this.reticle.visible) {
      const k = 1 - Math.exp(-9 * dt);
      this.uReticleAnchor.value.lerp(this.highlightTarget, k);
      this.uReticleLock.value += (1 - this.uReticleLock.value) * (1 - Math.exp(-4.5 * dt));
    }
    if (this.cursorActive) {
      const k = 1 - Math.exp(-14 * dt);
      this.uCursorAnchor.value.lerp(this.cursorTarget, k);
    }
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.object3d.clear();
    this.systemPositions.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private resolveHighlight(): void {
    if (!this.highlightId) {
      this.reticle.visible = false;
      return;
    }
    const p = this.systemPositions.get(this.highlightId);
    if (!p) {
      this.reticle.visible = false;
      return;
    }
    const wasVisible = this.reticle.visible;
    // Snap across long distances, ease across short ones — a reticle that
    // flies ten thousand light years looks like a bug, not like weight.
    if (!wasVisible || this.uReticleAnchor.value.distanceTo(p) > this.field.radius * 0.05) {
      this.uReticleAnchor.value.copy(p);
    }
    this.highlightTarget.copy(p);
    this.reticle.visible = true;
  }

  /** Radius, in ly, where this shape's light actually lives. */
  private referenceRadius(f: GalaxyField): number {
    switch (f.shape) {
      case 'elliptical':
        return f.effRadius * 0.6;
      case 'ring':
        return f.ringRadius;
      case 'irregular':
        return f.scaleLength;
      default:
        return f.radius * 0.35;
    }
  }

  /**
   * Solve for the emission coefficient that puts the reference structure at a
   * fixed screen exposure. Integrates the real density field vertically at a
   * spread of azimuths and takes an upper quartile, so the answer tracks an arm
   * ridge (or a ring, or a clump) rather than the gap next to it.
   */
  private calibrateEmission(f: GalaxyField): number {
    /**
     * Target linear value for the brightest structure, pre-tone-map.
     *
     * This number is set by where the whole chain lands, not by taste. The map
     * is authored in linear HDR and then goes through PostFX: auto exposure
     * (which pins to its 1.6x ceiling on a frame this dark), ACES, sRGB, a
     * contrast curve about a 0.36 pivot and a shoulder that asymptotes at 0.95.
     * That chain is extremely compressive above ~0.3 linear. At 0.38 — the
     * value this was first written with — an arm ridge, the interarm gap and
     * the nucleus all landed between 156 and 207/255: a milky, near-uniform
     * wash with about five levels of turbulent texture on it and no separation
     * between the core and the disc. Measured through the same chain, 0.085
     * puts an arm ridge at ~130 breathing between 92 and 165 with its
     * turbulence, the interarm gap at ~45, the outskirts near black and the
     * nucleus at ~190 — three stops of usable range instead of a third of one,
     * and dark enough that the resolved stars and the nebulae read as brighter
     * than the haze they sit in rather than drowning in it.
     */
    const TARGET = 0.085;
    const rRef = Math.max(this.referenceRadius(f), 1);
    const yMax = Math.max(f.scaleHeight * 8, f.effRadius * 2.5, f.bulgeRadius * 4);
    const steps = 160;
    const dy = (2 * yMax) / steps;
    const young = 0.22 + 0.5 * this.galaxy.armContrast;
    const invGas = 1 / Math.max(f.gasFraction, 1e-3);

    const columns: number[] = [];
    for (let a = 0; a < 48; a++) {
      const th = (a / 48) * Math.PI * 2;
      const x = Math.cos(th) * rRef;
      const z = Math.sin(th) * rRef;
      let sum = 0;
      for (let i = 0; i < steps; i++) {
        const y = -yMax + (i + 0.5) * dy;
        // starFormationAt divided by the whole-galaxy gas fraction is exactly
        // the field osYoungField() evaluates in the shader. An elliptical has
        // none: it is red and dead, and its constant trickle of formation must
        // not inflate the reference column.
        const sf = f.shape === 'elliptical' ? 0 : starFormationAt(f, x, y, z) * invGas;
        sum += densityAt(f, x, y, z) + young * sf;
      }
      // Doubled for the wide shot's 30-degree ray, which crosses twice the
      // vertical column a face-on ray would.
      columns.push(sum * dy * 2);
    }
    columns.sort((p, q) => p - q);
    // Near the top of the distribution, not the middle: a grand-design galaxy
    // spends most of its azimuth in the interarm gap, so a median would set the
    // exposure from the gap and blow the two ridges that matter to white.
    const ref = Math.max(columns[Math.min(columns.length - 1, Math.floor(columns.length * 0.95))], 1e-6);
    return TARGET / ref;
  }

  /**
   * Solve for the extinction coefficient that gives an arm's dust lane roughly
   * two and a half optical depths — dark enough to read as a lane, not so dark
   * that the disc is cut in half. The lane's own vertical profile is a sech^2
   * of scale height 0.30h, whose integral is 2 * 0.30h, doubled again for the
   * 30-degree ray. gasFraction is left to the shader so an elliptical, which
   * ran out of gas ten billion years ago, ends up with no lanes at all.
   */
  private calibrateDust(f: GalaxyField): number {
    const rRef = Math.max(this.referenceRadius(f), 1);
    const laneAmp = Math.exp(-rRef / Math.max(f.scaleLength * 2.2, 1));
    const path = 1.26 * Math.max(f.scaleHeight, 1);
    return 2.5 / Math.max(laneAmp * path, 1e-6);
  }

  /**
   * Per-star crowding attenuation.
   *
   * A hundred thousand additive points and a bulge that holds a fifth of them
   * is a recipe for one clipped white disc. Binning the catalogue and pulling
   * each star's energy down by the local occupancy keeps the total flux of the
   * core finite while leaving the brightest members punching through — so the
   * core reads as a dense hot mass with structure in it, which is what it is.
   */
  private buildCrowding(
    pos: Float32Array,
    n: number,
    ex: number,
    ey: number,
    ez: number,
    out: Float32Array,
  ): void {
    if (n === 0) return;
    const budget = 200_000;
    const span = Math.max(ex, ez);
    // Roughly cubic cells: split each axis in proportion to its extent.
    let gx = Math.max(4, Math.round(48 * (ex / span)));
    let gz = Math.max(4, Math.round(48 * (ez / span)));
    let gy = Math.max(4, Math.round(48 * (ey / span)));
    while (gx * gy * gz > budget) {
      gx = Math.max(4, gx - 2);
      gy = Math.max(4, gy - 1);
      gz = Math.max(4, gz - 2);
    }

    const cells = new Int32Array(gx * gy * gz);
    const which = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const cx = Math.min(gx - 1, Math.max(0, ((pos[i * 3] / ex + 1) * 0.5 * gx) | 0));
      const cy = Math.min(gy - 1, Math.max(0, ((pos[i * 3 + 1] / ey + 1) * 0.5 * gy) | 0));
      const cz = Math.min(gz - 1, Math.max(0, ((pos[i * 3 + 2] / ez + 1) * 0.5 * gz) | 0));
      const c = (cz * gy + cy) * gx + cx;
      which[i] = c;
      cells[c]++;
    }

    let occupied = 0;
    for (let c = 0; c < cells.length; c++) if (cells[c] > 0) occupied++;
    const mean = n / Math.max(occupied, 1);
    const ref = mean * 3;

    for (let i = 0; i < n; i++) {
      const c = cells[which[i]];
      // Exponent below 1: partial, not total. Full 1/N would flatten the core
      // into the disc and lose the density gradient that makes it a bulge.
      out[i] = c <= ref ? 1 : Math.min(1, Math.pow(ref / c, 0.45));
    }
  }

  private buildNebulae(
    specs: readonly NebulaSpec[],
    defines: Record<string, string | number>,
    dark: boolean,
  ): Mesh | null {
    if (specs.length === 0) return null;

    const base = new PlaneGeometry(2, 2, 1, 1);
    const geo = new InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.instanceCount = specs.length;
    // The source plane's own buffers are now referenced by `geo`; dispose only
    // the wrapper, never the shared attributes twice.
    this.geometries.push(base);

    const iPos = new Float32Array(specs.length * 3);
    const iColor = new Float32Array(specs.length * 4);
    const iAccent = new Float32Array(specs.length * 4);
    const iMeta = new Float32Array(specs.length * 2);

    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      iPos[i * 3] = s.position[0];
      iPos[i * 3 + 1] = s.position[1];
      iPos[i * 3 + 2] = s.position[2];
      iColor[i * 4] = s.color[0];
      iColor[i * 4 + 1] = s.color[1];
      iColor[i * 4 + 2] = s.color[2];
      iColor[i * 4 + 3] = s.density;
      iAccent[i * 4] = s.accentColor[0];
      iAccent[i * 4 + 1] = s.accentColor[1];
      iAccent[i * 4 + 2] = s.accentColor[2];
      iAccent[i * 4 + 3] = s.radiusLy;
      // Seed offsets the noise domain so no two nebulae share a shape.
      iMeta[i * 2] = new Rng(s.seed).range(-40, 40);
      iMeta[i * 2 + 1] = nebulaKindCode(s.kind);
    }

    geo.setAttribute('iPos', new InstancedBufferAttribute(iPos, 3));
    geo.setAttribute('iColor', new InstancedBufferAttribute(iColor, 4));
    geo.setAttribute('iAccent', new InstancedBufferAttribute(iAccent, 4));
    geo.setAttribute('iMeta', new InstancedBufferAttribute(iMeta, 2));

    const mat = new ShaderMaterial({
      defines,
      uniforms: {
        uCameraLocal: this.uCameraLocal,
        uPxScale: this.uPxScale,
        uMinPx: this.uNebulaMinPx,
        // The palette allows one saturated accent per location. An emission
        // nebula is the most saturated thing the map can draw, so it is kept
        // below the arm it sits on: a knot in the disc, not a sticker over it.
        uIntensity: { value: dark ? 1.5 : 0.30 },
        uZoom: this.uZoom,
      },
      vertexShader: NEBULA_VERT,
      fragmentShader: dark ? NEBULA_DARK_FRAG : NEBULA_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      ...(dark
        ? {
            // dst *= src — a dark cloud removes light, it does not add any.
            blending: CustomBlending,
            blendSrc: DstColorFactor,
            blendDst: ZeroFactor,
          }
        : { blending: AdditiveBlending }),
    });

    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.geometries.push(geo);
    this.materials.push(mat);
    return mesh;
  }

  /** Round a grid step to 1/2/5 × 10^n so the rings land on readable numbers. */
  private niceStep(v: number): number {
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1))));
    const f = v / mag;
    const m = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
    return m * mag;
  }
}

// ---------------------------------------------------------------------------
// Hero shots
// ---------------------------------------------------------------------------

/** Place the camera at a spherical offset in galaxy-local space, then aim it. */
function frameGalaxy(
  ctx: EngineContext,
  view: GalaxyView,
  targetLocal: Vector3,
  distance: number,
  azimuth: number,
  elevation: number,
  fovDeg: number,
  roll = 0,
): void {
  const obj = view.object3d;
  obj.updateWorldMatrix(true, false);

  const ce = Math.cos(elevation);
  const offset = new Vector3(
    Math.cos(azimuth) * ce * distance,
    Math.sin(elevation) * distance,
    Math.sin(azimuth) * ce * distance,
  );
  const camLocal = targetLocal.clone().add(offset);

  const camWorld = camLocal.applyMatrix4(obj.matrixWorld);
  const lookWorld = targetLocal.clone().applyMatrix4(obj.matrixWorld);
  // Galactic north is +Y in local space; using it as the camera's up keeps the
  // disc level in frame instead of tilting like a dropped plate.
  const upWorld = new Vector3(0, 1, 0)
    .applyMatrix4(obj.matrixWorld)
    .sub(new Vector3(0, 0, 0).applyMatrix4(obj.matrixWorld))
    .normalize();

  // A few degrees of roll. The horizon of a galaxy is not a spirit level, and
  // a dead-level one reads as a diagram rather than a photograph.
  upWorld.applyAxisAngle(new Vector3().subVectors(lookWorld, camWorld).normalize(), roll);
  ctx.camera.up.copy(upWorld);
  ctx.camera.position.copy(camWorld);
  ctx.camera.lookAt(lookWorld);
  ctx.camera.fov = fovDeg;
  ctx.camera.updateProjectionMatrix();
}

/**
 * Register the galaxy map's review shots.
 *
 * `getView` is a late-bound accessor so the integrator can register the shots
 * at boot, before the galaxy the player is actually in has been chosen.
 */
export function registerGalaxyViewShots(getView: () => GalaxyView | null): void {
  registerShot({
    name: 'galaxy-map-wide',
    description:
      'The whole galaxy from 30° above the plane: spiral arms, dust lanes cutting ' +
      'across the disc, a dense structured core and the navigation grid underneath.',
    apply(ctx) {
      const view = getView();
      if (!view) return;
      view.setRouteLine([]);
      view.setHighlight(null);
      view.setCursor(null);
      view.setGridVisible(true);

      const R = view.galaxy.radiusLy;
      // Off-centre so the core sits on a third rather than dead middle, and a
      // long-ish lens so the disc compresses instead of splaying.
      const target = new Vector3(R * 0.16, 0, -R * 0.06);
      // Seen from 30 degrees up, a disc projects to an ellipse half as tall as
      // it is wide, so a distance chosen to fit the *width* leaves the top and
      // bottom thirds of the frame empty and the map reads as a small diagram
      // in a large void. 1.9R fills the frame with the disc and lets the outer
      // grid ring run off the sides, which is what makes it a photograph of
      // something rather than a picture of a thing on a table.
      frameGalaxy(ctx, view, target, R * 1.9, 2.35, Math.PI / 6, 42, 0.07);
    },
  });

  registerShot({
    name: 'galaxy-map-zoom',
    description:
      'A local neighbourhood four orders of magnitude in: resolved stars with ' +
      'diffraction spikes, a cyan lock-on reticle on the target system and a ' +
      'dashed route running out to it, all against the galactic core behind.',
    apply(ctx) {
      const view = getView();
      if (!view) return;
      const g = view.galaxy;
      const R = g.radiusLy;

      // Deterministic target: solve the spiral for a point that lands ON an
      // arm, so the neighbourhood is somewhere worth looking at.
      const rng = rngFrom(g.seed, 'shot:galaxy-map-zoom');
      const field = buildField(g);
      const r = R * 0.52;
      const arm = rng.int(0, Math.max(0, field.armCount - 1));
      let theta =
        Math.log(Math.max(r, field.armStart * 0.25) / field.armStart) / field.tanPitch +
        field.barAngle +
        (arm * 2 * Math.PI) / Math.max(field.armCount, 1);
      const target = new Vector3(
        Math.cos(theta) * r,
        rng.gaussian(0, field.scaleHeight * 0.3),
        Math.sin(theta) * r,
      );

      // Compose against something. At 55 light years the unresolved haze is
      // twenty thousand light years away and the frame is otherwise a black
      // field with a sprinkle of points in it — the failure state the visual
      // contract names outright. Standing the neighbourhood off the flank of a
      // nebula puts a lit volume behind the instruments, which is the one
      // saturated accent this location is allowed and the only object at this
      // scale big enough to fill a frame.
      const glow = g.nebulae.filter((nb) => nb.kind !== 'dark');
      if (glow.length > 0) {
        const nb = glow[rng.int(0, glow.length - 1)];
        const c = new Vector3(nb.position[0], nb.position[1], nb.position[2]);
        // Outward along the galactic radius, far enough out that the cloud
        // sits behind the target rather than swallowing it. Under ~2.5 radii
        // it subtends more than the lens does and the frame becomes a flat
        // wall of one hue; at 2.8 it is a lit object with a silhouette and sky
        // around it, which is the difference between a backdrop and a wash.
        const out = new Vector3(c.x, 0, c.z).normalize();
        if (out.lengthSq() < 0.5) out.set(1, 0, 0);
        target.copy(c).addScaledVector(out, nb.radiusLy * 2.8);
        target.y = c.y + rng.gaussian(0, field.scaleHeight * 0.25);
        theta = Math.atan2(target.z - c.z, target.x - c.x);
      }

      // Ask the real catalogue what is out here. Systems sit roughly six light
      // years apart, so a 55 ly query is a proper neighbourhood and still only
      // touches a few hundred hash cells.
      const span = 55;
      const near = sampleSystemsNear(g, [target.x, target.y, target.z], span, 1400);

      if (near.length > 0) {
        view.setLocalSystems(near);
        // The brightest system in the neighbourhood, not the first one out of
        // the spatial hash. Three quarters of a real stellar census are M
        // dwarfs, so "the first one" is almost always a two-pixel ember and the
        // lock-on reticle ends up closed around nothing.
        let pick = near[0];
        for (const s of near) if (s.luminosity > pick.luminosity) pick = s;
        target.set(pick.position[0], pick.position[1], pick.position[2]);
        view.setHighlight(pick.id);
      } else {
        view.setLocalSystems([]);
        view.setSystemPositions([['shot-target', [target.x, target.y, target.z]]], true);
        view.setHighlight('shot-target');
      }

      // A plotted route running in to the target, wandering the way a real jump
      // plot does rather than running as a straight line. It is laid out mostly
      // ACROSS the view: run it along the view axis and perspective collapses
      // it into a foreshortened zigzag that reads as a broken polyline. The
      // wobble stays well under the leg length for the same reason — a lateral
      // kick comparable to the leg turns the route into a saw edge.
      const legs = 5;
      const reach = span * 0.85;
      const pts: Vec3[] = [];
      const inward = new Vector3(-Math.cos(theta), 0, -Math.sin(theta));
      const lateral = new Vector3(-inward.z, 0, inward.x);
      for (let i = legs; i >= 0; i--) {
        const t = i / legs;
        const wobble = (rng.next() - 0.5) * reach * 0.10 * (1 - t * 0.4);
        pts.push([
          target.x + (lateral.x * 0.92 + inward.x * 0.38) * reach * t + inward.x * wobble,
          target.y + rng.gaussian(0, reach * 0.05),
          target.z + (lateral.z * 0.92 + inward.z * 0.38) * reach * t + inward.z * wobble,
        ]);
      }
      view.setRouteLine(pts);
      view.setCursor([pts[0][0], pts[0][1], pts[0][2]]);
      // The grid's rings are ten thousand light years apart; at this range they
      // would be one line through frame, so it comes off.
      view.setGridVisible(false);

      // Stand on the far side of the target from the core, so the core is the
      // backdrop: local resolved stars and cyan instrumentation in front of a
      // hundred billion unresolved ones.
      // Almost in-plane. Looking down at a neighbourhood puts the distant disc
      // up on the top edge and leaves the bottom two thirds of the frame with
      // nothing in it; from inside the plane the disc runs across the middle of
      // the frame and the local stars sit in front of it.
      frameGalaxy(ctx, view, target, span * 0.95, theta, 0.14, 50, 0.16);
    },
  });
}
