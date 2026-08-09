/**
 * The codex — the ship's log, made readable.
 *
 * `ui:toggle-codex` has been on the bus and bound to KeyC since the input map
 * was written, and nothing has ever listened to it. This is the listener.
 *
 * It is deliberately a *document* rather than an instrument. The star map is
 * chrome: uppercase, cyan, gridded, alive. The log is paper. The frame keeps
 * the ship's typographic register — uppercase labels, amber and cyan — but the
 * entries themselves stay in the lower case the scanner writes in, because
 * what is on the page is not the ship talking, it is what the ship found.
 */

import { bus } from '@/core/EventBus';
import type { GameModule } from '@/core/Engine';
import { activeShotName, registerShot } from '@/game/Shots';
import { planetScan } from '@/gen/scan';
import type { LogEntry, LogKind, ShipLog } from '@/game/Log';
import type { Universe } from '@/game/Universe';

export interface CodexOptions {
  readonly log: ShipLog;
  readonly mount?: HTMLElement;
}

/** Filter tabs, in the order they read. */
const FILTERS: ReadonlyArray<{ key: 'all' | LogKind; label: string }> = [
  { key: 'all', label: 'everything' },
  { key: 'world', label: 'worlds' },
  { key: 'landing', label: 'landings' },
  { key: 'contact', label: 'contacts' },
  { key: 'arrival', label: 'systems' },
];

/** Seconds for the open/close ease. Matches the star map's cadence. */
const FADE = 0.22;

/** "1 system", not "1 systems" — the header is read every time the log opens. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** `label ..... value` as written by the scanner. Nothing else matches this. */
const READOUT = /^([a-z ]+?) (\.{2,}) (.*)$/;

/**
 * One line of an entry body, split into its three tones.
 *
 * A dot leader exists to be *quieter* than the things it joins — that is its
 * entire function. Rendered as one flat colour, as this was, the dots carry
 * the same weight as the data and a ten-row readout becomes a grey wall you
 * cannot scan. Three tones: leader faintest, label dim, value brightest.
 *
 * Lines that are not readouts — the prose notes, the landing summary — are the
 * only in-world writing in the log, and they get their own treatment rather
 * than being set as if they were another table row.
 */
function bodyLine(line: string): HTMLElement {
  const el = document.createElement('div');
  const m = READOUT.exec(line);
  if (!m) {
    el.className = 'pr';
    el.textContent = line;
    return el;
  }
  el.className = 'rw';
  const label = document.createElement('span');
  label.className = 'lb';
  label.textContent = m[1]!;
  const lead = document.createElement('span');
  lead.className = 'ld';
  lead.textContent = ` ${m[2]!} `;
  const value = document.createElement('span');
  value.className = 'vl';
  value.textContent = m[3]!;
  el.append(label, lead, value);
  return el;
}

export class Codex implements GameModule {
  readonly name = 'codex';

  private readonly log: ShipLog;
  private readonly mount: HTMLElement;

  private root: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private statsEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private readonly tabs: HTMLElement[] = [];

  private open = false;
  /** 0..1, eased. Drives opacity and the slide so nothing pops. */
  private amount = 0;
  private filter: 'all' | LogKind = 'all';
  /** Set when the model changed and the DOM has not caught up. */
  private dirty = true;

  private readonly disposers: Array<() => void> = [];
  private onKey: ((ev: KeyboardEvent) => void) | null = null;

  constructor(opts: CodexOptions) {
    this.log = opts.log;
    this.mount =
      opts.mount ?? (document.getElementById('ui-root') as HTMLElement) ?? document.body;
  }

  init(): void {
    this.injectStyle();
    this.buildDom();

    this.disposers.push(
      bus.on('ui:toggle-codex', () => this.toggle()),
      // Anything that writes to the log invalidates the rendered list. Cheaper
      // and more honest than diffing: the list is rebuilt only while open.
      bus.on('scan:complete', () => {
        this.dirty = true;
      }),
      bus.on('system:entered', () => {
        this.dirty = true;
      }),
      bus.on('planet:landed', () => {
        this.dirty = true;
      }),
      // The chart and the log are both full-screen reading surfaces. Two at
      // once is unreadable, and the star map already stands flight input down.
      bus.on('ui:map-opened', () => {
        if (this.open) this.setOpen(false);
      }),
    );

    // Escape closes, and while the log is up the flight keys must not reach
    // the ship — you should be able to read without drifting into a moon.
    this.onKey = (ev) => {
      if (!this.open) return;
      if (ev.code === 'Escape') {
        this.setOpen(false);
        ev.stopPropagation();
        ev.preventDefault();
        return;
      }
      if (ev.code === 'KeyC') return; // let the toggle through
      ev.stopPropagation();
    };
    // Capture phase: ahead of the input system, which listens on window.
    window.addEventListener('keydown', this.onKey, true);
  }

  update(dt: number): void {
    // Shots do not reset each other — whatever the previous one left on stays
    // on. `codex-log` opened this sheet and `game-opening` inherited it, which
    // is the same defect the showroom hit when a LOD survived into the next
    // frame. The module that owns the state closes it.
    const shot = activeShotName();
    if (shot !== null && shot !== 'codex-log' && this.open) this.setOpen(false);

    const target = this.open ? 1 : 0;
    if (this.amount === target) return;
    const step = dt / FADE;
    this.amount =
      target > this.amount
        ? Math.min(1, this.amount + step)
        : Math.max(0, this.amount - step);
    const root = this.root;
    if (!root) return;
    root.style.setProperty('--os-t', this.amount.toFixed(3));
    root.style.display = this.amount <= 0 ? 'none' : 'block';
    root.classList.toggle('is-live', this.open && this.amount > 0.5);
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    if (open) {
      if (this.root) this.root.style.display = 'block';
      this.dirty = true;
      this.render();
    }
  }

  // ------------------------------------------------------------ rendering

  private setFilter(key: 'all' | LogKind): void {
    this.filter = key;
    for (const t of this.tabs) t.dataset.on = t.dataset.k === key ? '1' : '0';
    this.dirty = true;
    this.render();
  }

  private render(): void {
    if (!this.listEl || !this.statsEl || !this.emptyEl) return;
    if (!this.dirty && this.open) return;
    this.dirty = false;

    // The counts live on the register below, not here. Listing "4 worlds ·
    // 1 landing · 0 contacts · 1 system" directly above a row reading "worlds
    // landings contacts systems" printed the same five words twice, stacked.
    const s = this.log.summary();
    this.statsEl.textContent = count(s.entries, 'entry').replace('entrys', 'entries');
    for (const t of this.tabs) {
      const key = t.dataset.k as 'all' | LogKind;
      const n =
        key === 'all'
          ? s.entries
          : key === 'world'
            ? s.worlds
            : key === 'landing'
              ? s.landings
              : key === 'contact'
                ? s.contacts
                : s.systems;
      t.textContent = `${t.dataset.label} ${n}`;
    }

    const entries =
      this.filter === 'all' ? this.log.all() : this.log.byKind(this.filter);

    this.emptyEl.style.display = entries.length === 0 ? 'block' : 'none';

    // Rebuilt wholesale rather than diffed. The list is only ever assembled
    // while the log is open and the game is not being flown, so the cost is
    // paid at a moment when nothing is competing for the frame.
    const frag = document.createDocumentFragment();
    let lastSystem = '';
    for (const e of entries) {
      if (e.system !== lastSystem) {
        lastSystem = e.system;
        const h = document.createElement('div');
        h.className = 'os-cx-sys';
        h.textContent = e.system;
        frag.appendChild(h);
      }
      frag.appendChild(this.entryNode(e));
    }
    this.listEl.replaceChildren(frag);
  }

  private entryNode(e: LogEntry): HTMLElement {
    const node = document.createElement('article');
    node.className = 'os-cx-entry';
    node.dataset.kind = e.kind;

    const head = document.createElement('header');
    const title = document.createElement('span');
    title.className = 'ti';
    title.textContent = e.title;
    const meta = document.createElement('span');
    meta.className = 'mt';
    meta.textContent =
      this.log.stampOf(e) + (e.visits > 1 ? ` · ${e.visits} visits` : '');
    head.append(title, meta);

    const body = document.createElement('div');
    body.className = 'bd';
    for (const line of e.body) body.appendChild(bodyLine(line));

    node.append(head, body);
    return node;
  }

  // ------------------------------------------------------------ DOM build

  private buildDom(): void {
    const root = document.createElement('div');
    root.className = 'os-codex';
    root.style.display = 'none';
    root.style.setProperty('--os-t', '0');
    root.innerHTML = CODEX_HTML;
    this.mount.appendChild(root);
    this.root = root;

    this.listEl = root.querySelector('.os-cx-list');
    this.statsEl = root.querySelector('.os-cx-stats');
    this.emptyEl = root.querySelector('.os-cx-empty');

    const tabHost = root.querySelector('.os-cx-tabs');
    if (tabHost) {
      for (const f of FILTERS) {
        const b = document.createElement('button');
        b.className = 'os-cx-tab';
        b.dataset.k = f.key;
        b.dataset.label = f.label;
        b.dataset.on = f.key === 'all' ? '1' : '0';
        b.textContent = f.label;
        b.addEventListener('click', () => this.setFilter(f.key));
        tabHost.appendChild(b);
        this.tabs.push(b);
      }
    }

    // Clicking off the sheet closes it. That, plus Esc and C, replaced a
    // boxed "esc" pill in the corner — the only web keycap on the screen, and
    // a second close affordance in a second visual language.
    root.querySelector('.os-cx-veil')?.addEventListener('click', () => this.setOpen(false));
  }

  private injectStyle(): void {
    if (document.getElementById('os-codex-style')) return;
    const el = document.createElement('style');
    el.id = 'os-codex-style';
    el.textContent = CODEX_CSS;
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

/**
 * Review shot.
 *
 * Seeded through the bus rather than by reaching into the log, so the shot
 * exercises exactly the path the game uses. A fixture that wrote entries
 * directly would keep photographing well after the subscriptions broke.
 */
export function registerCodexShots(codex: Codex, universe: Universe, log: ShipLog): void {
  registerShot({
    name: 'codex-log',
    live: true,
    description:
      "The ship's log open over the running game: system headers, scanned " +
      'worlds with their full dot-leader readouts, a landing, the summary ' +
      'line and the filter tabs. Judge the typographic register — uppercase ' +
      'chrome around lower-case findings — and whether the page reads as a ' +
      'document rather than as another instrument.',
    apply() {
      const system = universe.system;
      bus.emit('system:entered', { system });
      for (const p of system.planets.slice(0, 3)) {
        // Hours of mission time between findings. Without this every entry
        // carries the same stamp and the log looks like it was written in one
        // instant, which is the opposite of what it is for.
        log.update(4200 + p.orbit.period * 1e-4);
        bus.emit('scan:complete', planetScan(p));
        const moon = p.moons[0];
        if (moon) {
          log.update(9000);
          bus.emit('scan:complete', planetScan(moon));
        }
      }
      const landed = system.planets[0];
      if (landed) {
        log.update(26_000);
        bus.emit('planet:landed', { planet: landed });
      }
      codex.setOpen(true);
    },
  });
}

const CODEX_HTML = /* html */ `
<div class="os-cx-veil"></div>
<section class="os-cx-sheet">
  <header class="os-cx-head">
    <div class="os-cx-title">ship&rsquo;s log</div>
    <div class="os-cx-stats"></div>
  </header>
  <nav class="os-cx-tabs"></nav>
  <div class="os-cx-scroll">
    <div class="os-cx-list"></div>
    <p class="os-cx-empty">
      nothing recorded yet.<br>
      fly to a world and sweep it with <b>t</b>.
    </p>
  </div>
  <footer class="os-cx-foot">
    <span>esc or c &mdash; close</span>
    <span class="rt">recorded aboard, in transit</span>
  </footer>
</section>
`;

const CODEX_CSS = /* css */ `
.os-codex {
  --amber: #ffb454;
  --cyan: #5fd7e0;
  --dim: #6b7a85;
  --t: var(--os-t, 0);
  position: absolute;
  inset: 0;
  z-index: 24;
  opacity: var(--t);
  pointer-events: none;
  color: #cfd8dc;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-variant-ligatures: none;
}
.os-codex.is-live { pointer-events: auto; }
.os-codex * { border-radius: 0; box-sizing: border-box; }

.os-cx-veil {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 120% 90% at 50% 40%, rgba(2,5,7,0.72) 0%, rgba(1,3,4,0.95) 100%);
  backdrop-filter: blur(2px) saturate(0.7);
}

/* The sheet has to read as an OBJECT lying on the image, not as a rectangle
   cut out of it. Two things do that work: a substrate a few steps above the
   game's black rather than level with it, and a warm edge — the chrome
   elsewhere in this game is cyan, and a cyan frame would make the log another
   instrument. The warm rule is the one place the log disagrees with the ship. */
.os-cx-sheet {
  position: absolute;
  left: 50%; top: 50%;
  transform: translate(-50%, calc(-50% + (1 - var(--t)) * 14px));
  /* Narrowed to what the content actually uses. At 680 a 250px band down the
     right of the sheet held nothing but four timestamps — 27% of the measure,
     dead, with the entry separators running out into it. */
  width: min(566px, 86vw);
  height: min(74vh, 760px);
  display: flex; flex-direction: column;
  background:
    linear-gradient(180deg, rgba(19,20,20,0.985) 0%, rgba(14,15,16,0.985) 42%,
                            rgba(10,11,12,0.99) 100%);
  border: 1px solid rgba(120,101,74,0.55);
  box-shadow:
    inset 0 1px 0 rgba(255,180,84,0.07),
    0 0 0 1px rgba(0,0,0,0.75),
    0 30px 90px rgba(0,0,0,0.8);
}
/* Grain, and it has to be genuinely aperiodic.
   The first attempt used two repeating-linear-gradients at 2px and 3px, which
   is not grain — it is an aperture grille, mathematically perfect, and it read
   as a CRT. That is the exact opposite of the brief: a screen where the page
   was supposed to be. Fractal noise has no period to find. */
.os-cx-sheet::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  opacity: 0.5; mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)' opacity='0.16'/%3E%3C/svg%3E");
}

.os-cx-head {
  display: flex; align-items: baseline; gap: 14px;
  padding: 15px 18px 11px;
  border-bottom: 1px solid rgba(120,101,74,0.34);
  text-transform: uppercase; letter-spacing: 0.12em;
}
/* A masthead, not a slightly larger label. It was 10px against the entry
   titles' 9px — a 1.1x difference that letterspacing alone had to carry. */
.os-cx-title { color: var(--amber); font-size: 17px; letter-spacing: 0.2em; }
.os-cx-stats {
  color: #78818a; font-size: 10px; flex: 1; letter-spacing: 0.08em;
  text-align: right;
}

/* Not a tab bar. A register line, the way an index sits on a printed sheet:
   the filters read as entries in a list, and the current one is marked rather
   than underlined. The underline was also misaligned — it spanned the button's
   padding, so it started 12px left of the word it belonged to. */
.os-cx-tabs {
  display: flex; gap: 18px; padding: 7px 18px;
  border-bottom: 1px solid rgba(120,101,74,0.28);
}
.os-cx-tab {
  background: none; border: none; padding: 0; cursor: pointer;
  color: var(--dim); font: inherit; font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.12em;
}
/* No marker glyph. A "· " prefix pushed the whole register 15px off the 640
   rail that every other element on the sheet sits on, for a distinction the
   amber already makes. */
.os-cx-tab[data-on="1"] { color: var(--amber); }
.os-cx-tab:hover { color: #cfd8dc; }

.os-cx-scroll {
  flex: 1; overflow-y: auto; padding: 4px 18px 18px;
  scrollbar-width: thin; scrollbar-color: rgba(120,101,74,0.5) transparent;
  /* The list is cut by the footer rule otherwise, mid-glyph, which reads as a
     rendering fault rather than as more text below. Fade the last few pixels
     so the cut is legibly deliberate. */
  -webkit-mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 34px), transparent 100%);
          mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 34px), transparent 100%);
}
/* The scrollbar is the only signal that there is more below. It has to be
   visible, not merely present — the fade alone reads as a cropped render. */
.os-cx-scroll::-webkit-scrollbar { width: 6px; }
.os-cx-scroll::-webkit-scrollbar-track { background: rgba(0,0,0,0.35); }
.os-cx-scroll::-webkit-scrollbar-thumb { background: rgba(150,127,93,0.75); }

/* Warm, not cyan. Cyan is the instruments' colour, and this was the only cyan
   surface inside the document — the grouping device borrowing the voice the
   log is supposed to be distinct from. */
.os-cx-sys {
  color: #b08a52; font-size: 10px; letter-spacing: 0.22em;
  text-transform: uppercase; margin: 20px 0 2px;
  padding-bottom: 5px; border-bottom: 1px solid rgba(120,101,74,0.4);
}
.os-cx-sys:first-child { margin-top: 8px; }

/* The rule belonged to the entry BELOW it before: 19px of air above, 11 below,
   so every entry started pressed against its own separator. */
.os-cx-entry { padding: 14px 0 15px; border-bottom: 1px solid rgba(120,101,74,0.16); }
.os-cx-entry:last-child { border-bottom: none; }
.os-cx-entry header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 7px; }
/* Titles are dim-warm, not white. White was the brightest thing on the sheet,
   which made routine scans shout louder than the amber landings. */
.os-cx-entry .ti {
  color: #c9c2b4; font-size: 12px; letter-spacing: 0.07em; text-transform: uppercase;
}
/* Was 3.0:1 against the sheet. A date you cannot read is not a date. */
.os-cx-entry .mt {
  color: #7d858d; font-size: 10px; letter-spacing: 0.08em; margin-left: auto;
  flex: none; font-variant-numeric: tabular-nums;
}
.os-cx-entry .bd { font-size: 11px; line-height: 1.7; }
/* Three tones. The leader is the quietest thing on the page by design. */
.os-cx-entry .rw { white-space: pre; }
.os-cx-entry .rw .lb { color: #6f7c84; }
.os-cx-entry .rw .ld { color: #363c42; }
.os-cx-entry .rw .vl { color: #b9c6cc; }
/* Prose is the only in-world writing in the log. It is indented off the data
   rail and set in a warmer ink so it does not read as another table row.
   Consecutive prose lines must not each carry their own border — that left a
   3px tear in the rule between them, which reads as a rendering seam. Zero
   vertical margin keeps the rule continuous; spacing comes from padding on
   the run as a whole. */
.os-cx-entry .pr {
  color: #a09b93; padding: 1px 0 1px 14px; margin: 0;
  border-left: 1px solid rgba(120,101,74,0.34);
  max-width: 58ch;
}
.os-cx-entry .pr:first-child { padding-top: 3px; }
.os-cx-entry .pr:last-child { padding-bottom: 3px; }
.os-cx-entry[data-kind="landing"] .ti { color: var(--amber); }
.os-cx-entry[data-kind="contact"] .ti { color: var(--cyan); }

.os-cx-empty {
  color: var(--dim); font-size: 11px; line-height: 1.9;
  text-align: center; padding: 60px 0;
}
.os-cx-empty b { color: var(--amber); font-weight: normal; }

.os-cx-foot {
  display: flex; gap: 20px; padding: 9px 18px;
  border-top: 1px solid rgba(120,101,74,0.34);
  color: #79828a; font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.12em;
}
/* Measured at 2.0:1 before — the one line carrying the ship's own voice was
   the faintest pixel on the sheet. */
.os-cx-foot .rt { margin-left: auto; color: #6a727a; }
`;
