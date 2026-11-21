/**
 * Cloud save, end to end (v4 sub-plan 4, Task 7 Step 1; DESIGN-4 §5.7).
 *
 * Starts the BUILT server (dist-server/index.mjs, serving dist/ and /api from
 * one origin) against a throwaway Postgres database, then drives the game in
 * headless Chromium with its real keys: Tab, G (cruise to a belt field), L
 * (autopilot to the rock), B (mine), U (refine), Esc + SAVE (pause sheet), the
 * title's Enter, and the conflict screen's ← → Enter.
 *
 * What it reads, it reads through what the game already exposes for the
 * review harness: `window.__osReady` and `window.oneSpace` (the Engine, whose
 * `get(name)` returns a module — universe, targeting, mining, pause …). It
 * writes nothing into the game except one test-side tap: it wraps the HUD's
 * log line method to remember every line it was given (the lines themselves
 * fade from the DOM).
 *
 *   npm run e2e:cloud
 *
 * Needs:
 *   - a build: dist/ and dist-server/ (`npm run build`, or `npx vite build &&
 *     node scripts/build-server.mjs`);
 *   - `docker compose up -d db-test` (postgres on 127.0.0.1:54329). The run
 *     drops and recreates its OWN database (`onespace_e2e`), never the
 *     vitest database;
 *   - Chromium for the installed playwright version.
 *
 * Exit code 0 only when every step passes. A step marked XFAIL documents a
 * known, not yet fixed behaviour: it reports and never fails the run.
 */

import { chromium } from 'playwright';
import postgres from 'postgres';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8799);
const ORIGIN = `http://localhost:${PORT}`;
const ADMIN_URL = process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://onespace:onespace@127.0.0.1:54329/onespace_test';
const DB_NAME = 'onespace_e2e';
const DATABASE_URL = (() => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${DB_NAME}`;
  return u.toString();
})();

// The exact texts the game shows (src/ui/accountMenu.ts, src/net/SyncClient.ts, src/ui/conflictScreen.ts).
const TXT = {
  signIn: 'SIGN IN WITH DISCORD',
  signOut: 'SIGN OUT',
  continue: 'CONTINUE',
  undock: 'UNDOCK',
  offline: 'OFFLINE — SAVED LOCALLY',
  conflict: 'SYNC CONFLICT — CHOOSE ON NEXT START',
  diverged: 'TWO SAVES DIVERGED',
  thisDevice: 'THIS DEVICE',
  cloud: 'CLOUD',
  keepThis: 'KEEP THIS',
  keepCloud: 'KEEP CLOUD',
  notInvited: 'NOT INVITED — PLAYING AS GUEST',
  signInFailed: 'SIGN-IN FAILED — PLAYING AS GUEST',
  deleteAccount: 'DELETE ACCOUNT',
};
const signedIn = (name) => `SIGNED IN AS ${name}`;

const PILOT = 'e2e-pilot';
const XSS_NAME = '<img src=x onerror=alert(1)>';

/** A frame longer than this, inside the push window, is a hitch. */
const HITCH_MS = 100;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const say = (s) => console.log(`${stamp()}  ${s}`);

class AssertionError extends Error {}
function assert(cond, message) {
  if (!cond) throw new AssertionError(message);
}

/** @type {Array<{id: string, name: string, status: string, notes: string[], ms: number}>} */
const results = [];

/**
 * Run one named step. `requires`: ids that must have PASSed, or this one is
 * SKIPPED. `xfail`: a known, unfixed behaviour — the step reports what it saw
 * and never fails the run (a throw is XFAIL, a clean pass is XPASS).
 */
async function step(id, name, fn, { requires = [], xfail = false } = {}) {
  const notes = [];
  const note = (s) => {
    notes.push(s);
    say(`   · ${s}`);
  };
  const started = Date.now();
  const blocked = requires.filter((r) => results.find((x) => x.id === r)?.status !== 'PASS');
  if (blocked.length) {
    results.push({ id, name, status: 'SKIP', notes: [`needs ${blocked.join(', ')}`], ms: 0 });
    say(`SKIP  ${id} ${name} (needs ${blocked.join(', ')})`);
    return false;
  }
  say(`STEP  ${id} ${name}`);
  let status;
  try {
    await fn(note);
    status = xfail ? 'XPASS' : 'PASS';
  } catch (err) {
    status = xfail ? 'XFAIL' : 'FAIL';
    note(`${err instanceof AssertionError ? 'assertion' : 'error'}: ${err?.message ?? err}`);
  }
  results.push({ id, name, status, notes, ms: Date.now() - started });
  say(`${status.padEnd(5)} ${id} ${name}`);
  return status === 'PASS' || status === 'XPASS';
}

// ---------------------------------------------------------------------------
// Database and server
// ---------------------------------------------------------------------------

async function resetDatabase() {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {}, connect_timeout: 5 });
  try {
    await admin.unsafe(`drop database if exists ${DB_NAME} with (force)`);
    await admin.unsafe(`create database ${DB_NAME}`);
  } finally {
    await admin.end({ timeout: 2 });
  }
}

let server = null;
let serverOut = '';

function startServer() {
  const env = {
    ...process.env,
    DATABASE_URL,
    PUBLIC_ORIGIN: ORIGIN,
    PORT: String(PORT),
    NODE_ENV: 'test',
    ONESPACE_TEST_LOGIN: '1',
    // Never contacted: sign-in goes through the test login.
    DISCORD_CLIENT_ID: 'e2e',
    DISCORD_CLIENT_SECRET: 'e2e',
    DISCORD_GUILD_ID: 'e2e',
    DISCORD_ROLE_ID: 'e2e',
  };
  const child = spawn(process.execPath, ['dist-server/index.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = (d) => {
    serverOut += d.toString();
    if (serverOut.length > 50_000) serverOut = serverOut.slice(-50_000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  server = child;
  return child;
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) throw new Error(`server exited (${server.exitCode}):\n${serverOut}`);
    try {
      const r = await fetch(`${ORIGIN}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never became healthy:\n${serverOut}`);
}

async function stopServer() {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const t = setTimeout(() => child.kill('SIGKILL'), 5_000);
  await exited;
  clearTimeout(t);
}

// ---------------------------------------------------------------------------
// Browser observation: console, page errors, CSP, failed requests
// ---------------------------------------------------------------------------

/** Every console error / page error / CSP violation / failed request, with context. */
const problems = [];
/** HTTP error statuses the browser logs as console errors, matched to their request. */
const httpErrors = [];
/** While set, failed requests are deliberate (offline context, server stopped). */
const deliberate = { offline: new Set(), serverDown: false };

function watch(page, label) {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const url = msg.location()?.url ?? '';
    problems.push({ kind: text.startsWith('[e2e-csp]') ? 'csp' : 'console', label, text, url, at: stamp() });
  });
  page.on('pageerror', (err) => problems.push({ kind: 'pageerror', label, text: err.message, at: stamp() }));
  page.on('requestfailed', (req) => {
    const why = req.failure()?.errorText ?? '';
    const isDeliberate = deliberate.offline.has(label) || deliberate.serverDown;
    problems.push({ kind: isDeliberate ? 'requestfailed-deliberate' : 'requestfailed', label, text: `${req.method()} ${req.url()} ${why}`, at: stamp() });
  });
  page.on('response', (res) => {
    if (res.status() >= 400) httpErrors.push({ label, method: res.request().method(), url: res.url(), status: res.status(), at: stamp() });
  });
  page.on('dialog', (d) => {
    problems.push({ kind: 'dialog', label, text: `${d.type()}: ${d.message()}`, at: stamp() });
    void d.dismiss();
  });
}

let browser = null;
const contexts = new Map();

async function newPage(label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  // CSP violations also reach the console as errors; this makes them unmistakable.
  await ctx.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`[e2e-csp] ${e.violatedDirective} blocked ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber} (${e.disposition})`);
    });
  });
  const page = await ctx.newPage();
  watch(page, label);
  contexts.set(label, ctx);
  return { ctx, page };
}

async function setOffline(label, ctx, offline) {
  if (offline) deliberate.offline.add(label);
  await ctx.setOffline(offline);
  if (!offline) {
    // Requests that failed while offline may report a moment later.
    setTimeout(() => deliberate.offline.delete(label), 1_000);
  }
}

// ---------------------------------------------------------------------------
// Driving the game
// ---------------------------------------------------------------------------

/** Wait for the game to finish booting (the review harness flag), then tap the HUD log. */
async function booted(page, timeout = 120_000) {
  await page.waitForFunction(() => window.__osReady === true, null, { timeout });
  await page.evaluate(() => {
    // Lines already on the glass: the boot notices are logged before __osReady.
    const seen = [...document.querySelectorAll('.os-log-line')].map((e) => e.textContent ?? '').filter(Boolean);
    window.__e2eLog = seen;
    const hud = window.oneSpace.get('hud');
    if (!hud.__e2eTapped) {
      const orig = hud.pushLog.bind(hud);
      hud.pushLog = (text, tone) => {
        window.__e2eLog.push(text);
        return orig(text, tone);
      };
      hud.__e2eTapped = true;
    }
  });
}

async function gotoGame(page, path = '/') {
  await page.goto(ORIGIN + path, { waitUntil: 'load' });
  await booted(page);
}

async function reloadGame(page) {
  await page.reload({ waitUntil: 'load' });
  await booted(page);
}

async function waitLog(page, text, timeout = 30_000) {
  await page.waitForFunction((t) => (window.__e2eLog ?? []).includes(t), text, { timeout });
}

const logHas = (page, text) => page.evaluate((t) => (window.__e2eLog ?? []).includes(t), text);

async function testLogin(page, name) {
  return page.evaluate(async (n) => {
    const r = await fetch('/api/test/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: n }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, name);
}

async function title(page) {
  return page.evaluate(() => ({
    visible: document.querySelector('.os-title')?.classList.contains('visible') ?? false,
    account: document.querySelector('.os-title-account')?.textContent ?? '',
    items: [...document.querySelectorAll('.os-title-menu button')].map((b) => b.textContent ?? ''),
    on: document.querySelector('.os-title-menu button.on')?.textContent ?? '',
  }));
}

/** Pick a title item with the keys (↓ until it is lit, Enter). */
async function chooseTitle(page, label) {
  await page.waitForFunction(() => document.querySelector('.os-title')?.classList.contains('visible'), null, { timeout: 15_000 });
  for (let i = 0; i < 8; i++) {
    const t = await title(page);
    if (t.on === label) {
      await page.keyboard.press('Enter');
      return;
    }
    assert(t.items.includes(label), `title has no ${label} (items: ${t.items.join(' | ')})`);
    await page.keyboard.press('ArrowDown');
  }
  throw new AssertionError(`could not reach ${label} on the title`);
}

async function inFlight(page) {
  await page.waitForFunction(() => !document.querySelector('.os-title')?.classList.contains('visible'), null, { timeout: 15_000 });
  // Give the flight mode a couple of frames to take the keys.
  await page.waitForTimeout(500);
}

async function state(page) {
  return page.evaluate(() => {
    const e = window.oneSpace;
    const u = e.get('universe');
    const pause = e.get('pause');
    const target = e.get('targeting').targetId;
    return {
      iceKg: target?.startsWith('ast:') ? e.get('belt').remainingKg(target, 'ice') : 0,
      system: u.system?.name ?? null,
      tankKg: u.flight.propellant ? u.flight.propellant.massKg : null,
      target: e.get('targeting').targetId,
      cruising: e.get('cruise').busy,
      autopilot: e.get('autopilot').phase,
      job: e.get('mining').busy ? { ...e.get('mining').busy } : null,
      // Plan 5: an extraction is not a timed job; it is status('mine').
      mineKind: e.get('mining').status('mine').kind,
      inRange: e.get('mining').asteroidInRange,
      revision: e.get('save').revision,
      sync: pause.sync ? pause.sync.status() : null,
      syncText: pause.sync ? pause.sync.statusText() : null,
    };
  });
}

async function waitState(page, pred, what, timeout) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await state(page);
    if (pred(last)) return last;
    await page.waitForTimeout(500);
  }
  throw new AssertionError(`timed out waiting for ${what}; last state ${JSON.stringify(last)}`);
}

/** Tab until the target is a belt field; G; wait for the drop at the field (it targets the first rock). */
async function cruiseToBelt(page, note) {
  let s = await state(page);
  for (let i = 0; i < 20 && !s.target?.startsWith('field:'); i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(250);
    s = await state(page);
  }
  assert(s.target?.startsWith('field:'), `Tab never reached a belt field (last target ${s.target})`);
  note(`targeted ${s.target} in ${s.system}`);
  await page.keyboard.press('KeyG');
  await waitState(page, (x) => x.cruising, 'cruise to engage', 20_000);
  s = await waitState(page, (x) => !x.cruising && x.target?.startsWith('ast:'), 'cruise to drop at the field with a rock targeted', 300_000);
  await waitLog(page, 'CRUISE DISENGAGED', 5_000).catch(() => undefined);
  note(`dropped at the field; first rock ${s.target}`);
}

/** L with a rock targeted: the autopilot parks within mining range. */
async function parkAtRock(page, note) {
  await page.keyboard.press('KeyL');
  await waitState(page, (x) => x.autopilot !== 'idle', 'the approach to engage', 10_000);
  const s = await waitState(page, (x) => x.autopilot === 'idle' && x.inRange, 'the approach to park in range', 240_000);
  note(`parked at ${s.target}`);
}

/**
 * Tab until a rock with ice is targeted (after a CONTINUE the target is not
 * saved); park at it with L unless it is already in range.
 */
async function targetIceRock(page, note) {
  const good = (x) => x.target?.startsWith('ast:') && x.iceKg >= 500;
  let s = await state(page);
  let firstGood = null;
  for (let i = 0; i < 40 && !(good(s) && s.inRange); i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(250);
    s = await state(page);
    if (good(s) && firstGood === null) firstGood = s.target;
    if (i > 0 && s.target === firstGood && !s.inRange) break; // went round once
  }
  assert(good(s), `no rock with ice to target (last ${JSON.stringify(s)})`);
  if (!s.inRange) await parkAtRock(page, note);
  else note(`targeted ${s.target} in range (${s.iceKg.toFixed(0)} kg ice left)`);
  return s;
}

/** B, let a few bites land, B to stop; U, wait for the refine. Returns the tank before and after. */
async function mineAndRefine(page, note) {
  await page.keyboard.press('KeyB');
  await waitState(page, (x) => x.mineKind === 'running', 'the extraction to start', 5_000);
  // Plan 5: 150 kg/s in 250 kg bites; 4 s gives two bites (it may end by itself first).
  await page.waitForTimeout(4_000);
  if ((await state(page)).mineKind === 'running') await page.keyboard.press('KeyB');
  await waitState(page, (x) => x.mineKind !== 'running', 'the extraction to end', 10_000);
  const mined = await page.evaluate(() => window.__e2eLog.filter((l) => l.startsWith('MINED')).at(-1) ?? null);
  assert(mined && mined.includes(' KG ICE'), `the mine did not yield ice (log: ${mined})`);
  note(mined);
  const before = (await state(page)).tankKg;
  await page.keyboard.press('KeyU');
  await waitState(page, (x) => x.job?.kind === 'refine', 'the refine to start', 5_000);
  const after = (await waitState(page, (x) => x.job === null, 'the refine to finish', 40_000)).tankKg;
  const refined = await page.evaluate(() => window.__e2eLog.filter((l) => l.startsWith('REFINED')).at(-1) ?? null);
  note(`${refined}; tank ${before.toFixed(1)} → ${after.toFixed(1)} kg`);
  return { before, after };
}

async function openPause(page) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.os-pause')?.classList.contains('is-live'), null, { timeout: 5_000 });
}

async function resume(page) {
  await page.locator('.os-pause .os-pz-btn', { hasText: /^RESUME$/ }).click();
  await page.waitForFunction(() => !document.querySelector('.os-pause')?.classList.contains('is-live'), null, { timeout: 5_000 });
}

/** Esc, SAVE, wait for SAVED, RESUME. Returns the saved revision and tank. */
async function pauseSave(page) {
  const before = await state(page);
  await page.evaluate(() => {
    window.__e2eLog = window.__e2eLog.filter((l) => l !== 'SAVED');
  });
  await openPause(page);
  await page.locator('.os-pause .os-pz-btn', { hasText: /^SAVE$/ }).click();
  await waitLog(page, 'SAVED', 15_000);
  const after = await waitState(page, (x) => x.revision > before.revision, 'the revision to move', 5_000);
  await resume(page);
  return after;
}

async function pauseSyncLine(page) {
  return page.evaluate(() => document.querySelector('.os-pause .os-pz-sync')?.textContent ?? null);
}

/** The cloud head as the server holds it, with the context's own cookie. */
async function cloudHead(ctx) {
  const r = await ctx.request.get(`${ORIGIN}/api/save`);
  if (r.status() !== 200) return { status: r.status() };
  const b = await r.json();
  return { status: 200, revision: b.revision, tankKg: b.save.ship.propellant.massKg, system: b.save.player.system.name, saveId: b.save.saveId };
}

/** Hold the throttle for `ms`, then zero it: burns propellant. */
async function burn(page, ms) {
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(ms);
  await page.keyboard.up('KeyW');
  await page.keyboard.press('KeyX');
  await page.waitForTimeout(500);
}

const kg = (n) => (n === null || n === undefined ? String(n) : `${n.toFixed(1)} kg`);

function stats(xs) {
  if (!xs.length) return { n: 0, median: NaN, p95: NaN, max: NaN };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return { n: s.length, median: q(0.5), p95: q(0.95), max: s.at(-1) };
}
const fmt = (st) => `n=${st.n} median=${st.median.toFixed(1)} ms p95=${st.p95.toFixed(1)} ms max=${st.max.toFixed(1)} ms`;

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function run() {
  for (const f of ['dist/index.html', 'dist-server/index.mjs']) {
    if (!existsSync(resolve(ROOT, f))) {
      console.error(`${f} missing — build first (npm run build).`);
      process.exitCode = 2;
      return;
    }
  }

  say(`database ${DB_NAME} (recreated) · server ${ORIGIN}`);
  try {
    await resetDatabase();
  } catch (err) {
    console.error(`cannot reach Postgres at ${ADMIN_URL} — is \`docker compose up -d db-test\` running?\n${err.message}`);
    process.exitCode = 2;
    return;
  }
  startServer();
  await waitForHealth();
  say('server healthy');

  browser = await chromium.launch({
    args: [
      '--use-gl=angle',
      '--use-angle=default',
      '--enable-unsafe-swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--disable-gpu-sandbox',
      '--force-device-scale-factor=1',
    ],
  });

  // ------------------------------------------------------------------ extras
  await step('A', `?auth=not-invited and ?auth=error show their notice and leave the URL without a reload`, async (note) => {
    const { page } = await newPage('auth-notices');
    for (const [param, text] of [
      ['not-invited', TXT.notInvited],
      ['error', TXT.signInFailed],
    ]) {
      let documents = 0;
      const onReq = (req) => {
        if (req.resourceType() === 'document') documents++;
      };
      page.on('request', onReq);
      await gotoGame(page, `/?auth=${param}&keep=1#frag`);
      await page.waitForTimeout(1_000);
      page.off('request', onReq);
      const url = new URL(page.url());
      assert(!url.searchParams.has('auth'), `auth=${param} still in the URL: ${page.url()}`);
      assert(url.searchParams.get('keep') === '1' && url.hash === '#frag', `other parameters/hash not kept: ${page.url()}`);
      assert(documents === 1, `expected one document load, saw ${documents} (a reload?)`);
      assert(await logHas(page, text), `notice "${text}" not logged (log: ${JSON.stringify(await page.evaluate(() => window.__e2eLog))})`);
      note(`?auth=${param} → "${text}" logged; URL now ${url.pathname}${url.search}${url.hash}; 1 document load`);
    }
  });

  await step('B', 'a display name with markup renders literally and creates no element', async (note) => {
    const { page } = await newPage('xss');
    await gotoGame(page);
    const login = await testLogin(page, XSS_NAME);
    assert(login.status === 200, `test login refused the name: ${login.status} ${JSON.stringify(login.body)}`);
    note(`test login accepted the name (${login.status})`);
    await reloadGame(page);
    const t = await title(page);
    assert(t.account === signedIn(XSS_NAME), `title account line is ${JSON.stringify(t.account)}`);
    const dom = await page.evaluate(() => ({
      imgs: document.querySelectorAll('img').length,
      accountChildren: document.querySelector('.os-title-account .os-account-line')?.children.length ?? -1,
    }));
    assert(dom.imgs === 0, `${dom.imgs} <img> element(s) in the document`);
    assert(dom.accountChildren === 0, `the account line has ${dom.accountChildren} child element(s)`);
    note(`title shows ${JSON.stringify(t.account)}; 0 <img>; the line has no child elements`);
    await chooseTitle(page, TXT.undock);
    await inFlight(page);
    await openPause(page);
    const line = await page.evaluate(() => {
      const el = document.querySelector('.os-pause .os-pz-account .os-account-line');
      return { text: el?.textContent ?? null, children: el?.children.length ?? -1, imgs: document.querySelectorAll('img').length };
    });
    assert(line.text === signedIn(XSS_NAME), `pause account line is ${JSON.stringify(line.text)}`);
    assert(line.children === 0 && line.imgs === 0, `pause line children ${line.children}, <img> ${line.imgs}`);
    assert(!problems.some((p) => p.kind === 'dialog'), 'an alert() dialog opened');
    note(`pause sheet shows ${JSON.stringify(line.text)}; no element, no dialog`);
  });

  await step(
    'C',
    'holding Enter on a focused DELETE ACCOUNT in Pause never deletes the account (R61)',
    async (note) => {
      const { ctx, page } = await newPage('held-enter');
      await gotoGame(page);
      const name = 'e2e-held-enter';
      assert((await testLogin(page, name)).status === 200, 'test login failed');
      await reloadGame(page);
      await chooseTitle(page, TXT.undock);
      await inFlight(page);
      await openPause(page);
      const btn = page.locator('.os-pause .os-pz-btn', { hasText: /^DELETE ACCOUNT/ });
      await btn.focus();
      const labels = [];
      const sample = async () => {
        const l = await btn.textContent();
        if (labels.at(-1) !== l) labels.push(l);
      };
      await sample();
      // A held key: the first keydown, then auto-repeats (Playwright marks a
      // second down of a key already down as repeat), ~30 Hz for 600 ms.
      for (let i = 0; i < 18; i++) {
        await page.keyboard.down('Enter');
        await sample();
        await page.waitForTimeout(33);
      }
      await page.keyboard.up('Enter');
      await page.waitForTimeout(1_500);
      await sample();
      const me = await ctx.request.get(`${ORIGIN}/api/me`);
      const deleted = me.status() === 401;
      const log = await page.evaluate(() => window.__e2eLog.slice(-6));
      note(`button labels seen: ${labels.map((l) => JSON.stringify(l)).join(' → ')}`);
      note(`GET /api/me after: ${me.status()} → account ${deleted ? 'DELETED' : 'still there'}; last log lines ${JSON.stringify(log)}`);
      assert(!deleted, 'a held Enter deleted the account (armed and confirmed by key repeat)');
    },
  );
  for (const label of ['auth-notices', 'xss', 'held-enter']) await contexts.get(label)?.close();

  // ---------------------------------------------------------------- scenario 1
  const one = { ctx: null, page: null };
  const saved = {};

  await step('1', 'test login → belt → mine ice → refine → the tank rises → reload → still filled', async (note) => {
    Object.assign(one, await newPage('device-1'));
    const { page, ctx } = one;
    await gotoGame(page);
    let t = await title(page);
    assert(t.items.includes(TXT.signIn), `guest title has no ${TXT.signIn} (items: ${t.items.join(' | ')})`);
    const login = await testLogin(page, PILOT);
    assert(login.status === 200, `test login: ${login.status}`);
    await reloadGame(page);
    t = await title(page);
    assert(t.account === signedIn(PILOT), `title account line ${JSON.stringify(t.account)}`);
    assert(t.items.includes(TXT.signOut) && !t.items.includes(TXT.signIn), `items ${t.items.join(' | ')}`);
    note(`title: ${JSON.stringify(t.account)} · ${t.items.join(' | ')}`);

    await chooseTitle(page, TXT.undock);
    await inFlight(page);
    await cruiseToBelt(page, note);
    await parkAtRock(page, note);
    const { before, after } = await mineAndRefine(page, note);
    assert(after > before, `the tank did not rise (${kg(before)} → ${kg(after)})`);

    const s = await pauseSave(page);
    note(`SAVED revision ${s.revision}, tank ${kg(s.tankKg)}`);
    const synced = await waitState(page, (x) => x.sync === 'synced', 'sync to finish', 30_000);
    const head = await cloudHead(ctx);
    assert(head.status === 200 && head.revision === synced.revision, `cloud head ${JSON.stringify(head)} vs local revision ${synced.revision}`);
    assert(Math.abs(head.tankKg - s.tankKg) < 0.5, `cloud tank ${kg(head.tankKg)} vs saved ${kg(s.tankKg)}`);
    note(`cloud holds revision ${head.revision}, tank ${kg(head.tankKg)}, system ${head.system}`);
    Object.assign(saved, { tankKg: s.tankKg, system: s.system, revision: head.revision });

    await reloadGame(page);
    t = await title(page);
    assert(t.items[0] === TXT.continue, `after the reload the title offers ${t.items.join(' | ')}`);
    await chooseTitle(page, TXT.continue);
    await inFlight(page);
    const r = await state(page);
    assert(r.system === saved.system, `system after reload ${r.system} ≠ ${saved.system}`);
    assert(Math.abs(r.tankKg - saved.tankKg) < 1, `tank after reload ${kg(r.tankKg)} ≠ saved ${kg(saved.tankKg)}`);
    assert(r.tankKg > before, `tank after reload ${kg(r.tankKg)} not above the pre-refine ${kg(before)}`);
    note(`reloaded + CONTINUE: ${r.system}, tank ${kg(r.tankKg)} (sync ${r.sync})`);
  });

  // ---------------------------------------------------------------- scenario 2
  const two = { ctx: null, page: null };
  await step(
    '2',
    'a second browser context, same account → CONTINUE gives the same system and the same tank',
    async (note) => {
      Object.assign(two, await newPage('device-2'));
      const { page } = two;
      await gotoGame(page);
      assert((await testLogin(page, PILOT)).status === 200, 'test login failed');
      await reloadGame(page);
      const t = await title(page);
      assert(t.account === signedIn(PILOT), `account line ${JSON.stringify(t.account)}`);
      assert(t.items[0] === TXT.continue, `title offers ${t.items.join(' | ')}`);
      await chooseTitle(page, TXT.continue);
      await inFlight(page);
      const s = await state(page);
      assert(s.system === saved.system, `system ${s.system} ≠ ${saved.system}`);
      assert(Math.abs(s.tankKg - saved.tankKg) < 1, `tank ${kg(s.tankKg)} ≠ ${kg(saved.tankKg)}`);
      note(`device 2: ${s.system}, tank ${kg(s.tankKg)}, revision ${s.revision}, sync ${s.sync}`);
    },
    { requires: ['1'] },
  );

  // ---------------------------------------------------------------- scenario 3
  const chosen = {};
  await step(
    '3',
    'both offline; device 1 syncs first; device 2 gets 409 → SYNC CONFLICT → reload → conflict screen → KEEP THIS → tank ≤ the kept save',
    async (note) => {
      await setOffline('device-1', one.ctx, true);
      await setOffline('device-2', two.ctx, true);
      note('both contexts offline');

      // Device 1 gains fuel offline: mine + refine again at the same rock.
      const p1 = one.page;
      await targetIceRock(p1, (s) => note(`device 1: ${s}`));
      const gain = await mineAndRefine(p1, (s) => note(`device 1: ${s}`));
      const s1 = await pauseSave(p1);
      await waitState(p1, (x) => x.sync === 'offline', 'device 1 to report offline', 20_000);
      note(`device 1 saved offline: revision ${s1.revision}, tank ${kg(s1.tankKg)} (+${(gain.after - gain.before).toFixed(1)} kg refined); status "${(await state(p1)).syncText}"`);

      // Device 2 spends a little offline: a burn, then a save.
      const p2 = two.page;
      const b0 = (await state(p2)).tankKg;
      await burn(p2, 1_500);
      const s2 = await pauseSave(p2);
      await waitState(p2, (x) => x.sync === 'offline', 'device 2 to report offline', 20_000);
      note(`device 2 saved offline: revision ${s2.revision}, tank ${kg(b0)} → ${kg(s2.tankKg)}; status "${(await state(p2)).syncText}"`);

      // Device 1 online first: its retry pushes (backoff ≤ 15 s at this point).
      await setOffline('device-1', one.ctx, false);
      const on1 = await waitState(p1, (x) => x.sync === 'synced', 'device 1 to sync', 90_000);
      const head1 = await cloudHead(one.ctx);
      assert(head1.revision === on1.revision, `cloud revision ${head1.revision} ≠ device 1 ${on1.revision}`);
      note(`device 1 online → synced; cloud revision ${head1.revision}, tank ${kg(head1.tankKg)}`);

      // Device 2 online: its push is based on the old head → 409.
      const conflicts409 = () => httpErrors.filter((h) => h.label === 'device-2' && h.status === 409 && h.method === 'PUT').length;
      await setOffline('device-2', two.ctx, false);
      await waitState(p2, (x) => x.sync === 'conflict', 'device 2 to report the conflict', 90_000);
      assert(conflicts409() >= 1, 'no 409 PUT seen from device 2');
      await waitLog(p2, TXT.conflict, 5_000);
      await openPause(p2);
      const line = await pauseSyncLine(p2);
      assert(line === TXT.conflict, `pause sync line ${JSON.stringify(line)}`);
      await resume(p2);
      const kept = await state(p2);
      Object.assign(chosen, { tankKg: kept.tankKg, revision: kept.revision, cloudRevision: head1.revision, device1Tank: s1.tankKg });
      note(`device 2: PUT → 409; log + pause line "${line}"; its tank ${kg(kept.tankKg)} at revision ${kept.revision}`);

      // Reload device 2 → the conflict screen, over the boot veil.
      await p2.reload({ waitUntil: 'load' });
      await p2.waitForSelector('.os-conflict', { timeout: 60_000 });
      const screen = await p2.evaluate(() => ({
        title: document.querySelector('.os-cf-title')?.textContent,
        cards: [...document.querySelectorAll('.os-cf-card')].map((c) => [...c.children].map((x) => x.textContent)),
        on: document.querySelector('.os-cf-btn.on')?.textContent,
        veil: !document.getElementById('boot')?.classList.contains('hidden'),
        ready: window.__osReady === true,
      }));
      note(`conflict screen: ${screen.title}; ${screen.cards.map((c) => c.join(' / ')).join('  ||  ')}`);
      assert(screen.title === TXT.diverged, `title ${screen.title}`);
      assert(screen.cards[0]?.[0] === TXT.thisDevice && screen.cards[1]?.[0] === TXT.cloud, 'card labels');
      assert(screen.cards[0]?.at(-1) === TXT.keepThis && screen.cards[1]?.at(-1) === TXT.keepCloud, 'card buttons');
      assert(screen.veil && !screen.ready, `boot veil up ${screen.veil}, game ready ${screen.ready}`);
      await p2.keyboard.press('ArrowRight');
      assert((await p2.textContent('.os-cf-btn.on')) === TXT.keepCloud, '→ did not move to KEEP CLOUD');
      await p2.keyboard.press('ArrowLeft');
      assert((await p2.textContent('.os-cf-btn.on')) === TXT.keepThis, '← did not move to KEEP THIS');
      await p2.waitForTimeout(1_000);
      assert(await p2.evaluate(() => !document.getElementById('boot')?.classList.contains('hidden')), 'the veil dropped before a choice');
      // What is kept is the device's LATEST save — the reload itself may have
      // saved again (pagehide) — so it is read from the resolve request.
      const resolveReq = p2.waitForRequest((r) => r.url().endsWith('/api/save/resolve') && r.method() === 'POST', { timeout: 15_000 });
      const resolveRes = p2.waitForResponse((r) => r.url().endsWith('/api/save/resolve'), { timeout: 15_000 });
      await p2.keyboard.press('Enter');
      const sent = (await resolveReq).postDataJSON();
      const answer = await resolveRes;
      const keptRevision = sent.device.revision;
      const keptTank = sent.device.ship.propellant.massKg;
      note(`resolve sent keep=${sent.keep}, device revision ${keptRevision} (tank ${kg(keptTank)}), cloud seen ${sent.cloud?.revision}; answer ${answer.status()}`);
      assert(sent.keep === 'device', `resolve asked to keep ${sent.keep}`);
      assert(answer.status() === 200, `resolve answered ${answer.status()}`);
      await booted(p2);
      const head = await cloudHead(two.ctx);
      await chooseTitle(p2, TXT.continue);
      await inFlight(p2);
      const r = await state(p2);
      note(`KEEP THIS → cloud revision ${head.revision} (cloud ${head1.revision}, device ${keptRevision}), tank ${kg(head.tankKg)}; device 2 continues with tank ${kg(r.tankKg)}, sync ${r.sync}`);
      assert(head.revision === Math.max(sent.cloud?.revision ?? 0, keptRevision) + 1, `resolved revision ${head.revision}, expected max(both)+1`);
      assert(Math.abs(r.tankKg - head.tankKg) < 1, `device tank ${kg(r.tankKg)} ≠ cloud ${kg(head.tankKg)}`);
      assert(r.tankKg <= keptTank + 0.5, `the result ${kg(r.tankKg)} is above the kept save's ${kg(keptTank)} — fuel was created`);
      assert(r.tankKg < chosen.device1Tank, `the result ${kg(r.tankKg)} took device 1's tank ${kg(chosen.device1Tank)}`);
      note(`rule: result ${kg(r.tankKg)} ≤ kept ${kg(keptTank)}; device 1's refined ${kg(chosen.device1Tank)} not carried over`);
    },
    { requires: ['2'] },
  );
  // Device 1 now trails the resolved cloud; it is done.
  await one.ctx?.close();

  // ---------------------------------------------------------------- scenario 4
  const four = {};
  await step(
    '4',
    'the server stops mid-game → OFFLINE — SAVED LOCALLY; reload → the progress is still there',
    async (note) => {
      const page = two.page;
      await waitState(page, (x) => x.sync === 'synced', 'device 2 to be synced', 30_000);
      const cloudBefore = await cloudHead(two.ctx);
      note(`cloud before: revision ${cloudBefore.revision}, tank ${kg(cloudBefore.tankKg)}`);
      deliberate.serverDown = true;
      await stopServer();
      note('server stopped');
      const b0 = (await state(page)).tankKg;
      await burn(page, 3_000);
      const s = await pauseSave(page);
      await waitState(page, (x) => x.sync === 'offline', 'the offline status', 20_000);
      await waitLog(page, TXT.offline, 5_000);
      await openPause(page);
      const line = await pauseSyncLine(page);
      await resume(page);
      assert(line === TXT.offline, `pause sync line ${JSON.stringify(line)}`);
      note(`burned ${kg(b0)} → ${kg(s.tankKg)}, SAVED revision ${s.revision}; log + pause line "${line}"`);
      four.tankKg = s.tankKg;
      four.revision = s.revision;

      // Reload with the server down: there is nothing to serve the page.
      let reloadError = null;
      try {
        await page.reload({ waitUntil: 'load', timeout: 15_000 });
      } catch (err) {
        reloadError = err.message.split('\n')[0];
      }
      const ready = await page.evaluate(() => window.__osReady === true).catch(() => false);
      note(`reload with the server down: ${reloadError ?? 'loaded'}; url ${page.url()}; game booted: ${ready}`);
      assert(!ready, 'the game booted with no server (unexpected: no offline cache exists)');

      startServer();
      await waitForHealth();
      deliberate.serverDown = false;
      note('server restarted (the page cannot load without it); reloading');
      await gotoGame(page);
      const t = await title(page);
      assert(t.items[0] === TXT.continue, `title offers ${t.items.join(' | ')}`);
      await chooseTitle(page, TXT.continue);
      await inFlight(page);
      const r = await state(page);
      // The page saves once more as it goes (pagehide), with whatever the
      // drive burned since SAVE: the continued tank is the LATEST local save —
      // at or below the SAVE's, at or above its revision, and never the cloud's.
      note(`after reload + CONTINUE: tank ${kg(r.tankKg)}, revision ${r.revision} (SAVE was ${kg(four.tankKg)} at ${four.revision}; cloud ${kg(cloudBefore.tankKg)} at ${cloudBefore.revision})`);
      assert(r.revision >= four.revision, `revision ${r.revision} below the offline SAVE's ${four.revision}`);
      assert(r.tankKg <= four.tankKg + 0.5, `tank ${kg(r.tankKg)} above the offline SAVE's ${kg(four.tankKg)}`);
      assert(r.tankKg < cloudBefore.tankKg - 2, `tank ${kg(r.tankKg)} is the cloud's ${kg(cloudBefore.tankKg)}: the offline progress is gone`);
      note('local progress intact');
      const synced = await waitState(page, (x) => x.sync === 'synced', 'the boot to push the local save', 30_000);
      const head = await cloudHead(two.ctx);
      // The ship keeps flying (and burning) after CONTINUE: compare saves, not the live tank.
      assert(head.revision === synced.revision, `cloud revision ${head.revision} ≠ the local save's ${synced.revision}`);
      assert(head.tankKg <= four.tankKg + 0.5 && head.tankKg < cloudBefore.tankKg - 2, `cloud tank ${kg(head.tankKg)} after the push is not the offline progress`);
      note(`and pushed after the restart: cloud revision ${head.revision}, tank ${kg(head.tankKg)} (sync ${synced.sync})`);
    },
    { requires: ['3'] },
  );

  // ---------------------------------------------------------------- scenario 5
  await step(
    '5a',
    `frame time around a save + push (hitch threshold ${HITCH_MS} ms)`,
    async (note) => {
      const page = two.page;
      // The last PUT was at most a few seconds ago: wait out the 5 s push spacing first.
      await page.waitForTimeout(6_000);
      await page.evaluate(() => {
        window.__e2eFrames = [];
        window.__e2eFramesOn = true;
        const tick = (t) => {
          window.__e2eFrames.push(t);
          if (window.__e2eFramesOn) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await page.waitForTimeout(3_000);
      const putDone = page.waitForResponse((r) => r.url().endsWith('/api/save') && r.request().method() === 'PUT', { timeout: 30_000 });
      // The save the pilot asks for, without the pause sheet in the measured frames.
      const saveStart = await page.evaluate(() => {
        const t = performance.now();
        void window.oneSpace.get('save').saveNow('manual');
        return t;
      });
      const put = await putDone;
      const putEnd = await page.evaluate(() => performance.now());
      await page.waitForTimeout(3_000);
      const frames = await page.evaluate(() => {
        window.__e2eFramesOn = false;
        return window.__e2eFrames;
      });
      const deltas = [];
      for (let i = 1; i < frames.length; i++) deltas.push({ t: frames[i], d: frames[i] - frames[i - 1] });
      const all = stats(deltas.map((x) => x.d));
      const base = stats(deltas.filter((x) => x.t < saveStart).map((x) => x.d));
      const win = stats(deltas.filter((x) => x.t >= saveStart && x.t <= putEnd + 500).map((x) => x.d));
      note(`PUT ${put.status()} ${(putEnd - saveStart).toFixed(0)} ms after the save started`);
      note(`baseline: ${fmt(base)}`);
      note(`save+push window: ${fmt(win)}`);
      note(`whole run: ${fmt(all)}`);
      four.frames = { base, win, all };
      assert(put.status() === 200, `PUT answered ${put.status()}`);
      assert(win.max <= HITCH_MS, `a ${win.max.toFixed(1)} ms frame during the save + push`);
    },
    { requires: ['4'] },
  );

  await browser.close();
  browser = null;

  await step('5b', 'no console errors, page errors, CSP violations or failed requests, beyond the protocol statuses and deliberate outages', async (note) => {
    // Chromium logs every 4xx/5xx fetch as "Failed to load resource". The
    // statuses the protocol answers by design are listed, not counted:
    // 401 GET /api/me and /api/save (a guest), 404 GET /api/save (an empty
    // cloud), 409 PUT /api/save (the conflict scenario 3 provokes).
    const expectedHttp = (h) =>
      (h.status === 401 && h.method === 'GET' && (h.url.endsWith('/api/me') || h.url.endsWith('/api/save'))) ||
      (h.status === 404 && h.method === 'GET' && h.url.endsWith('/api/save')) ||
      (h.status === 409 && h.method === 'PUT' && h.url.endsWith('/api/save') && h.label === 'device-2');
    const statusLine = /^Failed to load resource: the server responded with a status of (\d+)/;
    const unexpectedHttp = httpErrors.filter((h) => !expectedHttp(h));
    const consoleErrors = problems.filter((p) => p.kind === 'console');
    const statusErrors = consoleErrors.filter((p) => statusLine.test(p.text));
    const networkErrors = consoleErrors.filter((p) => /net::ERR_/.test(p.text));
    const otherConsole = consoleErrors.filter((p) => !statusLine.test(p.text) && !/net::ERR_/.test(p.text));
    // net::ERR_ console lines: only from a context while it was offline or the server was down.
    const csp = problems.filter((p) => p.kind === 'csp');
    const pageErrors = problems.filter((p) => p.kind === 'pageerror');
    const failed = problems.filter((p) => p.kind === 'requestfailed');
    const dialogs = problems.filter((p) => p.kind === 'dialog');
    const deliberateFails = problems.filter((p) => p.kind === 'requestfailed-deliberate');
    const groups = (xs) => {
      const m = new Map();
      for (const h of xs) {
        const k = `${h.status} ${h.method} ${new URL(h.url).pathname} (${h.label})`;
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return [...m].map(([k, n]) => `${n}× ${k}`).join(', ') || 'none';
    };
    note(`HTTP error statuses by design: ${groups(httpErrors.filter(expectedHttp))}`);
    note(`browser console lines for them ("Failed to load resource"): ${statusErrors.length}`);
    note(`deliberate failed requests (offline / server down): ${deliberateFails.length}; net::ERR_ console lines: ${networkErrors.length}`);
    const list = (xs) => xs.map((p) => `[${p.label} ${p.at}] ${p.text}${p.url ? ` @ ${p.url}` : ''}`).join('\n      ');
    if (unexpectedHttp.length) note(`UNEXPECTED HTTP statuses: ${groups(unexpectedHttp)}`);
    if (otherConsole.length) note(`console errors:\n      ${list(otherConsole)}`);
    if (csp.length) note(`CSP violations:\n      ${list(csp)}`);
    if (pageErrors.length) note(`page errors:\n      ${list(pageErrors)}`);
    if (failed.length) note(`failed requests:\n      ${list(failed)}`);
    if (dialogs.length) note(`dialogs:\n      ${list(dialogs)}`);
    const strayNet = networkErrors.length > 0 && deliberateFails.length === 0;
    assert(
      !unexpectedHttp.length && !otherConsole.length && !csp.length && !pageErrors.length && !failed.length && !dialogs.length && !strayNet,
      'unexpected errors (above)',
    );
    note(`0 other console errors, 0 page errors, 0 CSP violations, 0 unexpected failed requests`);
  });
}

// ---------------------------------------------------------------------------
// Cleanup, always
// ---------------------------------------------------------------------------

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    await browser?.close();
  } catch {
    /* already gone */
  }
  await stopServer().catch(() => undefined);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    void cleanup().then(() => process.exit(130));
  });
}

try {
  await run();
} catch (err) {
  say(`ABORTED: ${err?.stack ?? err}`);
  results.push({ id: '!', name: 'run aborted', status: 'FAIL', notes: [String(err?.message ?? err)], ms: 0 });
} finally {
  await cleanup();
}

console.log('\n================ e2e:cloud ================');
for (const r of results) console.log(`${r.status.padEnd(5)} ${r.id.padEnd(3)} ${r.name}  (${(r.ms / 1000).toFixed(1)} s)`);
const failed = results.filter((r) => r.status === 'FAIL' || r.status === 'SKIP');
if (failed.length && serverOut) console.log(`\n--- server output (tail) ---\n${serverOut.slice(-4_000)}`);
if (process.argv.includes('--json')) console.log(JSON.stringify({ results, problems, httpErrors }, null, 2));
if (process.exitCode === undefined) process.exitCode = failed.length || !results.length ? 1 : 0;
