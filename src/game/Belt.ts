/**
 * Belt — the asteroid belt as game state (v4 sub-plan 2, Task 3).
 *
 * gen/belt.ts makes the belt a pure function of the seed. This module puts it
 * in the game: which field the ship is in, where each field and asteroid is
 * NOW on the orbit clock, how fast it moves, and how much is left in it once
 * the player has mined it (WorldState, P2).
 *
 * Frame: world km, float64, star at the origin — the same frame as
 * `Universe.allBodies()[i].world`, so a floating-origin rebase moves nothing
 * here. An asteroid sits at a fixed offset in its field, so its velocity is
 * the field centre's orbital velocity about the star.
 *
 * Inert without a belt (no belt in the system, or no system yet): every query
 * answers null / false / 0, and nothing else in the game changes.
 *
 * Per frame it costs one nearest-field search over the system's cached field
 * orbits and allocates nothing: the nearest field and its neighbours (±2) are
 * memoised as FieldSpecs, rebuilt only when the nearest field changes, and
 * id lookups hit the memo by string comparison before ever parsing an id.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import {
  ASTEROID_RADIUS_KM,
  FIELD_RADIUS_KM,
  beltFor,
  fieldOrbits,
  fieldSpec,
  nearestFieldIndex,
  type AsteroidSpec,
  type BeltSpec,
  type FieldSpec,
  type Resource,
  type Vec3Like,
} from '@/gen/belt';
import { orbitalPosition, orbitalVelocity } from '@/gen/orbit';
import type { OrbitSpec, StarSystemSpec } from '@/gen/types';
import type { WorldState } from '@/game/worldState';

/** What the Belt reads of the universe. `Universe` satisfies it. */
export interface BeltWorld {
  readonly system: StarSystemSpec | null | undefined;
  readonly orbitSeconds: number;
  readonly flight: { readonly worldPosition: Vec3Like };
}

export interface BeltOptions {
  readonly universe: BeltWorld;
  readonly worldState: WorldState;
}

/** A writable 3-vector; `three`'s Vector3 satisfies it. */
export interface MutableVec3Like {
  x: number;
  y: number;
  z: number;
}

/** Fields either side of the nearest one kept built. */
const MEMO_SPAN = 2;
const MEMO_SLOTS = 2 * MEMO_SPAN + 1;

/** Display name of belt field k: the chart, the nav target and the ORBIT log (R21). */
export function beltFieldName(systemName: string, k: number): string {
  return `BELT · ${systemName} ${k}`;
}

/**
 * Display name of a field or asteroid target id, or null if it is neither.
 * With the system's name a field reads as `beltFieldName`.
 */
export function beltTargetName(id: string, systemName?: string): string | null {
  // Allocates: called on selection and scan, never per frame.
  if (id.startsWith('ast:')) {
    const p = id.split(':');
    return `Asteroid ${p[p.length - 2]}-${p[p.length - 1]}`;
  }
  if (id.startsWith('field:')) {
    const p = id.split(':');
    const k = p[p.length - 1]!;
    return systemName ? beltFieldName(systemName, Number(k)) : `Field ${k}`;
  }
  return null;
}

export class Belt implements GameModule {
  readonly name = 'belt';

  private readonly world: BeltWorld;
  private readonly worldState: WorldState;

  private system: StarSystemSpec | null = null;
  private spec: BeltSpec | null = null;
  private orbits: readonly OrbitSpec[] = [];
  private astPrefix = '';
  private fieldPrefix = '';

  /** Memo: the nearest field and its ±MEMO_SPAN neighbours. */
  private readonly memo: Array<FieldSpec | null> = new Array<FieldSpec | null>(MEMO_SLOTS).fill(null);
  private nearest: FieldSpec | null = null;
  /** The last field looked up outside the memo, so repeated queries do not rebuild it. */
  private extra: FieldSpec | null = null;

  // Scratch, for the allocation-free lookups.
  private foundAst: AsteroidSpec | null = null;
  private readonly centre = { x: 0, y: 0, z: 0 };

  constructor(opts: BeltOptions) {
    this.world = opts.universe;
    this.worldState = opts.worldState;
  }

  /** The current system's belt, or null. */
  get belt(): BeltSpec | null {
    return this.spec;
  }

  update(_dt: number, _ctx: EngineContext): void {
    const sys = this.world.system ?? null;
    if (sys !== this.system) this.enter(sys);
    if (!this.spec || !this.system) return;

    const k = nearestFieldIndex(this.orbits, this.world.flight.worldPosition, this.world.orbitSeconds);
    if (this.nearest && this.nearest.index === k) return;
    this.rememo(k);
  }

  /** The field nearest the ship as of the last update, or null. */
  nearestField(): FieldSpec | null {
    return this.nearest;
  }

  /** World position of a field's centre now. False for an unknown id. */
  fieldWorld(id: string, out: MutableVec3Like): boolean {
    const f = this.fieldById(id);
    if (!f) return false;
    orbitalPosition(f.orbit, this.world.orbitSeconds, out);
    return true;
  }

  /** World velocity of a field's centre now (star frame, km/s). False for an unknown id. */
  fieldVelocity(id: string, out: MutableVec3Like): boolean {
    const f = this.fieldById(id);
    if (!f) return false;
    orbitalVelocity(f.orbit, this.world.orbitSeconds, this.spec!.starMu, out);
    return true;
  }

  /** World position of an asteroid now. False for an unknown id. */
  asteroidWorld(id: string, out: MutableVec3Like): boolean {
    const f = this.fieldOfAsteroid(id);
    if (!f) return false;
    const a = this.foundAst!;
    orbitalPosition(f.orbit, this.world.orbitSeconds, out);
    out.x += a.offsetKm[0];
    out.y += a.offsetKm[1];
    out.z += a.offsetKm[2];
    return true;
  }

  /** World velocity of an asteroid now (star frame, km/s). False for an unknown id. */
  asteroidVelocity(id: string, out: MutableVec3Like): boolean {
    const f = this.fieldOfAsteroid(id);
    if (!f) return false;
    orbitalVelocity(f.orbit, this.world.orbitSeconds, this.spec!.starMu, out);
    return true;
  }

  /**
   * Ids of the asteroids within `maxKm` of `world` (centre distance), searched
   * over the memoised fields. `out` is cleared and filled; returns its length.
   */
  asteroidsNear(world: Vec3Like, maxKm: number, out: string[]): number {
    out.length = 0;
    if (!this.spec) return 0;
    const t = this.world.orbitSeconds;
    const c = this.centre;
    for (let s = 0; s < MEMO_SLOTS; s++) {
      const f = this.memo[s];
      if (!f) continue;
      orbitalPosition(f.orbit, t, c);
      const dx = c.x - world.x;
      const dy = c.y - world.y;
      const dz = c.z - world.z;
      const reach = maxKm + FIELD_RADIUS_KM;
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      for (let i = 0; i < f.asteroids.length; i++) {
        const a = f.asteroids[i]!;
        const ax = dx + a.offsetKm[0];
        const ay = dy + a.offsetKm[1];
        const az = dz + a.offsetKm[2];
        if (ax * ax + ay * ay + az * az <= maxKm * maxKm) out.push(a.id);
      }
    }
    return out.length;
  }

  /**
   * Ids of the asteroids whose SURFACE is within `maxKm` of `world` (centre
   * distance − radius), over the memoised fields. `out` is cleared and
   * filled; returns its length. Allocation-free.
   */
  asteroidsNearSurface(world: Vec3Like, maxKm: number, out: string[]): number {
    out.length = 0;
    if (!this.spec) return 0;
    const t = this.world.orbitSeconds;
    const c = this.centre;
    const reach = maxKm + FIELD_RADIUS_KM + ASTEROID_RADIUS_KM[1];
    for (let s = 0; s < MEMO_SLOTS; s++) {
      const f = this.memo[s];
      if (!f) continue;
      orbitalPosition(f.orbit, t, c);
      const dx = c.x - world.x;
      const dy = c.y - world.y;
      const dz = c.z - world.z;
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      for (let i = 0; i < f.asteroids.length; i++) {
        const a = f.asteroids[i]!;
        const r = maxKm + a.radiusKm;
        const ax = dx + a.offsetKm[0];
        const ay = dy + a.offsetKm[1];
        const az = dz + a.offsetKm[2];
        if (ax * ax + ay * ay + az * az <= r * r) out.push(a.id);
      }
    }
    return out.length;
  }

  /**
   * The rock to target on arriving at field `fieldId` (owner's usable-belt
   * ruling): the one nearest `world` by surface distance with at least
   * `iceKg` ice left, else the nearest rock; null for an unknown or empty field.
   */
  firstRockTarget(fieldId: string, world: Vec3Like, iceKg = 1_000): string | null {
    const f = this.fieldById(fieldId);
    if (!f) return null;
    const c = this.centre;
    orbitalPosition(f.orbit, this.world.orbitSeconds, c);
    let icy: string | null = null;
    let icyD = Number.POSITIVE_INFINITY;
    let any: string | null = null;
    let anyD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < f.asteroids.length; i++) {
      const a = f.asteroids[i]!;
      const d =
        Math.hypot(c.x + a.offsetKm[0] - world.x, c.y + a.offsetKm[1] - world.y, c.z + a.offsetKm[2] - world.z) -
        a.radiusKm;
      if (d < anyD) {
        anyD = d;
        any = a.id;
      }
      if (d < icyD && Math.max(0, a.composition.ice - this.worldState.depleted(a.id).ice) >= iceKg) {
        icyD = d;
        icy = a.id;
      }
    }
    return icy ?? any;
  }

  /** The generated spec of an asteroid, or null. */
  asteroidSpec(id: string): AsteroidSpec | null {
    return this.fieldOfAsteroid(id) ? this.foundAst : null;
  }

  /** Kilograms of `r` still in the asteroid: generated minus mined, never negative. */
  remainingKg(id: string, r: Resource): number {
    const a = this.asteroidSpec(id);
    if (!a) return 0;
    return Math.max(0, a.composition[r] - this.worldState.depleted(id)[r]);
  }

  // -------------------------------------------------------------------------

  private enter(sys: StarSystemSpec | null): void {
    this.system = sys;
    this.spec = sys ? beltFor(sys) : null;
    this.orbits = this.spec && sys ? fieldOrbits(this.spec, sys.seed) : [];
    this.astPrefix = this.spec ? `ast:${this.spec.systemId}:` : '';
    this.fieldPrefix = this.spec ? `field:${this.spec.systemId}:` : '';
    this.memo.fill(null);
    this.nearest = null;
    this.extra = null;
    this.foundAst = null;
  }

  /** Rebuild the memo around field k, reusing any FieldSpec already built. */
  private rememo(k: number): void {
    const n = this.spec!.fieldCount;
    const seed = this.system!.seed;
    const old = this.memo.slice(); // allocates: only when the nearest field changes
    for (let s = 0; s < MEMO_SLOTS; s++) {
      const idx = (((k + s - MEMO_SPAN) % n) + n) % n;
      let f: FieldSpec | null = null;
      for (const o of old) if (o && o.index === idx) f = o;
      if (!f && this.extra && this.extra.index === idx) f = this.extra;
      this.memo[s] = f ?? fieldSpec(this.spec!, seed, idx);
    }
    this.nearest = this.memo[MEMO_SPAN]!;
  }

  private fieldById(id: string): FieldSpec | null {
    if (!this.spec || !id.startsWith(this.fieldPrefix)) return null;
    for (let s = 0; s < MEMO_SLOTS; s++) {
      const f = this.memo[s];
      if (f && f.id === id) return f;
    }
    if (this.extra && this.extra.id === id) return this.extra;
    const k = parseIndex(id.slice(this.fieldPrefix.length));
    if (k < 0 || k >= this.spec.fieldCount) return null;
    return this.loadExtra(k);
  }

  /** The asteroid's field, with `foundAst` set to the asteroid; null if unknown. */
  private fieldOfAsteroid(id: string): FieldSpec | null {
    this.foundAst = null;
    if (!this.spec || !id.startsWith(this.astPrefix)) return null;
    for (let s = 0; s <= MEMO_SLOTS; s++) {
      const f = s < MEMO_SLOTS ? this.memo[s] : this.extra;
      if (!f) continue;
      for (let i = 0; i < f.asteroids.length; i++) {
        if (f.asteroids[i]!.id === id) {
          this.foundAst = f.asteroids[i]!;
          return f;
        }
      }
    }
    // Not near the ship: resolve from the id alone. Allocates; rare.
    const rest = id.slice(this.astPrefix.length);
    const colon = rest.indexOf(':');
    if (colon < 0) return null;
    const k = parseIndex(rest.slice(0, colon));
    const n = parseIndex(rest.slice(colon + 1));
    if (k < 0 || k >= this.spec.fieldCount || n < 0) return null;
    const f = this.loadExtra(k);
    const a = f.asteroids[n];
    if (!a) return null;
    this.foundAst = a;
    return f;
  }

  private loadExtra(k: number): FieldSpec {
    if (!this.extra || this.extra.index !== k) this.extra = fieldSpec(this.spec!, this.system!.seed, k);
    return this.extra;
  }
}

/** A non-negative decimal integer, or -1. */
function parseIndex(s: string): number {
  return /^\d+$/.test(s) ? Number(s) : -1;
}
