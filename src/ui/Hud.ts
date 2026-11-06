/**
 * The heads-up display: DOM and CSS, never WebGL.
 *
 * Instrumentation is the reward loop of this game — the ship tells you what it
 * has found and you believe it. So the HUD is built like an instrument panel
 * from 1943 as imagined by someone who has only ever had one described to
 * them: etched 1px strokes, amber lamps behind glass, a cyan cathode wash, and
 * everything very slightly out of true.
 *
 * Two rules govern the implementation:
 *
 *  1. The DOM is built exactly once. Per frame we only write text content and
 *     CSS custom properties, and only when the *quantised* value has actually
 *     moved — a HUD that touches 200 style properties every frame will cost
 *     more than the planet behind it.
 *  2. Nothing snaps. Every needle, bar and digit chases its target through a
 *     critically-damped filter, and every digit is quantised with hysteresis so
 *     the last decimal never flickers between two values.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { registerShot } from '@/game/Shots';
import { AU, type GameScale, type ScanResult } from '@/gen/types';

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

/**
 * Flight state for the instruments. The HUD copies every field on the way in,
 * so the caller may hand the same mutable object back every frame.
 */
export interface HudVitals {
  /** Main engine setting, 0..1. */
  throttle: number;
  /** Speed along the velocity vector, km/s. */
  speedKmS: number;
  /** Height above the nearest body's surface in km, or null when in deep space. */
  altitudeKm: number | null;
  /** Nose elevation above the local horizon, radians. */
  pitchRad: number;
  /** Bank angle, radians, positive = right wing down. */
  rollRad: number;
  /** Optional G meter, in gravities. Hidden when omitted. */
  gLoad?: number;
}

/**
 * Where the current target is *on screen*. The HUD does no projection of its
 * own — it has no camera, and the integrator already has the matrices.
 */
export interface HudTarget {
  readonly id: string;
  readonly name: string;
  /** Projected position in CSS pixels, origin top-left of the viewport. */
  x: number;
  y: number;
  /** True when the target is behind the camera and the projection is mirrored. */
  behind: boolean;
  /** Range to target, km. */
  distanceKm: number;
  /** Projected aim-ahead point, CSS pixels. Omit for a static bracket. */
  leadX?: number;
  leadY?: number;
  /** Short classifier printed under the name, e.g. "ICE GIANT". */
  kind?: string;
  /** Rate the gap shrinks, km/s; negative while opening. Omit to hide the line. */
  closingKmS?: number;
  /** Seconds to arrival at the current closing speed, or null when not closing. */
  etaS?: number | null;
}

/**
 * Derived flight instruments, fed after `setVitals` each frame. Everything the
 * HUD cannot compute without a camera or a universe arrives here. The caller
 * may hand the same mutable object back every frame.
 */
export interface HudInstruments {
  /** False when the ship is too slow for a velocity direction to mean anything. */
  hasVelocity: boolean;
  /** Prograde marker, CSS px, and whether it projects behind the camera. */
  proX: number;
  proY: number;
  proBehind: boolean;
  retroX: number;
  retroY: number;
  retroBehind: boolean;
  /** Vertical speed, km/s, positive climbing; null hides the VSI row. */
  vsiKmS: number | null;
  /** Seconds to ground at the current sink rate; null hides it. */
  ttiS: number | null;
  /**
   * Overrides the vitals altitude: measured above terrain where a ground
   * sampler exists, and against the same body VEL is. Null = no reference.
   */
  altitudeKm: number | null;
  /** The body ALT is measured against. */
  altBody: string | null;
  /** The title line: where the ship is. */
  location: string;
}

// ---------------------------------------------------------------------------
// Small numeric helpers — all allocation-free
// ---------------------------------------------------------------------------

/**
 * Frame-rate independent exponential approach. `lambda` is the reciprocal of
 * the time constant: at lambda = 6 a value covers ~95% of its error in half a
 * second, which is about where a heavy instrument feels right.
 */
function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Deterministic 0..1 from an integer — used for flicker, never for generation. */
function hash01(n: number): number {
  let h = (n | 0) * 374761393;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** m:ss, h:mm:ss, or a floor for absurd waits. */
function clockText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 100 * 3600) return '>99h';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Signed speed with a unit that suits it: m/s below 1 km/s. */
function speedText(kmS: number): string {
  const a = Math.abs(kmS);
  const sign = kmS < 0 ? '−' : '+';
  return a < 1 ? `${sign}${fixed(a * 1000, 0)} m/s` : `${sign}${fixed(a, 2)} km/s`;
}

/** Avoids the "-0" that toFixed happily produces near zero. */
function fixed(v: number, decimals: number): string {
  const s = v.toFixed(decimals);
  return s === '-0' || /^-0\.0*$/.test(s) ? s.slice(1) : s;
}

/**
 * A style custom property with a memory. Writing a CSS variable forces a string
 * allocation, so we only do it once the value has moved by a visible amount.
 */
class CssVar {
  private last = Number.NaN;
  constructor(
    private readonly el: HTMLElement | SVGElement,
    private readonly name: string,
    private readonly quantum = 0.02,
    private readonly decimals = 2,
  ) {}

  set(v: number): void {
    if (Math.abs(v - this.last) < this.quantum) return;
    this.last = v;
    this.el.style.setProperty(this.name, v.toFixed(this.decimals));
  }
}

/** Text that is only written when it actually differs. */
class TextSlot {
  private last = '\0';
  constructor(private readonly el: Element) {}
  set(s: string): void {
    if (s === this.last) return;
    this.last = s;
    this.el.textContent = s;
  }
}

/**
 * A digit group. Damping alone is not enough to stop the last decimal buzzing:
 * a value hovering on a rounding boundary flips forever. The displayed number
 * therefore only re-quantises once the true value has moved three quarters of a
 * step away from what is currently on the glass.
 */
class Readout {
  private shown = Number.NaN;
  step(value: number, quantum: number): number {
    if (Number.isNaN(this.shown) || Math.abs(value - this.shown) >= quantum * 0.75) {
      this.shown = Math.round(value / quantum) * quantum;
    }
    return this.shown;
  }
  reset(): void {
    this.shown = Number.NaN;
  }
}

// ---------------------------------------------------------------------------
// Unit bands
// ---------------------------------------------------------------------------

/** km/s. Speed of light: the top of the speed tape. */
const C_KMS = 299792.458;

interface UnitBand {
  readonly label: string;
  /** Multiply the base (km or km/s) value by this to get display units. */
  readonly scale: number;
  readonly decimals: number;
  /** Upper bound of this band, in base units. */
  readonly max: number;
}

const SPEED_BANDS: readonly UnitBand[] = [
  { label: 'm/s', scale: 1000, decimals: 0, max: 1 },
  { label: 'km/s', scale: 1, decimals: 2, max: C_KMS * 0.01 },
  { label: 'c', scale: 1 / C_KMS, decimals: 4, max: C_KMS * 10 },
  // The cruise drive reaches a few hundred c. Four decimals there is noise
  // pretending to be precision, and the digits change too fast to read.
  { label: 'c', scale: 1 / C_KMS, decimals: 0, max: Infinity },
];

const ALT_BANDS: readonly UnitBand[] = [
  { label: 'm', scale: 1000, decimals: 0, max: 1 },
  { label: 'km', scale: 1, decimals: 1, max: 1e6 },
  { label: 'Mm', scale: 1e-3, decimals: 2, max: AU * 0.1 },
  { label: 'au', scale: 1 / AU, decimals: 3, max: Infinity },
];

/**
 * Pick a band for `value`, biased towards staying where it is. Without the
 * hysteresis factor a speed sitting exactly on 1 km/s would strobe between
 * "999 m/s" and "1.00 km/s" forever.
 */
function pickBand(bands: readonly UnitBand[], value: number, current: number): number {
  const HYST = 1.15;
  let i = clamp(current, 0, bands.length - 1) | 0;
  while (i < bands.length - 1 && value > bands[i]!.max * HYST) i++;
  while (i > 0 && value < bands[i - 1]!.max / HYST) i--;
  return i;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  parent?: Element,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  parent?.appendChild(node);
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  cls: string,
  parent?: Element,
  attrs?: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  if (cls) node.setAttribute('class', cls);
  if (attrs) for (const k in attrs) node.setAttribute(k, String(attrs[k]));
  parent?.appendChild(node);
  return node;
}

// ---------------------------------------------------------------------------
// Scrolling tape
// ---------------------------------------------------------------------------

const TAPE_ROWS = 7;
const TAPE_PX_PER_STEP = 26;

/**
 * A vertical tape scale. The minor ticks are a repeating gradient offset by a
 * single background-position, and only the seven numerals are real nodes — they
 * are recycled as they scroll off the ends rather than created and destroyed.
 */
class Tape {
  readonly root: HTMLDivElement;
  private readonly stripVar: CssVar;
  private readonly rowY: CssVar[] = [];
  private readonly rowText: TextSlot[] = [];

  constructor(parent: Element) {
    this.root = el('div', 'os-tape', parent);
    const strip = el('div', 'os-tape-strip', this.root);
    this.stripVar = new CssVar(strip, '--tape', 0.4, 1);
    for (let i = 0; i < TAPE_ROWS; i++) {
      const row = el('div', 'os-tape-row', this.root);
      el('i', 'os-tape-tick', row);
      const label = el('span', 'os-tape-num', row);
      this.rowY.push(new CssVar(row, '--ty', 0.4, 1));
      this.rowText.push(new TextSlot(label));
    }
  }

  /** `value` is already in display units. */
  update(value: number): void {
    // One step per half-decade keeps between 2 and 20 steps across the tape at
    // any magnitude, so the numerals never crowd and never go blank.
    const mag = Math.max(Math.abs(value), 1e-4);
    let step = Math.pow(10, Math.floor(Math.log10(mag))) / 2;
    if (!Number.isFinite(step) || step <= 0) step = 1;
    const decimals = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));

    const base = Math.floor(value / step);
    const mid = (TAPE_ROWS - 1) >> 1;
    for (let i = 0; i < TAPE_ROWS; i++) {
      const tickValue = (base + mid - i) * step;
      this.rowY[i]!.set(((value - tickValue) / step) * TAPE_PX_PER_STEP);
      this.rowText[i]!.set(fixed(tickValue, decimals));
    }
    this.stripVar.set((value / step - base) * TAPE_PX_PER_STEP);
  }
}

// ---------------------------------------------------------------------------
// Message log
// ---------------------------------------------------------------------------

const LOG_SLOTS = 6;
const LOG_LIFE = 8;

interface LogSlot {
  readonly root: HTMLDivElement;
  readonly text: TextSlot;
  readonly alpha: CssVar;
  age: number;
  live: boolean;
  tone: string;
}

// ---------------------------------------------------------------------------
// The HUD
// ---------------------------------------------------------------------------

const SCAN_LINES = 10;
/** Characters revealed per second by the scanner typewriter. */
const SCAN_CPS = 130;
/** Seconds the completed scan stays up before it retracts. */
const SCAN_HOLD = 12;
/**
 * SVG user units per degree of pitch. At 2.2 the masked reticle shows roughly
 * ±34°, which keeps five rungs on the glass — enough to read a climb, few
 * enough that the ladder never becomes a hatch pattern.
 */
const ATT_PX_PER_DEG = 2.2;

/**
 * Reticle geometry, in SVG user units.
 *
 * The viewBox starts at 0,0 and the reticle is centred at `ATT_C` *on purpose*.
 * With a viewBox whose origin is negative, `transform-box: view-box` +
 * `transform-origin: 50% 50%` is ambiguous: half the world resolves it to the
 * viewBox centre and half to (0.5·width, 0.5·height) *ignoring* min-x/min-y.
 * The browser this game shipped its review frames on chose the latter, so the
 * ladder rotated about a point 100 units down-and-right of the sight — which is
 * why the pitch bars lost their left arms, why the numerals collided with the
 * centre pip, and why the horizon survived only as a detached diagonal. With
 * min-x = min-y = 0 both readings give the same point and the ambiguity is gone.
 */
const ATT_C = 110;
/** Outer radius of the collimator mask. */
const ATT_R = 92;
/** Half-width of the gap the fixed reference sits in. */
const ATT_GAP = 30;
/** Half-width of a pitch bar. */
const ATT_ARM = 50;
/** Inboard edge of the rung numerals — always outboard of the bar end. */
const ATT_NUM = 54;
/** Radius of the roll scale. Outside `ATT_R`, so the two scales cannot touch. */
const ATT_ROLL_R = 100;
/** Full stick deflection puts the dot this far from the screen centre, CSS px. */
const STICK_RADIUS_PX = 64;

/** Inside the viewport with a small margin. Off-glass markers fade, never clamp. */
function onGlass(x: number, y: number, w: number, h: number): boolean {
  return x > 8 && x < w - 8 && y > 8 && y < h - 8;
}

export class Hud implements GameModule {
  readonly name = 'hud';

  // --- lifetime -----------------------------------------------------------
  private root: HTMLDivElement | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private offs: Array<() => void> = [];
  private onDismiss: (() => void) | null = null;
  private dismissEl: HTMLElement | null = null;
  private visible = true;
  private booted = false;
  private time = 0;

  // --- damped state -------------------------------------------------------
  private throttle = 0;
  private throttleTarget = 0;
  private speed = 0;
  private speedTarget = 0;
  private alt = 0;
  private altTarget = 0;
  private hasAlt = false;
  private pitch = 0;
  private pitchTarget = 0;
  private roll = 0;
  private rollTarget = 0;
  private gLoad = 1;
  private gLoadTarget = 1;
  private hasG = false;

  private warp = 0;
  private warpTarget = 0;
  /** Time since the last 'warp:charging'; the bar retracts if the drive stops. */
  private warpSilence = 99;

  private speedBand = 1;
  private altBand = 1;
  private speedSwap = 0;
  private altSwap = 0;

  // --- target -------------------------------------------------------------
  private hasTarget = false;
  private tgtName = '';
  private tgtKind = '';
  private tgtX = 0;
  private tgtY = 0;
  private tgtBehind = false;
  private tgtDist = 0;
  private tgtDistShown = 0;
  private tgtLeadX = 0;
  private tgtLeadY = 0;
  private tgtHasLead = false;
  private tgtHasClosing = false;
  private tgtClosing = 0;
  private tgtClosingShown = 0;
  private tgtEta: number | null = null;
  /** Screen-space bracket position, damped so the bracket lags the body. */
  private brX = 0;
  private brY = 0;
  private brInit = false;

  // --- instruments --------------------------------------------------------
  private hasVel = false;
  private proX = 0;
  private proY = 0;
  private proBehind = true;
  private retroX = 0;
  private retroY = 0;
  private retroBehind = true;
  private proShownX = 0;
  private proShownY = 0;
  private retroShownX = 0;
  private retroShownY = 0;
  private hasVsi = false;
  private vsiTarget = 0;
  private vsi = 0;
  private tti: number | null = null;
  private altBody = '';
  /** Stick deflection, -1..1 each axis, and its damped on-glass position. */
  private stickX = 0;
  private stickY = 0;
  private stickShownX = 0;
  private stickShownY = 0;
  private hasStick = false;

  // --- scanner ------------------------------------------------------------
  private scanState: 'idle' | 'busy' | 'show' = 'idle';
  private scanText: string[] = [];
  private scanShown: number[] = [];
  private scanTotal = 0;
  private scanReveal = 0;
  private scanHold = 0;

  // --- readouts (hysteresis) ---------------------------------------------
  private rThrottle = new Readout();
  private rSpeed = new Readout();
  private rAlt = new Readout();
  private rDist = new Readout();
  private rVsi = new Readout();
  private rTti = new Readout();
  private rClose = new Readout();
  private rG = new Readout();

  // --- nodes we mutate ----------------------------------------------------
  private vThrottleFill!: CssVar;
  private tThrottleNum!: TextSlot;
  private tAssist: TextSlot | null = null;
  private vThrottleIdx!: CssVar;

  private speedTape!: Tape;
  private altTape!: Tape;
  private tSpeedNum!: TextSlot;
  private tSpeedUnit!: TextSlot;
  private tAltNum!: TextSlot;
  private tAltUnit!: TextSlot;
  private elSpeedUnit!: HTMLElement;
  private elAltUnit!: HTMLElement;
  private elAltGauge!: HTMLElement;

  private vAttPitch!: CssVar;
  private vAttRoll!: CssVar;
  private vAttRollPtr!: CssVar;
  private tGLoad!: TextSlot;
  private elGLoad!: HTMLElement;

  private elTarget!: HTMLElement;
  private vTgtX!: CssVar;
  private vTgtY!: CssVar;
  private vTgtSize!: CssVar;
  private vTgtArrow!: CssVar;
  private vTgtLeadX!: CssVar;
  private vTgtLeadY!: CssVar;
  private tTgtName!: TextSlot;
  private tTgtKind!: TextSlot;
  private tTgtDist!: TextSlot;
  private elTgtLead!: HTMLElement;
  private tTgtClose!: TextSlot;

  private elPro!: HTMLElement;
  private vProX!: CssVar;
  private vProY!: CssVar;
  private elRetro!: HTMLElement;
  private vRetroX!: CssVar;
  private vRetroY!: CssVar;
  private elStick!: HTMLElement;
  private vStickX!: CssVar;
  private vStickY!: CssVar;
  private elVsi!: HTMLElement;
  private tVsi!: TextSlot;
  private tTti!: TextSlot;
  private elTti!: HTMLElement;
  private tAltBody!: TextSlot;

  private logSlots: LogSlot[] = [];

  private elScanner!: HTMLElement;
  private tScanTitle!: TextSlot;
  private scanRows: TextSlot[] = [];
  private tScanStatus!: TextSlot;

  private elWarp!: HTMLElement;
  private vWarp!: CssVar;
  private tWarpNum!: TextSlot;

  private tHeadScale!: TextSlot;
  private tHeadLoc!: TextSlot;

  /** Panels eligible for the wandering flicker. */
  private panels: HTMLElement[] = [];
  private flickerVars: CssVar[] = [];
  private flickerIdx = -1;

  // =========================================================================
  // Lifecycle
  // =========================================================================

  init(ctx: EngineContext): void {
    const host = document.getElementById('ui-root');
    if (!host) {
      console.warn('[Hud] #ui-root missing — the HUD will not be shown');
      return;
    }

    this.styleEl = document.createElement('style');
    this.styleEl.setAttribute('data-owner', 'os-hud');
    this.styleEl.textContent = CSS;
    document.head.appendChild(this.styleEl);

    this.root = el('div', 'os-hud os-cold', host);
    this.build(this.root);
    this.subscribe();

    registerHudShots(this);

    // Nothing has been fed to us yet; start the tapes where the ship is.
    this.layoutTarget(ctx.width, ctx.height);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    if (this.onDismiss && this.dismissEl) {
      this.dismissEl.removeEventListener('click', this.onDismiss);
    }
    this.onDismiss = null;
    this.dismissEl = null;
    this.root?.remove();
    this.root = null;
    this.styleEl?.remove();
    this.styleEl = null;
    this.panels.length = 0;
    this.flickerVars.length = 0;
    this.logSlots.length = 0;
    this.scanRows.length = 0;
  }

  // =========================================================================
  // Integrator API
  // =========================================================================

  /** Feed the instruments. Fields are copied; the object is not retained. */
  setVitals(v: HudVitals): void {
    this.throttleTarget = clamp(v.throttle, 0, 1);
    this.speedTarget = Math.max(0, v.speedKmS);
    if (v.altitudeKm === null || v.altitudeKm === undefined) {
      this.hasAlt = false;
    } else {
      this.hasAlt = true;
      this.altTarget = Math.max(0, v.altitudeKm);
    }
    this.pitchTarget = v.pitchRad;
    this.rollTarget = v.rollRad;
    if (v.gLoad === undefined) {
      this.hasG = false;
    } else {
      this.hasG = true;
      this.gLoadTarget = v.gLoad;
    }
  }

  /** Pass null to drop the bracket. Screen coordinates are CSS pixels. */
  setTarget(info: HudTarget | null): void {
    if (!info) {
      this.hasTarget = false;
      return;
    }
    this.hasTarget = true;
    this.tgtName = info.name;
    this.tgtKind = info.kind ?? '';
    this.tgtX = info.x;
    this.tgtY = info.y;
    this.tgtBehind = info.behind;
    this.tgtDist = Math.max(0, info.distanceKm);
    this.tgtHasLead = info.leadX !== undefined && info.leadY !== undefined;
    this.tgtLeadX = info.leadX ?? info.x;
    this.tgtLeadY = info.leadY ?? info.y;
    this.tgtHasClosing = info.closingKmS !== undefined;
    this.tgtClosing = info.closingKmS ?? 0;
    this.tgtEta = info.etaS ?? null;
  }

  /**
   * Feed the derived instruments. Call AFTER `setVitals` in the same frame:
   * the altitude here replaces the vitals one, because it is measured against
   * terrain and against the body VEL refers to.
   */
  setInstruments(i: HudInstruments): void {
    this.hasVel = i.hasVelocity;
    this.proX = i.proX;
    this.proY = i.proY;
    this.proBehind = i.proBehind;
    this.retroX = i.retroX;
    this.retroY = i.retroY;
    this.retroBehind = i.retroBehind;
    this.hasVsi = i.vsiKmS !== null;
    this.vsiTarget = i.vsiKmS ?? 0;
    this.tti = i.ttiS;
    if (i.altitudeKm === null) {
      this.hasAlt = false;
    } else {
      this.hasAlt = true;
      this.altTarget = Math.max(0, i.altitudeKm);
    }
    this.altBody = i.altBody ?? '';
    // Null before init() has built the DOM.
    this.tHeadLoc?.set(i.location);
  }

  /**
   * The virtual stick's deflection, each axis -1..1 (x right, y up). Drawn as
   * an amber dot offset from the screen centre. `null`, or a centred stick,
   * fades the dot out.
   */
  setStickDeflection(x: number | null, y = 0): void {
    if (x === null || (Math.abs(x) < 0.01 && Math.abs(y) < 0.01)) {
      this.hasStick = false;
      this.stickX = 0;
      this.stickY = 0;
      return;
    }
    this.hasStick = true;
    this.stickX = clamp(x, -1, 1);
    this.stickY = clamp(y, -1, 1);
  }

  /** The flight-assist line under the throttle gauge (game/assistReadout.ts). */
  setAssist(text: string): void {
    this.tAssist?.set(text);
  }

  setVisible(b: boolean): void {
    this.visible = b;
    this.root?.classList.toggle('os-hidden', !b);
  }

  /**
   * Run the power-on sequence. Normally triggered by 'boot:done'; exposed so a
   * review shot can bring the panel up without faking a boot.
   */
  powerOn(): void {
    if (!this.root || this.booted) return;
    this.booted = true;
    this.root.classList.remove('os-cold');
    this.root.classList.add('os-warm');
  }

  // =========================================================================
  // Frame
  // =========================================================================

  /**
   * All display work happens late: the integrator writes vitals and the target
   * projection during the normal update pass, and the glass should show that
   * same frame rather than trailing it by one.
   */
  lateUpdate(dt: number, ctx: EngineContext): void {
    if (!this.root) return;
    this.time += dt;

    // Damping runs even while hidden so nothing jumps when the HUD returns.
    this.throttle = damp(this.throttle, this.throttleTarget, 7, dt);
    this.speed = damp(this.speed, this.speedTarget, 4.5, dt);
    this.alt = damp(this.alt, this.altTarget, 4.5, dt);
    this.pitch = damp(this.pitch, this.pitchTarget, 9, dt);
    this.roll = damp(this.roll, this.rollTarget, 9, dt);
    this.gLoad = damp(this.gLoad, this.gLoadTarget, 5, dt);
    this.tgtDistShown = damp(this.tgtDistShown, this.tgtDist, 6, dt);
    this.tgtClosingShown = damp(this.tgtClosingShown, this.tgtClosing, 5, dt);
    this.vsi = damp(this.vsi, this.vsiTarget, 4.5, dt);
    // The stick dot is the pilot's own hand, so it is quick, but it still has
    // to travel, or a recentring stick would blink back to the middle.
    this.stickShownX = damp(this.stickShownX, this.stickX, 16, dt);
    this.stickShownY = damp(this.stickShownY, this.stickY, 16, dt);

    this.warpSilence += dt;
    if (this.warpSilence > 0.6) this.warpTarget = 0;
    this.warp = damp(this.warp, this.warpTarget, 5, dt);

    if (this.speedSwap > 0) this.speedSwap -= dt;
    if (this.altSwap > 0) this.altSwap -= dt;

    this.tickLog(dt);
    this.tickScanner(dt);

    if (!this.visible) return;

    this.drawThrottle();
    this.drawTapes();
    this.drawAttitude();
    this.drawTarget(ctx.width, ctx.height, dt);
    this.drawMarkers(ctx.width, ctx.height, dt);
    this.drawStick(ctx.width, ctx.height);
    this.drawWarp();
    this.drawFlicker();
  }

  resize(width: number, height: number): void {
    this.layoutTarget(width, height);
  }

  // =========================================================================
  // Drawing — text and custom properties only, never structure
  // =========================================================================

  private drawThrottle(): void {
    this.vThrottleFill.set(this.throttle);
    this.vThrottleIdx.set(this.throttle);
    const pct = this.rThrottle.step(this.throttle * 100, 1);
    this.tThrottleNum.set(fixed(pct, 0).padStart(3, '0'));
  }

  private drawTapes(): void {
    const sb = pickBand(SPEED_BANDS, this.speed, this.speedBand);
    if (sb !== this.speedBand) {
      this.speedBand = sb;
      this.speedSwap = 0.42;
      this.rSpeed.reset();
    }
    const sband = SPEED_BANDS[this.speedBand]!;
    const sval = this.speed * sband.scale;
    const sq = Math.pow(10, -sband.decimals);
    this.tSpeedNum.set(fixed(this.rSpeed.step(sval, sq), sband.decimals));
    this.tSpeedUnit.set(sband.label);
    this.elSpeedUnit.classList.toggle('os-swap', this.speedSwap > 0);
    this.speedTape.update(sval);

    this.elAltGauge.classList.toggle('os-void', !this.hasAlt);
    if (this.hasAlt) {
      const ab = pickBand(ALT_BANDS, this.alt, this.altBand);
      if (ab !== this.altBand) {
        this.altBand = ab;
        this.altSwap = 0.42;
        this.rAlt.reset();
      }
      const aband = ALT_BANDS[this.altBand]!;
      const aval = this.alt * aband.scale;
      const aq = Math.pow(10, -aband.decimals);
      this.tAltNum.set(fixed(this.rAlt.step(aval, aq), aband.decimals));
      this.tAltUnit.set(aband.label);
      this.altTape.update(aval);
      this.tAltBody.set(this.altBody);
    } else {
      this.tAltNum.set('- - -');
      this.tAltUnit.set('no ref');
      this.tAltBody.set('');
    }
    this.elAltUnit.classList.toggle('os-swap', this.altSwap > 0);

    // Vertical speed, in m/s below 1 km/s so it reads in the same units as
    // the landing limits the log grades touchdowns against.
    this.elVsi.classList.toggle('os-void', !this.hasVsi);
    if (this.hasVsi) {
      const q = Math.abs(this.vsi) < 1 ? 0.001 : 0.01;
      this.tVsi.set(speedText(this.rVsi.step(this.vsi, q)));
    }
    const tti = this.tti;
    this.elTti.classList.toggle('os-void', tti === null);
    this.elTti.classList.toggle('os-warn', tti !== null && tti < 30);
    if (tti !== null) this.tTti.set(clockText(this.rTti.step(tti, 1)));
  }

  private drawAttitude(): void {
    const pitchDeg = (this.pitch * 180) / Math.PI;
    const rollDeg = (this.roll * 180) / Math.PI;
    this.vAttPitch.set(clamp(pitchDeg, -95, 95) * ATT_PX_PER_DEG);
    // The ladder and the roll index belong to the horizon, so they counter-rotate.
    this.vAttRoll.set(-rollDeg);
    this.vAttRollPtr.set(-clamp(rollDeg, -75, 75));

    this.elGLoad.classList.toggle('os-void', !this.hasG);
    if (this.hasG) this.tGLoad.set(`${fixed(this.rG.step(this.gLoad, 0.1), 1)}g`);
  }

  private drawTarget(w: number, h: number, dt: number): void {
    this.elTarget.classList.toggle('os-void', !this.hasTarget);
    if (!this.hasTarget) {
      this.brInit = false;
      return;
    }

    const cx = w * 0.5;
    const cy = h * 0.5;
    // A target behind the camera projects to a mirrored point; flip it back so
    // the edge arrow points the short way round rather than the wrong way.
    let dx = this.tgtX - cx;
    let dy = this.tgtY - cy;
    if (this.tgtBehind) {
      dx = -dx;
      dy = -dy;
    }

    const marginX = w * 0.5 - 54;
    const marginY = h * 0.5 - 54;
    const off = this.tgtBehind || Math.abs(dx) > marginX || Math.abs(dy) > marginY;

    let px: number;
    let py: number;
    if (off) {
      // Clamp along the ray so the marker slides around the frame edge instead
      // of stopping in a corner.
      const s = Math.min(marginX / Math.max(Math.abs(dx), 1e-3), marginY / Math.max(Math.abs(dy), 1e-3));
      px = cx + dx * s;
      py = cy + dy * s;
      this.vTgtArrow.set((Math.atan2(dy, dx) * 180) / Math.PI);
    } else {
      px = cx + dx;
      py = cy + dy;
    }
    this.elTarget.classList.toggle('os-off', off);
    // The name block is wider than the bracket; against the right edge it would
    // hang off the glass, so it swaps to the other side of the reticle.
    this.elTarget.classList.toggle('os-flip', px > w - 230);

    if (!this.brInit) {
      this.brX = px;
      this.brY = py;
      this.brInit = true;
    }
    // The bracket has mass: it trails the body slightly and settles onto it.
    this.brX = damp(this.brX, px, off ? 22 : 14, dt);
    this.brY = damp(this.brY, py, off ? 22 : 14, dt);
    this.vTgtX.set(this.brX);
    this.vTgtY.set(this.brY);

    // Bracket opens up as you close: 30px at a million km, 62px alongside.
    const closeness = 1 - clamp(Math.log10(Math.max(this.tgtDistShown, 1)) / 6, 0, 1);
    this.vTgtSize.set(30 + closeness * 32);

    this.elTgtLead.classList.toggle('os-void', !this.tgtHasLead || off);
    if (this.tgtHasLead && !off) {
      this.vTgtLeadX.set(clamp(this.tgtLeadX - px, -240, 240));
      this.vTgtLeadY.set(clamp(this.tgtLeadY - py, -240, 240));
    }

    this.tTgtName.set(this.tgtName);
    this.tTgtKind.set(this.tgtKind);
    const band = ALT_BANDS[pickBand(ALT_BANDS, this.tgtDistShown, 1)]!;
    const dv = this.tgtDistShown * band.scale;
    this.tTgtDist.set(`${fixed(this.rDist.step(dv, Math.pow(10, -band.decimals)), band.decimals)} ${band.label}`);

    if (!this.tgtHasClosing) {
      this.tTgtClose.set('');
    } else {
      const c = this.rClose.step(this.tgtClosingShown, Math.abs(this.tgtClosingShown) < 1 ? 0.001 : 0.01);
      const eta = this.tgtEta;
      this.tTgtClose.set(
        eta !== null
          ? `${speedText(c)} · eta ${clockText(eta)}`
          : c < 0
            ? `${speedText(c)} · opening`
            : speedText(c),
      );
    }
  }

  /**
   * Prograde and retrograde. Only one of the pair is ever in front of the
   * camera; the other fades out rather than being clamped to the edge, since
   * an edge-clamped velocity marker reads as a target.
   */
  private drawMarkers(w: number, h: number, dt: number): void {
    const proOn = this.hasVel && !this.proBehind && onGlass(this.proX, this.proY, w, h);
    const retroOn = this.hasVel && !this.retroBehind && onGlass(this.retroX, this.retroY, w, h);
    this.elPro.classList.toggle('os-void', !proOn);
    this.elRetro.classList.toggle('os-void', !retroOn);
    // Damped only while on the glass. A marker re-entering from behind moves
    // to its point while still invisible, then fades in where it belongs.
    if (proOn) {
      this.proShownX = damp(this.proShownX, this.proX, 12, dt);
      this.proShownY = damp(this.proShownY, this.proY, 12, dt);
    } else {
      this.proShownX = this.proX;
      this.proShownY = this.proY;
    }
    if (retroOn) {
      this.retroShownX = damp(this.retroShownX, this.retroX, 12, dt);
      this.retroShownY = damp(this.retroShownY, this.retroY, 12, dt);
    } else {
      this.retroShownX = this.retroX;
      this.retroShownY = this.retroY;
    }
    this.vProX.set(this.proShownX);
    this.vProY.set(this.proShownY);
    this.vRetroX.set(this.retroShownX);
    this.vRetroY.set(this.retroShownY);
  }

  /** The stick dot sits within `STICK_RADIUS_PX` of the screen centre. */
  private drawStick(w: number, h: number): void {
    const moving = Math.abs(this.stickShownX) + Math.abs(this.stickShownY) > 0.01;
    this.elStick.classList.toggle('os-void', !this.hasStick && !moving);
    this.vStickX.set(w * 0.5 + this.stickShownX * STICK_RADIUS_PX);
    // Screen y grows downward; stick up is nose up.
    this.vStickY.set(h * 0.5 - this.stickShownY * STICK_RADIUS_PX);
  }

  private drawWarp(): void {
    this.vWarp.set(this.warp);
    this.elWarp.classList.toggle('os-void', this.warp < 0.005);
    this.tWarpNum.set(`${Math.round(this.warp * 100)}`.padStart(3, '0'));
  }

  /**
   * One panel at a time browns out for a fraction of a second. Driven from
   * simulated time rather than a CSS animation so a review screenshot of the
   * same frame is always the same frame.
   */
  private drawFlicker(): void {
    const WINDOW = 2.9;
    const slot = Math.floor(this.time / WINDOW);
    const local = this.time - slot * WINDOW;
    const fires = hash01(slot) < 0.5;
    const start = 0.3 + hash01(slot * 7 + 1) * 1.9;
    const len = 0.06 + hash01(slot * 13 + 3) * 0.1;
    const idx = Math.floor(hash01(slot * 31 + 5) * this.panels.length);
    const on = fires && local > start && local < start + len;

    const want = on ? idx : -1;
    if (want === this.flickerIdx) {
      if (want >= 0) {
        // A dying tube stutters rather than dims smoothly.
        const f = (local - start) / len;
        this.flickerVars[want]!.set(0.45 + 0.4 * Math.abs(Math.sin(f * 17)));
      }
      return;
    }
    if (this.flickerIdx >= 0) this.flickerVars[this.flickerIdx]!.set(1);
    this.flickerIdx = want;
    if (want >= 0) this.flickerVars[want]!.set(0.55);
  }

  private tickLog(dt: number): void {
    for (let i = 0; i < this.logSlots.length; i++) {
      const s = this.logSlots[i]!;
      if (!s.live) continue;
      s.age += dt;
      if (s.age >= LOG_LIFE) {
        s.live = false;
        s.alpha.set(0);
        s.text.set('');
        continue;
      }
      // Solid for six seconds, then it burns off the phosphor.
      s.alpha.set(clamp((LOG_LIFE - s.age) / 2, 0, 1));
    }
  }

  private tickScanner(dt: number): void {
    if (this.scanState === 'idle') return;

    if (this.scanState === 'busy') {
      // The status line counts up so the panel is never inert while waiting.
      this.tScanStatus.set(`acquiring${'.'.repeat(Math.floor(this.time * 2) % 4)}`);
      return;
    }

    if (this.scanReveal < this.scanTotal) {
      this.scanReveal = Math.min(this.scanTotal, this.scanReveal + dt * SCAN_CPS);
      let consumed = 0;
      for (let i = 0; i < this.scanRows.length; i++) {
        const full = this.scanText[i] ?? '';
        const avail = Math.floor(this.scanReveal) - consumed;
        const shown = clamp(avail, 0, full.length);
        if (shown !== this.scanShown[i]) {
          this.scanShown[i] = shown;
          // Slicing allocates, but only while characters are actually arriving.
          // The block cursor belongs to the one line currently being printed —
          // lines the beam has not reached yet stay blank.
          this.scanRows[i]!.set(
            shown >= full.length ? full : shown === 0 ? '' : `${full.slice(0, shown)}█`,
          );
        }
        consumed += full.length;
      }
      this.tScanStatus.set('decoding');
      return;
    }

    this.scanHold += dt;
    this.tScanStatus.set('complete');
    if (this.scanHold > SCAN_HOLD) this.hideScanner();
  }

  private hideScanner(): void {
    this.scanState = 'idle';
    this.elScanner.classList.add('os-void');
  }

  // =========================================================================
  // Bus
  // =========================================================================

  private subscribe(): void {
    this.offs.push(
      bus.on('boot:done', () => this.powerOn()),

      bus.on('log', ({ text, tone }) => this.pushLog(text, tone ?? 'normal')),

      bus.on('throttle:changed', ({ value }) => {
        this.throttleTarget = clamp(value, 0, 1);
      }),

      bus.on('target:changed', ({ name }) => {
        // The integrator still owns the projection; this only clears the glass
        // the instant the pilot cycles away from a target.
        if (name === null) this.hasTarget = false;
      }),

      bus.on('warp:charging', ({ progress }) => {
        this.warpTarget = clamp(progress, 0, 1);
        this.warpSilence = 0;
      }),
      bus.on('warp:engaged', () => {
        this.warpTarget = 1;
        this.warpSilence = 0;
      }),
      bus.on('warp:aborted', () => {
        this.warpTarget = 0;
        this.warpSilence = 99;
      }),

      bus.on('scan:started', () => {
        this.scanState = 'busy';
        this.scanReveal = 0;
        this.scanHold = 0;
        this.tScanTitle.set('unknown contact');
        for (let i = 0; i < this.scanRows.length; i++) {
          this.scanText[i] = '';
          this.scanShown[i] = -1;
          this.scanRows[i]!.set('');
        }
        this.elScanner.classList.remove('os-void');
      }),

      bus.on('scan:complete', (r) => this.showScan(r)),

      bus.on('scale:changed', ({ to }) => this.tHeadScale.set(scaleLabel(to))),
      bus.on('system:entered', ({ system }) => this.tHeadLoc.set(system.name)),
      // No 'planet:approached' here: it fires for every renderer streamed in,
      // so the title named whichever moon was acquired last (GAMEPLAY F9).
      // The location arrives with `setInstruments`, from the ship's parent.
      bus.on('galaxy:entered', ({ galaxy }) => this.tHeadLoc.set(galaxy.name)),
    );
  }

  private showScan(r: ScanResult): void {
    this.scanState = 'show';
    this.scanReveal = 0;
    this.scanHold = 0;
    this.scanTotal = 0;
    this.tScanTitle.set(r.name);
    for (let i = 0; i < this.scanRows.length; i++) {
      const line = i < r.lines.length ? r.lines[i]! : '';
      this.scanText[i] = line;
      this.scanShown[i] = -1;
      this.scanTotal += line.length;
    }
    this.elScanner.classList.remove('os-void');
  }

  private pushLog(text: string, tone: string): void {
    if (!this.logSlots.length) return;
    // Slots are fixed nodes; the contents shift down them so nothing is ever
    // created or destroyed at runtime.
    for (let i = this.logSlots.length - 1; i > 0; i--) {
      const dst = this.logSlots[i]!;
      const src = this.logSlots[i - 1]!;
      dst.age = src.age;
      dst.live = src.live;
      dst.tone = src.tone;
      dst.root.dataset.tone = src.tone;
      dst.text.set(src.live ? src.root.textContent ?? '' : '');
      dst.alpha.set(src.live ? clamp((LOG_LIFE - src.age) / 2, 0, 1) : 0);
    }
    const head = this.logSlots[0]!;
    head.age = 0;
    head.live = true;
    head.tone = tone;
    head.root.dataset.tone = tone;
    head.text.set(text);
    head.alpha.set(1);
  }

  // =========================================================================
  // Construction — runs once
  // =========================================================================

  private layoutTarget(_w: number, _h: number): void {
    // Kept as a hook: the bracket is positioned from ctx dimensions each frame,
    // so a resize only needs to invalidate the damped position.
    this.brInit = false;
  }

  private panel(cls: string, parent: Element, delayMs: number): HTMLDivElement {
    const p = el('div', `os-p ${cls}`, parent);
    p.style.setProperty('--d', `${delayMs}ms`);
    this.panels.push(p);
    this.flickerVars.push(new CssVar(p, '--fl', 0.02, 2));
    return p;
  }

  private build(root: HTMLElement): void {
    // Glass, in the order light meets it: hull shadow, then the collimator
    // vignette, then the aperture structure of the projector, then emulsion
    // grain, then the canopy frame everything else hangs off. All five are
    // static: they cost one composited quad each and nothing per frame.
    el('div', 'os-hull', root);
    el('div', 'os-vignette', root);
    el('div', 'os-scanlines', root);
    el('div', 'os-grain', root);
    el('div', 'os-canopy', root);

    this.buildHead(root);
    this.buildThrottle(root);
    this.buildRight(root);
    this.buildAttitude(root);
    this.buildTargetReticle(root);
    this.buildMarkers(root);
    this.buildLog(root);
    this.buildScanner(root);
    this.buildWarp(root);
  }

  private buildHead(root: HTMLElement): void {
    const p = this.panel('os-head', root, 60);
    const scale = el('span', 'os-head-scale', p, 'system');
    el('span', 'os-head-sep', p, '──');
    const loc = el('span', 'os-head-loc', p, 'uncharted');
    this.tHeadScale = new TextSlot(scale);
    this.tHeadLoc = new TextSlot(loc);
  }

  private buildThrottle(root: HTMLElement): void {
    const p = this.panel('os-thr', root, 180);
    el('div', 'os-label', p, 'thr');

    const body = el('div', 'os-thr-body', p);
    const ladder = el('div', 'os-thr-ladder', body);
    for (let i = 10; i >= 0; i--) {
      const t = el('div', i % 5 === 0 ? 'os-thr-tick os-major' : 'os-thr-tick', ladder);
      if (i % 5 === 0) el('span', 'os-thr-tlabel', t, String(i * 10));
    }

    const track = el('div', 'os-thr-track', body);
    const fill = el('i', 'os-thr-fill', track);
    const index = el('i', 'os-thr-index', track);
    this.vThrottleFill = new CssVar(fill, '--fill', 0.002, 3);
    this.vThrottleIdx = new CssVar(index, '--fill', 0.002, 3);

    const num = el('div', 'os-thr-num', p);
    const digits = el('span', 'os-num', num);
    el('span', 'os-unit', num, '%');
    this.tThrottleNum = new TextSlot(digits);
    // v2: what the flight computer is holding. Under FA-ON the gauge above is
    // engine output (0 % while holding speed in vacuum), so this line is the
    // only place the set speed is visible.
    this.tAssist = new TextSlot(el('div', 'os-thr-fa', p));
  }

  private buildRight(root: HTMLElement): void {
    const p = this.panel('os-right', root, 320);

    const spd = el('div', 'os-gauge', p);
    el('div', 'os-label', spd, 'vel');
    const spdRow = el('div', 'os-gauge-row', spd);
    this.speedTape = new Tape(spdRow);
    const spdBox = el('div', 'os-gauge-box', spdRow);
    const spdNum = el('span', 'os-num', spdBox);
    this.elSpeedUnit = el('span', 'os-unit', spdBox);
    this.tSpeedNum = new TextSlot(spdNum);
    this.tSpeedUnit = new TextSlot(this.elSpeedUnit);

    this.elAltGauge = el('div', 'os-gauge', p);
    const altLabel = el('div', 'os-label', this.elAltGauge, 'alt ');
    // Which world the altimeter is reading. VEL and ALT used to be able to
    // disagree about that without saying so (GAMEPLAY F11).
    this.tAltBody = new TextSlot(el('span', 'os-alt-body', altLabel));
    const altRow = el('div', 'os-gauge-row', this.elAltGauge);
    this.altTape = new Tape(altRow);
    const altBox = el('div', 'os-gauge-box', altRow);
    const altNum = el('span', 'os-num', altBox);
    this.elAltUnit = el('span', 'os-unit', altBox);
    this.tAltNum = new TextSlot(altNum);
    this.tAltUnit = new TextSlot(this.elAltUnit);

    const vs = el('div', 'os-vs', this.elAltGauge);
    this.elVsi = el('div', 'os-vs-row os-void', vs);
    el('span', 'os-label', this.elVsi, 'v/s');
    this.tVsi = new TextSlot(el('span', 'os-vs-num', this.elVsi));
    this.elTti = el('div', 'os-vs-row os-void', vs);
    el('span', 'os-label', this.elTti, 'impact');
    this.tTti = new TextSlot(el('span', 'os-vs-num', this.elTti));
  }

  private buildAttitude(root: HTMLElement): void {
    const p = this.panel('os-att', root, 420);
    const C = ATT_C;
    const s = svg('svg', 'os-att-svg', p, { viewBox: `0 0 ${C * 2} ${C * 2}` });

    // A hard circular clip guillotines the rung numerals as the ladder slides
    // under it. A soft radial mask lets them dissolve instead — which is also
    // what a real reflector sight does at the edge of the collimator.
    //
    // Both the gradient and the mask region are pinned to user space. Left on
    // their objectBoundingBox defaults they track the *transformed* bounding
    // box of the ladder, so the aperture changed shape every time the ship
    // rolled — a mask that moves with its subject masks nothing predictably.
    const defs = svg('defs', '', s);
    const grad = svg('radialGradient', '', defs, {
      id: 'os-att-fade',
      gradientUnits: 'userSpaceOnUse',
      cx: C,
      cy: C,
      r: ATT_R,
    });
    svg('stop', '', grad, { offset: '0.82', 'stop-color': '#fff' });
    svg('stop', '', grad, { offset: '0.93', 'stop-color': '#fff', 'stop-opacity': '0.55' });
    svg('stop', '', grad, { offset: '1', 'stop-color': '#000' });
    const mask = svg('mask', '', defs, {
      id: 'os-att-mask',
      maskUnits: 'userSpaceOnUse',
      x: 0,
      y: 0,
      width: C * 2,
      height: C * 2,
    });
    svg('circle', '', mask, { cx: C, cy: C, r: ATT_R, fill: 'url(#os-att-fade)' });

    const clipped = svg('g', '', s, { mask: 'url(#os-att-mask)' });
    const ladder = svg('g', 'os-att-ladder', clipped);
    // Rungs every 10° only. Five-degree infill reads as debris at this size — a
    // gunsight etches few lines and makes each one count. ±60° is as far as the
    // aperture can reach even at a steep climb; beyond that the nodes were only
    // ever masked geometry.
    for (let deg = -60; deg <= 60; deg += 10) {
      const y = C - deg * ATT_PX_PER_DEG;
      const g = svg('g', 'os-att-rung', ladder);
      if (deg === 0) {
        // The zero rung is the horizon: a broken line, never a filled sky. It
        // spans the full opaque width of the aperture so it always reads as a
        // horizon and never as an orphaned diagonal.
        svg('path', 'os-att-horizon', g, {
          d: `M ${C - 76} ${y} L ${C - ATT_GAP} ${y} M ${C + ATT_GAP} ${y} L ${C + 76} ${y}`,
        });
        continue;
      }
      // Rung ends hook towards the horizon, so which way is up stays readable
      // even when the ladder is upside down. Climb rungs are solid, descent
      // rungs are dashed — the oldest trick in the instrument book. Both arms
      // are drawn from the same numbers, so the bar is symmetric by
      // construction rather than by inspection.
      const drop = deg > 0 ? 5 : -5;
      const bar = svg('path', deg < 0 ? 'os-att-down' : '', g, {
        d:
          `M ${C - ATT_ARM} ${y + drop} L ${C - ATT_ARM} ${y} L ${C - ATT_GAP} ${y} ` +
          `M ${C + ATT_GAP} ${y} L ${C + ATT_ARM} ${y} L ${C + ATT_ARM} ${y + drop}`,
      });
      if (deg < 0) bar.setAttribute('stroke-dasharray', '4.5 3');
      // Numerals sit outboard of the bar end with 4 units of air, and the
      // baseline is nudged clear of the stroke. They can never cross the bar,
      // and since they live outside `ATT_ARM` they can never reach the fixed
      // reference either.
      const label = String(Math.abs(deg));
      svg('text', 'os-att-num', g, {
        x: C - ATT_NUM,
        y: y + 2.7,
        'text-anchor': 'end',
      }).textContent = label;
      svg('text', 'os-att-num', g, {
        x: C + ATT_NUM,
        y: y + 2.7,
        'text-anchor': 'start',
      }).textContent = label;
    }
    this.vAttPitch = new CssVar(ladder, '--pitch', 0.05, 2);
    this.vAttRoll = new CssVar(ladder, '--roll', 0.05, 2);

    // Fixed aircraft reference — the one thing on the HUD that never moves. It
    // is narrower than ATT_GAP, so at level flight it sits inside the horizon's
    // break instead of drawing a second line on top of it.
    svg('path', 'os-att-ref', s, {
      d: `M ${C - 28} ${C - 6} L ${C - 28} ${C} L ${C - 12} ${C} M ${C + 12} ${C} L ${C + 28} ${C} L ${C + 28} ${C - 6}`,
    });
    svg('circle', 'os-att-dot', s, { cx: C, cy: C, r: 1.7 });

    // Roll scale. Its own radius, its own weight, no numerals: at ATT_ROLL_R it
    // lives entirely outside the ladder's aperture, so the two scales can never
    // be mistaken for one another.
    const RR = ATT_ROLL_R;
    // Spans ±60° of bank about the vertical.
    const ax = (RR * Math.sin(Math.PI / 3)).toFixed(2);
    const ay = (RR * Math.cos(Math.PI / 3)).toFixed(2);
    svg('path', 'os-att-arc', s, {
      d: `M ${(C - +ax).toFixed(2)} ${(C - +ay).toFixed(2)} A ${RR} ${RR} 0 0 1 ${(C + +ax).toFixed(2)} ${(C - +ay).toFixed(2)}`,
    });
    const ticks = svg('g', 'os-att-rollticks', s);
    for (const b of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const long = b === 0 || Math.abs(b) === 30 || Math.abs(b) === 60;
      svg('line', long ? 'os-major' : '', ticks, {
        x1: C,
        y1: C - RR,
        x2: C,
        y2: C - RR + (long ? 8 : 4.5),
        // A rotate() *attribute* with an explicit centre — no transform-box, no
        // percentage origin, nothing for a UA to interpret.
        transform: `rotate(${b} ${C} ${C})`,
      });
    }
    const ptr = svg('path', 'os-att-rollptr', s, {
      d: `M ${C} ${C - RR} L ${C - 4.8} ${C - RR - 7.5} L ${C + 4.8} ${C - RR - 7.5} Z`,
    });
    this.vAttRollPtr = new CssVar(ptr, '--roll', 0.05, 2);

    this.elGLoad = el('div', 'os-att-g', p);
    this.tGLoad = new TextSlot(this.elGLoad);
  }

  private buildTargetReticle(root: HTMLElement): void {
    // Not a `panel`: it must not be picked for flicker, and it lives in the
    // middle of the frame where a power-on wipe would look like a glitch.
    const t = el('div', 'os-tgt os-void', root);
    this.elTarget = t;
    this.vTgtX = new CssVar(t, '--tx', 0.25, 1);
    this.vTgtY = new CssVar(t, '--ty', 0.25, 1);
    this.vTgtSize = new CssVar(t, '--sz', 0.4, 1);
    this.vTgtArrow = new CssVar(t, '--ang', 0.4, 1);

    const box = el('div', 'os-tgt-box', t);
    el('i', 'os-tgt-c os-tl', box);
    el('i', 'os-tgt-c os-tr', box);
    el('i', 'os-tgt-c os-bl', box);
    el('i', 'os-tgt-c os-br', box);

    const arrow = el('div', 'os-tgt-arrow', t);
    const arrowSvg = svg('svg', '', arrow, { viewBox: '0 0 20 20' });
    svg('path', '', arrowSvg, { d: 'M 3 4 L 16 10 L 3 16' });

    this.elTgtLead = el('div', 'os-tgt-lead', t);
    this.vTgtLeadX = new CssVar(this.elTgtLead, '--lx', 0.4, 1);
    this.vTgtLeadY = new CssVar(this.elTgtLead, '--ly', 0.4, 1);

    const info = el('div', 'os-tgt-info', t);
    const name = el('div', 'os-tgt-name', info);
    const kind = el('div', 'os-tgt-kind', info);
    const dist = el('div', 'os-tgt-dist', info);
    const close = el('div', 'os-tgt-close', info);
    this.tTgtName = new TextSlot(name);
    this.tTgtKind = new TextSlot(kind);
    this.tTgtDist = new TextSlot(dist);
    this.tTgtClose = new TextSlot(close);
  }

  private buildMarkers(root: HTMLElement): void {
    // Prograde: the classic ring with wings and a tail. Retrograde: the same
    // ring crossed out. Amber, never cyan: cyan is reserved for the nav target.
    this.elPro = el('div', 'os-vm os-void', root);
    const ps = svg('svg', '', this.elPro, { viewBox: '0 0 30 30' });
    svg('circle', '', ps, { cx: 15, cy: 15, r: 5.5 });
    svg('path', '', ps, { d: 'M 3 15 L 9.5 15 M 20.5 15 L 27 15 M 15 9.5 L 15 4' });
    this.vProX = new CssVar(this.elPro, '--vx', 0.25, 1);
    this.vProY = new CssVar(this.elPro, '--vy', 0.25, 1);

    this.elRetro = el('div', 'os-vm os-retro os-void', root);
    const rs = svg('svg', '', this.elRetro, { viewBox: '0 0 30 30' });
    svg('circle', '', rs, { cx: 15, cy: 15, r: 5.5 });
    svg('path', '', rs, {
      d: 'M 11.1 11.1 L 18.9 18.9 M 18.9 11.1 L 11.1 18.9 M 15 9.5 L 15 4 M 15 20.5 L 15 26',
    });
    this.vRetroX = new CssVar(this.elRetro, '--vx', 0.25, 1);
    this.vRetroY = new CssVar(this.elRetro, '--vy', 0.25, 1);

    this.elStick = el('div', 'os-stick os-void', root);
    this.vStickX = new CssVar(this.elStick, '--vx', 0.25, 1);
    this.vStickY = new CssVar(this.elStick, '--vy', 0.25, 1);
  }

  private buildLog(root: HTMLElement): void {
    const p = this.panel('os-log', root, 520);
    for (let i = 0; i < LOG_SLOTS; i++) {
      const line = el('div', 'os-log-line', p);
      line.dataset.tone = 'normal';
      const slot: LogSlot = {
        root: line,
        text: new TextSlot(line),
        alpha: new CssVar(line, '--a', 0.03, 2),
        age: LOG_LIFE,
        live: false,
        tone: 'normal',
      };
      slot.alpha.set(0);
      this.logSlots.push(slot);
    }
  }

  private buildScanner(root: HTMLElement): void {
    const p = this.panel('os-scan os-void', root, 620);
    this.elScanner = p;
    const head = el('div', 'os-scan-head', p);
    el('span', 'os-label', head, 'scan');
    const title = el('span', 'os-scan-title', head);
    this.tScanTitle = new TextSlot(title);

    const body = el('div', 'os-scan-body', p);
    for (let i = 0; i < SCAN_LINES; i++) {
      this.scanRows.push(new TextSlot(el('div', 'os-scan-line', body)));
      this.scanText.push('');
      this.scanShown.push(-1);
    }

    const foot = el('div', 'os-scan-foot', p);
    const status = el('span', 'os-scan-status', foot);
    this.tScanStatus = new TextSlot(status);
    const dismiss = el('button', 'os-scan-dismiss', foot, '[ dismiss ]');
    dismiss.type = 'button';
    this.onDismiss = () => this.hideScanner();
    dismiss.addEventListener('click', this.onDismiss);
    this.dismissEl = dismiss;
  }

  private buildWarp(root: HTMLElement): void {
    const p = this.panel('os-warp os-void', root, 700);
    this.elWarp = p;
    el('span', 'os-label', p, 'warp charge');
    const track = el('div', 'os-warp-track', p);
    const fill = el('i', 'os-warp-fill', track);
    this.vWarp = new CssVar(fill, '--w', 0.004, 3);
    const num = el('span', 'os-num os-warp-num', p);
    this.tWarpNum = new TextSlot(num);
  }
}

/** The scale name as an instrument would etch it. */
function scaleLabel(s: GameScale): string {
  switch (s) {
    case 'surface':
      return 'surface';
    case 'orbit':
      return 'orbital';
    case 'system':
      return 'in-system';
    case 'interstellar':
      return 'interstellar';
    case 'intergalactic':
      return 'intergalactic';
    default:
      return String(s);
  }
}

// ---------------------------------------------------------------------------
// Review shot
// ---------------------------------------------------------------------------

let shotsRegistered = false;

/**
 * Registers 'hud-full'. Called automatically by `Hud.init`; exported so the
 * integrator can attach it to a differently-constructed HUD if it ever needs to.
 */
export function registerHudShots(hud: Hud): void {
  if (shotsRegistered) return;
  shotsRegistered = true;

  // Preallocated so the shot itself obeys the no-allocation rule.
  const vitals: HudVitals = {
    throttle: 0.62,
    speedKmS: 41.7,
    altitudeKm: 2840,
    pitchRad: 0,
    rollRad: 0,
    gLoad: 1.4,
  };
  const target: HudTarget = {
    id: 'demo-target',
    name: 'kesh vaant iii',
    x: 0,
    y: 0,
    behind: false,
    distanceKm: 184_000,
    leadX: 0,
    leadY: 0,
    kind: 'ice giant — ringed',
  };
  const inst: HudInstruments = {
    hasVelocity: true,
    proX: 0,
    proY: 0,
    proBehind: false,
    retroX: 0,
    retroY: 0,
    retroBehind: true,
    vsiKmS: -0.042,
    ttiS: 2840 / 0.042,
    altitudeKm: 2840,
    altBody: 'kesh vaant iii',
    location: 'kesh vaant iii',
  };
  const scan: ScanResult = {
    targetId: 'demo-target',
    name: 'kesh vaant iii',
    lines: [
      'class .......... ice giant, ringed',
      'radius ......... 41 820 km',
      'gravity ........ 11.4 m/s²',
      'atmosphere ..... h2 / he / ch4 traces',
      'pressure ....... 3.9 bar at datum',
      'temperature .... 108 k mean',
      'rotation ....... 9 h 41 m retrograde',
      'moons .......... 14 catalogued',
      'anomaly ........ thermal plume, 61° s',
      'note ........... nobody has been here',
    ],
  };

  let t = 0;
  let logStep = 0;
  let scanStep = 0;

  registerShot({
    name: 'hud-full',
    description:
      'Every HUD element live at once: throttle ladder, scrolling velocity and altitude tapes with unit switch, attitude reticle at bank, tracked target bracket with lead indicator, message log, scanner readout mid-reveal and warp charge.',
    apply(ctx) {
      t = 0;
      logStep = 0;
      scanStep = 0;
      hud.setVisible(true);
      hud.powerOn();
      bus.emit('scale:changed', { from: 'system', to: 'orbit' });
      bus.emit('log', { text: 'orbital insertion nominal', tone: 'good' });
      bus.emit('log', { text: 'coolant loop 2 running warm', tone: 'warn' });
      bus.emit('log', { text: 'passive array locked on primary', tone: 'normal' });
      bus.emit('scan:complete', scan);
      hud.setVitals(vitals);
      inst.proX = ctx.width * 0.5 - 140;
      inst.proY = ctx.height * 0.5 + 60;
      hud.setInstruments(inst);
      target.closingKmS = 1.84;
      target.etaS = 1.84e3;
      target.x = ctx.width * 0.5 + 210;
      target.y = ctx.height * 0.5 - 96;
      hud.setTarget(target);
    },
    update(dt, ctx) {
      t += dt;
      // Slow, deterministic drift: the instruments must be seen settling, not
      // frozen — a still HUD hides exactly the damping this shot is judged on.
      vitals.throttle = 0.62 + Math.sin(t * 0.31) * 0.06;
      vitals.speedKmS = 41.7 + Math.sin(t * 0.23) * 4.5;
      vitals.altitudeKm = 2840 + Math.sin(t * 0.17) * 120;
      vitals.pitchRad = Math.sin(t * 0.19) * 0.16;
      vitals.rollRad = Math.sin(t * 0.13) * 0.32;
      vitals.gLoad = 1.4 + Math.sin(t * 0.41) * 0.15;
      hud.setVitals(vitals);
      inst.altitudeKm = vitals.altitudeKm;
      inst.vsiKmS = -0.042 + Math.sin(t * 0.29) * 0.006;
      inst.ttiS = (vitals.altitudeKm ?? 0) / 0.042;
      inst.proX = ctx.width * 0.5 - 140 + Math.sin(t * 0.15) * 12;
      inst.proY = ctx.height * 0.5 + 60 + Math.cos(t * 0.11) * 8;
      hud.setInstruments(inst);
      hud.setStickDeflection(0.32 + Math.sin(t * 0.37) * 0.1, -0.18);

      target.x = ctx.width * 0.5 + 210 + Math.sin(t * 0.21) * 40;
      target.y = ctx.height * 0.5 - 96 + Math.cos(t * 0.17) * 26;
      // Aim-ahead sits up and to the left of the body, clear of the name block.
      target.leadX = target.x - 54;
      target.leadY = target.y - 38;
      target.distanceKm = 184_000 - t * 120;
      hud.setTarget(target);

      bus.emit('warp:charging', { progress: 0.34 + Math.sin(t * 0.27) * 0.12 });

      if (t > logStep * 6 + 4) {
        logStep++;
        bus.emit('log', { text: `beacon drift ${(logStep * 0.7).toFixed(1)} arcsec`, tone: 'normal' });
      }
      // The scanner retracts on its own; bring it back so a late screenshot
      // still catches the panel.
      if (t > scanStep * 16 + 15) {
        scanStep++;
        bus.emit('scan:complete', scan);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Styles — owned entirely by this class, removed on dispose()
// ---------------------------------------------------------------------------

const CSS = /* css */ `
.os-hud {
  --os-amber: #ffb454;
  --os-amber-hi: #ffd49a;
  --os-cyan: #5fd7e0;
  /* Raised out of the mud: the old #6b7a85 had less luminance than a lit cloud
     band, so every label drawn over a planet disappeared into it. */
  --os-dim: #a8bac6;
  --os-warn: #ff5f56;
  --os-ink: rgba(3, 6, 8, 0.6);
  --os-etch: rgba(255, 180, 84, 0.34);
  /* Etched rules are 1px background boxes, so no text-shadow can reach them.
     This is the same idea in box-shadow form: a soft dark halo that keeps a
     hairline visible against a lit cloud deck. */
  --os-etch-shadow: 0 0 2px 1px rgba(0, 0, 0, 0.55);
  /* Every mark carries its own darkness. A HUD that is legible only against
     black is not a HUD; a projected reticle over a sunlit cloud deck still
     shades the deck behind it, and this is that shadow. */
  --os-shadow: 0 0 2px rgba(0, 0, 0, 0.92), 0 1px 2px rgba(0, 0, 0, 0.78);
  /* Three glow terms, not one: a tight core, a lens halo and a wide scatter.
     A single 6px shadow is a sticker; light that only exists at one radius is
     the tell that the HUD was pasted on rather than projected into the frame. */
  --os-glow: var(--os-shadow), 0 0 6px rgba(255, 180, 84, 0.5),
    0 0 18px rgba(255, 180, 84, 0.15), 0 0 44px rgba(255, 180, 84, 0.07);
  --os-glow-cyan: var(--os-shadow), 0 0 6px rgba(95, 215, 224, 0.5),
    0 0 20px rgba(95, 215, 224, 0.17), 0 0 46px rgba(95, 215, 224, 0.08);
  /* Seamless monochrome emulsion noise, matched to the PostFX grain amount so
     the two layers sit in the same image. Static, so it rasterises once. */
  --os-grain-src: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='220' height='220' filter='url(%23n)'/%3E%3C/svg%3E");
  position: absolute;
  inset: 0;
  pointer-events: none;
  color: var(--os-amber);
  font: 400 10px/1.35 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-variant-numeric: tabular-nums;
  /* Inherited, so anything that does not set its own glow still gets a shadow. */
  text-shadow: var(--os-shadow);
  opacity: 1;
  transition: opacity 0.55s ease;
}
.os-hud.os-hidden { opacity: 0; }
.os-hud .os-void { opacity: 0 !important; }

/* Panels ------------------------------------------------------------------ */
.os-hud .os-p { position: absolute; opacity: var(--fl, 1); }
.os-hud.os-cold .os-p { opacity: 0; }
.os-hud.os-warm .os-p {
  animation: os-power 0.62s var(--d, 0ms) cubic-bezier(0.2, 0.75, 0.25, 1) backwards;
}
@keyframes os-power {
  0%   { opacity: 0; clip-path: inset(48% -100% 48% -100%); filter: brightness(2.6); }
  32%  { opacity: 1; clip-path: inset(0 -100% 0 -100%); filter: brightness(2.6); }
  46%  { opacity: 0.25; }
  62%  { opacity: 1; }
  74%  { opacity: 0.6; }
  100% { opacity: 1; clip-path: inset(-100% -100% -100% -100%); filter: none; }
}

/* Glass ------------------------------------------------------------------- */
.os-hud .os-scanlines {
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    to bottom,
    rgba(255, 255, 255, 0.028) 0px,
    rgba(255, 255, 255, 0.028) 1px,
    transparent 1px,
    transparent 3px
  );
  mix-blend-mode: screen;
  opacity: 0.55;
}
.os-hud .os-grain {
  position: absolute;
  inset: 0;
  background-image: var(--os-grain-src);
  background-repeat: repeat;
  mix-blend-mode: overlay;
  opacity: 0.055;
}
.os-hud .os-vignette {
  position: absolute;
  inset: 0;
  /* Biased off-centre: the sight line is not the frame centre, and a symmetric
     vignette on an asymmetric composition reads as a filter, not as optics. */
  background: radial-gradient(ellipse at 45% 50%, transparent 48%, rgba(0, 0, 0, 0.55) 100%);
}
/* Hull. The dark corners the bottom instruments hang off — without them the
   right quarter of the frame is absence rather than shadow, and every panel
   floats. */
.os-hud .os-hull {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(to top right, rgba(1, 3, 5, 0.9) 0, rgba(1, 3, 5, 0) 210px) bottom left /
      330px 200px no-repeat,
    linear-gradient(to top left, rgba(1, 3, 5, 0.92) 0, rgba(1, 3, 5, 0) 230px) bottom right /
      380px 230px no-repeat,
    linear-gradient(to bottom, rgba(1, 3, 5, 0.5) 0, rgba(1, 3, 5, 0) 100%) top left / 100% 90px
      no-repeat;
}
/* Canopy frame. Corners cut away so it reads as structure rather than a border
   box; every edge panel is dimensioned to land on one of these rules. */
.os-hud .os-canopy {
  position: absolute;
  inset: 22px;
  border: 1px solid rgba(255, 180, 84, 0.17);
  clip-path: polygon(
    30px 0, calc(100% - 30px) 0,
    100% 30px, 100% calc(100% - 30px),
    calc(100% - 30px) 100%, 30px 100%,
    0 calc(100% - 30px), 0 30px
  );
}

/* Shared type ------------------------------------------------------------- */
.os-hud .os-label { color: var(--os-dim); letter-spacing: 0.34em; font-size: 9px; }
.os-hud .os-num {
  font-size: 20px;
  letter-spacing: 0.06em;
  color: var(--os-amber);
  text-shadow: var(--os-glow);
}
/* Unit suffixes are annotation, not state. They used to be cyan, which spent a
   saturated hue on nine unrelated roles and left it meaning nothing. */
.os-hud .os-unit {
  font-size: 9px;
  color: var(--os-dim);
  letter-spacing: 0.22em;
  display: inline-block;
  transition: opacity 0.18s linear;
}
.os-hud .os-unit.os-swap { animation: os-unitswap 0.42s ease-out; }
@keyframes os-unitswap {
  0%   { opacity: 0; transform: translateY(-6px); letter-spacing: 0.6em; }
  40%  { opacity: 1; }
  100% { opacity: 1; transform: translateY(0); letter-spacing: 0.22em; }
}

/* Header ------------------------------------------------------------------ */
.os-hud .os-head {
  top: 34px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 10px;
  align-items: baseline;
  color: var(--os-dim);
  font-size: 9px;
  letter-spacing: 0.4em;
}
.os-hud .os-head-scale { color: var(--os-dim); }
.os-hud .os-head-sep { opacity: 0.55; }
.os-hud .os-head-loc { color: var(--os-amber); text-shadow: var(--os-glow); }

/* Throttle ---------------------------------------------------------------- */
.os-hud .os-thr { left: 64px; top: 50%; transform: translateY(-50%); }
.os-hud .os-thr-body { display: flex; gap: 8px; margin: 8px 0 6px; height: 230px; }
.os-hud .os-thr-ladder {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: flex-end;
  width: 26px;
}
.os-hud .os-thr-tick {
  position: relative;
  width: 6px;
  height: 1px;
  background: var(--os-etch);
  box-shadow: var(--os-etch-shadow);
}
.os-hud .os-thr-tick.os-major { width: 12px; background: rgba(255, 190, 110, 0.7); }
.os-hud .os-thr-tlabel {
  position: absolute;
  right: 15px;
  top: -6px;
  font-size: 8px;
  color: var(--os-dim);
  letter-spacing: 0.12em;
}
.os-hud .os-thr-track {
  position: relative;
  width: 13px;
  border: 1px solid var(--os-etch);
  background: var(--os-ink);
}
/*
 * The segments are clipped, never scaled. Under "scaleY(var(--fill))" the 2/2px
 * comb was squashed by the throttle setting itself, so its period landed on an
 * arbitrary fraction of a device pixel and the bar moiréd — and the interference
 * pattern crawled as the pilot moved the lever. Clipping leaves the period fixed
 * in device pixels at every setting. The lit band is now wider than the dark gap
 * and the gap is nearly transparent, so the fill reads as a column of lamps
 * rather than a screen door.
 */
.os-hud .os-thr-fill {
  position: absolute;
  inset: 0;
  clip-path: inset(calc((1 - var(--fill, 0)) * 100%) 0 0 0);
  background: repeating-linear-gradient(
    to bottom,
    rgba(255, 190, 112, 0.92) 0px,
    rgba(255, 190, 112, 0.92) 3px,
    rgba(255, 180, 84, 0.1) 3px,
    rgba(255, 180, 84, 0.1) 7px
  );
}
/* The lit cap. The eye tracks a moving edge far better than a texture, so the
   level gets the brightest mark on the instrument. Amber, not cyan: throttle is
   a ship system, and cyan now means one thing only. */
.os-hud .os-thr-index {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(var(--fill, 0) * 100%);
  height: 2px;
  background: var(--os-amber-hi);
  box-shadow: 0 0 10px rgba(255, 180, 84, 0.85), 0 0 2px rgba(0, 0, 0, 0.9);
}
.os-hud .os-thr-num { display: flex; align-items: baseline; gap: 3px; }
.os-thr-fa {
  margin-top: 6px;
  font-size: 9px;
  letter-spacing: 0.16em;
  color: var(--os-amber);
  text-shadow: var(--os-shadow);
  white-space: nowrap;
}

/* Right stack ------------------------------------------------------------- */
.os-hud .os-right {
  right: 36px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 30px;
  align-items: flex-end;
}
.os-hud .os-gauge {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
  transition: opacity 0.5s ease;
}
/* Each gauge is tied to the canopy rule by a stub of etch, so the stack reads as
   bolted to the frame instead of hovering beside it. 36px inset - 14px stub
   lands exactly on the 22px frame line. */
.os-hud .os-gauge::after {
  content: '';
  position: absolute;
  right: -14px;
  top: 4px;
  width: 14px;
  height: 1px;
  background: rgba(255, 180, 84, 0.34);
}
.os-hud .os-gauge-row { display: flex; align-items: center; gap: 9px; }
.os-hud .os-gauge-box {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  min-width: 92px;
  padding: 4px 7px 3px;
  border: 1px solid var(--os-etch);
  background: var(--os-ink);
  box-shadow: 0 0 18px rgba(0, 0, 0, 0.55);
}
.os-hud .os-tape {
  position: relative;
  width: 54px;
  height: 190px;
  overflow: hidden;
  border-right: 1px solid var(--os-etch);
  /*
   * The fade has to be wider than the row pitch or it does not do its job. Rows
   * are 26px apart and the outermost of seven sits 78px from the middle; at the
   * old 22%/78% stops that numeral was still near half alpha when "overflow"
   * cut it, which is exactly the sliced "60" and "1500" in the review frames.
   * At 190px tall with these stops the mask reaches zero before the clip does,
   * so the end numerals genuinely dissolve.
   */
  -webkit-mask-image: linear-gradient(to bottom, transparent 0%, #000 26%, #000 74%, transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0%, #000 26%, #000 74%, transparent 100%);
}
.os-hud .os-tape-strip {
  position: absolute;
  inset: -30px 0 -30px auto;
  right: 0;
  width: 6px;
  background-image: repeating-linear-gradient(
    to bottom,
    var(--os-etch) 0px,
    var(--os-etch) 1px,
    transparent 1px,
    transparent 5.2px
  );
  background-position-y: calc(var(--tape, 0) * 1px);
}
.os-hud .os-tape-row {
  position: absolute;
  top: 50%;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  width: 100%;
  transform: translateY(calc(var(--ty, 0) * 1px - 50%));
}
.os-hud .os-tape-tick {
  width: 9px;
  height: 1px;
  background: rgba(255, 190, 110, 0.72);
  box-shadow: var(--os-etch-shadow);
  order: 2;
}
.os-hud .os-tape-num { font-size: 9px; color: var(--os-dim); letter-spacing: 0.1em; order: 1; }

/* Attitude ---------------------------------------------------------------- */
.os-hud .os-att {
  left: 50%;
  top: 50%;
  width: 330px;
  height: 330px;
  transform: translate(-50%, -50%);
}
.os-hud .os-att-svg {
  width: 100%;
  height: 100%;
  /*
   * The reticle is projected onto glass, so it owns a shadow and it is very
   * slightly soft. The drop-shadow is what makes an amber line survive an amber
   * cloud band — without it every stroke here sits at the planet's own
   * luminance and reads as a scratch. The 0.2px blur puts the collimated image
   * a hair behind the razor-crisp panel text, which is how a reflector sight
   * actually resolves. One filter chain on a 330px box, once a frame.
   */
  filter: drop-shadow(0 0 1.3px rgba(0, 0, 0, 0.95)) blur(0.2px);
}
.os-hud .os-att-svg path,
.os-hud .os-att-svg line { fill: none; stroke-width: 1; stroke-linecap: butt; }
.os-hud .os-att-rung path { stroke: rgba(255, 190, 110, 0.82); }
.os-hud .os-att-rung path.os-att-down { stroke: rgba(255, 190, 110, 0.6); }
/* The horizon is the strongest line in the ladder, and it is amber like every
   other attitude mark — cyan on it made a fourth role for a hue that now means
   "nav target" and nothing else. */
/* Specific enough to beat both the blanket stroke rule and ".os-att-rung path"
   on their own terms — the old rule had to reach for !important because it was
   less specific than the rule it meant to override, and its sibling
   ".os-att-ref" lost that same race silently and drew at 0.8 all along. */
.os-hud .os-att-rung path.os-att-horizon {
  stroke: var(--os-amber-hi);
  stroke-width: 1.35;
  filter: drop-shadow(0 0 3px rgba(255, 180, 84, 0.6));
}
.os-hud .os-att-num {
  font-size: 7.2px;
  fill: rgba(255, 200, 140, 0.9);
  letter-spacing: 0.08em;
  /* The numerals get the same darkness the strokes get from the group filter. */
  paint-order: stroke fill;
  stroke: rgba(0, 0, 0, 0.72);
  stroke-width: 1.6;
  stroke-linejoin: round;
}
/* viewBox origin is 0,0, so 50% 50% is the reticle centre under every reading of
   the spec. See ATT_C. */
.os-hud .os-att-ladder {
  transform-box: view-box;
  transform-origin: 50% 50%;
  transform: rotate(calc(var(--roll, 0) * 1deg)) translate(0, calc(var(--pitch, 0) * 1px));
}
.os-hud .os-att-svg path.os-att-ref { stroke: var(--os-amber-hi); stroke-width: 1.5; filter: drop-shadow(0 0 4px rgba(255, 180, 84, 0.55)); }
.os-hud .os-att-dot { fill: var(--os-amber-hi); stroke: none; }
/* Roll scale: its own radius, its own weight. Half the ladder's stroke so the
   two scales cannot be read as one instrument. */
.os-hud .os-att-svg path.os-att-arc { stroke: rgba(255, 180, 84, 0.4); stroke-width: 0.6; }
.os-hud .os-att-rollticks line { stroke: rgba(255, 180, 84, 0.5); stroke-width: 0.7; }
.os-hud .os-att-rollticks line.os-major { stroke: rgba(255, 180, 84, 0.8); stroke-width: 0.9; }
/* Wins over the blanket "every path is a stroke" rule above — this one is solid. */
.os-hud .os-att-svg path.os-att-rollptr {
  fill: var(--os-amber-hi);
  stroke: none;
  transform-box: view-box;
  transform-origin: 50% 50%;
  transform: rotate(calc(var(--roll, 0) * 1deg));
  filter: drop-shadow(0 0 4px rgba(255, 180, 84, 0.6));
}
.os-hud .os-att-g {
  position: absolute;
  left: 50%;
  bottom: 8px;
  transform: translateX(-50%);
  font-size: 9px;
  color: var(--os-dim);
  letter-spacing: 0.3em;
  transition: opacity 0.4s ease;
}

/* Target ------------------------------------------------------------------ */
.os-hud .os-tgt {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  transform: translate(calc(var(--tx, 0) * 1px), calc(var(--ty, 0) * 1px));
  transition: opacity 0.35s ease;
}
.os-hud .os-tgt-box {
  position: absolute;
  left: 0;
  top: 0;
  width: calc(var(--sz, 44) * 1px);
  height: calc(var(--sz, 44) * 1px);
  transform: translate(-50%, -50%);
  transition: opacity 0.25s linear;
}
.os-hud .os-tgt-c {
  position: absolute;
  width: 9px;
  height: 9px;
  border: 0 solid var(--os-cyan);
  filter: drop-shadow(0 0 4px rgba(95, 215, 224, 0.55)) drop-shadow(0 0 1px rgba(0, 0, 0, 0.9));
}
.os-hud .os-tgt-c.os-tl { left: 0; top: 0; border-left-width: 1px; border-top-width: 1px; }
.os-hud .os-tgt-c.os-tr { right: 0; top: 0; border-right-width: 1px; border-top-width: 1px; }
.os-hud .os-tgt-c.os-bl { left: 0; bottom: 0; border-left-width: 1px; border-bottom-width: 1px; }
.os-hud .os-tgt-c.os-br { right: 0; bottom: 0; border-right-width: 1px; border-bottom-width: 1px; }
.os-hud .os-tgt-lead {
  position: absolute;
  left: 0;
  top: 0;
  width: 11px;
  height: 11px;
  border: 1px solid var(--os-amber);
  transform: translate(calc(var(--lx, 0) * 1px - 50%), calc(var(--ly, 0) * 1px - 50%)) rotate(45deg);
  box-shadow: 0 0 7px rgba(255, 180, 84, 0.4), 0 0 2px 1px rgba(0, 0, 0, 0.7);
  transition: opacity 0.25s linear;
}
.os-hud .os-tgt-info {
  position: absolute;
  left: calc(var(--sz, 44) * 0.5px + 12px);
  top: 2px;
  white-space: nowrap;
  border-left: 1px solid rgba(95, 215, 224, 0.35);
  padding-left: 8px;
}
.os-hud .os-tgt.os-flip .os-tgt-info {
  left: auto;
  right: calc(var(--sz, 44) * 0.5px + 12px);
  text-align: right;
  border-left: 0;
  border-right: 1px solid rgba(95, 215, 224, 0.35);
  padding-left: 0;
  padding-right: 8px;
}
.os-hud .os-tgt-name { color: var(--os-cyan); font-size: 10px; letter-spacing: 0.26em; text-shadow: var(--os-glow-cyan); }
/* Was grey-on-cream and simply absent over a lit planet. Dimmed amber keeps it
   subordinate to the name without letting it leave the frame. */
.os-hud .os-tgt-kind {
  color: rgba(255, 202, 146, 0.78);
  font-size: 8px;
  letter-spacing: 0.2em;
  text-shadow: var(--os-shadow), 0 0 5px rgba(255, 180, 84, 0.25);
}
.os-hud .os-tgt-dist { color: var(--os-amber); font-size: 11px; letter-spacing: 0.14em; margin-top: 2px; text-shadow: var(--os-glow); }
.os-hud .os-tgt-close { color: var(--os-amber); opacity: 0.78; font-size: 9px; letter-spacing: 0.16em; margin-top: 1px; text-transform: lowercase; }

/* Velocity markers and stick ----------------------------------------------- */
.os-hud .os-vm {
  position: absolute;
  left: 0;
  top: 0;
  width: 30px;
  height: 30px;
  transform: translate(calc(var(--vx, 0) * 1px - 50%), calc(var(--vy, 0) * 1px - 50%));
  transition: opacity 0.3s ease;
}
.os-hud .os-vm svg { width: 100%; height: 100%; overflow: visible; }
.os-hud .os-vm circle, .os-hud .os-vm path {
  fill: none;
  stroke: var(--os-amber-hi);
  stroke-width: 1.3;
  filter: drop-shadow(0 0 3px rgba(255, 180, 84, 0.5)) drop-shadow(0 0 1px rgba(0, 0, 0, 0.9));
}
.os-hud .os-vm.os-retro { opacity: 0.72; }
.os-hud .os-stick {
  position: absolute;
  left: 0;
  top: 0;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--os-amber-hi);
  box-shadow: 0 0 6px rgba(255, 180, 84, 0.6), 0 0 2px 1px rgba(0, 0, 0, 0.7);
  transform: translate(calc(var(--vx, 0) * 1px - 50%), calc(var(--vy, 0) * 1px - 50%));
  transition: opacity 0.3s ease;
}

/* Vertical speed ------------------------------------------------------------ */
.os-hud .os-alt-body { color: var(--os-amber); letter-spacing: 0.22em; }
.os-hud .os-vs { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; margin-top: 2px; }
.os-hud .os-vs-row { display: flex; gap: 8px; align-items: baseline; transition: opacity 0.4s ease; }
.os-hud .os-vs-num { color: var(--os-amber); font-size: 11px; letter-spacing: 0.12em; text-shadow: var(--os-glow); text-transform: lowercase; }
.os-hud .os-vs-row.os-warn .os-vs-num { color: var(--os-warn); }
.os-hud .os-tgt-arrow {
  position: absolute;
  left: 0;
  top: 0;
  width: 20px;
  height: 20px;
  transform: translate(-50%, -50%) rotate(calc(var(--ang, 0) * 1deg));
  opacity: 0;
  transition: opacity 0.25s linear;
}
.os-hud .os-tgt-arrow svg { width: 100%; height: 100%; }
.os-hud .os-tgt-arrow path { fill: none; stroke: var(--os-cyan); stroke-width: 1.4; filter: drop-shadow(0 0 4px rgba(95, 215, 224, 0.6)); }
.os-hud .os-tgt.os-off .os-tgt-box { opacity: 0.25; }
.os-hud .os-tgt.os-off .os-tgt-arrow { opacity: 1; }
.os-hud .os-tgt.os-off .os-tgt-info { opacity: 0.75; }

/* Message log ------------------------------------------------------------- */
.os-hud .os-log {
  left: 36px;
  bottom: 34px;
  width: 30ch;
  display: flex;
  flex-direction: column-reverse;
  gap: 3px;
}
.os-hud .os-log-line {
  opacity: var(--a, 0);
  color: var(--os-amber);
  font-size: 9.5px;
  letter-spacing: 0.16em;
  white-space: nowrap;
  border-left: 1px solid currentColor;
  padding-left: 7px;
  text-shadow: var(--os-shadow), 0 0 7px rgba(255, 180, 84, 0.3);
  transition: opacity 0.25s linear;
}
.os-hud .os-log-line[data-tone="warn"] { color: var(--os-warn); text-shadow: var(--os-shadow), 0 0 8px rgba(255, 95, 86, 0.4); }
.os-hud .os-log-line[data-tone="good"] { color: var(--os-amber-hi); text-shadow: var(--os-glow); }

/* Scanner ----------------------------------------------------------------- */
/*
 * A cathode panel, not a debug rectangle: the top-right corner is cut, the fill
 * carries the same line structure as the rest of the glass, and it throws a
 * shadow so it separates from the black it sits on instead of dissolving into
 * it. It is the largest single shape on the HUD and it has to hold up.
 */
.os-hud .os-scan {
  right: 22px;
  bottom: 22px;
  width: 330px;
  padding: 9px 12px 8px;
  border: 1px solid var(--os-etch);
  border-top: 1px solid rgba(95, 215, 224, 0.55);
  background:
    repeating-linear-gradient(
      to bottom,
      rgba(255, 210, 150, 0.022) 0px,
      rgba(255, 210, 150, 0.022) 1px,
      transparent 1px,
      transparent 3px
    ),
    linear-gradient(to bottom, rgba(15, 24, 30, 0.82), rgba(2, 5, 7, 0.8));
  box-shadow: inset 0 0 34px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 210, 150, 0.06);
  clip-path: polygon(0 0, calc(100% - 15px) 0, 100% 15px, 100% 100%, 0 100%);
  /* drop-shadow, not box-shadow: clip-path would have cut an outer box-shadow
     away with the corner. The panel casts onto the canopy behind it. */
  filter: drop-shadow(0 5px 16px rgba(0, 0, 0, 0.9));
  transition: opacity 0.5s ease;
}
.os-hud .os-scan-head { position: relative; display: flex; gap: 9px; align-items: baseline; margin-bottom: 7px; padding-left: 8px; }
/* A tab for the SCAN label to hang off, so the header row is anchored. */
.os-hud .os-scan-head::before {
  content: '';
  position: absolute;
  left: -12px;
  top: 0;
  bottom: 1px;
  width: 3px;
  background: var(--os-amber);
  box-shadow: 0 0 8px rgba(255, 180, 84, 0.5);
}
.os-hud .os-scan-title { color: var(--os-cyan); letter-spacing: 0.3em; font-size: 10px; text-shadow: var(--os-glow-cyan); }
.os-hud .os-scan-body { display: flex; flex-direction: column; gap: 1px; }
.os-hud .os-scan-line {
  font-size: 9px;
  letter-spacing: 0.1em;
  color: rgba(255, 190, 110, 0.9);
  white-space: pre;
  min-height: 12px;
  text-shadow: var(--os-shadow), 0 0 6px rgba(255, 180, 84, 0.22);
}
.os-hud .os-scan-foot {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-top: 8px;
  border-top: 1px solid rgba(255, 180, 84, 0.16);
  padding-top: 5px;
}
.os-hud .os-scan-status { color: var(--os-dim); font-size: 8px; letter-spacing: 0.3em; }
.os-hud .os-scan-dismiss {
  pointer-events: auto;
  cursor: crosshair;
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  font-size: 8px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--os-dim);
  transition: color 0.2s linear;
}
.os-hud .os-scan-dismiss:hover { color: var(--os-cyan); }

/* Warp -------------------------------------------------------------------- */
.os-hud .os-warp {
  left: 50%;
  bottom: 34px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  transition: opacity 0.6s ease;
}
.os-hud .os-warp-track {
  position: relative;
  width: 210px;
  height: 3px;
  border: 1px solid var(--os-etch);
  background: var(--os-ink);
  overflow: hidden;
}
/* Warp charge is a ship system like the throttle, so it is amber. Cyan is
   reserved for the nav target: the bracket, the target name and the scan title. */
.os-hud .os-warp-fill {
  position: absolute;
  inset: 0;
  transform-origin: 0 50%;
  transform: scaleX(var(--w, 0));
  background: var(--os-amber-hi);
  box-shadow: 0 0 12px rgba(255, 180, 84, 0.7);
}
.os-hud .os-warp-num { font-size: 11px; color: var(--os-amber); text-shadow: var(--os-glow); }

@media (max-width: 900px) {
  .os-hud .os-scan { width: 250px; }
  .os-hud .os-att { width: 240px; height: 240px; }
  .os-hud .os-canopy { inset: 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .os-hud.os-warm .os-p { animation-duration: 0.01ms; }
  .os-hud .os-unit.os-swap { animation: none; }
}
`;
