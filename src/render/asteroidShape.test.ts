/**
 * v4 sub-plan 2, Task 4 — the asteroids can be seen: the shape.
 *
 * `asteroidShape(seed)` is pure: a seed in, a displaced icosphere out, as
 * indexed vertex data at NOMINAL radius 1 (the renderer scales each instance
 * by its radius). Eight seeds become the eight shared variant geometries.
 *
 * Contract asserted here:
 *   { positions: Float32Array (xyz), normals: Float32Array (xyz, unit),
 *     index: Uint16Array | Uint32Array (triangles, outward winding) }
 */

import { describe, expect, it } from 'vitest';

import { asteroidShape } from './asteroidShape';

/** Seeds as the belt makes them (uint32), edges included. */
const SEEDS: readonly number[] = [0, 1, 7, 8, 12345, 0x9e3779b9, 0x7fffffff, 0xffffffff];

describe('asteroidShape(seed)', () => {
  it('Given the same seed twice, Then the vertex data is identical (deterministic), and a different seed gives a different shape', () => {
    for (const seed of SEEDS) {
      const a = asteroidShape(seed);
      const b = asteroidShape(seed);
      expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
      expect(Array.from(b.normals)).toEqual(Array.from(a.normals));
      expect(Array.from(b.index)).toEqual(Array.from(a.index));
    }
    const p0 = asteroidShape(1).positions;
    const p1 = asteroidShape(2).positions;
    let diff = 0;
    for (let i = 0; i < Math.min(p0.length, p1.length); i++) diff = Math.max(diff, Math.abs(p0[i]! - p1[i]!));
    expect(diff).toBeGreaterThan(1e-3);
  });

  it('Given any seed, Then no position or normal is NaN or infinite, and every index is a valid vertex', () => {
    for (const seed of SEEDS) {
      const s = asteroidShape(seed);
      const n = s.positions.length / 3;
      expect(n).toBeGreaterThan(0);
      expect(s.positions.length % 3).toBe(0);
      expect(s.normals.length).toBe(s.positions.length);
      expect(s.index.length % 3).toBe(0);
      expect(s.index.length).toBeGreaterThan(0);
      for (const v of s.positions) expect(Number.isFinite(v)).toBe(true);
      for (const v of s.normals) expect(Number.isFinite(v)).toBe(true);
      for (const i of s.index) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(n);
      }
    }
  });

  it('Given any seed, Then every vertex lies within [0.6, 1.25] of the nominal radius', () => {
    for (const seed of SEEDS) {
      const p = asteroidShape(seed).positions;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < p.length; i += 3) {
        const r = Math.hypot(p[i]!, p[i + 1]!, p[i + 2]!);
        lo = Math.min(lo, r);
        hi = Math.max(hi, r);
      }
      expect(lo, `seed ${seed}`).toBeGreaterThanOrEqual(0.6);
      expect(hi, `seed ${seed}`).toBeLessThanOrEqual(1.25);
      // Displaced, not a sphere.
      expect(hi - lo, `seed ${seed}`).toBeGreaterThan(0.02);
    }
  });

  it('Given any seed, Then the mesh is closed with well-formed normals (sum of face normals ≈ 0, every edge shared by two faces, outward winding, unit outward vertex normals)', () => {
    for (const seed of SEEDS) {
      const { positions: p, normals: nrm, index: idx } = asteroidShape(seed);

      // Area-weighted face normals of a closed surface sum to zero.
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let area2 = 0;
      let volume6 = 0;
      const edges = new Map<string, number>();
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t]! * 3;
        const b = idx[t + 1]! * 3;
        const c = idx[t + 2]! * 3;
        const ux = p[b]! - p[a]!;
        const uy = p[b + 1]! - p[a + 1]!;
        const uz = p[b + 2]! - p[a + 2]!;
        const vx = p[c]! - p[a]!;
        const vy = p[c + 1]! - p[a + 1]!;
        const vz = p[c + 2]! - p[a + 2]!;
        const cx = uy * vz - uz * vy;
        const cy = uz * vx - ux * vz;
        const cz = ux * vy - uy * vx;
        sx += cx;
        sy += cy;
        sz += cz;
        area2 += Math.hypot(cx, cy, cz);
        // Signed volume (divergence theorem): positive for outward winding.
        volume6 += p[a]! * cx + p[a + 1]! * cy + p[a + 2]! * cz;
        const tri = [idx[t]!, idx[t + 1]!, idx[t + 2]!];
        for (let e = 0; e < 3; e++) {
          const i = tri[e]!;
          const j = tri[(e + 1) % 3]!;
          const key = i < j ? `${i}:${j}` : `${j}:${i}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      }
      expect(Math.hypot(sx, sy, sz) / area2, `seed ${seed}`).toBeLessThan(1e-4);
      expect(volume6, `seed ${seed}`).toBeGreaterThan(0);
      for (const [key, count] of edges) expect(count, `seed ${seed} edge ${key}`).toBe(2);

      for (let i = 0; i < nrm.length; i += 3) {
        const len = Math.hypot(nrm[i]!, nrm[i + 1]!, nrm[i + 2]!);
        expect(len).toBeCloseTo(1, 4);
        const outward = nrm[i]! * p[i]! + nrm[i + 1]! * p[i + 1]! + nrm[i + 2]! * p[i + 2]!;
        expect(outward, `seed ${seed} vertex ${i / 3}`).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Final whole-branch review, I1 — "en rigtig form" (DESIGN §5.5). The rocks
// read as soft discs; the relief must be more pronounced. Two measures, both
// pinned for the eight variant seeds the renderer uses and for SEEDS:
//   - radial spread: the standard deviation of |vertex| (the potato), and
//   - local relief: the mean |r − mean r of its mesh neighbours| (craters and
//     ridges you can see at the terminator, not just a stretched sphere).
// The old shapes measured sd 0.042–0.091 and local relief 0.0021–0.0034.
// The bounds, closure and outward normals above still hold.
// ---------------------------------------------------------------------------

/** The renderer's variant seeds (render/Asteroids: VARIANT_SEED_BASE + v). */
const VARIANT_SEEDS: readonly number[] = Array.from({ length: 8 }, (_, v) => (0xa57e0000 + v) >>> 0);

function radii(p: Float32Array): Float64Array {
  const r = new Float64Array(p.length / 3);
  for (let i = 0; i < r.length; i++) r[i] = Math.hypot(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!);
  return r;
}

function radialSd(r: Float64Array): number {
  let m = 0;
  for (const x of r) m += x;
  m /= r.length;
  let v = 0;
  for (const x of r) v += (x - m) ** 2;
  return Math.sqrt(v / r.length);
}

function localRelief(r: Float64Array, idx: ArrayLike<number>): number {
  const nb: Set<number>[] = Array.from({ length: r.length }, () => new Set<number>());
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!;
    const b = idx[t + 1]!;
    const c = idx[t + 2]!;
    nb[a]!.add(b).add(c);
    nb[b]!.add(a).add(c);
    nb[c]!.add(a).add(b);
  }
  let sum = 0;
  for (let i = 0; i < r.length; i++) {
    let s = 0;
    for (const j of nb[i]!) s += r[j]!;
    sum += Math.abs(r[i]! - s / nb[i]!.size);
  }
  return sum / r.length;
}

describe('asteroidShape — a real shape, not a soft disc (final review I1)', () => {
  const ALL = [...VARIANT_SEEDS, ...SEEDS];

  it('Given every variant seed (and SEEDS), Then the radial standard deviation is at least 0.07 of nominal', () => {
    for (const seed of ALL) {
      const sd = radialSd(radii(asteroidShape(seed).positions));
      expect(sd, `seed ${seed.toString(16)}`).toBeGreaterThanOrEqual(0.07);
    }
  });

  it('Given every variant seed (and SEEDS), Then the local relief (mean |r − neighbour mean|) is at least 0.004 of nominal', () => {
    for (const seed of ALL) {
      const s = asteroidShape(seed);
      const lr = localRelief(radii(s.positions), s.index);
      expect(lr, `seed ${seed.toString(16)}`).toBeGreaterThanOrEqual(0.004);
    }
  });

  it('Given every variant seed, Then every vertex still lies within [0.6, 1.25] and every vertex normal still points outward', () => {
    for (const seed of VARIANT_SEEDS) {
      const { positions: p, normals: n } = asteroidShape(seed);
      for (let i = 0; i < p.length; i += 3) {
        const r = Math.hypot(p[i]!, p[i + 1]!, p[i + 2]!);
        expect(r, `seed ${seed.toString(16)}`).toBeGreaterThanOrEqual(0.6);
        expect(r, `seed ${seed.toString(16)}`).toBeLessThanOrEqual(1.25);
        expect(n[i]! * p[i]! + n[i + 1]! * p[i + 1]! + n[i + 2]! * p[i + 2]!, `seed ${seed.toString(16)} v ${i / 3}`).toBeGreaterThan(0);
      }
    }
  });
});
