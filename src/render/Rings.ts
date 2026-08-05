/**
 * Planetary ring systems.
 *
 * A ring is not a texture on a quad. It is a thin, plane-parallel slab of dirty
 * water ice with an optical depth that varies wildly with radius, and the whole
 * reason rings photograph so well is that the light transport through that slab
 * is *dramatic*:
 *
 *   - Backlit (star on the far side) the slab glows. Transmitted radiance goes
 *     like tau * exp(-tau / muV), so it peaks where the normal optical depth is
 *     comparable to the viewing cosine: sparse bands and the material *inside*
 *     the divisions become the BRIGHTEST things in frame, dense bands go opaque
 *     and black, and a genuinely empty gap is dark because nothing is there to
 *     scatter. This is the Cassini "sun behind Saturn" look, and it only appears
 *     inside the forward-scattering lobe — see the `phase` field on the shots.
 *   - Frontlit (star on the camera's side) the slab reflects. It is roughly ten
 *     times dimmer, more opaque, and the dense bands are now the bright ones.
 *
 * Both regimes fall out of the Chandrasekhar single-scattering solution for a
 * homogeneous slab, which is two lines of algebra, so we solve it properly
 * rather than faking a gradient. The planet's shadow is intersected
 * analytically against the sphere — exact, one dot product, no shadow map.
 *
 * Everything is anti-aliased against the *radial* screen-space derivative,
 * because a ring seen near edge-on compresses tens of thousands of kilometres
 * of ringlets into one pixel row and will shimmer like tinfoil otherwise.
 *
 * Contract: see ARCHITECTURE.md §10. This class never touches the scene.
 */

import {
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  DataUtils,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  NoColorSpace,
  Object3D,
  Quaternion,
  RGFormat,
  ShaderMaterial,
  Uint32BufferAttribute,
  Vector3,
  Vector4,
} from 'three';

import type { EngineContext } from '@/core/Engine';
import type { QualitySettings } from '@/core/Config';
import type { RingSpec } from '@/gen/types';
import { hashSeed, hash3, Rng } from '@/math/rng';
import { registerShaderChunks } from '@/shaders/chunks';
import type { ViewState } from '@/render/ViewState';
import { registerShot } from '@/game/Shots';

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

interface RingBudget {
  /** Segments around the annulus. Governs how circular the silhouette is. */
  readonly angular: number;
  /** Rings of vertices across the annulus. Shading is per-fragment, so few. */
  readonly radial: number;
  /** Texels in the baked radial optical-depth profile. */
  readonly texels: number;
  /** GPU octaves layered *above* the baked profile's Nyquist limit. */
  readonly octaves: number;
  /** Whether to add the worley particulate layer (close-range material). */
  readonly particulate: boolean;
}

function budgetFor(q: QualitySettings): RingBudget {
  switch (q.tier) {
    case 'low':
      return { angular: 384, radial: 4, texels: 1024, octaves: 3, particulate: false };
    case 'medium':
      return { angular: 768, radial: 6, texels: 2048, octaves: 4, particulate: true };
    case 'ultra':
      return { angular: 2048, radial: 10, texels: 4096, octaves: 6, particulate: true };
    case 'high':
    default:
      return { angular: 1280, radial: 8, texels: 4096, octaves: 5, particulate: true };
  }
}

// ---------------------------------------------------------------------------
// What the planet material needs in order to draw the rings' shadow on itself
// ---------------------------------------------------------------------------

/**
 * Everything required to cast the ring shadow band back onto the planet.
 *
 * The planet material should, per surface fragment `P` (planet-local km):
 *   1. rotate `P` and the sun direction `L` by `toRingSpace`;
 *   2. solve `P.y + s * L.y == 0` for `s`; if `s <= 0` the ring plane is behind
 *      the surface point and there is no shadow;
 *   3. `r = length((P + s * L).xz)`; if `r` is outside `[innerKm, outerKm]`
 *      there is no shadow;
 *   4. `tau = texture2D(profile, vec2((r - innerKm) / (outerKm - innerKm), 0.5)).r
 *              * tauScale`;
 *   5. multiply the sunlight by `exp(-tau / max(abs(L.y), 1e-3))`.
 *
 * Step 5 is the same slant-path extinction the ring shader uses, so the band on
 * the planet and the rings themselves agree exactly — including every Cassini
 * division, because both read the same baked profile.
 */
export interface RingShadowParams {
  readonly innerKm: number;
  readonly outerKm: number;
  /** Rotates a planet-local vector into ring-plane space (ring plane = y == 0). */
  readonly toRingSpace: Quaternion;
  /** Ring plane normal expressed in planet-local space. */
  readonly normalLocal: Vector3;
  /** R = normalised optical depth 0..1, G = ice fraction 0..1. Mipmapped. */
  readonly profile: DataTexture;
  /** Multiply the profile's R channel by this to get the true normal optical depth. */
  readonly tauScale: number;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const RING_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vPos;

void main() {
  // Ring-plane space: the annulus lies in y == 0, planet centre at the origin.
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const RING_FRAG = /* glsl */ `
#include <common>
#include <onespace_noise>
#include <onespace_color>
#include <onespace_atmosphere>
#include <logdepthbuf_pars_fragment>

uniform sampler2D uProfile;
uniform float uInner;         // km
uniform float uOuter;         // km
uniform float uPlanetR;       // km
uniform vec3  uSunDir;        // ring space, unit, points from the planet to the star
uniform vec3  uSunColor;      // linear RGB, already scaled by the star's intensity
uniform vec3  uCam;           // ring space, km
uniform float uTau;           // peak normal optical depth
uniform vec3  uIceTint;       // dense, fresh-ice material
uniform vec3  uDustTint;      // sparse, silicate-contaminated material
uniform vec3  uShine;         // planetshine reaching the shadowed face
uniform vec3  uTwilight;      // reddened light in the penumbra
uniform float uTime;          // seconds
uniform float uSunAng;        // angular radius of the star, radians
uniform float uEdgeFade;      // |cos(incidence)| below which the plane fades out
uniform float uAlbedo;        // single-scattering albedo of a ring particle
uniform float uG;             // forward Henyey-Greenstein asymmetry
uniform float uDetailFreq;    // cycles across the ring for the first GPU octave
uniform float uDetail;        // master gain on the GPU detail layers
uniform float uShear;         // Keplerian shear rate of the azimuthal clumping
uniform float uSeed;
uniform float uExposure;
uniform vec4  uWaveA;         // (radial wavenumber, azimuthal m, amplitude, pattern speed)
uniform vec4  uWaveB;         // (centre t, envelope width, ---, ---)
uniform vec4  uWaveC;
uniform vec4  uWaveD;

varying vec3 vPos;

/**
 * One spiral density wave train.
 *
 * Real waves are launched at a satellite resonance and wind up tighter with
 * radius, so the radial wavenumber grows linearly — that is the t*t term. The
 * azimuthal harmonic is evaluated from (cos az, sin az) with the Chebyshev
 * identities rather than atan(), because atan()'s branch cut at +-PI puts a
 * one-pixel-wide discontinuity through the derivative used for anti-aliasing.
 */
float os_ringWave(vec4 A, vec4 B, float t, float radialFoot, float c, float s, float azFoot) {
  float phase = A.x * (0.5 * t * t + 0.5 * t) + A.w * uTime;
  float cm, sm;
  if (A.y < 2.5) {
    cm = c * c - s * s;          // cos 2az
    sm = 2.0 * c * s;            // sin 2az
  } else {
    cm = c * (c * c - 3.0 * s * s);  // cos 3az
    sm = s * (3.0 * c * c - s * s);  // sin 3az
  }
  float v = sin(phase) * cm - cos(phase) * sm;
  // Gaussian envelope: a wave train is local to its resonance, not global.
  float e = (t - B.x) / max(B.y, 1e-4);
  v *= exp(-e * e);
  // Screen-space phase footprint: kill the train once a pixel spans ~a radian.
  float foot = A.x * (t + 0.5) * radialFoot + A.y * azFoot;
  return A.z * v * (1.0 - smoothstep(0.45, 1.30, foot));
}

void main() {
  #include <logdepthbuf_fragment>

  float r = length(vPos.xz);
  float t = (r - uInner) / (uOuter - uInner);

  // The single most important number in this shader: how much of the radial
  // coordinate one pixel covers. Near edge-on this explodes, and every piece of
  // high-frequency structure below is faded out against it.
  float w = max(fwidth(t), 1e-8);

  // Unit azimuthal direction — continuous everywhere, unlike atan().
  float invR = 1.0 / max(r, 1e-4);
  float c = vPos.x * invR;
  float s = vPos.z * invR;
  float azFoot = length(vec2(fwidth(c), fwidth(s)));  // radians of arc per pixel

  // --- baked radial structure ------------------------------------------------
  // Automatic LOD + anisotropic filtering does the heavy lifting: the profile is
  // a mipmapped 1D texture, so hundreds of ringlets filter down to their correct
  // mean instead of strobing.
  vec2 prof = texture2D(uProfile, vec2(clamp(t, 0.0, 1.0), 0.5)).rg;
  float tauN = prof.r;
  float ice = prof.g;

  // --- GPU octaves above the profile's Nyquist limit -------------------------
  float det = 0.0;
  float amp = 1.0;
  float freq = uDetailFreq;
  for (int i = 0; i < OS_RING_OCTAVES; i++) {
    float fade = 1.0 - smoothstep(0.22, 0.85, w * freq);
    if (fade > 0.0) {
      det += amp * fade * os_snoise(vec3(t * freq, uSeed + float(i) * 13.0, 0.0));
    }
    freq *= 2.17;   // irrational-ish lacunarity: octaves never line up twice
    amp *= 0.60;
  }
  // Optical depth is a *column density*: a clump that doubles it and a void that
  // halves it have to be symmetric, which they only are in log space. The old
  // linear form (1 + k*det) had to be clamped at the bottom, and once every
  // octave woke up on close approach the clamp flattened the sparsest third of
  // the ring into a dead plateau — the exact "uniform field" failure mode.
  tauN *= exp(clamp(uDetail * 0.55 * det, -2.0, 2.0));

  // --- azimuthal breakup, sheared by Kepler ----------------------------------
  // Inner material laps outer material, so a clump smears into a spiral. Without
  // this the rings read as perfect concentric bands and the eye rejects them.
  float shear = mod(uTime * uShear * pow(uInner * invR, 1.5), 6.28318531);
  float cs = cos(shear), sn = sin(shear);
  float ca = c * cs + s * sn;
  float sa = s * cs - c * sn;
  float clumpFade = 1.0 - smoothstep(0.02, 0.06, w);
  float clump = os_snoise(vec3(ca * 5.0, sa * 5.0, t * 26.0 + uSeed)) * clumpFade;
  tauN *= exp(uDetail * 0.19 * clump);

  // --- spiral density waves --------------------------------------------------
  tauN *= 1.0 + uDetail * os_ringWave(uWaveA, uWaveB, t, w, c, s, azFoot);
  tauN *= 1.0 + uDetail * os_ringWave(uWaveC, uWaveD, t, w, c, s, azFoot);

#ifdef OS_RING_PARTICULATE
  // Close-range material: a swarm of km-scale clumps. Faded out well before it
  // can alias, so it costs nothing at orbital distance.
  float pFade = 1.0 - smoothstep(0.00006, 0.0004, w);
  if (pFade > 0.0) {
    float cell = 1.0 / max(uOuter * 0.00004, 0.5);
    vec2 wl = os_worley(vec3(vPos.x * cell, vPos.z * cell, uSeed * 0.37));
    tauN *= 1.0 + uDetail * pFade * (0.55 - wl.x) * 0.5;
  }
#endif

  float tau = max(tauN, 0.0) * uTau;

  // --- geometry of the light transport ---------------------------------------
  vec3 V = normalize(uCam - vPos);       // fragment -> camera
  vec3 L = uSunDir;                      // fragment -> star (rings are tiny vs. the orbit)

  float vy = V.y;
  float muV = max(abs(vy), 2.0e-3);
  float muL = max(abs(L.y), 2.0e-3);

  // Scattering angle: incoming propagation is -L, outgoing is V. cos = 1 is
  // pure forward scatter, i.e. the star is directly behind the ring particles.
  float cosTheta = dot(-L, V);
  float pF = os_phaseMie(cosTheta, uG) * 12.56637061;      // 1.0 == isotropic
  float pB = os_phaseMie(cosTheta, -0.30) * 12.56637061;
  float opp = pow(max(0.0, -cosTheta), 20.0);              // opposition surge
  float phase = min(0.55 * pF + 0.28 * pB + 0.17 + 0.90 * opp, 30.0);

  float Tv = exp(-tau / muV);
  float Tl = exp(-tau / muL);

  // Chandrasekhar single scattering off a homogeneous slab.
  float refl = (uAlbedo * phase / (4.0 * (muV + muL)))
             * (1.0 - exp(-tau * (1.0 / muV + 1.0 / muL)));

  // ...and through it. The (muV - muL) form is singular on the diagonal, so
  // blend into its analytic limit instead of dividing by nearly zero.
  float dm = muV - muL;
  float thru = (uAlbedo * phase / (4.0 * (abs(dm) < 1.0e-3 ? 1.0e-3 : dm))) * (Tv - Tl);
  float thruLimit = (uAlbedo * phase * tau / (4.0 * muV * muV)) * Tv;
  thru = mix(thruLimit, thru, smoothstep(1.0e-3, 6.0e-3, abs(dm)));

  // Same side of the plane -> we see reflected light; opposite -> transmitted.
  float sameSide = step(0.0, vy * L.y);
  float scatter = mix(max(thru, 0.0), max(refl, 0.0), sameSide);

  // Both Chandrasekhar branches carry a factor of muL that the algebra above
  // leaves out: a slab lit at a grazing angle intercepts less flux per unit of
  // its own area. Without this the ring is exactly as bright with the star 1
  // degree off the plane as with it 60 degrees up, which is the single biggest
  // thing that makes a CG ring read as a decal. OS_MUL_NORM renormalises so the
  // default uExposure still lands the backlit hero geometry (muL ~= 0.22) just
  // above 1.0 — it is a unit convention, not a fudge on the angular response.
  const float OS_MUL_NORM = 4.44;
  scatter *= muL * OS_MUL_NORM;

  // --- the planet's shadow, solved analytically ------------------------------
  // March from the ring sample towards the star and test the planet sphere.
  // |P| > planetR always, so both roots share a sign: the planet can only be in
  // the way when dot(P, L) < 0.
  vec3 P = vPos;
  float b = dot(P, L);
  float perp = sqrt(max(dot(P, P) - b * b, 0.0));
  // Penumbra width grows with the distance travelled to the occluder.
  float soft = max(-b, 0.0) * uSunAng + uPlanetR * 0.0015;
  // Dither the threshold: a 200,000 km wide gradient banded at 8 bits otherwise.
  float jitter = (os_igNoise(gl_FragCoord.xy) - 0.5) * soft * 0.6;
  float shade = step(b, 0.0) * (1.0 - smoothstep(uPlanetR - soft, uPlanetR + soft, perp + jitter));

  vec3 sunlight = uSunColor * (1.0 - shade);
  // Light bent through the planet's atmosphere reddens the shadow's edge.
  float penumbra = clamp(shade * (1.0 - shade) * 4.0, 0.0, 1.0);
  sunlight += uSunColor * uTwilight * penumbra;

  // --- colour ----------------------------------------------------------------
  // Two desaturated hues only: cold ice and warm dust. Forward-scattered light
  // reads cooler (small-particle diffraction), backscatter reads tan.
  //
  // The forward term may only BIAS the mix. At the backlit hero geometry
  // cosTheta is ~0.93 across the whole frame, so the old weights (0.75 * ice +
  // 0.35 * forward) drove the clamp to 1.0 for every ice fraction above 0.9 and
  // the dust hue vanished from the frame entirely — one flat blue field, which
  // is precisely what section 6 forbids. These weights keep the full 0.32..0.98
  // spread of the ice channel visible at the same geometry.
  float forward = clamp(cosTheta * 0.5 + 0.5, 0.0, 1.0);
  vec3 tint = mix(uDustTint, uIceTint, clamp(ice * 0.95 + forward * 0.20 - 0.16, 0.0, 1.0));

  vec3 radiance = sunlight * scatter * tint;

  // Planetshine: the only thing lighting the umbra. Deliberately near-black.
  float shineFall = uPlanetR * uPlanetR / max(dot(P, P), 1.0);
  radiance += uShine * shineFall * (1.0 - Tv) * tint;

  // --- coverage and the edge-on vanish ---------------------------------------
  // Alpha is real slab extinction; the extra fade is the physical fact that a
  // 20 m thick sheet seen within a couple of degrees of its own plane stops
  // covering whole pixels. Both the alpha and the radiance are faded so the
  // reflection/transmission switch at vy == 0 is never visible.
  float coverage = 1.0 - Tv;
  float edge = smoothstep(0.0, w * 1.5, t) * smoothstep(0.0, w * 1.5, 1.0 - t);
  float thin = smoothstep(0.0, uEdgeFade, abs(vy));
  float alpha = clamp(coverage * edge * thin, 0.0, 1.0);

  radiance *= edge * thin * uExposure;
  radiance = os_dither(radiance, gl_FragCoord.xy);

  // Premultiplied: radiance is what the ring ADDS, alpha is what it BLOCKS.
  gl_FragColor = vec4(max(radiance, 0.0), alpha);
}
`;

// ---------------------------------------------------------------------------
// CPU-side radial profile
// ---------------------------------------------------------------------------

/** 1D value noise on an exact integer lattice. Deterministic from `seed`. */
function valueNoise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash3(i, 0, 0, seed) / 4294967296;
  const b = hash3(i + 1, 0, 0, seed) / 4294967296;
  return a + (b - a) * u;
}

/**
 * Layered value noise, -1..1. Mirrors what the GPU adds above Nyquist.
 *
 * The top octaves run above the texture's own Nyquist limit and therefore alias
 * when point-sampled into one texel each. That was measured rather than assumed:
 * band-limiting them away makes the `low` and `high` bakes agree *worse* (15% vs
 * 6% RMS, since the cutoff itself is then tier-dependent) for a 4% gain in local
 * contrast. The aliased octaves carry gain^3..gain^4 of the amplitude, so what
 * they alias down to is indistinguishable from more ringlets. Left alone
 * deliberately — do not "fix" this without re-measuring both numbers.
 */
function fbm1(x: number, seed: number, octaves: number, lacunarity: number, gain: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * (valueNoise1(x * freq, (seed + i * 7919) >>> 0) * 2 - 1);
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / norm;
}

function smoothstepf(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / Math.max(edge1 - edge0, 1e-9)));
  return t * t * (3 - 2 * t);
}

interface ProfileMip {
  data: Uint16Array;
  width: number;
  height: number;
}

/**
 * Bake the radial optical-depth profile.
 *
 * This is the single source of truth for the ring's radial structure — the ring
 * shader reads it and so does the planet's shadow band, which is why it lives on
 * the CPU as data rather than as GLSL. Layers, coarsest first:
 *
 *   1. Broad bands (a Saturn A/B/C ring analogue) with random, sometimes sharp
 *      boundaries.
 *   2. Hundreds of fine ringlets from layered value noise.
 *   3. A handful of razor-sharp Cassini-style divisions, some containing their
 *      own narrow ringlet.
 *   4. Individual narrow features, bright and dark.
 *   5. Tapered inner and outer edges.
 */
function bakeProfile(spec: RingSpec, texels: number): { data: Uint16Array; mips: ProfileMip[] } {
  const rng = new Rng(hashSeed(spec.seed >>> 0, 'ring-profile'));
  const nSeed = hashSeed(spec.seed >>> 0, 'ring-noise');

  // A feature narrower than a texel is hit or missed depending on where the
  // texel centres happen to fall, so at `low` tier its very existence would be a
  // coin flip. Widen instead of dropping: a slightly soft Encke gap on `low` is
  // the same gap, a randomly-absent one is a different ring system.
  const minHalfWidth = 1.5 / texels;

  // 1. broad bands ----------------------------------------------------------
  const bandCount = rng.int(4, 7);
  const cuts: number[] = [];
  for (let i = 0; i < bandCount - 1; i++) cuts.push(rng.range(0.06, 0.94));
  cuts.sort((a, b) => a - b);
  const levels: number[] = [];
  const softs: number[] = [];
  for (let i = 0; i < bandCount; i++) {
    // A quarter of the bands are near-empty: that contrast is what makes a ring
    // system read as structured rather than as a smear.
    levels.push(rng.chance(0.28) ? rng.range(0.03, 0.18) : rng.range(0.42, 1.0));
    softs.push(rng.chance(0.4) ? rng.range(0.0015, 0.006) : rng.range(0.012, 0.055));
  }

  // 2. ringlet frequency ----------------------------------------------------
  // Two layers: the coarse one gives the bands you read at orbital distance,
  // the fine one gives the hairlines you only resolve on approach.
  const ringletFreq = rng.range(170, 340);
  const ringletDepth = rng.range(0.52, 0.78);
  const hairFreq = ringletFreq * rng.range(3.3, 4.6);
  const hairDepth = rng.range(0.20, 0.34);

  // 3. sharp divisions ------------------------------------------------------
  const gapCount = rng.int(2, 4);
  const gaps: Array<{ c: number; hw: number; depth: number; soft: number; inner: number }> = [];
  for (let i = 0; i < gapCount; i++) {
    const hw = Math.max(rng.range(0.004, 0.024), minHalfWidth);
    gaps.push({
      c: rng.range(0.12, 0.9),
      hw,
      depth: rng.range(0.0, 0.12),
      // The soft shoulder is what makes a division read as *sharp*, so it is
      // floored at half a texel rather than at a whole one.
      soft: Math.max(hw * rng.range(0.04, 0.22), 0.5 / texels),
      // 40% of divisions hold a narrow ringlet, as the Encke gap does.
      inner: rng.chance(0.4) ? rng.range(-0.5, 0.5) : Number.NaN,
    });
  }

  // 4. individual narrow features -------------------------------------------
  const featureCount = rng.int(10, 18);
  const features: Array<{ c: number; hw: number; gain: number }> = [];
  for (let i = 0; i < featureCount; i++) {
    features.push({
      c: rng.next(),
      hw: Math.max(rng.range(0.0008, 0.0055), minHalfWidth),
      gain: rng.chance(0.55) ? rng.range(0.35, 1.1) : rng.range(-0.75, -0.3),
    });
  }

  // 5. edge tapers ----------------------------------------------------------
  const innerTaper = rng.range(0.006, 0.035);
  const outerTaper = rng.range(0.010, 0.060);

  const tau = new Float32Array(texels);
  const iceCh = new Float32Array(texels);
  let peak = 1e-6;

  for (let i = 0; i < texels; i++) {
    const t = (i + 0.5) / texels;

    let level = levels[0]!;
    for (let b = 1; b < bandCount; b++) {
      level = level + (levels[b]! - level) * smoothstepf(cuts[b - 1]! - softs[b]!, cuts[b - 1]! + softs[b]!, t);
    }

    const rl = 0.5 + 0.5 * fbm1(t * ringletFreq, nSeed, 5, 2.13, 0.58);
    const hair = 0.5 + 0.5 * fbm1(t * hairFreq, (nSeed ^ 0x2f9e1c33) >>> 0, 4, 2.07, 0.55);
    let v = level * (1 - ringletDepth + ringletDepth * Math.pow(Math.max(rl, 0), 1.35));
    v *= 1 - hairDepth + hairDepth * Math.pow(Math.max(hair, 0), 1.6) * 2.0;

    for (const g of gaps) {
      const d = Math.abs(t - g.c);
      const inside = 1 - smoothstepf(g.hw - g.soft, g.hw + g.soft, d);
      v *= 1 + (g.depth - 1) * inside;
      if (!Number.isNaN(g.inner)) {
        const rc = g.c + g.inner * g.hw;
        const rhw = Math.max(g.hw * 0.1, minHalfWidth);
        v += 0.55 * level * (1 - smoothstepf(rhw * 0.5, rhw * 1.5, Math.abs(t - rc)));
      }
    }

    for (const f of features) {
      const m = 1 - smoothstepf(f.hw * 0.5, f.hw * 1.6, Math.abs(t - f.c));
      v *= 1 + f.gain * m;
    }

    v *= smoothstepf(0, innerTaper, t) * smoothstepf(0, outerTaper, 1 - t);
    v = Math.max(v, 0);
    tau[i] = v;
    if (v > peak) peak = v;

    // Denser material is fresher ice; sparse material is dust-contaminated.
    iceCh[i] = Math.min(1, Math.max(0, 0.3 + 0.7 * v + 0.22 * fbm1(t * 44, (nSeed ^ 0x5bf03635) >>> 0, 4, 2.0, 0.5)));
  }

  const inv = 1 / peak;
  const level0 = new Uint16Array(texels * 2);
  for (let i = 0; i < texels; i++) {
    level0[i * 2] = DataUtils.toHalfFloat(tau[i]! * inv);
    level0[i * 2 + 1] = DataUtils.toHalfFloat(iceCh[i]!);
  }

  // Manual mip chain. Box-filtering optical depth is the linear approximation —
  // exact for thin regions, slightly conservative for opaque ones, and vastly
  // better than the strobing you get with no mips at all.
  const mips: ProfileMip[] = [{ data: level0, width: texels, height: 1 }];
  let srcTau: Float32Array = new Float32Array(texels);
  let srcIce: Float32Array = new Float32Array(texels);
  for (let i = 0; i < texels; i++) {
    srcTau[i] = tau[i]! * inv;
    srcIce[i] = iceCh[i]!;
  }
  let width = texels;
  while (width > 1) {
    const half = width >> 1;
    const dstTau = new Float32Array(half);
    const dstIce = new Float32Array(half);
    const data = new Uint16Array(half * 2);
    for (let i = 0; i < half; i++) {
      dstTau[i] = (srcTau[i * 2]! + srcTau[i * 2 + 1]!) * 0.5;
      dstIce[i] = (srcIce[i * 2]! + srcIce[i * 2 + 1]!) * 0.5;
      data[i * 2] = DataUtils.toHalfFloat(dstTau[i]!);
      data[i * 2 + 1] = DataUtils.toHalfFloat(dstIce[i]!);
    }
    mips.push({ data, width: half, height: 1 });
    srcTau = dstTau;
    srcIce = dstIce;
    width = half;
  }

  return { data: level0, mips };
}

// ---------------------------------------------------------------------------
// Uniform bag
// ---------------------------------------------------------------------------

interface RingUniforms {
  uProfile: { value: DataTexture | null };
  uInner: { value: number };
  uOuter: { value: number };
  uPlanetR: { value: number };
  uSunDir: { value: Vector3 };
  uSunColor: { value: Color };
  uCam: { value: Vector3 };
  uTau: { value: number };
  uIceTint: { value: Color };
  uDustTint: { value: Color };
  uShine: { value: Color };
  uTwilight: { value: Color };
  uTime: { value: number };
  uSunAng: { value: number };
  uEdgeFade: { value: number };
  uAlbedo: { value: number };
  uG: { value: number };
  uDetailFreq: { value: number };
  uDetail: { value: number };
  uShear: { value: number };
  uSeed: { value: number };
  uExposure: { value: number };
  uWaveA: { value: Vector4 };
  uWaveB: { value: Vector4 };
  uWaveC: { value: Vector4 };
  uWaveD: { value: Vector4 };
  [key: string]: { value: unknown };
}

// ---------------------------------------------------------------------------
// RingRenderer
// ---------------------------------------------------------------------------

export class RingRenderer {
  /** Planet-local. The integrator parents this to the planet and never rotates it. */
  readonly object3d: Object3D;

  readonly innerRadiusKm: number;
  readonly outerRadiusKm: number;
  /** The body this ring orbits, kilometres — the shots need it to clear the limb. */
  readonly planetRadiusKm: number;
  /** Rotates a ring-plane-space vector into planet-local space. */
  readonly tiltQuaternion: Quaternion;

  private readonly mesh: Mesh;
  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly profile: DataTexture;
  private readonly uniforms: RingUniforms;

  /** Ring-plane space is the tilted frame; ViewState arrives in planet-local. */
  private readonly invTilt = new Quaternion();
  private readonly vSun = new Vector3();
  private readonly vCam = new Vector3();
  private readonly shineTint = new Color(0.55, 0.60, 0.68);
  private shineStrength = 0.014;
  private readonly planeNormal = new Vector3(0, 1, 0);
  /** Review-shot latch; see {@link setSunDirectionOverride}. Preallocated. */
  private readonly sunOverride = new Vector3(0, 0, 1);
  private hasSunOverride = false;
  private disposed = false;

  constructor(spec: RingSpec, planetRadiusKm: number, quality: QualitySettings) {
    registerShaderChunks();

    const budget = budgetFor(quality);
    this.planetRadiusKm = planetRadiusKm;
    this.innerRadiusKm = spec.innerRadius * planetRadiusKm;
    this.outerRadiusKm = spec.outerRadius * planetRadiusKm;
    this.tiltQuaternion = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), spec.tilt);
    this.invTilt.copy(this.tiltQuaternion).invert();
    this.planeNormal.set(0, 1, 0).applyQuaternion(this.tiltQuaternion);

    const rng = new Rng(hashSeed(spec.seed >>> 0, 'ring-render'));

    const baked = bakeProfile(spec, budget.texels);
    this.profile = new DataTexture(baked.data, budget.texels, 1, RGFormat, HalfFloatType);
    this.profile.mipmaps = baked.mips;
    this.profile.generateMipmaps = false;
    this.profile.minFilter = LinearMipmapLinearFilter;
    this.profile.magFilter = LinearFilter;
    this.profile.wrapS = ClampToEdgeWrapping;
    this.profile.wrapT = ClampToEdgeWrapping;
    // Anisotropy is what saves the grazing-angle case: the radial derivative can
    // be a thousand times the azimuthal one, and an isotropic LOD would blur the
    // entire ring system into one grey band.
    this.profile.anisotropy = Math.max(1, quality.anisotropy);
    this.profile.colorSpace = NoColorSpace;
    this.profile.needsUpdate = true;

    this.geometry = buildAnnulus(this.innerRadiusKm, this.outerRadiusKm, budget.angular, budget.radial);

    // Base colour is rationed hard: one cold and one warm desaturated tint, both
    // derived from the spec so a ring system still reads as its own world. The
    // two are pulled apart harder than a physical ice/silicate pair would be —
    // steel-blue against sodium-tan is the whole colour budget this object gets,
    // and at these radiances a subtle split reads as no split at all.
    const base = new Color(spec.color[0], spec.color[1], spec.color[2]);
    const ice = base.clone().lerp(new Color(0.70, 0.78, 0.92), 0.50);
    const dust = base.clone().lerp(new Color(0.56, 0.40, 0.26), 0.55);

    // Two density-wave trains at random resonances. These are the only structure
    // in the whole object that is not concentric, so they carry the job of
    // breaking up what would otherwise be a field of perfect circles.
    const waveA = new Vector4(rng.range(130, 380), rng.chance(0.5) ? 2 : 3, rng.range(0.14, 0.30), rng.range(-0.05, 0.05));
    const waveB = new Vector4(rng.range(0.12, 0.88), rng.range(0.06, 0.20), 0, 0);
    const waveC = new Vector4(rng.range(220, 560), rng.chance(0.5) ? 2 : 3, rng.range(0.09, 0.20), rng.range(-0.05, 0.05));
    const waveD = new Vector4(rng.range(0.12, 0.88), rng.range(0.05, 0.16), 0, 0);

    this.uniforms = {
      uProfile: { value: this.profile },
      uInner: { value: this.innerRadiusKm },
      uOuter: { value: this.outerRadiusKm },
      uPlanetR: { value: planetRadiusKm },
      uSunDir: { value: new Vector3(0, 0, 1) },
      uSunColor: { value: new Color(1, 1, 1) },
      uCam: { value: new Vector3(0, 1, 0) },
      // spec.opacity is an artistic 0..1 knob; this maps it onto a real peak
      // normal optical depth. The floor of 0.35 matters more than the range: the
      // backlit look only exists if the densest bands are genuinely opaque
      // (tau >> muV) while the sparse ones sit near tau == muV where the
      // transmission term peaks. With the old 1.35x an opacity of 0.4 gave a
      // peak tau of 0.54 and the whole ring sat on one side of that curve —
      // a smooth radial ramp, i.e. the flat gradient section 6 forbids.
      uTau: { value: 0.35 + Math.min(1, Math.max(0, spec.opacity)) * 1.75 },
      uIceTint: { value: ice },
      uDustTint: { value: dust },
      uShine: { value: new Color(0, 0, 0) },
      uTwilight: { value: new Color(0.55, 0.20, 0.06) },
      uTime: { value: 0 },
      uSunAng: { value: 0.006 },
      // ~1.8 degrees. A ring is metres thick; within a couple of degrees of its
      // own plane it genuinely stops covering whole pixels.
      uEdgeFade: { value: 0.032 },
      uAlbedo: { value: 0.62 },
      uG: { value: 0.78 },
      // Start the GPU octaves just above the profile texture's own Nyquist
      // limit (texels / 2) so the two layers meet without a gap and without
      // doubling up. The old `texels * 0.9` sat 1.8x above Nyquist, leaving a
      // near-octave-wide hole in which the ring stopped gaining detail for a
      // whole factor of two of approach before the GPU layer woke up.
      uDetailFreq: { value: budget.texels * 0.55 },
      uDetail: { value: quality.tier === 'low' ? 0.7 : 1.0 },
      uShear: { value: 0.004 },
      // os_snoise's permutation lattice wraps at 289, so an integer seed offset
      // aliases every 289th seed onto the same detail. A fractional offset in a
      // non-integer range gives every ring system its own field.
      uSeed: { value: (hashSeed(spec.seed >>> 0, 'ring-gpu') % 1000003) / 3571.7 },
      // Backlit single scattering peaks near 7x the ring's own albedo. 0.5 puts
      // that peak just above 1.0 so the filmic curve in PostFX still has the
      // ringlet contrast to work with instead of a white slab.
      uExposure: { value: 0.5 },
      uWaveA: { value: waveA },
      uWaveB: { value: waveB },
      uWaveC: { value: waveC },
      uWaveD: { value: waveD },
    };

    this.material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      defines: budget.particulate
        ? { OS_RING_OCTAVES: budget.octaves, OS_RING_PARTICULATE: '' }
        : { OS_RING_OCTAVES: budget.octaves },
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // The shader emits the radiance the ring ADDS and the fraction it BLOCKS,
      // which is exactly the premultiplied convention. Anything else double-
      // counts the scattered light against the alpha.
      premultipliedAlpha: true,
      toneMapped: false,
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.quaternion.copy(this.tiltQuaternion);
    this.mesh.renderOrder = 12;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();

    this.object3d = new Group();
    this.object3d.name = 'rings';
    this.object3d.add(this.mesh);
  }

  // -- tuning hooks the integrator may use ----------------------------------

  /** Angular radius of the star as seen from the planet, radians. Softens the penumbra. */
  setSunAngularRadius(radians: number): void {
    this.uniforms.uSunAng.value = Math.max(1e-4, radians);
  }

  /** Light bounced off the planet onto the shadowed face. Keep it near-black. */
  setPlanetshine(color: Color, strength: number): void {
    this.shineTint.copy(color);
    this.shineStrength = strength;
  }

  /** Overall radiance multiplier, for balancing against the star and the grade. */
  setExposure(x: number): void {
    this.uniforms.uExposure.value = x;
  }

  /**
   * Pin the star direction (planet-local, unit) regardless of what `ViewState`
   * says. `null` returns to following `ViewState`.
   *
   * This exists for the review shots only. A ring system is backlit or it is
   * nothing, and a hero shot whose lighting depends on whether the integrator
   * happened to wire {@link RingShotHooks.setSunDirection} is not a hero shot.
   * Gameplay code must never call this.
   */
  setSunDirectionOverride(dirLocal: Vector3 | null): void {
    if (dirLocal === null) {
      this.hasSunOverride = false;
      return;
    }
    this.sunOverride.copy(dirLocal).normalize();
    this.hasSunOverride = true;
  }

  /**
   * Everything the planet material needs to draw the ring shadow on itself.
   * See {@link RingShadowParams} for the five-line recipe.
   */
  shadowParams(): RingShadowParams {
    return {
      innerKm: this.innerRadiusKm,
      outerKm: this.outerRadiusKm,
      toRingSpace: this.invTilt,
      normalLocal: this.planeNormal,
      profile: this.profile,
      tauScale: this.uniforms.uTau.value,
    };
  }

  // -- frame ----------------------------------------------------------------

  update(dt: number, ctx: EngineContext, view: ViewState): void {
    const u = this.uniforms;

    // ViewState is planet-local; the ring plane is tilted inside this object, so
    // rotate the light and the eye into the plane's own frame once, here, rather
    // than rotating every fragment.
    this.vSun
      .copy(this.hasSunOverride ? this.sunOverride : view.sunDirection)
      .applyQuaternion(this.invTilt);
    this.vCam.copy(view.cameraLocal).applyQuaternion(this.invTilt);

    u.uSunDir.value.copy(this.vSun);
    u.uCam.value.copy(this.vCam);
    u.uSunColor.value.copy(view.sunColor);
    u.uTime.value = view.time;

    u.uShine.value.copy(view.sunColor).multiply(this.shineTint).multiplyScalar(this.shineStrength);
  }

  /**
   * Frees every GPU resource this class allocates, of which there are exactly
   * three: the annulus `BufferGeometry`, the `ShaderMaterial`, and the baked
   * radial-profile `DataTexture` (with its 11-13 hand-built mip levels). No
   * render targets, no second material, no per-frame textures.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.geometry.dispose();
    this.material.dispose();
    this.profile.dispose();
    // A DataTexture keeps its pixel data alive after dispose(), so leaving it
    // bound to a live uniform lets a stray render silently re-upload it and undo
    // the free. Drop the reference as well as the GL object.
    this.uniforms.uProfile.value = null;
    this.object3d.remove(this.mesh);
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * An annulus in the XZ plane.
 *
 * The outer ring of vertices is pushed out by 1/cos(PI/segments) so the polygon
 * *circumscribes* the true circle. The fragment shader recovers the exact radius
 * from the interpolated position and feathers the edge there, so the silhouette
 * is a mathematically perfect circle at any segment count instead of a visible
 * polygon — which matters enormously when you fly along the ring plane.
 */
function buildAnnulus(innerKm: number, outerKm: number, segments: number, rings: number): BufferGeometry {
  const circumscribe = 1 / Math.cos(Math.PI / segments);
  const rInner = innerKm;
  const rOuter = outerKm * circumscribe;

  const cols = segments + 1;
  const rows = rings + 1;
  const positions = new Float32Array(cols * rows * 3);

  for (let j = 0; j < rows; j++) {
    const f = j / rings;
    const r = rInner + (rOuter - rInner) * f;
    for (let i = 0; i < cols; i++) {
      const a = (i / segments) * Math.PI * 2;
      const k = (j * cols + i) * 3;
      positions[k] = Math.cos(a) * r;
      positions[k + 1] = 0;
      positions[k + 2] = Math.sin(a) * r;
    }
  }

  const indices = new Uint32Array(segments * rings * 6);
  let o = 0;
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices[o++] = a;
      indices[o++] = c;
      indices[o++] = b;
      indices[o++] = b;
      indices[o++] = c;
      indices[o++] = d;
    }
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setIndex(new Uint32BufferAttribute(indices, 1));
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

export interface RingShotHooks {
  /**
   * Aim the dominant star. `dirLocal` is a unit vector in the ring object's
   * *local* (planet-centred) space pointing from the planet towards the star.
   * The integrator should move whatever drives `ViewState.sunDirection`.
   * If absent the shot only places the camera.
   */
  setSunDirection?(dirLocal: Vector3): void;
}

/**
 * Frame the ring system at its most flattering.
 *
 * Both shots put the star on the far side of the ring plane, because that is
 * when a ring system stops being a decal and starts being a volume: the thin
 * regions light up, the dense bands go opaque and black, and the planet lays a
 * hard shadow across the whole thing.
 */
export function registerRingsShots(rings: RingRenderer, hooks: RingShotHooks = {}): void {
  const DEG = Math.PI / 180;

  interface Framing {
    /** Camera elevation above the ring plane, degrees. */
    readonly el: number;
    /** Camera distance from the planet centre, in multiples of the outer radius. */
    readonly dist: number;
    /** Look-at offset from the planet centre, in multiples of the outer radius. */
    readonly aimX: number;
    readonly aimY: number;
    /** Star elevation relative to the ring plane, degrees. Negative == backlit. */
    readonly sunEl: number;
    /**
     * Phase angle in degrees: the angle between the camera's line of sight and
     * the direction light was travelling before it scattered.
     *
     * This, not the azimuth, is the number that decides whether the shot works.
     * The forward Henyey-Greenstein lobe at g = 0.78 has a half-width of about
     * 20 degrees; at a 34 degree phase angle the lobe contributes a phase
     * function of 2.1 and the shot is *dimmer than backscatter* — the "gaps
     * blaze" premise fails outright. At 21 degrees it is 6.1. The azimuth needed
     * to hit a requested phase angle is solved for below, because it depends on
     * both elevations and getting it wrong by 12 degrees costs a factor of three.
     */
    readonly phase: number;
  }

  const frame = (ctx: EngineContext, f: Framing): void => {
    const centre = new Vector3();
    const worldQ = new Quaternion();
    rings.object3d.getWorldPosition(centre);
    rings.object3d.getWorldQuaternion(worldQ);
    const q = worldQ.clone().multiply(rings.tiltQuaternion); // ring space -> world

    const el = f.el * DEG;
    // The 0.35 skew swings the camera slightly off the sun's meridian so the
    // shadow band lands as a diagonal instead of pointing straight at the lens.
    const camRing = new Vector3(Math.sin(el * 0.35), Math.sin(el), Math.cos(el)).normalize();
    const camDir = camRing.clone().applyQuaternion(q);
    const planeUp = new Vector3(0, 1, 0).applyQuaternion(q);
    const ringX = new Vector3(1, 0, 0).applyQuaternion(q);

    const camDist = rings.outerRadiusKm * f.dist;
    ctx.camera.position.copy(centre).addScaledVector(camDir, camDist);
    // Level the horizon with the ring plane — the composition lives or dies on it.
    ctx.camera.up.copy(planeUp);
    ctx.camera.lookAt(
      centre
        .clone()
        .addScaledVector(ringX, rings.outerRadiusKm * f.aimX)
        .addScaledVector(planeUp, rings.outerRadiusKm * f.aimY),
    );
    ctx.camera.updateMatrixWorld();

    // Push the phase angle out past the planet's limb if the requested one would
    // hide the star behind the disc. Section 6 wants a light source in or just
    // outside frame throwing glare; an eclipsed star gives neither that nor the
    // rim-lit limb, and the ring's own shadow band reads better with the
    // terminator slightly off-axis anyway.
    const limbDeg = Math.asin(Math.min(1, rings.planetRadiusKm / Math.max(camDist, 1))) / DEG;
    const phase = Math.max(f.phase, limbDeg + 4) * DEG;

    // Solve the spherical law of cosines for the azimuth that puts the ANTI-sun
    // direction `phase` away from the camera direction:
    //   cos(phase) = sin(antiEl) sin(camEl) + cos(antiEl) cos(camEl) cos(dAz)
    const se = f.sunEl * DEG;
    const camEl = Math.asin(camRing.y);
    const camAz = Math.atan2(camRing.x, camRing.z);
    const antiEl = -se;
    const den = Math.cos(antiEl) * Math.cos(camEl);
    const cosDAz =
      den > 1e-6 ? (Math.cos(phase) - Math.sin(antiEl) * Math.sin(camEl)) / den : 1;
    const dAz = Math.acos(Math.min(1, Math.max(-1, cosDAz)));
    const sunAz = camAz + dAz + Math.PI;

    const sunRing = new Vector3(
      Math.cos(se) * Math.sin(sunAz),
      Math.sin(se),
      Math.cos(se) * Math.cos(sunAz),
    );
    const sunLocal = sunRing.applyQuaternion(rings.tiltQuaternion);
    // Both: the hook so the planet, atmosphere and star agree, and the latch so
    // the rings are correct even in a harness where nothing wired the hook.
    rings.setSunDirectionOverride(sunLocal);
    hooks.setSunDirection?.(sunLocal);
  };

  registerShot({
    name: 'rings-backlit',
    description:
      'The star is 13 degrees BELOW the ring plane while the camera is 13 degrees above ' +
      'it, so every ring sample is seen in transmission along a slant path about four ' +
      'times the normal optical depth, at a 21 degree phase angle that sits inside the ' +
      'forward-scattering lobe. Dense bands go opaque and black; the sparse bands and ' +
      'the material inside the Cassini-style divisions blaze warm with forward-scattered ' +
      'light while the mid-density material stays cold steel-blue. The planet lays a ' +
      'hard-edged shadow band with a reddened penumbra rim diagonally across the near ' +
      'arc, and inside it the ring is essentially black. The star sits just clear of the ' +
      'planet limb, off the left of frame.',
    apply(ctx) {
      frame(ctx, { el: 13, dist: 1.5, aimX: -0.45, aimY: -0.1, sunEl: -13, phase: 21 });
    },
  });

  registerShot({
    name: 'rings-grazing',
    description:
      'Five degrees off the ring plane and close in, still backlit. The plane thins ' +
      'towards the far limb and fades out rather than collapsing to a hard line; the ' +
      'dense bands become an opaque silhouette cutting the frame, and the fine ringlet ' +
      'structure must stay stable under the extreme radial compression rather than ' +
      'shimmering.',
    apply(ctx) {
      frame(ctx, { el: 5, dist: 1.15, aimX: -0.75, aimY: 0.02, sunEl: -9, phase: 19 });
    },
  });
}
