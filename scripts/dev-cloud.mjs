/**
 * Local development with the cloud save, in one command:
 *
 *   npm run dev:cloud
 *
 * 1. starts the Postgres container (`docker compose up -d db`) and waits until
 *    it accepts connections,
 * 2. builds the API server (server/ -> dist-server/),
 * 3. runs the API server with `.env` and the Vite dev server side by side,
 *    each line prefixed with where it came from.
 *
 * Ctrl-C stops both. If either one exits, the other is stopped too, so a
 * crashed server is never mistaken for a running one. The database container
 * is left running (`docker compose stop db` stops it).
 *
 * Needs `.env` (copy `.env.example`); `DEV_ENV_FILE` names another file.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = resolve(ROOT, process.env.DEV_ENV_FILE ?? '.env');
const DB_WAIT_MS = 30_000;

function fail(message) {
  console.error(`\n[dev:cloud] ${message}`);
  process.exit(1);
}

function step(message) {
  console.log(`[dev:cloud] ${message}`);
}

/** Run a command to completion; its output goes straight to the terminal. */
function run(command, args, what) {
  const r = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.error) fail(`${what}: ${r.error.message}`);
  if (r.status !== 0) fail(`${what} failed (exit ${r.status}).`);
}

function dbReady() {
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'db', 'pg_isready', '-q', '-U', 'onespace'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  return r.status === 0;
}

async function waitForDb() {
  const deadline = Date.now() + DB_WAIT_MS;
  while (Date.now() < deadline) {
    if (dbReady()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`the database did not accept connections within ${DB_WAIT_MS / 1000} s (docker compose logs db).`);
}

/** Start a long-running child and prefix every line it prints. */
function start(label, command, args) {
  const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '1' } });
  const prefix = `[${label}] `;
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) console.log(prefix + line);
    });
    stream.on('end', () => {
      if (rest) console.log(prefix + rest);
    });
  }
  return child;
}

if (!existsSync(ENV_FILE)) {
  fail(`${ENV_FILE} is missing. Copy .env.example to .env and fill in the Discord values.`);
}

step('starting the database …');
run('docker', ['compose', 'up', '-d', 'db'], 'docker compose up -d db');
await waitForDb();

step('building the server …');
run(process.execPath, ['scripts/build-server.mjs'], 'building the server');

step('starting the server and Vite (Ctrl-C stops both) …');
const children = [
  start('server', process.execPath, [`--env-file=${ENV_FILE}`, 'dist-server/index.mjs']),
  start('vite', process.execPath, ['node_modules/vite/bin/vite.js']),
];
const labels = ['server', 'vite'];

let stopping = false;
function stopAll(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
  // The server drains for up to 10 s; give it a little longer, then insist.
  const hard = setTimeout(() => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  }, 12_000);
  hard.unref();
  process.exitCode = exitCode;
}

children.forEach((child, i) => {
  child.on('error', (e) => {
    console.error(`[dev:cloud] could not start ${labels[i]}: ${e.message}`);
    stopAll(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[dev:cloud] ${labels[i]} stopped (${signal ?? `exit ${code}`}); stopping the other one.`);
      stopAll(code === 0 ? 0 : 1);
    }
  });
});

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
