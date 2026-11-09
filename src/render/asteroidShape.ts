/**
 * The shape of an asteroid (v4 sub-plan 2, Task 4) — pure.
 *
 * A seed in, a displaced icosphere out: an icosahedron subdivided three
 * times (20·4³ = 1 280 triangles, 642 shared vertices; ruling R14), each
 * vertex pushed along its own direction by a smooth radial function of the
 * seed. The shape is star-shaped by construction (one radius per direction),
 * so it is always closed, never self-intersecting, and its smooth normals
 * point outward as long as the slopes stay gentle — which is why every term
 * below is broad: a slight elongation, a handful of wide lobes and a few
 * shallow, wide craters. The radius is clamped to [0.62, 1.22] of nominal.
 *
 * Nominal radius 1: the renderer scales each instance by its radius in km.
 * Eight seeds become the eight shared variant geometries (render/Asteroids).
 */

import { Rng } from '@/math/rng';

export interface AsteroidShape {
  /** xyz per vertex, nominal radius 1. */
  readonly positions: Float32Array;
  /** Unit outward vertex normals, xyz per vertex. */
  readonly normals: Float32Array;
  /** Triangles, counter-clockwise seen from outside. */
  readonly index: Uint16Array;
}

/** Subdivision levels of the base icosahedron. */
export const ASTEROID_SUBDIVISIONS = 3;
export const ASTEROID_MIN_RADIUS = 0.62;
export const ASTEROID_MAX_RADIUS = 1.22;

const LOBES = 6;
const CRATERS = 5;

/** The unit icosphere: shared vertices (float64) and triangles. Built once. */
let sphere: { dirs: Float64Array; index: Uint16Array } | null = null;

function icosphere(): { dirs: Float64Array; index: Uint16Array } {
  if (sphere) return sphere;
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(([x, y, z]) => {
    const l = Math.hypot(x!, y!, z!);
    return [x! / l, y! / l, z! / l];
  });
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let level = 0; level < ASTEROID_SUBDIVISIONS; level++) {
    const mid = new Map<number, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      const hit = mid.get(key);
      if (hit !== undefined) return hit;
      const pa = verts[a]!;
      const pb = verts[b]!;
      const x = pa[0]! + pb[0]!;
      const y = pa[1]! + pb[1]!;
      const z = pa[2]! + pb[2]!;
      const l = Math.hypot(x, y, z);
      verts.push([x / l, y / l, z / l]);
      mid.set(key, verts.length - 1);
      return verts.length - 1;
    };
    const next: number[][] = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a!, b!);
      const bc = midpoint(b!, c!);
      const ca = midpoint(c!, a!);
      next.push([a!, ab, ca], [b!, bc, ab], [c!, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  const dirs = new Float64Array(verts.length * 3);
  verts.forEach((v, i) => dirs.set(v, i * 3));
  const index = new Uint16Array(faces.length * 3);
  faces.forEach((f, i) => index.set(f, i * 3));
  sphere = { dirs, index };
  return sphere;
}

/** A uniformly random unit vector. */
function randomDir(rng: Rng): [number, number, number] {
  const z = rng.range(-1, 1);
  const phi = rng.range(0, Math.PI * 2);
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(phi), r * Math.sin(phi), z];
}

/** Seed → displaced icosphere. Pure and deterministic. */
export function asteroidShape(seed: number): AsteroidShape {
  const { dirs, index } = icosphere();
  const rng = new Rng(seed >>> 0);
  const n = dirs.length / 3;

  // Elongation along one axis, flattening across another: most small bodies
  // are potatoes, not spheres.
  const long = randomDir(rng);
  const stretch = rng.range(0.08, 0.28);
  const flat = randomDir(rng);
  const squash = rng.range(0.0, 0.12);

  // Broad lobes: Gaussian bumps in angle, wide enough to keep slopes gentle.
  const lobeDir: number[] = [];
  const lobeAmp: number[] = [];
  const lobeK: number[] = [];
  for (let i = 0; i < LOBES; i++) {
    lobeDir.push(...randomDir(rng));
    lobeAmp.push(rng.range(-0.1, 0.12));
    const width = rng.range(0.45, 0.8); // radians
    lobeK.push(1 / (width * width));
  }
  // Shallow craters: a bowl with a faint rim.
  const craterDir: number[] = [];
  const craterDepth: number[] = [];
  const craterK: number[] = [];
  for (let i = 0; i < CRATERS; i++) {
    craterDir.push(...randomDir(rng));
    craterDepth.push(rng.range(0.025, 0.06));
    const width = rng.range(0.25, 0.45);
    craterK.push(1 / (width * width));
  }

  const positions = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const x = dirs[v * 3]!;
    const y = dirs[v * 3 + 1]!;
    const z = dirs[v * 3 + 2]!;
    const dl = x * long[0] + y * long[1] + z * long[2];
    const df = x * flat[0] + y * flat[1] + z * flat[2];
    let r = 1 + stretch * (dl * dl - 1 / 3) - squash * (df * df - 1 / 3);
    for (let i = 0; i < LOBES; i++) {
      const c = x * lobeDir[i * 3]! + y * lobeDir[i * 3 + 1]! + z * lobeDir[i * 3 + 2]!;
      // 2(1 - cos θ) ≈ θ² near the centre, and well defined everywhere.
      r += lobeAmp[i]! * Math.exp(-2 * (1 - c) * lobeK[i]!);
    }
    for (let i = 0; i < CRATERS; i++) {
      const c = x * craterDir[i * 3]! + y * craterDir[i * 3 + 1]! + z * craterDir[i * 3 + 2]!;
      const s = 2 * (1 - c) * craterK[i]!;
      // Mexican-hat profile: a bowl (s < 1) with a faint rim around it.
      r -= craterDepth[i]! * (1 - s) * Math.exp(-s);
    }
    r = Math.min(ASTEROID_MAX_RADIUS, Math.max(ASTEROID_MIN_RADIUS, r));
    positions[v * 3] = x * r;
    positions[v * 3 + 1] = y * r;
    positions[v * 3 + 2] = z * r;
  }

  // Smooth normals: area-weighted face normals summed per vertex.
  const acc = new Float64Array(n * 3);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t]! * 3;
    const b = index[t + 1]! * 3;
    const c = index[t + 2]! * 3;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      acc[k] = acc[k]! + cx;
      acc[k + 1] = acc[k + 1]! + cy;
      acc[k + 2] = acc[k + 2]! + cz;
    }
  }
  const normals = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const x = acc[v * 3]!;
    const y = acc[v * 3 + 1]!;
    const z = acc[v * 3 + 2]!;
    const l = Math.hypot(x, y, z) || 1;
    normals[v * 3] = x / l;
    normals[v * 3 + 1] = y / l;
    normals[v * 3 + 2] = z / l;
  }

  return { positions, normals, index: index.slice() };
}
