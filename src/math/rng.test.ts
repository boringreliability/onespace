/**
 * The RNG is the foundation of the whole universe: every star, hull and
 * mountain derives from it. These tests exist because a subtle change here is
 * invisible — the output still looks random — while silently regenerating
 * everything anyone has ever seen.
 */

import { describe, expect, it } from 'vitest';
import { Rng, hash3, hashSeed, rngFrom } from './rng';

describe('hashSeed', () => {
  it('is deterministic', () => {
    expect(hashSeed(12345, 'planet')).toBe(hashSeed(12345, 'planet'));
  });

  it('separates adjacent salts widely', () => {
    // The avalanche step exists for this. Without it, 'planet:1' and
    // 'planet:2' produce neighbouring streams and sibling worlds correlate.
    const a = hashSeed(1, 'planet:1');
    const b = hashSeed(1, 'planet:2');
    const diff = (a ^ b) >>> 0;
    let bits = 0;
    for (let i = 0; i < 32; i++) if ((diff >>> i) & 1) bits++;
    expect(bits).toBeGreaterThan(8);
  });

  it('separates adjacent seeds as widely as adjacent salts', () => {
    const a = hashSeed(1000, 'x');
    const b = hashSeed(1001, 'x');
    expect(a).not.toBe(b);
    expect(Math.abs(a - b)).toBeGreaterThan(1000);
  });

  it('always returns an unsigned 32-bit integer', () => {
    for (const seed of [0, 1, -1, 2 ** 31, 0xffffffff]) {
      const h = hashSeed(seed, 'k');
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });
});

describe('hash3', () => {
  it('is deterministic and order-sensitive', () => {
    expect(hash3(1, 2, 3)).toBe(hash3(1, 2, 3));
    expect(hash3(1, 2, 3)).not.toBe(hash3(3, 2, 1));
  });

  it('distinguishes neighbouring cells', () => {
    // Spatial hashing drives sampleSystemsNear; neighbouring grid cells that
    // collide would put two star systems in the same place.
    const seen = new Set<number>();
    for (let x = 0; x < 8; x++)
      for (let y = 0; y < 8; y++) for (let z = 0; z < 8; z++) seen.add(hash3(x, y, z, 99));
    expect(seen.size).toBe(512);
  });
});

describe('Rng', () => {
  it('reproduces its stream from the same seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('never returns 1 and never returns a negative', () => {
    const r = new Rng('bounds');
    for (let i = 0; i < 10_000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is roughly uniform', () => {
    const r = new Rng('uniform');
    const buckets = new Array(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i++) buckets[Math.floor(r.next() * 10)]!++;
    for (const b of buckets) {
      // ±5% of the expected tenth. Loose on purpose: this is a smoke test for
      // a broken generator, not a statistical certification.
      expect(b).toBeGreaterThan(n / 10 - n * 0.005);
      expect(b).toBeLessThan(n / 10 + n * 0.005);
    }
  });

  it('respects range bounds', () => {
    const r = new Rng('range');
    for (let i = 0; i < 1000; i++) {
      const v = r.range(-3, 7);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(7);
    }
  });

  it('int() is inclusive at both ends', () => {
    const r = new Rng('int');
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(r.int(0, 3));
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });

  it('onSphere returns unit vectors', () => {
    const r = new Rng('sphere');
    for (let i = 0; i < 500; i++) {
      const [x, y, z] = r.onSphere();
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 10);
    }
  });

  it('power() stays inside its bounds and favours the small end', () => {
    // Stellar masses and crater sizes are power-law distributed; a generator
    // that produces a uniform spread is the single loudest tell of fakery.
    const r = new Rng('power');
    let below = 0;
    const n = 5000;
    for (let i = 0; i < n; i++) {
      const v = r.power(1, 100, -2.2);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(100);
      if (v < 10) below++;
    }
    expect(below / n).toBeGreaterThan(0.8);
  });

  it('weighted() honours a zero weight', () => {
    const r = new Rng('weighted');
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(r.weighted(['a', 'b', 'c'], [1, 0, 1]));
    expect(seen.has('b')).toBe(false);
  });

  it('fork() gives independent streams', () => {
    const parent = new Rng('parent');
    const a = parent.fork('a');
    const b = parent.fork('b');
    const sa = Array.from({ length: 20 }, () => a.next());
    const sb = Array.from({ length: 20 }, () => b.next());
    expect(sa).not.toEqual(sb);
  });

  it('rngFrom is equivalent to seeding with hashSeed', () => {
    const a = rngFrom(7, 'salt');
    const b = new Rng(hashSeed(7, 'salt'));
    expect(a.next()).toBe(b.next());
  });

  it('shuffle is a permutation, not a resample', () => {
    const r = new Rng('shuffle');
    const input = Array.from({ length: 50 }, (_, i) => i);
    const out = r.shuffle([...input]);
    expect([...out].sort((x, y) => x - y)).toEqual(input);
  });
});
