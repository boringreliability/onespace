/**
 * The game's one writer (v4 sub-plan 3, Task 5; DESIGN §5.2).
 *
 * When:
 *  - autosave after a landing (`planet:landed`), a completed mine (the tick
 *    after `cargo:action`, so `recordMined` has run and both halves of the mine
 *    are in the journal), a system entry, the emergency exit, every
 *    AUTOSAVE_INTERVAL_S of piloting (counted from the last save), and a
 *    hidden tab;
 *  - a landing, mine or system entry inside AUTOSAVE_MIN_GAP_S of the last
 *    save is DEFERRED (R13): it saves once the gap has passed;
 *  - manually from the pause sheet (`saveNow('manual')`, logs SAVED).
 *
 * How (the order is the point):
 *    capture (buildSave) → wal.writeSnapshot → store.save (IndexedDB) → wal.clear(revision)
 *  - the built save is `prev` at once, whatever happens to the writes: buildSave
 *    drains the journal, so the next save appends to it and nothing is lost;
 *    revisions therefore rise strictly across every save, pagehide included;
 *  - a false from writeSnapshot is no cover: the store write goes on, and only
 *    a durable store write clears the WAL;
 *  - store writes are queued, so the store sees revisions in order.
 *
 * Emergency first (R2): Emergency and RecoveryCut call `critical(used)` on the
 * paying code path, before the exit is announced. The journal notes it (R13:
 * the one source of the entry — its `emergency:used` is not logged twice) and
 * the same entry, same seq, goes to the WAL synchronously.
 *
 * Closing: `visibilitychange → hidden` saves to IndexedDB; `pagehide` writes the
 * whole snapshot to the WAL synchronously (it may be the last thing that runs).
 *
 * One writing tab: without the writer lock SaveGame is inert — it logs
 * SAVING_DISABLED_TEXT once, never touches the journal, the WAL or the store.
 * Nothing is written without a tank (showroom hull) or over the title (its
 * opening world is not the pilot's game). The Yard keeps the tank, so it
 * saves (R14): leaving flight/map for the Yard or the title flushes a save
 * ('leave', always); hidden, pagehide and SAVE still write in the Yard. A
 * manual SAVE that cannot write says why; a WAL append that fails warns.
 *
 * The books: the journal's baseline is set to the tank at init and whenever
 * the tank is swapped.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import type { Mode } from '@/core/Modes';
import { bus, type GameEvents } from '@/core/EventBus';
import { modes } from '@/core/Modes';
import { buildSave, type SaveWorld } from '@/save/capture';
import type { SaveV1 } from '@/save/schema';
import type { SaveStore } from '@/save/store';
import type { Wal } from '@/save/wal';
import type { WriterLock } from '@/save/writerLock';
import { START_FILL, type Propellant } from '@/ship/propellant';
import { AUTOSAVE_INTERVAL_S, shouldAutosave, type SaveReason } from './saveTriggers';

export const SAVED_TEXT = 'SAVED';
export const SAVE_FAILED_TEXT = 'SAVE FAILED';
export const SAVING_DISABLED_TEXT = 'SAVING DISABLED — OPEN IN ANOTHER TAB';

export type SaveStatus = 'idle' | 'saving' | 'disabled';

/** Where the page's lifecycle events arrive: `document` and `window` in the game. */
export interface SavePage {
  readonly document: EventTarget & { readonly visibilityState: DocumentVisibilityState };
  readonly window: EventTarget;
}

export interface SaveGameOptions {
  readonly world: SaveWorld;
  readonly store: SaveStore;
  readonly wal: Wal;
  /** Resolved: this tab writes, or it is a reader. */
  readonly lock: WriterLock;
  /** Absent (node): no hidden/pagehide saves. */
  readonly page?: SavePage | null;
}

/** Triggers that wait for the gap, in the order they are tried. */
const GAPPED: readonly SaveReason[] = ['emergency', 'landed', 'mined', 'system'];

export class SaveGame implements GameModule {
  readonly name = 'save';

  private readonly world: SaveWorld;
  private readonly store: SaveStore;
  private readonly wal: Wal;
  private readonly lock: WriterLock;
  private readonly page: SavePage | null;

  /** The last save built — durable or not; the next one continues it. */
  private prev: SaveV1 | null = null;
  /** NEW GAME (Task 6): a first save goes above this revision, so it outranks the old game. */
  private revisionFloor = 0;
  /** R16: the highest seq already copied to the WAL by `critical`. */
  private walSeq = 0;
  /** Seconds since the last save (the gap); +Infinity before the first. */
  private sinceSaveS = Number.POSITIVE_INFINITY;
  /** Seconds since init or the last save (the interval). */
  private sinceIntervalS = 0;
  /** Triggers seen and not yet saved (deferred by the gap). */
  private readonly wanted = new Set<SaveReason>();
  private inFlight = 0;
  /** The store's queue: writes land in revision order. */
  private queue: Promise<unknown> = Promise.resolve();
  private tank: Propellant | null = null;
  private offs: Array<() => void> = [];
  private disposed = false;

  constructor(opts: SaveGameOptions) {
    this.world = opts.world;
    this.store = opts.store;
    this.wal = opts.wal;
    this.lock = opts.lock;
    this.page = opts.page ?? null;
  }

  get status(): SaveStatus {
    if (!this.lock.writer) return 'disabled';
    return this.inFlight > 0 ? 'saving' : 'idle';
  }

  /**
   * Task 6: the save the game was loaded from (or null for a new game). The
   * next save continues it — same saveId, revision + 1, its log as prefix.
   */
  continueFrom(save: SaveV1 | null): void {
    this.prev = save;
    this.revisionFloor = 0;
    this.sinceSaveS = save ? 0 : Number.POSITIVE_INFINITY;
    this.sinceIntervalS = 0;
    this.wanted.clear();
  }

  /**
   * Task 6: NEW GAME over a save. The next save starts a new game — a fresh
   * saveId, no log from before — at revision `afterRevision + 1`, so it
   * outranks the old game (kept as `previous` by the store).
   */
  startNew(afterRevision: number): void {
    this.continueFrom(null);
    this.revisionFloor = Number.isInteger(afterRevision) && afterRevision > 0 ? afterRevision : 0;
  }

  /** The revision of the last save built (the floor before any). */
  get revision(): number {
    return this.prev?.revision ?? this.revisionFloor;
  }

  init(): void {
    if (!this.lock.writer) {
      bus.emit('log', { text: SAVING_DISABLED_TEXT, tone: 'warn' });
      return;
    }
    this.syncBaseline(true);

    this.offs.push(
      bus.on('planet:landed', () => this.wanted.add('landed')),
      bus.on('system:entered', () => this.wanted.add('system')),
      bus.on('cargo:action', (e) => {
        if (e.action.kind === 'mine' && e.result.ok) this.wanted.add('mined');
      }),
    );

    const page = this.page;
    if (page) {
      const onVisibility = (): void => {
        if (page.document.visibilityState === 'hidden') void this.saveNow('hidden');
      };
      const onPageHide = (): void => this.snapshotNow();
      page.document.addEventListener('visibilitychange', onVisibility);
      page.window.addEventListener('pagehide', onPageHide);
      this.offs.push(
        () => page.document.removeEventListener('visibilitychange', onVisibility),
        () => page.window.removeEventListener('pagehide', onPageHide),
      );
    }
  }

  update(dt: number, _ctx?: EngineContext): void {
    if (!this.lock.writer) return;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.sinceSaveS += step;
    this.sinceIntervalS += step;
    this.syncBaseline(false);

    for (const reason of GAPPED) {
      if (this.wanted.has(reason) && shouldAutosave({ sinceLastS: this.sinceSaveS, reason })) {
        void this.saveNow(reason);
        return;
      }
    }
    if (this.sinceIntervalS >= AUTOSAVE_INTERVAL_S && shouldAutosave({ sinceLastS: this.sinceIntervalS, reason: 'interval' })) {
      void this.saveNow('interval');
    }
  }

  /**
   * R2: the paying code path's hook. The journal notes the exit and the WAL gets
   * the same entry now, synchronously; the autosave follows on the next tick.
   */
  critical(used: GameEvents['emergency:used']): void {
    if (!this.lock.writer || this.disposed) return;
    const journal = this.world.journal;
    // R16: the whole payment goes to the WAL — the burn to here booked as
    // thrust first, then what the payment announced (propellant / cargo) and
    // the exit itself — under the seqs the next save will carry. A reload
    // applies them over the last durable save (bootLoad, dedup by seq).
    const tank = this.world.universe.flight.propellant;
    if (tank) {
      this.syncBaseline(false);
      journal.settleThrust(tank.massKg, tank.baseCapacityKg * START_FILL);
    }
    const entry = journal.noteEmergency(used);
    let ok = entry !== null;
    for (const e of journal.peek()) {
      if (e.seq <= this.walSeq) continue;
      if (!this.wal.appendCritical(e)) ok = false;
      this.walSeq = Math.max(this.walSeq, e.seq);
    }
    // R14 M4: not on disk is not silent (the autosave on the next tick still tries).
    if (entry && !ok) bus.emit('log', { text: SAVE_FAILED_TEXT, tone: 'warn' });
    this.wanted.add('emergency');
  }

  /** Save now. True once the store holds it. */
  saveNow(reason: SaveReason): Promise<boolean> {
    return this.write(reason, false);
  }

  /**
   * R14/R15: leaving the piloting modes for the Yard or the title flushes a
   * save (always): the tank stays attached in the Yard, and nothing ticks there.
   */
  onModeChange(from: Mode, to: Mode, _ctx?: EngineContext): void {
    const piloting = from === 'flight' || from === 'map';
    if (piloting && (to === 'yard' || to === 'title')) void this.write('leave', true);
  }

  private async write(reason: SaveReason, leaving: boolean): Promise<boolean> {
    const save = this.capture(leaving);
    if (!save) {
      // R14 M3: the pilot's own SAVE is answered; autosaves stay quiet.
      if (reason === 'manual') {
        bus.emit('log', { text: this.lock.writer ? SAVE_FAILED_TEXT : SAVING_DISABLED_TEXT, tone: 'warn' });
      }
      return false;
    }

    // Synchronously first: a false here is no cover — the store write goes on.
    this.wal.writeSnapshot(save);

    this.inFlight++;
    const write = this.queue.then(() => this.store.save(save));
    this.queue = write.catch(() => undefined);
    try {
      await write;
    } catch {
      bus.emit('log', { text: SAVE_FAILED_TEXT, tone: 'warn' });
      return false;
    } finally {
      this.inFlight--;
    }
    this.wal.clear(save.revision);
    if (reason === 'manual') bus.emit('log', { text: SAVED_TEXT, tone: 'normal' });
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs = [];
    this.wanted.clear();
    this.lock.release();
  }

  // ---------------------------------------------------------------------------

  /**
   * May this tab write the game now? R14: a writer with a tank attached, not
   * over the title — the Yard keeps the tank, so it saves too. `leaving`: the
   * flush on the way out of flight, which may already find the title up.
   */
  private mayWrite(leaving: boolean): boolean {
    if (!this.lock.writer || this.disposed) return false;
    if (this.world.universe.flight.propellant === null) return false;
    return leaving || modes.base !== 'title';
  }

  /** Build the next save and keep it as prev (the journal was drained into it). */
  private capture(leaving = false): SaveV1 | null {
    if (!this.mayWrite(leaving)) return null;
    // R14 M2: a tank swapped since the last tick starts the books now, not as thrust.
    this.syncBaseline(false);
    let save = buildSave(this.world, this.prev);
    if (!this.prev && this.revisionFloor > 0) save = { ...save, revision: this.revisionFloor + 1 };
    this.prev = save;
    this.revisionFloor = 0;
    this.tank = this.world.universe.flight.propellant;
    this.sinceSaveS = 0;
    this.sinceIntervalS = 0;
    this.wanted.clear();
    return save;
  }

  /** pagehide: the whole snapshot to the WAL, synchronously. */
  private snapshotNow(): void {
    const save = this.capture();
    if (save) this.wal.writeSnapshot(save);
  }

  /** The books start at the tank: at init, and whenever the tank is swapped. */
  private syncBaseline(force: boolean): void {
    const tank = this.world.universe.flight.propellant;
    if (!force && tank === this.tank) return;
    this.tank = tank;
    this.world.journal.setBaseline(tank ? tank.massKg : null);
  }
}
