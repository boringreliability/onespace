/**
 * Shared GLSL library, registered into three.js's own `#include` preprocessor.
 *
 * Import this module once at boot, then any ShaderMaterial in the project can
 * write `#include <onespace_noise>` and get the same, identically-seeded noise
 * every other shader uses. Keeping one copy matters: the CPU terrain sampler
 * in `gen/terrain.ts` must agree with the GPU or the ship sinks through hills.
 */

import { ShaderChunk } from 'three';

/** Hashing + value/simplex/worley noise + fBm variants. */
export const NOISE_GLSL = /* glsl */ `
// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------
vec3 os_hash33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
}

/**
 * Scalar hash of a 3D coordinate.
 *
 * The obvious formulation — fract(p.x*p.y*p.z*(p.x+p.y+p.z)) over
 * fract(p * 0.3183099) — is a trap, and it shipped here once. It is a PRODUCT,
 * so any one component landing near zero collapses the whole result; and
 * 0.3183099 is 1/pi, whose third convergent is 355/113. The degenerate
 * coordinates therefore recur on a 355-unit lattice, which in screen space is
 * a visible grid of seams every 355 pixels in every frame of the game.
 *
 * This is Hoskins' hash13: the middle step is ADDITIVE, so no single component
 * can annihilate the output, and 0.1031 is not a rational approximation of
 * anything the inputs are likely to be commensurate with.
 */
float os_hash13(vec3 p) {
  vec3 q = fract(p * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// ---------------------------------------------------------------------------
// Simplex noise (Ashima / Gustavson formulation, 3D)
// Returns roughly -1..1.
// ---------------------------------------------------------------------------
vec4 os_permute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
vec4 os_taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float os_snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + 1.0 * C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;

  i = mod(i, 289.0);
  vec4 p = os_permute(os_permute(os_permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 1.0 / 7.0;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = os_taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// ---------------------------------------------------------------------------
// Worley / cellular noise. x = F1 distance, y = F2 - F1 (edge mask).
// ---------------------------------------------------------------------------
vec2 os_worley(vec3 p) {
  vec3 id = floor(p);
  vec3 fd = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int k = -1; k <= 1; k++) {
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec3 offset = vec3(float(i), float(j), float(k));
        vec3 pos = offset + os_hash33(id + offset) * 0.5 + 0.5 - fd;
        float d = dot(pos, pos);
        if (d < f1) { f2 = f1; f1 = d; }
        else if (d < f2) { f2 = d; }
      }
    }
  }
  return vec2(sqrt(f1), sqrt(f2) - sqrt(f1));
}

// ---------------------------------------------------------------------------
// fBm family
// ---------------------------------------------------------------------------
float os_fbm(vec3 p, int octaves, float lacunarity, float gain) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  float norm = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= octaves) break;
    sum += amp * os_snoise(p * freq);
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / max(norm, 1e-5);
}

/** Ridged multifractal — carves mountain chains rather than rolling hills. */
float os_ridged(vec3 p, int octaves, float lacunarity, float gain) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  float norm = 0.0;
  float prev = 1.0;
  for (int i = 0; i < 16; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(os_snoise(p * freq));
    n *= n;
    n *= prev;
    prev = n;
    sum += amp * n;
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return (sum / max(norm, 1e-5)) * 2.0 - 1.0;
}

/** Billowed noise — puffy, cloud-like. */
float os_billow(vec3 p, int octaves, float lacunarity, float gain) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  float norm = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= octaves) break;
    sum += amp * abs(os_snoise(p * freq));
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return (sum / max(norm, 1e-5)) * 2.0 - 1.0;
}

/**
 * Domain warping. Feeding noise back into its own coordinates is the single
 * cheapest way to make procedural terrain stop looking procedural — it
 * produces the swirls, deltas and erosion channels that plain fBm never has.
 */
vec3 os_warp(vec3 p, float strength) {
  vec3 q = vec3(
    os_snoise(p + vec3(0.0, 0.0, 0.0)),
    os_snoise(p + vec3(5.2, 1.3, 2.8)),
    os_snoise(p + vec3(9.2, 8.3, 4.1))
  );
  return p + q * strength;
}

/** Analytic-ish normal from a height function, by central differences. */
vec3 os_gradient(vec3 p, float eps, int octaves, float lacunarity, float gain) {
  float dx = os_fbm(p + vec3(eps, 0.0, 0.0), octaves, lacunarity, gain)
           - os_fbm(p - vec3(eps, 0.0, 0.0), octaves, lacunarity, gain);
  float dy = os_fbm(p + vec3(0.0, eps, 0.0), octaves, lacunarity, gain)
           - os_fbm(p - vec3(0.0, eps, 0.0), octaves, lacunarity, gain);
  float dz = os_fbm(p + vec3(0.0, 0.0, eps), octaves, lacunarity, gain)
           - os_fbm(p - vec3(0.0, 0.0, eps), octaves, lacunarity, gain);
  return vec3(dx, dy, dz) / (2.0 * eps);
}
`;

/** Colour space, tone mapping helpers and blue-noise dithering. */
export const COLOR_GLSL = /* glsl */ `
vec3 os_linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, 1e-5), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 os_srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

/** Blackbody colour from temperature in kelvin (approximate, 1000–40000 K). */
vec3 os_blackbody(float kelvin) {
  float t = kelvin / 100.0;
  vec3 c;
  if (t <= 66.0) {
    c.r = 1.0;
    c.g = clamp(0.39008157 * log(t) - 0.63184144, 0.0, 1.0);
    c.b = t <= 19.0 ? 0.0 : clamp(0.54320679 * log(t - 10.0) - 1.19625408, 0.0, 1.0);
  } else {
    c.r = clamp(1.29293618 * pow(t - 60.0, -0.1332047592), 0.0, 1.0);
    c.g = clamp(1.12989086 * pow(t - 60.0, -0.0755148492), 0.0, 1.0);
    c.b = 1.0;
  }
  return os_srgbToLinear(c);
}

/**
 * Interleaved-gradient noise. Cheap, temporally stable dither — kills the
 * banding that 8-bit output gives large, smooth gradients like sky and nebula.
 */
float os_igNoise(vec2 uv) {
  return fract(52.9829189 * fract(dot(uv, vec2(0.06711056, 0.00583715))));
}

vec3 os_dither(vec3 color, vec2 fragCoord) {
  return color + (os_igNoise(fragCoord) - 0.5) / 255.0;
}

/** Uncharted-2 style filmic curve; used by PostFX for the noir grade. */
vec3 os_filmic(vec3 x) {
  const float A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}

/** ACES approximation — punchier highlights than Reinhard, keeps hue. */
vec3 os_aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
`;

/** Ray/sphere intersection and scattering phase functions. */
export const ATMOSPHERE_GLSL = /* glsl */ `
/**
 * Ray–sphere intersection centred on the origin.
 * Returns (nearT, farT); nearT > farT means no hit.
 */
vec2 os_raySphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float h = b * b - c;
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

/** Rayleigh phase — the reason the sky is blue and sunsets are red. */
float os_phaseRayleigh(float cosTheta) {
  return (3.0 / (16.0 * 3.14159265)) * (1.0 + cosTheta * cosTheta);
}

/** Henyey–Greenstein — forward-scattering haze, dust and cloud silver lining. */
float os_phaseMie(float cosTheta, float g) {
  float g2 = g * g;
  float denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(denom, 1e-4), 1.5));
}

/** Exponential atmospheric density at a given altitude. */
float os_density(float altitude, float scaleHeight) {
  return exp(-max(altitude, 0.0) / scaleHeight);
}
`;

let registered = false;

/**
 * Register the library with three.js. Idempotent — safe to call from any
 * module that needs the chunks, so no module has to depend on boot order.
 */
export function registerShaderChunks(): void {
  if (registered) return;
  registered = true;
  (ShaderChunk as Record<string, string>)['onespace_noise'] = NOISE_GLSL;
  (ShaderChunk as Record<string, string>)['onespace_color'] = COLOR_GLSL;
  (ShaderChunk as Record<string, string>)['onespace_atmosphere'] = ATMOSPHERE_GLSL;
}
