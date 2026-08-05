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

/** How far the chart camera sits from its target, as a multiple of disc radius. */
const MAP_RANGE = 1.9;
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
    this.range = this.universe.galaxy.radiusLy * MAP_RANGE;
  }

  init(ctx: EngineContext): void {
    ctx.scene.add(this.view.object3d);
    void this.ui.init?.(ctx);

    this.rechart();
    registerGalaxyViewShots(() => this.view);
    registerStarMapShots(this.ui);

    this.disposers.push(
      bus.on('ui:toggle-map', () => this.toggle()),
      bus.on('nav:jump-requested', (req) => void this.jump(req.systemId, req.name, ctx)),
      bus.on('system:entered', () => this.rechart()),
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
    this.charted = sampleSystemsNear(this.universe.galaxy, this.universe.system.position, 140, 220);
    this.view.setLocalSystems(this.charted);
    this.target.set(
      this.universe.system.position[0],
      this.universe.system.position[1],
      this.universe.system.position[2],
    );
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
    bus.emit(this.open ? 'ui:map-opened' : 'ui:map-closed');
    bus.emit('log', {
      text: this.open ? 'CHART — GALACTIC' : 'CHART STOWED',
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

    // Orbit the chart with the pointer while it is open.
    if (this.open) {
      this.azimuth += ctx.input.pointerDX * 0.004;
      this.elevation = clamp(this.elevation - ctx.input.pointerDY * 0.004, -1.4, 1.4);
      if (ctx.input.wheelDelta !== 0) {
        this.range *= 1 + ctx.input.wheelDelta * 0.12;
        this.wheelConsumed(ctx);
      }
      this.range = clamp(
        this.range,
        this.universe.galaxy.radiusLy * 0.04,
        this.universe.galaxy.radiusLy * 4,
      );
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
