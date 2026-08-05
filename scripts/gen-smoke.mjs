/**
 * gen-smoke — end-to-end proof that the generation layer composes.
 *
 *   node scripts/gen-smoke.mjs [universeSeed]
 *
 * The four generator modules (names, galaxy, system, terrain) are written and
 * reviewed independently, and the seams between them are exactly the kind of
 * thing that typechecks perfectly and is still wrong: a planet that invents its
 * own seed typechecks. A system that re-rolls its star instead of consuming the
 * stub typechecks. This script runs the whole chain
 *
 *   generateGalaxy -> sampleSystemsNear -> generateSystem
 *                  -> generatePlanet    -> sampleTerrain
 *
 * and asserts the invariants that make the universe reproducible top-down:
 *
 *   1. The galaxy is a pure function of the universe seed.
 *   2. The full system's primary star IS the stub's star — same temperature and
 *      luminosity, bit for bit, not merely similar.
 *   3. The system carries the stub's identity (id, seed, name, position).
 *   4. Every planet seed is hashSeed(system.seed, 'planet:<i>').
 *   5. Every moon seed is hashSeed(planet.seed, 'moon:<j>').
 *   6. Terrain samples and checksums are stable across repeat evaluation.
 *   7. Re-running the entire chain from the bare universe seed reproduces a
 *      byte-identical universe.
 *
 * Exits 0 on PASS and 1 on the first failed invariant, so it is usable as a CI
 * gate. `--quiet` suppresses the sample and prints only the verdict.
 *
 * The generators are TypeScript with a `@/` path alias, so this bundles them
 * with esbuild (already present, vite depends on it) into a temp ESM module and
 * imports that. No build step and nothing to keep in sync.
 */

import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const QUIET = process.argv.includes('--quiet');
/** Default universe. Any 32-bit number works; this one is just the house seed. */
const DEFAULT_SEED = 0x5eed0a5e;
const SEED = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? DEFAULT_SEED);

// ---------------------------------------------------------------------------
// Bundle the generation layer
// ---------------------------------------------------------------------------

const ENTRY = `
export { generateGalaxy, sampleSystemsNear, buildField, primaryStarFor } from '@/gen/galaxy';
export { generateSystem, generatePlanet, habitableZone } from '@/gen/system';
export { sampleTerrain, sampleTerrainNormal, terrainChecksum } from '@/gen/terrain';
export { hashSeed } from '@/math/rng';
export { AU, EARTH_RADIUS } from '@/gen/types';
`;

async function loadGen() {
  const dir = await mkdtemp(join(tmpdir(), 'onespace-gen-'));
  const entry = join(dir, 'entry.ts');
  const out = join(dir, 'gen.mjs');
  await writeFile(entry, ENTRY, 'utf8');
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    alias: { '@': join(ROOT, 'src') },
  });
  const mod = await import(pathToFileURL(out).href);
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const failures = [];
let checks = 0;

function check(ok, label, detail) {
  checks++;
  if (!ok) failures.push(detail === undefined ? label : `${label} — ${detail}`);
}

function eq(a, b, label) {
  check(Object.is(a, b), label, `expected ${b}, got ${a}`);
}

/** Stable stringify: key order must not decide whether two universes match. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  }
  // Object.is so -0 and NaN survive the round trip; a NaN that appears in one
  // run and not another is the exact bug this whole script exists to catch.
  return typeof v === 'number' ? (Object.is(v, -0) ? '-0' : String(v)) : JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : String(v));

function fmtAtmosphere(a) {
  if (a === null) return 'none';
  return `${num(a.pressure, 3)} bar  H=${num(a.scaleHeight, 1)}km  t=${num(a.thickness, 0)}km  mie=${a.mie.toExponential(2)}`;
}

function fmtBody(b, indent) {
  return (
    `${indent}${pad(b.name, 26 - indent.length)} ${pad(b.type, 10)} ` +
    `r=${pad(num(b.radius, 0) + 'km', 10)} T=${pad(num(b.temperature, 1) + 'K', 10)} ` +
    `g=${pad(num(b.gravity, 2) + 'm/s2', 12)} atm=${fmtAtmosphere(b.atmosphere)}`
  );
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/**
 * Run the whole pipeline for a universe seed and return both the data and a
 * canonical string of it. Called twice — the second run is the reproducibility
 * proof, so it must share no state at all with the first.
 */
function runChain(gen, seed) {
  const galaxy = gen.generateGalaxy(seed);
  const field = gen.buildField(galaxy);

  // Sample from mid-disc rather than the core: the core is so dense that a
  // 60 ly query hits the per-cell cap everywhere and the sample stops being
  // representative of what a player actually flies through.
  const probe = [galaxy.radiusLy * 0.38, 0, 0];
  let stubs = gen.sampleSystemsNear(galaxy, probe, 60, 12);
  // Dwarf and gas-poor galaxies can be genuinely empty at 0.38 R. Widen rather
  // than fail: an empty neighbourhood is a valid universe, not a broken one.
  for (let r = 120; stubs.length < 3 && r <= 3840; r *= 2) {
    stubs = gen.sampleSystemsNear(galaxy, probe, r, 12);
  }

  const systems = stubs.slice(0, 3).map((s) => gen.generateSystem(galaxy, s, field));
  return { galaxy, field, probe, stubs, systems };
}

// ---------------------------------------------------------------------------

const { mod: gen, cleanup } = await loadGen();
const lines = [];
const say = (s = '') => lines.push(s);

try {
  const first = runChain(gen, SEED);
  const { galaxy, field, probe, stubs, systems } = first;

  // --- 1. galaxy is a pure function of the seed ----------------------------
  check(
    stable(gen.generateGalaxy(SEED)) === stable(galaxy),
    'generateGalaxy is deterministic',
  );
  check(stubs.length > 0, 'sampleSystemsNear found systems', `probe ${probe.join(',')}`);
  check(systems.length === Math.min(3, stubs.length), 'generateSystem expanded every stub');

  // --- header --------------------------------------------------------------
  say('='.repeat(112));
  say(`GALAXY   ${galaxy.name}   [${galaxy.id}]`);
  say('='.repeat(112));
  say(
    `  seed ${galaxy.seed}   shape ${galaxy.shape}   radius ${galaxy.radiusLy} ly   ` +
      `thickness ${num(galaxy.thicknessLy, 0)} ly`,
  );
  say(
    `  arms ${galaxy.armCount} (twist ${num(galaxy.armTwist, 3)}, contrast ${num(galaxy.armContrast, 2)})   ` +
      `bulge ${num(galaxy.bulgeFraction, 3)}   stars ${galaxy.starCount}   nebulae ${galaxy.nebulae.length}`,
  );
  say(`  "${galaxy.blurb}"`);
  say();
  say(`  probe at ${probe.map((v) => num(v, 0)).join(', ')} ly — ${stubs.length} systems in range`);

  let terrainChecksumLine = null;
  let sampledPlanets = 0;

  for (let si = 0; si < systems.length; si++) {
    const sys = systems[si];
    const stub = stubs[si];

    // --- 2 & 3. the stub is consumed, not re-invented ----------------------
    eq(sys.id, stub.id, `system[${si}] keeps stub id`);
    eq(sys.seed, stub.seed, `system[${si}] keeps stub seed`);
    eq(sys.name, stub.name, `system[${si}] keeps stub name`);
    eq(sys.position[0], stub.position[0], `system[${si}] keeps stub position.x`);
    eq(sys.position[1], stub.position[1], `system[${si}] keeps stub position.y`);
    eq(sys.position[2], stub.position[2], `system[${si}] keeps stub position.z`);
    eq(sys.galaxyId, galaxy.id, `system[${si}] belongs to the galaxy`);
    // The one that actually catches a re-roll. Exact float equality.
    eq(sys.stars[0].temperature, stub.temperature, `system[${si}] primary T matches stub`);
    eq(sys.stars[0].luminosity, stub.luminosity, `system[${si}] primary L matches stub`);
    // ...and the same star reached the other way.
    const direct = gen.primaryStarFor(galaxy, stub, field);
    eq(sys.stars[0].mass, direct.mass, `system[${si}] primary mass matches primaryStarFor`);
    eq(
      sys.stars[0].spectralClass,
      direct.spectralClass,
      `system[${si}] primary class matches primaryStarFor`,
    );

    const hz = sys.habitableZone;
    const primary = sys.stars[0];
    say();
    say('-'.repeat(112));
    say(`SYSTEM ${si + 1}/3   ${sys.name}   [${sys.id}]   seed ${sys.seed}`);
    say('-'.repeat(112));
    say(
      `  position ${sys.position.map((v) => num(v, 1)).join(', ')} ly   ` +
        `stars ${sys.stars.length}   planets ${sys.planets.length}   ` +
        `belt ${sys.hasAsteroidBelt ? 'yes' : 'no'}   civ ${num(sys.civilisation, 3)}`,
    );
    say(`  habitable zone ${num(hz[0], 3)} – ${num(hz[1], 3)} AU`);
    for (const st of sys.stars) {
      say(
        `  star ${pad(st.name, 20)} ${pad(st.spectralClass, 3)} ` +
          `T=${pad(num(st.temperature, 0) + 'K', 9)} R=${pad(num(st.radius, 3) + 'Rsun', 12)} ` +
          `M=${pad(num(st.mass, 3) + 'Msun', 12)} L=${pad(st.luminosity.toExponential(3) + 'Lsun', 14)} ` +
          `activity ${num(st.activity, 2)}`,
      );
    }
    say(`  "${sys.blurb}"`);

    if (sys.planets.length === 0) {
      say('  (no planets)');
    } else {
      say('  planets:');
    }

    for (let pi = 0; pi < sys.planets.length; pi++) {
      const p = sys.planets[pi];

      // --- 4. planet seeds derive from the system seed --------------------
      eq(p.seed, gen.hashSeed(sys.seed, `planet:${pi}`), `planet ${p.id} seed derives from system`);
      eq(p.id, `${sys.id}:p${pi}`, `planet ${pi} id derives from system id`);
      check(p.isMoon === false, `planet ${p.id} is not flagged as a moon`);
      check(Number.isFinite(p.radius) && p.radius > 0, `planet ${p.id} has a real radius`);
      check(Number.isFinite(p.temperature) && p.temperature > 0, `planet ${p.id} has a real T`);
      check(Number.isFinite(p.gravity) && p.gravity > 0, `planet ${p.id} has real gravity`);
      check(
        p.orbit.semiMajorAxis > 0 && p.orbit.period > 0,
        `planet ${p.id} has a real orbit`,
      );

      say(fmtBody(p, '    '));
      say(
        `      a=${num(p.orbit.semiMajorAxis / gen.AU, 3)} AU  e=${num(p.orbit.eccentricity, 3)}  ` +
          `P=${num(p.orbit.period / 86400, 2)} d  rot=${num(p.rotationPeriod / 3600, 2)} h  ` +
          `tilt=${num(p.axialTilt, 3)} rad  mass=${num(p.mass, 4)} Me  interest=${num(p.interest, 2)}`,
      );
      say(
        `      terrain f=${num(p.terrain.frequency, 2)} oct=${p.terrain.octaves} ` +
          `amp=${num(p.terrain.amplitude, 2)}km ridged=${num(p.terrain.ridged, 2)} ` +
          `warp=${num(p.terrain.warp, 2)} craters=${num(p.terrain.craters, 2)} ` +
          `sea=${num(p.terrain.seaLevel, 2)}   ` +
          `ocean=${p.ocean ? 'yes' : 'no'} clouds=${p.clouds ? num(p.clouds.coverage, 2) : 'no'} ` +
          `rings=${p.rings ? `${num(p.rings.innerRadius, 2)}–${num(p.rings.outerRadius, 2)}R` : 'no'} ` +
          `bands=${p.bands ? p.bands.count : 'no'}`,
      );
      say(`      "${p.blurb}"`);

      // --- 5. moon seeds derive from the planet seed ----------------------
      for (let mi = 0; mi < p.moons.length; mi++) {
        const m = p.moons[mi];
        eq(m.seed, gen.hashSeed(p.seed, `moon:${mi}`), `moon ${m.id} seed derives from planet`);
        eq(m.id, `${p.id}:m${mi}`, `moon ${mi} id derives from planet id`);
        check(m.isMoon === true, `moon ${m.id} is flagged as a moon`);
        check(m.moons.length === 0, `moon ${m.id} has no moons of its own`);
        check(m.mass < p.mass, `moon ${m.id} is lighter than its planet`);
        say(fmtBody(m, '      · '));
      }

      // --- 6. terrain is reachable and stable ------------------------------
      const dir = [0.5773502691896258, 0.5773502691896258, 0.5773502691896258];
      const h1 = gen.sampleTerrain(p.terrain, p.seed, dir);
      const h2 = gen.sampleTerrain(p.terrain, p.seed, dir);
      check(Number.isFinite(h1), `sampleTerrain(${p.id}) is finite`, `got ${h1}`);
      eq(h2, h1, `sampleTerrain(${p.id}) is stable across calls`);
      check(
        Math.abs(h1) <= p.terrain.amplitude + 1e-9,
        `sampleTerrain(${p.id}) stays inside its amplitude`,
        `|${h1}| > ${p.terrain.amplitude}`,
      );
      const n = gen.sampleTerrainNormal(p.terrain, p.seed, dir, p.radius);
      const nlen = Math.hypot(n[0], n[1], n[2]);
      check(Math.abs(nlen - 1) < 1e-6, `terrain normal(${p.id}) is unit length`, `|n|=${nlen}`);
      sampledPlanets++;

      // First solid surface in the sample carries the published checksum.
      if (terrainChecksumLine === null && p.terrain.amplitude > 0) {
        const c1 = gen.terrainChecksum(p.terrain, p.seed, 4096);
        const c2 = gen.terrainChecksum(p.terrain, p.seed, 4096);
        eq(c2, c1, 'terrainChecksum is stable across calls');
        terrainChecksumLine =
          `  body   ${p.name}  [${p.id}]  seed ${p.seed}\n` +
          `  4096-sample Fibonacci-spiral checksum: ${c1.toFixed(9)}\n` +
          `  elevation at (1,1,1)/sqrt(3): ${h1.toFixed(9)} km`;
      }
    }
  }

  check(sampledPlanets > 0, 'the sample contains at least one planet');
  check(terrainChecksumLine !== null, 'the sample contains at least one solid surface');

  say();
  say('='.repeat(112));
  say('TERRAIN CHECKSUM');
  say('='.repeat(112));
  say(terrainChecksumLine ?? '  (no solid surface in this sample)');

  // --- 7. the whole universe is reproducible from the seed alone -----------
  const second = runChain(gen, SEED);
  check(
    stable(second.systems) === stable(systems),
    'the full chain is reproducible from the universe seed alone',
  );
  // And a different seed must produce a different universe, or "reproducible"
  // would be trivially satisfied by a generator that ignores its input.
  const other = runChain(gen, SEED + 1);
  check(
    stable(other.systems) !== stable(systems),
    'a different universe seed produces a different universe',
  );

  say();
  say('='.repeat(112));
  if (failures.length === 0) {
    say(`SEAM CHECKS: ${checks} passed, 0 failed`);
  } else {
    say(`SEAM CHECKS: ${checks - failures.length} passed, ${failures.length} FAILED`);
    for (const f of failures) say(`  FAIL  ${f}`);
  }
  say(`VERDICT: ${failures.length === 0 ? 'PASS' : 'FAIL'}   (universe seed ${SEED})`);
  say('='.repeat(112));

  if (!QUIET) console.log(lines.join('\n'));
  else console.log(`gen-smoke: ${failures.length === 0 ? 'PASS' : 'FAIL'} (${checks} checks)`);
} finally {
  await cleanup();
}

process.exit(failures.length === 0 ? 0 : 1);
