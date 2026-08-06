/**
 * Map mode: the galaxy chart, and the jump that closes the travel loop.
 *
 * Two modules were built independently against an interface neither could see
 * the other side of — `render/GalaxyView` draws stars and knows nothing about
 * UI, `ui/StarMap` draws UI and declared the adapter it wanted. Two of the five
 * adapter methods have no counterpart in GalaxyView, because screen projection
 * and "which systems are in view" are questions about the *camera*, which
 * neither module owns. This file owns the camera, so it answers them.
 */

import { Color, PerspectiveCamera, Vector3 } from 'three';

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { config } from '@/core/Config';

import { generateStarField, sampleSystemsNear, type StarSystemStub } from '@/gen/galaxy';
import { generateSystem } from '@/gen/system';
import type { Vec3 } from '@/gen/types';

import { GalaxyView, registerGalaxyViewShots } from '@/render/GalaxyView';
import { MutableViewState } from '@/render/ViewState';
import { StarMap, registerStarMapShots, type GalaxyViewAdapter } from '@/ui/StarMap';
import type { Warp } from '@/ship/Warp';
import type { Universe } from '@/game/Universe';
import { shotOwnsScene } from '@/game/Shots';

/**
 * Radius of the neighbourhood the chart samples, in light years, and the range
 * the camera opens at.
 *
 * The chart used to open at whole-galaxy zoom. That looks impressive and is
 * useless: every system you can actually jump to lies within CHART_RADIUS, so
 * at 90,000 ly they collapse into one pixel, every label collides, the
 * declutter pass throws them all away, and there is nothing to click. Open on
 * the neighbourhood; the wheel goes out to the whole disc for orientation.
 */
const CHART_RADIUS_LY = 140;
const OPEN_RANGE_LY = CHART_RADIUS_LY * 1.7;
/** Seconds for the open/close transition. Matches the StarMap's own animation. */
const TRANSITION = 0.5;

export interface MapModeOptions {
  readonly universe: Universe;
  readonly warp: Warp;
}

export class MapMode implements GameModule {
  readonly name = 'map-mode';

  readonly view: GalaxyView;
  readonly ui: StarMap;

  private open = false;
  /** 0 = flying, 1 = fully in the chart. Drives the transition blend. */
  private blend = 0;

  /** Systems currently charted, keyed by id — the source for both halves. */
  private charted: StarSystemStub[] = [];

  private readonly viewState = new MutableViewState();
  private readonly sunDir = new Vector3(0, 1, 0);
  private readonly sunColor = new Color(1, 1, 1);
  private readonly target = new Vector3();
  private readonly camPos = new Vector3();
  private readonly savedCamPos = new Vector3();
  private readonly scratch = new Vector3();

  /** Chart camera orbit, driven by the pointer while the map is open. */
  private azimuth = 0.6;
  private elevation = 0.52;
  private range = 1;

  private readonly universe: Universe;
  private readonly warp: Warp;
  private disposers: Array<() => void> = [];

  constructor(opts: MapModeOptions) {
    this.universe = opts.universe;
    this.warp = opts.warp;

    const q = config.quality;
    this.view = new GalaxyView(
      this.universe.galaxy,
      q,
      generateStarField(this.universe.galaxy, q.galaxyStarBudget),
    );
    this.view.object3d.visible = false;

    this.ui = new StarMap(this.buildAdapter());
    this.range = OPEN_RANGE_LY;
  }

  private dragging = false;
  private dragDX = 0;
  private dragDY = 0;

  init(ctx: EngineContext): void {
    ctx.scene.add(this.view.object3d);

    const down = (e: PointerEvent): void => {
      if (this.open && e.button === 0) this.dragging = true;
    };
    const up = (): void => {
      this.dragging = false;
    };
    const move = (e: PointerEvent): void => {
      if (!this.open || !this.dragging) return;
      this.dragDX += e.movementX;
      this.dragDY += e.movementY;
    };
    const wheel = (e: WheelEvent): void => {
      if (!this.open) return;
      e.preventDefault();
      this.range *= 1 + Math.sign(e.deltaY) * 0.12;
    };
    window.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointermove', move);
    window.addEventListener('wheel', wheel, { passive: false });
    this.disposers.push(
      () => window.removeEventListener('pointerdown', down),
      () => window.removeEventListener('pointerup', up),
      () => window.removeEventListener('pointermove', move),
      () => window.removeEventListener('wheel', wheel),
    );
    void this.ui.init?.(ctx);

    this.rechart();
    this.publishOrigin();
    // Without a details provider the info panel has nothing to say about a
    // contact; generating the system on hover is cheap and deterministic.
    this.ui.setDetailsProvider((id) => {
      const stub = this.charted.find((c) => c.id === id);
      if (!stub) return null;
      const sys = generateSystem(this.universe.galaxy, stub);
      return {
        id: sys.id,
        name: sys.name,
        spectralClass: sys.stars[0]!.spectralClass,
        planetCount: sys.planets.length,
        blurb: sys.blurb,
      };
    });
    registerGalaxyViewShots(() => this.view);
    registerStarMapShots(this.ui);

    this.disposers.push(
      bus.on('ui:toggle-map', () => this.toggle()),
      bus.on('nav:jump-requested', (req) => void this.jump(req.systemId, req.name, ctx)),
      bus.on('system:entered', () => {
        this.rechart();
        this.publishOrigin();
      }),
    );
  }

  /**
   * Re-sample the neighbourhood around wherever we now are.
   *
   * Deliberately a *sample*, not a catalogue: `sampleSystemsNear` derives stars
   * from spatial hashes on demand, so the chart costs the same whether the
   * galaxy holds eighty thousand systems or eighty million.
   */
  private rechart(): void {
    this.charted = sampleSystemsNear(
      this.universe.galaxy,
      this.universe.system.position,
      CHART_RADIUS_LY,
      220,
    );
    this.view.setLocalSystems(this.charted);
    this.target.set(
      this.universe.system.position[0],
      this.universe.system.position[1],
      this.universe.system.position[2],
    );
  }

  /** The chart measures every distance from here; it has to be told where. */
  private publishOrigin(): void {
    this.ui.setOrigin(this.universe.system.position, this.universe.system.name, this.universe.system.id);
  }

  private buildAdapter(): GalaxyViewAdapter {
    const projected = new Vector3();
    return {
      setHighlight: (id) => this.view.setHighlight(id),
      setCursor: (p) => this.view.setCursor(p as Vec3 | null),
      setRouteLine: (pts) => this.view.setRouteLine(pts as readonly Vec3[]),

      // Screen projection is a camera question, which is why GalaxyView cannot
      // answer it: the same star is in three different places on screen for
      // three different cameras looking at the same chart.
      project: (positionLy) => {
        const cam = this.camera;
        if (!cam) return { x: 0, y: 0, visible: false };
        projected.set(positionLy[0], positionLy[1], positionLy[2]).project(cam);
        const behind = projected.z > 1;
        return {
          x: (projected.x * 0.5 + 0.5) * this.width,
          y: (-projected.y * 0.5 + 0.5) * this.height,
          visible:
            !behind &&
            projected.x >= -1.05 &&
            projected.x <= 1.05 &&
            projected.y >= -1.05 &&
            projected.y <= 1.05,
        };
      },

      systemsInView: () =>
        this.charted.map((s) => ({
          id: s.id,
          name: s.name,
          position: s.position,
          temperature: s.temperature,
          luminosity: s.luminosity,
        })),
    };
  }

  private camera: PerspectiveCamera | null = null;
  private width = 1920;
  private height = 1080;

  private toggle(): void {
    this.open = !this.open;

    // Flight holds the pointer captured so mouse motion steers; while it is
    // captured the cursor does not exist and nothing in the chart's DOM can be
    // clicked. Release it when the chart opens. Re-capture is left to the
    // player's next click on the canvas, which is the same gesture that starts
    // flight in the first place.
    if (this.open && document.pointerLockElement) document.exitPointerLock();
    // Reset to the neighbourhood each time it is opened, so a zoomed-out
    // sightseeing session does not leave the next jump unusable.
    if (this.open) this.range = OPEN_RANGE_LY;
    this.view.setGridVisible(this.open);

    bus.emit(this.open ? 'ui:map-opened' : 'ui:map-closed');
    bus.emit('log', {
      text: this.open
        ? 'CHART — GALACTIC · DRAG TO ORBIT · WHEEL TO ZOOM · CLICK A SYSTEM'
        : 'CHART STOWED',
      tone: 'normal',
    });
  }

  /**
   * Execute a jump. The warp sequence runs first and the destination is only
   * generated on arrival, so the tunnel covers the cost of building a system
   * and the player never waits on a loading state.
   */
  private async jump(systemId: string, name: string, ctx: EngineContext): Promise<void> {
    const stub = this.charted.find((s) => s.id === systemId);
    if (!stub) {
      bus.emit('log', { text: `NO CHART FIX ON ${name.toUpperCase()}`, tone: 'warn' });
      return;
    }
    if (this.open) this.toggle();

    try {
      await this.warp.engage({ name: stub.name, positionLy: stub.position });
    } catch {
      // A cancelled jump is a normal outcome, not an error.
      bus.emit('log', { text: 'JUMP ABORTED', tone: 'warn' });
      return;
    }

    this.universe.enterSystem(generateSystem(this.universe.galaxy, stub), ctx);
  }

  update(dt: number, ctx: EngineContext): void {
    this.camera = ctx.camera;
    this.width = ctx.width;
    this.height = ctx.height;

    // MapMode owns the StarMap rather than registering it with the engine, so
    // it also has to drive it. Skipping this leaves the chart's panels in the
    // DOM at zero opacity forever: the open transition is advanced by update(),
    // and a module that is never updated never finishes opening.
    this.ui.update(dt, ctx);

    if (shotOwnsScene()) {
      // Chart shots position the camera themselves; the module stands down but
      // leaves the view visible so those shots have something to frame.
      this.view.object3d.visible = true;
      this.viewState.set(
        ctx.camera.position,
        this.sunDir,
        this.sunColor,
        ctx.elapsed,
        (ctx.camera.fov * Math.PI) / 180,
        ctx.height,
      );
      this.view.update(dt, ctx, this.viewState);
      return;
    }

    const goal = this.open ? 1 : 0;
    this.blend += (goal - this.blend) * Math.min(1, dt / TRANSITION);
    if (Math.abs(goal - this.blend) < 0.002) this.blend = goal;

    const showing = this.blend > 0.002;
    this.view.object3d.visible = showing;
    this.universe.paused = this.blend > 0.5;

    if (!showing) return;

    // Orbit the chart by dragging. Input only reports motion while the pointer
    // is locked, which it deliberately is not here, so the chart reads the
    // drag itself.
    if (this.open) {
      this.azimuth += this.dragDX * 0.004;
      this.elevation = clamp(this.elevation - this.dragDY * 0.004, -1.4, 1.4);
      this.dragDX = 0;
      this.dragDY = 0;
      if (ctx.input.wheelDelta !== 0) {
        this.range *= 1 + ctx.input.wheelDelta * 0.12;
        this.wheelConsumed(ctx);
      }
      // From a few systems across up to the whole disc. The old floor was
      // 0.04 of the galaxy radius — about 2000 ly — which never reached the
      // neighbourhood the chart is actually about.
      this.range = clamp(this.range, 12, this.universe.galaxy.radiusLy * 2.5);
    }

    const cosE = Math.cos(this.elevation);
    this.camPos.set(
      this.target.x + Math.cos(this.azimuth) * cosE * this.range,
      this.target.y + Math.sin(this.elevation) * this.range,
      this.target.z + Math.sin(this.azimuth) * cosE * this.range,
    );

    // Ease the real camera towards the chart pose so opening the map feels like
    // pulling back rather than cutting to another scene.
    if (this.blend >= 1) {
      ctx.camera.position.copy(this.camPos);
      ctx.camera.lookAt(this.target);
    } else {
      this.savedCamPos.copy(ctx.camera.position);
      ctx.camera.position.lerpVectors(this.savedCamPos, this.camPos, this.blend);
      this.scratch.lerpVectors(this.savedCamPos, this.target, this.blend);
      ctx.camera.lookAt(this.scratch);
    }

    // Zoomed to the neighbourhood the camera is INSIDE the disc, where the
    // unresolved-starlight and dust layers — authored for a whole-galaxy view —
    // fill the frame with warm haze and bury the very stars you are choosing
    // between. Fade them out as the range closes; discrete stars take over.
    const zoom = clamp(this.range / (this.universe.galaxy.radiusLy * 0.6), 0, 1);
    this.view.setVolumeExposure(zoom * zoom);
    this.view.setDustDensity(zoom);
    this.view.setStarExposure(1 + (1 - zoom) * 1.4);

    this.viewState.set(
      this.scratch.copy(ctx.camera.position).sub(this.target),
      this.sunDir,
      this.sunColor,
      ctx.elapsed,
      (ctx.camera.fov * Math.PI) / 180,
      ctx.height,
    );
    this.view.update(dt, ctx, this.viewState);
  }

  /** Input.wheelDelta is cleared by Input.update; consume it explicitly here. */
  private wheelConsumed(ctx: EngineContext): void {
    (ctx.input as { wheelDelta: number }).wheelDelta = 0;
  }

  resize(width: number, height: number): void {
    this.ui.resize?.(width, height);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.view.object3d.removeFromParent();
    this.view.dispose();
    this.ui.dispose?.();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
