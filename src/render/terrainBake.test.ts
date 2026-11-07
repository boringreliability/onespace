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
  clipNeedsRecentre,
  drawnHeight,
  gridTexel,
  pickClipLevel,
  pickClipRecentre,
  selectBuilds,
  shadowClipExtents,
  SlotPool,
  tileOrigin,
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

describe('shadowClipExtents — the camera-centred shadow height map', () => {
  // Shadow rays run only within 0.06 R of the camera and reach 3x the terrain
  // amplitude. The outermost level must cover both; each finer level is a
  // quarter the size, so texel size shrinks 4x per level towards the camera.
  it('Given R=6000 and amplitude 20 over 4 levels, Then the top level covers 0.07 R + 3 amplitude', () => {
    const e = shadowClipExtents(6000, 20, 4);
    expect(e).toHaveLength(4);
    expect(e[3]).toBeCloseTo(6000 * 0.07 + 60);
  });

  it('Given any levels, Then each is 4x the one inside it', () => {
    const e = shadowClipExtents(3000, 8, 4);
    for (let i = 1; i < e.length; i++) expect(e[i]! / e[i - 1]!).toBeCloseTo(4);
  });
});

describe('pickClipLevel', () => {
  const ext = [10, 40, 160, 640];

  it('Given a point near the centre, Then the finest level is used', () => {
    expect(pickClipLevel(3, ext)).toBe(0);
  });

  it('Given a point just inside a level but within its edge margin, Then the next level out is used', () => {
    // 9.5 of 10 is inside, but bilinear taps and the ray need a margin.
    expect(pickClipLevel(9.5, ext)).toBe(1);
  });

  it('Given a point beyond every level, Then -1 (no shadow information)', () => {
    expect(pickClipLevel(700, ext)).toBe(-1);
  });
});

describe('clipNeedsRecentre', () => {
  const R = 6000;
  const north: [number, number, number] = [0, 1, 0];

  it('Given no previous centre, Then the level must be baked', () => {
    expect(clipNeedsRecentre(null, north, 10, R)).toBe(true);
  });

  it('Given the camera moved less than an eighth of the level, Then it is kept', () => {
    const a = 1 / R; // 1 km of arc
    expect(clipNeedsRecentre(north, [Math.sin(a), Math.cos(a), 0], 10, R)).toBe(false);
  });

  it('Given the camera moved more than an eighth of the level, Then it is re-centred', () => {
    const a = 2 / R; // 2 km of arc against a 10 km half-extent
    expect(clipNeedsRecentre(north, [Math.sin(a), Math.cos(a), 0], 10, R)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// review-p3: survivors of the phase-3 mutation run, and the bugs it found.
// ---------------------------------------------------------------------------

describe('review-p3 — boundaries the first suite left open', () => {
  it("Given a point exactly on a level's 90 % margin, Then that level is NOT used (strict <)", () => {
    expect(pickClipLevel(9, [10, 40])).toBe(1);
  });

  it('Given a drift of exactly an eighth of the level, Then the level is kept (strict >)', () => {
    // A quarter turn on a unit sphere is acos(0) = pi/2 of arc; a half-extent
    // of 8x that makes the threshold the same double exactly.
    const arc = Math.acos(0);
    expect(clipNeedsRecentre([1, 0, 0], [0, 1, 0], arc * 8, 1)).toBe(false);
    expect(pickClipRecentre([[1, 0, 0]], [0, 1, 0], [arc * 8], 1)).toBe(-1);
  });

  it('Given a budget larger than the output buffer, Then it never reports more picks than the buffer holds', () => {
    const err = Float64Array.from([5, 4, 3, 2, 1]);
    const out = new Int32Array(2);
    expect(selectBuilds(err, 5, 10, out)).toBe(2);
    expect(Array.from(out)).toEqual([0, 1]);
  });

  it('Given a request with zero screen error, Then it is still a request (only negatives are consumed)', () => {
    const out = new Int32Array(1);
    expect(selectBuilds(Float64Array.from([0]), 1, 1, out)).toBe(1);
    expect(out[0]).toBe(0);
  });

  it('Given a fresh pool, When slots are allocated, Then they come out from slot 0 (tile 0 at the atlas origin)', () => {
    const p = new SlotPool(4);
    expect(p.alloc()).toBe(0);
    expect(p.alloc()).toBe(1);
  });
});

describe('drawnHeight — the surface the GPU actually draws (review-p3 #1)', () => {
  // Phase 3 merged the sea into the surface pass: the vertex shader holds the
  // ground at sea level wherever it lies below it (OS_OCEAN). The collision
  // sampler kept returning the sea FLOOR, so auto-land on an ocean world set
  // the ship down 14 km under the drawn water, where the camera saw the
  // underside of the sea and the skirts hanging from it.
  it('Given an ocean world and ground below sea level, Then the drawn height is sea level', () => {
    expect(drawnHeight(-13.9, true)).toBe(0);
  });

  it('Given an ocean world and ground above sea level, Then the drawn height is the ground', () => {
    expect(drawnHeight(2.5, true)).toBe(2.5);
  });

  it('Given a world without an ocean, Then a basin is drawn at its own depth', () => {
    expect(drawnHeight(-3, false)).toBe(-3);
  });
});

describe('pickClipRecentre — at most one shadow level re-baked per frame (review-p3 #3)', () => {
  // A level costs about one patch bake (256^2 terrain evaluations, measured
  // ~1 ms on an M4 Pro). Re-centring all four in one frame at speed was ~3 ms
  // outside patchBuildBudget. A stale level stays self-consistent (its centre
  // uniform moves only when it is re-baked), so deferring one is safe.
  const R = 6000;
  const ext = [10, 40, 160, 640];
  const north: [number, number, number] = [0, 1, 0];
  const moved = (km: number): [number, number, number] => [Math.sin(km / R), Math.cos(km / R), 0];

  it('Given no level has been baked, Then the coarsest is baked first (it covers every shadow ray)', () => {
    expect(pickClipRecentre([null, null, null, null], north, ext, R)).toBe(3);
  });

  it('Given every level is centred under the camera, Then nothing is re-baked', () => {
    expect(pickClipRecentre([north, north, north, north], north, ext, R)).toBe(-1);
  });

  it('Given a drift inside every threshold, Then nothing is re-baked', () => {
    // 0.5 km against the finest level's 1.25 km.
    expect(pickClipRecentre([north, north, north, north], moved(0.5), ext, R)).toBe(-1);
  });

  it('Given a drift past the finest level only, Then the finest is re-baked', () => {
    // 2 km: past 10/8 but well inside 40/8.
    expect(pickClipRecentre([north, north, north, north], moved(2), ext, R)).toBe(0);
  });

  it('Given several levels overdue, Then the MOST overdue relative to its own size goes first', () => {
    // Camera at +2 km. Level 0 drift 2 km (1.6x its 1.25 km threshold);
    // level 1 baked at -10 km, drift 12 km (2.4x its 5 km threshold).
    const prev = [north, moved(-10), moved(2), moved(2)];
    expect(pickClipRecentre(prev, moved(2), ext, R)).toBe(1);
  });

  it('Given one unbaked level among drifted ones, Then the unbaked one wins', () => {
    expect(pickClipRecentre([moved(-5), null, north, north], north, ext, R)).toBe(1);
  });
});
