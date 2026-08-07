/**
 * oneSpace — star system, planet and moon generation.
 *
 * This is the third link in the generation chain and the only one the player
 * ever lands on:
 *
 *   generateGalaxy(seed)          -> GalaxySpec        (gen/galaxy.ts)
 *   sampleSystemsNear(galaxy, ..) -> StarSystemStub[]  (gen/galaxy.ts)
 *   generateSystem(galaxy, stub)  -> StarSystemSpec    (here)
 *   generatePlanet(ctx)           -> PlanetSpec        (here)
 *   sampleTerrain(spec.terrain, spec.seed, dir)        (gen/terrain.ts)
 *
 * SEEDS FLOW DOWNWARD, ALWAYS
 * Nothing in this file invents a seed. A system's identity is `stub.seed`,
 * which `systemSeedAt` derived from the galaxy seed and a grid cell; a planet's
 * seed is `hashSeed(system.seed, 'planet:<index>')`; a moon's is
 * `hashSeed(planet.seed, 'moon:<index>')`. That chain is what makes the
 * universe reproducible top-down: given one 32-bit number you can re-derive a
 * specific crater on a specific moon, on any machine, without storing a byte.
 *
 * The primary star is not re-rolled either. `sampleSystemsNear` already drew it
 * (that is where the stub's temperature and luminosity came from) and threw
 * away the mass, radius and class; `primaryStarFor` replays the identical draw
 * to get them back. Drawing a "similar" star here instead would mean the star
 * on the jump map and the star in the sky are different objects, which is the
 * single most visible way a procedural universe can betray itself.
 *
 * UNITS follow gen/types.ts: km, seconds, radians, Earth masses for planets,
 * Solar masses for stars, linear RGB. Orbit semi-major axes are stored in km
 * even though every formula here thinks in AU — the conversion happens once, at
 * the boundary, so the renderer never has to know that AU existed.
 */

import type {
  AtmosphereSpec,
  BandSpec,
  CloudSpec,
  GalaxySpec,
  OceanSpec,
  OrbitSpec,
  PlanetPalette,
  PlanetSpec,
  PlanetType,
  RGB,
  RingSpec,
  StarSpec,
  StarSystemSpec,
  TerrainSpec,
  Vec3,
} from './types';
import { AU, EARTH_RADIUS } from './types';
import type { GalaxyField, StarDraw, StarSystemStub } from './galaxy';
import { blackbodyColor, buildField, mainSequenceStar, primaryStarFor } from './galaxy';
import { blurb, moonName, planetName, starName } from './names';
import { Rng, hashSeed, rngFrom } from '@/math/rng';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Seconds in a Julian year. Orbits are computed in years and stored in seconds. */
const SECONDS_PER_YEAR = 3.15576e7;

/**
 * Standard gravitational parameter of Earth, km³/s². Moon periods use this
 * scaled by the parent's mass in Earth masses — the same Kepler third law as
 * the planets, just in the units the planet branch already speaks.
 */
const MU_EARTH = 3.986004418e5;

/** Surface gravity of Earth, m/s². The unit `PlanetSpec.gravity` is quoted in. */
const G_EARTH = 9.80665;

/**
 * Equilibrium temperature of a zero-albedo body at 1 AU from Sol, in kelvin:
 * T = (L☉ / (16 π σ d²))^¼. Every planet temperature in the game is this
 * number scaled by luminosity and distance, then bent by albedo and greenhouse.
 */
const T_EQ_1AU = 278.3;

/** The cosmic microwave background. Nothing in the universe is colder. */
const T_CMB = 2.725;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Jitter a linear-RGB colour multiplicatively, staying inside 0..1. */
function tint(rng: Rng, base: RGB, amount: number): RGB {
  return [
    clamp01(base[0] * rng.range(1 - amount, 1 + amount)),
    clamp01(base[1] * rng.range(1 - amount, 1 + amount)),
    clamp01(base[2] * rng.range(1 - amount, 1 + amount)),
  ];
}

// ---------------------------------------------------------------------------
// Habitable zone
// ---------------------------------------------------------------------------

/**
 * Inner and outer edge of the liquid-water zone in AU.
 *
 * Kopparapu et al. (2013) "runaway greenhouse" and "maximum greenhouse" limits,
 * scaled from Sol's 0.97–1.70 AU by the inverse-square law. The zone is where
 * *water* is liquid, not where the game is survivable — a world can sit dead
 * centre and still be a toxic rock, which is most of the point.
 */
export function habitableZone(luminosity: number): readonly [number, number] {
  const l = Math.max(0, luminosity);
  return [0.97 * Math.sqrt(l), 1.70 * Math.sqrt(l)];
}

/**
 * The snow line: where the star's flux drops far enough for water ice to
 * survive in the protoplanetary disc, so solids are suddenly ~4x more abundant
 * and cores grow fast enough to capture gas. Giants form beyond it; rocks form
 * inside it. Sol's sits at ~2.7 AU, which is exactly where the asteroid belt
 * gave up.
 *
 * Uses the *formation* luminosity, not the present one: a white dwarf lights
 * nothing today, but its planets condensed around the main-sequence star it
 * used to be, and their compositions still remember that.
 */
function frostLine(formationLuminosity: number): number {
  return 2.7 * Math.sqrt(Math.max(0.02, formationLuminosity));
}

// ---------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------

/**
 * Surface activity, 0..1 — how much the corona flares and the granulation
 * boils. Low-mass stars are fully convective and are the flare stars; hot
 * massive stars have radiative envelopes and are comparatively placid. Neutron
 * stars are pegged at maximum because a pulsar's magnetosphere is the most
 * violent thing a player will ever park next to.
 */
function activityFor(rng: Rng, s: StarDraw): number {
  if (s.spectralClass === 'BH') return 0;
  if (s.spectralClass === 'NS') return 1;
  if (s.spectralClass === 'WD') return rng.range(0.02, 0.15);
  const massTerm = clamp01(1 - Math.log10(Math.max(0.08, s.mass)) * 0.9 - 0.2);
  return clamp01(massTerm * rng.range(0.6, 1.3));
}

function toStarSpec(draw: StarDraw, seed: number, id: string, rng: Rng): StarSpec {
  return {
    id,
    seed,
    name: starName(hashSeed(seed, 'star')),
    spectralClass: draw.spectralClass,
    temperature: draw.temperature,
    radius: draw.radius,
    mass: draw.mass,
    luminosity: draw.luminosity,
    // Black holes ship with temperature 0 and are discarded by the renderer;
    // `blackbodyColor` clamps to 1000 K, so guard rather than emit a red tint
    // for something that has no photosphere at all.
    color: draw.spectralClass === 'BH' ? ([0, 0, 0] as RGB) : blackbodyColor(draw.temperature),
    activity: activityFor(rng, draw),
  };
}

/**
 * Multiplicity fraction against primary mass. Observed: ~26% for M dwarfs,
 * ~44% for solar types, >80% for O/B. A logarithm in mass reproduces that
 * spread with one constant, and the clamp keeps the tails honest.
 */
function multiplicityFraction(mass: number): number {
  return clamp(0.42 + 0.34 * Math.log10(Math.max(0.05, mass)), 0.15, 0.85);
}

// ---------------------------------------------------------------------------
// generateSystem
// ---------------------------------------------------------------------------

/**
 * Expand a jump-map stub into the full system.
 *
 * Pass `field` when expanding several systems from one galaxy: `buildField` is
 * not memoised and dominates the cost of a single call.
 */
/**
 * Suffix any repeated name with a roman numeral, depth-first over planets and
 * their moons. Mutates in place: the specs are readonly to consumers, but this
 * runs before the system is handed out.
 */
function dedupeNames(planets: PlanetSpec[]): void {
  const seen = new Map<string, number>();
  const ROMAN = ['', ' II', ' III', ' IV', ' V', ' VI', ' VII', ' VIII'];
  const visit = (body: PlanetSpec): void => {
    const n = seen.get(body.name) ?? 0;
    seen.set(body.name, n + 1);
    if (n > 0) {
      (body as { name: string }).name = body.name + (ROMAN[n] ?? ` ${n + 1}`);
    }
    for (const m of body.moons) visit(m);
  };
  for (const p of planets) visit(p);
}

export function generateSystem(
  galaxy: GalaxySpec,
  stub: StarSystemStub,
  field?: GalaxyField,
): StarSystemSpec {
  const f = field ?? buildField(galaxy);
  const primaryDraw = primaryStarFor(galaxy, stub, f);

  // One stream for the whole system. Every child gets a *seed*, never a slice
  // of this stream, so adding a draw here can never renumber a planet.
  const rng = rngFrom(stub.seed, 'system');

  // --- stars ---------------------------------------------------------------
  const stars: StarSpec[] = [
    toStarSpec(primaryDraw, hashSeed(stub.seed, 'star:0'), `${stub.id}:s0`, rng),
  ];

  if (rng.chance(multiplicityFraction(primaryDraw.mass))) {
    // Mass ratio q = M2/M1. Nearly flat with a mild preference for near-equal
    // pairs — the observed distribution for solar-type primaries. A companion
    // is always the lesser star by construction; "primary" means most massive.
    const q = clamp(rng.power(0.08, 1, -0.35), 0.08, 1);
    const secondary = mainSequenceStar(Math.max(0.08, primaryDraw.mass * q));
    stars.push(toStarSpec(secondary, hashSeed(stub.seed, 'star:1'), `${stub.id}:s1`, rng));

    // Hierarchical triples are ~10% of multiples; the third star orbits the
    // inner pair at a much greater distance, which is the only configuration
    // that is stable over gigayears.
    if (rng.chance(0.12)) {
      const q3 = clamp(rng.power(0.08, 0.9, -0.3), 0.08, 0.9);
      const tertiary = mainSequenceStar(Math.max(0.08, primaryDraw.mass * q3));
      stars.push(toStarSpec(tertiary, hashSeed(stub.seed, 'star:2'), `${stub.id}:s2`, rng));
    }
  }

  // Planets are lit by, and orbit, everything in the system. For a close binary
  // that is the physically right answer; for a wide one it overstates the flux
  // a little, and we accept that rather than model separation we do not store.
  let totalLuminosity = 0;
  let totalMass = 0;
  for (const s of stars) {
    totalLuminosity += s.luminosity;
    totalMass += s.mass;
  }

  const hz = habitableZone(totalLuminosity);

  /**
   * Formation luminosity. A remnant primary (WD/NS/BH) is dark now but was not
   * when its disc condensed, so the *architecture* of the system — where the
   * giants are, where the belt is — is set by what the star used to be, while
   * the temperatures below are set by what it is. Progenitor luminosity from
   * the main-sequence relation at the pre-collapse mass.
   */
  const isRemnant =
    primaryDraw.spectralClass === 'WD' ||
    primaryDraw.spectralClass === 'NS' ||
    primaryDraw.spectralClass === 'BH';
  const formationLuminosity = isRemnant
    ? mainSequenceStar(Math.max(0.5, primaryDraw.mass)).luminosity
    : Math.max(totalLuminosity, 1e-4);

  const snow = frostLine(formationLuminosity);

  // --- planet count --------------------------------------------------------
  /**
   * Kepler's occurrence rates say small planets are near-ubiquitous around
   * cool dwarfs and scarce around hot ones — an O star's disc is boiled off by
   * its own UV before cores can assemble. A supernova does the same job
   * retroactively, which is why remnants are docked hard.
   */
  let countBias = 1;
  if (primaryDraw.mass > 2) countBias *= 0.55;
  if (primaryDraw.mass > 8) countBias *= 0.4;
  if (primaryDraw.spectralClass === 'NS' || primaryDraw.spectralClass === 'BH') countBias *= 0.25;
  if (primaryDraw.spectralClass === 'WD') countBias *= 0.6;
  if (stars.length > 2) countBias *= 0.5; // triples clear their own discs

  const planetCount = Math.max(
    0,
    Math.round(rng.weighted([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [6, 8, 11, 14, 15, 13, 11, 8, 6, 5, 3]) *
      clamp(countBias, 0.15, 1)),
  );

  // --- orbital architecture -----------------------------------------------
  /**
   * A Titius–Bode-like geometric progression, fitted to the disc rather than
   * grown blindly outward.
   *
   * The inner edge is the dust sublimation line, which scales as sqrt(L) — very
   * close in for a red dwarf. The outer edge is where the disc ran out of
   * material, and that scales with stellar *mass*, not luminosity: discs are
   * tens of AU across around stars of every class, because their size is set by
   * the angular momentum of the cloud that collapsed, not by how brightly the
   * result ended up shining.
   *
   * Growing outward from the dust line at a fixed ratio — the obvious
   * implementation — conflates the two and is badly wrong for exactly the stars
   * that dominate the galaxy: a 0.3 M☉ dwarf has a sublimation line at 0.004 AU
   * and a snow line at 0.32 AU, so a fixed ~1.7x ratio needs eight planets
   * before one crosses the snow line and the system therefore never forms a
   * giant. Since three quarters of all stars are M dwarfs, that single mistake
   * removes gas giants from most of the universe. Fitting the progression
   * between both edges instead puts the outer planets past the snow line at
   * every stellar mass, which is where giants are allowed to exist.
   */
  const dustLine = Math.max(0.008, 0.034 * Math.sqrt(formationLuminosity));
  const discOuter = 30 * Math.pow(Math.max(0.05, totalMass), 0.9) * rng.range(0.25, 1.0);

  const inner = dustLine * rng.range(1.4, 5.0);
  // Neighbours closer than ~1.35x in semi-major axis scatter each other within
  // a few Myr, so the low clamp is dynamical stability, not taste. The high
  // clamp keeps a sparse system from flinging its outermost world into the Oort
  // cloud when the fit asks for an absurd ratio.
  const ratio =
    planetCount > 1
      ? clamp(Math.pow(Math.max(inner * 1.4, discOuter) / inner, 1 / (planetCount - 1)), 1.38, 2.6)
      : 1;

  const axes: number[] = [];
  let a = inner;
  for (let i = 0; i < planetCount; i++) {
    if (a > 220) break; // beyond this the disc had nothing left to build from
    axes.push(a);
    // Per-gap jitter, so a system is never a perfect geometric series.
    a *= ratio * rng.range(0.92, 1.1);
  }

  // --- asteroid belt -------------------------------------------------------
  // A belt is a failed planet: it needs a giant near the snow line to have
  // stirred the planetesimals past the point where they could accrete.
  const hasGiantBeyondSnow = axes.some((ax) => ax > snow);
  const hasAsteroidBelt = rng.chance(hasGiantBeyondSnow ? 0.62 : 0.22);

  // --- planets -------------------------------------------------------------
  const planets: PlanetSpec[] = [];
  for (let i = 0; i < axes.length; i++) {
    planets.push(
      generatePlanet({
        // The seam. A planet's seed is a pure function of the system's seed and
        // its orbital index — no stream position, no counter, no clock.
        seed: hashSeed(stub.seed, `planet:${i}`),
        id: `${stub.id}:p${i}`,
        systemName: stub.name,
        index: i,
        semiMajorAxisAu: axes[i]!,
        luminosity: totalLuminosity,
        formationLuminosity,
        starMassSolar: Math.max(0.02, totalMass),
        frostLineAu: snow,
        innerHzAu: hz[0],
        outerHzAu: hz[1],
      }),
    );
  }

  // --- name collisions -----------------------------------------------------
  //
  // Each body names itself from its own seed, which keeps generation pure and
  // order-independent — but two of them can independently land on the same
  // string, and only the system can see that. Measured: one collision in a
  // forty-system sample. Disambiguate in place rather than re-rolling, so a
  // planet's name never depends on how many siblings it happens to have.
  dedupeNames(planets);

  // --- civilisation --------------------------------------------------------
  /**
   * How picked-over the system is. Traffic follows two things: somewhere to
   * stand (a world in the habitable zone) and a reason to stop (a giant to mine
   * volatiles from, a belt to mine metals from). Most of the galaxy is empty,
   * so the base rate is deliberately low and the multipliers do the work.
   */
  let civ = rng.range(0, 0.18);
  for (const p of planets) {
    if (p.type === 'terran' || p.type === 'ocean') civ += rng.range(0.25, 0.55);
    else if (p.type === 'gas-giant' || p.type === 'ice-giant') civ += rng.range(0.02, 0.09);
  }
  if (hasAsteroidBelt) civ += rng.range(0.03, 0.12);
  if (isRemnant) civ *= 0.35; // nobody homesteads a corpse
  const civilisation = clamp01(civ);

  const primary = stars[0]!;

  return {
    id: stub.id,
    seed: stub.seed,
    name: stub.name,
    position: stub.position,
    galaxyId: galaxy.id,
    stars,
    planets,
    habitableZone: hz,
    civilisation,
    hasAsteroidBelt,
    blurb: blurb(hashSeed(stub.seed, 'blurb'), 'system', {
      stars: stars.length,
      spectralClass: primary.spectralClass,
      planets: planets.length,
      civilisation,
      belt: hasAsteroidBelt ? 1 : 0,
    }),
  };
}

// ---------------------------------------------------------------------------
// generatePlanet
// ---------------------------------------------------------------------------

/**
 * Everything a planet needs that it cannot derive from its own seed: where it
 * is, what is shining on it, and what it is called after.
 *
 * This is a plain data bag on purpose — `generatePlanet` never sees the
 * `StarSystemSpec`, so it cannot accidentally depend on a mutable parent or
 * reach for a random number that belongs to somebody else.
 */
export interface PlanetContext {
  /** Derived by the caller from the system seed. Never invented here. */
  readonly seed: number;
  readonly id: string;
  /** Used for naming: worlds inherit their star's dialect. */
  readonly systemName: string;
  /** Orbital index from the star outward, 0-based. */
  readonly index: number;
  readonly semiMajorAxisAu: number;
  /** Present-day system luminosity, solar units — sets temperature. */
  readonly luminosity: number;
  /** Luminosity when the disc condensed — sets composition. */
  readonly formationLuminosity: number;
  /** Total stellar mass, solar units — sets the orbital period. */
  readonly starMassSolar: number;
  readonly frostLineAu: number;
  readonly innerHzAu: number;
  readonly outerHzAu: number;
}

/** Bond albedo by type — the fraction of incident light thrown straight back. */
function albedoFor(type: PlanetType, rng: Rng): number {
  switch (type) {
    case 'ice':
      return rng.range(0.5, 0.72); // fresh ice is the brightest natural surface
    case 'ocean':
      return rng.range(0.2, 0.32);
    case 'terran':
      return rng.range(0.26, 0.38);
    case 'desert':
      return rng.range(0.22, 0.36);
    case 'toxic':
      return rng.range(0.6, 0.78); // Venus: a global cloud deck, 0.77
    case 'volcanic':
      return rng.range(0.06, 0.14);
    case 'gas-giant':
      return rng.range(0.3, 0.52);
    case 'ice-giant':
      return rng.range(0.28, 0.44);
    case 'barren':
      return rng.range(0.07, 0.16); // lunar regolith, 0.11
    case 'rocky':
      return rng.range(0.1, 0.24);
  }
}

/**
 * Decide what kind of world condensed at this distance.
 *
 * Composition first (which side of the snow line, how much mass), then climate
 * (what the present-day flux does to that composition). Doing it in the other
 * order is how you get an ocean world orbiting inside a star's corona.
 */
function classifyPlanet(rng: Rng, ctx: PlanetContext): { type: PlanetType; massEarth: number } {
  const beyondSnow = ctx.semiMajorAxisAu > ctx.frostLineAu;

  // --- giants --------------------------------------------------------------
  // Runaway gas accretion needs a ~10 Earth-mass core assembled before the disc
  // disperses, which essentially only happens outside the snow line. The window
  // just past the line is where the solid surface density peaks, so that is
  // where giants are most likely.
  const nearLine = ctx.semiMajorAxisAu < ctx.frostLineAu * 4;
  const giantChance = beyondSnow ? (nearLine ? 0.5 : 0.3) : 0.02;
  if (rng.chance(giantChance)) {
    const massEarth = rng.power(9, 3200, -1.05);
    // ~50 Earth masses is where a hydrogen envelope stops being an atmosphere
    // over an ice core and starts being the planet: Neptune is 17, Saturn 95.
    return { type: massEarth > 50 ? 'gas-giant' : 'ice-giant', massEarth };
  }

  // --- terrestrials --------------------------------------------------------
  // Steep power law: sub-Earths outnumber super-Earths, and both outnumber the
  // rare 8-Earth-mass rocks that never quite became giants.
  const massEarth = rng.power(0.008, 11, -0.95);

  /**
   * The runaway accretion threshold. A ~10 M⊕ core outside the snow line does
   * not stay a rock — its Hill sphere is large enough and its escape velocity
   * high enough that it captures whatever hydrogen is left in the disc, and it
   * becomes a Neptune. Without this the giant roll above can fail and hand back
   * a nine-Earth-mass "ice world" carrying 120 bar of atmosphere, which is a
   * mini-Neptune with the wrong label, the wrong palette and a solid surface it
   * has no business having.
   */
  if (beyondSnow && massEarth > 8) return { type: 'ice-giant', massEarth };

  // Provisional temperature, at the albedo of bare rock. The type it picks then
  // sets the real albedo, and the caller recomputes — one iteration is enough,
  // the feedback is weak everywhere except the runaway branch.
  const flux = ctx.luminosity / (ctx.semiMajorAxisAu * ctx.semiMajorAxisAu);
  const tBare = Math.max(T_CMB, T_EQ_1AU * Math.pow(Math.max(0, flux) * 0.85, 0.25));

  // A body this small cannot hold anything volatile: no atmosphere, no water,
  // no weather. Ceres, Mercury, the Moon.
  if (massEarth < 0.05) return { type: tBare < 150 ? 'ice' : 'barren', massEarth };

  // 700 K rather than the silicate melting point: a runaway greenhouse adds
  // several hundred K on top of this, so a world that reaches 700 K on bare
  // rock is a magma world by the time its atmosphere is accounted for. Setting
  // the cut at the melting point instead produced 1300 K worlds labelled
  // 'toxic', which is a lava planet wearing the wrong noun.
  if (tBare > 700) return { type: 'volcanic', massEarth };
  if (tBare > 420) {
    // Hot and heavy enough to have outgassed and then never lost it: a runaway
    // greenhouse, which is the single most common outcome for a Venus-mass rock
    // inside the inner edge of the habitable zone.
    return { type: massEarth > 0.4 && rng.chance(0.55) ? 'toxic' : 'desert', massEarth };
  }
  if (tBare < 170) return { type: 'ice', massEarth };

  // Temperate band. Whether it is alive, drowned, dry or just rock is the one
  // genuinely arbitrary call in this function — everything else is physics.
  const inHz = ctx.semiMajorAxisAu >= ctx.innerHzAu && ctx.semiMajorAxisAu <= ctx.outerHzAu;
  if (inHz && massEarth > 0.25) {
    return {
      type: rng.weighted(
        ['terran', 'ocean', 'desert', 'rocky'] as const,
        [26, 18, 28, 28],
      ),
      massEarth,
    };
  }
  return { type: rng.weighted(['rocky', 'desert', 'barren'] as const, [50, 28, 22]), massEarth };
}

/**
 * Mass–radius relation, returning kilometres.
 *
 * Rocky worlds follow Zeng et al.: R ∝ M^0.27 for an Earth-like iron fraction.
 * Giants are the interesting case — they *stop* growing. Electron degeneracy
 * pressure in the envelope means a 3-Jupiter-mass planet is very slightly
 * smaller than a 1-Jupiter one, so radius is essentially flat above ~300 Earth
 * masses. A naive power law here produces brown-dwarf-sized "planets", which
 * looks absurd the moment one is on screen next to its star.
 */
function radiusKmFor(type: PlanetType, massEarth: number, rng: Rng): number {
  if (type === 'gas-giant') {
    // 11.2 Earth radii is Jupiter. The exponent decays to zero past 300 M⊕.
    const m = massEarth / 318;
    const r = 11.2 * Math.pow(clamp(m, 0.05, 13), 0.05) * (1 + 0.35 * clamp(1 - m, 0, 1));
    return EARTH_RADIUS * r * rng.range(0.92, 1.1);
  }
  if (type === 'ice-giant') {
    return EARTH_RADIUS * 3.9 * Math.pow(massEarth / 17, 0.32) * rng.range(0.9, 1.12);
  }
  const iceRich = type === 'ice' || type === 'ocean';
  // Ice and water are less dense than silicates, so the same mass is bigger.
  const scale = iceRich ? 1.22 : 1;
  return EARTH_RADIUS * scale * Math.pow(Math.max(1e-4, massEarth), 0.27) * rng.range(0.95, 1.06);
}

// --- terrain ---------------------------------------------------------------

/**
 * Terrain parameters per world type.
 *
 * `amplitude` is peak-to-trough relief in km and is scaled by planet radius
 * afterwards — relief does not scale linearly with size, because a big world's
 * gravity crushes its own mountains (Olympus Mons is 22 km on a planet half
 * Earth's radius; Everest is 8.8 km on Earth). The exponent below is that
 * effect, and it is why small worlds read as jagged and big ones as smooth.
 */
function terrainFor(type: PlanetType, radiusKm: number, gravity: number, rng: Rng): TerrainSpec {
  // Giants have no surface. Amplitude 0 makes `sampleTerrain` return 0
  // everywhere, which is exactly what a lander needs to be told.
  if (type === 'gas-giant' || type === 'ice-giant') {
    return {
      frequency: 1,
      octaves: 4,
      lacunarity: 2,
      gain: 0.5,
      amplitude: 0,
      ridged: 0,
      warp: 0,
      craters: 0,
      sharpness: 1,
      seaLevel: 0.5,
    };
  }

  /**
   * Relief budget: proportional to radius, inversely to surface gravity — a
   * mountain is as tall as the rock at its base can bear, and that limit is set
   * by weight. The second clamp is the one that matters: relief is capped at
   * 1.2% of radius because no solid body in the solar system exceeds that
   * (Vesta, the most extreme, is ~1%), and without it the low-gravity branch
   * hands a 2500 km moonlet 40 km peaks and the horizon stops looking spherical.
   */
  const budget = (radiusKm / EARTH_RADIUS) * (9.81 / Math.max(1.5, gravity)) * 18;
  const relief = clamp(Math.min(budget, radiusKm * 0.012), 1.5, 90);

  switch (type) {
    case 'volcanic':
      return {
        frequency: rng.range(6, 11),
        octaves: 12,
        lacunarity: rng.range(2.0, 2.15),
        gain: rng.range(0.58, 0.66),
        amplitude: relief * rng.range(0.9, 1.4),
        ridged: rng.range(0.75, 0.95),
        warp: rng.range(0.4, 0.75),
        craters: rng.range(0.02, 0.12),
        sharpness: rng.range(1.05, 1.35),
        seaLevel: rng.range(0.38, 0.5), // lava seas sit low in the basins
      };
    case 'ocean':
      return {
        frequency: rng.range(5, 9),
        octaves: 12,
        lacunarity: rng.range(2.0, 2.12),
        gain: rng.range(0.5, 0.58),
        amplitude: relief * rng.range(0.5, 0.8),
        ridged: rng.range(0.3, 0.6),
        warp: rng.range(0.35, 0.6),
        craters: 0.01,
        sharpness: rng.range(0.85, 1.05),
        seaLevel: rng.range(0.72, 0.88), // drowned: only the peaks are land
      };
    case 'terran':
      return {
        frequency: rng.range(7, 11),
        octaves: 13,
        lacunarity: rng.range(2.02, 2.12),
        gain: rng.range(0.58, 0.66),
        amplitude: relief * rng.range(0.8, 1.2),
        ridged: rng.range(0.65, 0.88),
        warp: rng.range(0.45, 0.7),
        craters: rng.range(0.01, 0.06),
        sharpness: rng.range(1.0, 1.2),
        seaLevel: rng.range(0.44, 0.6),
      };
    case 'desert':
      return {
        frequency: rng.range(4, 8),
        octaves: 11,
        lacunarity: rng.range(2.0, 2.2),
        gain: rng.range(0.52, 0.6),
        amplitude: relief * rng.range(0.6, 1.0),
        ridged: rng.range(0.35, 0.65),
        warp: rng.range(0.6, 0.95), // dune fields are domain warp made visible
        craters: rng.range(0.05, 0.25),
        sharpness: rng.range(0.9, 1.15),
        seaLevel: rng.range(0.3, 0.45),
      };
    case 'ice':
      return {
        frequency: rng.range(5, 9),
        octaves: 12,
        lacunarity: rng.range(2.0, 2.15),
        gain: rng.range(0.5, 0.6),
        amplitude: relief * rng.range(0.4, 0.8),
        ridged: rng.range(0.4, 0.75),
        warp: rng.range(0.3, 0.6),
        // Ice relaxes: craters flow shut over geological time, so an ice world
        // shows far fewer than a rock at the same age.
        craters: rng.range(0.05, 0.2),
        sharpness: rng.range(0.85, 1.05),
        seaLevel: rng.range(0.35, 0.55),
      };
    case 'toxic':
      return {
        frequency: rng.range(4, 8),
        octaves: 11,
        lacunarity: rng.range(2.0, 2.15),
        gain: rng.range(0.5, 0.6),
        amplitude: relief * rng.range(0.4, 0.7),
        ridged: rng.range(0.3, 0.6),
        warp: rng.range(0.4, 0.7),
        // A thick atmosphere burns up small impactors: Venus has no crater
        // under ~3 km across, anywhere.
        craters: rng.range(0.0, 0.05),
        sharpness: rng.range(0.9, 1.1),
        seaLevel: rng.range(0.3, 0.45),
      };
    case 'rocky':
    case 'barren':
    default:
      return {
        frequency: rng.range(5, 10),
        octaves: 12,
        lacunarity: rng.range(2.0, 2.2),
        gain: rng.range(0.52, 0.62),
        amplitude: relief * rng.range(0.7, 1.1),
        ridged: rng.range(0.45, 0.8),
        warp: rng.range(0.25, 0.55),
        // Airless and dead: every impact since the late heavy bombardment is
        // still there. This is the single strongest visual tell of a dead world.
        craters: rng.range(0.45, 0.95),
        sharpness: rng.range(0.95, 1.2),
        seaLevel: rng.range(0.28, 0.44),
      };
  }
}

// --- palette ---------------------------------------------------------------

/**
 * Base palettes, linear RGB, deliberately dark.
 *
 * oneSpace grades to noir in post, and a palette authored at photographic
 * brightness turns to grey mush once the grade lands on it. These sit an
 * exposure stop or two below "correct", so the highlights the post pass lifts
 * are the peaks and the ice, which is where the eye should go.
 */
const PALETTES: Readonly<Record<PlanetType, PlanetPalette>> = {
  terran: {
    low: [0.038, 0.044, 0.046],
    mid: [0.062, 0.068, 0.058],
    high: [0.086, 0.076, 0.062],
    peak: [0.52, 0.55, 0.6],
    cliff: [0.044, 0.042, 0.04],
    polar: [0.7, 0.76, 0.84],
    accent: [0.235, 0.13, 0.048],
  },
  ocean: {
    low: [0.012, 0.028, 0.045],
    mid: [0.03, 0.052, 0.062],
    high: [0.07, 0.072, 0.062],
    peak: [0.42, 0.46, 0.52],
    cliff: [0.036, 0.038, 0.04],
    polar: [0.66, 0.74, 0.84],
    accent: [0.16, 0.14, 0.1],
  },
  desert: {
    low: [0.075, 0.055, 0.036],
    mid: [0.14, 0.104, 0.062],
    high: [0.2, 0.15, 0.09],
    peak: [0.34, 0.3, 0.24],
    cliff: [0.09, 0.062, 0.04],
    polar: [0.5, 0.48, 0.44],
    accent: [0.3, 0.18, 0.07],
  },
  ice: {
    low: [0.09, 0.11, 0.14],
    mid: [0.24, 0.29, 0.34],
    high: [0.42, 0.48, 0.55],
    peak: [0.78, 0.84, 0.92],
    cliff: [0.14, 0.16, 0.19],
    polar: [0.84, 0.9, 0.96],
    accent: [0.2, 0.3, 0.4],
  },
  volcanic: {
    low: [0.09, 0.026, 0.008], // fissure floor, still incandescent
    mid: [0.05, 0.036, 0.032],
    high: [0.07, 0.06, 0.056],
    peak: [0.14, 0.12, 0.11],
    cliff: [0.035, 0.028, 0.026],
    polar: [0.1, 0.09, 0.088],
    accent: [0.45, 0.13, 0.02],
  },
  toxic: {
    low: [0.075, 0.062, 0.03],
    mid: [0.12, 0.1, 0.05],
    high: [0.17, 0.145, 0.075],
    peak: [0.26, 0.23, 0.14],
    cliff: [0.085, 0.07, 0.036],
    polar: [0.2, 0.19, 0.13],
    accent: [0.32, 0.26, 0.09],
  },
  barren: {
    low: [0.028, 0.027, 0.026],
    mid: [0.048, 0.047, 0.045],
    high: [0.075, 0.073, 0.07],
    peak: [0.13, 0.128, 0.125],
    cliff: [0.036, 0.035, 0.034],
    polar: [0.1, 0.1, 0.1],
    accent: [0.09, 0.082, 0.07],
  },
  rocky: {
    low: [0.034, 0.031, 0.029],
    mid: [0.062, 0.055, 0.05],
    high: [0.098, 0.085, 0.072],
    peak: [0.2, 0.19, 0.18],
    cliff: [0.042, 0.038, 0.035],
    polar: [0.3, 0.31, 0.33],
    accent: [0.14, 0.1, 0.07],
  },
  'gas-giant': {
    low: [0.05, 0.05, 0.06],
    mid: [0.1, 0.09, 0.09],
    high: [0.16, 0.14, 0.13],
    peak: [0.3, 0.28, 0.26],
    cliff: [0.08, 0.07, 0.07],
    polar: [0.12, 0.14, 0.18],
    accent: [0.34, 0.14, 0.07],
  },
  'ice-giant': {
    low: [0.02, 0.045, 0.075],
    mid: [0.035, 0.075, 0.115],
    high: [0.06, 0.11, 0.16],
    peak: [0.16, 0.24, 0.32],
    cliff: [0.03, 0.06, 0.09],
    polar: [0.1, 0.16, 0.24],
    accent: [0.08, 0.18, 0.26],
  },
};

function paletteFor(type: PlanetType, rng: Rng): PlanetPalette {
  const base = PALETTES[type];
  // 18% jitter: enough that two desert worlds are visibly different rocks,
  // little enough that a desert is never mistaken for an ice field.
  return {
    low: tint(rng, base.low, 0.18),
    mid: tint(rng, base.mid, 0.18),
    high: tint(rng, base.high, 0.18),
    peak: tint(rng, base.peak, 0.12),
    cliff: tint(rng, base.cliff, 0.18),
    polar: tint(rng, base.polar, 0.1),
    accent: tint(rng, base.accent, 0.25),
  };
}

// --- atmosphere ------------------------------------------------------------

/**
 * Surface pressure in bar, from Jeans escape.
 *
 * A world keeps its air when escape velocity comfortably exceeds the thermal
 * speed of the gas — hot and small loses it, cold and large keeps it. The
 * `retention` term below is normalised so Earth sits at 1.0, and the sixth
 * power is what makes the cliff sharp: Mars, at retention 0.52, lands on
 * 0.02 bar, which is the right answer to within a factor of three.
 */
function pressureFor(
  type: PlanetType,
  massEarth: number,
  radiusKm: number,
  tEq: number,
  rng: Rng,
): number {
  if (type === 'gas-giant' || type === 'ice-giant') return rng.range(400, 4000);

  const rEarth = radiusKm / EARTH_RADIUS;
  const escapeKms = 11.186 * Math.sqrt(Math.max(1e-6, massEarth) / Math.max(1e-3, rEarth));
  const thermal = Math.sqrt(Math.max(40, tEq) / 288);
  const retention = escapeKms / (11.186 * thermal);

  if (retention < 0.33) return 0;

  const p = Math.pow(retention, 6) * rng.range(0.45, 2.1);

  /**
   * Saturate rather than clamp. A hard `clamp(p, 0, 90)` parks every
   * super-Earth on exactly 90.000 bar, and three planets in a row reading the
   * identical number is the most obvious possible tell that a range was
   * exceeded. `pMax * (1 - e^(-p/pMax))` is monotone, agrees with `p` to within
   * a percent while p ≪ pMax, and never reaches the ceiling — so two worlds
   * that differ in mass still differ in the readout, however thick they get.
   */
  const soften = (v: number, pMax: number): number => pMax * (1 - Math.exp(-v / pMax));

  // The runaway branch: a toxic world outgassed its entire carbonate inventory
  // and never rained it back out. Venus is 92 bar on a body that "should" hold
  // about one, and no continuous formula reaches that — it is a bifurcation,
  // so it is coded as one.
  if (type === 'toxic') return Math.max(8, soften(p * rng.range(30, 120), 180));
  return soften(p, 120);
}

/**
 * Rayleigh scattering coefficients, 1/km, per channel.
 *
 * Scattering goes as 1/λ⁴, which is the entire reason skies are blue. The base
 * triplet is Earth's at sea level; scaling it by pressure and shifting the
 * ratio by composition is what makes a thin CO₂ sky read butterscotch and a
 * thick one read as a lid.
 */
function rayleighFor(type: PlanetType, pressure: number, rng: Rng): RGB {
  const s = clamp(pressure, 0.01, 12) * rng.range(0.8, 1.25);
  switch (type) {
    case 'toxic':
      // Dense CO₂ plus sulphuric haze: the blue end never reaches the ground.
      return [0.0075 * s, 0.0052 * s, 0.0026 * s];
    case 'desert':
      return [0.0064 * s, 0.0072 * s, 0.0135 * s];
    case 'volcanic':
      return [0.0092 * s, 0.0048 * s, 0.0022 * s];
    case 'ice':
      return [0.0048 * s, 0.0118 * s, 0.0322 * s];
    default:
      return [0.0058 * s, 0.0135 * s, 0.0331 * s];
  }
}

function atmosphereFor(
  type: PlanetType,
  pressure: number,
  radiusKm: number,
  tEq: number,
  gravity: number,
  rng: Rng,
): AtmosphereSpec | null {
  if (pressure <= 0.0005) return null;

  /**
   * Hydrostatic scale height H = kT / (μ m_u g), in km.
   *
   * The constant is pinned to Earth — 0.2895 * 288 / 9.81 = 8.5 km — and then
   * corrected for what the air is actually made of, because μ varies by more
   * than an order of magnitude across the types here and H is inversely
   * proportional to it. Assuming nitrogen everywhere gives Jupiter a 0.9 km
   * scale height (it is ~27 km): a hydrogen envelope is twelve times fluffier
   * than air, and a giant whose atmosphere is a thin shell instead of a deep
   * one is wrong on screen the moment you fly into it.
   *
   * Check: Venus, μ=43 CO₂, 737 K, 8.87 m/s² -> 16.2 km, against a measured 15.9.
   */
  const mu =
    type === 'gas-giant' || type === 'ice-giant'
      ? 2.3 // H₂/He, primordial and never lost
      : type === 'toxic' || type === 'volcanic'
        ? 43 // CO₂ and heavier: outgassed, not captured
        : 29; // N₂/O₂-like
  const scaleHeight = clamp(
    (0.2895 * (29 / mu) * Math.max(50, tEq)) / Math.max(0.5, gravity),
    1.5,
    120,
  );

  return {
    scaleHeight,
    // The shell fades to vacuum at ~13 scale heights; clamped so a giant's
    // atmosphere does not become a second planet.
    thickness: clamp(scaleHeight * rng.range(11, 15), 8, radiusKm * 0.35),
    rayleigh: rayleighFor(type, pressure, rng),
    mie: clamp(0.0021 * Math.pow(clamp(pressure, 0.01, 160), 0.6), 0.0002, 0.05),
    mieAnisotropy: rng.range(0.68, 0.82),
    intensity: clamp(0.6 + 0.5 * Math.log10(clamp(pressure, 0.01, 160) + 1), 0.4, 2.2),
    pressure,
  };
}

function cloudsFor(
  type: PlanetType,
  pressure: number,
  radiusKm: number,
  rotationPeriod: number,
  rng: Rng,
): CloudSpec | null {
  if (pressure < 0.05) return null;
  if (type === 'gas-giant' || type === 'ice-giant') return null; // bands do this job

  const coverage =
    type === 'toxic'
      ? rng.range(0.9, 1.0) // an unbroken deck; the surface is never seen
      : type === 'ocean'
        ? rng.range(0.45, 0.75)
        : type === 'terran'
          ? rng.range(0.35, 0.65)
          : rng.range(0.05, 0.35);

  return {
    coverage,
    altitude: clamp(radiusKm * rng.range(0.0012, 0.0035), 2, 40),
    color: tint(rng, [0.72, 0.74, 0.78], 0.12),
    // Superrotation: the deck runs faster than the ground, and does so by more
    // on slow rotators — Venus' clouds lap its surface sixty times a day.
    drift: (rng.range(0.6, 2.4) * (2 * Math.PI)) / Math.max(3600, Math.abs(rotationPeriod) * 40),
    detail: rng.range(0.4, 1.0),
  };
}

function oceanFor(type: PlanetType, tEq: number, rng: Rng): OceanSpec | null {
  if (type === 'volcanic') {
    return {
      color: tint(rng, [0.55, 0.15, 0.02], 0.2),
      deepColor: tint(rng, [0.22, 0.04, 0.005], 0.2),
      specular: rng.range(0.15, 0.35),
      waveHeight: rng.range(0.0005, 0.002),
      emissive: tint(rng, [1.0, 0.28, 0.05], 0.15), // lava is its own light source
    };
  }
  if (type !== 'ocean' && type !== 'terran') return null;
  if (tEq < 180 || tEq > 400) return null; // frozen solid or boiled off

  return {
    color: tint(rng, [0.018, 0.04, 0.062], 0.25),
    deepColor: tint(rng, [0.0045, 0.0125, 0.0265], 0.25),
    specular: rng.range(0.72, 0.92),
    waveHeight: rng.range(0.0008, 0.0025),
    emissive: null,
  };
}

function ringsFor(type: PlanetType, seed: number, rng: Rng): RingSpec | null {
  const giant = type === 'gas-giant' || type === 'ice-giant';
  if (!rng.chance(giant ? 0.38 : 0.04)) return null;

  // The Roche limit for a rubble pile is ~2.4 planetary radii; anything outside
  // it accretes into a moon instead of staying a ring, so the outer edge is
  // capped there rather than chosen.
  const inner = rng.range(1.28, 1.75);
  return {
    innerRadius: inner,
    outerRadius: inner + rng.range(0.25, 0.95),
    color: tint(rng, [0.42, 0.4, 0.36], 0.22),
    opacity: rng.range(0.2, 0.8),
    seed: hashSeed(seed, 'rings'),
    // Rings lie in the equatorial plane — a torque-free disc has nowhere else
    // to be — so the tilt here is a small residual, not a free parameter.
    tilt: rng.gaussian(0, 0.04),
  };
}

function bandsFor(type: PlanetType, temperature: number, rng: Rng): BandSpec | null {
  if (type !== 'gas-giant' && type !== 'ice-giant') return null;

  // Band count is set by the Rhines scale: fast rotators and small radii give
  // narrow, numerous jets. Jupiter has ~14 visible; Neptune has ~4.
  const count = type === 'gas-giant' ? rng.int(8, 18) : rng.int(3, 8);

  // Warm giants are brown (organic haze); cold ones are blue-green (methane
  // absorbing the red end). ~120 K is roughly where the transition sits.
  const warm = temperature > 120;
  const base: RGB = warm ? [0.16, 0.13, 0.1] : [0.05, 0.11, 0.16];
  const palette: RGB[] = [];
  const stops = rng.int(4, 7);
  for (let i = 0; i < stops; i++) {
    const k = 0.35 + (i / Math.max(1, stops - 1)) * 1.5;
    palette.push(tint(rng, [base[0] * k, base[1] * k, base[2] * k], 0.2));
  }

  return {
    count,
    turbulence: rng.range(0.7, 1.5),
    shearSpeed: rng.range(0.003, 0.012),
    // Long-lived vortices need a deep, stably stratified envelope: gas giants
    // get them, ice giants mostly do not.
    stormCount: type === 'gas-giant' ? rng.int(0, 5) : rng.int(0, 2),
    palette,
  };
}

// --- orbit -----------------------------------------------------------------

function orbitFor(rng: Rng, semiMajorAxisKm: number, periodSeconds: number): OrbitSpec {
  return {
    semiMajorAxis: semiMajorAxisKm,
    // Rayleigh-ish: most planets are near-circular, a few are not. A flat
    // uniform draw here makes every system look like a scattering event.
    eccentricity: clamp(Math.abs(rng.gaussian(0, 0.055)), 0, 0.6),
    // Mutual inclinations in a settled system are a couple of degrees at most —
    // the disc they formed in was flat, and nothing since has torqued them.
    inclination: rng.gaussian(0, 0.035),
    longitudeOfAscendingNode: rng.range(0, Math.PI * 2),
    argumentOfPeriapsis: rng.range(0, Math.PI * 2),
    meanAnomalyAtEpoch: rng.range(0, Math.PI * 2),
    period: periodSeconds,
  };
}

/** Kepler's third law in solar units: P² = a³ / M, with a in AU and P in years. */
function orbitalPeriodSeconds(semiMajorAxisAu: number, starMassSolar: number): number {
  return (
    Math.sqrt(Math.pow(Math.max(1e-6, semiMajorAxisAu), 3) / Math.max(1e-3, starMassSolar)) *
    SECONDS_PER_YEAR
  );
}

/**
 * Tidal locking radius in AU.
 *
 * Locking time goes as a⁶/M², so over a few Gyr the boundary is sharp: inside
 * it everything is synchronous, outside it nothing is. The constant puts Sol's
 * line at 0.2 AU (Mercury, at 0.39, is in a 3:2 resonance rather than locked —
 * correct) and an M dwarf's at ~0.1 AU, which is squarely inside its habitable
 * zone. That single fact — that a red dwarf's temperate worlds all have a
 * permanent day side — is worth more to the game than any amount of tuning.
 */
function lockRadiusAu(starMassSolar: number): number {
  return 0.2 * Math.pow(Math.max(0.05, starMassSolar), 1 / 3);
}

// --- moons -----------------------------------------------------------------

/**
 * Build the satellites of a finished planet.
 *
 * Moons are `PlanetSpec`s too — the renderer, the flight model and the scanner
 * treat a moon and a planet identically, and the only difference in the data is
 * `isMoon` and whose gravity the orbit refers to. They never recurse: a moon of
 * a moon is not dynamically stable over any interesting timescale.
 */
function moonsFor(
  parentSeed: number,
  parentId: string,
  parentName: string,
  parentType: PlanetType,
  parentMassEarth: number,
  parentRadiusKm: number,
  luminosity: number,
  semiMajorAxisAu: number,
  starMassSolar: number,
  rng: Rng,
): PlanetSpec[] {
  const giant = parentType === 'gas-giant' || parentType === 'ice-giant';
  // Moon count tracks Hill-sphere volume, i.e. mass. Giants sweep up whole
  // families; a sub-Earth rock captures nothing.
  const maxMoons = giant ? 8 : parentMassEarth > 0.5 ? 3 : 1;
  const count = Math.min(
    maxMoons,
    Math.max(0, Math.round(rng.power(0.4, maxMoons + 0.9, giant ? -0.6 : -1.6) - 0.4)),
  );

  // The Hill sphere is the hard bound, and nothing enforced it before: moons
  // stepped outward by up to 2.4x each, so eight of them reached a thousand
  // parent radii and the outermost were measured 47% OUTSIDE the sphere they
  // would have to be inside to be bound at all. Prograde satellites are only
  // stable to roughly half the Hill radius in practice, so that is the ceiling.
  const AU_KM = 1.495978707e8;
  const EARTH_PER_SOLAR = 332946;
  const hillKm =
    semiMajorAxisAu *
    AU_KM *
    Math.cbrt(parentMassEarth / (3 * Math.max(0.02, starMassSolar) * EARTH_PER_SOLAR));
  const maxAKm = hillKm * 0.5;

  const moons: PlanetSpec[] = [];
  let aKm = Math.min(parentRadiusKm * rng.range(2.6, 5.5), maxAKm);

  for (let i = 0; i < count; i++) {
    const seed = hashSeed(parentSeed, `moon:${i}`);
    const mrng = rngFrom(seed, 'moon');

    // Moons are small: the largest in Sol is Ganymede at 0.025 Earth masses,
    // and the mass ratio to the parent is what actually bounds this.
    const massEarth = clamp(
      mrng.power(0.0005, 0.03, -0.9) * (giant ? 1 : 0.4),
      1e-5,
      parentMassEarth * 0.05,
    );
    /**
     * Composition follows from the moon's own insolation, not its parent's
     * type. A moon sits at essentially the same distance from the star as its
     * planet, so it gets the same flux — but a hot planet's moon is a hot
     * moon, and choosing 'ice' from the parent's temperature (or worse, from
     * nothing at all) puts water ice on a body at 277 K, where it would have
     * sublimated away in a geological eyeblink. Bare-rock albedo for the
     * provisional temperature, exactly as `classifyPlanet` does it.
     */
    const flux = luminosity / (semiMajorAxisAu * semiMajorAxisAu);
    const tBare = Math.max(T_CMB, T_EQ_1AU * Math.pow(Math.max(0, flux) * 0.85, 0.25));
    // 170 K is the water-ice sublimation line for a vacuum-exposed surface.
    const type: PlanetType = tBare < 170 ? (mrng.chance(0.8) ? 'ice' : 'barren') : 'barren';

    const radiusKm = radiusKmFor(type, massEarth, mrng);
    const gravity =
      (G_EARTH * massEarth) / Math.pow(Math.max(1e-4, radiusKm / EARTH_RADIUS), 2);

    const periodS = 2 * Math.PI * Math.sqrt(Math.pow(aKm, 3) / (MU_EARTH * Math.max(1e-4, parentMassEarth)));
    const albedo = albedoFor(type, mrng);
    const temperature = Math.max(
      T_CMB,
      T_EQ_1AU * Math.pow(Math.max(0, flux) * (1 - albedo), 0.25),
    );

    const pressure = pressureFor(type, massEarth, radiusKm, temperature, mrng);
    const terrain = terrainFor(type, radiusKm, gravity, mrng);
    const name = moonName(hashSeed(seed, 'name'), parentName, i);

    moons.push({
      id: `${parentId}:m${i}`,
      seed,
      name,
      type,
      radius: radiusKm,
      mass: massEarth,
      gravity,
      orbit: orbitFor(mrng, aKm, periodS),
      // Tidal locking of a satellite is essentially universal at these
      // separations. Our own Moon is the reference case.
      rotationPeriod: periodS,
      axialTilt: mrng.gaussian(0, 0.05),
      temperature,
      terrain,
      palette: paletteFor(type, mrng),
      atmosphere: atmosphereFor(type, pressure, radiusKm, temperature, gravity, mrng),
      clouds: null,
      ocean: null,
      rings: null,
      moons: [],
      bands: null,
      interest: clamp01(mrng.range(0, 0.35) + (pressure > 0.05 ? 0.25 : 0)),
      blurb: blurb(hashSeed(seed, 'blurb'), 'planet', {
        type,
        temperature,
        gravity,
        radius: radiusKm,
        pressure,
        moons: 0,
      }),
      isMoon: true,
    });

    aKm = Math.min(aKm * mrng.range(1.5, 2.4), maxAKm);
  }

  return moons;
}

// ---------------------------------------------------------------------------

/**
 * Generate one world. Pure: same context in, same planet out, forever.
 */
export function generatePlanet(ctx: PlanetContext): PlanetSpec {
  const rng = rngFrom(ctx.seed, 'planet');

  const { type, massEarth } = classifyPlanet(rng, ctx);
  const radiusKm = radiusKmFor(type, massEarth, rng);
  const rEarth = radiusKm / EARTH_RADIUS;
  const gravity = (G_EARTH * massEarth) / Math.max(1e-6, rEarth * rEarth);

  // --- climate -------------------------------------------------------------
  const albedo = albedoFor(type, rng);
  const flux = ctx.luminosity / (ctx.semiMajorAxisAu * ctx.semiMajorAxisAu);
  const tEq = Math.max(T_CMB, T_EQ_1AU * Math.pow(Math.max(0, flux) * (1 - albedo), 0.25));

  const pressure = pressureFor(type, massEarth, radiusKm, tEq, rng);

  /**
   * Greenhouse forcing, as an additive ΔT with a ceiling.
   *
   * Logarithmic in pressure because absorption bands saturate — doubling an
   * already-opaque atmosphere buys much less than doubling a thin one. 0.18
   * puts Earth at 287 K from a 255 K equilibrium, which is the calibration
   * point; the runaway branch gets a steeper coefficient because on Venus the
   * water that would have closed the bands left four billion years ago
   * (230 K + 437 K = 667 K, against a real 737 K).
   *
   * The cap is the part that matters. Written as a *multiplier* on T_eq —
   * the tempting form — the forcing compounds with an already-scorching orbit
   * and produces 1300 K worlds from a Venus-like atmosphere. Forcing does not
   * work that way: it is bounded by how much of the outgoing spectrum the
   * atmosphere can actually intercept, and once the bands are shut, more gas
   * buys nothing.
   */
  const ghCoefficient = type === 'toxic' ? 0.42 : 0.18;
  const ghMax = type === 'toxic' ? 520 : 90;
  const greenhouse = Math.min(ghMax, tEq * ghCoefficient * Math.log1p(Math.max(0, pressure)));
  const temperature = tEq + greenhouse;

  // --- rotation ------------------------------------------------------------
  const locked = ctx.semiMajorAxisAu < lockRadiusAu(ctx.starMassSolar);
  const periodS = orbitalPeriodSeconds(ctx.semiMajorAxisAu, ctx.starMassSolar);
  const rotationPeriod = locked
    ? periodS
    : // Giants spin fast (they never shed angular momentum to a moon system the
      // way a terrestrial does); rocks spin at a day-ish. The 8% retrograde rate
      // is roughly Sol's, where two of eight planets turn the wrong way.
      (rng.chance(0.08) ? -1 : 1) *
      (type === 'gas-giant' || type === 'ice-giant'
        ? rng.range(28000, 62000)
        : rng.range(20000, 900000));

  const axialTilt = locked
    ? Math.abs(rng.gaussian(0, 0.04)) // tides damp obliquity to zero as well
    : Math.abs(rng.gaussian(0, 0.42));

  // --- surface -------------------------------------------------------------
  const terrain = terrainFor(type, radiusKm, gravity, rng);
  const palette = paletteFor(type, rng);
  const atmosphere = atmosphereFor(type, pressure, radiusKm, temperature, gravity, rng);
  const clouds = cloudsFor(type, pressure, radiusKm, rotationPeriod, rng);
  const ocean = oceanFor(type, temperature, rng);
  const rings = ringsFor(type, ctx.seed, rng);
  const bands = bandsFor(type, temperature, rng);

  const name = planetName(hashSeed(ctx.seed, 'name'), ctx.systemName, ctx.index);

  const moons = moonsFor(
    ctx.seed,
    ctx.id,
    name,
    type,
    massEarth,
    radiusKm,
    ctx.luminosity,
    ctx.semiMajorAxisAu,
    ctx.starMassSolar,
    rng,
  );

  /**
   * Scanner interest, 0..1 — the number that decides whether the HUD pings.
   * Weighted towards things worth *landing* for, not things worth looking at:
   * a breathable temperate world outranks a spectacular ringed giant, because
   * you can walk on one of them.
   */
  let interest = rng.range(0, 0.2);
  if (type === 'terran') interest += 0.5;
  else if (type === 'ocean') interest += 0.4;
  else if (type === 'volcanic') interest += 0.28;
  else if (type === 'toxic') interest += 0.16;
  if (ocean !== null) interest += 0.1;
  if (rings !== null) interest += 0.12;
  if (moons.length >= 3) interest += 0.08;
  if (temperature > 250 && temperature < 320) interest += 0.15;
  if (pressure > 0.3 && pressure < 4) interest += 0.12;

  return {
    id: ctx.id,
    seed: ctx.seed,
    name,
    type,
    radius: radiusKm,
    mass: massEarth,
    gravity,
    orbit: orbitFor(rng, ctx.semiMajorAxisAu * AU, periodS),
    rotationPeriod,
    axialTilt,
    temperature,
    terrain,
    palette,
    atmosphere,
    clouds,
    ocean,
    rings,
    moons,
    bands,
    interest: clamp01(interest),
    blurb: blurb(hashSeed(ctx.seed, 'blurb'), 'planet', {
      type,
      temperature,
      gravity,
      radius: radiusKm,
      pressure,
      tidallyLocked: locked ? 1 : 0,
      moons: moons.length,
      rings: rings !== null ? 1 : 0,
      ocean: ocean !== null ? 1 : 0,
      interest,
    }),
    isMoon: false,
  };
}
