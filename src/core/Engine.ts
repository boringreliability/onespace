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
    const tier = detectTier(gl);
    const q = config.setTier(tier);

    this.renderer.outputColorSpace = SRGBColorSpace;
    // The scene is authored in physical-ish units and graded in post, so the
    // renderer itself stays linear — PostFX owns the tone map.
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.maxPixelRatio));

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

    // Clamp dt: a background tab or a long GC pause must not teleport the ship.
    const realDt = Math.min(this.clock.getDelta(), 1 / 15);
    const dt = this.fixedDt ?? realDt;
    this.elapsed += dt;
    this.frame++;

    this.input.update(dt);

    const ctx = this.context;
    for (const m of this.modules) m.update?.(dt, ctx);
    for (const m of this.modules) m.lateUpdate?.(dt, ctx);

    if (this.pipeline) this.pipeline.render(dt, ctx);
    else this.renderer.render(this.scene, this.camera);

    this.input.endFrame();

    const frameMs = performance.now() - t0;
    this.avgFrameMs += (frameMs - this.avgFrameMs) * 0.05;
    this.adaptResolution();

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

  resumeRealtime(): void {
    this.fixedDt = null;
    this.clock.getDelta();
  }

  /**
   * Nudge internal resolution to hold ~60fps. Dropping pixels is far less
   * visible than dropping frames, so this is the first lever we pull.
   */
  private adaptResolution(): void {
    if (this.frame % 30 !== 0) return;
    const target = 16.7;
    let next = this.resolutionScale;
    if (this.avgFrameMs > target * 1.35) next -= 0.05;
    else if (this.avgFrameMs < target * 0.8) next += 0.03;
    next = Math.max(0.55, Math.min(1, next));
    if (Math.abs(next - this.resolutionScale) > 0.001) {
      this.resolutionScale = next;
      config.dynamicResolution = next;
      this.applySize();
    }
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
      Math.min(window.devicePixelRatio, q.maxPixelRatio) * q.renderScale * this.resolutionScale,
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
  stats(): { fps: number; frameMs: number; scale: number; calls: number; tris: number } {
    const info = this.renderer.info;
    return {
      fps: 1000 / this.avgFrameMs,
      frameMs: this.avgFrameMs,
      scale: this.resolutionScale,
      calls: info.render.calls,
      tris: info.render.triangles,
    };
  }
}
