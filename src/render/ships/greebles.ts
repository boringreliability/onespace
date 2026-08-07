/**
 * oneSpace — the greeble vocabulary.
 *
 * Twenty-six detail families, every one of them an *assembly* authored in a
 * unit footprint (x, z ∈ [-0.5, 0.5]; y from 0, the mounting face, up to about
 * 1) so that a single per-instance scale drives all of them.
 *
 * WHY ASSEMBLIES AND NOT PRIMITIVES. This is the one lesson from `Ship.ts`
 * that cost real time to learn: a bare box and a bare cylinder gave a hull with
 * 200+ instances on it exactly *two* silhouettes, and two silhouettes repeated
 * two hundred times is visible tiling, not detail. Three primitives welded into
 * one recognisable object — a plate with a lip and a latch, a foot with a web
 * and a gusset — cost 36 triangles and read as hardware. The other half of the
 * trick is the per-family *envelope*: a pipe is square in plan and stands up, a
 * ribbed rail is long and low, a whip is a spike. Two families with the same
 * envelope are one family.
 *
 * WHAT THE FACTION LAYER DOES WITH THEM. `families.ts` gives each culture an
 * allowed list and a *forbidden* list, and says the refusals are the identity:
 * a Sillane hull with one external cable loom on it stops being Sillane. So
 * this module implements the whole vocabulary and never chooses from it — the
 * caller passes `greebleVocabulary(faction)` and gets only those.
 *
 * SCATTER. Rejection sampling against a *shared* seat list, because rejecting
 * only against your own family lets five scatters land on top of each other.
 * The seat test runs through a spatial hash rather than the reference's linear
 * scan: at 240 instances that scan was already ~1.15 M distance tests and
 * several milliseconds of a 25 ms budget, and it is O(n²).
 *
 * Everything here is build-time. There is no `update()` and nothing allocates
 * per frame.
 */

import { BufferGeometry, InstancedBufferAttribute, Matrix4, Vector3 } from 'three';

import type { GreebleFamily } from '@/gen/ships/families';
import { HATCH_WIDTH_KM, type LodLevel, type PrimaryVolume } from '@/gen/ships/types';
import { Rng, hashSeed } from '@/math/rng';

import {
  HullBuilder,
  SHADE_BARE_METAL,
  SHADE_HULL,
  SHADE_STRUCTURE,
  SHADE_TRIM,
  sampleVolumeNormal,
  sampleVolumeSurface,
  type OccluderSphere,
  type SurfaceSeat,
} from './volumes';

/** The kind is the faction layer's own union — one vocabulary, not two. */
export type GreebleKind = GreebleFamily;

/**
 * Instance part ids start here.
 *
 * `aPart` picks plate scale, panel projection offset, paint batch and shadow
 * self-rejection at once, so a collision with a hull part id is a visible bug
 * rather than a warning. The hull's monotonic allocator counts up from 1 and a
 * 4 km hull with 200 modules lands around 8 k; starting greebles at 2^20 puts
 * a floor of a hundred thousand ids between them.
 */
export const GREEBLE_PART_BASE = 1 << 20;

const TAU = Math.PI * 2;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Assembly helpers
// ---------------------------------------------------------------------------

const _m = new Matrix4();
const _m2 = new Matrix4();

/** Deterministic 0..1. The geometry is shared between every ship, so the
 *  jitter inside an assembly must be a constant of the assembly, not a draw. */
function jit(salt: string, i: number): number {
  return hashSeed(hashSeed(0x9e37, salt), i) / 4294967296;
}

/**
 * A surface of revolution about +Y with shared ring vertices, so it shades
 * smooth. The only smooth things in the vocabulary are the ones that were
 * pressed in a die — a blister, a radome — and that is exactly the read.
 */
function addLathe(
  b: HullBuilder,
  m: Matrix4,
  profile: readonly (readonly [number, number])[],
  seg: number,
): void {
  const rings: number[][] = [];
  for (const [r, y] of profile) {
    const ring: number[] = [];
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * TAU;
      ring.push(b.pushLocal(m, Math.cos(a) * r, y, Math.sin(a) * r, 0, 0, 0.35 + 0.65 * y, 0));
    }
    rings.push(ring);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let s = 0; s < seg; s++) {
      const n = (s + 1) % seg;
      b.quad(rings[i][s], rings[i + 1][s], rings[i + 1][n], rings[i][n]);
    }
  }
  const top = profile[profile.length - 1];
  if (top[0] > 1e-4) {
    const c = b.pushLocal(m, 0, top[1], 0, 0, 0, 1, 0);
    const last = rings[rings.length - 1];
    for (let s = 0; s < seg; s++) b.tri(c, last[(s + 1) % seg], last[s]);
  }
}

/** A member between two local points, as an n-gon prism. */
function addStrutLocal(
  b: HullBuilder,
  m: Matrix4,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r: number,
  sides = 4,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return;
  const up = new Vector3(dx / len, dy / len, dz / len);
  const ref = Math.abs(up.y) > 0.95 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(ref, up).normalize();
  const fwd = new Vector3().crossVectors(right, up).normalize();
  _m2.makeBasis(right, up, fwd).setPosition(ax, ay, az);
  _m2.premultiply(m);
  b.addCylinder(_m2, r, r, len, sides, 0, 0, 0, true, true);
}

/** A cylinder lying along local +X (a pipe run, a roller, a handrail). */
function addLyingCylinder(b: HullBuilder, m: Matrix4, x0: number, x1: number, y: number, z: number, r: number, seg = 8): void {
  addStrutLocal(b, m, x0, y, z, x1, y, z, r, seg);
}

// ---------------------------------------------------------------------------
// The families
// ---------------------------------------------------------------------------

type Assembly = (b: HullBuilder) => void;

const ASSEMBLIES: Record<GreebleKind, Assembly> = {
  /** Bolted access panel: plate, raised lip, latch block. */
  hatch: (b) => {
    b.addBox(_m.identity(), 1, 0.42, 1, 0, 0, 0);
    b.addBox(_m.makeTranslation(0, 0.42, 0), 0.78, 0.2, 0.78, 0, 0, 0);
    b.addBox(_m.makeTranslation(0.3, 0.42, -0.22), 0.18, 0.34, 0.3, 0, 0, 0);
  },

  /** L-bracket: foot, upright web, gusset. The commonest bolt-on in the world. */
  bracket: (b) => {
    b.addBox(_m.makeTranslation(0, 0, 0.16), 0.9, 0.22, 0.66, 0, 0, 0);
    b.addBox(_m.makeTranslation(0, 0, -0.32), 0.9, 1.0, 0.22, 0, 0, 0);
    b.addBox(_m.makeTranslation(-0.28, 0.22, -0.1), 0.16, 0.5, 0.2, 0, 0, 0);
  },

  /** Stiffened case: a base rail and three fins. Heat exchanger or avionics. */
  ribbed: (b) => {
    b.addBox(_m.identity(), 1, 0.18, 0.9, 0, 0, 0);
    for (let i = 0; i < 3; i++) b.addBox(_m.makeTranslation((i - 1) * 0.33, 0.18, 0), 0.14, 0.66, 0.94, 0, 0, 0);
  },

  /** Two crates and a strapped-on third, deliberately off-square. */
  stack: (b) => {
    b.addBox(_m.identity(), 1, 0.5, 0.8, 0, 0, 0);
    b.addBox(_m.makeTranslation(-0.12, 0.5, 0.08), 0.62, 0.55, 0.56, 0, 0, 0);
    b.addBox(_m.makeTranslation(0.36, 0.16, -0.2), 0.24, 0.24, 0.3, 0, 0, 0);
  },

  /** External run: root flange, riser, collar. */
  pipe: (b) => {
    b.addCylinder(_m.identity(), 0.5, 0.44, 0.14, 12, 0, 0, 0);
    b.addCylinder(_m.makeTranslation(0, 0.14, 0), 0.3, 0.27, 0.86, 10, 0, 0, 0);
    b.addCylinder(_m.makeTranslation(0, 0.74, 0), 0.4, 0.36, 0.12, 10, 0, 0, 0);
  },

  /** Louvred opening with a hood over it, so rain and exhaust miss the slats. */
  vent: (b) => {
    b.addBox(_m.identity(), 1, 0.12, 0.9, 0, 0, 0);
    for (let i = 0; i < 4; i++) {
      // Slats leaning aft: a vent that faces nowhere reads as a printed grid.
      _m.makeRotationX(-0.5).setPosition(0, 0.12 + i * 0.14, (i - 1.5) * 0.19);
      b.addBox(_m, 0.86, 0.07, 0.2, 0, 0, 0);
    }
    b.addBox(_m.makeTranslation(0, 0.62, -0.36), 0.96, 0.1, 0.2, 0, 0, 0);
  },

  /** Flat mesh over a recess: frame plus crossed bars, nothing proud. */
  grille: (b) => {
    b.addBox(_m.identity(), 1, 0.08, 1, 0, 0, 0);
    for (let i = 0; i < 4; i++) b.addBox(_m.makeTranslation((i - 1.5) * 0.24, 0.08, 0), 0.07, 0.06, 0.92, 0, 0, 0);
    b.addBox(_m.makeTranslation(0, 0.08, 0.38), 0.94, 0.09, 0.08, 0, 0, 0);
    b.addBox(_m.makeTranslation(0, 0.08, -0.38), 0.94, 0.09, 0.08, 0, 0, 0);
  },

  /**
   * Slats cut INTO the surface. The only family that lives below the mounting
   * face: it casts no shadow proud of the hull, which is precisely why a
   * moulding culture uses it and a welding culture cannot.
   */
  louvre: (b) => {
    b.addBox(_m.makeTranslation(0, -0.001, 0), 1, 0.05, 1, 0, 0, 0);
    for (let i = 0; i < 5; i++) {
      _m.makeRotationX(0.6).setPosition(0, -0.16, (i - 2) * 0.19);
      b.addBox(_m, 0.9, 0.05, 0.16, 0, 0, 0);
    }
  },

  /** Inspection panel with no rim: a chamfered plate that is almost flush. */
  'flush-panel': (b) => {
    b.addBox(_m.identity(), 1, 0.05, 0.86, 0, 0, 0);
    b.addBox(_m.makeTranslation(0, 0.05, 0), 0.9, 0.03, 0.78, 0, 0, 0);
  },

  /** Smooth fairing over a lump. Pressed in a die, so it is the smooth one. */
  blister: (b) => {
    addLathe(
      b,
      _m.identity(),
      [
        [0.5, 0],
        [0.49, 0.1],
        [0.44, 0.24],
        [0.34, 0.38],
        [0.19, 0.47],
        [0, 0.5],
      ],
      12,
    );
  },

  /** A bundle of cables clipped along the outside, with two saddle clips. */
  'cable-loom': (b) => {
    for (let i = 0; i < 3; i++) {
      const y = 0.1 + (i % 2) * 0.13;
      const z = (i - 1) * 0.14;
      addLyingCylinder(b, _m.identity(), -0.5, 0.5, y, z, 0.08, 6);
    }
    for (const x of [-0.28, 0.3]) {
      b.addBox(_m.makeTranslation(x, 0, 0), 0.1, 0.36, 0.5, 0, 0, 0);
    }
  },

  /** Armoured cable run: a square channel with two clamp bands and a flange. */
  conduit: (b) => {
    b.addBox(_m.identity(), 1, 0.3, 0.42, 0, 0, 0);
    for (const x of [-0.24, 0.26]) b.addBox(_m.makeTranslation(x, 0, 0), 0.1, 0.4, 0.54, 0, 0, 0);
    b.addBox(_m.makeTranslation(0.46, 0, 0), 0.1, 0.46, 0.6, 0, 0, 0);
  },

  /** A thin flexible rod on an insulator. Snaps, so nobody armoured builds them. */
  'antenna-whip': (b) => {
    b.addCylinder(_m.identity(), 0.28, 0.2, 0.12, 8, 0, 0, 0);
    b.addCylinder(_m.makeTranslation(0, 0.12, 0), 0.1, 0.075, 0.16, 6, 0, 0, 0);
    b.addCylinder(_m.makeTranslation(0, 0.28, 0), 0.045, 0.012, 0.72, 5, 0, 0, 0);
  },

  /** A rigid instrument mast: four uprights, two collars, a head. */
  mast: (b) => {
    b.addBox(_m.identity(), 0.6, 0.08, 0.6, 0, 0, 0);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      const x = Math.cos(a) * 0.2;
      const z = Math.sin(a) * 0.2;
      addStrutLocal(b, _m.identity(), x, 0.08, z, x * 0.35, 0.86, z * 0.35, 0.035, 4);
    }
    for (const y of [0.34, 0.62]) b.addCylinder(_m.makeTranslation(0, y, 0), 0.17, 0.17, 0.04, 6, 0, 0, 0);
    b.addBox(_m.makeTranslation(0, 0.86, 0), 0.2, 0.14, 0.2, 0, 0, 0);
  },

  /** Crew access. Its presence says people go outside on this hull. */
  ladder: (b) => {
    for (const z of [-0.2, 0.2]) {
      addLyingCylinder(b, _m.identity(), -0.46, 0.46, 0.24, z, 0.035, 5);
      b.addBox(_m.makeTranslation(-0.4, 0, z), 0.08, 0.24, 0.1, 0, 0, 0);
      b.addBox(_m.makeTranslation(0.4, 0, z), 0.08, 0.24, 0.1, 0, 0, 0);
    }
    for (let i = 0; i < 4; i++) {
      const x = (i - 1.5) * 0.24;
      addStrutLocal(b, _m.identity(), x, 0.24, -0.2, x, 0.24, 0.2, 0.028, 5);
    }
  },

  /** Two stanchions and a rail. Same statement as the ladder, at waist height. */
  handrail: (b) => {
    for (const x of [-0.36, 0.36]) {
      addStrutLocal(b, _m.identity(), x, 0, 0, x, 0.52, 0.06, 0.04, 5);
      b.addBox(_m.makeTranslation(x, 0, 0), 0.16, 0.06, 0.16, 0, 0, 0);
    }
    addLyingCylinder(b, _m.identity(), -0.42, 0.42, 0.52, 0.06, 0.04, 6);
  },

  /** A band clamp round something, with its two bolt lugs. */
  clamp: (b) => {
    b.addCylinder(_m.makeRotationZ(Math.PI / 2).setPosition(-0.12, 0.3, 0), 0.3, 0.3, 0.24, 10, 0, 0, 0, false, false);
    for (const z of [-0.2, 0.2]) b.addBox(_m.makeTranslation(0, 0.44, z), 0.22, 0.16, 0.08, 0, 0, 0);
    b.addBox(_m.makeTranslation(0, 0, 0), 0.36, 0.1, 0.44, 0, 0, 0);
  },

  /** A pressure bottle strapped on: drum, two straps, a valve head. */
  drum: (b) => {
    _m.makeRotationZ(Math.PI / 2).setPosition(-0.42, 0.34, 0);
    b.addCylinder(_m, 0.32, 0.32, 0.84, 12, 0, 0, 0, true, true);
    for (const x of [-0.24, 0.24]) b.addBox(_m2.makeTranslation(x, 0, 0), 0.08, 0.7, 0.72, 0, 0, 0);
    b.addCylinder(_m2.makeTranslation(0.46, 0.34, 0), 0.09, 0.07, 0.2, 6, 0, 0, 0);
  },

  /** A diagonal brace added after the fact, with a pad at each end. */
  strut: (b) => {
    addStrutLocal(b, _m.identity(), -0.42, 0.04, -0.2, 0.42, 0.66, 0.2, 0.055, 4);
    b.addBox(_m.makeTranslation(-0.42, 0, -0.2), 0.24, 0.08, 0.24, 0, 0, 0);
    b.addBox(_m.makeTranslation(0.36, 0.58, 0.2), 0.2, 0.16, 0.2, 0, 0, 0);
  },

  /** A plate welded over a plate. The reinforcement read, and the repair read. */
  'doubler-plate': (b) => {
    b.addBox(_m.identity(), 1, 0.07, 0.82, 0, 0, 0);
    b.addBox(_m.makeTranslation(0.06, 0.07, -0.04), 0.72, 0.06, 0.6, 0, 0, 0);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      b.addCylinder(_m.makeTranslation(Math.cos(a) * 0.38, 0.07, Math.sin(a) * 0.3), 0.05, 0.04, 0.05, 5, 0, 0, 0);
    }
  },

  /** A raised seam. Only a welding culture has these, and they are the tell. */
  'weld-bead': (b) => {
    // Three short prisms end to end with slightly different radii: a bead is
    // not extruded, it is a row of overlapping puddles.
    for (let i = 0; i < 3; i++) {
      const r = 0.055 + jit('bead', i) * 0.03;
      addLyingCylinder(b, _m.identity(), -0.5 + i * 0.34, -0.5 + (i + 1) * 0.34 + 0.02, r * 0.5, 0, r, 5);
    }
  },

  /** Foil or fabric lashed over something, with two lash cords. */
  tarp: (b) => {
    const n = 4;
    const grid: number[][] = [];
    for (let i = 0; i <= n; i++) {
      const row: number[] = [];
      for (let j = 0; j <= n; j++) {
        const x = i / n - 0.5;
        const z = j / n - 0.5;
        // Slack in the middle, pulled down at the corners: a taut tarp is a box.
        const sag = (1 - Math.abs(x) * 2) * (1 - Math.abs(z) * 2);
        const y = 0.06 + 0.34 * sag + (jit('tarp', i * 8 + j) - 0.5) * 0.09 * sag;
        row.push(b.pushLocal(_m.identity(), x, y, z, 0, 0, 0.5 + y, 0));
      }
      grid.push(row);
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) b.quad(grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]);
    }
    for (const z of [-0.22, 0.26]) addLyingCylinder(b, _m.identity(), -0.5, 0.5, 0.1, z, 0.022, 4);
  },

  /** A lumpy blob of cured foam. The cheapest, ugliest fix there is. */
  sealant: (b) => {
    const seg = 10;
    const rows = 5;
    const rings: number[][] = [];
    for (let r = 0; r <= rows; r++) {
      const phi = (r / rows) * (Math.PI * 0.5);
      const ring: number[] = [];
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * TAU;
        // Foam does not know what a sphere is.
        const k = 0.42 * (0.72 + 0.5 * jit('foam', r * 16 + s));
        ring.push(
          b.pushLocal(
            _m.identity(),
            Math.cos(a) * Math.cos(phi) * k,
            Math.sin(phi) * k * 0.9,
            Math.sin(a) * Math.cos(phi) * k,
            0,
            0,
            0.4 + 0.6 * (r / rows),
            0,
          ),
        );
      }
      rings.push(ring);
    }
    for (let r = 0; r < rows; r++) {
      for (let s = 0; s < seg; s++) {
        const n = (s + 1) % seg;
        b.quad(rings[r][s], rings[r + 1][s], rings[r + 1][n], rings[r][n]);
      }
    }
  },

  /** A work light aimed at the ship's own hull: yoke, housing, hood. */
  floodlight: (b) => {
    b.addBox(_m.identity(), 0.44, 0.1, 0.44, 0, 0, 0);
    addStrutLocal(b, _m.identity(), -0.16, 0.1, 0, -0.16, 0.5, 0, 0.04, 4);
    addStrutLocal(b, _m.identity(), 0.16, 0.1, 0, 0.16, 0.5, 0, 0.04, 4);
    _m.makeRotationX(1.1).setPosition(0, 0.44, 0);
    b.addCylinder(_m, 0.24, 0.3, 0.34, 10, 0, 0, 0);
    b.addBox(_m2.makeTranslation(0, 0.5, -0.24), 0.5, 0.06, 0.14, 0, 0, 0);
  },

  /** A cable guide. Its presence implies winches, and winches imply salvage. */
  fairlead: (b) => {
    b.addBox(_m.identity(), 1, 0.16, 0.7, 0, 0, 0);
    for (const x of [-0.3, 0.3]) {
      _m.makeRotationX(Math.PI / 2).setPosition(x, 0.38, -0.26);
      b.addCylinder(_m, 0.2, 0.2, 0.52, 10, 0, 0, 0, true, true);
      b.addBox(_m2.makeTranslation(x, 0.16, 0), 0.14, 0.24, 0.64, 0, 0, 0);
    }
  },

  /** A spool of cable on two end plates, with a crank boss. */
  'winch-drum': (b) => {
    _m.makeRotationZ(Math.PI / 2).setPosition(-0.34, 0.36, 0);
    b.addCylinder(_m, 0.26, 0.26, 0.68, 12, 0, 0, 0, true, true);
    for (const x of [-0.34, 0.34]) {
      _m.makeRotationZ(Math.PI / 2).setPosition(x, 0.36, 0);
      b.addCylinder(_m, 0.38, 0.38, 0.08, 12, 0, 0, 0, true, true);
    }
    b.addBox(_m2.makeTranslation(0, 0, 0.28), 0.9, 0.4, 0.14, 0, 0, 0);
    b.addBox(_m2.makeTranslation(0, 0, -0.28), 0.9, 0.4, 0.14, 0, 0, 0);
    b.addCylinder(_m2.makeRotationZ(Math.PI / 2).setPosition(0.46, 0.36, 0), 0.08, 0.08, 0.12, 6, 0, 0, 0);
  },
};

/**
 * The per-family footprint envelope.
 *
 * `w` is the family's plan size as a multiple of the base unit; `lo`/`hi`
 * bound the plan aspect (long-and-thin versus square) and `h`/`hlo`/`hhi` the
 * height. Widening these ranges is half of what stops a scatter reading as one
 * repeated silhouette — the geometry is the other half.
 *
 * `human` marks the families whose size is set by a *person*: a hatch a crew
 * member fits through is 0.9 m on a courier and 0.9 m on a 4 km capital, and
 * that invariance is one of the strongest scale cues the ship has. Everything
 * else is equipment, and equipment grows with the hull — but sub-linearly, at
 * L^0.35, because a bigger ship carries bigger pumps and not proportionally
 * bigger ones.
 */
export interface GreebleEnvelope {
  readonly w: number;
  readonly lo: number;
  readonly hi: number;
  readonly h: number;
  readonly hlo: number;
  readonly hhi: number;
  /** True: absolute human scale. False: scales with the hull at L^0.35. */
  readonly human: boolean;
  /** Relative commonness within a faction's allowed vocabulary. */
  readonly weight: number;
  /** Which palette slot the family paints from. */
  readonly shade: number;
  /**
   * The family's centre value for `aSurf.x`, the surface program's *exposure*
   * channel — not a wear dial, an answer to "how much does the crew and the
   * environment reach this?".
   *
   * `ShipMaterial` reads it in four places and each one wants a different part
   * of the range, which is why one blanket band for all twenty-six families
   * was wrong (BRIEF §7: uniform noise laid evenly over everything):
   *
   *  - `scuff`  fades in from 0.35: the things people rub past.
   *  - `wear`   (edge) is scaled by `0.4 + 0.8·x`: how readily an edge goes to
   *             bare steel. A moulded blister does not; a bare-metal doubler
   *             plate is already there.
   *  - `trim`   only above 0.90, and the shader's own comment says it is for
   *             "the handful of fittings the crew actually grab". At the old
   *             blanket 0.45–0.88 nothing on any hull ever reached it, so the
   *             one rationed accent colour was unreachable by construction.
   *  - anything below ~0.3 reads as plating, which is what a flush panel is.
   */
  readonly exposure: number;
}

export const GREEBLE_ENVELOPE: Record<GreebleKind, GreebleEnvelope> = {
  hatch: { w: 1.5, lo: 0.75, hi: 1.35, h: 0.22, hlo: 0.6, hhi: 1.3, human: true, weight: 1.0, shade: SHADE_HULL, exposure: 0.93 },
  bracket: { w: 1.1, lo: 0.6, hi: 2.2, h: 0.8, hlo: 0.6, hhi: 1.8, human: false, weight: 0.9, shade: SHADE_STRUCTURE, exposure: 0.56 },
  ribbed: { w: 1.3, lo: 0.5, hi: 3.4, h: 0.5, hlo: 0.5, hhi: 1.4, human: false, weight: 0.9, shade: SHADE_HULL, exposure: 0.44 },
  stack: { w: 1.6, lo: 0.6, hi: 1.7, h: 0.9, hlo: 0.7, hhi: 1.7, human: false, weight: 0.7, shade: SHADE_HULL, exposure: 0.6 },
  pipe: { w: 0.85, lo: 1.0, hi: 1.0, h: 1.5, hlo: 0.5, hhi: 1.6, human: false, weight: 0.8, shade: SHADE_STRUCTURE, exposure: 0.5 },
  vent: { w: 1.2, lo: 0.8, hi: 1.6, h: 0.55, hlo: 0.7, hhi: 1.2, human: true, weight: 0.6, shade: SHADE_HULL, exposure: 0.4 },
  grille: { w: 1.4, lo: 0.7, hi: 1.9, h: 0.12, hlo: 0.8, hhi: 1.2, human: true, weight: 0.5, shade: SHADE_TRIM, exposure: 0.36 },
  louvre: { w: 1.6, lo: 0.9, hi: 2.4, h: 0.3, hlo: 0.8, hhi: 1.2, human: true, weight: 0.5, shade: SHADE_HULL, exposure: 0.26 },
  'flush-panel': { w: 1.8, lo: 0.7, hi: 2.0, h: 0.1, hlo: 0.8, hhi: 1.2, human: true, weight: 0.9, shade: SHADE_HULL, exposure: 0.28 },
  blister: { w: 1.9, lo: 0.85, hi: 1.6, h: 0.75, hlo: 0.5, hhi: 1.2, human: false, weight: 0.7, shade: SHADE_HULL, exposure: 0.22 },
  'cable-loom': { w: 1.0, lo: 1.4, hi: 4.0, h: 0.32, hlo: 0.8, hhi: 1.3, human: false, weight: 0.7, shade: SHADE_TRIM, exposure: 0.5 },
  conduit: { w: 1.0, lo: 1.6, hi: 4.5, h: 0.4, hlo: 0.8, hhi: 1.4, human: false, weight: 0.8, shade: SHADE_STRUCTURE, exposure: 0.42 },
  'antenna-whip': { w: 0.5, lo: 1.0, hi: 1.0, h: 5.5, hlo: 0.5, hhi: 2.2, human: false, weight: 0.35, shade: SHADE_TRIM, exposure: 0.55 },
  mast: { w: 1.1, lo: 1.0, hi: 1.0, h: 3.2, hlo: 0.7, hhi: 1.8, human: false, weight: 0.3, shade: SHADE_STRUCTURE, exposure: 0.48 },
  ladder: { w: 0.8, lo: 1.0, hi: 2.6, h: 0.45, hlo: 0.9, hhi: 1.1, human: true, weight: 0.5, shade: SHADE_TRIM, exposure: 0.96 },
  // h was 0.5, which put the rail 0.33 m off the plating — a kerb, not
  // something a person in a suit holds. 1.35 puts it at 0.88 m, and a handrail
  // whose height is a person's height is one of the few unmissable scale cues
  // a hull has. Same argument as `human`, one level down.
  handrail: { w: 1.4, lo: 1.2, hi: 3.0, h: 1.35, hlo: 0.9, hhi: 1.1, human: true, weight: 0.6, shade: SHADE_TRIM, exposure: 0.97 },
  clamp: { w: 0.9, lo: 0.9, hi: 1.3, h: 0.7, hlo: 0.8, hhi: 1.3, human: false, weight: 0.5, shade: SHADE_BARE_METAL, exposure: 0.72 },
  drum: { w: 1.5, lo: 0.9, hi: 1.5, h: 0.8, hlo: 0.7, hhi: 1.3, human: false, weight: 0.6, shade: SHADE_HULL, exposure: 0.5 },
  strut: { w: 1.3, lo: 0.8, hi: 2.4, h: 0.9, hlo: 0.6, hhi: 1.6, human: false, weight: 0.6, shade: SHADE_STRUCTURE, exposure: 0.6 },
  'doubler-plate': { w: 1.7, lo: 0.7, hi: 1.9, h: 0.12, hlo: 0.8, hhi: 1.2, human: false, weight: 0.7, shade: SHADE_BARE_METAL, exposure: 0.78 },
  'weld-bead': { w: 1.2, lo: 2.0, hi: 6.0, h: 0.1, hlo: 0.7, hhi: 1.3, human: true, weight: 0.6, shade: SHADE_BARE_METAL, exposure: 0.8 },
  tarp: { w: 2.0, lo: 0.8, hi: 1.8, h: 0.5, hlo: 0.6, hhi: 1.3, human: false, weight: 0.4, shade: SHADE_TRIM, exposure: 0.62 },
  sealant: { w: 0.9, lo: 0.7, hi: 1.5, h: 0.6, hlo: 0.6, hhi: 1.4, human: true, weight: 0.4, shade: SHADE_TRIM, exposure: 0.66 },
  floodlight: { w: 0.9, lo: 0.9, hi: 1.2, h: 1.1, hlo: 0.8, hhi: 1.4, human: true, weight: 0.35, shade: SHADE_TRIM, exposure: 0.92 },
  fairlead: { w: 1.2, lo: 0.9, hi: 1.6, h: 0.6, hlo: 0.8, hhi: 1.2, human: false, weight: 0.35, shade: SHADE_BARE_METAL, exposure: 0.94 },
  'winch-drum': { w: 1.7, lo: 0.9, hi: 1.6, h: 0.9, hlo: 0.8, hhi: 1.3, human: false, weight: 0.3, shade: SHADE_STRUCTURE, exposure: 0.7 },
};

/**
 * The size draw.
 *
 * There used to be one falling distribution for every instance,
 * `power(0.35, 1.0, -1.6)`, whose median is 0.55 — so half of every scatter
 * landed between a third and a half of its family's unit, and the *whole*
 * population sat below it. Measured on the reference hull that put the median
 * greeble at 0.64 m across and the 95th percentile at 1.5 m: a single narrow
 * band of sub-metre chips. That is the hierarchy failure the greeble close-up
 * exists to catch — large hull masses, then panel lines, then a uniform grain,
 * with nothing in between and nothing a person could stand next to.
 *
 * Two changes, and they are separate arguments:
 *
 *  1. HUMAN FAMILIES DO NOT SCALE AT ALL. The envelope already says a hatch is
 *     0.9 m on a courier and 0.9 m on a capital, and then a 0.35–1.0 multiplier
 *     shrank it to 0.5 m — through which nobody in a suit is fitting. If the
 *     invariance is the scale cue, it has to actually be invariant; the draw
 *     is a tolerance, not a size class.
 *  2. EQUIPMENT COMES IN TWO SIZES. A hull carries a few pieces of major
 *     hardware you read from a hundred metres and a great many small fittings
 *     you read from ten. One distribution cannot be both. `MAJOR_P` of the
 *     equipment draw comes from the upper band, which is what puts a form
 *     between the primary masses and the panel grid.
 *
 * Tall spindly families are excluded from the upper band: their envelope
 * already spans 3.2–5.5 in height, and a 13 m sensor mast on a 131 m freighter
 * is not a middle band, it is a second silhouette.
 */
const SIZE_MAJOR_P = 0.18;
/**
 * The upper class is a SPAN, not a multiplier.
 *
 * `w` already spans 0.5 (a whip) to 2.0 (a tarp), so a flat "×2.5" meant 1.1 m
 * for one family and 6 m of base plan for another — before the aspect ratio,
 * which multiplies by up to another 6. Compounding the three turned a crate
 * stack into a 10 m × 9 m × 9 m mass on a 131 m freighter: not a greeble, a
 * primary volume, competing with the silhouette the hull is supposed to own.
 * A size class whose members are five times apart is not a class. Dividing the
 * draw by the family's own footprint makes every family's major instance land
 * in the same 3–5 m band, which is what "one size class" has to mean.
 */
const SIZE_MAJOR_SPAN_LO = 2.2;
const SIZE_MAJOR_SPAN_HI = 3.8;
/** A major draw always exceeds this; it is also the exact major/minor test. */
const SIZE_MAJOR_LO = 1.25;
const SIZE_MINOR_LO = 0.45;
const SIZE_MINOR_HI = 1.15;
const SIZE_HUMAN_LO = 0.85;
const SIZE_HUMAN_HI = 1.1;
/**
 * Only the low, wide, chunky families take the upper class. A family whose
 * height envelope is already 1.5–5.5 (a pipe riser, a mast, a whip) is tall by
 * construction; scaling it up as well produces a 14 m spike, which is a second
 * silhouette rather than a middle band.
 */
const SIZE_MAJOR_MAX_H = 1.0;
/** Bounds the seat-grid cell; must cover the largest multiplier we can draw. */
const SIZE_MAX = 6;

/**
 * NOT −1. `Rng.power` inverts the CDF as `(u·(maxᵃ⁺¹ − minᵃ⁺¹) + minᵃ⁺¹)^(1/(a+1))`,
 * which at a = −1 is `1^(1/0)` = `1^Infinity` = NaN — every draw, silently, and
 * a NaN scale propagates into the instance matrix and out to the GPU as a
 * degenerate transform. −1 is the log-uniform case and needs a different
 * formula; this is the nearest exponent that does not sit on the singularity.
 */
const SIZE_MINOR_ALPHA = -1.1;

function drawSize(rng: Rng, env: GreebleEnvelope): number {
  if (env.human) return rng.range(SIZE_HUMAN_LO, SIZE_HUMAN_HI);
  if (env.h <= SIZE_MAJOR_MAX_H && rng.chance(SIZE_MAJOR_P)) {
    const span = rng.range(SIZE_MAJOR_SPAN_LO, SIZE_MAJOR_SPAN_HI) / Math.max(env.w, 0.4);
    return Math.max(span, SIZE_MAJOR_LO);
  }
  return rng.power(SIZE_MINOR_LO, SIZE_MINOR_HI, SIZE_MINOR_ALPHA);
}

/**
 * Build one family's base geometry.
 *
 * `toGeometry(true)`, and the reason is worth stating because the opposite was
 * chosen first and it threw information away.
 *
 * Every assembly authors real per-vertex data: `addBox` writes a `mountAO`
 * gradient — dark at the mounting face, open at the top — and a bent normal
 * pointing away from the plate it is bolted to. That is the entire "seated
 * hardware" read, authored once per family and free at runtime. Building with
 * `toGeometry(false)` discarded all of it and left every fitting shaded by a
 * single flat per-instance occlusion constant, which is why a scatter of two
 * thousand assemblies read as two thousand flat chips.
 *
 * The base is never drawn. It is the *source*: `bakeScatter` reads its AO back
 * out per vertex, and the instanced path takes a thin view of it (see
 * `GreebleCache.instanceView`) that shares position/normal/index by reference
 * and overrides `aSurf`/`aBent` with per-instance buffers — which is the
 * channel-aliasing trick, now done on a per-batch object instead of by writing
 * on the shared geometry itself.
 */
export function greebleGeometry(kind: GreebleKind): BufferGeometry {
  const b = new HullBuilder(512);
  ASSEMBLIES[kind](b);
  const g = b.toGeometry(true);
  g.name = `greeble:${kind}`;
  return g;
}

/**
 * One geometry per family, shared by every ship in the scene.
 *
 * Twenty-six assemblies at ~40–200 triangles is under 3 k triangles of VRAM in
 * total, which is cheaper than one instance of a single ship's LOD2 — so the
 * store is per-*module*, never per-ship.
 *
 * WHY THE STORE IS MODULE-SCOPE AND THE CLASS IS A HANDLE. The doc comment
 * above has always said "shared by every ship", and `ShipMesh.dispose()` says
 * "owned by the shared cache, not by the mesh — disposing it here would pull
 * it out from under another ship". Neither was true: `ShipMesh` holds
 * `new GreebleCache()`, one per ship, so five Kessler freighters uploaded five
 * identical copies of hatch, bracket, ribbed, pipe and vent, and the comment
 * asserted a safety property that did not hold — the kind of comment that
 * licenses a real leak the day someone promotes the cache without refcounting.
 *
 * So the *store* moved to module scope and the class stayed exactly where it
 * was, as a refcounted handle onto it. `new GreebleCache()` still means "this
 * ship's view"; `get()` still returns a geometry; `dispose()` still frees
 * everything this ship was using and nothing another ship still needs. No
 * caller changes, and now both comments are true.
 */
interface CacheEntry {
  readonly geometry: BufferGeometry;
  refs: number;
}

const GEOMETRY_STORE = new Map<GreebleKind, CacheEntry>();

/**
 * Free a per-batch instanced view without taking the shared vertex data with
 * it.
 *
 * `BufferGeometry.dispose()` fires an event that makes the renderer drop the
 * GL buffer behind *every* attribute the geometry still references — including
 * the position and index buffers this view borrowed from the cache and that
 * every other ship is drawing from. Detaching the borrowed attributes first
 * makes the dispose free exactly what this view owns: its own `aSurf`,
 * `aBent` and `aShade`.
 */
function releaseInstanceView(g: BufferGeometry): void {
  g.deleteAttribute('position');
  g.deleteAttribute('normal');
  g.setIndex(null);
  g.dispose();
}

export class GreebleCache {
  /** Families this view has taken a reference on. One ref per kind, not per get. */
  private readonly held = new Set<GreebleKind>();
  /** Per-batch instanced views this view minted, and therefore owes a free. */
  private readonly views = new Set<BufferGeometry>();
  private disposed = false;

  get(kind: GreebleKind): BufferGeometry {
    let e = GEOMETRY_STORE.get(kind);
    if (!e) {
      e = { geometry: greebleGeometry(kind), refs: 0 };
      GEOMETRY_STORE.set(kind, e);
    }
    if (!this.held.has(kind)) {
      this.held.add(kind);
      e.refs++;
    }
    return e.geometry;
  }

  /**
   * A drawable view of one family for one batch.
   *
   * The vertex data is borrowed by reference — the same `BufferAttribute`
   * objects, so the renderer uploads one position buffer per family for the
   * whole scene, which is the sharing the budget asks for. Only the
   * per-instance channels are this batch's own.
   *
   * This is also the fix for a real corruption: `ShipMesh.makeInstanced` used
   * to `setAttribute('aSurf', …)` straight onto the cached geometry. Building
   * LOD1 therefore overwrote LOD0's per-instance buffers on the object LOD0's
   * `InstancedMesh` was still drawing from — measured as an InstancedMesh with
   * `count` 253 reading a 17-element `aSurf`, which is a read past the end of
   * the buffer and an INVALID_OPERATION on any driver that range-checks. It
   * would have fired the first time a ship dropped to LOD1 and came back.
   * A view per batch cannot alias another batch, in this ship or any other.
   */
  instanceView(
    kind: GreebleKind,
    surf: Float32Array,
    bent: Float32Array,
    shade: Float32Array,
  ): BufferGeometry {
    const base = this.get(kind);
    const g = new BufferGeometry();
    g.name = base.name;
    g.setAttribute('position', base.getAttribute('position'));
    const nrm = base.getAttribute('normal');
    if (nrm) g.setAttribute('normal', nrm);
    g.setIndex(base.getIndex());
    // Per-instance from here down. Declared here rather than left to the
    // assembler so a batch is correct the moment it is handed over.
    g.setAttribute('aSurf', new InstancedBufferAttribute(surf, 4));
    g.setAttribute('aBent', new InstancedBufferAttribute(bent, 4));
    g.setAttribute('aShade', new InstancedBufferAttribute(shade, 1));
    this.views.add(g);
    return g;
  }

  /** Frees this view's batches, and any family no other ship still holds. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const g of this.views) releaseInstanceView(g);
    this.views.clear();
    for (const kind of this.held) {
      const e = GEOMETRY_STORE.get(kind);
      if (!e) continue;
      if (--e.refs <= 0) {
        e.geometry.dispose();
        GEOMETRY_STORE.delete(kind);
      }
    }
    this.held.clear();
  }
}

/**
 * How many families the module-scope store is holding.
 *
 * The probe `ShipMaterial.shipMaterialCacheSize()` has and this module did
 * not: build two ships of a family and it stays at the vocabulary size rather
 * than doubling; dispose every ship and it must be 0.
 */
export function greebleCacheSize(): number {
  return GEOMETRY_STORE.size;
}

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

/** A surface the scatter may populate, with the blueprint's own density. */
export interface ScatterTarget {
  readonly volume: PrimaryVolume;
  /** `PrimaryVolume.detailDensity`, 0..1. Machinery high, tanks low. */
  readonly density: number;
  /** Run range to populate. Defaults to (0.06, 0.94) so caps stay clean. */
  readonly tRange?: readonly [number, number];
}

export interface ScatterOptions {
  readonly targets: readonly ScatterTarget[];
  /** The faction's vocabulary — `greebleVocabulary(faction)`. Never all 26. */
  readonly families: readonly GreebleKind[];
  /** `RenderProfile.detailSeed`. Same seed ⇒ same rivets, forever. */
  readonly seed: number;
  readonly lod: LodLevel;
  /** Overall hull length, km. Sets the equipment scale and the density law. */
  readonly hullLengthKm: number;
  readonly cache: GreebleCache;
  /** Hard cap on total instances, from the triangle budget. */
  readonly budget: number;
  /**
   * Hard cap on total greeble triangles. Defaults to `GREEBLE_TRI_SHARE` of
   * `lod.triangleBudget × lod.greebleFraction`.
   *
   * WHY THIS EXISTS SEPARATELY FROM `budget`. `budget` is an instance count,
   * and an instance count cannot bound triangles when one family costs 30
   * triangles and another costs 168 — a ladder is five and a half hatches.
   * The assembler derives its instance cap as `triangleBudget × 0.02`, i.e.
   * on an assumed 50 triangles per instance; the vocabulary's actual mean is
   * 56 and its ladder-heavy tail is much worse. Measured on the reference
   * hull at LOD0: 2,272 instances for 153,826 greeble triangles against a
   * 136,856 triangle budget that also has to pay for the hull — 33% over
   * before the plating is counted, and the overrun scales with whichever
   * families the faction happens to allow. So the budget is spent in the
   * currency it is denominated in.
   */
  readonly triangleBudget?: number;
  /** Shared with the volume builders so nothing lands on a rib or a patch. */
  readonly seats?: SurfaceSeat[];
  /** Parts already on the hull; a greeble buried in one is worse than none. */
  readonly occluders?: readonly OccluderSphere[];
  /** Appended to with one contact sphere per instance, for the material. */
  readonly outOccluders?: OccluderSphere[];
}

/**
 * One `InstancedMesh` worth of one family.
 *
 * The mesh itself is not built here: materials belong to `ShipMaterial.ts` and
 * the scene graph to `ShipMesh.ts`. What comes back is exactly the data an
 * `InstancedMesh` needs, so the assembly layer can decide how many draw calls
 * it can afford before it commits to any.
 */
export interface InstancedScatter {
  /** Geometry cache key — equal keys share one set of vertex buffers. */
  readonly key: string;
  readonly kind: GreebleKind;
  /**
   * Hand this to `InstancedMesh`. It is this batch's own thin geometry: the
   * position, normal and index `BufferAttribute`s are the shared cached ones
   * by reference, and `aSurf`/`aBent`/`aShade` are this batch's per-instance
   * buffers, already bound. Never shared with another batch or another LOD.
   */
  readonly geometry: BufferGeometry;
  /**
   * The shared family geometry, with the assembly's *per-vertex* surface data
   * still on it. Only the bake path wants this — it is the source of the
   * mount-AO gradient that the per-instance channel cannot carry.
   */
  readonly base: BufferGeometry;
  readonly count: number;
  /** `count × 16`, ready for `InstancedMesh.instanceMatrix`. */
  readonly matrices: Float32Array;
  /**
   * `count × 4` — `aSurf` = (wear, partId, yardTag, plateScale), the same
   * declaration the hull uses. Bind as an `InstancedBufferAttribute`; three
   * takes whichever the geometry supplies, so one program serves both.
   */
  readonly surf: Float32Array;
  /**
   * `count × 4` — `aBent` = (bent normal xyz in SHIP space, occlusion).
   *
   * Ship space, not instance space: the shader cannot know whether it was
   * handed a per-vertex or a per-instance channel, so the instance's own
   * orientation is folded in here. For a greeble that is the hull normal it
   * is bolted to, which is exactly right — a fitting sees the hemisphere its
   * mounting face points into and nothing behind it.
   */
  readonly bent: Float32Array;
  /** `count` — the palette selector. See `volumes.ts` SHADE_*. */
  readonly shade: Float32Array;
  /** Triangles this batch draws, for the budget check. */
  readonly triangles: number;
}

/** A spatial hash over the seat list. The reference's linear scan is O(n²). */
class SeatGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly seats: SurfaceSeat[];
  private readonly inv: number;
  /** Largest seat radius inserted so far. Bounds the neighbourhood search. */
  private maxSeatR = 0;

  constructor(seats: SurfaceSeat[], cellKm: number) {
    this.seats = seats;
    this.inv = 1 / Math.max(cellKm, 1e-9);
    for (let i = 0; i < seats.length; i++) this.insert(i);
  }

  private key(x: number, y: number, z: number): number {
    // A 21-bit-per-axis Morton-free hash. Collisions merely cost a few extra
    // distance tests; they never cause a false accept, because the candidate
    // list is always re-tested exactly.
    const i = Math.floor(x * this.inv) | 0;
    const j = Math.floor(y * this.inv) | 0;
    const k = Math.floor(z * this.inv) | 0;
    return (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) >>> 0;
  }

  private insert(i: number): void {
    const s = this.seats[i];
    if (s.r > this.maxSeatR) this.maxSeatR = s.r;
    const k = this.key(s.x, s.y, s.z);
    const cell = this.cells.get(k);
    if (cell) cell.push(i);
    else this.cells.set(k, [i]);
  }

  /** True when a sphere of `r` at (x,y,z) clears every seat already taken. */
  free(x: number, y: number, z: number, r: number): boolean {
    const cell = 1 / this.inv;
    // Two spheres can only touch within `r + maxSeatR`, so that — and not the
    // cell size — is the neighbourhood radius. Using the cell size instead
    // searches 125 cells where 27 suffice, which is 4.6× the whole scatter.
    const span = Math.ceil((r + this.maxSeatR) * this.inv);
    for (let i = -span; i <= span; i++) {
      for (let j = -span; j <= span; j++) {
        for (let k = -span; k <= span; k++) {
          const list = this.cells.get(this.key(x + i * cell, y + j * cell, z + k * cell));
          if (!list) continue;
          for (const idx of list) {
            const s = this.seats[idx];
            // Size-aware with a floor: hardware that touches its neighbour
            // reads as a pile, not as a fitted-out hull.
            const gap = (r + s.r) * 0.95 + HATCH_WIDTH_KM * 0.25;
            const dx = s.x - x;
            const dy = s.y - y;
            const dz = s.z - z;
            if (dx * dx + dy * dy + dz * dz < gap * gap) return false;
          }
        }
      }
    }
    return true;
  }

  take(x: number, y: number, z: number, r: number): void {
    this.seats.push({ x, y, z, r });
    this.insert(this.seats.length - 1);
  }
}

/**
 * How many greebles a surface should carry.
 *
 * The reference hull runs one per 2.75 m² on a 30 m courier. Holding that
 * areal density gives 266 k instances on a 1 km hull and 4.25 M on a 4 km one,
 * so it cannot be held: what is held instead is the *count*, which grows only
 * as the square root of the area. That drops the effective density by 3,000×
 * from courier to capital, which is exactly the figure the scale analysis
 * arrives at from the triangle budget — geometric detail stops being the
 * detail strategy at capital scale and the fragment shader takes over.
 */
/**
 * Share of a LOD's triangle budget the detail layer may spend.
 *
 * BRIEF §6 gives a medium hull 120 k triangles at LOD0, and detail is the last
 * thing generated and the first thing that should give way — the plating, the
 * spine and the primary volumes have to fit first. Just over half leaves the
 * reference hull's ~28 k of structure a 2× margin against the hulls whose
 * construction kind puts ribs and trusses on every station.
 */
export const GREEBLE_TRI_SHARE = 0.55;

export function greebleCountFor(areaKm2: number, density: number, budget: number, greebleFraction: number): number {
  const areaM2 = areaKm2 * 1e6;
  const n = 240 * Math.sqrt(Math.max(areaM2, 1) / 660) * clamp(density, 0, 1.2);
  return Math.max(0, Math.min(budget, Math.round(n * clamp(greebleFraction, 0, 1))));
}

/** Approximate skin area of a volume, km². Cheap: perimeter × run length. */
function volumeAreaKm2(v: PrimaryVolume): number {
  let per = 0;
  let len = 0;
  const p0 = new Vector3();
  const p1 = new Vector3();
  const steps = 6;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    let circ = 0;
    sampleVolumeSurface(v, t, 0, p0);
    for (let j = 1; j <= 12; j++) {
      sampleVolumeSurface(v, t, (j / 12) * TAU, p1);
      circ += p0.distanceTo(p1);
      p0.copy(p1);
    }
    per += circ / steps;
  }
  if (v.path.kind === 'linear') len = v.path.length;
  else len = Math.abs(v.path.radius * v.path.sweep);
  return per * len;
}

const _pos = new Vector3();
const _nrm = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _mat = new Matrix4();
const _scale = new Matrix4();
const AFT = new Vector3(0, 0, 1);

/**
 * Scatter every allowed family over every target surface.
 *
 * Three rules, all of them learned the hard way:
 *
 *  - ONE SHARED SEAT LIST. Rejecting only against your own family lets the
 *    families land on each other, which is the failure that looks worst.
 *  - SIZE BEFORE REJECTION. Spacing has to know how big the thing is; a fixed
 *    minimum lets a wide part sit on top of its neighbour.
 *  - SEAT THEM INTO THE SHELL. The mounting face is flat and the hull is not,
 *    so a part that only kisses the plating shows daylight under its corners.
 *    Sinking a fifth of its own height buries that gap and gives the base a
 *    contact line, which is what "no floating detail" actually costs.
 */
export function scatterGreebles(opts: ScatterOptions): InstancedScatter[] {
  const out: InstancedScatter[] = [];
  if (opts.lod.greebleFraction <= 0 || opts.families.length === 0 || opts.targets.length === 0) return out;

  const rng = new Rng(hashSeed(opts.seed >>> 0, 'render/greebles'));
  const seats: SurfaceSeat[] = opts.seats ?? [];

  // Equipment scale: sub-linear in hull length, human-scale families exempt.
  const equipK = Math.pow(Math.max(opts.hullLengthKm, 1e-4) / 0.03, 0.35);

  // Work out the per-target quota first, so a low-density tank does not eat
  // the budget a machinery deck needs.
  let totalCount = 0;
  const quota: number[] = [];
  for (const tgt of opts.targets) {
    const n = greebleCountFor(volumeAreaKm2(tgt.volume), tgt.density, opts.budget, opts.lod.greebleFraction);
    quota.push(n);
    totalCount += n;
  }
  if (totalCount > opts.budget) {
    const k = opts.budget / totalCount;
    for (let i = 0; i < quota.length; i++) quota[i] = Math.round(quota[i] * k);
  }

  // Split each family's share of every quota.
  let wsum = 0;
  for (const kind of opts.families) wsum += GREEBLE_ENVELOPE[kind].weight;

  // Now spend the budget in triangles as well as in instances. The projected
  // cost is exact — the quota, the family split and the per-family triangle
  // count are all known before a single instance is placed — so the trim is a
  // single scale factor applied to every quota rather than a first-come cut
  // that would silently starve whichever family sorts last.
  // `greebleFraction` is deliberately NOT in the cap: `greebleCountFor` has
  // already applied it to every quota, so folding it in here would square it
  // and strip a LOD1 that was comfortably inside its budget down to nothing.
  const triCap = Math.max(0, opts.triangleBudget ?? opts.lod.triangleBudget * GREEBLE_TRI_SHARE);
  let projected = 0;
  for (const kind of opts.families) {
    const share = GREEBLE_ENVELOPE[kind].weight / Math.max(wsum, 1e-9);
    const cost = greebleTriangleCount(kind, opts.cache);
    for (let i = 0; i < quota.length; i++) projected += Math.round(quota[i] * share) * cost;
  }
  if (projected > triCap) {
    const k = triCap / projected;
    for (let i = 0; i < quota.length; i++) quota[i] = Math.round(quota[i] * k);
  }

  // Cell size from the largest thing we could possibly place. The plan aspect
  // (`hi`, up to 6 for a weld bead) and the size draw both count: leaving them
  // out sized the cell for a third of the largest instance, and the grid then
  // walked a 5×5×5 neighbourhood where 3×3×3 was the whole point.
  let maxR = HATCH_WIDTH_KM;
  for (const kind of opts.families) {
    const e = GREEBLE_ENVELOPE[kind];
    const span = e.w * Math.max(e.hi, 1) * SIZE_MAX * (e.human ? 1 : equipK) * 0.5;
    maxR = Math.max(maxR, span * HATCH_WIDTH_KM);
  }
  const grid = new SeatGrid(seats, maxR * 2);

  // Only casters big enough to win one of the material's eight analytic slots
  // are worth emitting. `ShipMesh.publishOccluders` sorts by radius and keeps
  // the largest eight, so handing it 2,272 sub-metre spheres was 2,272
  // allocations and a 2,400-element sort to produce a list whose every greeble
  // entry is discarded. The threshold is set so the *major* fittings — the
  // ones whose shadow actually sweeps as the star moves — can compete with the
  // hull's own masses, and nothing else is offered.
  const occFloor = HATCH_WIDTH_KM * 1.1 * Math.max(1, equipK * 0.75);

  for (const kind of opts.families) {
    const env = GREEBLE_ENVELOPE[kind];
    const share = env.weight / Math.max(wsum, 1e-9);
    const mats: number[] = [];
    const surf: number[] = [];
    const bent: number[] = [];
    const shade: number[] = [];

    for (let ti = 0; ti < opts.targets.length; ti++) {
      const tgt = opts.targets[ti];
      const v = tgt.volume;
      const want = Math.round(quota[ti] * share);
      if (want <= 0) continue;
      const [t0, t1] = tgt.tRange ?? [0.06, 0.94];

      // Decide once, on the family's largest possible instance, whether this
      // family is geometry at this level at all. Deciding per attempt would
      // spin through the whole attempt budget rejecting its own dice.
      const unit = HATCH_WIDTH_KM * env.w * (env.human ? 1 : equipK);
      if (unit * Math.max(env.hi, env.h * env.hhi) < opts.lod.minFeatureKm) continue;

      let taken = 0;
      let attempts = 0;
      const maxAttempts = want * 24;
      while (taken < want && attempts < maxAttempts) {
        attempts++;
        const t = rng.range(t0, t1);
        // Biased away from straight down: nobody bolts equipment where the
        // landing gear puts it in the dirt, and a greebled belly reads as
        // noise from every angle that matters.
        const theta = rng.chance(0.8)
          ? rng.range(-0.75, Math.PI + 0.75)
          : rng.range(Math.PI + 0.75, TAU - 0.75);

        // The position is one section evaluation; the normal is four, so it is
        // only worth taking once the candidate has survived rejection. That
        // single reordering is most of the scatter's cost.
        sampleVolumeSurface(v, t, theta, _pos);

        // Size, drawn before the rejection test: spacing has to know how big
        // the thing is, and a fixed minimum lets a wide part sit on top of its
        // neighbour. See `drawSize` for why it is two populations and not one.
        const s = drawSize(rng, env);
        // A big fitting is chunky, not big AND maximally elongated. The aspect
        // range exists so that the *small* instances can be long thin runs;
        // letting the upper class draw from the same range multiplies the two
        // and is the other half of how a 2.4 m crate became a 10 m one.
        const major = s >= SIZE_MAJOR_LO;
        const ratio = major
          ? rng.range(env.lo, env.lo + (env.hi - env.lo) * 0.3)
          : rng.range(env.lo, env.hi);
        const sx = unit * s * ratio;
        const sz = unit * s * (env.lo === env.hi ? ratio : rng.range(major ? 0.85 : 0.7, major ? 1.15 : 1.5));
        const sy = unit * env.h * s * rng.range(env.hlo, env.hhi);
        const rad = Math.max(sx, sz) * 0.5;

        // Nothing non-finite reaches an instance buffer. A NaN scale or a NaN
        // sample point produces a degenerate matrix, and a degenerate matrix
        // is not a visibly wrong greeble that someone notices in review — it
        // is a greeble that silently is not there, which is indistinguishable
        // from a scatter that never ran. Checked before the rejection test so
        // a bad candidate costs an attempt and never a seat.
        if (!Number.isFinite(sx + sy + sz + _pos.x + _pos.y + _pos.z) || sx <= 0 || sy <= 0 || sz <= 0) continue;

        if (!grid.free(_pos.x, _pos.y, _pos.z, rad)) continue;
        let buried = false;
        if (opts.occluders) {
          for (const o of opts.occluders) {
            const dx = _pos.x - o.x;
            const dy = _pos.y - o.y;
            const dz = _pos.z - o.z;
            if (dx * dx + dy * dy + dz * dz < o.r * o.r * 0.9) {
              buried = true;
              break;
            }
          }
        }
        if (buried) continue;

        grid.take(_pos.x, _pos.y, _pos.z, rad);
        taken++;
        sampleVolumeNormal(v, t, theta, _nrm);
        // Same rule for the orientation. A degenerate section can hand back a
        // zero or non-finite normal; +Y up is a wrong-looking fitting, which
        // is a bug someone can see, rather than an invisible one.
        if (!Number.isFinite(_nrm.x + _nrm.y + _nrm.z) || _nrm.lengthSq() < 1e-12) _nrm.set(0, 1, 0);

        // Mounting frame: +Y is the surface normal, +Z runs aft along the
        // airflow, so every fitting is naturally aligned to the hull and the
        // grime streaks off it in the right direction.
        _fwd.copy(AFT).addScaledVector(_nrm, -AFT.dot(_nrm));
        if (_fwd.lengthSq() < 1e-10) _fwd.set(0, 1, 0).addScaledVector(_nrm, -_nrm.y);
        _fwd.normalize();
        _right.crossVectors(_nrm, _fwd);
        _mat.makeBasis(_right, _nrm, _fwd);
        // Seat depth is set by the FOOTPRINT, not by the height.
        //
        // The gap being buried is the daylight under a flat mounting face on a
        // curved shell, and its depth is the sagitta of the contact patch — a
        // function of how wide the base is and how tight the hull curves, and
        // of nothing else. Sinking "a fifth of its own height" instead made
        // the depth grow with the wrong dimension: on a 3.5 m instrument mast
        // it drove the base plate 0.77 m inside the plating, which is not a
        // seated fitting, it is a mast growing out of a hull with no visible
        // mounting at all. The height only survives as a cap, so that a nearly
        // flat family — a weld bead, a flush panel — is not pushed through the
        // skin it is supposed to be lying on.
        const sink = Math.min(0.08 * Math.min(sx, sz), 0.3 * sy);
        _mat.setPosition(
          _pos.x - _nrm.x * sink,
          _pos.y - _nrm.y * sink,
          _pos.z - _nrm.z * sink,
        );
        // Long fittings — rails, looms, beads — align to the airflow; compact
        // ones take any yaw. A cable run at 40° to the hull is a lie.
        const yaw = env.hi > 2.2 ? (rng.chance(0.85) ? 0 : Math.PI * 0.5) : rng.range(0, TAU);
        if (yaw !== 0) _mat.multiply(_scale.makeRotationY(yaw));
        _mat.multiply(_scale.makeScale(sx, sy, sz));
        for (let i = 0; i < 16; i++) mats.push(_mat.elements[i]);

        const partId = GREEBLE_PART_BASE + ((taken * 7 + ti * 13) % 4096);
        // Exposure follows FUNCTION, not the scatter. The old blanket
        // 0.45–0.88 said every fitting on every hull is reached by hands and
        // by space to the same degree, which is the "uniform noise laid evenly
        // over everything" BRIEF §7 rejects by name — and it also put the
        // whole vocabulary below the 0.90 the shader gates the trim accent on,
        // so the one rationed colour was unreachable on any ship. A handrail
        // and a moulded blister are now three quarters of the range apart.
        const expo = clamp(env.exposure + rng.range(-0.06, 0.06), 0.05, 0.995);
        // A fitting is a different plate size from the hull it is bolted to;
        // and the major fittings are big enough to carry hull-scale plating.
        surf.push(expo, partId, 0, major ? 0.8 : 0.55);
        // The unoccluded direction is the hull normal under it. That single
        // vec4 is what replaces the analytic contact-shadow array. The scalar
        // is how buried the family sits: a louvre is cut into the plate, a
        // mast stands clear of it, and one constant for both was flat.
        // The band is centred on the 0.28 that used to be a constant, so the
        // hull's overall value does not move; what changes is that the two
        // ends of the vocabulary are now half a band apart instead of equal.
        bent.push(_nrm.x, _nrm.y, _nrm.z, clamp(0.36 - 0.16 * env.h, 0.12, 0.36));
        shade.push(env.shade);
        // The caster is a SPHERE, so its radius has to be the size of the
        // contact patch and not of the bounding box. `max(rad, sy/2)` let the
        // longest axis set it: a 12 m conduit run claimed a 7 m sphere of
        // darkened plate around a fitting 1.2 m wide, and a 5 m mast claimed
        // 2.9 m around a pole. Worse, both then outranked the hull's own
        // radiators in `publishOccluders`, which sorts by radius into eight
        // slots — the exact eviction ShipMaterial's budget note says must
        // never happen ("a whip antenna must never evict a radiator"). Short
        // plan axis plus height, and height clamped by the plan so a spindly
        // family cannot buy its way up the sort.
        const occR = (Math.min(sx, sz) * 0.5 + Math.min(sy, Math.max(sx, sz))) * 0.7;
        if (occR >= occFloor) {
          opts.outOccluders?.push({ x: _pos.x, y: _pos.y, z: _pos.z, r: occR, part: partId });
        }
      }
    }

    const n = shade.length;
    if (n === 0) continue;
    const base = opts.cache.get(kind);
    const index = base.getIndex();
    const surfA = Float32Array.from(surf);
    const bentA = Float32Array.from(bent);
    const shadeA = Float32Array.from(shade);
    out.push({
      key: `greeble:${kind}`,
      kind,
      geometry: opts.cache.instanceView(kind, surfA, bentA, shadeA),
      base,
      count: n,
      matrices: Float32Array.from(mats),
      surf: surfA,
      bent: bentA,
      shade: shadeA,
      triangles: ((index ? index.count : 0) / 3) * n,
    });
  }

  return out;
}

/**
 * Triangles one instance of a family costs. For the budget arithmetic in
 * `ShipMesh`, which has to decide how many families it can afford before it
 * builds any of them.
 */
export function greebleTriangleCount(kind: GreebleKind, cache: GreebleCache): number {
  const idx = cache.get(kind).getIndex();
  return idx ? idx.count / 3 : 0;
}

/**
 * Weld a batch into the merged hull buffer instead of drawing it.
 *
 * The draw-call budget is twelve and an Ossuary hull has twenty-four allowed
 * families; something has to give, and it must not be the vocabulary, because
 * the vocabulary *is* the faction. So the crowded families are instanced and
 * the sparse ones are baked: a family with nine instances costs 9 × 40 = 360
 * unique triangles in a buffer that is already being drawn, against a whole
 * draw call of its own. Bake below roughly 40 instances and instance above it.
 *
 * Wear, part and shade move from per-instance attributes to per-vertex ones,
 * which is exactly the channel-aliasing trick the material relies on.
 */
export function bakeScatter(s: InstancedScatter, out: HullBuilder): void {
  const src = s.base;
  const pos = src.getAttribute('position');
  const index = src.getIndex();
  if (!index) return;
  // The assembly's own per-vertex occlusion, authored by `addBox`'s mountAO
  // and by the lathe profiles: dark at the mounting face, open at the top.
  // This path used to write one constant for the whole instance and throw the
  // gradient away, which is what made a baked fitting read as a decal — the
  // underside of a hatch lip was exactly as bright as its top face. The
  // instance's own burial factor still multiplies it, so the two compose.
  const srcBent = src.getAttribute('aBent');
  const m = new Matrix4();
  const p = new Vector3();
  const bn = new Vector3();
  for (let i = 0; i < s.count; i++) {
    m.fromArray(s.matrices, i * 16);
    const base = out.vertexCount;
    const nx = s.bent[i * 4];
    const ny = s.bent[i * 4 + 1];
    const nz = s.bent[i * 4 + 2];
    // Occlusion polarity: the builder carries 1 = open sky and packs the flip
    // at `toGeometry`, so both the instance's `aBent.w` and the source's
    // invert here, and they compose as open-sky fractions rather than sums.
    const open = 1 - s.bent[i * 4 + 3];
    out.setBent(nx, ny, nz);
    out.setYard(s.surf[i * 4 + 2]);
    out.setPlateScale(s.surf[i * 4 + 3] || 1);
    for (let v = 0; v < pos.count; v++) {
      p.set(pos.getX(v), pos.getY(v), pos.getZ(v)).applyMatrix4(m);
      if (srcBent) {
        // The assembly's bent normal is authored in its own frame — the sides
        // of a box see half a hemisphere, not the whole one — so rotate it
        // into ship space rather than flattening every vertex to the hull
        // normal. Zero means "no opinion" and falls back to that normal.
        bn.set(srcBent.getX(v), srcBent.getY(v), srcBent.getZ(v));
        if (bn.lengthSq() > 1e-8) {
          bn.transformDirection(m);
          out.setBent(bn.x, bn.y, bn.z);
        } else {
          out.setBent(nx, ny, nz);
        }
      }
      const vOpen = srcBent ? open * (1 - clamp(srcBent.getW(v), 0, 1)) : open;
      out.vertex(p.x, p.y, p.z, s.surf[i * 4], s.surf[i * 4 + 1], vOpen, s.shade[i]);
    }
    for (let k = 0; k < index.count; k += 3) {
      out.tri(base + index.getX(k), base + index.getX(k + 1), base + index.getX(k + 2));
    }
  }
  // Leave the builder as we found it. The bake used to walk out with the last
  // instance's yard, plate scale and bent normal still set, and every vertex
  // written after it inherited them — harmless only because `ShipMesh` happens
  // to bake last. That is a property of the caller, not of this function.
  out.setBent(0, 0, 0);
  out.setYard(0);
  out.setPlateScale(1);
}

/**
 * Split a scatter into what gets its own draw call and what gets welded in.
 *
 * Sorted by instance count so the batches that actually pay for a draw call
 * keep theirs. Deterministic: equal counts break on the family name, never on
 * insertion order.
 */
export function splitScatterBudget(
  scatters: readonly InstancedScatter[],
  maxBatches: number,
): { readonly instanced: InstancedScatter[]; readonly baked: InstancedScatter[] } {
  const sorted = [...scatters].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  return {
    instanced: sorted.slice(0, Math.max(0, maxBatches)),
    baked: sorted.slice(Math.max(0, maxBatches)),
  };
}
