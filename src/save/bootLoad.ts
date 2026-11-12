/**
 * Boot: which save, and what it holds (v4 sub-plan 3, Task 6; DESIGN §5.2).
 *
 *  - `loadForBoot` takes the NEWEST VALID of IndexedDB current, IndexedDB
 *    previous and the WAL snapshot (`newestOf`). A false from writeSnapshot
 *    never meant "the old snapshot is intact", so all three are compared.
 *  - Nothing is discarded silently: an unreadable slot is kept
 *    (`store.keepCorrupt`) and the notice says so. A store that cannot be
 *    opened (a VersionError after another tab upgraded the database) never
 *    crashes the boot: the WAL snapshot is used if there is one.
 *  - WAL critical entries are merged with DEDUP BY SEQ: an entry the chosen
 *    save already covers (its seq is ≤ the highest seq in its actions, a
 *    checkpoint counting with its upToSeq) is not applied again. A newer one
 *    is appended and applied by the replay rules (R16): the ship's tank and
 *    hold, a `mined` entry into the world (P2), a cannibalization's
 *    timesUsed, and a beacon's logbook note.
 *  - The legacy logbook is offered only when nothing at all is stored.
 *  - `prepareNewGame` destroys nothing: the old game (merged) is written back
 *    as revision + 1; the new game saves from `afterRevision + 1`.
 *
 * Never throws.
 */

import type { Route } from '@/core/Route';
import type { UniverseOptions } from '@/game/Universe';
import { BEACON_NOTE_TITLE } from '@/ship/emergency';
import { legacyLogToV1, migrate } from './migrate';
import { applyEntry, zeroState, type ReplayState } from './replay';
import type { ActionEntry, SaveV1 } from './schema';
import { newestOf, type SaveStore } from './store';
import type { Wal } from './wal';

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

/** `s` with the WAL entries it does not cover applied, in seq order. Returns `s` itself when none apply. */
export function mergeCritical(s: SaveV1, entries: readonly ActionEntry[]): SaveV1 {
  const upTo = coveredSeq(s);
  const seen = new Set<number>();
  const fresh: ActionEntry[] = [];
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
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

function readWal(wal: Wal): { snapshot: SaveV1 | null; critical: ActionEntry[] } {
  try {
    const r = wal.read();
    // `read` runs the snapshot through migrate already.
    return { snapshot: (r.snapshot as SaveV1 | null) ?? null, critical: r.critical };
  } catch {
    return { snapshot: null, critical: [] };
  }
}

export async function loadForBoot(store: SaveStore, wal: Wal): Promise<BootLoad> {
  const w = readWal(wal);
  const merged = (s: SaveV1 | null): SaveV1 | null => (s ? mergeCritical(s, w.critical) : null);

  let slots: { current: unknown | null; previous: unknown | null };
  try {
    slots = await store.load();
  } catch {
    return { save: merged(w.snapshot), notice: STORE_UNAVAILABLE_TEXT, legacyLog: null };
  }

  let best: SaveV1 | null = w.snapshot;
  let anyStored = w.snapshot !== null;
  let notice: string | null = null;
  for (const raw of [slots.current, slots.previous]) {
    if (raw === null || raw === undefined) continue;
    anyStored = true;
    const m = migrate(raw);
    if (m.ok) {
      best = newestOf(best, m.save);
      continue;
    }
    notice = SAVE_UNREADABLE_TEXT;
    try {
      await store.keepCorrupt(raw, Date.now());
    } catch {
      // Kept in its slot until a save overwrites it; the notice still says so.
    }
  }
  return { save: merged(best), notice, legacyLog: anyStored ? null : readLegacyLog() };
}

/**
 * NEW GAME confirmed: write the old game (WAL merged) back as revision + 1 and
 * clear its WAL, so nothing of it leaks into the new game. The new game's
 * first save is `afterRevision + 1`, which pushes the old one to `previous`.
 */
export async function prepareNewGame(store: SaveStore, wal: Wal, load: BootLoad): Promise<{ afterRevision: number }> {
  if (!load.save) return { afterRevision: 0 };
  const old: SaveV1 = { ...load.save, revision: load.save.revision + 1 };
  try {
    wal.writeSnapshot(old);
  } catch {
    // the WAL never throws; belt and braces
  }
  try {
    await store.save(old);
    wal.clear(old.revision);
  } catch {
    // The WAL keeps the old game (tagged); the new game's first durable save clears it.
  }
  return { afterRevision: old.revision };
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
