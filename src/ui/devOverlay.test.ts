import { describe, expect, it } from 'vitest';
import { formatDevLines } from './devFormat';

const stats = { fps: 58.4, frameMs: 17.12, cpuMs: 1.9, scale: 0.95, calls: 160, tris: 1_210_000, programs: 48 };

describe('formatDevLines', () => {
  it('Given typical stats, Then line one reads fps · ms · cpu · scale · calls · tris · progs', () => {
    const [a] = formatDevLines(stats, { mode: 'flight', tier: 'high', ticking: 9, modules: 17 });
    expect(a).toBe('58 fps · 17.1 ms · cpu 1.9 · scale .95 · calls 160 · tris 1.21M · progs 48');
  });

  it('Given the mode context, Then line two reads mode · tier · ticking', () => {
    const [, b] = formatDevLines(stats, { mode: 'yard', tier: 'medium', ticking: 4, modules: 17 });
    expect(b).toBe('mode YARD · tier medium · ticking 4/17');
  });

  it('Given small triangle counts, Then they read in k, and tiny ones plainly', () => {
    expect(formatDevLines({ ...stats, tris: 54_000 }, { mode: 'flight', tier: 'high', ticking: 1, modules: 1 })[0]).toContain('tris 54k');
    expect(formatDevLines({ ...stats, tris: 812 }, { mode: 'flight', tier: 'high', ticking: 1, modules: 1 })[0]).toContain('tris 812');
  });

  it('Given full scale, Then it reads 1.00, not .100', () => {
    expect(formatDevLines({ ...stats, scale: 1 }, { mode: 'flight', tier: 'high', ticking: 1, modules: 1 })[0]).toContain('scale 1.00');
  });

  it('Given non-finite fps (first frame), Then it shows a dash rather than Infinity', () => {
    const [a] = formatDevLines({ ...stats, fps: Infinity }, { mode: 'boot', tier: 'low', ticking: 0, modules: 0 });
    expect(a.startsWith('— fps')).toBe(true);
  });
});
