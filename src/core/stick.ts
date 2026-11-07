/**
 * The mouse as a virtual joystick (GAMEPLAY B1).
 *
 * The old mouse path turned one frame's pixel delta into an axis and threw the
 * delta away, so the axis was a 1/60 s spike that the attitude hold promptly
 * damped back out: a full 2000 px swipe turned the nose 2.6°, and the same
 * swipe at 144 Hz turned it 2.4× less because the spike was shorter.
 *
 * Here the mouse moves a *dot*. Its offset from centre, clamped to a circle,
 * IS the stick, and it stays where it was put until the hand moves it back
 * ([v3-T2]: no constant recentring; optional idle auto-centre, off by default). The axis is therefore a held value like a
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
   * [v3-T2] Optional auto-centre: after `autoCentreIdleSeconds` with no mouse
   * motion the offset decays exponentially with `autoCentreTau`. OFF by
   * default — a held turn is a turn however long it lasts (a 180° turn at
   * 35°/s is ~5 s of a still hand), and the HUD dot shows where centre is.
   */
  readonly autoCentre: boolean;
  readonly autoCentreIdleSeconds: number;
  readonly autoCentreTau: number;
}

export const STICK_DEFAULTS: StickTuning = {
  // ~300 px is a comfortable wrist flick on a 1080p-to-retina desk mouse:
  // small enough that full deflection is one motion, large enough that half
  // deflection is easy to hold.
  radiusPx: 300,
  // [v3-T2] 2.5 % of 300 px is 7.5 px: above sensor jitter, and with the
  // cubic curve below a deflection just past it is a crawl, not a jump.
  deadzone: 0.025,
  // [v3-T2] v2 walked the stick home linearly over 8 s, which ate small
  // deflections (0.25 was gone after 2 s, PLAN S1). The stick now holds.
  autoCentre: false,
  autoCentreIdleSeconds: 1.0,
  autoCentreTau: 0.25,
};

/**
 * [v3-T2] Response curve on the deadzone-rescaled magnitude: 0.35x + 0.65x³.
 * Fine near centre (half the slope of linear) for precision aiming, still
 * exactly 1 at full deflection so mouse and keys keep parity. Odd.
 */
export function stickCurve(x: number): number {
  return 0.35 * x + 0.65 * x * x * x;
}

export interface StickVector {
  readonly x: number;
  readonly y: number;
}

export class VirtualStick {
  readonly tuning: StickTuning;

  /** Accumulated offset in pixels, always inside the radius. */
  private px = 0;
  private py = 0;
  /** Seconds since the last non-zero pointer delta (auto-centre only). */
  private idle = 0;

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

  /** The control output: deadzone removed, rescaled, then shaped by `stickCurve`. */
  get axis(): StickVector {
    return this._axis;
  }

  /** Feed a pointer delta in pixels (already scaled by sensitivity). */
  addDelta(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    // Input feeds a zero delta every frame; only real motion is "the hand moved".
    if (dx === 0 && dy === 0) return;
    this.idle = 0;
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
   * Once per frame. Without auto-centre the stick simply holds. With it, the
   * idle threshold is crossed mid-frame exactly (only the part of `dt` past
   * it decays), so the result is the same however a second is sliced.
   */
  update(dt: number): void {
    const t = this.tuning;
    if (t.autoCentre && dt > 0 && Number.isFinite(dt)) {
      const before = this.idle;
      this.idle += dt;
      const decaying = this.idle - Math.max(before, t.autoCentreIdleSeconds);
      if (decaying > 0 && t.autoCentreTau > 0) {
        const k = Math.exp(-decaying / t.autoCentreTau);
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
    this.idle = 0;
    this.refresh();
  }

  private refresh(): void {
    const r = this.tuning.radiusPx;
    const dx = this.px / r;
    const dy = this.py / r;
    this._deflection.x = dx;
    this._deflection.y = dy;

    // Radial deadzone, rescaled so the axis leaves zero continuously at the
    // edge and still reaches exactly 1 at full deflection; the curve then
    // acts on the radius, so the direction is kept.
    const mag = Math.hypot(dx, dy);
    const dz = this.tuning.deadzone;
    if (mag <= dz || mag === 0) {
      this._axis.x = 0;
      this._axis.y = 0;
      return;
    }
    const shaped = stickCurve(Math.min(1, (mag - dz) / (1 - dz)));
    this._axis.x = (dx / mag) * shaped;
    this._axis.y = (dy / mag) * shaped;
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
