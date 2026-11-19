/**
 * The speed tape without the decade snap (v3 PLAN F / H1).
 *
 * v2's tape stepped `10^floor(log10 v) / 2` per row: crossing 1.0 km/s the
 * step jumped ×10 and every numeral and tick on the tape jumped with it. The
 * v3 tape is log-compressed — position = tapeScale(v), linear near zero and
 * logarithmic above — so a tick for a given value has ONE position on the
 * scale at every speed, and crossing a decade is just more scrolling. Ticks
 * that get too close cross-fade out instead of popping.
 */

import { describe, expect, it } from 'vitest';

import {
  TAPE_PX_PER_DECADE,
  TAPE_V0_KMS,
  tapeScale,
  tapeTicks,
  tapeValue,
  tickLabel,
  type TapeTick,
} from './speedTape';

const HALF = 90; // half the visible tape, px

function ticksAt(v: number): Map<number, TapeTick> {
  const out: TapeTick[] = [];
  for (let i = 0; i < 32; i++) out.push({ value: 0, offsetPx: 0, alpha: 0, major: false });
  const n = tapeTicks(v, TAPE_V0_KMS, TAPE_PX_PER_DECADE, HALF, out);
  const m = new Map<number, TapeTick>();
  for (let i = 0; i < n; i++) m.set(out[i]!.value, { ...out[i]! });
  return m;
}

describe('tapeScale', () => {
  it('Given zero speed, Then the scale is at its origin', () => {
    expect(tapeScale(0)).toBe(0);
  });

  it('Given speeds from 0 to 1.5e8 km/s (the cruise ceiling), Then the scale is strictly increasing', () => {
    let prev = -Infinity;
    for (let e = -6; e <= 8.2; e += 0.01) {
      const u = tapeScale(Math.pow(10, e));
      expect(u).toBeGreaterThan(prev);
      prev = u;
    }
  });

  it('Given every decade boundary from 1 m/s to 10^8 km/s, Then the scale is continuous across it (no jump at 10^k)', () => {
    for (let k = -3; k <= 8; k++) {
      const v = Math.pow(10, k);
      const below = tapeScale(v * (1 - 1e-9));
      const above = tapeScale(v * (1 + 1e-9));
      expect(Math.abs(above - below)).toBeLessThan(1e-6);
    }
  });

  it('Given equal small steps in speed, Then the scale moves by bounded steps everywhere (Lipschitz: no hidden kink)', () => {
    // d(tapeScale)/dv is largest at v = 0: 1 / (v0 · ln 10).
    const maxSlope = 1 / (TAPE_V0_KMS * Math.LN10);
    const dv = 1e-6;
    for (let v = 0; v < 0.02; v += 1e-4) {
      expect(Math.abs(tapeScale(v + dv) - tapeScale(v))).toBeLessThanOrEqual(maxSlope * dv * (1 + 1e-6));
    }
  });

  it('Given far above v0, Then one decade of speed is one decade of scale (log region)', () => {
    expect(tapeScale(1e5) - tapeScale(1e4)).toBeCloseTo(1, 3);
  });

  it('Given far below v0, Then the scale is linear (a hover at 0.3 m/s still moves the tape)', () => {
    const v = TAPE_V0_KMS * 1e-4; // log1p(2x)/log1p(x) = 2 − x/2 + …: x must be small for 4 digits
    expect(tapeScale(2 * v) / tapeScale(v)).toBeCloseTo(2, 3);
  });

  it('Given a negative speed (never fed, but defended), Then it reads as zero rather than NaN', () => {
    expect(tapeScale(-5)).toBe(0);
  });

  it('Given tapeValue, Then it inverts tapeScale', () => {
    for (const v of [0, 1e-4, 0.0523, 1, 7.8, 3e4, 1.5e8]) {
      expect(tapeValue(tapeScale(v))).toBeCloseTo(v, Math.max(0, 6 - Math.ceil(Math.log10(v + 1))));
    }
  });
});

describe('tapeTicks — no snapping', () => {
  it('Given orbital speed (7.8 km/s), Then the tape shows ticks either side of the readout and at least one major', () => {
    const t = [...ticksAt(7.8).values()];
    expect(t.some((x) => x.offsetPx < 0)).toBe(true);
    expect(t.some((x) => x.offsetPx > 0)).toBe(true);
    expect(t.some((x) => x.major && x.alpha > 0.5)).toBe(true);
  });

  it('Given every tick, Then it lies inside the visible half-height', () => {
    for (const v of [0, 0.004, 0.9, 1.0, 1.1, 7.8, 299792, 1.5e8]) {
      for (const t of ticksAt(v).values()) expect(Math.abs(t.offsetPx)).toBeLessThanOrEqual(HALF + 1e-9);
    }
  });

  it('Given the speed sweeps through a decade (0.9 → 1.1 km/s in 1 m/s steps), Then no tick jumps more than 1 px and no tick’s alpha jumps more than 0.1 between steps', () => {
    let prev = ticksAt(0.9);
    for (let v = 0.901; v <= 1.1; v += 0.001) {
      const cur = ticksAt(v);
      for (const [value, t] of cur) {
        const p = prev.get(value);
        if (p) {
          expect(Math.abs(t.offsetPx - p.offsetPx)).toBeLessThan(1);
          expect(Math.abs(t.alpha - p.alpha)).toBeLessThan(0.1);
        } else {
          // A tick entering the window enters transparent.
          expect(t.alpha).toBeLessThan(0.1);
        }
      }
      for (const [value, p] of prev) {
        // A tick leaving the window left transparent.
        if (!cur.has(value)) expect(p.alpha).toBeLessThan(0.1);
      }
      prev = cur;
    }
  });

  it('Given the speed sweeps through the c boundary region (0.005c → 0.02c), Then the same continuity holds', () => {
    const C = 299792.458;
    let prev = ticksAt(0.005 * C);
    for (let f = 0.0051; f <= 0.02; f += 0.0001) {
      const cur = ticksAt(f * C);
      for (const [value, t] of cur) {
        const p = prev.get(value);
        if (p) expect(Math.abs(t.offsetPx - p.offsetPx)).toBeLessThan(1);
        else expect(t.alpha).toBeLessThan(0.1);
      }
      prev = cur;
    }
  });

  it('Given a tick value, Then its offset is (tapeScale(tick) − tapeScale(v)) × px-per-decade, with up positive as CSS-negative', () => {
    const v = 7.8;
    for (const t of ticksAt(v).values()) {
      expect(t.offsetPx).toBeCloseTo(-(tapeScale(t.value) - tapeScale(v)) * TAPE_PX_PER_DECADE, 6);
    }
  });

  it('Given more ticks than the output holds, Then it fills what it can and returns that count', () => {
    const out: TapeTick[] = [{ value: 0, offsetPx: 0, alpha: 0, major: false }];
    expect(tapeTicks(7.8, TAPE_V0_KMS, TAPE_PX_PER_DECADE, HALF, out)).toBe(1);
  });
});

describe('tickLabel', () => {
  it('Given 0.5 km/s on a km/s tape, Then "0.5"', () => {
    expect(tickLabel(0.5, 1)).toBe('0.5');
  });

  it('Given 2 km/s on an m/s tape, Then "2000"', () => {
    expect(tickLabel(2, 1000)).toBe('2000');
  });

  it('Given 5 km/s on a km/s tape, Then "5" (no trailing zeros)', () => {
    expect(tickLabel(5, 1)).toBe('5');
  });

  it('Given 0.02 c on a c tape, Then "0.02"', () => {
    const C = 299792.458;
    expect(tickLabel(0.02 * C, 1 / C)).toBe('0.02');
  });

  it('Given 20 000 km/s on a km/s tape, Then a compact "20k"', () => {
    expect(tickLabel(20_000, 1)).toBe('20k');
  });

  it('Given zero, Then "0"', () => {
    expect(tickLabel(0, 1)).toBe('0');
  });
});

// review-v3b (mutation ST2): the crowd fade is what keeps the knee legible.
describe('tapeTicks: crowded ticks fade out', () => {
  it('Given the tape at rest (0 m/s), Then no two drawn ticks sit closer than 10 px — the sub-knee 1-2-5 ticks that crowd onto zero are faded away', () => {
    const offs = [...ticksAt(0).values()].map((t) => t.offsetPx).sort((a, b) => a - b);
    for (let i = 1; i < offs.length; i++) expect(offs[i]! - offs[i - 1]!).toBeGreaterThanOrEqual(10);
  });
});
