/**
 * Input aggregation.
 *
 * Consumers ask "what does the pilot want right now" rather than subscribing
 * to raw DOM events. Axes are already smoothed and normalised to -1..1, so the
 * flight model stays free of input plumbing.
 */

import {
  VirtualStick,
  clampSensitivity,
  loadStickSettings,
  saveStickSettings,
  type StickSettings,
  type StickVector,
} from './stick';

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
  | 'cruise'
  | 'warp'
  | 'scan'
  | 'map'
  | 'codex'
  | 'land'
  | 'cycleTarget'
  | 'toggleCamera'
  | 'pause'
  | 'screenshot'
  | 'zeroThrottle'
  | 'flightAssist'
  // [v2-p4] time compression steps (game/TimeCompression.ts)
  | 'timeSlower'
  | 'timeFaster';

const KEY_ACTIONS: Record<string, ActionName> = {
  ShiftLeft: 'boost',
  ShiftRight: 'boost',
  Space: 'brake',
  KeyG: 'cruise', // not F: F is strafe-down. J stays the interstellar jump
  KeyJ: 'warp',
  KeyT: 'scan',   // not E: E is roll, and a key cannot mean two things
  KeyM: 'map',
  KeyC: 'codex',
  KeyL: 'land',
  Tab: 'cycleTarget',
  KeyV: 'toggleCamera',
  Escape: 'pause',
  F2: 'screenshot',
  KeyX: 'zeroThrottle', // the coast detent: lever to 0 in one press, not 1.1 s of S
  KeyZ: 'flightAssist',
  // [v2-p4] `,` / `.` step time compression 1× / 10× / 100× (the KSP keys).
  Comma: 'timeSlower',
  Period: 'timeFaster',
};

// ---------------------------------------------------------------------------
// [v3-T2] Key-axis ramps (PLAN phase B)
// ---------------------------------------------------------------------------

export interface KeyRamp {
  /** Seconds for a full 0 → 1 stroke. */
  readonly upSeconds: number;
  /** Seconds for a full 1 → 0 stroke. */
  readonly downSeconds: number;
}

/**
 * Under the rate-command plant a key that steps 0 → 1 is an α_max kick on
 * every tap; 0.15 s up takes the edge off without feeling soft, and 0.08 s
 * down keeps the release sharp (it costs ~1.4° of glide from full pitch).
 */
export const KEY_RAMP: KeyRamp = { upSeconds: 0.15, downSeconds: 0.08 };

/**
 * Move a key axis towards `target`, linear in time: towards zero at the down
 * rate, away from it at the up rate. A reversal is split at zero, so the
 * result is exactly the same however `dt` is sliced. Pure.
 */
export function rampAxis(current: number, target: number, dt: number, ramp: KeyRamp = KEY_RAMP): number {
  if (!Number.isFinite(current)) current = 0;
  if (!(dt > 0) || !Number.isFinite(dt)) return current;
  let v = current;
  let left = dt;
  // Phase 1: shrinking |v| (towards zero, or towards a smaller target on the same side).
  const sameSide = v === 0 || target === 0 || Math.sign(v) === Math.sign(target);
  const downTo = sameSide && Math.abs(target) < Math.abs(v) ? target : sameSide ? v : 0;
  if (downTo !== v) {
    const need = (Math.abs(v - downTo) * ramp.downSeconds);
    if (left >= need) {
      v = downTo;
      left -= need;
    } else {
      return v - Math.sign(v - downTo) * (left / ramp.downSeconds);
    }
  }
  if (v === target) return v;
  // Phase 2: growing |v| towards the target.
  const step = left / ramp.upSeconds;
  const dist = target - v;
  return Math.abs(dist) <= step ? target : v + Math.sign(dist) * step;
}

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

  /**
   * Mouse steering is the primary control; keys are a fallback. The mouse
   * drives a virtual stick (see `stick.ts`) rather than being read as a
   * per-frame delta — that delta reading is what made a 2000 px swipe turn the
   * nose 2.6°.
   */
  private readonly stick = new VirtualStick();
  private settings: StickSettings;
  private keys = new Set<string>();
  private pressedThisFrame = new Set<ActionName>();
  private targetThrottle = 0;
  /** [v3-T2] Ramped key contributions (pitch, yaw, roll). */
  private keyPitch = 0;
  private keyYaw = 0;
  private keyRoll = 0;
  private disposers: Array<() => void> = [];

  constructor(private element: HTMLElement) {
    this.settings = loadStickSettings(safeStorage());
    this.bind();
  }

  /**
   * Stick offset, normalised -1..1, screen convention (+x right, +y down),
   * before the deadzone — for the HUD's amber dot.
   */
  get stickDeflection(): StickVector {
    return this.stick.deflection;
  }

  get stickSettings(): StickSettings {
    return this.settings;
  }

  /** Validate, apply for this session, and persist where storage allows. */
  setStickSettings(s: StickSettings): void {
    this.settings = {
      sensitivity: clampSensitivity(s.sensitivity),
      invertY: s.invertY === true,
    };
    saveStickSettings(safeStorage(), this.settings);
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
      // Losing the lock (Esc, a map opening) must not leave a turn latched on.
      if (!this.pointerLocked) {
        this.stick.reset();
        this.pointerDX = 0;
        this.pointerDY = 0;
      }
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
    // The zero stop IS the coast detent, however the lever got there (S, the
    // wheel, `setThrottle(0)` on touchdown). The easing above is exponential
    // and never reaches 0 by itself, and under flight assist a lever at 1e-20
    // is a speed hold at ~0 km/s: an active stop that eats the orbit.
    if (this.targetThrottle === 0) a.throttle = 0;
    // X skips the lever's easing on purpose: under flight assist, exactly 0 is
    // the coast detent, and a lever that eases down passes through every set
    // speed on the way (a brief speed hold the pilot never asked for).
    if (this.pressedThisFrame.has('zeroThrottle')) {
      this.targetThrottle = 0;
      a.throttle = 0;
    }

    // Mouse → stick. The pixels are summed into a held deflection, so the axis
    // no longer depends on how many frames the movement was sliced into.
    const sens = this.settings.sensitivity;
    this.stick.addDelta(this.pointerDX * sens, this.pointerDY * sens);
    this.pointerDX = 0;
    this.pointerDY = 0;
    this.stick.update(dt);

    // Signs as before the stick: mouse-up (screen -y) is nose-up and
    // mouse-right is a NEGATIVE yaw axis, matching ArrowRight; FlightModel's
    // yawAxisSign turns that into a right turn.
    const sx = this.stick.axis.x;
    const sy = this.stick.axis.y;
    const mousePitch = this.settings.invertY ? sy : -sy;
    const mouseYaw = -sx;

    // [v3-T2] Keys ramp (see `rampAxis`); the mouse does not — the hand is
    // already its own ramp, and a held deflection must read exactly.
    const keyPitch = (this.isDown('ArrowUp') ? 1 : 0) - (this.isDown('ArrowDown') ? 1 : 0);
    const keyYaw = (this.isDown('ArrowLeft') ? 1 : 0) - (this.isDown('ArrowRight') ? 1 : 0);
    const keyRoll = (this.isDown('KeyQ') ? 1 : 0) - (this.isDown('KeyE') ? 1 : 0);
    this.keyPitch = rampAxis(this.keyPitch, keyPitch, dt);
    this.keyYaw = rampAxis(this.keyYaw, keyYaw, dt);
    this.keyRoll = rampAxis(this.keyRoll, keyRoll, dt);

    a.pitch = clamp(mousePitch + this.keyPitch, -1, 1);
    a.yaw = clamp(mouseYaw + this.keyYaw, -1, 1);
    a.roll = clamp(this.keyRoll, -1, 1);

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
    // The detent snaps, as X does: an eased cut passes through every FA-ON
    // speed hold on the way down, and geometrically never quite reaches 0 —
    // the computer then brakes a recovery orbit to a hover (review-p1).
    if (this.targetThrottle === 0) this.axes.throttle = 0;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}

/** `localStorage`, or null where even touching the accessor throws. */
function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
