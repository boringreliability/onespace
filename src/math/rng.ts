/**
 * Deterministic pseudo-random number generation.
 *
 * Every procedural feature in oneSpace derives from a single 32-bit universe
 * seed. Given the same seed the universe is bit-for-bit identical across
 * machines, sessions and reloads — that is what makes an infinite universe
 * *persistent* without storing anything.
 *
 * The rule: never call Math.random() anywhere in generation code. Derive a
 * child seed with `hashSeed(parent, salt)` and open a fresh `Rng` on it.
 */

/** FNV-1a style integer hash. Fast, well-distributed, no dependencies. */
export function hashSeed(seed: number, salt: string | number): number {
  let h = seed >>> 0;
  const s = typeof salt === 'number' ? String(salt) : salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Final avalanche (splitmix32 finaliser) so adjacent salts diverge widely.
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

/** Hash three integers into one — used for spatial/grid seeds. */
export function hash3(x: number, y: number, z: number, seed = 0): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d) >>> 0;
  h = Math.imul(h ^ (y | 0), 0x165667b1) >>> 0;
  h = Math.imul(h ^ (z | 0), 0x9e3779b1) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * splitmix32 — a small, fast, statistically solid generator.
 * Period 2^32, which is ample for per-object generation.
 */
export class Rng {
  private s: number;

  constructor(seed: number | string) {
    this.s = typeof seed === 'string' ? hashSeed(0x9e3779b9, seed) : seed >>> 0;
    if (this.s === 0) this.s = 0x6d2b79f5;
  }

  /** Raw 32-bit unsigned integer. */
  nextUint(): number {
    this.s = (this.s + 0x9e3779b9) >>> 0;
    let z = this.s;
    z ^= z >>> 16;
    z = Math.imul(z, 0x21f0aaad) >>> 0;
    z ^= z >>> 15;
    z = Math.imul(z, 0x735a2d97) >>> 0;
    z ^= z >>> 15;
    return z >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint() / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Standard normal via Box–Muller (cached pair). */
  private spare: number | null = null;
  gaussian(mean = 0, stdev = 1): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return mean + stdev * v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * mul;
    return mean + stdev * (u * mul);
  }

  /**
   * Power-law sample in [min, max] with exponent `alpha`.
   * Stellar masses, planet radii and crater sizes all follow power laws in
   * nature; using one here is what stops generated systems feeling uniform.
   */
  power(min: number, max: number, alpha: number): number {
    const u = this.next();
    const a1 = alpha + 1;
    return Math.pow(u * (Math.pow(max, a1) - Math.pow(min, a1)) + Math.pow(min, a1), 1 / a1);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }

  /** Weighted pick. `weights` need not be normalised. */
  weighted<T>(arr: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i]!;
      if (r <= 0) return arr[i]!;
    }
    return arr[arr.length - 1]!;
  }

  /** Fisher–Yates, in place. Returns the same array for chaining. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = t;
    }
    return arr;
  }

  /** A uniformly distributed point on the unit sphere. */
  onSphere(): [number, number, number] {
    const z = this.range(-1, 1);
    const t = this.range(0, Math.PI * 2);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return [r * Math.cos(t), r * Math.sin(t), z];
  }

  /** Fork a child generator — keeps sibling streams independent. */
  fork(salt: string | number): Rng {
    return new Rng(hashSeed(this.nextUint(), salt));
  }
}

/** Convenience: build an Rng from a parent seed plus a salt. */
export function rngFrom(seed: number, salt: string | number): Rng {
  return new Rng(hashSeed(seed, salt));
}
