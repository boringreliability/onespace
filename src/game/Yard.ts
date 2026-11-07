/**
 * The Yard — a shipyard registry you can walk round.
 *
 * In the fiction it is a register of hulls, not an asset viewer
 * (docs/v2/SHOWROOM.md §2): pick a builder, a job, a size and a hull number,
 * and the yard rolls that ship out under its lights. It is built on the same
 * Stage the review shots use — isolation, cache, camera solver, lighting —
 * and adds the three things the review harness never needed: an owner of the
 * state, input, and a way in and out.
 *
 * ---------------------------------------------------------------------------
 * WAY IN, WAY OUT
 *
 * `?mode=yard` boots straight here (main.ts); `Y` from flight comes here; Esc
 * goes back to wherever it came from. Leaving flight takes a FlightSnapshot
 * (camera pose, up, lens, fixed step) and the gating table in `gating.ts`
 * stops every flight module, so flight is frozen, not merely hidden, and
 * comes back exactly as it was left.
 *
 * Every cut goes through black: the panel's veil fades up, the change happens
 * behind it, the veil fades away. That is what hides a hull swap — generation
 * and mesh assembly are 30-100 ms of main thread — and it is why nothing on
 * screen ever snaps (ARCHITECTURE §6).
 *
 * ---------------------------------------------------------------------------
 * INPUT IS OURS WHILE WE ARE HERE
 *
 * `core/Input.ts` belongs to flight and to another track, and it does three
 * things that are wrong in the Yard: a click on the canvas requests pointer
 * lock, the wheel and W/S move the flight throttle, and every key is
 * recorded. So while the Yard is up it listens in the CAPTURE phase on
 * `window` — ahead of Input's own listeners — and stops the click, the wheel
 * and the key presses from reaching it. Key-ups are let through, so a key
 * held across the cut is not left stuck down in flight.
 */

import {
  Color,
  Group,
  Mesh,
  PerspectiveCamera,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { modes, type BaseMode, type Mode } from '@/core/Modes';
import { parseRoute, serializeRoute } from '@/core/Route';
import { tryFactionById } from '@/gen/ships/families';

import { FlightSnapshot, restoresFlightTo, snapshotsFlightFrom, type FlightClock } from './FlightSnapshot';
import { mayEnterYard, yardOwnsInput, type EntryContext } from './entryGuards';
import type { Showroom, ShowroomSetup, Triple } from './showroom/Stage';
import { placeCamera, swingToFace, type CameraSpec } from './showroom/camera';
import {
  DRIVE_PRESETS,
  DRIVE_PRESET_IDS,
  LIGHT_PRESETS,
  LIGHT_PRESET_IDS,
  VIEW_PRESETS,
  VIEW_PRESET_IDS,
  type DrivePresetId,
  type LightPreset,
  type LightPresetId,
} from './showroom/presets';
import {
  FACTION_IDS,
  legalize,
  selectionFromRoute,
  stepRole,
  stepSeed,
  stepSize,
  toRouteShip,
  toShipParams,
  withYardRoute,
  type YardSelection,
} from './showroom/catalog';
import { shipRegistry, shipSpecs, type ShipRegistryHeader, type SpecLine } from './showroom/specs';
import { OrbitController, type Vec3Out } from './showroom/orbit';
import { YardPanel, type YardAction, type YardBackdrop, type YardView } from '@/ui/YardPanel';

/** Seconds of the veil fading UP before a swap. Short: it is a blink. */
const FADE_OUT_S = 0.16;
/** Seconds of the veil fading AWAY after a swap. Longer: the hull rolls out. */
const FADE_IN_S = 0.42;
/** Frames held at black after a swap, so the new hull's buffers upload behind it. */
const SETTLE_FRAMES = 2;
/** Seconds for a light preset to cross-fade. */
const LIGHT_TWEEN_S = 0.6;
/** The yard's default lens when nothing else has chosen one. */
const DEFAULT_FILL = 0.8;
/**
 * CSS pixels each side margin of the panel takes. The fit is solved for the
 * clear zone between them, not the whole frame: a hull fitted edge to edge
 * puts its bow under the spec readout and its plume under the controls.
 */
const PANEL_MARGIN_PX = 250;
/**
 * The scale toggle frames the reference props, as `ship-docking-scale` does
 * (minus its roll and offsets): a 1.8 m figure framed with the whole hull is
 * nine pixels tall and proves nothing.
 */
const SCALE_VIEW: CameraSpec = { dir: [-0.88, 0.2, 0.43], fovDeg: 30, fill: 0.72, aimAt: 'scale' };

export interface YardOptions {
  readonly stage: Showroom;
  readonly panel: YardPanel;
  /** The engine's fixed-step clock, handed back to real time on exit. */
  readonly clock: FlightClock;
  /** Quieten the drive while the player stands in the yard. */
  readonly audio?: { setEngine(throttle: number, boost: number): void };
  /** A jump or a recovery cut is running: the Yard does not open mid-sequence. */
  readonly busy?: () => boolean;
}

type Phase = 'idle' | 'out' | 'settle' | 'in' | 'leaving';

export class Yard implements GameModule {
  readonly name = 'yard';
  readonly activeIn: readonly Mode[] = ['yard'];

  /** Set by the registry once PostFX exists: snaps the iris at a scene cut. */
  iris: { resetExposure(): void } | null = null;

  private readonly stage: Showroom;
  private readonly panel: YardPanel;
  private readonly clock: FlightClock;
  private readonly audio: YardOptions['audio'];
  private readonly busy: () => boolean;

  private readonly snapshot = new FlightSnapshot();
  private readonly orbit = new OrbitController();
  private readonly backdrop = new Anchorage();

  private canvas: HTMLCanvasElement | null = null;
  private inside = false;
  private entering = false;
  private chartOpen = false;
  private cameFrom: BaseMode = 'flight';

  // -- what the player asked for --------------------------------------------
  private sel: YardSelection;
  private light: LightPresetId = 'raking';
  private drive: DrivePresetId = 'cruise';
  private view: YardView = 'three-quarter';
  private silhouette = false;
  private scale = false;
  private backdropMode: YardBackdrop = 'void';
  private stale = false;

  // -- what is on stage -----------------------------------------------------
  private onStage: string | null = null;
  private header: ShipRegistryHeader | null = null;
  private specs: readonly SpecLine[] = [];
  private shipRadius = 0.05;

  // -- transitions ----------------------------------------------------------
  private phase: Phase = 'idle';
  private phaseAt = 0;
  private settleFrames = 0;
  private panelDirty = true;
  private readonly actions: YardAction[] = [];
  private fitRequested = false;
  private exitQueued = false;
  /** Frame the scale reference at the next swap instead of the view. */
  private scaleFramePending = false;

  /** Light cross-fade: from → to over LIGHT_TWEEN_S. `cur` is what is applied. */
  private readonly lightFrom = mutableLight(LIGHT_PRESETS.raking);
  private readonly lightCur = mutableLight(LIGHT_PRESETS.raking);
  private lightTo: LightPreset = LIGHT_PRESETS.raking;
  private lightT = 1;

  // -- scratch (update allocates nothing) -----------------------------------
  private readonly eye: Vec3Out = { x: 0, y: 0, z: 0 };
  private readonly lookAt = new Vector3();
  private readonly fitDir = new Vector3();
  private readonly fitAuthored = new Vector3();
  private readonly fitAim = new Vector3();
  private readonly fitCorners: Vector3[] = [];
  private readonly fitClear: Vector3[] = [];
  private readonly fitCamera = new PerspectiveCamera(24, 1, 0.0005, 1e12);

  private dragging = false;
  private dragId = -1;
  private readonly disposers: Array<() => void> = [];
  private readonly yardDisposers: Array<() => void> = [];

  constructor(opts: YardOptions) {
    this.stage = opts.stage;
    this.panel = opts.panel;
    this.clock = opts.clock;
    this.audio = opts.audio;
    this.busy = opts.busy ?? (() => false);
    const route = parseRoute(window.location.search);
    this.sel = selectionFromRoute(route.ship);
    this.stale = route.staleGeneration === true;
    for (const w of route.warnings) bus.emit('log', { text: `LINK: ${w.toUpperCase()}`, tone: 'warn' });
  }

  init(ctx: EngineContext): void {
    this.canvas = ctx.renderer.domElement;
    this.panel.build();
    this.panel.onAction = (a) => {
      this.actions.push(a);
    };

    // `Y` from flight. Bubble phase on purpose: the codex and the local chart
    // swallow keys in the capture phase while they are open, and the yard
    // should not open over a document the player is reading.
    const onFlightKey = (e: KeyboardEvent): void => {
      if (e.code !== 'KeyY' || this.entering) return;
      if (!mayEnterYard(this.entryContext(), e)) return;
      this.requestEnter();
    };
    window.addEventListener('keydown', onFlightKey);
    this.disposers.push(
      () => window.removeEventListener('keydown', onFlightKey),
      bus.on('ui:chart', ({ chart }) => {
        this.chartOpen = chart !== null;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Mode lifecycle
  // -------------------------------------------------------------------------

  onModeChange(from: Mode, _to: Mode, ctx: EngineContext): void {
    // Decided on the BASE mode: a photo overlay on top of the yard is still
    // the yard, and must not tear the stage down underneath itself.
    if (modes.base === 'yard' && !this.inside) this.enter(from, ctx);
    else if (modes.base !== 'yard' && this.inside) this.leave(modes.base, ctx);
  }

  private entryContext(): EntryContext {
    return { base: modes.base, overlay: modes.overlay, menuOpen: this.chartOpen, busy: this.busy() };
  }

  /** Fade to black over flight, then cut to the yard behind it. */
  private requestEnter(): void {
    this.entering = true;
    this.panel.setVeil(1, FADE_OUT_S);
    window.setTimeout(() => {
      this.entering = false;
      // Re-asked: a chart, a photo or a jump may have started during the fade.
      if (mayEnterYard(this.entryContext()) && modes.can('yard')) modes.go('yard');
      else this.panel.setVeil(0, FADE_IN_S);
    }, FADE_OUT_S * 1000 + 30);
  }

  private enter(from: Mode, ctx: EngineContext): void {
    this.inside = true;
    // Back to where we came from on Esc. Boot has nowhere to go back to, and a
    // review shot cleared back into the yard keeps the original answer.
    if (from === 'flight' || from === 'title') this.cameFrom = from;
    else if (from === 'boot') this.cameFrom = 'flight';
    if (snapshotsFlightFrom(from)) {
      this.snapshot.capture(ctx.camera, {
        exposureBias: 1,
        pointerLocked: document.pointerLockElement === this.canvas,
      });
    }
    if (document.pointerLockElement) document.exitPointerLock();
    this.audio?.setEngine(0, 0);
    this.listen();

    this.stage.enter(ctx);
    this.stage.root.add(this.backdrop.root);
    this.panel.setVeil(1, 0);
    this.lightT = 1;
    copyLight(this.lightCur, LIGHT_PRESETS[this.light]);
    this.swap(ctx, true);
    this.writeUrl(this.sel);
    this.phase = 'settle';
    this.settleFrames = SETTLE_FRAMES;
    this.panel.show(true);
    this.panelDirty = true;
    this.iris?.resetExposure();
  }

  private leave(to: BaseMode, ctx: EngineContext): void {
    this.inside = false;
    this.unlisten();
    this.panel.show(false);
    this.stage.root.remove(this.backdrop.root);
    this.stage.exit();
    this.phase = 'idle';
    this.actions.length = 0;
    this.onStage = null;
    // Only flight is restored. A review shot taking the scene from the yard
    // keeps the snapshot for when the shot hands the yard back and Esc leaves.
    if (restoresFlightTo(to)) this.snapshot.restore(ctx.camera, this.clock);
    else if (to !== 'review') this.clock.resumeRealtime();
    this.iris?.resetExposure();
    this.writeUrl(null);
    this.panel.setVeil(0, to === 'review' ? 0 : FADE_IN_S);
  }

  private requestExit(): void {
    if (this.phase === 'leaving') return;
    this.phase = 'leaving';
    this.phaseAt = performance.now();
    this.panel.setVeil(1, FADE_OUT_S);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, ctx: EngineContext): void {
    // Under a photo overlay the Yard is frozen, wall-clock phases included:
    // a hull swap must not happen behind a frame being composed.
    if (!this.inside || modes.overlay !== null) return;
    this.drainActions();

    const now = performance.now();
    switch (this.phase) {
      case 'out':
        // Wall-clock, because the veil's CSS transition is wall-clock.
        if (now - this.phaseAt >= FADE_OUT_S * 1000) {
          this.swap(ctx, false);
          this.phase = 'settle';
          this.settleFrames = SETTLE_FRAMES;
        }
        break;
      case 'settle':
        if (--this.settleFrames <= 0) {
          this.panel.setVeil(0, FADE_IN_S);
          this.phase = 'in';
          this.phaseAt = now;
        }
        break;
      case 'in':
        if (now - this.phaseAt >= FADE_IN_S * 1000) this.phase = 'idle';
        break;
      case 'leaving':
        if (now - this.phaseAt >= FADE_OUT_S * 1000 && !this.exitQueued) {
          // Not from inside this update. A mode change mid-frame hands the
          // scene back to flight while this frame's tick still runs as the
          // yard — flight is drawn once without its modules having updated,
          // and on exactly that frame the driver reported "GL_INVALID_OPERATION:
          // feedback loop between framebuffer and active texture" (measured;
          // gone with this change). Queued as a microtask, the change lands
          // after this frame's render and before the next frame's tick.
          this.exitQueued = true;
          const back = modes.can(this.cameFrom) ? this.cameFrom : 'flight';
          queueMicrotask(() => {
            this.exitQueued = false;
            if (modes.base === 'yard' && modes.can(back)) modes.go(back);
          });
        }
        break;
      case 'idle':
        break;
    }

    if (this.fitRequested) {
      this.fitRequested = false;
      this.fit(ctx, false);
    }

    this.tweenLight(dt);
    this.placeCamera(dt, ctx);
    this.backdrop.update(this.lightCur, ctx);

    if (this.panelDirty) {
      this.panelDirty = false;
      this.panel.render({
        selection: this.sel,
        factionName: tryFactionById(this.sel.factionId)?.name ?? this.sel.factionId,
        light: this.light,
        drive: this.drive,
        view: this.view,
        silhouette: this.silhouette,
        scale: this.scale,
        backdrop: this.backdropMode,
        header: this.header,
        specs: this.specs,
        stale: this.stale,
      });
    }
  }

  private placeCamera(dt: number, ctx: EngineContext): void {
    const o = this.orbit;
    o.update(dt);
    o.eye(this.eye);
    const cam = ctx.camera;
    cam.position.set(this.eye.x, this.eye.y, this.eye.z);
    cam.up.set(0, 1, 0);
    this.lookAt.set(o.centre[0].value, o.centre[1].value, o.centre[2].value);
    cam.lookAt(this.lookAt);
    if (Math.abs(cam.fov - o.fov.value) > 1e-6) {
      cam.fov = o.fov.value;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private drainActions(): void {
    for (let i = 0; i < this.actions.length; i++) this.apply(this.actions[i]!);
    this.actions.length = 0;
  }

  private apply(a: YardAction): void {
    if (this.phase === 'leaving') return;
    switch (a.kind) {
      case 'faction':
        this.select(legalize({ ...this.sel, factionId: a.id }));
        break;
      case 'role':
        this.select(stepRole(this.sel, a.step));
        break;
      case 'size':
        this.select(stepSize(this.sel, a.step));
        break;
      case 'seed':
        this.select(stepSeed(this.sel, a.step));
        break;
      case 'light':
        if (a.id !== this.light) {
          this.light = a.id;
          copyLight(this.lightFrom, this.lightCur);
          this.lightTo = LIGHT_PRESETS[a.id];
          this.lightT = 0;
        }
        break;
      case 'drive':
        this.drive = a.id;
        // The visual damps its own throttle and plume towards this.
        this.stage.setDrive(DRIVE_PRESETS[a.id]);
        break;
      case 'view':
        this.view = a.id;
        if (a.id !== 'free') this.fitRequested = true;
        break;
      case 'silhouette':
        this.silhouette = !this.silhouette;
        this.requestSwap();
        break;
      case 'scale':
        this.scale = !this.scale;
        // On: look at the ruler. Off: back to the whole hull.
        this.view = this.scale ? 'free' : 'three-quarter';
        this.scaleFramePending = this.scale;
        this.requestSwap();
        break;
      case 'backdrop':
        if (a.id !== this.backdropMode) {
          this.backdropMode = a.id;
          this.requestSwap();
        }
        break;
      case 'link':
        this.copyLink();
        break;
      case 'exit':
        this.requestExit();
        break;
    }
    this.panelDirty = true;
  }

  private select(next: YardSelection): void {
    this.sel = next;
    // A ship chosen in the yard is, by definition, of this generation.
    this.stale = false;
    this.writeUrl(next);
    this.requestSwap();
  }

  /**
   * Ask for the stage to be rebuilt behind the veil. Coalesces: holding → for
   * ten hulls fades out once, builds only the hull the player stopped on, and
   * fades in once.
   */
  private requestSwap(): void {
    if (this.phase === 'out' || this.phase === 'leaving') return;
    this.phase = 'out';
    this.phaseAt = performance.now();
    this.panel.setVeil(1, FADE_OUT_S);
  }

  /** Build (or reuse) the selected hull and frame it. Only ever behind black. */
  private swap(ctx: EngineContext, initial: boolean): void {
    const setup: ShowroomSetup = {
      ships: [toShipParams(this.sel)],
      drive: DRIVE_PRESETS[this.drive],
      silhouette: this.silhouette,
      scaleReference: this.scale,
      sunDirection: this.lightCur.sunDirection,
      sunColor: this.lightCur.sunColor,
      sunIntensity: this.lightCur.sunIntensity,
      fillColor: this.lightCur.fillColor,
      fillDirection: this.lightCur.fillDirection,
    };
    this.stage.configure(ctx, setup);
    const s = this.stage.subject(0);
    if (!s) return;
    const bp = s.blueprint;
    this.onStage = bp.id;
    this.header = shipRegistry(bp);
    this.specs = shipSpecs(bp);
    this.shipRadius = bp.dimensions.boundingRadius;
    // Close enough for a hatch, far enough to see the whole fleet's biggest.
    this.orbit.setLimits(Math.max(0.0015, this.shipRadius * 0.06), this.shipRadius * 14);
    if (initial) this.orbit.fov.snap(VIEW_PRESETS['three-quarter'].fovDeg);
    this.fit(ctx, true);
    this.backdrop.setVisible(this.backdropMode === 'anchorage');
    this.backdrop.place(this.fitDir, this.shipRadius);
    this.panelDirty = true;
  }

  /**
   * Frame the hull with the review camera solver and hand the result to the
   * orbit. `immediate` only behind the veil; otherwise the orbit glides there.
   */
  private fit(ctx: EngineContext, immediate: boolean): void {
    const scaleShot = this.scaleFramePending && this.scale;
    this.scaleFramePending = false;
    const preset = scaleShot ? SCALE_VIEW : this.view === 'free' ? null : VIEW_PRESETS[this.view];
    const spec: CameraSpec = preset ?? {
      dir: [0, 0, 1],
      fovDeg: this.orbit.fov.target,
      fill: DEFAULT_FILL,
      aimAt: 'hull',
    };
    if (preset) this.fitAuthored.set(preset.dir[0], preset.dir[1], preset.dir[2]).normalize();
    else this.orbit.direction(this.fitAuthored);
    this.fitDir.copy(this.fitAuthored);

    const aimAt = spec.aimAt ?? 'hull';
    let radius = this.stage.aim(aimAt, this.fitAim, this.fitDir);
    // The detail view's one iteration of "look at the cluster from its own
    // side", exactly as `registerShowroomShots` does for ship-greeble-close.
    const face = spec.faceAim ?? 0;
    if (face > 0 && swingToFace(this.fitDir, this.stage.aimNormal, face)) {
      radius = this.stage.aim(aimAt, this.fitAim, this.fitDir);
      this.fitDir.copy(this.fitAuthored);
      swingToFace(this.fitDir, this.stage.aimNormal, face);
    }
    const corners = this.stage.aimCorners(aimAt, this.fitCorners);
    const clear = corners >= 2 ? this.stage.clearanceCorners(this.fitClear) : 0;

    // Solved on a scratch camera, because the solver writes the camera it is
    // given and the real one belongs to the orbit — and with the aspect of the
    // clear zone between the panel margins rather than the whole frame.
    const clearW = ctx.width > PANEL_MARGIN_PX * 4 ? ctx.width - PANEL_MARGIN_PX * 2 : ctx.width;
    this.fitCamera.aspect = Math.max(clearW, 1) / Math.max(ctx.height, 1);
    placeCamera(
      { ...ctx, camera: this.fitCamera },
      spec,
      this.fitDir,
      radius,
      this.fitAim,
      this.fitCorners,
      corners,
      this.fitClear,
      clear,
    );
    // `placeCamera` recentres `fitAim` on the projected box; with no offsets
    // the camera looks straight at it, so the orbit centre is that point.
    const distance = this.fitCamera.position.distanceTo(this.fitAim);
    const o = this.orbit;
    o.lookFrom(this.fitDir.x, this.fitDir.y, this.fitDir.z, immediate);
    if (immediate) {
      o.distance.snap(distance);
      o.fov.snap(spec.fovDeg);
      o.centre[0].snap(this.fitAim.x);
      o.centre[1].snap(this.fitAim.y);
      o.centre[2].snap(this.fitAim.z);
    } else {
      o.distance.target = distance;
      o.fov.target = spec.fovDeg;
      o.centre[0].target = this.fitAim.x;
      o.centre[1].target = this.fitAim.y;
      o.centre[2].target = this.fitAim.z;
    }
  }

  private tweenLight(dt: number): void {
    if (this.lightT >= 1) return;
    this.lightT = Math.min(1, this.lightT + dt / LIGHT_TWEEN_S);
    const t = this.lightT;
    const k = t * t * (3 - 2 * t);
    lerpLight(this.lightCur, this.lightFrom, this.lightTo, k);
    this.stage.setLight(this.lightCur);
  }

  // -------------------------------------------------------------------------
  // URL and link
  // -------------------------------------------------------------------------

  private writeUrl(sel: YardSelection | null): void {
    const search = withYardRoute(window.location.search, sel);
    if (search === window.location.search) return;
    try {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
    } catch {
      /* sandboxed frames may refuse; the link button still works */
    }
  }

  private copyLink(): void {
    const url = `${window.location.origin}${window.location.pathname}${serializeRoute({
      mode: 'yard',
      ship: toRouteShip(this.sel),
      warnings: [],
    })}`;
    const clip = navigator.clipboard;
    if (!clip) {
      this.panel.flashLink('in url bar');
      return;
    }
    clip.writeText(url).then(
      () => this.panel.flashLink('copied'),
      () => this.panel.flashLink('in url bar'),
    );
  }

  // -------------------------------------------------------------------------
  // Input — our own listeners, only while inside
  // -------------------------------------------------------------------------

  private listen(): void {
    const canvas = this.canvas;
    if (!canvas) return;

    const onKey = (e: KeyboardEvent): void => {
      // Photo on top owns the keyboard. stopPropagation() in its handler does
      // not stop this one (same target), so the Yard has to stand down itself:
      // Esc used to leave the photo AND the Yard, ← / → swapped the hull.
      if (!yardOwnsInput(modes)) return;
      // Browser and OS shortcuts are not ours to eat.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      let handled = true;
      switch (e.code) {
        case 'ArrowLeft':
          this.actions.push({ kind: 'seed', step: -1 });
          break;
        case 'ArrowRight':
          this.actions.push({ kind: 'seed', step: 1 });
          break;
        case 'ArrowUp':
          this.actions.push({ kind: 'role', step: -1 });
          break;
        case 'ArrowDown':
          this.actions.push({ kind: 'role', step: 1 });
          break;
        case 'KeyF':
          if (!e.repeat) this.fitRequested = true;
          break;
        case 'Escape':
          if (!e.repeat) this.actions.push({ kind: 'exit' });
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
      // Every key stops here, handled or not: Input must not see W/S (the
      // flight throttle) or anything else while flight is frozen.
      e.stopPropagation();
    };
    const onClick = (e: MouseEvent): void => {
      // Input requests pointer lock on a canvas click. Not here (nor in photo).
      if (e.target === canvas) e.stopPropagation();
    };
    const onWheel = (e: WheelEvent): void => {
      // Photo's wheel is its lens; let it through to Photo's listener.
      if (!yardOwnsInput(modes)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY !== 0) this.orbit.zoom(Math.sign(e.deltaY));
    };
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0 || !yardOwnsInput(modes)) return;
      this.dragging = true;
      this.dragId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent): void => {
      if (!this.dragging || e.pointerId !== this.dragId) return;
      if (e.movementX === 0 && e.movementY === 0) return;
      this.orbit.drag(e.movementX, e.movementY);
      if (this.view !== 'free') {
        this.view = 'free';
        this.panelDirty = true;
      }
    };
    const onUp = (e: PointerEvent): void => {
      if (e.pointerId !== this.dragId) return;
      this.dragging = false;
      this.dragId = -1;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    const onLock = (): void => {
      // Belt and braces: nothing should lock the pointer in the yard.
      if (document.pointerLockElement) document.exitPointerLock();
    };

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    document.addEventListener('pointerlockchange', onLock);
    canvas.style.cursor = 'grab';
    this.yardDisposers.push(
      () => window.removeEventListener('keydown', onKey, true),
      () => window.removeEventListener('click', onClick, true),
      () => window.removeEventListener('wheel', onWheel, { capture: true }),
      () => canvas.removeEventListener('pointerdown', onDown),
      () => canvas.removeEventListener('pointermove', onMove),
      () => canvas.removeEventListener('pointerup', onUp),
      () => canvas.removeEventListener('pointercancel', onUp),
      () => document.removeEventListener('pointerlockchange', onLock),
      () => {
        canvas.style.cursor = '';
      },
    );
  }

  private unlisten(): void {
    for (const d of this.yardDisposers) d();
    this.yardDisposers.length = 0;
    this.dragging = false;
    this.dragId = -1;
  }

  dispose(): void {
    this.unlisten();
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.backdrop.dispose();
    this.panel.dispose();
  }
}

// ===========================================================================
// Light presets as mutable scratch, so a cross-fade allocates nothing
// ===========================================================================

interface MutableLight {
  sunDirection: [number, number, number];
  sunColor: [number, number, number];
  sunIntensity: number;
  fillColor: [number, number, number];
  fillDirection: [number, number, number];
}

function mutableLight(p: LightPreset): MutableLight {
  const l: MutableLight = {
    sunDirection: [0, 0, 0],
    sunColor: [0, 0, 0],
    sunIntensity: 0,
    fillColor: [0, 0, 0],
    fillDirection: [0, 0, 0],
  };
  copyLight(l, p);
  return l;
}

function copy3(out: [number, number, number], v: Triple): void {
  out[0] = v[0];
  out[1] = v[1];
  out[2] = v[2];
}

function copyLight(out: MutableLight, p: LightPreset): void {
  copy3(out.sunDirection, p.sunDirection);
  copy3(out.sunColor, p.sunColor);
  out.sunIntensity = p.sunIntensity;
  copy3(out.fillColor, p.fillColor);
  copy3(out.fillDirection, p.fillDirection);
}

function lerp3(out: [number, number, number], a: Triple, b: Triple, k: number): void {
  out[0] = a[0] + (b[0] - a[0]) * k;
  out[1] = a[1] + (b[1] - a[1]) * k;
  out[2] = a[2] + (b[2] - a[2]) * k;
}

/**
 * Directions are lerped and left for `Stage.setLight` to normalise. Two of
 * the presets are nearly opposite keys (raking vs rim), so the midpoint passes
 * close to zero length — the light swings THROUGH the hull rather than round
 * it, which reads as the key dimming and re-rising on the other side. That is
 * the honest picture of a cross-fade between two lights, so it is kept.
 */
function lerpLight(out: MutableLight, a: LightPreset, b: LightPreset, k: number): void {
  lerp3(out.sunDirection, a.sunDirection, b.sunDirection, k);
  lerp3(out.sunColor, a.sunColor, b.sunColor, k);
  out.sunIntensity = a.sunIntensity + (b.sunIntensity - a.sunIntensity) * k;
  lerp3(out.fillColor, a.fillColor, b.fillColor, k);
  lerp3(out.fillDirection, a.fillDirection, b.fillDirection, k);
  // A zero direction normalises to NaN; nudge the degenerate midpoint.
  const d = out.sunDirection;
  if (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] < 1e-6) d[1] += 1e-3;
}

// ===========================================================================
// The anchorage backdrop
// ===========================================================================

/**
 * A distant gas giant behind the hull, as a SHAPE: ARCHITECTURE §6 wants
 * something always occluding and never an empty black frame, and a void
 * backdrop is exactly that failure for anyone who is not reviewing. Lit by
 * the stage's own key, so a rim-light preset gives a crescent and the raking
 * key a gibbous world; near-black albedo, steel-blue bands, dithered, so it
 * sits behind the hull without ever being brighter than it.
 *
 * World-fixed once placed (it is far enough that orbiting the hull shows
 * honest parallax), and placed below and to the left of the opening view so
 * its limb crosses the lower third rather than sitting dead behind the ship.
 */
class Anchorage {
  readonly root = new Group();
  private readonly geometry = new SphereGeometry(1, 96, 64);
  private readonly material: ShaderMaterial;
  private readonly mesh: Mesh;
  private readonly scratch = new Vector3();
  private readonly side = new Vector3();
  private readonly worldUp = new Vector3(0, 1, 0);

  constructor() {
    this.root.name = 'yard-anchorage';
    this.material = new ShaderMaterial({
      vertexShader: ANCHORAGE_VERT,
      fragmentShader: ANCHORAGE_FRAG,
      uniforms: {
        uSunDir: { value: new Vector3(0, 1, 0) },
        uKey: { value: new Color(1, 1, 1) },
        uCamPos: { value: new Vector3() },
      },
      toneMapped: false,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);
    this.root.visible = false;
  }

  setVisible(on: boolean): void {
    this.root.visible = on;
  }

  /**
   * `viewDir` points from the hull to the camera. The world sits behind the
   * hull from there, 32° below and 14° left of the line of sight, at forty
   * hull radii, sized to subtend about 26° — big enough to own the lower
   * third of a 24° lens, far enough to read as distant.
   */
  place(viewDir: Vector3, shipRadius: number): void {
    const away = this.scratch.copy(viewDir).multiplyScalar(-1).normalize();
    this.side.crossVectors(this.worldUp, away);
    if (this.side.lengthSq() < 1e-9) this.side.set(1, 0, 0);
    this.side.normalize();
    const down = Math.tan((32 * Math.PI) / 180);
    const left = Math.tan((14 * Math.PI) / 180);
    away.addScaledVector(this.worldUp, -down).addScaledVector(this.side, left).normalize();
    const distance = shipRadius * 40;
    this.mesh.position.copy(away).multiplyScalar(distance);
    this.mesh.scale.setScalar(distance * Math.sin((26 * Math.PI) / 180));
    this.mesh.updateMatrixWorld();
  }

  update(light: MutableLight, ctx: EngineContext): void {
    if (!this.root.visible) return;
    const u = this.material.uniforms;
    const d = light.sunDirection;
    (u.uSunDir!.value as Vector3).set(d[0], d[1], d[2]).normalize();
    const c = light.sunColor;
    (u.uKey!.value as Color).setRGB(c[0], c[1], c[2]).multiplyScalar(light.sunIntensity);
    (u.uCamPos!.value as Vector3).copy(ctx.camera.position);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

const ANCHORAGE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vLocal;
void main() {
  vLocal = position;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const ANCHORAGE_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <onespace_noise>
#include <onespace_color>
uniform vec3 uSunDir;
uniform vec3 uKey;
uniform vec3 uCamPos;
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vLocal;
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(uCamPos - vPosW);
  float ndl = dot(N, uSunDir);
  float mu = clamp(dot(N, V), 0.0, 1.0);

  // Latitude bands, broken by a slow fbm so they are weather, not stripes.
  float warp = os_fbm(vLocal * 3.1, 4, 2.0, 0.5);
  float band = 0.5 + 0.5 * sin(vLocal.y * 23.0 + warp * 2.6);
  float fine = os_fbm(vLocal * vec3(2.0, 18.0, 2.0) + warp, 3, 2.1, 0.5);
  // Albedo a third of the hull's: the world is a SHAPE behind the subject,
  // and the auto-exposure meters the whole frame — a bright world would
  // stop the lens down and sink the hull into black.
  vec3 dark = vec3(0.0055, 0.0072, 0.0098);
  vec3 pale = vec3(0.0150, 0.0178, 0.0220);
  vec3 albedo = mix(dark, pale, band * 0.75 + fine * 0.25);
  // The key's luminance, not its colour: a warm star on a warm-banded world
  // turns it cream, and the yard's one accent is already the drive plume.
  float key = dot(uKey, vec3(0.2126, 0.7152, 0.0722));

  // A gas giant's terminator is soft — there is no surface to cut it.
  float lit = smoothstep(-0.08, 0.35, ndl) * max(ndl + 0.08, 0.0);
  // Limb darkening on the lit face; the deep atmosphere eats the edge.
  float limb = 0.3 + 0.7 * pow(mu, 0.45);
  vec3 col = albedo * key * lit * limb;
  // A thin cool haze at the limb on the sunward side only.
  float rim = pow(1.0 - mu, 5.0) * smoothstep(-0.15, 0.45, ndl);
  col += vec3(0.010, 0.015, 0.024) * key * rim;
  // Never absolute black: PostFX meters a near-zero tap as void.
  col += vec3(0.0016, 0.0018, 0.0022);
  gl_FragColor = vec4(os_dither(col, gl_FragCoord.xy), 1.0);
}
`;

/** Exported for the registry's FACTION list in the panel. */
export const YARD_FACTIONS = FACTION_IDS.map((id) => ({ id, label: id }));
export const YARD_VIEWS: readonly YardView[] = ['free', ...VIEW_PRESET_IDS];
export { LIGHT_PRESET_IDS as YARD_LIGHTS, DRIVE_PRESET_IDS as YARD_DRIVES };
