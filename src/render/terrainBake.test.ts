/**
 * Baked terrain tiles — the pure bookkeeping behind them.
 *
 * The v2 audit measured terrain evaluated five times per vertex per frame as
 * the dominant GPU cost (PERFORMANCE.md root cause #1). Phase 3 bakes each
 * patch once into a tile of a per-planet float atlas. The GPU half is checked
 * by measurement and screenshots; what is tested here is the arithmetic that
 * decides WHICH texel a vertex reads, WHICH patch is baked this frame and
 * WHICH tile a shadow ray is allowed to march through. Get any of these wrong
 * and the planet tears at a seam or reads its neighbour's mountains.
 */

import { describe, expect, it } from 'vitest';
import {
  atlasLayout,
  bakeNormalEps,
  dualBasis,
  gridTexel,
  pickShadowAncestor,
  selectBuilds,
  SlotPool,
  tileOrigin,
  tileTransform,
} from './terrainBake';

describe('atlasLayout', () => {
  it('Given 288 slots of 33 texels, When laid out, Then every slot fits and the atlas is near square', () => {
    const l = atlasLayout(288, 33);
    expect(l.cols * l.rows).toBeGreaterThanOrEqual(288);
    expect(l.width).toBe(l.cols * 33);
    expect(l.height).toBe(l.rows * 33);
    expect(Math.abs(l.cols - l.rows)).toBeLessThanOrEqual(1);
  });

  it('Given one slot, When laid out, Then the atlas is exactly one tile', () => {
    const l = atlasLayout(1, 65);
    expect([l.cols, l.rows, l.width, l.height]).toEqual([1, 1, 65, 65]);
  });

  it('Given no slots (a gas giant), When laid out, Then it is still a valid 1x1-tile atlas', () => {
    const l = atlasLayout(0, 33);
    expect(l.cols).toBe(1);
    expect(l.rows).toBe(1);
  });
});

describe('tileOrigin', () => {
  const l = atlasLayout(10, 33); // 4 cols x 3 rows

  it('Given slot 0, Then its tile starts at the atlas origin', () => {
    expect(tileOrigin(l, 0)).toEqual([0, 0]);
  });

  it('Given a slot past the first row, Then it wraps to the next row', () => {
    expect(tileOrigin(l, l.cols)).toEqual([0, 33]);
    expect(tileOrigin(l, l.cols + 1)).toEqual([33, 33]);
  });

  it('Given every slot, Then no two tiles overlap and all lie inside the atlas', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 10; s++) {
      const [x, y] = tileOrigin(l, s);
      expect(x + 33).toBeLessThanOrEqual(l.width);
      expect(y + 33).toBeLessThanOrEqual(l.height);
      seen.add(`${x},${y}`);
    }
    expect(seen.size).toBe(10);
  });

  it('Given a slot outside the atlas, Then it throws rather than aliasing another tile', () => {
    expect(() => tileOrigin(l, l.cols * l.rows)).toThrow();
    expect(() => tileOrigin(l, -1)).toThrow();
  });
});

describe('gridTexel — vertex grid (with skirt ring) to tile texel', () => {
  // gridN = res + 2: one skirt vertex on each side shares its edge neighbour's
  // direction, so it must read the SAME texel or the skirt tears off the edge.
  const res = 33;
  const gridN = res + 2;

  it('Given the skirt vertex at index 0, Then it reads the first interior texel', () => {
    expect(gridTexel(0, gridN)).toBe(0);
    expect(gridTexel(1, gridN)).toBe(0);
  });

  it('Given the far skirt vertex, Then it reads the last interior texel', () => {
    expect(gridTexel(gridN - 1, gridN)).toBe(res - 1);
    expect(gridTexel(gridN - 2, gridN)).toBe(res - 1);
  });

  it('Given an interior vertex, Then it is offset by exactly the skirt ring', () => {
    expect(gridTexel(17, gridN)).toBe(16);
  });
});

describe('tileTransform — mapping own-tile uv into an ancestor tile', () => {
  it('Given the patch is its own reference, Then the transform is identity', () => {
    const t = tileTransform({ a0: 0.25, b0: 0.5, size: 0.125 }, { a0: 0.25, b0: 0.5, size: 0.125 });
    expect(t).toEqual({ k: 1, offU: 0, offV: 0 });
  });

  it('Given the third child of a root, When mapped into the root, Then corners land on the right quarter', () => {
    const own = { a0: 0, b0: 0.5, size: 0.5 };
    const root = { a0: 0, b0: 0, size: 1 };
    const t = tileTransform(own, root);
    // own uv (0,0) -> root (0, 0.5); own uv (1,1) -> root (0.5, 1).
    expect(0 * t.k + t.offU).toBeCloseTo(0);
    expect(0 * t.k + t.offV).toBeCloseTo(0.5);
    expect(1 * t.k + t.offU).toBeCloseTo(0.5);
    expect(1 * t.k + t.offV).toBeCloseTo(1);
  });

  it('Given dyadic patch extents, Then the transform is exact (no seam drift)', () => {
    const own = { a0: 0.6875, b0: 0.3125, size: 0.0625 };
    const anc = { a0: 0.5, b0: 0.25, size: 0.25 };
    const t = tileTransform(own, anc);
    expect(t.k).toBe(0.25);
    expect(t.offU).toBe(0.75);
    expect(t.offV).toBe(0.25);
  });
});

describe('pickShadowAncestor', () => {
  // The chain runs from the patch's parent up to its root. A shadow ray needs a
  // tile wide enough to contain it, and it must be BUILT (baked) — an unbaked
  // tile is zeros, which would put every ray under a flat plain at sea level.
  const chain = [
    { side: 10, built: true },
    { side: 20, built: true },
    { side: 40, built: false },
    { side: 80, built: true },
    { side: 160, built: true },
  ];

  it('Given the patch itself is wide enough, Then no ancestor is needed (-1)', () => {
    expect(pickShadowAncestor(chain, 5, 5)).toBe(-1);
  });

  it('Given a required width, Then the nearest built ancestor at least that wide is chosen', () => {
    expect(pickShadowAncestor(chain, 5, 15)).toBe(1);
  });

  it('Given the first wide-enough ancestor is unbuilt, Then the next built one up is chosen', () => {
    expect(pickShadowAncestor(chain, 5, 30)).toBe(3);
  });

  it('Given nothing is wide enough, Then the topmost built ancestor is the fallback', () => {
    expect(pickShadowAncestor(chain, 5, 1000)).toBe(4);
  });

  it('Given an empty chain (a root), Then the patch uses its own tile', () => {
    expect(pickShadowAncestor([], 5, 1000)).toBe(-1);
  });
});

describe('dualBasis — km on the surface to tile uv', () => {
  it('Given orthogonal tangents, Then the dual vectors are the tangents over their squared lengths', () => {
    const [da, db] = dualBasis([2, 0, 0], [0, 4, 0]);
    expect(da).toEqual([0.5, 0, 0]);
    expect(db[1]).toBeCloseTo(0.25);
  });

  it('Given skewed tangents, Then dot(dual_i, tangent_j) is the identity', () => {
    const ta: [number, number, number] = [3, 1, 0.5];
    const tb: [number, number, number] = [0.7, 2, -0.4];
    const [da, db] = dualBasis(ta, tb);
    const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    expect(dot(da, ta)).toBeCloseTo(1, 10);
    expect(dot(da, tb)).toBeCloseTo(0, 10);
    expect(dot(db, ta)).toBeCloseTo(0, 10);
    expect(dot(db, tb)).toBeCloseTo(1, 10);
  });

  it('Given degenerate (parallel) tangents, Then it returns zeros instead of NaN', () => {
    const [da, db] = dualBasis([1, 0, 0], [2, 0, 0]);
    expect([...da, ...db].every((v) => v === 0)).toBe(true);
  });
});

describe('bakeNormalEps', () => {
  it('Given a mid-size cell, Then the normal step is half a cell', () => {
    expect(bakeNormalEps(2, 6000)).toBeCloseTo(1);
  });

  it('Given a huge cell (root patch), Then it is capped at the old vertex-shader ceiling', () => {
    expect(bakeNormalEps(300, 6000)).toBeCloseTo(6000 * 1.5e-3);
  });

  it('Given a tiny cell, Then it is floored at the old vertex-shader floor', () => {
    expect(bakeNormalEps(1e-5, 6000)).toBeCloseTo(6000 * 3e-6);
  });
});

describe('selectBuilds — the per-frame bake budget', () => {
  it('Given more requests than budget, Then the highest screen errors win, in order', () => {
    const err = Float64Array.from([3, 9, 1, 7, 5]);
    const out = new Int32Array(5);
    const n = selectBuilds(err, 5, 2, out);
    expect(n).toBe(2);
    expect([out[0], out[1]]).toEqual([1, 3]);
  });

  it('Given budget at least the request count, Then every request is taken', () => {
    const err = Float64Array.from([2, 1, 3]);
    const out = new Int32Array(3);
    expect(selectBuilds(err, 3, 10, out)).toBe(3);
    expect(Array.from(out)).toEqual([2, 0, 1]);
  });

  it('Given consumed (negative) slots, Then they are never selected', () => {
    const err = Float64Array.from([-1, 4, -1]);
    const out = new Int32Array(3);
    expect(selectBuilds(err, 3, 3, out)).toBe(1);
    expect(out[0]).toBe(1);
  });

  it('Given equal errors, Then the earlier request wins (stable, deterministic)', () => {
    const err = Float64Array.from([5, 5, 5]);
    const out = new Int32Array(3);
    selectBuilds(err, 3, 2, out);
    expect([out[0], out[1]]).toEqual([0, 1]);
  });

  it('Given a zero budget, Then nothing is selected', () => {
    expect(selectBuilds(Float64Array.from([1]), 1, 0, new Int32Array(1))).toBe(0);
  });

  it('Given the err array is used as scratch, Then it is left untouched for the caller', () => {
    const err = Float64Array.from([3, 9, 1]);
    selectBuilds(err, 3, 2, new Int32Array(3));
    expect(Array.from(err)).toEqual([3, 9, 1]);
  });
});

describe('SlotPool — atlas tiles live and die with their patch', () => {
  it('Given a fresh pool, When all slots are taken, Then each is distinct and the next alloc is -1', () => {
    const p = new SlotPool(3);
    const got = [p.alloc(), p.alloc(), p.alloc()];
    expect(new Set(got).size).toBe(3);
    expect(got.every((s) => s >= 0 && s < 3)).toBe(true);
    expect(p.alloc()).toBe(-1);
    expect(p.free).toBe(0);
  });

  it('Given a freed slot, When allocating again, Then that slot is reused', () => {
    const p = new SlotPool(2);
    const a = p.alloc();
    p.alloc();
    p.release(a);
    expect(p.free).toBe(1);
    expect(p.alloc()).toBe(a);
  });

  it('Given a slot released twice, Then the second release throws (a double free would hand one tile to two patches)', () => {
    const p = new SlotPool(2);
    const a = p.alloc();
    p.release(a);
    expect(() => p.release(a)).toThrow();
  });

  it('Given a slot that was never allocated, Then releasing it throws', () => {
    const p = new SlotPool(2);
    expect(() => p.release(1)).toThrow();
    expect(() => p.release(7)).toThrow();
  });

  it('Given in-use queries, Then they track alloc and release', () => {
    const p = new SlotPool(2);
    const a = p.alloc();
    expect(p.inUse(a)).toBe(true);
    p.release(a);
    expect(p.inUse(a)).toBe(false);
  });
});
