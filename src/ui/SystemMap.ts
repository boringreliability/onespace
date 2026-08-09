/**
 * The local chart — the system you are actually in.
 *
 * The galaxy chart answers "where do I jump next". Until now nothing answered
 * "what is in here, and how far is it", which is the question you have every
 * time you arrive somewhere. With the cruise drive that question finally has a
 * useful answer, because the things on this chart are now reachable: it quotes
 * a crossing time next to every body, computed from the same law the drive
 * flies by.
 *
 * TWO CHOICES WORTH DEFENDING
 *
 * **Radius is logarithmic.** A system with a rocky world at 0.4 AU and an ice
 * giant at 28 drawn linearly is a dot at the centre and a dot at the rim, with
 * nothing legible between them. Every real system is like that. The log scale
 * costs geometric truth and buys a chart you can read, and since the numbers
 * are printed next to the bodies, nothing is actually hidden.
 *
 * **Orbits are sampled, not drawn as ellipses.** A log radial scale maps an
 * ellipse to something that is not an ellipse, so an SVG <ellipse> would be a
 * lie in exactly the eccentric cases where the shape matters. Sixty-four
 * samples through the real Kepler solution, each scaled radially, is both
 * honest and cheap.
 */

import { bus } from '@/core/EventBus';
import type { EngineContext, GameModule } from '@/core/Engine';
import { activeShotName, registerShot } from '@/game/Shots';
import { orbitalPosition } from '@/gen/orbit';
import { AU, SOLAR_RADIUS, type PlanetSpec, type StarSystemSpec } from '@/gen/types';
import { cruiseTravelSeconds } from '@/ship/CruiseDrive';
import type { Universe } from '@/game/Universe';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Chart radius in viewBox units. The viewBox is square and centred on 0,0. */
const R = 500;

/** Inner end of the log scale, km. Comfortably inside any star. */
const R_FLOOR_KM = 1e5;

/** Samples per orbit polyline. 64 is smooth at chart scale and free. */
const ORBIT_SAMPLES = 64;

/** Seconds for the open/close ease. */
const FADE = 0.24;

/** Colour per planet type — the chart's only use of hue as information. */
const TYPE_COLOUR: Record<PlanetSpec['type'], string> = {
  rocky: '#9aa7ad',
  ocean: '#5aa9c8',
  desert: '#c8a066',
  ice: '#a8cdd8',
  volcanic: '#c86a45',
  toxic: '#b0a24e',
  barren: '#8b8b86',
  terran: '#79bd7a',
  'gas-giant': '#c9a074',
  'ice-giant': '#7fb0c4',
};

/** A body as the chart needs it: enough to draw and enough to quote. */
interface Node {
  readonly spec: PlanetSpec;
  readonly parent: Node | null;
  /** Screen-space position in viewBox units. */
  x: number;
  y: number;
  /** Distance from the ship, km. */
  distanceKm: number;
  el: SVGCircleElement | null;
  label: SVGTextElement | null;
}

/** log-scaled radius: km from the star to viewBox units. */
function radial(km: number, maxKm: number): number {
  const r = Math.max(km, R_FLOOR_KM);
  const span = Math.log(Math.max(maxKm, R_FLOOR_KM * 10) / R_FLOOR_KM);
  return (R * Math.min(1, Math.log(r / R_FLOOR_KM) / span));
}

/** "4 m 12 s", "1 h 06 m" — a crossing time a pilot can act on. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return `${m} m ${String(Math.round(seconds - m * 60)).padStart(2, '0')} s`;
  }
  const h = Math.floor(seconds / 3600);
  return `${h} h ${String(Math.floor((seconds - h * 3600) / 60)).padStart(2, '0')} m`;
}

/** Distance in the unit that suits it. */
export function formatRange(km: number): string {
  if (km < 1e4) return `${Math.round(km)} km`;
  if (km < AU * 0.01) return `${(km / 1e6).toFixed(2)} Mm`;
  return `${(km / AU).toFixed(3)} au`;
}

export interface SystemMapOptions {
  readonly universe: Universe;
  readonly mount?: HTMLElement;
}

export class SystemMap implements GameModule {
  readonly name = 'system-map';

  private readonly universe: Universe;
  private readonly mount: HTMLElement;

  private root: HTMLElement | null = null;
  private svg: SVGSVGElement | null = null;
  private gOrbits: SVGGElement | null = null;
  private gBodies: SVGGElement | null = null;
  private shipEl: SVGGElement | null = null;
  private titleEl: HTMLElement | null = null;
  private infoEls: Record<string, HTMLElement> = {};

  private open = false;
  private amount = 0;
  /** True while the galaxy chart has the screen; M then closes that, not this. */
  private galaxyOpen = false;
  /** Set while closing because another chart took over. See the handler. */
  private superseded = false;

  private nodes: Node[] = [];
  private maxKm = AU;
  private selected: Node | null = null;
  private builtFor: string | null = null;

  private readonly disposers: Array<() => void> = [];
  private onKey: ((e: KeyboardEvent) => void) | null = null;

  constructor(opts: SystemMapOptions) {
    this.universe = opts.universe;
    this.mount =
      opts.mount ?? (document.getElementById('ui-root') as HTMLElement) ?? document.body;
  }

  init(): void {
    this.injectStyle();
    this.buildDom();

    this.disposers.push(
      // M is the one chart key. It opens the local chart; from there the
      // player zooms out to the galaxy. Routing lives here so MapMode keeps
      // owning exactly one thing: the galaxy view.
      bus.on('ui:toggle-map', () => {
        if (this.galaxyOpen) {
          bus.emit('ui:toggle-galaxy');
          return;
        }
        this.setOpen(!this.open);
      }),
      bus.on('ui:chart', ({ chart }) => {
        this.galaxyOpen = chart === 'galaxy';
        if (this.galaxyOpen && this.open) {
          // Closing because something else took the screen, not because the
          // screen is going back to flight. Announcing `null` here would tell
          // the HUD to come back up over the galactic chart, and would strip
          // the canvas recede the other chart is relying on.
          this.superseded = true;
          this.setOpen(false);
          this.superseded = false;
        }
      }),
      bus.on('system:entered', () => {
        this.builtFor = null;
        this.selected = null;
      }),
    );

    this.onKey = (e) => {
      // M closes the galactic chart too. It cannot arrive by the normal route:
      // MapMode pauses the universe while its chart is up, and Pilot — which
      // turns the key into `ui:toggle-map` — returns before reading input when
      // paused. So the chart could only ever be stowed with Escape. Chart
      // routing already lives in this module; this is the rest of it.
      if (!this.open && this.galaxyOpen && e.code === 'KeyM') {
        bus.emit('ui:toggle-galaxy');
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (!this.open) return;
      if (e.code === 'Escape') {
        this.setOpen(false);
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (e.code === 'KeyM') return;
      e.stopPropagation();
    };
    window.addEventListener('keydown', this.onKey, true);
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    // Push the game back behind the chart the way the galactic chart does.
    // Without it the hull sits in the middle of the orbit rings and the world
    // below shows through every line on the page.
    const html = document.documentElement;
    if (open) {
      html.classList.add('os-map-recede');
      html.style.setProperty('--os-recede', '1.06');
      html.style.setProperty('--os-recede-dim', '0.22');
    } else if (!this.superseded) {
      html.classList.remove('os-map-recede');
      html.style.removeProperty('--os-recede');
      html.style.removeProperty('--os-recede-dim');
    }
    if (open || !this.superseded) {
      bus.emit('ui:chart', { chart: open ? 'system' : null });
    }
    if (open) {
      if (document.pointerLockElement) document.exitPointerLock();
      if (this.root) this.root.style.display = 'block';
      this.rebuild();
      bus.emit('log', {
        text: 'CHART — LOCAL · CLICK A BODY · WHEEL OUT FOR THE GALAXY',
        tone: 'normal',
      });
    }
  }

  update(dt: number, _ctx: EngineContext): void {
    // Shots do not reset each other; the module that owns the state closes it.
    const shot = activeShotName();
    if (shot !== null && shot !== 'system-map' && this.open) this.setOpen(false);

    const target = this.open ? 1 : 0;
    if (this.amount !== target) {
      const step = dt / FADE;
      this.amount =
        target > this.amount ? Math.min(1, this.amount + step) : Math.max(0, this.amount - step);
      const root = this.root;
      if (root) {
        root.style.setProperty('--os-t', this.amount.toFixed(3));
        root.style.display = this.amount <= 0 ? 'none' : 'block';
        root.classList.toggle('is-live', this.open && this.amount > 0.5);
      }
    }
    if (!this.open) return;
    this.refresh();
  }

  // ------------------------------------------------------------ chart build

  /** Rebuild the static half — orbits and body nodes — for the current system. */
  private rebuild(): void {
    const sys = this.universe.system;
    if (!sys || !this.gOrbits || !this.gBodies) return;
    if (this.builtFor === sys.id) return;
    this.builtFor = sys.id;

    this.gOrbits.replaceChildren();
    this.gBodies.replaceChildren();
    this.nodes = [];

    this.maxKm =
      sys.planets.reduce((m, p) => Math.max(m, p.orbit.semiMajorAxis * (1 + p.orbit.eccentricity)), AU) *
      1.12;

    if (this.titleEl) this.titleEl.textContent = sys.name;

    // The star. Drawn from the spec so a binary reads as a binary.
    const star = sys.stars[0];
    if (star) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('class', 'os-sm2-star');
      c.setAttribute('cx', '0');
      c.setAttribute('cy', '0');
      c.setAttribute('r', String(Math.max(6, radial(star.radius * SOLAR_RADIUS, this.maxKm))));
      c.setAttribute('fill', rgbOf(star.color));
      this.gOrbits.appendChild(c);
    }

    for (const p of sys.planets) {
      this.gOrbits.appendChild(this.orbitPath(p));
      this.nodes.push(this.makeNode(p, null));
    }
  }

  /** The orbit as a closed polyline through the real Kepler solution. */
  private orbitPath(p: PlanetSpec): SVGPathElement {
    let d = '';
    for (let i = 0; i <= ORBIT_SAMPLES; i++) {
      const t = (i / ORBIT_SAMPLES) * Math.max(p.orbit.period, 1);
      const v = orbitalPosition(p.orbit, t);
      const r = Math.hypot(v.x, v.z);
      const k = radial(r, this.maxKm) / Math.max(r, 1e-9);
      d += `${i === 0 ? 'M' : 'L'}${(v.x * k).toFixed(2)} ${(v.z * k).toFixed(2)}`;
    }
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'os-sm2-orbit');
    path.setAttribute('d', `${d}Z`);
    return path;
  }

  private makeNode(spec: PlanetSpec, parent: Node | null): Node {
    const node: Node = { spec, parent, x: 0, y: 0, distanceKm: 0, el: null, label: null };

    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', 'os-sm2-body');
    c.setAttribute('r', spec.moons.length > 0 ? '7' : '6');
    c.setAttribute('fill', TYPE_COLOUR[spec.type] ?? '#9aa7ad');
    c.addEventListener('click', () => this.select(node));
    this.gBodies!.appendChild(c);
    node.el = c;

    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('class', 'os-sm2-label');
    t.textContent = spec.name;
    t.addEventListener('click', () => this.select(node));
    this.gBodies!.appendChild(t);
    node.label = t;

    return node;
  }

  // ------------------------------------------------------------ per frame

  /** Move everything that moves, and requote the selection. */
  private refresh(): void {
    const shipWorld = this.universe.flight.worldPosition;
    const orbitT = this.universe.orbitSeconds;

    for (const n of this.nodes) {
      const v = orbitalPosition(n.spec.orbit, orbitT);
      const r = Math.hypot(v.x, v.z);
      const k = radial(r, this.maxKm) / Math.max(r, 1e-9);
      n.x = v.x * k;
      n.y = v.z * k;
      // The chart is a projection; the range is not. Quote the true 3D gap.
      n.distanceKm = Math.hypot(v.x - shipWorld.x, v.y - shipWorld.y, v.z - shipWorld.z);
      n.el?.setAttribute('cx', n.x.toFixed(2));
      n.el?.setAttribute('cy', n.y.toFixed(2));
      n.label?.setAttribute('x', (n.x + 11).toFixed(2));
      n.label?.setAttribute('y', (n.y + 4).toFixed(2));
      n.el?.setAttribute('data-on', this.selected === n ? '1' : '0');
    }

    // The ship, projected the same way as everything else.
    const sr = Math.hypot(shipWorld.x, shipWorld.z);
    const sk = radial(sr, this.maxKm) / Math.max(sr, 1e-9);
    this.shipEl?.setAttribute(
      'transform',
      `translate(${(shipWorld.x * sk).toFixed(2)} ${(shipWorld.z * sk).toFixed(2)})`,
    );

    this.quote();
  }

  /** Select by index — used by the review shot so the readout is never empty. */
  selectNth(i: number): void {
    const n = this.nodes[Math.min(Math.max(i, 0), this.nodes.length - 1)];
    if (n) this.select(n);
  }

  private select(n: Node): void {
    this.selected = n;
    bus.emit('target:changed', { id: n.spec.id, name: n.spec.name });
    this.quote();
  }

  /** Fill the readout for the current selection. */
  private quote(): void {
    const set = (k: string, v: string): void => {
      const el = this.infoEls[k];
      if (el && el.textContent !== v) el.textContent = v;
    };
    const n = this.selected;
    if (!n) {
      set('name', 'no selection');
      set('type', '—');
      set('range', '—');
      set('eta', '—');
      set('gravity', '—');
      return;
    }
    set('name', n.spec.name);
    const moons = n.spec.moons.length;
    set('type', `${n.spec.type}${moons ? ` · ${moons} moon${moons === 1 ? '' : 's'}` : ''}`);
    set('range', formatRange(n.distanceKm));
    // The crossing time the cruise drive would actually deliver: it closes on
    // the body, so the gap it flies is surface-to-ship, and the arrival is at
    // the drive's own drop threshold rather than at zero.
    set('eta', formatEta(cruiseTravelSeconds(Math.max(n.distanceKm - n.spec.radius, 1), 3_000)));
    set('gravity', `${n.spec.gravity.toFixed(1)} m/s²`);
  }

  // ------------------------------------------------------------ DOM

  private buildDom(): void {
    const root = document.createElement('div');
    root.className = 'os-sysmap';
    root.style.display = 'none';
    root.style.setProperty('--os-t', '0');
    root.innerHTML = SYSMAP_HTML;
    this.mount.appendChild(root);
    this.root = root;

    this.svg = root.querySelector('svg');
    this.gOrbits = root.querySelector('.orbits');
    this.gBodies = root.querySelector('.bodies');
    this.shipEl = root.querySelector('.ship');
    this.titleEl = root.querySelector('.os-sm2-title');
    for (const el of root.querySelectorAll<HTMLElement>('[data-v]')) {
      this.infoEls[el.dataset.v!] = el;
    }

    root.querySelector('.os-sm2-out')?.addEventListener('click', () => this.toGalaxy());
    // Wheeling out past the chart is the same gesture as zooming out of it.
    this.svg?.addEventListener(
      'wheel',
      (e) => {
        if (!this.open) return;
        e.preventDefault();
        if (e.deltaY > 0) this.toGalaxy();
      },
      { passive: false },
    );
  }

  /** Hand the screen to the galaxy chart. One chart is visible at a time. */
  private toGalaxy(): void {
    if (!this.open) return;
    this.setOpen(false);
    bus.emit('ui:toggle-galaxy');
  }

  private injectStyle(): void {
    if (document.getElementById('os-sysmap-style')) return;
    const el = document.createElement('style');
    el.id = 'os-sysmap-style';
    el.textContent = SYSMAP_CSS;
    document.head.appendChild(el);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    if (this.onKey) window.removeEventListener('keydown', this.onKey, true);
    this.root?.remove();
    this.root = null;
  }
}

function rgbOf(c: readonly [number, number, number]): string {
  const to = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${to(c[0])},${to(c[1])},${to(c[2])})`;
}

/** Review shot. Opens the chart over the live system with a body selected. */
export function registerSystemMapShots(map: SystemMap): void {
  registerShot({
    name: 'system-map',
    live: true,
    description:
      'The local chart: logarithmic orbit rings through the real Kepler ' +
      'solution, bodies coloured by type, the ship marked, and the readout ' +
      'quoting range and a cruise crossing time. Judge legibility of the ' +
      'inner system against the outer, and whether the chart reads as an ' +
      'instrument distinct from the galaxy chart.',
    apply() {
      map.setOpen(true);
      // The outermost world: a selection that demonstrates a real crossing
      // time rather than the one the ship is already parked at.
      map.selectNth(99);
    },
  });
}

const SYSMAP_HTML = /* html */ `
<div class="os-sm2-veil"></div>
<svg viewBox="-560 -560 1120 1120" xmlns="http://www.w3.org/2000/svg">
  <g class="orbits"></g>
  <g class="bodies"></g>
  <g class="ship">
    <circle r="3.5"></circle>
    <path d="M0 -13 L5 -4 L0 -6 L-5 -4 Z"></path>
  </g>
</svg>
<header class="os-sm2-head">
  <span class="os-sm2-kicker">local chart</span>
  <span class="os-sm2-title">—</span>
</header>
<aside class="os-sm2-info">
  <div class="nm" data-v="name">no selection</div>
  <dl>
    <dt>class</dt><dd data-v="type">—</dd>
    <dt>range</dt><dd data-v="range">—</dd>
    <dt>cruise</dt><dd data-v="eta">—</dd>
    <dt>gravity</dt><dd data-v="gravity">—</dd>
  </dl>
</aside>
<footer class="os-sm2-foot">
  <span>esc &mdash; stow</span>
  <button class="os-sm2-out">wheel out &mdash; galactic chart</button>
</footer>
`;

const SYSMAP_CSS = /* css */ `
.os-sysmap {
  --cyan: #5fd7e0;
  --amber: #ffb454;
  --dim: #6b7a85;
  --t: var(--os-t, 0);
  position: absolute; inset: 0; z-index: 22;
  opacity: var(--t); pointer-events: none;
  color: #cfd8dc;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  text-transform: uppercase; font-variant-ligatures: none;
}
.os-sysmap.is-live { pointer-events: auto; }
.os-sysmap * { border-radius: 0; }

.os-sm2-veil {
  position: absolute; inset: 0;
  background: radial-gradient(ellipse 120% 100% at 50% 50%,
              rgba(2,6,8,0.90) 0%, rgba(1,3,4,0.995) 100%);
}

.os-sysmap svg {
  position: absolute; left: 50%; top: 50%;
  width: min(88vh, 88vw); height: min(88vh, 88vw);
  transform: translate(-50%, -50%) scale(calc(0.965 + var(--t) * 0.035));
  overflow: visible;
}

.os-sm2-orbit { fill: none; stroke: rgba(95,215,224,0.22); stroke-width: 1.1; }
.os-sm2-star { filter: drop-shadow(0 0 14px rgba(255,200,120,0.75)); }

.os-sm2-body { cursor: pointer; stroke: rgba(0,0,0,0.85); stroke-width: 1.5; }
.os-sm2-body:hover { stroke: var(--amber); stroke-width: 2; }
.os-sm2-body[data-on="1"] { stroke: var(--amber); stroke-width: 2.5; }

.os-sm2-label {
  fill: #8b969d; font-size: 13px; font-family: inherit;
  letter-spacing: 0.14em; cursor: pointer; text-transform: uppercase;
  paint-order: stroke; stroke: rgba(0,0,0,0.9); stroke-width: 3px;
}
.os-sm2-label:hover { fill: var(--amber); }

.ship circle { fill: var(--amber); }
.ship path { fill: none; stroke: var(--amber); stroke-width: 1.6; }

.os-sm2-head {
  position: absolute; left: 34px; top: 30px;
  display: flex; flex-direction: column; gap: 4px;
}
.os-sm2-kicker { color: var(--dim); font-size: 10px; letter-spacing: 0.3em; }
.os-sm2-title { color: var(--cyan); font-size: 21px; letter-spacing: 0.22em; }

.os-sm2-info {
  position: absolute; right: 34px; top: 30px; width: 250px;
  border: 1px solid rgba(95,215,224,0.24);
  border-top-color: rgba(95,215,224,0.6);
  background: linear-gradient(180deg, rgba(4,9,11,0.94), rgba(2,5,6,0.96));
  padding: 12px 14px 13px;
}
.os-sm2-info .nm { color: var(--amber); font-size: 12px; letter-spacing: 0.14em; margin-bottom: 9px; }
.os-sm2-info dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; }
.os-sm2-info dt { color: var(--dim); font-size: 9px; letter-spacing: 0.18em; }
.os-sm2-info dd {
  margin: 0; color: #c3ced4; font-size: 10px; letter-spacing: 0.08em;
  text-align: right;
  /* Never uppercase a value. "Mm" becomes "MM" — megametres read as
     millimetres — and "m/s²" becomes "M/S²", which is not a unit. Same class
     of error as the scanner's "266 k mean". */
  text-transform: none;
}

.os-sm2-foot {
  position: absolute; left: 34px; bottom: 26px;
  display: flex; gap: 22px; align-items: center;
  color: var(--dim); font-size: 10px; letter-spacing: 0.14em;
}
.os-sm2-out {
  background: none; border: 1px solid rgba(95,215,224,0.3);
  color: var(--dim); font: inherit; font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; padding: 4px 10px; cursor: pointer;
}
.os-sm2-out:hover { color: var(--cyan); border-color: rgba(95,215,224,0.7); }
`;
