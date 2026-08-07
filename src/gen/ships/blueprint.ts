/**
 * oneSpace — the ship generator.
 *
 *   ShipParams ──▶ generateShip ──▶ ShipBlueprint (plain JSON)
 *
 * Pure: no three.js, no DOM, no I/O, no `Math.random`. Same params + same
 * `SHIP_GENERATION_VERSION` give a byte-identical blueprint forever.
 *
 * ---------------------------------------------------------------------------
 * THE PIPELINE — BRIEF §4, in order, one function per stage
 *
 *   1  identity()      role, faction, family, size, technology, ARCHETYPE
 *   2  buildSpine()    the load path from the engines to the nose
 *   3  buildPrimary()  the two or three masses that make the silhouette
 *   4  buildDrive()    thrust axis through the centre of mass
 *   5  buildSockets()  + placeModules(): typed mounts, checked for clearance
 *   6  buildSecondary() radiators, tanks, gear, sensors
 *   7  buildAccents()  the one or two shapes that make it recognisable
 *   8  buildGreebles() last, and never to rescue a weak form
 *   ·  buildHistory()  a service life that moves geometry
 *   ·  assemble()      palette, markings, mass properties, CoM rebase, scan
 *
 * Each stage owns a named seed stream (`shipSubSeed(seed, 'spine')`, …) taken
 * from the closed `ShipSeedStage` union in `types.ts`. That is not tidiness:
 * it means adding one extra draw inside `buildGreebles` can never renumber the
 * draws inside `buildPrimary`, so a detail tweak does not reshape the hull.
 * Within a stage, sub-streams come from `sub(stageSeed, 'pods')` — never from
 * `Rng.fork`, which advances its parent and reintroduces exactly the coupling
 * the stage split removed.
 *
 * ---------------------------------------------------------------------------
 * SILHOUETTE FIRST — why there is an `HullArchetype` layer at all
 *
 * A generator that samples one fuselage and hangs parameters off it produces
 * one ship in N costumes, however wide the parameter ranges are. Aspect ratio
 * and cross-section family vary the *proportions* of a shape; they cannot
 * change the *topology*. So the first structural decision is topological:
 *
 *   monolithic      one dominant mass, tapered — courier, gunship, shuttle
 *   stacked         3–4 segments of different section FAMILIES with hard steps
 *   spine-and-pod   an exposed truss keel, pods hung along it — the freighter
 *   fork            two booms forward of a shared aft body — catamaran, tug
 *   ring            a closed hoop plus hub and spokes — colony, science
 *   slab            wide, flat planform with an off-centre island — carrier
 *   tower           the long axis is VERTICAL — refinery, station tender
 *   asymmetric      one large mass on one side only — salvager, miner
 *   cluster         several near-equal cans bundled round a core — tanker
 *
 * Those nine have genuinely different bounding boxes, different silhouettes as
 * black shapes, and different answers to "where is the mass". The role chooses
 * among them by weight, and then modifies the proportions — which is what makes
 * a freighter's cargo *be* its silhouette rather than a box bolted to a hull.
 *
 * ---------------------------------------------------------------------------
 * FUNCTION DECIDES FORM
 *
 * `ROLE_SPEC` below is the contract between "what is this ship for" and every
 * geometric decision downstream: which archetypes are plausible, how slender it
 * is, what fraction of its enclosed volume is payload, what it must carry, what
 * acceleration it is designed for. A freighter is not a courier with a bigger
 * number; it is a different topology carrying a different mass fraction at a
 * different acceleration, and every one of those falls out of this table.
 */

import { Rng, hashSeed } from '@/math/rng';

import {
  FACTIONS,
  factionRoleWeight,
  familyFor,
  lengthBeamFor,
  markingCapHeightKm,
  paletteFor,
  registryFor,
  roleById,
  sampleRange,
  shipClassName,
  technologyProfileFor,
  tryFactionById,
  wearWeightsFor,
} from './families';
import type { FactionDna, HullFamily, MassingDna, RoleSpec as FamilyRoleSpec } from './families';
import { engineRatedThrustN, shipDockingFrames, shipMassProperties, shipPhysicsProfile, shipScanLines, shipThrust } from './physics';

import {
  MODULE_SOCKET,
  ORIGIN_TOLERANCE_KM,
  SCAN_MAX_LINES,
  SHIP_GENERATION_VERSION,
  SIZE_CLASS_LENGTH_KM,
  TWIN_LOBE_MAX_SEPARATION,
  CONTAINER_LENGTH_KM,
  DECK_HEIGHT_KM,
  HATCH_WIDTH_KM,
  HUMAN_HEIGHT_KM,
  aabbRadiusFromOrigin,
  frameRight,
  makeSocketId,
  newMutFrame,
  newStationSample,
  sampleStation,
  sectionPoint,
  shipBlueprintId,
  shipSubSeed,
  sizeClassFor,
  unionAabb,
  vCross,
  vDot,
  vLength,
  vNormalize,
  volumeBounds,
  volumePathFrame,
  volumeSurfacePoint,
} from './types';

import type {
  Aabb,
  AxisTriple,
  CapStyle,
  Connection,
  ConnectionKind,
  DamageCause,
  DamageEvent,
  DamageKind,
  Displacement,
  DockingPort,
  EnginePod,
  FactionId,
  FamilyId,
  Frame,
  GeometryRef,
  Hardpoint,
  HardpointKind,
  InstanceHint,
  LandingLeg,
  LandingSystem,
  LodLevel,
  Marking,
  MarkingKind,
  MaterialProfile,
  ModuleKind,
  MutVec2,
  MutVec3,
  NozzleStyle,
  PhysicsProfile,
  PrimaryVolume,
  RGB,
  RcsGroup,
  RcsThruster,
  RenderProfile,
  RepairEvent,
  RepairKind,
  ScanProfile,
  SectionFamily,
  SectionHarmonic,
  SectionLobe,
  SectionShape,
  ShipBlueprint,
  ShipDimensions,
  ShipModule,
  ShipPalette,
  ShipRole,
  SizeClass,
  Socket,
  SocketHost,
  SocketId,
  SocketType,
  SpineChain,
  SpineExposure,
  SpineMemberStyle,
  SpineNode,
  SpineNodeKind,
  StructuralSpine,
  TargetableSubsystem,
  TechnologyProfile,
  ThreatClass,
  Vec2,
  Vec3,
  VolumeConstruction,
  VolumeId,
  VolumeKind,
  VolumeStation,
  WearWeights,
} from './types';

// ===========================================================================
// Public API
// ===========================================================================

/**
 * What the caller chooses. Only `seed` is required: everything else is derived
 * from it, so `generateShip({ seed })` is a complete request and a fleet is a
 * loop over seeds. Supplying a field pins it and lets the rest vary, which is
 * how the review shots put six roles of one faction side by side.
 */
export interface ShipParams {
  readonly seed: number;
  readonly factionId?: FactionId;
  readonly role?: ShipRole;
  readonly sizeClass?: SizeClass;
  /** Service age in years. Overrides the age the family would have chosen. */
  readonly ageYears?: number;
  /** 0 = untouched hull, 1 = a wreck that still flies. Scales damage counts. */
  readonly damageLevel?: number;
  /** 0 = neglected, 1 = kept to survey standard. The quality profile. */
  readonly maintenance?: number;
  /** Pin the version for a regression test. Defaults to SHIP_GENERATION_VERSION. */
  readonly generationVersion?: number;
}

/** Topology, decided before any dimension. See the header. */
export type HullArchetype =
  | 'monolithic'
  | 'stacked'
  | 'spine-and-pod'
  | 'fork'
  | 'ring'
  | 'slab'
  | 'tower'
  | 'asymmetric'
  | 'cluster';

/**
 * A placement the generator refused, and why.
 *
 * BRIEF §5 lists seven rules a placement must respect. Silently satisfying them
 * is not enough: a reviewer has to be able to see that the generator *tried*
 * something absurd and threw it away, otherwise a rule that never fires and a
 * rule that is not implemented look identical from outside. Every rejection is
 * recorded with the measured number that failed the test.
 */
export interface PlacementRejection {
  /** Which pipeline stage refused it. */
  readonly stage: 'propulsion' | 'sockets' | 'modules' | 'secondary' | 'accents' | 'landing';
  /** The BRIEF §5 rule, or the internal invariant, that was violated. */
  readonly rule:
    | 'exhaust-intersects-hull'
    | 'cockpit-view-blocked'
    | 'gear-not-lowest'
    | 'radiator-buried'
    | 'weapon-arc-obstructed'
    | 'docking-unreachable'
    | 'thrust-off-axis'
    | 'socket-inside-hull'
    | 'module-too-large'
    | 'overlaps-existing'
    | 'no-compatible-socket'
    /** The aft disc cannot carry the exit area the role's acceleration needs.
     *  Thrust grows as L² and mass as L³, so this is a fact about large hulls
     *  rather than a placement mistake — but it is one a reviewer must see. */
    | 'thrust-below-role-band'
    /** The orthographic silhouette closed round no daylight at all, and the
     *  generator had to add a gantry to give it a load path you can see
     *  through. Logged because a hull that needed rescuing is a hull whose
     *  archetype builder did not do its job. */
    | 'silhouette-has-no-hole'
    /** A clearance measured at mounting time no longer holds against the
     *  finished part list. See `remeasureClearances`. */
    | 'post-pass-obstructed'
    /** The role's payload is supposed to be the largest thing on the ship and
     *  the massing did not make it so. */
    | 'payload-not-dominant'
    /** The finished envelope was too stubby to read as a vessel with a
     *  direction of travel, and the bow was lengthened to give it one. */
    | 'axis-too-short'
    /** Summed nozzle exit area wanted more of the stern than structure,
     *  plumbing and radiators can spare. See `MAX_EXIT_FRACTION_OF_STERN`. */
    | 'nozzle-area-over-stern'
    /** The cockpit or bridge cannot see enough of the forward hemisphere.
     *  Measured as a solid fraction over a real fan, not as a cone scalar. */
    | 'view-cone-narrow'
    /** The LADEN centre of mass sits off the thrust line by more than the
     *  drive can trim out, so the ship tumbles when it burns loaded. */
    | 'load-out-of-trim';
  /** What was being placed. */
  readonly what: string;
  /** Where it would have gone, ship-local km. */
  readonly at: Vec3;
  /** The measured value that failed, and the threshold it had to beat. */
  readonly measured: number;
  readonly required: number;
  /** Retry index. >0 means the generator moved it and tried again. */
  readonly attempt: number;
}

/**
 * A blueprint plus the generator's own audit trail.
 *
 * This is a `ShipBlueprint` — every consumer that wants the contract type gets
 * it — with one extra plain-data field. `types.ts` is append-only and not mine
 * to edit, so the log rides on a subtype instead. It survives
 * `JSON.parse(JSON.stringify(...))` like everything else.
 */
export interface GeneratedShip extends ShipBlueprint {
  readonly archetype: HullArchetype;
  readonly placementLog: readonly PlacementRejection[];
}

// ===========================================================================
// The `families.ts` seam
//
// `families.ts` owns the faction catalogue, the hull lines and the role
// requirements. This generator never invents a proportion, a palette, a wear
// weight or a class name — it reads them, and the two interfaces below are the
// projections it works in. `requirementsFor` and `dnaFromFaction` are the only
// two functions that touch the catalogue; everything downstream sees these.
// ===========================================================================

/**
 * The visual DNA of one shipbuilding family, flattened for the generator.
 *
 * Everything here is a *bias*, not a value: the family says "this yard builds
 * faceted hulls with heavy fluting and cold plumes", and the seed decides how
 * much. `faction` and `hull` carry the full doctrine through, because the
 * spine, the drive and the markings need bands a summary would throw away.
 */
export interface ShipFamilyDna {
  readonly id: FamilyId;
  readonly factionId: FactionId;
  /** Shown in the scanner as "<name>-pattern <role>". */
  readonly name: string;
  readonly faction: FactionDna;
  readonly hull: HullFamily;
  /** Weights over the three section families in `types.ts`. */
  readonly sectionWeights: Readonly<Record<SectionFamily, number>>;
  /** Superellipse exponent band. 2 = round yard, 8 = a yard that only bends flat plate. */
  readonly exponent: Vec2;
  /** Polygon side counts this yard uses. */
  readonly polygonSides: readonly number[];
  /** Probability a volume carries a chine/flute harmonic, and its amplitude band. */
  readonly harmonicChance: number;
  readonly harmonicAmplitude: Vec2;
  /** Probability of a ventral keel lobe / dorsal spine lobe. */
  readonly keelChance: number;
  readonly dorsalChance: number;
  /** Preferred spine member styles, most-likely first. */
  readonly spineStyles: readonly SpineMemberStyle[];
  /** Nozzle styles, weighted by order. */
  readonly nozzles: readonly NozzleStyle[];
  /** 0..1 — how much this yard leaves structure showing. */
  readonly exposedStructure: Vec2;
  /** 0..1 — how tidy the yard is. Drives panel jitter and repair quality. */
  readonly discipline: number;
}

/**
 * What a role demands of the geometry, as this generator consumes it. Built by
 * `requirementsFor` from the `RoleSpec` in `families.ts` plus the topology
 * table below; nothing numeric here is invented locally.
 */
export interface ShipRoleRequirements {
  readonly role: ShipRole;
  /** Archetype weights. Absent = never. */
  readonly archetypes: readonly (readonly [HullArchetype, number])[];
  /** length / beam, role ∩ faction ∩ hull line. A tug is 2, a courier is 11. */
  readonly fineness: Vec2;
  /** height / beam. */
  readonly heightRatio: Vec2;
  /** Size classes this role is built in, weighted. */
  readonly sizes: readonly (readonly [SizeClass, number])[];
  /** Design acceleration band, m/s². Sizes the drive against the loaded mass. */
  readonly accelMs2: Vec2;
  /** Fraction of enclosed volume that is payload. A freighter is over half. */
  readonly cargoFraction: Vec2;
  /** Absolute crew complement band. */
  readonly crew: Vec2;
  /** Socket types this role must have at least one of. */
  readonly needs: readonly SocketType[];
  /** Hardware this role attracts, signature kinds weighted above required ones. */
  readonly wants: readonly (readonly [ModuleKind, number])[];
  /** Threat contribution band, 0..1. */
  readonly threat: Vec2;
  readonly threatClass: ThreatClass;
  readonly pressurisedChance: number;
  readonly atmosphereChance: number;
  readonly ageYears: Vec2;
  readonly maintenance: Vec2;
  /** What the pods/cans of a spine-and-pod or cluster hull actually are. */
  readonly payloadKind: VolumeKind;
  readonly detailDensity: Vec2;
  readonly markings: readonly MarkingKind[];
  readonly thermalSignature: Vec2;
  readonly radarSignature: Vec2;
  readonly emSignature: Vec2;
  readonly deltaVKmS: Vec2;
  readonly topSpeedKmS: Vec2;
  readonly forbiddenVolumeKinds: readonly VolumeKind[];
  /** Uppercase-safe short label for the HUD. */
  readonly label: string;
  /** One-line codex description, completed by the family name. */
  readonly blurb: string;
}
/**
 * TOPOLOGY TABLE — the one thing `families.ts` does not own.
 *
 * `RoleSpec` in `families.ts` states what a role must carry, how slender it is,
 * what fraction of it is payload and what a critic must be able to say about
 * its silhouette. What it deliberately does not state is the ship's *topology*:
 * whether the payload is inside one hull, hung off a keel, bundled round a
 * core, or spun on a ring. That decision belongs to the generator, because it
 * is a decision about how the masses are arranged rather than about what the
 * masses are — and it is the decision that stops eighteen roles becoming one
 * fuselage with eighteen sets of bolt-ons.
 *
 * Everything else in `ShipRoleRequirements` is READ from `families.ts` by
 * `requirementsFor` below. Nothing numeric is duplicated.
 */
interface RoleTopology {
  /**
   * Archetype weights. Absent = this role is never built that way.
   *
   * These are deliberately FLAT. A steeply peaked table ("freighter is
   * spine-and-pod 6, cluster 3, stacked 2, monolithic 1") reads as variety when
   * you count the archetypes the generator can reach and as monotony when you
   * fly past the traffic: half of every freighter you ever see is one shape.
   * No entry here is more than ~28% of its role's total and every role lists at
   * least five, so an unusual-but-plausible hull — a slab freighter, a ring
   * liner — is reachable at about one in ten rather than never. Implausible
   * pairings are absent (weight zero), not shaved towards uniform: a shuttle
   * with a spin ring is not rare, it is wrong.
   */
  readonly archetypes: readonly (readonly [HullArchetype, number])[];
  /** height ÷ beam, before the archetype modifier. `families.ts` gives L/H;
   *  this narrows it, because a role can be tall without being short. */
  readonly heightRatio: Vec2;
  /** What the pods, cans and racks of this role actually contain. */
  readonly payloadKind: VolumeKind;
  /**
   * Does this ship put itself on a surface? BRIEF §5 makes landing gear a named
   * placement rule, and `families.ts` only declares a `landing` socket for the
   * handful of roles that carry a full undercarriage — which left thirteen of
   * eighteen roles with no way to set down at all and verified the rule against
   * a single sample. A courier that can only ever hard-dock is not a courier.
   * Where this is true the gear is REQUIRED, and a hull that cannot fit legs
   * with clearance says so in the placement log rather than omitting them.
   */
  readonly landsOnSurfaces: boolean;
  /** How common in traffic. Sampling roles uniformly makes every third ship a
   *  capital, which destroys the size hierarchy BRIEF §8 asks for. */
  readonly frequency: number;
}

const ROLE_TOPOLOGY: Readonly<Record<ShipRole, RoleTopology>> = {
  shuttle: {
    archetypes: [['monolithic', 5], ['stacked', 4], ['slab', 3], ['asymmetric', 2], ['fork', 2], ['cluster', 2]],
    heightRatio: [0.7, 1.05], payloadKind: 'habitat', landsOnSurfaces: true, frequency: 9,
  },
  courier: {
    archetypes: [['monolithic', 5], ['stacked', 4], ['fork', 3], ['slab', 3], ['asymmetric', 2], ['cluster', 1]],
    heightRatio: [0.45, 0.8], payloadKind: 'cargo-bay', landsOnSurfaces: true, frequency: 10,
  },
  survey: {
    archetypes: [['monolithic', 4], ['stacked', 4], ['fork', 3], ['ring', 6], ['asymmetric', 2], ['cluster', 2], ['tower', 1]],
    heightRatio: [0.6, 0.95], payloadKind: 'habitat', landsOnSurfaces: true, frequency: 7,
  },
  freighter: {
    archetypes: [['spine-and-pod', 5], ['cluster', 4], ['stacked', 3], ['monolithic', 3], ['slab', 2], ['asymmetric', 2], ['fork', 1]],
    heightRatio: [0.7, 1.15], payloadKind: 'cargo-bay', landsOnSurfaces: false, frequency: 12,
  },
  tanker: {
    archetypes: [['cluster', 5], ['spine-and-pod', 4], ['monolithic', 4], ['stacked', 3], ['tower', 2], ['slab', 1]],
    heightRatio: [0.85, 1.15], payloadKind: 'tank', landsOnSurfaces: false, frequency: 6,
  },
  miner: {
    archetypes: [['asymmetric', 5], ['spine-and-pod', 4], ['fork', 3], ['tower', 3], ['cluster', 3], ['monolithic', 2]],
    heightRatio: [0.9, 1.4], payloadKind: 'cargo-rack', landsOnSurfaces: true, frequency: 8,
  },
  prospector: {
    archetypes: [['monolithic', 4], ['asymmetric', 4], ['stacked', 3], ['fork', 3], ['cluster', 2], ['tower', 2], ['slab', 1]],
    heightRatio: [0.8, 1.2], payloadKind: 'cargo-rack', landsOnSurfaces: true, frequency: 7,
  },
  refinery: {
    archetypes: [['tower', 5], ['cluster', 4], ['spine-and-pod', 4], ['asymmetric', 3], ['stacked', 2], ['ring', 3]],
    heightRatio: [1.2, 2.0], payloadKind: 'machinery', landsOnSurfaces: false, frequency: 4,
  },
  salvager: {
    archetypes: [['asymmetric', 5], ['spine-and-pod', 4], ['fork', 3], ['cluster', 3], ['stacked', 3], ['tower', 1]],
    heightRatio: [0.85, 1.35], payloadKind: 'cargo-rack', landsOnSurfaces: true, frequency: 6,
  },
  tug: {
    archetypes: [['monolithic', 5], ['fork', 4], ['stacked', 3], ['asymmetric', 3], ['cluster', 2], ['slab', 2]],
    heightRatio: [0.9, 1.3], payloadKind: 'machinery', landsOnSurfaces: true, frequency: 6,
  },
  science: {
    archetypes: [['ring', 6], ['fork', 4], ['monolithic', 3], ['stacked', 3], ['cluster', 3], ['tower', 2], ['asymmetric', 1]],
    heightRatio: [0.7, 1.2], payloadKind: 'habitat', landsOnSurfaces: true, frequency: 6,
  },
  liner: {
    archetypes: [['stacked', 4], ['monolithic', 4], ['ring', 6], ['spine-and-pod', 3], ['slab', 2], ['cluster', 2]],
    heightRatio: [0.8, 1.25], payloadKind: 'habitat', landsOnSurfaces: false, frequency: 4,
  },
  colony: {
    archetypes: [['cluster', 5], ['ring', 7], ['spine-and-pod', 4], ['stacked', 3], ['tower', 2], ['asymmetric', 1]],
    heightRatio: [0.95, 1.5], payloadKind: 'habitat', landsOnSurfaces: false, frequency: 3,
  },
  patrol: {
    archetypes: [['monolithic', 5], ['stacked', 4], ['fork', 3], ['slab', 3], ['asymmetric', 2], ['cluster', 1]],
    heightRatio: [0.5, 0.9], payloadKind: 'habitat', landsOnSurfaces: true, frequency: 6,
  },
  gunship: {
    archetypes: [['monolithic', 4], ['stacked', 4], ['slab', 5], ['fork', 3], ['asymmetric', 2], ['cluster', 1]],
    heightRatio: [0.45, 0.85], payloadKind: 'machinery', landsOnSurfaces: true, frequency: 4,
  },
  carrier: {
    archetypes: [['slab', 5], ['stacked', 4], ['spine-and-pod', 3], ['monolithic', 3], ['cluster', 2], ['fork', 2], ['tower', 1]],
    heightRatio: [0.3, 0.55], payloadKind: 'cargo-bay', landsOnSurfaces: false, frequency: 1,
  },
  'station-tender': {
    archetypes: [['tower', 5], ['asymmetric', 4], ['cluster', 4], ['spine-and-pod', 3], ['fork', 2], ['stacked', 2], ['ring', 2]],
    heightRatio: [1.0, 1.7], payloadKind: 'machinery', landsOnSurfaces: true, frequency: 7,
  },
  derelict: {
    archetypes: [
      ['spine-and-pod', 3], ['monolithic', 3], ['asymmetric', 3], ['stacked', 3],
      ['cluster', 3], ['fork', 2], ['ring', 3], ['tower', 2], ['slab', 1],
    ],
    heightRatio: [0.6, 1.4], payloadKind: 'cargo-bay', landsOnSurfaces: false, frequency: 4,
  },
};

/**
 * How each yard's manufacturing doctrine biases the massing solution.
 *
 * This is the missing half of the faction contrast test. `families.ts` already
 * says, in prose and in numbers, that Kessler welds flat plate into rectangular
 * blocks, that Sillane pours a single long monocoque shell, and that Ossuary
 * bolts salvaged sections together with no symmetry policy — and none of it
 * reached the massing stage, because the archetype was drawn from the ROLE
 * table alone. Same seed, three factions, and the generator returned the same
 * hull three times: the shot's own FAILS IF, "the three differ only in paint".
 *
 * Each entry multiplies the role's weight for that archetype. A role weight of
 * zero stays zero — a culture's habits cannot make it build a shape its trade
 * forbids — so this narrows the role's list rather than replacing it.
 *
 * The numbers are read off the doctrine, not tuned to taste:
 *
 *   Kessler   a press cannot be taken to a mining station, so nothing is a
 *             compound curve: flat-sided blocks, stacks and slabs. It builds a
 *             keel-and-pod hull reluctantly, because an open truss is a thing
 *             you cannot walk on.
 *   Sillane   a cast monocoque is one continuous shell. It cannot be a bundle
 *             of parallel capsules, and it will not be a random assembly, so
 *             cluster and asymmetric are all but excluded.
 *   Ossuary   salvage: whatever came off the last hull, bolted where it fits.
 *             Asymmetry, clusters and forks are the native language; a single
 *             poured monolith is the one thing a breaker's yard cannot make.
 */
/** No archetype a role permits may fall below this share of that role's table. */
const ARCHETYPE_FLOOR_SHARE = 0.11;
/** …and the role's own first choice keeps at least this share of it. */
const ARCHETYPE_TOP_SHARE = 0.45;

const FACTION_ARCHETYPE_BIAS: Readonly<Record<FactionId, Partial<Record<HullArchetype, number>>>> = {
  kessler: {
    monolithic: 1.6, stacked: 2.5, slab: 2.5, tower: 1.2, fork: 1.1,
    'spine-and-pod': 0.4, cluster: 0.5, asymmetric: 0.45, ring: 0.9,
  },
  sillane: {
    monolithic: 2.5, 'spine-and-pod': 2.0, ring: 2.4, tower: 1.1, stacked: 0.8,
    slab: 0.7, fork: 0.7, cluster: 0.2, asymmetric: 0.2,
  },
  ossuary: {
    asymmetric: 3.0, cluster: 2.8, fork: 2.2, 'spine-and-pod': 1.5, tower: 1.4,
    stacked: 0.7, slab: 0.5, ring: 0.9, monolithic: 0.3,
  },
};

/** The role's archetype table, narrowed by the yard's doctrine. See above. */
function archetypesFor(
  role: readonly (readonly [HullArchetype, number])[],
  factionId: FactionId,
): readonly (readonly [HullArchetype, number])[] {
  const bias = FACTION_ARCHETYPE_BIAS[factionId];
  const out: [HullArchetype, number][] = [];
  let total = 0;
  for (const [a, w] of role) {
    const v = w * (bias[a] ?? 1);
    total += v;
    out.push([a, v]);
  }
  // A doctrine that zeroed everything the role allows would leave nothing to
  // draw from; fall back to the role's own table rather than to a default hull.
  if (total <= 0) return role;

  // A FLOOR, because coverage a player never sees is not coverage.
  //
  // The generator used all nine archetypes and reported it as a pass, while
  // over 200 seeds ring came out 9 times and tower 7 — 4.5% and 3.5%. Across a
  // five-hull fleet the chance of meeting either is under one in five, so the
  // two shapes with the strongest silhouette read appeared in none of the
  // review captures in two consecutive rounds. Multiplying the role weight by
  // the yard's doctrine is right, but a 0.4 and a 0.2 compounding on a weight
  // of 1 puts an archetype below the noise floor of the draw.
  //
  // So a yard's dislike can make a shape UNUSUAL and cannot make it unseen: no
  // entry the role permits falls under this share of its own table. The role's
  // zeroes are untouched — a culture's habits cannot make it build a shape its
  // trade forbids, and that stays the only way to reach zero.
  // The role's OWN first choice is guaranteed, before the yard's habits are
  // allowed to talk it out of it. This is what puts a ring on a colony ship
  // and a tower on a refinery: those two archetypes are named as the top entry
  // by exactly the roles whose trade calls for them, and nowhere else, so
  // guaranteeing the role's first choice is the same statement as "gate ring
  // and tower to the roles that need them, and then let those roles have them".
  let topI = 0;
  for (let i = 1; i < role.length; i++) if (role[i][1] > role[topI][1]) topI = i;
  const guaranteed = total * ARCHETYPE_TOP_SHARE;
  if (out[topI][1] < guaranteed) {
    const need = guaranteed - out[topI][1];
    let rest = total - out[topI][1];
    if (rest > need) {
      const k = 1 - need / rest;
      for (let i = 0; i < out.length; i++) if (i !== topI) out[i][1] *= k;
      out[topI][1] = guaranteed;
    }
  }

  const floor = total * ARCHETYPE_FLOOR_SHARE;
  let bumped = 0;
  for (const e of out) if (e[1] > 0 && e[1] < floor) { bumped += floor - e[1]; e[1] = floor; }
  if (bumped > 0) {
    // Pay for the floor out of the entries that are above it, in proportion, so
    // the shape of the yard's preference survives the correction.
    let above = 0;
    for (const e of out) if (e[1] > floor) above += e[1] - floor;
    if (above > bumped) {
      const k = 1 - bumped / above;
      for (const e of out) if (e[1] > floor) e[1] = floor + (e[1] - floor) * k;
    }
  }
  return out;
}

/** Threat band per `ThreatClass`, for the scan profile. */
const THREAT_BAND: Readonly<Record<ThreatClass, Vec2>> = {
  derelict: [0, 0],
  unarmed: [0, 0.08],
  defensive: [0.08, 0.3],
  armed: [0.3, 0.62],
  warship: [0.6, 1.0],
};

/**
 * Build the generator's requirement view from the `families.ts` catalogue.
 *
 * The intersections matter: a role's length/beam band and a faction's are both
 * real constraints, and `lengthBeamFor` already narrows one against the other.
 * Height comes out of the faction's length/height band divided through by the
 * fineness, so a culture that builds tall ships builds tall ships in every role
 * it serves rather than only where a table happens to say so.
 */
function requirementsFor(faction: FactionDna, role: FamilyRoleSpec, family: HullFamily): ShipRoleRequirements {
  const topo = ROLE_TOPOLOGY[role.id];
  const fineness = lengthBeamFor(faction, role, family);
  const lh = faction.proportion.lengthHeight;
  // H/B = (L/B) / (L/H). Both bands are honest, so the widest consistent band
  // is low/high and high/low, then narrowed by the role's own topology band.
  const hFromFaction: Vec2 = [fineness[0] / Math.max(1e-6, lh[1]), fineness[1] / Math.max(1e-6, lh[0])];
  const heightRatio: Vec2 = [
    Math.max(topo.heightRatio[0], Math.min(hFromFaction[0], topo.heightRatio[1])),
    Math.min(topo.heightRatio[1], Math.max(hFromFaction[1], topo.heightRatio[0])),
  ];

  const needs: SocketType[] = [];
  for (const d of role.sockets) if (d.min >= 1) needs.push(d.type);

  // Signature modules outweigh required ones, because BRIEF §4's "the role must
  // be readable without a label" is a statement about what is BIG, not about
  // what is present. `families.ts` says so in its own words on `signatureModules`.
  const wants: (readonly [ModuleKind, number])[] = [];
  for (const k of role.signatureModules) if (!role.forbiddenModules.includes(k)) wants.push([k, 5]);
  for (const k of role.requiredModules) if (!role.forbiddenModules.includes(k) && !role.signatureModules.includes(k)) wants.push([k, 3]);
  if (wants.length === 0) wants.push(['service-hatch', 1]);

  // What this role's payload IS.
  //
  // The topology table's answer wins, and the role's `requiredVolumeKinds` is
  // only a fallback when the topology's kind is forbidden. It used to be the
  // other way round, and a courier — whose required kinds list a propellant
  // tank, as every ship's would — ended up with 'tank' as its PAYLOAD. Its
  // parcels then had nowhere to go: `physics.cargoVolumeM3` came out as
  // literally zero on all eight sampled seeds, so the scan the HUD renders said
  // a parcel runner carries nothing.
  const PAYLOADS: readonly VolumeKind[] = ['cargo-bay', 'cargo-rack', 'tank', 'habitat', 'machinery', 'pod'];
  const named = role.forbiddenVolumeKinds.includes(topo.payloadKind)
    ? role.requiredVolumeKinds.find((k) => PAYLOADS.includes(k) && !role.forbiddenVolumeKinds.includes(k))
    : undefined;

  return {
    role: role.id,
    archetypes: topo.archetypes,
    fineness,
    heightRatio,
    sizes: role.sizeClasses.map((s) => [s, 1] as const),
    accelMs2: role.accelMs2,
    cargoFraction: role.cargoFraction,
    crew: role.crew,
    needs,
    wants,
    threat: THREAT_BAND[role.threatClass],
    threatClass: role.threatClass,
    pressurisedChance: role.pressurised ? 1 : 0,
    atmosphereChance: role.lands ? 1 : 0,
    ageYears: faction.construction.ageYears,
    maintenance: faction.construction.maintenance,
    payloadKind: named ?? topo.payloadKind,
    detailDensity: role.detailDensity,
    markings: role.markings,
    thermalSignature: role.thermalSignature,
    radarSignature: role.radarSignature,
    emSignature: role.emSignature,
    deltaVKmS: role.deltaVKmS,
    topSpeedKmS: role.topSpeedKmS,
    forbiddenVolumeKinds: role.forbiddenVolumeKinds,
    label: role.label,
    blurb: role.summary,
  };
}

/**
 * Proportion modifiers per archetype, applied on top of the role's bands.
 *
 * These are what stop the archetype from being cosmetic. A `tower` hull is not
 * a monolithic hull with a mast: `fineness × 0.55` and `heightRatio × 2.4`
 * makes it genuinely taller than it is long, and every socket, leg and radiator
 * placed afterwards inherits that box.
 */
const ARCHETYPE_PROPORTION: Readonly<Record<HullArchetype, { readonly fineness: number; readonly height: number }>> = {
  monolithic: { fineness: 1.0, height: 1.0 },
  stacked: { fineness: 0.95, height: 1.05 },
  'spine-and-pod': { fineness: 1.15, height: 1.05 },
  fork: { fineness: 0.8, height: 0.8 },
  ring: { fineness: 0.5, height: 1.7 },
  slab: { fineness: 0.62, height: 0.4 },
  tower: { fineness: 0.55, height: 2.4 },
  asymmetric: { fineness: 0.85, height: 1.1 },
  cluster: { fineness: 0.78, height: 1.2 },
};
/**
 * Build the generator's DNA view from a faction and one of its hull lines.
 *
 * A flattening, not a reinterpretation: every field is a projection of
 * `FactionDna`, and `faction`/`hull` are carried through so the stages that
 * need the full doctrine — the spine, the drive, the radiators, the markings —
 * can read it directly instead of through a lossy summary.
 */
function dnaFromFaction(faction: FactionDna, hull: HullFamily): ShipFamilyDna {
  const s = faction.surface;
  const weights: Record<SectionFamily, number> = { superellipse: 0, polygon: 0, 'twin-lobe': 0 };
  for (const [f, w] of s.sectionFamilies) weights[f] = w;
  // A zeroed vocabulary would make `pickWeighted` fall through to the last
  // entry forever, so a faction that somehow declares nothing gets the default.
  if (weights.superellipse + weights.polygon + weights['twin-lobe'] <= 0) weights.superellipse = 1;

  const harmMid = (s.harmonicCount[0] + s.harmonicCount[1]) * 0.5;
  const lobeMid = (s.lobeCount[0] + s.lobeCount[1]) * 0.5;

  return {
    id: hull.id,
    factionId: faction.id,
    name: faction.shortName,
    faction,
    hull,
    sectionWeights: weights,
    exponent: s.exponent,
    polygonSides: s.polygonSides.length > 0 ? s.polygonSides : [4, 6],
    // The faction states a lobe/harmonic COUNT band; the generator asks a
    // per-volume yes/no. A mean count of 1.5 harmonics is a 75% chance that any
    // one volume carries one, which preserves the culture's density without
    // pretending a volume can have half a chine.
    harmonicChance: clamp01(harmMid * 0.75),
    harmonicAmplitude: s.harmonicAmplitude,
    keelChance: clamp01(lobeMid * 0.45),
    dorsalChance: clamp01(lobeMid * 0.35),
    spineStyles: faction.structure.member === faction.structure.heavyMember
      ? [faction.structure.member]
      : [faction.structure.member, faction.structure.heavyMember],
    nozzles: [faction.propulsion.nozzle],
    exposedStructure: faction.construction.exposedStructure,
    // Tolerance jitter is how badly parts line up; discipline is its inverse,
    // and it is what decides whether a patch is rectangular and a rivet row
    // straight.
    discipline: clamp01(1 - faction.construction.toleranceJitter),
  };
}

/**
 * Which yard built this hull.
 *
 * Weighted by the faction's own appetite for the role, so a culture that never
 * builds carriers never appears on one — `factionRoleWeight` returns 0 for
 * everything in `neverBuilds`, and a role nobody builds falls back to the whole
 * catalogue rather than throwing, because a fleet generator must always be able
 * to produce a ship.
 */
function pickFaction(rng: Rng, role: ShipRole, factionId: FactionId | undefined): FactionDna {
  if (factionId !== undefined) {
    const named = tryFactionById(factionId);
    if (named) return named;
  }
  const able = FACTIONS.filter((f) => factionRoleWeight(f, role) > 0);
  const pool = able.length > 0 ? able : FACTIONS;
  return pickWeighted(rng, pool.map((f) => [f, Math.max(0.01, factionRoleWeight(f, role))] as const));
}

// ===========================================================================
// Small maths. Deliberately local: `gen/` cannot import three.js, and these
// are the four functions every stage below would otherwise re-derive.
// ===========================================================================

const TAU = Math.PI * 2;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

function smoothstep(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/** A child seed for a sub-stream inside one stage. Never `Rng.fork` — see header. */
function sub(seed: number, salt: string): number {
  return hashSeed(seed >>> 0, salt);
}

/** Metres, for a log line. Blueprints are in km; humans are not. */
function fmtKm(km: number): string {
  return `${(km * 1000).toFixed(1)} m`;
}

/** Uniform in a `Vec2` band. The role and faction bands are all written this way. */
function band(rng: Rng, b: Vec2): number {
  return rng.range(b[0], b[1]);
}

/** Weighted pick over `[value, weight]` pairs, the shape the tables above use. */
function pickWeighted<T>(rng: Rng, pairs: readonly (readonly [T, number])[]): T {
  let total = 0;
  for (const p of pairs) total += p[1];
  let r = rng.next() * total;
  for (const p of pairs) {
    r -= p[1];
    if (r <= 0) return p[0];
  }
  return pairs[pairs.length - 1][0];
}

/** Log-uniform inside a band. Length bands span a decade, so uniform would bunch. */
function logBand(rng: Rng, b: Vec2): number {
  const lo = Math.log(Math.max(1e-9, b[0]));
  const hi = Math.log(Math.max(1e-9, b[1]));
  return Math.exp(lerp(lo, hi, rng.next()));
}

const FWD_Z: Vec3 = [0, 0, 1];
const UP_Y: Vec3 = [0, 1, 0];

/** A frame with the ship's default basis, translated. Most volumes want this. */
function axialFrame(x: number, y: number, z: number): Frame {
  return { origin: [x, y, z], forward: FWD_Z, up: UP_Y };
}

function frameAt(origin: Vec3, forward: Vec3, up: Vec3): Frame {
  const f = vNormalize(forward);
  // Re-orthogonalise `up` against `forward` so a frame can never hold a skew
  // basis — `frameRight` assumes perpendicularity and silently shears if not.
  const d = vDot(up, f);
  const u = vNormalize([up[0] - f[0] * d, up[1] - f[1] * d, up[2] - f[2] * d]);
  if (vLength(u) < 0.5) {
    // `up` was parallel to `forward`. Fall back to whichever ship axis is not.
    const alt: Vec3 = Math.abs(f[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
    const d2 = vDot(alt, f);
    return { origin, forward: f, up: vNormalize([alt[0] - f[0] * d2, alt[1] - f[1] * d2, alt[2] - f[2] * d2]) };
  }
  return { origin, forward: f, up: u };
}

// ===========================================================================
// Geometry queries
//
// Everything here is built on `volumeSurfacePoint` from `types.ts`, which is
// the single definition of where the hull surface is. Nothing in this file
// re-derives a section; if the socket placer and the geometry builder ever
// disagree about where the skin is, it will not be because of this module.
//
// The scratch objects are module-level on purpose: `volumeContains` runs on the
// order of 10^5 times per ship and allocating a station sample per call is the
// difference between a 6 ms hull and a 60 ms one. Generation is single-threaded
// and re-entrancy is not a property anything here needs.
// ===========================================================================

const _q = newStationSample();
const _qFlat = newStationSample();
const _qf = newMutFrame();
const _qa: MutVec3 = [0, 0, 0];
const _qb: MutVec3 = [0, 0, 0];
const _qc: MutVec3 = [0, 0, 0];
const _qd: MutVec3 = [0, 0, 0];
const _qs: MutVec2 = [0, 0];

/**
 * Polar radius of the unit section at `theta`, with the ventral flatten
 * removed.
 *
 * The flatten is a post-scale on y (`sectionPoint` applies it last), so a
 * containment test has to undo it on the query point rather than fold it into
 * the radius — otherwise a flat-bellied hull reports every ventral point as
 * outside itself.
 */
function sectionRadius(shape: SectionShape, s: typeof _q, theta: number): number {
  _qFlat.t = s.t;
  _qFlat.exponent = s.exponent;
  _qFlat.chamfer = s.chamfer;
  _qFlat.lobeSeparation = s.lobeSeparation;
  _qFlat.ventralFlatten = 1;
  // The `out` argument is not optional here even though it defaults: this runs
  // on the order of 10^5 times per hull and letting `sectionPoint` allocate its
  // own pair puts the whole generator in the garbage collector.
  const p = sectionPoint(shape, _qFlat, theta, _qs);
  return Math.hypot(p[0], p[1]);
}

/**
 * The run parameter of the point on a volume's path nearest to `p`.
 *
 * Linear paths solve in closed form. Arcs are searched: 24 samples then three
 * bisection refinements, which lands within 0.1% of a ring's circumference —
 * far finer than any clearance test needs and far cheaper than an analytic
 * solve that would have to handle the degenerate straight-arc case.
 */
function nearestT(v: PrimaryVolume, p: Vec3): number {
  if (v.path.kind === 'linear') {
    const f = v.frame;
    const dz = (p[0] - f.origin[0]) * f.forward[0] + (p[1] - f.origin[1]) * f.forward[1] + (p[2] - f.origin[2]) * f.forward[2];
    return v.path.length > 1e-9 ? dz / v.path.length : 0;
  }
  let bestT = 0;
  let bestD = Infinity;
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    volumePathFrame(v, t, _qf);
    const dx = p[0] - _qf.origin[0];
    const dy = p[1] - _qf.origin[1];
    const dz = p[2] - _qf.origin[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; bestT = t; }
  }
  let step = 1 / 24;
  for (let k = 0; k < 3; k++) {
    step *= 0.5;
    for (const t of [bestT - step, bestT + step]) {
      if (t < 0 || t > 1) continue;
      volumePathFrame(v, t, _qf);
      const dx = p[0] - _qf.origin[0];
      const dy = p[1] - _qf.origin[1];
      const dz = p[2] - _qf.origin[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; bestT = t; }
    }
  }
  return bestT;
}

/**
 * Is `p` inside this volume? `pad` inflates the section radius, so `pad = 0.15`
 * asks "is it within 15% of the skin", which is how a socket keeps its module
 * off the plating.
 *
 * Exact because the section is star-shaped about its centre by construction
 * (`types.ts`): a point is inside exactly when its radius at its own angle is
 * less than the section's, with no ray casting and no tessellation.
 */
function volumeContains(v: PrimaryVolume, p: Vec3, pad = 0): boolean {
  const t = nearestT(v, p);
  if (t < 0 || t > 1) return false;
  sampleStation(v.stations, t, _q);
  if (_q.halfWidth < 1e-9 || _q.halfHeight < 1e-9) return false;
  volumePathFrame(v, t, _qf);
  const right = frameRight(_qf, _qa);
  const rx = p[0] - _qf.origin[0];
  const ry = p[1] - _qf.origin[1];
  const rz = p[2] - _qf.origin[2];
  // A point off the path plane (radially outside a ring's tube) still has to be
  // rejected, so the along-path component is folded back in for arcs.
  const alongF = rx * _qf.forward[0] + ry * _qf.forward[1] + rz * _qf.forward[2];
  if (v.path.kind === 'arc' && Math.abs(alongF) > _q.halfWidth * 1.5) return false;
  let nx = (rx * right[0] + ry * right[1] + rz * right[2] - _q.offsetX) / _q.halfWidth;
  let ny = (rx * _qf.up[0] + ry * _qf.up[1] + rz * _qf.up[2] - _q.offsetY) / _q.halfHeight;
  if (ny < 0) ny /= clamp(_q.ventralFlatten, 0.05, 1);
  const rad = Math.hypot(nx, ny);
  if (rad < 1e-9) return true;
  return rad <= sectionRadius(v.shape, _q, Math.atan2(ny, nx)) * (1 + pad);
}

/** Outward unit normal of a volume's surface at (t, θ), by central difference. */
function surfaceNormal(v: PrimaryVolume, t: number, theta: number, out: MutVec3 = [0, 0, 0]): MutVec3 {
  const dt = 0.004;
  const dth = 0.02;
  const t0 = clamp(t - dt, 0, 1);
  const t1 = clamp(t + dt, 0, 1);
  volumeSurfacePoint(v, t0, theta, _qa);
  volumeSurfacePoint(v, t1, theta, _qb);
  volumeSurfacePoint(v, t, theta - dth, _qc);
  volumeSurfacePoint(v, t, theta + dth, _qd);
  const du: Vec3 = [_qb[0] - _qa[0], _qb[1] - _qa[1], _qb[2] - _qa[2]];
  const dv: Vec3 = [_qd[0] - _qc[0], _qd[1] - _qc[1], _qd[2] - _qc[2]];
  vNormalize(vCross(dv, du, out), out);
  // Orientation: the section is star-shaped, so "away from the path axis" is an
  // unambiguous outward test and does not depend on the cross-product order
  // surviving a degenerate station.
  volumeSurfacePoint(v, t, theta, _qa);
  volumePathFrame(v, t, _qf);
  const ax = _qa[0] - _qf.origin[0];
  const ay = _qa[1] - _qf.origin[1];
  const az = _qa[2] - _qf.origin[2];
  if (out[0] * ax + out[1] * ay + out[2] * az < 0) {
    out[0] = -out[0]; out[1] = -out[1]; out[2] = -out[2];
  }
  if (vLength(out) < 0.5) { out[0] = ax; out[1] = ay; out[2] = az; vNormalize(out, out); }
  return out;
}

/**
 * AABB per volume, cached BY INDEX.
 *
 * `volumeBounds` samples 408 surface points, so caching is not optional. The
 * cache is index-aligned rather than a map keyed by id because it is read
 * inside the clearance sweeps — tens of thousands of times per hull — and a
 * string hash per read is measurable there. Volumes are only ever appended and
 * replaced in place, so an index is stable for the life of the context.
 */
/**
 * Everything the clearance sweeps read, and nothing else.
 *
 * `Ctx` satisfies this structurally, so the pipeline passes itself. The reason
 * it is named separately is that `shipSelfTest` has to run the same sweeps
 * against a FINISHED blueprint — the §5 verdicts have to be measured on the
 * ship that shipped, not re-derived from a build context that no longer
 * exists — and a reviewer measuring with a second implementation of the same
 * test is how the reviewer and the generator come to disagree.
 */
interface ClearanceView {
  readonly volumes: readonly PrimaryVolume[];
  readonly modules: readonly ShipModule[];
  readonly bounds: (Aabb | undefined)[];
  readonly moduleBounds: (Aabb | undefined)[];
}

function boundsAt(ctx: ClearanceView, i: number): Aabb {
  const hit = ctx.bounds[i];
  if (hit !== undefined) return hit;
  const b = volumeBounds(ctx.volumes[i]);
  ctx.bounds[i] = b;
  return b;
}

function boundsOf(ctx: ClearanceView, v: PrimaryVolume): Aabb {
  const i = ctx.volumes.indexOf(v);
  return i >= 0 ? boundsAt(ctx, i) : volumeBounds(v);
}

/**
 * Axis-aligned bound of a module's oriented box, cached and index-aligned with
 * `ctx.modules`. Same contract as `boundsAt`: modules are only appended, and
 * `applyShift` translates the cache rather than dropping it.
 */
function moduleBoundsAt(ctx: ClearanceView, i: number): Aabb {
  const hit = ctx.moduleBounds[i];
  if (hit !== undefined) return hit;
  const m = ctx.modules[i];
  const f = m.frame;
  const r = frameRight(f, [0, 0, 0]);
  const h = m.halfExtents;
  const ex = Math.abs(r[0]) * h[0] + Math.abs(f.up[0]) * h[1] + Math.abs(f.forward[0]) * h[2];
  const ey = Math.abs(r[1]) * h[0] + Math.abs(f.up[1]) * h[1] + Math.abs(f.forward[1]) * h[2];
  const ez = Math.abs(r[2]) * h[0] + Math.abs(f.up[2]) * h[1] + Math.abs(f.forward[2]) * h[2];
  const b: Aabb = {
    min: [f.origin[0] - ex, f.origin[1] - ey, f.origin[2] - ez],
    max: [f.origin[0] + ex, f.origin[1] + ey, f.origin[2] + ez],
  };
  ctx.moduleBounds[i] = b;
  return b;
}

const _obb: MutVec3 = [0, 0, 0];

/** Is `p` inside the module's own oriented box? */
function moduleContains(m: ShipModule, p: Vec3): boolean {
  const f = m.frame;
  _obb[0] = p[0] - f.origin[0];
  _obb[1] = p[1] - f.origin[1];
  _obb[2] = p[2] - f.origin[2];
  const r = frameRight(f, [0, 0, 0]);
  const h = m.halfExtents;
  if (Math.abs(_obb[0] * r[0] + _obb[1] * r[1] + _obb[2] * r[2]) > h[0]) return false;
  if (Math.abs(_obb[0] * f.up[0] + _obb[1] * f.up[1] + _obb[2] * f.up[2]) > h[1]) return false;
  return Math.abs(_obb[0] * f.forward[0] + _obb[1] * f.forward[1] + _obb[2] * f.forward[2]) <= h[2];
}


const _mp: MutVec3 = [0, 0, 0];

/**
 * Sample count along a clearance sweep. Twenty steps of an exact containment
 * test gives a distance accurate to 5% of the sweep — an order of magnitude
 * finer than the clearances any of the BRIEF §5 rules turn on.
 */
const CLEARANCE_STEPS = 20;

/**
 * The largest single bell a yard will roll, as a fraction of the aft section.
 *
 * A jig scales with the ships a yard builds, but not without limit: past about
 * three fifths of the aft radius the mandrel, the regenerative cooling and the
 * gimbal ring all stop being buildable, and every real high-thrust vehicle
 * answers the problem the same way — another bell off the same jig, in a ring.
 * That is what makes engine COUNT a function of thrust: required exit area
 * grows as L³ with the mass, a single throat only as L², so the number of them
 * has to climb. Without this bound the count read backwards against mass.
 */
const MAX_BELL_FRACTION_OF_AFT = 0.6;

/**
 * How much of the stern the SUMMED exit area may take.
 *
 * `MAX_BELL_FRACTION_OF_AFT` bounds one bell; nothing bounded the battery, so a
 * hull that could not make its role's acceleration answered by growing every
 * bell at once until the tail was a wall of nozzle — 92% of beam × height on a
 * heavy courier, 81% on a heavy shuttle, 70% on a heavy miner. Structure,
 * plumbing, the thrust frame and the radiators that reject the drive's own
 * waste heat all live in the same section; a third of it is a generous share
 * and it is the difference between a ship with engines and an engine with a
 * ship attached.
 */
const MAX_EXIT_FRACTION_OF_STERN = 0.35;

/**
 * Projected area one radiator slab must present, as a fraction of the hull's
 * side profile, for a yard whose thermal doctrine is flat panels in mirrored
 * pairs. Ten per cent of the profile per slab is what turns "there are
 * radiators on it somewhere" into "that is the ship with the two slabs".
 */
const SLAB_FRACTION_OF_PROFILE = 0.055;

/**
 * How much heavier a hull gets between stage 4 and the finished blueprint.
 *
 * Measured over 200 mixed seeds: the modules, the payload rack, the radiators,
 * the quads and the gear together roughly double the mass of the primary
 * volumes the drive is sized against. See `buildDrive`.
 */
const OUTFIT_MASS_GROWTH = 2.1;

/**
 * Share of a hull's dry mass the attitude quads may cost.
 *
 * See `retuneRcs`: `physics.ts` prices a nozzle at 10 kg/kN, which makes the
 * sizing law a fixed point that DIVERGES on every hull this generator builds —
 * a heavier quad is a heavier ship is a larger moment of inertia. Without a
 * bound the solver simply runs to the clamp, and a courier came out with two
 * thirds of its dry mass in attitude plumbing. A third is still a great deal of
 * hardware and it is deliberately generous, because the alternative to spending
 * it is a hull that cannot turn; where even a third will not buy the design
 * rate, `retuneRcs` says so in the placement log.
 */
const RCS_MASS_FRACTION = 0.35;

let _slabT0 = 0;
let _slabT1 = 0;

/** Ray/AABB overlap over [0, maxDist]; the interval lands in `_slabT0/_slabT1`. */
function raySlab(o: Vec3, d: Vec3, b: Aabb, maxDist: number): boolean {
  let t0 = 0;
  let t1 = maxDist;
  for (let a = 0; a < 3; a++) {
    const da = d[a];
    if (Math.abs(da) < 1e-12) {
      if (o[a] < b.min[a] || o[a] > b.max[a]) return false;
      continue;
    }
    const inv = 1 / da;
    let n = (b.min[a] - o[a]) * inv;
    let f = (b.max[a] - o[a]) * inv;
    if (n > f) { const tmp = n; n = f; f = tmp; }
    if (n > t0) t0 = n;
    if (f < t1) t1 = f;
    if (t0 > t1) return false;
  }
  _slabT0 = t0;
  _slabT1 = t1;
  return true;
}

/**
 * Free distance along `dir` from `origin` before something is in the way.
 *
 * Marched rather than solved: the section families admit a closed-form ray
 * intersection only for the superellipse, and 20 steps of a containment test
 * that is itself exact gives a distance accurate to 5% of the sweep — an order
 * of magnitude finer than the clearances any of the BRIEF §5 rules turn on.
 *
 * MODULES ARE PART OF THE SHIP. This used to march through the primary volumes
 * alone, and over 200 seeds a hull averages 13 volumes and 20 modules — so
 * about sixty per cent of the finished ship was invisible to every one of the
 * BRIEF §5 sweeps. `exhaust-clear`, `view-cone`, `field-of-fire` and
 * `approach-corridor` all reported OK because they were measuring a hull
 * consisting of nothing but its primary masses: a cockpit with a cargo pod
 * bolted in front of it, a weapon firing through a comms mast and a docking
 * port with a radiator across its corridor all passed. Modules that ARE swept
 * volumes are skipped here because the volume loop already has them.
 */
function clearanceAlong(ctx: ClearanceView, origin: Vec3, dir: Vec3, maxDist: number, skip: VolumeId | null, skip2: string | null = null): number {
  const steps = CLEARANCE_STEPS;
  const step = maxDist / steps;
  // The first sample index at which anything is in the way. Searched part by
  // part rather than sample by sample, and this is not a rewrite for its own
  // sake: the sample-major form ran the containment test for every part at
  // every one of the twenty stations, and a ray that clears the ship — the
  // common case, and the expensive one, because it never exits early — paid for
  // all of them. A slab test against the part's cached box first says which
  // samples could possibly be inside it, which is usually none. Same samples,
  // same answer, one test instead of twenty.
  let firstHit = steps + 1;

  const vols = ctx.volumes;
  for (let vi = 0; vi < vols.length; vi++) {
    const v = vols[vi];
    if (v.id === skip || v.id === skip2) continue;
    const b = boundsAt(ctx, vi);
    if (!raySlab(origin, dir, b, maxDist)) continue;
    const lo = Math.max(1, Math.ceil((_slabT0 / maxDist) * steps));
    const hi = Math.min(firstHit - 1, Math.floor((_slabT1 / maxDist) * steps));
    for (let k = lo; k <= hi; k++) {
      _mp[0] = origin[0] + dir[0] * k * step;
      _mp[1] = origin[1] + dir[1] * k * step;
      _mp[2] = origin[2] + dir[2] * k * step;
      if (volumeContains(v, _mp)) { firstHit = k; break; }
    }
  }

  const mods = ctx.modules;
  for (let mi = 0; mi < mods.length; mi++) {
    const m = mods[mi];
    if (!m.present || m.volumeId !== null) continue;
    if (m.id === skip2 || m.socketId === skip) continue;
    const b = moduleBoundsAt(ctx, mi);
    if (!raySlab(origin, dir, b, maxDist)) continue;
    const lo = Math.max(1, Math.ceil((_slabT0 / maxDist) * steps));
    const hi = Math.min(firstHit - 1, Math.floor((_slabT1 / maxDist) * steps));
    for (let k = lo; k <= hi; k++) {
      _mp[0] = origin[0] + dir[0] * k * step;
      _mp[1] = origin[1] + dir[1] * k * step;
      _mp[2] = origin[2] + dir[2] * k * step;
      if (moduleContains(m, _mp)) { firstHit = k; break; }
    }
  }

  return firstHit > steps ? maxDist : (firstHit - 1) * step;
}

/** Any unit vector perpendicular to `d`. */
function perpendicular(d: Vec3, out: MutVec3 = [0, 0, 0]): MutVec3 {
  const alt: Vec3 = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  return vNormalize(vCross(d, alt, out), out);
}

const CONE_ANGLES: readonly number[] = [0.15, 0.3, 0.45, 0.6, 0.8, 1.0, 1.25, 1.5];
const _c1: MutVec3 = [0, 0, 0];
const _c2: MutVec3 = [0, 0, 0];
const _cd: MutVec3 = [0, 0, 0];

/**
 * Half-angle of the unobstructed cone about `dir`, out to `testDist`.
 *
 * This is the single measurement four of the seven BRIEF §5 rules reduce to: a
 * weapon's field of fire, a cockpit's view cone, an engine's exhaust cone and a
 * docking port's approach corridor are the same question asked about different
 * axes. Measuring it once at generation time and writing it into
 * `Socket.clearAngle` is what lets the physics reviewer check the rules by
 * reading JSON instead of re-running the geometry.
 *
 * Six azimuths per band: a cone obstructed by a hull feature is obstructed over
 * a wide azimuth range, so the failure is never subtle enough to slip between
 * 60° samples, and the cost is linear in the sample count.
 */
function clearAngleAt(ctx: ClearanceView, origin: Vec3, dir: Vec3, testDist: number, skip: VolumeId | null, skip2: string | null = null, limit = Infinity): number {
  if (clearanceAlong(ctx, origin, dir, testDist, skip, skip2) < testDist * 0.999) return 0;
  const e1 = perpendicular(dir, _c1);
  vNormalize(vCross(dir, e1, _c2), _c2);
  let best = CONE_ANGLES[0];
  for (const a of CONE_ANGLES) {
    // A re-measure can only ever narrow a cone, so bands wider than the value
    // being re-measured cost 6 sweeps each and cannot change the answer.
    if (a > limit) break;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    let ok = true;
    for (let j = 0; j < 6 && ok; j++) {
      const az = (j / 6) * TAU;
      const cz = Math.cos(az) * sa;
      const sz = Math.sin(az) * sa;
      _cd[0] = dir[0] * ca + e1[0] * cz + _c2[0] * sz;
      _cd[1] = dir[1] * ca + e1[1] * cz + _c2[1] * sz;
      _cd[2] = dir[2] * ca + e1[2] * cz + _c2[2] * sz;
      if (clearanceAlong(ctx, origin, _cd, testDist, skip, skip2) < testDist * 0.999) ok = false;
    }
    if (!ok) break;
    best = a;
  }
  return best;
}

/**
 * What a pilot can actually SEE, as a solid fraction — not a cone scalar.
 *
 * `clearAngleAt` answers "how wide is the largest cone about this axis that is
 * clear all the way out". For an exhaust plume that is exactly right: a plume
 * is a cone and it either fits or it does not. For a canopy it is close to
 * useless, and the numbers proved it: sampled over eight seeds, the
 * cockpit/bridge socket came back 1.500 rad on seven and 0.000 on the eighth —
 * 1.500 being the top of `CONE_ANGLES`, i.e. a saturated cap rather than a
 * measurement. The check built on it therefore had exactly two reachable
 * outcomes and could not tell a 30° slit from a 90° canopy.
 *
 * So this measures what BRIEF §5 actually asks for. A fan of 5 elevations ×
 * 9 azimuths spanning ±60° about the socket normal, each ray weighted by the
 * solid angle its cell subtends (cos of the elevation), returns the fraction
 * of the forward hemisphere the crew can see out to `dist`. A single strut
 * across one corner costs a few per cent; a cargo pod parked in front costs
 * half. Both are things a reviewer can rank, which a saturating cap is not.
 *
 * `forwardDot` is the other half of the rule — "a view cone FORWARD" — and is
 * reported separately, because a perfectly clear cone pointing at the tail is
 * a gun position, not a bridge.
 */
const VIEW_ELEVATIONS: readonly number[] = [0, 0.262, 0.524, 0.785, 1.047];
const _va: MutVec3 = [0, 0, 0];
const _vb: MutVec3 = [0, 0, 0];
const _vd: MutVec3 = [0, 0, 0];

interface ViewCone {
  /** Solid fraction of the ±60° fan that is unobstructed, 0..1. */
  readonly fraction: number;
  /** Dot of the cone axis with ship-forward (−Z). 1 = straight ahead. */
  readonly forwardDot: number;
}

function viewCone(ctx: ClearanceView, origin: Vec3, dir: Vec3, dist: number, skip: VolumeId | null, skip2: string | null = null): ViewCone {
  const e1 = perpendicular(dir, _va);
  vNormalize(vCross(dir, e1, _vb), _vb);
  let clear = 0;
  let total = 0;
  for (const el of VIEW_ELEVATIONS) {
    const ce = Math.cos(el);
    const se = Math.sin(el);
    // One ray on the axis, nine round each ring: the weight is the ring's own
    // share of the solid angle, so the axis is not counted nine times.
    const n = el === 0 ? 1 : 9;
    const w = (el === 0 ? 1 : ce) / n;
    for (let j = 0; j < n; j++) {
      const az = (j / n) * TAU;
      const cz = Math.cos(az) * se;
      const sz = Math.sin(az) * se;
      _vd[0] = dir[0] * ce + e1[0] * cz + _vb[0] * sz;
      _vd[1] = dir[1] * ce + e1[1] * cz + _vb[1] * sz;
      _vd[2] = dir[2] * ce + e1[2] * cz + _vb[2] * sz;
      total += w;
      if (clearanceAlong(ctx, origin, _vd, dist, skip, skip2) >= dist * 0.999) clear += w;
    }
  }
  return {
    fraction: total > 0 ? clear / total : 0,
    forwardDot: -dir[2] / Math.max(1e-9, vLength(dir)),
  };
}

/** A bridge below this cannot fly the ship. BRIEF §5, made measurable. */
const MIN_VIEW_FRACTION = 0.5;
/** …and a bridge looking sideways is not looking forward. */
const MIN_VIEW_FORWARD_DOT = 0.6;

/**
 * A finished blueprint, seen as the thing the clearance sweeps read.
 *
 * The point is that `shipSelfTest` and `reviewShipPhysics` measure the SAME
 * geometry with the SAME code as the generator did, so a verdict can never be
 * a restatement of a field the generator wrote. The caches start empty and
 * fill on first use, exactly as they do during generation.
 */
function clearanceViewOf(bp: ShipBlueprint): ClearanceView {
  return { volumes: bp.primaryVolumes, modules: bp.modules, bounds: [], moduleBounds: [] };
}

/** The command module's measured view, on the finished hull. */
function commandView(bp: ShipBlueprint, cv: ClearanceView, m: ShipModule, sock: Socket): ViewCone {
  const f = sock.frame;
  const dist = Math.max(bp.dimensions.lengthKm * 2, 1e-5);
  const eps = Math.max(1e-6, dist * 0.02);
  const o: Vec3 = [
    f.origin[0] + f.forward[0] * eps,
    f.origin[1] + f.forward[1] * eps,
    f.origin[2] + f.forward[2] * eps,
  ];
  const skip = sock.host.kind === 'volume' ? sock.host.volumeId : null;
  return viewCone(cv, o, f.forward, dist, skip, m.volumeId ?? m.id);
}

// ===========================================================================
// The build context — mutable while the pipeline runs, discarded afterwards
// ===========================================================================

/**
 * The longitudinal profile of a hull, as five numbers a naval architect would
 * recognise. This is the parameter set that separates a dart from a brick:
 *
 *   widestAt   0.2 = shoulders forward (a hammerhead), 0.75 = a wedge
 *   noseEnd    section radius at t=0 as a fraction of maximum. 0.05 = a point,
 *              0.85 = a blunt industrial face
 *   noseSharp  <1 fills the nose out into an ogive, >1 draws it into a spike
 *   waistDepth how far the section pinches between the shoulders and the tail —
 *              the single cheapest way to stop a hull reading as an extrusion
 */
interface Proportions {
  readonly lengthKm: number;
  readonly beamKm: number;
  readonly heightKm: number;
  readonly widestAt: number;
  readonly noseEnd: number;
  readonly tailEnd: number;
  readonly noseSharp: number;
  readonly tailSharp: number;
  readonly waistDepth: number;
  readonly waistAt: number;
  readonly waistWidth: number;
  /** Bilateral for almost everything; `asymmetric` hulls deliberately break it. */
  readonly symmetric: boolean;
}

interface LampSpec {
  readonly position: Vec3;
  readonly radius: number;
  readonly intensity: number;
}

interface Ctx {
  readonly seed: number;
  readonly version: number;
  readonly role: ShipRole;
  readonly spec: ShipRoleRequirements;
  readonly dna: ShipFamilyDna;
  /** The full faction doctrine, for stages that need bands the DNA view drops. */
  readonly faction: FactionDna;
  readonly hull: HullFamily;
  readonly factionId: FactionId;
  readonly sizeClass: SizeClass;
  readonly archetype: HullArchetype;
  readonly tech: TechnologyProfile;
  readonly prop: Proportions;
  /** Design acceleration, m/s². Chosen in stage 1; the drive is sized to it. */
  readonly accelMs2: number;
  readonly drive: TechnologyProfile['drive'];

  readonly volumes: PrimaryVolume[];
  readonly sockets: Socket[];
  readonly modules: ShipModule[];
  readonly engines: EnginePod[];
  readonly thrusters: RcsThruster[];
  readonly hardpoints: Hardpoint[];
  readonly docks: DockingPort[];
  readonly connections: Connection[];
  readonly damage: DamageEvent[];
  readonly repairs: RepairEvent[];
  readonly markings: Marking[];
  readonly instancing: InstanceHint[];
  readonly lamps: LampSpec[];
  readonly rejections: PlacementRejection[];
  /** Internal only, never emitted. Index-aligned with `volumes`; see `boundsAt`. */
  readonly bounds: (Aabb | undefined)[];
  /** Index-aligned with `modules`; see `moduleBoundsAt`. */
  readonly moduleBounds: (Aabb | undefined)[];
  /**
   * Where each module was mounted, in its host volume's own (t, θ) parameters.
   * Internal only, never emitted — `types.ts` is append-only and not mine.
   *
   * It exists because a torn-off module has to leave a mark ON THE PLATING, and
   * plating damage is addressed in the host's surface parameters. The mount
   * knew them; `ShipModule` only keeps a world frame, and recovering θ from a
   * frame on a superelliptical section is a root-find nobody should be doing at
   * history time.
   */
  readonly mounts: Map<string, { readonly volumeId: VolumeId; readonly t: number; readonly theta: number }>;
  readonly counters: Map<string, number>;
  readonly palette: ShipPalette;

  spine: StructuralSpine;
  landing: LandingSystem | null;
  /** Filled by stage 4 so later stages can keep clear of the plume. */
  plumeLengthKm: number;
  /** How many masses have been held off the hull on pylons. See `standoff`. */
  standoffs: number;
  /** The forward termination from stage 3. `enforceLongitudinalAxis` grows it. */
  bow: PrimaryVolume | null;
}

/** Monotonic, per-prefix ids. Deterministic because the call order is. */
function nextId(ctx: Ctx, prefix: string): string {
  const n = (ctx.counters.get(prefix) ?? 0) + 1;
  ctx.counters.set(prefix, n);
  return `${prefix}${n}`;
}

function reject(ctx: Ctx, r: PlacementRejection): void {
  ctx.rejections.push(r);
}

const MAT_HULL = 0;
const MAT_STRUCT = 1;
const MAT_DETAIL = 2;

/**
 * Exactly three material keys per ship, and they are family-scoped so that two
 * Kessler freighters share one GPU program (BRIEF §6: ≤ 3 materials per ship,
 * shared across ships of a family).
 */
function matKey(ctx: Ctx, slot: number): string {
  const names = ['hull', 'struct', 'detail'];
  return `${ctx.dna.id}/${names[slot]}`;
}

// ===========================================================================
// STAGE 1 — role and family
//
// "What is this ship for, and who built it" (BRIEF §4.1). Nothing geometric
// happens here; what happens is that every geometric decision downstream is
// constrained. The archetype is chosen in this stage rather than with the
// volumes because the spine has to know the topology before it can lay a load
// path through it.
// ===========================================================================

interface Identity {
  readonly role: ShipRole;
  readonly spec: ShipRoleRequirements;
  readonly dna: ShipFamilyDna;
  readonly faction: FactionDna;
  readonly hull: HullFamily;
  readonly factionId: FactionId;
  readonly sizeClass: SizeClass;
  readonly archetype: HullArchetype;
  readonly tech: TechnologyProfile;
  readonly prop: Proportions;
  readonly accelMs2: number;
  readonly drive: TechnologyProfile['drive'];
}

const ALL_ROLES: readonly ShipRole[] = [
  'shuttle', 'courier', 'survey', 'freighter', 'tanker', 'miner', 'prospector',
  'refinery', 'salvager', 'tug', 'science', 'liner', 'colony', 'patrol',
  'gunship', 'carrier', 'station-tender', 'derelict',
];

/** Traffic frequency, from the topology table. See `RoleTopology.frequency`. */
const ROLE_FREQUENCY: readonly (readonly [ShipRole, number])[] =
  ALL_ROLES.map((r) => [r, ROLE_TOPOLOGY[r].frequency] as const);

function identity(params: ShipParams): Identity {
  const rng = new Rng(shipSubSeed(params.seed, 'family'));

  const role = params.role ?? pickWeighted(rng, ROLE_FREQUENCY);
  const roleSpec = roleById(role);
  const faction = pickFaction(rng, role, params.factionId);
  const hull = familyFor(faction, role);
  const dna = dnaFromFaction(faction, hull);
  const spec = requirementsFor(faction, roleSpec, hull);
  const sizeClass = params.sizeClass ?? pickWeighted(rng, spec.sizes);
  // The massing solution is a function of BOTH what the ship is for and who
  // built it. Drawing it from the role table alone is what made the faction
  // contrast shot return one hull three times; see `FACTION_ARCHETYPE_BIAS`.
  //
  // Drawn from a FACTION-SALTED stream, not from the shared one. Biasing the
  // weights alone is not enough for the contrast test: three yards handed the
  // same uniform variate land on the same entry far more often than their
  // weights say they should, because the variate is the same number. Two
  // different yards reaching two independent decisions do not share a coin, so
  // neither do they here.
  const archetype = pickWeighted(
    new Rng(sub(shipSubSeed(params.seed, 'family'), `archetype/${faction.id}`)),
    archetypesFor(spec.archetypes, faction.id),
  );

  // Length is log-uniform inside the class band: the bands span a factor of
  // 2.5–4, and a uniform draw over that puts two thirds of the fleet in the top
  // half of every class, which reads as "they are all the big one".
  const lengthKm = logBand(rng, SIZE_CLASS_LENGTH_KM[sizeClass]);

  // The archetype's proportion modifier is a BAND, not a constant.
  //
  // `ARCHETYPE_PROPORTION` gave every stacked hull exactly ×0.95 fineness and
  // ×1.05 height, so two stacked hulls of the same size class differed only in
  // the role band's own draw and 39% of seeds duplicated another seed's
  // proportion signature. A yard's stacked hull is a family of proportions,
  // not one proportion — so the modifier is jittered per seed, which puts the
  // variance in stage 3 where the silhouette is decided rather than in the
  // detail layer where it cannot be seen from across a system.
  const mod = ARCHETYPE_PROPORTION[archetype];
  const jf = rng.range(0.78, 1.3);
  const jh = rng.range(0.78, 1.3);
  const fineness = clamp(band(rng, spec.fineness) * mod.fineness * jf, 1.05, 16);
  const heightRatio = clamp(band(rng, spec.heightRatio) * mod.height * jh, 0.18, 3.0);
  const beamKm = lengthKm / fineness;
  const heightKm = beamKm * heightRatio;

  // The technology profile is the faction's, not the generator's: `families.ts`
  // decays maintenance with age inside the yard's own band, which is what keeps
  // "a tired Kessler" distinct from "a badly built Kessler". The params can pin
  // age or care for a review shot, and the rest of the profile follows.
  const base = technologyProfileFor(faction, roleSpec, params.seed);
  const maintenance = clamp01(params.maintenance ?? base.maintenance);
  const ageYears = Math.max(0, params.ageYears ?? base.ageYears);
  const tech: TechnologyProfile = {
    ...base,
    maintenance,
    ageYears,
    // An open topology shows more of its structure whatever the yard's habit —
    // there is nowhere on a spine-and-pod hull to hide a keel.
    exposedStructure: clamp01(base.exposedStructure * (archetype === 'spine-and-pod' || archetype === 'cluster' ? 1.3 : 1)),
  };
  const drive = tech.drive;

  // Bow and stern are different KINDS of termination, and the profile has to
  // say so in the loft rather than leave it to a mast to imply.
  //
  // The stern is a thrust structure: a flat transom you bolt engines to, so it
  // stays blunt. The bow is a bow — it resolves. Drawn independently these two
  // bands overlapped almost completely, and roughly a third of hulls came out
  // with two near-identical rectangular blocks at the ends: cover the middle of
  // the frame and you could not tell which way the ship was pointing, which is
  // the side-silhouette shot's own stated failure. So the nose radius is held
  // to at most 62% of the tail radius, which is a contrast no viewer can miss
  // and no decimation pass can shorten away.
  const tailEnd = rng.range(0.62, 0.98);
  const noseDraw = rng.range(0.06, 0.72) * (spec.accelMs2[1] > 150 ? 0.55 : 1.0) + (archetype === 'slab' ? 0.2 : 0);
  const noseEnd = clamp01(Math.min(noseDraw, tailEnd * 0.62));

  // The bow is part of the length BUDGET, not an extension of it.
  //
  // `buildBow` terminates the spine forward with a real volume, and if the
  // archetype builders were handed the full class length the finished hull
  // would overrun its own size class by whatever the bow ran to — the probe
  // hull went from 326 m to 539 m and would have been published as a class
  // larger than the one it was asked for. So the run the bow will take is
  // reserved here and the archetype gets what is left. Same formula
  // `buildBow` uses, without its jitter, so the two agree to a few per cent.
  const bowFrac = lerp(0.085, 0.2, clamp01(1 - noseEnd));
  const hullLengthKm = lengthKm / (1 + bowFrac);

  const prop: Proportions = {
    lengthKm: hullLengthKm,
    beamKm,
    heightKm,
    widestAt: rng.range(0.22, 0.72),
    // Nose bluntness is where a working hull separates from a fast one: a
    // freighter's bow is a flat face with a door in it, a courier's is a point.
    noseEnd,
    tailEnd,
    // >1 draws the bow out into a point, <1 fills it into an ogive. Either
    // reads as a bow; a bow that is a cylinder does not, so the band starts
    // above the flat 1.0 that a straight taper would give.
    noseSharp: rng.range(0.7, 2.0),
    tailSharp: rng.range(0.5, 1.6),
    waistDepth: rng.chance(0.45) ? rng.range(0.05, 0.22) : 0,
    waistAt: rng.range(0.35, 0.7),
    waistWidth: rng.range(0.12, 0.3),
    symmetric: archetype !== 'asymmetric',
  };

  const accelMs2 = band(rng, spec.accelMs2);

  // A derelict has no working drive. `accelMs2 = 0` is what makes that true
  // everywhere downstream: the pods are still built, the plumes are not.
  return { role, spec, dna, faction, hull, factionId: faction.id, sizeClass, archetype, tech, prop, accelMs2, drive };
}

/** Section radius as a fraction of maximum, at run parameter `t`. See `Proportions`. */
function profileAt(p: Proportions, t: number): number {
  const w = clamp(p.widestAt, 0.05, 0.95);
  const a = t < w ? t / w : (1 - t) / (1 - w);
  const endR = t < w ? p.noseEnd : p.tailEnd;
  const sharp = t < w ? p.noseSharp : p.tailSharp;
  // smoothstep before the power keeps the tangent continuous at the shoulder,
  // so a hull with a full nose does not crease where the taper turns over.
  let r = lerp(endR, 1, Math.pow(smoothstep(a), sharp));
  if (p.waistDepth > 0) {
    const d = (t - p.waistAt) / Math.max(0.02, p.waistWidth);
    r *= 1 - p.waistDepth * Math.exp(-0.5 * d * d);
  }
  return Math.max(0.02, r);
}

// ===========================================================================
// Section and station construction
// ===========================================================================

type SectionBias = 'hull' | 'tank' | 'truss' | 'panel' | 'pod' | 'machinery' | 'boom';

/**
 * Build a cross-section for one volume.
 *
 * The family comes from the yard's habits, the bias from what the volume *is* —
 * a pressure vessel is round because pressure vessels are round, a truss is a
 * polygon because its longerons sit at the vertices. Where the two conflict,
 * function wins; the yard's DNA then shows in the exponent, the side count and
 * the chines rather than in the family.
 *
 * Harmonic phases are not free: mirror symmetry about the ship's XZ plane
 * requires `cos(f(π-θ)+φ) ≡ cos(fθ+φ)`, i.e. `φ = -fπ/2 + kπ`, which collapses
 * to φ ∈ {0, π} for even f and φ ∈ {±π/2} for odd f. Any other phase silently
 * makes the port side different from the starboard one — the tell of a
 * generator that never thought about it.
 */
function makeSection(rng: Rng, dna: ShipFamilyDna, bias: SectionBias, symmetric: boolean): SectionShape {
  let family: SectionFamily;
  let sides: number;

  switch (bias) {
    case 'tank':
      family = rng.chance(0.75) ? 'superellipse' : 'polygon';
      sides = rng.pick([6, 8]);
      break;
    case 'truss':
      family = 'polygon';
      sides = rng.pick(dna.polygonSides.filter((n) => n <= 4).length > 0 ? dna.polygonSides.filter((n) => n <= 4) : [3, 4]);
      break;
    case 'panel':
      family = 'superellipse';
      sides = 4;
      break;
    case 'boom':
      family = rng.chance(0.5) ? 'polygon' : 'superellipse';
      sides = rng.pick([3, 4, 6]);
      break;
    case 'machinery':
      family = rng.chance(0.7) ? 'polygon' : 'superellipse';
      sides = rng.pick([4, 6]);
      break;
    default:
      family = pickWeighted(rng, [
        ['superellipse', dna.sectionWeights.superellipse] as const,
        ['polygon', dna.sectionWeights.polygon] as const,
        ['twin-lobe', dna.sectionWeights['twin-lobe']] as const,
      ]);
      sides = rng.pick(dna.polygonSides);
      break;
  }

  const harmonics: SectionHarmonic[] = [];
  if (bias !== 'panel' && bias !== 'truss' && rng.chance(dna.harmonicChance)) {
    const frequency = rng.pick([3, 4, 5, 6, 7]);
    const amp = band(rng, dna.harmonicAmplitude);
    const phase = symmetric
      ? (frequency % 2 === 0 ? (rng.chance(0.5) ? 0 : Math.PI) : (rng.chance(0.5) ? Math.PI / 2 : -Math.PI / 2))
      : rng.range(0, TAU);
    // The amplitude runs from t=0 to t=1: a chine that fades out towards the
    // tail reads as a designed line, one that is constant reads as corrugation.
    harmonics.push({ frequency, amplitude: [amp * rng.range(0.4, 1), amp * rng.range(0.4, 1)], phase });
  }

  const lobes: SectionLobe[] = [];
  if (bias === 'hull' || bias === 'pod') {
    if (rng.chance(dna.keelChance)) {
      const d = rng.range(0.06, 0.2);
      lobes.push({ angle: -Math.PI / 2, width: rng.range(0.22, 0.5), depth: [d * rng.range(0.3, 1), d] });
    }
    if (rng.chance(dna.dorsalChance)) {
      const d = rng.range(0.05, 0.18);
      lobes.push({ angle: Math.PI / 2, width: rng.range(0.2, 0.55), depth: [d, d * rng.range(0.3, 1)] });
    }
    if (rng.chance(0.3)) {
      // Sponsons come in pairs or the hull is no longer bilaterally symmetric.
      const a = rng.range(0.15, 0.9);
      const d = rng.range(0.05, 0.16);
      const w = rng.range(0.18, 0.4);
      lobes.push({ angle: a, width: w, depth: [d * 0.4, d] });
      if (symmetric) lobes.push({ angle: Math.PI - a, width: w, depth: [d * 0.4, d] });
    }
  }

  return { family, sides, harmonics, lobes };
}

/** The scalar half of a section, shared by every station of one volume. */
interface SectionScalars {
  readonly exponent: number;
  readonly chamfer: number;
  readonly lobeSeparation: number;
  readonly ventralFlatten: number;
}

function makeScalars(rng: Rng, dna: ShipFamilyDna, shape: SectionShape, bias: SectionBias): SectionScalars {
  return {
    exponent: bias === 'tank' ? rng.range(2.0, 2.6) : band(rng, dna.exponent),
    chamfer: bias === 'truss' ? 0 : rng.range(0, 0.55),
    lobeSeparation: shape.family === 'twin-lobe' ? rng.range(0.18, TWIN_LOBE_MAX_SEPARATION) : 0,
    // Ships sit on their bellies and land on them. `Ship.ts` hard-codes 0.82 for
    // the hero hull; a tank or a boom has no reason to be flattened at all.
    ventralFlatten: bias === 'hull' || bias === 'pod' ? rng.range(0.72, 1.0) : 1,
  };
}

/**
 * One station. `twist` is always zero, and that is not laziness:
 * `volumeSurfacePoint` evaluates the section at `theta - twist` and then writes
 * the result at the *same* angle, so twist reparametrises the curve without
 * rotating it — it is geometrically a no-op in the published contract. Section
 * rotation is therefore expressed through harmonic phase and lobe angle, which
 * do rotate the shape. (Noted for the contract author; `types.ts` is
 * append-only and not mine to change.)
 */
function station(
  t: number,
  halfWidth: number,
  halfHeight: number,
  s: SectionScalars,
  opts?: { readonly offset?: Vec2; readonly isFrame?: boolean; readonly hardEdge?: boolean; readonly exponent?: number; readonly twist?: number },
): VolumeStation {
  return {
    t,
    exponent: opts?.exponent ?? s.exponent,
    chamfer: s.chamfer,
    lobeSeparation: s.lobeSeparation,
    ventralFlatten: s.ventralFlatten,
    halfWidth: Math.max(1e-6, halfWidth),
    halfHeight: Math.max(1e-6, halfHeight),
    offset: opts?.offset ?? [0, 0],
    twist: opts?.twist ?? 0,
    isFrame: opts?.isFrame ?? false,
    hardEdge: opts?.hardEdge ?? false,
  };
}

/**
 * Station count for a run of `lengthKm`.
 *
 * Frames sit roughly one deck height apart on a small hull and one container
 * length apart on a large one, which is what makes a 4 km hull read as 4 km:
 * the panel and frame rhythm is a human-scale multiple, never a fixed count
 * (BRIEF §7).
 */
function stationCount(lengthKm: number): number {
  const pitch = lengthKm < 0.06 ? DECK_HEIGHT_KM * 2.2 : CONTAINER_LENGTH_KM * 1.6;
  return clamp(Math.round(lengthKm / pitch), 4, 22);
}

// ===========================================================================
// STAGE 2 — the structural spine
//
// "The load path from engines to nose" (BRIEF §4.2). It is built before any
// volume because the topology chosen in stage 1 is a statement about where the
// load goes: a fork has two load paths, a ring has spokes, a spine-and-pod
// hangs its payload off a keel. Volumes then hang off the spine rather than the
// spine being drawn through whatever the volumes turned out to be.
// ===========================================================================

/** Mean density of a manned hull, kg/m³. Calibrated against `Ship.ts`: a 30 m,
 *  8.4 m beam survey boat at `DEFAULT_SHIP_CONFIG.mass` = 2.0e5 kg works out at
 *  ~270 kg/m³ of gross envelope, i.e. mostly empty space wrapped in structure. */
const HULL_MEAN_DENSITY = 250;
/** Fraction of the length × beam × height box that is actually hull. */
const BOX_FILL = 0.45;
/** m³ per km³. */
const M3_PER_KM3 = 1e9;

/** First-pass mass, used to size the spine before any volume exists. */
function estimateMassKg(p: Proportions): number {
  return p.lengthKm * p.beamKm * p.heightKm * BOX_FILL * M3_PER_KM3 * HULL_MEAN_DENSITY;
}

/**
 * Radius of a compression member carrying `loadN` over an unbraced bay of
 * `bayM` metres.
 *
 * Sized by Euler buckling, not by yield: a keel longeron in a spacecraft truss
 * is slender, and yield stress would size it at a few centimetres — visually a
 * wire. P_cr = π²EI/L² with I = πr⁴/4 rearranges to r = (4·P·L² / (π³·E))^(1/4).
 * E = 70 GPa (aluminium alloy), safety factor 3 on load. The fourth root is why
 * a capital's truss is only ~3× thicker than a courier's despite carrying 100×
 * the load, which is exactly how real structures scale and why sizing it rather
 * than drawing it is what makes a hull look engineered.
 */
/**
 * Mean of the three factions' `workingStressNPerKm2`. Used as the denominator
 * so the faction knob stays a *ratio*, which is what `families.ts` says it is
 * for ("the knob that makes one culture's structure visibly heavier"). Its
 * absolute value cannot be used directly: the drive thrusts in this game are
 * deliberately unphysical (`FlightModel`'s own comment), so an area sized from
 * one would put a two-metre longeron on a thirty-metre boat.
 */
const REFERENCE_WORKING_STRESS = (9.0e11 + 2.1e12 + 1.4e12) / 3;

function memberRadiusKm(loadN: number, bayM: number, members: number, workingStress: number): number {
  const E = 7e10;
  const P = (Math.max(1, loadN) * 3) / Math.max(1, members);
  const rM = Math.pow((4 * P * bayM * bayM) / (Math.PI ** 3 * E), 0.25);
  // Area scales as 1/stress, so radius scales as 1/√stress. Kessler over-builds
  // by ~28%, Sillane builds ~16% lighter, and the read is exactly the one the
  // faction catalogue asks for.
  const cultural = Math.sqrt(REFERENCE_WORKING_STRESS / Math.max(1, workingStress));
  return Math.max(HATCH_WIDTH_KM * 0.15, (rM / 1000) * cultural);
}

/**
 * Which member style carries the load.
 *
 * The topology gets the casting vote — there is no such thing as a monocoque
 * spine-and-pod freighter — and the faction supplies the answer everywhere the
 * topology does not care. `heavyMember` is the fallback the catalogue provides
 * for exactly the case where the primary cannot carry the role's load.
 */
function spineStyleFor(rng: Rng, id: Identity): SpineMemberStyle {
  const st = id.faction.structure;
  const heavy = id.sizeClass === 'capital' || id.sizeClass === 'super-capital';
  if (id.archetype === 'spine-and-pod' || id.archetype === 'cluster') {
    if (st.member === 'monocoque') return st.heavyMember === 'monocoque' ? 'box-truss' : st.heavyMember;
    return rng.chance(0.7) ? st.member : st.heavyMember;
  }
  if (id.archetype === 'fork') return rng.chance(0.6) ? 'a-frame' : st.heavyMember;
  if (id.archetype === 'ring') return rng.chance(0.6) ? 'tube' : st.member;
  if (id.archetype === 'tower') return st.heavyMember;
  if (id.tech.exposedStructure < 0.25 && st.member !== 'monocoque') return rng.chance(0.6) ? 'monocoque' : 'keel-beam';
  return heavy ? st.heavyMember : rng.pick(id.dna.spineStyles);
}

function exposureFor(tech: TechnologyProfile, member: SpineMemberStyle, faction: FactionDna): SpineExposure {
  if (member === 'monocoque') return 'buried';
  // The faction states a doctrine; the hull's own exposure decides whether this
  // particular one lives up to it.
  if (tech.exposedStructure > 0.6) return faction.structure.exposure === 'buried' ? 'partial' : 'exposed';
  if (tech.exposedStructure > 0.3) return 'partial';
  return faction.structure.exposure === 'exposed' ? 'partial' : 'buried';
}

function buildSpine(id: Identity, seed: number): StructuralSpine {
  const rng = new Rng(shipSubSeed(seed, 'spine'));
  const p = id.prop;
  const L = p.lengthKm;
  const thrustEst = estimateMassKg(p) * 1.35 * id.accelMs2;

  const member = spineStyleFor(rng, id);
  const exposure = exposureFor(id.tech, member, id.faction);
  const shape = makeSection(new Rng(sub(shipSubSeed(seed, 'spine'), 'section')), id.dna, 'truss', true);

  // The main keel stops short of both ends: a nose fairing and an engine bell
  // overhang the structure, which is why `mainLengthKm` is not `lengthKm`.
  const z0 = -L * 0.46;
  const z1 = L * 0.44;
  const mainLen = z1 - z0;
  const count = clamp(Math.round(mainLen / (L < 0.06 ? DECK_HEIGHT_KM * 3 : CONTAINER_LENGTH_KM * 2.2)), 4, 16);

  const nodes: SpineNode[] = [];
  // The thrust frame is where engine loads enter the structure. Everything aft
  // of it is nozzle; everything forward carries the accelerated mass.
  const thrustAt = 0.86;
  for (let i = 0; i < count; i++) {
    const s = i / (count - 1);
    const z = lerp(z0, z1, s);
    const prof = profileAt(p, clamp((z + L * 0.5) / L, 0, 1));
    const structFrac = exposure === 'exposed' ? 0.34 : 0.8;
    let kind: SpineNodeKind;
    if (i === 0) kind = 'nose-cap';
    else if (i === count - 1) kind = 'tail-cap';
    else if (s <= thrustAt && (i + 1) / (count - 1) > thrustAt) kind = 'thrust-frame';
    else if (id.tech.pressurised && i % 3 === 1) kind = 'bulkhead';
    else if (exposure === 'exposed') kind = 'node-joint';
    else kind = 'ring-frame';
    nodes.push({
      id: `sn${i}`,
      s,
      position: [0, 0, z],
      up: UP_Y,
      radius: Math.max(HATCH_WIDTH_KM, Math.max(p.beamKm, p.heightKm) * 0.5 * prof * structFrac),
      kind,
      // Load rises from zero at the nose to the full thrust at the thrust frame,
      // because a node carries the inertia of everything forward of it.
      loadN: thrustEst * Math.min(1, s / thrustAt),
    });
  }

  const chains: SpineChain[] = [{
    id: 'sc0',
    parentNodeId: null,
    nodes,
    member,
    exposure,
    shape,
    materialKey: `${id.dna.id}/struct`,
  }];

  // Branch chains: the topology made structural. A fork has two forward load
  // paths, a ring has spokes, an asymmetric hull has one outrigger, and each of
  // them is a chain rather than a decorative boom.
  const branchAt = (frac: number): SpineNode => nodes[clamp(Math.round(frac * (count - 1)), 0, count - 1)];
  const addBranch = (i: number, from: SpineNode, tip: Vec3, up: Vec3, radiusFrac: number): void => {
    const n = 4;
    const bn: SpineNode[] = [];
    for (let k = 0; k < n; k++) {
      const s = k / (n - 1);
      bn.push({
        id: `sn${i}_${k}`,
        s,
        position: [lerp(from.position[0], tip[0], s), lerp(from.position[1], tip[1], s), lerp(from.position[2], tip[2], s)],
        up,
        radius: from.radius * radiusFrac * lerp(1, 0.5, s),
        kind: k === 0 ? 'node-joint' : k === n - 1 ? 'nose-cap' : 'ring-frame',
        // A branch carries only what hangs on it, which is why an outrigger is
        // visibly lighter than the keel it leaves.
        loadN: from.loadN * radiusFrac * (1 - s),
      });
    }
    chains.push({ id: `sc${i}`, parentNodeId: from.id, nodes: bn, member: id.archetype === 'fork' ? 'a-frame' : member, exposure, shape, materialKey: `${id.dna.id}/struct` });
  };

  switch (id.archetype) {
    case 'fork': {
      const from = branchAt(0.55);
      const dx = p.beamKm * 0.3;
      addBranch(1, from, [dx, 0, -L * 0.44], UP_Y, 0.6);
      addBranch(2, from, [-dx, 0, -L * 0.44], UP_Y, 0.6);
      break;
    }
    case 'ring': {
      const from = branchAt(0.45);
      const r = Math.max(p.beamKm, p.heightKm) * 0.42;
      addBranch(1, from, [r, 0, from.position[2]], FWD_Z, 0.45);
      addBranch(2, from, [-r, 0, from.position[2]], FWD_Z, 0.45);
      break;
    }
    case 'tower': {
      const from = branchAt(0.5);
      addBranch(1, from, [0, p.heightKm * 0.45, from.position[2]], FWD_Z, 0.8);
      break;
    }
    case 'asymmetric': {
      const from = branchAt(0.4);
      addBranch(1, from, [p.beamKm * 0.34, 0, from.position[2]], UP_Y, 0.55);
      break;
    }
    case 'slab': {
      const from = branchAt(0.35);
      addBranch(1, from, [p.beamKm * 0.3, p.heightKm * 0.6, from.position[2]], FWD_Z, 0.5);
      break;
    }
    case 'cluster': {
      const from = branchAt(0.5);
      const r = p.beamKm * 0.32;
      addBranch(1, from, [r, 0, from.position[2]], UP_Y, 0.4);
      addBranch(2, from, [-r, 0, from.position[2]], UP_Y, 0.4);
      break;
    }
    default:
      break;
  }

  return { chains, mainLengthKm: mainLen };
}

// ===========================================================================
// STAGE 3 — primary volumes
//
// "The two or three masses that make the silhouette" (BRIEF §4.3). One builder
// per archetype. They share `sweptVolume` and nothing else, which is the point:
// a ring hull and a slab hull do not differ by a parameter, they differ by
// which function ran.
// ===========================================================================

interface SweptArgs {
  readonly kind: VolumeKind;
  readonly frame: Frame;
  readonly length: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly bias: SectionBias;
  readonly capStart: CapStyle;
  readonly capEnd: CapStyle;
  readonly materialSlot: number;
  readonly detailDensity: number;
  readonly loadShare: number;
  readonly profile?: (t: number) => number;
  /** Independent vertical profile, when a hull is not a body of revolution. */
  readonly profileY?: (t: number) => number;
  readonly offsetFn?: (t: number) => Vec2;
  readonly anchor?: PrimaryVolume['anchor'];
  readonly mirrorOf?: string | null;
  readonly interiorVisible?: boolean;
  readonly shape?: SectionShape;
  readonly scalars?: SectionScalars;
  readonly construction?: VolumeConstruction;
  readonly arc?: { readonly radius: number; readonly sweep: number };
  readonly stations?: number;
  readonly frameEvery?: number;
  readonly hardStart?: boolean;
}

/**
 * Choose how a volume is realised as surface.
 *
 * Function first, yard second: a tank is a pressure vessel however the yard
 * likes to build, a keel is a truss, a radiator is a slab. Only the pressurised
 * hull is open to the yard's habits, and even there the choice is between
 * plated and ribbed rather than between plated and open framework.
 */
function constructionFor(
  rng: Rng, kind: VolumeKind, id: Identity, sides: number, lengthKm: number, radiusKm: number, loadN: number,
): VolumeConstruction {
  switch (kind) {
    case 'keel':
    case 'boom':
    case 'cargo-rack': {
      const longerons = clamp(Math.round(sides), 3, 6);
      // Bay length is the faction's `bayAspect` × the local structural radius,
      // then held to a human-scale absolute band so the truss rhythm on a 4 km
      // hull is still readable rather than four bays stretched over it.
      const st = id.faction.structure;
      const bayLen = clamp(radiusKm * sampleRange(st.bayAspect, rng), CONTAINER_LENGTH_KM * 0.7, CONTAINER_LENGTH_KM * 2.5);
      const bays = clamp(Math.round(lengthKm / bayLen), 2, 40);
      return {
        kind: 'truss',
        longerons,
        brace: st.brace,
        memberRadius: memberRadiusKm(loadN, (lengthKm / bays) * 1000, longerons, st.workingStressNPerKm2),
        bays,
      };
    }
    case 'tank':
      return { kind: 'tank', domeRatio: rng.range(0.45, 1.0), girthBands: clamp(Math.round(lengthKm / (radiusKm * 1.4)), 2, 18) };
    case 'radiator':
    case 'wing':
    case 'fin':
      return {
        kind: 'panel',
        thickness: Math.max(HATCH_WIDTH_KM * 0.25, radiusKm * 0.09),
        segments: kind === 'radiator' ? rng.int(2, 6) : 1,
        porosity: kind === 'radiator' ? rng.range(0.05, 0.35) : 0,
      };
    case 'shroud':
    case 'nacelle':
      return { kind: 'shroud', thickness: Math.max(HATCH_WIDTH_KM * 0.2, radiusKm * 0.07) };
    default: {
      // Ribs are the freighter read: external frames on a plated skin. A yard
      // that casts monocoque hulls does not rib them.
      const ribbed = id.tech.fabrication !== 'cast-monocoque' && id.tech.fabrication !== 'composite-wrap'
        && (kind === 'cargo-bay' || kind === 'hull' || kind === 'midbody') && rng.chance(0.45);
      if (ribbed) {
        return {
          kind: 'ribbed',
          ribDepth: Math.max(HATCH_WIDTH_KM * 0.3, radiusKm * 0.055),
          ribWidth: Math.max(HATCH_WIDTH_KM * 0.4, radiusKm * 0.09),
          ribDensity: clamp(lengthKm / Math.max(1e-6, radiusKm * 1.6), 2, 24),
        };
      }
      return { kind: 'skin', panelBreaks: clamp(Math.round(lengthKm / Math.max(1e-6, radiusKm * 1.2)), 0, 12) };
    }
  }
}

function sweptVolume(ctx: Ctx, rng: Rng, a: SweptArgs): PrimaryVolume {
  const shape = a.shape ?? makeSection(rng, ctx.dna, a.bias, ctx.prop.symmetric || a.bias !== 'hull');
  const scalars = a.scalars ?? makeScalars(rng, ctx.dna, shape, a.bias);
  const n = a.stations ?? stationCount(a.length);
  const prof = a.profile ?? ((): number => 1);
  const profY = a.profileY ?? prof;
  const frameEvery = a.frameEvery ?? 2;

  // A twist along the run, rationed like colour.
  //
  // The parameter existed from the start but was inert — volumeSurfacePoint
  // rotated theta before the anisotropic scale, which only re-parameterises
  // the same outline — so this was pinned to zero. With the contract fixed it
  // is the cheapest source of a silhouette you have not seen before: a hull
  // whose section rolls along its length reads as forged rather than extruded.
  // Most hulls still get none; a quarter of load-bearing volumes get a little.
  // Closed arcs are excluded — a twisted ring is a mistake, not a design.
  const twistTotal =
    a.arc || !rng.chance(0.25) ? 0 : rng.range(-0.42, 0.42);

  const stations: VolumeStation[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    stations.push(station(t, a.halfWidth * prof(t), a.halfHeight * profY(t), scalars, {
      offset: a.offsetFn ? a.offsetFn(t) : [0, 0],
      isFrame: i % frameEvery === 0,
      hardEdge: (i === 0 && a.hardStart === true) || false,
      // Eased rather than linear: a constant rate looks like a screw thread.
      twist: twistTotal * (t * t * (3 - 2 * t)),
    }));
  }
  // A closed arc must end where it began or the ring shows a seam.
  if (a.arc && Math.abs(a.arc.sweep - TAU) < 1e-6) {
    stations[stations.length - 1] = station(1, stations[0].halfWidth, stations[0].halfHeight, scalars, { isFrame: true });
  }

  const id = nextId(ctx, 'v');
  const loadN = ctx.spine.chains[0].nodes[ctx.spine.chains[0].nodes.length - 1].loadN * a.loadShare;
  return {
    id,
    kind: a.kind,
    frame: a.frame,
    path: a.arc ? { kind: 'arc', radius: a.arc.radius, sweep: a.arc.sweep } : { kind: 'linear', length: a.length },
    shape,
    construction: a.construction ?? constructionFor(rng, a.kind, ctxIdentity(ctx), shape.sides, a.length, Math.max(a.halfWidth, a.halfHeight), loadN),
    stations,
    capStart: a.capStart,
    capEnd: a.capEnd,
    anchor: a.anchor ?? null,
    mirrorOf: a.mirrorOf ?? null,
    materialKey: matKey(ctx, a.materialSlot),
    detailDensity: clamp01(a.detailDensity),
    loadShare: clamp01(a.loadShare),
    seed: sub(shipSubSeed(ctx.seed, 'volumes'), id),
    interiorVisible: a.interiorVisible ?? false,
  };
}

/** `Ctx` carries the identity fields flat; `constructionFor` wants them boxed. */
function ctxIdentity(ctx: Ctx): Identity {
  return {
    role: ctx.role, spec: ctx.spec, dna: ctx.dna, faction: ctx.faction, hull: ctx.hull,
    factionId: ctx.factionId, sizeClass: ctx.sizeClass, archetype: ctx.archetype,
    tech: ctx.tech, prop: ctx.prop, accelMs2: ctx.accelMs2, drive: ctx.drive,
  };
}

/**
 * Cap style at the nose. The hull line names its preferred cap and gets it
 * whenever the profile allows — a Carapace is an ogive because that is what a
 * Carapace is — but a bow this generator has drawn as a flat industrial face
 * cannot be capped with a spike, so bluntness has the final say.
 */
function noseCapFor(ctx: Ctx, noseEnd: number): CapStyle {
  const preferred = ctx.hull.noseCap;
  if (noseEnd < 0.18) return preferred === 'flat' || preferred === 'blunt' ? 'ogive' : preferred;
  if (noseEnd < 0.4) return preferred === 'flat' ? 'taper' : preferred;
  if (noseEnd < 0.7) return preferred === 'ogive' ? 'dome' : preferred;
  return preferred === 'ogive' || preferred === 'taper' ? 'blunt' : preferred;
}

/** Payload volume kind for this role — what the pods and cans actually are. */
function payloadOf(ctx: Ctx): VolumeKind {
  return ctx.spec.payloadKind;
}

function payloadBias(kind: VolumeKind): SectionBias {
  if (kind === 'tank') return 'tank';
  if (kind === 'cargo-rack') return 'truss';
  if (kind === 'machinery') return 'machinery';
  return 'pod';
}

// ---------------------------------------------------------------------------
// Structure that spans a gap
//
// BRIEF §4 stage 2 asks for a structural spine that is a VISIBLE load path, and
// BRIEF §8 asks for a silhouette that is interesting as a black shape from
// three angles. Both reduce to one measurable property, and it was the property
// this generator was failing outright: ENCLOSED NEGATIVE SPACE. Thresholded and
// hole-filled, all three canonical silhouettes contained zero enclosed
// background regions. A monocoque tube with everything buried inside it has no
// load path to read, and from three-quarter it is exactly what the shot's own
// FAILS IF describes — an undifferentiated mass.
//
// The cure is not more parts; a hull already carries twenty modules and it did
// not help. The cure is ONE part with daylight under it: a mass held off the
// hull on pylons, so the outline closes round a hole. That construct does four
// jobs at once — it is the load path, it is the medium tier of forms between
// the hull and the sub-metre greebles, it is where a freighter's payload
// actually goes, and it is the hole.
// ---------------------------------------------------------------------------

/**
 * A structural stub from `a` to `b`. The visible half of a load path.
 *
 * The LANGUAGE of that stub is the faction's, not a constant.
 *
 * `StructureDna.exposure` was being read in exactly one place — `exposureFor`,
 * which decides whether the SPINE is drawn — and nowhere else. So a yard whose
 * whole identity is `exposure: 'buried'`, monocoque, "nothing unbolts, nothing
 * is visible, it arrives finished", got its dorsal mass held up on two slim
 * round masts standing clear of the skin: the bolt-on architecture that is a
 * welded-plate yard's signature, drawn identically on the one faction it is
 * supposed to distinguish it FROM. On the three-faction contrast plate the
 * Sillane dorsal array was indistinguishable from the Kessler dorsal array
 * beside it, which is the whole test that shot exists to run.
 *
 * A monocoque yard still has to get the load from the mass into the hull. It
 * does it the way a cast structure does: a broad fore-and-aft WEB, filleted
 * into the skin at its root, deep in the plane of the load and thin across it.
 * The daylight underneath survives — it has to, `ensureSpanningStructure`
 * measures it — but the outline reads as one continuous form arching over a
 * recess rather than a shelf on two poles.
 *
 * The volume KIND stays `pylon` on both branches deliberately. `spanHost` and
 * `largestPrimaryArea` both exclude `pylon`, and a support that changed kind
 * would start competing to be the span host and to set the accent-size cap —
 * which is the sort of shared-parameter change that broke the silhouette
 * framing in an earlier round.
 */
function strut(ctx: Ctx, rng: Rng, a: Vec3, b: Vec3, radius: number, hostId: VolumeId | null): PrimaryVolume {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.max(1e-6, Math.hypot(d[0], d[1], d[2]));
  const fwd: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
  const up = Math.abs(fwd[1]) > 0.94 ? FWD_Z : UP_Y;
  // `up` is the section's local +Y, so `halfHeight` runs along it: for a dorsal
  // support that is the fore-and-aft direction, which is the one a web wants to
  // be deep in and a mast wants to be slim in.
  const buried = ctx.faction.structure.exposure === 'buried';
  const v = sweptVolume(ctx, rng, {
    kind: 'pylon',
    frame: frameAt(a, fwd, up),
    length: len,
    halfWidth: buried ? radius * rng.range(0.5, 0.72) : radius,
    halfHeight: radius * (buried ? rng.range(3.4, 4.8) : rng.range(1.1, 1.8)),
    bias: buried ? 'panel' : 'boom',
    capStart: 'flat',
    capEnd: 'flat',
    // Hull plate, hull panel size, hull shade: the web is part of the casting,
    // not a piece of structural steel bolted through it.
    materialSlot: buried ? MAT_HULL : MAT_STRUCT,
    detailDensity: buried ? 0.12 : 0.55,
    loadShare: 0.45,
    stations: buried ? 4 : 3,
    // The fillet. A cast web is widest where it meets the skin and thins as it
    // reaches the mass, which is what makes it read as grown rather than bolted.
    profile: buried ? (u): number => lerp(1.5, 0.85, smoothstep(clamp01(u * 1.3))) : undefined,
    profileY: buried ? (u): number => lerp(1.22, 0.92, smoothstep(clamp01(u * 1.6))) : undefined,
    anchor: hostId ? { kind: 'volume', volumeId: hostId, t: 0.5 } : null,
  });
  ctx.volumes.push(v);
  return v;
}

/**
 * May this yard build a separate mass of this kind at all?
 *
 * `MassingDna` is the doctrine that decides what a hull is made OF, and it is a
 * refusal list rather than a set of weights for the reason its own header
 * gives: a preference expressed as a multiplier gets flattened by the floor
 * share downstream and stops being doctrine. `forbiddenKinds` and a budget of
 * `[0, 0]` are the same statement said twice, and both are honoured here.
 *
 * This is the gate the r5 census was missing. `exposureFor` consulted
 * `structure.exposure` for the SPINE and nothing consulted anything for the
 * things hung on the OUTSIDE of the hull — so the one yard whose entry reads
 * "there is no external volume of any kind — no pod, no boom, no pylon" got a
 * dorsal mass on two masts at the same standoff, spacing and silhouette weight
 * as the welded-plate yard beside it on the contrast plate.
 *
 * Read defensively. `families.ts` is another agent's file and is mid-round;
 * a faction whose `massing` block has not landed yet must generate a ship
 * rather than throw, and "no doctrine stated" means "no refusal".
 */
function yardBuilds(ctx: Ctx, kind: VolumeKind): boolean {
  const massing: MassingDna | undefined = ctx.faction.massing;
  if (massing === undefined) return true;
  if (massing.forbiddenKinds.includes(kind)) return false;
  const budget = massing.budget.find((b) => b.kind === kind);
  return budget === undefined || budget.count[1] > 0;
}

/** The volume a rack or gantry should hang from: the longest axial primary. */
function spanHost(ctx: Ctx): PrimaryVolume | null {
  let best: PrimaryVolume | null = null;
  let bestLen = 0;
  for (const v of ctx.volumes) {
    if (v.path.kind !== 'linear') continue;
    if (v.kind === 'nacelle' || v.kind === 'radiator' || v.kind === 'wing'
      || v.kind === 'fin' || v.kind === 'pylon' || v.kind === 'shroud') continue;
    const b = boundsOf(ctx, v);
    const len = b.max[2] - b.min[2];
    if (len > bestLen) { bestLen = len; best = v; }
  }
  return best;
}

interface StandoffSpec {
  readonly kind: VolumeKind;
  readonly bias: SectionBias;
  /** Section angle to stand off along: π/2 dorsal, −π/2 ventral, 0 starboard. */
  readonly theta: number;
  /** Fraction of the host's length the mass runs over. */
  readonly runFrom: number;
  readonly runTo: number;
  /** Half-extent across the standoff direction (the one the gap is measured to). */
  readonly outHalf: number;
  /** Half-extent across the other two. */
  readonly sideHalf: number;
  /** Clear daylight between the host's skin and the mass. This IS the hole. */
  readonly gap: number;
  /** Least side-projected area the mass must present, km². Grows `outHalf`. */
  readonly minSideArea?: number;
  readonly capStart: CapStyle;
  readonly capEnd: CapStyle;
  readonly materialSlot: number;
  readonly detailDensity: number;
  readonly loadShare: number;
  readonly mirrorTheta?: boolean;
}

/**
 * Hold a mass off the hull on two pylons, leaving daylight underneath.
 *
 * The daylight is the whole point, so the standoff is measured against the
 * host's actual skin at five stations along the run rather than against a
 * nominal radius: a hull that bulges amidships would otherwise swallow the mass
 * it is supposed to be carrying, which is precisely how the lateral cargo pods
 * on the hero freighter ended up butted against the keel with no gap at all.
 */
function standoff(ctx: Ctx, rng: Rng, s: StandoffSpec): PrimaryVolume | null {
  // A standoff is two things at once — an external mass AND the pylons under it
  // — so a yard that refuses either refuses the construct. Callers must have a
  // fused answer ready; `ensurePayloadMass` does, and `ensureSpanningStructure`
  // logs the refusal rather than pretending it did not measure.
  if (!yardBuilds(ctx, s.kind) || !yardBuilds(ctx, 'pylon')) return null;
  const host = spanHost(ctx);
  if (!host) return null;
  const nx = Math.cos(s.theta);
  const ny = Math.sin(s.theta);

  // The run is measured over the SHIP, not over the host. `spanHost` returns
  // the longest volume, which on a stacked hull is one segment of four — and a
  // rack sized to one segment came out a third of the length it was supposed to
  // be and lost the "which mass is largest" argument it exists to win.
  let shipZ0 = Infinity;
  let shipZ1 = -Infinity;
  for (let i = 0; i < ctx.volumes.length; i++) {
    const b = boundsAt(ctx, i);
    if (b.min[2] < shipZ0) shipZ0 = b.min[2];
    if (b.max[2] > shipZ1) shipZ1 = b.max[2];
  }
  if (!Number.isFinite(shipZ0) || shipZ1 <= shipZ0) return null;
  const z0 = lerp(shipZ0, shipZ1, s.runFrom);
  const z1 = lerp(shipZ0, shipZ1, s.runTo);
  let runLen = z1 - z0;
  if (runLen <= 0) return null;

  // Pylon feet go on the host's own skin, at the host station nearest each
  // foot's z. Sampled at the same five stations so the standoff clears the
  // host's widest point over the run rather than its mean.
  const hb = boundsOf(ctx, host);
  const hz0 = hb.min[2];
  const hz1 = hb.max[2];
  const SAMPLES = 5;
  let radial = -Infinity;
  const skin: Vec3[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const z = lerp(z0, z1, i / (SAMPLES - 1));
    const t = hz1 > hz0 ? clamp((z - hz0) / (hz1 - hz0), 0.04, 0.96) : 0.5;
    const p = volumeSurfacePoint(host, t, s.theta, [0, 0, 0]);
    radial = Math.max(radial, p[0] * nx + p[1] * ny);
    skin.push([p[0], p[1], z]);
  }
  if (!Number.isFinite(radial)) return null;

  // Clear EVERYTHING in the corridor, not only the volume it is bolted to. A
  // mass that stands off its host and then buries itself in the capsule next
  // door has added a bulge, not a hole — which is exactly what happened on the
  // cluster hulls, where the host is one capsule of four.
  const hostRadial = radial;
  const lateral = Math.abs(nx) > 0.5;
  for (let i = 0; i < ctx.volumes.length; i++) {
    const v = ctx.volumes[i];
    if (v.kind === 'nacelle' || v.kind === 'shroud') continue;
    const b = boundsAt(ctx, i);
    if (b.max[2] < z0 || b.min[2] > z1) continue;
    const r = lateral ? (nx > 0 ? b.max[0] : -b.min[0]) : (ny > 0 ? b.max[1] : -b.min[1]);
    if (r > radial) radial = r;
  }
  // …but not at any price. A single radiator fin does not get to push the whole
  // rack half a hull-height into space; past this the mass would stop reading
  // as part of the ship.
  const across = lateral ? ctx.prop.beamKm : ctx.prop.heightKm;
  radial = Math.min(radial, hostRadial + across * 0.55);

  // Grow to meet the area the caller has to present, now that the run this
  // hull actually offers is known.
  const outHalf = s.minSideArea !== undefined
    ? Math.max(s.outHalf, s.minSideArea / (2 * runLen))
    : s.outHalf;

  // Centreline distance from the ship axis: past the skin, past the gap, then
  // half the mass itself.
  const d = radial + s.gap + outHalf;
  const mass = sweptVolume(ctx, rng, {
    kind: s.kind,
    frame: axialFrame(nx * d, ny * d, z0),
    length: runLen,
    halfWidth: Math.abs(nx) > 0.5 ? outHalf : s.sideHalf,
    halfHeight: Math.abs(nx) > 0.5 ? s.sideHalf : outHalf,
    bias: s.bias,
    capStart: s.capStart,
    capEnd: s.capEnd,
    materialSlot: s.materialSlot,
    detailDensity: s.detailDensity,
    loadShare: s.loadShare,
    frameEvery: 1,
    anchor: { kind: 'volume', volumeId: host.id, t: 0.5 },
  });
  ctx.volumes.push(mass);
  ctx.standoffs++;

  // Two supports. Two and not one: one is a cantilever and reads as a bracket,
  // two read as a structure and leave a rectangle of daylight between them that
  // a black silhouette can close round.
  //
  // WHERE they stand is doctrine. A yard that bolts things on puts its masts at
  // the quarter points, because that is where a simply-supported beam wants
  // them. A monocoque yard springs an arch from the two ENDS of the run, and it
  // has to: `strut` draws a buried yard's support as a deep fore-and-aft web,
  // and a deep web at the quarter points would eat the daylight this whole
  // construct exists to create. Ends plus web is the same hole, differently
  // told — measured below by `enclosedHoleFraction`, which is the only opinion
  // that counts.
  const buried = ctx.faction.structure.exposure === 'buried';
  const rPylon = clamp(Math.min(outHalf, s.sideHalf) * 0.3, HATCH_WIDTH_KM * 0.35, Math.max(HATCH_WIDTH_KM * 0.4, s.gap * 0.5));
  for (const i of buried ? [0, SAMPLES - 1] : [1, 3]) {
    const base = skin[i];
    const top: Vec3 = [nx * (d - outHalf * 0.85), ny * (d - outHalf * 0.85), base[2]];
    strut(ctx, rng, base, top, rPylon, host.id);
  }
  return mass;
}

// --- the silhouette post-condition -----------------------------------------
//
// A rule nobody measures is a rule nobody keeps, so the enclosed-hole property
// is checked rather than assumed. The projection is rasterised from the same
// `volumeSurfacePoint` the loft, the mass integrator and the collision fitter
// all use — so what is measured here is the ship, not a proxy for it.

const SIL_NU = 168;
const SIL_NV = 104;
const _silGrid = new Uint8Array(SIL_NU * SIL_NV);
const _silLo = new Int16Array(SIL_NU);
const _silHi = new Int16Array(SIL_NU);
const _silStack = new Int32Array(SIL_NU * SIL_NV);

/**
 * Largest enclosed background region in an orthographic projection, as a
 * fraction of the ship's own projected area.
 *
 * `axis` 0 drops X (the side view), 1 drops Y (the plan view). Per volume the
 * column between its topmost and bottommost sample is filled, because a swept
 * convex section is convex in that column — which is what makes the difference
 * between "there is a hole" and "the sampling missed the middle".
 */
function enclosedHoleFraction(ctx: Ctx, axis: 0 | 1): number {
  const vols = ctx.volumes;
  if (vols.length === 0) return 0;
  let box = boundsOf(ctx, vols[0]);
  for (let i = 1; i < vols.length; i++) box = unionAabb(box, boundsOf(ctx, vols[i]));
  const uMin = box.min[2];
  const uMax = box.max[2];
  const vMin = axis === 0 ? box.min[1] : box.min[0];
  const vMax = axis === 0 ? box.max[1] : box.max[0];
  const du = uMax - uMin;
  const dv = vMax - vMin;
  if (!(du > 0) || !(dv > 0)) return 0;

  _silGrid.fill(0);
  const T = 18;
  const TH = 16;
  const p: MutVec3 = [0, 0, 0];
  for (const vol of vols) {
    _silLo.fill(32767);
    _silHi.fill(-1);
    for (let i = 0; i < T; i++) {
      const t = i / (T - 1);
      for (let j = 0; j < TH; j++) {
        volumeSurfacePoint(vol, t, (j / TH) * TAU, p);
        const cu = clamp(Math.floor(((p[2] - uMin) / du) * (SIL_NU - 1)), 0, SIL_NU - 1);
        const cv = clamp(Math.floor((((axis === 0 ? p[1] : p[0]) - vMin) / dv) * (SIL_NV - 1)), 0, SIL_NV - 1);
        if (cv < _silLo[cu]) _silLo[cu] = cv;
        if (cv > _silHi[cu]) _silHi[cu] = cv;
      }
    }
    // A long volume sampled at T stations touches fewer columns than it spans,
    // and leaving the untouched ones empty rasterises a solid boom as a picket
    // fence — which is a background the flood fill walks straight through, so
    // every real hole reads as open. Interpolating between the columns the
    // samples did reach is what makes this a silhouette rather than a scatter.
    let first = -1;
    let last = -1;
    for (let u = 0; u < SIL_NU; u++) if (_silHi[u] >= 0) { if (first < 0) first = u; last = u; }
    if (first < 0) continue;
    let prev = first;
    for (let u = first + 1; u <= last; u++) {
      if (_silHi[u] < 0) continue;
      for (let g = prev + 1; g < u; g++) {
        const k = (g - prev) / (u - prev);
        _silLo[g] = Math.round(lerp(_silLo[prev], _silLo[u], k));
        _silHi[g] = Math.round(lerp(_silHi[prev], _silHi[u], k));
      }
      prev = u;
    }
    for (let u = first; u <= last; u++) {
      const lo = _silLo[u];
      const hi = _silHi[u];
      if (hi < lo) continue;
      for (let v = lo; v <= hi; v++) _silGrid[u * SIL_NV + v] = 1;
    }
  }

  let ship = 0;
  for (let i = 0; i < _silGrid.length; i++) if (_silGrid[i] === 1) ship++;
  if (ship === 0) return 0;

  // Flood the background inward from the border; anything empty it cannot reach
  // is enclosed by hull on every side.
  let sp = 0;
  const push = (u: number, v: number): void => {
    if (u < 0 || v < 0 || u >= SIL_NU || v >= SIL_NV) return;
    const k = u * SIL_NV + v;
    if (_silGrid[k] !== 0) return;
    _silGrid[k] = 2;
    _silStack[sp++] = k;
  };
  for (let u = 0; u < SIL_NU; u++) { push(u, 0); push(u, SIL_NV - 1); }
  for (let v = 0; v < SIL_NV; v++) { push(0, v); push(SIL_NU - 1, v); }
  while (sp > 0) {
    const k = _silStack[--sp];
    const u = (k / SIL_NV) | 0;
    const v = k - u * SIL_NV;
    push(u + 1, v); push(u - 1, v); push(u, v + 1); push(u, v - 1);
  }

  // Largest remaining zero component is the biggest enclosed hole.
  let best = 0;
  for (let start = 0; start < _silGrid.length; start++) {
    if (_silGrid[start] !== 0) continue;
    let size = 0;
    sp = 0;
    _silGrid[start] = 3;
    _silStack[sp++] = start;
    while (sp > 0) {
      const k = _silStack[--sp];
      size++;
      const u = (k / SIL_NV) | 0;
      const v = k - u * SIL_NV;
      const nb = [u + 1 < SIL_NU ? k + SIL_NV : -1, u > 0 ? k - SIL_NV : -1, v + 1 < SIL_NV ? k + 1 : -1, v > 0 ? k - 1 : -1];
      for (const n of nb) {
        if (n < 0 || _silGrid[n] !== 0) continue;
        _silGrid[n] = 3;
        _silStack[sp++] = n;
      }
    }
    if (size > best) best = size;
  }
  return best / ship;
}

/** The threshold the review shot is measured against: 0.5% of the ship's area. */
const SIL_MIN_HOLE = 0.009;

/**
 * Post-condition: the side projection must close round daylight.
 *
 * Run after the accents, because an accent can legitimately fill a gap and a
 * post-condition that fires before the last thing that can break it is
 * decoration. If the hull still has no hole it gets a dorsal gantry — a
 * conduit run on two pylons, which is what a real ship of this size carries
 * anyway — and the rescue is written into the placement log, because a hull
 * that needed rescuing is a hull whose archetype builder did not do its job.
 */
function ensureSpanningStructure(ctx: Ctx): void {
  const rng = new Rng(sub(shipSubSeed(ctx.seed, 'secondary'), 'span'));
  const p = ctx.prop;
  // Not short-circuited on `ctx.standoffs`: a mass on pylons has daylight under
  // it when it is placed, and stages 5 to 7 can still fill that daylight with a
  // radiator or a strake. Measuring is cheap next to a mass integration and
  // assuming is how a post-condition becomes a comment.
  // A yard whose massing doctrine has no external masses in it cannot be
  // rescued this way, and pretending otherwise is what the r5 contrast plate
  // caught: a monocoque hull carrying a welded-plate yard's dorsal gantry. The
  // measurement still runs and the refusal is still logged — a rule nobody
  // measures is a rule nobody keeps — but the answer for that yard is a
  // silhouette carried by proportion and section, which stages 1 and 3 own.
  const rescueable = yardBuilds(ctx, 'boom') && yardBuilds(ctx, 'pylon');
  for (let attempt = 0; attempt < 2; attempt++) {
    const side = enclosedHoleFraction(ctx, 0);
    if (side >= SIL_MIN_HOLE) return;
    reject(ctx, {
      stage: 'secondary',
      rule: 'silhouette-has-no-hole',
      what: rescueable
        ? 'side projection encloses no daylight'
        : 'side projection encloses no daylight; this yard builds no external mass to open one with',
      at: [0, 0, 0],
      measured: side,
      required: SIL_MIN_HOLE,
      attempt,
    });
    if (!rescueable) return;
    // Dorsal first, ventral if the dorsal run found nowhere to stand. Never a
    // lateral pair: a boom either side widens the beam without opening the one
    // projection this rule is about, and a hull that grows fat to satisfy its
    // own check has been made worse by it.
    const theta = attempt === 0 || ROLE_TOPOLOGY[ctx.role].landsOnSurfaces ? DORSAL : VENTRAL;
    const across = p.heightKm;
    const mass = standoff(ctx, rng, {
      kind: 'boom',
      bias: 'truss',
      theta,
      runFrom: 0.12,
      runTo: 0.86,
      outHalf: Math.max(HATCH_WIDTH_KM * 0.8, across * 0.05),
      sideHalf: Math.max(HATCH_WIDTH_KM * 0.8, across * 0.07),
      gap: Math.max(HUMAN_HEIGHT_KM * 2, across * 0.16),
      capStart: 'flat',
      capEnd: 'flat',
      materialSlot: MAT_STRUCT,
      detailDensity: 0.6,
      loadShare: 0.3,
    });
    if (!mass) return;
  }
}

/**
 * Stage 3 proper. Dispatch on topology.
 *
 * Every branch produces two to four masses and nothing else — no detail, no
 * bolt-ons, no rescue greebles. If the black silhouette does not work at the
 * end of this function it will not work at the end of the pipeline, and that is
 * deliberately where the check lives.
 */
function buildPrimary(ctx: Ctx): void {
  const rng = new Rng(shipSubSeed(ctx.seed, 'volumes'));
  switch (ctx.archetype) {
    case 'monolithic': buildMonolithic(ctx, rng); break;
    case 'stacked': buildStacked(ctx, rng); break;
    case 'spine-and-pod': buildSpineAndPod(ctx, rng); break;
    case 'fork': buildFork(ctx, rng); break;
    case 'ring': buildRing(ctx, rng); break;
    case 'slab': buildSlab(ctx, rng); break;
    case 'tower': buildTower(ctx, rng); break;
    case 'asymmetric': buildAsymmetric(ctx, rng); break;
    case 'cluster': buildCluster(ctx, rng); break;
  }
  ensurePayloadMass(ctx, rng);
  enforceSalvageMassing(ctx, rng);
  // The bow closes stage 3, not stage 7.
  //
  // It is structure — the forward end of the load path the engines push on —
  // and putting it in the accent pass meant it appeared AFTER the cockpit was
  // mounted, so on three hulls in fourteen the bridge ended up looking into
  // the back of a nose that had not existed when its site was chosen. Built
  // here, every clearance sweep downstream measures against a hull that has
  // its front end on. `enforceLongitudinalAxis` may still lengthen it in
  // stage 7, once everything that can widen the envelope exists.
  ctx.bow = buildBow(ctx, new Rng(sub(shipSubSeed(ctx.seed, 'volumes'), 'bow')));
}

/**
 * A salvage yard does not build matched pairs.
 *
 * `families.ts:1358+` says it in numbers — `salvage-weld`, panel size variance
 * 0.65 ("the single most legible 'this is a scavenger hull' cue"), tolerance
 * jitter 0.75 ("nothing lines up, because nothing was cut to fit anything"),
 * joint `torch-cut-graft` — and none of it reached the MASSING stage. Every
 * one of those fields is a material or a surface property, and material
 * variance is invisible at the range where a faction has to be identified: the
 * rendered Ossuary hull was two tubes of identical diameter, identical length
 * and identical cap in a clean mirrored pair. It looked like a tug from a
 * competent yard, which is the inverse of the doctrine.
 *
 * So the doctrine reaches the primary volumes. The two largest structural
 * masses on a salvage hull must differ in girth by at least 30% — that is the
 * read: two hulls that came off two different ships and were welded together
 * because they were what the yard had. The smaller one is taken in rather than
 * the larger one grown, so the ship keeps the size class it was asked for.
 */
const SALVAGE_MASS_RATIO = 1.32;

function enforceSalvageMassing(ctx: Ctx, rng: Rng): void {
  if (ctx.faction.construction.primary !== 'salvage-weld') return;

  const idx: number[] = [];
  const girth: number[] = [];
  for (let i = 0; i < ctx.volumes.length; i++) {
    const v = ctx.volumes[i];
    if (!isStructural(v.kind)) continue;
    let r = 0;
    for (const s of v.stations) r = Math.max(r, Math.max(s.halfWidth, s.halfHeight));
    if (r <= 0) continue;
    idx.push(i);
    girth.push(r);
  }
  if (idx.length < 2) return;

  // The two biggest, by girth.
  let a = 0;
  let b = 1;
  if (girth[b] > girth[a]) { const t = a; a = b; b = t; }
  for (let k = 2; k < idx.length; k++) {
    if (girth[k] > girth[a]) { b = a; a = k; } else if (girth[k] > girth[b]) b = k;
  }
  const ratio = girth[a] / Math.max(1e-9, girth[b]);
  if (ratio >= SALVAGE_MASS_RATIO) return;

  const k = ratio / (SALVAGE_MASS_RATIO * rng.range(1.0, 1.25));
  const i = idx[b];
  const v = ctx.volumes[i];
  ctx.volumes[i] = {
    ...v,
    stations: v.stations.map((s) => ({
      ...s,
      halfWidth: Math.max(1e-6, s.halfWidth * k),
      halfHeight: Math.max(1e-6, s.halfHeight * k),
    })),
    // A graft, not a fillet: the join between two hulls that were never meant
    // to meet is a torch-cut collar, and a hard station edge is how the loft
    // says so.
    capStart: v.capStart === 'open' ? 'open' : 'flat',
  };
  ctx.bounds[i] = undefined;
}

/**
 * The payload has to be the biggest thing on the ship.
 *
 * BRIEF §4 is not subtle about it: "a freighter must look like it carries
 * cargo… a role that is only a label on the same hull is a failure, not a
 * variation." Five of the nine archetype builders never emitted a payload
 * volume at all — a monolithic freighter was a tapered tube with an engine
 * block, and its `physics.cargoVolumeM3` came out as literally zero, so the
 * scan the HUD renders was factually wrong about what the ship was for. Where a
 * builder did emit pods, nothing checked that they beat the drive section, and
 * on the hero hull they did not: the largest single mass was the service tube.
 *
 * So this runs after every branch and enforces two things the role's own
 * `cargoFraction` implies:
 *
 *   1. a volume of the role's payload kind EXISTS;
 *   2. its side-projected area beats the drive section's by 1.4×, over at least
 *      40% of the hull's length, and it sits between the engines and the bridge
 *      so the load path reads engines-through-payload-to-nose.
 *
 * Where the archetype already provides one, this only grows it. Where it does
 * not, the payload arrives as a rack held off the hull on pylons — which is
 * both the honest answer for a hull with no internal bay and the shape that
 * puts daylight in the silhouette.
 */
function ensurePayloadMass(ctx: Ctx, rng: Rng): void {
  const kind = payloadOf(ctx);
  if (ctx.spec.forbiddenVolumeKinds.includes(kind)) return;
  // A gunship's "payload" is its guns and a derelict's is whatever is left; the
  // rule is about ships whose trade is carrying something.
  const CARRIERS: readonly ShipRole[] = [
    'freighter', 'courier', 'tanker', 'miner', 'prospector', 'salvager',
    'liner', 'colony', 'carrier', 'refinery',
  ];
  if (!CARRIERS.includes(ctx.role)) return;

  const p = ctx.prop;
  const L = p.lengthKm;
  // Side-projected area of what is already there, per kind.
  const areaOf = (v: PrimaryVolume): number => {
    const b = boundsOf(ctx, v);
    return (b.max[2] - b.min[2]) * (b.max[1] - b.min[1]);
  };
  let payloadArea = 0;
  let payloadSpan = 0;
  for (const v of ctx.volumes) {
    if (v.kind !== kind) continue;
    payloadArea += areaOf(v);
    const b = boundsOf(ctx, v);
    payloadSpan = Math.max(payloadSpan, b.max[2] - b.min[2]);
  }
  let driveArea = 0;
  for (const v of ctx.volumes) if (v.kind === 'afterbody' || v.kind === 'machinery') driveArea = Math.max(driveArea, areaOf(v));

  const enough = payloadArea >= driveArea * 1.4 && payloadSpan >= L * 0.4;
  if (enough) return;

  reject(ctx, {
    stage: 'secondary',
    rule: 'payload-not-dominant',
    what: `${ctx.role} payload (${kind}) is smaller than its own drive section`,
    at: [0, 0, 0],
    measured: driveArea > 0 ? payloadArea / driveArea : 0,
    required: 1.4,
    attempt: 0,
  });

  // How much section the role's cargo fraction actually asks for, as a radius.
  const frac = clamp(band(rng, ctx.spec.cargoFraction), 0.15, 0.92);
  const bias = payloadBias(kind);
  // Between the engines and the bridge: the run starts clear of the nose and
  // stops clear of the tail, so the eye goes engines → payload → nose. The
  // forward quarter is left alone deliberately — that is where the cockpit
  // looks out of, and a rack over the bow is a cockpit with a cargo pod in
  // front of it, which is the exact failure the clearance post-pass exists to
  // catch. Sixty per cent of the hull is still well past the 40% the payload
  // rule asks for.
  const runFrom = 0.26;
  const runTo = 0.86;
  const across = p.heightKm;
  // The rack has to be big enough to BE the answer, so it is sized from the
  // requirement and not only from taste: its side-projected area must beat the
  // drive section's by the same 1.4× the rule above measures, over a run that
  // is at least 40% of the hull. Sizing it from `cargoFraction` alone produced
  // a rack that satisfied the letter of "a payload exists" and lost the
  // argument about which mass is largest.
  const outHalf = Math.max(HATCH_WIDTH_KM, Math.sqrt(frac) * across * rng.range(0.3, 0.42));
  const sideHalf = Math.max(HATCH_WIDTH_KM, Math.sqrt(frac) * p.beamKm * rng.range(0.34, 0.48));
  // A ship that sets down on a surface does not hang its payload under its
  // belly: the legs would have to be longer than the hull is tall, which is
  // exactly why three of the roles that are supposed to land were refusing
  // their own undercarriage.
  const dorsal = ROLE_TOPOLOGY[ctx.role].landsOnSurfaces || kind !== 'tank' || rng.chance(0.6);
  const mass = standoff(ctx, rng, {
    kind,
    bias,
    theta: dorsal ? DORSAL : VENTRAL,
    runFrom,
    runTo,
    outHalf,
    sideHalf,
    // Enough daylight for a gantry crane to reach the containers, which is what
    // this gap is for on a real hull and what makes it read on this one.
    gap: Math.max(HUMAN_HEIGHT_KM * 3, across * rng.range(0.14, 0.22)),
    // The rack has to BE the answer, so it is sized from the requirement and
    // not only from taste: 1.45× the drive section's side-projected area, over
    // whatever run the hull actually offers.
    minSideArea: driveArea > 0 ? driveArea * 1.45 : undefined,
    capStart: kind === 'tank' ? 'dome' : 'flat',
    capEnd: kind === 'tank' ? 'dome' : 'flat',
    materialSlot: kind === 'machinery' ? MAT_STRUCT : MAT_HULL,
    detailDensity: kind === 'machinery' ? 0.85 : rng.range(0.2, 0.5),
    loadShare: 0.4,
  });
  if (mass) return;
  // `mirrorOf` is not set on the rack: it is one mass on the centreline, and
  // the pylons under it are already a mirrored pair by construction.

  // --- the fused answer ----------------------------------------------------
  //
  // A rack is one yard's answer to "the payload must be the largest thing on
  // the ship", not the only one, and on a yard whose doctrine is "where a hull
  // needs more volume the loft swells; where it needs less it draws out again"
  // it is the wrong one. BRIEF §4's requirement is about MASS AND READ, not
  // about racks: the payload still has to dominate the side projection and
  // still has to be visibly the thing this ship is for.
  //
  // So it swells. One volume on the ship's own axis, running the same 60% of
  // the hull, a little fuller than the section it grows out of, in hull plate
  // with the hull's own panel size — a bulge in one continuous body rather than
  // a box on masts. It reads as a hold from outside for the same reason a
  // widebody's belly does.
  const host = spanHost(ctx);
  if (!host) return;
  // Over the SHIP, not over the host, and for the reason `standoff` gives: on a
  // stacked hull the longest single volume is one segment of four, and a
  // payload sized to one segment is a third of the length it has to be and
  // loses the "which mass is largest" argument it exists to win.
  let shipZ0 = Infinity;
  let shipZ1 = -Infinity;
  for (let i = 0; i < ctx.volumes.length; i++) {
    const b = boundsAt(ctx, i);
    if (b.min[2] < shipZ0) shipZ0 = b.min[2];
    if (b.max[2] > shipZ1) shipZ1 = b.max[2];
  }
  if (!Number.isFinite(shipZ0) || shipZ1 <= shipZ0) return;
  const z0 = lerp(shipZ0, shipZ1, runFrom);
  const z1 = lerp(shipZ0, shipZ1, runTo);
  const runLen = z1 - z0;
  if (runLen <= 0) return;
  // Sampled off the host at the middle of the run rather than off the nominal
  // beam, so the swelling starts from the surface it is a swelling OF.
  const mid = host.stations[Math.floor(host.stations.length * 0.5)];
  // …and then grown until it MEETS the requirement, exactly as the rack's
  // `minSideArea` does. The profile below draws the ends in, so the run's mean
  // half-height is about 0.9 of the peak and the area has to be asked for
  // against that rather than against the peak.
  const MEAN_PROFILE = 0.9;
  const needHalfH = driveArea > 0 ? (driveArea * 1.45) / (2 * runLen * MEAN_PROFILE) : 0;
  const swellW = Math.max(HATCH_WIDTH_KM, mid.halfWidth * (1.06 + 0.22 * frac));
  const swellH = clamp(
    Math.max(mid.halfHeight * (1.08 + 0.3 * frac), needHalfH),
    HATCH_WIDTH_KM,
    // A swelling, not a second hull bolted through the first: past twice the
    // section it grew out of it stops reading as one body, which is the whole
    // reason this branch exists.
    Math.max(HATCH_WIDTH_KM * 1.01, mid.halfHeight * 2.0),
  );
  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind,
    frame: axialFrame(host.frame.origin[0], host.frame.origin[1], z0),
    length: runLen,
    halfWidth: swellW,
    halfHeight: swellH,
    bias,
    // Faired at both ends into the run it came out of. A flat cap here would be
    // a step, and a step is a joint, and this doctrine has no joints.
    capStart: 'taper',
    capEnd: 'taper',
    materialSlot: MAT_HULL,
    detailDensity: 0.1,
    loadShare: 0.4,
    stations: 7,
    frameEvery: 3,
    // Fullest amidships, drawn out at both ends: the loft swelling and drawing
    // out again, in one profile.
    profile: (u): number => lerp(0.72, 1, Math.sin(clamp01(u) * Math.PI) ** 0.55),
    profileY: (u): number => lerp(0.68, 1, Math.sin(clamp01(u) * Math.PI) ** 0.5),
    anchor: { kind: 'volume', volumeId: host.id, t: 0.5 },
  }));
}

// --- monolithic ------------------------------------------------------------
// One dominant tapered mass plus an engineering block. The `Ship.ts` read, and
// the only archetype where the profile parameters carry the whole silhouette.

function buildMonolithic(ctx: Ctx, rng: Rng): void {
  const p = ctx.prop;
  const L = p.lengthKm;
  const split = rng.range(0.82, 0.9);
  const hullLen = L * split;

  // The vertical profile is deliberately not the horizontal one: a hull whose
  // height and width taper identically is a solid of revolution, and reads as a
  // pipe from every angle. Blending the two by 0.35–0.8 keeps the family
  // resemblance while breaking the revolution.
  const yBlend = rng.range(0.35, 0.8);
  const profX = (t: number): number => profileAt(p, t * split);
  const profY = (t: number): number => lerp(1, profileAt(p, t * split), yBlend);

  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: 'hull',
    frame: axialFrame(0, 0, -L * 0.5),
    length: hullLen,
    halfWidth: p.beamKm * 0.5,
    halfHeight: p.heightKm * 0.5,
    bias: 'hull',
    capStart: noseCapFor(ctx, p.noseEnd),
    capEnd: 'flat',
    materialSlot: MAT_HULL,
    detailDensity: rng.range(0.35, 0.7),
    loadShare: 0.7,
    profile: profX,
    profileY: profY,
    anchor: { kind: 'spine', nodeId: ctx.spine.chains[0].nodes[1].id },
  }));

  const aftR = profileAt(p, split);
  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: 'afterbody',
    frame: axialFrame(0, 0, -L * 0.5 + hullLen),
    length: L - hullLen,
    halfWidth: p.beamKm * 0.5 * aftR * rng.range(0.9, 1.12),
    halfHeight: p.heightKm * 0.5 * lerp(1, aftR, yBlend) * rng.range(0.9, 1.12),
    bias: 'machinery',
    capStart: 'open',
    capEnd: 'flat',
    materialSlot: MAT_STRUCT,
    detailDensity: rng.range(0.6, 0.95),
    loadShare: 1.0,
    hardStart: true,
    anchor: { kind: 'spine', nodeId: ctx.spine.chains[0].nodes[ctx.spine.chains[0].nodes.length - 1].id },
  }));
}

// --- stacked ---------------------------------------------------------------
// Three or four segments with different section FAMILIES and hard diameter
// steps. A round nose into a hexagonal mid-body into a boxy engineering section
// gives three distinct silhouettes in one hull, which no single swept volume
// can do however its exponent ramps.

function buildStacked(ctx: Ctx, rng: Rng): void {
  const p = ctx.prop;
  const L = p.lengthKm;
  const n = rng.int(3, 4);

  // Segment lengths, normalised. Sampling then normalising (rather than picking
  // a partition) keeps every segment a legible fraction instead of occasionally
  // producing a 3% ring nobody reads as a segment.
  const raw: number[] = [];
  for (let i = 0; i < n; i++) raw.push(rng.range(0.6, 1.6));
  const total = raw.reduce((s, v) => s + v, 0);

  // Diameter steps of at least 18%: below that the join reads as a manufacturing
  // tolerance rather than as two different parts bolted together.
  const scales: number[] = [rng.range(0.55, 1.0)];
  for (let i = 1; i < n; i++) {
    let s = rng.range(0.4, 1.0);
    if (Math.abs(s - scales[i - 1]) < 0.18) s = scales[i - 1] > 0.7 ? scales[i - 1] - 0.24 : scales[i - 1] + 0.24;
    scales.push(clamp(s, 0.28, 1.0));
  }

  let z = -L * 0.5;
  for (let i = 0; i < n; i++) {
    const len = (raw[i] / total) * L;
    const kind: VolumeKind = i === 0 ? 'forebody' : i === n - 1 ? 'afterbody' : 'midbody';
    const bias: SectionBias = i === n - 1 ? 'machinery' : i === 0 ? 'hull' : rng.chance(0.4) ? 'tank' : 'hull';
    const sIn = scales[i];
    const sOut = i === n - 1 ? scales[i] * rng.range(0.8, 1.0) : scales[i];
    ctx.volumes.push(sweptVolume(ctx, rng, {
      kind,
      frame: axialFrame(0, 0, z),
      length: len,
      halfWidth: p.beamKm * 0.5,
      halfHeight: p.heightKm * 0.5,
      bias,
      capStart: i === 0 ? noseCapFor(ctx, p.noseEnd) : 'flat',
      capEnd: i === n - 1 ? 'flat' : 'flat',
      materialSlot: i === n - 1 ? MAT_STRUCT : MAT_HULL,
      detailDensity: i === n - 1 ? rng.range(0.6, 0.95) : rng.range(0.3, 0.65),
      loadShare: lerp(0.35, 1, i / (n - 1)),
      profile: (t) => lerp(sIn, sOut, t) * (i === 0 ? profileAt(p, t * 0.5) : 1),
      profileY: (t) => lerp(sIn, sOut, t) * (i === 0 ? lerp(1, profileAt(p, t * 0.5), 0.6) : 1),
      hardStart: i > 0,
      frameEvery: rng.int(1, 3),
      anchor: { kind: 'spine', nodeId: ctx.spine.chains[0].nodes[clamp(Math.round((i / n) * (ctx.spine.chains[0].nodes.length - 1)), 0, ctx.spine.chains[0].nodes.length - 1)].id },
    }));
    z += len;
  }
}

// --- spine-and-pod ---------------------------------------------------------
// The freighter. An exposed truss keel carries the load; the payload hangs off
// it and IS the silhouette. BRIEF §4: "a freighter's cargo volume should BE
// most of its silhouette" — so the pods are sized from `cargoFraction` before
// anything else is placed, and the cab and the engine block are what is left.

function buildSpineAndPod(ctx: Ctx, rng: Rng): void {
  const p = ctx.prop;
  const L = p.lengthKm;
  const keelZ0 = -L * 0.4;
  const keelZ1 = L * 0.4;
  const keelR = Math.max(p.beamKm, p.heightKm) * rng.range(0.1, 0.19);

  const keel = sweptVolume(ctx, rng, {
    kind: 'keel',
    frame: axialFrame(0, 0, keelZ0),
    length: keelZ1 - keelZ0,
    halfWidth: keelR,
    halfHeight: keelR,
    bias: 'truss',
    capStart: 'open',
    capEnd: 'open',
    materialSlot: MAT_STRUCT,
    detailDensity: 0.25,
    loadShare: 1.0,
    frameEvery: 1,
    anchor: { kind: 'spine', nodeId: ctx.spine.chains[0].nodes[0].id },
  });
  ctx.volumes.push(keel);

  // Cab at the nose. Small, and deliberately much narrower than the payload —
  // that size contrast is most of what says "hauler" at a glance.
  const cabLen = L * rng.range(0.1, 0.17);
  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: 'forebody',
    frame: axialFrame(0, 0, -L * 0.5),
    length: cabLen,
    halfWidth: p.beamKm * rng.range(0.18, 0.3),
    halfHeight: p.heightKm * rng.range(0.2, 0.34),
    bias: 'hull',
    capStart: noseCapFor(ctx, p.noseEnd),
    capEnd: 'flat',
    materialSlot: MAT_HULL,
    detailDensity: rng.range(0.45, 0.8),
    loadShare: 0.15,
    anchor: { kind: 'spine', nodeId: ctx.spine.chains[0].nodes[0].id },
  }));

  const blockLen = L * rng.range(0.11, 0.18);
  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: 'afterbody',
    frame: axialFrame(0, 0, L * 0.5 - blockLen),
    length: blockLen,
    halfWidth: p.beamKm * rng.range(0.26, 0.42),
    halfHeight: p.heightKm * rng.range(0.3, 0.46),
    bias: 'machinery',
    capStart: 'flat',
    capEnd: 'flat',
    materialSlot: MAT_STRUCT,
    detailDensity: rng.range(0.7, 1.0),
    loadShare: 1.0,
    anchor: { kind: 'spine', nodeId: ctx.spine.chains[0].nodes[ctx.spine.chains[0].nodes.length - 1].id },
  }));

  const kind = payloadOf(ctx);
  const bias = payloadBias(kind);
  const arrangement = pickWeighted(rng, [
    ['inline', 4] as const, ['ventral', 3] as const, ['lateral', 4] as const, ['radial', 2] as const,
  ]);
  const podShape = makeSection(rng, ctx.dna, bias, true);
  const podScalars = makeScalars(rng, ctx.dna, podShape, bias);
  const span = keelZ1 - keelZ0 - cabLen * 0.3;
  const cargoFrac = band(rng, ctx.spec.cargoFraction);

  /**
   * Daylight between the keel and the pods, and it is not optional.
   *
   * The standoff used to be `keelR + r × 0.9…1.25`, which on the hero hull put
   * the pod's inner face INSIDE the keel: the pods and the keel fused into one
   * horizontal slab and the archetype whose whole read is "an open frame with
   * the payload hung off it" produced a silhouette with no daylight anywhere in
   * it. A hauler's pods stand clear of the keel because a crew has to get
   * between them, so the gap is a human-scale absolute with a proportional
   * floor, and the pods sit outside it rather than at it.
   */
  const standoffGap = Math.max(HUMAN_HEIGHT_KM * 2.5, Math.max(p.beamKm, p.heightKm) * rng.range(0.07, 0.12));
  /** [pod, outward unit, radius of the pod's inner face, z] — a bracket goes here. */
  const hangers: [PrimaryVolume, Vec3, number, number][] = [];

  const addPod = (frameIn: Frame, len: number, hw: number, hh: number, mirrorOf: string | null, anchorT: number): PrimaryVolume => {
    const v = sweptVolume(ctx, rng, {
      kind,
      frame: frameIn,
      length: len,
      halfWidth: hw,
      halfHeight: hh,
      bias,
      capStart: kind === 'tank' ? 'dome' : 'flat',
      capEnd: kind === 'tank' ? 'dome' : 'flat',
      materialSlot: kind === 'machinery' ? MAT_STRUCT : MAT_HULL,
      detailDensity: kind === 'machinery' ? 0.9 : rng.range(0.2, 0.5),
      loadShare: 0.35,
      shape: podShape,
      scalars: podScalars,
      mirrorOf,
      anchor: { kind: 'volume', volumeId: keel.id, t: anchorT },
      frameEvery: 1,
    });
    ctx.volumes.push(v);
    return v;
  };

  switch (arrangement) {
    case 'inline': {
      const n = rng.int(2, 5);
      const gap = span * 0.04;
      const len = (span - gap * (n - 1)) / n;
      // Radius is set from the cargo fraction, not from taste: half of a
      // freighter's enclosed volume has to fit in these, so they are fat.
      const r = Math.sqrt(clamp(cargoFrac, 0.1, 0.8)) * Math.max(p.beamKm, p.heightKm) * 0.52;
      for (let i = 0; i < n; i++) {
        const z = keelZ0 + i * (len + gap);
        addPod(axialFrame(0, 0, z), len, r, r * rng.range(0.85, 1.1), null, (z - keelZ0) / (keelZ1 - keelZ0));
      }
      break;
    }
    case 'ventral': {
      const n = rng.int(2, 4);
      const len = (span / n) * 0.9;
      const r = Math.sqrt(clamp(cargoFrac, 0.1, 0.8)) * p.beamKm * 0.45;
      const drop = keelR + standoffGap + r;
      for (let i = 0; i < n; i++) {
        const z = keelZ0 + (span / n) * i;
        const v = addPod(axialFrame(0, -drop, z), len, r, r * 0.8, null, (z - keelZ0) / (keelZ1 - keelZ0));
        hangers.push([v, [0, -1, 0], drop - r, z + len * 0.5]);
      }
      break;
    }
    case 'lateral': {
      const n = rng.int(1, 3);
      const len = (span / n) * 0.88;
      const r = Math.sqrt(clamp(cargoFrac, 0.1, 0.8)) * p.beamKm * 0.34;
      const x = keelR + standoffGap + r;
      for (let i = 0; i < n; i++) {
        const z = keelZ0 + (span / n) * i;
        const t = (z - keelZ0) / (keelZ1 - keelZ0);
        const hh = r * rng.range(0.9, 1.3);
        const a = addPod(axialFrame(x, 0, z), len, r, hh, null, t);
        const b = addPod(axialFrame(-x, 0, z), len, r, hh, a.id, t);
        hangers.push([a, [1, 0, 0], x - r, z + len * 0.5], [b, [-1, 0, 0], x - r, z + len * 0.5]);
      }
      break;
    }
    default: {
      // Radial: three or four pods clocked round the keel. Symmetric about the
      // vertical because the set {π/2 + 2πk/n} is closed under θ → π−θ.
      const n = rng.int(3, 4);
      const len = span * rng.range(0.6, 0.85);
      const r = Math.sqrt(clamp(cargoFrac, 0.1, 0.8)) * Math.max(p.beamKm, p.heightKm) * 0.3;
      const rr = keelR + standoffGap + r;
      const z0 = keelZ0 + (span - len) * 0.5;
      for (let i = 0; i < n; i++) {
        const a = Math.PI / 2 + (i / n) * TAU;
        const v = addPod(axialFrame(Math.cos(a) * rr, Math.sin(a) * rr, z0), len, r, r, null, 0.5);
        hangers.push([v, [Math.cos(a), Math.sin(a), 0], rr - r, z0 + len * 0.5]);
      }
      break;
    }
  }

  // The hangers are the point of the archetype. A pod bolted flush to the keel
  // is a bulge; a pod on a bracket with daylight under it is a load path, and
  // it is the only thing that puts an enclosed hole in the black silhouette.
  const rHang = clamp(standoffGap * 0.32, HATCH_WIDTH_KM * 0.3, keelR * 0.9);
  for (const [pod, dir, base, z] of hangers) {
    const from: Vec3 = [dir[0] * keelR * 0.85, dir[1] * keelR * 0.85, z];
    const to: Vec3 = [dir[0] * (base + 1e-6), dir[1] * (base + 1e-6), z];
    strut(ctx, rng, from, to, rHang, keel.id);
    void pod;
  }
}

// --- fork ------------------------------------------------------------------
// Two booms forward of a shared aft body. From the front this is two lobes with
// daylight between them; from the side it is one long slab. No monolithic hull
// produces either read.

function buildFork(ctx: Ctx, rng: Rng): void {
  const p = ctx.prop;
  const L = p.lengthKm;
  const joinZ = L * rng.range(0.0, 0.12);

  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: 'afterbody',
    frame: axialFrame(0, 0, joinZ),
    length: L * 0.5 - joinZ,
    halfWidth: p.beamKm * rng.range(0.34, 0.48),
    halfHeight: p.heightKm * rng.range(0.4, 0.5),
    bias: 'machinery',
    capStart: 'blunt',
    capEnd: 'flat',
    materialSlot: MAT_STRUCT,
    detailDensity: rng.range(0.6, 0.95),
    loadShare: 1.0,
    anchor: { kind: 'spine', nodeId: ctx.spine.chains[0].nodes[ctx.spine.chains[0].nodes.length - 1].id },
  }));

  const sep = p.beamKm * rng.range(0.24, 0.34);
  const bw = p.beamKm * rng.range(0.11, 0.18);
  const bh = p.heightKm * rng.range(0.3, 0.48);
  const boomShape = makeSection(rng, ctx.dna, 'hull', true);
  const boomScalars = makeScalars(rng, ctx.dna, boomShape, 'hull');
  const boomLen = joinZ + L * 0.5 + L * 0.06;
  const prof = (t: number): number => profileAt(p, clamp(t * 0.8, 0, 1));

  const mk = (x: number, mirrorOf: string | null): PrimaryVolume => {
    const v = sweptVolume(ctx, rng, {
      kind: 'boom',
      frame: axialFrame(x, 0, -L * 0.5),
      length: boomLen,
      halfWidth: bw,
      halfHeight: bh,
      bias: 'hull',
      capStart: noseCapFor(ctx, p.noseEnd),
      capEnd: 'open',
      materialSlot: MAT_HULL,
      detailDensity: rng.range(0.35, 0.7),
      loadShare: 0.5,
      profile: prof,
      profileY: (t) => lerp(1, prof(t), 0.5),
      shape: boomShape,
      scalars: boomScalars,
      mirrorOf,
      anchor: { kind: 'spine', nodeId: ctx.spine.chains[Math.min(1, ctx.spine.chains.length - 1)].nodes[0].id },
    });
    ctx.volumes.push(v);
    return v;
  };
  const port = mk(sep, null);
  mk(-sep, port.id);

  // A cross-member closing the fork turns two booms into a frame. Without it a
  // fork reads as two ships flying formation, which is a real failure mode.
  if (rng.chance(0.55)) {
    const z = lerp(-L * 0.4, joinZ - L * 0.05, rng.next());
    ctx.volumes.push(sweptVolume(ctx, rng, {
      kind: 'pylon',
      frame: frameAt([-sep, 0, z], [1, 0, 0], UP_Y),
      length: sep * 2,
      halfWidth: bw * rng.range(0.3, 0.5),
      halfHeight: bh * rng.range(0.2, 0.4),
      bias: 'boom',
      capStart: 'flat',
      capEnd: 'flat',
      materialSlot: MAT_STRUCT,
      detailDensity: 0.6,
      loadShare: 0.4,
      stations: 3,
    }));
  }
}

// --- ring ------------------------------------------------------------------
// A closed hoop, a hub and spokes. `VolumePath.arc` with sweep 2π is the only
// way to express this; an offset cannot turn a frame.

function buildRing(ctx: Ctx, rng: Rng): void {
  const p = ctx.prop;
  const L = p.lengthKm;
  const upright = rng.chance(0.65);
  const R = Math.max(p.beamKm, p.heightKm) * rng.range(0.36, 0.48);
  const tube = R * rng.range(0.1, 0.19);
  const zRing = lerp(-L * 0.15, L * 0.2, rng.next());

  const hubR = Math.max(p.beamKm, p.heightKm) * rng.range(0.1, 0.17);
  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: 'hull',
    frame: axialFrame(0, 0, -L * 0.5),
    length: L * rng.range(0.9, 1.0),
    halfWidth: hubR,
    halfHeight: hubR * rng.range(0.85, 1.15),
    bias: 'hull',
    capStart: noseCapFor(ctx, p.noseEnd),
    capEnd: 'flat',
    materialSlot: MAT_HULL,
    detailDensity: rng.range(0.4, 0.75),
    loadShare: 1.0,
    profile: (t) => profileAt(p, t),
    anchor: { kind: 'spine', nodeId: ctx.spine.chains[0].nodes[0].id },
  }));

  // Upright: the ring lies in XY and spins about Z, the classic wheel seen
  // head-on. Flat: it lies in XZ and reads as a halo from above. The centre of
  // curvature is `radius` to starboard of the run start (`volumePathFrame`), so
  // the origin is placed one radius the other way to centre the hoop on the axis.
  const ringFrame: Frame = upright
    ? { origin: [0, -R, zRing], forward: [1, 0, 0], up: [0, 0, 1] }
    : { origin: [0, zRing === 0 ? 0 : 0, R], forward: [1, 0, 0], up: UP_Y };
  const ringOrigin: Frame = upright ? ringFrame : { origin: [0, 0, R], forward: [1, 0, 0], up: UP_Y };

  const ring = sweptVolume(ctx, rng, {
    kind: 'ring',
    frame: ringOrigin,
    length: TAU * R,
    halfWidth: tube,
    halfHeight: tube * rng.range(0.8, 1.4),
    bias: 'pod',
    capStart: 'open',
    capEnd: 'open',
    materialSlot: MAT_HULL,
    detailDensity: rng.range(0.3, 0.6),
    loadShare: 0.3,
    arc: { radius: R, sweep: TAU },
    stations: rng.int(10, 18),
    frameEvery: 1,
  });
  ctx.volumes.push(ring);

  const spokes = rng.int(3, 6);
  const spokeR = tube * rng.range(0.24, 0.42);
  const spokeShape = makeSection(rng, ctx.dna, 'boom', true);
  const spokeScalars = makeScalars(rng, ctx.dna, spokeShape, 'boom');
  for (let i = 0; i < spokes; i++) {
    const a = Math.PI / 2 + (i / spokes) * TAU;
    const dir: Vec3 = upright ? [Math.cos(a), Math.sin(a), 0] : [Math.cos(a), 0, -Math.sin(a)];
    const origin: Vec3 = upright
      ? [dir[0] * hubR, dir[1] * hubR, zRing]
      : [dir[0] * hubR, 0, dir[2] * hubR];
    ctx.volumes.push(sweptVolume(ctx, rng, {
      kind: 'boom',
      frame: frameAt(origin, dir, upright ? FWD_Z : UP_Y),
      length: Math.max(1e-5, R - hubR - tube * 0.4),
      halfWidth: spokeR,
      halfHeight: spokeR,
      bias: 'boom',
      capStart: 'flat',
      capEnd: 'flat',
      materialSlot: MAT_STRUCT,
      detailDensity: 0.4,
      loadShare: 0.2,
      shape: spokeShape,
      scalars: spokeScalars,
      stations: 3,
      anchor: { kind: 'volume', volumeId: ring.id, t: i / spokes },
    }));
  }
}

// --- slab ------------------------------------------------------------------
// The carrier. A wide, flat deck with an OFF-CENTRE island: the one archetype
// whose defining feature is a deliberate break in bilateral symmetry, and the
// cheapest possible read on "this ship launches other ships".

function buildSlab(ctx: Ctx, rng: Rng): void {
  const p = ctx.prop;
  const L = p.lengthKm;
  const deckLen = L * rng.range(0.86, 0.96);

  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: 'hull',
    frame: axialFrame(0, 0, -L * 0.5),
    length: deckLen,
    halfWidth: p.beamKm * 0.5,
    halfHeight: p.heightKm * 0.5,
    bias: 'hull',
    capStart: p.noseEnd > 0.6 ? 'flat' : 'taper',
    capEnd: 'flat',
    materialSlot: MAT_HULL,
    detailDensity: rng.range(0.3, 0.55),
    loadShare: 1.0,
    // Deliberately boxy: a flight deck is a plane, and a superellipse at n = 7
    // is a plane with a fillet on it.
    scalars: { exponent: rng.range(5.5, 8), chamfer: 0.2, lobeSeparation: 0, ventralFlatten: rng.range(0.85, 1) },
    profile: (t) => lerp(rng.chance(0.5) ? 0.72 : 0.9, 1, smoothstep(t * 3)) * (t > 0.9 ? lerp(1, 0.94, (t - 0.9) * 10) : 1),
    profileY: () => 1,
    anchor: { kind: 'spine', nodeId: ctx.spine.chains[0].nodes[1].id },
  }));

  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: 'afterbody',
    frame: axialFrame(0, 0, -L * 0.5 + deckLen),
    length: L - deckLen,
    halfWidth: p.beamKm * 0.46,
    halfHeight: p.heightKm * 0.5,
    bias: 'machinery',
    capStart: 'open',
    capEnd: 'flat',
    materialSlot: MAT_STRUCT,
    detailDensity: rng.range(0.65, 0.95),
    loadShare: 1.0,
    hardStart: true,
  }));

  // The island. Vertical run: `forward` = +Y, so the section's half-width lies
  // along ship X and its half-height along the fore-aft axis.
  const side = rng.chance(0.5) ? 1 : -1;
  const ix = side * p.beamKm * rng.range(0.24, 0.36);
  const iz = lerp(-L * 0.12, L * 0.2, rng.next());
  const ih = p.heightKm * rng.range(0.8, 1.6);
  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: 'bridge',
    frame: frameAt([ix, p.heightKm * 0.42, iz], UP_Y, [0, 0, -1]),
    length: ih,
    halfWidth: p.beamKm * rng.range(0.06, 0.11),
    halfHeight: L * rng.range(0.05, 0.1),
    bias: 'hull',
    capStart: 'flat',
    capEnd: 'flat',
    materialSlot: MAT_HULL,
    detailDensity: rng.range(0.6, 0.95),
    loadShare: 0.1,
    profile: (t) => lerp(1, rng.range(0.4, 0.75), t),
    profileY: (t) => lerp(1, 0.85, t),
  }));

  // Hangar mouth: an open shroud whose interior is visible. This is the shape
  // that says "things come out of here" without a single greeble.
  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: 'shroud',
    frame: axialFrame(0, -p.heightKm * rng.range(0.02, 0.1), -L * 0.5 - L * 0.005),
    length: L * rng.range(0.18, 0.32),
    halfWidth: p.beamKm * rng.range(0.24, 0.36),
    halfHeight: p.heightKm * rng.range(0.28, 0.4),
    bias: 'panel',
    capStart: 'open',
    capEnd: 'open',
    materialSlot: MAT_STRUCT,
    detailDensity: 0.8,
    loadShare: 0.1,
    interiorVisible: true,
    stations: 3,
  }));
}

// --- tower -----------------------------------------------------------------
// The refinery and the station tender. The long axis is VERTICAL: the hull is
// taller than it is long, which nothing else in the fleet is.

function buildTower(ctx: Ctx, rng: Rng): void {
  const p = ctx.prop;
  const L = p.lengthKm;
  const H = p.heightKm;

  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: 'hull',
    frame: axialFrame(0, -H * rng.range(0.25, 0.4), -L * 0.5),
    length: L * rng.range(0.9, 1.0),
    halfWidth: p.beamKm * 0.5,
    halfHeight: H * rng.range(0.1, 0.2),
    bias: 'hull',
    capStart: 'blunt',
    capEnd: 'flat',
    materialSlot: MAT_HULL,
    detailDensity: rng.range(0.5, 0.85),
    loadShare: 1.0,
    profile: (t) => profileAt(p, t),
    profileY: () => 1,
  }));

  const stacks = rng.int(1, 3);
  const towerShape = makeSection(rng, ctx.dna, 'machinery', true);
  const towerScalars = makeScalars(rng, ctx.dna, towerShape, 'machinery');
  for (let i = 0; i < stacks; i++) {
    const hx = i === 0 ? 0 : (i % 2 === 0 ? 1 : -1) * p.beamKm * rng.range(0.16, 0.3);
    const hz = i === 0 ? lerp(-L * 0.1, L * 0.15, rng.next()) : lerp(-L * 0.3, L * 0.3, rng.next());
    const hgt = H * (i === 0 ? rng.range(0.75, 1.0) : rng.range(0.4, 0.75));
    const r = p.beamKm * (i === 0 ? rng.range(0.18, 0.3) : rng.range(0.07, 0.14));
    ctx.volumes.push(sweptVolume(ctx, rng, {
      kind: i === 0 ? 'machinery' : 'tank',
      frame: frameAt([hx, -H * rng.range(0.15, 0.3), hz], UP_Y, [0, 0, -1]),
      length: hgt,
      halfWidth: r,
      halfHeight: r * rng.range(0.8, 1.4),
      bias: i === 0 ? 'machinery' : 'tank',
      capStart: 'flat',
      capEnd: i === 0 ? 'flat' : 'dome',
      materialSlot: i === 0 ? MAT_STRUCT : MAT_HULL,
      detailDensity: i === 0 ? rng.range(0.8, 1.0) : rng.range(0.2, 0.45),
      loadShare: i === 0 ? 0.6 : 0.2,
      shape: i === 0 ? towerShape : undefined,
      scalars: i === 0 ? towerScalars : undefined,
      profile: (t) => lerp(1, rng.range(0.6, 1.0), t),
      anchor: ctx.spine.chains.length > 1 ? { kind: 'spine', nodeId: ctx.spine.chains[1].nodes[0].id } : null,
    }));
  }
}

// --- asymmetric ------------------------------------------------------------
// The working hull. One large mass on ONE side, no counterweight, and the main
// hull shifted off the centreline to acknowledge it. The result tumbles oddly
// with assist off and the physics profile says so in `inertiaProducts`.

function buildAsymmetric(ctx: Ctx, rng: Rng): void {
  const p = ctx.prop;
  const L = p.lengthKm;
  const side = rng.chance(0.5) ? 1 : -1;
  const shift = -side * p.beamKm * rng.range(0.08, 0.17);

  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: 'hull',
    frame: axialFrame(0, 0, -L * 0.5),
    length: L * rng.range(0.84, 0.94),
    halfWidth: p.beamKm * rng.range(0.28, 0.38),
    halfHeight: p.heightKm * 0.5,
    bias: 'hull',
    capStart: noseCapFor(ctx, p.noseEnd),
    capEnd: 'flat',
    materialSlot: MAT_HULL,
    detailDensity: rng.range(0.45, 0.8),
    loadShare: 1.0,
    profile: (t) => profileAt(p, t),
    profileY: (t) => lerp(1, profileAt(p, t), 0.55),
    offsetFn: () => [shift, 0],
  }));

  const gz0 = lerp(-L * 0.42, -L * 0.2, rng.next());
  const gz1 = lerp(L * 0.1, L * 0.38, rng.next());
  const gr = p.beamKm * rng.range(0.16, 0.26);
  // The offset mass is the archetype and it stays on every yard. Whether it
  // stands OFF the hull on a pylon or grows OUT of it is doctrine: a yard that
  // refuses pylons gets the mass pulled in until it overlaps, which is the same
  // asymmetry told as a swelling in one loft rather than as a bolt-on.
  const slung = yardBuilds(ctx, 'pylon');
  const gx = slung
    ? side * (p.beamKm * rng.range(0.24, 0.36))
    : shift + side * gr * rng.range(0.45, 0.7);
  const gantryKind: VolumeKind = ctx.role === 'salvager' || ctx.role === 'station-tender' ? 'machinery' : payloadOf(ctx);
  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: gantryKind,
    frame: axialFrame(gx, lerp(-p.heightKm * 0.15, p.heightKm * 0.2, rng.next()), gz0),
    length: gz1 - gz0,
    halfWidth: gr,
    halfHeight: gr * rng.range(0.7, 1.5),
    bias: payloadBias(gantryKind),
    capStart: 'flat',
    capEnd: 'flat',
    materialSlot: gantryKind === 'machinery' ? MAT_STRUCT : MAT_HULL,
    detailDensity: gantryKind === 'machinery' ? rng.range(0.85, 1.0) : rng.range(0.3, 0.6),
    loadShare: 0.45,
    frameEvery: 1,
    anchor: ctx.spine.chains.length > 1 ? { kind: 'spine', nodeId: ctx.spine.chains[1].nodes[0].id } : null,
  }));

  // The pylon that carries it. Without this the mass floats; with it the hull
  // reads as having been modified to take the load, which is the story. On a
  // fused yard the mass is already inside the loft, so there is nothing to
  // carry and a pylon would be a joint on a hull that has none.
  if (slung) ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: 'pylon',
    frame: frameAt([shift, 0, lerp(gz0, gz1, 0.5)], [side, 0, 0], UP_Y),
    length: Math.abs(gx - shift),
    halfWidth: gr * rng.range(0.25, 0.4),
    halfHeight: gr * rng.range(0.3, 0.55),
    bias: 'boom',
    capStart: 'flat',
    capEnd: 'flat',
    materialSlot: MAT_STRUCT,
    detailDensity: 0.7,
    loadShare: 0.45,
    stations: 3,
  }));

  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: 'afterbody',
    frame: axialFrame(0, 0, L * 0.5 - L * 0.12),
    length: L * 0.12,
    halfWidth: p.beamKm * rng.range(0.24, 0.34),
    halfHeight: p.heightKm * rng.range(0.35, 0.48),
    bias: 'machinery',
    capStart: 'open',
    capEnd: 'flat',
    materialSlot: MAT_STRUCT,
    detailDensity: rng.range(0.7, 1.0),
    loadShare: 1.0,
    offsetFn: () => [shift, 0],
  }));
}

// --- cluster ---------------------------------------------------------------
// Several near-equal cans bundled round a core. The tanker and the colony ship:
// mass distributed rather than concentrated, and a front view that is a rosette
// rather than a blob.

function buildCluster(ctx: Ctx, rng: Rng): void {
  const p = ctx.prop;
  const L = p.lengthKm;
  const n = rng.int(3, 6);
  const coreR = Math.max(p.beamKm, p.heightKm) * rng.range(0.1, 0.17);

  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: 'hull',
    frame: axialFrame(0, 0, -L * 0.5),
    length: L * rng.range(0.92, 1.0),
    halfWidth: coreR,
    halfHeight: coreR,
    bias: 'hull',
    capStart: noseCapFor(ctx, p.noseEnd),
    capEnd: 'flat',
    materialSlot: MAT_HULL,
    detailDensity: rng.range(0.4, 0.75),
    loadShare: 1.0,
    profile: (t) => profileAt(p, t),
    anchor: { kind: 'spine', nodeId: ctx.spine.chains[0].nodes[0].id },
  }));

  const kind = payloadOf(ctx);
  const bias = payloadBias(kind);
  const canShape = makeSection(rng, ctx.dna, bias, true);
  const canScalars = makeScalars(rng, ctx.dna, canShape, bias);
  const canR = Math.max(p.beamKm, p.heightKm) * rng.range(0.15, 0.23);
  const ringR = coreR + canR * rng.range(0.95, 1.15);
  const canLen = L * rng.range(0.6, 0.82);
  const z0 = lerp(-L * 0.44, -L * 0.2, rng.next());

  for (let i = 0; i < n; i++) {
    // {π/2 + 2πk/n} is closed under θ → π−θ, so the bundle stays bilaterally
    // symmetric for every n, odd or even.
    const a = Math.PI / 2 + (i / n) * TAU;
    ctx.volumes.push(sweptVolume(ctx, rng, {
      kind,
      frame: axialFrame(Math.cos(a) * ringR, Math.sin(a) * ringR, z0),
      length: canLen,
      halfWidth: canR,
      halfHeight: canR,
      bias,
      capStart: kind === 'tank' ? 'dome' : 'flat',
      capEnd: kind === 'tank' ? 'dome' : 'flat',
      materialSlot: MAT_HULL,
      detailDensity: rng.range(0.2, 0.5),
      loadShare: 0.3,
      shape: canShape,
      scalars: canScalars,
      frameEvery: 1,
      anchor: { kind: 'spine', nodeId: ctx.spine.chains[0].nodes[Math.floor(ctx.spine.chains[0].nodes.length / 2)].id },
    }));
  }

  ctx.volumes.push(sweptVolume(ctx, rng, {
    kind: 'afterbody',
    frame: axialFrame(0, 0, L * 0.5 - L * 0.13),
    length: L * 0.13,
    halfWidth: ringR * rng.range(0.75, 1.0),
    halfHeight: ringR * rng.range(0.75, 1.0),
    bias: 'machinery',
    capStart: 'flat',
    capEnd: 'flat',
    materialSlot: MAT_STRUCT,
    detailDensity: rng.range(0.7, 1.0),
    loadShare: 1.0,
  }));
}

// ===========================================================================
// Mass — owned by `physics.ts`
//
// This file deliberately holds NO mass model. `shipMassProperties` integrates
// the same `volumeSurfacePoint` surface this generator lofts, with a finer
// skin-areal-plus-outfit law than anything belonging here, and it is the model
// the flight computer will fly. A second integration living in this file would
// mean the generator balanced a hull its own physics called unbalanced — which
// is worse than not balancing it. The only two things left are predicates about
// what a volume CONTAINS, which is a question about the ship's function rather
// than about its mass.
// ===========================================================================

/** True when a volume's enclosed space is propellant rather than structure. */
function fuelFraction(v: PrimaryVolume): number {
  if (v.kind === 'tank') return 0.85;
  if (v.construction.kind === 'tank') return 0.8;
  return 0;
}

// ===========================================================================
// Sockets — the typed mounts, measured once
// ===========================================================================

interface SocketRequest<T extends SocketType> {
  readonly type: T;
  readonly frame: Frame;
  readonly host: SocketHost;
  readonly radius: number;
  readonly depth: number;
  readonly massKg: number;
  readonly accepts: readonly ModuleKind[];
  readonly mirrorOf?: SocketId | null;
  /** How far to probe when measuring clearance and the clear cone, km. */
  readonly probe?: number;
}

/**
 * Mint a socket and MEASURE its free space.
 *
 * The measurement is the whole point. `clearance` and `clearAngle` turn four of
 * the seven BRIEF §5 rules into fields a reviewer can read, and
 * `moduleFitsSocket` in `types.ts` already refuses a module deeper than the
 * clearance — so a socket that was measured honestly cannot later accept
 * something that intersects the hull.
 */
function addSocket<T extends SocketType>(ctx: Ctx, req: SocketRequest<T>): Socket<T> {
  const skip = req.host.kind === 'volume' ? req.host.volumeId : null;
  const probe = req.probe ?? Math.max(req.depth * 1.5, ctx.prop.lengthKm * 0.12);
  // Start the probe just off the mounting face: a socket sits ON the skin, so a
  // sweep from exactly the surface point always reports zero.
  const eps = Math.max(1e-6, probe * 0.02);
  const o: Vec3 = [
    req.frame.origin[0] + req.frame.forward[0] * eps,
    req.frame.origin[1] + req.frame.forward[1] * eps,
    req.frame.origin[2] + req.frame.forward[2] * eps,
  ];
  const clearance = eps + clearanceAlong(ctx, o, req.frame.forward, probe, skip);
  const clearAngle = clearAngleAt(ctx, o, req.frame.forward, Math.min(probe, Math.max(req.radius * 3, ctx.prop.lengthKm * 0.05)), skip);

  const s: Socket<T> = {
    id: makeSocketId<T>(nextId(ctx, `sk_${req.type}_`)),
    type: req.type,
    frame: req.frame,
    budget: { radius: req.radius, depth: req.depth, massKg: req.massKg },
    host: req.host,
    clearance,
    clearAngle,
    accepts: req.accepts,
    occupiedBy: null,
    mirrorOf: req.mirrorOf ?? null,
  };
  ctx.sockets.push(s);
  return s;
}

/** Mark a socket occupied. Sockets are readonly, so this rebuilds the record. */
function occupy(ctx: Ctx, socket: Socket, occupantId: string): void {
  const i = ctx.sockets.indexOf(socket);
  if (i >= 0) ctx.sockets[i] = { ...socket, occupiedBy: occupantId };
}

/** Every module kind that mounts on a socket type. Used to fill `accepts`. */
function kindsFor(type: SocketType): readonly ModuleKind[] {
  const out: ModuleKind[] = [];
  for (const k of Object.keys(MODULE_SOCKET) as ModuleKind[]) {
    if (MODULE_SOCKET[k] === type) out.push(k);
  }
  return out;
}

/**
 * Project a point onto the surface of whichever volume is nearest, and return
 * the outward normal there. This is how every socket lands on real geometry
 * rather than in the air next to it.
 */
function surfaceMount(ctx: Ctx, v: PrimaryVolume, t: number, theta: number): Frame {
  const p = volumeSurfacePoint(v, t, theta, [0, 0, 0]);
  const n = surfaceNormal(v, t, theta, [0, 0, 0]);
  // `up` for a mount is the ship's own up projected onto the mounting plane, so
  // every module on a hull shares a consistent roll reference and a row of
  // hatches does not spiral.
  return frameAt(p, n, Math.abs(vDot(n, UP_Y)) > 0.94 ? FWD_Z : UP_Y);
}

// ===========================================================================
// STAGE 4 — propulsion architecture
//
// "Thrust axis through the centre of mass" (BRIEF §4.4) is not a check applied
// afterwards: the engine cluster is CENTRED on the projected dry centre of mass
// by construction, so the offset is zero unless a later constraint forces a pod
// somewhere else — and then the reason is written into
// `PhysicsProfile.thrustOffsetReason` rather than left to be discovered.
// ===========================================================================

/** Exhaust velocity by drive tech, km/s. Sets delta-v through Tsiolkovsky. */
function exhaustVelocity(drive: TechnologyProfile['drive']): number {
  switch (drive) {
    case 'chemical': return 4.4;
    case 'ion': return 30;
    case 'plasma': return 60;
    case 'fusion-torch': return 110;
    case 'reaction-plate': return 200;
  }
}

/**
 * Plume colours. Cool by art direction — the drive is the only cold light on
 * the ship (ARCHITECTURE §6), so no branch here returns anything warm.
 * Diamond counts come from the faction, which is the culture's statement about
 * how well its drives are expanded; the hue comes from the physics.
 */
function plumeColors(drive: TechnologyProfile['drive']): { core: RGB; edge: RGB } {
  switch (drive) {
    case 'chemical': return { core: [0.58, 0.66, 0.98], edge: [0.16, 0.26, 0.62] };
    case 'ion': return { core: [0.34, 0.58, 1.0], edge: [0.1, 0.2, 0.55] };
    case 'plasma': return { core: [0.5, 0.78, 1.0], edge: [0.14, 0.34, 0.8] };
    case 'fusion-torch': return { core: [0.8, 0.88, 1.0], edge: [0.26, 0.44, 0.92] };
    case 'reaction-plate': return { core: [0.62, 0.72, 1.0], edge: [0.2, 0.3, 0.75] };
  }
}

/** The drive technology overrides the yard's habit: an ion drive has no bell to
 *  have a style, whatever the catalogue would prefer. */
function nozzleStyleFor(dna: ShipFamilyDna, drive: TechnologyProfile['drive']): NozzleStyle {
  if (drive === 'ion') return 'grid';
  if (drive === 'reaction-plate') return 'plate';
  const preferred = dna.faction.propulsion.nozzle;
  return preferred === 'grid' || preferred === 'plate' ? 'bell' : preferred;
}

/** Cluster offsets in the aft plane, normalised to a unit cluster radius. */
function clusterLayout(count: number): readonly Vec2[] {
  switch (count) {
    case 1: return [[0, 0]];
    case 2: return [[1, 0], [-1, 0]];
    case 3: return [[0, 1], [-0.87, -0.5], [0.87, -0.5]];
    case 4: return [[1, 0], [-1, 0], [0, 1], [0, -1]];
    default: {
      const out: Vec2[] = [];
      // Clocked from the vertical so the set is closed under x → −x, which keeps
      // the resultant thrust on the centreline for any count, odd or even.
      for (let i = 0; i < count; i++) {
        const a = Math.PI / 2 + (i / count) * TAU;
        out.push([Math.cos(a), Math.sin(a)]);
      }
      return out;
    }
  }
}

/**
 * How many main drives.
 *
 * The faction supplies the legal counts — even counts read as heavy, odd as
 * cheap or exotic, and the catalogue means that — and the size class picks
 * among them and then multiplies for the very largest hulls, which no yard
 * moves on one bell.
 */
function engineCountFor(rng: Rng, ctx: Ctx): number {
  const legal = ctx.faction.propulsion.engineCounts;
  const base = legal.length > 0 ? rng.pick(legal) : 2;
  switch (ctx.sizeClass) {
    case 'shuttle': case 'light': return clamp(base, 1, 3);
    case 'medium': return base;
    case 'heavy': return clamp(base * (rng.chance(0.4) ? 2 : 1), 1, 8);
    default: return clamp(base * rng.pick([2, 2, 3]), 2, 10);
  }
}

interface DriveResult {
  readonly totalThrustN: number;
  readonly dryCom: Vec3;
}

function buildDrive(ctx: Ctx): DriveResult {
  const rng = new Rng(shipSubSeed(ctx.seed, 'propulsion'));
  // The drive is sized against `physics.ts`'s mass model, not a second one built
  // here. Its skin-areal-plus-outfit model is finer than anything this file
  // should own, and a drive sized against a different mass is a drive that does
  // not deliver the acceleration its role demands. At this point in the pipeline
  // the volumes exist and nothing else does, which is exactly the hull mass a
  // drive is designed around; the modules bolted on later are the margin.
  const mass = massPropertiesOf(ctx);
  const dryCom = mass.centreOfMass;
  const loadedKg = mass.loadedMassKg;

  const live = ctx.accelMs2 > 0;
  // Sized for the FINISHED ship, not for the bare hull.
  //
  // At this point in the pipeline only the primary volumes exist — that is the
  // whole reason the drive is sized here, since a bell cannot be dimensioned
  // before there is a hull to bolt it to — but stages 5 to 7 then add the
  // modules, the payload rack, the radiators and the gear, and on a working
  // hull those are most of the finished mass. Sizing against the stage-4 mass
  // put half the fleet under its own role's acceleration band while every pod
  // was making exactly the thrust it had been designed for. A naval architect
  // sizes the plant for the full-load displacement; the growth factor is
  // measured over the fleet rather than assumed, and what remains after it is
  // audited on the finished hull by `auditThrustDelivered`.
  const totalThrustN = live ? loadedKg * ctx.accelMs2 * OUTFIT_MASS_GROWTH : 0;

  // The aft plane: behind everything, so a bell never grows out of a hull.
  let aftZ = -Infinity;
  let aftR = ctx.prop.beamKm * 0.2;
  for (const v of ctx.volumes) {
    const b = boundsOf(ctx, v);
    if (b.max[2] > aftZ) {
      aftZ = b.max[2];
      aftR = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) * 0.5;
    }
  }
  if (!Number.isFinite(aftZ)) aftZ = ctx.prop.lengthKm * 0.5;

  // The stern the drive has to share, measured the way the review measured it:
  // the hull's own BEAM × HEIGHT. A cluster may legitimately overhang the last
  // volume — every real high-thrust vehicle's engines are wider than the tank
  // above them — so the denominator is the ship, not the last frame. Structure,
  // plumbing, the thrust frame and the radiators that reject the drive's waste
  // heat all live back there too. See `MAX_EXIT_FRACTION_OF_STERN`.
  let sx0 = Infinity, sx1 = -Infinity, sy0 = Infinity, sy1 = -Infinity;
  for (const v of ctx.volumes) {
    const b = boundsOf(ctx, v);
    sx0 = Math.min(sx0, b.min[0]); sx1 = Math.max(sx1, b.max[0]);
    sy0 = Math.min(sy0, b.min[1]); sy1 = Math.max(sy1, b.max[1]);
  }
  const sternAreaM2 = Number.isFinite(sx0)
    ? Math.max(1e-9, (sx1 - sx0) * 1000 * (sy1 - sy0) * 1000)
    : Math.max(1e-9, ctx.prop.beamKm * 1000 * ctx.prop.heightKm * 1000);

  const prop = ctx.faction.propulsion;
  let count = engineCountFor(rng, ctx);
  const style = nozzleStyleFor(ctx.dna, ctx.tech.drive);
  const colors = plumeColors(ctx.tech.drive);

  // Nozzles are sized GEOMETRICALLY, from the aft section, not from thrust.
  // `FlightModel` runs a deliberately unphysical 20 g main drive (its own
  // comment says so); a bell sized from that thrust at any real chamber
  // pressure would be wider than the hull. So the fiction is a very high
  // specific impulse, the visible hardware is proportioned to the ship, and the
  // proportion is the faction's `exitRadiusRatio` — which is what makes a
  // Sillane drive read as one enormous throat and a Kessler as a battery.
  const throats = prop.nozzlesPerPod.length > 0 ? rng.pick(prop.nozzlesPerPod) : 1;
  /** The yard's preferred bell size for a hull with this aft section. */
  const rPref = clamp(aftR * sampleRange(prop.exitRadiusRatio, rng), HATCH_WIDTH_KM * 0.4, aftR * 1.2);

  // `physics.ts` rates a nozzle from its EXIT AREA and publishes `sizingError`
  // when a blueprint's declared thrust disagrees with what its bells are worth.
  // So the bell is sized against that law rather than guessed at, and the
  // declared thrust is then taken from the law — the two cannot drift apart.
  //
  // The specific thrust constant lives in `physics.ts` and is not exported, so
  // it is probed: a 1 m exit radius is π m² of exit area, and the rating of that
  // nozzle divided by π is thrust per square metre including the maintenance
  // upkeep factor. Inverting is then exact rather than approximately calibrated.
  const unitNozzle = { style, exitRadius: 1e-3, throatRadius: 5e-4, length: 1e-3, count: 1, clusterRadius: 0, gimbalLimit: 0 };
  const thrustPerM2 = Math.max(1e-9, engineRatedThrustN(unitNozzle, ctx.tech) / Math.PI);
  const areaWantedM2 = totalThrustN / thrustPerM2;

  // The cap that was missing.
  //
  // Stage 4 was aft-area-limited and its answer to a thrust shortfall was to
  // grow the bells until they filled the stern: summed exit area reached 92%
  // of beam × height on a heavy courier — four bells of 15.9 m exit radius,
  // 31.8 m across each, on a 60.6 m beam, so two side by side were already
  // wider than the ship. That is not a spacecraft, it is a nozzle rack with a
  // hull bolted to it, and it is what `ship-fleet-family`'s left-hand hull
  // reads as. Thirty-five per cent is an industrial figure that still leaves
  // room for the thrust frame, the plumbing and the radiators, and where the
  // role's thrust band cannot be met inside it the shortfall is REPORTED
  // rather than spent on a wider bell — the drive technology is the faction's
  // and is not the generator's to escalate.
  const areaCapM2 = sternAreaM2 * MAX_EXIT_FRACTION_OF_STERN;
  const areaTotalM2 = Math.min(areaWantedM2, areaCapM2);
  if (live && areaWantedM2 > areaCapM2 * 1.001) {
    reject(ctx, {
      stage: 'propulsion',
      rule: 'nozzle-area-over-stern',
      what: `the role's acceleration wants ${Math.round(areaWantedM2)} m² of exit area on a ${Math.round(sternAreaM2)} m² stern`,
      at: [0, 0, aftZ],
      measured: areaWantedM2 / sternAreaM2,
      required: MAX_EXIT_FRACTION_OF_STERN,
      attempt: 0,
    });
  }

  // Packing: for a ring of n bells at radius R the chord between neighbours is
  // 2R·sin(π/n), so R ≥ 1.05·r/sin(π/n). The cluster then spans R + r, and that
  // has to stay inside 1.4× the aft radius — a bell may overhang the hull it is
  // bolted to (every real high-thrust vehicle's engines are wider than the tank
  // above them) but a drive twice the width of its own ship is not a ship.
  const packK = (n: number): number => (n <= 1 ? 0 : n === 2 ? 1.05 : 1.05 / Math.sin(Math.PI / n));
  // A bell may overhang the hull it is bolted to — every real high-thrust
  // vehicle's engines are wider than the tank above them — and a big cluster
  // overhangs further, because a ring of twelve is an engine block rather than
  // a tail fairing. Bounded so a drive never grows to twice the ship.
  const spanFactor = (n: number): number => Math.min(2.4, 1.4 + 0.055 * n);
  const rLimit = (n: number): number => (aftR * spanFactor(n)) / (packK(n) + 1);

  // The thrust the role asks for sets the TOTAL exit area; the faction's
  // preferred bell size then decides how that area is divided. A yard that
  // likes one enormous throat gets one; a yard that likes batteries gets six.
  // This is the right way round — the count is the aesthetic choice and the
  // area is the engineering one.
  //
  // Note the packing arithmetic: n circles inside one circle waste more of it
  // the more of them there are (four circles fill 69% of their bounding circle,
  // twelve fill 43%), so a hull that cannot make its thrust does NOT get more
  // engines — more engines would give it less exit area. It gets the fewest its
  // yard will build, which is why a thrust-starved Kessler capital ends up on
  // two enormous bells and a Sillane on one.
  const capArea = (n: number): number => n * Math.PI * Math.pow(rLimit(n) * 1000, 2) * throats;
  if (areaTotalM2 > 0) {
    // How many bells the exit area needs if no single one may exceed what a
    // yard can actually roll.
    //
    // This is the missing constraint, and without it the count read BACKWARDS
    // against mass: a hull whose required exit area exceeded the packing limit
    // fell through to "the smallest count this yard builds", so a 95 Mt carrier
    // came out on 1.6 bells and a 8.7 kt prospector on 8.1. Thrust was right —
    // it comes from area, and the square-cube ordering held — but the thing a
    // viewer counts was inverted. A shipyard's answer to more thrust is another
    // bell off the same jig, so the count now rises as the cube root of thrust
    // and the mandrel is what bounds a single throat.
    const rBellMax = Math.max(HATCH_WIDTH_KM * 0.5, aftR * MAX_BELL_FRACTION_OF_AFT);
    const nFromArea = Math.ceil(areaTotalM2 / (Math.PI * Math.pow(rBellMax * 1000, 2) * throats));
    const ideal = areaTotalM2 / (Math.PI * Math.pow(rPref * 1000, 2) * throats);
    // …and a bound at the small end, because a sixty-metre prospector with an
    // eight-bell cluster reads as a capital that shrank.
    const nMax = ctx.sizeClass === 'shuttle' || ctx.sizeClass === 'light' ? 2
      : ctx.sizeClass === 'medium' ? 3
        : ctx.sizeClass === 'heavy' ? 4
          : ctx.sizeClass === 'capital' ? 6 : 8;
    const candidates = [1, 2, 3, 4, 6, 8].filter((n) => n <= nMax);
    const wanted = candidates.filter((n) => n >= Math.min(nFromArea, nMax));
    const pool = wanted.length > 0 ? wanted : candidates;
    const feasible = pool.filter((n) => capArea(n) >= areaTotalM2);
    const choose = feasible.length > 0 ? feasible : pool;
    let best = choose[0];
    let bestErr = Infinity;
    for (const n of choose) {
      const err = Math.abs(Math.log(n / Math.max(1e-9, Math.max(ideal, nFromArea))));
      if (err < bestErr) { bestErr = err; best = n; }
    }
    count = best;
  }

  const rNeed = areaTotalM2 > 0 ? Math.sqrt((areaTotalM2 / count / throats) / Math.PI) / 1000 : 0;
  // Where the geometry cannot deliver the area, the ship is simply less
  // powerful than its role would like. That is the square-cube law — thrust
  // grows with the aft disc (L²) and mass with the hull (L³) — and it is a fact
  // about big ships, not a number to fudge. It is recorded below.
  const exitRadius = clamp(
    rNeed > 0 ? rNeed : rPref,
    HATCH_WIDTH_KM * 0.4,
    Math.max(HATCH_WIDTH_KM * 0.5, Math.min(aftR * MAX_BELL_FRACTION_OF_AFT, rLimit(count) || aftR * 1.4)),
  );
  const clusterR = count === 1 ? 0 : Math.max(aftR * rng.range(0.42, 0.66), exitRadius * packK(count));
  const bellLen = style === 'grid' || style === 'plate'
    ? exitRadius * 0.18
    : exitRadius * Math.max(0.2, sampleRange(prop.bellAspect, rng));
  const lengthRatio = sampleRange(prop.plumeLength, rng) * (ctx.tech.drive === 'ion' ? 0.35 : 1);
  ctx.plumeLengthKm = exitRadius * lengthRatio;

  const layout = clusterLayout(count);
  // Spool is the faction's band scaled by how much mass this hull actually has
  // to get moving: the same yard's drive is slower on a capital than on a boat.
  const spool = clamp(sampleRange(prop.spoolTime, rng) * Math.pow(loadedKg / 2e5, 0.12), 0.3, 9);
  const ve = exhaustVelocity(ctx.tech.drive) * 1000; // m/s for the jet-power sum
  const nozzleSpec = {
    style, exitRadius,
    throatRadius: exitRadius * (style === 'grid' || style === 'plate' ? 0.95 : rng.range(0.28, 0.45)),
    length: bellLen, count: throats, clusterRadius: exitRadius * 1.2, gimbalLimit: 0,
  };
  // Declared thrust IS the rated thrust of the bell that was built. A derelict
  // declares zero: its engines are cold, and that is a fact about the ship
  // rather than a rounding of a small number.
  const perPod = live ? engineRatedThrustN(nozzleSpec, ctx.tech) : 0;

  if (live && perPod * count < totalThrustN * 0.9) {
    reject(ctx, {
      stage: 'propulsion',
      rule: 'thrust-below-role-band',
      what: `${count}× ${style} cannot make the role's design acceleration on a ${fmtKm(aftR * 2)} aft section`,
      at: [0, 0, aftZ],
      measured: perPod * count,
      required: totalThrustN,
      attempt: 0,
    });
  }

  // How far out and how far aft the whole cluster has to sit before every bell
  // has clear space in front of it.
  //
  // Walked as a CLUSTER, not pod by pod. Moving one pod outboard because its
  // own exhaust hit something and leaving its opposite number where it was
  // breaks the one property the layout is built to have — closure under
  // x → −x — and the resultant thrust then misses the centre of mass by the
  // difference. That is a tumble at full burn, reported afterwards as an
  // off-axis drive that nothing could explain.
  let scale = 1;
  let zoff = 0;
  let attempt = 0;
  const plumeHalfAngle = style === 'grid' || style === 'plate' ? 0.09 : 0.16;
  const need = Math.max(ctx.plumeLengthKm * 0.35, exitRadius * 3);
  for (; attempt < 4; attempt++) {
    let allClear = true;
    for (let i = 0; i < layout.length && allClear; i++) {
      const throat: Vec3 = [
        dryCom[0] + layout[i][0] * clusterR * scale,
        dryCom[1] + layout[i][1] * clusterR * scale,
        aftZ + bellLen * 0.15 + zoff,
      ];
      const free = clearanceAlong(ctx, throat, FWD_Z, need, null);
      const cone = clearAngleAt(ctx, throat, FWD_Z, Math.min(need, exitRadius * 4), null);
      if (free >= need * 0.999 && cone >= plumeHalfAngle) continue;
      allClear = false;
      reject(ctx, {
        stage: 'propulsion',
        rule: 'exhaust-intersects-hull',
        what: `engine ${i} (${style})`,
        at: throat,
        measured: free < need * 0.999 ? free : cone,
        required: free < need * 0.999 ? need : plumeHalfAngle,
        attempt,
      });
    }
    if (allClear) break;
    scale *= 1.25;
    zoff += bellLen * 0.6;
  }

  const placed: EnginePod[] = [];
  for (let i = 0; i < layout.length; i++) {
    const ox = dryCom[0] + layout[i][0] * clusterR * scale;
    const oy = dryCom[1] + layout[i][1] * clusterR * scale;
    const oz = aftZ + bellLen * 0.15 + zoff;
    // Still fouled after four steps: this pod is refused outright, and the
    // cluster keeps its symmetry because its opposite number goes too.
    if (attempt >= 4) {
      const throat: Vec3 = [ox, oy, oz];
      if (clearanceAlong(ctx, throat, FWD_Z, need, null) < need * 0.999) continue;
    }

    const frame = frameAt([ox, oy, oz], FWD_Z, UP_Y);
    const socket = addSocket<'engine'>(ctx, {
      type: 'engine',
      frame,
      host: { kind: 'spine', nodeId: ctx.spine.chains[0].nodes[ctx.spine.chains[0].nodes.length - 1].id },
      radius: exitRadius * 1.15,
      depth: bellLen + ctx.plumeLengthKm,
      massKg: loadedKg,
      accepts: [],
      probe: Math.max(ctx.plumeLengthKm, bellLen * 3),
    });

    const id = nextId(ctx, 'eng');
    const pod: EnginePod = {
      id,
      socketId: socket.id,
      frame,
      thrustAxis: [0, 0, -1],
      thrustN: perPod,
      // Nozzles per pod comes from the faction: four throats in one pod reads
      // very differently from four pods, and the catalogue is explicit about it.
      nozzle: { ...nozzleSpec, gimbalLimit: style === 'plate' ? 0 : sampleRange(prop.gimbal, rng) },
      plume: {
        coreColor: colors.core,
        edgeColor: colors.edge,
        lengthRatio,
        diamonds: ctx.tech.drive === 'ion' || ctx.tech.drive === 'reaction-plate'
          ? 0 : Math.round(sampleRange(prop.plumeDiamonds, rng)),
        // The faction's baseline instability, opened up by neglect. A drive that
        // has not been serviced in twenty years burns unevenly, and that costs
        // no geometry at all.
        flicker: clamp01(sampleRange(prop.plumeFlicker, rng) * lerp(3.0, 1.0, ctx.tech.maintenance)),
      },
      // Jet power is ½·F·v_e; a real drive dumps 10–20% of it as heat, and that
      // number is what the radiators in stage 6 are sized against.
      heatW: 0.5 * perPod * ve * rng.range(0.08, 0.18),
      spoolTime: spool * rng.range(0.9, 1.15),
      mirrorOf: null,
      materialKey: matKey(ctx, MAT_STRUCT),
      seed: sub(shipSubSeed(ctx.seed, 'propulsion'), id),
    };
    occupy(ctx, ctx.sockets[ctx.sockets.length - 1], id);
    placed.push(pod);
    ctx.volumes.push(nacelleFor(ctx, rng, pod, aftR));
  }

  // Mark mirrored pairs so the renderer can instance one bell twice.
  for (let i = 0; i < placed.length; i++) {
    for (let j = 0; j < i; j++) {
      if (Math.abs(placed[i].frame.origin[0] + placed[j].frame.origin[0] - 2 * dryCom[0]) < 1e-9
        && Math.abs(placed[i].frame.origin[1] - placed[j].frame.origin[1]) < 1e-9) {
        placed[i] = { ...placed[i], mirrorOf: placed[j].id };
        break;
      }
    }
  }
  ctx.engines.push(...placed);

  buildRcs(ctx, dryCom, mass.inertia);
  return { totalThrustN: placed.reduce((s, e) => s + e.thrustN, 0), dryCom };
}

/**
 * A short shroud round each bell. Not decoration: without it the drive reads as
 * a bell floating behind the ship, and the thrust structure that BRIEF §5 cares
 * about is invisible.
 */
function nacelleFor(ctx: Ctx, rng: Rng, pod: EnginePod, aftR: number): PrimaryVolume {
  const r = pod.nozzle.exitRadius * rng.range(1.05, 1.35);
  const len = pod.nozzle.length * rng.range(0.7, 1.2);
  return sweptVolume(ctx, rng, {
    kind: 'nacelle',
    frame: axialFrame(pod.frame.origin[0], pod.frame.origin[1], pod.frame.origin[2] - len),
    length: len,
    halfWidth: r,
    halfHeight: r,
    bias: 'machinery',
    capStart: 'flat',
    capEnd: 'open',
    materialSlot: MAT_STRUCT,
    detailDensity: 0.95,
    loadShare: 0.5,
    stations: 3,
    interiorVisible: false,
    anchor: { kind: 'socket', socketId: pod.socketId },
  });
}

/**
 * RCS. Twelve to twenty-four nozzles in quads, and the control groups are
 * *derived* from where each nozzle is and which way it points — not assigned.
 *
 * A nozzle's force is the negative of its exhaust, its couple is r × F about the
 * centre of mass, and it joins every group whose axis it contributes to by more
 * than half. That is the same rule `Ship.ts` fires its thrusters by, and it
 * means a hull that ends up asymmetric gets an asymmetric but *correct* RCS
 * layout rather than four nozzles that happen to be labelled.
 *
 * Sign convention, stated once: pitch+ is a couple about +X, which lifts the
 * nose (−Z rotates towards +Y); yaw+ is about +Y; roll+ is about +Z.
 */
function buildRcs(ctx: Ctx, com: Vec3, inertia: AxisTriple): void {
  const rng = new Rng(sub(shipSubSeed(ctx.seed, 'propulsion'), 'rcs'));
  const L = ctx.prop.lengthKm;
  const stations = ctx.sizeClass === 'shuttle' || ctx.sizeClass === 'light' ? 2 : 3;
  // The longest primary, not the first one that matches: a quad's torque arm is
  // its distance from the balance point, and hanging the rings off a short
  // forward section gave arms a quarter of what the hull actually offers. The
  // set then had to be four times as powerful — and four times as heavy — to
  // deliver the same rate.
  const host = spanHost(ctx) ?? ctx.volumes[0];
  if (!host) return;
  // Station parameters are mapped through the SHIP's fore-aft extent rather
  // than the host's own, so the fore and aft rings sit at the ends of the ship
  // and not at the ends of whichever volume they are bolted to.
  let shipZ0 = Infinity;
  let shipZ1 = -Infinity;
  for (let vi = 0; vi < ctx.volumes.length; vi++) {
    const vb = boundsAt(ctx, vi);
    if (vb.min[2] < shipZ0) shipZ0 = vb.min[2];
    if (vb.max[2] > shipZ1) shipZ1 = vb.max[2];
  }
  const hbb = boundsOf(ctx, host);
  const hostT = (u: number): number => {
    if (!Number.isFinite(shipZ0) || shipZ1 <= shipZ0 || hbb.max[2] <= hbb.min[2]) return clamp(u, 0.03, 0.97);
    const z = lerp(shipZ0, shipZ1, u);
    return clamp((z - hbb.min[2]) / (hbb.max[2] - hbb.min[2]), 0.03, 0.97);
  };

  interface Raw { pos: Vec3; exhaust: Vec3; cluster: string; }
  const raws: Raw[] = [];

  // Radial nozzles at four clock positions on two or three rings. Between them
  // these give both translation axes and both rotation axes that a normal force
  // can produce: a dorsal nozzle forward and a ventral one aft is a pitch
  // couple, and the same pattern in X is yaw.
  for (let si = 0; si < stations; si++) {
    const t = stations === 2 ? (si === 0 ? 0.07 : 0.93) : 0.05 + (si / (stations - 1)) * 0.9;
    for (let q = 0; q < 4; q++) {
      const theta = q * (Math.PI / 2);
      const p = volumeSurfacePoint(host, hostT(t), theta, [0, 0, 0]);
      const n = surfaceNormal(host, hostT(t), theta, [0, 0, 0]);
      raws.push({ pos: [p[0], p[1], p[2]], exhaust: [n[0], n[1], n[2]], cluster: `rcsq${si}` });
    }
  }

  // TANGENTIAL nozzles, and they are not optional.
  //
  // A nozzle mounted on the skin fires along the surface normal, so its force is
  // radial — parallel to its own moment arm — and r × F is ZERO about the roll
  // axis. A ship with only radial thrusters cannot roll at all, and sizing the
  // set against a roll requirement divides by an authority of zero. Real quads
  // carry opposed tangential pairs for exactly this reason, so these are placed
  // at the aft ring in both senses: a full ring firing the same way is a pure
  // couple (the translations cancel round the ring) and the opposite ring is
  // the other sense.
  const rollT = stations === 2 ? 0.86 : 0.88;
  for (let q = 0; q < 4; q++) {
    const theta = q * (Math.PI / 2);
    const p = volumeSurfacePoint(host, hostT(rollT), theta, [0, 0, 0]);
    // Tangent to the section at this clock position, in the ship's XY plane.
    const tang: Vec3 = [-Math.sin(theta), Math.cos(theta), 0];
    for (const sign of [1, -1]) {
      raws.push({ pos: [p[0], p[1], p[2]], exhaust: [tang[0] * sign, tang[1] * sign, 0], cluster: `rcsroll${sign > 0 ? 'p' : 'm'}` });
    }
  }

  // Axial nozzles. Without forward-firing ones the ship has no way to arrest
  // closing speed except by turning round, and a docking approach is impossible.
  for (let q = 0; q < 4; q++) {
    const theta = q * (Math.PI / 2) + Math.PI / 4;
    const fwd = volumeSurfacePoint(host, hostT(0.04), theta, [0, 0, 0]);
    raws.push({ pos: [fwd[0], fwd[1], fwd[2]], exhaust: [0, 0, -1], cluster: 'rcsfwd' });
    const aft = volumeSurfacePoint(host, hostT(0.96), theta, [0, 0, 0]);
    raws.push({ pos: [aft[0], aft[1], aft[2]], exhaust: [0, 0, 1], cluster: 'rcsaft' });
  }

  const AXES: readonly Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const TRANS: readonly RcsGroup[][] = [['x+', 'x-'], ['y+', 'y-'], ['z+', 'z-']];
  const ROT: readonly RcsGroup[][] = [['pitch+', 'pitch-'], ['yaw+', 'yaw-'], ['roll+', 'roll-']];

  // Unit-thrust force and couple per nozzle, and the groups each one joins.
  //
  // GROUPS ARE ASSIGNED BEFORE THE SET IS SIZED, and that ordering is the whole
  // fix. The budget used to accumulate Σ|r × F| per axis over every nozzle,
  // ignoring direction and ignoring group membership — but `physics.ts`'s
  // `rcsAuthority`, which is what `FlightModel` actually flies, reduces the same
  // set as min(Σ pitch+, Σ pitch−) over the thrusters in those groups. Roughly
  // half the ring pushes one way and half the other, so the min-of-two-
  // directions reduction discards half of what the budget counted, and the
  // group thresholds below discard more: delivered pitch authority came out
  // 4.2× to 28.2× below the target this function had sized for, on all eighteen
  // roles. Accumulating exactly what physics.ts will accumulate closes it.
  interface Row { readonly r: Raw; readonly f: Vec3; readonly c: Vec3; readonly groups: RcsGroup[]; }
  const rows: Row[] = [];
  // [pitch+, pitch−, yaw+, yaw−, roll+, roll−] at unit thrust.
  const bins = [0, 0, 0, 0, 0, 0];
  for (const r of raws) {
    const fx = -r.exhaust[0], fy = -r.exhaust[1], fz = -r.exhaust[2];
    const rx = r.pos[0] - com[0], ry = r.pos[1] - com[1], rz = r.pos[2] - com[2];
    const c: Vec3 = [ry * fz - rz * fy, rz * fx - rx * fz, rx * fy - ry * fx];
    const f: Vec3 = [fx, fy, fz];
    const groups: RcsGroup[] = [];
    for (let a = 0; a < 3; a++) {
      const d = vDot(f, AXES[a]);
      if (d > 0.5) groups.push(TRANS[a][0]);
      else if (d < -0.5) groups.push(TRANS[a][1]);
    }
    const cm = vLength(c);
    if (cm > 1e-9) {
      for (let a = 0; a < 3; a++) {
        const d = vDot(c, AXES[a]) / cm;
        if (d > 0.5) { groups.push(ROT[a][0]); bins[a * 2] += Math.max(0, c[a]); }
        else if (d < -0.5) { groups.push(ROT[a][1]); bins[a * 2 + 1] += Math.max(0, -c[a]); }
      }
    }
    if (groups.length === 0) continue;
    rows.push({ r, f, c, groups });
  }

  // Target angular acceleration falls with size as 1/√L: a 30 m boat snaps to
  // 2 rad/s² (the `DEFAULT_SHIP_CONFIG` figure), a 1 km hull to about 0.35, and
  // a super-capital to 0.17 — which is what makes mass legible from the cockpit.
  const alpha = clamp(2.0 * Math.sqrt(0.03 / Math.max(1e-6, L)), 0.06, 3.0);
  // The moments come from `physics.ts`, which already integrated them about the
  // dry centre of mass. Re-deriving a tensor here would be a second mass model
  // disagreeing with the published one, and it is the published one the flight
  // model will fly.
  //
  // Torque in N·km against an inertia in kg·km² gives rad/s² only after the
  // N→kg·km/s² conversion FlightModel applies (M_TO_KM); hence the 1e3.
  const need: readonly [number, number, number] = [
    alpha * Math.max(1e-6, inertia.pitch) * 1e3,
    alpha * Math.max(1e-6, inertia.yaw) * 1e3,
    alpha * Math.max(1e-6, inertia.roll) * 1e3,
  ];
  // The weaker of the two senses is what the pilot gets, exactly as
  // `rcsAuthority` says, so that is what the set is sized against.
  const auth: readonly [number, number, number] = [
    Math.min(bins[0], bins[1]), Math.min(bins[2], bins[3]), Math.min(bins[4], bins[5]),
  ];
  // An axis with no authority must be reported, never divided by. The floor is
  // 2% of the strongest axis: below that the layout has a hole in it, and
  // sizing the whole set against the hole is how a nozzle ends up massing more
  // than the ship it steers.
  const strongest = Math.max(auth[0], auth[1], auth[2]);
  const floor = strongest * 0.02;
  let per = 0;
  const AXIS_NAME = ['pitch', 'yaw', 'roll'];
  for (let a = 0; a < 3; a++) {
    if (auth[a] < floor || auth[a] <= 0) {
      reject(ctx, {
        stage: 'propulsion', rule: 'no-compatible-socket',
        what: `no usable RCS authority about ${AXIS_NAME[a]}`,
        at: com, measured: auth[a], required: floor, attempt: 0,
      });
      continue;
    }
    per = Math.max(per, need[a] / auth[a]);
  }
  const thrustN = clamp(per > 0 ? per : need[0] / Math.max(1e-9, strongest), 1, 1e11);

  for (const row of rows) {
    const groups = row.groups;
    const frame = frameAt(row.r.pos, row.r.exhaust, Math.abs(vDot(row.r.exhaust, UP_Y)) > 0.94 ? FWD_Z : UP_Y);
    const socket = addSocket<'rcs'>(ctx, {
      type: 'rcs',
      frame,
      host: { kind: 'volume', volumeId: host.id },
      radius: Math.max(HATCH_WIDTH_KM * 0.3, ctx.prop.beamKm * 0.02),
      depth: Math.max(HATCH_WIDTH_KM * 0.4, ctx.prop.beamKm * 0.03),
      massKg: 1e6,
      accepts: [],
      probe: ctx.prop.lengthKm * 0.06,
    });
    const id = nextId(ctx, 'rcs');
    ctx.thrusters.push({
      id,
      socketId: socket.id,
      frame,
      thrustN,
      radius: Math.max(HATCH_WIDTH_KM * 0.25, ctx.prop.beamKm * 0.016) * rng.range(0.85, 1.2),
      groups,
      clusterKey: row.r.cluster,
      mirrorOf: null,
    });
    occupy(ctx, socket, id);
  }
}

// ===========================================================================
// STAGE 5 — module layout
//
// "Placed on compatible sockets, checked for clearance" (BRIEF §4.5). Every
// mount goes through `tryMount`, which walks a deterministic candidate grid on
// the surface, measures the free space, and either accepts a placement or
// records exactly what it refused and by how much. A generator that never
// refuses anything is a generator that has not checked.
// ===========================================================================

interface MountSpec {
  /** Hosts in preference order. The first that yields a legal mount wins. */
  readonly hosts: readonly PrimaryVolume[];
  readonly ts: readonly number[];
  readonly thetas: readonly number[];
  readonly minClearance: number;
  readonly minAngle: number;
  readonly rule: PlacementRejection['rule'];
  readonly what: string;
  /** Bias the outward normal towards this ship direction (a view or fire axis). */
  readonly aim?: Vec3;
  readonly aimWeight?: number;
  /** Accept the least-bad candidate instead of nothing. Used where a hull MUST
   *  have the fitting — a ship with no cockpit is not a variation. */
  readonly acceptBest?: boolean;
  /** Also require a real forward view — see `viewCone`. Command mounts only:
   *  it is 37 rays per candidate and nothing else needs the shape of the cone,
   *  only its width. */
  readonly viewFan?: boolean;
}

interface Mount {
  readonly host: PrimaryVolume;
  readonly t: number;
  readonly theta: number;
  readonly frame: Frame;
  readonly clearance: number;
  readonly clearAngle: number;
  /** Measured only when `MountSpec.viewFan` is set. */
  readonly view: ViewCone | null;
}

/**
 * Walk the candidate grid and return the first legal mount.
 *
 * The grid is ordered, not sampled, so the same hull always tries the same
 * places in the same order — which is what makes a rejection reproducible and
 * therefore reviewable.
 */
function tryMount(ctx: Ctx, spec: MountSpec): Mount | null {
  let best: Mount | null = null;
  let bestScore = -Infinity;
  let attempt = 0;

  for (const host of spec.hosts) {
    for (const t of spec.ts) {
      for (const theta of spec.thetas) {
        const p = volumeSurfacePoint(host, t, theta, [0, 0, 0]);
        const n = surfaceNormal(host, t, theta, [0, 0, 0]);
        let dir: Vec3 = [n[0], n[1], n[2]];
        if (spec.aim) {
          const w = spec.aimWeight ?? 1;
          dir = vNormalize([n[0] + spec.aim[0] * w, n[1] + spec.aim[1] * w, n[2] + spec.aim[2] * w]);
        }
        const eps = Math.max(1e-6, spec.minClearance * 0.02 + 1e-7);
        const o: Vec3 = [p[0] + dir[0] * eps, p[1] + dir[1] * eps, p[2] + dir[2] * eps];
        const clearance = eps + clearanceAlong(ctx, o, dir, Math.max(spec.minClearance, eps * 4), host.id);
        // The cone sweep costs ~40× a straight sweep, and most candidates fail
        // on clearance alone. Measuring it only when the cheap test passes is
        // most of this generator's speed and changes no result: a mount that
        // fails clearance is rejected whatever its cone would have been.
        const straightOk = clearance >= spec.minClearance * 0.999;
        const angle = straightOk
          ? clearAngleAt(ctx, o, dir, Math.min(spec.minClearance, ctx.prop.lengthKm * 0.25), host.id)
          : 0;
        const frame = frameAt([p[0], p[1], p[2]], dir, Math.abs(vDot(dir, UP_Y)) > 0.94 ? FWD_Z : UP_Y);
        const coneOk = straightOk && angle >= spec.minAngle;
        // Only worth 37 rays once the cheap tests have already passed.
        const view = spec.viewFan === true && coneOk
          ? viewCone(ctx, o, dir, Math.max(spec.minClearance, eps * 4), host.id)
          : null;
        const m: Mount = { host, t, theta, frame, clearance, clearAngle: angle, view };
        const viewOk = spec.viewFan !== true || (view !== null
          && view.fraction >= MIN_VIEW_FRACTION && view.forwardDot >= MIN_VIEW_FORWARD_DOT);

        if (coneOk && viewOk) return m;

        const score = Math.min(1, clearance / Math.max(1e-9, spec.minClearance))
          + Math.min(1, angle / Math.max(1e-9, spec.minAngle))
          + (view !== null ? view.fraction * 2 + Math.max(0, view.forwardDot) : 0);
        if (score > bestScore) { bestScore = score; best = m; }
        const failedView = coneOk && !viewOk;
        reject(ctx, {
          stage: 'modules',
          rule: failedView ? 'view-cone-narrow' : spec.rule,
          what: spec.what,
          at: [p[0], p[1], p[2]],
          measured: failedView ? (view?.fraction ?? 0) : (clearance < spec.minClearance * 0.999 ? clearance : angle),
          required: failedView ? MIN_VIEW_FRACTION : (clearance < spec.minClearance * 0.999 ? spec.minClearance : spec.minAngle),
          attempt: attempt++,
        });
      }
    }
  }
  return spec.acceptBest === true ? best : null;
}

/** Volumes that make plausible hosts for a given job, best first. */
function hostsFor(ctx: Ctx, want: readonly VolumeKind[]): readonly PrimaryVolume[] {
  const hit = ctx.volumes.filter((v) => want.includes(v.kind));
  return hit.length > 0 ? hit : ctx.volumes.filter((v) => v.kind !== 'nacelle');
}

/** Size and mass of a piece of hardware, scaled to the ship it hangs on. */
function moduleSize(ctx: Ctx, rng: Rng, kind: ModuleKind): { half: Vec3; massKg: number; density: number } {
  const B = ctx.prop.beamKm;
  const L = ctx.prop.lengthKm;
  let half: Vec3;
  let density = 400;
  switch (kind) {
    case 'cockpit':
      half = [B * 0.16, DECK_HEIGHT_KM * 0.75, B * 0.24]; density = 320; break;
    case 'bridge-tower':
      half = [B * 0.14, DECK_HEIGHT_KM * rng.range(1.2, 2.6), B * 0.18]; density = 300; break;
    case 'sensor-dish':
      half = [B * rng.range(0.1, 0.24), B * rng.range(0.1, 0.24), B * 0.05]; density = 90; break;
    case 'sensor-array':
      half = [B * 0.1, B * 0.04, L * 0.05]; density = 140; break;
    case 'antenna-mast':
      half = [HATCH_WIDTH_KM * 0.5, L * rng.range(0.05, 0.14), HATCH_WIDTH_KM * 0.5]; density = 60; break;
    case 'airlock':
      half = [HATCH_WIDTH_KM * 1.3, HATCH_WIDTH_KM * 1.3, HATCH_WIDTH_KM * 0.9]; density = 420; break;
    case 'docking-collar':
      half = [B * 0.09, B * 0.09, B * 0.045]; density = 380; break;
    case 'cargo-container':
      // Lying DOWN, long axis along the face it is racked on: a container
      // stood on end pointing away from the hull needed twelve metres of
      // clearance to mount and was refused on every hull that had a rack,
      // which is why the freighters came out with no visible cargo at all.
      half = [CONTAINER_LENGTH_KM * 0.5, CONTAINER_LENGTH_KM * 0.2, CONTAINER_LENGTH_KM * 0.2]; density = 200; break;
    case 'cargo-pod': case 'ore-bin':
      half = [B * 0.14, B * 0.14, L * 0.09]; density = 220; break;
    case 'habitat-can':
      half = [B * 0.12, B * 0.12, L * 0.08]; density = 260; break;
    case 'reactor-can':
      half = [B * 0.13, B * 0.13, L * 0.07]; density = 900; break;
    case 'radiator-panel':
      half = [B * rng.range(0.2, 0.45), L * rng.range(0.06, 0.16), HATCH_WIDTH_KM * 0.35]; density = 55; break;
    case 'radiator-drum':
      half = [B * 0.1, B * 0.1, L * 0.06]; density = 120; break;
    case 'fuel-drum':
      half = [B * 0.07, B * 0.07, L * 0.05]; density = 300; break;
    case 'turret':
      half = [B * 0.07, B * 0.07, B * 0.09]; density = 900; break;
    case 'missile-rack':
      half = [B * 0.09, B * 0.05, L * 0.05]; density = 700; break;
    case 'point-defence':
      half = [B * 0.035, B * 0.035, B * 0.05]; density = 850; break;
    case 'mining-head':
      half = [B * 0.11, B * 0.11, B * 0.16]; density = 1400; break;
    case 'mining-boom':
      half = [B * 0.05, B * 0.05, L * rng.range(0.12, 0.26)]; density = 500; break;
    case 'ore-processor':
      half = [B * 0.16, B * 0.16, L * 0.1]; density = 1100; break;
    case 'grapple-arm': case 'crane':
      half = [B * 0.05, B * 0.05, L * rng.range(0.1, 0.24)]; density = 450; break;
    case 'cutting-rig':
      half = [B * 0.06, B * 0.06, B * 0.1]; density = 800; break;
    case 'winch':
      half = [B * 0.06, B * 0.06, B * 0.06]; density = 1200; break;
    case 'landing-leg':
      half = [HATCH_WIDTH_KM, ctx.prop.heightKm * 0.2, HATCH_WIDTH_KM]; density = 500; break;
    case 'landing-skid':
      half = [HATCH_WIDTH_KM * 1.2, ctx.prop.heightKm * 0.1, L * 0.12]; density = 400; break;
    // The flush fittings. Their third half-extent is the amount that stands
    // PROUD of the plating, and it is deliberately tiny: a hatch sits in the
    // skin, a navlight lens is a few centimetres of glass. Giving them a
    // nominal depth is what makes a socket refuse a light it could obviously
    // carry, on a hull where something else happens to be nearby.
    case 'service-hatch': case 'toolbox': case 'blanking-plate':
      half = [HATCH_WIDTH_KM * 0.8, HATCH_WIDTH_KM * 0.8, HATCH_WIDTH_KM * 0.05]; density = 350; break;
    case 'ladder': case 'handrail':
      half = [HATCH_WIDTH_KM * 0.35, HUMAN_HEIGHT_KM * 0.6, HATCH_WIDTH_KM * 0.06]; density = 120; break;
    case 'navlight': case 'beacon':
      half = [HATCH_WIDTH_KM * 0.3, HATCH_WIDTH_KM * 0.3, HATCH_WIDTH_KM * 0.07]; density = 200; break;
    default:
      half = [HATCH_WIDTH_KM * 1.5, HATCH_WIDTH_KM * 1.5, HATCH_WIDTH_KM * 0.03]; density = 250; break;
  }
  const m3 = half[0] * half[1] * half[2] * 8 * M3_PER_KM3;
  return { half, massKg: Math.max(20, m3 * density), density };
}

/**
 * Mint a socket at a mount and bolt a module to it.
 *
 * `moduleFitsSocket` from `types.ts` is the gate — type mapping, accept list,
 * envelope and measured clearance. Anything it refuses is logged and dropped,
 * so an over-large module cannot reach the blueprint by being written directly.
 */
function mountModule(
  ctx: Ctx, rng: Rng, kind: ModuleKind, mount: Mount, opts?: {
    readonly mirrorOf?: string | null;
    readonly volumeId?: string | null;
    readonly crewAccessible?: boolean;
    readonly materialSlot?: number;
    readonly mismatched?: boolean;
    /** Replace the catalogue size — used where a part is sized to fit the space
     *  the hull actually left it rather than to a nominal figure. */
    readonly halfExtents?: Vec3;
  },
): ShipModule | null {
  const type = MODULE_SOCKET[kind];
  const cat = moduleSize(ctx, rng, kind);
  const size = opts?.halfExtents
    ? { half: opts.halfExtents, massKg: Math.max(20, opts.halfExtents[0] * opts.halfExtents[1] * opts.halfExtents[2] * 8 * M3_PER_KM3 * cat.density), density: cat.density }
    : cat;
  const radius = Math.max(size.half[0], size.half[1]);
  const depth = size.half[2] * 2;

  const socket = addSocket(ctx, {
    type,
    frame: mount.frame,
    host: { kind: 'volume', volumeId: mount.host.id },
    radius: Math.max(radius * 1.2, radius + HATCH_WIDTH_KM * 0.2),
    depth: Math.max(depth * 1.25, mount.clearance),
    massKg: size.massKg * 4,
    accepts: kindsFor(type),
    // The probe has to reach past the part, or the socket records a clearance
    // shorter than the thing bolted to it and every later reader concludes the
    // module is buried. A radiator's outward span is its `radius`, not its
    // `depth`, which is why both are in here.
    probe: Math.max(depth * 3, radius * 2.6, mount.clearance, ctx.prop.lengthKm * 0.08),
  });

  if (!moduleFits(kind, socket, radius, depth, size.massKg)) {
    reject(ctx, {
      stage: 'modules',
      rule: 'module-too-large',
      what: kind,
      at: mount.frame.origin,
      measured: depth,
      required: Math.min(socket.budget.depth, socket.clearance),
      attempt: 0,
    });
    return null;
  }

  const id = nextId(ctx, 'mod');
  // A hull with refits behind it carries parts from other yards; that mismatch
  // is the cheapest possible read on "this ship has a history" (types.ts).
  const mismatched = opts?.mismatched ?? (ctx.tech.refits > 0 && rng.chance(clamp01(0.12 * ctx.tech.refits)));
  const mod: ShipModule = {
    id,
    kind,
    type,
    socketId: socket.id,
    frame: mount.frame,
    halfExtents: size.half,
    massKg: size.massKg,
    volumeId: opts?.volumeId ?? null,
    present: true,
    integrity: clamp01(rng.range(0.55, 1) * lerp(0.6, 1.1, ctx.tech.maintenance)),
    mismatched,
    materialKey: matKey(ctx, opts?.materialSlot ?? MAT_DETAIL),
    mirrorOf: opts?.mirrorOf ?? null,
    seed: sub(shipSubSeed(ctx.seed, 'modules'), id),
    crewAccessible: opts?.crewAccessible ?? (type === 'airlock' || type === 'docking' || type === 'service'),
  };
  ctx.modules.push(mod);
  ctx.mounts.set(id, { volumeId: mount.host.id, t: mount.t, theta: mount.theta });
  occupy(ctx, socket, id);
  return mod;
}

/** Local mirror of `moduleFitsSocket`, kept typed against a freshly minted socket. */
function moduleFits(kind: ModuleKind, socket: Socket, radius: number, depth: number, massKg: number): boolean {
  if (MODULE_SOCKET[kind] !== socket.type) return false;
  if (socket.accepts.length > 0 && !socket.accepts.includes(kind)) return false;
  if (radius > socket.budget.radius) return false;
  if (depth > socket.budget.depth) return false;
  if (massKg > socket.budget.massKg) return false;
  return depth <= socket.clearance;
}

const DORSAL = Math.PI / 2;
const VENTRAL = -Math.PI / 2;

function placeModules(ctx: Ctx): void {
  const rng = new Rng(shipSubSeed(ctx.seed, 'modules'));
  const L = ctx.prop.lengthKm;
  const B = ctx.prop.beamKm;
  const needs = new Set<SocketType>(ctx.spec.needs);

  // --- command: a cockpit with an actual view cone forward (BRIEF §5) -------
  if (needs.has('cockpit') || needs.has('bridge')) {
    const wantsBridge = needs.has('bridge');
    const kind: ModuleKind = wantsBridge ? 'bridge-tower' : 'cockpit';
    const hosts = hostsFor(ctx, wantsBridge ? ['bridge', 'forebody', 'hull', 'midbody'] : ['forebody', 'hull', 'boom']);
    const m = tryMount(ctx, {
      hosts,
      // Sites are walked from the bow back and from the crown down. The extra
      // dorsal-forward entries exist because the bow now terminates the hull
      // (stage 3), so a bridge sitting low and far forward is looking into the
      // back of its own nose — which is a real constraint on a real ship and
      // the reason superstructures sit high and a little aft of the stem.
      ts: [0.14, 0.22, 0.3, 0.09, 0.42, 0.55],
      thetas: [DORSAL, DORSAL - 0.35, DORSAL + 0.35, DORSAL - 0.7, DORSAL + 0.7, 0, Math.PI],
      // The view has to reach: two ship lengths of clear space, and a cone wide
      // enough to fly by. A cockpit looking into a cargo pod is not a cockpit.
      minClearance: L * 2,
      minAngle: 0.5,
      rule: 'cockpit-view-blocked',
      what: kind,
      aim: [0, 0, -1],
      aimWeight: 1.4,
      acceptBest: true,
      viewFan: true,
    });
    if (m) {
      const mod = mountModule(ctx, rng, kind, m, { materialSlot: MAT_HULL, crewAccessible: true });
      if (mod) {
        // Lit windows spill onto surrounding plate. `Ship.ts` caps the analytic
        // lamp array at 6, so these are rationed to the places that matter.
        ctx.lamps.push({ position: mod.frame.origin, radius: Math.max(mod.halfExtents[0], mod.halfExtents[1]) * 2.2, intensity: 1 });
      }
    }
  }

  // --- sensors -------------------------------------------------------------
  if (needs.has('sensor')) {
    const n = ctx.role === 'survey' || ctx.role === 'science' ? rng.int(2, 4) : rng.int(1, 2);
    const hosts = hostsFor(ctx, ['forebody', 'hull', 'bridge', 'midbody']);
    for (let i = 0; i < n; i++) {
      const kind = pickWeighted(rng, [['sensor-dish', 3] as const, ['sensor-array', 3] as const, ['antenna-mast', 2] as const]);
      const m = tryMount(ctx, {
        hosts,
        ts: [0.12 + i * 0.13, 0.3, 0.45, 0.06],
        thetas: [DORSAL, DORSAL + 0.6, DORSAL - 0.6, 0.3, Math.PI - 0.3],
        minClearance: B * 0.5,
        minAngle: 0.4,
        rule: 'overlaps-existing',
        what: kind,
        acceptBest: i === 0,
      });
      if (m) mountModule(ctx, rng, kind, m);
    }
  }

  // --- radiators: not buried inside other volumes (BRIEF §5) ---------------
  //
  // `ThermalDna.elementCounts` is a HARD CAP, not a hint, and `architecture`
  // decides whether there is any external hardware to count.
  //
  // The count was sampled from the faction and then run through
  // `clamp(…, 1, 5)`, whose floor of one PAIR silently resurrected a radiator
  // on a yard that declares `elementCounts: [0]`. Three Sillane hulls in four
  // came out carrying external fins, on the one faction whose catalogue entry
  // says in as many words that the hull is long *because* its skin is the
  // radiator and there is no external structure of any kind. The role's
  // `requiredVolumeKinds` does not get a vote here: a freighter needs heat
  // rejection, not fins, and this yard's answer to heat rejection is area —
  // which is exactly what `slendernessBandFor`'s thermal floor already buys it,
  // and what `heatStaining: [0.7, 1.0]` then draws on its flanks.
  const heat = ctx.faction.thermal;
  const declaredElements = heat.elementCounts.length > 0 ? Math.max(...heat.elementCounts) : 4;
  // Two doctrines have to agree before a fin exists: the thermal one, which
  // says whether this yard rejects heat through hardware, and the massing one,
  // which says whether it builds separate external masses at all. Either may
  // refuse; neither may be overruled by a clamp.
  const skinRadiator = heat.architecture === 'skin' || heat.architecture === 'none'
    || declaredElements <= 0 || !yardBuilds(ctx, 'radiator');
  if (needs.has('radiator') && !skinRadiator) {
    const heatW = ctx.engines.reduce((s, e) => s + e.heatW, 0);
    const th = ctx.faction.thermal;
    // `areaPerWatt` is the faction's heat doctrine. Its absolute product with a
    // fictional drive power does not close — nothing here can, given a 20 g main
    // drive — so it is used as the RATIO the catalogue says it is: the area this
    // yard would ask for, relative to the mean, times the hull's own plan area.
    const MEAN_AREA_PER_WATT = 2.3e-13;
    const doctrine = clamp(th.areaPerWatt / MEAN_AREA_PER_WATT, 0.4, 2.5);
    // Heat load relative to the reference 30 m survey boat, so a torch on a
    // capital grows visibly bigger fins than an ion grid on a courier.
    const heatRatio = clamp(Math.pow(heatW / 2.0e11, 0.35), 0.4, 3.0);
    const wanted = th.elementCounts.length > 0 ? rng.pick(th.elementCounts) : 4;
    // The floor of one may never resurrect an element the doctrine deleted; a
    // yard that declares a count of zero on this draw builds zero, full stop.
    // The ceiling is left where it was: it is what sizes the Kessler slab pair
    // against a torch drive, and nothing about this defect touched it.
    const pairs = wanted <= 0 ? 0 : clamp(Math.round((wanted / 2) * heatRatio * doctrine), 1, 5);
    const hosts = hostsFor(ctx, ['afterbody', 'hull', 'midbody', 'keel', 'machinery']);
    const size = moduleSize(ctx, rng, 'radiator-panel');
    // A NAMED silhouette accent is a requirement, not a probability.
    //
    // `families.ts:660` states the Kessler read as a black shape: "a
    // rectangular block with visible ribbing, two enormous flat radiator slabs
    // in a mirrored pair, and four bells standing clear of the tail". The
    // generator drew radiators from a size band that had nothing to do with
    // the outline, so the pair came out as small fins and the frame and the
    // document had drifted apart — the only large flat plates anywhere in the
    // faction plate belonged to a different faction's winglets.
    //
    // A yard whose thermal doctrine is FLAT PANELS IN MIRRORED PAIRS gets a
    // pair sized against the hull's own side profile, so the slab reads at
    // fleet range where the faction has to be identified. Everything else
    // keeps the band it had: this is Kessler's accent, not everyone's.
    const slabDoctrine = th.architecture === 'flat-panel' && th.mirrored;
    const sideProfile = ctx.prop.lengthKm * ctx.prop.heightKm;
    const slabSpan = Math.sqrt(Math.max(1e-12, sideProfile * SLAB_FRACTION_OF_PROFILE * sampleRange(th.aspect, rng)));
    const wantSpan = slabDoctrine
      ? clamp(Math.max(size.half[0] * 2, slabSpan), B * 0.25, Math.max(B * 0.25, Math.min(B * 1.1, ctx.prop.lengthKm * 0.2)))
      : size.half[0] * 2;
    // Below this a panel is not a radiator, it is a fin. If the hull cannot
    // give it this much clear space the element is refused rather than buried.
    const minSpan = Math.max(HATCH_WIDTH_KM * 2, B * 0.12);
    for (let i = 0; i < pairs; i++) {
      const t = 0.35 + (i / Math.max(1, pairs)) * 0.5;
      const theta = rng.chance(0.6) ? 0.35 : DORSAL - 0.3;
      // A slab pair wants the FLANKS: that is where a hull offers the longest
      // uninterrupted span, and it is the only mounting that mirrors across X
      // into a pair a viewer reads as a pair. Yards without the flat-panel
      // doctrine keep the older search, which spreads panels round the hull.
      const thetas = slabDoctrine
        ? [0, 0.25, -0.25, theta, DORSAL]
        : [theta, DORSAL, 0.15, -0.35];
      const m = tryMount(ctx, {
        hosts,
        ts: [t, t + 0.1, t - 0.12, 0.6],
        thetas,
        // A radiator must be able to see space along its whole span or it is a
        // heatsink bolted to the thing it is trying to cool. The panel extends
        // OUTWARD along the mount normal, so this really is a depth.
        minClearance: wantSpan,
        minAngle: 0.45,
        rule: 'radiator-buried',
        what: 'radiator-panel',
        acceptBest: true,
      });
      if (!m) continue;
      // Sized to the space the hull actually left, not to a nominal figure —
      // which is what a thermal engineer would do, and it means a cluttered
      // hull grows short fat panels instead of long ones inside its own tanks.
      // BOTH sides are measured BEFORE either is mounted, and a mirrored pair
      // is sized to the smaller of the two.
      //
      // It used to mount the starboard slab at whatever starboard had room
      // for and then measure port; where port came up short the port slab was
      // simply refused, leaving one enormous panel on one side of the ship —
      // which is not a mirrored pair, it is an unbalanced hull. With the slabs
      // sized against the side profile (see `SLAB_FRACTION_OF_PROFILE`) that
      // single panel was heavy enough to walk the balance point off the origin
      // and to put a laden hull 44 m off its own thrust line. A pair is a
      // pair: same span both sides, or neither.
      let span = Math.min(wantSpan, m.clearance * 0.92);
      const mf = th.mirrored ? mirrorFrameXLocal(m.frame) : null;
      let mClear = 0;
      if (mf) {
        const eps = Math.max(1e-6, wantSpan * 0.02);
        const mo: Vec3 = [
          mf.origin[0] + mf.forward[0] * eps, mf.origin[1] + mf.forward[1] * eps, mf.origin[2] + mf.forward[2] * eps,
        ];
        mClear = eps + clearanceAlong(ctx, mo, mf.forward, wantSpan, m.host.id);
        span = Math.min(span, mClear * 0.92);
      }
      if (span < minSpan) {
        reject(ctx, {
          stage: 'secondary', rule: 'radiator-buried', what: mf ? 'radiator-panel (pair)' : 'radiator-panel',
          at: m.frame.origin, measured: mf ? Math.min(m.clearance, mClear) : m.clearance, required: minSpan, attempt: 9,
        });
        continue;
      }
      // Aspect ratio is the faction's; the span is the hull's. Drawn once and
      // used on both slabs, because a pair whose two halves have different
      // aspect ratios is two panels that happen to be opposite each other.
      const aspect = Math.max(0.2, sampleRange(th.aspect, rng));
      const half: Vec3 = [span * 0.5, span * 0.5 / aspect, size.half[2]];
      const a = mountModule(ctx, rng, 'radiator-panel', m, { materialSlot: MAT_STRUCT, halfExtents: half });
      if (!a) continue;
      // `mirrored: false` licenses the salvage read — three panels at three
      // different angles — and is a real cultural difference, not an oversight.
      if (mf) {
        const mirrored: Mount = { ...m, frame: mf, theta: Math.PI - m.theta, clearance: mClear };
        mountModule(ctx, rng, 'radiator-panel', mirrored, { mirrorOf: a.id, materialSlot: MAT_STRUCT, halfExtents: half });
      }
      ctx.volumes.push(radiatorVolume(ctx, rng, a));
    }
  }

  // --- weapons: unobstructed fields of fire (BRIEF §5) ---------------------
  if (needs.has('weapon')) {
    const n = ctx.role === 'gunship' ? rng.int(3, 6) : ctx.role === 'carrier' ? rng.int(3, 6) : rng.int(1, 3);
    const hosts = hostsFor(ctx, ['hull', 'midbody', 'forebody', 'afterbody', 'wing']);
    for (let i = 0; i < n; i++) {
      const kind = pickWeighted(rng, ctx.spec.wants.filter((w) => MODULE_SOCKET[w[0]] === 'weapon'));
      const dorsalSide = i % 2 === 0;
      const m = tryMount(ctx, {
        hosts,
        ts: [0.2 + (i / Math.max(1, n)) * 0.6, 0.3, 0.5, 0.7],
        thetas: dorsalSide ? [DORSAL, DORSAL - 0.5, DORSAL + 0.5] : [VENTRAL, VENTRAL + 0.5, VENTRAL - 0.5],
        minClearance: B * 0.9,
        // A TRAINABLE mount has to track a target that is moving, so it needs
        // sky, not a gunport: 0.7 rad is 40° of clear cone, and below that a
        // turret can only engage something that flies into its slit. A fixed
        // gun aims by flying the ship and keeps the older, looser bar — it is
        // the airframe that traverses. `remeasureClearances` holds the same
        // two bars after stages 6–8 have placed things in front of them.
        minAngle: kind === 'turret' || kind === 'point-defence' ? 0.7 : 0.4,
        rule: 'weapon-arc-obstructed',
        what: kind,
      });
      if (!m) continue;
      const mod = mountModule(ctx, rng, kind, m, { materialSlot: MAT_STRUCT });
      if (!mod) continue;
      const hpKind: HardpointKind = kind === 'turret' ? 'turret' : kind === 'missile-rack' ? 'missile-rack' : 'point-defence';
      const mount: Hardpoint['mount'] = kind === 'turret' ? 'turret' : kind === 'point-defence' ? 'barbette' : 'fixed';
      ctx.hardpoints.push({
        id: nextId(ctx, 'hp'),
        kind: hpKind,
        socketId: mod.socketId as SocketId<'weapon'>,
        frame: mod.frame,
        mount,
        traverse: mount === 'fixed' ? [-0.1, 0.1] : [-Math.PI, Math.PI],
        elevation: mount === 'fixed' ? [-0.05, 0.05] : [-0.35, 1.4],
        // The measured cone, not the mechanical limits: a turret that can
        // traverse 360° through a radiator has a 40° field of fire.
        clearArc: m.clearAngle,
        threatWeight: kind === 'missile-rack' ? 0.45 : kind === 'turret' ? 0.35 : 0.12,
        moduleId: mod.id,
        mirrorOf: null,
      });
    }
  }

  // --- industrial gear: structural, not bolted on (BRIEF §4) ---------------
  if (needs.has('mining')) placeIndustrial(ctx, rng, 'mining');
  if (needs.has('salvage')) placeIndustrial(ctx, rng, 'salvage');

  // --- docking: reachable from outside (BRIEF §5) --------------------------
  if (needs.has('docking')) {
    const n = ctx.role === 'carrier' || ctx.role === 'liner' || ctx.role === 'colony' ? rng.int(2, 4) : rng.int(1, 2);
    const hosts = hostsFor(ctx, ['hull', 'midbody', 'forebody', 'habitat']);
    const size = moduleSize(ctx, rng, 'docking-collar');
    const wantDiameter = size.half[0] * 2;
    // A collar has to admit a suited human through an airlock; below that it is
    // an umbilical fitting, not a dock.
    const minDiameter = HATCH_WIDTH_KM * 2.2;
    for (let i = 0; i < n; i++) {
      const m = tryMount(ctx, {
        hosts,
        ts: [0.3 + i * 0.18, 0.45, 0.2, 0.6],
        thetas: [i % 2 === 0 ? 0 : Math.PI, DORSAL, 0.6, Math.PI - 0.6],
        // Three collar diameters of straight corridor, or nothing can dock.
        minClearance: wantDiameter * 3,
        minAngle: 0.35,
        rule: 'docking-unreachable',
        what: 'docking-collar',
        acceptBest: true,
      });
      if (!m) continue;
      // The corridor is what it is; the collar is sized to fit it. A port that
      // announces a diameter its approach cannot deliver is worse than no port.
      const diameter = Math.min(wantDiameter, m.clearance / 3);
      if (diameter < minDiameter) {
        reject(ctx, {
          stage: 'modules', rule: 'docking-unreachable', what: 'docking-collar',
          at: m.frame.origin, measured: m.clearance, required: minDiameter * 3, attempt: 9,
        });
        continue;
      }
      const mod = mountModule(ctx, rng, 'docking-collar', m, {
        crewAccessible: true, materialSlot: MAT_STRUCT,
        halfExtents: [diameter * 0.5, diameter * 0.5, size.half[2]],
      });
      if (!mod) continue;
      ctx.docks.push({
        id: nextId(ctx, 'dock'),
        socketId: mod.socketId as SocketId<'docking'>,
        kind: pickWeighted(rng, [['collar', 4] as const, ['clamp', 2] as const, ['magnetic', 2] as const, ['gantry', 1] as const, ['umbilical', 1] as const]),
        frame: mod.frame,
        diameter,
        approachCone: m.clearAngle,
        approachClearance: m.clearance,
        pressurised: ctx.tech.pressurised,
        guideLightCount: rng.int(3, 8),
      });
      ctx.lamps.push({ position: mod.frame.origin, radius: diameter, intensity: 0.35 });
    }
  }

  // --- airlocks, service, habitat -----------------------------------------
  if (needs.has('airlock')) {
    const hosts = hostsFor(ctx, ['hull', 'habitat', 'forebody', 'midbody']);
    const m = tryMount(ctx, {
      hosts, ts: [0.35, 0.5, 0.25], thetas: [0.25, Math.PI - 0.25, DORSAL],
      minClearance: HATCH_WIDTH_KM * 3, minAngle: 0.3, rule: 'overlaps-existing', what: 'airlock', acceptBest: true,
    });
    if (m) mountModule(ctx, rng, 'airlock', m, { crewAccessible: true, materialSlot: MAT_HULL });
  }

  if (needs.has('habitat')) {
    const hosts = hostsFor(ctx, ['hull', 'midbody', 'keel', 'habitat']);
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++) {
      const m = tryMount(ctx, {
        hosts, ts: [0.3 + i * 0.16, 0.55], thetas: [DORSAL, VENTRAL, 0.4],
        minClearance: B * 0.3, minAngle: 0.35, rule: 'overlaps-existing', what: 'habitat-can',
      });
      if (m) {
        const mod = mountModule(ctx, rng, 'habitat-can', m, { crewAccessible: true, materialSlot: MAT_HULL });
        if (mod) ctx.lamps.push({ position: mod.frame.origin, radius: mod.halfExtents[0] * 2, intensity: 0.7 });
      }
    }
  }

  if (needs.has('reactor')) {
    const hosts = hostsFor(ctx, ['afterbody', 'machinery', 'hull']);
    const m = tryMount(ctx, {
      hosts, ts: [0.5, 0.35, 0.65], thetas: [DORSAL, 0, VENTRAL],
      minClearance: B * 0.15, minAngle: 0.25, rule: 'overlaps-existing', what: 'reactor-can', acceptBest: true,
    });
    if (m) mountModule(ctx, rng, 'reactor-can', m, { materialSlot: MAT_STRUCT });
  }

  // --- the payload, expressed as HARDWARE (BRIEF §4) -----------------------
  //
  // "A freighter must look like it carries cargo." The generator knew the hero
  // carried 3 710 m³ — `shipScan` printed it — and there was no bay, no rack,
  // no hatch line and no external payload anywhere on the hull, because the
  // volume was allocated internally and never expressed as form. Shown the
  // three-faction contrast plate, which holds ROLE constant at freighter, the
  // critic read tanker, gunship and carrier: nought for three.
  //
  // The old pass scattered one to eight singles through the generic mount grid,
  // where they competed with every other fitting and lost — one container on
  // the hero, two on the best of four sampled hulls. This lays a RACK: a row of
  // whole standard units at container pitch along the payload mass, on the
  // faces a gantry can reach, which is what a container rack is and what makes
  // the scale shot's floating 12.2 m box correspond to something on the ship.
  if (needs.has('cargo')) {
    const pods = ctx.volumes.filter((v) => v.kind === 'cargo-bay' || v.kind === 'cargo-rack');
    const hosts = pods.length > 0 ? pods : ctx.volumes.filter((v) => v.kind === 'pod' || v.kind === 'tank');
    // Ore comes out of the ground in bins, not in ISO boxes, and a bin scales
    // with the rig that fills it. Everything else moves in the standard unit.
    const ore = ctx.role === 'miner' || ctx.role === 'prospector' || ctx.role === 'salvager';
    let placed = 0;
    const MAX_UNITS = 20;
    for (const host of hosts) {
      if (placed >= MAX_UNITS) break;
      const hb = boundsOf(ctx, host);
      const runLen = hb.max[2] - hb.min[2];
      const across = Math.max(hb.max[0] - hb.min[0], hb.max[1] - hb.min[1]) * 0.5;
      // The unit follows the mass that carries it. A payload big enough to
      // rack STANDARD containers gets standard containers — that is the whole
      // point of a standard container, and it is what makes the docking-scale
      // shot's floating 12.2 m box mean something. A payload smaller than one
      // gets ship-scaled pods, because a 12 m box racked on a 5 m hold is a
      // box with a ship attached and destroys the scale read it exists to give.
      const bigEnough = across >= CONTAINER_LENGTH_KM * 0.26 && runLen >= CONTAINER_LENGTH_KM * 2;
      // A yard that racks boxes racks boxes; one that ships in pressurised
      // pods ships in pods. Both are legal answers on a hull big enough for
      // either, and which one this yard uses is a fact about the yard.
      const kind: ModuleKind = ore ? 'ore-bin'
        : bigEnough && rng.chance(0.72) ? 'cargo-container' : 'cargo-pod';
      const unitLen = kind === 'cargo-container' ? CONTAINER_LENGTH_KM : L * 0.18;
      if (runLen < unitLen * 1.5 || across < unitLen * 0.2) continue;
      const perRow = clamp(Math.floor(runLen / (unitLen * 1.18)), 1, 8);
      // Both flanks and the crown: the three faces a gantry crane can reach.
      // The belly is left clear for the undercarriage and the ground.
      const faces = ROLE_TOPOLOGY[ctx.role].landsOnSurfaces ? [0, Math.PI] : [0, Math.PI, DORSAL];
      for (const theta of faces) {
        for (let i = 0; i < perRow && placed < MAX_UNITS; i++) {
          const t = (i + 0.5) / perRow;
          const p = volumeSurfacePoint(host, t, theta, [0, 0, 0]);
          const n = surfaceNormal(host, t, theta, [0, 0, 0]);
          const frame = frameAt([p[0], p[1], p[2]], [n[0], n[1], n[2]], Math.abs(n[1]) > 0.94 ? FWD_Z : UP_Y);
          // Measured from a hair OFF the skin: the mount point is on the
          // surface, so a sweep started exactly there reports the hull it is
          // bolted to as the obstruction and every rack came out empty.
          const depth = kind === 'cargo-container' ? CONTAINER_LENGTH_KM * 0.4 : L * 0.09 * 2;
          const eps = depth * 0.05;
          const o: Vec3 = [
            frame.origin[0] + n[0] * eps,
            frame.origin[1] + n[1] * eps,
            frame.origin[2] + n[2] * eps,
          ];
          const clearance = eps + clearanceAlong(ctx, o, frame.forward, depth * 2.2, host.id);
          // The unit stands proud of the skin, so it needs its own depth of
          // daylight in front of the face it is racked on.
          if (clearance < depth * 0.55) continue;
          const mod = mountModule(ctx, rng, kind, {
            host, t, theta, frame, clearance, clearAngle: 0.5, view: null,
          }, { materialSlot: MAT_HULL });
          if (mod) placed++;
        }
      }
    }
    if (placed === 0 && hosts.length > 0) {
      reject(ctx, {
        stage: 'modules',
        rule: 'payload-not-dominant',
        what: 'no payload mass could carry a cargo handling unit',
        at: [0, 0, 0],
        measured: 0,
        required: 4,
        attempt: 0,
      });
    }
  }

  // --- landing gear, then navlights and emblems ----------------------------
  // `families.ts` only declares a `landing` socket for the handful of roles
  // that carry a full undercarriage, which left thirteen of eighteen roles with
  // no way to set down at all — a 54 m courier and a 57 m station-tender that
  // can only ever hard-dock are functional contradictions, and BRIEF §5's
  // "clearance below every other part" was being verified against a single
  // sample because only one hull in sixteen had any gear to check. The
  // topology table now says which roles put themselves on a surface, and where
  // it does the gear is required rather than optional.
  if (needs.has('landing') || ROLE_TOPOLOGY[ctx.role].landsOnSurfaces) placeLandingGear(ctx, rng);
  placeServiceAndLights(ctx, rng);
}

/** Mirror a frame across the ship's XZ plane — `mirrorFrameX` from `types.ts`
 *  with the same semantics, kept local so the placement code reads straight. */
function mirrorFrameXLocal(f: Frame): Frame {
  return {
    origin: [-f.origin[0], f.origin[1], f.origin[2]],
    forward: [-f.forward[0], f.forward[1], f.forward[2]],
    up: [-f.up[0], f.up[1], f.up[2]],
  };
}

/**
 * A radiator is a swept slab, not a decal: it gets its own volume so it casts a
 * silhouette, occludes, and can be torn off by a collision later.
 */
function radiatorVolume(ctx: Ctx, rng: Rng, mod: ShipModule): PrimaryVolume {
  const half = mod.halfExtents;
  return sweptVolume(ctx, rng, {
    kind: 'radiator',
    frame: frameAt(mod.frame.origin, mod.frame.forward, mod.frame.up),
    length: half[0] * 2,
    halfWidth: half[2],
    halfHeight: half[1],
    bias: 'panel',
    capStart: 'flat',
    capEnd: 'flat',
    materialSlot: MAT_STRUCT,
    detailDensity: 0.15,
    loadShare: 0.05,
    stations: 3,
    anchor: { kind: 'socket', socketId: mod.socketId },
  });
}

/**
 * Mining and salvage gear. BRIEF §4: "a miner must carry visible industrial
 * machinery"; §4 again: it must be structural, not bolted on. So the heads go
 * on the FORWARD faces where the work happens, the booms run along the hull
 * from a root near the keel, and both are sized off the beam rather than
 * scattered at a decorative scale.
 */
function placeIndustrial(ctx: Ctx, rng: Rng, type: 'mining' | 'salvage'): void {
  const L = ctx.prop.lengthKm;
  const B = ctx.prop.beamKm;
  const hosts = hostsFor(ctx, type === 'mining'
    ? ['machinery', 'forebody', 'hull', 'keel', 'cargo-rack']
    : ['machinery', 'hull', 'boom', 'forebody', 'keel']);
  const kinds = ctx.spec.wants.filter((w) => MODULE_SOCKET[w[0]] === type);
  if (kinds.length === 0) return;
  const n = rng.int(2, 4);

  for (let i = 0; i < n; i++) {
    const kind = pickWeighted(rng, kinds);
    const reachForward = kind === 'mining-head' || kind === 'cutting-rig' || kind === 'grapple-arm';
    const m = tryMount(ctx, {
      hosts,
      ts: reachForward ? [0.02, 0.1, 0.2] : [0.3 + i * 0.15, 0.5, 0.65],
      thetas: reachForward ? [VENTRAL + 0.4, VENTRAL, 0, Math.PI] : [0.2, Math.PI - 0.2, DORSAL, VENTRAL],
      minClearance: reachForward ? L * 0.25 : B * 0.4,
      minAngle: reachForward ? 0.45 : 0.3,
      rule: 'overlaps-existing',
      what: kind,
      aim: reachForward ? [0, 0, -1] : undefined,
      aimWeight: reachForward ? 0.9 : 0,
      acceptBest: i === 0,
    });
    if (!m) continue;
    const mod = mountModule(ctx, rng, kind, m, { materialSlot: MAT_STRUCT });
    if (!mod) continue;
    ctx.hardpoints.push({
      id: nextId(ctx, 'hp'),
      kind: type === 'mining' ? (kind === 'mining-head' ? 'mining-laser' : 'cutter') : (kind === 'grapple-arm' ? 'grapple' : 'cutter'),
      socketId: mod.socketId as SocketId<'mining' | 'salvage'>,
      frame: mod.frame,
      mount: 'barbette',
      traverse: [-0.8, 0.8],
      elevation: [-0.5, 0.5],
      clearArc: m.clearAngle,
      threatWeight: 0.08,
      moduleId: mod.id,
      mirrorOf: null,
    });
    // The machinery gets a body, so it reads as plant rather than as a sprite.
    if (kind === 'mining-head' || kind === 'ore-processor' || kind === 'crane' || kind === 'mining-boom') {
      ctx.volumes.push(sweptVolume(ctx, rng, {
        kind: 'machinery',
        frame: mod.frame,
        length: mod.halfExtents[2] * 2,
        halfWidth: mod.halfExtents[0],
        halfHeight: mod.halfExtents[1],
        bias: 'machinery',
        capStart: 'flat',
        capEnd: kind === 'mining-head' ? 'taper' : 'flat',
        materialSlot: MAT_STRUCT,
        detailDensity: 1.0,
        loadShare: 0.15,
        stations: 3,
        anchor: { kind: 'socket', socketId: mod.socketId },
      }));
    }
  }
}

/**
 * Landing gear.
 *
 * BRIEF §5: "landing gear on the underside, with clearance below every other
 * part". That is a measurement, not a placement rule — so the lowest point of
 * every non-gear volume is found first, and the legs are then SIZED to reach
 * past it. A leg that would have to be absurdly long for the hull it is on
 * (a spine-and-pod freighter with ventral tanks) is refused and the ship simply
 * does not land, which is a truthful answer.
 */
function placeLandingGear(ctx: Ctx, rng: Rng): void {
  const L = ctx.prop.lengthKm;
  const H = ctx.prop.heightKm;

  let lowest = 0;
  for (const v of ctx.volumes) {
    const b = boundsOf(ctx, v);
    if (b.min[1] < lowest) lowest = b.min[1];
  }
  const clearGround = Math.max(HUMAN_HEIGHT_KM, H * 0.06);
  const needed = -lowest + clearGround;
  // A lander's legs are as long as they have to be — an Apollo LM's are most of
  // its height — and holding them to 55% of the hull HEIGHT was refusing gear
  // on exactly the hulls whose role is to set down: a slab courier is wide and
  // shallow, so a bound taken from its height could not reach past its own
  // engine bells. Measured against the larger of the two cross-section
  // dimensions, it is a bound on absurdity rather than on reach.
  const maxLeg = Math.max(H, ctx.prop.beamKm * 0.5) * 1.4 + clearGround;

  if (needed > maxLeg) {
    reject(ctx, {
      stage: 'landing',
      rule: 'gear-not-lowest',
      what: 'landing gear',
      at: [0, lowest, 0],
      measured: maxLeg,
      required: needed,
      attempt: 0,
    });
    ctx.landing = null;
    return;
  }

  const style: LandingLeg['style'] = ctx.tech.atmosphereCapable
    ? rng.pick(['strut', 'a-frame', 'wheeled'] as const)
    : rng.pick(['strut', 'a-frame', 'pad', 'skid'] as const);
  const tripod = rng.chance(0.3);
  const count = tripod ? 3 : 4;
  // Hang them from whatever reaches furthest down: a leg rooted in the dorsal
  // hull while a ventral tank hangs below it is a leg that cannot touch the
  // ground before the tank does.
  const candidates = hostsFor(ctx, ['hull', 'midbody', 'forebody', 'afterbody', 'keel']);
  const zSpan = (v: PrimaryVolume): number => { const b2 = boundsOf(ctx, v); return b2.max[2] - b2.min[2]; };
  const longest = candidates.reduce((mx, v) => Math.max(mx, zSpan(v)), 0);
  // Legs go on something long enough to spread them fore and aft — a tripod
  // rooted in a two-metre ventral tank has a footprint the balance point falls
  // outside of — and, among those, on whatever reaches furthest down, because a
  // leg rooted above a ventral pod cannot touch the ground before the pod does.
  const hosts = candidates
    .filter((v) => zSpan(v) >= longest * 0.5)
    .sort((a2, b2) => boundsOf(ctx, a2).min[1] - boundsOf(ctx, b2).min[1]);
  if (hosts.length === 0) {
    reject(ctx, {
      stage: 'landing', rule: 'gear-not-lowest', what: 'no volume to hang legs from',
      at: [0, lowest, 0], measured: 0, required: 1, attempt: 0,
    });
    ctx.landing = null;
    return;
  }
  const legs: LandingLeg[] = [];
  let contactY = 0;

  // Legs are spread over the fore-aft extent so the footprint is wide in Z, not
  // just in X: a ship on four legs in a square tips fore-and-aft first.
  const spots: readonly Vec2[] = tripod
    ? [[0.12, 0], [0.86, 0.55], [0.86, -0.55]]
    : [[0.14, 0.5], [0.14, -0.5], [0.86, 0.6], [0.86, -0.6]];

  for (let i = 0; i < count; i++) {
    const [tz, sx] = spots[i];
    const theta = VENTRAL + sx * 0.55;
    const host = hosts[0];
    const p = volumeSurfacePoint(host, clamp(tz, 0.03, 0.97), theta, [0, 0, 0]);
    const hip: Vec3 = [p[0], p[1], p[2]];
    const legLen = clamp(hip[1] - (lowest - clearGround), clearGround, maxLeg);
    const contact: Vec3 = [hip[0] * rng.range(1.0, 1.35), hip[1] - legLen, hip[2]];
    contactY = Math.min(contactY, contact[1]);

    const size = moduleSize(ctx, rng, style === 'skid' ? 'landing-skid' : 'landing-leg');
    const frame = frameAt(hip, [0, -1, 0], FWD_Z);
    const socket = addSocket<'landing'>(ctx, {
      type: 'landing',
      frame,
      host: { kind: 'volume', volumeId: host.id },
      radius: size.half[0] * 2,
      depth: legLen * 1.2,
      massKg: size.massKg * 6,
      accepts: kindsFor('landing'),
      probe: legLen * 1.5,
    });
    const id = nextId(ctx, 'leg');
    legs.push({
      id,
      socketId: socket.id,
      frame,
      style,
      length: legLen,
      padRadius: Math.max(HATCH_WIDTH_KM * 0.8, ctx.prop.beamKm * 0.035),
      travel: legLen * rng.range(0.08, 0.18),
      contactPoint: contact,
      mirrorOf: i > 0 && !tripod && i % 2 === 1 ? legs[i - 1].id : null,
    });
    occupy(ctx, socket, id);
  }

  // Convex hull of the contact points in the XZ plane. Three or four points, so
  // gift-wrapping is both the simplest and the fastest thing that works.
  const pts: Vec2[] = legs.map((l) => [l.contactPoint[0], l.contactPoint[2]]);
  const footprint = convexHullXZ(pts);

  ctx.landing = {
    legs,
    retracts: ctx.tech.atmosphereCapable || rng.chance(0.4),
    footprint,
    staticHeight: -contactY,
    lowestFixedPoint: lowest,
  };

}

/**
 * A footprint that does not contain the centre of mass is a ship that tips over
 * on touchdown. Worth saying out loud rather than discovering in play.
 *
 * Checked AFTER the rebase, and that is the whole point of it living here: the
 * origin only becomes the centre of mass in `balance`, so the same test run at
 * placement time was comparing the footprint against a point that was not yet
 * the balance point. It reported a tipping hazard on hulls that stand up
 * perfectly well and would have missed one that does not.
 */
function auditLandingFootprint(ctx: Ctx): void {
  const ls = ctx.landing;
  if (!ls || ls.footprint.length < 3) return;
  if (pointInPolygon([0, 0], ls.footprint)) return;
  reject(ctx, {
    stage: 'landing',
    rule: 'gear-not-lowest',
    what: 'footprint does not contain the centre of mass',
    at: [0, -ls.staticHeight, 0],
    measured: 0,
    required: 1,
    attempt: 1,
  });
}

function convexHullXZ(pts: readonly Vec2[]): readonly Vec2[] {
  if (pts.length < 3) return pts.slice();
  const sorted = pts.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1] || 1e-12) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * Navigation lights, service fittings and the emblem.
 *
 * Navlights go on the EXTREMITIES, because their whole job is to tell another
 * pilot how big you are and which way you are pointing. Port red, starboard
 * green, a white strobe on the highest point: not decoration, a size cue.
 */
function placeServiceAndLights(ctx: Ctx, rng: Rng): void {
  const box = ctx.volumes.reduce<Aabb | null>((acc, v) => (acc ? unionAabb(acc, boundsOf(ctx, v)) : boundsOf(ctx, v)), null);
  if (!box) return;
  const hosts = hostsFor(ctx, ['hull', 'midbody', 'forebody', 'afterbody']);
  const host = hosts[0];

  const extremes: readonly (readonly [number, number, string])[] = [
    [0.03, DORSAL, 'nose'],
    [0.97, DORSAL, 'tail'],
    [0.5, 0, 'starboard'],
    [0.5, Math.PI, 'port'],
    [0.35, DORSAL, 'dorsal'],
  ];
  for (const [t, theta, where] of extremes) {
    const p = volumeSurfacePoint(host, t, theta, [0, 0, 0]);
    const n = surfaceNormal(host, t, theta, [0, 0, 0]);
    const frame = frameAt([p[0], p[1], p[2]], [n[0], n[1], n[2]], Math.abs(n[1]) > 0.94 ? FWD_Z : UP_Y);
    const kind: ModuleKind = where === 'dorsal' || where === 'tail' ? 'beacon' : 'navlight';
    // Routed through the same validated path as everything else. A navlight
    // that will not fit its own recess is a bug wherever it appears, and going
    // round `mountModule` to place one is how it would stop being visible.
    mountModule(ctx, rng, kind, {
      host, t, theta, frame,
      clearance: clearanceAlong(ctx, frame.origin, frame.forward, ctx.prop.beamKm * 0.2, host.id),
      clearAngle: 0.7,
      view: null,
    }, { materialSlot: MAT_DETAIL });
  }

  // Service fittings, and the handrails and ladders that connect the things a
  // suited human has to reach. Purely a hint in the contract, but a hull with
  // no route between its hatches never reads as inhabited.
  const crewPoints = ctx.modules.filter((m) => m.crewAccessible).length;
  const serviceCount = clamp(Math.round(2 + crewPoints * rng.range(0.8, 2.2) + ctx.prop.lengthKm / (CONTAINER_LENGTH_KM * 6)), 2, 14);
  for (let i = 0; i < serviceCount; i++) {
    const v = ctx.volumes[Math.floor(rng.next() * ctx.volumes.length)];
    if (v.kind === 'nacelle' || v.kind === 'radiator') continue;
    const t = rng.range(0.08, 0.92);
    const theta = rng.range(0, TAU);
    const p = volumeSurfacePoint(v, t, theta, [0, 0, 0]);
    const n = surfaceNormal(v, t, theta, [0, 0, 0]);
    const frame = frameAt([p[0], p[1], p[2]], [n[0], n[1], n[2]], Math.abs(n[1]) > 0.94 ? FWD_Z : UP_Y);
    const kind = pickWeighted(rng, [
      ['service-hatch', 4] as const, ['handrail', 4] as const, ['ladder', 2] as const, ['toolbox', 1] as const,
    ]);
    mountModule(ctx, rng, kind, { host: v, t, theta, frame, clearance: ctx.prop.beamKm, clearAngle: 0.6, view: null }, { crewAccessible: true });
  }

  // The emblem goes on the largest flat the ship has, which is where a yard
  // would put it: a big pod side, or the hull amidships.
  const flat = ctx.volumes.filter((v) => v.kind !== 'nacelle' && v.kind !== 'radiator')
    .sort((a, b) => volumeSpan(ctx, b) - volumeSpan(ctx, a))[0];
  if (flat) {
    const t = 0.45;
    const theta = rng.chance(0.5) ? 0.2 : Math.PI - 0.2;
    const p = volumeSurfacePoint(flat, t, theta, [0, 0, 0]);
    const n = surfaceNormal(flat, t, theta, [0, 0, 0]);
    const frame = frameAt([p[0], p[1], p[2]], [n[0], n[1], n[2]], UP_Y);
    mountModule(ctx, rng, rng.chance(0.5) ? 'emblem-plate' : 'registry-plate', {
      host: flat, t, theta, frame, clearance: ctx.prop.beamKm, clearAngle: 0.8, view: null,
    }, { materialSlot: MAT_HULL });
  }
}

function volumeSpan(ctx: Ctx, v: PrimaryVolume): number {
  const b = boundsOf(ctx, v);
  return (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]);
}

// ===========================================================================
// STAGE 6 — secondary volumes
//
// "Radiators, tanks, gear, sensors" (BRIEF §4.6). Radiators were built with
// their modules in stage 5 because they are sized from the drive's waste heat,
// which only exists after stage 4. What is left is what the role still needs
// and the archetype has not already provided.
// ===========================================================================

function buildSecondary(ctx: Ctx): void {
  const rng = new Rng(shipSubSeed(ctx.seed, 'secondary'));
  const p = ctx.prop;
  const L = p.lengthKm;

  // Propellant. Every ship needs tankage; a hull that has none in its primary
  // volumes gets external drums, which is itself a strong industrial read.
  const hasTank = ctx.volumes.some((v) => v.kind === 'tank' || v.construction.kind === 'tank');
  if (!hasTank) {
    // A bottle strapped to the flank is one yard's industrial read; a moulded
    // bay inside the loft is another's, and the difference is doctrine rather
    // than taste. `attach: 'flush'` puts the drum INSIDE the body it belongs
    // to: same volume, same propellant mass, no external object. Only the
    // standoff distance changes, which is the whole of the disagreement.
    const fused = (ctx.faction.massing as MassingDna | undefined)?.attach === 'flush';
    const n = fused ? 1 : rng.int(1, 3);
    const host = hostsFor(ctx, ['hull', 'keel', 'midbody', 'afterbody'])[0];
    const r = Math.max(p.beamKm, p.heightKm) * rng.range(0.1, 0.18);
    const shape = makeSection(rng, ctx.dna, 'tank', true);
    const scalars = makeScalars(rng, ctx.dna, shape, 'tank');
    // A ship that sets down on a surface does not hang its drums under its
    // belly. The legs would have to reach past them, which is the refusal that
    // was taking the undercarriage off six couriers in eight.
    const lands = ROLE_TOPOLOGY[ctx.role].landsOnSurfaces;
    for (let i = 0; i < n; i++) {
      const t = 0.45 + i * 0.14;
      const theta = n === 1 ? (lands ? DORSAL : VENTRAL) : (i % 2 === 0 ? 0.5 : Math.PI - 0.5);
      const sp = volumeSurfacePoint(host, clamp(t, 0.05, 0.9), theta, [0, 0, 0]);
      const sn = surfaceNormal(host, clamp(t, 0.05, 0.9), theta, [0, 0, 0]);
      // `-r` sinks the drum a full radius INSIDE the skin it was sitting on.
      const stand = fused ? -r : r;
      ctx.volumes.push(sweptVolume(ctx, rng, {
        kind: 'tank',
        frame: axialFrame(sp[0] + sn[0] * stand, sp[1] + sn[1] * stand, sp[2] - L * 0.09),
        length: L * rng.range(0.14, 0.26),
        halfWidth: r,
        halfHeight: r,
        bias: 'tank',
        capStart: 'dome',
        capEnd: 'dome',
        materialSlot: MAT_HULL,
        detailDensity: 0.25,
        loadShare: 0.2,
        shape,
        scalars,
        frameEvery: 1,
        anchor: { kind: 'volume', volumeId: host.id, t },
      }));
    }
  }

  // Atmospheric surfaces, only where the hull actually enters an atmosphere.
  // A wing on a ship that never sees air is the single most common piece of
  // procedural nonsense, so it is gated on `atmosphereCapable`.
  if (ctx.tech.atmosphereCapable && rng.chance(0.75)) {
    const host = hostsFor(ctx, ['hull', 'midbody', 'boom'])[0];
    const t = rng.range(0.55, 0.8);
    const span = p.beamKm * rng.range(0.35, 0.8);
    const shape = makeSection(rng, ctx.dna, 'panel', true);
    const scalars = makeScalars(rng, ctx.dna, shape, 'panel');
    for (const side of [1, -1]) {
      const theta = side > 0 ? 0.1 : Math.PI - 0.1;
      const sp = volumeSurfacePoint(host, t, theta, [0, 0, 0]);
      ctx.volumes.push(sweptVolume(ctx, rng, {
        kind: 'wing',
        frame: frameAt([sp[0], sp[1], sp[2]], [side, 0, 0], UP_Y),
        length: span,
        halfWidth: Math.max(HATCH_WIDTH_KM * 0.5, p.heightKm * 0.04),
        halfHeight: L * rng.range(0.07, 0.16),
        bias: 'panel',
        capStart: 'flat',
        capEnd: 'taper',
        materialSlot: MAT_STRUCT,
        detailDensity: 0.2,
        loadShare: 0.1,
        shape,
        scalars,
        stations: 4,
        profile: (u) => lerp(1, rng.range(0.35, 0.7), u),
        profileY: (u) => lerp(1, rng.range(0.4, 0.8), u),
        mirrorOf: side < 0 ? ctx.volumes[ctx.volumes.length - 1].id : null,
        anchor: { kind: 'volume', volumeId: host.id, t },
      }));
    }
  }

  // Sensor booms: instruments held away from the hull so they are not looking
  // through their own ship. Science and survey hulls earn long ones.
  //
  // …but only where the yard's sensor doctrine puts instruments on booms at all.
  // `SensorDna` states it twice — as a `language` and as a `standoff` band —
  // and this stage was reading neither, so a yard whose entry says
  // `conformal-array`, "flush phased-array patches; no protrusion",
  // `standoff: [0.0, 0.03]`, still grew a mast off its crown on three hulls in
  // ten. On a buried-structure faction that mast is the strongest thing in the
  // silhouette and it is another culture's word.
  const sens = ctx.faction.sensors;
  const boomYard = yardBuilds(ctx, 'boom')
    && (sens.language === 'boom-instrument' || sens.language === 'mast-array'
      || sens.language === 'whip-forest' || sens.language === 'caged-dish'
      || sens.standoff[1] >= 0.08);
  if (boomYard && ctx.spec.needs.includes('sensor') && (ctx.role === 'science' || ctx.role === 'survey' || rng.chance(0.3))) {
    const host = hostsFor(ctx, ['forebody', 'hull', 'bridge'])[0];
    const t = rng.range(0.05, 0.25);
    const theta = rng.chance(0.6) ? DORSAL : VENTRAL;
    const sp = volumeSurfacePoint(host, t, theta, [0, 0, 0]);
    const sn = surfaceNormal(host, t, theta, [0, 0, 0]);
    // Raked forward, not straight out sideways.
    //
    // A sensor mast exists to get the instrument away from the ship's own
    // structure and emissions, and the cheapest direction to do that in is
    // along the axis, past the bow — which is where every real spacecraft
    // magnetometer boom points. Straight out it was up to 0.3 × LENGTH of
    // pure beam: on a 279 m survey hull, an 84 m mast standing off a 68 m
    // hull. That single volume was setting the height of the whole envelope,
    // which is how a ship ends up measuring 1.8 : 1 on its long axis. Two
    // thirds forward, one third radial, and a third of the length.
    const rake = rng.range(0.55, 0.78);
    const dir: Vec3 = [sn[0] * (1 - rake), sn[1] * (1 - rake), -rake];
    vNormalize(dir as MutVec3, dir as MutVec3);
    ctx.volumes.push(sweptVolume(ctx, rng, {
      kind: 'boom',
      frame: frameAt([sp[0], sp[1], sp[2]], dir, FWD_Z),
      // How far out is the yard's number, not a constant: a caged-dish yard
      // keeps its instruments close, a whip-forest holds them well clear. The
      // clamp is the envelope guard the paragraph above earned — the declared
      // band tops out at 0.6 × length, which is the 84 m mast on a 279 m hull
      // this code was already fixed once for.
      length: L * clamp(sampleRange(sens.standoff, rng), 0.09, 0.24),
      halfWidth: Math.max(HATCH_WIDTH_KM * 0.3, p.beamKm * 0.014),
      halfHeight: Math.max(HATCH_WIDTH_KM * 0.3, p.beamKm * 0.014),
      bias: 'boom',
      capStart: 'flat',
      capEnd: 'taper',
      materialSlot: MAT_STRUCT,
      detailDensity: 0.5,
      loadShare: 0.02,
      stations: 3,
      anchor: { kind: 'volume', volumeId: host.id, t },
    }));
  }
}

// ===========================================================================
// STAGE 7 — silhouette accents
//
// "The one or two shapes that make it recognisable" (BRIEF §4.7). One or two,
// and never more: three accents is a hull with no accent. Each is a large,
// simple shape that changes the black outline, chosen so it also says something
// about the family or the role.
// ===========================================================================

type Accent = 'dorsal-fin' | 'tail-flare' | 'bow-ram' | 'canards' | 'collar-ring' | 'ventral-strake' | 'shoulder-pods';

/**
 * How elongated the finished envelope has to be, by archetype.
 *
 * BRIEF §4 stage 2 asks for "the load path from engines to nose", and the
 * side-silhouette shot's own FAILS IF is "you cannot tell which end is the
 * front". Neither survives a cube: measured over sixty seeds the finished
 * envelope was 1.83 : 1 on the long axis, with the hero freighter at 1.23 : 1
 * — 62 m long and 50 m tall. The primary volumes were not the problem; the
 * transverse stack of racks, drums, booms and radiators bolted to them was.
 *
 * So the ratio is a REQUIREMENT with a named remedy, not a hope. Two
 * archetypes are exempt because being tall is the whole of what they are: a
 * tower is a tower and a ring is a ring, and forcing 2.5 : 1 on those would
 * undo the one part of the archetype table that is not cosmetic.
 */
const AXIS_TARGET: Readonly<Record<HullArchetype, number>> = {
  monolithic: 2.6, stacked: 2.6, 'spine-and-pod': 2.8, fork: 2.3,
  slab: 2.2, asymmetric: 2.2, cluster: 2.3, tower: 0.7, ring: 1.1,
};

/** Volumes that are hull rather than hardware hung off it. */
function isStructural(kind: VolumeKind): boolean {
  return kind === 'hull' || kind === 'forebody' || kind === 'midbody' || kind === 'afterbody'
    || kind === 'keel' || kind === 'cargo-bay' || kind === 'bridge' || kind === 'habitat';
}

/** The ship's forward plane and the section it presents there. */
function bowPlane(ctx: Ctx): { z: number; halfW: number; halfH: number; cx: number; cy: number } | null {
  let z = Infinity;
  for (let i = 0; i < ctx.volumes.length; i++) {
    if (!isStructural(ctx.volumes[i].kind)) continue;
    const b = boundsAt(ctx, i);
    if (b.min[2] < z) z = b.min[2];
  }
  if (!Number.isFinite(z)) return null;
  // The section at that plane, from every structural volume that reaches it.
  const slab = z + Math.max(1e-6, ctx.prop.lengthKm * 0.02);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < ctx.volumes.length; i++) {
    if (!isStructural(ctx.volumes[i].kind)) continue;
    const b = boundsAt(ctx, i);
    if (b.min[2] > slab) continue;
    x0 = Math.min(x0, b.min[0]); x1 = Math.max(x1, b.max[0]);
    y0 = Math.min(y0, b.min[1]); y1 = Math.max(y1, b.max[1]);
  }
  if (!Number.isFinite(x0)) return null;
  return { z, halfW: Math.max(1e-6, (x1 - x0) * 0.5), halfH: Math.max(1e-6, (y1 - y0) * 0.5), cx: (x0 + x1) * 0.5, cy: (y0 + y1) * 0.5 };
}

/**
 * Terminate the spine forward. BRIEF §4 stage 7, and not optional.
 *
 * `bow-ram` existed as one of seven weighted accents at weight 1 for most
 * roles, so five hulls in six had no forward termination at all: the load path
 * ran out of ship, the outline stopped at the last cargo frame, and the
 * silhouette critic could only find the stern by looking for the engines. A
 * bow is not an accent — it is the other end of the structure the engines push
 * on — so every hull now gets one, and the accent draw is what decorates it.
 *
 * The shape says what the ship is for, which is the point: a hull whose
 * `noseEnd` is small resolves to a point over a long run (a courier), one
 * whose `noseEnd` is large steps down to a flat bow face over a short one (a
 * freighter, with a door in it). Either reads as the front; a cylinder does
 * not. Returns the volume so `enforceLongitudinalAxis` can grow it.
 */
function buildBow(ctx: Ctx, rng: Rng): PrimaryVolume | null {
  const bp = bowPlane(ctx);
  if (!bp) return null;
  const p = ctx.prop;
  const L = p.lengthKm;

  // A blunt bow is short and a fine bow is long: the run is what turns a
  // tip-radius fraction into an angle, and an 8% run on a 0.1 nose is a spike
  // while a 24% run on a 0.6 nose is a shoulder. Both are bows.
  const fine = clamp01(1 - p.noseEnd);
  const runFrac = lerp(0.085, 0.2, fine) * rng.range(0.85, 1.2);
  const len = L * runFrac;
  const tip = clamp(p.noseEnd, 0.16, 0.72);

  // Held to the section it grows out of, minus the diameter step that makes
  // the join read as a join rather than as more of the same tube.
  const step = rng.range(0.82, 0.94);
  const halfW = bp.halfW * step;
  const halfH = bp.halfH * step;

  const v = sweptVolume(ctx, rng, {
    kind: 'forebody',
    frame: axialFrame(bp.cx, bp.cy, bp.z - len),
    length: len,
    halfWidth: halfW,
    halfHeight: halfH,
    bias: 'hull',
    capStart: noseCapFor(ctx, p.noseEnd),
    capEnd: 'flat',
    materialSlot: MAT_HULL,
    detailDensity: rng.range(0.3, 0.6),
    loadShare: 0.35,
    // Runs tip-first: t=0 is the point of the bow, t=1 is the shoulder where
    // it meets the hull, so the taper is a bow taper and not a tail one.
    profile: (t) => lerp(tip, 1, Math.pow(smoothstep(t), p.noseSharp)),
    profileY: (t) => lerp(tip * rng.range(0.9, 1.25), 1, Math.pow(smoothstep(t), p.noseSharp * 0.85)),
    stations: clamp(Math.round(stationCount(len)), 4, 10),
    frameEvery: 2,
    anchor: { kind: 'spine', nodeId: ctx.spine.chains[0].nodes[0].id },
  });
  ctx.volumes.push(v);
  return v;
}

/**
 * Make the envelope longer than it is wide, by lengthening the bow.
 *
 * The remedy is deliberately additive. Shrinking the transverse masses instead
 * would undo `ensurePayloadMass` (which exists because the payload was losing
 * the argument about which mass is largest) and would close the daylight
 * `ensureSpanningStructure` measures — two fixes from the previous round. A
 * hull that carries a lot across its beam is simply a hull that needs more
 * keel, which is what a naval architect would say and what this does.
 *
 * Bounded at 40% of the finished length: past that the bow stops being a bow
 * and becomes a lance, and the ratio is better left unmet and reported.
 */
function enforceLongitudinalAxis(ctx: Ctx, bow: PrimaryVolume | null): void {
  const target = AXIS_TARGET[ctx.archetype];
  if (!bow || target <= 0) return;

  const measure = (): { L: number; across: number } => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < ctx.volumes.length; i++) {
      const b = boundsAt(ctx, i);
      if (b.min[0] < x0) x0 = b.min[0];
      if (b.max[0] > x1) x1 = b.max[0];
      if (b.min[1] < y0) y0 = b.min[1];
      if (b.max[1] > y1) y1 = b.max[1];
      if (b.min[2] < z0) z0 = b.min[2];
      if (b.max[2] > z1) z1 = b.max[2];
    }
    return { L: z1 - z0, across: Math.max(x1 - x0, y1 - y0) };
  };

  const m = measure();
  if (m.across <= 0 || m.L / m.across >= target) return;

  // How much more keel the ratio asks for. Extending forward by `d` lengthens
  // the ship by `d` and leaves the beam alone, so (L+d)/across = target.
  const want = target * m.across - m.L;
  const bowLen = bow.path.kind === 'linear' ? bow.path.length : 0;
  if (bowLen <= 0) return;
  // Two bounds, and the ship keeps the tighter. A bow past 40% of the finished
  // length stops being a bow; and a hull that grows more than a third beyond
  // what its archetype built is no longer the size class it was asked for,
  // which would make every fleet comparison shot a comparison of the wrong
  // ships. Where both bind, the ratio is left unmet and logged.
  const maxLen = Math.min(bowLen + want, (m.L + want) * 0.4, bowLen + m.L * 0.33);
  if (maxLen <= bowLen * 1.02) return;

  const k = maxLen / Math.max(1e-9, bowLen);
  const i = ctx.volumes.indexOf(bow);
  if (i < 0) return;
  const f = bow.frame;
  ctx.volumes[i] = {
    ...bow,
    // Grows forward from the shoulder, which stays welded where it was.
    frame: { ...f, origin: [f.origin[0], f.origin[1], f.origin[2] - (maxLen - bowLen)] },
    path: { kind: 'linear', length: maxLen },
  };
  ctx.bounds[i] = undefined;

  reject(ctx, {
    stage: 'accents',
    rule: 'axis-too-short',
    what: `envelope was ${fmt(m.L / m.across, 2)}:1 on the long axis; the bow was lengthened to ${fmtKm(maxLen)}`,
    at: [f.origin[0], f.origin[1], f.origin[2]],
    measured: m.L / m.across,
    required: target,
    attempt: 0,
  });
}

function buildAccents(ctx: Ctx): void {
  const rng = new Rng(shipSubSeed(ctx.seed, 'accents'));
  const p = ctx.prop;
  const L = p.lengthKm;

  const bow = ctx.bow;
  const host = hostsFor(ctx, ['hull', 'midbody', 'forebody', 'keel'])[0];
  if (!host) { enforceLongitudinalAxis(ctx, bow); return; }

  // Each accent IS a volume kind, so each is subject to the yard's massing
  // doctrine. A weight of zero is the only refusal that survives `pickWeighted`
  // and the archetype floor, which is why `yardBuilds` is multiplied in rather
  // than consulted afterwards: an accent a culture cannot build must be
  // impossible on every seed, not merely rare. This is stage 7's half of the
  // same gate `standoff` applies at stage 3 — a fin, a hoop and a shoulder pod
  // are external masses however recognisable they are.
  const may = (k: VolumeKind): number => (yardBuilds(ctx, k) ? 1 : 0);
  const options: (readonly [Accent, number])[] = [
    ['dorsal-fin', ctx.dna.dorsalChance * 6 * may('fin')],
    ['tail-flare', 4 * may('shroud')],
    ['bow-ram', (ctx.role === 'miner' || ctx.role === 'tug' || ctx.role === 'gunship' ? 5 : 1) * may('machinery')],
    ['canards', (ctx.tech.atmosphereCapable ? 4 : 1) * may('fin')],
    ['collar-ring', (ctx.archetype === 'ring' ? 0 : 3) * may('ring')],
    // A hull that sets down on a surface does not carry a deep ventral keel
    // strake: it is the one accent the undercarriage has to reach past, and it
    // was taking the gear off six couriers in eight.
    ['ventral-strake', (ROLE_TOPOLOGY[ctx.role].landsOnSurfaces ? 0 : ctx.dna.keelChance * 5) * may('keel')],
    ['shoulder-pods', 3 * may('pod')],
  ];
  const count = rng.chance(0.35) ? 2 : 1;
  const chosen: Accent[] = [];
  for (let i = 0; i < count; i++) {
    const pool = options.filter((o) => !chosen.includes(o[0]) && o[1] > 0);
    if (pool.length === 0) break;
    chosen.push(pickWeighted(rng, pool));
  }

  for (const a of chosen) {
    switch (a) {
      case 'dorsal-fin': {
        const t = rng.range(0.45, 0.75);
        const sp = volumeSurfacePoint(host, t, DORSAL, [0, 0, 0]);
        // An accent is "the one or two shapes that make it recognisable"
        // (BRIEF §4.7), not the largest thing on the ship. Unbounded, this fin
        // came out at twice the side-projected area of the cargo section on the
        // hero freighter — the trapezoidal sail that made a hauler read as a
        // conning tower on a submarine. Half the biggest primary mass is still
        // a very large fin and it can no longer win the argument about what
        // this ship is for.
        let finRise = p.heightKm * rng.range(0.5, 1.1);
        let finChord = L * rng.range(0.09, 0.2);
        const cap = largestPrimaryArea(ctx) * 0.5;
        const finArea = finRise * finChord * 2;
        if (cap > 0 && finArea > cap) {
          const k = Math.sqrt(cap / finArea);
          finRise *= k;
          finChord *= k;
        }
        ctx.volumes.push(sweptVolume(ctx, rng, {
          kind: 'fin',
          frame: frameAt([sp[0], sp[1], sp[2]], UP_Y, [0, 0, -1]),
          length: finRise,
          halfWidth: Math.max(HATCH_WIDTH_KM * 0.6, p.beamKm * 0.035),
          halfHeight: finChord,
          bias: 'panel',
          capStart: 'flat',
          capEnd: 'taper',
          materialSlot: MAT_STRUCT,
          detailDensity: 0.3,
          loadShare: 0.05,
          stations: 4,
          profile: (u) => lerp(1, 0.45, u),
          profileY: (u) => lerp(1, rng.range(0.35, 0.7), u),
          anchor: { kind: 'volume', volumeId: host.id, t },
        }));
        break;
      }
      case 'tail-flare': {
        // A flared skirt round the drive. Reads as thrust structure and gives
        // the aft end a silhouette other than "cut off".
        const b = boundsOf(ctx, host);
        const r = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) * 0.5;
        ctx.volumes.push(sweptVolume(ctx, rng, {
          kind: 'shroud',
          frame: axialFrame(0, 0, b.max[2] - L * 0.06),
          length: L * rng.range(0.07, 0.14),
          halfWidth: r * rng.range(1.05, 1.5),
          halfHeight: r * rng.range(1.05, 1.5),
          bias: 'machinery',
          capStart: 'open',
          capEnd: 'open',
          materialSlot: MAT_STRUCT,
          detailDensity: 0.8,
          loadShare: 0.3,
          stations: 3,
          profile: (u) => lerp(0.72, 1, u),
          interiorVisible: true,
        }));
        break;
      }
      case 'bow-ram': {
        const b = boundsOf(ctx, host);
        ctx.volumes.push(sweptVolume(ctx, rng, {
          kind: 'machinery',
          frame: axialFrame(0, lerp(-p.heightKm * 0.2, p.heightKm * 0.1, rng.next()), b.min[2] - L * rng.range(0.04, 0.11)),
          length: L * rng.range(0.08, 0.16),
          halfWidth: p.beamKm * rng.range(0.12, 0.26),
          halfHeight: p.heightKm * rng.range(0.12, 0.3),
          bias: 'machinery',
          capStart: 'taper',
          capEnd: 'flat',
          materialSlot: MAT_STRUCT,
          detailDensity: 0.95,
          loadShare: 0.2,
          stations: 3,
          profile: (u) => lerp(0.4, 1, u),
        }));
        break;
      }
      case 'canards': {
        const t = rng.range(0.12, 0.3);
        const span = p.beamKm * rng.range(0.25, 0.5);
        for (const side of [1, -1]) {
          const theta = side > 0 ? 0.25 : Math.PI - 0.25;
          const sp = volumeSurfacePoint(host, t, theta, [0, 0, 0]);
          ctx.volumes.push(sweptVolume(ctx, rng, {
            kind: 'fin',
            frame: frameAt([sp[0], sp[1], sp[2]], [side, rng.range(-0.2, 0.35), 0], UP_Y),
            length: span,
            halfWidth: Math.max(HATCH_WIDTH_KM * 0.4, p.heightKm * 0.025),
            halfHeight: L * rng.range(0.05, 0.1),
            bias: 'panel',
            capStart: 'flat',
            capEnd: 'taper',
            materialSlot: MAT_STRUCT,
            detailDensity: 0.2,
            loadShare: 0.03,
            stations: 3,
            profile: (u) => lerp(1, 0.5, u),
            anchor: { kind: 'volume', volumeId: host.id, t },
          }));
        }
        break;
      }
      case 'collar-ring': {
        // A hoop round the hull. Cheap, unmistakable, and it gives the eye a
        // scale reference at a distance where panels have stopped resolving.
        const t = rng.range(0.3, 0.7);
        const b = boundsOf(ctx, host);
        const r = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) * 0.5 * rng.range(1.1, 1.5);
        const z = lerp(b.min[2], b.max[2], t);
        ctx.volumes.push(sweptVolume(ctx, rng, {
          kind: 'ring',
          frame: { origin: [0, -r, z], forward: [1, 0, 0], up: [0, 0, 1] },
          length: TAU * r,
          halfWidth: r * rng.range(0.06, 0.12),
          halfHeight: r * rng.range(0.06, 0.12),
          bias: 'boom',
          capStart: 'open',
          capEnd: 'open',
          materialSlot: MAT_STRUCT,
          detailDensity: 0.5,
          loadShare: 0.05,
          arc: { radius: r, sweep: TAU },
          stations: 12,
          frameEvery: 1,
        }));
        break;
      }
      case 'ventral-strake': {
        const b = boundsOf(ctx, host);
        ctx.volumes.push(sweptVolume(ctx, rng, {
          kind: 'keel',
          frame: axialFrame(0, b.min[1] * rng.range(0.92, 1.0), lerp(b.min[2], b.max[2], 0.18)),
          length: (b.max[2] - b.min[2]) * rng.range(0.5, 0.75),
          halfWidth: p.beamKm * rng.range(0.05, 0.1),
          halfHeight: p.heightKm * rng.range(0.06, 0.16),
          bias: 'boom',
          capStart: 'taper',
          capEnd: 'flat',
          materialSlot: MAT_STRUCT,
          detailDensity: 0.6,
          loadShare: 0.25,
          stations: 4,
        }));
        break;
      }
      default: {
        // Shoulder pods: a mirrored pair high on the flanks. Breaks a round
        // section into something with corners without touching the section.
        const t = rng.range(0.25, 0.55);
        const r = Math.max(p.beamKm, p.heightKm) * rng.range(0.09, 0.16);
        const shape = makeSection(rng, ctx.dna, 'pod', true);
        const scalars = makeScalars(rng, ctx.dna, shape, 'pod');
        let firstId: string | null = null;
        for (const side of [1, -1]) {
          const theta = side > 0 ? 0.7 : Math.PI - 0.7;
          const sp = volumeSurfacePoint(host, t, theta, [0, 0, 0]);
          const sn = surfaceNormal(host, t, theta, [0, 0, 0]);
          const v = sweptVolume(ctx, rng, {
            kind: 'pod',
            frame: axialFrame(sp[0] + sn[0] * r * 0.55, sp[1] + sn[1] * r * 0.55, sp[2] - L * 0.08),
            length: L * rng.range(0.16, 0.34),
            halfWidth: r,
            halfHeight: r * rng.range(0.7, 1.2),
            bias: 'pod',
            capStart: 'taper',
            capEnd: 'flat',
            materialSlot: MAT_HULL,
            detailDensity: 0.45,
            loadShare: 0.12,
            shape,
            scalars,
            mirrorOf: side < 0 ? firstId : null,
            anchor: { kind: 'volume', volumeId: host.id, t },
          });
          if (firstId === null) firstId = v.id;
          ctx.volumes.push(v);
        }
        break;
      }
    }
  }

  // Last, once every mass that can widen the envelope exists.
  enforceLongitudinalAxis(ctx, bow);
}

// ===========================================================================
// STAGE 8 — greebles
//
// "Last, and never to rescue a weak form" (BRIEF §4.8). Nothing here changes a
// silhouette. Connections are generated from the FUNCTION GRAPH — reactor to
// engines, tank to engines, hab to hab, pod to keel — never for decoration,
// because a pipe that goes from nowhere to nowhere is the thing that makes a
// procedural hull read as procedural.
// ===========================================================================

/** Side-projected area of the biggest mass on the hull, km². Bounds the accents. */
function largestPrimaryArea(ctx: Ctx): number {
  let best = 0;
  for (const v of ctx.volumes) {
    if (v.kind === 'fin' || v.kind === 'wing' || v.kind === 'radiator' || v.kind === 'pylon'
      || v.kind === 'boom' || v.kind === 'nacelle' || v.kind === 'shroud') continue;
    const b = boundsOf(ctx, v);
    const a = (b.max[2] - b.min[2]) * (b.max[1] - b.min[1]);
    if (a > best) best = a;
  }
  return best;
}

function volumeCentre(ctx: Ctx, v: PrimaryVolume): Vec3 {
  const b = boundsOf(ctx, v);
  return [(b.min[0] + b.max[0]) * 0.5, (b.min[1] + b.max[1]) * 0.5, (b.min[2] + b.max[2]) * 0.5];
}

function addConnection(
  ctx: Ctx, rng: Rng, kind: ConnectionKind, from: string, to: string, path: readonly Vec3[], radius: number,
): void {
  ctx.connections.push({
    id: nextId(ctx, 'cn'),
    kind,
    path,
    radius,
    // Only a cable sags. A pipe with sag reads as rubber; a cable without it
    // reads as a rod, and the slack is the whole reason to draw one.
    sag: kind === 'cable' ? rng.range(0.04, 0.16) : 0,
    fittingDensity: kind === 'pipe' ? rng.range(60, 220) : kind === 'conduit' ? rng.range(30, 120) : rng.range(8, 40),
    fromId: from,
    toId: to,
    materialKey: matKey(ctx, MAT_DETAIL),
    seed: sub(shipSubSeed(ctx.seed, 'greebles'), `${from}>${to}`),
  });
}

/** A three-point run with one dog-leg. Straight lines between two points read
 *  as CAD; one bend at a plausible place reads as plumbing. */
function runPath(a: Vec3, b: Vec3, lateral: number, rng: Rng): readonly Vec3[] {
  const mid: Vec3 = [
    lerp(a[0], b[0], 0.5) + lateral * rng.range(-1, 1),
    lerp(a[1], b[1], 0.5) + lateral * rng.range(-0.4, 1),
    lerp(a[2], b[2], 0.5),
  ];
  return [a, mid, b];
}

function buildGreebles(ctx: Ctx): void {
  const rng = new Rng(shipSubSeed(ctx.seed, 'greebles'));
  const B = ctx.prop.beamKm;
  const pipeR = Math.max(HATCH_WIDTH_KM * 0.18, B * 0.008);

  // Power: reactor (or the engineering block) to every engine.
  const reactor = ctx.modules.find((m) => m.kind === 'reactor-can');
  const engBlock = ctx.volumes.find((v) => v.kind === 'afterbody' || v.kind === 'machinery');
  const powerSource: Vec3 = reactor ? reactor.frame.origin : engBlock ? volumeCentre(ctx, engBlock) : [0, 0, 0];
  const powerId = reactor ? reactor.id : engBlock ? engBlock.id : 'hull';
  for (const e of ctx.engines) {
    addConnection(ctx, rng, 'conduit', powerId, e.id, runPath(powerSource, e.frame.origin, B * 0.05, rng), pipeR * 1.6);
  }

  // Propellant: every tank to the drive.
  for (const v of ctx.volumes) {
    if (fuelFraction(v) <= 0) continue;
    const target = ctx.engines.length > 0 ? ctx.engines[0] : null;
    if (!target) break;
    addConnection(ctx, rng, 'pipe', v.id, target.id, runPath(volumeCentre(ctx, v), target.frame.origin, B * 0.04, rng), pipeR);
  }

  // Structure: every pod hung on the keel gets the struts that hold it there.
  const keel = ctx.volumes.find((v) => v.kind === 'keel');
  if (keel) {
    for (const v of ctx.volumes) {
      if (v.anchor?.kind !== 'volume' || v.anchor.volumeId !== keel.id) continue;
      const c = volumeCentre(ctx, v);
      const kc = volumeSurfacePoint(keel, clamp(v.anchor.t, 0.02, 0.98), Math.atan2(c[1], c[0]), [0, 0, 0]);
      addConnection(ctx, rng, 'strut', keel.id, v.id, [[kc[0], kc[1], kc[2]], c], pipeR * 2.4);
    }
  }

  // Crew route: a ladder run linking the things a suited human has to reach.
  const crew = ctx.modules.filter((m) => m.crewAccessible);
  for (let i = 1; i < Math.min(crew.length, 7); i++) {
    addConnection(ctx, rng, 'ladder-run', crew[i - 1].id, crew[i].id,
      runPath(crew[i - 1].frame.origin, crew[i].frame.origin, B * 0.02, rng), pipeR * 0.5);
  }

  // Umbilicals hanging off the docking collars. Detachable service lines are
  // the detail that says the ship spends its life attached to something.
  for (const d of ctx.docks) {
    if (!rng.chance(0.5)) continue;
    const end: Vec3 = [d.frame.origin[0] + d.frame.forward[0] * B * 0.1, d.frame.origin[1] - B * 0.06, d.frame.origin[2] + B * 0.05];
    addConnection(ctx, rng, 'cable', d.id, `${d.id}:free`, [d.frame.origin, end], pipeR * 0.7);
  }

  // Instance batches. `Ship.ts` proved that greebles must be ASSEMBLIES in a
  // unit footprint, not primitives — a bare box and a bare cylinder gave the
  // whole hull two silhouettes. The generator names the families and the count;
  // the geometry module owns what each one looks like.
  let surfaceKm2 = 0;
  for (const v of ctx.volumes) {
    const b = boundsOf(ctx, v);
    const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
    surfaceKm2 += 2 * (sx * sy + sy * sz + sz * sx) * v.detailDensity;
  }
  // One greeble per this much plating. Scaled by hatch area so a 4 km capital
  // gets proportionally as much detail as a 30 m courier and not 10,000× more.
  const per = HATCH_WIDTH_KM * HATCH_WIDTH_KM * 320;
  const total = clamp(Math.round(surfaceKm2 / per), 12, 900);
  const families: readonly (readonly [string, number, number])[] = [
    ['hatch', 0.26, 1],
    ['bracket', 0.2, 1],
    ['ribbed', 0.16, 1],
    ['stack', 0.12, 0],
    ['pipe', 0.14, 1],
    ['vent', 0.12, 0],
  ];
  for (const [key, share, drop] of families) {
    ctx.instancing.push({
      key: `${ctx.dna.id}/${key}`,
      count: Math.max(1, Math.round(total * share)),
      materialKey: matKey(ctx, key === 'pipe' || key === 'stack' ? MAT_STRUCT : MAT_DETAIL),
      dropAtLevel: drop,
    });
  }
}

// ===========================================================================
// Centre-of-mass rebase
//
// `types.ts` is explicit: the origin IS the dry centre of mass, because
// `FlightModel` rotates the hull about its object origin and an origin that is
// not the CoM makes the ship pivot about a point in empty space. Every position
// in the blueprint is translated once, here, after all geometry exists and
// before history is generated — so damage lands in final coordinates and never
// needs moving twice.
// ===========================================================================

function shift(v: Vec3, d: Vec3): Vec3 {
  return [v[0] + d[0], v[1] + d[1], v[2] + d[2]];
}

function shiftFrame(f: Frame, d: Vec3): Frame {
  return { origin: shift(f.origin, d), forward: f.forward, up: f.up };
}

/** Move every cached bounding box. Exact under a pure translation. */
function translateBounds(ctx: Ctx, d: Vec3): void {
  for (let i = 0; i < ctx.bounds.length; i++) {
    const b = ctx.bounds[i];
    if (b !== undefined) ctx.bounds[i] = { min: shift(b.min, d), max: shift(b.max, d) };
  }
  for (let i = 0; i < ctx.moduleBounds.length; i++) {
    const b = ctx.moduleBounds[i];
    if (b !== undefined) ctx.moduleBounds[i] = { min: shift(b.min, d), max: shift(b.max, d) };
  }
}

/**
 * How many full mass integrations the last `generateShip` performed.
 *
 * `shipMassProperties` is 4.7 ms on a medium hull against a 25 ms budget for
 * the whole ship, so the count is the single most important performance number
 * this generator has — and it was being reported as a hard-coded "3" in the
 * self-test while the pipeline actually ran four. A number a report asserts is
 * not a number anyone is measuring, so this one is counted.
 */
let massIntegrations = 0;

/** Integrations performed by the most recent `generateShip` call. */
export function lastMassIntegrationCount(): number {
  return massIntegrations;
}

/** `shipMassProperties` over the context, counted. The only way this file calls it. */
function massPropertiesOf(ctx: Ctx): ReturnType<typeof shipMassProperties> {
  massIntegrations++;
  return shipMassProperties(physicsView(ctx));
}

/** The `ShipPhysicsInput` view of the context. `physics.ts` reads nothing else. */
function physicsView(ctx: Ctx): Parameters<typeof shipMassProperties>[0] {
  return {
    role: ctx.role,
    technologyProfile: ctx.tech,
    primaryVolumes: ctx.volumes,
    modules: ctx.modules,
    engines: ctx.engines,
    thrusters: ctx.thrusters,
    hardpoints: ctx.hardpoints,
    dockingPoints: ctx.docks,
    landingSystem: ctx.landing,
  };
}


/**
 * `MassProperties` for geometry that has only been TRANSLATED, without a second
 * integration.
 *
 * A full `shipMassProperties` is the most expensive call in this pipeline —
 * 4.7 ms on a medium hull, against a 25 ms budget for the whole ship — and the
 * pipeline was paying for one it did not need. Under a pure translation by `d`:
 *
 *   - every mass, volume and area is unchanged;
 *   - the centre of mass moves by `d`, exactly;
 *   - the moments and products are taken ABOUT the dry centre of mass
 *     (`MassProperties` says so on the field), and a translation moves the
 *     reference point with the body, so the parallel-axis term is zero and the
 *     whole tensor is invariant.
 *
 * `MassItem.centre` IS a position, so the item list is translated with
 * everything else — `retuneRcs` reads the undercarriage's centroid off it to
 * correct the balance point, and a stale centroid there put the origin
 * millimetres out on the largest hulls. This is the exact answer, not an
 * approximation of one, and it is only ever used where the geometry between
 * the two points genuinely was translated and nothing else.
 */
function translateMass(
  m: ReturnType<typeof shipMassProperties>, d: Vec3,
): ReturnType<typeof shipMassProperties> {
  return {
    ...m,
    centreOfMass: [m.centreOfMass[0] + d[0], m.centreOfMass[1] + d[1], m.centreOfMass[2] + d[2]],
    loadedCentreOfMass: [
      m.loadedCentreOfMass[0] + d[0], m.loadedCentreOfMass[1] + d[1], m.loadedCentreOfMass[2] + d[2],
    ],
    items: m.items.map((it) => ({
      ...it,
      centre: [it.centre[0] + d[0], it.centre[1] + d[1], it.centre[2] + d[2]] as Vec3,
    })),
  };
}

/**
 * Balance the hull: origin at the dry centre of mass, thrust line through it.
 *
 * The two are coupled. Moving the origin to the centre of mass moves the
 * engines with everything else; moving the engines to put their line of action
 * through the origin moves the centre of mass by their share of the total mass.
 * So they are alternated, and each pass shrinks the residual by that mass ratio
 * — a few percent on most hulls. Iterating to convergence rather than a fixed
 * count matters because a full mass integration is the most expensive thing
 * this generator does, and the common case converges on the second pass.
 */
/** What the load lives in: cargo holds and propellant tankage. */
function carriesLoad(kind: VolumeKind): boolean {
  return kind === 'cargo-bay' || kind === 'cargo-rack' || kind === 'tank';
}
function moduleCarriesLoad(kind: ModuleKind): boolean {
  return kind === 'cargo-container' || kind === 'cargo-pod' || kind === 'ore-bin' || kind === 'fuel-drum';
}

/**
 * Trim the load until the LADEN centre of mass sits on the thrust line.
 *
 * This is the fix for the finding that a laden miner tumbles at 2.85 rad/s²
 * one second into a burn. The dry hull was balanced and the drive was aimed at
 * the dry balance point, and neither operation had ever looked at where the
 * cargo was: on an asymmetric hull the ore bins sit on one flank, so filling
 * them walks the balance point ten metres sideways and the ship can no longer
 * hold a heading under power. A cargo ship that only flies empty is the exact
 * inverse of what a cargo ship is for.
 *
 * The mechanism is the one a chief officer would use: move the load, not the
 * engines. Moving the holds and tanks by `t` moves the dry balance point by
 * α·t and the laden one by β·t, where α and β are those masses' shares of the
 * dry and loaded totals — both exactly known from the integration that has
 * already run. Rebasing the origin by −α·t afterwards restores the dry balance
 * point to zero and leaves the laden one at c + (β − α)·t, so the trim that
 * nulls it is t = −c / (β − α). No second integration, and no guessing.
 *
 * Bounded by what the structure allows: the group is walked outward along the
 * trim direction with the same clearance sweep everything else uses, so the
 * load never trims itself into the hull. Where the bound binds, the residual
 * is real and `auditThrustAxis` records it as `load-out-of-trim` rather than
 * publishing a hull that claims a balance it does not have.
 */
function trimLoad(ctx: Ctx, m: ReturnType<typeof shipMassProperties>): { dx: number; dy: number; alpha: number } {
  const cx = m.loadedCentreOfMass[0];
  const cy = m.loadedCentreOfMass[1];
  const off = Math.hypot(cx, cy);
  const tol = Math.max(1e-6, ctx.prop.lengthKm * 0.002);
  if (off <= tol) return { dx: 0, dy: 0, alpha: 0 };

  const groupVols = new Set<string>();
  for (const v of ctx.volumes) if (carriesLoad(v.kind)) groupVols.add(v.id);
  const groupMods = new Set<string>();
  for (const mo of ctx.modules) if (mo.present && mo.volumeId === null && moduleCarriesLoad(mo.kind)) groupMods.add(mo.id);
  if (groupVols.size === 0 && groupMods.size === 0) return { dx: 0, dy: 0, alpha: 0 };

  let dryGroup = 0;
  for (const it of m.items) {
    if (it.source === 'volume' && groupVols.has(it.id)) dryGroup += it.massKg;
    if (it.source === 'module' && groupMods.has(it.id)) dryGroup += it.massKg;
  }
  const alpha = dryGroup / Math.max(1, m.dryMassKg);
  const beta = (dryGroup + m.fuelMassKg + m.cargoMassKg) / Math.max(1, m.loadedMassKg);
  const lever = beta - alpha;
  // A hull whose load is spread exactly like its structure cannot be trimmed by
  // moving the load: the two centres travel together. Nothing to do but say so.
  if (lever <= 0.02) return { dx: 0, dy: 0, alpha: 0 };

  // Bounded before it starts: a drum that trims itself half a hull-width into
  // space has stopped being ballast and started being a silhouette problem.
  const reach = Math.max(ctx.prop.beamKm, ctx.prop.heightKm) * 0.4;
  const want = Math.min(off / lever, reach);
  const ux = -cx / off;
  const uy = -cy / off;
  const dir: Vec3 = [ux, uy, 0];

  // PER MEMBER, not as a rigid group.
  //
  // Trimming the whole load as one block is limited by whichever hold has the
  // least room, and on the hulls that need it most that hold is the one
  // already pressed against the hull — the heavy side. The light side is where
  // the space is, which is exactly why the ship is out of trim. So each hold
  // and drum moves as far along the trim direction as its own clearance sweep
  // allows, and the balance point follows by the mass-weighted mean of what
  // actually moved. This is a ballast transfer, and a ballast transfer is
  // per-tank.
  /**
   * How far a box may slide along `u` before it enters an exhaust corridor.
   *
   * `clearanceAlong` only sees the volumes and modules; a plume is neither, so
   * a drum trimmed toward the light side could slide straight into the fire of
   * an outboard bell — which is exactly what happened on a cluster tanker, and
   * it cost two of its four engines their cone. The corridor is the bell's
   * mouth swept aft over the plume, and the trim stops at its edge.
   */
  const exhaustLimit = (b: Aabb): number => {
    let cap = Infinity;
    for (const e of ctx.engines) {
      const n = e.nozzle;
      const r = n.exitRadius * 2.2 + (n.count > 1 ? n.clusterRadius : 0);
      const o = e.frame.origin;
      const z0 = o[2] - n.length;
      const z1 = o[2] + Math.max(ctx.plumeLengthKm, n.length * 3);
      if (b.max[2] < z0 || b.min[2] > z1) continue;
      // The box is inside the corridor only once BOTH lateral intervals
      // overlap, so the travel it has is the later of the two crossings.
      let along = 0;
      for (let a = 0; a < 2; a++) {
        const uu = a === 0 ? ux : uy;
        const lo = o[a] - r;
        const hi = o[a] + r;
        if (b.max[a] > lo && b.min[a] < hi) continue; // already overlapping
        let d = Infinity;
        if (b.max[a] <= lo && uu > 1e-9) d = (lo - b.max[a]) / uu;
        else if (b.min[a] >= hi && uu < -1e-9) d = (hi - b.min[a]) / uu;
        along = Math.max(along, d);
      }
      cap = Math.min(cap, Math.max(0, along));
    }
    return cap;
  };

  const movedIdx: number[] = [];
  const movedMod: number[] = [];
  const dist: number[] = [];
  const distMod: number[] = [];
  let weighted = 0;
  let groupKg = 0;
  const massOf = new Map<string, number>();
  for (const it of m.items) if (it.source === 'volume' || it.source === 'module') massOf.set(it.id, it.massKg);

  for (let i = 0; i < ctx.volumes.length; i++) {
    const v = ctx.volumes[i];
    if (!groupVols.has(v.id)) continue;
    const b = boundsAt(ctx, i);
    const c: Vec3 = [(b.min[0] + b.max[0]) * 0.5, (b.min[1] + b.max[1]) * 0.5, (b.min[2] + b.max[2]) * 0.5];
    const half = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) * 0.5;
    const o: Vec3 = [c[0] + ux * half, c[1] + uy * half, c[2]];
    const room = Math.max(0, Math.min(want, clearanceAlong(ctx, o, dir, want, v.id), exhaustLimit(b)));
    movedIdx.push(i);
    dist.push(room);
    const kg = massOf.get(v.id) ?? 0;
    groupKg += kg;
    weighted += kg * room;
  }
  for (let i = 0; i < ctx.modules.length; i++) {
    const mo = ctx.modules[i];
    if (!groupMods.has(mo.id)) continue;
    const half = Math.max(mo.halfExtents[0], mo.halfExtents[1]);
    const o: Vec3 = [mo.frame.origin[0] + ux * half, mo.frame.origin[1] + uy * half, mo.frame.origin[2]];
    const room = Math.max(0, Math.min(want, clearanceAlong(ctx, o, dir, want, null, mo.id), exhaustLimit(moduleBoundsAt(ctx, i))));
    movedMod.push(i);
    distMod.push(room);
    const kg = massOf.get(mo.id) ?? 0;
    groupKg += kg;
    weighted += kg * room;
  }
  if (groupKg <= 0) return { dx: 0, dy: 0, alpha: 0 };
  const mean = weighted / groupKg;
  if (mean <= tol) return { dx: 0, dy: 0, alpha: 0 };

  for (let k = 0; k < movedIdx.length; k++) {
    const i = movedIdx[k];
    const d: Vec3 = [ux * dist[k], uy * dist[k], 0];
    ctx.volumes[i] = { ...ctx.volumes[i], frame: shiftFrame(ctx.volumes[i].frame, d) };
    const b = ctx.bounds[i];
    if (b !== undefined) ctx.bounds[i] = { min: shift(b.min, d), max: shift(b.max, d) };
  }
  for (let k = 0; k < movedMod.length; k++) {
    const i = movedMod[k];
    const d: Vec3 = [ux * distMod[k], uy * distMod[k], 0];
    ctx.modules[i] = { ...ctx.modules[i], frame: shiftFrame(ctx.modules[i].frame, d) };
    const b = ctx.moduleBounds[i];
    if (b !== undefined) ctx.moduleBounds[i] = { min: shift(b.min, d), max: shift(b.max, d) };
  }
  // The equivalent rigid displacement, for the arithmetic the caller runs.
  return { dx: ux * mean, dy: uy * mean, alpha };
}

/**
 * Stand the cluster off aft until every bell has its cone back.
 *
 * `buildDrive` walks the cluster out until each throat is clear — and then
 * `alignThrustAxis` slides the whole cluster sideways onto the thrust line and
 * `trimLoad` slides the holds the other way, so a bell that was clear when it
 * was placed can be looking at a drum by the time the hull is balanced. The
 * §5 exhaust verdict only started reporting it once `remeasureClearances` was
 * moved to the far side of the balance, where it belongs; the fault was
 * already there and was being measured on a hull that no longer existed.
 *
 * The remedy is the one a yard would use: stand the drives further aft on the
 * thrust frame. It is along the thrust axis, so it cannot introduce a couple,
 * and the balance point follows by the drive's own mass fraction — exactly, as
 * with every other correction in `balance`.
 */
function clearExhaust(ctx: Ctx): { dz: number; movedIds: string[] } | null {
  if (ctx.engines.length === 0) return null;
  const half = 0.16;
  const fouled = (): boolean => {
    for (const e of ctx.engines) {
      const o = e.frame.origin;
      const need = Math.max(ctx.plumeLengthKm * 0.35, e.nozzle.exitRadius * 3);
      if (clearanceAlong(ctx, o, FWD_Z, need, null) < need * 0.999) return true;
      if (clearAngleAt(ctx, o, FWD_Z, Math.min(need, e.nozzle.exitRadius * 4), null) < half) return true;
    }
    return false;
  };
  if (!fouled()) return null;

  const step = Math.max(ctx.prop.lengthKm * 0.01, ctx.engines[0].nozzle.exitRadius * 0.5);
  let dz = 0;
  for (let attempt = 0; attempt < 5 && fouled(); attempt++) {
    dz += step;
    const d: Vec3 = [0, 0, step];
    const moved = new Set<string>();
    for (let i = 0; i < ctx.engines.length; i++) {
      ctx.engines[i] = { ...ctx.engines[i], frame: shiftFrame(ctx.engines[i].frame, d) };
      moved.add(ctx.engines[i].socketId);
    }
    for (let i = 0; i < ctx.sockets.length; i++) {
      if (moved.has(ctx.sockets[i].id)) ctx.sockets[i] = { ...ctx.sockets[i], frame: shiftFrame(ctx.sockets[i].frame, d) };
    }
    for (let i = 0; i < ctx.volumes.length; i++) {
      const a = ctx.volumes[i].anchor;
      if (a?.kind !== 'socket' || !moved.has(a.socketId)) continue;
      ctx.volumes[i] = { ...ctx.volumes[i], frame: shiftFrame(ctx.volumes[i].frame, d) };
      const b = ctx.bounds[i];
      if (b !== undefined) ctx.bounds[i] = { min: shift(b.min, d), max: shift(b.max, d) };
    }
  }
  if (dz === 0) return null;
  const ids: string[] = ctx.engines.map((e) => e.id);
  const engineSockets = new Set(ctx.engines.map((e) => e.socketId as string));
  for (const v of ctx.volumes) {
    const a = v.anchor;
    if (a?.kind === 'socket' && engineSockets.has(a.socketId)) ids.push(v.id);
  }
  if (fouled()) {
    reject(ctx, {
      stage: 'propulsion',
      rule: 'exhaust-intersects-hull',
      what: `the cluster still fouls after standing ${fmtKm(dz)} further aft`,
      at: ctx.engines[0].frame.origin,
      measured: 0,
      required: half,
      attempt: 9,
    });
  }
  return { dz, movedIds: ids };
}

function balance(ctx: Ctx): ReturnType<typeof shipMassProperties> {
  // ONE integration, and the count matters: `shipMassProperties` is 4.9 ms on a
  // medium hull and BRIEF §6 gives the whole ship 25 ms. The pipeline used to
  // spend two here and a third in `buildDrive`, with `shipPhysicsProfile`
  // adding two more of its own — four to five full integrations for a hull the
  // generator's own geometry work builds in five.
  //
  //   1. measure, and move the origin to the balance point;
  //   2. bring the drive's line of action through it;
  //   3. the balance point follows the drive by the drive's own share of the
  //      mass — which is an EXACT relation, not an approximation: a centre of
  //      mass is a mass-weighted mean, so moving a known subset by a known
  //      vector moves the mean by (m_moved / m_total) × that vector. The second
  //      integration was measuring a number arithmetic already knew.
  //
  // The audit is not skipped, it is moved: `generateShip` now checks the thrust
  // line against `shipPhysicsProfile`'s own report on the FINISHED hull, which
  // is a stricter test than the one this function used to run on an
  // intermediate state.
  const first = massPropertiesOf(ctx);
  const c0 = first.centreOfMass;
  applyShift(ctx, [-c0[0], -c0[1], -c0[2]]);

  // Trim the load before aiming the drive, because trimming moves the balance
  // point the drive is about to be aimed at. See `trimLoad`: the arithmetic is
  // exact under a translation of a known subset, so this costs no integration.
  const rebased = translateMass(first, [-c0[0], -c0[1], -c0[2]]);
  const trim = trimLoad(ctx, rebased);
  let lx = rebased.loadedCentreOfMass[0];
  let ly = rebased.loadedCentreOfMass[1];
  if (trim.dx !== 0 || trim.dy !== 0) {
    const dryGroupShare = trim.alpha;
    const beta = dryGroupShare + (first.fuelMassKg + first.cargoMassKg) / Math.max(1, first.loadedMassKg);
    lx += (beta - dryGroupShare) * trim.dx;
    ly += (beta - dryGroupShare) * trim.dy;
    // Put the dry balance point back on the origin, which is what `types.ts`
    // says the origin IS.
    applyShift(ctx, [-dryGroupShare * trim.dx, -dryGroupShare * trim.dy, 0]);
  }

  // Align, follow, repeat. Each round leaves a residual of the drive's mass
  // fraction times the last correction — a few percent of a few percent — so
  // three rounds put the thrust line through the balance point to well inside
  // the 1 m origin tolerance, and every round after the first is arithmetic
  // over a list of masses the first integration already returned.
  let fDry = 0;
  let fLoaded = 0;
  let ax = 0;
  let ay = 0;
  let any = false;
  for (let round = 0; round < 3; round++) {
    const mv = alignThrustAxis(ctx);
    if (!mv) break;
    any = true;
    const ids = new Set(mv.movedIds);
    let movedKg = 0;
    for (const it of first.items) if (ids.has(it.id)) movedKg += it.massKg;
    fDry = movedKg / Math.max(1, first.dryMassKg);
    fLoaded = movedKg / Math.max(1, first.loadedMassKg);
    ax += (fLoaded - fDry) * mv.dx;
    ay += (fLoaded - fDry) * mv.dy;
    applyShift(ctx, [-fDry * mv.dx, -fDry * mv.dy, 0]);
  }
  // The drives may still be looking at something the alignment or the trim put
  // in front of them. Standing them off aft is a pure z translation, so it
  // cannot introduce a couple; the balance point follows by the drive's own
  // mass fraction, which the first integration already measured.
  const clear = clearExhaust(ctx);
  if (clear) {
    const ids = new Set(clear.movedIds);
    let movedKg = 0;
    for (const it of first.items) if (ids.has(it.id)) movedKg += it.massKg;
    const fz = movedKg / Math.max(1, first.dryMassKg);
    applyShift(ctx, [0, 0, -fz * clear.dz]);
  }

  // Everything the caller reads off this — `pressurisedVolumeM3` — is invariant
  // under every operation above, and the dry centre of mass is now zero by
  // construction. The laden one carries both corrections: the load trim and
  // the drive's own share of the follow-up shifts.
  return {
    ...rebased,
    centreOfMass: [0, 0, 0],
    loadedCentreOfMass: [lx + ax, ly + ay, rebased.loadedCentreOfMass[2]],
  };
}

function applyShift(ctx: Ctx, d: Vec3): void {
  if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) < 1e-12) return;

  for (let i = 0; i < ctx.volumes.length; i++) {
    ctx.volumes[i] = { ...ctx.volumes[i], frame: shiftFrame(ctx.volumes[i].frame, d) };
  }
  // Translate the cached boxes rather than dropping them. A rebase moves every
  // volume by the same vector, so the cached bounds are still exact once
  // shifted — and re-deriving them would mean 408 surface evaluations per
  // volume, three or four times per ship, for no new information.
  translateBounds(ctx, d);

  ctx.spine = {
    ...ctx.spine,
    chains: ctx.spine.chains.map((c) => ({ ...c, nodes: c.nodes.map((n) => ({ ...n, position: shift(n.position, d) })) })),
  };

  for (let i = 0; i < ctx.sockets.length; i++) ctx.sockets[i] = { ...ctx.sockets[i], frame: shiftFrame(ctx.sockets[i].frame, d) };
  for (let i = 0; i < ctx.modules.length; i++) ctx.modules[i] = { ...ctx.modules[i], frame: shiftFrame(ctx.modules[i].frame, d) };
  for (let i = 0; i < ctx.engines.length; i++) ctx.engines[i] = { ...ctx.engines[i], frame: shiftFrame(ctx.engines[i].frame, d) };
  for (let i = 0; i < ctx.thrusters.length; i++) ctx.thrusters[i] = { ...ctx.thrusters[i], frame: shiftFrame(ctx.thrusters[i].frame, d) };
  for (let i = 0; i < ctx.hardpoints.length; i++) ctx.hardpoints[i] = { ...ctx.hardpoints[i], frame: shiftFrame(ctx.hardpoints[i].frame, d) };
  for (let i = 0; i < ctx.docks.length; i++) ctx.docks[i] = { ...ctx.docks[i], frame: shiftFrame(ctx.docks[i].frame, d) };
  for (let i = 0; i < ctx.connections.length; i++) {
    ctx.connections[i] = { ...ctx.connections[i], path: ctx.connections[i].path.map((p) => shift(p, d)) };
  }
  for (let i = 0; i < ctx.lamps.length; i++) ctx.lamps[i] = { ...ctx.lamps[i], position: shift(ctx.lamps[i].position, d) };
  for (let i = 0; i < ctx.rejections.length; i++) ctx.rejections[i] = { ...ctx.rejections[i], at: shift(ctx.rejections[i].at, d) };

  // History is generated before the rebase (a torn-off module changes the
  // balance point, so it has to exist before the hull is balanced), which means
  // wounds and patches are in pre-rebase coordinates and move with everything
  // else. `Displacement.pivot` is a position and shifts; its axis is not.
  const shiftDisp = (p: Displacement | null): Displacement | null =>
    p === null ? null : { ...p, pivot: shift(p.pivot, d) };
  for (let i = 0; i < ctx.damage.length; i++) {
    ctx.damage[i] = { ...ctx.damage[i], frame: shiftFrame(ctx.damage[i].frame, d), displacement: shiftDisp(ctx.damage[i].displacement) };
  }
  for (let i = 0; i < ctx.repairs.length; i++) {
    ctx.repairs[i] = { ...ctx.repairs[i], frame: shiftFrame(ctx.repairs[i].frame, d), displacement: shiftDisp(ctx.repairs[i].displacement) };
  }
  for (let i = 0; i < ctx.markings.length; i++) {
    ctx.markings[i] = { ...ctx.markings[i], frame: shiftFrame(ctx.markings[i].frame, d) };
  }

  if (ctx.landing) {
    ctx.landing = {
      ...ctx.landing,
      legs: ctx.landing.legs.map((l) => ({ ...l, frame: shiftFrame(l.frame, d), contactPoint: shift(l.contactPoint, d) })),
      footprint: ctx.landing.footprint.map((f): Vec2 => [f[0] + d[0], f[1] + d[2]]),
      // `staticHeight` is a DISTANCE from the origin down to the ground, so a
      // shift of the origin moves it the other way. Getting this sign wrong
      // makes a perfectly good undercarriage report itself as buried.
      staticHeight: ctx.landing.staticHeight - d[1],
      lowestFixedPoint: ctx.landing.lowestFixedPoint + d[1],
    };
  }
}

// ===========================================================================
// History — a service life that moves geometry
//
// BRIEF §7: "History must be visible in the GEOMETRY, not only in the material".
// So the timeline is generated first — commissioning, owners, refits, a bad
// day — and each beat is then expressed as `DamageEvent`s and `RepairEvent`s
// carrying a `GeometryRef`, an incidence direction and an age. Every damage
// kind except `scoring` changes the mesh.
// ===========================================================================

/** Pick a point on a random volume's surface, weighted towards big volumes. */
function randomSurface(ctx: Ctx, rng: Rng, forwardBias: number): { v: PrimaryVolume; t: number; theta: number; p: Vec3; n: Vec3 } | null {
  const pool = ctx.volumes.filter((v) => v.kind !== 'nacelle');
  if (pool.length === 0) return null;
  const weights = pool.map((v) => {
    const b = boundsOf(ctx, v);
    return Math.max(1e-9, (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]) + (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]));
  });
  let total = 0;
  for (const w of weights) total += w;
  let r = rng.next() * total;
  let idx = 0;
  for (; idx < pool.length - 1; idx++) { r -= weights[idx]; if (r <= 0) break; }
  const v = pool[idx];
  // Forward bias: a run advances nose → tail, so low `t` is forward-facing
  // plating, which is where micrometeorites land and nowhere else.
  const t = forwardBias > 0 ? clamp(Math.pow(rng.next(), 1 + forwardBias * 3), 0.02, 0.98) : rng.range(0.02, 0.98);
  const theta = rng.range(0, TAU);
  const p = volumeSurfacePoint(v, t, theta, [0, 0, 0]);
  const n = surfaceNormal(v, t, theta, [0, 0, 0]);
  return { v, t, theta, p: [p[0], p[1], p[2]], n: [n[0], n[1], n[2]] };
}

const YEAR_S = 3600 * 24 * 365.25;

function buildHistory(ctx: Ctx, damageLevel: number): void {
  const rng = new Rng(shipSubSeed(ctx.seed, 'history'));
  const age = ctx.tech.ageYears;
  const care = ctx.tech.maintenance;
  const L = ctx.prop.lengthKm;
  const skin = Math.max(HATCH_WIDTH_KM * 0.02, L * 0.0012);

  const addDamage = (
    kind: DamageKind, cause: DamageCause, sev: number, ageS: number,
    hit: { v: PrimaryVolume; t: number; theta: number; p: Vec3; n: Vec3 },
    radius: number, depth: number, incidence: Vec3, displacement: DamageEvent['displacement'] = null,
  ): DamageEvent => {
    const id = nextId(ctx, 'dmg');
    const arcHalf = clamp(radius / Math.max(1e-6, ctx.prop.beamKm * 0.5), 0.05, Math.PI);
    const tHalf = clamp(radius / Math.max(1e-6, L), 0.005, 0.4);
    const ev: DamageEvent = {
      id,
      kind,
      cause,
      target: {
        kind: 'volume',
        volumeId: hit.v.id,
        span: [clamp(hit.t - tHalf, 0, 1), clamp(hit.t + tHalf, 0, 1)],
        arc: [hit.theta - arcHalf, hit.theta + arcHalf],
      },
      frame: frameAt(hit.p, hit.n, Math.abs(hit.n[1]) > 0.94 ? FWD_Z : UP_Y),
      radius,
      depth,
      incidence,
      severity: clamp01(sev),
      ageSeconds: ageS,
      displacement,
      repairedBy: null,
      seed: sub(shipSubSeed(ctx.seed, 'history'), id),
    };
    ctx.damage.push(ev);
    return ev;
  };

  /**
   * The plate did not evaporate; it was pushed.
   *
   * `Displacement` is the contract's word for "the geometry MOVED rather than
   * eroded", and it was being set on exactly one damage kind — `strut-bent` —
   * on 1.1 % of events. Everything else was a hole with nothing around it,
   * which is the difference between a hull that has been hit and a hull that
   * has been sandblasted, and it is why the history frame reads as dirty rather
   * than as a specific story. A plate taken off by a collision hinges along one
   * edge and stands out of the skin; a plate taken off by a gun goes with the
   * shot. Both are a rotation about a pivot at the wound rim, so both are this.
   */
  const peel = (
    hit: { p: Vec3; n: Vec3 }, incidence: Vec3, radius: number, sev: number, rngIn: Rng,
  ): Displacement => {
    // Hinge axis: in the plane of the plate, square to the direction the hit
    // came from. That is what makes the flap open AWAY from the incidence
    // instead of in some radially symmetric direction nobody can read.
    let axis = vCross(hit.n, incidence);
    if (Math.hypot(axis[0], axis[1], axis[2]) < 1e-6) axis = perpendicular(hit.n);
    axis = vNormalize([axis[0], axis[1], axis[2]]);
    const lift = radius * rngIn.range(0.1, 0.4) * sev;
    return {
      // Along the incidence, and a little proud of the skin: the plate went
      // where it was pushed and took a set on the way.
      offset: [
        incidence[0] * lift + hit.n[0] * lift * 0.5,
        incidence[1] * lift + hit.n[1] * lift * 0.5,
        incidence[2] * lift + hit.n[2] * lift * 0.5,
      ],
      axis: [axis[0], axis[1], axis[2]],
      angle: rngIn.range(0.08, 0.5) * sev * (rngIn.chance(0.5) ? 1 : -1),
      pivot: [hit.p[0], hit.p[1], hit.p[2]],
    };
  };

  const addRepair = (
    kind: RepairKind, of: DamageEvent | null, target: GeometryRef, frame: Frame,
    half: Vec2, quality: number, ageS: number, disp: RepairEvent['displacement'] = null,
  ): RepairEvent => {
    const id = nextId(ctx, 'rep');
    const ev: RepairEvent = {
      id,
      kind,
      repairs: of ? of.id : null,
      target,
      frame,
      halfExtents: half,
      // Never exactly zero: BRIEF §7 says a replaced panel sits slightly PROUD,
      // and a patch flush to the skin is invisible from every angle that matters.
      proud: Math.max(skin * 0.35, skin * lerp(1.8, 0.5, quality)),
      quality: clamp01(quality),
      shadeIndex: rng.int(0, 3),
      fastenerCount: kind === 'weld-seam' || kind === 'sealant-foam' ? 0 : rng.int(6, 26),
      ageSeconds: ageS,
      displacement: disp,
      seed: sub(shipSubSeed(ctx.seed, 'history'), id),
    };
    ctx.repairs.push(ev);
    if (of) {
      const i = ctx.damage.indexOf(of);
      if (i >= 0) ctx.damage[i] = { ...of, repairedBy: ev.id };
    }
    return ev;
  };

  /** Fittings a hull can lose and still be the ship it was. See `tearOff`. */
  const tearable = (): readonly ShipModule[] => ctx.modules.filter(
    (m) => m.present
      && m.type !== 'engine' && m.type !== 'cockpit' && m.type !== 'bridge'
      && m.type !== 'landing' && m.type !== 'rcs'
      // A radiator panel owns a `PrimaryVolume` of its own (`radiatorVolume`,
      // anchored to this very socket) and the slab is drawn from the volume
      // list, not the module list. Marking the module absent while its slab
      // stayed in the silhouette would be a lie the frame can see. Until the
      // geometry module keys that slab off `present`, radiators do not come off.
      && m.type !== 'radiator',
  );

  /**
   * Take a fitting off the hull and leave the evidence, in two records.
   *
   * The first is the canonical one: `module-torn-off`, targeting the module, so
   * anything reading the blueprint knows the socket is empty and what direction
   * the thing left in. That is the record `physics.ts` prices and the record
   * `buildMountingStubs` in the geometry module is waiting for.
   *
   * The second is the mark on the PLATING, and it is why this is a function
   * rather than four lines. Module-targeted damage says a part is missing; it
   * says nothing about the hull it was bolted to, and the surface pass only
   * ever resolves wounds that name a volume and a (span, arc) on it. So a
   * torn-off module left the mesh completely untouched — the absence was true
   * in the data and invisible in the frame, which is precisely the failure
   * BRIEF §7 is written against. A module does not come off cleanly: it takes
   * its plate, its fastener ring and a strip of conduit with it, and that is a
   * `panel-loss` at the mount, in the host's own parameters, with the flap
   * standing where it was pushed.
   */
  const tearOff = (cause: DamageCause, when: number, incidence: Vec3): boolean => {
    const pool = tearable();
    if (pool.length === 0) return false;
    const victim = rng.pick(pool);
    const vi = ctx.modules.indexOf(victim);
    ctx.modules[vi] = { ...victim, present: false, integrity: 0 };
    const r = Math.max(victim.halfExtents[0], victim.halfExtents[1]);

    const id = nextId(ctx, 'dmg');
    ctx.damage.push({
      id,
      kind: 'module-torn-off',
      cause,
      target: { kind: 'module', moduleId: victim.id },
      frame: victim.frame,
      radius: r,
      depth: skin * 3,
      incidence,
      severity: 1,
      ageSeconds: when,
      displacement: peel(
        { p: victim.frame.origin, n: victim.frame.forward }, incidence, r * 2, 1, rng,
      ),
      repairedBy: null,
      seed: sub(shipSubSeed(ctx.seed, 'history'), id),
    });

    const mnt = ctx.mounts.get(victim.id);
    const host = mnt ? ctx.volumes.find((v) => v.id === mnt.volumeId) : undefined;
    if (mnt && host) {
      const sp = volumeSurfacePoint(host, mnt.t, mnt.theta, [0, 0, 0]);
      const sn = surfaceNormal(host, mnt.t, mnt.theta, [0, 0, 0]);
      const hit = {
        v: host, t: mnt.t, theta: mnt.theta,
        p: [sp[0], sp[1], sp[2]] as Vec3, n: [sn[0], sn[1], sn[2]] as Vec3,
      };
      // A hair wider than the flange, never so deep that a hull with a modelled
      // interior gets a hole the camera can see the far side through.
      const wound = r * rng.range(1.05, 1.5);
      const sev = rng.range(0.5, 0.9);
      addDamage('panel-loss', cause, sev, when + 1, hit, wound, skin * rng.range(2, 5),
        incidence, peel(hit, incidence, wound, sev, rng));
    }
    return true;
  };

  // --- micrometeorites: constant rate over the whole service life ----------
  // The faction states damage events per decade of service — a scavenger hull
  // carries other people's damage as well as its own — and that rate is the
  // background hiss of the timeline. Everything below is an event on top of it.
  // Capped at 40: past that the wounds stop reading as a history and start
  // reading as a texture, and each one is real geometry the renderer must build.
  const perDecade = sampleRange(ctx.tech.fabrication === 'salvage-weld'
    ? [ctx.faction.construction.damageRatePerDecade[0] * 1.4, ctx.faction.construction.damageRatePerDecade[1] * 1.4]
    : ctx.faction.construction.damageRatePerDecade, rng);
  const flux = perDecade * (0.5 + clamp01(damageLevel) * 1.5) * (1.4 - care * 0.6);
  const strikes = clamp(Math.round((age / 10) * flux), 0, 40);
  for (let i = 0; i < strikes; i++) {
    const hit = randomSurface(ctx, rng, 1);
    if (!hit) break;
    // Arrived from ahead: mostly along +Z with a scatter, which is what puts
    // the pitting on the bow and the everted lips pointing aft.
    const inc = vNormalize([rng.gaussian(0, 0.35), rng.gaussian(0, 0.35), 1]);
    const r = Math.max(skin * 0.6, rng.power(skin * 0.5, skin * 6, -1.8));
    const deep = r > skin * 1.6;
    addDamage(
      deep ? 'puncture' : 'scoring', 'micrometeorite',
      clamp01(r / (skin * 6)), rng.range(0, age) * YEAR_S,
      hit, r, deep ? skin * rng.range(1.2, 3) : skin * 0.4, [inc[0], inc[1], inc[2]],
    );
  }

  // --- one bad day: a collision, and everything it did in one direction ----
  const hadCollision = rng.chance(clamp01(0.2 + age / 60 + (1 - care) * 0.35 + damageLevel * 0.4));
  if (hadCollision) {
    const when = rng.range(0.1, 0.85) * age * YEAR_S;
    const incidence = vNormalize([rng.range(-1, 1), rng.range(-0.6, 0.6), rng.range(-1, 0.4)]);
    const anchor = randomSurface(ctx, rng, 0.2);
    if (anchor) {
      const R = ctx.prop.beamKm * rng.range(0.12, 0.35);
      addDamage('buckle', 'collision', rng.range(0.5, 0.95), when, anchor, R, R * 0.4,
        [incidence[0], incidence[1], incidence[2]]);
      // Damage is a cluster, not a scatter: a collision leaves a group of
      // related wounds sharing one incidence, and that shared direction is what
      // makes the eye read them as one event.
      const n = rng.int(2, 5);
      for (let i = 0; i < n; i++) {
        const near = randomSurface(ctx, rng, 0.2);
        if (!near) continue;
        const kind = pickWeighted(rng, [
          ['panel-loss', 4] as const, ['puncture', 3] as const, ['ablation', 2] as const, ['debris-embedded', 1] as const,
        ]);
        const sev = rng.range(0.35, 0.8);
        const wr = R * rng.range(0.25, 0.7);
        // A collision MOVES metal. `debris-embedded` is the one kind in this
        // cluster that does not — the thing that hit is still in the hole —
        // so it is the one exception rather than the rule the whole list used
        // to be.
        addDamage(kind, 'collision', sev, when + rng.range(-60, 60), near,
          wr, skin * rng.range(1.5, 5), [incidence[0], incidence[1], incidence[2]],
          kind === 'debris-embedded' ? null : peel(near, incidence, wr, sev, rng));
      }
      // Bent structure. A 3° bend on a boom is very legible and cannot be
      // expressed as a texture, which is exactly why it is here.
      const boom = ctx.volumes.find((v) => v.kind === 'boom' || v.kind === 'pylon' || v.kind === 'keel' || v.kind === 'fin');
      if (boom && rng.chance(0.6)) {
        const pivot = boom.frame.origin;
        const axis = vNormalize(vCross(incidence, boom.frame.forward));
        addDamage('strut-bent', 'collision', rng.range(0.4, 0.85), when, anchor,
          ctx.prop.beamKm * 0.05, skin, [incidence[0], incidence[1], incidence[2]], {
            offset: [0, 0, 0],
            axis: [axis[0], axis[1], axis[2]],
            angle: rng.range(0.02, 0.09) * (rng.chance(0.5) ? 1 : -1),
            pivot,
          });
      }
      // Something was torn off in the impact itself. This one belongs to the
      // event and is scaled by how hard the hull was hit; the service-life rate
      // below is separate and is what a wreck actually accumulates.
      if (rng.chance(clamp01(0.12 + damageLevel * 0.6))) {
        tearOff('collision', when, [incidence[0], incidence[1], incidence[2]]);
      }
    }
  }

  // --- attrition: what a service life takes off a hull ---------------------
  //
  // BRIEF §7 names this explicitly — "a torn-off module leaves its mounting
  // stubs" — and it was one coin flip, `chance(0.45)`, nested inside the
  // collision branch, unscaled by anything. So a hull could lose at most ONE
  // module however wrecked it was, and 62-year-old salvage breakers at 8 %
  // maintenance came out with a full set of fittings: 2 % of modules absent
  // across two hundred heavily damaged seeds, and none at all on the seed the
  // history shot is taken on.
  //
  // Loss is a RATE, and it belongs to the whole service life rather than to one
  // bad afternoon. Squared in `damageLevel` so a working hull keeps its gear
  // and a wreck sheds it; linear in neglect, because the difference between a
  // kept ship and an abandoned one is whether anyone re-bolted the thing after
  // it worked loose. Critical fittings are exempt: a hull with no cockpit, no
  // engines, no attitude control and no undercarriage is not a wreck, it is a
  // different ship, and the physics and landing audits both reason about them.
  // Squared in BOTH terms. A single power on neglect put the median working
  // hull — default damage, ordinary upkeep — at one missing fitting, and a
  // freighter in service is not missing a fitting; the story only starts when
  // nobody has been re-bolting things for a decade. Squared, an averagely kept
  // hull loses nothing and a hull at 0.95/0.08 loses four or five.
  const lossOdds = clamp01(
    damageLevel * damageLevel * (0.06 + 0.26 * (1 - care) * (1 - care))
    * lerp(0.75, 1.25, clamp01(age / 80)),
  );
  const pool = tearable();
  // Expectation first, then one draw for the fraction. A pure per-module coin
  // flip has a standard deviation of nearly two on a twenty-module hull, which
  // is how "most wrecks have none" survives a rate that looks right on paper.
  const expected = pool.length * lossOdds;
  let toLose = Math.floor(expected);
  if (rng.next() < expected - toLose) toLose++;
  for (let i = 0; i < toLose; i++) {
    // Spread over the life, not all on one day: an absence with an age is a
    // timeline, and the repair pass reads `ageSeconds` to decide what has been
    // capped off since.
    const when = rng.range(0.15, 0.95) * age * YEAR_S;
    const inc = vNormalize([rng.range(-1, 1), rng.range(-0.7, 0.7), rng.range(-1, 0.5)]);
    if (!tearOff(rng.chance(0.45) ? 'collision' : 'fatigue', when, [inc[0], inc[1], inc[2]])) break;
  }

  // --- weapons, for hulls that live where that happens ---------------------
  if (ctx.spec.threat[1] > 0.1 || ctx.role === 'derelict' || ctx.role === 'salvager') {
    const hits = rng.int(0, Math.round(3 + damageLevel * 6));
    const incidence = vNormalize([rng.range(-1, 1), rng.range(-0.5, 0.5), rng.range(-1, 1)]);
    for (let i = 0; i < hits; i++) {
      const hit = randomSurface(ctx, rng, 0);
      if (!hit) break;
      const kind = rng.chance(0.5) ? 'burn-through' : 'panel-loss';
      const sev = rng.range(0.4, 1);
      const wr = ctx.prop.beamKm * rng.range(0.02, 0.1);
      // A plate taken off by a shot went somewhere. `burn-through` did not move
      // metal, it removed it, so that one keeps its null.
      addDamage(kind, 'weapons', sev,
        rng.range(0, age) * YEAR_S, hit, wr, skin * rng.range(2, 8),
        [incidence[0], incidence[1], incidence[2]],
        kind === 'panel-loss' ? peel(hit, incidence, wr, sev, rng) : null);
    }
  }

  // --- thermal and fatigue: the slow, boring, universal damage -------------
  const nozzleCracks = ctx.engines.length > 0 && rng.chance(clamp01((1 - care) * 0.5 + age / 120)) ? 1 : 0;
  for (let i = 0; i < nozzleCracks; i++) {
    const e = rng.pick(ctx.engines);
    const id = nextId(ctx, 'dmg');
    ctx.damage.push({
      id, kind: 'nozzle-cracked', cause: 'thermal',
      target: { kind: 'engine', engineId: e.id },
      frame: e.frame, radius: e.nozzle.exitRadius * rng.range(0.15, 0.4), depth: skin * 2,
      incidence: [0, 0, 1], severity: rng.range(0.3, 0.8), ageSeconds: rng.range(0, age) * YEAR_S,
      displacement: null, repairedBy: null, seed: sub(shipSubSeed(ctx.seed, 'history'), id),
    });
  }
  const fatigue = clamp(Math.round(age * (1 - care) * 0.25), 0, 12);
  for (let i = 0; i < fatigue; i++) {
    const hit = randomSurface(ctx, rng, 0);
    if (!hit) break;
    addDamage('ablation', 'fatigue', rng.range(0.2, 0.6), rng.range(0, age) * YEAR_S, hit,
      ctx.prop.beamKm * rng.range(0.03, 0.12), skin * 0.6, [0, 0, 1]);
  }

  // --- a role conversion, if the hull has been round long enough ----------
  if (ctx.tech.refits > 1 && rng.chance(0.4)) {
    const spare = ctx.sockets.filter((s) => s.occupiedBy === null);
    if (spare.length > 0) {
      const s = rng.pick(spare);
      // Someone cut the old fitting off and plated over the hole. This is what
      // a role conversion looks like from outside, years later.
      addRepair('plated-over', null, { kind: 'socket', socketId: s.id }, s.frame,
        [s.budget.radius * 1.3, s.budget.radius * 1.3], rng.range(0.1, 0.5),
        rng.range(0, age * 0.6) * YEAR_S);
    }
  }

  // --- repairs: the better the owner, the more of it got fixed ------------
  // `repairFraction` is the faction's — how much of its damage a culture ever
  // bothers to address — scaled by how well this particular hull was kept.
  const repairOdds = clamp01(sampleRange(ctx.faction.construction.repairFraction, rng) * lerp(0.5, 1.25, care));
  for (const d of ctx.damage) {
    if (d.kind === 'scoring') continue;
    const fixed = rng.chance(repairOdds);
    if (!fixed) continue;
    // A repair happens after the damage and before now.
    const when = rng.range(0, d.ageSeconds);
    // The yard's own standard, dragged down by how this hull has been kept: a
    // Sillane field weld is still a Sillane field weld.
    const quality = clamp01(sampleRange(ctx.faction.construction.repairQuality, rng) * lerp(0.55, 1.15, care));
    const kind = pickWeighted(rng, [
      ['patch-plate', 5] as const,
      ['panel-replaced', quality > 0.6 ? 4 : 1] as const,
      ['weld-seam', 3] as const,
      ['sealant-foam', quality < 0.4 ? 4 : 0.4] as const,
      ['strut-splint', d.kind === 'strut-bent' ? 6 : 0] as const,
      ['stub-capped', d.kind === 'module-torn-off' ? 6 : 0] as const,
      ['field-brace', d.kind === 'buckle' ? 3 : 0] as const,
    ]);
    // A field repair is bigger than the hole and not necessarily square.
    const half: Vec2 = [d.radius * rng.range(1.2, 2.1), d.radius * rng.range(1.2, 2.1) * lerp(1.4, 1.0, quality)];
    addRepair(kind, d, d.target, d.frame, half, quality, when,
      d.displacement && kind === 'strut-splint'
        // A splint straightens the strut most of the way, never all of it.
        ? { ...d.displacement, angle: -d.displacement.angle * rng.range(0.5, 0.85) }
        : null);
  }
}

// ===========================================================================
// Assembly — dimensions, surfaces, markings, scan, render profile
// ===========================================================================

/**
 * The box round every LOD0 PART — which is what `ShipDimensions.bounds` has
 * always promised and what, until now, it did not deliver.
 *
 * It used to union the primary volumes and nothing else. That is not what the
 * contract says and it is not what the renderer draws: a hull's modules, its
 * bells and its undercarriage are all LOD0 geometry, and on the hero freighter
 * the modules reached 3.2 m further forward than the box did while the engine
 * bells hung entirely outside it, because the aft-most volume ENDS at the
 * throat plane. Anything that fits a camera, a cull sphere or a HUD bracket to
 * this box was therefore fitting to a hull five per cent shorter than the one
 * on screen, and the error was worst exactly where it shows — off the ends.
 *
 * `lengthKm`, `beamKm`, `heightKm` and `boundingRadius` are all derived from
 * this one box, so the sphere and the corners can never again describe
 * different ships. `shipSelfTest` asserts that relation over every seed.
 */
function lod0Bounds(ctx: Ctx): Aabb {
  let box: Aabb | null = null;
  const grow = (b: Aabb): void => { box = box ? unionAabb(box, b) : b; };

  for (let i = 0; i < ctx.volumes.length; i++) grow(boundsAt(ctx, i));
  for (let i = 0; i < ctx.modules.length; i++) {
    // A torn-off module is not drawn, so it is not in the box. Its mounting
    // stubs are greebles on a volume and are already covered.
    if (!ctx.modules[i].present) continue;
    grow(moduleBoundsAt(ctx, i));
  }
  for (const e of ctx.engines) {
    // The bell itself: a disc of `exitRadius` about each throat in the pod's
    // cluster, swept aft over the bell's length. The plume is NOT included —
    // it is a billboard, not a part, and `Showroom.aimCorners` documents that
    // it must stay outside this box or every shot reframes on the throttle.
    const n = e.nozzle;
    const r = n.exitRadius + (n.count > 1 ? n.clusterRadius : 0);
    const o = e.frame.origin;
    grow({ min: [o[0] - r, o[1] - r, o[2] - n.length * 0.2], max: [o[0] + r, o[1] + r, o[2] + n.length] });
  }
  for (const t of ctx.thrusters) {
    const r = Math.max(t.radius, HATCH_WIDTH_KM * 0.2);
    const o = t.frame.origin;
    grow({ min: [o[0] - r, o[1] - r, o[2] - r], max: [o[0] + r, o[1] + r, o[2] + r] });
  }
  return box ?? { min: [0, 0, 0], max: [0, 0, 0] };
}

function shipDimensions(ctx: Ctx, pressurisedVolumeM3: number): ShipDimensions {
  const b = lod0Bounds(ctx);

  return {
    lengthKm: b.max[2] - b.min[2],
    beamKm: b.max[0] - b.min[0],
    heightKm: b.max[1] - b.min[1],
    bounds: b,
    boundingRadius: aabbRadiusFromOrigin(b),
    // From `physics.ts`, which already integrated it. This file does not own a
    // second volume model, and the scan readout must agree with the mass model
    // that decided how much the ship weighs.
    pressurisedVolumeM3,
    panelSizeKm: panelSizeFor(ctx),
  };
}

/**
 * Panel edge length.
 *
 * Derived from length, never a constant (BRIEF §7) — but sub-linearly, with a
 * 0.45 exponent: real plate does grow with the ship, and it does not grow
 * proportionally, because the thing setting the upper bound is what a yard can
 * roll and handle rather than what the hull can take. A 30 m courier lands on a
 * 2.6 m plate (one deck height) and a 4 km capital on ~23 m, so a plate is
 * always readable as a plate at the distance the ship reads as a ship. The
 * faction's `panelSizeFactor` then says how coarse *this yard's* stock is.
 */
function panelSizeFor(ctx: Ctx): number {
  const base = DECK_HEIGHT_KM * Math.pow(ctx.prop.lengthKm / 0.03, 0.45);
  return clamp(base, DECK_HEIGHT_KM * 0.6, CONTAINER_LENGTH_KM * 2.2) * ctx.faction.construction.panelSizeFactor;
}

/**
 * Three materials, at most, shared across the family (BRIEF §6). The wear
 * weights are the faction's character × the role's bias × maintenance, from
 * `wearWeightsFor`, then leaned per slot: structure corrodes and stains,
 * detail scuffs where hands go. A single grime slider on all three is exactly
 * the uniform-noise failure BRIEF §7 rejects.
 */
function materialProfiles(ctx: Ctx): readonly MaterialProfile[] {
  const c = ctx.faction.construction;
  const s = ctx.faction.surface;
  const rng = new Rng(shipSubSeed(ctx.seed, 'material'));
  const panel = panelSizeFor(ctx);
  const baseWear = wearWeightsFor(ctx.faction, roleById(ctx.role), ctx.tech.maintenance);
  const age = clamp01(ctx.tech.ageYears / 60);

  const lean = (w: WearWeights, k: Partial<WearWeights>): WearWeights => ({
    edges: clamp01(w.edges * (k.edges ?? 1)),
    hatches: clamp01(w.hatches * (k.hatches ?? 1)),
    streaks: clamp01(w.streaks * (k.streaks ?? 1)),
    soot: clamp01(w.soot * (k.soot ?? 1)),
    heat: clamp01(w.heat * (k.heat ?? 1)),
    pitting: clamp01(w.pitting * (k.pitting ?? 1)),
    corrosion: clamp01(w.corrosion * (k.corrosion ?? 1)),
    frost: clamp01(w.frost * (k.frost ?? 1)),
  });

  const mk = (slot: number, roughK: number, metal: number, sizeK: number, wear: WearWeights, flow: Vec3): MaterialProfile => ({
    key: matKey(ctx, slot),
    roughness: clamp01(sampleRange(s.roughness, rng) * roughK),
    metalness: metal,
    panelSizeKm: panel * sizeK,
    panelJitter: clamp01(c.panelSizeVariance),
    // A seam has to read as a groove, not a line: one part in 40 of the plate.
    seamDepth: panel * 0.025 * c.seamDepthFactor,
    // Exactly zero means welded — a statement about the culture, not a small
    // number (`ConstructionDna.fastenerPitchFactor` says so).
    fastenerPitch: c.fastenerPitchFactor === 0 ? 0 : panel * 0.09 * c.fastenerPitchFactor,
    wear,
    flowDirection: flow,
    microDetailScale: s.microDetailScale * clamp(Math.pow(ctx.prop.lengthKm / 0.03, 0.3), 1, 6),
    paintFade: clamp01(sampleRange(s.paintFade, rng) + age * 0.35),
  });

  return [
    // Painted hull plate: metalness 0, streaked aft along the ship's own flow.
    mk(MAT_HULL, 1.0, 0, 1.0, baseWear, [0, 0, 1]),
    // Bare structural metal: corrodes, stains with heat, never painted.
    mk(MAT_STRUCT, 1.08, 0.85, 0.55, lean(baseWear, { corrosion: 1.6, heat: 1.5, edges: 1.3, streaks: 0.7 }), [0, 0, 1]),
    // Fittings the crew touch: scuffed round the hatches, pitted less.
    mk(MAT_DETAIL, 0.95, 0.45, 0.3, lean(baseWear, { hatches: 1.8, edges: 1.5, pitting: 0.6, frost: 0.7 }), [0, -1, 0.4]),
  ];
}

/**
 * Markings. Text is the cheapest scale cue in the game, so cap height comes
 * from `markingCapHeightKm` — a multiple of `DECK_HEIGHT_KM`, never of the
 * ship. A 4 km capital with 4 km-scaled lettering reads as a 40 m model.
 */
function buildMarkings(ctx: Ctx, registry: string, name: string): readonly Marking[] {
  const rng = new Rng(shipSubSeed(ctx.seed, 'markings'));
  const md = ctx.faction.markings;
  const out: Marking[] = [];
  const hosts = ctx.volumes.filter((v) => v.kind !== 'nacelle' && v.kind !== 'radiator' && v.kind !== 'ring');
  if (hosts.length === 0) return out;

  const place = (kind: MarkingKind, text: string, where: string, capK: number, color: RGB): void => {
    const host = where === 'largest-flat'
      ? hosts.slice().sort((a, b) => volumeSpan(ctx, b) - volumeSpan(ctx, a))[0]
      : hosts[Math.floor(rng.next() * hosts.length)];
    const t = where === 'nose' ? 0.08 : where === 'tail-band' || where === 'dorsal-aft' ? 0.82 : rng.range(0.3, 0.65);
    const theta = where === 'ventral' ? VENTRAL : where === 'dorsal-aft' ? DORSAL : (rng.chance(0.5) ? 0.25 : Math.PI - 0.25);
    const p = volumeSurfacePoint(host, t, theta, [0, 0, 0]);
    const n = surfaceNormal(host, t, theta, [0, 0, 0]);
    const cap = markingCapHeightKm(ctx.faction, capK);
    out.push({
      id: nextId(ctx, 'mk'),
      kind,
      text,
      frame: frameAt([p[0], p[1], p[2]], [n[0], n[1], n[2]], Math.abs(n[1]) > 0.94 ? FWD_Z : UP_Y),
      // Roughly 0.62 of cap height per character is the aspect of a stencil face.
      halfExtents: [Math.max(cap, text.length * cap * 0.31), cap * 0.5],
      color,
      // Markings near hatches and thrusters wear first. A uniformly worn set is
      // the same failure as uniform noise on a hull (`Marking.wear` says so).
      wear: clamp01(sampleRange(md.wear, rng) * (where === 'tail-band' || where === 'engine-shroud' ? 1.5 : 1)),
      volumeId: host.id,
    });
  };

  const wanted = ctx.spec.markings.filter((k) => md.kinds.includes(k));
  const kinds = wanted.length > 0 ? wanted : md.kinds;
  const places = md.placement.length > 0 ? md.placement : (['largest-flat'] as const);

  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const where = places[i % places.length];
    switch (kind) {
      case 'registry': place(kind, registry, where, 1, ctx.palette.trim); break;
      case 'name': if (md.namesShips) place(kind, name.toUpperCase(), where, 0.8, ctx.palette.trim); break;
      case 'emblem': place(kind, ctx.faction.shortName.toUpperCase(), 'largest-flat', 1, ctx.palette.accent); break;
      // Hazard chevrons go round the exhaust, because that is the thing that
      // will kill someone. Placement is function, not pattern.
      case 'hazard': place(kind, 'HAZARD', 'engine-shroud', 0.5, ctx.palette.accent); break;
      case 'stencil': place(kind, rng.pick(['NO STEP', 'FUEL', 'RESCUE', 'VENT', 'HIGH PRESSURE']), where, 0.3, ctx.palette.trim); break;
      case 'numeral': place(kind, String(rng.int(1, 48)).padStart(2, '0'), where, 0.6, ctx.palette.trim); break;
      default: place(kind, '', where, 1, ctx.palette.accent); break;
    }
  }
  return out;
}

/**
 * LOD distances are absolute km derived from the ship's LENGTH.
 *
 * A 4 km capital that swaps to LOD1 where a 30 m courier does pops in the
 * middle of the screen, because the thing that matters is angular size. The
 * multipliers below are "how many ship-lengths away" and are therefore the
 * same angular thresholds for every hull in the fleet.
 */
function renderProfile(ctx: Ctx, dims: ShipDimensions): RenderProfile {
  const L = Math.max(1e-5, dims.lengthKm);
  const sizeK = clamp(Math.pow(L / 0.09, 0.35), 0.35, 1.6);
  const budget0 = Math.round(120000 * sizeK);

  const lods: LodLevel[] = [
    { level: 0, minDistanceKm: 0, triangleBudget: budget0, sectionSegments: 24, stationSubdivisions: 3, greebleFraction: 1, minFeatureKm: L * 0.0018, separateModules: true, connections: true },
    { level: 1, minDistanceKm: L * 25, triangleBudget: Math.round(25000 * sizeK), sectionSegments: 14, stationSubdivisions: 1, greebleFraction: 0.35, minFeatureKm: L * 0.012, separateModules: true, connections: true },
    { level: 2, minDistanceKm: L * 90, triangleBudget: Math.round(3000 * sizeK), sectionSegments: 8, stationSubdivisions: 0, greebleFraction: 0, minFeatureKm: L * 0.05, separateModules: false, connections: false },
    { level: 3, minDistanceKm: L * 280, triangleBudget: Math.round(700 * sizeK), sectionSegments: 6, stationSubdivisions: 0, greebleFraction: 0, minFeatureKm: L * 0.15, separateModules: false, connections: false },
  ];

  // Draw calls: one merged buffer per material, plus the instanced greeble
  // batches, plus one for the bells and one for the plumes. BRIEF §6 caps LOD0
  // at 12, so the batch list is trimmed rather than the budget quietly broken.
  const fixed = 3 + 2;
  const maxBatches = Math.max(0, 12 - fixed);
  const instancing = ctx.instancing.slice(0, maxBatches);

  return {
    lods,
    impostorDistanceKm: L * 900,
    cullDistanceKm: L * 20000,
    materialKeys: [matKey(ctx, MAT_HULL), matKey(ctx, MAT_STRUCT), matKey(ctx, MAT_DETAIL)],
    instancing,
    drawCallEstimate: fixed + instancing.length,
    // `Ship.ts` compiles OCC_MAX = 28 and LAMP_MAX = 6 into the shader as
    // defines. Exceeding either silently drops the overflow, so it is capped
    // here where it is visible instead.
    occluderBudget: Math.min(28, ctx.modules.filter((m) => m.present).length + ctx.engines.length),
    lampBudget: Math.min(6, ctx.lamps.length),
    detailSeed: shipSubSeed(ctx.seed, 'greebles'),
    lamps: ctx.lamps.slice(0, 6),
  };
}

/** Subsystems the HUD can bracket and the player can disable. */
function subsystems(ctx: Ctx): readonly TargetableSubsystem[] {
  const out: TargetableSubsystem[] = [];
  if (ctx.engines.length > 0) {
    const e = ctx.engines[0];
    out.push({
      id: 'sub:drive', label: 'DRIVE', frame: e.frame,
      radius: e.nozzle.exitRadius * 2.2,
      integrity: clamp01(1 - ctx.damage.filter((d) => d.target.kind === 'engine').length * 0.3),
      critical: true, target: { kind: 'engine', engineId: e.id },
    });
  }
  const cmd = ctx.modules.find((m) => m.kind === 'cockpit' || m.kind === 'bridge-tower');
  if (cmd) {
    out.push({
      id: 'sub:command', label: cmd.kind === 'cockpit' ? 'COCKPIT' : 'BRIDGE', frame: cmd.frame,
      radius: Math.max(cmd.halfExtents[0], cmd.halfExtents[1]) * 1.8,
      integrity: cmd.integrity, critical: true, target: { kind: 'module', moduleId: cmd.id },
    });
  }
  for (const kind of ['sensor-dish', 'sensor-array', 'radiator-panel', 'reactor-can', 'mining-head', 'grapple-arm'] as const) {
    const m = ctx.modules.find((x) => x.kind === kind && x.present);
    if (!m) continue;
    out.push({
      id: `sub:${kind}`,
      label: kind.replace('-', ' ').toUpperCase(),
      frame: m.frame,
      radius: Math.max(m.halfExtents[0], m.halfExtents[1]) * 1.6,
      integrity: m.integrity,
      critical: kind === 'reactor-can',
      target: { kind: 'module', moduleId: m.id },
    });
  }
  const cargo = ctx.volumes.find((v) => v.kind === 'cargo-bay' || v.kind === 'cargo-rack' || v.kind === 'tank');
  if (cargo) {
    out.push({
      id: 'sub:cargo', label: cargo.kind === 'tank' ? 'TANKAGE' : 'CARGO',
      frame: { origin: volumeCentre(ctx, cargo), forward: FWD_Z, up: UP_Y },
      radius: aabbRadiusFromOrigin(boundsOf(ctx, cargo)) * 0.4,
      integrity: 1, critical: false,
      target: { kind: 'volume', volumeId: cargo.id, span: [0, 1], arc: [0, TAU] },
    });
  }
  return out;
}

/**
 * Put the resultant thrust line through the centre of mass (BRIEF §5).
 *
 * The cluster was laid out about the CoM the generator knew at stage 4; by the
 * time every module, radiator and leg exists the balance point has moved, and
 * the origin has since become the true CoM. So the whole drive assembly — pods,
 * their sockets and their nacelle shrouds — slides laterally until
 * `shipThrust().offsetKm` is inside tolerance. Only x and y move: shifting a
 * drive along z changes nothing about the line it thrusts along.
 *
 * If a second pass still cannot close it, the offset is left standing and
 * reported. A hull whose drive genuinely torques it is a legitimate ship; a
 * hull that quietly pretends otherwise is not.
 */
interface ThrustAlignment {
  readonly dx: number;
  readonly dy: number;
  /** Ids of every part that moved, so the balance point can follow analytically. */
  readonly movedIds: readonly string[];
}

function alignThrustAxis(ctx: Ctx): ThrustAlignment | null {
  if (ctx.engines.length === 0) return null;
  // A hundredth of the beam: below that the couple is smaller than the RCS
  // trim authority and no pilot could tell.
  const tolerance = ctx.prop.beamKm * 0.01;

  // Thrust-weighted lateral centroid of the throats. Moving it to (0,0) puts
  // the line of action through the origin, which IS the centre of mass.
  let wx = 0, wy = 0, w = 0;
  for (const e of ctx.engines) { wx += e.frame.origin[0] * e.thrustN; wy += e.frame.origin[1] * e.thrustN; w += e.thrustN; }
  if (w <= 0) {
    // A derelict declares zero thrust, so the weighted centroid is undefined —
    // and skipping the alignment left its cold cluster wherever the geometry
    // happened to put it, which the physics reviewer then read as an off-axis
    // drive on a ship that cannot burn. The bells are still bolted to a thrust
    // frame the yard built straight, so centre them unweighted.
    for (const e of ctx.engines) { wx += e.frame.origin[0]; wy += e.frame.origin[1]; }
    w = ctx.engines.length;
  }
  const dx = -wx / w;
  const dy = -wy / w;
  if (Math.hypot(dx, dy) <= tolerance) return null;

  const movedIds: string[] = [];
  const moved = new Set<string>();
  for (let i = 0; i < ctx.engines.length; i++) {
    const e = ctx.engines[i];
    ctx.engines[i] = { ...e, frame: shiftFrame(e.frame, [dx, dy, 0]) };
    moved.add(e.socketId);
    movedIds.push(e.id);
  }
  for (let i = 0; i < ctx.sockets.length; i++) {
    if (moved.has(ctx.sockets[i].id)) ctx.sockets[i] = { ...ctx.sockets[i], frame: shiftFrame(ctx.sockets[i].frame, [dx, dy, 0]) };
  }
  // The nacelle shrouds are anchored to the engine sockets and must travel with
  // them, or the bells slide out through their own cowlings.
  for (let i = 0; i < ctx.volumes.length; i++) {
    const a = ctx.volumes[i].anchor;
    if (a?.kind === 'socket' && moved.has(a.socketId)) {
      const v = ctx.volumes[i];
      ctx.volumes[i] = { ...v, frame: shiftFrame(v.frame, [dx, dy, 0]) };
      movedIds.push(v.id);
      const b = ctx.bounds[i];
      if (b !== undefined) ctx.bounds[i] = { min: shift(b.min, [dx, dy, 0]), max: shift(b.max, [dx, dy, 0]) };
    }
  }
  // A cracked bell's wound rides the bell it is on.
  for (let i = 0; i < ctx.damage.length; i++) {
    if (ctx.damage[i].target.kind === 'engine') {
      ctx.damage[i] = { ...ctx.damage[i], frame: shiftFrame(ctx.damage[i].frame, [dx, dy, 0]) };
    }
  }
  return { dx, dy, movedIds };
}

/**
 * Set the RCS thrust from the FINISHED hull's inertia, about the finished
 * hull's centre of mass.
 *
 * `buildRcs` places the quads in stage 4, where it has to: the nozzles have to
 * exist before the modules are mounted around them. But it sized them against
 * the stage-4 inertia — a hull consisting of its primary volumes and nothing
 * else — while the ship the pilot flies carries twenty modules, its radiators,
 * its gear and its payload, and comes out five to ten times harder to turn.
 * Delivered pitch authority was landing at a tenth of the target on every one
 * of the eighteen roles, which then saturated `assistDampTime` against its
 * upper clamp in physics.ts and gave a 22 m shuttle and a 2 km carrier the same
 * attitude-hold lag.
 *
 * Rescaling costs nothing: a thruster's mass comes from its throat radius, not
 * from its rating, so changing the rating cannot move the balance point and no
 * second mass integration is needed. Groups are re-derived at the same time
 * because the moment arms are measured from the final centre of mass, which is
 * the origin by the time this runs.
 */
function retuneRcs(ctx: Ctx, mass: ReturnType<typeof shipMassProperties>): void {
  if (ctx.thrusters.length === 0) return;
  const inertia = mass.inertia;
  const AXES: readonly Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const TRANS: readonly RcsGroup[][] = [['x+', 'x-'], ['y+', 'y-'], ['z+', 'z-']];
  const ROT: readonly RcsGroup[][] = [['pitch+', 'pitch-'], ['yaw+', 'yaw-'], ['roll+', 'roll-']];
  const bins = [0, 0, 0, 0, 0, 0];
  const groupsFor: RcsGroup[][] = [];
  const sum: MutVec3 = [0, 0, 0];
  /** Σ r⊥² per axis: how much inertia one kilogramme of quad adds where it sits. */
  const spread = [0, 0, 0];

  for (const t of ctx.thrusters) {
    const f: Vec3 = [-t.frame.forward[0], -t.frame.forward[1], -t.frame.forward[2]];
    const r = t.frame.origin;
    sum[0] += r[0]; sum[1] += r[1]; sum[2] += r[2];
    spread[0] += r[1] * r[1] + r[2] * r[2];
    spread[1] += r[0] * r[0] + r[2] * r[2];
    spread[2] += r[0] * r[0] + r[1] * r[1];
    const c: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const groups: RcsGroup[] = [];
    for (let a = 0; a < 3; a++) {
      const d = vDot(f, AXES[a]);
      if (d > 0.5) groups.push(TRANS[a][0]);
      else if (d < -0.5) groups.push(TRANS[a][1]);
    }
    const cm = vLength(c);
    if (cm > 1e-9) {
      for (let a = 0; a < 3; a++) {
        const d = vDot(c, AXES[a]) / cm;
        if (d > 0.5) { groups.push(ROT[a][0]); bins[a * 2] += Math.max(0, c[a]); }
        else if (d < -0.5) { groups.push(ROT[a][1]); bins[a * 2 + 1] += Math.max(0, -c[a]); }
      }
    }
    groupsFor.push(groups);
  }

  const L = Math.max(1e-6, ctx.prop.lengthKm);
  const alpha = clamp(2.0 * Math.sqrt(0.03 / L), 0.06, 3.0);
  const need = [
    alpha * Math.max(1e-6, inertia.pitch) * 1e3,
    alpha * Math.max(1e-6, inertia.yaw) * 1e3,
    alpha * Math.max(1e-6, inertia.roll) * 1e3,
  ];
  const auth = [Math.min(bins[0], bins[1]), Math.min(bins[2], bins[3]), Math.min(bins[4], bins[5])];
  const strongest = Math.max(auth[0], auth[1], auth[2]);
  const floorAuth = strongest * 0.02;

  // The quad mass law, probed rather than guessed: `physics.ts` charges
  // `mount + k × thrustN` per nozzle and neither constant is exported, so two
  // nozzles at known ratings are integrated in isolation — no volumes, no
  // modules, microseconds — and the law read off the two items it returns. The
  // same trick `buildDrive` uses for the nozzle thrust constant, and for the
  // same reason: a law inverted from the source of truth cannot drift from it.
  const probeFrame = frameAt([0, 0, 0], FWD_Z, UP_Y);
  const probe = shipMassProperties({
    role: ctx.role,
    technologyProfile: ctx.tech,
    primaryVolumes: [],
    modules: [],
    engines: [],
    thrusters: [
      { ...ctx.thrusters[0], id: 'probe-a', frame: probeFrame, thrustN: 0 },
      { ...ctx.thrusters[0], id: 'probe-b', frame: probeFrame, thrustN: 1e6 },
    ],
    hardpoints: [],
    dockingPoints: [],
    landingSystem: null,
  });
  const pa = probe.items.find((it) => it.id === 'probe-a');
  const pb = probe.items.find((it) => it.id === 'probe-b');
  const kgPerN = pa && pb ? Math.max(0, (pb.massKg - pa.massKg) / 1e6) : 0;

  // Sizing the RCS is a FIXED POINT, not a division, and treating it as a
  // division is why the delivered rate never reached the target however the
  // authority was measured. `physics.ts` prices a nozzle at ten kilogrammes per
  // kilonewton, so a heavier quad is a heavier ship is a larger moment of
  // inertia is a larger torque requirement. Writing that down:
  //
  //   T·A = α·1e3·( I₀ + k·(T − T₀)·Σr⊥² )
  //
  // and solving for T gives the rating that actually delivers α once its own
  // mass is carried. Where the bracket's coefficient exceeds the authority the
  // loop diverges — the hull cannot buy the rate at any price, which is the
  // literal truth for a four-kilometre capital — and that is reported.
  const oldT = ctx.thrusters[0].thrustN;
  const I = [inertia.pitch, inertia.yaw, inertia.roll];
  let want = 0;
  let axis = 0;
  let unreachable = false;
  for (let a = 0; a < 3; a++) {
    if (auth[a] < floorAuth || auth[a] <= 0) continue;
    const den = auth[a] - alpha * 1e3 * kgPerN * spread[a];
    const num = alpha * 1e3 * Math.max(0, I[a] - kgPerN * oldT * spread[a]);
    const t = den > 0 ? num / den : Infinity;
    if (!Number.isFinite(t)) { unreachable = true; continue; }
    if (t > want) { want = t; axis = a; }
  }
  if (want <= 0 && !unreachable) return;

  // A hull cannot spend unbounded mass on attitude control. Where the fixed
  // point diverges the set is held to a share of the dry mass — sized to what a
  // real vehicle spends on reaction control — and the shortfall is REPORTED
  // rather than delivered as a number nobody can fly to.
  const n = ctx.thrusters.length;
  const maxThrust = kgPerN > 0 ? (mass.dryMassKg * RCS_MASS_FRACTION) / (n * kgPerN) : Infinity;
  const thrustN = clamp(Math.min(want > 0 ? want : Infinity, maxThrust), 1, 1e12);
  if (unreachable || want > maxThrust * 1.001) {
    const AXIS_NAME = ['pitch', 'yaw', 'roll'];
    const iAxis = Math.max(1e-9, I[axis]);
    reject(ctx, {
      stage: 'propulsion',
      rule: 'no-compatible-socket',
      what: `RCS cannot reach the design ${AXIS_NAME[axis]} rate without massing more than ${Math.round(RCS_MASS_FRACTION * 100)}% of the hull`,
      at: [0, 0, 0],
      measured: (auth[axis] * thrustN * 1e-3) / iAxis,
      required: alpha,
      attempt: 0,
    });
  }

  for (let i = 0; i < n; i++) {
    const t = ctx.thrusters[i];
    ctx.thrusters[i] = { ...t, thrustN, groups: groupsFor[i].length > 0 ? groupsFor[i] : t.groups };
  }

  // Re-rating the quads changed their mass, so it moved the balance point. The
  // correction is exact and costs no integration: every nozzle changed by the
  // same `k × Δthrust`, the origin was the centre of mass before, so the new
  // centre is that delta times the sum of the nozzle positions over the new
  // total. Skipping this put the origin three metres off the balance point on a
  // ninety-metre hull, against a one-metre tolerance.
  const dm = kgPerN * (thrustN - oldT);
  if (dm !== 0) {
    // …and the undercarriage follows, because `physics.ts` sizes the legs as a
    // fraction of everything they hold up. Both ratios are read off the items
    // the integration already returned, so the correction stays exact without a
    // second one. Missing this term put the origin two per cent of a hull
    // length off the balance point on every hull that carries gear.
    const gearItem = mass.items.find((it) => it.source === 'landing-gear');
    let gearDelta = 0;
    const gearAt: Vec3 = gearItem ? gearItem.centre : [0, 0, 0];
    if (gearItem) {
      const rest = mass.dryMassKg - gearItem.massKg;
      if (rest > 1) gearDelta = (gearItem.massKg / rest) * n * dm;
    }
    const total = mass.dryMassKg + dm * n + gearDelta;
    if (total > 1) {
      applyShift(ctx, [
        -(dm * sum[0] + gearDelta * gearAt[0]) / total,
        -(dm * sum[1] + gearDelta * gearAt[1]) / total,
        -(dm * sum[2] + gearDelta * gearAt[2]) / total,
      ]);
      // That shift moved the drive off the balance point by the same amount, so
      // bring it back — and follow the balance point after it, the same exact
      // arithmetic `balance` uses, so the realignment does not cost the origin
      // the accuracy the correction above just bought.
      const mv = alignThrustAxis(ctx);
      if (mv) {
        const ids = new Set(mv.movedIds);
        let movedKg = 0;
        for (const it of mass.items) if (ids.has(it.id)) movedKg += it.massKg;
        const f = movedKg / Math.max(1, total);
        applyShift(ctx, [-f * mv.dx, -f * mv.dy, 0]);
      }
    }
  }
}

/**
 * Report a thrust line the generator could not bring through the centre of
 * mass. BRIEF §5 allows the offset — it does not allow it to be silent.
 *
 * Measured on the FINISHED blueprint, from `shipPhysicsProfile`'s own report.
 * It used to be measured inside `balance`, against an intermediate state and at
 * the cost of a full extra mass integration; the same number now comes free
 * from a profile the pipeline computes anyway, and it is the number the physics
 * reviewer reads, so the two can no longer disagree.
 */
function auditThrustDelivered(ctx: Ctx, physics: PhysicsProfile): void {
  if (ctx.accelMs2 <= 0) return;
  const delivered = physics.thrustN / Math.max(1, physics.loadedMassKg);
  const want = ctx.spec.accelMs2[0];
  if (delivered >= want) return;
  // The drive is sized in stage 4, against the hull as it stands at stage 4 —
  // which is the only mass that exists when a bell has to be dimensioned. Five
  // stages of modules, payload racks, radiators and gear are then bolted on,
  // and on a hull where they are most of the finished mass the delivered
  // acceleration lands under the role's band even though every pod is making
  // exactly the thrust it was designed for. That is a true fact about the ship
  // and it belongs in the log; the alternative is a blueprint that publishes an
  // acceleration its own engines cannot produce.
  reject(ctx, {
    stage: 'propulsion',
    rule: 'thrust-below-role-band',
    what: `finished hull accelerates at ${delivered.toFixed(1)} m/s², below the ${ctx.role} band`,
    at: [0, 0, 0],
    measured: delivered,
    required: want,
    attempt: 9,
  });
}

/**
 * Perpendicular distance from the resultant thrust line to the LOADED centre
 * of mass, km. The same Σ (r − c) × F loop `physics.ts` runs, about the other
 * centre — which is the one that matters, and the one nothing was checking.
 *
 * `shipThrust` evaluates only at `mass.centreOfMass`, and the generator's last
 * act is to rebase the origin onto exactly that point, so the published
 * `thrustOffset` was measured against a number the pipeline had just made
 * zero. Recomputed about `loadedCentreOfMass` on the same seeds it came out
 * seven to seventy times larger: a laden miner missing its own balance point
 * by 9.4 m, five times further off axis than the case `physics.ts`'s own
 * self-test calls a failure.
 */
function ladenThrustOffsetKm(bp: ShipBlueprint): number {
  return thrustOffsetAbout(bp.engines, bp.physics.loadedCentreOfMass);
}

function thrustOffsetAbout(engines: readonly EnginePod[], c: Vec3): number {
  let fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0;
  for (const e of engines) {
    const mag = e.thrustN;
    if (mag <= 0) continue;
    const a = e.thrustAxis;
    const Fx = a[0] * mag, Fy = a[1] * mag, Fz = a[2] * mag;
    fx += Fx; fy += Fy; fz += Fz;
    const rx = e.frame.origin[0] - c[0];
    const ry = e.frame.origin[1] - c[1];
    const rz = e.frame.origin[2] - c[2];
    tx += ry * Fz - rz * Fy;
    ty += rz * Fx - rx * Fz;
    tz += rx * Fy - ry * Fx;
  }
  const m = Math.hypot(fx, fy, fz);
  return m > 0 ? Math.hypot(tx, ty, tz) / m : 0;
}

function auditThrustAxis(ctx: Ctx, physics: PhysicsProfile): void {
  if (ctx.engines.length === 0) return;
  // The reviewer's own bar, in both places, so the sweep and `reviewShipPhysics`
  // cannot return different verdicts on the same hull. The old test here used
  // 1% of BEAM and the §5 sweep used 5% of beam, while the reviewer used 0.4%
  // of LENGTH — three tolerances for one rule.
  const tolerance = Math.max(1e-5, ctx.prop.lengthKm * 0.004);
  const dry = physics.thrustOffset;
  const laden = thrustOffsetAbout(ctx.engines, physics.loadedCentreOfMass);
  if (physics.thrustN <= 0) return;
  if (Math.max(dry, laden) <= tolerance) return;
  reject(ctx, {
    stage: 'propulsion',
    rule: laden > dry ? 'load-out-of-trim' : 'thrust-off-axis',
    what: laden > dry
      ? `laden centre of mass sits ${fmtKm(laden)} off the thrust line (dry ${fmtKm(dry)})`
      : 'resultant thrust line does not pass through the centre of mass',
    at: [0, 0, 0],
    measured: Math.max(dry, laden),
    required: tolerance,
    attempt: 4,
  });
}

/**
 * Re-measure every clearance that a BRIEF §5 rule turns on, against the
 * FINISHED part list.
 *
 * `Socket.clearance` and `Socket.clearAngle` were frozen at the moment of
 * mounting, so a value measured in stage 4 could not be invalidated by anything
 * stages 5 to 8 placed in front of it. Combined with `occupantAt` ignoring
 * modules, that made the four §5 sweeps a measurement of a ship that no longer
 * existed by the time the generator returned it: `ship-engine-close.png` shows
 * booms, a lattice and a mast sitting within a bell radius of the outer
 * nozzles, and none of that geometry took part in the exhaust-cone test.
 *
 * So the sockets that matter are measured again here, once, after stage 8, and
 * the new value is written back. Where it has fallen below what the placement
 * rule demanded, the loss is recorded as `post-pass-obstructed` rather than
 * quietly overwritten — the point is not to make the numbers agree, it is to
 * make the disagreement visible.
 */
function remeasureClearances(ctx: Ctx): readonly string[] {
  const WATCH: readonly SocketType[] = ['engine', 'cockpit', 'bridge', 'weapon', 'docking'];
  /** The rule each socket type has to keep, from the placement code above. */
  const MIN_CONE: Partial<Record<SocketType, number>> = {
    engine: 0.09, cockpit: 0.3, bridge: 0.3, weapon: 0.4, docking: 0.3,
  };
  // A trainable mount that lost its sky to a radiator is refused outright, at
  // the same 0.7 rad the placement pass accepted it against — the two bars
  // have to be the same number or the post-pass silently publishes turrets the
  // placement rule would never have fitted.
  const TRAINABLE_ARC = 0.7;
  const bySocket = new Map<string, ShipModule>();
  for (const m of ctx.modules) if (m.present) bySocket.set(m.socketId, m);
  const lost = new Set<string>();
  const removed: string[] = [];
  const newCone = new Map<string, number>();
  const newClear = new Map<string, number>();

  for (let i = 0; i < ctx.sockets.length; i++) {
    const sk = ctx.sockets[i];
    if (!WATCH.includes(sk.type)) continue;
    if (sk.type !== 'engine' && sk.occupiedBy === null) continue;
    const occupant = bySocket.get(sk.id);
    // Skip the part being measured FOR — its own box always contains its own
    // socket — and the volume it hangs on.
    const skip = sk.host.kind === 'volume' ? sk.host.volumeId : null;
    const skip2 = occupant ? (occupant.volumeId ?? occupant.id) : null;

    const probe = sk.type === 'engine'
      ? Math.max(ctx.plumeLengthKm, sk.budget.depth)
      : Math.max(sk.budget.depth * 1.5, ctx.prop.lengthKm * 0.12);
    const eps = Math.max(1e-6, probe * 0.02);
    const f = sk.frame;
    const o: Vec3 = [
      f.origin[0] + f.forward[0] * eps,
      f.origin[1] + f.forward[1] * eps,
      f.origin[2] + f.forward[2] * eps,
    ];
    const clearance = eps + clearanceAlong(ctx, o, f.forward, probe, skip, skip2);
    const cone = clearAngleAt(
      ctx, o, f.forward, Math.min(probe, Math.max(sk.budget.radius * 3, ctx.prop.lengthKm * 0.05)), skip, skip2, sk.clearAngle,
    );
    const trainable = sk.type === 'weapon' && occupant !== undefined
      && (occupant.kind === 'turret' || occupant.kind === 'point-defence');
    const floor = trainable ? TRAINABLE_ARC : (MIN_CONE[sk.type] ?? 0);
    if (cone < floor && sk.clearAngle >= floor) {
      reject(ctx, {
        stage: sk.type === 'engine' ? 'propulsion' : 'modules',
        rule: 'post-pass-obstructed',
        what: `${sk.type} ${occupant ? occupant.kind : sk.id} lost its cone to a part placed after it was mounted`,
        at: f.origin,
        measured: cone,
        required: floor,
        attempt: 9,
      });
    }
    ctx.sockets[i] = { ...sk, clearance, clearAngle: cone };
    newCone.set(sk.id, cone);
    newClear.set(sk.id, clearance);
    // A turret that can only shoot its own radiator, or a collar nothing can
    // reach, is not a feature of the ship — it is a claim the blueprint makes
    // and cannot keep. BRIEF §5 says weapons have unobstructed fields of fire
    // and docking ports are reachable from outside, so these are refused
    // outright rather than published with an honest but useless number. The
    // socket and its mounting stubs stay, which is what a yard would leave.
    const tooDeep = occupant !== undefined && occupant.halfExtents[2] * 2 > clearance * 1.0001;
    if (tooDeep && sk.clearance >= occupant.halfExtents[2] * 2) {
      reject(ctx, {
        stage: sk.type === 'engine' ? 'propulsion' : 'modules',
        rule: 'post-pass-obstructed',
        what: `${occupant.kind} no longer fits the corridor it was mounted in`,
        at: f.origin,
        measured: clearance,
        required: occupant.halfExtents[2] * 2,
        attempt: 9,
      });
    }
    // A turret that was TORN OFF took its gun with it, and the hardpoint record
    // has to go too. It did not: `bySocket` only holds present modules, so a
    // wrecked mount fell through this branch entirely and the blueprint kept
    // publishing a `Hardpoint` with a 0 rad field of fire on a socket with
    // nothing in it — which is how a gunship came out of the §5 sweep with a
    // turret that could not shoot and no explanation anywhere.
    if (occupant === undefined && (sk.type === 'weapon' || sk.type === 'docking') && sk.occupiedBy !== null) {
      lost.add(sk.id);
      continue;
    }
    if ((cone < floor || tooDeep) && occupant && (sk.type === 'weapon' || sk.type === 'docking')) {
      lost.add(sk.id);
      const mi = ctx.modules.indexOf(occupant);
      if (mi >= 0) { ctx.modules.splice(mi, 1); ctx.moduleBounds.splice(mi, 1); removed.push(occupant.id); }
      // Not `present: false` — that means TORN OFF, and a yard that never
      // fitted the turret in the first place is a different fact about the ship.
      // The socket and its mounting stubs stay, empty.
      ctx.sockets[i] = { ...ctx.sockets[i], occupiedBy: null };
    }
  }
  if (lost.size > 0) {
    for (let i = ctx.hardpoints.length - 1; i >= 0; i--) if (lost.has(ctx.hardpoints[i].socketId)) ctx.hardpoints.splice(i, 1);
    for (let i = ctx.docks.length - 1; i >= 0; i--) if (lost.has(ctx.docks[i].socketId)) ctx.docks.splice(i, 1);
  }

  // The gameplay records carry their own copies of the same measurement, and a
  // turret whose published arc is the one it had before the radiator went on is
  // worse than no published arc at all.
  for (let i = 0; i < ctx.hardpoints.length; i++) {
    const h = ctx.hardpoints[i];
    const c = newCone.get(h.socketId);
    if (c !== undefined && c !== h.clearArc) ctx.hardpoints[i] = { ...h, clearArc: c };
  }
  for (let i = 0; i < ctx.docks.length; i++) {
    const d = ctx.docks[i];
    const c = newCone.get(d.socketId);
    const l = newClear.get(d.socketId);
    if (c === undefined || l === undefined) continue;
    if (c !== d.approachCone || l !== d.approachClearance) {
      ctx.docks[i] = { ...d, approachCone: c, approachClearance: l };
    }
  }
  return removed;
}

/**
 * Re-measure the undercarriage against the finished hull.
 *
 * The gear was sized in stage 5, but stages 6 and 7 add tanks, strakes and
 * ventral pods that can reach below it. "Clearance below every other part"
 * (BRIEF §5) is only true if it is checked against the ship that actually
 * exists, so the legs are re-measured and either lengthened or refused.
 */
function settleLandingGear(ctx: Ctx): void {
  const ls = ctx.landing;
  if (!ls) return;
  let lowest = 0;
  for (const v of ctx.volumes) {
    const b = boundsOf(ctx, v);
    if (b.min[1] < lowest) lowest = b.min[1];
  }
  const clearGround = Math.max(HUMAN_HEIGHT_KM, ctx.prop.heightKm * 0.06);
  const wantHeight = -lowest + clearGround;
  if (ls.staticHeight >= wantHeight) {
    ctx.landing = { ...ls, lowestFixedPoint: lowest };
    return;
  }

  const grow = wantHeight - ls.staticHeight;
  const maxLeg = Math.max(ctx.prop.heightKm, ctx.prop.beamKm * 0.5) * 1.4 + clearGround;
  const legs = ls.legs.map((l) => ({
    ...l,
    length: Math.min(maxLeg, l.length + grow),
    contactPoint: [l.contactPoint[0], l.contactPoint[1] - Math.min(maxLeg - l.length, grow), l.contactPoint[2]] as Vec3,
  }));
  const reached = -Math.min(...legs.map((l) => l.contactPoint[1]));
  if (reached < wantHeight * 0.999) {
    reject(ctx, {
      stage: 'landing',
      rule: 'gear-not-lowest',
      what: 'gear cannot reach past a ventral part added after it was sized',
      at: [0, lowest, 0],
      measured: reached,
      required: wantHeight,
      attempt: 2,
    });
    ctx.landing = null;
    return;
  }
  ctx.landing = { ...ls, legs, staticHeight: reached, lowestFixedPoint: lowest };
}

/**
 * A ship's name.
 *
 * `gen/names.ts` has generators for galaxies, systems, stars, planets, moons
 * and nebulae but none for ships, so this is local. Two-part, noir register,
 * and only used when the faction actually names its hulls — a culture that
 * paints numbers on its ships is making a statement (`MarkingDna.namesShips`).
 */
const NAME_HEAD: readonly string[] = [
  'Ashen', 'Cold', 'Long', 'Slow', 'Quiet', 'Iron', 'Salt', 'Black', 'Grey', 'Last',
  'Low', 'Dry', 'Hollow', 'Far', 'Blind', 'Patient', 'Broken', 'Second', 'Bitter', 'Half',
];
const NAME_TAIL: readonly string[] = [
  'Meridian', 'Ledger', 'Errand', 'Harbour', 'Compass', 'Anchor', 'Verdict', 'Tally',
  'Interval', 'Lantern', 'Reckoning', 'Passage', 'Draught', 'Signal', 'Margin',
  'Testament', 'Furlong', 'Debt', 'Watch', 'Remittance',
];

function shipName(seed: number, faction: FactionDna, registry: string): string {
  if (!faction.markings.namesShips) return registry;
  const rng = new Rng(shipSubSeed(seed, 'name'));
  return `${rng.pick(NAME_HEAD)} ${rng.pick(NAME_TAIL)}`;
}

// ===========================================================================
// The pipeline
// ===========================================================================

function newContext(params: ShipParams, id: Identity, spine: StructuralSpine): Ctx {
  return {
    seed: params.seed >>> 0,
    version: params.generationVersion ?? SHIP_GENERATION_VERSION,
    role: id.role,
    spec: id.spec,
    dna: id.dna,
    faction: id.faction,
    hull: id.hull,
    factionId: id.factionId,
    sizeClass: id.sizeClass,
    archetype: id.archetype,
    tech: id.tech,
    prop: id.prop,
    accelMs2: id.accelMs2,
    drive: id.drive,
    palette: paletteFor(id.faction, id.hull),
    volumes: [],
    sockets: [],
    modules: [],
    engines: [],
    thrusters: [],
    hardpoints: [],
    docks: [],
    connections: [],
    damage: [],
    repairs: [],
    markings: [],
    instancing: [],
    lamps: [],
    rejections: [],
    bounds: [],
    moduleBounds: [],
    mounts: new Map(),
    counters: new Map(),
    spine,
    landing: null,
    plumeLengthKm: 0,
    standoffs: 0,
    bow: null,
  };
}

/**
 * Generate one ship.
 *
 * The eight stages of BRIEF §4 in order, then the rebase, then history, then
 * the derived profiles. Each stage reads only what earlier stages produced —
 * which is why the rebase can happen exactly once, after all geometry exists
 * and before any of it is described.
 */
export function generateShip(params: ShipParams): GeneratedShip {
  massIntegrations = 0;
  const version = params.generationVersion ?? SHIP_GENERATION_VERSION;
  const id = identity(params); //                          1  role and family
  const spine = buildSpine(id, params.seed); //            2  the load path
  const ctx = newContext(params, id, spine);

  buildPrimary(ctx); //                                    3  the silhouette
  const drive = buildDrive(ctx); //                        4  thrust through CoM
  placeModules(ctx); //                                    5  sockets + modules
  buildSecondary(ctx); //                                  6  tanks, wings, booms
  buildAccents(ctx); //                                    7  the recognisable shapes
  // Post-condition on stages 2–7, checked before the detail pass so no greeble
  // can be mistaken for the thing that saved the silhouette. See
  // `ensureSpanningStructure`: the outline has to close round daylight.
  ensureSpanningStructure(ctx);
  buildGreebles(ctx); //                                   8  detail, last

  // History comes BEFORE the balance, not after. A torn-off module is a real
  // change to the mass distribution — that is the point of `present: false` —
  // so a hull balanced before its history is balanced for a ship that no longer
  // exists. Wounds are placed in pre-rebase coordinates and travel with the
  // hull when it is rebased, which `applyShift` handles.
  buildHistory(ctx, clamp01(params.damageLevel ?? (ctx.role === 'derelict' ? 0.85 : 0.35)));

  // The undercarriage is re-measured next, because lengthening a leg moves the
  // balance point and there is no point balancing a hull twice.
  settleLandingGear(ctx);
  // Origin to the centre of mass, thrust line through it. See `balance`.
  const mass = balance(ctx);

  // Every clearance a BRIEF §5 rule turns on is measured again HERE, after the
  // balance rather than before it — because the balance MOVES things. It
  // rebases the origin, walks the engine cluster onto the thrust line and, as
  // of this round, trims the load laterally, and a corridor measured before
  // any of that is a corridor on a hull that no longer exists. Running the
  // pass on the wrong side of the balance put three engines in sixteen behind
  // a drum that the trim had slid into their exhaust.
  const dropped = remeasureClearances(ctx);
  // Anything this pass REFUSED took its mass off the ship after the balance
  // had already been struck, and the origin is the dry centre of mass by
  // contract. Removing mass `m` sitting at `c` moves the balance point to
  // −m·c/(M−m); shifting the hull by the negative of that puts it back, and
  // the relation is exact, so no second integration is needed. Two hulls in
  // sixty — a 4.2 km carrier and a 3.1 km colony ship — were coming out with
  // their origin 1.7 m and 2.8 m off, which `mass/CoM` duly reported.
  if (dropped.length > 0) {
    const ids = new Set(dropped);
    let mk = 0;
    const mc: MutVec3 = [0, 0, 0];
    for (const it of mass.items) {
      if (!ids.has(it.id)) continue;
      mk += it.massKg;
      mc[0] += it.massKg * it.centre[0];
      mc[1] += it.massKg * it.centre[1];
      mc[2] += it.massKg * it.centre[2];
    }
    const rest = mass.dryMassKg - mk;
    if (mk > 0 && rest > 1) {
      applyShift(ctx, [mc[0] / rest, mc[1] / rest, mc[2] / rest]);
    }
  }

  auditLandingFootprint(ctx);
  // The quads were placed in stage 4 against a hull that did not exist yet.
  retuneRcs(ctx, mass);

  // The spine was sized against an estimated thrust before any volume existed.
  // Now that the real number is known, the load path is rescaled — otherwise a
  // hull whose mass came out differently carries a truss sized for another ship.
  const estimated = estimateMassKg(ctx.prop) * 1.35 * Math.max(1e-6, ctx.accelMs2);
  const loadScale = drive.totalThrustN > 0 ? drive.totalThrustN / estimated : 1;
  ctx.spine = {
    ...ctx.spine,
    chains: ctx.spine.chains.map((c) => ({ ...c, nodes: c.nodes.map((n) => ({ ...n, loadN: n.loadN * loadScale })) })),
  };

  const registry = registryFor(ctx.faction, ctx.seed);
  const name = shipName(ctx.seed, ctx.faction, registry);
  const markings = buildMarkings(ctx, registry, name);
  const dims = shipDimensions(ctx, mass.pressurisedVolumeM3);

  const physicsInput = {
    role: ctx.role,
    technologyProfile: ctx.tech,
    primaryVolumes: ctx.volumes as readonly PrimaryVolume[],
    modules: ctx.modules as readonly ShipModule[],
    engines: ctx.engines as readonly EnginePod[],
    thrusters: ctx.thrusters as readonly RcsThruster[],
    hardpoints: ctx.hardpoints as readonly Hardpoint[],
    dockingPoints: ctx.docks as readonly DockingPort[],
    landingSystem: ctx.landing,
  };
  const physics = shipPhysicsProfile(physicsInput);
  auditThrustAxis(ctx, physics);
  auditThrustDelivered(ctx, physics);

  const rng = new Rng(shipSubSeed(ctx.seed, 'name'));
  const threat = ctx.hardpoints.reduce((s, h) => s + h.threatWeight, 0);
  const crew = ctx.tech.pressurised ? Math.max(0, Math.round(sampleRange(ctx.spec.crew, rng))) : 0;

  const scanBase: ScanProfile = {
    displayName: name,
    className: shipClassName(ctx.faction, roleById(ctx.role), ctx.sizeClass),
    registry,
    operator: ctx.faction.name,
    role: ctx.role,
    sizeClass: sizeClassFor(dims.lengthKm),
    massTonnes: physics.dryMassKg / 1000,
    lengthM: dims.lengthKm * 1000,
    crew,
    cargoCapacityM3: physics.cargoVolumeM3,
    threat: clamp01(Math.max(band(rng, ctx.spec.threat), Math.min(1, threat))),
    threatClass: ctx.spec.threatClass,
    thermalSignature: clamp01(band(rng, ctx.spec.thermalSignature)),
    radarSignature: clamp01(band(rng, ctx.spec.radarSignature)),
    emSignature: clamp01(band(rng, ctx.spec.emSignature)),
    subsystems: subsystems(ctx),
    lines: [],
    blurb: `${ctx.spec.blurb} ${ctx.faction.blurb}`,
  };

  const base: ShipBlueprint = {
    id: shipBlueprintId(ctx.seed, version),
    seed: ctx.seed,
    generationVersion: version,
    name,
    factionId: ctx.factionId,
    familyId: ctx.hull.id,
    role: ctx.role,
    sizeClass: sizeClassFor(dims.lengthKm),
    technologyProfile: ctx.tech,
    dimensions: dims,
    structuralSpine: ctx.spine,
    primaryVolumes: ctx.volumes,
    sockets: ctx.sockets,
    modules: ctx.modules,
    connections: ctx.connections,
    engines: ctx.engines,
    thrusters: ctx.thrusters,
    hardpoints: ctx.hardpoints,
    dockingPoints: ctx.docks,
    landingSystem: ctx.landing,
    palette: ctx.palette,
    materialProfiles: materialProfiles(ctx),
    damageHistory: ctx.damage,
    repairHistory: ctx.repairs,
    markings,
    physics,
    scan: scanBase,
    renderProfile: renderProfile(ctx, dims),
  };

  // `shipScanLines` formats from a finished blueprint, so the profile is filled
  // in two passes: everything but the lines, then the lines. Formatting lives in
  // pure data so the HUD stays a typewriter (`types.ts`).
  const scan: ScanProfile = { ...scanBase, lines: shipScanLines(base).slice(0, SCAN_MAX_LINES) };

  return { ...base, scan, archetype: ctx.archetype, placementLog: ctx.rejections };
}

/**
 * A fleet from one yard.
 *
 * Used by the review shots to show a family together, which is the only way to
 * check BRIEF §8's two hardest criteria at once: that the faction's DNA is
 * recognisable across seeds, and that the seeds are genuinely different ships
 * rather than the same ship redressed. So the faction is pinned and the roles
 * and sizes are not — and roles are walked rather than sampled, so a fleet of
 * six is six roles rather than four freighters and a coincidence.
 */
export function generateFleet(seed: number, count: number): GeneratedShip[] {
  const rng = new Rng(shipSubSeed(seed, 'family'));
  const factionId = pickFaction(rng, 'freighter', undefined).id;
  const roles = ALL_ROLES.filter((r) => factionRoleWeight(tryFactionById(factionId) ?? FACTIONS[0], r) > 0);
  const out: GeneratedShip[] = [];
  for (let i = 0; i < Math.max(0, count); i++) {
    out.push(generateShip({
      seed: hashSeed(seed >>> 0, `fleet/${i}`),
      factionId,
      role: roles.length > 0 ? roles[i % roles.length] : undefined,
    }));
  }
  return out;
}

// ===========================================================================
// Self-test
//
// Determinism is the acceptance test, but it is not the interesting one: a
// generator that returns the same ship for every seed is perfectly
// deterministic. The variation section below is the one that decides whether
// this system works, and it reports the ACTUAL spread rather than asserting a
// bound — a number a reviewer can disagree with is worth more than a green tick.
// ===========================================================================

interface Stat {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly cv: number;
}

function statOf(xs: readonly number[]): Stat {
  if (xs.length === 0) return { min: 0, max: 0, mean: 0, cv: 0 };
  let min = Infinity, max = -Infinity, sum = 0;
  for (const x of xs) { if (x < min) min = x; if (x > max) max = x; sum += x; }
  const mean = sum / xs.length;
  let v = 0;
  for (const x of xs) v += (x - mean) * (x - mean);
  const sd = Math.sqrt(v / xs.length);
  return { min, max, mean, cv: mean !== 0 ? sd / Math.abs(mean) : 0 };
}

function fmt(n: number, dp = 3): string {
  if (!Number.isFinite(n)) return String(n);
  return Math.abs(n) >= 1000 || (Math.abs(n) < 0.001 && n !== 0) ? n.toExponential(2) : n.toFixed(dp);
}

/**
 * Run every check and return the report, one line per finding.
 *
 * Lines beginning `FAIL` are defects; `WARN` is a number worth an argument;
 * everything else is evidence.
 */
export function shipSelfTest(): string[] {
  const out: string[] = [];
  const N = 200;

  // --- determinism ---------------------------------------------------------
  {
    const cases: readonly ShipParams[] = [
      { seed: 1 },
      { seed: 0xdecafbad, role: 'freighter' },
      { seed: 77, role: 'miner', sizeClass: 'heavy' },
      { seed: 4242, role: 'carrier', factionId: FACTIONS[0].id },
      { seed: 999, role: 'derelict', ageYears: 120, damageLevel: 1, maintenance: 0 },
    ];
    let bad = 0;
    for (const c of cases) {
      const a = JSON.stringify(generateShip(c));
      const b = JSON.stringify(generateShip(c));
      if (a !== b) { bad++; out.push(`FAIL determinism: seed ${c.seed} role ${c.role ?? 'auto'} differs between runs`); }
      // A blueprint must survive JSON round-tripping unchanged — that is how a
      // regression test pins a hull and how two seeds are diffed (`types.ts`).
      const round = JSON.stringify(JSON.parse(a));
      if (round !== a) { bad++; out.push(`FAIL determinism: seed ${c.seed} is not JSON-stable (Infinity/NaN/undefined in the blueprint?)`); }
    }
    // Order independence: generating another ship in between must not shift the
    // stream, which is the failure mode a shared `Rng` would produce.
    const solo = JSON.stringify(generateShip({ seed: 31337 }));
    generateShip({ seed: 12 });
    const after = JSON.stringify(generateShip({ seed: 31337 }));
    if (solo !== after) { bad++; out.push('FAIL determinism: generation order affects output (a stage is sharing an Rng)'); }
    out.push(`determinism: ${bad === 0 ? 'OK' : `${bad} FAILURES`} — 5 cases, byte-identical repeats + JSON round-trip + order independence`);
  }

  // --- one detailed hull ---------------------------------------------------
  const probe = generateShip({ seed: 0xbeef, role: 'freighter', sizeClass: 'heavy' });
  out.push(`probe: ${probe.id} ${probe.scan.className} — ${probe.archetype}, ${fmt(probe.dimensions.lengthKm * 1000, 0)} m, ${probe.primaryVolumes.length} volumes, ${probe.modules.length} modules, ${probe.sockets.length} sockets`);

  // --- socket legality -----------------------------------------------------
  {
    let bad = 0;
    let checked = 0;
    let occupancyErrors = 0;
    const seeds = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
    for (const s of seeds) {
      const bp = generateShip({ seed: s });
      const byId = new Map(bp.sockets.map((k) => [k.id, k]));
      for (const m of bp.modules) {
        checked++;
        const sock = byId.get(m.socketId);
        if (!sock) { bad++; out.push(`FAIL socket: module ${m.id} (${m.kind}) references a socket that does not exist`); continue; }
        if (sock.type !== MODULE_SOCKET[m.kind]) { bad++; out.push(`FAIL socket: ${m.kind} on a '${sock.type}' socket`); }
        if (sock.accepts.length > 0 && !sock.accepts.includes(m.kind)) { bad++; out.push(`FAIL socket: ${m.kind} not in the accept list of ${sock.id}`); }
        // The GEOMETRIC bars apply to what is actually on the hull. A module
        // with `present: false` was torn off: its half-extents describe a part
        // that is not there any more, and asking whether it fits the corridor
        // it used to sit in is a question about a ship that no longer exists.
        // `remeasureClearances` shortens a socket's published clearance after
        // the fact — that is its job — so an absent module reliably fails a bar
        // it is not subject to, which is exactly what this said when the loss
        // rate went up. The identity bars above still apply to every row,
        // because a socket reference has to stay valid whatever happened to the
        // thing that was bolted to it.
        if (m.present && m.halfExtents[2] * 2 > sock.clearance * 1.0001) { bad++; out.push(`FAIL socket: ${m.kind} is ${fmt(m.halfExtents[2] * 2)} km deep into ${fmt(sock.clearance)} km of clearance`); }
        if (m.present && m.massKg > sock.budget.massKg * 1.0001) { bad++; out.push(`FAIL socket: ${m.kind} exceeds the mount's mass rating`); }
        if (sock.occupiedBy !== m.id) occupancyErrors++;
        if (!Number.isFinite(sock.clearance)) { bad++; out.push(`FAIL socket: ${sock.id} has a non-finite clearance (types.ts forbids Infinity)`); }
      }
      for (const e of bp.engines) {
        const sock = byId.get(e.socketId);
        if (!sock || sock.type !== 'engine') { bad++; out.push(`FAIL socket: engine ${e.id} is not on an engine socket`); }
      }
    }
    if (occupancyErrors > 0) out.push(`FAIL socket: ${occupancyErrors} sockets do not name their occupant`);
    out.push(`socket legality: ${bad === 0 && occupancyErrors === 0 ? 'OK' : `${bad + occupancyErrors} FAILURES`} — ${checked} module mounts over ${seeds.length} hulls (type, accept list, envelope, mass, measured clearance)`);
  }

  // --- the framing contract: bounds and boundingRadius describe ONE ship ---
  //
  // A review harness fits its camera to the box corners on some shots and to
  // the sphere on others. If the two disagree, half the review is framed for a
  // different vessel than the other half — and that is not hypothetical: round
  // three's silhouette frames were unusable, and the first thing anyone asked
  // was whether these two numbers agreed. They must, by construction, and now
  // that is asserted rather than assumed. `boundingRadius` is the corner of
  // `bounds` furthest from the origin, so it can never be smaller than the
  // furthest face and never larger than the furthest corner.
  {
    let bad = 0;
    let worstOut = 0;
    for (let i = 0; i < 200; i++) {
      const bp = generateShip({ seed: hashSeed(0xb0d1e5, `bounds/${i}`) });
      const b = bp.dimensions.bounds;
      const face = Math.max(
        Math.abs(b.min[0]), Math.abs(b.max[0]),
        Math.abs(b.min[1]), Math.abs(b.max[1]),
        Math.abs(b.min[2]), Math.abs(b.max[2]),
      );
      const corner = aabbRadiusFromOrigin(b);
      const r = bp.dimensions.boundingRadius;
      if (!(r >= face - 1e-9 && r <= corner * 1.05 + 1e-9)) bad++;
      // Every LOD0 part inside the box. Volumes are sampled by `volumeBounds`;
      // modules and bells are exact, so a leak here is a part the box forgot.
      let out = 0;
      const test = (p: Vec3, pad: number): void => {
        out = Math.max(out,
          b.min[0] - p[0] - pad, p[0] - b.max[0] - pad,
          b.min[1] - p[1] - pad, p[1] - b.max[1] - pad,
          b.min[2] - p[2] - pad, p[2] - b.max[2] - pad);
      };
      for (const m of bp.modules) {
        if (!m.present) continue;
        const h = Math.hypot(m.halfExtents[0], m.halfExtents[1], m.halfExtents[2]);
        test(m.frame.origin, h);
      }
      for (const e of bp.engines) test(e.frame.origin, e.nozzle.exitRadius + e.nozzle.clusterRadius);
      const tol = Math.max(1e-9, bp.dimensions.lengthKm * 1e-3);
      if (out > tol) bad++;
      worstOut = Math.max(worstOut, out / Math.max(1e-9, bp.dimensions.lengthKm));
    }
    out.push(`framing contract: ${bad === 0 ? 'OK' : `FAIL ${bad}`}/200 seeds — boundingRadius is a corner of bounds, and bounds encloses every LOD0 part (worst leak ${fmt(worstOut * 100, 3)}% of length)`);
  }

  // --- BRIEF §5 placement rules -------------------------------------------
  //
  // Every verdict here is labelled `measured` or `declared`, and four of the
  // seven changed sides this round. A reader could not previously tell
  // `radiator-exposed` (which samples 40 surface points per panel) from
  // `approach-corridor` (which compared one blueprint field against another
  // and never fired a ray), and they were printed on the same line in the same
  // format. A sweep that restates a field the generator wrote cannot fail.
  {
    // Armed roles are forced into the set, because the old seed list produced
    // eight weapon hardpoints across sixteen hulls — half a gun per ship —
    // and one bad hull could not have moved the count.
    const seeds = [7, 11, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73];
    const cases: ShipParams[] = seeds.map((seed) => ({ seed }));
    for (const r of ['patrol', 'gunship', 'carrier', 'salvager', 'miner'] as const) {
      for (let i = 0; i < 3; i++) cases.push({ seed: hashSeed(0x5eed5, `${r}/${i}`), role: r });
    }

    let exhaust = 0, cockpit = 0, gear = 0, radiator = 0, weapon = 0, docking = 0, thrust = 0;
    let cockpits = 0, radiators = 0, weapons = 0, dockings = 0, geared = 0;
    let logged = 0;
    const viewFractions: number[] = [];
    let worstForwardDot = 1;
    const ladenOffsets: number[] = [];

    for (const c of cases) {
      const bp = generateShip(c);
      logged += bp.placementLog.length;
      const byId = new Map(bp.sockets.map((k) => [k.id, k]));
      const cv = clearanceViewOf(bp);

      for (const e of bp.engines) {
        const sock = byId.get(e.socketId);
        // A bell's exhaust cone must be clear. `clearAngle` was measured at
        // generation time; anything below the plume half-angle melts the hull.
        if (sock && sock.clearAngle < 0.09) exhaust++;
      }
      for (const m of bp.modules) {
        const sock = byId.get(m.socketId);
        if (!sock) continue;
        if (m.kind === 'cockpit' || m.kind === 'bridge-tower') {
          cockpits++;
          // MEASURED, on the finished hull, with the same fan the generator
          // accepted the site against. The old test read `sock.clearAngle`,
          // which is a saturating cone scalar: it came back 1.500 (the top of
          // `CONE_ANGLES`) on seven hulls in eight and 0.000 on the last, so
          // it had two reachable outcomes and could not distinguish a slit
          // from a canopy.
          const v = commandView(bp, cv, m, sock);
          viewFractions.push(v.fraction);
          worstForwardDot = Math.min(worstForwardDot, v.forwardDot);
          if (v.fraction < MIN_VIEW_FRACTION || v.forwardDot < MIN_VIEW_FORWARD_DOT) cockpit++;
        }
        if (m.kind === 'radiator-panel') {
          radiators++;
          if (sock.clearance < m.halfExtents[0]) radiator++;
        }
      }
      for (const h of bp.hardpoints) {
        if (h.kind === 'mining-laser' || h.kind === 'cutter' || h.kind === 'grapple') continue;
        weapons++;
        // A turret has to TRACK. 0.3 rad is 17°, which is a gunport, not a
        // field of fire — so a trainable mount is held to 0.7 rad (40°) and
        // only a fixed forward gun, which aims by flying the ship, keeps the
        // old bar.
        const trainable = h.kind === 'turret' || h.kind === 'point-defence' || h.kind === 'tractor';
        if (h.clearArc < (trainable ? 0.7 : 0.3)) weapon++;
      }
      // MEASURED: `shipDockingFrames` marches a ray down each corridor and
      // returns `reachable`. Comparing `approachClearance` against `diameter`
      // — two fields of the same record — could not see a radiator that grew
      // across the corridor after the port was placed, which is the entire
      // reason `remeasureClearances` exists.
      for (const d of shipDockingFrames(bp)) {
        dockings++;
        if (!d.reachable) docking++;
      }
      if (bp.landingSystem) {
        geared++;
        // "Clearance below every other part": the gear's static height must put
        // the ground below the lowest non-gear point on the hull.
        if (bp.landingSystem.staticHeight < -bp.landingSystem.lowestFixedPoint) gear++;
      }
      // Thrust axis through the centre of mass — the LADEN one.
      //
      // The dry centre of mass is the origin by construction (the hull is
      // rebased onto it as the generator's last act), so checking the thrust
      // line against it was close to self-fulfilling, and the tolerance it
      // used — 5% of BEAM — was twelve times looser than the one
      // `reviewShipPhysics` applies. A freighter that only flies straight when
      // it is empty is the inverse of what a freighter is for, so the number
      // that has to hold is the worse of the two conditions against the
      // reviewer's own bar.
      //
      // BRIEF §5 allows the offset "or an explicit reason why not", so a hull
      // that could not be trimmed inside its own structure and SAYS SO in the
      // placement log is not a silent failure. `physics.ts` hard-codes
      // `thrustOffsetReason` to null and is not this module's to change, so
      // the reason lives where this generator's other refusals live.
      if (bp.physics.thrustN > 0) {
        const laden = ladenThrustOffsetKm(bp);
        ladenOffsets.push(laden * 1000);
        const off = Math.max(bp.physics.thrustOffset, laden);
        const declared = bp.placementLog.some((r) => r.rule === 'load-out-of-trim' || r.rule === 'thrust-off-axis');
        if (off > Math.max(1e-5, bp.dimensions.lengthKm * 0.004) && !declared) thrust++;
      }
    }
    const rule = (n: number, of: number, label: string): string => `${label} ${n === 0 ? 'OK' : `FAIL ${n}`}/${of}`;
    out.push(`BRIEF §5 over ${cases.length} hulls: ${[
      `${rule(exhaust, cases.length, 'exhaust-clear')} (measured)`,
      `${rule(cockpit, cockpits, 'view-cone')} (measured)`,
      `${rule(gear, geared, 'gear-lowest')} (declared, ${geared} of ${cases.length} hulls carry gear)`,
      `${rule(radiator, radiators, 'radiator-exposed')} (measured)`,
      `${rule(weapon, weapons, 'field-of-fire')} (measured, 0.7 rad on trainable mounts)`,
      `${rule(docking, dockings, 'approach-corridor')} (measured)`,
      `${rule(thrust, cases.length, 'thrust-through-CoM')} (measured, laden, 0.4% of length)`,
    ].join(', ')}`);
    const vf = statOf(viewFractions);
    const distinct = new Set(viewFractions.map((v) => Math.round(v * 50))).size;
    out.push(`  view cone: unobstructed fraction ${fmt(vf.min, 3)}–${fmt(vf.max, 3)} (mean ${fmt(vf.mean, 3)}, ${distinct} distinct values over ${viewFractions.length} bridges) — a measurement, not a cap; worst forward dot ${fmt(worstForwardDot, 3)}`);
    const lo = statOf(ladenOffsets);
    out.push(`  laden thrust offset: ${fmt(lo.min, 3)}–${fmt(lo.max, 3)} m (mean ${fmt(lo.mean, 3)}) about the LOADED centre of mass`);
    out.push(`placement log: ${logged} refusals recorded over ${cases.length} hulls (${fmt(logged / cases.length, 1)} per ship) — a generator that refuses nothing has not checked`);
  }

  // --- mass, thrust and inertia sanity ------------------------------------
  {
    const seeds: number[] = [];
    for (let i = 0; i < 60; i++) seeds.push(hashSeed(9001, `mass/${i}`));
    let comBad = 0, massBad = 0, accelBad = 0, inertiaBad = 0, areaLimited = 0;
    const accels: number[] = [];
    const dv: number[] = [];
    for (const s of seeds) {
      const bp = generateShip({ seed: s });
      const starved = bp.placementLog.some((r) => r.rule === 'thrust-below-role-band');
      if (starved) areaLimited++;
      const c = bp.physics.centreOfMass;
      if (Math.hypot(c[0], c[1], c[2]) > ORIGIN_TOLERANCE_KM) comBad++;
      if (!(bp.physics.dryMassKg > 0) || !Number.isFinite(bp.physics.dryMassKg)) massBad++;
      const I = bp.physics.inertia;
      if (!(I.pitch > 0 && I.yaw > 0 && I.roll > 0)) inertiaBad++;
      if (bp.physics.thrustN > 0 && bp.role !== 'derelict') {
        const a = bp.physics.thrustN / bp.physics.loadedMassKg;
        accels.push(a);
        dv.push(bp.physics.deltaVKmS);
        // Checked against the ROLE's own band from `families.ts`, not against a
        // global one: a colony ship at 6 m/s² and a tug at 400 are both correct,
        // and a single bound would have to be wide enough to catch neither.
        //
        // Overshooting the band is always a generator error — nothing forces a
        // drive to be bigger than the role asks for. UNDERSHOOTING is only an
        // error when the drive was not already area-limited: thrust grows with
        // the aft disc and mass with the hull, so a kilometre-long refinery
        // physically cannot accelerate like the 200-tonne boat those bands were
        // calibrated against. Those hulls log `thrust-below-role-band` and are
        // counted separately rather than being quietly forgiven.
        const want = roleById(bp.role).accelMs2;
        if (a > want[1] * 4) accelBad++;
        else if (a < want[0] * 0.25 && !starved) accelBad++;
      }
    }
    const A = statOf(accels);
    const D = statOf(dv);
    out.push(`mass/CoM: ${comBad === 0 ? 'OK' : `FAIL ${comBad}`}/${seeds.length} hulls within ORIGIN_TOLERANCE_KM of the origin; ${massBad === 0 ? 'OK' : `FAIL ${massBad}`} mass positive; ${inertiaBad === 0 ? 'OK' : `FAIL ${inertiaBad}`} inertia positive-definite`);
    out.push(`thrust: ${accelBad === 0 ? 'OK' : `FAIL ${accelBad}`} against each role's own band — loaded acceleration ${fmt(A.min, 1)}–${fmt(A.max, 1)} m/s² (mean ${fmt(A.mean, 1)}); delta-v ${fmt(D.min, 1)}–${fmt(D.max, 1)} km/s; ${areaLimited}/${seeds.length} hulls report a thrust shortfall in the log (aft area, or outfit mass the stage-4 sizing could not see)`);
  }

  // --- performance budgets (BRIEF §6) -------------------------------------
  {
    let draw = 0, mats = 0, occ = 0, lamp = 0;
    for (let i = 0; i < 40; i++) {
      const bp = generateShip({ seed: hashSeed(555, `budget/${i}`) });
      const r = bp.renderProfile;
      if (r.drawCallEstimate > 12) draw++;
      if (r.materialKeys.length > 3) mats++;
      if (r.occluderBudget > 28) occ++;
      if (r.lampBudget > 6) lamp++;
    }
    out.push(`budgets: draw calls ≤12 ${draw === 0 ? 'OK' : `FAIL ${draw}`}, materials ≤3 ${mats === 0 ? 'OK' : `FAIL ${mats}`}, occluders ≤28 ${occ === 0 ? 'OK' : `FAIL ${occ}`}, lamps ≤6 ${lamp === 0 ? 'OK' : `FAIL ${lamp}`}`);
  }

  // --- cross-seed variation, the test that actually matters ---------------
  {
    const t0 = Date.now();
    const lengths: number[] = [];
    const beams: number[] = [];
    const heights: number[] = [];
    const fineness: number[] = [];
    const volCount: number[] = [];
    const modCount: number[] = [];
    const socketCount: number[] = [];
    const engineCount: number[] = [];
    const damageCount: number[] = [];
    const archHist = new Map<string, number>();
    const roleHist = new Map<string, number>();
    const factionHist = new Map<string, number>();
    const sectionHist = new Map<string, number>();
    const modMixes = new Set<string>();
    const silhouettes = new Set<string>();

    for (let i = 0; i < N; i++) {
      const bp = generateShip({ seed: hashSeed(20260806, `sweep/${i}`) });
      const d = bp.dimensions;
      lengths.push(d.lengthKm);
      beams.push(d.beamKm);
      heights.push(d.heightKm);
      fineness.push(d.lengthKm / Math.max(1e-9, d.beamKm));
      volCount.push(bp.primaryVolumes.length);
      modCount.push(bp.modules.length);
      socketCount.push(bp.sockets.length);
      engineCount.push(bp.engines.length);
      damageCount.push(bp.damageHistory.length);
      archHist.set(bp.archetype, (archHist.get(bp.archetype) ?? 0) + 1);
      roleHist.set(bp.role, (roleHist.get(bp.role) ?? 0) + 1);
      factionHist.set(bp.factionId, (factionHist.get(bp.factionId) ?? 0) + 1);
      for (const v of bp.primaryVolumes) sectionHist.set(v.shape.family, (sectionHist.get(v.shape.family) ?? 0) + 1);
      modMixes.add(Array.from(new Set(bp.modules.map((m) => m.kind))).sort().join(','));
      // Proportion signature: the black shape at impostor range, quantised.
      // Two ships with the same signature look the same from across a system.
      silhouettes.add([
        bp.archetype,
        Math.round(Math.log(d.lengthKm / Math.max(1e-9, d.beamKm)) * 4),
        Math.round(Math.log(Math.max(1e-9, d.heightKm) / Math.max(1e-9, d.beamKm)) * 4),
        // A DEAD AXIS, until now. `Math.min(9, primaryVolumes.length)` was the
        // fourth term of the signature and the volume count runs 10 to 29, so
        // it evaluated to 9 on every seed ever generated: the metric that
        // reports how many distinct silhouettes exist was three-dimensional
        // and claimed to be four. The massing question it was reaching for is
        // "how many KINDS of mass does this hull show", which is what an
        // outline actually differs by, and that runs 5 to 13.
        new Set(bp.primaryVolumes.map((v) => v.kind)).size,
      ].join('/'));
    }
    const ms = Date.now() - t0;

    const line = (label: string, s: Stat, dp = 3): string =>
      `  ${label.padEnd(14)} min ${fmt(s.min, dp).padStart(9)}  max ${fmt(s.max, dp).padStart(9)}  mean ${fmt(s.mean, dp).padStart(9)}` +
      `  spread ${s.min > 0 ? `×${fmt(s.max / s.min, 1)}` : '(min 0)'}  cv ${fmt(s.cv, 2)}`;

    out.push(`variation over ${N} seeds (${ms} ms total, ${fmt(ms / N, 1)} ms/ship):`);
    out.push(line('length km', statOf(lengths), 4));
    out.push(line('beam km', statOf(beams), 4));
    out.push(line('height km', statOf(heights), 4));
    out.push(line('length/beam', statOf(fineness), 2));
    out.push(line('volumes', statOf(volCount), 1));
    out.push(line('modules', statOf(modCount), 1));
    out.push(line('sockets', statOf(socketCount), 1));
    out.push(line('engines', statOf(engineCount), 1));
    out.push(line('damage events', statOf(damageCount), 1));

    const hist = (m: Map<string, number>): string =>
      Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
    out.push(`  archetypes    ${archHist.size}/9 used — ${hist(archHist)}`);
    out.push(`  roles         ${roleHist.size}/18 used — ${hist(roleHist)}`);
    out.push(`  factions      ${factionHist.size}/${FACTIONS.length} used — ${hist(factionHist)}`);
    out.push(`  sections      ${hist(sectionHist)}`);
    out.push(`  module mixes  ${modMixes.size} distinct of ${N} (${fmt((modMixes.size / N) * 100, 0)}%)`);
    out.push(`  silhouettes   ${silhouettes.size} distinct proportion signatures of ${N} (${fmt((silhouettes.size / N) * 100, 0)}%)`);

    // A near-constant dimension is the failure the brief names explicitly:
    // "if any of those is nearly constant, fix the generator".
    const flat: string[] = [];
    if (statOf(lengths).cv < 0.25) flat.push('length');
    if (statOf(beams).cv < 0.25) flat.push('beam');
    if (statOf(fineness).cv < 0.15) flat.push('length/beam');
    if (statOf(volCount).cv < 0.15) flat.push('volume count');
    if (modMixes.size < N * 0.3) flat.push('module mix');
    if (archHist.size < 7) flat.push('archetype coverage');
    if (silhouettes.size < N * 0.25) flat.push('silhouette signature');
    out.push(flat.length === 0
      ? 'variation: OK — no dimension is nearly constant'
      : `FAIL variation: nearly constant — ${flat.join(', ')}`);
  }

  // --- generation time by size class (BRIEF §6: ≤ 25 ms, medium hull) -----
  {
    const classes: readonly SizeClass[] = ['shuttle', 'light', 'medium', 'heavy', 'capital', 'super-capital'];
    const parts: string[] = [];
    let mediumMs = 0;
    const reps = 12;
    const kept: GeneratedShip[] = [];
    for (const c of classes) {
      const t0 = Date.now();
      for (let i = 0; i < reps; i++) {
        const bp = generateShip({ seed: hashSeed(31, `${c}/${i}`), sizeClass: c });
        if (c === 'medium') kept.push(bp);
      }
      const per = (Date.now() - t0) / reps;
      if (c === 'medium') mediumMs = per;
      parts.push(`${c} ${fmt(per, 1)}`);
    }
    out.push(`generation time ms/ship: ${parts.join(', ')} — medium ${mediumMs <= 25 ? 'OK' : 'WARN'} against the 25 ms budget`);

    // Where the time actually goes. `shipPhysicsProfile` and the three
    // `shipMassProperties` calls the pipeline needs are `physics.ts`'s cost, not
    // this file's, and no amount of work here removes them — so the split is
    // measured and reported rather than absorbed into one opaque number.
    const t1 = Date.now();
    for (const bp of kept) shipPhysicsProfile(bp);
    const profMs = (Date.now() - t1) / kept.length;
    const t2 = Date.now();
    for (const bp of kept) shipMassProperties(bp);
    const massMs = (Date.now() - t2) / kept.length;
    // COUNTED, not assumed. The pipeline used to run four integrations while
    // this line claimed three, and `shipPhysicsProfile` runs two more inside
    // itself (`shipMassProperties` directly, and `shipFlightConfig` again),
    // which is why the profile costs what three do.
    let integrations = 0;
    for (const c of ['medium', 'medium', 'medium']) {
      generateShip({ seed: hashSeed(31, `${c}/0`), sizeClass: c as SizeClass });
      integrations = lastMassIntegrationCount();
    }
    const physicsMs = profMs + massMs * integrations;
    out.push(`  of which physics.ts: ${fmt(profMs, 1)} ms for shipPhysicsProfile + ${integrations} × ${fmt(massMs, 1)} ms shipMassProperties (drive sizing, balance) = ${fmt(physicsMs, 1)} ms; this generator's own geometry work is ${fmt(Math.max(0, mediumMs - physicsMs), 1)} ms`);
    // The two numbers in this output that measure the same thing, printed
    // together so nobody has to notice the contradiction for themselves.
    //
    // `physics.ts`'s own self-test prints "physics fits the generation budget,
    // 2.2 ms per medium hull" and it is measuring ONE isolated
    // `shipMassProperties` on a stub — no modules, no gear, a handful of
    // volumes. The generator makes a different call, on a real hull, and the
    // line above measures that. Both are honest; only one is relevant, and the
    // green one is the one a reader believes. Until `shipPhysicsProfile`
    // shares its integration with `shipFlightConfig` — it runs
    // `shipMassProperties` and then `shipFlightConfig` runs it again on the
    // same geometry — this budget cannot be met from inside this file: the
    // generator's own geometry work is well inside 25 ms and the call it has
    // to make is not.
    out.push(`  budget: ${fmt(mediumMs, 1)} ms of a 25 ms budget, ${fmt((physicsMs / Math.max(1e-9, mediumMs)) * 100, 0)}% of it inside physics.ts. Compare the physics self-test's own "${fmt(massMs, 2)} ms per medium hull" — that figure times a stub hull; this one times the call generateShip actually makes. OWNER: physics.ts (one integration shared between shipMassProperties and shipFlightConfig would return ${fmt(profMs / 3, 1)} ms of the ${fmt(profMs, 1)} ms profile).`);
  }

  // --- a fleet -------------------------------------------------------------
  {
    const fleet = generateFleet(2026, 6);
    const one = new Set(fleet.map((f) => f.factionId));
    const roles = new Set(fleet.map((f) => f.role));
    out.push(`fleet: ${fleet.length} hulls, ${one.size === 1 ? 'OK' : 'FAIL'} one faction (${Array.from(one).join('/')}), ${roles.size} distinct roles, lengths ${fleet.map((f) => fmt(f.dimensions.lengthKm * 1000, 0)).join('/')} m`);
  }

  return out;
}
