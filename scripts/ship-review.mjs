/**
 * Ship review harness.
 *
 * Captures the whole showroom shot set into a dated folder under
 * `review/ships/` and writes a JSON manifest the critic agents consume.
 *
 * This is a WRAPPER, not a second harness. `scripts/shoot.mjs` already owns
 * the hard parts — starting the preview server, launching headless Chromium
 * with a working ANGLE stack, driving `window.__osSetShot` / `__osSettle`, and
 * capturing PNGs with per-shot renderer stats — and duplicating any of that
 * would guarantee the two drift and that a ship frame and a planet frame stop
 * being comparable. So this script does exactly three things `shoot.mjs`
 * cannot:
 *
 *   1. decides WHICH shots are the ship set, from the showroom's own table;
 *   2. puts the run in a dated folder so a review is never overwritten by the
 *      next one and two rounds can be diffed;
 *   3. joins each PNG to the critic brief that was written for it, so a critic
 *      is never handed a picture without being told what to look for.
 *
 * The briefs come straight out of `src/game/Showroom.ts` — bundled with
 * esbuild and imported, the same trick `scripts/ship-smoke.mjs` uses — rather
 * than being copied here, because a description that lives in two files is a
 * description that will eventually describe the wrong frame.
 *
 *   node scripts/ship-review.mjs
 *   node scripts/ship-review.mjs ship-hero-close ship-silhouette-side
 *   node scripts/ship-review.mjs --out review/ships/round2 --settle 8
 *   node scripts/ship-review.mjs --width 2560 --height 1440
 *   node scripts/ship-review.mjs --build      # run `npm run build` first
 */

import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Args — same shape as shoot.mjs so muscle memory transfers
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const consumed = new Set();
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  consumed.add(i);
  consumed.add(i + 1);
  return argv[i + 1];
}

const RUN_ID = stamp(new Date());
const OUT = resolve(ROOT, flag('out', join('review', 'ships', RUN_ID)));
const WIDTH = Number(flag('width', 1920));
const HEIGHT = Number(flag('height', 1080));
/**
 * A different default port from shoot.mjs on purpose. Several agents work this
 * repository at once and `--strictPort` means a collision is a hard failure
 * several minutes into a capture rather than a warning at the start.
 */
const PORT = Number(flag('port', 4188));
const SETTLE = Number(flag('settle', 6));
const DO_BUILD = argv.includes('--build');
const named = argv.filter((a, i) => !a.startsWith('--') && !consumed.has(i));

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// The shot table, straight from the module that registers it
// ---------------------------------------------------------------------------

/**
 * Bundle `Showroom.ts` for node and read its exported shot table.
 *
 * Half a megabyte and about a second: the shot table carries `Vector3` drive
 * states, so three.js comes along for the ride. It imports cleanly under node
 * (no DOM is touched at module scope) and nothing is constructed, so this
 * stays a pure data read — no browser, no GL context, no server.
 *
 * `nodePaths` is required because the generated entry does not live next to
 * `node_modules`, and `alias` maps the `@/` paths from tsconfig — esbuild
 * resolves both against the working directory, not against this file.
 */
async function loadShotTable() {
  const outfile = resolve(ROOT, 'node_modules/.cache/onespace-ship-shots.mjs');
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    stdin: {
      contents: `export { SHOWROOM_SHOTS } from '@/game/Showroom';`,
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'ship-review-entry.ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'warning',
    alias: { '@': resolve(ROOT, 'src') },
    nodePaths: [resolve(ROOT, 'node_modules')],
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  rmSync(outfile, { force: true });
  if (!Array.isArray(mod.SHOWROOM_SHOTS) || mod.SHOWROOM_SHOTS.length === 0) {
    throw new Error('Showroom.ts exported no shots');
  }
  return mod.SHOWROOM_SHOTS;
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

function run(command, args, { capture = false } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
    });
    let stdout = '';
    if (capture) child.stdout.on('data', (d) => (stdout += d));
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout }));
  });
}

/** shoot.mjs writes progress to stderr and exactly one JSON object to stdout. */
function parseShootOutput(stdout) {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const table = await loadShotTable();
  const byName = new Map(table.map((s) => [s.name, s.description]));

  const shots = named.length ? named : table.map((s) => s.name);
  const unknown = shots.filter((s) => !byName.has(s));
  if (unknown.length) {
    throw new Error(
      `not showroom shots: ${unknown.join(', ')}\navailable: ${[...byName.keys()].join(', ')}`,
    );
  }

  if (DO_BUILD) {
    process.stderr.write('› npm run build\n');
    const built = await run('npm', ['run', 'build']);
    if (built.code !== 0) throw new Error('build failed');
  }
  if (!existsSync(resolve(ROOT, 'dist/index.html'))) {
    throw new Error(
      'dist/ missing — run `npm run build`, or pass --build.\n' +
        '(Not done automatically: other agents share this path.)',
    );
  }

  mkdirSync(OUT, { recursive: true });

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  process.stderr.write(`› capturing ${shots.length} ship shots into ${relative(ROOT, OUT)}\n`);

  const shot = await run(
    'node',
    [
      'scripts/shoot.mjs',
      '--out',
      OUT,
      '--width',
      String(WIDTH),
      '--height',
      String(HEIGHT),
      '--port',
      String(PORT),
      '--settle',
      String(SETTLE),
      '--keep', // the dated directory is already fresh; do not let it be wiped
      ...shots,
    ],
    { capture: true },
  );

  const result = parseShootOutput(shot.stdout);
  if (!result) {
    process.stderr.write(shot.stdout);
    throw new Error(`shoot.mjs produced no parsable result (exit ${shot.code})`);
  }

  const statsByShot = new Map((result.shots ?? []).map((s) => [s.shot, s.stats]));
  const captured = new Set(readdirSync(OUT).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)));

  const entries = shots.map((name) => {
    const stats = statsByShot.get(name) ?? null;
    const file = `${name}.png`;
    return {
      shot: name,
      description: byName.get(name),
      file,
      path: relative(ROOT, resolve(OUT, file)),
      captured: captured.has(name),
      drawCalls: stats ? stats.calls : null,
      triangles: stats ? stats.tris : null,
      fps: stats ? Number(stats.fps.toFixed(1)) : null,
      frameMs: stats ? Number(stats.frameMs.toFixed(2)) : null,
    };
  });

  const missing = entries.filter((e) => !e.captured).map((e) => e.shot);

  const manifest = {
    kind: 'onespace/ship-review',
    version: 1,
    run: RUN_ID,
    startedAt,
    durationSeconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    viewport: { width: WIDTH, height: HEIGHT },
    settleSeconds: SETTLE,
    directory: relative(ROOT, OUT),
    /**
     * Budgets from BRIEF §6, restated here so a critic can check a frame
     * against them without opening the brief.
     */
    budgets: { drawCallsLod0: 12, trianglesLod0: 120000, trianglesLod1: 25000, trianglesLod2: 3000, materialsPerShip: 3 },
    /**
     * `drawCalls` and `triangles` are WHOLE-FRAME counts from
     * `renderer.info`: they include the sky, the post chain and any gallery
     * fixture still in the scene, not the ship alone. Read them as an upper
     * bound on the ship's cost, and compare shots against each other rather
     * than against the budget in isolation.
     */
    countsAreWholeFrame: true,
    shots: entries,
    missing,
    consoleErrorCount: result.consoleErrorCount ?? 0,
    consoleErrors: result.consoleErrors ?? [],
  };

  const manifestPath = resolve(OUT, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // A stable place for a critic agent to find the newest run without listing
  // and sorting directories.
  mkdirSync(resolve(ROOT, 'review/ships'), { recursive: true });
  writeFileSync(
    resolve(ROOT, 'review/ships/latest.json'),
    `${JSON.stringify({ run: RUN_ID, directory: manifest.directory, manifest: relative(ROOT, manifestPath) }, null, 2)}\n`,
  );

  for (const e of entries) {
    const cost = e.drawCalls === null ? 'no stats' : `${e.drawCalls} calls · ${(e.triangles / 1000).toFixed(1)}k tris`;
    process.stderr.write(`  ${e.captured ? '✓' : '✗'} ${e.shot.padEnd(30)} ${cost}\n`);
  }
  process.stderr.write(`› manifest: ${relative(ROOT, manifestPath)}\n`);

  console.log(manifestPath);

  if (missing.length || manifest.consoleErrorCount > 0 || shot.code !== 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
