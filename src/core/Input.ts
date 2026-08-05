/**
 * Input aggregation.
 *
 * Consumers ask "what does the pilot want right now" rather than subscribing
 * to raw DOM events. Axes are already smoothed and normalised to -1..1, so the
 * flight model stays free of input plumbing.
 */

export interface InputAxes {
  /** Nose up (+) / down (-). */
  pitch: number;
  /** Nose right (+) / left (-). */
  yaw: number;
  /** Roll right (+) / left (-). */
  roll: number;
  /** Main engine, 0..1. */
  throttle: number;
  /** Lateral strafe, right positive. */
  strafeX: number;
  /** Vertical strafe, up positive. */
  strafeY: number;
  /** Longitudinal strafe, forward positive (independent of throttle). */
  strafeZ: number;
}

export type ActionName =
  | 'boost'
  | 'brake'
  | 'warp'
  | 'scan'
  | 'map'
  | 'codex'
  | 'land'
  | 'cycleTarget'
  | 'toggleCamera'
  | 'pause'
  | 'screenshot';

const KEY_ACTIONS: Record<string, ActionName> = {
  ShiftLeft: 'boost',
  ShiftRight: 'boost',
  Space: 'brake',
  KeyJ: 'warp',
  KeyE: 'scan',
  KeyM: 'map',
  KeyC: 'codex',
  KeyL: 'land',
  Tab: 'cycleTarget',
  KeyV: 'toggleCamera',
  Escape: 'pause',
  F2: 'screenshot',
};

export class Input {
  readonly axes: InputAxes = {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: 0,
    strafeX: 0,
    strafeY: 0,
    strafeZ: 0,
  };

  /** Raw pointer delta since last frame, in pixels. */
  pointerDX = 0;
  pointerDY = 0;
  wheelDelta = 0;
  pointerLocked = false;

  /** Mouse steering is the primary control; keys are a fallback. */
  mouseSensitivity = 0.0022;
  private keys = new Set<string>();
  private pressedThisFrame = new Set<ActionName>();
  private targetThrottle = 0;
  private disposers: Array<() => void> = [];

  constructor(private element: HTMLElement) {
    this.bind();
  }

  private bind(): void {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      const action = KEY_ACTIONS[e.code];
      if (action) this.pressedThisFrame.add(action);
    };
    const onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
    const onBlur = () => this.keys.clear();

    const onPointerMove = (e: PointerEvent) => {
      if (!this.pointerLocked) return;
      this.pointerDX += e.movementX;
      this.pointerDY += e.movementY;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.wheelDelta += Math.sign(e.deltaY);
    };
    const onLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.element;
    };
    const onClick = () => {
      if (!this.pointerLocked) void this.element.requestPointerLock?.();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointermove', onPointerMove);
    this.element.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('pointerlockchange', onLockChange);
    this.element.addEventListener('click', onClick);

    this.disposers.push(
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('blur', onBlur),
      () => window.removeEventListener('pointermove', onPointerMove),
      () => this.element.removeEventListener('wheel', onWheel),
      () => document.removeEventListener('pointerlockchange', onLockChange),
      () => this.element.removeEventListener('click', onClick),
    );
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  held(action: ActionName): boolean {
    for (const [code, a] of Object.entries(KEY_ACTIONS)) {
      if (a === action && this.keys.has(code)) return true;
    }
    return false;
  }

  /** True exactly once, on the frame the key went down. */
  pressed(action: ActionName): boolean {
    return this.pressedThisFrame.has(action);
  }

  /**
   * Fold raw state into axes. Call once per frame *before* systems update.
   * Throttle is integrated rather than instantaneous — a capital-ship feel,
   * not a twitch shooter.
   */
  update(dt: number): void {
    const a = this.axes;

    // Throttle: W/S nudge a target the actual throttle chases.
    if (this.isDown('KeyW')) this.targetThrottle += dt * 0.9;
    if (this.isDown('KeyS')) this.targetThrottle -= dt * 0.9;
    if (this.wheelDelta !== 0) {
      this.targetThrottle -= this.wheelDelta * 0.08;
      this.wheelDelta = 0;
    }
    this.targetThrottle = clamp(this.targetThrottle, 0, 1);
    a.throttle += (this.targetThrottle - a.throttle) * Math.min(1, dt * 4);

    // Mouse steering, with the vertical axis inverted the way pilots expect.
    const mousePitch = clamp(-this.pointerDY * this.mouseSensitivity, -1, 1);
    const mouseYaw = clamp(-this.pointerDX * this.mouseSensitivity, -1, 1);
    this.pointerDX = 0;
    this.pointerDY = 0;

    const keyPitch = (this.isDown('ArrowUp') ? 1 : 0) - (this.isDown('ArrowDown') ? 1 : 0);
    const keyYaw = (this.isDown('ArrowLeft') ? 1 : 0) - (this.isDown('ArrowRight') ? 1 : 0);
    const keyRoll = (this.isDown('KeyQ') ? 1 : 0) - (this.isDown('KeyE') ? 1 : 0);

    a.pitch = clamp(mousePitch + keyPitch, -1, 1);
    a.yaw = clamp(mouseYaw + keyYaw, -1, 1);
    a.roll = clamp(keyRoll, -1, 1);

    a.strafeX = (this.isDown('KeyD') ? 1 : 0) - (this.isDown('KeyA') ? 1 : 0);
    a.strafeY = (this.isDown('KeyR') ? 1 : 0) - (this.isDown('KeyF') ? 1 : 0);
    a.strafeZ = 0;
  }

  /** Call at the very end of the frame. */
  endFrame(): void {
    this.pressedThisFrame.clear();
  }

  setThrottle(v: number): void {
    this.targetThrottle = clamp(v, 0, 1);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
