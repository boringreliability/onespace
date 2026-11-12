/**
 * The save format, v1 (v4 sub-plan 3).
 *
 * A seeded universe regenerates everything except what the player did, so this
 * is the one record that cannot be rebuilt — and the one that arrives from
 * outside the program (storage, an old build, a hand-edited file). Every schema
 * here is therefore a whitelist: `strictObject` everywhere, every number finite
 * (Zod 4's `z.number()` rejects NaN and ±Infinity), amounts never negative.
 *
 * Player and world are separate (P2); both clocks ride on everything that
 * happens (P5); the action log is append-only and its payload is checked
 * against its source (P3). Quaternions are normalised after parsing, so a save
 * that drifted off unit length loads as the same rotation.
 *
 * FORMAT RULE (R4): format 1 is frozen. ANY change to this shape — a renamed
 * or removed field, a new enum value, a new action source, even an added
 * OPTIONAL field — needs a new format number (CURRENT_FORMAT + 1) and an
 * explicit step in migrate.ts `UPGRADES`. That is what lets `migrate` call a
 * format-1 save with unknown keys `newer-build` instead of `invalid`: under
 * this rule only a newer build can have written them.
 *
 * The "Mirrors X" schemas are held to their runtime types by
 * schemaDrift.test.ts (type level in `tsc`, and real outputs at runtime).
 */

// A namespace import, not `import { z }`: the `z` object drags in every Zod
// locale (~260 kB minified); `* as z` lets the bundler drop them.
import * as z from 'zod';

export const CURRENT_FORMAT = 1;

// --- primitives --------------------------------------------------------------

/** Finite: z.number() in Zod 4 already refuses NaN and ±Infinity. */
const num = z.number();
/** An amount (kg, distance, fraction): finite and ≥ 0. */
const amount = z.number().min(0);
/** A count or a sequence number. */
const count = z.number().int().min(0);

const vec3 = z.tuple([num, num, num]);

type Quat = [number, number, number, number];

/** Below this a quaternion has no direction to normalise to. */
const QUAT_MIN_LENGTH = 1e-9;

const quaternion = z
  .tuple([num, num, num, num])
  .refine((q) => Math.hypot(q[0], q[1], q[2], q[3]) > QUAT_MIN_LENGTH, {
    message: 'quaternion has (near) zero length',
  })
  .transform((q): Quat => {
    const l = Math.hypot(q[0], q[1], q[2], q[3]);
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  });

export const ResourceSchema = z.enum(['ice', 'metal', 'silicate', 'rare']);

/** Record<Resource, T> as a closed object: all four keys, nothing else. */
function perResource<T extends z.ZodType>(value: T) {
  return z.strictObject({ ice: value, metal: value, silicate: value, rare: value });
}

/** `${galaxy.id}:v1`, galaxy id `gx-<seed base36>`. */
const universeId = z.string().regex(/^gx-[0-9a-z]+:v1$/, 'expected gx-<base36>:v1');

const clocks = { wallMs: num, orbitSeconds: num };

// --- log and world -----------------------------------------------------------

/** Mirrors `LogEntry` (src/game/Log.ts). */
export const LogEntrySchema = z.strictObject({
  key: z.string().min(1),
  kind: z.enum(['arrival', 'world', 'landing', 'contact', 'note']),
  at: amount,
  system: z.string(),
  title: z.string(),
  /** `LogEntry.body` is `readonly string[]`; the schema must accept it as-is (schemaDrift.test.ts). */
  body: z.array(z.string()).readonly(),
  visits: z.number().int().min(1),
});

export const LogSchema = z.strictObject({
  time: amount,
  entries: z.array(LogEntrySchema),
});

/** Mirrors `MinedEntry` (src/game/worldState.ts). */
export const MinedEntrySchema = z.strictObject({
  id: z.string().min(1),
  by: z.literal('local'),
  resource: ResourceSchema,
  kg: amount,
  ...clocks,
});

// --- action payloads ---------------------------------------------------------

/** Mirrors `PropellantAction` (src/ship/travelCost.ts). */
const PropellantActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cruise-spool') }),
  z.strictObject({ kind: z.literal('cruise-leg'), distanceKm: amount }),
  z.strictObject({ kind: z.literal('jump'), distanceLy: amount }),
  z.strictObject({ kind: z.literal('cannibalize'), part: z.literal('tank'), timesUsed: count.optional() }),
  z.strictObject({ kind: z.literal('beacon') }),
  z.strictObject({ kind: z.literal('jump-refund'), kg: amount }),
  z.strictObject({ kind: z.literal('spool-refund'), kg: amount }),
]);

/** Mirrors `CargoAction` (src/ship/cargo.ts). */
const CargoActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('mine'), asteroidId: z.string().min(1), resource: ResourceSchema, kg: amount }),
  z.strictObject({ kind: z.literal('refine') }),
  z.strictObject({ kind: z.literal('repair') }),
  z.strictObject({ kind: z.literal('jettison-all') }),
  z.strictObject({ kind: z.literal('cannibalize-cargo') }),
]);

/** Mirrors `CargoResult` (src/ship/cargo.ts). */
const CargoResultSchema = z.strictObject({
  ok: z.boolean(),
  kgIn: amount,
  kgOut: amount,
  fuelKg: amount,
  restoredFrac: amount,
  reason: z
    .enum([
      'hold-full',
      'nothing-to-refine',
      'tank-full',
      'insufficient',
      'nothing-to-repair',
      'empty',
      'not-empty',
      'no-tank',
      'invalid',
    ])
    .optional(),
});

/** One action entry: the payload is whatever its source announced, checked per source. */
function entry<S extends string, P extends z.ZodType>(source: S, payload: P) {
  return z.strictObject({ seq: z.number().int().min(1), source: z.literal(source), payload, ...clocks });
}

export const ActionEntrySchema = z.discriminatedUnion('source', [
  /** `propellant:action`. */
  /** R7: `tankDeltaKg` is signed — negative for a spend, positive for a refund or a gain. */
  entry('propellant', z.strictObject({ action: PropellantActionSchema, ok: z.boolean(), kg: amount, tankDeltaKg: num })),
  /** `cargo:action` (only `result.ok` is logged). */
  entry('cargo', z.strictObject({ action: CargoActionSchema, result: CargoResultSchema })),
  /** `emergency:used`. */
  entry(
    'emergency',
    z.strictObject({
      kind: z.enum(['cannibalize', 'cannibalize-cargo', 'beacon']),
      timesUsed: count.optional(),
    }),
  ),
  /** `WorldState.recordMined` (P2: who mined it). */
  entry(
    'mined',
    z.strictObject({ id: z.string().min(1), by: z.literal('local'), resource: ResourceSchema, kg: amount }),
  ),
  /** Unannounced burns, aggregated once per save so the tank's books balance. */
  entry('thrust', z.strictObject({ kg: amount })),
  /** The oldest entries, compacted to sums (MAX_ACTIONS). */
  entry(
    'checkpoint',
    z.strictObject({
      upToSeq: count,
      propellantKg: amount,
      cargoKg: perResource(amount),
      minedKg: perResource(amount),
      emergency: z.strictObject({ cannibalize: count, cannibalizeCargo: count, beacon: count }),
    }),
  ),
]);

export type ActionEntry = z.infer<typeof ActionEntrySchema>;

// --- the save ----------------------------------------------------------------

export const SaveV1Schema = z
  .strictObject({
    format: z.literal(CURRENT_FORMAT),
    saveId: z.uuid(),
    universeId,
    revision: z.number().int().min(1),
    savedAt: z.strictObject(clocks),
    player: z.strictObject({
      system: z.strictObject({
        id: z.string().min(1),
        seed: count,
        name: z.string(),
        positionLy: vec3,
      }),
      parentId: z.string().min(1).nullable(),
      flight: z.strictObject({
        position: vec3,
        velocity: vec3,
        orientation: quaternion,
        grounded: z.boolean(),
        flightAssist: z.boolean(),
      }),
    }),
    ship: z.strictObject({
      propellant: z.strictObject({ massKg: amount, capacityLossFrac: z.number().min(0).max(1) }),
      cargo: perResource(amount),
      emergencyTimesUsed: count,
    }),
    log: LogSchema,
    world: z.strictObject({ universeId, entries: z.array(MinedEntrySchema) }),
    actions: z.array(ActionEntrySchema),
  })
  .refine((s) => s.world.universeId === s.universeId, {
    message: 'world belongs to another universe',
    path: ['world', 'universeId'],
  });

export type SaveV1 = z.infer<typeof SaveV1Schema>;
