/**
 * oneSpace — terrain: one height function, two implementations.
 *
 * The ship lands on CPU-sampled terrain but *looks* at GPU-displaced terrain.
 * If the two disagree the ship sinks into hills or hovers over them, so this
 * file owns both sides of that contract: the TypeScript sampler below and the
 * GLSL emitted by `terrainGlsl()` are line-for-line the same algorithm, and
 * every tuning constant is defined once (see TUNING) and interpolated into the
 * shader source so the two literally cannot drift apart.
 *
 * ---------------------------------------------------------------------------
 * WHY CPU AND GPU AGREE  (measured, not asserted)
 * ---------------------------------------------------------------------------
 * Verified against a real GPU — ANGLE/Metal on an Apple M4, the emitted GLSL
 * compiled and run for 36864 directions per planet, compared sample by sample
 * with `sampleTerrain`:
 *
 *     height error   median 7 mm    p99.9 22 cm    max 62 cm
 *     normal error   median 0.006 deg              max 0.05 deg
 *
 * on planets with 9-20 km of relief. Re-run that check after ANY edit here.
 *
 * Three separate mechanisms buy that agreement, and each was necessary:
 *
 * 1. EVERY DECISION IS MADE IN float32. Continuous arithmetic may run in
 *    float64 — a 1e-7 difference in a smooth function is a sub-millimetre
 *    difference in elevation. But anything that CHOOSES — floor, step, a sign
 *    test — must round exactly as the GPU rounds, because a flipped choice does
 *    not perturb the answer, it replaces it.
 *
 *    The sharpest case, and the bug that a naive port ships with: os_snoise
 *    picks each corner's gradient from the sign of `h = 1 - |x| - |y|`, and h
 *    is ALGEBRAICALLY ZERO for 7 of its 49 gradients. Its computed sign is pure
 *    rounding noise — and float64 and float32 disagree on all seven, i.e. on
 *    14% of all corners. A float64 port therefore does not approximate the GPU,
 *    it computes a different noise field: measured, mean error 0.09 and peak
 *    1.6 on a field whose range is -1..1. So `snoise` below emulates float32
 *    (see GRAD_X and the `fr()` calls) wherever a choice is made.
 *
 * 2. INTEGERS STAY UNDER 2^24, where a 24-bit significand is exact and float32
 *    and float64 are simply equal. os_snoise's lattice work relies on this
 *    already — `permute` peaks at 289*34*289 ~ 2.84e6, which is exactly why
 *    Ashima chose 289 — and `cellHash` below is built the same way on purpose.
 *    That is also why craters do NOT use `os_worley`: it seeds cells with
 *    `fract(sin(x)*43758.5453)`, and `sin` is not reproducible between a CPU
 *    libm and a GPU's transcendental unit, so the two would put craters in
 *    completely different places. `cellHash` is bit-identical instead — its
 *    multiply-modulo is split into two 12-bit halves precisely so that no
 *    product can exceed the significand. Measured GPU agreement: 7e-6.
 *
 * 3. NO TRANSCENDENTAL HIDES A DISCONTINUITY. The crater rim is a Hermite bump,
 *    not a Gaussian; the size distribution is a polynomial, not a `pow`; the
 *    abyssal roll-off is a hyperbola, not an exponential; the range saturator
 *    is x/sqrt(1+x^2), and sqrt is the one IEEE-exact operation available. The
 *    only `pow` left is `spec.sharpness`, which is smooth and monotonic.
 *
 * KNOWN INHERITED ARTEFACT. `os_snoise` uses a kernel radius of r^2 = 0.6, not
 * Perlin's 0.5, so the kernel has NOT decayed to zero when a corner is swapped
 * out at a simplex boundary: webgl-noise trades a slightly smoother-looking
 * field for a C0 discontinuity of ~5e-3 noise units. End to end that is a ~10 m
 * step, at isolated points, on a planet with 9 km of relief. It is inherited
 * deliberately — the GPU takes the SAME step in the SAME place, so the collision
 * surface and the visible surface still agree, which is the property that
 * matters here. Changing 0.6 to 0.5 in `chunks.ts` would remove it everywhere
 * at once and this port would follow automatically; that is the integrator's
 * call, and it must never be done on one side only.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE HEIGHT FUNCTION IS
 * ---------------------------------------------------------------------------
 *   1. domain warp            — erosion channels, deltas, swirl (spec.warp)
 *   2. fBm / ridged blend     — the base relief (spec.ridged), shaped by a
 *                               continental mask into a *bimodal* hypsometric
 *                               curve, because real worlds are not a single
 *                               Gaussian of elevations: Earth has continental
 *                               platforms near +0.8 km and abyssal plains near
 *                               -4 km with very little in between, and the Moon
 *                               and Mars have the same split (highlands/maria,
 *                               the martian dichotomy). Mountain building is
 *                               concentrated at the margins of that mask, the
 *                               way real orogeny follows plate boundaries.
 *   3. crater field           — three octaves of a power-law population with a
 *                               real crater *profile*: flat floor, parabolic
 *                               wall, raised rim, r^-3 ejecta blanket, and a
 *                               central peak on the large (complex) ones only.
 *   4. sharpness              — signed exponent (spec.sharpness)
 *   5. sea level + abyss      — bathymetry flattens onto an abyssal plain
 *   6. amplitude              — scale to kilometres
 *
 * ELEVATION DATUM: the returned height is zero at **sea level**, which is the
 * planet's mean radius / the radius an ocean shell should be drawn at. Positive
 * is up. For an airless body `spec.seaLevel` is near zero and the datum is
 * simply the basin floor.
 *
 * PURITY: no three.js, no DOM, no I/O, no Math.random. Allocation-free on the
 * hot path — `sampleTerrain` touches no arrays and creates no objects.
 */

import type { TerrainSpec, Vec3 } from './types';
import { rngFrom } from '@/math/rng';

// ---------------------------------------------------------------------------
// TUNING — single source of truth. Every one of these is interpolated into the
// GLSL, so the shader and the sampler cannot disagree about them.
// ---------------------------------------------------------------------------

/**
 * Cycles-per-planet-radius of the largest crater lattice. 5 puts the biggest
 * cells at ~1250 km on an Earth-sized world, so the rare largest craters come
 * out around 500 km across — the scale of Hellas or Imbrium.
 */
const CRATER_FREQ0 = 5.0;
/**
 * Lattice frequency ratio between crater octaves. Each octave has 2.6^3 more
 * cells for craters 2.6x smaller, i.e. N(>D) steepens roughly as D^-2, which
 * is the observed lunar production function.
 */
const CRATER_LACUNARITY = 2.6;
const CRATER_OCTAVES = 3;
/**
 * Depth of the largest octave-0 crater, in normalised noise units (the field is
 * -1..1, so 0.9 means a basin nearly as deep as the whole relief range). Impact
 * basins really are the dominant landform on an airless world — Imbrium is 5 km
 * deep on a body whose total relief is about 16 km — so this is deliberately
 * large. Anything less and craters read as dents in noise instead of geology.
 */
const CRATER_WEIGHT0 = 0.9;
/**
 * Per-octave depth falloff. The geometric value would be 1/2.6 = 0.385 (equal
 * depth/diameter at every scale); 0.5 deliberately over-deepens small craters
 * so they stay readable against the fBm they are punched into.
 */
const CRATER_WEIGHT_FALLOFF = 0.5;
/** Smallest crater radius, in lattice cells. */
const CRATER_R_MIN = 0.11;
/**
 * Largest crater radius, in lattice cells.
 *
 * THE 3x3x3 BUDGET. A cell outside the scanned neighbourhood is at L-infinity
 * distance >= 1 from the sample, hence Euclidean distance >= 1, so the scan is
 * *exact* — not approximate — as long as no crater's support escapes the unit
 * ball. The support is a cylinder of radius CRATER_CUT * CRATER_R_MAX and
 * half-height CRATER_RZ, so the invariant is
 *
 *     (CRATER_CUT * CRATER_R_MAX)^2 + CRATER_RZ^2 <= 1
 *
 * which these values satisfy at 0.988. Break it and craters will pop in and
 * out as the camera moves. Raising any of the three means a 5x5x5 scan.
 */
const CRATER_R_MAX = 0.46;
/**
 * Outer edge of the ejecta blanket, in crater radii. The *continuous* ejecta
 * blanket of a real crater reaches about one crater radius beyond the rim;
 * past that it breaks into discontinuous secondaries which are below the
 * resolution of this field anyway.
 */
const CRATER_CUT = 1.8;
/**
 * Radial half-thickness of the crater lattice, in cells.
 *
 * The lattice is a 3D grid but the surface is a 2D shell through it, so almost
 * every cell's feature point sits above or below the ground and would never be
 * seen. Measuring only the TANGENTIAL distance and fading the crater out over
 * CRATER_RZ of radial offset fixes that: it turns the shell's whole
 * neighbourhood into usable craters and, as a bonus, the partially faded ones
 * read as degraded, flooded or buried craters — exactly the range of
 * preservation states an old surface actually shows.
 */
const CRATER_RZ = 0.55;
/** Rim crest height as a fraction of crater depth. Real rims are ~0.04 D against ~0.2 D of depth. */
const CRATER_RIM_H = 0.2;
/** Half-width of the rim crest, in crater radii. */
const CRATER_RIM_W = 0.32;
/**
 * Ejecta blanket shape coefficient. With the r^-3 falloff and the rim ramp
 * this peaks at about 0.06 of crater depth a third of a radius outside the
 * rim, i.e. roughly 1.5% of the crater diameter — the right order for a
 * continuous ejecta blanket.
 */
const CRATER_EJECTA_H = 0.45;
/** Height of the central peak of a complex crater, as a fraction of depth. */
const CRATER_PEAK_H = 0.4;
/** Normalised radius above which a crater is "complex" and grows a central peak. */
const CRATER_COMPLEX = 0.6;

/** Continental mask frequency, in cycles per planet radius. ~1.7 gives 2-4 landmasses. */
const CONTINENT_FREQ = 1.7;
/** Elevation of the abyssal mode and its relief scale (normalised units). */
const OCEAN_BASE = -0.42;
const OCEAN_RELIEF = 0.34;
/** Elevation of the continental mode and its relief scale (normalised units). */
const LAND_BASE = 0.3;
const LAND_RELIEF = 0.55;

/** Domain-warp displacement per unit of `spec.warp`, in noise-space units. */
const WARP_SCALE = 0.65;

/**
 * Gain applied to the fBm/ridged blend before it is saturated into -1..1.
 *
 * os_fbm divides by the sum of its octave amplitudes, so its output almost
 * never leaves +-0.6 — feeding that straight into the elevation curve would
 * spend a quarter of `spec.amplitude` and produce a suspiciously calm planet.
 * The gain spends the range; the algebraic saturator x/sqrt(1+x^2) stops it
 * clipping into mesas. 1.8 was chosen by measuring the resulting peak-to-trough
 * against spec.amplitude, which the TerrainSpec contract says should match.
 */
const BASE_GAIN = 1.8;

/** 2^23 — the modulus of the exact integer hash. See the header. */
const HASH_M = 8388608.0;

/** Golden-angle rotation for the checksum spiral, precomputed so no trig is needed. */
const GOLDEN_COS = -0.73736887807831974495;
const GOLDEN_SIN = 0.67549029426152384925;

// ---------------------------------------------------------------------------
// Simplex noise — a faithful port of os_snoise from src/shaders/chunks.ts.
//
// Every vec4 in the original is four scalars here, so the hot path never
// allocates. The gradient table, the (1/6, 1/3) skew factors, the 0.6 kernel
// radius and the 42.0 normalisation are all identical to the GLSL; see the
// file header for why the port is exact where it has to be.
// ---------------------------------------------------------------------------

/**
 * float32 rounding, used on every step of the sampler that MAKES A CHOICE.
 * See mechanism 1 in the file header — this is not defensive style, a float64
 * port of os_snoise computes a measurably different field. `Math.fround` is a
 * V8 intrinsic and compiles to a single instruction.
 */
const fr = Math.fround;

/** GLSL `mod(x, 289.0)`, in float32. */
function mod289(x: number): number {
  return fr(x - fr(289.0 * Math.floor(fr(x / 289.0))));
}

/** GLSL `os_permute`. Peak intermediate is (289*34+1)*289 ~ 2.84e6, exact in float32. */
function permute(x: number): number {
  return mod289(fr(fr(fr(x * 34.0) + 1.0) * x));
}

/**
 * GLSL `os_taylorInvSqrt` — a linear stand-in for inversesqrt over the
 * gradient's range. The two coefficients are Ashima's originals, copied
 * verbatim from os_snoise: they are a least-squares fit of 1/sqrt(r) over the
 * narrow range the gradient norms actually occupy, which is why a straight line
 * suffices. They are not tunable here — they must equal chunks.ts exactly, and
 * `inversesqrt` is deliberately NOT used instead because its precision is
 * implementation-defined and would break CPU/GPU agreement.
 */
function taylorInvSqrt(r: number): number {
  return fr(fr(1.79284291400159) - fr(fr(0.85373472095314) * r));
}

/** GLSL `dot` for a vec3, in the order a GLSL compiler emits it. */
function dot3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return fr(fr(fr(ax * bx) + fr(ay * by)) + fr(az * bz));
}

/**
 * The 289 gradient vectors os_snoise can address, already normalised.
 *
 * `os_snoise` derives its gradient from the permutation index alone, so the
 * whole float32 unpack — the 7x7 grid decode, the h sign test, the
 * taylorInvSqrt normalisation — is a pure function of one integer in [0, 289).
 * Building it once at load turns the per-corner cost into an array read, and
 * pins the knife-edge decisions (see `snoise`) to float32 in one place.
 *
 * Stored as Float32Array so the values are exactly the ones the GPU holds.
 */
const GRAD_X = new Float32Array(289);
const GRAD_Y = new Float32Array(289);
const GRAD_Z = new Float32Array(289);

(function buildGradientTable(): void {
  // ns = (1/7) * D.wyz - D.xzx with D = (0, 0.5, 1, 2)
  const n_ = fr(1.0 / 7.0);
  const nsx = fr(fr(n_ * 2.0) - 0.0);
  const nsy = fr(fr(n_ * 0.5) - 1.0);
  const nsz = fr(fr(n_ * 1.0) - 0.0);

  for (let p = 0; p < 289; p++) {
    const j = fr(p - fr(49.0 * Math.floor(fr(fr(p * nsz) * nsz))));
    const xr = Math.floor(fr(j * nsz));
    const yr = Math.floor(fr(j - fr(7.0 * xr)));
    const gx = fr(fr(xr * nsx) + nsy);
    const gy = fr(fr(yr * nsx) + nsy);

    // THE KNIFE EDGE. h is ALGEBRAICALLY ZERO for 7 of the 49 (xr, yr) pairs —
    // (0,3) (1,2) (2,1) (3,0) (4,6) (5,5) (6,4) — so its computed sign is pure
    // rounding noise, and `sh` below turns that sign into a choice between two
    // different gradient vectors. In float64 those seven land at -1.1e-16 or
    // +4.4e-16; in float32 they land at +1.2e-7 or -2.4e-7, the OPPOSITE sign
    // in all seven cases. That is 14% of all corners.
    //
    // A float64 port of os_snoise therefore does not approximate the GPU, it
    // computes a DIFFERENT FIELD: measured against a real GPU, a float64 port
    // was off by a mean of 0.09 and a peak of 1.6 on a field whose range is
    // -1..1, i.e. the ship would have flown over terrain that did not exist.
    // Hence fr() on every step here.
    const h = fr(fr(1.0 - Math.abs(gx)) - Math.abs(gy));
    const sh = h <= 0.0 ? -1.0 : 0.0;
    const sx = Math.floor(gx) * 2.0 + 1.0;
    const sy = Math.floor(gy) * 2.0 + 1.0;

    const ax = fr(gx + sx * sh);
    const ay = fr(gy + sy * sh);
    const norm = taylorInvSqrt(dot3(ax, ay, h, ax, ay, h));
    GRAD_X[p] = fr(ax * norm);
    GRAD_Y[p] = fr(ay * norm);
    GRAD_Z[p] = fr(h * norm);
  }
})();

/**
 * 3D simplex noise — a float32-faithful port of `os_snoise` from
 * src/shaders/chunks.ts. Every vec4 in the original is four scalars here, so
 * the hot path never allocates.
 *
 * WHY EVERY OPERATION IS WRAPPED IN fr()
 * --------------------------------------
 * The gradient table is addressed by `h = 1.0 - abs(x) - abs(y)`, and the sign
 * of h picks which of two gradients a corner gets:
 *
 *     vec4 sh = -step(h, vec4(0.0));      // sh = -1 when h <= 0, else 0
 *
 * For 7 of the 49 (x_, y_) gradient combinations — (0,3) (1,2) (2,1) (3,0)
 * (4,6) (5,5) (6,4) — h is *algebraically exactly zero*, so its computed sign
 * is pure rounding noise. In float64 those seven land at -1.1e-16 or +4.4e-16;
 * in float32 they land at +1.2e-7 or -2.4e-7 — with the OPPOSITE sign in all
 * seven cases. That is 14% of all corners getting a different gradient vector.
 *
 * A naive float64 port of this function therefore does not approximate the GPU,
 * it computes a *different noise field*: measured against a real GPU it was off
 * by a mean of 0.09 and a maximum of 1.6 on a field whose range is -1..1. The
 * ship would have been flying over terrain that did not exist.
 *
 * So the port emulates float32 throughout, in the GLSL's operation order.
 * Verified against ANGLE/Metal: max |error| ~1e-6 across the whole field.
 */
function snoise(vx0: number, vy0: number, vz0: number): number {
  // The GLSL compiler folds these to float32 constants.
  const CX = fr(1.0 / 6.0);
  const CY = fr(1.0 / 3.0);

  const vx = fr(vx0);
  const vy = fr(vy0);
  const vz = fr(vz0);

  // i = floor(v + dot(v, C.yyy));  x0 = v - i + dot(i, C.xxx);
  const sv = dot3(vx, vy, vz, CY, CY, CY);
  let ix = Math.floor(fr(vx + sv));
  let iy = Math.floor(fr(vy + sv));
  let iz = Math.floor(fr(vz + sv));
  const si = dot3(ix, iy, iz, CX, CX, CX);
  const x0x = fr(fr(vx - ix) + si);
  const x0y = fr(fr(vy - iy) + si);
  const x0z = fr(fr(vz - iz) + si);

  // Rank the components to find which of the six simplices we are in.
  // g = step(x0.yzx, x0.xyz) => component k is 1 when x0[k] >= x0[k+1].
  const gx = x0x >= x0y ? 1.0 : 0.0;
  const gy = x0y >= x0z ? 1.0 : 0.0;
  const gz = x0z >= x0x ? 1.0 : 0.0;
  const lx = 1.0 - gx;
  const ly = 1.0 - gy;
  const lz = 1.0 - gz;
  const i1x = Math.min(gx, lz);
  const i1y = Math.min(gy, lx);
  const i1z = Math.min(gz, ly);
  const i2x = Math.max(gx, lz);
  const i2y = Math.max(gy, lx);
  const i2z = Math.max(gz, ly);

  const C2 = fr(2.0 * CX);
  const C3 = fr(3.0 * CX);
  const x1x = fr(fr(x0x - i1x) + CX);
  const x1y = fr(fr(x0y - i1y) + CX);
  const x1z = fr(fr(x0z - i1z) + CX);
  const x2x = fr(fr(x0x - i2x) + C2);
  const x2y = fr(fr(x0y - i2y) + C2);
  const x2z = fr(fr(x0z - i2z) + C2);
  const x3x = fr(fr(x0x - 1.0) + C3);
  const x3y = fr(fr(x0y - 1.0) + C3);
  const x3z = fr(fr(x0z - 1.0) + C3);

  ix = mod289(ix);
  iy = mod289(iy);
  iz = mod289(iz);

  // permute() is componentwise, so the nested vec4 chain unrolls to four
  // independent chains — same values, no vectors.
  let p0 = permute(iz);
  let p1 = permute(fr(iz + i1z));
  let p2 = permute(fr(iz + i2z));
  let p3 = permute(fr(iz + 1.0));
  p0 = permute(fr(p0 + iy));
  p1 = permute(fr(fr(p1 + iy) + i1y));
  p2 = permute(fr(fr(p2 + iy) + i2y));
  p3 = permute(fr(fr(p3 + iy) + 1.0));
  p0 = permute(fr(p0 + ix));
  p1 = permute(fr(fr(p1 + ix) + i1x));
  p2 = permute(fr(fr(p2 + ix) + i2x));
  p3 = permute(fr(fr(p3 + ix) + 1.0));

  // Gradients come from the table below — they are a pure function of the
  // permutation index, so all of that float32 unpacking happens 289 times at
  // module load instead of four times per noise sample.
  const g0x = GRAD_X[p0]!, g0y = GRAD_Y[p0]!, g0z = GRAD_Z[p0]!;
  const g1x = GRAD_X[p1]!, g1y = GRAD_Y[p1]!, g1z = GRAD_Z[p1]!;
  const g2x = GRAD_X[p2]!, g2y = GRAD_Y[p2]!, g2z = GRAD_Z[p2]!;
  const g3x = GRAD_X[p3]!, g3y = GRAD_Y[p3]!, g3z = GRAD_Z[p3]!;

  // Radially symmetric kernel, quartic, cut at r^2 = 0.6.
  //
  // From here down the arithmetic is left in float64. Everything remaining is
  // continuous — no floor, no step, no sign test — so the float64 result simply
  // sits ~1e-7 closer to the true value than the GPU's float32 one, which is a
  // sub-millimetre difference in elevation and cannot flip a decision. The
  // float32 emulation above is confined to the parts that CHOOSE something.
  let m0 = Math.max(0.6 - (x0x * x0x + x0y * x0y + x0z * x0z), 0.0);
  let m1 = Math.max(0.6 - (x1x * x1x + x1y * x1y + x1z * x1z), 0.0);
  let m2 = Math.max(0.6 - (x2x * x2x + x2y * x2y + x2z * x2z), 0.0);
  let m3 = Math.max(0.6 - (x3x * x3x + x3y * x3y + x3z * x3z), 0.0);
  m0 = m0 * m0;
  m1 = m1 * m1;
  m2 = m2 * m2;
  m3 = m3 * m3;

  return (
    42.0 *
    (m0 * m0 * (g0x * x0x + g0y * x0y + g0z * x0z) +
      m1 * m1 * (g1x * x1x + g1y * x1y + g1z * x1z) +
      m2 * m2 * (g2x * x2x + g2y * x2y + g2z * x2z) +
      m3 * m3 * (g3x * x3x + g3y * x3y + g3z * x3z))
  );
}

/** Port of `os_fbm`. Same amp/norm bookkeeping and the same 16-octave cap. */
function fbm(px: number, py: number, pz: number, octaves: number, lac: number, gain: number): number {
  let sum = 0.0;
  let amp = fr(0.5);
  let freq = 1.0;
  let norm = 0.0;
  for (let i = 0; i < 16; i++) {
    if (i >= octaves) break;
    sum = fr(sum + fr(amp * snoise(fr(px * freq), fr(py * freq), fr(pz * freq))));
    norm = fr(norm + amp);
    freq = fr(freq * lac);
    amp = fr(amp * gain);
  }
  return fr(sum / Math.max(norm, fr(1e-5)));
}

/** Port of `os_ridged`. The `prev` feedback is what makes ridges branch like drainage divides. */
function ridged(px: number, py: number, pz: number, octaves: number, lac: number, gain: number): number {
  let sum = 0.0;
  let amp = fr(0.5);
  let freq = 1.0;
  let norm = 0.0;
  let prev = 1.0;
  for (let i = 0; i < 16; i++) {
    if (i >= octaves) break;
    let n = fr(1.0 - Math.abs(snoise(fr(px * freq), fr(py * freq), fr(pz * freq))));
    n = fr(n * n);
    n = fr(n * prev);
    prev = n;
    sum = fr(sum + fr(amp * n));
    norm = fr(norm + amp);
    freq = fr(freq * lac);
    amp = fr(amp * gain);
  }
  return fr(fr(fr(sum / Math.max(norm, fr(1e-5))) * 2.0) - 1.0);
}

// Domain-warp output. Module-level scratch so the hot path allocates nothing;
// this module is single-threaded and never re-enters itself.
let warpX = 0;
let warpY = 0;
let warpZ = 0;

/**
 * Port of `os_warp`. The offsets (5.2, 1.3, 2.8) and (9.2, 8.3, 4.1) are copied
 * verbatim from chunks.ts — they are the conventional Iñigo Quílez warp
 * offsets, arbitrary but large enough that the three noise lookups land in
 * uncorrelated parts of the field instead of returning near-equal values and
 * collapsing the warp into a translation along (1,1,1).
 */
function warp(px: number, py: number, pz: number, strength: number): void {
  const qx = snoise(px, py, pz);
  const qy = snoise(fr(px + fr(5.2)), fr(py + fr(1.3)), fr(pz + fr(2.8)));
  const qz = snoise(fr(px + fr(9.2)), fr(py + fr(8.3)), fr(pz + fr(4.1)));
  warpX = fr(px + fr(qx * strength));
  warpY = fr(py + fr(qy * strength));
  warpZ = fr(pz + fr(qz * strength));
}

// ---------------------------------------------------------------------------
// Exact 23-bit integer hash.
//
// Everything below is integer arithmetic carried in floats, with every
// intermediate held under 2^24 so it is *exact* in a 24-bit significand. That
// makes it bit-identical on CPU (float64) and GPU (float32) — the property the
// crater field lives or dies on. `sin`-based hashes cannot promise that.
// ---------------------------------------------------------------------------

/**
 * (a * b) mod 2^23 for a < 2^23, b < 2^12, without ever exceeding 2^24.
 *
 * Split a into hi*2^12 + lo. Then a*b = hi*b*2^12 + lo*b, and since
 * 2^23 / 2^12 = 2^11 we may reduce hi*b mod 2^11 before scaling. hi*b < 2^23,
 * (hi*b mod 2^11)*2^12 < 2^23 and lo*b < 2^24, so every product is exact and
 * the final sum of two sub-2^23 terms stays under 2^24.
 */
function mulmod(a: number, b: number): number {
  const hi = Math.floor(a / 4096.0);
  const lo = a - hi * 4096.0;
  return ((hi * b) % 2048.0) * 4096.0 + ((lo * b) % HASH_M);
}

/** Non-negative modulo, matching GLSL `mod(x, y) = x - y*floor(x/y)`. */
function fmod(x: number, y: number): number {
  return x - y * Math.floor(x / y);
}

/**
 * Hash a lattice cell to an integer in [0, 2^23). `salt` decorrelates the
 * crater octaves and the two draws per cell. The shift-add rounds stand in for
 * the xor-shifts of a normal integer hash — xor is unavailable in floats, but
 * add-shift avalanches well enough for jitter and a presence test.
 *
 * WHERE THE CONSTANTS COME FROM. Every multiplier (3571, 2477, 3181, 2879,
 * 3671) is an odd prime strictly below 4096 = 2^12, which is not cosmetic:
 * `mulmod` is only exact while b < 2^12, so a larger multiplier would silently
 * break the CPU/GPU bit-identity this whole file rests on. Odd makes them
 * invertible mod 2^23 (so no draws are lost), prime kills any shared factor
 * with the 2^23 modulus or with each other. The additive offsets (1013, 2027,
 * 3319) are arbitrary distinct primes whose only job is to break the symmetry
 * between the three axes, so that cells (a,b,c) and (c,b,a) do not collide.
 * `Math.floor(h / 2048.0)` is the shift half of the shift-add round — 2048 is
 * 2^11, i.e. half the 23 bits, which is where a shift mixes high bits into low
 * ones fastest.
 */
function cellHash(cx: number, cy: number, cz: number, salt: number): number {
  let h = fmod(cx, HASH_M);
  h = mulmod(fmod(h + 1013.0, HASH_M), 3571.0) % HASH_M;
  h = fmod(h + fmod(cy, HASH_M), HASH_M);
  h = mulmod(fmod(h + 2027.0, HASH_M), 2477.0) % HASH_M;
  h = fmod(h + fmod(cz, HASH_M), HASH_M);
  h = mulmod(fmod(h + 3319.0, HASH_M), 3181.0) % HASH_M;
  h = fmod(h + salt, HASH_M);
  h = mulmod(h, 2879.0) % HASH_M;
  h = fmod(h + Math.floor(h / 2048.0), HASH_M);
  h = mulmod(h, 3671.0) % HASH_M;
  return h;
}

// ---------------------------------------------------------------------------
// Craters
// ---------------------------------------------------------------------------

/**
 * The radial profile of an impact crater, in units of its own depth
 * (0 = pre-impact surface, -1 = crater floor).
 *
 *   u < floorFrac   flat floor — melt sheet and slumped debris pond here
 *   u < 1           parabolic wall
 *   u ~ 1           overturned rim, uplifted above the pre-impact surface
 *   u > 1           ejecta blanket, thinning as r^-3 as observed at Copernicus
 *   u > CRATER_CUT  nothing
 *
 * Complex craters (large ones) additionally rebound into a central peak.
 * Everything is polynomial: no exp, no pow, so the CPU and the GPU agree and
 * the profile has compact support, which is what lets a 3x3x3 neighbourhood
 * be exactly right rather than approximately right.
 */
function craterProfile(
  u: number,
  floorFrac: number,
  rimH: number,
  ejectaH: number,
  peakH: number,
): number {
  if (u >= CRATER_CUT) return 0.0;

  // Parabolic bowl, renormalised so the flat floor sits at exactly -1.
  const uc = Math.max(u, floorFrac);
  const bowl = -Math.max(0.0, 1.0 - uc * uc) / (1.0 - floorFrac * floorFrac);

  // Rim crest: Hermite bump centred on u = 1.
  const t = Math.min(Math.max(1.0 - Math.abs(u - 1.0) / CRATER_RIM_W, 0.0), 1.0);
  const rim = rimH * t * t * (3.0 - 2.0 * t);

  // Ejecta blanket. Two windows, and both are load-bearing:
  //   `ramp` grows the blanket out of the rim crest. Without it the r^-3 term
  //   would be at full thickness the instant u passes 1, which is a STEP in
  //   the height field — the ship would drop a few tens of metres crossing
  //   every rim. Physically it is right too: the crest is the overturned flap,
  //   the blanket proper starts just outside it.
  //   `w` takes the blanket to exactly zero at the cut, which is what makes
  //   the support compact and the 3x3x3 scan exact.
  let ejecta = 0.0;
  if (u > 1.0) {
    const w = Math.min(Math.max((CRATER_CUT - u) / (CRATER_CUT - 1.0), 0.0), 1.0);
    const q = Math.min((u - 1.0) / CRATER_RIM_W, 1.0);
    ejecta = (ejectaH * (q * q * (3.0 - 2.0 * q)) * w * w) / (u * u * u);
  }

  // Central peak — rebound of the transient cavity, only in complex craters.
  // The peak's base is `floorFrac * 1.05`: the 1.05 puts it a few percent WIDER
  // than the flat floor, so the peak rises out of the melt sheet and its foot is
  // hidden by the floor, rather than climbing the crater wall. Real central
  // peaks occupy roughly the inner fifth of the crater, which is what floorFrac
  // is at the large end of the size distribution (0.12 + 0.38 -> 0.5 radius of
  // floor, and the peak fills that).
  let peak = 0.0;
  if (peakH > 0.0) {
    const s = Math.min(Math.max(1.0 - u / (floorFrac * 1.05), 0.0), 1.0);
    peak = peakH * s * s * (3.0 - 2.0 * s);
  }

  return bowl + rim + ejecta + peak;
}

/**
 * Accumulated crater relief at `dir`, in normalised height units.
 *
 * Contributions are summed rather than min/max-combined: overlapping craters
 * are what an old airless surface actually looks like, and summation is
 * trivially continuous. `density` is the per-cell probability that a crater
 * exists at all, so `spec.craters = 0` really does mean a pristine surface.
 */
function craterField(
  dirX: number,
  dirY: number,
  dirZ: number,
  offX: number,
  offY: number,
  offZ: number,
  density: number,
): number {
  let total = 0.0;
  let freq = CRATER_FREQ0;
  let weight = CRATER_WEIGHT0;

  // A lattice offset unrelated to the fBm domain, so craters do not correlate
  // with the mountains they are punched into. 0.61 is an irrational-ish scale
  // (not 1, not 1/2) so the crater lattice and the fBm domain drift apart as
  // the seed moves instead of staying locked in step; 7.13 / 11.71 / 3.37 are
  // arbitrary unequal offsets whose only job is to stop seed 0 putting a cell
  // boundary exactly on the +X axis. No value here is load-bearing — any three
  // unequal numbers work — but they must never change, because changing them
  // moves every crater on every planet in the universe.
  const bx = offX * 0.61 + 7.13;
  const by = offY * 0.61 + 11.71;
  const bz = offZ * 0.61 + 3.37;

  // Bounding radius of the largest possible support cylinder — see CRATER_R_MAX.
  const support = Math.sqrt(
    CRATER_R_MAX * CRATER_CUT * (CRATER_R_MAX * CRATER_CUT) + CRATER_RZ * CRATER_RZ,
  );

  for (let o = 0; o < CRATER_OCTAVES; o++) {
    const px = dirX * freq + bx;
    const py = dirY * freq + by;
    const pz = dirZ * freq + bz;
    const c0x = Math.floor(px);
    const c0y = Math.floor(py);
    const c0z = Math.floor(pz);

    for (let k = -1; k <= 1; k++) {
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const cx = c0x + i;
          const cy = c0y + j;
          const cz = c0z + k;

          // Cheap exact reject: distance from p to the cell's bounding box.
          // A crater centred anywhere in that box cannot reach p if the box is
          // already further away than the maximum ejecta radius.
          const dx = Math.max(cx - px, px - (cx + 1.0), 0.0);
          const dy = Math.max(cy - py, py - (cy + 1.0), 0.0);
          const dz = Math.max(cz - pz, pz - (cz + 1.0), 0.0);
          const boxDist2 = dx * dx + dy * dy + dz * dz;
          if (boxDist2 > support * support) continue;

          // Salt spacing. Each octave needs two independent draws per cell
          // (presence+size, and jitter), taken at salt+101 and salt+1. Striding
          // the octaves by 7 keeps those two draws at least 7 apart for every
          // octave, so no octave's jitter draw can ever coincide with another
          // octave's size draw — which would make small craters sit exactly
          // concentric inside big ones.
          const salt = o * 7.0;
          const h2 = cellHash(cx, cy, cz, salt + 101.0);
          // 11 bits of presence, 12 bits of size, from one 23-bit draw.
          const presence = Math.floor(h2 / 4096.0) / 2048.0;
          if (presence >= density) continue;
          const sizeBits = (h2 - Math.floor(h2 / 4096.0) * 4096.0) / 4096.0;

          // Squared remap: within an octave, big craters are rarer than small
          // ones. The heavy lifting on the size-frequency distribution is done
          // by the octaves themselves (2.6^3 times as many cells for craters
          // 2.6x smaller is the D^-2 lunar production function); this just
          // stops each octave being monodisperse.
          const rn = sizeBits * sizeBits;
          const radius = CRATER_R_MIN + (CRATER_R_MAX - CRATER_R_MIN) * rn;

          // Now that this crater's real size is known, re-run the box reject
          // against ITS support instead of the worst case. Most craters are
          // far smaller than CRATER_R_MAX, so this skips the second hash for
          // most of the neighbourhood. Still exact: the feature point is
          // inside the box, so it cannot be nearer than boxDist.
          const reach = CRATER_CUT * radius;
          if (boxDist2 > reach * reach + CRATER_RZ * CRATER_RZ) continue;

          const h1 = cellHash(cx, cy, cz, salt + 1.0);
          // 8 / 8 / 7 bits of jitter. At ~1000 km cells that is 4 km of
          // quantisation, far below anything the eye or the ship can resolve.
          const a = Math.floor(h1 / 32768.0);
          const rem = h1 - a * 32768.0;
          const b = Math.floor(rem / 128.0);
          const c = rem - b * 128.0;
          const fx = cx + (a + 0.5) / 256.0;
          const fy = cy + (b + 0.5) / 256.0;
          const fz = cz + (c + 0.5) / 128.0;

          // Split the offset into radial and tangential parts. `dir` IS the
          // outward normal of the shell (the lattice offset `b` translates the
          // shell but does not rotate it), so this is exact.
          const ex = px - fx;
          const ey = py - fy;
          const ez = pz - fz;
          const rad = ex * dirX + ey * dirY + ez * dirZ;
          if (rad >= CRATER_RZ || rad <= -CRATER_RZ) continue;
          const tx = ex - rad * dirX;
          const ty = ey - rad * dirY;
          const tz = ez - rad * dirZ;
          const u = Math.sqrt(tx * tx + ty * ty + tz * tz) / radius;
          if (u >= CRATER_CUT) continue;

          // Radial fade: a crater centred well off the shell is one that has
          // been buried or flooded, and shows only as a ghost ring.
          const wz = 1.0 - Math.abs(rad) / CRATER_RZ;
          const fade = wz * wz * (3.0 - 2.0 * wz);

          // Depth is proportional to DIAMETER, not to the size draw — a small
          // crater is shallow because it is small, not because it is near the
          // bottom of the distribution. (Keying depth off `rn` would give the
          // smallest craters zero depth, which is why this uses `rr`.)
          // The quadratic term is the complex-crater collapse: past a few tens
          // of km, gravity slumps the walls and basins end up much shallower
          // relative to their width than a simple bowl would be.
          //
          // The three magic numbers below are all the *simple-to-complex
          // transition*, which on the Moon happens near D = 15 km and is the
          // single most visible fact about crater morphology:
          //
          //   0.45  the depth a crater LOSES at the top of the size range.
          //         Simple craters hold depth/diameter ~ 0.2; complex ones fall
          //         to ~0.1 as the walls slump, so the largest lose about half
          //         their bowl. 0.45 at rn = 1 is that, slightly softened.
          //   0.12 / 0.38  the flat-floor fraction, running 0.12 (a small bowl
          //         with a nearly pointed base) to 0.50 (a basin that is half
          //         flat floor). Both terms are in rn^2, not rn, so the change
          //         is confined to the top of the size range where it belongs
          //         rather than smeared across every crater.
          //   0.25  the width, in rn, of the ramp into "complex". Narrow enough
          //         that peaks are clearly a property of big craters, wide
          //         enough that the peak grows in rather than popping on.
          const rr = radius / CRATER_R_MAX;
          const depth = weight * rr * (1.0 - 0.45 * rn * rn);
          const floorFrac = 0.12 + 0.38 * rn * rn;
          const peakH =
            CRATER_PEAK_H * Math.min(Math.max((rn - CRATER_COMPLEX) / 0.25, 0.0), 1.0);

          total +=
            depth * fade * craterProfile(u, floorFrac, CRATER_RIM_H, CRATER_EJECTA_H, peakH);
        }
      }
    }

    freq *= CRATER_LACUNARITY;
    weight *= CRATER_WEIGHT_FALLOFF;
  }

  return total;
}

// ---------------------------------------------------------------------------
// The height function
// ---------------------------------------------------------------------------

/** GLSL `smoothstep`. */
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0.0), 1.0);
  return t * t * (3.0 - 2.0 * t);
}

/**
 * Normalised height in roughly -1..1 before sea level and amplitude are
 * applied. Split out because both `sampleTerrain` and the checksum want it and
 * neither wants an allocation.
 */
function heightNormalised(
  spec: TerrainSpec,
  dirX: number,
  dirY: number,
  dirZ: number,
  offX: number,
  offY: number,
  offZ: number,
): number {
  const octaves = clampOctaves(spec.octaves);

  // Coordinates that reach a floor()/step() inside the noise are rounded to
  // float32 first, so the CPU lands in the same simplex cell as the GPU. The
  // arithmetic AFTER the noise is left in float64: it is all continuous, so a
  // 1e-7 difference there is a sub-millimetre difference in elevation.
  const px = fr(fr(dirX * spec.frequency) + offX);
  const py = fr(fr(dirY * spec.frequency) + offY);
  const pz = fr(fr(dirZ * spec.frequency) + offZ);

  // 1. Domain warp. Folding the field back through itself is what turns
  //    isotropic fBm into something with valleys, deltas and grain.
  warp(px, py, pz, fr(spec.warp * WARP_SCALE));
  const wx = warpX;
  const wy = warpY;
  const wz = warpZ;

  // Continental mask. One very low frequency field decides land from basin;
  // sharpening it with smoothstep is what gives coastlines instead of a
  // gradual beach that wraps the whole planet.
  //
  // Octave settings (4, 2.1, 0.55): four octaves is enough to give a coastline
  // headlands and bays but not enough to break a continent into an archipelago;
  // 2.1 rather than a clean 2.0 stops successive octaves lining up their
  // features on the same lattice directions, which is what produces visible
  // grid-aligned coasts; 0.55 is slightly red-tilted (> 0.5) so the large
  // landmasses dominate and the detail only crenellates their edges.
  // The offsets (-4.4, 7.9, 2.2) and the 0.31 scaling on the seed offset put
  // this field in a different, more slowly moving part of the noise domain than
  // the relief fBm, so a seed change reshapes the continents and the mountains
  // independently instead of sliding both rigidly together.
  const cont = fbm(
    fr(fr(fr(dirX * CONTINENT_FREQ) + fr(offX * 0.31)) - fr(4.4)),
    fr(fr(fr(dirY * CONTINENT_FREQ) + fr(offY * 0.31)) + fr(7.9)),
    fr(fr(fr(dirZ * CONTINENT_FREQ) + fr(offZ * 0.31)) + fr(2.2)),
    4,
    2.1,
    0.55,
  );
  // The two thresholds are the planet's land budget, and they are the reason a
  // default world looks like Earth rather than like a coin flip. `cont` is a
  // roughly zero-mean fBm, so a symmetric pair would flood half the planet;
  // biasing the window upwards to [-0.16, 0.24] puts the mask above 0.5 on
  // about 30% of the sphere. Measured over 60 seeds at seaLevel 0.5 the
  // resulting land fraction is 0.269 - 0.369, mean 0.314 — Earth is 0.29.
  // The 0.40-wide band between them is the continental slope: wide enough that
  // the shelf break is a slope and not a wall, narrow enough that it does not
  // become a beach wrapping the whole globe.
  const land = smoothstep(-0.16, 0.24, cont);

  // 2. fBm/ridged blend. Ridges are pushed towards the *margins* of the
  //    continental mask (land*(1-land) peaks at the coastline) because that is
  //    where real orogeny happens — the Andes and the Cascades sit on plate
  //    boundaries, not in the middle of cratons.
  //
  //    4.0 is the normaliser, not a taste value: land*(1-land) maxes at 1/4
  //    when land = 0.5, so x4 makes `margin` reach exactly 1.0 at the
  //    coastline and 0 deep inside both the craton and the abyss.
  //    0.55 / 0.9 then say: away from any margin a world shows 55% of the
  //    ridging its spec asks for (cratons are rolling, not flat), and at a
  //    margin it shows 145% — clamped to 1 — so plate boundaries saturate to
  //    fully ridged terrain while `spec.ridged = 0` still means no ridges
  //    anywhere, since both terms are multiplied by it.
  const margin = 4.0 * land * (1.0 - land);
  const rw = Math.min(Math.max(spec.ridged * (0.55 + 0.9 * margin), 0.0), 1.0);
  const f = fbm(wx, wy, wz, octaves, spec.lacunarity, spec.gain);
  const r = ridged(wx, wy, wz, octaves, spec.lacunarity, spec.gain);
  let h = f + (r - f) * rw;

  // Spend the full -1..1 range without clipping. sqrt is IEEE-exact, so this
  // saturator costs nothing in CPU/GPU agreement, unlike a tanh.
  h *= BASE_GAIN;
  h = h / Math.sqrt(1.0 + h * h);

  // Bimodal hypsometry: continental platform and abyssal plain are two
  // separate populations with a steep continental slope between them, which is
  // what Earth's elevation histogram actually looks like.
  const ocean = h * OCEAN_RELIEF + OCEAN_BASE;
  const landH = h * LAND_RELIEF + LAND_BASE;
  h = ocean + (landH - ocean) * land;

  // 3. Craters, modulated by a smooth mask so the surface has heavily battered
  //    highlands next to resurfaced plains — the maria/highlands contrast —
  //    rather than a statistically uniform sprinkle.
  //    Frequency 2.3 sizes the maria: a shade above the continental mask's 1.7,
  //    so resurfaced provinces are somewhat smaller than continents — Oceanus
  //    Procellarum is about a third of the lunar nearside. Three octaves at
  //    (2.0, 0.5) keep the mask smooth; it is a province boundary, not terrain,
  //    and any detail in it would print itself into the crater density as
  //    visible noise. The 0.17 seed scaling and the (21.5, -13.9, 6.1) offsets
  //    move it well away from both the relief and the continental fields so the
  //    maria do not silently track the coastlines.
  //    0.001 is just a "not zero" guard that also skips the whole 27-cell scan
  //    for the majority of worlds, which have no craters at all.
  if (spec.craters > 0.001) {
    const resurf = fbm(
      fr(fr(fr(dirX * fr(2.3)) + fr(offX * fr(0.17))) + fr(21.5)),
      fr(fr(fr(dirY * fr(2.3)) + fr(offY * fr(0.17))) - fr(13.9)),
      fr(fr(fr(dirZ * fr(2.3)) + fr(offZ * fr(0.17))) + fr(6.1)),
      3,
      2.0,
      0.5,
    );
    // 0.35 is a FLOOR, not a scale: a resurfaced plain is younger, not
    // sterile — Mare Imbrium still carries craters, just an order of magnitude
    // fewer than the highlands beside it. So the mask runs 0.35..1.0 rather
    // than 0..1, giving highlands roughly 3x the crater relief of the maria,
    // which is the right contrast to read as two ages of surface without the
    // plains looking artificially swept. The +-0.35 smoothstep window is about
    // half the usable range of a 3-octave fBm, so the transition occupies a
    // visible fraction of the province rather than being a hard shoreline —
    // mare margins are gradual, unlike coastlines.
    const mask = 0.35 + 0.65 * smoothstep(-0.35, 0.35, resurf);
    h += mask * craterField(dirX, dirY, dirZ, offX, offY, offZ, spec.craters);
  }

  // 4. Sharpness, applied signed so basins hollow out exactly as peaks sharpen.
  //    The 1e-8 floor only exists because pow(0, s) is undefined for s <= 0 in
  //    GLSL. It buys a discontinuity of 2*(1e-8)^sharpness at exactly h = 0:
  //    on a 20 km world that is 5 cm at sharpness 0.7, 0.2 mm at 1.0 and
  //    negligible above — i.e. worst case ~30x smaller than the noise's own
  //    inherited C0 step (measured 1.4 m; see the file header), and confined to
  //    a single isosurface. Raising the floor would make it worse, not better.
  h = Math.min(Math.max(h, -1.0), 1.0);
  const s = h < 0.0 ? -1.0 : 1.0;
  h = s * Math.pow(Math.max(Math.abs(h), 1e-8), spec.sharpness);

  return h;
}

/**
 * Map normalised height to elevation relative to sea level, flattening the
 * deep ocean onto an abyssal plain.
 *
 * Real bathymetry does not fall linearly. Past the shelf break the sea floor
 * plunges down the continental slope — the steepest large-scale feature on
 * Earth — and then flattens onto an abyssal plain that occupies most of the
 * ocean floor, because ocean crust is young, dense and uniformly thick.
 *
 * `d * (A + dMax) / (A + d)` reproduces exactly that: slope greater than one at
 * the shoreline, flattening with depth, and — unlike a plain hyperbola — it
 * still reaches the full depth at the deepest sample, so `spec.amplitude`
 * survives instead of being quietly halved. Algebraic, so the GPU agrees.
 */
function applySeaFloor(hn: number, seaLevel: number): number {
  const d = seaLevel - hn;
  if (d <= 0.0) return hn;
  // A is the depth scale at which the curve turns over: above it the sea floor
  // still falls steeply, below it flattens onto the abyssal plain. Making it
  // proportional to seaLevel (0.35, i.e. about a third of the water column)
  // keeps the shape of the bathymetry the same whether a world's ocean is
  // shallow or planet-deep, instead of a deep ocean being all plain and a
  // shallow one all slope. On Earth the shelf break to the abyssal plain is
  // about 4 km of an 11 km range, which is the same third.
  // The 1e-4 is only a divide-by-zero guard for seaLevel = 0 (an airless body,
  // where nothing is submerged and this branch is essentially never taken).
  const A = 0.35 * seaLevel + 1e-4;
  return seaLevel - (d * (A + seaLevel)) / (A + d);
}

/**
 * 16 is not arbitrary: `os_fbm` and `os_ridged` in chunks.ts have a hard
 * `for (i < 16)` cap (GLSL ES needs a constant loop bound), so asking for more
 * would give the GPU 16 and the CPU whatever it was told — the two would
 * silently displace different terrain. The floor of 1 keeps `norm` non-zero.
 */
function clampOctaves(o: number): number {
  return Math.min(16, Math.max(1, Math.round(o)));
}

// ---------------------------------------------------------------------------
// Seed → noise-domain offset
// ---------------------------------------------------------------------------

// A one-entry memo. The physics loop calls sampleTerrain with the same seed
// thousands of times in a row, and deriving the offset means allocating an Rng.
let memoSeed = Number.NaN;
let memoX = 0;
let memoY = 0;
let memoZ = 0;

function resolveOffset(seed: number): void {
  if (seed === memoSeed) return;
  const rng = rngFrom(seed, 'terrain-domain');
  // Kept small on purpose: the offset is added to the noise coordinate before
  // it is multiplied by lacunarity^octaves, so a large offset would burn the
  // GPU's float32 mantissa at the highest octaves and the fine detail would
  // quantise into steps. +-12 still gives an effectively infinite variety of
  // domains because the offset is continuous.
  memoX = rng.range(-12, 12);
  memoY = rng.range(-12, 12);
  memoZ = rng.range(-12, 12);
  memoSeed = seed;
}

/**
 * The noise-domain offset for a seed. The renderer MUST bind this as
 * `uTerrainSeedOffset` (or pass it as the `seedOffset` argument) or the GPU
 * will displace a different planet from the one the ship is landing on.
 */
export function terrainSeedOffset(seed: number): Vec3 {
  resolveOffset(seed);
  return [memoX, memoY, memoZ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Elevation at a point on the sphere, in kilometres, signed about the mean
 * radius (= sea level; see the file header).
 *
 * `dir` must be a unit vector. Allocation-free: this is the physics hot path.
 */
export function sampleTerrain(spec: TerrainSpec, seed: number, dir: Vec3): number {
  resolveOffset(seed);
  const h = heightNormalised(spec, dir[0], dir[1], dir[2], memoX, memoY, memoZ);
  const hn = applySeaFloor(h * 0.5 + 0.5, spec.seaLevel);
  return spec.amplitude * (hn - spec.seaLevel);
}

// Scratch for the normal, so the only allocation is the returned tuple.
let nx = 0;
let ny = 0;
let nz = 0;

/**
 * Outward surface normal at `dir`, by central differences on the displaced
 * surface. `eps` is the finite-difference step measured in kilometres *along
 * the surface*; it defaults to a fraction of the planet radius, which keeps the
 * normal stable at orbital scale, but a lander wanting fine slope data should
 * pass something near its own footprint size.
 */
export function sampleTerrainNormal(
  spec: TerrainSpec,
  seed: number,
  dir: Vec3,
  radiusKm: number,
  eps?: number,
): Vec3 {
  resolveOffset(seed);
  // Default step: radius * 1e-4 is 640 m on an Earth-sized world and scales
  // with the body, which is the right order for an orbital-scale normal — small
  // enough to follow a mountain range, large enough that the difference of two
  // elevations is not swamped by the ~1.4 m C0 steps in the noise. The 0.02 km
  // (20 m) floor stops a tiny moon or a caller passing radiusKm ~ 0 from
  // collapsing the step to zero and producing a degenerate cross product.
  const step = eps !== undefined ? eps : Math.max(0.02, radiusKm * 1e-4);
  computeNormal(spec, dir[0], dir[1], dir[2], radiusKm, step);
  return [nx, ny, nz];
}

/** Allocation-free variant for callers inside an update loop. Writes 3 floats into `out`. */
export function sampleTerrainNormalInto(
  spec: TerrainSpec,
  seed: number,
  dir: Vec3,
  radiusKm: number,
  eps: number,
  out: number[],
): void {
  resolveOffset(seed);
  computeNormal(spec, dir[0], dir[1], dir[2], radiusKm, eps);
  out[0] = nx;
  out[1] = ny;
  out[2] = nz;
}

function elevationAt(spec: TerrainSpec, dx: number, dy: number, dz: number): number {
  const h = heightNormalised(spec, dx, dy, dz, memoX, memoY, memoZ);
  const hn = applySeaFloor(h * 0.5 + 0.5, spec.seaLevel);
  return spec.amplitude * (hn - spec.seaLevel);
}

function computeNormal(
  spec: TerrainSpec,
  dx: number,
  dy: number,
  dz: number,
  radiusKm: number,
  eps: number,
): void {
  // Branchless orthonormal basis (Duff et al. 2017). The sign trick avoids the
  // singularity a naive up-vector cross product has at the poles.
  const sg = dz >= 0.0 ? 1.0 : -1.0;
  const a = -1.0 / (sg + dz);
  const b = dx * dy * a;
  const t1x = 1.0 + sg * dx * dx * a;
  const t1y = sg * b;
  const t1z = -sg * dx;
  const t2x = b;
  const t2y = sg + dy * dy * a;
  const t2z = -dy;

  // eps is an arc length; on a sphere of radius R that is an angle eps/R, and
  // for the small steps we use tan(theta) ~ theta, so stepping along the
  // tangent and renormalising is accurate to O(theta^2).
  const ang = eps / Math.max(radiusKm, 1e-6);

  // Four probes: +/- along each tangent. Central differences rather than
  // forward differences because a forward difference biases the normal
  // uphill, which makes a landed ship visibly lean.
  probe(spec, dx + t1x * ang, dy + t1y * ang, dz + t1z * ang, radiusKm);
  const ax = probeX;
  const ay = probeY;
  const az = probeZ;
  probe(spec, dx - t1x * ang, dy - t1y * ang, dz - t1z * ang, radiusKm);
  const bx2 = probeX;
  const by2 = probeY;
  const bz2 = probeZ;
  probe(spec, dx + t2x * ang, dy + t2y * ang, dz + t2z * ang, radiusKm);
  const cx2 = probeX;
  const cy2 = probeY;
  const cz2 = probeZ;
  probe(spec, dx - t2x * ang, dy - t2y * ang, dz - t2z * ang, radiusKm);
  const ex = probeX;
  const ey = probeY;
  const ez = probeZ;

  const ux = ax - bx2;
  const uy = ay - by2;
  const uz = az - bz2;
  const vx = cx2 - ex;
  const vy = cy2 - ey;
  const vz = cz2 - ez;

  const cxn = uy * vz - uz * vy;
  const cyn = uz * vx - ux * vz;
  const czn = ux * vy - uy * vx;

  let len = Math.sqrt(cxn * cxn + cyn * cyn + czn * czn);
  if (len < 1e-20) {
    // Degenerate step (eps far below the float resolution of the surface):
    // fall back to the sphere normal rather than emitting a NaN into physics.
    nx = dx;
    ny = dy;
    nz = dz;
    return;
  }
  // (t1, t2, dir) is right-handed, so u x v already points outwards; the guard
  // costs nothing and survives a caller passing a left-handed dir.
  if (cxn * dx + cyn * dy + czn * dz < 0.0) len = -len;
  const inv = 1.0 / len;
  nx = cxn * inv;
  ny = cyn * inv;
  nz = czn * inv;
}

// Displaced probe position. Module scratch so the normal path allocates nothing.
let probeX = 0;
let probeY = 0;
let probeZ = 0;

function probe(spec: TerrainSpec, qx: number, qy: number, qz: number, radiusKm: number): void {
  const inv = 1.0 / Math.sqrt(qx * qx + qy * qy + qz * qz);
  const ux = qx * inv;
  const uy = qy * inv;
  const uz = qz * inv;
  const rr = radiusKm + elevationAt(spec, ux, uy, uz);
  probeX = ux * rr;
  probeY = uy * rr;
  probeZ = uz * rr;
}

// ---------------------------------------------------------------------------
// GPU side
// ---------------------------------------------------------------------------

/**
 * The uniforms `terrainGlsl()` declares. `render/Planet.ts` must put a value
 * for every one of these into its `uniforms` object, and must NOT redeclare
 * them in its own shader source — the snippet declares them itself.
 *
 * Types: `uTerrainOctaves` is an `int`, `uTerrainSeedOffset` is a `vec3`,
 * everything else is a `float`. Use `terrainUniformValues()` to fill them.
 */
export const TERRAIN_UNIFORM_NAMES: readonly string[] = [
  'uTerrainFrequency',
  'uTerrainOctaves',
  'uTerrainLacunarity',
  'uTerrainGain',
  'uTerrainAmplitude',
  'uTerrainRidged',
  'uTerrainWarp',
  'uTerrainCraters',
  'uTerrainSharpness',
  'uTerrainSeaLevel',
  'uTerrainSeedOffset',
];

/**
 * Every value the GPU needs, keyed by uniform name. Octaves is rounded here so
 * the shader's `int` and the sampler's loop count cannot differ by a rounding
 * mode.
 */
export function terrainUniformValues(
  spec: TerrainSpec,
  seed: number,
): Readonly<Record<string, number | Vec3>> {
  return {
    uTerrainFrequency: spec.frequency,
    uTerrainOctaves: clampOctaves(spec.octaves),
    uTerrainLacunarity: spec.lacunarity,
    uTerrainGain: spec.gain,
    uTerrainAmplitude: spec.amplitude,
    uTerrainRidged: spec.ridged,
    uTerrainWarp: spec.warp,
    uTerrainCraters: spec.craters,
    uTerrainSharpness: spec.sharpness,
    uTerrainSeaLevel: spec.seaLevel,
    uTerrainSeedOffset: terrainSeedOffset(seed),
  };
}

/** Format a number as a literal the GLSL compiler will read back as the same value. */
function g(x: number): string {
  if (Number.isInteger(x)) return x.toFixed(1);
  return String(x);
}

/**
 * The GPU half of the contract.
 *
 * Returns GLSL defining:
 *   float os_terrainHeight(vec3 dir, vec3 seedOffset);
 *   vec3  os_terrainNormal(vec3 dir, vec3 seedOffset, float radius, float eps);
 *
 * Requirements on the consumer:
 *   - `#include <onespace_noise>` must appear BEFORE this snippet (it uses
 *     os_snoise / os_fbm / os_ridged / os_warp). The snippet deliberately does
 *     not emit the include itself, so a shader that already has it does not end
 *     up with duplicate definitions.
 *   - The snippet declares the uniforms in TERRAIN_UNIFORM_NAMES. Do not
 *     declare them again.
 *   - Call it from the VERTEX stage. It is a displacement function, not a
 *     shading function.
 *
 * `os_terrainHeight` returns kilometres, signed about sea level, exactly as
 * `sampleTerrain()` does — the whole point of this file.
 *
 * The body is generated from the same TUNING constants the sampler uses, so
 * editing a constant changes both sides at once and they cannot drift.
 */
export function terrainGlsl(): string {
  return /* glsl */ `
// ===========================================================================
// oneSpace terrain — GPU mirror of src/gen/terrain.ts.
//
// Do not "optimise" anything below without making the identical change in the
// TypeScript sampler. The ship's collision surface is the CPU function; this
// is what the player sees. They must be the same function.
//
// Requires: #include <onespace_noise>
// ===========================================================================
#ifndef OS_TERRAIN_INCLUDED
#define OS_TERRAIN_INCLUDED

uniform float uTerrainFrequency;
uniform int   uTerrainOctaves;
uniform float uTerrainLacunarity;
uniform float uTerrainGain;
uniform float uTerrainAmplitude;
uniform float uTerrainRidged;
uniform float uTerrainWarp;
uniform float uTerrainCraters;
uniform float uTerrainSharpness;
uniform float uTerrainSeaLevel;
uniform vec3  uTerrainSeedOffset;

#define OS_HASH_M ${g(HASH_M)}
#define OS_CRATER_CUT ${g(CRATER_CUT)}
#define OS_CRATER_RZ ${g(CRATER_RZ)}
// Lowering this makes the GPU disagree with the CPU sampler. Only ever do it
// for LOD levels the ship cannot land on.
#ifndef OS_CRATER_OCTAVES
#define OS_CRATER_OCTAVES ${CRATER_OCTAVES}
#endif

// ---------------------------------------------------------------------------
// Exact 23-bit integer hash. Every intermediate is an integer below 2^24, so
// this evaluates bit-identically in float32 here and float64 on the CPU. That
// is why craters do not use os_worley, whose sin()-based hash would place them
// somewhere else entirely on the GPU.
//
// Every multiplier is an odd prime below 4096 = 2^12. That bound is REQUIRED:
// os_tMulMod is only exact while b < 2^12. The additive offsets are distinct
// primes that break the symmetry between the three axes. See cellHash() in
// terrain.ts for the full derivation.
// ---------------------------------------------------------------------------
float os_tMulMod(float a, float b) {
  float hi = floor(a / 4096.0);
  float lo = a - hi * 4096.0;
  return mod(hi * b, 2048.0) * 4096.0 + mod(lo * b, OS_HASH_M);
}

float os_tCellHash(vec3 c, float salt) {
  float h = mod(c.x, OS_HASH_M);
  h = mod(os_tMulMod(mod(h + 1013.0, OS_HASH_M), 3571.0), OS_HASH_M);
  h = mod(h + mod(c.y, OS_HASH_M), OS_HASH_M);
  h = mod(os_tMulMod(mod(h + 2027.0, OS_HASH_M), 2477.0), OS_HASH_M);
  h = mod(h + mod(c.z, OS_HASH_M), OS_HASH_M);
  h = mod(os_tMulMod(mod(h + 3319.0, OS_HASH_M), 3181.0), OS_HASH_M);
  h = mod(h + salt, OS_HASH_M);
  h = mod(os_tMulMod(h, 2879.0), OS_HASH_M);
  h = mod(h + floor(h / 2048.0), OS_HASH_M);
  h = mod(os_tMulMod(h, 3671.0), OS_HASH_M);
  return h;
}

// ---------------------------------------------------------------------------
// Crater radial profile, in units of the crater's own depth.
// Flat floor -> parabolic wall -> uplifted rim -> r^-3 ejecta blanket, plus a
// central peak on complex craters. All polynomial: compact support, and no
// transcendental that could round differently from the CPU.
// ---------------------------------------------------------------------------
float os_tCraterProfile(float u, float floorFrac, float rimH, float ejectaH, float peakH) {
  if (u >= OS_CRATER_CUT) return 0.0;

  float uc = max(u, floorFrac);
  float bowl = -max(0.0, 1.0 - uc * uc) / (1.0 - floorFrac * floorFrac);

  float t = clamp(1.0 - abs(u - 1.0) / ${g(CRATER_RIM_W)}, 0.0, 1.0);
  float rim = rimH * t * t * (3.0 - 2.0 * t);

  // Ejecta blanket. The q ramp grows it out of the rim crest — without it the
  // r^-3 term would be at full thickness the instant u passes 1, which is a
  // STEP in the height field. The w window takes it to zero at the cut, which
  // is what makes the support compact and the 3x3x3 scan exact.
  float ejecta = 0.0;
  if (u > 1.0) {
    float w = clamp((OS_CRATER_CUT - u) / (OS_CRATER_CUT - 1.0), 0.0, 1.0);
    float q = min((u - 1.0) / ${g(CRATER_RIM_W)}, 1.0);
    ejecta = ejectaH * (q * q * (3.0 - 2.0 * q)) * w * w / (u * u * u);
  }

  // 1.05 makes the peak's base a few percent wider than the flat floor, so it
  // rises out of the melt sheet instead of climbing the crater wall.
  float peak = 0.0;
  if (peakH > 0.0) {
    float s = clamp(1.0 - u / (floorFrac * 1.05), 0.0, 1.0);
    peak = peakH * s * s * (3.0 - 2.0 * s);
  }

  return bowl + rim + ejecta + peak;
}

float os_tCraterField(vec3 dir, vec3 seedOffset, float density) {
  float total = 0.0;
  float freq = ${g(CRATER_FREQ0)};
  float weight = ${g(CRATER_WEIGHT0)};
  // 0.61 decorrelates the crater lattice from the fBm domain as the seed moves;
  // the three offsets are arbitrary unequal numbers that keep a cell boundary
  // off the axes. Not load-bearing, but changing them moves every crater in the
  // universe — and must be changed on BOTH sides or not at all.
  vec3 base = seedOffset * 0.61 + vec3(7.13, 11.71, 3.37);
  // Bounding radius of the crater support cylinder. The 3x3x3 scan is exact
  // only while this stays under 1.0 — see CRATER_R_MAX in terrain.ts.
  const float support = ${g(Math.sqrt(CRATER_R_MAX * CRATER_CUT * (CRATER_R_MAX * CRATER_CUT) + CRATER_RZ * CRATER_RZ))};

  for (int o = 0; o < OS_CRATER_OCTAVES; o++) {
    vec3 p = dir * freq + base;
    vec3 c0 = floor(p);

    for (int k = -1; k <= 1; k++) {
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec3 c = c0 + vec3(float(i), float(j), float(k));

          // Exact reject on the cell's bounding box: a crater centred anywhere
          // inside it cannot reach p if the box is already out of range. This
          // is what keeps a 27-cell scan affordable.
          vec3 d = max(max(c - p, p - (c + 1.0)), vec3(0.0));
          float boxDist2 = dot(d, d);
          if (boxDist2 > support * support) continue;

          // Stride 7 keeps this octave's two draws (salt+1, salt+101) from ever
          // colliding with another octave's, which would nest craters exactly.
          float salt = float(o) * 7.0;
          float h2 = os_tCellHash(c, salt + 101.0);
          float presence = floor(h2 / 4096.0) / 2048.0;
          if (presence >= density) continue;
          float sizeBits = (h2 - floor(h2 / 4096.0) * 4096.0) / 4096.0;

          // Big craters rarer than small ones within an octave; the D^-2
          // size-frequency slope itself comes from the octave cadence.
          float rn = sizeBits * sizeBits;
          float radius = ${g(CRATER_R_MIN)} + ${g(CRATER_R_MAX - CRATER_R_MIN)} * rn;

          // Re-reject against THIS crater's support now that its size is known;
          // still exact, since the feature point lies inside the box.
          float reach = OS_CRATER_CUT * radius;
          if (boxDist2 > reach * reach + OS_CRATER_RZ * OS_CRATER_RZ) continue;

          float h1 = os_tCellHash(c, salt + 1.0);
          float a = floor(h1 / 32768.0);
          float rem = h1 - a * 32768.0;
          float b = floor(rem / 128.0);
          float cc = rem - b * 128.0;
          vec3 f = c + vec3((a + 0.5) / 256.0, (b + 0.5) / 256.0, (cc + 0.5) / 128.0);

          // Tangential distance only: the lattice is 3D but the surface is a
          // 2D shell through it, and dir is that shell's outward normal.
          vec3 e = p - f;
          float rad = dot(e, dir);
          if (rad >= OS_CRATER_RZ || rad <= -OS_CRATER_RZ) continue;
          float u = length(e - rad * dir) / radius;
          if (u >= OS_CRATER_CUT) continue;

          // Craters centred off the shell fade out — buried and flooded ghosts.
          float wz = 1.0 - abs(rad) / OS_CRATER_RZ;
          float fade = wz * wz * (3.0 - 2.0 * wz);

          // Depth follows DIAMETER (constant depth/diameter), with a quadratic
          // term for the complex-crater collapse that leaves big basins shallow
          // relative to their width.
          //
          // 0.45 / 0.12 / 0.38 / 0.25 are all the simple-to-complex transition:
          // the depth the largest craters lose to wall slumping (d/D falls from
          // ~0.2 to ~0.1), the flat-floor fraction growing from 0.12 to 0.50,
          // and the width of the ramp into "complex". Both size terms are rn^2
          // so the change stays at the top of the size range. Full reasoning in
          // craterField() in terrain.ts.
          float rr = radius / ${g(CRATER_R_MAX)};
          float depth = weight * rr * (1.0 - 0.45 * rn * rn);
          float floorFrac = 0.12 + 0.38 * rn * rn;
          float peakH = ${g(CRATER_PEAK_H)} * clamp((rn - ${g(CRATER_COMPLEX)}) / 0.25, 0.0, 1.0);

          total += depth * fade * os_tCraterProfile(u, floorFrac, ${g(CRATER_RIM_H)}, ${g(CRATER_EJECTA_H)}, peakH);
        }
      }
    }

    freq *= ${g(CRATER_LACUNARITY)};
    weight *= ${g(CRATER_WEIGHT_FALLOFF)};
  }

  return total;
}

/** Normalised height, roughly -1..1, before sea level and amplitude. */
float os_tHeightNormalised(vec3 dir, vec3 seedOffset) {
  vec3 p = dir * uTerrainFrequency + seedOffset;

  // 1. Domain warp — erosion channels and grain that plain fBm never has.
  vec3 w = os_warp(p, uTerrainWarp * ${g(WARP_SCALE)});

  // Continental mask: one very low frequency field, sharpened into coastlines.
  // 4 octaves gives headlands and bays without shattering a continent into an
  // archipelago; 2.1 (not 2.0) keeps octaves off a shared lattice direction so
  // coasts are not grid-aligned; 0.55 is red-tilted so landmasses dominate.
  float cont = os_fbm(dir * ${g(CONTINENT_FREQ)} + seedOffset * 0.31 + vec3(-4.4, 7.9, 2.2),
                      4, 2.1, 0.55);
  // The asymmetric window is the planet's land budget: cont is ~zero-mean, so
  // biasing it upwards yields land on ~30% of the sphere (measured 0.269-0.369
  // over 60 seeds, mean 0.314; Earth is 0.29). The 0.40-wide band is the
  // continental slope — a slope, not a wall, and not a global beach.
  float land = smoothstep(-0.16, 0.24, cont);

  // 2. fBm/ridged blend, with ridges pushed towards the margins of the mask —
  //    real mountain belts sit on plate boundaries, not in the middle of
  //    cratons, and land*(1-land) peaks exactly at the coastline.
  //    4.0 is the normaliser (land*(1-land) maxes at 1/4), so margin hits
  //    exactly 1 at the coast. 0.55/0.9 then give a craton 55% of the spec's
  //    ridging and a plate boundary 145%, clamped to 1 — and because both are
  //    multiplied by uTerrainRidged, 0 still means no ridges anywhere.
  float margin = 4.0 * land * (1.0 - land);
  float rw = clamp(uTerrainRidged * (0.55 + 0.9 * margin), 0.0, 1.0);
  float f = os_fbm(w, uTerrainOctaves, uTerrainLacunarity, uTerrainGain);
  float r = os_ridged(w, uTerrainOctaves, uTerrainLacunarity, uTerrainGain);
  float h = mix(f, r, rw);

  // Spend the full -1..1 range without clipping into mesas. sqrt is exact, so
  // this costs nothing in CPU/GPU agreement.
  h *= ${g(BASE_GAIN)};
  h = h / sqrt(1.0 + h * h);

  // Bimodal hypsometry — continental platform and abyssal plain are two
  // separate populations, the way Earth's elevation histogram really is.
  float ocean = h * ${g(OCEAN_RELIEF)} + (${g(OCEAN_BASE)});
  float landH = h * ${g(LAND_RELIEF)} + ${g(LAND_BASE)};
  h = mix(ocean, landH, land);

  // 3. Craters, modulated so battered highlands sit next to resurfaced plains.
  if (uTerrainCraters > 0.001) {
    // NB: not named 'patch' — that is a reserved word in GLSL ES 3.00.
    // 2.3 sizes the maria a little smaller than the continents (1.7); 3 smooth
    // octaves because this is a province boundary, not terrain — detail here
    // would print into the crater density as noise.
    float resurf = os_fbm(dir * 2.3 + seedOffset * 0.17 + vec3(21.5, -13.9, 6.1), 3, 2.0, 0.5);
    // 0.35 is a FLOOR, not a scale: maria are younger, not sterile. Highlands
    // get ~3x the crater relief of the plains, which reads as two ages of
    // surface without the plains looking swept clean.
    float mask = 0.35 + 0.65 * smoothstep(-0.35, 0.35, resurf);
    h += mask * os_tCraterField(dir, seedOffset, uTerrainCraters);
  }

  // 4. Sharpness, applied signed so basins hollow as peaks sharpen. The 1e-8
  //    floor exists because pow(0, s) is undefined for s <= 0; it costs a step
  //    of 2*(1e-8)^sharpness at h = 0 — 5 cm on a 20 km world at sharpness 0.7,
  //    well under the noise's own inherited 1.4 m C0 step.
  h = clamp(h, -1.0, 1.0);
  float sgn = h < 0.0 ? -1.0 : 1.0;
  h = sgn * pow(max(abs(h), 1e-8), uTerrainSharpness);

  return h;
}

/**
 * Continental slope then abyssal plain: steep at the shoreline, flattening
 * with depth, but still reaching full depth at the deepest sample so that
 * spec.amplitude is not quietly halved. Algebraic, so the CPU agrees exactly.
 */
float os_tSeaFloor(float hn, float seaLevel) {
  float d = seaLevel - hn;
  if (d <= 0.0) return hn;
  // A is the turnover depth: steep above it, abyssal plain below. Tying it to
  // 0.35 * seaLevel keeps the bathymetry the same shape whether the ocean is
  // shallow or planet-deep (Earth: ~4 km of an 11 km range). 1e-4 guards
  // seaLevel = 0 on an airless body.
  float A = 0.35 * seaLevel + 1e-4;
  return seaLevel - (d * (A + seaLevel)) / (A + d);
}

/** Elevation in km, signed about sea level. Identical to sampleTerrain(). */
float os_terrainHeight(vec3 dir, vec3 seedOffset) {
  float h = os_tHeightNormalised(dir, seedOffset);
  float hn = os_tSeaFloor(h * 0.5 + 0.5, uTerrainSeaLevel);
  return uTerrainAmplitude * (hn - uTerrainSeaLevel);
}

/**
 * Outward normal by central differences on the displaced surface.
 * eps is a step measured in km ALONG THE SURFACE, matching the CPU sampler.
 */
vec3 os_terrainNormal(vec3 dir, vec3 seedOffset, float radius, float eps) {
  // Branchless orthonormal basis (Duff et al. 2017) — no pole singularity.
  float sg = dir.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (sg + dir.z);
  float b = dir.x * dir.y * a;
  vec3 t1 = vec3(1.0 + sg * dir.x * dir.x * a, sg * b, -sg * dir.x);
  vec3 t2 = vec3(b, sg + dir.y * dir.y * a, -dir.y);

  float ang = eps / max(radius, 1e-6);

  vec3 qa = normalize(dir + t1 * ang);
  vec3 qb = normalize(dir - t1 * ang);
  vec3 qc = normalize(dir + t2 * ang);
  vec3 qd = normalize(dir - t2 * ang);

  vec3 pa = qa * (radius + os_terrainHeight(qa, seedOffset));
  vec3 pb = qb * (radius + os_terrainHeight(qb, seedOffset));
  vec3 pc = qc * (radius + os_terrainHeight(qc, seedOffset));
  vec3 pd = qd * (radius + os_terrainHeight(qd, seedOffset));

  vec3 n = cross(pa - pb, pc - pd);
  float len = length(n);
  if (len < 1e-20) return dir;
  return normalize(dot(n, dir) < 0.0 ? -n : n);
}

#endif
`;
}

// ---------------------------------------------------------------------------
// Determinism self-check
// ---------------------------------------------------------------------------

/**
 * Sum of sampled elevations over a fixed Fibonacci spiral of directions.
 *
 * Used by the verification pass: identical inputs must give an identical
 * number on every machine and every run. The spiral is built from a two-term
 * rotation recurrence seeded with hard-coded golden-angle constants rather than
 * `Math.sin`/`Math.cos`, because trigonometric functions are not required to be
 * correctly rounded and are the one place a JS engine could legitimately differ
 * from another. Everything here is +, *, / and sqrt, all of which IEEE-754
 * pins down exactly.
 */
export function terrainChecksum(spec: TerrainSpec, seed: number, samples: number): number {
  resolveOffset(seed);
  const n = Math.max(1, Math.floor(samples));
  let cx = 1.0;
  let cy = 0.0;
  let sum = 0.0;
  for (let i = 0; i < n; i++) {
    const z = 1.0 - (2.0 * i + 1.0) / n;
    const r = Math.sqrt(Math.max(0.0, 1.0 - z * z));
    const h = heightNormalised(spec, r * cx, r * cy, z, memoX, memoY, memoZ);
    const hn = applySeaFloor(h * 0.5 + 0.5, spec.seaLevel);
    sum += spec.amplitude * (hn - spec.seaLevel);

    // Rotate by the golden angle, then renormalise so 10^6 steps cannot drift.
    const rx = cx * GOLDEN_COS - cy * GOLDEN_SIN;
    const ry = cx * GOLDEN_SIN + cy * GOLDEN_COS;
    const inv = 1.0 / Math.sqrt(rx * rx + ry * ry);
    cx = rx * inv;
    cy = ry * inv;
  }
  return sum;
}

