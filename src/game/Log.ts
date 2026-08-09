/**
 * The ship's log.
 *
 * ARCHITECTURE.md says the loop is "travel, look, scan, log". The first three
 * existed; this is the fourth. Without it a scan is ten lines that fade after
 * twelve seconds, and everything you find stops existing the moment you fly on.
 *
 * In a universe derived entirely from one seed, the log is the ONLY thing that
 * needs saving. Every star, world and hull can be regenerated on demand — what
 * cannot be regenerated is which of them you went to, and in what order. So
 * this file stores references and impressions, never generated data: an entry
 * is an id, a timestamp and the sentence the game wrote about it, not a copy of
 * the planet.
 */

import type { GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';

/** Bumped when the stored shape changes in a way old saves cannot satisfy. */
const LOG_VERSION = 1;
const STORAGE_KEY = 'onespace.log.v1';

/** Entries beyond this are dropped oldest-first. A log is not an archive. */
const MAX_ENTRIES = 500;

export type LogKind = 'arrival' | 'world' | 'landing' | 'contact' | 'note';

export interface LogEntry {
  /** Stable identity of the subject. A second visit updates rather than repeats. */
  readonly key: string;
  readonly kind: LogKind;
  /** Seconds of mission time when it was first recorded. */
  readonly at: number;
  /** Where it happened, for grouping. */
  readonly system: string;
  readonly title: string;
  /** The game's own prose. One or two sentences, already written. */
  readonly body: readonly string[];
  /** How many times this subject has been revisited, first visit included. */
  visits: number;
}

export interface LogSummary {
  readonly systems: number;
  readonly worlds: number;
  readonly landings: number;
  readonly contacts: number;
  readonly entries: number;
}

/**
 * Mission time, in seconds, shown as a stardate-ish stamp.
 *
 * Deliberately not a wall clock: the universe has no calendar, and a real date
 * would date the *player's* session rather than the voyage.
 */
function stamp(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${String(d).padStart(3, '0')}·${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;
}

export class ShipLog implements GameModule {
  readonly name = 'log';

  private entries: LogEntry[] = [];
  private index = new Map<string, LogEntry>();
  private time = 0;
  private currentSystem = '—';
  private disposers: Array<() => void> = [];

  constructor() {
    this.load();
  }

  /** Subscribe to the events that already exist. Nothing new is emitted. */
  init(): void {
    this.disposers.push(
      bus.on('system:entered', ({ system }) => {
        this.currentSystem = system.name;
        this.record({
          key: `sys:${system.id}`,
          kind: 'arrival',
          system: system.name,
          title: system.name,
          body: [
            // The spectral class keeps its capital: M is a designation, not a
            // word. The blurb is prose and joins the rest of the log's lower
            // case register.
            `${system.stars.length > 1 ? `${system.stars.length} stars` : system.stars[0]?.spectralClass ?? '—'} · ${system.planets.length} worlds`,
            system.blurb.toLowerCase(),
          ],
        });
      }),

      bus.on('scan:complete', (scan) => {
        // `kind` is optional on ScanResult because the showroom fixtures predate
        // the log. Absent means a world, which is what the field defaults to.
        this.record({
          key: `scan:${scan.targetId}`,
          kind: scan.kind === 'vessel' ? 'contact' : 'world',
          system: this.currentSystem,
          title: scan.name,
          body: scan.lines,
        });
      }),

      bus.on('planet:landed', ({ planet }) => {
        this.record({
          key: `land:${planet.id}`,
          kind: 'landing',
          system: this.currentSystem,
          title: `${planet.name} — surface`,
          // Lower case, like every other line in the log. The scanner rows are
          // lower case by construction, and a single sentence-cased paragraph
          // in the middle of them reads as a rendering fault rather than as
          // prose.
          body: [
            `${planet.type} · ${planet.gravity.toFixed(2)} m/s²`,
            planet.blurb.toLowerCase(),
          ],
        });
      }),
    );
  }

  /** Advance mission time. Cheap enough to run unconditionally every frame. */
  update(dt: number): void {
    this.time += dt;
  }

  /**
   * Add or update an entry.
   *
   * A second visit bumps the count rather than appending: the log is a record
   * of what you have found, and finding the same world twice is one discovery
   * with two dates, not two discoveries.
   */
  record(e: Omit<LogEntry, 'at' | 'visits'>): void {
    const existing = this.index.get(e.key);
    if (existing) {
      existing.visits++;
      this.save();
      return;
    }
    const entry: LogEntry = { ...e, at: this.time, visits: 1 };
    this.entries.push(entry);
    this.index.set(entry.key, entry);
    if (this.entries.length > MAX_ENTRIES) {
      const dropped = this.entries.shift();
      if (dropped) this.index.delete(dropped.key);
    }
    // Loading from storage does not come through here — it assigns the array
    // directly — so this announcement only ever fires for something new.
    bus.emit('log', { text: `LOGGED — ${entry.title.toUpperCase()}`, tone: 'good' });
    this.save();
  }

  /** Newest first, which is the order a log is read in. */
  all(): readonly LogEntry[] {
    return [...this.entries].reverse();
  }

  byKind(kind: LogKind): readonly LogEntry[] {
    return this.all().filter((e) => e.kind === kind);
  }

  summary(): LogSummary {
    let systems = 0;
    let worlds = 0;
    let landings = 0;
    let contacts = 0;
    for (const e of this.entries) {
      if (e.kind === 'arrival') systems++;
      else if (e.kind === 'world') worlds++;
      else if (e.kind === 'landing') landings++;
      else if (e.kind === 'contact') contacts++;
    }
    return { systems, worlds, landings, contacts, entries: this.entries.length };
  }

  stampOf(entry: LogEntry): string {
    return stamp(entry.at);
  }

  clear(): void {
    this.entries = [];
    this.index.clear();
    this.save();
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private save(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: LOG_VERSION, time: this.time, entries: this.entries }),
      );
    } catch {
      // A full or disabled storage must never break the frame loop. The log is
      // a convenience; the universe regenerates without it.
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as { version?: number; time?: number; entries?: LogEntry[] };
      if (data.version !== LOG_VERSION || !Array.isArray(data.entries)) return;
      this.time = typeof data.time === 'number' ? data.time : 0;
      this.entries = data.entries;
      for (const e of this.entries) this.index.set(e.key, e);
    } catch {
      // Corrupt storage is not worth a crash on boot; start a fresh log.
      this.entries = [];
      this.index.clear();
    }
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}
