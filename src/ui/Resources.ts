/**
 * v4 sub-plan 6, Task 4 — the resources screen in the game (DESIGN-6 §7.1,
 * §7.2, §7.3). The rules — what it shows and what each key does — are pure, in
 * resourcesState.ts (Task 3); this file is the module, the DOM and the wiring.
 *
 *  - Opened by I (the 'resources' action) from free flight. Refused in cruise,
 *    in a jump, during the beacon's recovery and while the emergency choice
 *    menu is up (open choice 1: one O there could throw out the hold the menu's
 *    CANNIBALIZE CARGO needs), with one warn line saying why (OCCUPIED_TEXT). Over the chart, under the pause sheet and in photo the
 *    press does nothing and logs nothing.
 *  - While open it is its own mode ('resources'): everything that moves the
 *    world sleeps (gating.ts), and opening ends an extraction and aborts a
 *    refine or repair (Mining.onModeChange), as every other screen does.
 *  - While open it owns the keyboard: its capture listener on window turns the
 *    key into an event through `resourcesKey` and stops every key from reaching
 *    the flight (as ConflictOverlay does). Browser defaults are kept for the
 *    chords and the unbound function keys (resourcesKey says which).
 *  - Jettison goes through `applyCargoAction` (one `cargo:action`; SaveGame
 *    asks for a 'jettison' save), the beam's choice through
 *    `mining.setBeamResource`, closing through `modes.go('flight')`.
 *  - The selection starts on ice and is remembered between openings.
 *
 * The constructor, update() and onKeyDown() touch no DOM until init() built it
 * (tests run in node and never call init()). Built with createElement +
 * textContent throughout.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { modes, type Mode } from '@/core/Modes';
import type { Resource } from '@/gen/belt';
import type { ActionState, MiningKind } from '@/game/Mining';
import { OCCUPIED_TEXT, formatKg } from '@/game/miningRules';
import { registerShot } from '@/game/Shots';
import { CARGO_CAPACITY_KG, applyCargoAction, type Cargo } from '@/ship/cargo';
import type { Propellant } from '@/ship/propellant';
import {
  RESOURCE_ORDER,
  resourcesKey,
  resourcesView,
  type ResourcesEvent,
  type ResourcesView,
  type ResourcesViewInput,
} from './resourcesState';

/** The screen's title (plan 6 Global Constraints: verbatim). */
export const RESOURCES_TITLE = 'RESOURCES';
/** The column headings, left to right (verbatim). */
export const RESOURCES_COLUMNS: readonly string[] = Object.freeze(['HOLD', 'BEAM', 'USES']);

/** Seconds for the sheet to fade, as the pause sheet. */
const FADE = 0.18;
const STYLE_ID = 'os-resources-style';

/** The log line for what really left the hold (R9: the result's kgOut). */
function jettisonedText(kgOut: number, r: Resource): string {
  return `JETTISONED · ${formatKg(kgOut)} KG ${r.toUpperCase()}`;
}

export interface ResourcesOptions {
  /** `Universe` satisfies it. */
  readonly universe: {
    readonly paused: boolean;
    readonly frozen: boolean;
    readonly cargo: Cargo | null;
    readonly flight: { readonly propellant: Propellant | null };
  };
  readonly mining: {
    readonly beamResource: Resource;
    setBeamResource(r: Resource): void;
    status(kind: MiningKind): ActionState;
  };
  readonly cruise: { readonly busy: boolean };
  readonly warp: { readonly phase: string };
  readonly recovery: { readonly active: boolean };
  /**
   * The emergency choice menu (`Emergency` satisfies it). Optional: a screen
   * built without one never refuses for it; registry.ts passes it.
   */
  readonly emergency?: { readonly open: boolean };
}

const EMPTY_HOLD: Readonly<Record<Resource, number>> = Object.freeze({ ice: 0, rare: 0, metal: 0, silicate: 0 });

interface HoldRowEls {
  readonly row: HTMLElement;
  readonly mark: HTMLElement;
  readonly name: HTMLElement;
  readonly kg: HTMLElement;
  readonly beam: HTMLElement;
}
interface UseRowEls {
  readonly label: HTMLElement;
  readonly cost: HTMLElement;
  readonly status: HTMLElement;
}

export class Resources implements GameModule {
  readonly name = 'resources';

  private readonly opts: ResourcesOptions;
  /** The selected line; ice the first time, then whatever was last selected. */
  private selected: Resource = 'ice';

  private root: HTMLDivElement | null = null;
  private totalEl: HTMLElement | null = null;
  private footEl: HTMLElement | null = null;
  private holdRows: HoldRowEls[] = [];
  private useRows: UseRowEls[] = [];
  private amount = 0;
  private lastAmount = -1;
  /** A review shot is showing a fixed view: update() leaves the sheet alone. */
  private shot = false;
  /** Whether the sheet catches clicks, as last painted. */
  private lastLive = false;
  /**
   * Task 4 review fix (M-5): the keys down now (keydown seen in any mode, until
   * their keyup or a blur), and those that were already down when the screen
   * opened. A held key's auto-repeat from flight (an arrow pitching the ship)
   * must not run the cursor; a fresh press on the sheet does (Task 3).
   */
  private readonly down = new Set<string>();
  private stale = new Set<string>();

  constructor(opts: ResourcesOptions) {
    this.opts = opts;
  }

  init(_ctx: EngineContext): void {
    this.injectStyle();
    this.build();
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onBlur);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    this.root?.remove();
    this.root = null;
    this.holdRows = [];
    this.useRows = [];
  }

  update(dt: number, ctx: EngineContext): void {
    if (modes.base === 'flight' && modes.overlay === null && ctx.input.pressed('resources')) this.tryOpen();
    this.fade(dt);
  }

  onModeChange(from: Mode, to: Mode): void {
    if (to === 'resources') {
      this.shot = false;
      this.stale = new Set(this.down);
      this.render();
    }
    // Back to flight it fades (update ticks there); into a review shot, which
    // it sleeps through, it goes at once — a shot shows its own view.
    if (from === 'resources' && to !== 'flight' && !this.shot) {
      this.amount = 0;
      this.paint();
    }
  }

  /**
   * THE keydown listener (window, capture phase — ahead of Input). Acts only
   * while the screen is open; then no key reaches the flight.
   */
  onKeyDown = (e: KeyboardEvent): void => {
    if (!e.repeat) this.down.add(e.code);
    if (modes.base !== 'resources' || modes.overlay !== null) return;
    if (e.repeat && this.stale.has(e.code)) {
      // Held since before the screen opened: neither the sheet's nor the flight's.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    this.stale.delete(e.code);
    const r = resourcesKey(
      { code: e.code, shift: e.shiftKey, repeat: e.repeat, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey },
      { selected: this.selected, cargo: this.hold() },
    );
    if (r.preventDefault) e.preventDefault();
    // Always, whatever the default: a key on the screen never flies the ship.
    e.stopPropagation();
    if (r.event) this.apply(r.event);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
    this.stale.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.down.clear();
    this.stale.clear();
  };

  // ---------------------------------------------------------------- rules

  /** I in flight: open, or say why not. */
  private tryOpen(): void {
    const { universe, cruise, warp, recovery, emergency } = this.opts;
    // The chart is up over flight: the press is the chart's, not ours.
    if (universe.paused) return;
    // Before `frozen`: the recovery freezes the world too, and it says why.
    if (recovery.active) return this.refuse(OCCUPIED_TEXT.recovery);
    // The pause sheet: it owns the keyboard; nothing to say.
    if (universe.frozen) return;
    if (emergency?.open) return this.refuse(OCCUPIED_TEXT.emergency);
    if (cruise.busy) return this.refuse(OCCUPIED_TEXT.cruise);
    if (warp.phase !== 'idle') return this.refuse(OCCUPIED_TEXT.jump);
    if (!modes.can('resources')) return;
    this.releasePointer();
    modes.go('resources');
  }

  private refuse(text: string): void {
    bus.emit('log', { text, tone: 'warn' });
  }

  private apply(e: ResourcesEvent): void {
    switch (e.kind) {
      case 'select':
        this.selected = e.resource;
        break;
      case 'beam':
        this.opts.mining.setBeamResource(e.resource);
        break;
      case 'jettison': {
        const cargo = this.opts.universe.cargo;
        if (!cargo) return;
        const res = applyCargoAction(cargo, this.opts.universe.flight.propellant, {
          kind: 'jettison',
          resource: e.resource,
          kg: e.kg,
        });
        if (res.ok) bus.emit('log', { text: jettisonedText(res.kgOut, e.resource), tone: 'normal' });
        break;
      }
      case 'close':
        if (modes.can('flight')) modes.go('flight');
        return;
    }
    this.render();
  }

  private hold(): Readonly<Record<Resource, number>> {
    return this.opts.universe.cargo?.snapshot() ?? EMPTY_HOLD;
  }

  /** What the screen shows now, from the live hold, the beam and Mining's rows. */
  private liveView(): ResourcesView {
    const { universe, mining } = this.opts;
    return resourcesView({
      cargo: this.hold(),
      capacityKg: universe.cargo?.capacityKg ?? 0,
      selected: this.selected,
      beam: mining.beamResource,
      refine: mining.status('refine'),
      repair: mining.status('repair'),
    });
  }

  // ------------------------------------------------------------------ DOM

  /**
   * The pointer is freed as the map and the Yard free it: Esc then arrives as a
   * key (it closes the screen), and the lock loss happens in 'resources', where
   * the pause sheet does not take it for an Esc.
   */
  private releasePointer(): void {
    if (!this.root) return;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private fade(dt: number): void {
    if (!this.root || this.shot) return;
    const goal = modes.base === 'resources' ? 1 : 0;
    this.amount += (goal - this.amount) * Math.min(1, dt / FADE);
    if (Math.abs(goal - this.amount) < 0.003) this.amount = goal;
    this.paint();
  }

  private paint(): void {
    if (!this.root) return;
    // Task 4 review fix (M-4): the sheet catches clicks from the frame it opens,
    // not once the fade-in is half done — a click in that window would reach
    // the canvas and lock the pointer under the open sheet. Closed, it lets
    // them through at once (one click on the canvas takes the controls again).
    // A review shot shows it at full strength.
    const live = this.shot ? this.amount > 0.5 : modes.base === 'resources';
    if (this.amount === this.lastAmount && live === this.lastLive) return;
    this.lastAmount = this.amount;
    this.lastLive = live;
    this.root.style.setProperty('--os-res-t', this.amount.toFixed(3));
    this.root.style.display = this.amount > 0 ? 'block' : 'none';
    this.root.classList.toggle('is-live', live);
  }

  private render(fixed: { view: ResourcesView; held: Readonly<Record<Resource, number>> } | null = null): void {
    if (!this.root) return;
    const v = fixed?.view ?? this.liveView();
    const held = fixed?.held ?? this.hold();
    if (this.totalEl) this.totalEl.textContent = v.header;
    if (this.footEl) this.footEl.textContent = v.footer;
    v.hold.forEach((line, i) => {
      const els = this.holdRows[i];
      if (!els) return;
      // The view's text is "NAME 1 234 KG": the name, then the kilograms.
      const cut = line.text.indexOf(' ');
      els.name.textContent = cut > 0 ? line.text.slice(0, cut) : line.text;
      els.kg.textContent = cut > 0 ? line.text.slice(cut + 1) : '';
      els.mark.textContent = line.selected ? '▸' : '';
      els.beam.textContent = line.beam ? '◉' : '';
      els.row.classList.toggle('is-selected', line.selected);
      els.row.classList.toggle('is-beam', line.beam);
      // Shown as 0 KG (formatKg rounds below 0.5 down): drawn dim.
      els.row.classList.toggle('is-empty', !(held[line.resource] >= 0.5));
    });
    v.uses.forEach((use, i) => {
      const els = this.useRows[i];
      if (!els) return;
      els.label.textContent = use.label;
      els.cost.textContent = use.cost;
      els.status.textContent = use.status;
      els.status.dataset.tone = use.tone;
    });
  }

  private build(): void {
    const host = document.getElementById('ui-root') ?? document.body;
    const root = document.createElement('div');
    root.className = 'os-res';
    root.style.display = 'none';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', RESOURCES_TITLE);

    const veil = document.createElement('div');
    veil.className = 'os-rs-veil';
    root.appendChild(veil);

    const sheet = document.createElement('section');
    sheet.className = 'os-rs-sheet';
    root.appendChild(sheet);

    const head = document.createElement('header');
    head.className = 'os-rs-head';
    const title = document.createElement('span');
    title.className = 'os-rs-title';
    title.textContent = RESOURCES_TITLE;
    this.totalEl = document.createElement('span');
    this.totalEl.className = 'os-rs-total';
    head.append(title, this.totalEl);
    sheet.appendChild(head);

    // One grid: the hold (mark, name, kg), the beam, then the uses (label, cost, status).
    const grid = document.createElement('div');
    grid.className = 'os-rs-grid';
    sheet.appendChild(grid);
    const [holdCol, beamCol, usesCol] = RESOURCES_COLUMNS;
    const heading = (text: string | undefined, cls: string): void => {
      const h = document.createElement('div');
      h.className = `os-rs-col ${cls}`;
      h.textContent = text ?? '';
      grid.appendChild(h);
    };
    heading(holdCol, 'os-rs-col-hold');
    heading(beamCol, 'os-rs-col-beam');
    heading(usesCol, 'os-rs-col-uses');

    this.holdRows = RESOURCE_ORDER.map((_, i) => {
      const row = document.createElement('div');
      row.className = 'os-rs-line';
      row.style.gridRow = String(i + 2);
      const cell = (cls: string): HTMLElement => {
        const c = document.createElement('span');
        c.className = cls;
        row.appendChild(c);
        return c;
      };
      const els = { row, mark: cell('os-rs-mark'), name: cell('os-rs-name'), kg: cell('os-rs-kg'), beam: cell('os-rs-beam') };
      grid.appendChild(row);
      return els;
    });
    this.useRows = [0, 1].map((i) => {
      const cell = (cls: string): HTMLElement => {
        const c = document.createElement('span');
        c.className = cls;
        c.style.gridRow = String(i + 2);
        grid.appendChild(c);
        return c;
      };
      return { label: cell('os-rs-use-label'), cost: cell('os-rs-use-cost'), status: cell('os-rs-use-status') };
    });

    this.footEl = document.createElement('footer');
    this.footEl.className = 'os-rs-foot';
    sheet.appendChild(this.footEl);

    host.appendChild(root);
    this.root = root;
    this.render();
  }

  private injectStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  // ---------------------------------------------------------- review shots

  /** A review shot: show a fixed view at once (the module sleeps in review). */
  showShot(input: ResourcesViewInput): void {
    if (!this.root) return;
    this.shot = true;
    this.render({ view: resourcesView(input), held: input.cargo });
    this.amount = 1;
    this.paint();
  }

  hideShot(): void {
    if (!this.root) return;
    this.shot = false;
    this.amount = modes.base === 'resources' ? 1 : 0;
    if (this.amount > 0) this.render();
    this.paint();
  }
}

// ---------------------------------------------------------------------------
// Review shots (DESIGN-6 §7.1): judged at 1280×700 and 1920×1080 — the footer
// must not be clipped, the long statuses must fit.
// ---------------------------------------------------------------------------

const IDLE = { progress: 0, shownKg: 0, leftS: 0, resource: null } as const;
const blocked = (reason: Extract<ActionState, { kind: 'blocked' }>['reason']): ActionState => ({ ...IDLE, kind: 'blocked', reason });
const READY: ActionState = { ...IDLE, kind: 'ready' };

export function registerResourcesShots(screen: Resources): void {
  const teardown = (): void => screen.hideShot();
  registerShot({
    name: 'resources-empty',
    live: true,
    description:
      'The resources screen (I) on an empty hold: all four lines at 0 KG, ▸ and the beam ◉ on ICE, REFINE and REPAIR with nothing to work on. Title RESOURCES, columns HOLD / BEAM / USES, the full key footer unclipped.',
    apply() {
      screen.showShot({
        cargo: EMPTY_HOLD,
        capacityKg: CARGO_CAPACITY_KG,
        selected: 'ice',
        beam: 'ice',
        refine: blocked('nothing-to-refine'),
        repair: blocked('nothing-to-repair'),
      });
    },
    teardown,
  });
  registerShot({
    name: 'resources-full',
    live: true,
    description:
      'The resources screen on a full hold (8 000 / 8 000 KG): ▸ on METAL, the beam ◉ on RARE; beside the HUD’s own tank (part full, undamaged) REFINE says ▸ READY and REPAIR TANK UNDAMAGED — what a player really sees with this hold. Nothing may wrap into the next column or clip at 1280×700.',
    apply() {
      screen.showShot({
        cargo: { ice: 5_000, rare: 250, metal: 1_000, silicate: 1_750 },
        capacityKg: CARGO_CAPACITY_KG,
        selected: 'metal',
        beam: 'rare',
        // What Mining.status says for this hold beside a part-full, undamaged
        // tank (refineRefusal / repairRefusal) — the tank the HUD behind the
        // shot shows. Never IN CRUISE / IN JUMP / BUSY: the screen cannot open
        // in cruise or a jump, and opening ends an action.
        refine: READY,
        repair: blocked('nothing-to-repair'),
      });
    },
    teardown,
  });
}

const CSS = /* css */ `
.os-res {
  --amber: #ffb454;
  --amber-hi: #ffd49a;
  --t: var(--os-res-t, 0);
  position: absolute; inset: 0; z-index: 30;
  opacity: var(--t);
  pointer-events: none;
  color: #cfd8dc;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-variant-ligatures: none;
  font-variant-numeric: tabular-nums;
}
.os-res.is-live { pointer-events: auto; }
.os-res * { border-radius: 0; box-sizing: border-box; }
/* Lighter than the pause veil: the log in the lower left stays legible, so a
   JETTISONED line is read where every other line is. */
.os-rs-veil {
  position: absolute; inset: 0;
  background: radial-gradient(ellipse 110% 85% at 50% 42%, rgba(2,5,7,0.62) 0%, rgba(1,3,4,0.35) 100%);
}
.os-rs-sheet {
  position: absolute; left: 50%; top: 44%;
  transform: translate(-50%, calc(-50% + (1 - var(--t)) * 12px));
  width: min(860px, calc(100vw - 32px));
  max-height: calc(100vh - 32px); overflow-y: auto;
  padding: 22px 26px 16px;
  background: linear-gradient(180deg, rgba(19,20,20,0.975) 0%, rgba(10,11,12,0.985) 100%);
  border: 1px solid rgba(120,101,74,0.55);
  box-shadow: inset 0 1px 0 rgba(255,180,84,0.07), 0 0 0 1px rgba(0,0,0,0.75), 0 30px 90px rgba(0,0,0,0.8);
}
.os-rs-head {
  display: flex; justify-content: space-between; align-items: baseline; gap: 18px;
  margin-bottom: 18px; flex-wrap: wrap;
}
.os-rs-title { color: var(--amber); font-size: 17px; letter-spacing: 0.2em; }
.os-rs-total { color: #a7b0b5; font-size: 11px; letter-spacing: 0.12em; white-space: nowrap; }
.os-rs-grid {
  display: grid;
  /* The kg column has a fixed floor wide enough for 8 000 KG (letter-spacing
     included), so BEAM and USES do not jump sideways when the widest number
     changes (a jettison); the names are fixed words. */
  grid-template-columns: 1.6em max-content minmax(calc(8ch + 0.64em), max-content) 4.5em max-content max-content 1fr;
  column-gap: 14px; row-gap: 6px;
  font-size: 11px; letter-spacing: 0.08em;
  align-items: baseline;
}
.os-rs-col {
  grid-row: 1; color: #7d858d; font-size: 10px; letter-spacing: 0.18em;
  padding-bottom: 6px; border-bottom: 1px solid rgba(120,101,74,0.3);
}
.os-rs-col-hold { grid-column: 1 / 4; }
.os-rs-col-beam { grid-column: 4; text-align: center; }
.os-rs-col-uses { grid-column: 5 / 8; }
.os-rs-line { display: contents; color: #a7b0b5; }
.os-rs-line > * { white-space: nowrap; }
.os-rs-mark { grid-column: 1; color: var(--amber); }
.os-rs-name { grid-column: 2; }
.os-rs-kg { grid-column: 3; text-align: right; }
.os-rs-beam { grid-column: 4; text-align: center; color: var(--amber); }
.os-rs-line.is-empty { color: #6a727a; }
.os-rs-line.is-selected { color: var(--amber); }
.os-rs-line.is-selected .os-rs-name, .os-rs-line.is-selected .os-rs-kg { text-shadow: 0 0 6px rgba(255,180,84,0.35); }
.os-rs-use-label { grid-column: 5; color: #7d858d; letter-spacing: 0.18em; white-space: nowrap; }
.os-rs-use-cost { grid-column: 6; color: #a7b0b5; white-space: nowrap; }
.os-rs-use-status { grid-column: 7; color: #7d858d; }
.os-rs-use-status[data-tone="ready"] { color: var(--amber); }
.os-rs-use-status[data-tone="running"] { color: var(--amber-hi); text-shadow: 0 0 6px rgba(255,180,84,0.4); }
.os-rs-foot {
  margin-top: 20px; padding-top: 12px; border-top: 1px solid rgba(120,101,74,0.3);
  color: #8a9298; font-size: 10px; letter-spacing: 0.08em;
  white-space: pre-wrap;
}
`;
