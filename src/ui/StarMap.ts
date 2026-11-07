/**
 * The stellar chart — navigation interface layered over the galaxy view.
 *
 * This module draws no stars. `render/GalaxyView.ts` owns the 3D chart; the
 * StarMap is the *instrument* bolted over it: labels, search, selection, route
 * and the jump confirmation. The two talk through `GalaxyViewAdapter` so that
 * neither knows the other's internals and either can be rebuilt alone.
 *
 * Two ideas carry the feel:
 *
 *  1. Opening is a *transition*, not a toggle. One critically damped scalar
 *     (`openAmount`) drives everything — panel entrances, label fade, and the
 *     recede of the game view behind the glass. Because it is a real spring
 *     with velocity, interrupting an open with a close inherits the motion
 *     instead of snapping.
 *
 *  2. A chart whose labels overlap is not a chart. Every frame the labels are
 *     ranked by importance and greedily placed; the loser of a collision drops
 *     its name and keeps its tick. That single pass is the difference between
 *     an instrument and a mess.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { registerShot } from '@/game/Shots';
import type { SpectralClass, Vec3 } from '@/gen/types';
import { hashSeed, Rng } from '@/math/rng';
import { jumpEstimateSeconds } from '@/ship/warpTimeline';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface GalaxyViewAdapter {
  setHighlight(systemId: string | null): void;
  setCursor(positionLy: readonly [number, number, number] | null): void;
  setRouteLine(points: readonly (readonly [number, number, number])[]): void;
  project(positionLy: readonly [number, number, number]): {
    x: number;
    y: number;
    visible: boolean;
  };
  systemsInView(): Array<{
    id: string;
    name: string;
    position: readonly [number, number, number];
    temperature: number;
    luminosity: number;
  }>;
}

/**
 * Anything the chart wants to display that the adapter does not carry.
 * The adapter deliberately exposes only what the *renderer* already knows;
 * planet counts and survey notes come from the universe state instead.
 * Absent values render as `--` rather than being invented.
 */
export interface SystemDetails {
  readonly planetCount?: number;
  readonly spectralClass?: SpectralClass;
  /** 0..1 — drives the "settled / picked over" annotation. */
  readonly civilisation?: number;
  readonly note?: string;
}

export type SystemDetailsProvider = (systemId: string) => SystemDetails | null;

export interface StarMapOptions {
  /** Defaults to `#ui-root`, then `document.body`. */
  mount?: HTMLElement;
  /** Hard cap on label nodes. Beyond this the chart shows GalaxyView's stars only. */
  maxLabels?: number;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Critically damped spring rate for the open/close transition. A critical
 * damper responds as (1 + wt)e^(-wt), which is 95% settled at wt ≈ 4.74, so
 * w = 9.5 puts the transition at ~0.5 s with zero overshoot.
 */
const OPEN_OMEGA = 9.5;

/** How far the game view falls away behind the glass, and how much it dims. */
const RECEDE_SCALE = 0.955;
const RECEDE_BRIGHT = 0.5;

/** Label geometry, in CSS pixels. Must match the injected CSS. */
const LABEL_OFF_X = 16;
const LABEL_H = 13;
const LABEL_FONT_PX = 10.5;
/**
 * Monospace advance = font-size * 0.6, plus the 0.14em tracking. Estimating
 * rather than measuring keeps the declutter pass free of forced layout — a
 * single getBoundingClientRect() per label per frame would cost more than the
 * whole rest of this module.
 */
const LABEL_CHAR_W = LABEL_FONT_PX * 0.6 + LABEL_FONT_PX * 0.14;
/** Breathing room between accepted labels. Tight enough to keep density up. */
const LABEL_GUTTER = 6;

/**
 * Importance at or above which a label is placed before the star ticks are
 * reserved — i.e. it is allowed to overlap a star rather than be dropped.
 * Selection, hover and the origin clear this bar; nothing else does.
 */
const PRIORITY_LABEL = 2e5;

/** Pointer must come within this many pixels of a star tick to hover it. */
const HOVER_RADIUS = 34;

/** Catalogue re-read interval, seconds. The star list changes slowly. */
const CATALOGUE_INTERVAL = 0.25;

/** Points sent to the 3D route line. Enough for GalaxyView to bow the curve. */
const ROUTE_SEGMENTS = 8;

const EMPTY_ROUTE: ReadonlyArray<readonly [number, number, number]> = [];

// ---------------------------------------------------------------------------
// Internal per-star record. Allocated once, mutated forever.
// ---------------------------------------------------------------------------

interface MapEntry {
  id: string;
  name: string;
  /** Galaxy-local light years. Reused as the argument to adapter.project(). */
  readonly pos: [number, number, number];
  temperature: number;
  luminosity: number;
  distanceLy: number;
  /** Screen space, after the recede transform. */
  sx: number;
  sy: number;
  visible: boolean;
  labelW: number;
  importance: number;
  labelShown: boolean;
  matches: boolean;
  /** Cached DOM node and the last values written to it. */
  node: HTMLDivElement | null;
  nameEl: HTMLDivElement | null;
  lastX: number;
  lastY: number;
  rebind: boolean;
}

function makeEntry(): MapEntry {
  return {
    id: '',
    name: '',
    pos: [0, 0, 0],
    temperature: 5772,
    luminosity: 1,
    distanceLy: 0,
    sx: 0,
    sy: 0,
    visible: false,
    labelW: 0,
    importance: 0,
    labelShown: false,
    matches: true,
    node: null,
    nameEl: null,
    lastX: -9999,
    lastY: -9999,
    rebind: true,
  };
}

// ---------------------------------------------------------------------------
// StarMap
// ---------------------------------------------------------------------------

export class StarMap implements GameModule {
  readonly name = 'star-map';

  private adapter: GalaxyViewAdapter | null;
  private details: SystemDetailsProvider | null = null;
  private readonly opts: Required<StarMapOptions>;

  // --- transition state ---------------------------------------------------
  private openTarget = false;
  private openAmount = 0;
  private openVel = 0;
  private live = false;
  /** True once the engine is driving update(); the shot falls back if not. */
  private engineDriven = false;

  // --- catalogue ----------------------------------------------------------
  private entries: MapEntry[] = [];
  private count = 0;
  private catalogueTimer = 0;
  private order: number[] = [];
  /** Flat accepted label rects: x0,y0,x1,y1 per label. */
  private accepted: number[] = [];
  private acceptedN = 0;

  // --- selection ----------------------------------------------------------
  private hoverId: string | null = null;
  private selectedId: string | null = null;
  private query = '';
  private matchCount = 0;

  /** Where distances are measured from — the ship's current system. */
  private readonly originPos: [number, number, number] = [0, 0, 0];
  private originId: string | null = null;
  private originLabel = 'CURRENT POSITION';

  // --- pointer ------------------------------------------------------------
  private pointerX = -1e4;
  private pointerY = -1e4;
  private pointerInside = false;

  // --- preallocated route -------------------------------------------------
  private readonly routePoints: Array<[number, number, number]> = [];
  private routeDirty = false;

  // --- range rings --------------------------------------------------------
  /** Scratch vector for ring probing. Never escapes this class. */
  private readonly probe: [number, number, number] = [0, 0, 0];
  private readonly ringRadii: [number, number, number] = [10, 20, 40];
  private lastRingKey = '';
  private originSx = 0;
  private originSy = 0;
  private originVisible = false;
  /** Screen rects the chart's own annotations occupy, fed to the declutter. */
  private readonly ringTagX: number[] = [0, 0, 0];
  private readonly ringTagY: number[] = [0, 0, 0];
  private readonly ringTagW: number[] = [0, 0, 0];
  private routeTagX = 0;
  private routeTagY = 0;
  private routeTagW = 0;
  private routeVisible = false;

  // --- DOM ----------------------------------------------------------------
  private styleEl: HTMLStyleElement | null = null;
  private root: HTMLDivElement | null = null;
  private layer: HTMLDivElement | null = null;
  private svg: SVGSVGElement | null = null;
  private routeGroup: SVGGElement | null = null;
  private ringGroup: SVGGElement | null = null;
  private routeHalo: SVGPathElement | null = null;
  private routeLine: SVGPathElement | null = null;
  private routeCap: SVGRectElement | null = null;
  private routeTag: SVGTextElement | null = null;
  private originNode: HTMLDivElement | null = null;
  private originNameEl: HTMLDivElement | null = null;
  private readonly ringPaths: SVGPathElement[] = [];
  private readonly ringTags: SVGTextElement[] = [];
  private searchInput: HTMLInputElement | null = null;
  private countEl: HTMLDivElement | null = null;
  private infoEl: HTMLDivElement | null = null;
  private infoVals: Record<string, HTMLDivElement> = {};
  private confirmEl: HTMLDivElement | null = null;
  private confirmVals: Record<string, HTMLDivElement> = {};
  private emptyEl: HTMLDivElement | null = null;

  // --- caches so we never write the DOM with a value it already has -------
  private lastInfoKey = '';
  private lastConfirmKey = '';
  private lastRouteKey = '';
  private lastT = -1;
  private width = 1;
  private height = 1;

  private disposers: Array<() => void> = [];

  constructor(adapter: GalaxyViewAdapter | null, options: StarMapOptions = {}) {
    this.adapter = adapter;
    this.opts = {
      mount: options.mount ?? (document.getElementById('ui-root') as HTMLElement) ?? document.body,
      maxLabels: options.maxLabels ?? 160,
    };
    for (let i = 0; i <= ROUTE_SEGMENTS; i++) this.routePoints.push([0, 0, 0]);
  }

  // -------------------------------------------------------------------- API

  setAdapter(adapter: GalaxyViewAdapter | null): void {
    if (this.adapter === adapter) return;
    this.adapter?.setHighlight(null);
    this.adapter?.setCursor(null);
    this.adapter?.setRouteLine(EMPTY_ROUTE);
    this.adapter = adapter;
    this.count = 0;
    this.catalogueTimer = 0;
    for (const e of this.entries) e.rebind = true;
  }

  setDetailsProvider(fn: SystemDetailsProvider | null): void {
    this.details = fn;
    this.lastInfoKey = '';
    this.lastConfirmKey = '';
  }

  /** Tell the chart where the ship is, so distances mean something. */
  setOrigin(positionLy: Vec3, label: string, systemId: string | null = null): void {
    this.originPos[0] = positionLy[0];
    this.originPos[1] = positionLy[1];
    this.originPos[2] = positionLy[2];
    this.originLabel = label.toUpperCase();
    this.originId = systemId;
    this.routeDirty = true;
    this.lastInfoKey = '';
  }

  get isOpen(): boolean {
    return this.openTarget;
  }

  get hasAdapter(): boolean {
    return this.adapter !== null;
  }

  get selection(): string | null {
    return this.selectedId;
  }

  /**
   * The selected system with what a jump needs to know about it, or null.
   * The `J` key reads this, so a jump no longer has to go through Enter here.
   */
  selectedTarget(): { id: string; name: string; distanceLy: number } | null {
    const e = this.selectedId ? this.findEntry(this.selectedId) : null;
    return e ? { id: e.id, name: e.name, distanceLy: e.distanceLy } : null;
  }

  /** The system the chart is measured from — where the ship is. */
  get origin(): string | null {
    return this.originId;
  }

  /** Plot a course to whatever sits nearest the middle of the chart. */
  selectCentremost(): void {
    const e = this.centremost();
    if (e) this.select(e.id);
  }

  /**
   * Force the contact panel onto a system without a pointer. Used by the
   * review shot; also handy for a tutorial pointing at somewhere specific.
   */
  previewContact(id: string | null): void {
    this.setHover(id);
  }

  setOpen(open: boolean): void {
    if (this.openTarget === open) return;
    this.openTarget = open;
    // Hit testing follows intent, not the animation: a chart that is fading
    // out must stop eating clicks the instant you dismiss it.
    this.root?.classList.toggle('is-live', open);
    if (open) {
      // The chart is a pointer instrument; flying with a locked pointer and a
      // hidden cursor makes it unusable.
      if (document.pointerLockElement) document.exitPointerLock();
      this.catalogueTimer = 0;
      bus.emit('ui:map-opened');
      bus.emit('log', { text: 'STELLAR CHART ONLINE', tone: 'normal' });
    } else {
      this.setHover(null);
      bus.emit('ui:map-closed');
    }
  }

  toggle(): void {
    this.setOpen(!this.openTarget);
  }

  /** Plot a course. Passing null clears the route. */
  select(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.routeDirty = true;
    this.lastConfirmKey = '';
    const e = id ? this.findEntry(id) : null;
    bus.emit('nav:route-set', {
      systemId: id,
      name: e ? e.name : null,
      distanceLy: e ? e.distanceLy : 0,
    });
    if (e) bus.emit('log', { text: `COURSE PLOTTED: ${e.name.toUpperCase()}`, tone: 'good' });
  }

  // ------------------------------------------------------------- lifecycle

  init(ctx: EngineContext): void {
    this.width = ctx.width;
    this.height = ctx.height;
    if (this.root) return; // idempotent: the review shot may init us early
    this.injectStyle();
    this.buildDom();
    this.bindEvents();
  }

  update(dt: number, ctx: EngineContext): void {
    this.engineDriven = true;
    this.tick(dt, ctx.width, ctx.height);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.adapter?.setHighlight(null);
    this.adapter?.setCursor(null);
    this.adapter?.setRouteLine(EMPTY_ROUTE);
    this.applyRecede(0);
    document.documentElement.classList.remove('os-map-recede');
    document.documentElement.style.removeProperty('--os-recede');
    document.documentElement.style.removeProperty('--os-recede-dim');
    this.root?.remove();
    this.styleEl?.remove();
    this.root = null;
    this.styleEl = null;
    this.layer = null;
    this.svg = null;
    this.infoVals = {};
    this.confirmVals = {};
    for (const e of this.entries) {
      e.node = null;
      e.nameEl = null;
    }
    this.entries = [];
    this.count = 0;
  }

  // -------------------------------------------------------------- the loop

  /** Split out of update() so the review shot can drive it before wiring. */
  private tick(dt: number, width: number, height: number): void {
    this.width = width;
    this.height = height;

    this.stepOpen(dt);
    const t = this.openAmount;

    if (!this.openTarget && t <= 0.003) {
      if (this.live) this.goDark();
      return;
    }
    if (!this.live) this.goLive();

    this.applyRecede(t);
    if (Math.abs(t - this.lastT) > 0.002) {
      this.root?.style.setProperty('--os-t', t.toFixed(4));
      this.lastT = t;
    }

    this.catalogueTimer -= dt;
    if (this.catalogueTimer <= 0) {
      this.catalogueTimer = CATALOGUE_INTERVAL;
      this.syncCatalogue();
    }

    this.projectAll(t);
    this.resolveHover();
    // Rings and course first: their annotations are part of the chart, so they
    // claim screen space in the same declutter pass the star labels compete in.
    this.updateRings(t);
    this.updateRoute();
    this.rank();
    this.declutter();
    this.writeNodes();
    this.updatePanels();
  }

  /**
   * Critically damped spring, semi-implicit. Chosen over a lerp because the
   * spring carries velocity: reversing mid-transition feels like a heavy panel
   * being pushed back, not a value jumping to a new target.
   */
  private stepOpen(dt: number): void {
    const target = this.openTarget ? 1 : 0;
    const w = OPEN_OMEGA;
    // Clamp: a stalled tab must not blow the integrator up.
    const h = Math.min(dt, 1 / 20);
    const a = -2 * w * this.openVel - w * w * (this.openAmount - target);
    this.openVel += a * h;
    this.openAmount += this.openVel * h;
    if (this.openAmount < 0) {
      this.openAmount = 0;
      if (this.openVel < 0) this.openVel = 0;
    } else if (this.openAmount > 1) {
      this.openAmount = 1;
      if (this.openVel > 0) this.openVel = 0;
    }
  }

  private goLive(): void {
    this.live = true;
    if (this.root) {
      this.root.style.display = 'block';
      this.root.classList.toggle('is-live', this.openTarget);
    }
    document.documentElement.classList.add('os-map-recede');
  }

  private goDark(): void {
    this.live = false;
    this.lastT = -1;
    if (this.root) {
      this.root.style.display = 'none';
      this.root.classList.remove('is-live');
    }
    document.documentElement.classList.remove('os-map-recede');
    document.documentElement.style.removeProperty('--os-recede');
    document.documentElement.style.removeProperty('--os-recede-dim');
    this.adapter?.setCursor(null);
  }

  /**
   * Push the game view back behind the glass. Scaling and dimming the canvas
   * costs nothing (it is a composited layer) and reads as depth; blurring it
   * would be wrong — the labels annotate those exact stars, so they must stay
   * sharp underneath.
   */
  private applyRecede(t: number): void {
    const s = 1 + (RECEDE_SCALE - 1) * t;
    const b = 1 + (RECEDE_BRIGHT - 1) * t;
    const style = document.documentElement.style;
    style.setProperty('--os-recede', s.toFixed(4));
    style.setProperty('--os-recede-dim', b.toFixed(4));
  }

  // ------------------------------------------------------------- catalogue

  private syncCatalogue(): void {
    const src = this.adapter ? this.adapter.systemsInView() : null;
    const n = src ? Math.min(src.length, this.opts.maxLabels) : 0;

    while (this.entries.length < n) this.entries.push(makeEntry());
    this.count = n;

    for (let i = 0; i < n; i++) {
      const s = src![i]!;
      const e = this.entries[i]!;
      if (e.id !== s.id || e.name !== s.name) {
        e.id = s.id;
        e.name = s.name.toUpperCase();
        e.labelW = e.name.length * LABEL_CHAR_W;
        e.rebind = true;
      }
      e.pos[0] = s.position[0];
      e.pos[1] = s.position[1];
      e.pos[2] = s.position[2];
      if (e.temperature !== s.temperature) {
        e.temperature = s.temperature;
        e.rebind = true;
      }
      if (e.luminosity !== s.luminosity) {
        e.luminosity = s.luminosity;
        e.rebind = true;
      }
      const dx = e.pos[0] - this.originPos[0];
      const dy = e.pos[1] - this.originPos[1];
      const dz = e.pos[2] - this.originPos[2];
      e.distanceLy = Math.sqrt(dx * dx + dy * dy + dz * dz);
      e.matches = this.query.length === 0 || e.name.indexOf(this.query) >= 0;
    }

    // Hide any pooled nodes the catalogue shrank past.
    for (let i = n; i < this.entries.length; i++) {
      const node = this.entries[i]!.node;
      if (node) node.style.display = 'none';
    }

    let matches = 0;
    let far = 0;
    for (let i = 0; i < n; i++) {
      const e = this.entries[i]!;
      if (e.matches) matches++;
      if (e.distanceLy > far) far = e.distanceLy;
    }
    this.matchCount = matches;

    // Rings scale to whatever slice of the galaxy is on screen, so the chart
    // reads the same whether you are looking at a cluster or a whole arm.
    const outer = StarMap.niceRadius(far * 0.8);
    this.ringRadii[2] = outer;
    this.ringRadii[1] = outer * 0.5;
    this.ringRadii[0] = outer * 0.25;
    this.lastRingKey = '';

    const empty = n === 0;
    if (this.emptyEl) this.emptyEl.classList.toggle('is-on', empty);
    if (this.root) this.root.classList.toggle('no-data', empty);

    // A selection that has left the chart is no longer a course.
    if (this.selectedId && !this.findEntry(this.selectedId)) this.select(null);
    this.routeDirty = true;
  }

  private findEntry(id: string): MapEntry | null {
    for (let i = 0; i < this.count; i++) {
      const e = this.entries[i]!;
      if (e.id === id) return e;
    }
    return null;
  }

  /**
   * Project every star and fold in the recede transform, so labels stay welded
   * to their stars while the view falls away.
   */
  private projectAll(t: number): void {
    const a = this.adapter;
    if (!a) {
      this.count = 0;
      return;
    }
    const cx = this.width * 0.5;
    const cy = this.height * 0.5;
    const s = 1 + (RECEDE_SCALE - 1) * t;
    for (let i = 0; i < this.count; i++) {
      const e = this.entries[i]!;
      const p = a.project(e.pos);
      e.sx = cx + (p.x - cx) * s;
      e.sy = cy + (p.y - cy) * s;
      e.visible =
        p.visible && e.sx > -80 && e.sy > -40 && e.sx < this.width + 200 && e.sy < this.height + 40;
    }
    const o = a.project(this.originPos);
    this.originSx = cx + (o.x - cx) * s;
    this.originSy = cy + (o.y - cy) * s;
    this.originVisible = o.visible;
  }

  /**
   * Project a light-year position into recede-corrected screen space, leaving
   * the answer in `probeX`/`probeY`. Scalar out-params instead of a returned
   * object: this runs a hundred-odd times a frame for the range rings.
   */
  private projectInto(p: readonly [number, number, number], t: number): void {
    const cx = this.width * 0.5;
    const cy = this.height * 0.5;
    const s = 1 + (RECEDE_SCALE - 1) * t;
    const q = this.adapter!.project(p);
    this.probeX = cx + (q.x - cx) * s;
    this.probeY = cy + (q.y - cy) * s;
  }
  private probeX = 0;
  private probeY = 0;

  /**
   * Concentric range rings around the ship, in light years.
   *
   * The rings are *probed*, not drawn analytically: 36 points on a circle in
   * the galactic plane are pushed through `adapter.project()` and joined. That
   * costs a little more than an ellipse but it is correct under any projection
   * the galaxy view chooses — perspective, tilt, or none — without this module
   * knowing anything about its camera.
   */
  private updateRings(t: number): void {
    const live = this.adapter !== null && this.count > 0;
    if (this.ringGroup) this.ringGroup.style.display = live ? '' : 'none';
    if (!live || this.ringPaths.length === 0) return;

    // Cheap invalidation: two probes on the outer ring plus the origin.
    this.probe[0] = this.originPos[0] + this.ringRadii[2];
    this.probe[1] = this.originPos[1];
    this.probe[2] = this.originPos[2];
    this.projectInto(this.probe, t);
    const key = `${this.originSx.toFixed(0)},${this.originSy.toFixed(0)},${this.probeX.toFixed(0)},${this.probeY.toFixed(0)},${this.ringRadii[2]}`;
    if (key === this.lastRingKey) return;
    this.lastRingKey = key;

    const STEPS = 36;
    for (let r = 0; r < 3; r++) {
      const radius = this.ringRadii[r]!;
      let d = '';
      let tagX = 0;
      let tagY = 0;
      for (let k = 0; k < STEPS; k++) {
        const ang = (k / STEPS) * Math.PI * 2;
        // The galactic disc lies in XZ; Y is disc thickness.
        this.probe[0] = this.originPos[0] + Math.cos(ang) * radius;
        this.probe[1] = this.originPos[1];
        this.probe[2] = this.originPos[2] + Math.sin(ang) * radius;
        this.projectInto(this.probe, t);
        d += `${k === 0 ? 'M' : 'L'}${this.probeX.toFixed(1)},${this.probeY.toFixed(1)}`;
        if (k === 0) {
          tagX = this.probeX;
          tagY = this.probeY;
        }
      }
      d += 'Z';
      this.ringPaths[r]!.setAttribute('d', d);
      const tag = this.ringTags[r]!;
      this.ringTagX[r] = tagX + 8;
      this.ringTagY[r] = tagY - 5;
      tag.setAttribute('x', this.ringTagX[r]!.toFixed(1));
      tag.setAttribute('y', this.ringTagY[r]!.toFixed(1));
      const label = `${radius >= 1 ? Math.round(radius) : radius.toFixed(1)} LY`;
      if (tag.textContent !== label) tag.textContent = label;
      this.ringTagW[r] = label.length * 7.6;
    }
  }

  /** 1-2-5 series, so ring labels are always round numbers. */
  private static niceRadius(v: number): number {
    if (!(v > 0)) return 10;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / mag;
    return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * mag;
  }

  private resolveHover(): void {
    if (!this.pointerInside || this.openAmount < 0.6) return;
    let best: MapEntry | null = null;
    let bestD = HOVER_RADIUS * HOVER_RADIUS;
    for (let i = 0; i < this.count; i++) {
      const e = this.entries[i]!;
      if (!e.visible || !e.matches) continue;
      const dx = e.sx - this.pointerX;
      const dy = e.sy - this.pointerY;
      const d = dx * dx + dy * dy;
      // Labels are part of the target: a hit anywhere along the name counts.
      const inLabel =
        e.labelShown &&
        this.pointerX > e.sx + LABEL_OFF_X - 4 &&
        this.pointerX < e.sx + LABEL_OFF_X + e.labelW + 4 &&
        Math.abs(this.pointerY - e.sy) < LABEL_H;
      if (inLabel) {
        best = e;
        bestD = -1;
        break;
      }
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    this.setHover(best ? best.id : null);
  }

  private setHover(id: string | null): void {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.lastInfoKey = '';
    const a = this.adapter;
    if (!a) return;
    a.setHighlight(id ?? this.selectedId);
    const e = id ? this.findEntry(id) : this.selectedId ? this.findEntry(this.selectedId) : null;
    a.setCursor(e ? e.pos : null);
  }

  /**
   * Importance ordering for the declutter pass. The chart must always name
   * what you are pointing at and where you are going; after that, bright stars
   * and stars near the crosshair win, because that is what the eye is on.
   */
  private rank(): void {
    const cx = this.width * 0.5;
    const cy = this.height * 0.5;
    const searching = this.query.length > 0;
    const order = this.order;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const e = this.entries[i]!;
      if (!e.visible) {
        e.labelShown = false;
        continue;
      }
      let imp = 0;
      if (e.id === this.selectedId) imp += 1e6;
      if (e.id === this.hoverId) imp += 5e5;
      if (e.id === this.originId) imp += 2.5e5;
      if (searching) imp += e.matches ? 1e5 : -1e6;
      // Luminosity spans many decades; log keeps a hypergiant from erasing a
      // whole quadrant of ordinary stars.
      imp += Math.log10(1 + Math.max(0, e.luminosity)) * 34;
      const dx = e.sx - cx;
      const dy = e.sy - cy;
      imp -= Math.sqrt(dx * dx + dy * dy) * 0.045;
      imp -= e.distanceLy * 0.015;
      e.importance = imp;
      order[n++] = i;
    }
    order.length = n;
    order.sort(this.byImportance);
  }

  private byImportance = (a: number, b: number): number =>
    this.entries[b]!.importance - this.entries[a]!.importance;

  /**
   * Greedy declutter. Walk the labels most-important first and keep the first
   * one to claim each patch of screen; anything that collides loses its name
   * and keeps its tick, so the star is still *there*, just unnamed. Greedy is
   * the right algorithm here: it is stable frame to frame (a label only
   * disappears when something genuinely more important moves over it), which
   * matters far more than packing optimally.
   */
  private declutter(): void {
    const acc = this.accepted;
    let accN = 0;
    const order = this.order;

    // The chart's own furniture claims its screen space before any star label
    // gets a look in: "you are here" is never negotiable, and a range ring you
    // cannot read the radius of is decoration.
    if (this.originVisible && this.count > 0) {
      // Covers the marker cross as well as the two-line label above it.
      accN = this.reserve(
        acc,
        accN,
        this.originSx - 14,
        this.originSy - LABEL_H * 2,
        this.originSx + LABEL_OFF_X + this.originLabel.length * LABEL_CHAR_W,
        this.originSy + LABEL_H,
      );
    }
    if (this.count > 0) {
      for (let r = 0; r < 3; r++) {
        accN = this.reserve(
          acc,
          accN,
          this.ringTagX[r]!,
          this.ringTagY[r]! - LABEL_H * 0.7,
          this.ringTagX[r]! + this.ringTagW[r]!,
          this.ringTagY[r]! + 3,
        );
      }
    }
    if (this.routeVisible) {
      accN = this.reserve(
        acc,
        accN,
        this.routeTagX - this.routeTagW * 0.5,
        this.routeTagY - LABEL_H * 0.8,
        this.routeTagX + this.routeTagW * 0.5,
        this.routeTagY + 4,
      );
    }
    // Pass one: the labels the pilot is actually looking at. These are placed
    // before the star ticks are reserved, because "what have I selected" must
    // always be readable even if it sits inside a crowded arm.
    let k = 0;
    for (; k < order.length; k++) {
      const e = this.entries[order[k]!]!;
      if (e.importance < PRIORITY_LABEL) break;
      accN = this.place(e, acc, accN);
    }

    // Every star tick now claims a few pixels, so no name is printed through a
    // star that is not its own. Text over a light source reads as a smudge.
    for (let i = 0; i < this.count; i++) {
      const e = this.entries[i]!;
      if (!e.visible) continue;
      accN = this.reserve(acc, accN, e.sx - 4, e.sy - 4, e.sx + 4, e.sy + 4);
    }

    // Pass two: everything else, still most-important-first.
    for (; k < order.length; k++) {
      accN = this.place(this.entries[order[k]!]!, acc, accN);
    }
    this.acceptedN = accN;
  }

  /** Claim a label's rect if it is free. Returns the new accepted count. */
  private place(e: MapEntry, acc: number[], accN: number): number {
    // A plotted course must stay legible even while filtering for something
    // else — the target is the one thing you can never afford to lose.
    if (this.query.length > 0 && !e.matches && e.id !== this.selectedId) {
      e.labelShown = false;
      return accN;
    }
    const x0 = e.sx + LABEL_OFF_X - LABEL_GUTTER;
    const y0 = e.sy - LABEL_H * 0.5 - LABEL_GUTTER * 0.5;
    const x1 = e.sx + LABEL_OFF_X + e.labelW + LABEL_GUTTER;
    const y1 = e.sy + LABEL_H * 0.5 + LABEL_GUTTER * 0.5;
    for (let j = 0; j < accN; j += 4) {
      if (x0 < acc[j + 2]! && x1 > acc[j]! && y0 < acc[j + 3]! && y1 > acc[j + 1]!) {
        e.labelShown = false;
        return accN;
      }
    }
    e.labelShown = true;
    return this.reserve(acc, accN, x0, y0, x1, y1);
  }

  private reserve(
    acc: number[],
    n: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): number {
    acc[n] = x0;
    acc[n + 1] = y0;
    acc[n + 2] = x1;
    acc[n + 3] = y1;
    return n + 4;
  }

  // ------------------------------------------------------------------- DOM

  private writeNodes(): void {
    const layer = this.layer;
    if (!layer) return;

    const on = this.originNode;
    if (on) {
      const show = this.originVisible && this.count > 0;
      on.style.display = show ? '' : 'none';
      if (show) {
        on.style.transform = `translate3d(${this.originSx.toFixed(1)}px,${this.originSy.toFixed(1)}px,0)`;
        if (this.originNameEl && this.originNameEl.textContent !== this.originLabel) {
          this.originNameEl.textContent = this.originLabel;
        }
      }
    }

    for (let i = 0; i < this.count; i++) {
      const e = this.entries[i]!;
      let node = e.node;
      if (!node) {
        node = this.makeStarNode();
        layer.appendChild(node);
        e.node = node;
        e.nameEl = node.lastElementChild as HTMLDivElement;
        e.rebind = true;
      }
      if (!e.visible) {
        if (node.style.display !== 'none') node.style.display = 'none';
        continue;
      }
      if (node.style.display === 'none') node.style.display = '';

      if (e.rebind) {
        e.rebind = false;
        if (e.nameEl) e.nameEl.textContent = e.name;
        node.style.setProperty('--star', tintFromTemperature(e.temperature));
        // Tick size encodes luminosity — the chart should read as a sky.
        const d = 2.5 + Math.min(3.5, Math.log10(1 + Math.max(0, e.luminosity)) * 2.2);
        node.style.setProperty('--d', `${d.toFixed(2)}px`);
      }

      // Sub-pixel moves are invisible but cost a style write each; skip them.
      if (Math.abs(e.sx - e.lastX) > 0.35 || Math.abs(e.sy - e.lastY) > 0.35) {
        e.lastX = e.sx;
        e.lastY = e.sy;
        node.style.transform = `translate3d(${e.sx.toFixed(1)}px,${e.sy.toFixed(1)}px,0)`;
      }

      const cl = node.classList;
      cl.toggle('no-label', !e.labelShown);
      cl.toggle('is-selected', e.id === this.selectedId);
      cl.toggle('is-hovered', e.id === this.hoverId);
      cl.toggle('is-origin', e.id === this.originId);
      cl.toggle('is-dim', this.query.length > 0 && !e.matches && e.id !== this.selectedId);
    }
  }

  private makeStarNode(): HTMLDivElement {
    const n = document.createElement('div');
    n.className = 'os-sm-star';
    const ring = document.createElement('div');
    ring.className = 'rg';
    const tick = document.createElement('div');
    tick.className = 'tk';
    const lead = document.createElement('div');
    lead.className = 'ld';
    const nm = document.createElement('div');
    nm.className = 'nm';
    n.append(ring, tick, lead, nm);
    return n;
  }

  // ----------------------------------------------------------------- route

  private updateRoute(): void {
    const a = this.adapter;
    const sel = this.selectedId ? this.findEntry(this.selectedId) : null;

    if (this.routeDirty && a) {
      this.routeDirty = false;
      if (!sel) {
        a.setRouteLine(EMPTY_ROUTE);
      } else {
        for (let i = 0; i <= ROUTE_SEGMENTS; i++) {
          const f = i / ROUTE_SEGMENTS;
          const p = this.routePoints[i]!;
          p[0] = this.originPos[0] + (sel.pos[0] - this.originPos[0]) * f;
          p[1] = this.originPos[1] + (sel.pos[1] - this.originPos[1]) * f;
          p[2] = this.originPos[2] + (sel.pos[2] - this.originPos[2]) * f;
        }
        a.setRouteLine(this.routePoints);
      }
    }

    // The chart draws its own screen-space course annotation as well as asking
    // GalaxyView for a 3D line: the plotted course is a property of the
    // instrument, and it must read even when the 3D line is edge-on.
    const svg = this.svg;
    if (!svg || !this.routeHalo || !this.routeLine || !this.routeCap || !this.routeTag) return;
    const group = this.routeGroup;
    if (!group) return;
    if (!sel || !a || !this.originVisible || !sel.visible) {
      if (group.style.display !== 'none') group.style.display = 'none';
      this.routeVisible = false;
      return;
    }
    if (group.style.display === 'none') group.style.display = '';
    this.routeVisible = true;
    const ox = this.originSx;
    const oy = this.originSy;

    // Bow the course perpendicular to itself. A dead-straight line reads as a
    // UI stroke; a slight arc reads as a trajectory.
    const dx = sel.sx - ox;
    const dy = sel.sy - oy;
    const len = Math.hypot(dx, dy) || 1;
    const mx = (ox + sel.sx) * 0.5 - (dy / len) * len * 0.09;
    const my = (oy + sel.sy) * 0.5 + (dx / len) * len * 0.09;
    // Quadratic midpoint is at t=0.5 → (P0 + 2C + P2) / 4.
    this.routeTagX = (ox + 2 * mx + sel.sx) / 4;
    this.routeTagY = (oy + 2 * my + sel.sy) / 4 - 8;

    const key = `${sel.id}|${ox.toFixed(0)},${oy.toFixed(0)},${sel.sx.toFixed(0)},${sel.sy.toFixed(0)}`;
    if (key === this.lastRouteKey) return;
    this.lastRouteKey = key;

    const d = `M${ox.toFixed(1)},${oy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${sel.sx.toFixed(1)},${sel.sy.toFixed(1)}`;
    this.routeHalo.setAttribute('d', d);
    this.routeLine.setAttribute('d', d);
    this.routeCap.setAttribute('x', (ox - 5).toFixed(1));
    this.routeCap.setAttribute('y', (oy - 5).toFixed(1));
    this.routeTag.setAttribute('x', this.routeTagX.toFixed(1));
    this.routeTag.setAttribute('y', this.routeTagY.toFixed(1));
    const tag = `${formatLy(sel.distanceLy)} · ${formatDuration(this.jumpSeconds(sel.distanceLy))}`;
    this.routeTag.textContent = tag;
    this.routeTagW = tag.length * 7.6;
  }

  /**
   * The same timeline the warp runs (GAMEPLAY F5). This used to be its own
   * model — 22 s + 41 s/ly — and promised a minute for a jump that took 7.4 s.
   */
  private jumpSeconds(distanceLy: number): number {
    return jumpEstimateSeconds(distanceLy);
  }

  // ---------------------------------------------------------------- panels

  private updatePanels(): void {
    const focusId = this.hoverId ?? this.selectedId;
    const e = focusId ? this.findEntry(focusId) : null;

    if (this.infoEl) {
      this.infoEl.classList.toggle('is-on', !!e);
      const key = e ? `${e.id}|${e.distanceLy.toFixed(3)}|${e.temperature}` : '';
      if (key !== this.lastInfoKey) {
        this.lastInfoKey = key;
        if (e) {
          const det = this.details ? this.details(e.id) : null;
          const cls = det?.spectralClass ?? spectralFromTemperature(e.temperature);
          this.setVal(this.infoVals, 'name', e.name);
          this.setVal(this.infoVals, 'class', `${cls} · ${Math.round(e.temperature)} K`);
          this.setVal(
            this.infoVals,
            'lum',
            e.luminosity >= 0.01 ? `${e.luminosity.toFixed(2)} L☉` : e.luminosity.toExponential(1),
          );
          this.setVal(
            this.infoVals,
            'planets',
            det?.planetCount === undefined ? '--' : String(det.planetCount),
          );
          this.setVal(
            this.infoVals,
            'dist',
            e.id === this.originId ? 'CURRENT' : formatLy(e.distanceLy),
          );
          this.setVal(
            this.infoVals,
            'jump',
            e.id === this.originId ? '--' : formatDuration(this.jumpSeconds(e.distanceLy)),
          );
          this.setVal(this.infoVals, 'note', det?.note ?? civNote(det?.civilisation));
        }
      }
    }

    const sel = this.selectedId ? this.findEntry(this.selectedId) : null;
    if (this.confirmEl) {
      this.confirmEl.classList.toggle('is-on', !!sel);
      const key = sel ? `${sel.id}|${sel.distanceLy.toFixed(3)}` : '';
      if (key !== this.lastConfirmKey) {
        this.lastConfirmKey = key;
        if (sel) {
          const det = this.details ? this.details(sel.id) : null;
          this.setVal(this.confirmVals, 'target', sel.name);
          this.setVal(this.confirmVals, 'from', this.originLabel);
          this.setVal(this.confirmVals, 'dist', formatLy(sel.distanceLy));
          this.setVal(this.confirmVals, 'eta', formatDuration(this.jumpSeconds(sel.distanceLy)));
          this.setVal(
            this.confirmVals,
            'class',
            det?.spectralClass ?? spectralFromTemperature(sel.temperature),
          );
        }
      }
    }

    if (this.countEl) {
      const txt =
        this.count === 0
          ? ''
          : this.query.length > 0
            ? `${this.matchCount}/${this.count}`
            : `${this.count} CHARTED`;
      if (this.countEl.textContent !== txt) this.countEl.textContent = txt;
    }
  }

  private setVal(bag: Record<string, HTMLDivElement>, key: string, value: string): void {
    const el = bag[key];
    if (el && el.textContent !== value) el.textContent = value;
  }

  // ------------------------------------------------------------ navigation

  /**
   * Move the selection to the nearest system in a screen direction. Scoring is
   * the classic spatial-navigation cone: along-axis distance plus a heavy
   * penalty for lateral offset, so "right" goes right rather than diagonally.
   */
  private navigate(dirX: number, dirY: number): void {
    const from = this.selectedId ? this.findEntry(this.selectedId) : null;
    const ox = from ? from.sx : this.width * 0.5;
    const oy = from ? from.sy : this.height * 0.5;

    let best: MapEntry | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < this.count; i++) {
      const e = this.entries[i]!;
      if (!e.visible || e === from) continue;
      if (this.query.length > 0 && !e.matches) continue;
      const dx = e.sx - ox;
      const dy = e.sy - oy;
      const along = dx * dirX + dy * dirY;
      if (along <= 2) continue; // behind us, or on the axis
      const lateral = Math.abs(dx * dirY - dy * dirX);
      if (lateral > along * 1.6) continue; // outside a ~58° cone
      const score = along + lateral * 2.4;
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    if (!best && !from) {
      // Nothing in that direction and nothing selected: grab the centremost.
      best = this.centremost();
    }
    if (best) {
      this.select(best.id);
      this.setHover(null);
      this.adapter?.setHighlight(best.id);
      this.adapter?.setCursor(best.pos);
    }
  }

  private centremost(): MapEntry | null {
    const cx = this.width * 0.5;
    const cy = this.height * 0.5;
    let best: MapEntry | null = null;
    let bestD = Infinity;
    for (let i = 0; i < this.count; i++) {
      const e = this.entries[i]!;
      if (!e.visible || (this.query.length > 0 && !e.matches)) continue;
      const d = (e.sx - cx) ** 2 + (e.sy - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private confirmJump(): void {
    const sel = this.selectedId ? this.findEntry(this.selectedId) : null;
    if (!sel) return;
    bus.emit('nav:jump-requested', {
      systemId: sel.id,
      name: sel.name,
      distanceLy: sel.distanceLy,
    });
    bus.emit('log', { text: `JUMP AUTHORISED — ${sel.name}`, tone: 'good' });
    this.setOpen(false);
  }

  // ---------------------------------------------------------------- events

  private bindEvents(): void {
    // 'ui:toggle-galaxy', not 'ui:toggle-map'. M now opens the LOCAL chart, and
    // the galaxy is reached from there. The galactic chart's open state has two
    // owners — MapMode holds the camera, this holds the UI — and they stay in
    // step only by listening to the same event. Leaving this one on the raw key
    // opened both charts at once on the first press.
    const offToggle = bus.on('ui:toggle-galaxy', () => this.toggle());
    this.disposers.push(offToggle);

    const offSystem = bus.on('system:entered', ({ system }) => {
      this.setOrigin(system.position, system.name, system.id);
    });
    this.disposers.push(offSystem);

    const root = this.root!;
    const onMove = (ev: PointerEvent): void => {
      this.pointerX = ev.clientX;
      this.pointerY = ev.clientY;
      this.pointerInside = true;
    };
    const onLeave = (): void => {
      this.pointerInside = false;
      this.setHover(null);
    };
    const onDown = (ev: PointerEvent): void => {
      if (ev.button !== 0) return;
      if (this.searchInput && ev.target === this.searchInput) return;
      this.pointerX = ev.clientX;
      this.pointerY = ev.clientY;
      this.pointerInside = true;
      this.resolveHover();
      if (this.hoverId) this.select(this.hoverId);
      else this.select(null);
    };
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerleave', onLeave);
    root.addEventListener('pointerdown', onDown);
    this.disposers.push(
      () => root.removeEventListener('pointermove', onMove),
      () => root.removeEventListener('pointerleave', onLeave),
      () => root.removeEventListener('pointerdown', onDown),
    );

    const input = this.searchInput!;
    const onInput = (): void => {
      this.query = input.value.trim().toUpperCase();
      this.catalogueTimer = 0;
      this.syncCatalogue();
    };
    input.addEventListener('input', onInput);
    this.disposers.push(() => input.removeEventListener('input', onInput));

    // Capture phase on window: while the chart is up it must intercept the
    // flight keys before Input sees them, or typing a system name flies the
    // ship into a star.
    const onKey = (ev: KeyboardEvent): void => this.onKeyDown(ev);
    window.addEventListener('keydown', onKey, true);
    this.disposers.push(() => window.removeEventListener('keydown', onKey, true));
  }

  /** Keys the flight model would otherwise eat while the chart has focus. */
  private static readonly FLIGHT_KEYS = new Set([
    'KeyW',
    'KeyA',
    'KeyS',
    'KeyD',
    'KeyQ',
    'KeyE',
    'KeyR',
    'KeyF',
    'KeyJ',
    'KeyL',
    'Space',
    'Tab',
    'ShiftLeft',
    'ShiftRight',
  ]);

  private onKeyDown(ev: KeyboardEvent): void {
    if (!this.openTarget) return;
    const inField = this.searchInput !== null && ev.target === this.searchInput;

    switch (ev.code) {
      case 'ArrowLeft':
        if (inField) return; // let the caret move
        ev.preventDefault();
        ev.stopPropagation();
        this.navigate(-1, 0);
        return;
      case 'ArrowRight':
        if (inField) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.navigate(1, 0);
        return;
      case 'ArrowUp':
        ev.preventDefault();
        ev.stopPropagation();
        this.navigate(0, -1);
        return;
      case 'ArrowDown':
        ev.preventDefault();
        ev.stopPropagation();
        this.navigate(0, 1);
        return;
      case 'Enter':
        ev.preventDefault();
        ev.stopPropagation();
        if (this.selectedId) this.confirmJump();
        else if (this.matchCount === 1) {
          for (let i = 0; i < this.count; i++) {
            const e = this.entries[i]!;
            if (e.matches) {
              this.select(e.id);
              break;
            }
          }
        }
        return;
      case 'Escape':
        ev.preventDefault();
        ev.stopPropagation();
        // Peel one layer at a time — search, then course, then the chart.
        if (this.query.length > 0 && this.searchInput) {
          this.searchInput.value = '';
          this.query = '';
          this.syncCatalogue();
        } else if (this.selectedId) {
          this.select(null);
        } else {
          this.setOpen(false);
        }
        return;
      case 'Slash':
        if (!inField) {
          ev.preventDefault();
          ev.stopPropagation();
          this.searchInput?.focus();
        }
        return;
      default:
        break;
    }

    if (inField) {
      // Typing must never reach the flight model, but must still type.
      ev.stopPropagation();
      return;
    }
    if (StarMap.FLIGHT_KEYS.has(ev.code)) ev.stopPropagation();
  }

  // ------------------------------------------------------------ DOM build

  private buildDom(): void {
    const root = document.createElement('div');
    root.className = 'os-starmap';
    root.style.display = 'none';
    root.style.setProperty('--os-t', '0');

    root.innerHTML = STARMAP_HTML;
    this.opts.mount.appendChild(root);
    this.root = root;

    this.layer = root.querySelector('.os-sm-layer');
    this.svg = root.querySelector('.os-sm-route');
    this.routeGroup = root.querySelector('.os-sm-route .course');
    this.ringGroup = root.querySelector('.os-sm-route .rings');
    this.routeHalo = root.querySelector('.os-sm-route .halo');
    this.routeLine = root.querySelector('.os-sm-route .line');
    this.routeCap = root.querySelector('.os-sm-route .cap');
    this.routeTag = root.querySelector('.os-sm-route .tag');
    this.originNode = root.querySelector('.os-sm-origin');
    this.originNameEl = root.querySelector('.os-sm-origin .nm');
    for (const p of root.querySelectorAll<SVGPathElement>('.os-sm-route .rings path')) {
      this.ringPaths.push(p);
    }
    for (const tx of root.querySelectorAll<SVGTextElement>('.os-sm-route .rings text')) {
      this.ringTags.push(tx);
    }
    this.searchInput = root.querySelector('.os-sm-search input');
    this.countEl = root.querySelector('.os-sm-count');
    this.infoEl = root.querySelector('.os-sm-info');
    this.confirmEl = root.querySelector('.os-sm-confirm');
    this.emptyEl = root.querySelector('.os-sm-empty');

    for (const el of root.querySelectorAll<HTMLDivElement>('.os-sm-info [data-v]')) {
      this.infoVals[el.dataset.v!] = el;
    }
    for (const el of root.querySelectorAll<HTMLDivElement>('.os-sm-confirm [data-v]')) {
      this.confirmVals[el.dataset.v!] = el;
    }
  }

  private injectStyle(): void {
    if (document.getElementById('os-starmap-style')) return;
    const el = document.createElement('style');
    el.id = 'os-starmap-style';
    el.textContent = STARMAP_CSS;
    document.head.appendChild(el);
    this.styleEl = el;
  }

  /** Escape hatch for the review shot when the module is not engine-driven. */
  private driveExternally(dt: number, width: number, height: number): void {
    if (this.engineDriven) return;
    this.tick(dt, width, height);
  }

  /** @internal — used by registerStarMapShots. */
  shotDrive(dt: number, ctx: EngineContext): void {
    this.driveExternally(dt, ctx.width, ctx.height);
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** MK boundaries, in kelvin. Derived from the adapter's temperature — the
 *  chart never invents a class it was not given a temperature for. */
export function spectralFromTemperature(k: number): SpectralClass {
  if (k >= 30000) return 'O';
  if (k >= 10000) return 'B';
  if (k >= 7500) return 'A';
  if (k >= 6000) return 'F';
  if (k >= 5200) return 'G';
  if (k >= 3700) return 'K';
  return 'M';
}

function formatLy(ly: number): string {
  if (ly < 0.01) return '< 0.01 LY';
  if (ly < 10) return `${ly.toFixed(2)} LY`;
  if (ly < 1000) return `${ly.toFixed(1)} LY`;
  return `${Math.round(ly)} LY`;
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} S`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m} M ${String(s % 60).padStart(2, '0')} S`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} H ${String(m % 60).padStart(2, '0')} M`;
  return `${Math.floor(h / 24)} D ${String(h % 24).padStart(2, '0')} H`;
}

function civNote(civ: number | undefined): string {
  if (civ === undefined) return 'NO SURVEY ON FILE';
  if (civ < 0.05) return 'UNVISITED';
  if (civ < 0.25) return 'TRACE SIGNALS';
  if (civ < 0.6) return 'ESTABLISHED TRAFFIC';
  return 'HEAVILY WORKED';
}

/**
 * Temperature → one of the two sanctioned hues. Hot stars run cyan, cool stars
 * run amber, and the pale middle is where most of the chart sits. Encoding
 * temperature without spending a third saturated hue keeps the palette rule.
 */
function tintFromTemperature(k: number): string {
  const t = clamp01((Math.log(Math.max(1200, k)) - Math.log(2500)) / (Math.log(30000) - Math.log(2500)));
  // amber (255,180,84) → pale (222,232,238) → cyan (95,215,224)
  let r: number;
  let g: number;
  let b: number;
  if (t < 0.55) {
    const f = t / 0.55;
    r = 255 + (222 - 255) * f;
    g = 180 + (232 - 180) * f;
    b = 84 + (238 - 84) * f;
  } else {
    const f = (t - 0.55) / 0.45;
    r = 222 + (95 - 222) * f;
    g = 232 + (215 - 232) * f;
    b = 238 + (224 - 238) * f;
  }
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

const STARMAP_HTML = /* html */ `
<div class="os-sm-veil"></div>
<div class="os-sm-grid"></div>
<svg class="os-sm-route" xmlns="http://www.w3.org/2000/svg">
  <g class="rings">
    <path fill="none"></path><path fill="none"></path><path fill="none"></path>
    <text></text><text></text><text></text>
  </g>
  <g class="course">
    <path class="halo" fill="none"></path>
    <path class="line" fill="none"></path>
    <rect class="cap" width="10" height="10" fill="none"></rect>
    <text class="tag"></text>
  </g>
</svg>
<div class="os-sm-layer"></div>
<div class="os-sm-origin">
  <div class="cr"></div>
  <div class="nm">ORIGIN</div>
</div>
<div class="os-sm-scan"></div>

<div class="os-sm-corner tl"></div>
<div class="os-sm-corner tr"></div>
<div class="os-sm-corner bl"></div>
<div class="os-sm-corner br"></div>

<div class="os-sm-head">
  <div>
    <div class="os-sm-title">STELLAR CHART</div>
    <div class="os-sm-sub">GALACTIC SURVEY &middot; INTERSTELLAR PLOT</div>
    <div class="os-sm-rule"></div>
  </div>
  <div class="os-sm-searchwrap">
    <div class="os-sm-search">
      <label for="os-sm-q">FIND</label>
      <input id="os-sm-q" type="text" spellcheck="false" autocomplete="off" placeholder="DESIGNATION" />
    </div>
    <div class="os-sm-count"></div>
  </div>
</div>

<div class="os-sm-info">
  <div class="hd">CONTACT</div>
  <div class="nm" data-v="name">--</div>
  <div class="row"><span>CLASS</span><div data-v="class">--</div></div>
  <div class="row"><span>OUTPUT</span><div data-v="lum">--</div></div>
  <div class="row"><span>PLANETS</span><div data-v="planets">--</div></div>
  <div class="row"><span>RANGE</span><div data-v="dist">--</div></div>
  <div class="row"><span>JUMP EST</span><div data-v="jump">--</div></div>
  <div class="note" data-v="note">--</div>
</div>

<div class="os-sm-confirm">
  <div class="hd">COURSE PLOTTED</div>
  <div class="tgt" data-v="target">--</div>
  <div class="cols">
    <div class="col"><span>FROM</span><div data-v="from">--</div></div>
    <div class="col"><span>RANGE</span><div data-v="dist">--</div></div>
    <div class="col"><span>JUMP EST</span><div data-v="eta">--</div></div>
    <div class="col"><span>CLASS</span><div data-v="class">--</div></div>
  </div>
  <div class="acts"><b>[ENTER]</b> ENGAGE JUMP<i></i><b>[ESC]</b> CANCEL</div>
</div>

<div class="os-sm-empty">
  <div class="t">NO CHART DATA</div>
  <div class="s">SURVEY LINK OFFLINE &middot; DEAD RECKONING ONLY</div>
</div>

<div class="os-sm-foot">
  <span><b>&larr; &uarr; &darr; &rarr;</b> SELECT</span>
  <span><b>ENTER</b> ENGAGE</span>
  <span><b>/</b> FIND</span>
  <span><b>ESC</b> BACK</span>
</div>
`;

const STARMAP_CSS = /* css */ `
/* The game view falls away behind the chart. Scale + dim only: the labels
   annotate those stars, so the stars must stay sharp. */
html.os-map-recede canvas#gl {
  transform: scale(var(--os-recede, 1));
  transform-origin: 50% 50%;
  filter: brightness(var(--os-recede-dim, 1)) contrast(1.06);
  will-change: transform, filter;
}

.os-starmap {
  --amber: #ffb454;
  --cyan: #5fd7e0;
  --dim: #6b7a85;
  --warn: #ff5f56;
  --t: var(--os-t, 0);
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: var(--t);
  color: #cfd8dc;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-variant-ligatures: none;
  text-transform: uppercase;
  z-index: 20;
}
.os-starmap.is-live { pointer-events: auto; }
.os-starmap * { border-radius: 0; }

/* --- ground layers ----------------------------------------------------- */
.os-sm-veil {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 130% 95% at 50% 50%, rgba(0,0,0,0) 30%, rgba(0,0,0,0.72) 100%),
    linear-gradient(180deg, rgba(2,5,7,0.92) 0%, rgba(2,5,7,0.18) 20%,
                            rgba(2,5,7,0.18) 78%, rgba(2,5,7,0.94) 100%);
}
.os-sm-grid {
  position: absolute; inset: 0;
  opacity: calc(var(--t) * 0.85);
  background-image:
    repeating-linear-gradient(0deg,  rgba(95,215,224,0.055) 0 1px, transparent 1px 72px),
    repeating-linear-gradient(90deg, rgba(95,215,224,0.055) 0 1px, transparent 1px 72px);
  -webkit-mask-image: radial-gradient(ellipse 70% 70% at 50% 50%, #000 25%, transparent 82%);
          mask-image: radial-gradient(ellipse 70% 70% at 50% 50%, #000 25%, transparent 82%);
}
/* Instrument scanlines. Alpha only — no blend modes, so it composites over
   the canvas exactly as authored. */
.os-sm-scan {
  position: absolute; inset: 0;
  pointer-events: none;
  opacity: calc(var(--t) * 0.55);
  background: repeating-linear-gradient(0deg, rgba(0,0,0,0.34) 0 1px, transparent 1px 3px);
}

.os-sm-corner {
  position: absolute; width: 26px; height: 26px;
  border: 0 solid rgba(255,180,84,0.55);
  opacity: calc(var(--t) * var(--t));
}
.os-sm-corner.tl { top: 14px;    left: 16px;  border-top-width: 1px; border-left-width: 1px; }
.os-sm-corner.tr { top: 14px;    right: 16px; border-top-width: 1px; border-right-width: 1px; }
.os-sm-corner.bl { bottom: 14px; left: 16px;  border-bottom-width: 1px; border-left-width: 1px; }
.os-sm-corner.br { bottom: 14px; right: 16px; border-bottom-width: 1px; border-right-width: 1px; }

/* --- stars ------------------------------------------------------------- */
.os-sm-layer { position: absolute; inset: 0; }

.os-sm-star {
  position: absolute; left: 0; top: 0;
  color: var(--star, #b9c7d0);
  will-change: transform;
}
.os-sm-star .tk {
  position: absolute;
  width: var(--d, 3px); height: var(--d, 3px);
  left: calc(var(--d, 3px) / -2); top: calc(var(--d, 3px) / -2);
  background: currentColor;
  box-shadow: 0 0 7px currentColor;
}
.os-sm-star .ld {
  position: absolute; left: 6px; top: 0;
  width: 8px; height: 1px;
  background: currentColor; opacity: 0.45;
}
.os-sm-star .nm {
  position: absolute;
  left: ${LABEL_OFF_X}px; top: -7px;
  font-size: ${LABEL_FONT_PX}px;
  letter-spacing: 0.14em;
  line-height: ${LABEL_H}px;
  white-space: nowrap;
  color: #a9b8c2;
  text-shadow: 0 0 8px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,1);
}
.os-sm-star .rg {
  position: absolute; width: 20px; height: 20px; left: -10px; top: -10px;
  border: 1px solid var(--amber);
  opacity: 0;
  transform: rotate(45deg) scale(1.4);
  transition: opacity 0.18s ease-out, transform 0.24s cubic-bezier(0.2,0.7,0.2,1);
}
.os-sm-star.no-label .nm, .os-sm-star.no-label .ld { display: none; }
.os-sm-star.is-dim { opacity: 0.18; }
.os-sm-star.is-origin .nm { color: var(--cyan); }
.os-sm-star.is-origin .tk { box-shadow: 0 0 12px var(--cyan); }
.os-sm-star.is-hovered .nm { color: var(--cyan); }
.os-sm-star.is-hovered .rg { opacity: 0.5; transform: rotate(45deg) scale(1); border-color: var(--cyan); }
.os-sm-star.is-selected .nm { color: var(--amber); }
.os-sm-star.is-selected .rg { opacity: 1; transform: rotate(0deg) scale(1); }

/* --- you are here ------------------------------------------------------ */
.os-sm-origin { position: absolute; left: 0; top: 0; color: var(--cyan); will-change: transform; }
.os-sm-origin .cr {
  position: absolute; left: -9px; top: -9px; width: 18px; height: 18px;
  border: 1px solid currentColor;
  box-shadow: 0 0 16px rgba(95,215,224,0.5), inset 0 0 8px rgba(95,215,224,0.25);
}
.os-sm-origin .cr::before, .os-sm-origin .cr::after {
  content: ''; position: absolute; background: currentColor;
}
.os-sm-origin .cr::before { left: 7px; top: -8px; width: 1px; height: 24px; }
.os-sm-origin .cr::after  { top: 7px; left: -8px; height: 1px; width: 24px; }
.os-sm-origin .nm {
  position: absolute; left: ${LABEL_OFF_X}px; top: -${LABEL_H + 6}px;
  font-size: ${LABEL_FONT_PX}px; letter-spacing: 0.2em; line-height: ${LABEL_H}px;
  white-space: nowrap; color: var(--cyan);
  text-shadow: 0 0 10px rgba(0,0,0,0.95);
}
.os-sm-origin .nm::after {
  content: 'ORIGIN'; display: block;
  font-size: 8px; letter-spacing: 0.3em; color: var(--dim);
}

/* --- range rings and plotted course ------------------------------------ */
.os-sm-route { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.os-sm-route .rings path {
  stroke: rgba(95,215,224,0.16); stroke-width: 1; stroke-dasharray: 2 6;
}
.os-sm-route .rings text {
  fill: rgba(95,215,224,0.45); font-size: 8.5px; letter-spacing: 0.26em;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.os-sm-route .halo { stroke: rgba(255,180,84,0.16); stroke-width: 5; }
.os-sm-route .line {
  stroke: var(--amber); stroke-width: 1;
  stroke-dasharray: 7 5;
  opacity: 0.85;
}
.os-sm-route .cap { stroke: var(--cyan); stroke-width: 1; opacity: 0.9; }
.os-sm-route .tag {
  fill: var(--amber); font-size: 9.5px; letter-spacing: 0.2em;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  text-anchor: middle; opacity: 0.9;
}

/* --- chrome ------------------------------------------------------------ */
.os-sm-head {
  position: absolute; top: 0; left: 0; right: 0;
  display: flex; justify-content: space-between; align-items: flex-start;
  padding: 34px 44px;
  transform: translateY(calc((1 - var(--t)) * -20px));
}
.os-sm-title { font-size: 11px; letter-spacing: 0.46em; color: var(--amber); }
.os-sm-sub { margin-top: 7px; font-size: 9px; letter-spacing: 0.28em; color: var(--dim); }
.os-sm-rule {
  margin-top: 11px; height: 1px; width: 240px;
  background: linear-gradient(90deg, rgba(255,180,84,0.8), rgba(255,180,84,0));
}
.os-sm-searchwrap { text-align: right; }
.os-sm-search {
  display: flex; align-items: center; gap: 12px;
  min-width: 280px;
  border-bottom: 1px solid rgba(95,215,224,0.35);
  padding-bottom: 6px;
}
.os-sm-search label { font-size: 9px; letter-spacing: 0.3em; color: var(--cyan); }
.os-sm-search input {
  flex: 1; min-width: 0;
  background: transparent; border: 0; outline: 0; padding: 0;
  color: #e8eef2;
  font: inherit; font-size: 11px; letter-spacing: 0.22em;
  text-transform: uppercase;
  caret-color: var(--amber);
  -webkit-appearance: none; appearance: none;
}
.os-sm-search input::placeholder { color: #3d4a53; letter-spacing: 0.22em; }
.os-sm-count { margin-top: 8px; font-size: 9px; letter-spacing: 0.24em; color: var(--dim); }

.os-sm-info {
  position: absolute; right: 44px; top: 132px; width: 262px;
  padding: 4px 0 4px 16px;
  border-left: 1px solid rgba(255,180,84,0.45);
  opacity: 0;
  transform: translateX(10px);
  transition: opacity 0.2s ease-out, transform 0.26s cubic-bezier(0.2,0.7,0.2,1);
}
.os-sm-info.is-on { opacity: calc(var(--t) * var(--t)); transform: translateX(0); }
.os-sm-info .hd { font-size: 8.5px; letter-spacing: 0.36em; color: var(--dim); }
.os-sm-info .nm {
  margin: 8px 0 12px; font-size: 15px; letter-spacing: 0.16em; color: var(--amber);
}
.os-sm-info .row {
  display: flex; justify-content: space-between; align-items: baseline;
  gap: 12px; padding: 3px 0;
  font-size: 10px; letter-spacing: 0.14em;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.os-sm-info .row span { color: var(--dim); font-size: 9px; letter-spacing: 0.24em; }
.os-sm-info .row div { color: #dfe7ec; }
.os-sm-info .note {
  margin-top: 12px; font-size: 9px; letter-spacing: 0.2em; color: var(--cyan); opacity: 0.75;
}

.os-sm-confirm {
  position: absolute; left: 50%; bottom: 74px;
  min-width: 460px;
  padding: 16px 26px 14px;
  background: rgba(3,6,8,0.86);
  border: 1px solid rgba(255,180,84,0.5);
  box-shadow: 0 0 40px rgba(0,0,0,0.8), inset 0 0 30px rgba(255,180,84,0.04);
  opacity: 0;
  transform: translate(-50%, 14px);
  transition: opacity 0.22s ease-out, transform 0.3s cubic-bezier(0.2,0.7,0.2,1);
}
.os-sm-confirm.is-on { opacity: calc(var(--t) * var(--t)); transform: translate(-50%, 0); }
.os-sm-confirm .hd { font-size: 8.5px; letter-spacing: 0.4em; color: var(--dim); }
.os-sm-confirm .tgt {
  margin: 9px 0 14px; font-size: 19px; letter-spacing: 0.2em; color: var(--amber);
  text-shadow: 0 0 22px rgba(255,180,84,0.28);
}
.os-sm-confirm .cols { display: flex; gap: 30px; }
.os-sm-confirm .col span {
  display: block; font-size: 8.5px; letter-spacing: 0.26em; color: var(--dim); margin-bottom: 4px;
}
.os-sm-confirm .col div { font-size: 11px; letter-spacing: 0.14em; color: #dfe7ec; }
.os-sm-confirm .acts {
  margin-top: 15px; padding-top: 11px;
  border-top: 1px solid rgba(255,255,255,0.08);
  display: flex; align-items: center;
  font-size: 9.5px; letter-spacing: 0.24em; color: var(--dim);
}
.os-sm-confirm .acts b { color: var(--cyan); font-weight: 400; margin-right: 8px; }
.os-sm-confirm .acts i { flex: 1; }

.os-sm-empty {
  position: absolute; left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  text-align: center;
  opacity: 0;
  transition: opacity 0.3s ease-out;
}
.os-sm-empty.is-on { opacity: calc(var(--t) * var(--t)); }
.os-sm-empty .t {
  font-size: 15px; letter-spacing: 0.5em; color: var(--warn);
  padding: 14px 26px; border: 1px solid rgba(255,95,86,0.4);
}
.os-sm-empty .s { margin-top: 14px; font-size: 9px; letter-spacing: 0.3em; color: var(--dim); }

.os-sm-foot {
  position: absolute; left: 44px; bottom: 34px;
  display: flex; gap: 26px;
  font-size: 9px; letter-spacing: 0.24em; color: var(--dim);
  transform: translateY(calc((1 - var(--t)) * 16px));
}
.os-sm-foot b { color: var(--cyan); font-weight: 400; margin-right: 7px; }
`;

// ---------------------------------------------------------------------------
// Demo chart — review scaffolding
// ---------------------------------------------------------------------------

/**
 * A deterministic stand-in for GalaxyView, used by the review shot and by the
 * integrator before the real galaxy renderer lands. It is *chart* data only:
 * it never enters the game's universe state, and it is seeded, so the shot is
 * identical on every machine.
 */
export function createDemoChartAdapter(
  seed = 0x0e5ace,
  getWidth: () => number = () => window.innerWidth,
  getHeight: () => number = () => window.innerHeight,
): GalaxyViewAdapter {
  const rng = new Rng(hashSeed(seed >>> 0, 'demo-chart'));
  const HEAD = ['KEPH', 'VELA', 'ORIN', 'TARN', 'SABIK', 'MEROE', 'ISHTAR', 'CALDER', 'VOSS', 'AZEL', 'NYX', 'HOLM', 'REGAL', 'SIRIN', 'DUAT', 'MARLOW'];
  const systems: Array<{
    id: string;
    name: string;
    position: readonly [number, number, number];
    temperature: number;
    luminosity: number;
  }> = [];

  const count = 96;
  for (let i = 0; i < count; i++) {
    // A thin disc with a little spiral bias — enough structure that the
    // declutter pass has genuinely crowded regions to solve.
    const r = rng.power(1.2, 46, -0.6);
    const arm = Math.floor(rng.next() * 2) * Math.PI;
    const theta = arm + r * 0.16 + rng.gaussian(0, 0.36);
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    const y = rng.gaussian(0, 1.6);
    const temperature = rng.power(2700, 24000, -1.6);
    const luminosity = Math.pow(temperature / 5772, 3.2) * rng.range(0.4, 1.8);
    const name = `${rng.pick(HEAD)}-${rng.int(100, 989)}`;
    systems.push({ id: `demo-${i}`, name, position: [x, y, z], temperature, luminosity });
  }

  // Fixed chart camera: a tilted plan view of the disc.
  const YAW = 0.62;
  const TILT = 0.42;
  const cos = Math.cos(YAW);
  const sin = Math.sin(YAW);
  const out = { x: 0, y: 0, visible: false };

  return {
    setHighlight(): void {},
    setCursor(): void {},
    setRouteLine(): void {},
    project(p): { x: number; y: number; visible: boolean } {
      // Returns a shared object on purpose: the chart reads it before the next
      // call, and a projection per star per frame must not allocate.
      const w = getWidth();
      const h = getHeight();
      // The disc deliberately bleeds off the top and bottom of frame: an
      // instrument you can see all of at once has no depth to it.
      const scale = Math.min(w, h) / 62;
      const rx = p[0] * cos + p[2] * sin;
      const rz = p[2] * cos - p[0] * sin;
      out.x = w * 0.5 + rx * scale;
      out.y = h * 0.5 - p[1] * scale * 1.6 + rz * scale * TILT;
      out.visible = out.x > -60 && out.y > -60 && out.x < w + 60 && out.y < h + 60;
      return out;
    },
    systemsInView(): typeof systems {
      return systems;
    },
  };
}

// ---------------------------------------------------------------------------
// Review shot
// ---------------------------------------------------------------------------

export function registerStarMapShots(map: StarMap): void {
  registerShot({
    name: 'starmap-open',
    description:
      'Stellar chart open over the galaxy: decluttered labels, a hovered contact panel, a plotted course and the jump confirmation. Judge label collision handling and the amber/cyan instrument language.',
    apply(ctx): void {
      // Safe if the integrator already registered the module: init() is a no-op
      // once the DOM exists.
      map.init(ctx);

      // Only stand in when the real galaxy view has not been injected.
      if (!map.hasAdapter) {
        map.setAdapter(
          createDemoChartAdapter(
            0x51a12a9,
            () => ctx.width,
            () => ctx.height,
          ),
        );
        map.setDetailsProvider((id) => {
          // Deterministic survey record for the demo catalogue only.
          const r = new Rng(hashSeed(0x5c4a7, id));
          return { planetCount: r.int(0, 9), civilisation: r.next() * 0.8 };
        });
        map.setOrigin([-17.5, 0.8, 12.0], 'HOLM STATION');
      }

      map.setOpen(true);
      // Give the frame a subject: a plotted course plus a live contact.
      map.select('demo-31');
      map.previewContact('demo-14');
    },
    update(dt, ctx): void {
      // shotDrive is a no-op when the engine already drives the module.
      map.shotDrive(dt, ctx);
      // With a real galaxy view wired in, the demo id above will not exist;
      // fall back to whatever is under the crosshair so the frame still shows
      // a course, a selection and the confirmation panel.
      if (!map.selection) map.selectCentremost();
    },
  });
}
