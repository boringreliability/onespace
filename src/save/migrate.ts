/**
 * Migration: the only door a stored save comes through (v4 sub-plan 3).
 *
 * Two rules, both silent when broken:
 *  - `migrate` never throws. A bad save on boot is a message, not a crash.
 *  - Nothing is swallowed. An unknown or broken save comes back as an error and
 *    the raw input is left untouched, so the caller can keep it
 *    (`onespace.save.corrupt.<wallMs>`).
 *
 * Every format older than CURRENT_FORMAT gets an explicit step function in
 * `UPGRADES` that lifts it one version. v1 is the first format, so there are
 * no steps yet.
 */

import type { z } from 'zod';

import { CURRENT_FORMAT, LogSchema, SaveV1Schema, type SaveV1 } from './schema';

export type MigrateResult =
  | { ok: true; save: SaveV1; migratedFrom: number }
  | { ok: false; reason: 'unknown-format' | 'invalid'; issues: string[] };

/** `UPGRADES[n]` lifts a format-n save to format n + 1. */
const UPGRADES: Readonly<Record<number, (raw: Record<string, unknown>) => Record<string, unknown>>> = {};

/** The oldest format we can read. */
const OLDEST_FORMAT = 1;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `<dotted.path>: <message>`; the root is `(root)`. */
function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`);
}

export function migrate(raw: unknown): MigrateResult {
  try {
    if (!isRecord(raw)) return { ok: false, reason: 'invalid', issues: ['(root): not an object'] };

    const format = raw.format;
    if (typeof format !== 'number' || !Number.isInteger(format)) {
      return { ok: false, reason: 'invalid', issues: ['format: missing or not an integer'] };
    }
    if (format < OLDEST_FORMAT || format > CURRENT_FORMAT) {
      return { ok: false, reason: 'unknown-format', issues: [`format: unknown format ${format}`] };
    }

    let data: Record<string, unknown> = raw;
    for (let v = format; v < CURRENT_FORMAT; v++) {
      const step = UPGRADES[v];
      if (!step) return { ok: false, reason: 'unknown-format', issues: [`format: no upgrade from ${v}`] };
      data = step(data);
    }

    // Zod builds a new object; `raw` is never written to.
    const parsed = SaveV1Schema.safeParse(data);
    if (!parsed.success) return { ok: false, reason: 'invalid', issues: describeIssues(parsed.error) };
    return { ok: true, save: parsed.data, migratedFrom: format };
  } catch (e) {
    return { ok: false, reason: 'invalid', issues: [`(root): ${e instanceof Error ? e.message : String(e)}`] };
  }
}

/**
 * Import the pre-save logbook (`onespace.log.v1`: `{version: 1, time, entries}`)
 * once, into the first save. Entries are checked against the save's own
 * LogEntrySchema, so the two cannot drift. Returns null for anything that is
 * not a readable v1 log, one bad entry included — the caller keeps the old key
 * as a backup, so null loses nothing. `ctx` is where and when the import
 * happens; the legacy entries already carry their own system and time.
 */
export function legacyLogToV1(
  legacy: unknown,
  ctx: {
    universeId: string;
    /** As `player.system`; the position is any readable triple (not read here). */
    system: { id: string; seed: number; name: string; positionLy: readonly number[] };
    now: { wallMs: number; orbitSeconds: number };
  },
): SaveV1['log'] | null {
  void ctx;
  try {
    if (!isRecord(legacy) || legacy.version !== 1 || !Array.isArray(legacy.entries)) return null;
    // ShipLog.load read a missing or non-numeric time as 0.
    const time = typeof legacy.time === 'number' ? legacy.time : 0;
    const log = LogSchema.safeParse({ time, entries: legacy.entries });
    return log.success ? log.data : null;
  } catch {
    return null;
  }
}
