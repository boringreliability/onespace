/**
 * The G meter without the shouting (v3 PLAN F / H1, item 7).
 *
 * v2 printed "62G" in the middle of the frame, over the hull and the plume,
 * during an autopilot boost. The number is true and stays; what changes is
 * the voice: lower-case unit, one weight, no size or colour jump. A high load
 * earns the single rationed amber accent (ARCHITECTURE §6), nothing louder.
 * Free fall reads as a dim "0.0 g" rather than vanishing, so the meter does not
 * pop in and out at every burn.
 */

import { describe, expect, it } from 'vitest';

import { G_HIGH, gReadout } from './gReadout';

describe('gReadout', () => {
  it('Given free fall (0.02 g), Then a dim "0.0 g"', () => {
    expect(gReadout(0.02)).toEqual({ text: '0.0 g', tone: 'idle' });
  });

  it('Given 1.43 g, Then "1.4 g" in the normal tone', () => {
    expect(gReadout(1.43)).toEqual({ text: '1.4 g', tone: 'normal' });
  });

  it('Given 62.4 g (autopilot boost), Then the TRUE number "62 g" in the high tone — not hidden, not capped', () => {
    expect(gReadout(62.4)).toEqual({ text: '62 g', tone: 'high' });
  });

  it('Given 9.96 g, Then whole numbers from 10 g up ("10 g", never "10.0 g")', () => {
    expect(gReadout(9.96).text).toBe('10 g');
  });

  it('Given the high threshold, Then just below it is normal and at it is high', () => {
    expect(gReadout(G_HIGH - 0.01).tone).toBe('normal');
    expect(gReadout(G_HIGH).tone).toBe('high');
  });

  it('Given any load, Then the text never uses a capital G, an exclamation or a warning word', () => {
    for (const g of [0, 0.5, 3, 12, 62, 400]) {
      expect(gReadout(g).text).not.toMatch(/G|!|WARN|OVER/);
    }
  });

  it('Given NaN or a negative reading, Then a dim dash rather than a number', () => {
    expect(gReadout(Number.NaN)).toEqual({ text: '— g', tone: 'idle' });
    expect(gReadout(-1)).toEqual({ text: '— g', tone: 'idle' });
  });
});
