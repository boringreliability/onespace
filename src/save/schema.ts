/**
 * The save format (v4 sub-plan 3; format 2: sub-plan 6).
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
 * FORMAT RULE (R4): a released format is frozen. ANY change to the shape — a
 * renamed or removed field, a new enum value, a new action kind or source,
 * even an added OPTIONAL field — needs a new format number (CURRENT_FORMAT +
 * 1), a new save schema here, and an explicit step in migrate.ts `UPGRADES`;
 * the old schema stays exactly as it was. `migrate` checks a stored save
 * against the schema of the format it CLAIMS before it lifts it, so:
 *  - a save that claims a known format and fails ONLY because of unknown keys
 *    can only have been written by a build that knows more fields than this
 *    one: `newer-build`, not `invalid`;
 *  - a field or action of a newer format never gets in by way of a save that
 *    claims an older one (a format-1 save with a `jettison` is `invalid`).
 *
 * Formats:
 *  - 1 (`SaveV1Schema`, sub-plan 3): read only by `migrate`, before the lift.
 *  - 2 (`SaveV2Schema`, CURRENT, sub-plan 6): format 1 plus the cargo action
 *    `jettison` (one resource, kg) and `ship.beamResource` (the resource the
 *    mining beam takes). `Save` and `ActionEntry` are format 2 — what the rest
 *    of the code means by "a save".
 *
 * The "Mirrors X" schemas are held to their runtime types by
 * schemaDrift.test.ts (type level in `tsc`, and real outputs at runtime).
 */

// A namespace import, not `import { z }`: the `z` object drags in every Zod
// locale (~260 kB minified); `* as z` lets the bundler drop them.
import * as z from 'zod';

export const CURRENT_FORMAT = 2;

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

const quatLength = (q: readonly number[]): number => Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);

/**
 * Unit length within a few ulp: already normalised, returned exactly as given.
 * Dividing such a quaternion by its length again moves its last bit in about a
 * third of orientations, so parsing a parsed save would not give the same save
 * (plan 6 review fix I-1: SyncClient re-migrates migrated bodies and compares
 * them bitwise; a moved bit was a false conflict). What is valid is unchanged —
 * only the refine below decides that.
 */
const QUAT_UNIT_TOLERANCE = 4 * Number.EPSILON;

/**
 * Valid: a length that is finite and above QUAT_MIN_LENGTH. Plan 6, open
 * choice 4: finite components can still overflow `hypot` (four of 9e307 give
 * Infinity). Such a quaternion is refused on the FIRST parse; it used to pass
 * here, be divided by Infinity into zeros, and be refused only when that result
 * was parsed again. It is not rescued by scaling before `hypot`: an orientation
 * no build writes is invalid. A large but finite length (1e150 ×4, MAX_VALUE
 * alone) stays valid and is normalised as before.
 */
const quaternion = z
  .tuple([num, num, num, num])
  .refine(
    (q) => {
      const l = quatLength(q);
      return Number.isFinite(l) && l > QUAT_MIN_LENGTH;
    },
    {
      error: (iss) =>
        Array.isArray(iss.input) && !Number.isFinite(quatLength(iss.input as number[]))
          ? 'quaternion length overflows'
          : 'quaternion has (near) zero length',
    },
  )
  .transform((q): Quat => {
    const l = quatLength(q);
    // Idempotent: parse(parse(x)) === parse(x), bit for bit (shared by client and server).
    if (Math.abs(l - 1) <= QUAT_UNIT_TOLERANCE) return [q[0], q[1], q[2], q[3]];
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

/**
 * R25 I1: an asteroid id, exactly as the generator makes it (src/gen/belt.ts
 * fieldSpec): `ast:<systemId>:<field>:<n>`. A whitelist: an id is a key into
 * depletion maps, so "__proto__" and every other name must stay out.
 */
export const ASTEROID_ID = /^ast:[^:\s]+:\d+:\d+$/;
const asteroidId = z.string().regex(ASTEROID_ID, 'expected ast:<system>:<field>:<n>');

/**
 * A record keyed by asteroid id. Zod's record silently DROPS an own
 * "__proto__" key instead of failing it, so every raw key is checked first:
 * a hostile key rejects the whole entry, it is not quietly ignored.
 */
function asteroidRecord<T extends z.ZodType>(value: T) {
  return z
    .unknown()
    .refine(
      (raw) => !!raw && typeof raw === 'object' && Object.keys(raw).every((k) => ASTEROID_ID.test(k)),
      { message: 'expected asteroid ids as keys' },
    )
    .pipe(z.record(asteroidId, value));
}

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
  id: asteroidId,
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

/** The cargo actions of format 1. Frozen (R4). */
const CARGO_ACTIONS_V1 = [
  z.strictObject({ kind: z.literal('mine'), asteroidId, resource: ResourceSchema, kg: amount }),
  z.strictObject({ kind: z.literal('refine') }),
  z.strictObject({ kind: z.literal('repair') }),
  z.strictObject({ kind: z.literal('jettison-all') }),
  z.strictObject({ kind: z.literal('cannibalize-cargo') }),
] as const;

/** Format 1's `CargoAction` (read only by `migrate`, before its lift). */
const CargoActionSchemaV1 = z.discriminatedUnion('kind', [...CARGO_ACTIONS_V1]);

/**
 * Mirrors `CargoAction` (src/ship/cargo.ts). Format 2: format 1's actions plus
 * `jettison` of one resource; `kg` is what was ASKED for, `result.kgOut` what
 * really left the hold.
 */
const CargoActionSchema = z.discriminatedUnion('kind', [
  ...CARGO_ACTIONS_V1,
  z.strictObject({ kind: z.literal('jettison'), resource: ResourceSchema, kg: amount }),
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

/**
 * The action entry union over one format's cargo actions; every other source
 * is the same in format 1 and 2.
 */
function actionEntrySchema<C extends z.ZodType>(cargoAction: C) {
  return z.discriminatedUnion('source', [
    /** `propellant:action`. */
    /** R7: `tankDeltaKg` is signed — negative for a spend, positive for a refund or a gain. */
    entry('propellant', z.strictObject({ action: PropellantActionSchema, ok: z.boolean(), kg: amount, tankDeltaKg: num })),
    /** `cargo:action` (only `result.ok` is logged). */
    entry('cargo', z.strictObject({ action: cargoAction, result: CargoResultSchema })),
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
      z.strictObject({ id: asteroidId, by: z.literal('local'), resource: ResourceSchema, kg: amount }),
    ),
    /** Unannounced burns, aggregated once per save so the tank's books balance. */
    entry('thrust', z.strictObject({ kg: amount })),
    /**
     * The oldest entries, compacted (MAX_ACTIONS). R8: it carries the NET effect
     * of everything it absorbed, so replaying [checkpoint, …rest] recomputes the
     * same ship as replaying the full log (src/save/replay.ts).
     */
    entry(
      'checkpoint',
      z.strictObject({
        upToSeq: count,
        /** Signed change to the tank's mass. */
        tankNetKg: num,
        /** Signed change to the capacity loss (cannibalizations up, repairs down). */
        capacityLossNetFrac: num,
        /** Signed change to the hold, per resource. */
        cargoNetKg: perResource(num),
        /** Depletion added, per asteroid id. */
        minedByAsteroid: asteroidRecord(perResource(amount)),
        emergency: z.strictObject({ cannibalize: count, cannibalizeCargo: count, beacon: count }),
        /** The latest cannibalization's timesUsed in what was folded (carried over). */
        lastCannibalizeTimesUsed: count,
      }),
    ),
  ]);
}

/** Format 1's action entries (read only by `migrate`, before its lift). */
const ActionEntrySchemaV1 = actionEntrySchema(CargoActionSchemaV1);

/** The current format's action entries: the save, the WAL and the journal. */
export const ActionEntrySchema = actionEntrySchema(CargoActionSchema);

export type ActionEntry = z.infer<typeof ActionEntrySchema>;

// --- the save ----------------------------------------------------------------

// The parts formats 1 and 2 share. Shared by reference, so they cannot drift
// apart; a part that changes in a later format gets its own copy there (R4).

const savedAt = z.strictObject(clocks);

const PlayerSchema = z.strictObject({
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
});

const PropellantStateSchema = z.strictObject({ massKg: amount, capacityLossFrac: z.number().min(0).max(1) });

const WorldSchema = z.strictObject({ universeId, entries: z.array(MinedEntrySchema) });

/** The save's world must be of the save's own universe. */
const inOwnUniverse = (s: { universeId: string; world: { universeId: string } }): boolean =>
  s.world.universeId === s.universeId;
const otherUniverse = () => ({ message: 'world belongs to another universe', path: ['world', 'universeId'] });

/** Format 1. Frozen (R4): only `migrate` reads it, to check a format-1 save before lifting it. */
export const SaveV1Schema = z
  .strictObject({
    format: z.literal(1),
    saveId: z.uuid(),
    universeId,
    revision: z.number().int().min(1),
    savedAt,
    player: PlayerSchema,
    ship: z.strictObject({
      propellant: PropellantStateSchema,
      cargo: perResource(amount),
      emergencyTimesUsed: count,
    }),
    log: LogSchema,
    world: WorldSchema,
    actions: z.array(ActionEntrySchemaV1),
  })
  .refine(inOwnUniverse, otherUniverse());

/** Format 2, the current one: format 1 plus `jettison` and `ship.beamResource`. */
export const SaveV2Schema = z
  .strictObject({
    format: z.literal(2),
    saveId: z.uuid(),
    universeId,
    revision: z.number().int().min(1),
    savedAt,
    player: PlayerSchema,
    ship: z.strictObject({
      propellant: PropellantStateSchema,
      cargo: perResource(amount),
      emergencyTimesUsed: count,
      /** The resource the mining beam takes (sub-plan 6). A lifted format-1 save gets 'ice'. */
      beamResource: ResourceSchema,
    }),
    log: LogSchema,
    world: WorldSchema,
    actions: z.array(ActionEntrySchema),
  })
  .refine(inOwnUniverse, otherUniverse());

/** A save in the current format: what the rest of the code means by "a save". */
export type Save = z.infer<typeof SaveV2Schema>;

/** A format-1 save, as `SaveV1Schema` reads it. Only `migrate` (before its lift) and its tests deal in these. */
export type SaveFormat1 = z.infer<typeof SaveV1Schema>;

/**
 * @deprecated The old name of {@link Save}, kept so code and tests written
 * before format 2 still compile. It is the CURRENT format, not format 1 — a
 * format-1 save is {@link SaveFormat1}. New code says `Save`.
 */
export type SaveV1 = Save;
