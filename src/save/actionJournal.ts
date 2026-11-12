/**
 * The action log (v4 sub-plan 3, P3 / D13) — append-only, both clocks (P5).
 *
 * Sources:
 *  - `propellant:action` — every one, refused too (the payload carries `ok`);
 *  - `cargo:action` — only `result.ok`;
 *  - `emergency:used`;
 *  - a mine, through `noteMined`, which `WorldState.recordMined` calls via its
 *    `onMined` hook. Mining announces `cargo:action` BEFORE it records the
 *    mine; a hook (not the bus) is what makes both halves arrive together;
 *  - unannounced thrust, as one aggregated `thrust` entry per save.
 *
 * The books (R7): over an interval the tank obeys
 *     after = before + Σ propellant tankDeltaKg + Σ cargo fuelKg − thrust,
 * so thrust = (before − after) + Σ tankDeltaKg + Σ fuelKg, never negative.
 * `settleThrust` books it and starts the next interval at the tank as it is.
 *
 * `drain()` hands over what was noted since the last drain (a save appends it
 * to the previous save's log). `seq` rises strictly and never repeats, even
 * after `restore`. Past MAX_ACTIONS the oldest fold into one checkpoint.
 */

import { bus } from '@/core/EventBus';
import type { MinedEntry } from '@/game/worldState';
import type { Resource } from '@/gen/belt';
import type { ActionEntry } from './schema';

export const MAX_ACTIONS = 5_000;

/** Below this a thrust remainder is float dust, not a burn, kg. */
const THRUST_EPS_KG = 1e-9;

export interface JournalClock {
  wallMs(): number;
  orbitSeconds(): number;
}

type Payload<S extends ActionEntry['source']> = Extract<ActionEntry, { source: S }>['payload'];
type Checkpoint = Payload<'checkpoint'>;

const RESOURCES: readonly Resource[] = ['ice', 'metal', 'silicate', 'rare'];

function perResource(): Record<Resource, number> {
  return { ice: 0, metal: 0, silicate: 0, rare: 0 };
}

export class ActionJournal {
  private pending: ActionEntry[] = [];
  private lastSeq = 0;
  /** Tank mass at the start of the books' interval; null until known. */
  private baselineKg: number | null = null;
  /** Σ tankDeltaKg + Σ fuelKg since the interval began. */
  private namedDeltaKg = 0;
  private offs: Array<() => void> = [];

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
        this.push('emergency', e.timesUsed === undefined ? { kind: e.kind } : { kind: e.kind, timesUsed: e.timesUsed });
      }),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** A mine as WorldState recorded it; the entry keeps the mine's own clocks. */
  noteMined(m: MinedEntry): void {
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
   * `tankAfter` while named actions took `namedKg` (net). Never negative.
   */
  noteThrust(tankBefore: number, tankAfter: number, namedKg: number): void {
    const kg = tankBefore - tankAfter - namedKg;
    if (!Number.isFinite(kg) || !(kg > THRUST_EPS_KG)) return;
    this.push('thrust', { kg });
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

  /** Everything noted since the last drain, oldest first. */
  drain(): ActionEntry[] {
    const out = this.pending;
    this.pending = [];
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
    this.namedDeltaKg = 0;
  }

  /** Keep at most MAX_ACTIONS pending; the oldest fold into one checkpoint. */
  compact(): void {
    this.pending = compactEntries(this.pending, MAX_ACTIONS);
  }

  private push<S extends Exclude<ActionEntry['source'], 'mined' | 'checkpoint'>>(source: S, payload: Payload<S>): void {
    this.pending.push({
      seq: ++this.lastSeq,
      source,
      payload,
      wallMs: this.clock.wallMs(),
      orbitSeconds: this.clock.orbitSeconds(),
    } as ActionEntry);
  }
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
 * At most `max` entries: the oldest fold into ONE checkpoint at the front
 * (an existing leading checkpoint folds in too). The checkpoint takes the seq
 * and clocks of the last entry it absorbed, so seqs stay unique and rising.
 */
export function compactEntries(entries: readonly ActionEntry[], max: number = MAX_ACTIONS): ActionEntry[] {
  if (entries.length <= max) return [...entries];
  const fold = entries.length - max + 1;
  const old = entries.slice(0, fold);
  const last = old[old.length - 1]!;
  const cp: Checkpoint = {
    upToSeq: maxSeq(old),
    propellantKg: 0,
    cargoKg: perResource(),
    minedKg: perResource(),
    emergency: { cannibalize: 0, cannibalizeCargo: 0, beacon: 0 },
  };
  for (const e of old) addTo(cp, e);
  return [
    { seq: cp.upToSeq, source: 'checkpoint', payload: cp, wallMs: last.wallMs, orbitSeconds: last.orbitSeconds },
    ...entries.slice(fold),
  ];
}

/**
 * Fold one entry into a checkpoint's sums. Propellant is every kg that left
 * the tank: named spends (refunds put kg back and are not spends) plus thrust.
 */
function addTo(cp: Checkpoint, e: ActionEntry): void {
  switch (e.source) {
    case 'propellant': {
      const k = e.payload.action.kind;
      if (k !== 'jump-refund' && k !== 'spool-refund') cp.propellantKg += e.payload.kg;
      break;
    }
    case 'thrust':
      cp.propellantKg += e.payload.kg;
      break;
    case 'cargo':
      if (e.payload.action.kind === 'mine') cp.cargoKg[e.payload.action.resource] += e.payload.result.kgIn;
      break;
    case 'mined':
      cp.minedKg[e.payload.resource] += e.payload.kg;
      break;
    case 'emergency':
      if (e.payload.kind === 'cannibalize') cp.emergency.cannibalize++;
      else if (e.payload.kind === 'cannibalize-cargo') cp.emergency.cannibalizeCargo++;
      else cp.emergency.beacon++;
      break;
    case 'checkpoint':
      cp.propellantKg += e.payload.propellantKg;
      for (const r of RESOURCES) {
        cp.cargoKg[r] += e.payload.cargoKg[r];
        cp.minedKg[r] += e.payload.minedKg[r];
      }
      cp.emergency.cannibalize += e.payload.emergency.cannibalize;
      cp.emergency.cannibalizeCargo += e.payload.emergency.cannibalizeCargo;
      cp.emergency.beacon += e.payload.emergency.beacon;
      break;
  }
}
