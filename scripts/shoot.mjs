/**
 * Visual review harness.
 *
 * Boots the built game in headless Chromium, drives it to a set of named
 * "shots" (fixed camera setups defined in `src/game/Shots.ts`), and writes PNGs
 * to `review/`. The visual critics compare those PNGs against reference frames
 * from shipped games — so the harness must produce *representative* frames, not
 * whatever the camera happened to be doing.
 *
 *   node scripts/shoot.mjs                      # all shots, 1920x1080
 *   node scripts/shoot.mjs planet-approach      # one shot
 *   node scripts/shoot.mjs --out review/round2  # custom output dir
 *   node scripts/shoot.mjs --width 2560 --height 1440
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
}
const OUT = resolve(ROOT, flag('out', 'review/latest'));
const WIDTH = Number(flag('width', 1920));
const HEIGHT = Number(flag('height', 1080));
const PORT = Number(flag('port', 4173));
/** Seconds of in-game time to let each shot settle (LOD, damping, warm-up). */
const SETTLE = Number(flag('settle', 6));
const KEEP = argv.includes('--keep');
const named = argv.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function startPreview() {
  const child = spawn(
    'npx',
    ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  return child;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const consoleErrors = [];

async function run() {
  if (!existsSync(resolve(ROOT, 'dist/index.html'))) {
    console.error('dist/ missing — run `npm run build` first.');
    process.exit(2);
  }

  if (existsSync(OUT) && !KEEP) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const server = startPreview();
  const url = `http://127.0.0.1:${PORT}/`;
  if (!(await waitForServer(url))) {
    server.kill();
    throw new Error('vite preview never came up');
  }

  const browser = await chromium.launch({
    args: [
      // Headless Chromium needs to be told to expose a GPU-ish WebGL stack.
      '--use-gl=angle',
      '--use-angle=default',
      '--enable-unsafe-swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--disable-gpu-sandbox',
      '--force-device-scale-factor=1',
    ],
  });

  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') {
      const text = msg.text();
      consoleErrors.push(`[${t}] ${text}`);
      process.stderr.write(`[page:${t}] ${text}\n`);
    }
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(`[pageerror] ${err.message}`);
    process.stderr.write(`[pageerror] ${err.message}\n`);
  });

  await page.goto(url, { waitUntil: 'load' });

  // The game signals readiness by setting window.__osReady.
  await page.waitForFunction(() => window.__osReady === true, null, { timeout: 90_000 });

  // Which shots exist is decided by the game, not by this script.
  const available = await page.evaluate(() => window.__osShots?.() ?? []);
  if (!available.length) {
    console.error('game exposed no shots via window.__osShots()');
  }
  const shots = named.length ? available.filter((s) => named.includes(s)) : available;
  if (named.length && shots.length !== named.length) {
    const missing = named.filter((n) => !available.includes(n));
    throw new Error(`unknown shot(s): ${missing.join(', ')} — available: ${available.join(', ')}`);
  }

  const results = [];
  for (const shot of shots) {
    process.stderr.write(`→ ${shot}\n`);
    await page.evaluate((s) => window.__osSetShot(s), shot);

    // Advance deterministic time rather than sleeping: LOD streaming and
    // damped camera moves need simulated frames, not wall-clock seconds.
    await page.evaluate((seconds) => window.__osSettle(seconds), SETTLE);
    await page.waitForFunction(() => window.__osSettled === true, null, { timeout: 120_000 });

    const file = resolve(OUT, `${shot}.png`);
    await page.screenshot({ path: file, type: 'png' });
    const stats = await page.evaluate(() => window.__osStats?.() ?? null);
    results.push({ shot, file, stats });
    process.stderr.write(
      `  ${stats ? `${stats.fps.toFixed(0)} fps · ${stats.calls} calls · ${(stats.tris / 1000).toFixed(0)}k tris` : 'no stats'}\n`,
    );
  }

  await browser.close();
  server.kill();

  console.log(
    JSON.stringify(
      {
        out: OUT,
        shots: results,
        consoleErrors: consoleErrors.slice(0, 40),
        consoleErrorCount: consoleErrors.length,
      },
      null,
      2,
    ),
  );

  if (consoleErrors.length) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
