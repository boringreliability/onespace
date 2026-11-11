/**
 * The asteroid belt and its fields (sub-plan 2, Task 1).
 *
 * `beltFor` places one band per system that has `hasAsteroidBelt`, between the
 * planets and around the snow line. `fieldSpec(belt, seed, k)` lays out one of
 * FIELDS_PER_BELT clusters of asteroids on that band — purely, from
 * `hashSeed(system.seed, …)`, so it never disturbs the system's own rng and
 * any field can be rebuilt on demand from its index alone.
 *
 * The fixture is the real start system: Fyss at DEFAULT_UNIVERSE_SEED, found
 * the way `Universe.pickStartSystem` finds its candidates (probe at 0.34 of the
 * disc radius, first 24 systems sampled about it).
 */

import { describe, expect, it } from 'vitest';
import { Rng, hashSeed } from '@/math/rng';
import { generateGalaxy, sampleSystemsNear } from './galaxy';
import { generateSystem } from './system';
import { orbitalPosition } from './orbit';
import { AU, type StarSystemSpec, type Vec3 } from './types';
import { DEFAULT_UNIVERSE_SEED } from '@/game/Universe';
import {
  ASTEROID_RADIUS_KM,
  FIELDS_PER_BELT,
  FIELD_RADIUS_KM,
  beltFor,
  fieldOrbits,
  fieldSpec,
  nearestFieldIndex,
  type BeltSpec,
  type FieldSpec,
  type Resource,
} from './belt';

/** The 24 start candidates of `Universe.pickStartSystem`, freshly generated. */
function startCandidates(seed: number): StarSystemSpec[] {
  const galaxy = generateGalaxy(seed);
  const rng = new Rng(hashSeed(seed, 'start'));
  const r = galaxy.radiusLy * 0.34;
  const theta = rng.range(0, Math.PI * 2);
  const probe: Vec3 = [r * Math.cos(theta), rng.gaussian(0, 30), r * Math.sin(theta)];
  return sampleSystemsNear(galaxy, probe, 260, 96)
    .slice(0, 24)
    .map((stub) => generateSystem(galaxy, stub));
}

function fyss(): StarSystemSpec {
  const sys = startCandidates(DEFAULT_UNIVERSE_SEED).find((s) => s.name === 'Fyss');
  if (!sys) throw new Error('Fyss is not among the start candidates');
  return sys;
}

const CANDIDATES = startCandidates(DEFAULT_UNIVERSE_SEED);
const FYSS = fyss();
const FYSS_BELT = beltFor(FYSS) as BeltSpec;
/** Every field of Fyss's belt, built once. */
const FYSS_FIELDS: FieldSpec[] = Array.from({ length: FIELDS_PER_BELT }, (_, k) =>
  fieldSpec(FYSS_BELT, FYSS.seed, k),
);

/** A few fields from the other belted start candidates, so "any field" is not just Fyss. */
const OTHER_FIELDS: FieldSpec[] = CANDIDATES.filter((s) => s.hasAsteroidBelt && s.id !== FYSS.id)
  .flatMap((s) => {
    const b = beltFor(s);
    return b ? [0, 1, 97, FIELDS_PER_BELT - 1].map((k) => fieldSpec(b, s.seed, k)) : [];
  });

const ALL_FIELDS = [...FYSS_FIELDS, ...OTHER_FIELDS];

const RESOURCES: readonly Resource[] = ['ice', 'metal', 'silicate', 'rare'];

function snowLineAu(sys: StarSystemSpec): number {
  return 2.7 * Math.sqrt(Math.max(0.02, sys.stars[0]!.luminosity));
}

describe('beltFor — placement', () => {
  it('Given Fyss (start system), Then beltFor returns a belt whose band [inner, outer] AU contains no planet\'s semi-major axis and lies between 0.6× and 3× the snow line 2.7·√max(0.02, L)', () => {
    expect(FYSS.hasAsteroidBelt).toBe(true);
    expect(FYSS_BELT).not.toBeNull();
    const { innerAU, outerAU } = FYSS_BELT;
    expect(Number.isFinite(innerAU)).toBe(true);
    expect(Number.isFinite(outerAU)).toBe(true);
    expect(innerAU).toBeGreaterThan(0);
    expect(outerAU).toBeGreaterThan(innerAU);

    for (const p of FYSS.planets) {
      const a = p.orbit.semiMajorAxis / AU;
      expect(a < innerAU || a > outerAU, `${p.name} at ${a} AU`).toBe(true);
    }

    const snow = snowLineAu(FYSS);
    expect(innerAU).toBeGreaterThanOrEqual(0.6 * snow);
    expect(outerAU).toBeLessThanOrEqual(3 * snow);

    expect(FYSS_BELT.systemId).toBe(FYSS.id);
    expect(FYSS_BELT.fieldCount).toBe(FIELDS_PER_BELT);
    expect(FYSS_BELT.halfThicknessAU).toBeGreaterThan(0);
  });

  it('Given a system without hasAsteroidBelt, Then beltFor is null', () => {
    const bare = CANDIDATES.filter((s) => !s.hasAsteroidBelt);
    expect(bare.length).toBeGreaterThan(0);
    for (const s of bare) expect(beltFor(s)).toBeNull();
  });
});

describe('fieldSpec — determinism and identity', () => {
  it('Given the same system twice (fresh generation), Then belt and fieldSpec(k) are deep-equal; a different k gives a different field', () => {
    const again = fyss();
    const beltA = beltFor(FYSS);
    const beltB = beltFor(again);
    expect(beltB).toEqual(beltA);
    for (const k of [0, 1, 255, FIELDS_PER_BELT - 1]) {
      expect(fieldSpec(beltB as BeltSpec, again.seed, k)).toEqual(
        fieldSpec(beltA as BeltSpec, FYSS.seed, k),
      );
    }
    expect(fieldSpec(FYSS_BELT, FYSS.seed, 1)).not.toEqual(fieldSpec(FYSS_BELT, FYSS.seed, 0));
  });

  it('Given field k, Then its id is field:<systemId>:<k> and each asteroid id is ast:<systemId>:<k>:<n>, all unique', () => {
    const seen = new Set<string>();
    FYSS_FIELDS.forEach((f, k) => {
      expect(f.index).toBe(k);
      expect(f.id).toBe(`field:${FYSS.id}:${k}`);
      expect(seen.has(f.id)).toBe(false);
      seen.add(f.id);
      f.asteroids.forEach((a, n) => {
        expect(a.id).toBe(`ast:${FYSS.id}:${k}:${n}`);
        expect(seen.has(a.id)).toBe(false);
        seen.add(a.id);
      });
    });
  });
});

describe('fieldSpec — asteroids', () => {
  it('Given any field, Then 12–30 asteroids, radii in [0.4, 4] km, every offset within FIELD_RADIUS_KM (80), composition kg all ≥ 0 and finite', () => {
    expect(FIELD_RADIUS_KM).toBe(80);
    expect(ASTEROID_RADIUS_KM).toEqual([0.4, 4]);
    expect(OTHER_FIELDS.length).toBeGreaterThan(0);
    for (const f of ALL_FIELDS) {
      expect(f.radiusKm).toBe(FIELD_RADIUS_KM);
      expect(f.asteroids.length).toBeGreaterThanOrEqual(12);
      expect(f.asteroids.length).toBeLessThanOrEqual(30);
      for (const a of f.asteroids) {
        expect(a.radiusKm).toBeGreaterThanOrEqual(0.4);
        expect(a.radiusKm).toBeLessThanOrEqual(4);
        const [x, y, z] = a.offsetKm;
        expect(Math.hypot(x, y, z)).toBeLessThanOrEqual(FIELD_RADIUS_KM);
        for (const r of RESOURCES) {
          const kg = a.composition[r];
          expect(Number.isFinite(kg), `${a.id} ${r}`).toBe(true);
          expect(kg).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('Given any field, Then at least 3 asteroids carry ≥ 1 000 kg ice', () => {
    for (const f of ALL_FIELDS) {
      const icy = f.asteroids.filter((a) => a.composition.ice >= 1000).length;
      expect(icy, f.id).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('fieldSpec — bigger rocks that never overlap (owner decision: usable belt)', () => {
  /** Every field of every belted start candidate: 512 × the belted systems. */
  const EVERY_FIELD: FieldSpec[] = CANDIDATES.flatMap((s) => {
    const b = beltFor(s);
    return b ? Array.from({ length: b.fieldCount }, (_, k) => fieldSpec(b, s.seed, k)) : [];
  });

  it('Given every field of every belted start system, Then no two asteroids overlap: centre distance ≥ r1 + r2 + 0.5 km for every pair', () => {
    expect(EVERY_FIELD.length).toBeGreaterThanOrEqual(2 * FIELDS_PER_BELT);
    let pairs = 0;
    for (const f of EVERY_FIELD) {
      const as = f.asteroids;
      for (let i = 0; i < as.length; i++) {
        for (let j = i + 1; j < as.length; j++) {
          const a = as[i]!;
          const b = as[j]!;
          const d = Math.hypot(a.offsetKm[0] - b.offsetKm[0], a.offsetKm[1] - b.offsetKm[1], a.offsetKm[2] - b.offsetKm[2]);
          pairs++;
          if (d < a.radiusKm + b.radiusKm + 0.5) {
            expect.fail(`${a.id} and ${b.id} overlap: centres ${d.toFixed(3)} km apart, radii ${a.radiusKm.toFixed(3)} + ${b.radiusKm.toFixed(3)}`);
          }
        }
      }
    }
    expect(pairs).toBeGreaterThan(0);
  });

  it('Given every field of every belted start system, Then the radii fill [0.4, 4] km (some rocks above 2 km, none below 0.4) and every field keeps ≥ 3 rocks with ≥ 1 000 kg ice', () => {
    let big = 0;
    for (const f of EVERY_FIELD) {
      for (const a of f.asteroids) {
        expect(a.radiusKm, a.id).toBeGreaterThanOrEqual(0.4);
        expect(a.radiusKm, a.id).toBeLessThanOrEqual(4);
        if (a.radiusKm > 2) big++;
      }
      expect(f.asteroids.filter((a) => a.composition.ice >= 1000).length, f.id).toBeGreaterThanOrEqual(3);
    }
    expect(big).toBeGreaterThan(0);
  });

  it('Given every asteroid, Then its extractable mass stays in [5 000, 65 000] kg — the resource economy is not scaled with the bigger rocks', () => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    for (const f of EVERY_FIELD) {
      for (const a of f.asteroids) {
        const sum = RESOURCES.reduce((s, r) => s + a.composition[r], 0);
        lo = Math.min(lo, sum);
        hi = Math.max(hi, sum);
      }
    }
    expect(lo).toBeGreaterThanOrEqual(5000 - 2);
    expect(hi).toBeLessThanOrEqual(65000 + 2);
  });
});

describe('fieldSpec — orbit', () => {
  it('Given a field orbit, Then its semi-major axis lies inside the band, e < 0.05, |i| < halfThickness/a', () => {
    const belts = new Map<string, BeltSpec>();
    for (const s of CANDIDATES) {
      const b = beltFor(s);
      if (b) belts.set(s.id, b);
    }
    for (const f of ALL_FIELDS) {
      const systemId = f.id.slice('field:'.length, f.id.lastIndexOf(':'));
      const b = belts.get(systemId)!;
      expect(b, f.id).toBeDefined();
      const aAU = f.orbit.semiMajorAxis / AU;
      expect(aAU).toBeGreaterThanOrEqual(b.innerAU);
      expect(aAU).toBeLessThanOrEqual(b.outerAU);
      expect(f.orbit.eccentricity).toBeGreaterThanOrEqual(0);
      expect(f.orbit.eccentricity).toBeLessThan(0.05);
      expect(Math.abs(f.orbit.inclination)).toBeLessThan(b.halfThicknessAU / aAU);
      expect(f.orbit.period).toBeGreaterThan(0);
    }
  });
});

describe('nearestFieldIndex', () => {
  it('Given a world position placed exactly at field k\'s position at time t, Then nearestFieldIndex returns k (for t = 0 and t = one tenth of an orbit)', () => {
    const orbits = fieldOrbits(FYSS_BELT, FYSS.seed);
    for (const k of [0, 1, 2, 137, 256, FIELDS_PER_BELT - 2, FIELDS_PER_BELT - 1]) {
      const f = FYSS_FIELDS[k]!;
      for (const t of [0, f.orbit.period / 10]) {
        const pos = orbitalPosition(f.orbit, t);
        expect(nearestFieldIndex(orbits, pos, t), `k=${k} t=${t}`).toBe(k);
      }
    }
  });

  it('Given t = 10 years and a position 30 km off field k\'s centre, Then nearestFieldIndex still returns k (differential rotation and off-centre ships)', () => {
    const orbits = fieldOrbits(FYSS_BELT, FYSS.seed);
    const t = 10 * 365.25 * 86_400;
    for (const k of [0, 3, 200, 401, FIELDS_PER_BELT - 1]) {
      const p = orbitalPosition(FYSS_FIELDS[k]!.orbit, t);
      const pos = { x: p.x + 18, y: p.y - 12, z: p.z + 20.8 }; // |offset| ≈ 30 km
      expect(nearestFieldIndex(orbits, pos, t), `k=${k}`).toBe(k);
    }
  });
});

describe('R6 — fieldOrbits, readonly offsets, guarded k', () => {
  it('Given Fyss\'s belt, Then fieldOrbits returns FIELDS_PER_BELT orbits, orbit k deep-equal to fieldSpec(k).orbit', () => {
    const orbits = fieldOrbits(FYSS_BELT, FYSS.seed);
    expect(orbits.length).toBe(FIELDS_PER_BELT);
    for (let k = 0; k < FIELDS_PER_BELT; k++) {
      expect(orbits[k], `k=${k}`).toEqual(FYSS_FIELDS[k]!.orbit);
    }
  });

  it('Given fieldOrbits called twice for the same system, Then the same array is returned (computed once per system, not per call)', () => {
    expect(fieldOrbits(FYSS_BELT, FYSS.seed)).toBe(fieldOrbits(FYSS_BELT, FYSS.seed));
    // An equal belt rebuilt from a fresh generation of the same system hits the same cache.
    const again = fyss();
    expect(fieldOrbits(beltFor(again) as BeltSpec, again.seed)).toBe(fieldOrbits(FYSS_BELT, FYSS.seed));
  });

  it('Given another belted system, Then its fieldOrbits differ from Fyss\'s (the cache is keyed per system)', () => {
    const other = CANDIDATES.find((s) => s.hasAsteroidBelt && s.id !== FYSS.id)!;
    const b = beltFor(other) as BeltSpec;
    const orbits = fieldOrbits(b, other.seed);
    expect(orbits).not.toBe(fieldOrbits(FYSS_BELT, FYSS.seed));
    expect(orbits[7]).toEqual(fieldSpec(b, other.seed, 7).orbit);
  });

  it('Given k outside [0, FIELDS_PER_BELT) or not an integer, Then fieldSpec throws', () => {
    for (const k of [-1, FIELDS_PER_BELT, FIELDS_PER_BELT + 10, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => fieldSpec(FYSS_BELT, FYSS.seed, k), `k=${k}`).toThrow();
    }
    expect(() => fieldSpec(FYSS_BELT, FYSS.seed, 0)).not.toThrow();
    expect(() => fieldSpec(FYSS_BELT, FYSS.seed, FIELDS_PER_BELT - 1)).not.toThrow();
  });

  it('Given an AsteroidSpec, Then offsetKm is a readonly tuple (compile-time: `tsc --noEmit` rejects a write)', () => {
    // Never executed; checked by the type checker. The directive itself fails
    // `npm run typecheck` while offsetKm is still a mutable tuple.
    const mustNotCompile = (f: FieldSpec): void => {
      // @ts-expect-error offsetKm is readonly [number, number, number]
      f.asteroids[0]!.offsetKm[0] = 1;
    };
    expect(typeof mustNotCompile).toBe('function');
  });
});

describe('seeds', () => {
  /**
   * Golden values recorded from generateSystem BEFORE belt.ts existed
   * (DEFAULT_UNIVERSE_SEED, Fyss). The belt draws from hashSeed(system.seed, …),
   * never from generateSystem's sequential rng, so these must not move.
   */
  const GOLDEN_FYSS_PLANETS: readonly (readonly [string, number])[] = [
    ['Fyss I', 3965570.004609258],
    ['Fyss c', 8178108.409524087],
    ['Remit 31 / Fyss', 15156412.43106267],
    ['Vassa', 30368676.617454786],
    ['Vhessvaem', 64602309.165128134],
    ['Grey Angle', 121627675.39595845],
    ['Fyss VII', 258298795.82014716],
    ['Fyss VIII', 546748334.7826301],
  ];

  it('Given generateSystem before and after this task, Then planets are unchanged', () => {
    const sys = fyss();
    beltFor(sys);
    fieldSpec(FYSS_BELT, sys.seed, 0);
    expect(sys.planets.map((p) => p.name)).toEqual(GOLDEN_FYSS_PLANETS.map(([n]) => n));
    sys.planets.forEach((p, i) => {
      const golden = GOLDEN_FYSS_PLANETS[i]![1];
      expect(Math.abs(p.orbit.semiMajorAxis - golden) / golden).toBeLessThan(1e-12);
    });
    // And building belts/fields leaves a fresh generation untouched.
    expect(fyss()).toEqual(sys);
  });
});

// ---------------------------------------------------------------------------
// Mutation hardening (Task 8, phase A): a hand-built system pins the gap rule.
// ---------------------------------------------------------------------------

/** A synthetic system: only what beltFor reads (luminosity, mass, planet axes). */
function synth(luminosity: number | null, axesAu: readonly number[], withStar = true): StarSystemSpec {
  return {
    id: 'sys-synth',
    seed: 4242,
    name: 'Synth',
    hasAsteroidBelt: true,
    stars: withStar ? [{ luminosity: luminosity ?? 0, mass: 1 }] : [],
    planets: axesAu.map((a) => ({ orbit: { semiMajorAxis: a * AU } })),
  } as unknown as StarSystemSpec;
}

/** Snow line of luminosity 1 is 2.7 AU: window [1.62, 8.1]. */
const SNOW1 = 2.7;

describe('beltFor — the gap-selection rule, on a synthetic system', () => {
  it('Given no planets, Then the fallback band is centred on 1.2·snow, ±15 %, half-thickness 0.03·c', () => {
    const b = beltFor(synth(1, []))!;
    const c = 1.2 * SNOW1;
    expect(b.innerAU).toBeCloseTo(0.85 * c, 12);
    expect(b.outerAU).toBeCloseTo(1.15 * c, 12);
    expect(b.halfThicknessAU).toBeCloseTo(0.03 * c, 12);
    expect(b.fieldCount).toBe(512);
    expect(b.systemId).toBe('sys-synth');
  });

  it('Given a gap of exactly ratio 1.4 (2.5 → 3.5 AU), Then it qualifies: centre √(a_in·a_out), half-width 0.15·c, half-thickness 0.03·c', () => {
    const b = beltFor(synth(1, [2.5, 3.5]))!;
    const c = Math.sqrt(2.5 * 3.5);
    expect(b.innerAU).toBeCloseTo(Math.max(0.85 * c, 1.62, 2.5 * 1.02), 12);
    expect(b.outerAU).toBeCloseTo(1.15 * c, 12);
    expect(b.halfThicknessAU).toBeCloseTo(0.03 * c, 12);
    // not the fallback centre 3.24
    expect(Math.abs(b.halfThicknessAU - 0.03 * 1.2 * SNOW1)).toBeGreaterThan(1e-4);
  });

  it('Given gaps of ratio 1.39 and 1.35, Then neither qualifies and the fallback band is used', () => {
    for (const out of [3.475, 3.375]) {
      const b = beltFor(synth(1, [2.5, out]))!;
      expect(b.halfThicknessAU, `out=${out}`).toBeCloseTo(0.03 * 1.2 * SNOW1, 12);
      expect(b.innerAU).toBeCloseTo(0.85 * 1.2 * SNOW1, 12);
    }
  });

  it('Given a qualifying gap of ratio 1.42, Then the inner edge keeps 2 % clear of the inner planet (a_in·1.02 beats 0.85·c)', () => {
    const b = beltFor(synth(1, [2.5, 3.55]))!;
    const c = Math.sqrt(2.5 * 3.55);
    expect(0.85 * c).toBeLessThan(2.5 * 1.02); // the fixture is right
    expect(b.innerAU).toBeCloseTo(2.5 * 1.02, 12);
    expect(b.outerAU).toBeCloseTo(1.15 * c, 12);
  });

  it("Given a gap whose outer planet is below 0.6·snow, Then it is ignored: the window starts at 0.6·snow", () => {
    // 1.0 → 1.5 AU: ratio 1.5, a_out = 1.5 < 0.6·2.7 = 1.62.
    const b = beltFor(synth(1, [1.0, 1.5]))!;
    expect(b.halfThicknessAU).toBeCloseTo(0.03 * 1.2 * SNOW1, 12);
  });

  it('Given two qualifying gaps, Then the wider (larger ratio) one wins', () => {
    const b = beltFor(synth(1, [2.5, 3.55, 5.5]))!; // 1.42 then 1.549
    const c = Math.sqrt(3.55 * 5.5);
    expect(b.halfThicknessAU).toBeCloseTo(0.03 * c, 12);
  });

  it('Given planet axes out of order, Then they are sorted before gaps are read', () => {
    const b = beltFor(synth(1, [3.5, 2.5]))!;
    expect(b.halfThicknessAU).toBeCloseTo(0.03 * Math.sqrt(2.5 * 3.5), 12);
  });

  it('Given luminosity far below 0.02 (or no star at all), Then the snow line is floored at 2.7·√0.02', () => {
    const c = 1.2 * 2.7 * Math.sqrt(0.02);
    for (const sys of [synth(0.0001, []), synth(0, []), synth(null, [], false)]) {
      const b = beltFor(sys)!;
      expect(b.halfThicknessAU).toBeCloseTo(0.03 * c, 12);
      expect(b.innerAU).toBeCloseTo(0.85 * c, 12);
    }
  });

  it('Given hasAsteroidBelt false, Then beltFor is null', () => {
    expect(beltFor({ ...synth(1, []), hasAsteroidBelt: false } as StarSystemSpec)).toBeNull();
  });
});

describe('fieldSpec — constants and composition rules', () => {
  it('Then FIELDS_PER_BELT is 512', () => {
    expect(FIELDS_PER_BELT).toBe(512);
    expect(FYSS_BELT.fieldCount).toBe(512);
    expect(fieldOrbits(FYSS_BELT, FYSS.seed).length).toBe(512);
  });

  it('Given any asteroid, Then its extractable mass is 5000 + 60000·(radius fraction), to rounding', () => {
    for (const f of ALL_FIELDS) {
      for (const a of f.asteroids) {
        const sum = RESOURCES.reduce((s, r) => s + a.composition[r], 0);
        const expected = 5000 + 60000 * ((a.radiusKm - 0.4) / (4 - 0.4));
        expect(Math.abs(sum - expected)).toBeLessThanOrEqual(2);
      }
    }
  });

  it('Given any asteroid, Then it sits at most FIELD_RADIUS_KM − 1 km from the field centre', () => {
    for (const f of ALL_FIELDS) {
      for (const a of f.asteroids) {
        expect(Math.hypot(...a.offsetKm)).toBeLessThanOrEqual(FIELD_RADIUS_KM - 1 + 1e-9);
      }
    }
  });

  it('Given every field, Then asteroids 0, 1, 2 are ice-major (≥ 60 % ice) and asteroid 3 is an ordinary draw', () => {
    const share = (a: FieldSpec['asteroids'][number]): number => {
      const t = RESOURCES.reduce((s, r) => s + a.composition[r], 0);
      return a.composition.ice / t;
    };
    let nonIcyAtThree = 0;
    for (const f of ALL_FIELDS) {
      for (let n = 0; n < 3; n++) expect(share(f.asteroids[n]!), `${f.id} #${n}`).toBeGreaterThan(0.59);
      if (share(f.asteroids[3]!) < 0.5) nonIcyAtThree++;
    }
    expect(nonIcyAtThree).toBeGreaterThan(0);
  });
});

describe('fieldOrbits — cache keyed by system id AND seed', () => {
  it('Given the same belt asked with two different seeds, Then the orbits differ and each equals its own fieldSpec orbits', () => {
    const sA = FYSS.seed;
    const sB = FYSS.seed + 1;
    const a1 = fieldOrbits(FYSS_BELT, sA);
    const b1 = fieldOrbits(FYSS_BELT, sB);
    expect(b1).not.toBe(a1);
    expect(b1[5]).not.toEqual(a1[5]);
    expect(b1[5]).toEqual(fieldSpec(FYSS_BELT, sB, 5).orbit);
    const a2 = fieldOrbits(FYSS_BELT, sA);
    expect(a2[5]).toEqual(fieldSpec(FYSS_BELT, sA, 5).orbit);
  });
});

describe('nearestFieldIndex — the shortlist is wider than one', () => {
  it('Given a field the planar estimate loves but whose eccentric orbit puts it far away, Then the exactly-placed runner-up wins', () => {
    const base = {
      inclination: 0,
      longitudeOfAscendingNode: 0,
      argumentOfPeriapsis: 0,
      meanAnomalyAtEpoch: 0,
      period: 1e7,
    };
    const A = 1e8;
    // k=0: a = A but e = 0.5, so at periapsis it is at 0.5·A from the star.
    const eccentric = { ...base, semiMajorAxis: A, eccentricity: 0.5 };
    // k=1: circular at 0.9·A.
    const circular = { ...base, semiMajorAxis: 0.9 * A, eccentricity: 0 };
    const ship = { x: A, y: 0, z: 0 };
    const p0 = orbitalPosition(eccentric, 0);
    const p1 = orbitalPosition(circular, 0);
    const exact0 = Math.hypot(p0.x - ship.x, p0.y - ship.y, p0.z - ship.z);
    const exact1 = Math.hypot(p1.x - ship.x, p1.y - ship.y, p1.z - ship.z);
    expect(exact1).toBeLessThan(exact0); // fixture sanity: k=1 is truly nearer
    expect(nearestFieldIndex([eccentric, circular], ship, 0)).toBe(1);
  });
});
