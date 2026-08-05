/**
 * oneSpace — galaxy generation and the star catalogue.
 *
 * PURE MODULE. No three.js, no DOM, no I/O, no Math.random(). Everything here
 * is a function of a 32-bit seed, so the same galaxy exists on every machine
 * forever.
 *
 * ---------------------------------------------------------------------------
 * COORDINATE FRAME
 * ---------------------------------------------------------------------------
 * Galaxy-local, light years, right-handed, Y-up (three.js convention):
 *
 *     +Y  = galactic north  (the thin axis — disc scale height runs along Y)
 *     XZ  = the disc plane  (galactic radius r = hypot(x, z))
 *      θ  = atan2(z, x), increasing counter-clockwise seen from +Y
 *
 * The disc is therefore flat in XZ and thin in Y, which is what every renderer
 * in this project expects to be able to drop straight onto a Y-up scene graph.
 *
 * ---------------------------------------------------------------------------
 * THE TWO POPULATIONS — why this file is longer than "random points in a spiral"
 * ---------------------------------------------------------------------------
 * A galaxy that reads as real is not a uniform sample. Three physical facts do
 * almost all of the work here and every one of them is implemented literally:
 *
 *  1. The IMF is a power law. Kroupa (2001): dN/dm ∝ m^-1.3 below 0.5 M☉ and
 *     m^-2.3 above. Low-mass stars outnumber high-mass ones by ~1000:1.
 *  2. Massive stars die fast. τ_MS ≈ 10 Gyr · (M/M☉)^-2.5. A 30 M☉ star lives
 *     2 Myr; the galaxy is ~11 Gyr old. So the *present-day* mass function is
 *     the IMF multiplied by a survival probability, and O stars only exist
 *     where stars were made in the last few million years — i.e. in the arms.
 *     This is the single detail that makes arms blue and the bulge amber, and
 *     it also hands us the white dwarf / neutron star / black hole population
 *     for free, at the correct rarity, without a separate "exotic" roll.
 *  3. Everything else follows from two power laws: L ≈ M^3.5, R ≈ M^0.57, and
 *     then Stefan–Boltzmann gives temperature. The whole HR diagram falls out.
 *
 * ---------------------------------------------------------------------------
 * TWO CATALOGUES, ON PURPOSE
 * ---------------------------------------------------------------------------
 * `generateStarField` produces the ~10^5 points you *see* on the galaxy map: a
 * sparse artistic sample of ~10^11 real stars, drawn from the density field by
 * importance sampling.
 *
 * `sampleSystemsNear` produces the systems you can *fly to*: a stateless
 * spatial hash over deterministic grid cells, so a jump map query costs
 * O(cells in range) rather than O(stars in galaxy) and never needs the star
 * field to exist. The two agree statistically (same density field, same
 * stellar population model) but not star-for-star, and that is fine — one is a
 * painting of a hundred billion stars, the other is a road atlas.
 */

import type { GalaxyShape, GalaxySpec, NebulaSpec, RGB, SpectralClass, Vec3 } from './types';
import { Rng, hash3, hashSeed, rngFrom } from '@/math/rng';
import { blurb, galaxyName, nebulaName, systemName } from './names';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A star system as the jump map knows it: enough to draw it, name it and
 * decide whether it is worth the fuel. The full `StarSystemSpec` (planets,
 * moons, habitable zone) is generated on demand by `gen/system.ts` from
 * `seed` — never eagerly, there are billions of these.
 */
export interface StarSystemStub {
  readonly id: string;
  readonly seed: number;
  readonly name: string;
  /** Galaxy-local, light years. */
  readonly position: Vec3;
  /** Primary's effective temperature, kelvin. */
  readonly temperature: number;
  /** Primary's bolometric luminosity, solar luminosities. */
  readonly luminosity: number;
}

// ---------------------------------------------------------------------------
// Astrophysical constants
// ---------------------------------------------------------------------------

/** Sol's effective temperature, K. Anchors the Stefan–Boltzmann relation. */
const SOLAR_TEFF = 5772;

/**
 * Kroupa (2001) broken-power-law IMF. Slopes are dN/dm ∝ m^-alpha.
 * The break at 0.5 M☉ is where the fragmentation physics of collapsing
 * molecular cores changes regime.
 */
const IMF_M_MIN = 0.08; // hydrogen burning limit — below this it is a brown dwarf
const IMF_M_BREAK = 0.5;
const IMF_M_MAX = 120; // the observed upper limit; R136a1 is ~200 but that is one object
const IMF_ALPHA_LOW = 1.3;
const IMF_ALPHA_HIGH = 2.3;

/**
 * Probability that a Kroupa draw lands in the low-mass segment. Derived by
 * integrating each segment of the (continuity-matched) IMF:
 *   low  = ∫[0.08,0.5] m^-1.3 dm                   = 3.008
 *   high = 0.5 · ∫[0.5,120] m^-2.3 dm              = 0.946
 * The 0.5 factor is the continuity constant k2 = 0.5^(α_high - α_low).
 * Result: ~76% of all stars ever born are below half a solar mass.
 */
const IMF_LOW_FRACTION = 3.008 / (3.008 + 0.946);

/** Main-sequence lifetime in Gyr: nuclear fuel ∝ M, burn rate ∝ L ∝ M^3.5. */
function msLifetimeGyr(mass: number): number {
  // Floored at 2.5 Myr — above ~40 M☉ mass loss, not fuel, sets the clock.
  return Math.max(0.0025, 10 * Math.pow(mass, -2.5));
}

/** Age of a typical disc galaxy in Gyr. Sets how much of the IMF has died. */
const GALAXY_AGE_GYR = 11.5;

/**
 * Chance a star belongs to the *young* population, i.e. was formed recently
 * enough that the O/B stars around it are still alive. Star formation needs
 * cold molecular gas, and cold molecular gas only survives where something is
 * compressing it — so this is driven almost entirely by the local
 * star-formation term and barely at all by a constant.
 *
 * Getting this ratio right is the whole ballgame. Too high a floor and every
 * region of every galaxy is equally blue, which is what a uniform sampler
 * looks like. At these values a spiral arm carries ~20x the young fraction of
 * the interarm gap, and a gas-stripped elliptical carries essentially none.
 */
const YOUNG_SFR_GAIN = 0.24;

/**
 * Fraction of evolved sub-8 M☉ stars caught in the (brief) giant phase rather
 * than already cooled to a white dwarf. It is a duty cycle: the RGB + AGB
 * phases together last ~1 Gyr against ~11.5 Gyr of elapsed galactic time, so
 * roughly one evolved star in twelve is currently a giant. The rest are the
 * white dwarfs that phase leaves behind.
 *
 * Small as it is, this number does a lot of visible work — giants are ~0.5% of
 * the catalogue by count but around half of a galaxy's integrated light, so it
 * is the main lever on how bright an old, gas-poor galaxy reads.
 */
const GIANT_FRACTION = 0.08;

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Blackbody colour, linear RGB.
 *
 * The body of this function is a line-for-line mirror of `os_blackbody` in
 * `shaders/chunks.ts` — a star's catalogue colour and its rendered corona must
 * agree, otherwise the HUD swatch and the sky disagree and the illusion dies.
 * If one changes, change both.
 *
 * ONE DELIBERATE DIFFERENCE: the input is clamped to 1000–40000 K here and is
 * not clamped in the GLSL. The fit is only valid over roughly that interval
 * (below ~1000 K `log(t)` dives towards -inf, above ~40000 K the curve has
 * flattened and stops meaning anything), and this module has to survive being
 * handed 0 K for a black hole and ~10^6 K for a neutron star. The GPU never
 * sees either: black holes ship with temperature 0 *and* brightness 0 so the
 * renderer discards them, and if a renderer ever does tint a neutron star it
 * must clamp first or it will get a different blue than the catalogue did.
 * 1000 K is the coolest brown-dwarf photosphere worth a colour; 40000 K is
 * hotter than any main-sequence star this generator produces (max ~60000 K for
 * a 120 M☉ O2V, which clamps).
 */
export function blackbodyColor(kelvin: number): RGB {
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100;
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
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

/**
 * Interstellar reddening. Dust extinction goes roughly as 1/λ across the
 * optical, so blue light is scattered out of the line of sight far harder than
 * red — which is exactly why dust lanes in a spiral read as warm brown against
 * a blue disc rather than as neutral grey.
 */
function redden(color: RGB, tau: number): RGB {
  // Effective band centres, nm: R 600, G 550, B 445.
  const ref = 600;
  return [
    color[0] * Math.exp(-tau * (ref / 600)),
    color[1] * Math.exp(-tau * (ref / 550)),
    color[2] * Math.exp(-tau * (ref / 445)),
  ];
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function scaleRgb(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

function srgbTriplet(r: number, g: number, b: number): RGB {
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * sech²(x), written so it cannot overflow. The self-gravitating isothermal
 * sheet solution (Spitzer 1942) — the correct vertical profile for a stellar
 * disc, and visibly flatter-topped and sharper-edged than a gaussian.
 */
function sech2(x: number): number {
  const e = Math.exp(-Math.abs(x));
  const s = (2 * e) / (1 + e * e);
  return s * s;
}

// ---------------------------------------------------------------------------
// The density field
// ---------------------------------------------------------------------------

interface Clump {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly weight: number;
}

/**
 * Everything the density field needs, derived deterministically from the spec
 * plus `spec.seed`. Rebuilt on demand rather than cached so this module stays
 * genuinely stateless — it is ~40 arithmetic ops plus a handful of Rng draws.
 */
export interface GalaxyField {
  readonly shape: GalaxyShape;
  readonly radius: number;
  /** Exponential disc scale length, ly. Milky Way: R_disc/R_25 ≈ 1/4. */
  readonly scaleLength: number;
  readonly scaleHeight: number;
  readonly armCount: number;
  /** tan of the spiral pitch angle. Small = tightly wound. */
  readonly tanPitch: number;
  readonly armContrast: number;
  /** Exponent that narrows the arms. Rises with contrast. */
  readonly armSharp: number;
  /** Peak arm overdensity above the smooth disc. 3 means a 4:1 arm/interarm. */
  readonly armGain: number;
  /** Azimuthal mean of the arm profile — the fraction of the circle it covers. */
  readonly armMean: number;
  /** Radius at which the arms start, ly — the bulge edge or the bar end. */
  readonly armStart: number;
  readonly bulgeRadius: number;
  readonly bulgeFlatten: number;
  /** Amplitude of the bulge term relative to the disc term at r=0. */
  readonly bulgeAmp: number;
  readonly barLength: number;
  readonly barWidth: number;
  readonly barAmp: number;
  readonly barAngle: number;
  readonly ringRadius: number;
  readonly ringWidth: number;
  /** Triaxial axis ratios b/a, c/a for ellipticals. */
  readonly axisB: number;
  readonly axisC: number;
  /** Effective (half-light) radius for the de Vaucouleurs profile, ly. */
  readonly effRadius: number;
  readonly clumps: readonly Clump[];
  /** Offset of the disc centroid, ly — irregulars are lopsided. */
  readonly offsetX: number;
  readonly offsetZ: number;
  /** Normaliser so densityAt() returns 0..1. */
  readonly peak: number;
  /** Fraction of disc+bar+bulge stars belonging to each component. */
  readonly shareBulge: number;
  readonly shareBar: number;
  /** Fraction of an irregular's stars inside its star-forming clumps. */
  readonly shareClumps: number;
  /** Cold gas available for star formation, relative to a healthy spiral. */
  readonly gasFraction: number;
}

/**
 * Cold gas budget by Hubble type. Ellipticals were stripped or burnt out
 * long ago (that is what makes them "red and dead"); dwarf irregulars are the
 * most gas-rich objects in the sky, which is why they are also the bluest.
 */
function gasFractionFor(shape: GalaxyShape): number {
  switch (shape) {
    case 'elliptical':
      return 0.02;
    case 'irregular':
      return 1.35;
    case 'ring':
      return 0.9;
    default:
      return 1;
  }
}

/**
 * Derive the density field from a finished spec. Exported so `render/GalaxyView`
 * can evaluate the same field the catalogue uses — the map's haze and its
 * navigable systems must agree or the player will see stars where the paint
 * says there are none.
 */
export function buildField(g: GalaxySpec): GalaxyField {
  const rng = rngFrom(g.seed, 'field');
  const R = g.radiusLy;

  // Real discs: the exponential scale length is ~1/4 of the optical radius.
  const scaleLength = R * 0.25;
  const scaleHeight = g.thicknessLy;

  // Pitch angle from armTwist. The contract says higher armTwist = tighter, so
  // tan(pitch) must fall as armTwist rises. 0.15 -> 21° (Sc, open, flocculent),
  // 0.45 -> 7° (Sa, tightly wound) — the observed Hubble-type range.
  const tanPitch = clamp(0.58 - g.armTwist, 0.06, 0.5);

  // Bulge gaussian sigma. Observed bulge effective radii run ~7% of the optical
  // radius for a bulgeless Sd up to ~19% for an Sa, hence 0.075 + 0.11·f. For an
  // elliptical the "bulge" IS the galaxy, so the term has to be big enough to
  // carry the whole light profile; 0.45 R is only used as a scale here because
  // rawDensity switches to the de Vaucouleurs law for that shape anyway.
  const bulgeRadius = R * (g.shape === 'elliptical' ? 0.45 : 0.075 + g.bulgeFraction * 0.11);
  // Bulges are oblate, roughly 0.6 axis ratio; classical bulges rounder.
  const bulgeFlatten = 0.55 + g.bulgeFraction * 0.4;

  // Bar semi-length as a fraction of the optical radius. The observed range for
  // strong bars is 0.15–0.35 R_25 (Erwin 2005); axis ratio b/a of a bar is
  // 0.15–0.25, which is the second range. Bars are stubbier than they look —
  // most of the apparent length is the dust lane running down the leading edge.
  const barLength = g.shape === 'barred-spiral' ? R * rng.range(0.16, 0.34) : 0;
  const barWidth = barLength * rng.range(0.16, 0.26);
  // The bar's position angle is arbitrary — nothing else in the galaxy defines a
  // preferred azimuth — but everything downstream keys off it: the arms launch
  // from the bar ends, and the ring galaxy's knots use it as their phase origin.
  const barAngle = rng.range(0, Math.PI * 2);
  // Bars carry a fifth to a third of the disc light inside their own radius.
  const barAmp = barLength > 0 ? rng.range(0.9, 1.6) : 0;

  // Arms emanate from the bulge edge, or from the ends of the bar if there is
  // one — a bar and its arms are one dynamical structure, not two. The 0.04 R
  // floor is for the bulgeless, barless case: without it `armStart` collapses to
  // a few light years, `log(r / armStart)` blows up, and the spiral winds
  // through dozens of turns before it clears the nucleus.
  const armStart = Math.max(bulgeRadius * 0.9, barLength * 0.95, R * 0.04);
  // Grand-design arms are narrow ridges, not sine waves. Contrast 1 gives a
  // cos^17 profile: roughly a 25° wide arm, which is what M51 looks like.
  const armSharp = 1 + 16 * g.armContrast * g.armContrast;
  // Arms are *compressions*: they multiply the disc up rather than dimming the
  // gaps down. Observed arm/interarm contrast in the optical runs 1.5:1 for a
  // flocculent disc to 8:1 for a grand design, which is what this maps onto.
  const armGain = 8 * Math.pow(g.armContrast, 1.6);
  /**
   * Azimuthal mean of ((1 + cos φ)/2)^k, exactly Γ(k+½)/(√π·Γ(k+1)). The closed
   * form needs a gamma function we do not have; this approximation is within 1%
   * across every k we generate, and it is what lets the sampler place a star
   * *on* an arm directly rather than rejection-sampling the whole azimuth.
   */
  const armMean = 1 / Math.sqrt(Math.PI * (armSharp + 0.25));

  /**
   * Bulge amplitude, from mass bookkeeping rather than taste. Integrating each
   * component over all space:
   *   disc  = 2πL² · 2h        (exponential × sech²)
   *   bulge = (2π)^1.5 σ³ · q  (triaxial gaussian)
   * Setting N_bulge / N_total = bulgeFraction fixes the ratio of amplitudes,
   * which is what makes the core the right brightness instead of a guess.
   */
  const discIntegral = 4 * Math.PI * scaleLength * scaleLength * scaleHeight;
  const bulgeIntegral =
    Math.pow(2 * Math.PI, 1.5) * bulgeRadius * bulgeRadius * bulgeRadius * bulgeFlatten;
  const bf = clamp(g.bulgeFraction, 0.001, 0.95);
  const bulgeAmp = (bf / (1 - bf)) * (discIntegral / Math.max(bulgeIntegral, 1e-6));

  // Ring galaxies: a collisional density wave parked at ~2/3 of the radius,
  // with a starved gap between it and the surviving nucleus (Hoag's object).
  const ringRadius = R * rng.range(0.58, 0.74);
  const ringWidth = ringRadius * rng.range(0.07, 0.15);

  // Ellipticals are triaxial, never spherical. E0-E6 covers b/a down to ~0.4.
  const axisB = rng.range(0.42, 0.95);
  const axisC = axisB * rng.range(0.6, 1.0);
  // Half-light radius. The de Vaucouleurs profile is very extended — it reaches
  // roughly 3 R_e before it drops below a detectable surface brightness — so
  // R_e ≈ R/3 is what makes the *visible* extent come out at `radiusLy`.
  const effRadius = R * 0.34;

  const clumps = buildClumps(g, rng, R, scaleHeight);

  // Irregulars have no dynamical centre worth the name; the light is lopsided.
  const lop = g.shape === 'irregular' ? R * 0.18 : 0;
  const offsetX = rng.gaussian(0, lop);
  const offsetZ = rng.gaussian(0, lop);

  const f: GalaxyField = {
    shape: g.shape,
    radius: R,
    scaleLength,
    scaleHeight,
    armCount: Math.max(1, g.armCount),
    tanPitch,
    armContrast: g.armContrast,
    armSharp,
    armGain,
    armMean,
    armStart,
    bulgeRadius,
    bulgeFlatten,
    bulgeAmp,
    barLength,
    barWidth,
    barAmp,
    barAngle,
    ringRadius,
    ringWidth,
    axisB,
    axisC,
    effRadius,
    clumps,
    offsetX,
    offsetZ,
    peak: 1,
    shareBulge: 0,
    shareBar: 0,
    shareClumps: 0,
    gasFraction: gasFractionFor(g.shape),
  };

  // Component shares come from integrals of the very terms above, so the
  // sampler and the density function can never drift apart. The arms are part
  // of the disc's mass, not a free addition — forget them and a strongly
  // armed galaxy sends a third of its disc stars to the bulge instead.
  const discMass = 4 * Math.PI * scaleLength * scaleLength * scaleHeight + armMassOf(f);
  const bulgeMass = bulgeAmp * bulgeIntegral;
  const barMass = barMassOf(f);
  const totalMass = discMass + bulgeMass + barMass;

  // Normalise by the actual maximum so densityAt() is a clean 0..1 and the
  // stars-per-cubic-light-year conversion has one meaning for every shape.
  return {
    ...f,
    peak: estimatePeak(f),
    shareBulge: bulgeMass / totalMass,
    shareBar: barMass / totalMass,
    shareClumps: clumpShareOf(f),
  };
}

/**
 * What fraction of an irregular's stars the clumps hold, integrated rather
 * than guessed. `rawDensity` mixes 0.35 smooth + 0.65 clumps by *amplitude*;
 * the sampler needs the split by *mass*, and the two differ by whatever volume
 * the clumps happen to occupy this time.
 *   smooth clump : 0.65·w·π^1.5·rad³ / 1.6   (the 1.6 is the y compression)
 *   smooth disc  : 0.35 · 2π(1.5L)² · 2(1.8h)
 */
function clumpShareOf(f: GalaxyField): number {
  if (f.clumps.length === 0) return 0;
  const disc =
    0.35 *
    2 *
    Math.PI *
    Math.pow(1.5 * f.scaleLength, 2) *
    2 *
    (1.8 * f.scaleHeight);
  let clumps = 0;
  for (const c of f.clumps) {
    clumps += (0.65 * c.weight * Math.pow(Math.PI, 1.5) * c.radius * c.radius * c.radius) / 1.6;
  }
  return clumps / (clumps + disc);
}

function buildClumps(g: GalaxySpec, rng: Rng, R: number, scaleHeight: number): readonly Clump[] {
  if (g.shape !== 'irregular') return [];
  // Irregulars are a handful of super star clusters and their tidal debris —
  // the LMC is essentially 30 Doradus plus a smear. Few, big, unequal.
  const n = rng.int(3, 6);
  const out: Clump[] = [];
  for (let i = 0; i < n; i++) {
    // Spread out rather than piled on a centre — an irregular has no centre.
    const r = R * rng.power(0.12, 1.0, -0.35);
    const th = rng.range(0, Math.PI * 2);
    out.push({
      x: Math.cos(th) * r,
      z: Math.sin(th) * r,
      y: rng.gaussian(0, scaleHeight * 1.6),
      // Kept small enough that neighbouring clumps stay distinguishable;
      // overlapping them just rebuilds a smooth blob, which is the failure
      // mode this whole shape exists to avoid.
      radius: R * rng.range(0.06, 0.22),
      // Power-law weights: one clump dominates (30 Doradus), the rest are knots.
      weight: rng.power(0.12, 1, -1.5),
    });
  }
  return out;
}

/**
 * Where the field peaks — solved rather than searched.
 *
 * `buildField` runs on every `sampleSystemsNear` call, which is every frame
 * while the jump map is open, so sweeping a probe grid to find the maximum is
 * not affordable. Every shape here has its maximum at a point we already know
 * analytically, so we evaluate a handful of candidates instead of a thousand.
 */
function estimatePeak(f: GalaxyField): number {
  switch (f.shape) {
    case 'elliptical':
      // The r^(1/4) law is singular at the origin; rawDensity clamps the
      // normalised radius at 0.004, so that clamp *is* the maximum.
      return Math.exp(-7.669 * (Math.pow(0.004, 0.25) - 1));

    case 'irregular': {
      let p = rawDensity(f, f.offsetX, 0, f.offsetZ);
      for (const c of f.clumps) p = Math.max(p, rawDensity(f, c.x, c.y, c.z));
      return Math.max(p, 1e-6);
    }

    case 'ring': {
      // Two candidates: the surviving nucleus, and the brightest knot on the
      // ring — which sits at the azimuth where the knot cosine equals one.
      const nucleus = rawDensity(f, 0, 0, 0);
      const knot = rawDensity(
        f,
        Math.cos(f.barAngle) * f.ringRadius,
        0,
        Math.sin(f.barAngle) * f.ringRadius,
      );
      return Math.max(nucleus, knot, 1e-6);
    }

    default: {
      // Two candidates: the nucleus, where disc + bar + bulge all peak at once,
      // and the arm ridge, where the disc is dimmer but multiplied by armGain.
      // Walking the ridge costs six evaluations because we can solve for where
      // it is rather than searching for it.
      // Six steps from the arm start out to 0.6 R. The ridge's brightness is
      // exp(-r/L)·armGain·damping(r) — monotonically falling once the inner
      // smoothstep has saturated — so the maximum is always near armStart and a
      // coarse walk finds it. Past 0.6 R the exponential has killed the disc and
      // there is nothing left to be the peak.
      let peak = 1 + f.barAmp + f.bulgeAmp;
      for (let i = 1; i <= 6; i++) {
        const r = f.armStart + ((f.radius * 0.6 - f.armStart) * i) / 6;
        if (r <= 0) continue;
        const th = armRidgeAzimuth(f, r);
        peak = Math.max(peak, rawDensity(f, Math.cos(th) * r, 0, Math.sin(th) * r));
      }
      return peak;
    }
  }
}

/**
 * How far onto an arm ridge a point sits, 0 (interarm) to 1 (on the crest).
 *
 * Logarithmic spiral: a curve of constant pitch angle ψ satisfies
 * r = r0·e^(θ·tanψ), i.e. θ_arm(r) = ln(r/r0) / tanψ. Subtracting that from
 * the point's own azimuth gives a phase that is constant *along* an arm, so
 * cos(N·phase) paints N arms that genuinely wind instead of radiating.
 */
function armPhaseStrength(f: GalaxyField, x: number, y: number, z: number): number {
  if (f.armContrast <= 0.001) return 0;
  const r = Math.hypot(x, z);
  if (r < 1e-3) return 0;
  const phase = Math.atan2(z, x) - armRidgeAzimuth(f, r);
  return Math.pow(0.5 + 0.5 * Math.cos(f.armCount * phase), f.armSharp) * armDamping(f, r, y);
}

/** Azimuth of arm 0's ridge at radius r — the inverse of r = r0·e^(θ·tanψ). */
function armRidgeAzimuth(f: GalaxyField, r: number): number {
  return Math.log(Math.max(r, f.armStart * 0.25) / f.armStart) / f.tanPitch + f.barAngle;
}

/**
 * How much arm there is to be on, independent of azimuth. Arms are a gas-disc
 * phenomenon: they do not exist inside the bulge or bar (the bar's own orbits
 * dominate there), they stop at the gas truncation radius, and they live in
 * the thin molecular layer rather than the puffed-up old stellar disc — which
 * is why a spiral seen edge-on is a knife and not a lens.
 *
 * The three numbers: arms ramp in between 0.7 and 1.8 armStart (a smooth
 * hand-off across the bulge/bar edge rather than a ring-shaped seam), they fade
 * out between 0.85 and 1.15 R (the gas disc truncates just outside the optical
 * radius, not at it), and the molecular layer is 0.55x the scale height of the
 * old stellar disc — young stars have not had time to be scattered out of the
 * plane they were born in.
 */
function armDamping(f: GalaxyField, r: number, y: number): number {
  return (
    smoothstep(f.armStart * 0.7, f.armStart * 1.8, r) *
    (1 - smoothstep(f.radius * 0.85, f.radius * 1.15, r)) *
    sech2(y / (f.scaleHeight * 0.55))
  );
}

/** Sum of the irregular galaxy's star-forming clumps at a point, 0..~1. */
function clumpStrength(f: GalaxyField, x: number, y: number, z: number): number {
  let sum = 0;
  for (const c of f.clumps) {
    const dx = x - c.x;
    const dy = (y - c.y) * 1.6; // clumps are flattened with the gas layer
    const dz = z - c.z;
    const d2 = (dx * dx + dy * dy + dz * dz) / (c.radius * c.radius);
    sum += c.weight * Math.exp(-d2);
  }
  return sum;
}

/**
 * How strongly this point is currently forming stars, 0..1. Drives the young
 * population fraction, hence O/B stars, hence the colour of the arms — this is
 * the function that decides whether a galaxy reads as alive or as embalmed.
 *
 * Multiplied through by `gasFraction`, which is a whole-galaxy property: you
 * cannot form stars out of gas you do not have, and an elliptical has not had
 * any for ten billion years.
 */
export function starFormationAt(f: GalaxyField, x: number, y: number, z: number): number {
  switch (f.shape) {
    case 'elliptical':
      // Red and dead. What little formation there is happens in the odd
      // accreted gas cloud, far below anything that changes the colour.
      return f.gasFraction * 0.05;

    case 'irregular':
      // 0.04 is a genuine floor here, unlike in the disc case: an irregular is
      // tidally stirred throughout, so even the smear between the super star
      // clusters is forming stars. gasFraction 1.35 lifts it to ~5%.
      return clamp01(f.gasFraction * (0.04 + clumpStrength(f, x, y, z)));

    case 'ring': {
      const r = Math.hypot(x, z);
      const onRing = Math.exp(-Math.pow((r - f.ringRadius) / f.ringWidth, 2));
      // The shock front beads up rather than burning evenly around the annulus.
      const theta = Math.atan2(z, x);
      const knots = 0.55 + 0.45 * Math.cos(f.armCount * (theta - f.barAngle));
      return clamp01(f.gasFraction * onRing * knots * sech2(y / (f.scaleHeight * 0.6)));
    }

    default: {
      const r = Math.hypot(x, z);
      // Diffuse component: even a flocculent disc with no coherent arms forms
      // stars throughout its molecular layer, which truncates sharply near the
      // optical radius because the gas surface density drops below the
      // Toomre threshold there.
      // 0.6 h: the molecular layer is thinner than the stellar disc it sits in.
      const gasLayer = sech2(y / (f.scaleHeight * 0.6));
      // Rises across the bulge (no star formation inside it) and falls between
      // 0.78 and 1.05 R — slightly *inside* where the arms truncate, because the
      // diffuse molecular gas runs out before the density wave stops sweeping.
      const radial =
        smoothstep(0, f.armStart * 1.5, r) * (1 - smoothstep(f.radius * 0.78, f.radius * 1.05, r));
      // 0.11 sets the interarm floor. Multiplied by YOUNG_SFR_GAIN it makes an
      // interarm star ~2.6% likely to be young, against ~24% on an arm crest —
      // the ~9:1 ratio that gives the measured ~3-8:1 arm/interarm contrast in
      // integrated colour. Raise it and every disc becomes uniformly blue.
      const diffuse = 0.11 * gasLayer * radial;
      return clamp01(f.gasFraction * (diffuse + armPhaseStrength(f, x, y, z)));
    }
  }
}

/** Un-normalised stellar density. `densityAt` divides this by `peak`. */
function rawDensity(f: GalaxyField, x: number, y: number, z: number): number {
  switch (f.shape) {
    case 'elliptical': {
      // de Vaucouleurs r^(1/4) law, triaxial. The 7.669 is the constant that
      // makes effRadius enclose exactly half the light (Sérsic b_n for n=4).
      const q = Math.sqrt(
        x * x + (y / f.axisC) * (y / f.axisC) + (z / f.axisB) * (z / f.axisB),
      );
      const s = Math.max(q / f.effRadius, 0.004);
      return Math.exp(-7.669 * (Math.pow(s, 0.25) - 1));
    }

    case 'irregular': {
      const dx = x - f.offsetX;
      const dz = z - f.offsetZ;
      const r = Math.hypot(dx, dz);
      // An irregular's smooth component is a puffed-up, shallower disc than a
      // spiral's: 1.5x the scale length (no density wave to concentrate it) and
      // 1.8x the scale height (no cold thin disc — the whole thing is stirred).
      const base = Math.exp(-r / (f.scaleLength * 1.5)) * sech2(y / (f.scaleHeight * 1.8));
      // 35% smooth field, 65% in the clusters — irregulars are mostly clumps.
      // Both multipliers are mirrored in `clumpShareOf` and `samplePosition`;
      // change one and the sampler stops matching the field it is sampling.
      return 0.35 * base + 0.65 * clumpStrength(f, x, y, z);
    }

    case 'ring': {
      const r = Math.hypot(x, z);
      const ring = Math.exp(-Math.pow((r - f.ringRadius) / f.ringWidth, 2));
      const theta = Math.atan2(z, x);
      const knots = 0.6 + 0.4 * Math.cos(f.armCount * (theta - f.barAngle));
      // The intruder punched through the centre and the nucleus survived as a
      // compact remnant — ~9% of the optical radius, matching Hoag's Object,
      // where the core is a tight ball inside a ring six times its size.
      const nucleus = Math.exp(-Math.pow(r / (f.radius * 0.09), 2));
      const vert = sech2(y / f.scaleHeight);
      // The gap is not empty, just starved — a thin scattered disc survives at
      // ~5% of the ring's surface brightness, which is what stops the gap from
      // reading as a hole cut in a sprite. The 0.85 / 1.15 split makes the
      // nucleus the brighter of the two in surface brightness while the ring,
      // spread over a far larger area, holds most of the actual stars.
      const scattered = 0.05 * Math.exp(-r / (f.scaleLength * 1.2));
      return (0.85 * ring * knots + 1.15 * nucleus + scattered) * vert;
    }

    default: {
      const r = Math.hypot(x, z);
      const vert = sech2(y / f.scaleHeight);
      // Arms multiply the disc up. Writing this as (1 - c) + c·arm instead
      // caps the contrast at 1/(1-c) and produces a galaxy with no visible
      // arms at all, which is the single most common way to get this wrong.
      const arms = 1 + f.armGain * armPhaseStrength(f, x, y, z);
      let d = Math.exp(-r / f.scaleLength) * vert * arms;

      if (f.barAmp > 0) {
        // Rotate into bar-aligned coordinates. Real bars have flat-topped
        // surface-brightness profiles along their length with abrupt ends, so
        // the |u| term is raised to 3.5 — an exponential would taper them into
        // a lens and lose the hard edge the arms hang off.
        const ca = Math.cos(-f.barAngle);
        const sa = Math.sin(-f.barAngle);
        const u = x * ca - z * sa;
        const v = x * sa + z * ca;
        const bar =
          Math.exp(-Math.pow(Math.abs(u) / f.barLength, 3.5) - Math.pow(v / f.barWidth, 2)) *
          sech2(y / (f.scaleHeight * 1.5));
        d += f.barAmp * bar;
      }

      const bx = x / f.bulgeRadius;
      const by = y / (f.bulgeRadius * f.bulgeFlatten);
      const bz = z / f.bulgeRadius;
      d += f.bulgeAmp * Math.exp(-0.5 * (bx * bx + by * by + bz * bz));
      return d;
    }
  }
}

/** Normalised stellar density at a galaxy-local point, 0..1. */
export function densityAt(f: GalaxyField, x: number, y: number, z: number): number {
  return clamp01(rawDensity(f, x, y, z) / f.peak);
}

// ---------------------------------------------------------------------------
// Stellar population
// ---------------------------------------------------------------------------

export interface StarDraw {
  readonly mass: number;
  readonly temperature: number;
  /** Solar luminosities. */
  readonly luminosity: number;
  /** Solar radii. */
  readonly radius: number;
  readonly spectralClass: SpectralClass;
}

/** Draw an initial mass from the Kroupa broken power law. */
function kroupaMass(rng: Rng): number {
  return rng.chance(IMF_LOW_FRACTION)
    ? rng.power(IMF_M_MIN, IMF_M_BREAK, -IMF_ALPHA_LOW)
    : rng.power(IMF_M_BREAK, IMF_M_MAX, -IMF_ALPHA_HIGH);
}

/**
 * Main-sequence mass–luminosity relation, four segments.
 *
 * A single L ∝ M^3.5 power law is the usual shortcut and it is wrong at both
 * ends: fully convective M dwarfs are shallower, and above ~20 M☉ radiation
 * pressure pushes stars towards the Eddington limit so luminosity climbs far
 * more slowly than the classic slope predicts. Using one power law puts a
 * 100 M☉ star at 87,000 K, which does not exist; these four put it at 56,000 K,
 * which is an O2V. The breakpoints are chosen so the segments join smoothly.
 */
function msLuminosity(mass: number): number {
  if (mass < 0.43) return 0.23 * Math.pow(mass, 2.3); // fully convective
  if (mass < 2) return Math.pow(mass, 4); // radiative core, steepest regime
  if (mass < 20) return 1.4 * Math.pow(mass, 3.5);
  return 50088 * Math.pow(mass / 20, 2.1); // Eddington-limited
}

/**
 * Radius of a 20 M☉ star on the segment below the break, i.e. 20^0.57. Written
 * as the expression rather than a typed-in 5.596 so the two segments cannot
 * drift apart: a hand-rounded constant here put a 1.4% step in the radius at
 * M = 20, which Stefan–Boltzmann turns into a 0.7% step in temperature and a
 * visible seam in the O/B end of the HR diagram.
 */
const MS_RADIUS_AT_20 = Math.pow(20, 0.57);

/**
 * Mass–radius on the main sequence. Massive stars are surprisingly compact.
 *
 * The exponents are the observed fits: R ∝ M^0.8 below 1 M☉ (degeneracy of the
 * envelope has not set in, but the star is fully convective and puffier than a
 * straight scaling), R ∝ M^0.57 through the radiative regime, and R ∝ M^0.5
 * above ~20 M☉ where radiation pressure inflates the envelope.
 */
function msRadius(mass: number): number {
  if (mass < 1) return Math.pow(mass, 0.8);
  if (mass < 20) return Math.pow(mass, 0.57);
  return MS_RADIUS_AT_20 * Math.pow(mass / 20, 0.5);
}

/**
 * Morgan–Keenan class from effective temperature. These seven boundaries are
 * the standard Harvard/MK divisions, not tuning knobs — 30000 / 10000 / 7500 /
 * 6000 / 5200 / 3700 K are where the defining absorption lines appear and
 * disappear (He II, He I, the hydrogen Balmer peak, Ca II H&K, the G band, TiO).
 * Sol at 5772 K lands in G with room to spare, which is the sanity check.
 * Degenerates never reach this function: WD, NS and BH are assigned directly.
 */
function classify(t: number): SpectralClass {
  if (t >= 30000) return 'O';
  if (t >= 10000) return 'B';
  if (t >= 7500) return 'A';
  if (t >= 6000) return 'F';
  if (t >= 5200) return 'G';
  if (t >= 3700) return 'K';
  return 'M';
}

/**
 * Sample one star from the present-day population at a point with the given
 * star-formation strength.
 *
 * The order matters: mass first (IMF), then age (young population only where
 * gas is collapsing), then ask whether it is still on the main sequence. A
 * star that failed the survival test is not re-rolled — it becomes its own
 * remnant, which is how white dwarfs end up at ~6% of the catalogue and
 * stellar-mass black holes at a few hundredths of a percent without anyone
 * writing those numbers down.
 */
function drawStar(rng: Rng, sfr: number): StarDraw {
  const mass = kroupaMass(rng);

  // No additive floor: a star out in the halo, where `sfr` is zero, is old
  // because there has been nothing out there to make a new one from since the
  // galaxy collapsed. The floor lives inside `starFormationAt` instead, where
  // it can be scaled by the galaxy's actual gas budget.
  const young = rng.chance(YOUNG_SFR_GAIN * clamp01(sfr));
  // Young ages skew hard towards zero (u³): star formation in an arm is a
  // continuous process but the arm has only been sitting on this gas for a
  // crossing time, so the sample is dominated by the most recent burst.
  // The old population starts at 1.5 Gyr, not 0: anything younger than that
  // belongs to the young population by definition, and letting the two overlap
  // would put O stars in the halo. 0.5 Gyr is the young population's ceiling —
  // long enough that a B star is still on the main sequence, short enough that
  // the 30 M☉ stars (τ = 2 Myr) are already dead unless they are very new.
  const age = young
    ? 0.5 * Math.pow(rng.next(), 3)
    : rng.range(1.5, GALAXY_AGE_GYR);

  const tau = msLifetimeGyr(mass);

  if (age <= tau) {
    // --- main sequence -----------------------------------------------------
    const lum = msLuminosity(mass);
    const rad = msRadius(mass);
    // Stefan–Boltzmann in solar units: L = R²(T/T☉)⁴. Nothing about a star's
    // colour is chosen here — it is forced by its mass, twice removed.
    const temp = SOLAR_TEFF * Math.pow(lum / (rad * rad), 0.25);
    return { mass, luminosity: lum, radius: rad, temperature: temp, spectralClass: classify(temp) };
  }

  // --- evolved / dead ------------------------------------------------------
  if (mass < 8) {
    if (rng.chance(GIANT_FRACTION)) {
      // Red giant branch: the envelope inflates ~50x while the core contracts,
      // so the surface cools to 3000-4800 K but luminosity climbs enormously.
      const rad = rng.power(10, 110, -1.6);
      const temp = rng.range(3100, 4900);
      const lum = rad * rad * Math.pow(temp / SOLAR_TEFF, 4);
      return {
        mass,
        luminosity: lum,
        radius: rad,
        temperature: temp,
        spectralClass: classify(temp),
      };
    }
    // White dwarf: Earth-sized, no fusion, cooling along a track that spends
    // most of its time cold — hence the steep power law towards low T.
    const temp = rng.power(3800, 40000, -1.8);
    const rad = 0.0084 * Math.pow(1 / Math.max(mass * 0.6, 0.2), 1 / 3); // M–R for degenerate matter
    const lum = rad * rad * Math.pow(temp / SOLAR_TEFF, 4);
    return { mass, luminosity: lum, radius: rad, temperature: temp, spectralClass: 'WD' };
  }

  if (mass < 25) {
    // Neutron star: 12 km across, still glowing at ~10^5-10^6 K from birth heat.
    const temp = rng.power(1e5, 1.2e6, -1.2);
    const rad = 1.72e-5; // 12 km in solar radii
    const lum = rad * rad * Math.pow(temp / SOLAR_TEFF, 4);
    return { mass, luminosity: lum, radius: rad, temperature: temp, spectralClass: 'NS' };
  }

  // Black hole. Zero photosphere; anything visible is an accretion disc, which
  // is the system generator's problem, not the catalogue's.
  return {
    mass,
    luminosity: 0,
    radius: 8.9e-6 * mass, // Schwarzschild radius in solar radii
    temperature: 0,
    spectralClass: 'BH',
  };
}

/**
 * A main-sequence star of a given mass, with nothing random about it.
 *
 * `drawStar` samples a *population*; this asks for one specific star. The
 * system generator needs it for companions, whose masses come from the mass
 * ratio distribution rather than from the IMF — and which must nonetheless sit
 * on the same mass–luminosity and mass–radius relations as everything else, or
 * a binary's secondary will not agree with a single star of identical mass.
 * Exported rather than duplicated in `gen/system.ts` for exactly that reason.
 */
export function mainSequenceStar(mass: number): StarDraw {
  const lum = msLuminosity(mass);
  const rad = msRadius(mass);
  const temp = SOLAR_TEFF * Math.pow(lum / (rad * rad), 0.25);
  return { mass, luminosity: lum, radius: rad, temperature: temp, spectralClass: classify(temp) };
}

/**
 * Re-derive the primary star of a stub, in full.
 *
 * `sampleSystemsNear` throws away everything about the primary except its
 * temperature and luminosity, because that is all the jump map draws. When the
 * player actually arrives, `gen/system.ts` needs the mass (it sets the orbital
 * periods and the multiplicity), the radius (it sets the disc on screen) and
 * the spectral class (it goes on the HUD) — and those must be the *same* star,
 * not a plausible one. So this replays the identical draw: same seed, same
 * three burnt position values, same star-formation rate read at the same point
 * of the same field. `star.temperature === stub.temperature` is therefore an
 * exact float equality, and `scripts/gen-smoke.mjs` asserts it.
 *
 * Pass `field` when generating several systems from one galaxy — `buildField`
 * is not memoised and is by far the most expensive part of this call.
 */
export function primaryStarFor(
  galaxy: GalaxySpec,
  stub: StarSystemStub,
  field?: GalaxyField,
): StarDraw {
  const f = field ?? buildField(galaxy);
  const rng = new Rng(stub.seed);
  // The three position draws `sampleSystemsNear` makes before it touches the
  // star. Burning them is what keeps the streams aligned.
  rng.next();
  rng.next();
  rng.next();
  return drawStar(rng, starFormationAt(f, stub.position[0], stub.position[1], stub.position[2]));
}

// ---------------------------------------------------------------------------
// generateGalaxy
// ---------------------------------------------------------------------------

const SHAPES: readonly GalaxyShape[] = [
  'spiral',
  'barred-spiral',
  'elliptical',
  'irregular',
  'ring',
];

/**
 * Shape weights. Two thirds of bright galaxies are discs and about two thirds
 * of *those* are barred (SDSS/Galaxy Zoo). Ring galaxies need a head-on
 * collision, so they are genuinely rare and should feel like a find.
 */
const SHAPE_WEIGHTS: readonly number[] = [26, 32, 17, 21, 4];

export function generateGalaxy(seed: number): GalaxySpec {
  const rng = rngFrom(seed, 'galaxy');
  const shape = rng.weighted(SHAPES, SHAPE_WEIGHTS);

  /**
   * Galaxy sizes follow a steep luminosity function — dwarfs outnumber giants
   * by orders of magnitude. alpha = -1.6 keeps the Milky Way (≈50,000 ly
   * radius) a large galaxy rather than an average one, which is correct.
   */
  let radiusLy = rng.power(9000, 95000, -1.6);
  if (shape === 'elliptical') radiusLy *= rng.range(1.1, 1.9); // cD ellipticals are monsters
  if (shape === 'irregular') radiusLy *= rng.range(0.35, 0.7); // irregulars are dwarfs
  radiusLy = Math.round(radiusLy);

  // Vertical structure. Discs are astonishingly thin: the Milky Way's thin
  // disc scale height is ~1000 ly against a 50,000 ly radius, ~1:50. Tightly
  // wound (high armTwist) discs are dynamically colder, hence thinner still.
  // Spanning the observed Hubble-type range (Sc/open to Sa/tight). alpha = -0.6
  // is a mild tilt towards the open end: open, flocculent discs are the more
  // common morphology, and they are also the ones where the arms read clearly
  // at map zoom, so biasing towards them costs nothing and shows more.
  const armTwistBase = rng.power(0.15, 0.45, -0.6);
  let thickness: number;
  switch (shape) {
    case 'elliptical':
      // Not a disc at all — this is the c/a of an E3–E6 spheroid, and
      // `rawDensity` only uses it as a scale hint since the de Vaucouleurs
      // branch gets its flattening from axisB/axisC instead.
      thickness = radiusLy * rng.range(0.35, 0.6);
      break;
    case 'irregular':
      // Dwarf irregulars are dynamically hot and puffy — the SMC is roughly as
      // deep as it is wide. 1:6 to 1:14 is the observed range.
      thickness = radiusLy * rng.range(0.07, 0.16);
      break;
    default:
      // Linear in armTwist across its full 0.15–0.45 range: 0.035 R for the
      // most open (dynamically hottest, ~1:29) down to 0.005 R for the most
      // tightly wound (~1:200). The Milky Way sits mid-range at ~1:50, which is
      // the anchor. The ±40% jitter stops every disc of a given twist from
      // having identical proportions.
      thickness = radiusLy * (0.035 - 0.03 * (armTwistBase - 0.15) / 0.3) * rng.range(0.7, 1.4);
  }

  // Arm count. Grand-design two-armed spirals dominate; odd counts require an
  // asymmetric perturber and are rare and beautiful when they happen.
  const armCount =
    shape === 'barred-spiral'
      ? rng.weighted([2, 4, 3], [78, 15, 7]) // bars almost always drive m=2
      : rng.weighted([2, 4, 3, 5, 6], [52, 24, 10, 9, 5]);

  let armTwist = armTwistBase;
  let armContrast: number;
  switch (shape) {
    case 'elliptical':
      armContrast = rng.range(0, 0.02);
      break;
    case 'irregular':
      armContrast = rng.range(0.02, 0.15); // flocculent at best
      break;
    case 'ring':
      armContrast = rng.range(0.25, 0.5);
      armTwist = rng.range(0.35, 0.5);
      break;
    case 'barred-spiral':
      // Bars funnel gas and sharpen the shock: barred spirals have the most
      // knife-edged arms in the sky (NGC 1300).
      armContrast = rng.power(0.35, 0.95, 0.6);
      break;
    default:
      armContrast = rng.power(0.2, 0.92, 0.2);
  }

  // Bulge fraction rises along the Hubble sequence and is ~1 for ellipticals.
  let bulgeFraction: number;
  switch (shape) {
    case 'elliptical':
      bulgeFraction = rng.range(0.9, 0.99);
      break;
    case 'irregular':
      bulgeFraction = rng.range(0.0, 0.06);
      break;
    case 'ring':
      bulgeFraction = rng.range(0.2, 0.4);
      break;
    case 'barred-spiral':
      // Bars are efficient at *not* building classical bulges.
      bulgeFraction = rng.power(0.04, 0.28, 0.4);
      break;
    default:
      bulgeFraction = rng.power(0.05, 0.45, -0.3);
  }

  /**
   * Point budget for the map view. Scales sub-linearly with area so a giant
   * elliptical does not cost 20x a dwarf — beyond ~200k points the eye reads
   * surface brightness, not individual stars, and the renderer's additive
   * blending is doing the work anyway.
   */
  const starCount = Math.round(
    clamp(48000 * Math.pow(radiusLy / 30000, 1.15) * rng.range(0.85, 1.2), 30000, 240000),
  );

  const palette = galaxyPalette(shape, rng, bulgeFraction);
  const id = `gx-${(seed >>> 0).toString(36)}`;
  const name = galaxyName(hashSeed(seed, 'galaxy-name'));

  // The nebula placer needs the finished geometry, so build a provisional spec
  // and hand it the field. Everything it reads is already final.
  const provisional: GalaxySpec = {
    id,
    seed: seed >>> 0,
    name,
    shape,
    radiusLy,
    thicknessLy: Math.round(thickness),
    armCount,
    armTwist,
    armContrast,
    bulgeFraction,
    starCount,
    coreColor: palette.core,
    armColor: palette.arm,
    dustColor: palette.dust,
    nebulae: [],
    blurb: '',
  };

  const nebulae = placeNebulae(provisional);
  const codex = galaxyBlurb({ ...provisional, nebulae });

  return { ...provisional, nebulae, blurb: codex };
}

interface Palette {
  readonly core: RGB;
  readonly arm: RGB;
  readonly dust: RGB;
}

/**
 * Galaxy colours are integrated stellar populations, not choices.
 * The bulge is old — a K/M giant population, ~4000 K, amber. The arms are the
 * handful of surviving O/B stars, which outshine everything around them, so an
 * arm's integrated colour sits near 9000-14000 K even though 99.9% of the
 * stars in it are red dwarfs. Dust is the arm light run through the extinction
 * law, which is why dust lanes read warm brown against a cool blue disc.
 */
function galaxyPalette(shape: GalaxyShape, rng: Rng, bulgeFraction: number): Palette {
  let coreT: number;
  let armT: number;
  switch (shape) {
    case 'elliptical':
      // Nothing young left anywhere. Red and dead, edge to edge.
      coreT = rng.range(3700, 4300);
      armT = rng.range(4200, 5200);
      break;
    case 'irregular':
      // Low metallicity + violent starburst: the bluest galaxies in the sky.
      coreT = rng.range(6000, 8000);
      armT = rng.range(13000, 20000);
      break;
    case 'ring':
      // Hoag's object exactly: a dead yellow nucleus inside a blue-white ring.
      coreT = rng.range(4200, 5000);
      armT = rng.range(11000, 16000);
      break;
    default:
      coreT = rng.range(3900, 4900);
      armT = rng.range(8500, 14500);
  }

  const core = scaleRgb(blackbodyColor(coreT), rng.range(0.85, 1.0));
  const arm = blackbodyColor(armT);

  // Optical depth of the dust lane. Gas-rich late types are filthy; ellipticals
  // are nearly dust-free, so their "dust" colour is a faint warm haze.
  const tau = shape === 'elliptical' ? rng.range(0.15, 0.4) : rng.range(0.9, 2.1);
  // What the dust is lit BY. A dust lane is not self-luminous; it scatters the
  // integrated light of the disc around it, which is a blend of the young arm
  // population and the old bulge population weighted by how bulge-dominated the
  // galaxy is. Starting at 0.55 (already core-leaning, because dust sits in the
  // inner disc where the old population lives) and climbing with bulgeFraction.
  const dustBase = mixRgb(arm, core, 0.55 + bulgeFraction * 0.3);
  // Dust is seen in silhouette and in scattered light, never at full intensity —
  // half to nine tenths of the surface brightness it is standing in front of.
  const dust = scaleRgb(redden(dustBase, tau), rng.range(0.5, 0.9));

  return { core, arm, dust };
}

// ---------------------------------------------------------------------------
// Nebulae
// ---------------------------------------------------------------------------

type NebulaKind = NebulaSpec['kind'];

const NEBULA_KINDS: readonly NebulaKind[] = [
  'emission',
  'reflection',
  'dark',
  'planetary',
  'supernova-remnant',
];

/**
 * Which nebulae a galaxy can have is a gas-content question. Spirals are full
 * of H II regions; ellipticals have essentially no cold gas, so what you find
 * there is the leftovers of dying stars — planetaries and supernova remnants.
 */
function nebulaWeights(shape: GalaxyShape): readonly number[] {
  switch (shape) {
    case 'elliptical':
      return [0.2, 0.5, 1.0, 5.0, 2.0];
    case 'irregular':
      return [7.0, 2.0, 2.0, 0.5, 2.0];
    case 'ring':
      return [4.0, 2.0, 2.0, 1.0, 1.5];
    default:
      return [5.0, 3.0, 4.0, 1.0, 1.5];
  }
}

/** Radius as a fraction of the galaxy radius: [min, max]. */
function nebulaSizeRange(kind: NebulaKind): readonly [number, number] {
  // These are complexes, not single objects: the Orion Nebula is 12 ly across
  // but the Orion molecular cloud it sits in is 400, and the Gould Belt that
  // spawned both is 3000. At galaxy-map scale the complex is the visible unit.
  switch (kind) {
    case 'emission':
      return [0.010, 0.045];
    case 'reflection':
      return [0.006, 0.020];
    case 'dark':
      return [0.012, 0.050];
    case 'planetary':
      return [0.0008, 0.0030];
    case 'supernova-remnant':
      return [0.0040, 0.0160];
  }
}

/**
 * Nebula colour is emission-line physics, one line per kind:
 *   emission  — Hα 656 nm ionised hydrogen, with [O III] 501 nm in the core
 *   reflection— starlight Rayleigh-scattered off dust grains, so blue
 *   dark      — absorption only; nearly black, faintly rust from reddening
 *   planetary — [O III] dominated, a hard teal, with [N II] red in the shell
 *   supernova — synchrotron blue-violet plus shocked [S II] orange filaments
 */
function nebulaColors(kind: NebulaKind, rng: Rng): { color: RGB; accent: RGB } {
  const j = (v: number, amount = 0.08): number => clamp01(v + rng.gaussian(0, amount));
  switch (kind) {
    case 'emission':
      return {
        color: srgbTriplet(j(0.87), j(0.19), j(0.27)),
        accent: srgbTriplet(j(0.10), j(0.63), j(0.56)),
      };
    case 'reflection':
      return {
        color: srgbTriplet(j(0.24), j(0.41), j(0.80)),
        accent: srgbTriplet(j(0.62), j(0.52), j(0.36)),
      };
    case 'dark':
      return {
        color: srgbTriplet(j(0.10, 0.03), j(0.08, 0.03), j(0.09, 0.03)),
        accent: srgbTriplet(j(0.26), j(0.15), j(0.10)),
      };
    case 'planetary':
      return {
        color: srgbTriplet(j(0.17), j(0.73), j(0.66)),
        accent: srgbTriplet(j(0.74), j(0.23), j(0.20)),
      };
    case 'supernova-remnant':
      return {
        color: srgbTriplet(j(0.35), j(0.56), j(0.88)),
        accent: srgbTriplet(j(0.86), j(0.46), j(0.15)),
      };
  }
}

/**
 * Opacity/emissivity the volumetric renderer marches, 0..1. Ordered by how
 * optically thick the real object is: a dark cloud is by definition the thickest
 * thing on this list (it is only visible as an absence), an H II region is dense
 * and self-luminous, a reflection nebula is thin dust lit from outside, and a
 * planetary or a supernova remnant is a shell of gas expanding into vacuum —
 * bright in line emission but almost transparent along any given ray.
 */
function nebulaDensity(kind: NebulaKind, rng: Rng): number {
  switch (kind) {
    case 'emission':
      return rng.range(0.55, 0.9);
    case 'reflection':
      return rng.range(0.18, 0.45);
    case 'dark':
      return rng.range(0.7, 1.0);
    case 'planetary':
      return rng.range(0.3, 0.6);
    case 'supernova-remnant':
      return rng.range(0.22, 0.5);
  }
}

/**
 * Place 3-6 nebulae ON the star-forming structure — the arms of a spiral, the
 * ring of a ring galaxy, the clusters of an irregular. A nebula floating in
 * the interarm void would be a tell that the galaxy is fake: molecular clouds
 * collapse where the density wave squeezes them, and nowhere else.
 */
function placeNebulae(g: GalaxySpec): readonly NebulaSpec[] {
  const rng = rngFrom(g.seed, 'nebulae');
  const f = buildField(g);
  const weights = nebulaWeights(g.shape);
  const count = rng.int(3, 6);
  const out: NebulaSpec[] = [];

  for (let i = 0; i < count; i++) {
    const kind = rng.weighted(NEBULA_KINDS, weights);
    const seed = hashSeed(g.seed, `nebula:${i}`);
    const sub = new Rng(seed);
    const pos = placeOnStructure(f, sub, kind);

    const [lo, hi] = nebulaSizeRange(kind);
    // Nebula sizes are power-law like everything else in a turbulent ISM:
    // one Carina, several Orions, and a scatter of little knots.
    const radiusLy = Math.max(4, g.radiusLy * sub.power(lo, hi, -1.8));
    const { color, accent } = nebulaColors(kind, sub);

    out.push({
      id: `${g.id}-neb-${i}`,
      seed,
      name: nebulaName(hashSeed(seed, 'name')),
      position: pos,
      radiusLy,
      color,
      accentColor: accent,
      density: nebulaDensity(kind, sub),
      kind,
    });
  }
  return out;
}

/**
 * Find a point sitting on the galaxy's star-forming structure. Rather than
 * rejection-sample the whole volume (slow, and biased towards wherever the
 * field happens to be brightest), invert the spiral directly: pick a radius,
 * pick an arm, then *solve* for the azimuth that puts you on it.
 */
function placeOnStructure(f: GalaxyField, rng: Rng, kind: NebulaKind): Vec3 {
  // Planetary nebulae come from ordinary old stars, so they track the general
  // stellar population rather than the arms — including the bulge.
  const followsGas = kind !== 'planetary';

  if (!followsGas || f.shape === 'elliptical') {
    // Track the old population: a shallow power law out to 1.6 effective radii,
    // which is where the r^(1/4) profile still holds most of its light.
    const dir = rng.onSphere();
    const r = f.effRadius * rng.power(0.05, 1.6, -1.2);
    // Flattening: an elliptical's own c/a, but a *disc* galaxy's planetaries sit
    // in the disc, so they get squashed to 0.15 — otherwise a spiral ends up
    // with a spherical halo of planetary nebulae, which reads as a bug on the
    // map long before anyone works out why.
    return [dir[0] * r, dir[1] * r * (f.shape === 'elliptical' ? f.axisC : 0.15), dir[2] * r];
  }

  if (f.shape === 'irregular' && f.clumps.length > 0) {
    const c = rng.weighted(f.clumps, f.clumps.map((k) => k.weight));
    return [
      c.x + rng.gaussian(0, c.radius * 0.55),
      c.y + rng.gaussian(0, c.radius * 0.3),
      c.z + rng.gaussian(0, c.radius * 0.55),
    ];
  }

  if (f.shape === 'ring') {
    const th = rng.range(0, Math.PI * 2);
    const r = f.ringRadius + rng.gaussian(0, f.ringWidth * 0.8);
    return [Math.cos(th) * r, rng.gaussian(0, f.scaleHeight * 0.7), Math.sin(th) * r];
  }

  // Spiral / barred: star formation peaks in the molecular ring at ~0.2-0.6 R
  // and dies out past the gas truncation radius.
  const r = f.radius * rng.range(0.18, 0.78);
  const arm = rng.int(0, Math.max(0, f.armCount - 1));
  const spiralTheta =
    Math.log(Math.max(r, f.armStart * 0.25) / f.armStart) / f.tanPitch +
    f.barAngle +
    (arm * 2 * Math.PI) / f.armCount;
  // Scatter of a few degrees puts it inside the arm's width, not on its centreline.
  const theta = spiralTheta + rng.gaussian(0, 0.13);
  return [
    Math.cos(theta) * r,
    rng.gaussian(0, f.scaleHeight * 0.5),
    Math.sin(theta) * r,
  ];
}

// ---------------------------------------------------------------------------
// Blurb
// ---------------------------------------------------------------------------

/**
 * Codex flavour. The prose voice lives in `gen/names.ts` so that every module
 * writes in the same register; this function's only job is to hand it the facts.
 *
 * The star count reported to the codex is the *real* stellar population, not
 * `spec.starCount` — that is a rendering budget and has no business in the
 * science readout. Galaxy mass scales roughly as R^2.3 across the luminosity
 * function, anchored on the Milky Way: 50,000 ly of radius, 10^11 stars.
 */
function galaxyBlurb(g: GalaxySpec): string {
  const trueStarCount = Math.round(1.0e11 * Math.pow(g.radiusLy / 50000, 2.3));
  return blurb(hashSeed(g.seed, 'galaxy-blurb'), 'galaxy', {
    shape: g.shape,
    stars: trueStarCount,
    nebulae: g.nebulae.length,
    radiusLy: g.radiusLy,
  });
}

// ---------------------------------------------------------------------------
// Star field
// ---------------------------------------------------------------------------

/**
 * Build the point cloud for the galaxy map.
 *
 * PACKING — 5 floats per star, tightly interleaved, stride 5:
 *
 *   [i*5 + 0]  x   galaxy-local, light years
 *   [i*5 + 1]  y   galaxy-local, light years (galactic north)
 *   [i*5 + 2]  z   galaxy-local, light years
 *   [i*5 + 3]  brightness  0..1, normalised log luminosity.
 *                          Recover solar luminosities with L = 10^(b*9 - 4),
 *                          i.e. b=0 is 1e-4 L☉ (a cold white dwarf) and b=1 is
 *                          1e5 L☉ (a blue supergiant). Stored logarithmically
 *                          because the real range spans nine decades and a
 *                          linear float32 attribute would quantise every dwarf
 *                          in the galaxy to zero.
 *   [i*5 + 4]  temperature kelvin, 0 for black holes. Feed straight to
 *                          `os_blackbody` — do not pre-convert to colour, the
 *                          shader needs the temperature for limb and bloom tint.
 *
 * The array is exactly `count * 5` long. Black holes are emitted with
 * brightness 0 and temperature 0 so the renderer can discard them cheaply, but
 * they keep their slot so indices stay stable across calls.
 *
 * NOTE TO THE RENDERER — this one matters. Three quarters of these points are
 * M dwarfs sitting at b ≈ 0.2, and the handful of O/B stars at b ≈ 1 carry a
 * quarter to a half of the galaxy's entire light output. Drive point size and
 * HDR intensity from the *decoded* luminosity (or at least from a steep curve
 * such as pow(b, 6)), never from `b` linearly. Used linearly, b compresses a
 * nine-decade range into a 5:1 ratio and the map turns into a uniform red haze
 * with no arms, no core and nothing to look at.
 */
export function generateStarField(galaxy: GalaxySpec, count: number): Float32Array {
  const out = new Float32Array(Math.max(0, count) * 5);
  if (count <= 0) return out;

  const f = buildField(galaxy);
  const rng = rngFrom(galaxy.seed, 'starfield');
  const cdf = needsRadialCdf(f.shape) ? buildRadialCdf(f) : null;

  for (let i = 0; i < count; i++) {
    const p = samplePosition(f, rng, cdf);
    const sfr = starFormationAt(f, p[0], p[1], p[2]);
    const star = drawStar(rng, sfr);

    const o = i * 5;
    out[o] = p[0];
    out[o + 1] = p[1];
    out[o + 2] = p[2];
    out[o + 3] = star.luminosity > 0 ? clamp01((Math.log10(star.luminosity) + 4) / 9) : 0;
    out[o + 4] = star.temperature;
  }
  return out;
}

function needsRadialCdf(shape: GalaxyShape): boolean {
  return shape === 'elliptical' || shape === 'ring';
}

/**
 * Bins in the tabulated radial CDF. The inverse is linearly interpolated inside
 * a bin, so the error is second order in the bin width; 192 bins across 1.4 R
 * puts a bin at ~0.7% of the radius, which is finer than the sharpest feature
 * either profile has (a ring's width is ~7-15% of its radius) and well under
 * the point size the map draws. Doubling it changes the sampled profile by less
 * than the shot noise of a 200k-star field.
 */
const CDF_BINS = 192;

/**
 * How far out to tabulate, as a multiple of the optical radius. Both profiles
 * this is used for have real light beyond `radius` — the de Vaucouleurs law has
 * a long r^(1/4) tail and a ring galaxy's outer edge sits at ~0.74 R plus its
 * own width — so truncating at 1.0 R would shear the halo off flat. 1.4 R is
 * where the de Vaucouleurs profile has fallen below 1e-3 of its peak.
 */
const CDF_R_MAX_FACTOR = 1.4;

/**
 * Tabulate the cumulative radial mass profile so we can importance-sample the
 * radius by inverting it. Needed for the de Vaucouleurs and ring profiles,
 * which have no closed-form inverse; the exponential disc does (see below) and
 * skips this entirely.
 */
function buildRadialCdf(f: GalaxyField): Float64Array {
  const cdf = new Float64Array(CDF_BINS + 1);
  const rMax = f.radius * CDF_R_MAX_FACTOR;
  // An elliptical is sampled as a scaled sphere, so its profile is already a
  // function of one radius and must be read along a single axis. A ring is
  // sampled in cylindrical coordinates, so its radial profile has to be the
  // azimuthal *average* — reading one spoke would bake that spoke's knot
  // brightness into the radial distribution.
  const spokes = f.shape === 'elliptical' ? 1 : 8;
  let acc = 0;
  for (let i = 1; i <= CDF_BINS; i++) {
    const r = (i / CDF_BINS) * rMax;
    // Shell weighting: r² for a 3D spheroid, r for a 2D annulus.
    const shell = f.shape === 'elliptical' ? r * r : r;
    let mean = 0;
    for (let s = 0; s < spokes; s++) {
      const th = (s / spokes) * Math.PI * 2;
      mean += rawDensity(f, Math.cos(th) * r, 0, Math.sin(th) * r);
    }
    acc += (mean / spokes) * shell;
    cdf[i] = acc;
  }
  if (acc > 0) for (let i = 0; i <= CDF_BINS; i++) cdf[i] /= acc;
  return cdf;
}

function sampleRadialCdf(cdf: Float64Array, rMax: number, u: number): number {
  let lo = 0;
  let hi = CDF_BINS;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid]! < u) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const c0 = cdf[i - 1]!;
  const c1 = cdf[i]!;
  const t = c1 > c0 ? (u - c0) / (c1 - c0) : 0;
  return ((i - 1 + t) / CDF_BINS) * rMax;
}

/**
 * Draw one star position from the density field.
 *
 * Rejection sampling the full 3D field would be catastrophically inefficient —
 * an exponential disc puts 99% of its volume in the low-density outskirts, so
 * you would reject hundreds of times per star. Instead each factor of the
 * field is sampled by the cheapest exact method available, and rejection is
 * used *only* on the arm modulation, which is bounded in [1-c, 1] and
 * therefore accepts in ~2 tries.
 */
function samplePosition(f: GalaxyField, rng: Rng, cdf: Float64Array | null): Vec3 {
  switch (f.shape) {
    case 'elliptical': {
      const r = sampleRadialCdf(cdf!, f.radius * CDF_R_MAX_FACTOR, rng.next());
      const d = rng.onSphere();
      return [d[0] * r, d[1] * r * f.axisC, d[2] * r * f.axisB];
    }

    case 'ring': {
      const r = sampleRadialCdf(cdf!, f.radius * CDF_R_MAX_FACTOR, rng.next());
      // Azimuth by rejection against the knot pattern (bounded 0.2..1).
      let theta = 0;
      for (let t = 0; t < 8; t++) {
        theta = rng.range(0, Math.PI * 2);
        const knots = 0.6 + 0.4 * Math.cos(f.armCount * (theta - f.barAngle));
        if (rng.next() < knots) break;
      }
      return [Math.cos(theta) * r, sampleSech2Height(f.scaleHeight, rng), Math.sin(theta) * r];
    }

    case 'irregular': {
      if (f.shareClumps > 0 && rng.chance(f.shareClumps)) {
        const c = rng.weighted(f.clumps, f.clumps.map((k) => k.weight));
        return [
          c.x + rng.gaussian(0, c.radius * 0.5),
          c.y + rng.gaussian(0, c.radius * 0.32),
          c.z + rng.gaussian(0, c.radius * 0.5),
        ];
      }
      // 1.5x scale length and 1.8x scale height mirror `rawDensity`'s irregular
      // branch exactly; 1.3 R truncates the tail (see the sampler's docblock).
      const r = sampleExponentialDiscRadius(f.scaleLength * 1.5, rng, f.radius * 1.3);
      const th = rng.range(0, Math.PI * 2);
      return [
        f.offsetX + Math.cos(th) * r,
        sampleSech2Height(f.scaleHeight * 1.8, rng),
        f.offsetZ + Math.sin(th) * r,
      ];
    }

    default: {
      const u = rng.next();
      const bulgeCut = f.shareBulge;
      const barCut = bulgeCut + f.shareBar;

      if (u < bulgeCut) {
        // Three independent normals *is* the triaxial gaussian. Sampling a
        // direction and then |N(0,σ)| along it is a different distribution
        // entirely — it piles stars at the centre and starves the outskirts.
        return [
          rng.gaussian(0, f.bulgeRadius),
          rng.gaussian(0, f.bulgeRadius * f.bulgeFlatten),
          rng.gaussian(0, f.bulgeRadius),
        ];
      }

      if (u < barCut) {
        // Flat-topped along the bar, gaussian across it. The |u| profile has no
        // usable inverse CDF, but it is bounded by 1, so plain rejection over a
        // slightly oversized interval accepts about two thirds of the time.
        let uu = 0;
        for (let t = 0; t < 16; t++) {
          uu = rng.range(-1.45, 1.45) * f.barLength;
          if (rng.next() < Math.exp(-Math.pow(Math.abs(uu) / f.barLength, 3.5))) break;
        }
        // exp(-(v/w)²) is a gaussian of standard deviation w/√2, not w.
        const vv = rng.gaussian(0, f.barWidth * Math.SQRT1_2);
        // Rotate bar-aligned (u, v) back into galaxy coordinates. This must be
        // the *inverse* of the rotation in rawDensity — get the sign wrong and
        // the bar sits mirrored across the arms it is supposed to launch.
        const ca = Math.cos(f.barAngle);
        const sa = Math.sin(f.barAngle);
        return [
          uu * ca - vv * sa,
          sampleSech2Height(f.scaleHeight * 1.5, rng),
          uu * sa + vv * ca,
        ];
      }

      // 1.15 R is where the disc is considered to end. It matches the outer
      // edge of `armDamping`'s truncation, so no star is placed in a region the
      // arm term has already faded out of.
      const r = sampleExponentialDiscRadius(f.scaleLength, rng, f.radius * 1.15);
      const y = sampleSech2Height(f.scaleHeight, rng);

      /**
       * Azimuth as a two-component mixture rather than rejection over the whole
       * circle. At this (r, y) the disc contributes a flat 1 and the arms
       * contribute armGain·damping·armMean once integrated round the circle, so
       * that ratio is exactly the probability the star belongs to an arm. Then
       * we place it on a specific arm by *solving* the spiral for its azimuth.
       *
       * Rejection over the full azimuth would also be correct, but its
       * acceptance rate collapses as the arms sharpen, and the bail-out after N
       * tries silently re-uniformises exactly the galaxies with the strongest
       * arms — which is how a grand-design spiral ends up looking like a disc.
       */
      const excess = f.armGain * armDamping(f, r, y) * f.armMean;
      let theta: number;
      if (excess > 1e-6 && rng.chance(excess / (1 + excess))) {
        const phi = sampleArmPhase(f, rng);
        const arm = rng.int(0, f.armCount - 1);
        theta = armRidgeAzimuth(f, r) + (phi + 2 * Math.PI * arm) / f.armCount;
      } else {
        theta = rng.range(0, Math.PI * 2);
      }
      return [Math.cos(theta) * r, y, Math.sin(theta) * r];
    }
  }
}

/**
 * Offset from an arm's ridge line, in units where the arm repeats every 2π.
 * The profile is ((1 + cos φ)/2)^k with a maximum of exactly 1 at φ = 0, so
 * plain rejection works and accepts at rate `armMean` (~22% for a sharp arm).
 * On the rare bail-out we snap to the ridge rather than falling back to a
 * uniform azimuth: the bias is then towards the structure instead of away
 * from it, which is the difference between a blurred arm and no arm.
 */
function sampleArmPhase(f: GalaxyField, rng: Rng): number {
  for (let t = 0; t < 24; t++) {
    const phi = rng.range(-Math.PI, Math.PI);
    if (rng.next() < Math.pow(0.5 + 0.5 * Math.cos(phi), f.armSharp)) return phi;
  }
  return 0;
}

/**
 * Radius of a star in an exponential disc, exactly.
 * The 2D radial pdf is p(r) ∝ r·e^(-r/L), which is Gamma(shape=2, scale=L),
 * and a Gamma with integer shape 2 is just the sum of two exponentials:
 * r = -L·(ln u1 + ln u2). No rejection, no table, exact.
 *
 * `rMax` truncates the infinite tail. Callers pass ~1.15-1.3 R with L = R/4, so
 * the cut is at 4.6-5.2 scale lengths where the Gamma(2) survival function is
 * ~3% — a real number of stars, which is why they are re-drawn rather than
 * clamped to the edge (clamping would build a bright rim at exactly rMax). Six
 * attempts drives the failure rate under 1e-9; the final uniform fallback is
 * unreachable in practice and exists only so the function always terminates.
 */
function sampleExponentialDiscRadius(scaleLength: number, rng: Rng, rMax: number): number {
  for (let i = 0; i < 6; i++) {
    const u1 = Math.max(rng.next(), 1e-12);
    const u2 = Math.max(rng.next(), 1e-12);
    const r = -scaleLength * (Math.log(u1) + Math.log(u2));
    if (r <= rMax) return r;
  }
  return rMax * rng.next();
}

/**
 * Height in a self-gravitating isothermal sheet, exactly.
 * p(z) ∝ sech²(z/h) integrates to ½(1 + tanh(z/h)), so z = h·atanh(2u - 1).
 */
function sampleSech2Height(h: number, rng: Rng): number {
  const u = clamp(rng.next(), 1e-9, 1 - 1e-9);
  return h * Math.atanh(2 * u - 1);
}

/**
 * Extra stellar mass the arms add on top of the smooth exponential disc.
 *
 * The term separates cleanly — armGain·armMean carries the azimuth, and what
 * is left is a radial integral of the damping against the disc profile and a
 * vertical integral of the two sech² layers against each other. Both are done
 * numerically because the damping is a pair of smoothsteps with no closed
 * form, but 48 evaluations is nothing next to the thousands of stars this
 * number then places correctly.
 */
function armMassOf(f: GalaxyField): number {
  if (f.armGain <= 0 || f.armContrast <= 0.001) return 0;

  // 1.3 R: `armDamping`'s outer smoothstep has reached zero by 1.15 R, so this
  // integrates over the whole support with margin. 32 midpoint samples is
  // ample — the integrand is a single smooth hump, and the answer only has to
  // be good enough to split a star budget between three components.
  const rMax = f.radius * 1.3;
  let radial = 0;
  for (let i = 0; i < 32; i++) {
    const r = ((i + 0.5) / 32) * rMax;
    const damp =
      smoothstep(f.armStart * 0.7, f.armStart * 1.8, r) *
      (1 - smoothstep(f.radius * 0.85, f.radius * 1.15, r));
    radial += Math.exp(-r / f.scaleLength) * damp * 2 * Math.PI * r * (rMax / 32);
  }

  // sech²(y/h)·sech²(y/0.55h) is down by ~3e-4 at 4h, so the truncated tail is
  // far below the accuracy this budget split needs.
  const yMax = f.scaleHeight * 4;
  let vertical = 0;
  for (let j = 0; j < 16; j++) {
    const y = ((j + 0.5) / 16) * yMax;
    // Doubled for the symmetric negative half.
    vertical += 2 * sech2(y / f.scaleHeight) * sech2(y / (f.scaleHeight * 0.55)) * (yMax / 16);
  }

  return f.armGain * f.armMean * radial * vertical;
}

/**
 * Analytic mass of the bar term, for the same budget split:
 *   ∫exp(-|u/a|^3.5)du · ∫exp(-(v/b)²)dv · ∫sech²(y/h)dy
 *   = 2a·Γ(1 + 1/3.5) · b√π · 2h  ≈  2a(0.8997) · b(1.7725) · 2h
 */
function barMassOf(f: GalaxyField): number {
  if (f.barAmp <= 0) return 0;
  return f.barAmp * 2 * f.barLength * 0.8997 * f.barWidth * 1.7725 * 2 * (f.scaleHeight * 1.5);
}

// ---------------------------------------------------------------------------
// The navigable catalogue — deterministic spatial hash
// ---------------------------------------------------------------------------

/**
 * Grid cell edge, light years. Chosen against real local stellar density
 * (~0.004 stars/ly³ near Sol, mean separation 6.3 ly): a 14 ly cell holds ~11
 * systems out here, so a 40 ly jump-range query touches ~7³ cells and evaluates
 * a few hundred systems — comfortably inside a frame budget, and small enough
 * that the corner-distance cull actually rejects most of the shell.
 */
const CELL_LY = 14;

/**
 * Stars per cubic light year where the normalised density field reads 1.0.
 * Calibrated so the mid-disc (field ≈ 0.1) lands on the real solar-neighbourhood
 * value of 0.004/ly³. The core is compressed relative to reality — the true
 * nuclear star cluster is ~10^6 times denser than the disc and would be an
 * unnavigable solid — so the field is read at a power below 1 there.
 */
const DENSITY_SCALE = 0.04;

/** Hard cap per cell. Stops core queries from allocating tens of thousands. */
const MAX_PER_CELL = 40;

/**
 * The seed of the `index`-th system in grid cell (cellX, cellY, cellZ).
 *
 * This is the only identity a star system has. Everything about it — position
 * within the cell, spectral type, planets, the name on the HUD — is derived
 * from this number, so nothing is ever stored and the same cell always yields
 * the same sky. `gen/system.ts` takes this seed directly.
 */
export function systemSeedAt(
  galaxy: GalaxySpec,
  cellX: number,
  cellY: number,
  cellZ: number,
  index: number,
): number {
  return hashSeed(hash3(cellX, cellY, cellZ, galaxy.seed), index);
}

/**
 * Cell occupancy uses its own hash stream so it cannot alias with star seeds.
 * The XOR constant is an arbitrary fixed 32-bit nothing-up-my-sleeve value; its
 * only job is to make `cellCountSeed` and `systemSeedAt` decorrelated views of
 * the same cell. Any constant with a well-mixed bit pattern works, but it must
 * never change: it is baked into which systems exist in every saved galaxy.
 */
function cellCountSeed(galaxy: GalaxySpec, cx: number, cy: number, cz: number): number {
  return hash3(cx, cy, cz, (galaxy.seed ^ 0x5bf03635) >>> 0);
}

/**
 * Poisson draw. Stars are not laid out on a lattice — the count in a cell
 * fluctuates, and that fluctuation is what stops the jump map from looking
 * like graph paper. Knuth's product method below λ=30, normal approximation
 * above (where the product underflows float64 and the two agree to <1%).
 */
function poisson(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda < 30) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= rng.next();
    } while (p > L && k < 400);
    return k - 1;
  }
  return Math.max(0, Math.round(rng.gaussian(lambda, Math.sqrt(lambda))));
}

/**
 * Every system within `radiusLy` of `position`, nearest first, capped at `max`.
 *
 * O(cells in range), not O(stars in galaxy) — the jump map calls this every
 * frame while the player drags the cursor. There is no cache and no stored
 * state: the same galaxy and the same cell always produce the same systems,
 * on any machine, forever.
 */
export function sampleSystemsNear(
  galaxy: GalaxySpec,
  position: Vec3,
  radiusLy: number,
  max: number,
): StarSystemStub[] {
  if (max <= 0 || radiusLy <= 0) return [];

  /**
   * Candidates carry only what the distance sort needs. Spectral type, colour
   * and name are the expensive part — a dozen `pow` calls and a string build
   * each — so they are deferred until after the sort, at which point we do the
   * work for `max` systems instead of the several thousand inside the sphere.
   * The seed is what makes that safe: a system's identity does not depend on
   * when we get around to evaluating it.
   */
  const found: Array<{ cx: number; cy: number; cz: number; i: number; x: number; y: number; z: number; d2: number }> =
    [];

  const f = buildField(galaxy);
  let cutoff2 = radiusLy * radiusLy;
  /**
   * Once we hold comfortably more than `max` candidates we can prove that
   * anything farther than the current max-th nearest is dead, so we sort,
   * discard the tail, and tighten the search radius. In the galactic core this
   * turns a 60 ly query from "every cell in the box" into "the few dozen cells
   * that actually reach", and it cannot change the answer — only candidates
   * already beaten by `max` closer ones are ever dropped.
   */
  const pruneAt = max * 4;

  const minX = Math.floor((position[0] - radiusLy) / CELL_LY);
  const maxX = Math.floor((position[0] + radiusLy) / CELL_LY);
  const minY = Math.floor((position[1] - radiusLy) / CELL_LY);
  const maxY = Math.floor((position[1] + radiusLy) / CELL_LY);
  const minZ = Math.floor((position[2] - radiusLy) / CELL_LY);
  const maxZ = Math.floor((position[2] + radiusLy) / CELL_LY);

  for (let cx = minX; cx <= maxX; cx++) {
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        // Cull by the cell's nearest corner: the bounding box of a sphere has
        // ~48% of its cells entirely outside the sphere.
        if (cellNearestDistance2(cx, cy, cz, position) > cutoff2) continue;

        const ox = cx * CELL_LY;
        const oy = cy * CELL_LY;
        const oz = cz * CELL_LY;
        const mid = densityAt(f, ox + CELL_LY * 0.5, oy + CELL_LY * 0.5, oz + CELL_LY * 0.5);
        if (mid <= 1e-5) continue;

        // Compress the core: density^0.75 keeps the gradient legible without
        // making the nucleus a wall of unreachable systems.
        const lambda = Math.pow(mid, 0.75) * DENSITY_SCALE * CELL_LY * CELL_LY * CELL_LY;
        const countRng = new Rng(cellCountSeed(galaxy, cx, cy, cz));
        const n = Math.min(MAX_PER_CELL, poisson(countRng, lambda));

        for (let i = 0; i < n; i++) {
          const srng = new Rng(systemSeedAt(galaxy, cx, cy, cz, i));
          const px = ox + srng.next() * CELL_LY;
          const py = oy + srng.next() * CELL_LY;
          const pz = oz + srng.next() * CELL_LY;

          const dx = px - position[0];
          const dy = py - position[1];
          const dz = pz - position[2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > cutoff2) continue;

          found.push({ cx, cy, cz, i, x: px, y: py, z: pz, d2 });
        }

        if (found.length >= pruneAt) {
          found.sort((a, b) => a.d2 - b.d2);
          found.length = max;
          cutoff2 = found[max - 1]!.d2;
        }
      }
    }
  }

  found.sort((a, b) => a.d2 - b.d2);
  if (found.length > max) found.length = max;

  return found.map((c) => {
    const seed = systemSeedAt(galaxy, c.cx, c.cy, c.cz, c.i);
    const srng = new Rng(seed);
    // Burn the three position draws so the stream lines up with the pass above
    // — the star must come from the same point in the sequence either way.
    srng.next();
    srng.next();
    srng.next();
    const star = drawStar(srng, starFormationAt(f, c.x, c.y, c.z));
    return {
      id: `${galaxy.id}-${c.cx}.${c.cy}.${c.cz}.${c.i}`,
      seed,
      name: systemName(hashSeed(seed, 'name')),
      position: [c.x, c.y, c.z] as Vec3,
      temperature: star.temperature,
      luminosity: star.luminosity,
    };
  });
}

/** Squared distance from a point to the nearest point of a grid cell. */
function cellNearestDistance2(cx: number, cy: number, cz: number, p: Vec3): number {
  const nx = axisGap(cx * CELL_LY, p[0]);
  const ny = axisGap(cy * CELL_LY, p[1]);
  const nz = axisGap(cz * CELL_LY, p[2]);
  return nx * nx + ny * ny + nz * nz;
}

function axisGap(cellMin: number, v: number): number {
  if (v < cellMin) return cellMin - v;
  const cellMax = cellMin + CELL_LY;
  return v > cellMax ? v - cellMax : 0;
}
