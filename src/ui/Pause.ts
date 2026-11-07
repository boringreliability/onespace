/**
 * The pause overlay (GAMEPLAY B5, PLAN fase 1 punkt 5).
 *
 * `Esc` used to do nothing but the browser's own pointer-lock release. Now it
 * freezes the simulation behind a sheet with the controls, the mouse settings,
 * the quality tier and RETURN TO ORBIT. The transitions are a pure reducer
 * (`pauseState.ts`, tested); this file is the DOM and the wiring.
 *
 * The world stays on screen behind the sheet — `Universe.frozen`, not
 * `Universe.paused`, which MapMode rewrites every frame and which hides the
 * scene for the chart.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { Config, config, type QualityTier } from '@/core/Config';
import { shotOwnsScene } from '@/game/Shots';
import type { Universe } from '@/game/Universe';
import type { RecoveryCut } from '@/game/RecoveryCut';
import { modes } from '@/core/Modes';
import { PAUSE_CLOSED, pauseContextFor, pauseStep, type PauseEvent, type PauseState } from '@/ui/pauseState';
import {
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  loadStickSettings,
  saveStickSettings,
  type StickSettings,
} from '@/ui/stickSettings';

/** Seconds for the sheet to fade. Eased, never snapped (ARCHITECTURE §6). */
const FADE = 0.22;

export interface PauseOptions {
  readonly universe: Universe;
  readonly recovery: RecoveryCut;
  /** The jump drive; a jump cannot be paused into. */
  readonly warp: { readonly phase: string };
}

const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['MOUSE · ARROWS', 'PITCH AND YAW'],
  ['Q / E', 'ROLL'],
  ['W / S · WHEEL', 'THROTTLE'],
  ['X', 'THROTTLE ZERO'],
  ['A D · R F', 'LATERAL · VERTICAL THRUST'],
  ['SHIFT · SPACE', 'BOOST · BRAKE'],
  ['Z', 'FLIGHT ASSIST'],
  ['TAB', 'CYCLE TARGET'],
  ['G', 'CRUISE'],
  ['T', 'SCAN'],
  ['M', 'CHART (WHEEL OUT FOR THE GALAXY)'],
  ['J', 'JUMP TO THE CHARTED SYSTEM'],
  ['C', 'CODEX'],
  ['V', 'CAMERA'],
  ['F2', 'SCREENSHOT'],
  ['ESC', 'PAUSE'],
];

/** localStorage, or null where it is blocked (private windows, sandboxed frames). */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export class Pause implements GameModule {
  readonly name = 'pause';

  private state: PauseState = PAUSE_CLOSED;
  private chartOpen = false;
  private amount = 0;
  private lastAmount = -1;

  private root: HTMLDivElement | null = null;
  private sensVal: HTMLSpanElement | null = null;
  private canvas: HTMLElement | null = null;
  private stick: StickSettings = loadStickSettings(storage());
  private disposers: Array<() => void> = [];

  private readonly universe: Universe;
  private readonly recovery: RecoveryCut;
  private readonly warp: { readonly phase: string };

  constructor(opts: PauseOptions) {
    this.universe = opts.universe;
    this.recovery = opts.recovery;
    this.warp = opts.warp;
  }

  /** True while the overlay is up. The hint line stands down under it. */
  get isOpen(): boolean {
    return this.state.open;
  }

  init(ctx: EngineContext): void {
    this.canvas = ctx.renderer.domElement;
    this.injectStyle();
    this.build();

    this.disposers.push(
      bus.on('ui:chart', ({ chart }) => {
        this.chartOpen = chart !== null;
      }),
    );

    // Esc while the pointer is captured never reaches the page as a key: the
    // browser eats it and releases the lock. The lock loss IS the press.
    const onLock = (): void => {
      if (document.pointerLockElement) return;
      this.dispatch({ type: 'lockLost', t: performance.now() });
    };
    document.addEventListener('pointerlockchange', onLock);
    this.disposers.push(() => document.removeEventListener('pointerlockchange', onLock));

    // While the sheet is up it owns the keyboard, as the codex does: flight
    // keys must not reach a ship you cannot see the instruments of. Capture
    // phase, ahead of Input on window.
    const onKey = (ev: KeyboardEvent): void => {
      if (!this.state.open) return;
      if (ev.code === 'Escape') {
        ev.preventDefault();
        if (!ev.repeat) this.dispatch({ type: 'escKey', t: performance.now() });
      }
      if (ev.code === 'Tab') ev.preventDefault();
      ev.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    this.disposers.push(() => window.removeEventListener('keydown', onKey, true));
  }

  private overlayOpen(): boolean {
    if (this.chartOpen) return true;
    // The codex owns Esc too and exposes no state; its live class is the
    // honest signal and costs one selector a frame.
    return document.querySelector('.os-codex.is-live') !== null;
  }

  private dispatch(event: PauseEvent): void {
    if (shotOwnsScene()) return;
    // The Yard and photo release the pointer on purpose; that is not an Esc.
    const r = pauseStep(
      this.state,
      event,
      pauseContextFor({
        flightShown: modes.current === 'flight',
        menuOpen: this.overlayOpen(),
        busy: this.warp.phase !== 'idle' || this.recovery.active,
      }),
    );
    const was = this.state.open;
    this.state = r.state;
    if (r.effect === 'requestLock') this.requestLock();
    if (r.effect === 'respawn') this.recovery.request('requested');
    if (this.state.open !== was) {
      bus.emit('log', { text: this.state.open ? 'PAUSED' : 'RESUMED', tone: 'normal' });
      if (this.state.open) this.syncSettings();
    }
  }

  private requestLock(): void {
    const el = this.canvas;
    if (!el?.requestPointerLock) return;
    try {
      // Chrome refuses a re-lock for about a second after an Esc release and
      // reports it as a rejected promise; the hint line covers that case.
      const p = el.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => undefined);
    } catch {
      // Older engines throw instead. Same answer: click the canvas.
    }
  }

  update(dt: number, ctx: EngineContext): void {
    // Esc with the pointer free arrives as a key, through Input as usual.
    if (!this.state.open && ctx.input.pressed('pause')) {
      this.dispatch({ type: 'escKey', t: performance.now() });
    }

    this.universe.frozen = this.state.open || this.recovery.active;

    const goal = this.state.open ? 1 : 0;
    this.amount += (goal - this.amount) * Math.min(1, dt / FADE);
    if (Math.abs(goal - this.amount) < 0.003) this.amount = goal;
    if (this.root && this.amount !== this.lastAmount) {
      this.lastAmount = this.amount;
      this.root.style.setProperty('--os-pause-t', this.amount.toFixed(3));
      this.root.style.display = this.amount > 0 ? 'block' : 'none';
      this.root.classList.toggle('is-live', this.state.open);
    }
  }

  // ------------------------------------------------------------------ DOM

  private build(): void {
    const host = document.getElementById('ui-root') ?? document.body;
    const root = document.createElement('div');
    root.className = 'os-pause';
    root.style.display = 'none';

    const veil = document.createElement('div');
    veil.className = 'os-pz-veil';
    root.appendChild(veil);

    const sheet = document.createElement('section');
    sheet.className = 'os-pz-sheet';
    root.appendChild(sheet);

    const title = document.createElement('header');
    title.className = 'os-pz-title';
    title.textContent = 'PAUSED';
    sheet.appendChild(title);

    // Controls. Built with textContent throughout — nothing here is HTML.
    const list = document.createElement('dl');
    list.className = 'os-pz-keys';
    for (const [k, v] of CONTROLS) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      list.append(dt, dd);
    }
    sheet.appendChild(list);

    // Settings.
    const set = document.createElement('div');
    set.className = 'os-pz-set';
    sheet.appendChild(set);

    const sensRow = this.row(set, 'MOUSE SENSITIVITY');
    const sens = document.createElement('input');
    sens.type = 'range';
    sens.min = String(SENSITIVITY_MIN);
    sens.max = String(SENSITIVITY_MAX);
    sens.step = '0.05';
    sens.className = 'os-pz-range';
    this.sensVal = document.createElement('span');
    this.sensVal.className = 'os-pz-val';
    sens.addEventListener('input', () => {
      this.stick = { ...this.stick, sensitivity: Number(sens.value) };
      saveStickSettings(storage(), this.stick);
      // Not syncSettings(): with storage blocked a re-read would snap the
      // slider back to the default under the pilot's hand.
      if (this.sensVal) this.sensVal.textContent = `${this.stick.sensitivity.toFixed(2)}×`;
    });
    sensRow.append(sens, this.sensVal);

    const invRow = this.row(set, 'INVERT PITCH');
    const inv = document.createElement('input');
    inv.type = 'checkbox';
    inv.className = 'os-pz-check';
    inv.addEventListener('change', () => {
      this.stick = { ...this.stick, invertY: inv.checked };
      saveStickSettings(storage(), this.stick);
    });
    invRow.appendChild(inv);

    const tierRow = this.row(set, 'QUALITY');
    const tier = document.createElement('select');
    tier.className = 'os-pz-select';
    for (const t of Config.tiers()) {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t.toUpperCase();
      tier.appendChild(o);
    }
    tier.addEventListener('change', () => this.applyTier(tier.value as QualityTier));
    const note = document.createElement('span');
    note.className = 'os-pz-note';
    note.textContent = 'RELOADS';
    tierRow.append(tier, note);

    // Actions.
    const actions = document.createElement('div');
    actions.className = 'os-pz-actions';
    sheet.appendChild(actions);
    const resume = this.button(actions, 'RESUME', () => this.dispatch({ type: 'resume' }));
    resume.classList.add('is-primary');
    this.button(actions, 'RETURN TO ORBIT', () => this.dispatch({ type: 'returnToOrbit' }));

    const foot = document.createElement('footer');
    foot.className = 'os-pz-foot';
    foot.textContent = 'ESC — RESUME';
    sheet.appendChild(foot);

    host.appendChild(root);
    this.root = root;
    this.syncSettings();

    // Keep the inputs in step with whatever is stored, without re-querying.
    this.syncInputs = () => {
      sens.value = String(this.stick.sensitivity);
      inv.checked = this.stick.invertY;
      tier.value = config.quality.tier;
    };
    this.syncInputs();
  }

  private syncInputs: () => void = () => undefined;

  private syncSettings(): void {
    this.stick = loadStickSettings(storage());
    if (this.sensVal) this.sensVal.textContent = `${this.stick.sensitivity.toFixed(2)}×`;
    this.syncInputs();
  }

  /**
   * Quality tiers are baked into every renderer at construction, so a live
   * switch would be a lie. Reloading with `?tier=` (whitelisted in Route.ts)
   * is honest and costs a boot.
   */
  private applyTier(t: QualityTier): void {
    if (!Config.tiers().includes(t) || t === config.quality.tier) return;
    const url = new URL(window.location.href);
    url.searchParams.set('tier', t);
    window.location.assign(url.toString());
  }

  private row(parent: HTMLElement, label: string): HTMLDivElement {
    const r = document.createElement('div');
    r.className = 'os-pz-row';
    const l = document.createElement('span');
    l.className = 'os-pz-label';
    l.textContent = label;
    r.appendChild(l);
    parent.appendChild(r);
    return r;
  }

  private button(parent: HTMLElement, label: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'os-pz-btn';
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    parent.appendChild(b);
    return b;
  }

  private injectStyle(): void {
    if (document.getElementById('os-pause-style')) return;
    const el = document.createElement('style');
    el.id = 'os-pause-style';
    el.textContent = PAUSE_CSS;
    document.head.appendChild(el);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.root?.remove();
    this.root = null;
    this.universe.frozen = false;
  }
}

const PAUSE_CSS = /* css */ `
.os-pause {
  --amber: #ffb454;
  --t: var(--os-pause-t, 0);
  position: absolute; inset: 0; z-index: 30;
  opacity: var(--t);
  pointer-events: none;
  color: #cfd8dc;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-variant-ligatures: none;
}
.os-pause.is-live { pointer-events: auto; }
.os-pause * { border-radius: 0; box-sizing: border-box; }
.os-pz-veil {
  position: absolute; inset: 0;
  background: radial-gradient(ellipse 120% 90% at 50% 40%, rgba(2,5,7,0.55) 0%, rgba(1,3,4,0.9) 100%);
}
.os-pz-sheet {
  position: absolute; left: 50%; top: 50%;
  transform: translate(-50%, calc(-50% + (1 - var(--t)) * 12px));
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100vh - 32px); overflow-y: auto;
  padding: 22px 26px 16px;
  background: linear-gradient(180deg, rgba(19,20,20,0.985) 0%, rgba(10,11,12,0.99) 100%);
  border: 1px solid rgba(120,101,74,0.55);
  box-shadow: inset 0 1px 0 rgba(255,180,84,0.07), 0 0 0 1px rgba(0,0,0,0.75), 0 30px 90px rgba(0,0,0,0.8);
}
.os-pz-title { color: var(--amber); font-size: 17px; letter-spacing: 0.2em; margin-bottom: 16px; }
.os-pz-keys {
  display: grid; grid-template-columns: max-content 1fr; gap: 4px 18px;
  margin: 0 0 18px; font-size: 11px; letter-spacing: 0.08em;
}
.os-pz-keys dt { color: var(--amber); opacity: 0.85; }
.os-pz-keys dd { margin: 0; color: #a7b0b5; }
.os-pz-set { border-top: 1px solid rgba(120,101,74,0.3); padding-top: 14px; display: grid; gap: 10px; }
.os-pz-row { display: flex; align-items: center; gap: 12px; font-size: 11px; letter-spacing: 0.08em; }
.os-pz-label { color: #7d858d; width: 150px; flex: none; }
.os-pz-val, .os-pz-note { color: #7d858d; font-size: 10px; }
.os-pz-range { flex: 1; accent-color: var(--amber); min-width: 0; }
.os-pz-check { accent-color: var(--amber); }
.os-pz-select {
  background: #0c0d0e; color: #cfd8dc; border: 1px solid rgba(120,101,74,0.55);
  font: inherit; letter-spacing: 0.08em; padding: 3px 6px;
}
.os-pz-actions { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
.os-pz-btn {
  flex: 1; min-width: 140px; padding: 9px 12px;
  background: transparent; color: #cfd8dc; font: inherit; font-size: 11px; letter-spacing: 0.18em;
  border: 1px solid rgba(120,101,74,0.55); cursor: pointer;
  transition: border-color 0.18s ease, color 0.18s ease, background-color 0.18s ease;
}
.os-pz-btn:hover, .os-pz-btn:focus-visible { border-color: var(--amber); color: var(--amber); outline: none; }
.os-pz-btn.is-primary { color: var(--amber); background: rgba(255,180,84,0.05); }
.os-pz-foot { margin-top: 14px; color: #6a727a; font-size: 10px; letter-spacing: 0.08em; }
`;
