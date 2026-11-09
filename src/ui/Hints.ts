/**
 * NAV ADVISORY — one line, bottom centre, the single next useful action
 * (GAMEPLAY B6, PLAN P7). It replaces a tutorial.
 *
 * Which hint, and when one is learnt, is pure (`hintRules.ts`, tested). This
 * module reads game state, counts what the pilot actually does, persists the
 * counts, and fades the line — eased both ways, never snapped (ARCHITECTURE §6).
 *
 * Deliberately separate from the HUD: it is a voice, not an instrument.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import type { Mode } from '@/core/Modes';
import { bus } from '@/core/EventBus';
import { modes } from '@/core/Modes';
import { shotOwnsScene } from '@/game/Shots';
import type { Universe } from '@/game/Universe';
import type { RecoveryCut } from '@/game/RecoveryCut';
import type { Pause } from '@/ui/Pause';
import {
  HINT_TEXT,
  loadHintCounts,
  recordUse,
  saveHintCounts,
  selectHint,
  type HintCounts,
  type KeyValueStore,
  type RetirableHintId,
} from '@/ui/hintRules';

/** Fade time constant, seconds. */
const FADE = 0.35;
/** Below this the line is invisible and its text can be swapped unseen. */
const SWAP_AT = 0.02;

export interface HintsOptions {
  readonly universe: Universe;
  readonly pause: Pause;
  readonly recovery: RecoveryCut;
  readonly warp: { readonly phase: string };
  /**
   * [v4-fuel] The emergency exit's line ("EMERGENCY · H", or its menu). When
   * set it outranks every lesson: a dry tank is not a tutorial moment.
   */
  readonly emergency?: { readonly line: string | null };
}

function storage(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export class Hints implements GameModule {
  readonly name = 'hints';

  private counts: HintCounts = loadHintCounts(storage());
  private chartOpen = false;
  private hasTarget = false;
  private wasPaused = false;
  private throttleHeld = false;

  private el: HTMLDivElement | null = null;
  private textEl: HTMLSpanElement | null = null;
  /** The text on the line (a hint's, or the emergency line). */
  private shown: string | null = null;
  private opacity = 0;
  private lastOpacity = -1;
  private disposers: Array<() => void> = [];

  constructor(private readonly opts: HintsOptions) {}

  /**
   * Gated to flight/map (game/gating.ts). A sleeping module stops updating
   * but its DOM would stay up — "CLICK TO TAKE THE CONTROLS" over the title or
   * the Yard — so it hides itself on the way out.
   */
  onModeChange(_from: Mode, to: Mode): void {
    if (this.el) this.el.style.visibility = to === 'flight' || to === 'map' ? '' : 'hidden';
  }

  init(): void {
    this.injectStyle();
    const host = document.getElementById('ui-root') ?? document.body;
    const el = document.createElement('div');
    el.className = 'os-hint';
    el.setAttribute('aria-live', 'polite');
    const tag = document.createElement('span');
    tag.className = 'os-hint-tag';
    tag.textContent = 'NAV ADVISORY';
    const text = document.createElement('span');
    text.className = 'os-hint-text';
    el.append(tag, text);
    host.appendChild(el);
    this.el = el;
    this.textEl = text;

    this.disposers.push(
      bus.on('ui:chart', ({ chart }) => {
        this.chartOpen = chart !== null;
      }),
      bus.on('target:changed', ({ id }) => {
        this.hasTarget = id !== null;
      }),
      // A new system means the old target is gone.
      bus.on('system:entered', () => {
        this.hasTarget = false;
      }),
    );
  }

  private use(id: RetirableHintId): void {
    this.counts = recordUse(this.counts, id);
    saveHintCounts(storage(), this.counts);
  }

  update(dt: number, ctx: EngineContext): void {
    const input = ctx.input;
    const { universe, pause, recovery, warp } = this.opts;

    // Count what the pilot does whether or not its hint is showing: a pilot
    // who found T alone does not need to be told about it.
    const throttle = input.isDown('KeyW') || input.isDown('KeyS');
    if (throttle && !this.throttleHeld && input.pointerLocked) this.use('fly');
    this.throttleHeld = throttle;
    if (input.pressed('scan')) this.use('scan');
    if (input.pressed('map')) this.use('chart');
    if (input.pressed('cruise')) this.use('cruise');
    if (pause.isOpen && !this.wasPaused) this.use('pause');
    this.wasPaused = pause.isOpen;

    const codexOpen = document.querySelector('.os-codex.is-live') !== null;
    const want = shotOwnsScene()
      ? null
      : selectHint(
          {
            inFlight: modes.current === 'flight',
            pointerLocked: input.pointerLocked,
            overlayOpen: this.chartOpen || codexOpen,
            paused: pause.isOpen,
            busy: warp.phase !== 'idle' || recovery.active,
            hasTarget: this.hasTarget,
            cruising: universe.flight.cruising,
          },
          this.counts,
        );

    // [v4-fuel] The emergency line takes the slot whenever a hint could show.
    const urgent =
      !shotOwnsScene() &&
      modes.current === 'flight' &&
      !this.chartOpen &&
      !codexOpen &&
      !pause.isOpen &&
      !recovery.active &&
      warp.phase === 'idle'
        ? (this.opts.emergency?.line ?? null)
        : null;
    const wantText: string | null = urgent ?? (want ? HINT_TEXT[want] : null);

    // Fade out, swap while invisible, fade in. A changed hint never cuts.
    const goal = wantText !== null && wantText === this.shown ? 1 : 0;
    this.opacity += (goal - this.opacity) * Math.min(1, dt / FADE);
    if (Math.abs(goal - this.opacity) < 0.002) this.opacity = goal;
    if (this.opacity < SWAP_AT && wantText !== this.shown) {
      this.shown = wantText;
      if (this.textEl) this.textEl.textContent = wantText ?? '';
    }

    if (this.el && Math.abs(this.opacity - this.lastOpacity) > 0.002) {
      this.lastOpacity = this.opacity;
      this.el.style.opacity = this.opacity.toFixed(3);
    }
  }

  private injectStyle(): void {
    if (document.getElementById('os-hint-style')) return;
    const el = document.createElement('style');
    el.id = 'os-hint-style';
    el.textContent = HINT_CSS;
    document.head.appendChild(el);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.el?.remove();
    this.el = null;
    this.textEl = null;
  }
}

const HINT_CSS = /* css */ `
.os-hint {
  position: absolute; left: 50%; bottom: 13vh; transform: translateX(-50%);
  z-index: 22; opacity: 0; pointer-events: none;
  max-width: calc(100vw - 32px);
  display: flex; align-items: baseline; gap: 12px; white-space: nowrap;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-variant: small-caps; font-variant-ligatures: none;
  text-shadow: 0 0 6px rgba(255,150,40,0.25), 0 1px 2px rgba(0,0,0,0.9);
}
.os-hint-tag { color: #b08a52; font-size: 9px; letter-spacing: 0.24em; opacity: 0.8; }
.os-hint-text { color: #ffb454; font-size: 12px; letter-spacing: 0.16em; }
@media (max-width: 520px) {
  .os-hint { white-space: normal; flex-direction: column; align-items: center; gap: 4px; text-align: center; }
}
`;
