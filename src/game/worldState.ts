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
  /**
   * [v4-save] Told of every mine as it is recorded (the action journal).
   * Mining announces `cargo:action` before it records the mine, so a journal
   * listening to the bus alone would hold half a mine. `restore` never calls it.
   */
  readonly onMined?: (e: MinedEntry) => void;
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
    const e: MinedEntry = { id, by, resource: r, kg, orbitSeconds: this.clocks.orbitSeconds(), wallMs: this.clocks.wallMs() };
    this.log.push(e);
    this.clocks.onMined?.({ ...e });
  }

  /** Every mine, oldest first. A copy: callers cannot write the world through it. */
  entries(): readonly MinedEntry[] {
    return [...this.log];
  }

  /**
   * [v4-save] Replace the world with saved entries. The map and the log are
   * rebuilt from them as they are — each keeps its own clocks; nothing is
   * stamped now. Non-finite or negative kg is skipped, as recordMined does.
   */
  restore(entries: readonly MinedEntry[]): void {
    this.mined.clear();
    this.log.length = 0;
    for (const e of entries) {
      if (!Number.isFinite(e.kg) || e.kg < 0) continue;
      let d = this.mined.get(e.id);
      if (!d) {
        d = { ice: 0, metal: 0, silicate: 0, rare: 0 };
        this.mined.set(e.id, d);
      }
      d[e.resource] += e.kg;
      this.log.push({ ...e });
    }
  }
}
