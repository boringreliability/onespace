/**
 * The title screen. It grows out of the boot veil: same typography, same
 * place, and the live opening frame already drifting behind it — the first
 * thing a player sees is the game, not a menu over black.
 *
 * Shown while modes.current === 'title'. While shown it owns the keyboard
 * (capture phase), so W on the menu never throttles the ship behind it.
 * Hidden whenever a review shot owns the scene, so harness frames stay clean.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import { modes } from '@/core/Modes';
import { config } from '@/core/Config';
import { activeShotName } from '@/game/Shots';
import { bus } from '@/core/EventBus';
import { newGameSearch } from '@/core/Route';
import { issueNewGameNonce } from '@/save/newGameNonce';
import { initialTitle, titleKey, titleLabel, titleStep, type TitleEffect, type TitleEvent, type TitleState } from './titleMenu';

/** [v4-save] Task 6: what the title knows of the save, and what CONTINUE does. */
export interface TitleOptions {
  readonly universeSeed: number;
  /** A save is loaded behind the title: CONTINUE / NEW GAME instead of UNDOCK. */
  readonly hasSave?: boolean;
  /** Called on CONTINUE before flight starts (SaveGame.continueFrom). */
  readonly onContinue?: () => void;
}

export class Title implements GameModule {
  readonly name = 'title';

  private state: TitleState;
  private root: HTMLDivElement | null = null;
  private items: HTMLButtonElement[] = [];
  private settings: HTMLDivElement | null = null;
  private seedInput: HTMLInputElement | null = null;
  private seedError: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private shown = false;

  private readonly universeSeed: number;

  constructor(private readonly opts: TitleOptions) {
    this.universeSeed = opts.universeSeed;
    this.state = initialTitle({ hasSave: opts.hasSave === true });
  }

  init(ctx: EngineContext): void {
    this.canvas = ctx.renderer.domElement;
    const host = document.getElementById('ui-root') ?? document.body;
    const root = document.createElement('div');
    root.className = 'os-title';
    root.innerHTML = `
      <div class="os-title-name">O N E S P A C E</div>
      <div class="os-title-sub">a procedurally generated noir odyssey</div>
      <div class="os-title-menu"></div>
      <div class="os-title-settings" hidden>
        <label>QUALITY <select class="os-title-tier"></select></label>
      </div>
      <div class="os-title-foot">
        <label>SEED 0x<input class="os-title-seed" spellcheck="false" maxlength="10"></label>
        <span class="os-title-seed-err"></span>
        <span class="os-title-ver">v0.2 · ↑↓ ⏎</span>
      </div>`;
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const menu = root.querySelector('.os-title-menu') as HTMLDivElement;
    this.state.items.forEach((item, i) => {
      const b = document.createElement('button');
      b.textContent = titleLabel(this.state, item);
      b.addEventListener('click', () => this.dispatch({ kind: 'click', index: i }));
      b.addEventListener('mouseenter', () => {
        // Moving to another item disarms NEW GAME, as the keys do.
        if (this.state.index !== i) this.state = { ...this.state, index: i, armed: false };
        this.render();
      });
      menu.appendChild(b);
      this.items.push(b);
    });

    this.settings = root.querySelector('.os-title-settings');
    const tier = root.querySelector('.os-title-tier') as HTMLSelectElement;
    for (const t of ['low', 'medium', 'high', 'ultra']) {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t.toUpperCase();
      o.selected = t === config.quality.tier;
      tier.appendChild(o);
    }
    tier.addEventListener('change', () => {
      const u = new URL(window.location.href);
      u.searchParams.set('tier', tier.value);
      window.location.href = u.toString();
    });

    this.seedInput = root.querySelector('.os-title-seed');
    this.seedError = root.querySelector('.os-title-seed-err');
    if (this.seedInput) {
      this.seedInput.value = (this.universeSeed >>> 0).toString(16).toUpperCase();
      this.seedInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') this.dispatch({ kind: 'seed', text: this.seedInput!.value });
      });
    }

    host.appendChild(root);
    this.root = root;
    window.addEventListener('keydown', this.onKey, true);
    this.render();
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.shown || e.target === this.seedInput) return;
    const k = titleKey(e);
    if (k.preventDefault) e.preventDefault();
    e.stopPropagation();
    if (k.event) this.dispatch(k.event);
  };

  private dispatch(e: TitleEvent): void {
    const r = titleStep(this.state, e);
    this.state = r.state;
    this.apply(r.effect);
    this.render();
  }

  private apply(effect: TitleEffect): void {
    switch (effect.kind) {
      case 'go':
        this.go(effect.mode);
        return;
      case 'continue':
        if (!modes.can('flight')) return;
        // Before flight starts: the next save continues the loaded one.
        this.opts.onContinue?.();
        this.go('flight');
        return;
      case 'newgame':
        // The first press only arms (render shows the confirmation label).
        // Confirmed: reload into a new game, carrying a one-time nonce from
        // sessionStorage — a link alone cannot do this (R17). The old save is
        // kept (src/save/boot.ts decideBoot).
        if (effect.confirmed) {
          const nonce = issueNewGameNonce(sessionStore());
          if (nonce === null) {
            bus.emit('log', { text: 'NEW GAME UNAVAILABLE — SESSION STORAGE BLOCKED', tone: 'warn' });
            return;
          }
          window.location.search = newGameSearch(window.location.search, nonce);
        }
        return;
      case 'settings':
        if (this.settings) this.settings.hidden = !this.settings.hidden;
        return;
      case 'reseed': {
        const u = new URL(window.location.href);
        u.searchParams.set('seed', effect.seed.toString(16));
        window.location.href = u.toString();
        return;
      }
      case 'none':
        return;
    }
  }

  private go(mode: 'flight' | 'yard'): void {
    if (!modes.can(mode)) return;
    modes.go(mode);
    // A click is a user gesture, so pointer lock may be taken here — the
    // player lands in flight already holding the controls.
    if (mode === 'flight') {
      try {
        // Chrome returns a promise; a refusal (no gesture, headless) is
        // harmless — the hint line asks for a click instead.
        const p = this.canvas?.requestPointerLock?.() as unknown as Promise<void> | undefined;
        p?.catch?.(() => undefined);
      } catch {
        /* older browsers throw synchronously */
      }
    }
  }

  private render(): void {
    this.items.forEach((b, i) => {
      b.classList.toggle('on', i === this.state.index);
      b.textContent = titleLabel(this.state, this.state.items[i]!);
    });
    if (this.seedError) this.seedError.textContent = this.state.seedError ?? '';
  }

  update(): void {
    const show = modes.current === 'title' && activeShotName() === null;
    if (show === this.shown || !this.root) return;
    this.shown = show;
    this.root.classList.toggle('visible', show);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.root?.remove();
  }
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

const CSS = /* css */ `
.os-title {
  position: absolute; inset: 0; z-index: 40; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 0.9rem;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace; color: #a8bac6;
  background: radial-gradient(ellipse at center, rgba(3,6,8,0.15) 0%, rgba(3,6,8,0.72) 75%);
  opacity: 0; pointer-events: none; transition: opacity 1.2s ease;
}
.os-title.visible { opacity: 1; pointer-events: auto; }
.os-title-name { font-size: 1.6rem; letter-spacing: 0.6em; color: #ffd49a;
  text-shadow: 0 0 6px rgba(255,180,84,0.5), 0 0 30px rgba(255,180,84,0.15); }
.os-title-sub { font-size: 0.68rem; letter-spacing: 0.35em; text-transform: uppercase; margin-bottom: 2rem; }
.os-title-menu { display: flex; flex-direction: column; gap: 0.5rem; align-items: center; }
.os-title-menu button { all: unset; cursor: pointer; font-size: 0.85rem; letter-spacing: 0.3em;
  padding: 0.2rem 1rem; color: #a8bac6; transition: color 0.25s ease, text-shadow 0.25s ease; }
.os-title-menu button.on { color: #ffb454; text-shadow: 0 0 6px rgba(255,180,84,0.5); }
.os-title-menu button.on::before { content: '▸ '; }
.os-title-settings { font-size: 0.7rem; letter-spacing: 0.2em; }
.os-title-settings select, .os-title-foot input { font: inherit; color: #ffb454; background: transparent;
  border: none; border-bottom: 1px solid rgba(255,180,84,0.34); outline: none; }
.os-title-foot { position: absolute; bottom: 1.4rem; left: 1.6rem; right: 1.6rem; display: flex; gap: 1rem;
  font-size: 0.62rem; letter-spacing: 0.2em; }
.os-title-foot input { width: 6.5em; text-transform: uppercase; }
.os-title-seed-err { color: #ff5f56; }
.os-title-ver { margin-left: auto; color: #3d4a53; }
`;
