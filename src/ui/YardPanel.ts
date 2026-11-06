/**
 * The Yard's overlay — a registry page laid over the hull.
 *
 * Same typographic register as the HUD and the codex: monospace, uppercase
 * labels, dot-leader readouts in three tones (label dim, leader faintest,
 * value bright), amber for the one thing that is selected and nowhere else.
 * The hull is the picture; the panel is two narrow margins and a masthead,
 * set in ink rather than boxed, so it never competes with the subject
 * (ARCHITECTURE §6: colour is rationed; amber is the instruments' glow).
 *
 * The panel owns DOM and nothing else. It reports what was clicked through
 * `onAction` and is told what to show through `render`; the Yard module owns
 * every decision. It also owns the VEIL — a black sheet under the panel that
 * the Yard fades up to hide a hull swap (generation is 30-100 ms of main
 * thread; behind black it is invisible) and fades away again. Opacity rides a
 * CSS transition, so the fade keeps running on frames where the main thread
 * is busy building the next ship, and across the mode change back to flight.
 */

import type { DrivePresetId, LightPresetId, ViewPresetId } from '@/game/showroom/presets';
import type { SpecLine, ShipRegistryHeader } from '@/game/showroom/specs';
import type { YardSelection } from '@/game/showroom/catalog';

export type YardBackdrop = 'void' | 'anchorage';
export type YardView = ViewPresetId | 'free';

export type YardAction =
  | { readonly kind: 'faction'; readonly id: string }
  | { readonly kind: 'role' | 'size' | 'seed'; readonly step: 1 | -1 }
  | { readonly kind: 'light'; readonly id: LightPresetId }
  | { readonly kind: 'drive'; readonly id: DrivePresetId }
  | { readonly kind: 'view'; readonly id: YardView }
  | { readonly kind: 'silhouette' | 'scale' }
  | { readonly kind: 'backdrop'; readonly id: YardBackdrop }
  | { readonly kind: 'link' | 'exit' };

export interface YardPanelState {
  readonly selection: YardSelection;
  readonly factionName: string;
  readonly light: LightPresetId;
  readonly drive: DrivePresetId;
  readonly view: YardView;
  readonly silhouette: boolean;
  readonly scale: boolean;
  readonly backdrop: YardBackdrop;
  readonly header: ShipRegistryHeader | null;
  readonly specs: readonly SpecLine[];
  /** The link named a ship generation older than this build. */
  readonly stale: boolean;
}

export interface YardPanelOptions {
  readonly factions: readonly { readonly id: string; readonly label: string }[];
  readonly lights: readonly LightPresetId[];
  readonly drives: readonly DrivePresetId[];
  readonly views: readonly YardView[];
  readonly mount?: HTMLElement;
}

/** Short labels where the preset id is long. */
const VIEW_LABEL: Record<YardView, string> = {
  free: 'free',
  side: 'side',
  front: 'front',
  'three-quarter': '3/4',
  engine: 'engine',
  detail: 'detail',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class YardPanel {
  onAction: (a: YardAction) => void = () => {};

  private readonly mount: HTMLElement;
  private root: HTMLElement | null = null;
  private veil: HTMLElement | null = null;
  private titleName: HTMLElement | null = null;
  private titleClass: HTMLElement | null = null;
  private linkBtn: HTMLButtonElement | null = null;
  private roleVal: HTMLElement | null = null;
  private sizeVal: HTMLElement | null = null;
  private seedVal: HTMLElement | null = null;
  private regName: HTMLElement | null = null;
  private regLine: HTMLElement | null = null;
  private specList: HTMLElement | null = null;
  private staleNote: HTMLElement | null = null;
  /** Every option word, keyed `group:id`, so render only flips attributes. */
  private readonly options = new Map<string, HTMLElement>();
  private linkTimer = 0;

  constructor(private readonly opts: YardPanelOptions) {
    this.mount = opts.mount ?? (document.getElementById('ui-root') as HTMLElement | null) ?? document.body;
  }

  /** Build the DOM. Hidden until `show(true)`. */
  build(): void {
    if (this.root) return;
    this.injectStyle();

    // The veil lives OUTSIDE the panel root: it has to keep fading after the
    // panel is hidden, across the cut back to flight.
    const veil = el('div', 'os-yard-veil');
    this.mount.appendChild(veil);
    this.veil = veil;

    const root = el('div', 'os-yard');
    root.setAttribute('aria-hidden', 'true');

    // -- masthead ---------------------------------------------------------
    const head = el('header', 'os-yd-head');
    head.append(el('span', 'ti', 'The Yard'), el('span', 'sep', '·'));
    this.titleName = el('span', 'nm');
    this.titleClass = el('span', 'cl');
    head.append(this.titleName, this.titleClass, el('span', 'sp'));
    const link = el('button', 'os-yd-btn', '⎘ link');
    link.title = 'Copy a link to this ship';
    link.addEventListener('click', () => this.onAction({ kind: 'link' }));
    this.linkBtn = link;
    const esc = el('button', 'os-yd-btn', 'esc');
    esc.title = 'Leave the yard';
    esc.addEventListener('click', () => this.onAction({ kind: 'exit' }));
    head.append(link, esc);

    // -- controls ---------------------------------------------------------
    const ctl = el('aside', 'os-yd-ctl');
    ctl.append(
      this.wordRow(
        'faction',
        this.opts.factions.map((f) => ({ id: f.id, label: f.label })),
        (id) => this.onAction({ kind: 'faction', id }),
      ),
    );
    this.roleVal = this.stepRow(ctl, 'role', 'role');
    this.sizeVal = this.stepRow(ctl, 'size', 'size');
    this.seedVal = this.stepRow(ctl, 'seed', 'seed');
    ctl.append(el('div', 'gap'));
    ctl.append(
      this.wordRow(
        'light',
        this.opts.lights.map((id) => ({ id, label: id })),
        (id) => this.onAction({ kind: 'light', id: id as LightPresetId }),
      ),
      this.wordRow(
        'drive',
        this.opts.drives.map((id) => ({ id, label: id })),
        (id) => this.onAction({ kind: 'drive', id: id as DrivePresetId }),
      ),
      this.wordRow(
        'view',
        this.opts.views.map((id) => ({ id, label: VIEW_LABEL[id] })),
        (id) => this.onAction({ kind: 'view', id: id as YardView }),
      ),
      this.wordRow(
        'show',
        [
          { id: 'silhouette', label: 'silhouette' },
          { id: 'scale', label: 'scale' },
        ],
        (id) => this.onAction({ kind: id as 'silhouette' | 'scale' }),
      ),
      this.wordRow(
        'backdrop',
        [
          { id: 'void', label: 'void' },
          { id: 'anchorage', label: 'anchorage' },
        ],
        (id) => this.onAction({ kind: 'backdrop', id: id as YardBackdrop }),
      ),
    );

    // -- registry page ----------------------------------------------------
    const spec = el('aside', 'os-yd-spec');
    this.regName = el('div', 'rn');
    this.regLine = el('div', 'rl');
    this.specList = el('div', 'rows');
    this.staleNote = el('div', 'stale', 'registered under an older yard standard');
    spec.append(this.regName, this.regLine, this.specList, this.staleNote);

    // -- footer -----------------------------------------------------------
    const foot = el('footer', 'os-yd-foot');
    for (const [k, v] of [
      ['drag', 'orbit'],
      ['wheel', 'zoom'],
      ['← →', 'seed'],
      ['↑ ↓', 'role'],
      ['F', 'fit'],
      ['Esc', 'back'],
    ] as const) {
      const s = el('span');
      s.append(el('b', undefined, k), document.createTextNode(` ${v}`));
      foot.append(s);
    }
    const note = el('span', 'rt', 'registry only — hulls are not flown from the yard');
    foot.append(note);

    root.append(head, ctl, spec, foot);
    this.mount.appendChild(root);
    this.root = root;
  }

  show(on: boolean): void {
    if (!this.root) return;
    this.root.classList.toggle('is-on', on);
    this.root.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  /**
   * Fade the veil to `opacity` over `seconds`. Black at 1. Driven by a CSS
   * transition so it keeps moving on a frame the main thread spends building.
   */
  setVeil(opacity: number, seconds: number): void {
    const v = this.veil;
    if (!v) return;
    v.style.transitionDuration = `${Math.max(0, seconds)}s`;
    v.style.opacity = String(opacity);
  }

  /** Cheap: text and attributes only. Call when the state changed, not per frame. */
  render(s: YardPanelState): void {
    const sel = s.selection;
    if (this.titleName) this.titleName.textContent = s.factionName;
    if (this.titleClass) this.titleClass.textContent = s.header?.className ?? '';
    if (this.roleVal) this.roleVal.textContent = sel.role;
    if (this.sizeVal) this.sizeVal.textContent = sel.sizeClass;
    if (this.seedVal) this.seedVal.textContent = sel.seed.toString(16).toUpperCase().padStart(8, '0');

    this.mark('faction', sel.factionId);
    this.mark('light', s.light);
    this.mark('drive', s.drive);
    this.mark('view', s.view);
    this.mark('backdrop', s.backdrop);
    this.options.get('show:silhouette')?.setAttribute('data-on', s.silhouette ? '1' : '0');
    this.options.get('show:scale')?.setAttribute('data-on', s.scale ? '1' : '0');

    if (this.regName) this.regName.textContent = s.header?.name ?? '';
    if (this.regLine) {
      const h = s.header;
      this.regLine.textContent = h ? [h.registry || '— unregistered —', h.operator].filter(Boolean).join('  ·  ') : '';
    }
    if (this.specList) {
      const list = this.specList;
      list.replaceChildren();
      for (const line of s.specs) {
        const row = el('div', 'rw');
        // A fixed-width label column and a leader that fills the gap, so the
        // values align on one rail the way the scanner's own rows do.
        row.append(el('span', 'lb', line.label), el('span', 'ld'), el('span', 'vl', line.value));
        list.appendChild(row);
      }
    }
    if (this.staleNote) this.staleNote.style.display = s.stale ? 'block' : 'none';
  }

  /** Brief acknowledgement on the LINK button. */
  flashLink(text: string): void {
    const b = this.linkBtn;
    if (!b) return;
    b.textContent = text;
    b.setAttribute('data-on', '1');
    window.clearTimeout(this.linkTimer);
    this.linkTimer = window.setTimeout(() => {
      b.textContent = '⎘ link';
      b.setAttribute('data-on', '0');
    }, 1400);
  }

  dispose(): void {
    window.clearTimeout(this.linkTimer);
    this.root?.remove();
    this.veil?.remove();
    this.root = null;
    this.veil = null;
    this.options.clear();
  }

  // -------------------------------------------------------------------------

  private mark(group: string, id: string): void {
    for (const [key, node] of this.options) {
      if (!key.startsWith(`${group}:`)) continue;
      node.setAttribute('data-on', key === `${group}:${id}` ? '1' : '0');
    }
  }

  private wordRow(
    group: string,
    items: readonly { id: string; label: string }[],
    pick: (id: string) => void,
  ): HTMLElement {
    const row = el('div', 'row');
    row.append(el('span', 'k', group));
    const words = el('span', 'v');
    for (const it of items) {
      const b = el('button', 'w', it.label);
      b.addEventListener('click', () => pick(it.id));
      this.options.set(`${group}:${it.id}`, b);
      words.append(b);
    }
    row.append(words);
    return row;
  }

  private stepRow(parent: HTMLElement, label: string, kind: 'role' | 'size' | 'seed'): HTMLElement {
    const row = el('div', 'row');
    row.append(el('span', 'k', label));
    const v = el('span', 'v step');
    const prev = el('button', 'ar', '◂');
    const next = el('button', 'ar', '▸');
    const val = el('span', 'cur');
    prev.addEventListener('click', () => this.onAction({ kind, step: -1 }));
    next.addEventListener('click', () => this.onAction({ kind, step: 1 }));
    v.append(prev, val, next);
    row.append(v);
    parent.append(row);
    return val;
  }

  private injectStyle(): void {
    if (document.getElementById('os-yard-style')) return;
    const s = document.createElement('style');
    s.id = 'os-yard-style';
    s.textContent = YARD_CSS;
    document.head.appendChild(s);
  }
}

const YARD_CSS = /* css */ `
.os-yard-veil {
  position: absolute; inset: 0; z-index: 22;
  background: #000; opacity: 0; pointer-events: none;
  transition-property: opacity; transition-timing-function: ease-in-out;
}
.os-yard {
  --amber: #ffb454;
  --ink: #b9c6cc;
  --lab: #6f7c84;
  --lead: #2c3238;
  --rule: rgba(120,101,74,0.34);
  position: absolute; inset: 0; z-index: 23;
  pointer-events: none;
  color: var(--ink);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-variant-ligatures: none;
  font-size: 11px;
  opacity: 0; transition: opacity 0.45s ease;
  text-shadow: 0 0 2px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.75);
}
.os-yard.is-on { opacity: 1; }
.os-yard * { box-sizing: border-box; border-radius: 0; }
.os-yard button {
  font: inherit; color: inherit; background: none; border: none; padding: 0;
  cursor: pointer; text-shadow: inherit;
}
.os-yard.is-on button { pointer-events: auto; }

/* Masthead: a registry's running head, a hairline under it, nothing boxed. */
.os-yd-head {
  position: absolute; left: 28px; right: 28px; top: 20px;
  display: flex; align-items: baseline; gap: 12px;
  padding-bottom: 9px; border-bottom: 1px solid var(--rule);
  text-transform: uppercase; letter-spacing: 0.14em;
}
.os-yd-head .ti { color: var(--amber); font-size: 15px; letter-spacing: 0.24em; }
.os-yd-head .sep { color: #4a4238; }
.os-yd-head .nm { color: #c9c2b4; font-size: 12px; }
.os-yd-head .cl { color: var(--lab); font-size: 10px; text-transform: none; letter-spacing: 0.06em; }
.os-yd-head .sp { flex: 1; }
.os-yd-btn {
  color: var(--lab) !important; font-size: 10px; letter-spacing: 0.16em;
  text-transform: uppercase; padding: 2px 0 !important; margin-left: 14px;
}
.os-yd-btn:hover, .os-yd-btn[data-on="1"] { color: var(--amber) !important; }

/* Controls: a narrow left margin. Label column, then the choices as words. */
.os-yd-ctl {
  position: absolute; left: 28px; top: 72px; width: 360px;
  display: flex; flex-direction: column; gap: 9px;
}
.os-yd-ctl .gap { height: 8px; }
.os-yd-ctl .row { display: flex; align-items: baseline; gap: 10px; }
.os-yd-ctl .k {
  flex: none; width: 66px; color: var(--lab); font-size: 9px;
  letter-spacing: 0.18em; text-transform: uppercase;
}
.os-yd-ctl .v { display: flex; flex-wrap: wrap; gap: 4px 11px; }
.os-yd-ctl .w { color: #7f8a91; }
.os-yd-ctl .w:hover { color: #cfd8dc; }
/* Selected: amber, with the instrument's pointer. The only warm ink here. */
.os-yd-ctl .w[data-on="1"] { color: var(--amber); }
.os-yd-ctl .w[data-on="1"]::before { content: "\\25b8"; margin-right: 3px; }
.os-yd-ctl .step { gap: 8px; align-items: baseline; }
.os-yd-ctl .ar { color: var(--lab); padding: 0 2px !important; }
.os-yd-ctl .ar:hover { color: var(--amber); }
.os-yd-ctl .cur { color: #d6dde0; min-width: 9ch; text-align: center; font-variant-numeric: tabular-nums; }

/* The registry page: right margin, dot-leader readout in three tones. */
.os-yd-spec {
  position: absolute; right: 28px; top: 72px; width: 318px;
}
.os-yd-spec .rn {
  color: #c9c2b4; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase;
}
.os-yd-spec .rl {
  color: var(--lab); font-size: 10px; letter-spacing: 0.08em; margin: 3px 0 11px;
  padding-bottom: 8px; border-bottom: 1px solid rgba(120,101,74,0.2);
}
.os-yd-spec .rows { display: flex; flex-direction: column; gap: 3px; line-height: 1.55; }
.os-yd-spec .rw { display: flex; align-items: baseline; gap: 6px; white-space: nowrap; }
.os-yd-spec .lb { color: var(--lab); flex: none; }
/* The leader is a dotted rule that fills whatever the label leaves, so the
   values sit on one rail without a monospace dot count to maintain. */
.os-yd-spec .ld { flex: 1; min-width: 12px; border-bottom: 1px dotted var(--lead); transform: translateY(-3px); }
.os-yd-spec .vl { color: var(--ink); flex: none; max-width: 210px; overflow: hidden; text-overflow: ellipsis; }
.os-yd-spec .stale {
  display: none; margin-top: 12px; color: var(--amber); font-size: 10px;
  letter-spacing: 0.1em; text-transform: uppercase;
}

.os-yd-foot {
  position: absolute; left: 28px; right: 28px; bottom: 18px;
  display: flex; gap: 22px; padding-top: 8px; border-top: 1px solid var(--rule);
  color: #6a737b; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
}
.os-yd-foot b { color: #8d979e; font-weight: normal; }
.os-yd-foot .rt { margin-left: auto; text-transform: none; letter-spacing: 0.04em; color: #545c63; }

@media (max-width: 980px) {
  .os-yd-spec { top: auto; bottom: 52px; width: 280px; }
  .os-yd-foot .rt { display: none; }
}
`;
