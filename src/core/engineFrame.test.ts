/**
 * [review-v3a] The engine's frame, end to end, with a recording renderer.
 *
 * The pure pieces (substepBudget, ResizeLatch, governorShouldStep) were
 * tested; the wiring that makes them hold in the game was not — removing the
 * clamp, the latch or the hold from Engine.ts left every test green
 * (mutation review). These tests drive `Engine.step()` itself. No GL: the
 * renderer only records the order of resize and render, which is the whole
 * property (a resize between render and present is a black frame, D19).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];

vi.hoisted(() => {
  const noop = (): void => undefined;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    location: { search: '' },
    addEventListener: noop,
    removeEventListener: noop,
    innerWidth: 1600,
    innerHeight: 900,
    devicePixelRatio: 1,
  };
  g.document = { addEventListener: noop, removeEventListener: noop, pointerLockElement: null };
});

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class RecordingRenderer {
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    info = { render: { calls: 0, triangles: 0 }, programs: [] };
    getContext(): null {
      return null;
    }
    setPixelRatio(): void {
      calls.push('pixelRatio');
    }
    setSize(): void {
      calls.push('resize');
    }
    render(): void {
      calls.push('render');
    }
    dispose(): void {}
  }
  return { ...three, WebGLRenderer: RecordingRenderer };
});

import { Engine, type GameModule } from './Engine';
import { ENGINE_MAX_DT } from './substeps';
import { flightActivity } from './flightActivity';
import { modes } from './Modes';

const noop = (): void => undefined;
const canvas = { addEventListener: noop, removeEventListener: noop } as unknown as HTMLCanvasElement;

interface Internals {
  step(): void;
  clock: { getDelta(): number; start(): void };
  governor: { sample(ms: number, holdUp?: boolean): boolean; scale: number };
}

function engineWith(deltas: number[]): { e: Engine; i: Internals; dts: number[] } {
  const e = new Engine(canvas);
  const i = e as unknown as Internals;
  let k = 0;
  i.clock = { start: noop, getDelta: () => deltas[Math.min(k++, deltas.length - 1)]! };
  const dts: number[] = [];
  const probe: GameModule = { name: 'probe', update: (dt) => void dts.push(dt) };
  void e.add(probe);
  return { e, i, dts };
}

afterEach(() => {
  calls.length = 0;
  flightActivity.autopilot = false;
  flightActivity.cruise = false;
  flightActivity.cruiseFallback = false;
});

describe('Engine frame (review-v3a)', () => {
  it('Given a 0.5 s stall on the clock, When the frame runs, Then every module sees at most ENGINE_MAX_DT (the substep budget covers it)', () => {
    const { i, dts } = engineWith([1 / 60, 0.5, 1 / 60]);
    i.step();
    i.step();
    i.step();
    expect(dts[1]).toBeCloseTo(ENGINE_MAX_DT, 12);
    for (const dt of dts) expect(dt).toBeLessThanOrEqual(ENGINE_MAX_DT);
  });

  it('Given the governor decides a step at the end of frame N, Then frame N presents what it rendered and frame N+1 resizes BEFORE it renders', () => {
    const { i } = engineWith([1 / 60]);
    i.step(); // first frame: wallMs 0, never sampled
    let force = true;
    i.governor.sample = function () {
      if (!force) return false;
      force = false;
      this.scale = 0.7;
      return true;
    };
    calls.length = 0;
    i.step(); // frame N: governor steps after render
    const frameN = [...calls];
    calls.length = 0;
    i.step(); // frame N+1
    const frameN1 = [...calls];
    expect(frameN).toEqual(['render']);
    expect(frameN1.indexOf('resize')).toBeGreaterThanOrEqual(0);
    expect(frameN1.indexOf('resize')).toBeLessThan(frameN1.indexOf('render'));
    expect(frameN1.filter((c) => c === 'resize')).toHaveLength(1);
  });

  it('Given cruise is flying in flight, When the governor is fed, Then it is told to hold rises; Given the same frozen flags in the Yard, Then it is not', () => {
    const { i } = engineWith([1 / 60]);
    const holds: boolean[] = [];
    i.governor.sample = (_ms: number, hold?: boolean) => {
      holds.push(hold === true);
      return false;
    };
    flightActivity.cruise = true;
    modes.go('flight');
    i.step();
    i.step();
    expect(holds.at(-1)).toBe(true);
    flightActivity.cruise = false;
    flightActivity.autopilot = true;
    i.step();
    expect(holds.at(-1)).toBe(true);
    // Entered the Yard with the autopilot and cruise still "on": their modules
    // stop ticking there and the flags freeze.
    flightActivity.cruise = true;
    modes.go('yard');
    i.step();
    expect(holds.at(-1)).toBe(false);
    modes.go('flight');
    i.step();
    expect(holds.at(-1)).toBe(true);
  });

  it('Given simulate() asked for a fixed step longer than the clamp, When it runs, Then no frame exceeds ENGINE_MAX_DT and the requested time is still simulated', async () => {
    const { e, i, dts } = engineWith([1 / 60]);
    const done = e.simulate(1, 0.1);
    for (let n = 0; n < 200 && dts.length < 200; n++) i.step();
    await done;
    expect(Math.max(...dts)).toBeLessThanOrEqual(ENGINE_MAX_DT);
    const total = dts.slice(0, Math.ceil(1 / ENGINE_MAX_DT)).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(1 - 1e-9);
  });
});
