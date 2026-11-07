/**
 * Photo mode — `P` from flight or the Yard.
 *
 * A mode OVERLAY (core/Modes.ts): pushing it freezes the base mode's modules
 * at dt = 0 (core/tick.ts) so the scene holds still while the camera is
 * free. This module is registered LAST so its lateUpdate writes the camera
 * after the flight rig has — the rig still runs (dt 0) and would otherwise
 * pull the camera back to the hull every frame.
 *
 * Controls: drag = look, WASD = move, R/F = up/down, Shift = fast,
 * wheel = FOV, [ ] = exposure, G = grain, C = aberration, Enter = save PNG,
 * P or Esc = leave. The camera pose is restored exactly on exit.
 */

import { Quaternion, Vector3 } from 'three';
import type { Engine, EngineContext, GameModule } from '@/core/Engine';
import { modes } from '@/core/Modes';
import { bus } from '@/core/EventBus';
import type { PostFX } from '@/render/PostFX';
import {
  clampGrade,
  createFlyCam,
  stepFlyCam,
  type FlyCamInput,
  type FlyCamState,
  type Grade,
} from './photo/flycam';
import { mayEnterPhoto } from './entryGuards';
import { PhotoFrame } from './photo/pose';

const MOVE_KEYS: Record<string, [number, number, number]> = {
  KeyW: [0, 0, -1],
  KeyS: [0, 0, 1],
  KeyA: [-1, 0, 0],
  KeyD: [1, 0, 0],
  KeyR: [0, 1, 0],
  KeyF: [0, -1, 0],
};

/** Anything up that owns the screen; photo mode does not open over it. */
export const PHOTO_BLOCKERS = '.os-pause.is-live, .os-codex.is-live, .os-sysmap.is-live, .os-starmap.is-live';

export class Photo implements GameModule {
  readonly name = 'photo';
  readonly activeIn = ['photo'] as const;

  private cam: FlyCamState | null = null;
  private saved = { pos: new Vector3(), quat: new Quaternion(), up: new Vector3(), fov: 60 };
  private held = new Set<string>();
  private look = { dx: 0, dy: 0, dragging: false };
  private zoom = 0;
  private grade: { exposure: number; grain: number; ca: number } = { exposure: 1, grain: 0.055, ca: 0.0055 };
  private bar: HTMLDivElement | null = null;
  private style: HTMLStyleElement | null = null;
  private idleFor = 0;
  /** The fly-cam runs in the entry camera's frame, so P never rolls the shot. */
  private readonly frame = new PhotoFrame();
  private input: FlyCamInput = { move: [0, 0, 0], lookDx: 0, lookDy: 0, zoom: 0, fast: false };
  private chartOpen = false;
  private offChart: (() => void) | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly postfx: PostFX,
  ) {}

  init(ctx: EngineContext): void {
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    ctx.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('blur', this.onBlur);
    this.offChart = bus.on('ui:chart', ({ chart }) => {
      this.chartOpen = chart !== null;
    });
    this.style = document.createElement('style');
    this.style.textContent = CSS;
    document.head.appendChild(this.style);
  }

  // -- entry / exit ---------------------------------------------------------

  private enter(): void {
    const camera = this.engine.camera;
    this.saved.pos.copy(camera.position);
    this.saved.quat.copy(camera.quaternion);
    this.saved.up.copy(camera.up);
    this.saved.fov = camera.fov;
    this.frame.anchor(camera.position, camera.quaternion);
    this.cam = createFlyCam([0, 0, 0], 0, 0, camera.fov);
    this.grade = { exposure: 1, grain: 0.055, ca: 0.0055 };
    document.exitPointerLock?.();
    modes.push('photo');
    document.body.classList.add('os-photo');
    this.mountBar();
    bus.emit('log', { text: 'PHOTO MODE — ENTER TO SAVE · P TO LEAVE', tone: 'normal' });
  }

  private leave(): void {
    if (modes.overlay !== 'photo') return;
    const camera = this.engine.camera;
    camera.position.copy(this.saved.pos);
    camera.quaternion.copy(this.saved.quat);
    camera.up.copy(this.saved.up);
    camera.fov = this.saved.fov;
    camera.updateProjectionMatrix();
    this.postfx.setGrade(null);
    this.cam = null;
    this.held.clear();
    document.body.classList.remove('os-photo');
    this.bar?.remove();
    this.bar = null;
    modes.pop();
  }

  // -- frame ----------------------------------------------------------------

  lateUpdate(dt: number, ctx: EngineContext): void {
    const c = this.cam;
    if (!c) return;
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (const k of this.held) {
      const m = MOVE_KEYS[k];
      if (m) {
        mx += m[0];
        my += m[1];
        mz += m[2];
      }
    }
    const inp = this.input as { -readonly [K in keyof FlyCamInput]: FlyCamInput[K] };
    (inp.move as [number, number, number])[0] = Math.max(-1, Math.min(1, mx));
    (inp.move as [number, number, number])[1] = Math.max(-1, Math.min(1, my));
    (inp.move as [number, number, number])[2] = Math.max(-1, Math.min(1, mz));
    inp.lookDx = this.look.dx;
    inp.lookDy = this.look.dy;
    inp.zoom = this.zoom;
    inp.fast = this.held.has('ShiftLeft') || this.held.has('ShiftRight');
    this.look.dx = 0;
    this.look.dy = 0;
    this.zoom = 0;

    stepFlyCam(c, inp, dt);

    const camera = ctx.camera;
    this.frame.pose(c, camera.position, camera.quaternion);
    if (camera.fov !== c.fov) {
      camera.fov = c.fov;
      camera.updateProjectionMatrix();
    }

    // The bar fades after two idle seconds so the frame is clean.
    this.idleFor += dt;
    if (this.bar) {
      this.bar.classList.toggle('idle', this.idleFor > 2);
      this.renderBar();
    }
  }

  // -- input ----------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent): void => {
    if (modes.overlay !== 'photo') {
      // Only from a base that can host the overlay, and never over a map/menu.
      if (e.code === 'KeyP' && mayEnterPhoto({ base: modes.base, overlay: modes.overlay, menuOpen: this.menuOpen() }, e)) {
        e.preventDefault();
        this.enter();
      }
      return;
    }
    // In photo mode this module owns the keyboard. Immediate: the Yard's own
    // capture listener on window sits after this one and must not see it.
    e.preventDefault();
    e.stopImmediatePropagation();
    this.idleFor = 0;
    switch (e.code) {
      case 'KeyP':
      case 'Escape':
        this.leave();
        return;
      case 'Enter':
        void this.save();
        return;
      case 'BracketLeft':
        this.adjust({ exposure: this.grade.exposure / 1.15 });
        return;
      case 'BracketRight':
        this.adjust({ exposure: this.grade.exposure * 1.15 });
        return;
      case 'KeyG':
        this.adjust({ grain: this.grade.grain > 0 ? 0 : 0.055 });
        return;
      case 'KeyC':
        this.adjust({ ca: this.grade.ca > 0 ? 0 : 0.0055 });
        return;
    }
    this.held.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  /** A key released while the window is unfocused never sends keyup. */
  private onBlur = (): void => {
    this.held.clear();
  };

  /**
   * The pause sheet, the codex, or either chart: the live classes those
   * modules really set (PHOTO_BLOCKERS, review-p1), plus the chart event.
   */
  private menuOpen(): boolean {
    return this.chartOpen || document.querySelector(PHOTO_BLOCKERS) !== null;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (modes.overlay !== 'photo') return;
    this.look.dragging = true;
    this.idleFor = 0;
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.look.dragging || modes.overlay !== 'photo') return;
    this.look.dx += e.movementX;
    this.look.dy += e.movementY;
  };

  private onPointerUp = (): void => {
    this.look.dragging = false;
  };

  private onWheel = (e: WheelEvent): void => {
    if (modes.overlay !== 'photo') return;
    e.preventDefault();
    this.zoom += e.deltaY;
    this.idleFor = 0;
  };

  private adjust(g: Grade): void {
    const next = clampGrade({ ...this.grade, ...g });
    this.grade = {
      exposure: next.exposure ?? this.grade.exposure,
      grain: next.grain ?? this.grade.grain,
      ca: next.ca ?? this.grade.ca,
    };
    this.postfx.setGrade(this.grade);
  }

  private async save(): Promise<void> {
    // Hide the bar for the captured frame itself.
    this.bar?.classList.add('capturing');
    const blob = await this.engine.captureNextFrame();
    this.bar?.classList.remove('capturing');
    if (!blob) {
      bus.emit('log', { text: 'PHOTO — CAPTURE REFUSED BY BROWSER', tone: 'warn' });
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `onespace-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    bus.emit('log', { text: 'PHOTO SAVED', tone: 'good' });
  }

  // -- bar ------------------------------------------------------------------

  private mountBar(): void {
    const root = document.getElementById('ui-root') ?? document.body;
    this.bar = document.createElement('div');
    this.bar.className = 'os-photo-bar';
    root.appendChild(this.bar);
    this.idleFor = 0;
    this.renderBar();
  }

  private lastBar = '';

  private renderBar(): void {
    if (!this.bar || !this.cam) return;
    const g = this.grade;
    const text =
      `PHOTO · FOV ${Math.round(this.cam.fov)}° (wheel) · EXP ${g.exposure.toFixed(2)} ([ ]) · ` +
      `GRAIN ${g.grain > 0 ? '●' : '○'} (G) · CA ${g.ca > 0 ? '●' : '○'} (C) · ` +
      `drag look · WASD/RF move · ⇧ fast · ⏎ SAVE · P leave`;
    if (text !== this.lastBar) {
      this.bar.textContent = text;
      this.lastBar = text;
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    this.engine.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('blur', this.onBlur);
    this.offChart?.();
    this.bar?.remove();
    this.style?.remove();
  }
}

const CSS = /* css */ `
body.os-photo #ui-root > :not(.os-photo-bar) { visibility: hidden !important; }
.os-photo-bar {
  position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%);
  font: 11px/1.4 ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: 0.08em;
  color: #ffb454; background: rgba(3, 6, 8, 0.6); padding: 6px 12px;
  border-top: 1px solid rgba(255, 180, 84, 0.34); white-space: nowrap;
  text-shadow: 0 0 2px rgba(0,0,0,0.92), 0 0 6px rgba(255,180,84,0.5);
  transition: opacity 0.6s ease; pointer-events: none;
}
.os-photo-bar.idle { opacity: 0; }
.os-photo-bar.capturing { opacity: 0; transition: none; }
`;
