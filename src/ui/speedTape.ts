/**
 * Log-compressed tape scale (v3 PLAN F / H1).
 *
 * Position on the tape is `tapeScale(v) = log10(1 + v / v0)`: linear below v0,
 * logarithmic above, smooth everywhere. A tick for a given value therefore has
 * one place on the scale at every speed, and crossing a decade is only more
 * scrolling — v2's tape re-stepped ×10 there and every numeral jumped. Ticks
 * sit on the 1-2-5 ladder; ticks that would crowd are faded by their (fixed)
 * spacing, and ticks fade in and out at the tape's ends. Pure, no allocation.
 */

/** Speed tape knee, km/s: 1 m/s. */
export const TAPE_V0_KMS = 0.001;
/** Altitude tape knee, km: 10 m. */
export const TAPE_V0_ALT_KM = 0.01;
/** Pixels per decade of `tapeScale`. */
export const TAPE_PX_PER_DECADE = 80;

/** Ticks fade over this many px at either end of the tape. */
const EDGE_FADE_PX = 18;
/** Below this spacing to its lower neighbour a minor tick is gone... */
const MINOR_MIN_PX = 14;
/** ...and above MIN + this it is fully drawn. */
const MINOR_FADE_PX = 8;
const MAJOR_MIN_PX = 10;
const MAJOR_FADE_PX = 8;

export function tapeScale(v: number, v0 = TAPE_V0_KMS): number {
  if (!(v > 0)) return 0;
  return Math.log1p(v / v0) / Math.LN10;
}

export function tapeValue(u: number, v0 = TAPE_V0_KMS): number {
  if (!(u > 0)) return 0;
  return v0 * Math.expm1(u * Math.LN10);
}

export interface TapeTick {
  value: number;
  /** CSS px from the tape centre; negative = above (higher value). */
  offsetPx: number;
  alpha: number;
  /** A power of ten (or zero). */
  major: boolean;
}

const MANT = [1, 2, 5] as const;
/** The 1-2-5 neighbour below m·10^k, as a fraction of 10^k. */
const BELOW = [0.5, 1, 2] as const;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Ticks visible around `v`, written into `out` (which the caller sized).
 * Returns the count written. Spacing alpha depends only on the tick's value
 * (the scale is fixed), so the only alpha that moves with `v` is the edge
 * fade — which is why nothing pops.
 */
export function tapeTicks(
  v: number,
  v0: number,
  pxPerDecade: number,
  halfPx: number,
  out: TapeTick[],
): number {
  const uc = tapeScale(v, v0);
  const span = halfPx / pxPerDecade;
  const vHi = tapeValue(uc + span, v0);
  const vLo = tapeValue(uc - span, v0);
  let n = 0;

  if (vLo <= 0) n = pushTick(out, n, 0, true, Number.POSITIVE_INFINITY, uc, v0, pxPerDecade, halfPx);

  // Decades below v0/1e3 are all crowded to nothing; start there.
  const kMin = Math.floor(Math.log10(Math.max(vLo, v0 * 1e-3)));
  const kMax = Math.ceil(Math.log10(Math.max(vHi, v0 * 1e-3)));
  for (let k = kMin; k <= kMax; k++) {
    const p = Math.pow(10, k);
    for (let j = 0; j < 3; j++) {
      const value = MANT[j]! * p;
      if (value < vLo || value > vHi) continue;
      const major = j === 0;
      const lower = major ? p / 10 : BELOW[j]! * p;
      const spacing = (tapeScale(value, v0) - tapeScale(lower, v0)) * pxPerDecade;
      n = pushTick(out, n, value, major, spacing, uc, v0, pxPerDecade, halfPx);
    }
  }
  return n;
}

function pushTick(
  out: TapeTick[],
  n: number,
  value: number,
  major: boolean,
  spacingPx: number,
  uc: number,
  v0: number,
  pxPerDecade: number,
  halfPx: number,
): number {
  if (n >= out.length) return n;
  const off = -(tapeScale(value, v0) - uc) * pxPerDecade;
  if (Math.abs(off) > halfPx) return n;
  const edge = clamp01((halfPx - Math.abs(off)) / EDGE_FADE_PX);
  const crowd = major
    ? clamp01((spacingPx - MAJOR_MIN_PX) / MAJOR_FADE_PX)
    : clamp01((spacingPx - MINOR_MIN_PX) / MINOR_FADE_PX);
  const alpha = edge * crowd;
  if (alpha <= 0) return n;
  const t = out[n]!;
  t.value = value;
  t.offsetPx = off;
  t.alpha = alpha;
  t.major = major;
  return n + 1;
}

/** A tick numeral in display units (`value · scale`), compact. */
export function tickLabel(value: number, scale: number): string {
  const d = value * scale;
  if (d === 0) return '0';
  const a = Math.abs(d);
  if (a >= 1e6) return `${trim(d / 1e6)}M`;
  if (a >= 1e4) return `${trim(d / 1e3)}k`;
  return trim(d);
}

function trim(x: number): string {
  return String(Number(x.toPrecision(3)));
}
