/**
 * oneSpace — bootstrap.
 *
 * Owns nothing but wiring: create the engine, register modules in dependency
 * order, hand control to the frame loop. Anything with logic in it belongs in
 * a module, not here.
 */

import { Engine } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { registerShaderChunks } from '@/shaders/chunks';
import { clearShot, setShot, shotList, shotNames } from '@/game/Shots';
import { modes } from '@/core/Modes';
import { parseRoute } from '@/core/Route';

const boot = {
  el: document.getElementById('boot') as HTMLDivElement,
  bar: document.getElementById('boot-bar') as HTMLElement,
  status: document.getElementById('boot-status') as HTMLElement,
  set(progress: number, status: string): void {
    if (this.bar) this.bar.style.right = `${Math.round((1 - progress) * 100)}%`;
    if (this.status) this.status.textContent = status;
  },
  hide(): void {
    this.el?.classList.add('hidden');
  },
};

function fatal(err: unknown): void {
  const pre = document.getElementById('fatal');
  if (pre) {
    pre.style.display = 'block';
    pre.textContent = `oneSpace failed to start\n\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  }
  console.error(err);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('gl') as HTMLCanvasElement;
  if (!canvas) throw new Error('canvas #gl not found');

  registerShaderChunks();

  bus.on('boot:progress', ({ progress, status }) => boot.set(progress, status));

  const engine = new Engine(canvas);
  boot.set(0.1, 'engine online');

  // Modules are registered here as they land. Order is dependency order:
  // world state, then generation-driven renderers, then ship, then UI/post.
  const { registerModules } = await import('@/game/registry');
  await registerModules(engine, (progress, status) =>
    bus.emit('boot:progress', { progress: 0.1 + progress * 0.85, status }),
  );

  // Link every program the opening scene needs while the boot veil is still
  // up. Lazily, the first frame did it synchronously: 0.3 s warm, 2.8 s with
  // a cold shader cache — a frozen screen as the first thing a player sees.
  boot.set(0.97, 'compiling shaders');
  await engine.prewarm();

  boot.set(1, 'ready');
  // Boot into the title unless a link names a mode (?mode=flight skips it,
  // ?mode=yard opens the Yard). `map` and `review` are not boot targets for a
  // player — the chart and shots are entered from flight — so they fall back
  // to the title.
  const route = parseRoute(window.location.search);
  for (const w of route.warnings) console.warn(`route: ${w}`);
  const bootMode = route.mode === 'flight' || route.mode === 'yard' ? route.mode : 'title';
  modes.go(bootMode);
  engine.start();
  bus.emit('boot:done');
  setTimeout(() => boot.hide(), 400);

  installReviewHarness(engine);
}

/**
 * Hooks consumed by `scripts/shoot.mjs`. Kept in the shipped bundle on purpose:
 * they are a few hundred bytes and they mean the reviewed build is byte-identical
 * to the played build. Nothing here runs unless something calls it.
 */
function installReviewHarness(engine: Engine): void {
  const w = window as unknown as Record<string, unknown>;
  w.oneSpace = engine;
  w.__osReady = true;
  w.__osShots = () => shotNames();
  w.__osShotList = () => shotList();
  w.__osStats = () => engine.stats();
  w.__osSetShot = async (name: string) => {
    w.__osSettled = false;
    boot.hide();
    await setShot(name, engine.context);
  };
  // Leave the active shot and return to the mode it interrupted.
  w.__osClearShot = () => clearShot(engine.context);
  w.__osSettle = async (seconds: number) => {
    w.__osSettled = false;
    await engine.simulate(seconds);
    w.__osSettled = true;
  };
}

main().catch(fatal);
