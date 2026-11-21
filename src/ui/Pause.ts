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
import { modes } from '@/core/Modes';
import { Config, config, type QualityTier } from '@/core/Config';
import { shotOwnsScene } from '@/game/Shots';
import type { Universe } from '@/game/Universe';
import type { RecoveryCut } from '@/game/RecoveryCut';
import {
  DELETE_DISARMED,
  PAUSE_CLOSED,
  deleteAccountLabel,
  deleteAccountStep,
  initialSyncNotice,
  pauseAccountView,
  pauseContextFor,
  pauseControls,
  pauseStep,
  returnToOrbitLabel,
  syncNoticeStep,
  type DeleteAccountEvent,
  type DeleteAccountState,
  type PauseEvent,
  type PauseState,
  type SyncNoticeWatch,
} from '@/ui/pauseState';
import { renderAccountLine, runDeleteAccount, type AccountView } from '@/ui/accountMenu';
import type { SyncClient } from '@/net/SyncClient';
import {
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  loadStickSettings,
  saveStickSettings,
  type StickSettings,
} from '@/ui/stickSettings';
import {
  FLIGHT_PRESETS,
  FLIGHT_PRESET_IDS,
  activeFlightPreset,
  setActiveFlightPreset,
} from '@/game/flightPreset'; // [v2-p4]

/** Seconds for the sheet to fade. Eased, never snapped (ARCHITECTURE §6). */
const FADE = 0.22;

export interface PauseOptions {
  readonly universe: Universe;
  readonly recovery: RecoveryCut;
  /** The jump drive; a jump cannot be paused into. */
  readonly warp: { readonly phase: string };
  /**
   * The live input, so MOUSE SENSITIVITY and INVERT PITCH take effect now.
   * Without it they were only written to storage and Input — which reads
   * storage once, at construction — ignored them until a reload (review-p1).
   */
  readonly input?: { setStickSettings(s: StickSettings): void } | null;
  /** [v4-save] SAVE: the game's one writer (SaveGame). Absent: the button does nothing. */
  readonly save?: { saveNow(reason: 'manual'): Promise<boolean> } | null;
  /**
   * [v4-net] Task 6: the cloud sync — its status sits under the account line
   * and a change is logged once; DELETE ACCOUNT goes through it (R54).
   */
  readonly sync?: (Pick<SyncClient, 'status' | 'statusText'> & Partial<Pick<SyncClient, 'deleteAccount'>>) | null;
  /** [v4-net] The account the sheet shows (R51, R57); omitted = none. */
  readonly account?: AccountView;
  /** [v4-net] The account changed here (deleted): the title follows. */
  readonly onAccount?: (account: AccountView) => void;
}

type PauseSync = NonNullable<PauseOptions['sync']>;

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
  private returnBtn: HTMLButtonElement | null = null;
  private canvas: HTMLElement | null = null;
  private stick: StickSettings = loadStickSettings(storage());
  private disposers: Array<() => void> = [];

  private readonly universe: Universe;
  private readonly recovery: RecoveryCut;
  private readonly warp: { readonly phase: string };
  private readonly input: { setStickSettings(s: StickSettings): void } | null;
  private readonly save: { saveNow(reason: 'manual'): Promise<boolean> } | null;

  // [v4-net] Task 6
  private readonly sync: PauseSync | null;
  private readonly onAccount: ((account: AccountView) => void) | null;
  private account: AccountView;
  private syncWatch: SyncNoticeWatch;
  private deleteState: DeleteAccountState = DELETE_DISARMED;
  private deleting = false;
  private accountBox: HTMLDivElement | null = null;
  private syncLineEl: HTMLDivElement | null = null;
  private deleteBtn: HTMLButtonElement | null = null;
  private shownSyncLine: string | null = null;
  /** R61: an activation key is auto-repeating (held down). */
  private keyRepeating = false;

  constructor(opts: PauseOptions) {
    this.universe = opts.universe;
    this.recovery = opts.recovery;
    this.warp = opts.warp;
    this.input = opts.input ?? null;
    this.save = opts.save ?? null;
    this.sync = opts.sync ?? null;
    this.onAccount = opts.onAccount ?? null;
    this.account = opts.account ?? { kind: 'hidden' };
    // The boot's status is already in the boot notices: only changes are logged.
    this.syncWatch = this.sync
      ? initialSyncNotice(this.sync.status(), this.sync.statusText())
      : initialSyncNotice('off', null);
  }

  /** [v4-net] The account changed (signed out on the title). */
  setAccount(account: AccountView): void {
    this.account = account;
    this.deleteState = DELETE_DISARMED;
    this.renderAccount();
  }

  /** [v4-save] The SAVE button: saves when the sheet is up (SaveGame logs SAVED / SAVE FAILED). */
  requestSave(): void {
    this.dispatch({ type: 'save' });
  }

  /** Apply mouse settings for this session and persist them. */
  applyStickSettings(s: StickSettings): void {
    this.stick = s;
    saveStickSettings(storage(), s);
    this.input?.setStickSettings(s);
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
      // R61: a held key auto-repeats, and a focused <button> takes a click per
      // repeat — one long Enter on DELETE ACCOUNT armed AND confirmed it.
      // Repeats never reach a button; the first press still does.
      if (ev.code === 'Enter' || ev.code === 'NumpadEnter' || ev.code === 'Space') {
        this.keyRepeating = ev.repeat;
        if (ev.repeat) ev.preventDefault();
      }
      if (ev.code === 'Escape') {
        ev.preventDefault();
        if (!ev.repeat) this.dispatch({ type: 'escKey', t: performance.now() });
      }
      if (ev.code === 'Tab') ev.preventDefault();
      ev.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    this.disposers.push(() => window.removeEventListener('keydown', onKey, true));
    const onKeyUp = (ev: KeyboardEvent): void => {
      if (ev.code === 'Enter' || ev.code === 'NumpadEnter' || ev.code === 'Space') this.keyRepeating = false;
    };
    window.addEventListener('keyup', onKeyUp, true);
    this.disposers.push(() => window.removeEventListener('keyup', onKeyUp, true));
    // R67: a keyup that never arrives (blur, alt-tab mid-press) must not leave
    // the flag set — a later mouse click on DELETE ACCOUNT is a real press.
    const onBlur = (): void => {
      this.keyRepeating = false;
    };
    window.addEventListener('blur', onBlur);
    this.disposers.push(() => window.removeEventListener('blur', onBlur));
    const onPointerDown = (): void => {
      this.keyRepeating = false;
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    this.disposers.push(() => window.removeEventListener('pointerdown', onPointerDown, true));
  }

  private overlayOpen(): boolean {
    if (this.chartOpen) return true;
    // Photo mode releases the pointer on entry; that lock loss is not an Esc
    // and must not open the sheet underneath it (review-p1).
    if (modes.overlay !== null) return true;
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
    if (r.effect === 'save') void this.save?.saveNow('manual');
    if (this.state.open !== was) {
      // Closing the sheet disarms DELETE ACCOUNT, as leaving NEW GAME does.
      if (!this.state.open) this.deleteStep({ kind: 'closed' });
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

  // ------------------------------------------------------------ account

  private deleteStep(e: DeleteAccountEvent): void {
    const r = deleteAccountStep(this.deleteState, e);
    this.deleteState = r.state;
    if (r.effect.kind === 'deleteAccount' && r.effect.confirmed) void this.deleteAccount();
    if (this.deleteBtn) this.deleteBtn.textContent = deleteAccountLabel(this.deleteState);
  }

  private async deleteAccount(): Promise<void> {
    const sync = this.sync;
    if (this.deleting || !sync?.deleteAccount) return;
    this.deleting = true;
    try {
      const r = await runDeleteAccount({ deleteAccount: () => sync.deleteAccount!() }, this.account);
      if (r.notice) bus.emit('log', { text: r.notice, tone: 'warn' });
      if (r.account !== this.account) {
        this.account = r.account;
        this.renderAccount();
        this.onAccount?.(r.account);
      }
    } finally {
      this.deleting = false;
    }
  }

  /** The account line, the sync line under it, DELETE ACCOUNT — or none of them (R57). */
  private renderAccount(): void {
    const view = pauseAccountView(this.account, this.sync?.statusText() ?? null);
    if (this.accountBox) {
      this.accountBox.replaceChildren();
      // R52: the name by textContent only.
      const line = renderAccountLine(document, this.account);
      if (line) {
        line.classList.add('os-pz-account-line');
        this.accountBox.appendChild(line);
      }
      const sync = document.createElement('div');
      sync.className = 'os-pz-sync';
      sync.textContent = view.syncLine ?? '';
      this.accountBox.appendChild(sync);
      this.syncLineEl = sync;
      this.shownSyncLine = view.syncLine;
      this.accountBox.hidden = view.line === null;
    }
    if (this.deleteBtn) {
      this.deleteBtn.hidden = !view.deleteAccount;
      this.deleteBtn.textContent = deleteAccountLabel(this.deleteState);
    }
  }

  /** A sync status change: logged once (R56: a status without text logs nothing), and the line follows. */
  private watchSync(): void {
    const sync = this.sync;
    if (!sync) return;
    const text = sync.statusText();
    const r = syncNoticeStep(this.syncWatch, sync.status(), text);
    this.syncWatch = r.watch;
    if (r.notice) bus.emit('log', { text: r.notice, tone: 'warn' });
    const line = pauseAccountView(this.account, text).syncLine;
    if (this.syncLineEl && line !== this.shownSyncLine) {
      this.shownSyncLine = line;
      this.syncLineEl.textContent = line ?? '';
    }
  }

  update(dt: number, ctx: EngineContext): void {
    this.watchSync();

    // Esc with the pointer free arrives as a key, through Input as usual.
    if (!this.state.open && ctx.input.pressed('pause')) {
      this.dispatch({ type: 'escKey', t: performance.now() });
    }

    // A mode overlay (photo) freezes the world too: no module declares
    // `activeIn` yet (D16), so tick.ts's dt = 0 never reached the simulation
    // and the ship flew on behind the photo camera (review-p1).
    this.universe.frozen = this.state.open || this.recovery.active || modes.overlay !== null;

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

    // [v4-net] The account line and the sync status under it (signed in only).
    this.accountBox = document.createElement('div');
    this.accountBox.className = 'os-pz-account';
    sheet.appendChild(this.accountBox);

    // Controls. Built with textContent throughout — nothing here is HTML.
    const list = document.createElement('dl');
    list.className = 'os-pz-keys';
    for (const [k, v] of pauseControls()) {
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
      this.applyStickSettings({ ...this.stick, sensitivity: Number(sens.value) });
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
      this.applyStickSettings({ ...this.stick, invertY: inv.checked });
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

    // --- [v2-p4] flight preset (P8). Persisted by game/flightPreset.ts; the
    // FA default applies at once, the autopilot gate on the next L.
    const presetRow = this.row(set, 'FLIGHT PRESET');
    const preset = document.createElement('select');
    preset.className = 'os-pz-select';
    for (const id of FLIGHT_PRESET_IDS) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = FLIGHT_PRESETS[id].label;
      preset.appendChild(o);
    }
    const presetNote = document.createElement('span');
    presetNote.className = 'os-pz-note';
    const showPreset = (): void => {
      const p = activeFlightPreset();
      preset.value = p.id;
      presetNote.textContent = p.blurb;
    };
    preset.addEventListener('change', () => {
      const p = setActiveFlightPreset(preset.value);
      this.universe.flight.flightAssist = p.flightAssist;
      bus.emit('log', { text: `FLIGHT PRESET — ${p.label}`, tone: 'normal' });
      showPreset();
    });
    presetRow.append(preset, presetNote);
    showPreset();
    // --- [/v2-p4]

    // Actions.
    const actions = document.createElement('div');
    actions.className = 'os-pz-actions';
    sheet.appendChild(actions);
    const resume = this.button(actions, 'RESUME', () => this.dispatch({ type: 'resume' }));
    resume.classList.add('is-primary');
    this.button(actions, 'SAVE', () => this.requestSave());
    this.returnBtn = this.button(actions, returnToOrbitLabel(false), () => this.dispatch({ type: 'returnToOrbit' }));
    // [v4-net] R54: two presses, as NEW GAME; any other button disarms it.
    this.deleteBtn = this.button(actions, deleteAccountLabel(this.deleteState), () =>
      this.deleteStep({ kind: 'press', repeat: this.keyRepeating }),
    );
    this.deleteBtn.classList.add('is-danger');

    const foot = document.createElement('footer');
    foot.className = 'os-pz-foot';
    foot.textContent = 'ESC — RESUME';
    sheet.appendChild(foot);

    host.appendChild(root);
    this.root = root;
    this.renderAccount();
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
    // [v4-fuel] I1: the price of RETURN TO ORBIT follows the hull (tank or not);
    // [v4-mining] I2: and it says when the hold goes with it.
    if (this.returnBtn) {
      this.returnBtn.textContent = returnToOrbitLabel(this.universe.flight.propellant !== null, this.universe.cargo.totalKg);
    }
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
      // Any other button disarms DELETE ACCOUNT (R54), as on the title.
      if (b !== this.deleteBtn) this.deleteStep({ kind: 'other' });
      fn();
    });
    // R62a: the pointer entering another item disarms it too, as NEW GAME's hover does.
    b.addEventListener('pointerenter', () => {
      if (b !== this.deleteBtn && this.deleteState.armed) this.deleteStep({ kind: 'other' });
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
.os-pz-account { margin: -8px 0 14px; font-size: 10px; letter-spacing: 0.12em; display: grid; gap: 3px; }
.os-pz-account[hidden], .os-pz-btn[hidden] { display: none; }
.os-pz-account-line { color: #a7b0b5; }
.os-pz-sync { color: var(--amber); opacity: 0.85; min-height: 1em; }
.os-pz-btn.is-danger:hover, .os-pz-btn.is-danger:focus-visible { border-color: #ff5f56; color: #ff5f56; }
.os-pz-foot { margin-top: 14px; color: #6a727a; font-size: 10px; letter-spacing: 0.08em; }
`;
