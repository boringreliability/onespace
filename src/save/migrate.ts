/**
 * Migration: the only door a stored save comes through (v4 sub-plan 3; the
 * first real upgrade, format 1 → 2: sub-plan 6).
 *
 * Two rules, both silent when broken:
 *  - `migrate` never throws. A bad save on boot is a message, not a crash.
 *  - Nothing is swallowed. An unknown or broken save comes back as an error and
 *    the raw input is left untouched, so the caller can keep it
 *    (`onespace.save.corrupt.<wallMs>`).
 *
 * The order, for a save that claims format F:
 *  1. F above CURRENT_FORMAT → `newer-build`; F below OLDEST_FORMAT →
 *     `unknown-format`. Nothing inside is read.
 *  2. The raw body is checked against F's OWN schema (`SCHEMAS[F]`), not the
 *     current one. So a format-1 save that holds a format-2 action or field is
 *     refused here, before any lift could make it look valid.
 *  3. The checked raw body is lifted one format at a time by `UPGRADES[F]`,
 *     `UPGRADES[F + 1]`, … up to CURRENT_FORMAT. A step builds a new object (it
 *     never writes into its input) and changes only what its format changed.
 *  4. The lifted body is parsed with the current schema (`SaveV2Schema`); that
 *     is what comes back. Parsed once from the raw values, so a quaternion is
 *     normalised once, as it always was. A failure here is an upgrade step
 *     that produced a bad save: `invalid`. (A save already in the current
 *     format has no step 3, and its step-2 parse is step 4.)
 *
 * FORMAT RULE (R4, see schema.ts): a released format is frozen; ANY change to
 * the shape, an added optional field included, requires a new format number,
 * a new schema in SCHEMAS and an `UPGRADES` step. So a save that claims a
 * format this build knows and fails step 2 ONLY because of keys this build
 * does not know was written by a newer build: `newer-build`, not `invalid`, so
 * the game can say why it fell back instead of guessing. Anything else wrong
 * with it (a bad value, an unknown enum member or action kind) is `invalid`.
 */

import type { z } from 'zod';

import { CURRENT_FORMAT, LogSchema, SaveV1Schema, SaveV2Schema, type Save } from './schema';

export type MigrateResult =
  | { ok: true; save: Save; migratedFrom: number }
  | { ok: false; reason: 'unknown-format' | 'newer-build' | 'invalid'; issues: string[] };

type Raw = Record<string, unknown>;

/**
 * The schema each readable format is checked against BEFORE it is lifted
 * (step 2). The entry for CURRENT_FORMAT must be SaveV2Schema (migrate.ts
 * returns its output as a `Save`).
 */
const SCHEMAS: Readonly<Record<number, z.ZodType>> = {
  1: SaveV1Schema,
  2: SaveV2Schema,
};

/**
 * `UPGRADES[n]` lifts a format-n save, already checked against `SCHEMAS[n]`,
 * to format n + 1. It returns a new object and never writes into its input.
 */
const UPGRADES: Readonly<Record<number, (raw: Raw) => Raw>> = {
  /**
   * 1 → 2 (sub-plan 6): the beam's resource is new; a format-1 game mined ice
   * by default, so it gets 'ice'. Nothing else changes — no action in the old
   * log is rewritten (format 1 has no `jettison`, and every format-1 action
   * means the same in format 2).
   */
  1: (raw) => ({ ...raw, format: 2, ship: { ...(raw.ship as Raw), beamResource: 'ice' } }),
};

/** The oldest format we can read. */
const OLDEST_FORMAT = 1;

function isRecord(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `<dotted.path>: <message>`; the root is `(root)`. */
function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`);
}

export function migrate(raw: unknown): MigrateResult {
  try {
    if (!isRecord(raw)) return { ok: false, reason: 'invalid', issues: ['(root): not an object'] };

    // 1. The number alone decides whether this build can read it at all.
    const format = raw.format;
    if (typeof format !== 'number' || !Number.isInteger(format)) {
      return { ok: false, reason: 'invalid', issues: ['format: missing or not an integer'] };
    }
    if (format > CURRENT_FORMAT) {
      return {
        ok: false,
        reason: 'newer-build',
        issues: [`format: format ${format} is newer than this build reads (${CURRENT_FORMAT})`],
      };
    }
    const own = SCHEMAS[format];
    if (format < OLDEST_FORMAT || !own) {
      return { ok: false, reason: 'unknown-format', issues: [`format: unknown format ${format}`] };
    }

    // 2. Checked as what it claims to be. Zod builds a new object; `raw` is never written to.
    const checked = own.safeParse(raw);
    if (!checked.success) {
      const onlyExtraKeys = checked.error.issues.every((i) => i.code === 'unrecognized_keys');
      return { ok: false, reason: onlyExtraKeys ? 'newer-build' : 'invalid', issues: describeIssues(checked.error) };
    }
    // Already current: SCHEMAS[CURRENT_FORMAT] is SaveV2Schema, so this IS step 4.
    if (format === CURRENT_FORMAT) return { ok: true, save: checked.data as Save, migratedFrom: format };

    // 3. Lifted from the raw values (each step copies; `raw` stays as it was).
    let data: Raw = raw;
    for (let v = format; v < CURRENT_FORMAT; v++) {
      const step = UPGRADES[v];
      if (!step) return { ok: false, reason: 'unknown-format', issues: [`format: no upgrade from ${v}`] };
      data = step(data);
    }

    // 4. Parsed once as the current format.
    const parsed = SaveV2Schema.safeParse(data);
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
): Save['log'] | null {
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
