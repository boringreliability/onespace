/**
 * The action log (v4 sub-plan 3, P3 / D13) — append-only, both clocks (P5).
 *
 * Sources:
 *  - `propellant:action` — every one, refused too (the payload carries `ok`);
 *  - `cargo:action` — only `result.ok`;
 *  - an emergency exit: `noteEmergency` on the paying code path (R13: the one
 *    source in the game; the `emergency:used` that follows is not logged
 *    twice). An `emergency:used` nobody noted is still logged from the bus;
 *  - a mine, through `noteMined`, which `WorldState.recordMined` calls via its
 *    `onMined` hook. Mining announces `cargo:action` BEFORE it records the
 *    mine; a hook (not the bus) is what makes both halves arrive together;
 *  - unannounced thrust, as one aggregated `thrust` entry per save.
 *
 * The books (R7): over an interval the tank obeys
 *     after = before + Σ propellant tankDeltaKg + Σ cargo fuelKg − thrust,
 * so thrust = (before − after) + Σ tankDeltaKg + Σ fuelKg. A negative
 * remainder — the tank rose with nothing to say why — is never logged as
 * thrust; it is counted on `unexplainedGainKg` (M-2).
 *
 * `drain()` hands over what was noted since the last drain (a save appends it
 * to the previous save's log). `seq` rises strictly and never repeats, even
 * after `restore`. Past MAX_ACTIONS the oldest fold into one checkpoint that
 * carries their NET effect (R8), so `replay` of the compacted log recomputes
 * the same ship as the full one.
 */

import { bus, type GameEvents } from '@/core/EventBus';
import type { MinedEntry } from '@/game/worldState';
import { applyEntry, zeroState } from './replay';
import type { ActionEntry } from './schema';

export const MAX_ACTIONS = 5_000;

/** Below this a books remainder is float dust, not a burn or a gain, kg. */
const BOOKS_EPS_KG = 1e-9;

export interface JournalClock {
  wallMs(): number;
  orbitSeconds(): number;
}

type Payload<S extends ActionEntry['source']> = Extract<ActionEntry, { source: S }>['payload'];

export class ActionJournal {
  private pending: ActionEntry[] = [];
  private lastSeq = 0;
  /** Tank mass at the start of the books' interval; null until known. */
  private baselineKg: number | null = null;
  /** Σ tankDeltaKg + Σ fuelKg since the interval began. */
  private namedDeltaKg = 0;
  private offs: Array<() => void> = [];
  private disposed = false;
  private _unexplainedGainKg = 0;
  /** Emergencies noted by `noteEmergency` whose `emergency:used` has not arrived yet. */
  private claims: Array<{ kind: EmergencyUse['kind']; timesUsed: number | undefined }> = [];

  constructor(private readonly clock: JournalClock) {
    this.offs.push(
      bus.on('propellant:action', (e) => {
        if (Number.isFinite(e.tankDeltaKg)) this.namedDeltaKg += e.tankDeltaKg;
        this.push('propellant', { action: e.action, ok: e.ok, kg: e.kg, tankDeltaKg: e.tankDeltaKg });
      }),
      bus.on('cargo:action', (e) => {
        if (!e.result.ok) return;
        if (Number.isFinite(e.result.fuelKg)) this.namedDeltaKg += e.result.fuelKg;
        this.push('cargo', { action: e.action, result: e.result });
      }),
      bus.on('emergency:used', (e) => {
        // R13: the paying code path noted it already (noteEmergency) — one entry, one seq.
        const i = this.claims.findIndex((c) => c.kind === e.kind && c.timesUsed === e.timesUsed);
        if (i >= 0) {
          this.claims.splice(i, 1);
          return;
        }
        this.push('emergency', emergencyPayload(e));
      }),
    );
  }

  /** Off the bus, and deaf to the WorldState hook (M-3). */
  dispose(): void {
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** kg the tank rose by with no named action to explain it, since the journal started (M-2). */
  get unexplainedGainKg(): number {
    return this._unexplainedGainKg;
  }

  /**
   * [v4-save] R2/R13: an emergency exit, noted SYNCHRONOUSLY on the paying
   * code path (SaveGame's `critical` hook), so the same entry — same seq — can
   * go to the WAL before the effect shows. The `emergency:used` that follows
   * is then not logged a second time. Null once disposed.
   */
  noteEmergency(used: EmergencyUse): ActionEntry | null {
    if (this.disposed) return null;
    const entry = this.push('emergency', emergencyPayload(used));
    this.claims.push({ kind: used.kind, timesUsed: used.timesUsed });
    return entry;
  }

  /** A mine as WorldState recorded it; the entry keeps the mine's own clocks. */
  noteMined(m: MinedEntry): void {
    if (this.disposed) return;
    this.pending.push({
      seq: ++this.lastSeq,
      source: 'mined',
      payload: { id: m.id, by: m.by, resource: m.resource, kg: m.kg },
      wallMs: m.wallMs,
      orbitSeconds: m.orbitSeconds,
    });
  }

  /**
   * Book the unannounced burn of an interval: the tank went `tankBefore` →
   * `tankAfter` while named actions took `namedKg` (net). A negative remainder
   * is an unexplained gain: counted, never logged as thrust.
   */
  noteThrust(tankBefore: number, tankAfter: number, namedKg: number): void {
    const kg = tankBefore - tankAfter - namedKg;
    if (!Number.isFinite(kg)) return;
    if (kg > BOOKS_EPS_KG) this.push('thrust', { kg });
    else if (kg < -BOOKS_EPS_KG) this._unexplainedGainKg -= kg;
  }

  /** Where the books' interval starts. A save or a load sets it; null = unknown. */
  setBaseline(tankKg: number | null): void {
    this.baselineKg = tankKg !== null && Number.isFinite(tankKg) ? tankKg : null;
    this.namedDeltaKg = 0;
  }

  /**
   * Close the books' interval at `tankKg` (null: no tank — nothing to book).
   * `openingKg` stands in for an unknown baseline: the tank a new game opens with.
   */
  settleThrust(tankKg: number | null, openingKg: number): void {
    if (tankKg === null || !Number.isFinite(tankKg)) {
      this.setBaseline(null);
      return;
    }
    const before = this.baselineKg ?? openingKg;
    this.noteThrust(before, tankKg, -this.namedDeltaKg);
    this.setBaseline(tankKg);
  }

  /**
   * [v4-save] R16: what is noted and not yet drained, oldest first, without
   * draining it — the critical hook copies the paid entries to the WAL.
   */
  peek(): readonly ActionEntry[] {
    return this.pending.slice();
  }

  /** Everything noted since the last drain, oldest first. */
  drain(): ActionEntry[] {
    const out = this.pending;
    this.pending = [];
    // R14 M1: a claim lives at most until the next save; one whose emit never
    // came must not swallow a later, unrelated emergency:used.
    this.claims = [];
    return out;
  }

  /**
   * A saved log is the past: seq continues above everything in it, and what
   * was pending (another timeline) is dropped. The entries themselves stay in
   * the save; the next save appends to them.
   */
  restore(entries: readonly ActionEntry[]): void {
    this.lastSeq = Math.max(this.lastSeq, maxSeq(entries));
    this.pending = [];
    this.claims = [];
    this.namedDeltaKg = 0;
  }

  /** Keep at most MAX_ACTIONS pending; the oldest fold into one checkpoint. */
  compact(): void {
    this.pending = compactEntries(this.pending, MAX_ACTIONS);
  }

  private push<S extends Exclude<ActionEntry['source'], 'mined' | 'checkpoint'>>(
    source: S,
    payload: Payload<S>,
  ): ActionEntry | null {
    if (this.disposed) return null;
    const entry = {
      seq: ++this.lastSeq,
      source,
      payload,
      wallMs: this.clock.wallMs(),
      orbitSeconds: this.clock.orbitSeconds(),
    } as ActionEntry;
    this.pending.push(entry);
    return entry;
  }
}

type EmergencyUse = GameEvents['emergency:used'];

function emergencyPayload(e: EmergencyUse): Payload<'emergency'> {
  return e.timesUsed === undefined ? { kind: e.kind } : { kind: e.kind, timesUsed: e.timesUsed };
}

function maxSeq(entries: readonly ActionEntry[]): number {
  let m = 0;
  for (const e of entries) {
    m = Math.max(m, e.seq);
    if (e.source === 'checkpoint') m = Math.max(m, e.payload.upToSeq);
  }
  return m;
}

/**
 * At most `max` entries: the oldest fold into ONE checkpoint at the front (an
 * existing leading checkpoint folds in too). The checkpoint holds the NET
 * effect of what it absorbed — the prefix replayed from nothing — so replay
 * of the result equals replay of the input. (A jettison inside the prefix is
 * netted against the hold the prefix itself filled: the log starts at a new
 * game, with an empty hold.) It takes the seq and clocks of the last entry it
 * absorbed, so seqs stay unique and rising.
 */
export function compactEntries(entries: readonly ActionEntry[], max: number = MAX_ACTIONS): ActionEntry[] {
  const keep = Math.max(1, Math.floor(max));
  if (entries.length <= keep) return [...entries];
  const fold = entries.length - keep + 1;
  const old = entries.slice(0, fold);
  const last = old[old.length - 1]!;

  const net = zeroState();
  let lastCannibalizeTimesUsed = 0;
  for (const e of old) {
    applyEntry(net, e);
    if (e.source === 'checkpoint') lastCannibalizeTimesUsed = e.payload.lastCannibalizeTimesUsed;
    else if (e.source === 'emergency' && e.payload.kind === 'cannibalize' && e.payload.timesUsed !== undefined) {
      lastCannibalizeTimesUsed = e.payload.timesUsed;
    }
  }

  const upToSeq = maxSeq(old);
  const checkpoint: ActionEntry = {
    seq: upToSeq,
    source: 'checkpoint',
    payload: {
      upToSeq,
      tankNetKg: net.tank.massKg,
      capacityLossNetFrac: net.tank.capacityLossFrac,
      cargoNetKg: net.cargo,
      minedByAsteroid: net.depletion,
      emergency: net.emergency,
      lastCannibalizeTimesUsed,
    },
    wallMs: last.wallMs,
    orbitSeconds: last.orbitSeconds,
  };
  return [checkpoint, ...entries.slice(fold)];
}
