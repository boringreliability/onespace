/**
 * The conflict screen's DOM (v4 sub-plan 4, Task 6; R49). The state, texts
 * and boot orchestration are pure, in conflictScreen.ts.
 *
 * Shown over the boot veil before the world exists, and only at boot. While
 * shown it owns the keyboard (capture phase, every key stopped), so nothing
 * behind it hears a key; ← → choose, Enter keeps. There is no close button
 * and Esc does nothing: the screen ends with a choice.
 *
 * Built with createElement + textContent throughout (system and body names
 * come from the save); no inline handlers, no style attributes.
 *
 * (Named ConflictOverlay, not ConflictScreen: on a case-insensitive file
 * system ConflictScreen.ts and conflictScreen.ts are the same file.)
 */

import {
  CONFLICT_TITLE,
  conflictKey,
  conflictStep,
  keepLabel,
  type ConflictCard,
  type ConflictChoice,
  type ConflictEvent,
  type ConflictState,
} from './conflictScreen';

const STYLE_ID = 'os-conflict-style';

export class ConflictOverlay {
  private state: ConflictState | null = null;
  private root: HTMLDivElement | null = null;
  private buttons: Record<ConflictChoice, HTMLButtonElement | null> = { device: null, cloud: null };
  private cards: Record<ConflictChoice, HTMLElement | null> = { device: null, cloud: null };
  private done: ((c: ConflictChoice) => void) | null = null;

  constructor(private readonly doc: Document = document) {}

  /** Show the two cards (again) and resolve with the player's choice. */
  show(view: ConflictState): Promise<ConflictChoice> {
    this.close();
    this.state = view;
    this.build(view);
    window.addEventListener('keydown', this.onKey, true);
    return new Promise<ConflictChoice>((resolve) => {
      this.done = resolve;
    });
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.state) return;
    const k = conflictKey(e);
    if (k.preventDefault) e.preventDefault();
    e.stopPropagation();
    if (k.event && !e.repeat) this.dispatch(k.event);
  };

  private dispatch(e: ConflictEvent): void {
    if (!this.state) return;
    const r = conflictStep(this.state, e);
    this.state = r.state;
    this.render();
    if (r.effect.kind === 'choose') {
      const resolve = this.done;
      this.close();
      resolve?.(r.effect.keep);
    }
  }

  private close(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.root?.remove();
    this.root = null;
    this.state = null;
    this.done = null;
    this.buttons = { device: null, cloud: null };
    this.cards = { device: null, cloud: null };
  }

  private build(view: ConflictState): void {
    const d = this.doc;
    if (!d.getElementById(STYLE_ID)) {
      const style = d.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      d.head.appendChild(style);
    }
    const root = d.createElement('div');
    root.className = 'os-conflict';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');

    const title = d.createElement('div');
    title.className = 'os-cf-title';
    title.textContent = CONFLICT_TITLE;
    root.appendChild(title);

    const row = d.createElement('div');
    row.className = 'os-cf-row';
    root.appendChild(row);
    for (const choice of ['device', 'cloud'] as const) {
      row.appendChild(this.card(choice, choice === 'device' ? view.device : view.cloud));
    }

    const foot = d.createElement('div');
    foot.className = 'os-cf-foot';
    foot.textContent = '← → CHOOSE · ⏎ KEEP';
    root.appendChild(foot);

    d.body.appendChild(root);
    this.root = root;
    this.render();
  }

  private card(choice: ConflictChoice, c: ConflictCard): HTMLElement {
    const d = this.doc;
    const card = d.createElement('section');
    card.className = 'os-cf-card';
    const line = (cls: string, text: string): void => {
      const el = d.createElement('div');
      el.className = cls;
      el.textContent = text;
      card.appendChild(el);
    };
    line('os-cf-label', c.label);
    line('os-cf-system', c.system);
    line('os-cf-place', c.place);
    line('os-cf-stat', `TANK ${c.tank}`);
    line('os-cf-stat', `CARGO ${c.cargo}`);
    line('os-cf-ago', c.ago);
    const b = d.createElement('button');
    b.type = 'button';
    b.className = 'os-cf-btn';
    b.textContent = keepLabel(choice);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dispatch({ kind: 'click', choice });
    });
    b.addEventListener('mouseenter', () => {
      if (!this.state || this.state.choice === choice) return;
      this.dispatch({ kind: choice === 'device' ? 'left' : 'right' });
    });
    card.appendChild(b);
    this.buttons[choice] = b;
    this.cards[choice] = card;
    return card;
  }

  private render(): void {
    if (!this.state) return;
    for (const choice of ['device', 'cloud'] as const) {
      const on = this.state.choice === choice;
      this.cards[choice]?.classList.toggle('on', on);
      this.buttons[choice]?.classList.toggle('on', on);
    }
  }
}

const CSS = /* css */ `
.os-conflict {
  position: fixed; inset: 0; z-index: 200; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 1.6rem;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace; color: #a8bac6;
  background: radial-gradient(ellipse at center, rgba(3,6,8,0.9) 0%, rgba(1,2,3,0.98) 75%);
}
.os-cf-title { font-size: 1.1rem; letter-spacing: 0.45em; color: #ffd49a;
  text-shadow: 0 0 6px rgba(255,180,84,0.5), 0 0 30px rgba(255,180,84,0.15); }
.os-cf-row { display: flex; gap: 1.4rem; flex-wrap: wrap; justify-content: center; padding: 0 16px; }
.os-cf-card { width: min(260px, calc(100vw - 32px)); padding: 18px 20px 14px; display: flex; flex-direction: column; gap: 6px;
  border: 1px solid rgba(120,101,74,0.4); background: rgba(10,11,12,0.92);
  font-size: 11px; letter-spacing: 0.1em; transition: border-color 0.2s ease; }
.os-cf-card.on { border-color: #ffb454; }
.os-cf-label { color: #ffb454; letter-spacing: 0.3em; margin-bottom: 6px; }
.os-cf-system { color: #e8eef2; font-size: 13px; }
.os-cf-place, .os-cf-ago { color: #7d858d; }
.os-cf-btn { all: unset; cursor: pointer; margin-top: 10px; padding: 7px 10px; text-align: center;
  letter-spacing: 0.25em; border: 1px solid rgba(120,101,74,0.55); color: #cfd8dc; }
.os-cf-btn.on, .os-cf-btn:hover, .os-cf-btn:focus-visible { border-color: #ffb454; color: #ffb454; }
.os-cf-foot { font-size: 0.62rem; letter-spacing: 0.2em; color: #3d4a53; }
`;
