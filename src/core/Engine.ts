/**
 * The engine: renderer, frame loop, and a registry of game modules.
 *
 * The engine knows nothing about space, ships or planets. It owns the WebGL
 * context, the clock and the module lifecycle; everything else is a module.
 * That boundary is what lets each subsystem be written, replaced and reviewed
 * on its own.
 */

import {
  ACESFilmicToneMapping,
  Clock,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';

import { bus } from './EventBus';
import { config, detectTier, type QualitySettings } from './Config';
import { FloatingOrigin } from './FloatingOrigin';
import { Input } from './Input';
import { ResolutionGovernor } from './ResolutionGovernor';
import { modes, type Mode } from './Modes';
import { moduleDt, tickModules } from './tick';
import { parseDevParams } from './Route';
import { ENGINE_MAX_DT } from './substeps';
import { governorHoldUp } from './flightActivity';
import { ResizeLatch } from './resizeLatch';

export interface EngineContext {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly input: Input;
  readonly origin: FloatingOrigin;
  readonly quality: QualitySettings;
  /** Seconds since boot. */
  readonly elapsed: number;
  /** Frames rendered since boot. */
  readonly frame: number;
  readonly width: number;
  readonly height: number;
}

export interface GameModule {
  readonly name: string;
  /**
   * Modes this module lives in (see core/Modes.ts and core/tick.ts). Omitted
   * means always on — the v1 behaviour, and the right default for anything
   * whose clock must not stop (log, audio).
   */
  readonly activeIn?: readonly Mode[];
  /** Told on every mode change, active or not, so it can hide or restore. */
  onModeChange?(from: Mode, to: Mode, ctx: EngineContext): void;
  init?(ctx: EngineContext): Promise<void> | void;
  /** Called every frame, in registration order. */
  update?(dt: number, ctx: EngineContext): void;
  /** Called after all updates — use for anything that must see final state. */
  lateUpdate?(dt: number, ctx: EngineContext): void;
  resize?(width: number, height: number, ctx: EngineContext): void;
  dispose?(): void;
}

/**
 * A module that takes over presentation. Exactly one may be registered; if
 * present the engine calls it instead of `renderer.render()`. PostFX uses this.
 */
export interface RenderPipeline {
  render(dt: number, ctx: EngineContext): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly input: Input;
  readonly origin = new FloatingOrigin();

  private modules: GameModule[] = [];
  /** Reused every frame — no allocation in the loop. */
  private tickState: { base: typeof modes.base; overlay: typeof modes.overlay } = {
    base: modes.base,
    overlay: modes.overlay,
  };
  private pipeline: RenderPipeline | null = null;
  private clock = new Clock();
  private running = false;
  private rafId = 0;
  private elapsed = 0;
  private frame = 0;
  private width = 1;
  private height = 1;

  /** Rolling average frame time in ms, used by the adaptive resolution. */
  private avgFrameMs = 16.7;
  private resolutionScale = 1;
  /** Wall-clock governor — the only frame timer that sees the GPU. */
  private governor = new ResolutionGovernor();
  private lastStepAt = 0;
  private avgWallMs = 16.7;
  /**
   * [v3-T1] A governor step resizes the drawing buffer, which clears it. Held
   * here and applied at the start of the next frame, never between a render
   * and the browser presenting it (that was a black frame per step).
   */
  private readonly resizeLatch = new ResizeLatch();
  /** `?dpr=` override; replaces the tier's cap when set. */
  private dprCap: number | null = null;

  /**
   * When set, the loop advances by exactly this much simulated time per frame
   * regardless of wall clock. The screenshot harness uses it so a "6 second
   * settle" means 360 identical frames on any machine, fast or slow.
   */
  fixedDt: number | null = null;
  private frameWaiters: Array<{ remaining: number; resolve: () => void }> = [];

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false, // handled in post; MSAA on a deferred-ish stack is wasted
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
    });

    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    // `?tier=` and `?dpr=` override the guess. Whitelisted in Route.ts.
    const dev = parseDevParams(window.location.search);
    const tier = dev.tier ?? detectTier(gl);
    const q = config.setTier(tier);
    this.dprCap = dev.dpr ?? null;

    this.renderer.outputColorSpace = SRGBColorSpace;
    // The scene is authored in physical-ish units and graded in post, so the
    // renderer itself stays linear — PostFX owns the tone map.
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.setPixelRatio(this.pixelRatioCap(q));

    // near/far are deliberately extreme; the logarithmic depth buffer copes.
    //
    // near is 0.5 m, not 50 m. Units are kilometres, and the ship is 0.03 —
    // thirty metres. A near plane of 0.05 slices straight through the hull in
    // chase and cockpit views, exposing the interior greebles, which reads as
    // broken geometry rather than as clipping. A tiny near plane is exactly
    // what the logarithmic depth buffer is for; not using it wastes it.
    this.camera = new PerspectiveCamera(62, 1, 0.0005, 1e12);
    this.camera.position.set(0, 0, 0);

    this.input = new Input(canvas);

    modes.onChange((from, to) => {
      const ctx = this.context;
      for (const m of this.modules) m.onModeChange?.(from, to, ctx);
    });

    this.handleResize();
    window.addEventListener('resize', this.handleResize);

    // Losing the context on a laptop lid-close should not be fatal.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.stop();
      bus.emit('log', { text: 'GRAPHICS CONTEXT LOST — attempting recovery', tone: 'warn' });
    });
    canvas.addEventListener('webglcontextrestored', () => this.start());
  }

  get context(): EngineContext {
    return {
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      input: this.input,
      origin: this.origin,
      quality: config.quality,
      elapsed: this.elapsed,
      frame: this.frame,
      width: this.width,
      height: this.height,
    };
  }

  async add(module: GameModule): Promise<void> {
    this.modules.push(module);
    await module.init?.(this.context);
  }

  setPipeline(pipeline: RenderPipeline | null): void {
    this.pipeline?.dispose();
    this.pipeline = pipeline;
    if (pipeline) pipeline.resize(this.width, this.height);
  }

  get<T extends GameModule>(name: string): T | undefined {
    return this.modules.find((m) => m.name === name) as T | undefined;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const tick = () => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(tick);
      this.step();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private step(): void {
    const t0 = performance.now();
    // Interval since the previous frame began: CPU + GPU + vsync, everything.
    const wallMs = this.lastStepAt > 0 ? t0 - this.lastStepAt : 0;
    this.lastStepAt = t0;

    // [v3-T1] A pending resolution change lands before anything is drawn.
    if (this.resizeLatch.takeBeforeRender()) this.applySize();

    // Clamp dt: a background tab or a long GC pause must not teleport the ship.
    // [v3-T1] The clamp is shared with FlightModel's substep budget
    // (core/substeps.ts) so no clamped frame ever loses ship time.
    const realDt = Math.min(this.clock.getDelta(), ENGINE_MAX_DT);
    const dt = this.fixedDt ?? realDt;
    this.elapsed += dt;
    this.frame++;

    this.input.update(dt);

    const ctx = this.context;
    this.tickState.base = modes.base;
    this.tickState.overlay = modes.overlay;
    tickModules(this.modules, this.tickState, dt, ctx);

    if (this.pipeline) this.pipeline.render(dt, ctx);
    else this.renderer.render(this.scene, this.camera);

    // Read back in the same task as the draw: the drawing buffer is still
    // intact, so no preserveDrawingBuffer (which costs every frame) is needed.
    if (this.captureWaiters.length) {
      const waiters = this.captureWaiters.splice(0);
      this.canvas.toBlob((b) => {
        for (const w of waiters) w(b);
      }, 'image/png');
    }

    this.input.endFrame();

    // CPU-side cost only; kept for the stats overlay. The governor is fed the
    // wall-clock interval instead, because this number never sees the GPU.
    const frameMs = performance.now() - t0;
    this.avgFrameMs += (frameMs - this.avgFrameMs) * 0.05;
    // Clamped, not filtered: under SwiftShader every frame can exceed 250 ms,
    // and a filter left the readout stuck at a fictional 60 fps.
    if (wallMs > 0) this.avgWallMs += (Math.min(wallMs, 2000) - this.avgWallMs) * 0.05;
    // Fixed-step simulation (review harness) is not real time; its intervals
    // say nothing about load.
    if (this.fixedDt === null) this.adaptResolution(wallMs);

    if (this.frameWaiters.length) this.tickWaiters();
  }

  private tickWaiters(): void {
    for (let i = this.frameWaiters.length - 1; i >= 0; i--) {
      const w = this.frameWaiters[i]!;
      if (--w.remaining <= 0) {
        this.frameWaiters.splice(i, 1);
        w.resolve();
      }
    }
  }

  /**
   * Run `seconds` of simulated time at a fixed step, then resolve.
   * Leaves the engine in fixed-step mode so successive calls stay reproducible;
   * call `resumeRealtime()` to hand time back to the wall clock.
   */
  simulate(seconds: number, fixedDt = 1 / 60): Promise<void> {
    this.fixedDt = fixedDt;
    const remaining = Math.max(1, Math.ceil(seconds / fixedDt));
    return new Promise<void>((resolve) => {
      this.frameWaiters.push({ remaining, resolve });
    });
  }

  /**
   * Compile every material currently in the scene, using
   * KHR_parallel_shader_compile where the driver has it. Never rejects: a
   * failure here only means the first frame compiles lazily, as before.
   */
  async prewarm(): Promise<void> {
    // One frame first, so modules that create their renderers lazily — the
    // home planet is acquired by Universe's first update — exist when the
    // programs are compiled. Under the boot veil; nobody sees this frame.
    this.step();
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch {
      /* fall back to lazy compile */
    }
  }

  /** Resolve with a PNG of the next rendered frame (null if the browser refuses). */
  captureNextFrame(): Promise<Blob | null> {
    return new Promise((resolve) => this.captureWaiters.push(resolve));
  }

  private captureWaiters: Array<(b: Blob | null) => void> = [];

  /** How many modules tick in the current mode — for the dev overlay. */
  moduleCounts(): { ticking: number; total: number } {
    let ticking = 0;
    const st = { base: modes.base, overlay: modes.overlay };
    for (const m of this.modules) if (moduleDt(m, st, 1) >= 0) ticking++;
    return { ticking, total: this.modules.length };
  }

  resumeRealtime(): void {
    this.fixedDt = null;
    this.clock.getDelta();
  }

  /**
   * Nudge internal resolution to hold ~60fps. Dropping pixels is far less
   * visible than dropping frames, so this is the first lever we pull.
   */
  private adaptResolution(wallMs: number): void {
    // [v3-T1] No rise while the autopilot or cruise is flying: each step
    // reallocates the post stack and costs a 56-67 ms frame.
    if (!this.governor.sample(wallMs, governorHoldUp())) return;
    this.resolutionScale = this.governor.scale;
    config.dynamicResolution = this.resolutionScale;
    // [v3-T1] Not applySize() here: this runs after render(), and resizing
    // the canvas clears what the browser is about to present.
    this.resizeLatch.request();
  }

  private pixelRatioCap(q: QualitySettings): number {
    return Math.min(window.devicePixelRatio, this.dprCap ?? q.maxPixelRatio);
  }

  private handleResize = (): void => {
    this.applySize();
  };

  private applySize(): void {
    const q = config.quality;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.width = w;
    this.height = h;

    this.renderer.setPixelRatio(
      this.pixelRatioCap(q) * q.renderScale * this.resolutionScale,
    );
    this.renderer.setSize(w, h, false);

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    this.pipeline?.resize(w, h);
    const ctx = this.context;
    for (const m of this.modules) m.resize?.(w, h, ctx);
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    for (const m of this.modules) m.dispose?.();
    this.modules = [];
    this.pipeline?.dispose();
    this.input.dispose();
    this.renderer.dispose();
  }

  /** Diagnostics for the debug overlay. */
  stats(): {
    fps: number;
    frameMs: number;
    cpuMs: number;
    scale: number;
    calls: number;
    tris: number;
    programs: number;
  } {
    const info = this.renderer.info;
    return {
      // Wall-clock: what the player actually gets. v1 reported CPU time here,
      // which read "500 fps" on a frame that took 112 ms.
      fps: 1000 / this.avgWallMs,
      frameMs: this.avgWallMs,
      cpuMs: this.avgFrameMs,
      scale: this.resolutionScale,
      calls: info.render.calls,
      tris: info.render.triangles,
      programs: info.programs?.length ?? 0,
    };
  }
}
