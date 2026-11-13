/**
 * Boot: which save, and what it holds (v4 sub-plan 3, Task 6; DESIGN §5.2).
 *
 *  - `loadForBoot` takes the NEWEST VALID of IndexedDB current, IndexedDB
 *    previous and the WAL snapshot (`newestOf`). A false from writeSnapshot
 *    never meant "the old snapshot is intact", so all three are compared.
 *  - Nothing is discarded silently: an unreadable slot is kept
 *    (`store.keepCorrupt`) and the notice says so; so is a valid save of
 *    ANOTHER game that loses the comparison (R26) — an older revision of the
 *    same game is not.
 *  - A store that cannot be opened (a VersionError after another tab
 *    upgraded the database) or does not answer within STORE_TIMEOUT_MS (R25
 *    I3) never stops the boot: the WAL snapshot is used if there is one, and
 *    `loadForBootResult` says `storeAvailable: false` — the session then
 *    never writes to that store (R25 I2), and neither does the boot.
 *  - WAL critical entries are merged only into THEIR game (fix round 1, I1):
 *    an entry is applied when its saveId is the chosen save's (an entry
 *    without one: by the rules below only), it is not tagged as covered by a
 *    revision ≤ the chosen one (`by`), and its seq is above what the save
 *    covers (the highest seq in its actions, a checkpoint counting with its
 *    upToSeq). It is appended and applied by the replay rules (R16): the
 *    ship's tank and hold, a `mined` entry into the world (P2), a
 *    cannibalization's timesUsed, and a beacon's logbook note.
 *  - Only a writer tab keeps a copy (of an unreadable slot or a losing game).
 *  - The legacy logbook is offered only when nothing at all is stored.
 *  - `replaceGame` (NEW GAME, a failed restore) destroys nothing: the old
 *    game (merged) is written back as revision + 1 AND kept as a copy on the
 *    kept shelf (I2), which no later save evicts; the new game saves from
 *    `afterRevision + 1`. With the store unavailable it goes to the WAL only.
 *  - Every store call the boot makes gets STORE_TIMEOUT_MS (3 s).
 *
 * Never throws.
 */

import type { Route } from '@/core/Route';
import type { UniverseOptions } from '@/game/Universe';
import { BEACON_NOTE_TITLE } from '@/ship/emergency';
import { legacyLogToV1, migrate } from './migrate';
import { applyEntry, zeroState, type ReplayState } from './replay';
import type { ActionEntry, SaveV1 } from './schema';
import { newestOf, STORE_TIMEOUT_MS, withTimeout, type SaveStore } from './store';
import type { TaggedEntry, Wal } from './wal';

export const SAVE_UNREADABLE_TEXT = 'SAVE UNREADABLE — KEPT A COPY';
export const STORE_UNAVAILABLE_TEXT = 'SAVE STORAGE UNAVAILABLE — RELOAD THE TAB';

const LEGACY_LOG_KEY = 'onespace.log.v1';
const BEACON_KEY = /^beacon:(\d+)$/;

export interface BootLoad {
  /** The save to CONTINUE, WAL entries merged; null = a new game. */
  readonly save: SaveV1 | null;
  /** One log line for the player, or null. */
  readonly notice: string | null;
  /** The pre-save logbook, only when nothing at all is stored. */
  readonly legacyLog: SaveV1['log'] | null;
}

/** The highest seq a save's log holds (a checkpoint counts with its upToSeq). */
function coveredSeq(s: SaveV1): number {
  let m = 0;
  for (const a of s.actions) {
    m = Math.max(m, a.seq);
    if (a.source === 'checkpoint') m = Math.max(m, a.payload.upToSeq);
  }
  return m;
}

function nextBeacon(log: SaveV1['log']): number {
  let n = 0;
  for (const e of log.entries) {
    const m = BEACON_KEY.exec(e.key);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return n + 1;
}

/** An entry the WAL holds, with or without its tags (a bare entry: no saveId, not covered). */
export type WalEntry = ActionEntry | TaggedEntry;

function tagged(x: WalEntry): TaggedEntry {
  return 'e' in x ? x : { e: x, by: null, saveId: null };
}

/**
 * `s` with the WAL entries of ITS game that it does not cover applied, in seq
 * order. Returns `s` itself when none apply.
 */
export function mergeCritical(s: SaveV1, entries: readonly WalEntry[]): SaveV1 {
  const upTo = coveredSeq(s);
  const seen = new Set<number>();
  const fresh: ActionEntry[] = [];
  const mine = entries
    .map(tagged)
    .filter((t) => (t.saveId === null || t.saveId === s.saveId) && !(t.by !== null && t.by <= s.revision))
    .map((t) => t.e);
  for (const e of mine.sort((a, b) => a.seq - b.seq)) {
    if (e.seq <= upTo || seen.has(e.seq)) continue;
    seen.add(e.seq);
    fresh.push(e);
  }
  if (fresh.length === 0) return s;

  const out = structuredClone(s);
  const st: ReplayState = { ...zeroState(), tank: { ...out.ship.propellant }, cargo: { ...out.ship.cargo } };
  /** kg the last jettison-all before a beacon threw out. */
  let jettisonedKg = 0;
  for (const e of fresh) {
    applyEntry(st, e);
    out.actions.push(e);
    switch (e.source) {
      case 'mined':
        out.world.entries.push({ ...e.payload, wallMs: e.wallMs, orbitSeconds: e.orbitSeconds });
        break;
      case 'cargo':
        if (e.payload.action.kind === 'jettison-all') jettisonedKg = e.payload.result.kgOut;
        break;
      case 'emergency':
        if (e.payload.timesUsed !== undefined) {
          out.ship.emergencyTimesUsed = Math.max(out.ship.emergencyTimesUsed, e.payload.timesUsed);
        }
        if (e.payload.kind === 'beacon') {
          const kg = Math.round(jettisonedKg);
          out.log.entries.push({
            key: `beacon:${nextBeacon(out.log)}`,
            kind: 'note',
            at: out.log.time,
            system: out.player.system.name,
            title: BEACON_NOTE_TITLE,
            body: [
              'distress beacon answered · returned to a safe orbit',
              kg > 0 ? `hold jettisoned · ${kg} kg` : 'hold empty · nothing jettisoned',
            ],
            visits: 1,
          });
          jettisonedKg = 0;
        }
        break;
    }
  }
  out.ship.propellant = {
    massKg: Math.max(0, st.tank.massKg),
    capacityLossFrac: Math.min(1, Math.max(0, st.tank.capacityLossFrac)),
  };
  out.ship.cargo = {
    ice: Math.max(0, st.cargo.ice),
    metal: Math.max(0, st.cargo.metal),
    silicate: Math.max(0, st.cargo.silicate),
    rare: Math.max(0, st.cargo.rare),
  };
  return out;
}

function readLegacyLog(): SaveV1['log'] | null {
  try {
    const text = (globalThis as { localStorage?: Storage }).localStorage?.getItem(LEGACY_LOG_KEY) ?? null;
    if (!text) return null;
    return legacyLogToV1(JSON.parse(text), {
      universeId: '',
      system: { id: '', seed: 0, name: '', positionLy: [0, 0, 0] },
      now: { wallMs: Date.now(), orbitSeconds: 0 },
    });
  } catch {
    return null;
  }
}

function readWal(wal: Wal): { snapshot: SaveV1 | null; critical: TaggedEntry[] } {
  try {
    const r = wal.readTagged();
    // `read` runs the snapshot through migrate already.
    return { snapshot: (r.snapshot as SaveV1 | null) ?? null, critical: r.critical };
  } catch {
    return { snapshot: null, critical: [] };
  }
}

export interface LoadOptions {
  /** A reader tab reads but never writes: no copy of an unreadable slot. Default true. */
  readonly writer?: boolean;
}

/** `loadForBoot`, and whether the store answered (R25 I2: false = store-inert for the session). */
export interface BootLoadResult {
  readonly load: BootLoad;
  readonly storeAvailable: boolean;
}

/** A store call with the boot's time limit (R25 I3); never throws, false on failure. */
async function tryStore(call: () => Promise<unknown>): Promise<boolean> {
  try {
    await withTimeout(call, STORE_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

export async function loadForBoot(store: SaveStore, wal: Wal, opts: LoadOptions = {}): Promise<BootLoad> {
  return (await loadForBootResult(store, wal, opts)).load;
}

export async function loadForBootResult(store: SaveStore, wal: Wal, opts: LoadOptions = {}): Promise<BootLoadResult> {
  const writer = opts.writer !== false;
  const w = readWal(wal);
  const merged = (s: SaveV1 | null): SaveV1 | null => (s ? mergeCritical(s, w.critical) : null);

  let slots: { current: unknown | null; previous: unknown | null };
  try {
    // R25 I3: a hung open or load is an unavailable store after 3 s.
    slots = await withTimeout(() => store.load(), STORE_TIMEOUT_MS);
  } catch {
    return {
      load: { save: merged(w.snapshot), notice: STORE_UNAVAILABLE_TEXT, legacyLog: null },
      storeAvailable: false,
    };
  }

  /** Every valid save found, with what to shelve if it loses (the raw slot value, or the WAL snapshot). */
  const valid: Array<{ save: SaveV1; raw: unknown }> = [];
  if (w.snapshot) valid.push({ save: w.snapshot, raw: w.snapshot });
  let anyStored = w.snapshot !== null;
  let notice: string | null = null;
  for (const raw of [slots.current, slots.previous]) {
    if (raw === null || raw === undefined) continue;
    anyStored = true;
    const m = migrate(raw);
    if (m.ok) {
      valid.push({ save: m.save, raw });
      continue;
    }
    notice = SAVE_UNREADABLE_TEXT;
    if (!writer) continue;
    // Kept in its slot until a save overwrites it if this fails; the notice still says so.
    await tryStore(() => store.keepCorrupt(raw, Date.now()));
  }

  let best: SaveV1 | null = null;
  for (const v of valid) best = newestOf(best, v.save);

  // R26: a save of ANOTHER game that loses is kept on the shelf — a later save
  // would rotate it out of the slots for good. An older revision of the same
  // game is not (it is that game's past). The store dedups by raw value.
  if (writer && best) {
    for (const v of valid) {
      if (v.save.saveId !== best.saveId) await tryStore(() => store.keepCorrupt(v.raw, Date.now()));
    }
  }
  return { load: { save: merged(best), notice, legacyLog: anyStored ? null : readLegacyLog() }, storeAvailable: true };
}

export interface ReplaceOptions {
  /**
   * R25 I2/C4: false when the store was unavailable at boot — nothing is
   * written to it (a store that recovers must not have a real save rotated
   * out); the old game goes back to the WAL snapshot only. Default true.
   */
  readonly storeAvailable?: boolean;
}

/**
 * NEW GAME confirmed, or a restore that failed (writer tabs only): write the
 * old game (WAL merged) back as revision + 1, keep a copy of it on the kept
 * shelf (I2: `previous` alone is evicted by the new game's second save), and
 * clear its WAL, so nothing of it leaks into the new game. The new game's
 * first save is `afterRevision + 1`. Each store call gets 3 s (R25 I3).
 */
export async function replaceGame(
  store: SaveStore,
  wal: Wal,
  load: BootLoad,
  opts: ReplaceOptions = {},
): Promise<{ afterRevision: number; kept: boolean }> {
  if (!load.save) return { afterRevision: 0, kept: false };
  const old: SaveV1 = { ...load.save, revision: load.save.revision + 1 };
  const useStore = opts.storeAvailable !== false;
  // The copy first; if it fails the old game is still written back below.
  const kept = useStore && (await tryStore(() => store.keepCorrupt(old, Date.now())));
  try {
    wal.writeSnapshot(old);
  } catch {
    // the WAL never throws; belt and braces
  }
  // The WAL keeps the old game (tagged) if this fails; the new game's first durable save clears it.
  if (useStore && (await tryStore(() => store.save(old)))) wal.clear(old.revision);
  return { afterRevision: old.revision, kept };
}

/** The log a boot starts with. NEW GAME over a save starts empty: the legacy entries belong to the old game. */
export function openingLog(load: BootLoad, start: 'continue' | 'new'): SaveV1['log'] {
  if (start === 'continue' && load.save) return load.save.log;
  if (!load.save && load.legacyLog) return load.legacyLog;
  return { time: 0, entries: [] };
}

/** `gx-<base36>:v1` → the universe seed. */
function seedOf(universeId: string): number | undefined {
  const m = /^gx-([0-9a-z]+):v1$/.exec(universeId);
  if (!m) return undefined;
  const n = parseInt(m[1]!, 36);
  return Number.isFinite(n) ? n >>> 0 : undefined;
}

/** The Universe a boot builds: the save's universe and place, or the route's seed for a new game. */
export function universeOptionsFor(route: Route, save: SaveV1 | null): UniverseOptions {
  if (!save) return route.universeSeed !== undefined ? { seed: route.universeSeed } : {};
  const p = save.player;
  const seed = seedOf(save.universeId);
  return {
    ...(seed !== undefined ? { seed } : {}),
    restore: {
      system: p.system,
      orbitSeconds: save.savedAt.orbitSeconds,
      parentId: p.parentId,
      flight: {
        position: p.flight.position,
        velocity: p.flight.velocity,
        orientation: p.flight.orientation,
        // A grounded ship needs ground: without a parent it would hang frozen.
        grounded: p.parentId !== null && p.flight.grounded,
      },
      flightAssist: p.flight.flightAssist,
    },
  };
}
