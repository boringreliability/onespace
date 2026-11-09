/**
 * World state (v4 sub-plan 2, P2) — what the player has taken out of the
 * generated universe.
 *
 * Every star, field and asteroid regenerates from the seed; a mined-out rock
 * does not. This is the in-memory record of depletion, keyed by asteroid id.
 * Each mine is also kept as an entry naming who mined (P2: 'local' until
 * there is more than one player) and BOTH clocks (P5): the orbit clock the
 * world moves on, and wall time. Persistence is sub-plan 3's.
 */

import type { Resource } from '@/gen/belt';

export type PlayerId = 'local';

export interface MinedEntry {
  readonly id: string;
  readonly by: PlayerId;
  readonly resource: Resource;
  readonly kg: number;
  /** Orbit clock (Universe.orbitSeconds) when mined. */
  readonly orbitSeconds: number;
  /** Wall clock, ms since the epoch, when mined. */
  readonly wallMs: number;
}

export interface WorldStateClocks {
  readonly orbitSeconds: () => number;
  readonly wallMs: () => number;
}

/** Shared answer for anything never mined. Frozen: callers cannot write it. */
const NONE: Readonly<Record<Resource, number>> = Object.freeze({ ice: 0, metal: 0, silicate: 0, rare: 0 });

export class WorldState {
  private readonly clocks: WorldStateClocks;
  private readonly mined = new Map<string, Record<Resource, number>>();
  private readonly log: MinedEntry[] = [];

  constructor(clocks: WorldStateClocks) {
    this.clocks = clocks;
  }

  /** Kilograms taken from `id`, per resource. Zero for an untouched id. Allocation-free. */
  depleted(id: string): Readonly<Record<Resource, number>> {
    return this.mined.get(id) ?? NONE;
  }

  /** Record `kg` of `r` taken from `id`. Non-finite or negative kg is ignored. */
  recordMined(id: string, r: Resource, kg: number, by: PlayerId): void {
    if (!Number.isFinite(kg) || kg < 0) return;
    let d = this.mined.get(id);
    if (!d) {
      d = { ice: 0, metal: 0, silicate: 0, rare: 0 };
      this.mined.set(id, d);
    }
    d[r] += kg;
    this.log.push({ id, by, resource: r, kg, orbitSeconds: this.clocks.orbitSeconds(), wallMs: this.clocks.wallMs() });
  }

  /** Every mine, oldest first. */
  entries(): readonly MinedEntry[] {
    return this.log;
  }
}
