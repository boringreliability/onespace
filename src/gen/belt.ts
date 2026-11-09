/**
 * oneSpace — asteroid belts and their fields.
 *
 * A system with `hasAsteroidBelt` gets one band of rubble near its snow line,
 * placed in the widest gap between planets. The band is never instantiated as
 * a whole: it is FIELDS_PER_BELT fields (clusters of a few dozen asteroids),
 * and any one of them can be rebuilt from its index alone with `fieldSpec`.
 *
 * Pure and deterministic. Seeds come only from `hashSeed(system.seed, 'belt')`
 * and `hashSeed(system.seed, 'field:<k>')` — never from generateSystem's
 * sequential rng — so adding belts moves no planet.
 *
 * Frame and units as everywhere in gen: km, seconds, star at the origin, XZ is
 * the invariable plane, Y up.
 */

import { Rng, hashSeed } from '@/math/rng';
import { orbitalPosition } from './orbit';
import { AU, type OrbitSpec, type StarSystemSpec } from './types';

export type Resource = 'ice' | 'metal' | 'silicate' | 'rare';

/** Plain 3-vector; `three`'s Vector3 satisfies it. */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BeltSpec {
  readonly systemId: string;
  readonly innerAU: number;
  readonly outerAU: number;
  readonly halfThicknessAU: number;
  readonly fieldCount: number;
  /** Primary's gravitational parameter, km³/s² — fields need it for their period. */
  readonly starMu: number;
}

export interface AsteroidSpec {
  readonly id: string;
  /** Offset from the field centre, km. */
  readonly offsetKm: readonly [number, number, number];
  readonly radiusKm: number;
  readonly seed: number;
  /** Extractable kilograms of each resource. */
  readonly composition: Record<Resource, number>;
}

export interface FieldSpec {
  readonly id: string;
  readonly index: number;
  /** Orbit of the field centre about the primary. */
  readonly orbit: OrbitSpec;
  readonly radiusKm: number;
  readonly asteroids: readonly AsteroidSpec[];
}

export const FIELDS_PER_BELT = 512;
export const FIELD_RADIUS_KM = 40;
export const ASTEROIDS_PER_FIELD: readonly [number, number] = [12, 30];
export const ASTEROID_RADIUS_KM: readonly [number, number] = [0.05, 0.6];

/** Gravitational parameter of one solar mass, km³/s² (same value as Universe.ts). */
const MU_SUN = 1.32712440018e11;
const TAU = Math.PI * 2;

/** Asteroids guaranteed icy in every field, so finding ice never depends on luck. */
const GUARANTEED_ICY = 3;

/**
 * Snow line, AU. Uses the primary's PRESENT luminosity. The planet generator's
 * frostLine (system.ts) uses the FORMATION luminosity instead; the two agree
 * for every main-sequence star and differ only for stellar remnants (a white
 * dwarf's belt would sit inside where its planets think the snow line was).
 */
function snowLineAu(system: StarSystemSpec): number {
  return 2.7 * Math.sqrt(Math.max(0.02, system.stars[0]?.luminosity ?? 0));
}

export function beltFor(system: StarSystemSpec): BeltSpec | null {
  if (!system.hasAsteroidBelt) return null;
  const snow = snowLineAu(system);
  const lo = 0.6 * snow;
  const hi = 3 * snow;

  const axes = system.planets.map((p) => p.orbit.semiMajorAxis / AU).sort((a, b) => a - b);
  let best: [number, number] | null = null;
  let bestRatio = 0;
  for (let i = 0; i + 1 < axes.length; i++) {
    const aIn = axes[i]!;
    const aOut = axes[i + 1]!;
    const ratio = aOut / aIn;
    if (ratio >= 1.4 && aIn < hi && aOut > lo && ratio > bestRatio) {
      bestRatio = ratio;
      best = [aIn, aOut];
    }
  }

  let c = 1.2 * snow;
  let inner = 0.85 * c;
  let outer = 1.15 * c;
  if (best) {
    const [aIn, aOut] = best;
    const cg = Math.sqrt(aIn * aOut);
    // Clip to the window and to the gap, so a gap that only grazes the window
    // still yields a band that is inside both.
    const gi = Math.max(0.85 * cg, lo, aIn * 1.02);
    const go = Math.min(1.15 * cg, hi, aOut / 1.02);
    if (go / gi >= 1.05) {
      c = cg;
      inner = gi;
      outer = go;
    }
  }

  return {
    systemId: system.id,
    innerAU: inner,
    outerAU: outer,
    halfThicknessAU: 0.03 * c,
    fieldCount: FIELDS_PER_BELT,
    starMu: MU_SUN * (system.stars[0]?.mass ?? 1),
  };
}

/** Whole-belt rotation, so field 0 does not always sit on the +X axis. */
function beltPhase(systemSeed: number): number {
  return new Rng(hashSeed(systemSeed, 'belt')).range(0, TAU);
}

function wrapAngle(x: number): number {
  const r = x % TAU;
  return r < 0 ? r + TAU : r;
}

/**
 * The field centre's orbit. Drawn FIRST from the field's rng, so this helper
 * and `fieldSpec` agree and the nearest-field search need not build asteroids.
 */
function drawOrbit(belt: BeltSpec, rng: Rng, k: number, phase: number): OrbitSpec {
  const aAU = rng.range(belt.innerAU, belt.outerAU);
  // Small e keeps true longitude within a fraction of a field spacing of the
  // mean longitude the fields are laid out on.
  const eccentricity = rng.range(0, 0.002);
  const inclination = rng.range(-0.8, 0.8) * (belt.halfThicknessAU / aAU);
  const longitudeOfAscendingNode = rng.range(0, TAU);
  const argumentOfPeriapsis = rng.range(0, TAU);
  const spacing = TAU / FIELDS_PER_BELT;
  const jitter = rng.range(-0.3, 0.3) * spacing;
  const meanLongitude = phase + k * spacing + jitter;
  const a = aAU * AU;
  return {
    semiMajorAxis: a,
    eccentricity,
    inclination,
    longitudeOfAscendingNode,
    argumentOfPeriapsis,
    meanAnomalyAtEpoch: wrapAngle(meanLongitude - longitudeOfAscendingNode - argumentOfPeriapsis),
    period: TAU * Math.sqrt((a * a * a) / belt.starMu),
  };
}

function fieldRng(systemSeed: number, k: number): Rng {
  return new Rng(hashSeed(systemSeed, `field:${k}`));
}

function drawComposition(rng: Rng, radiusKm: number, icy: boolean): Record<Resource, number> {
  const [rMin, rMax] = ASTEROID_RADIUS_KM;
  // Extractable mass in game kilograms: a small rock still pays out a few tonnes.
  const total = 5000 + 60000 * ((radiusKm - rMin) / (rMax - rMin));
  const kind = icy ? 0 : rng.int(0, 2);
  const major = rng.range(0.6, 0.85);
  const rare = rng.range(0, 0.03);
  const restA = rng.range(0, 1 - major - rare);
  const restB = 1 - major - rare - restA;
  let ice: number;
  let metal: number;
  let silicate: number;
  if (kind === 0) [ice, metal, silicate] = [major, restA, restB];
  else if (kind === 1) [metal, silicate, ice] = [major, restA, restB];
  else [silicate, ice, metal] = [major, restA, restB];
  const kg = (f: number): number => Math.max(0, Math.round(total * f));
  return { ice: kg(ice), metal: kg(metal), silicate: kg(silicate), rare: kg(rare) };
}

export function fieldSpec(belt: BeltSpec, systemSeed: number, k: number): FieldSpec {
  if (!Number.isInteger(k) || k < 0 || k >= belt.fieldCount) {
    throw new RangeError(`fieldSpec: k=${k} outside [0, ${belt.fieldCount})`);
  }
  const rng = fieldRng(systemSeed, k);
  const orbit = drawOrbit(belt, rng, k, beltPhase(systemSeed));
  const count = rng.int(ASTEROIDS_PER_FIELD[0], ASTEROIDS_PER_FIELD[1]);
  const asteroids: AsteroidSpec[] = [];
  for (let n = 0; n < count; n++) {
    const radiusKm = rng.power(ASTEROID_RADIUS_KM[0], ASTEROID_RADIUS_KM[1], -1.5);
    // Uniform in a ball, kept a kilometre inside the field edge.
    let dx = rng.gaussian();
    let dy = rng.gaussian() * 0.5;
    let dz = rng.gaussian();
    const len = Math.hypot(dx, dy, dz) || 1;
    const dist = (FIELD_RADIUS_KM - 1) * Math.cbrt(rng.next());
    dx = (dx / len) * dist;
    dy = (dy / len) * dist;
    dz = (dz / len) * dist;
    const seed = rng.nextUint();
    asteroids.push({
      id: `ast:${belt.systemId}:${k}:${n}`,
      offsetKm: [dx, dy, dz],
      radiusKm,
      seed,
      composition: drawComposition(rng, radiusKm, n < GUARANTEED_ICY),
    });
  }
  return {
    id: `field:${belt.systemId}:${k}`,
    index: k,
    orbit,
    radiusKm: FIELD_RADIUS_KM,
    asteroids,
  };
}

/** One cached entry: the last system asked for (a session sits in one system at a time). */
let orbitsCache: { key: string; orbits: readonly OrbitSpec[] } | null = null;

/**
 * Every field centre's orbit, index k = field k. Computed once per system
 * (keyed by systemId and seed, so an equal belt rebuilt from a fresh
 * generation hits the same array) — drawing 512 orbits costs ~50 µs, too much
 * for a per-frame search.
 */
export function fieldOrbits(belt: BeltSpec, systemSeed: number): readonly OrbitSpec[] {
  const key = `${belt.systemId}|${systemSeed}`;
  if (orbitsCache && orbitsCache.key === key) return orbitsCache.orbits;
  const phase = beltPhase(systemSeed);
  const orbits: OrbitSpec[] = [];
  for (let k = 0; k < belt.fieldCount; k++) orbits.push(drawOrbit(belt, fieldRng(systemSeed, k), k, phase));
  orbitsCache = { key, orbits };
  return orbits;
}

const SHORTLIST = 5;
const shortK = new Int32Array(SHORTLIST);
const shortD = new Float64Array(SHORTLIST);
const scratchP = { x: 0, y: 0, z: 0 };

/**
 * Index of the field whose centre is nearest `worldPos` (star-centred km) at
 * `orbitSeconds`, given the system's `fieldOrbits`.
 *
 * Each field's longitude is advanced by its OWN mean motion (fields at the
 * inner edge lap those at the outer edge, so after a while index order no
 * longer matches longitude order), giving a cheap planar distance estimate
 * for every field. Only the best few are then placed exactly with Kepler.
 * Allocation-free.
 */
export function nearestFieldIndex(orbits: readonly OrbitSpec[], worldPos: Vec3Like, orbitSeconds: number): number {
  const rs = Math.hypot(worldPos.x, worldPos.z);
  const lambdaShip = Math.atan2(worldPos.z, worldPos.x);

  let count = 0;
  for (let k = 0; k < orbits.length; k++) {
    const orbit = orbits[k]!;
    const a = orbit.semiMajorAxis;
    const n = TAU / orbit.period;
    const lambda =
      orbit.longitudeOfAscendingNode +
      orbit.argumentOfPeriapsis +
      orbit.meanAnomalyAtEpoch +
      n * orbitSeconds;
    const d2 = rs * rs + a * a - 2 * rs * a * Math.cos(lambda - lambdaShip);
    // Insertion into a tiny sorted shortlist (fixed arrays, no splice).
    if (count === SHORTLIST && d2 >= shortD[SHORTLIST - 1]!) continue;
    let i = count < SHORTLIST ? count++ : SHORTLIST - 1;
    while (i > 0 && shortD[i - 1]! > d2) {
      shortD[i] = shortD[i - 1]!;
      shortK[i] = shortK[i - 1]!;
      i--;
    }
    shortD[i] = d2;
    shortK[i] = k;
  }

  let best = count > 0 ? shortK[0]! : 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let j = 0; j < count; j++) {
    const k = shortK[j]!;
    orbitalPosition(orbits[k]!, orbitSeconds, scratchP);
    const d = Math.hypot(scratchP.x - worldPos.x, scratchP.y - worldPos.y, scratchP.z - worldPos.z);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return best;
}
