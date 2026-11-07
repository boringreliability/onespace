/**
 * Baked terrain tiles — the pure bookkeeping behind Planet.ts's height atlas.
 *
 * WHY BAKE. The v2 audit (docs/v2/PERFORMANCE.md, root cause #1) measured the
 * terrain function — 11-13 octaves of fBm/ridged, a domain warp and a crater
 * field — being evaluated five times per vertex every frame (height plus a
 * four-tap normal), ~3.7 M evaluations a frame, and again per pixel in the
 * shadow march and the ocean depth. A patch's surface never changes while the
 * patch lives, so all of that is now done ONCE per patch, on the GPU, with the
 * very same GLSL (`terrainGlsl()`), into one tile of a per-planet float atlas.
 * The vertex shader then does one texelFetch.
 *
 * WHY ONE ATLAS AND NOT A TEXTURE PER PATCH. All patches share one material
 * and one draw state. Per-patch textures would mean a uniform/texture rebind
 * per draw — which three only does when the material changes, so it would also
 * mean one material per patch and a program-cache lookup per draw. One atlas
 * keeps a single binding for the whole planet, and its tile index is the
 * geometry-pool slot the patch already owns, so tile lifetime is patch
 * lifetime by construction (ARCHITECTURE rule 7).
 *
 * This file is three-free so the arithmetic can be tested in node.
 */

export type V3 = readonly [number, number, number];

export interface AtlasLayout {
  readonly cols: number;
  readonly rows: number;
  /** Texels per tile side (= patch resolution: one texel per grid vertex). */
  readonly tile: number;
  readonly width: number;
  readonly height: number;
}

/** Near-square grid of `slots` tiles. Always at least one tile. */
export function atlasLayout(slots: number, tile: number): AtlasLayout {
  const n = Math.max(1, Math.floor(slots));
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows, tile, width: cols * tile, height: rows * tile };
}

/** Texel coordinates of a slot's lower-left corner. */
export function tileOrigin(l: AtlasLayout, slot: number): [number, number] {
  if (!Number.isInteger(slot) || slot < 0 || slot >= l.cols * l.rows) {
    throw new RangeError(`atlas slot ${slot} outside ${l.cols}x${l.rows}`);
  }
  return [(slot % l.cols) * l.tile, Math.floor(slot / l.cols) * l.tile];
}

/**
 * Vertex index along one side of the skirted grid (gridN = res + 2) to texel
 * index inside the tile (0..res-1). Skirt vertices share the direction of the
 * edge vertex next to them (see Planet.buildPatch), so they share its texel —
 * otherwise the skirt would hang from a different height than the edge.
 */
export function gridTexel(i: number, gridN: number): number {
  const res = gridN - 2;
  return Math.min(res - 1, Math.max(0, i - 1));
}

/**
 * Half-extents (km) of the camera-centred shadow height map's levels, finest
 * first, each 4x the one inside it.
 *
 * WHY A CLIPMAP AND NOT THE PATCH TILES. Shadow rays run only within 0.06 R of
 * the camera (Planet's surface shader) and reach up to 3x the terrain
 * amplitude. Reading them from the patch atlas meant leaving the patch's own
 * tile at once near the camera, where patches are a few km across; the first
 * cut fell back to a coarser ancestor tile, which printed the patch grid into
 * the shadows, and then to the full terrain function, which kept ~45 % of the
 * shadow cost (measured). A clipmap centred under the camera is independent of
 * the patch tree, so it cannot print the grid, and its resolution falls off
 * with distance from the camera exactly as the pixel footprint does.
 */
export function shadowClipExtents(radius: number, amplitude: number, levels: number): number[] {
  const top = radius * 0.07 + amplitude * 3;
  const out: number[] = [];
  for (let i = 0; i < levels; i++) out.push(top / Math.pow(4, levels - 1 - i));
  return out;
}

/**
 * Finest level whose square contains a point `dist` km (Chebyshev, in the
 * level's plane) from the centre, keeping a 10 % margin for the bilinear taps.
 * -1 when no level reaches. The GLSL twin is os_clipLevel in Planet.ts.
 */
export function pickClipLevel(dist: number, extents: readonly number[]): number {
  for (let i = 0; i < extents.length; i++) if (dist < extents[i]! * 0.9) return i;
  return -1;
}

/**
 * Whether a level must be re-baked around the camera's new ground point: when
 * there is none yet, or the camera has drifted more than an eighth of the
 * level's half-extent, which keeps the camera well inside the margin above.
 */
export function clipNeedsRecentre(prev: V3 | null, next: V3, halfExtent: number, radius: number): boolean {
  return clipOverdue(prev, next, halfExtent, radius) > 1;
}

/** Drift as a multiple of the re-centre threshold; Infinity when never baked. */
function clipOverdue(prev: V3 | null, next: V3, halfExtent: number, radius: number): number {
  if (!prev) return Infinity;
  const d = prev[0] * next[0] + prev[1] * next[1] + prev[2] * next[2];
  const arc = Math.acos(Math.min(1, Math.max(-1, d))) * radius;
  const limit = halfExtent / 8;
  return limit > 0 ? arc / limit : arc > 0 ? Infinity : 0;
}

/**
 * The one clipmap level to re-bake this frame, or -1. A level costs about one
 * patch bake (256^2 terrain evaluations), and all four at once — a teleport,
 * or cruise speed low over the ground — was ~3 ms of GPU outside
 * patchBuildBudget. Deferring a level is safe: its centre uniform only moves
 * when it is re-baked, so a stale level is still self-consistent and the
 * shader simply finds the camera nearer its edge (or falls back a level).
 *
 * The most overdue level relative to its own threshold goes first; a level
 * never baked is infinitely overdue, and among those the COARSEST wins, since
 * it alone covers every shadow ray.
 */
export function pickClipRecentre(
  prev: ReadonlyArray<V3 | null>,
  next: V3,
  extents: readonly number[],
  radius: number,
): number {
  let best = -1;
  let bestOver = 1;
  for (let l = extents.length - 1; l >= 0; l--) {
    const over = clipOverdue(prev[l] ?? null, next, extents[l]!, radius);
    if (over > bestOver) {
      best = l;
      bestOver = over;
    }
  }
  return best;
}

/**
 * Height of the surface the GPU DRAWS, km about sea level. On an ocean world
 * the surface pass holds the ground at sea level wherever it lies below it
 * (Planet's vertex shader: hs = max(h, 0)), so that is where a ship must touch
 * down and what a patch's bounds must enclose. The GLSL twin is in
 * surfaceVertexShader.
 */
export function drawnHeight(h: number, ocean: boolean): number {
  return ocean ? Math.max(h, 0) : h;
}

/**
 * Finite-difference step for the baked normal, km along the surface.
 *
 * The old vertex shader stepped ~1.5 px of footprint. A patch is split when a
 * grid cell exceeds a few pixels and merged below ~2.5, so half a cell is the
 * same footprint without any per-frame view dependence. The clamp is the old
 * shader's own floor and ceiling.
 */
export function bakeNormalEps(cellKm: number, radius: number): number {
  return Math.min(radius * 1.5e-3, Math.max(radius * 3e-6, cellKm * 0.5));
}

/**
 * Choose up to `budget` requests, highest screen error first (ties: earlier
 * request). Entries < 0 are consumed and skipped. Writes request indices into
 * `out` and returns how many. Allocation-free; O(budget * count), and both are
 * small (budget <= 6, count <= the pool).
 */
export function selectBuilds(err: ArrayLike<number>, count: number, budget: number, out: Int32Array): number {
  let n = 0;
  const lim = Math.min(budget, out.length);
  while (n < lim) {
    let best = -1;
    let bestErr = -Infinity;
    for (let i = 0; i < count; i++) {
      const e = err[i]!;
      if (!(e >= 0) || e <= bestErr) continue;
      let taken = false;
      for (let k = 0; k < n; k++) if (out[k] === i) { taken = true; break; }
      if (taken) continue;
      best = i;
      bestErr = e;
    }
    if (best < 0) break;
    out[n++] = best;
  }
  return n;
}

/**
 * Fixed pool of atlas/geometry slots. Same LIFO reuse the planet always had,
 * plus the guard that a slot can never be handed to two patches.
 */
export class SlotPool {
  private readonly stack: number[] = [];
  private readonly used: Uint8Array;

  constructor(readonly size: number) {
    this.used = new Uint8Array(Math.max(0, size));
    // Pushed in reverse so the first alloc() returns slot 0.
    for (let i = size - 1; i >= 0; i--) this.stack.push(i);
  }

  get free(): number {
    return this.stack.length;
  }

  alloc(): number {
    const s = this.stack.pop();
    if (s === undefined) return -1;
    this.used[s] = 1;
    return s;
  }

  release(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.size || this.used[slot] !== 1) {
      throw new Error(`SlotPool: release of slot ${slot} that is not in use`);
    }
    this.used[slot] = 0;
    this.stack.push(slot);
  }

  inUse(slot: number): boolean {
    return this.used[slot] === 1;
  }
}
