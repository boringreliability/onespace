/**
 * The mouse as a virtual joystick (GAMEPLAY B1).
 *
 * The old mouse path turned one frame's pixel delta into an axis and threw the
 * delta away, so the axis was a 1/60 s spike that the attitude hold promptly
 * damped back out: a full 2000 px swipe turned the nose 2.6°, and the same
 * swipe at 144 Hz turned it 2.4× less because the spike was shorter.
 *
 * Here the mouse moves a *dot*. Its offset from centre, clamped to a circle,
 * IS the stick, and it stays where it was put until the hand moves it back or
 * the slow recentring walks it home. The axis is therefore a held value like a
 * key — full deflection reads exactly 1, the same as an arrow key, which is
 * what gives mouse/keyboard parity for free — and the delta sum is
 * independent of how many frames it arrived in.
 *
 * Pure: no DOM, no three. `Input` owns the DOM side.
 */

export interface StickTuning {
  /** Deflection radius in (sensitivity-scaled) pixels. Full axis at this offset. */
  readonly radiusPx: number;
  /** Fraction of the radius that reads as zero, so a resting hand is not a slow turn. */
  readonly deadzone: number;
  /**
   * Seconds for the drift back to centre to walk a FULL deflection home. The
   * walk is radial at a constant rate, so half deflection takes half as long.
   * 0 disables recentring.
   */
  readonly recentreSeconds: number;
}

export const STICK_DEFAULTS: StickTuning = {
  // ~300 px is a comfortable wrist flick on a 1080p-to-retina desk mouse:
  // small enough that full deflection is one motion, large enough that half
  // deflection is easy to hold.
  radiusPx: 300,
  // 4% of 300 px is 12 px — larger than sensor jitter and a resting hand,
  // small enough that a gentle correction still registers.
  deadzone: 0.04,
  // Slow on purpose: a 1 s manoeuvre loses 12% of full deflection, so a held
  // turn stays a turn and mouse stays on par with the arrow keys, but a stick
  // left off-centre and forgotten is home within 8 s instead of spinning the
  // ship forever. Constant-rate rather than exponential: an exponential
  // strong enough to get home in ~8 s already eats ~25% of the first second,
  // which is exactly the part of a turn the pilot is holding on purpose.
  recentreSeconds: 8,
};

export interface StickVector {
  readonly x: number;
  readonly y: number;
}

export class VirtualStick {
  readonly tuning: StickTuning;

  /** Accumulated offset in pixels, always inside the radius. */
  private px = 0;
  private py = 0;

  private readonly _deflection = { x: 0, y: 0 };
  private readonly _axis = { x: 0, y: 0 };

  constructor(tuning: Partial<StickTuning> = {}) {
    this.tuning = { ...STICK_DEFAULTS, ...tuning };
  }

  /**
   * Raw offset / radius, -1..1, before the deadzone. Screen convention: +x is
   * right, +y is DOWN. This is what a HUD dot should draw — the deadzone is an
   * input concern, and hiding the dot inside it would make it look stuck.
   */
  get deflection(): StickVector {
    return this._deflection;
  }

  /** The control output: deflection with the deadzone removed and rescaled. */
  get axis(): StickVector {
    return this._axis;
  }

  /** Feed a pointer delta in pixels (already scaled by sensitivity). */
  addDelta(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.px += dx;
    this.py += dy;
    // Clamp the ACCUMULATOR, not just the output: otherwise a 5000 px shove
    // winds up 4700 px of invisible travel the hand has to undo before the
    // stick responds again.
    const r = this.tuning.radiusPx;
    const len = Math.hypot(this.px, this.py);
    if (len > r) {
      const k = r / len;
      this.px *= k;
      this.py *= k;
    }
    this.refresh();
  }

  /**
   * Once per frame. Recentring shortens the offset by a fixed number of
   * pixels per second, which is linear in time and therefore identical
   * however the second is sliced into frames.
   */
  update(dt: number): void {
    const t = this.tuning.recentreSeconds;
    if (t > 0 && dt > 0) {
      const len = Math.hypot(this.px, this.py);
      if (len > 0) {
        const next = Math.max(0, len - (this.tuning.radiusPx / t) * dt);
        const k = next / len;
        this.px *= k;
        this.py *= k;
      }
    }
    this.refresh();
  }

  /** Snap to centre — pointer lock lost, menu opened, ship respawned. */
  reset(): void {
    this.px = 0;
    this.py = 0;
    this.refresh();
  }

  private refresh(): void {
    const r = this.tuning.radiusPx;
    const dx = this.px / r;
    const dy = this.py / r;
    this._deflection.x = dx;
    this._deflection.y = dy;

    // Radial deadzone, rescaled so the axis leaves zero continuously at the
    // edge and still reaches exactly 1 at full deflection.
    const mag = Math.hypot(dx, dy);
    const dz = this.tuning.deadzone;
    if (mag <= dz || mag === 0) {
      this._axis.x = 0;
      this._axis.y = 0;
      return;
    }
    const scaled = Math.min(1, (mag - dz) / (1 - dz));
    this._axis.x = (dx / mag) * scaled;
    this._axis.y = (dy / mag) * scaled;
  }
}

// ---------------------------------------------------------------------------
// Settings persistence
//
// Storage contract shared with the pause UI: two keys,
//   os.stick.sensitivity  plain decimal multiplier, default 1, clamped [0.25, 4]
//   os.stick.invertY      exactly 'true' or 'false'
// localStorage is user-writable text that outlives builds, so parsing is a
// whitelist: exact formats only, no coercion, unknown → that key's default.
// ---------------------------------------------------------------------------

export interface StickSettings {
  /** Multiplier on pointer pixels before they reach the stick. */
  readonly sensitivity: number;
  /** Mouse-up pitches the nose down. */
  readonly invertY: boolean;
}

export const STICK_SENSITIVITY_KEY = 'os.stick.sensitivity';
export const STICK_INVERT_Y_KEY = 'os.stick.invertY';
/** 0.25..4 is 1200 px..75 px for full deflection — beyond that is a typo, not a taste. */
export const STICK_SENSITIVITY_MIN = 0.25;
export const STICK_SENSITIVITY_MAX = 4;

export const DEFAULT_STICK_SETTINGS: StickSettings = { sensitivity: 1, invertY: false };

/** A plain positive decimal: digits, optional fraction. No signs, exponents, hex or padding. */
const DECIMAL = /^\d+(\.\d+)?$/;

export function clampSensitivity(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_STICK_SETTINGS.sensitivity;
  return Math.min(STICK_SENSITIVITY_MAX, Math.max(STICK_SENSITIVITY_MIN, v));
}

export function parseStickSettings(
  sensitivityText: string | null | undefined,
  invertYText: string | null | undefined,
): StickSettings {
  let sensitivity = DEFAULT_STICK_SETTINGS.sensitivity;
  if (typeof sensitivityText === 'string' && DECIMAL.test(sensitivityText)) {
    sensitivity = clampSensitivity(Number(sensitivityText));
  }
  let invertY = DEFAULT_STICK_SETTINGS.invertY;
  if (invertYText === 'true') invertY = true;
  else if (invertYText === 'false') invertY = false;
  return { sensitivity, invertY };
}

/** Never throws: private mode and blocked site data make `getItem` throw. */
export function loadStickSettings(
  storage: { getItem(key: string): string | null } | null | undefined,
): StickSettings {
  if (!storage) return DEFAULT_STICK_SETTINGS;
  try {
    return parseStickSettings(
      storage.getItem(STICK_SENSITIVITY_KEY),
      storage.getItem(STICK_INVERT_Y_KEY),
    );
  } catch {
    return DEFAULT_STICK_SETTINGS;
  }
}

/** Never throws; reports whether it was stored. Quota errors are real. */
export function saveStickSettings(
  storage: { setItem(key: string, value: string): void } | null | undefined,
  settings: StickSettings,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(STICK_SENSITIVITY_KEY, String(clampSensitivity(settings.sensitivity)));
    storage.setItem(STICK_INVERT_Y_KEY, settings.invertY ? 'true' : 'false');
    return true;
  } catch {
    return false;
  }
}
