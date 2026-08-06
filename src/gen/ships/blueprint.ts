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
import type { FactionDna, HullFamily, RoleSpec as FamilyRoleSpec } from './families';
import { engineRatedThrustN, shipMassProperties, shipPhysicsProfile, shipScanLines, shipThrust } from './physics';

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
    | 'thrust-below-role-band';
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
  /** Archetype weights. Absent = this role is never built that way. */
  readonly archetypes: readonly (readonly [HullArchetype, number])[];
  /** height ÷ beam, before the archetype modifier. `families.ts` gives L/H;
   *  this narrows it, because a role can be tall without being short. */
  readonly heightRatio: Vec2;
  /** What the pods, cans and racks of this role actually contain. */
  readonly payloadKind: VolumeKind;
  /** How common in traffic. Sampling roles uniformly makes every third ship a
   *  capital, which destroys the size hierarchy BRIEF §8 asks for. */
  readonly frequency: number;
}

const ROLE_TOPOLOGY: Readonly<Record<ShipRole, RoleTopology>> = {
  shuttle: { archetypes: [['monolithic', 6], ['stacked', 2], ['slab', 1]], heightRatio: [0.7, 1.05], payloadKind: 'habitat', frequency: 9 },
  courier: { archetypes: [['monolithic', 5], ['stacked', 4], ['fork', 1]], heightRatio: [0.45, 0.8], payloadKind: 'cargo-bay', frequency: 10 },
  survey: { archetypes: [['monolithic', 4], ['stacked', 4], ['fork', 2], ['ring', 1]], heightRatio: [0.6, 0.95], payloadKind: 'habitat', frequency: 7 },
  freighter: { archetypes: [['spine-and-pod', 6], ['cluster', 3], ['stacked', 2], ['monolithic', 1]], heightRatio: [0.7, 1.15], payloadKind: 'cargo-bay', frequency: 12 },
  tanker: { archetypes: [['cluster', 5], ['spine-and-pod', 4], ['monolithic', 2], ['stacked', 1]], heightRatio: [0.85, 1.15], payloadKind: 'tank', frequency: 6 },
  miner: { archetypes: [['asymmetric', 5], ['spine-and-pod', 4], ['fork', 2], ['tower', 1]], heightRatio: [0.9, 1.4], payloadKind: 'cargo-rack', frequency: 8 },
  prospector: { archetypes: [['monolithic', 4], ['asymmetric', 4], ['stacked', 2]], heightRatio: [0.8, 1.2], payloadKind: 'cargo-rack', frequency: 7 },
  refinery: { archetypes: [['tower', 5], ['cluster', 3], ['spine-and-pod', 3], ['asymmetric', 1]], heightRatio: [1.2, 2.0], payloadKind: 'machinery', frequency: 2 },
  salvager: { archetypes: [['asymmetric', 6], ['spine-and-pod', 3], ['fork', 2], ['stacked', 1]], heightRatio: [0.85, 1.35], payloadKind: 'cargo-rack', frequency: 6 },
  tug: { archetypes: [['monolithic', 5], ['fork', 3], ['stacked', 2]], heightRatio: [0.9, 1.3], payloadKind: 'machinery', frequency: 6 },
  science: { archetypes: [['ring', 3], ['fork', 3], ['monolithic', 3], ['stacked', 2], ['cluster', 1]], heightRatio: [0.7, 1.2], payloadKind: 'habitat', frequency: 4 },
  liner: { archetypes: [['stacked', 5], ['monolithic', 3], ['ring', 3], ['spine-and-pod', 1]], heightRatio: [0.8, 1.25], payloadKind: 'habitat', frequency: 2 },
  colony: { archetypes: [['cluster', 5], ['ring', 4], ['spine-and-pod', 3], ['stacked', 1]], heightRatio: [0.95, 1.5], payloadKind: 'habitat', frequency: 1 },
  patrol: { archetypes: [['monolithic', 5], ['stacked', 3], ['fork', 2]], heightRatio: [0.5, 0.9], payloadKind: 'habitat', frequency: 6 },
  gunship: { archetypes: [['monolithic', 4], ['stacked', 4], ['slab', 2], ['fork', 1]], heightRatio: [0.45, 0.85], payloadKind: 'machinery', frequency: 4 },
  carrier: { archetypes: [['slab', 6], ['stacked', 3], ['spine-and-pod', 2]], heightRatio: [0.3, 0.55], payloadKind: 'cargo-bay', frequency: 1 },
  'station-tender': { archetypes: [['tower', 4], ['asymmetric', 4], ['cluster', 3], ['spine-and-pod', 2]], heightRatio: [1.0, 1.7], payloadKind: 'machinery', frequency: 5 },
  derelict: {
    archetypes: [
      ['spine-and-pod', 3], ['monolithic', 3], ['asymmetric', 3], ['stacked', 2],
      ['cluster', 2], ['fork', 1], ['ring', 1], ['tower', 1],
    ],
    heightRatio: [0.6, 1.4], payloadKind: 'cargo-bay', frequency: 4,
  },
};

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

  // The payload kind the role's own volume requirements name, if any; the
  // topology table's default otherwise.
  const PAYLOADS: readonly VolumeKind[] = ['cargo-bay', 'cargo-rack', 'tank', 'habitat', 'machinery', 'pod'];
  const named = role.requiredVolumeKinds.find((k) => PAYLOADS.includes(k));

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
function boundsAt(ctx: Ctx, i: number): Aabb {
  const hit = ctx.bounds[i];
  if (hit !== undefined) return hit;
  const b = volumeBounds(ctx.volumes[i]);
  ctx.bounds[i] = b;
  return b;
}

function boundsOf(ctx: Ctx, v: PrimaryVolume): Aabb {
  const i = ctx.volumes.indexOf(v);
  return i >= 0 ? boundsAt(ctx, i) : volumeBounds(v);
}

/**
 * Which volume, if any, contains `p`. The AABB test in front is what makes the
 * clearance sweeps affordable: it rejects ~90% of candidates in six compares.
 */
function occupantAt(ctx: Ctx, p: Vec3, skip: VolumeId | null): VolumeId | null {
  const vols = ctx.volumes;
  for (let i = 0; i < vols.length; i++) {
    const v = vols[i];
    if (v.id === skip) continue;
    const b = boundsAt(ctx, i);
    if (p[0] < b.min[0] || p[0] > b.max[0] || p[1] < b.min[1] || p[1] > b.max[1] || p[2] < b.min[2] || p[2] > b.max[2]) continue;
    if (volumeContains(v, p)) return v.id;
  }
  return null;
}

const _mp: MutVec3 = [0, 0, 0];

/**
 * Free distance along `dir` from `origin` before something is in the way.
 *
 * Marched rather than solved: the section families admit a closed-form ray
 * intersection only for the superellipse, and 20 steps of a containment test
 * that is itself exact gives a distance accurate to 5% of the sweep — an order
 * of magnitude finer than the clearances any of the BRIEF §5 rules turn on.
 */
function clearanceAlong(ctx: Ctx, origin: Vec3, dir: Vec3, maxDist: number, skip: VolumeId | null): number {
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    const d = (i / steps) * maxDist;
    _mp[0] = origin[0] + dir[0] * d;
    _mp[1] = origin[1] + dir[1] * d;
    _mp[2] = origin[2] + dir[2] * d;
    if (occupantAt(ctx, _mp, skip) !== null) return ((i - 1) / steps) * maxDist;
  }
  return maxDist;
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
function clearAngleAt(ctx: Ctx, origin: Vec3, dir: Vec3, testDist: number, skip: VolumeId | null): number {
  if (clearanceAlong(ctx, origin, dir, testDist, skip) < testDist * 0.999) return 0;
  const e1 = perpendicular(dir, _c1);
  vNormalize(vCross(dir, e1, _c2), _c2);
  let best = CONE_ANGLES[0];
  for (const a of CONE_ANGLES) {
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
      if (clearanceAlong(ctx, origin, _cd, testDist, skip) < testDist * 0.999) ok = false;
    }
    if (!ok) break;
    best = a;
  }
  return best;
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
  readonly counters: Map<string, number>;
  readonly palette: ShipPalette;

  spine: StructuralSpine;
  landing: LandingSystem | null;
  /** Filled by stage 4 so later stages can keep clear of the plume. */
  plumeLengthKm: number;
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
  const archetype = pickWeighted(rng, spec.archetypes);

  // Length is log-uniform inside the class band: the bands span a factor of
  // 2.5–4, and a uniform draw over that puts two thirds of the fleet in the top
  // half of every class, which reads as "they are all the big one".
  const lengthKm = logBand(rng, SIZE_CLASS_LENGTH_KM[sizeClass]);

  const mod = ARCHETYPE_PROPORTION[archetype];
  const fineness = clamp(band(rng, spec.fineness) * mod.fineness, 1.05, 16);
  const heightRatio = clamp(band(rng, spec.heightRatio) * mod.height, 0.18, 3.0);
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

  const prop: Proportions = {
    lengthKm,
    beamKm,
    heightKm,
    widestAt: rng.range(0.22, 0.72),
    // Nose bluntness is where a working hull separates from a fast one: a
    // freighter's bow is a flat face with a door in it, a courier's is a point.
    noseEnd: clamp01(rng.range(0.06, 0.9) * (spec.accelMs2[1] > 150 ? 0.55 : 1.0) + (archetype === 'slab' ? 0.25 : 0)),
    tailEnd: rng.range(0.45, 0.98),
    noseSharp: rng.range(0.45, 2.0),
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
  opts?: { readonly offset?: Vec2; readonly isFrame?: boolean; readonly hardEdge?: boolean; readonly exponent?: number },
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
    twist: 0,
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

  const stations: VolumeStation[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    stations.push(station(t, a.halfWidth * prof(t), a.halfHeight * profY(t), scalars, {
      offset: a.offsetFn ? a.offsetFn(t) : [0, 0],
      isFrame: i % frameEvery === 0,
      hardEdge: (i === 0 && a.hardStart === true) || false,
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
      for (let i = 0; i < n; i++) {
        const z = keelZ0 + (span / n) * i;
        addPod(axialFrame(0, -(keelR + r * 0.85), z), len, r, r * 0.8, null, (z - keelZ0) / (keelZ1 - keelZ0));
      }
      break;
    }
    case 'lateral': {
      const n = rng.int(1, 3);
      const len = (span / n) * 0.88;
      const r = Math.sqrt(clamp(cargoFrac, 0.1, 0.8)) * p.beamKm * 0.34;
      const x = keelR + r * rng.range(0.9, 1.25);
      for (let i = 0; i < n; i++) {
        const z = keelZ0 + (span / n) * i;
        const t = (z - keelZ0) / (keelZ1 - keelZ0);
        const a = addPod(axialFrame(x, 0, z), len, r, r * rng.range(0.9, 1.3), null, t);
        addPod(axialFrame(-x, 0, z), len, r, r * rng.range(0.9, 1.3), a.id, t);
      }
      break;
    }
    default: {
      // Radial: three or four pods clocked round the keel. Symmetric about the
      // vertical because the set {π/2 + 2πk/n} is closed under θ → π−θ.
      const n = rng.int(3, 4);
      const len = span * rng.range(0.6, 0.85);
      const r = Math.sqrt(clamp(cargoFrac, 0.1, 0.8)) * Math.max(p.beamKm, p.heightKm) * 0.3;
      const rr = keelR + r * 1.05;
      for (let i = 0; i < n; i++) {
        const a = Math.PI / 2 + (i / n) * TAU;
        addPod(axialFrame(Math.cos(a) * rr, Math.sin(a) * rr, keelZ0 + (span - len) * 0.5), len, r, r, null, 0.5);
      }
      break;
    }
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
  const gx = side * (p.beamKm * rng.range(0.24, 0.36));
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
  // reads as having been modified to take the load, which is the story.
  ctx.volumes.push(sweptVolume(ctx, rng, {
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
  const mass = shipMassProperties(physicsView(ctx));
  const dryCom = mass.centreOfMass;
  const loadedKg = mass.loadedMassKg;

  const live = ctx.accelMs2 > 0;
  const totalThrustN = live ? loadedKg * ctx.accelMs2 : 0;

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
  const areaTotalM2 = totalThrustN / thrustPerM2;

  // Packing: for a ring of n bells at radius R the chord between neighbours is
  // 2R·sin(π/n), so R ≥ 1.05·r/sin(π/n). The cluster then spans R + r, and that
  // has to stay inside 1.4× the aft radius — a bell may overhang the hull it is
  // bolted to (every real high-thrust vehicle's engines are wider than the tank
  // above them) but a drive twice the width of its own ship is not a ship.
  const packK = (n: number): number => (n <= 1 ? 0 : n === 2 ? 1.05 : 1.05 / Math.sin(Math.PI / n));
  const rLimit = (n: number): number => (aftR * 1.4) / (packK(n) + 1);

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
    const ideal = areaTotalM2 / (Math.PI * Math.pow(rPref * 1000, 2) * throats);
    const candidates = [1, 2, 3, 4, 6, 8, 10, 12];
    const feasible = candidates.filter((n) => capArea(n) >= areaTotalM2);
    if (feasible.length > 0) {
      let best = feasible[0];
      let bestErr = Infinity;
      for (const n of feasible) {
        const err = Math.abs(Math.log(n / Math.max(1e-9, ideal)));
        if (err < bestErr) { bestErr = err; best = n; }
      }
      count = best;
    } else {
      // Nothing fits. Fall back to the smallest count this yard builds, which
      // is the one that leaves the most exit area.
      const legal = prop.engineCounts.length > 0 ? prop.engineCounts : [1, 2];
      count = clamp(Math.min(...legal), 1, 12);
    }
  }

  const rNeed = areaTotalM2 > 0 ? Math.sqrt((areaTotalM2 / count / throats) / Math.PI) / 1000 : 0;
  // Where the geometry cannot deliver the area, the ship is simply less
  // powerful than its role would like. That is the square-cube law — thrust
  // grows with the aft disc (L²) and mass with the hull (L³) — and it is a fact
  // about big ships, not a number to fudge. It is recorded below.
  const exitRadius = clamp(rNeed > 0 ? rNeed : rPref, HATCH_WIDTH_KM * 0.4, rLimit(count) || aftR * 1.4);
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

  const placed: EnginePod[] = [];
  for (let i = 0; i < layout.length; i++) {
    let ox = dryCom[0] + layout[i][0] * clusterR;
    let oy = dryCom[1] + layout[i][1] * clusterR;
    let oz = aftZ + bellLen * 0.15;
    let ok = false;
    let attempt = 0;

    // Retry loop: an exhaust that intersects the hull is the first rule in
    // BRIEF §5, so the pod is walked outboard and aft rather than emitted and
    // apologised for. Four attempts, then the pod is refused outright.
    for (; attempt < 4; attempt++) {
      const throat: Vec3 = [ox, oy, oz];
      const need = Math.max(ctx.plumeLengthKm * 0.35, exitRadius * 3);
      const free = clearanceAlong(ctx, throat, FWD_Z, need, null);
      const cone = clearAngleAt(ctx, throat, FWD_Z, Math.min(need, exitRadius * 4), null);
      // The plume half-angle: a bell's exhaust spreads ~9°, a grid ~5°.
      const plumeHalfAngle = style === 'grid' || style === 'plate' ? 0.09 : 0.16;
      if (free >= need * 0.999 && cone >= plumeHalfAngle) { ok = true; break; }
      reject(ctx, {
        stage: 'propulsion',
        rule: 'exhaust-intersects-hull',
        what: `engine ${i} (${style})`,
        at: [ox, oy, oz],
        measured: free < need * 0.999 ? free : cone,
        required: free < need * 0.999 ? need : plumeHalfAngle,
        attempt,
      });
      ox *= 1.25;
      oy *= 1.25;
      oz += bellLen * 0.6;
    }
    if (!ok) continue;

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
  const host = ctx.volumes.find((v) => v.kind === 'hull' || v.kind === 'forebody' || v.kind === 'boom') ?? ctx.volumes[0];
  if (!host) return;

  interface Raw { pos: Vec3; exhaust: Vec3; cluster: string; }
  const raws: Raw[] = [];

  // Radial nozzles at four clock positions on two or three rings. Between them
  // these give both translation axes and both rotation axes that a normal force
  // can produce: a dorsal nozzle forward and a ventral one aft is a pitch
  // couple, and the same pattern in X is yaw.
  for (let si = 0; si < stations; si++) {
    const t = stations === 2 ? (si === 0 ? 0.12 : 0.86) : 0.1 + (si / (stations - 1)) * 0.78;
    for (let q = 0; q < 4; q++) {
      const theta = q * (Math.PI / 2);
      const p = volumeSurfacePoint(host, t, theta, [0, 0, 0]);
      const n = surfaceNormal(host, t, theta, [0, 0, 0]);
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
    const p = volumeSurfacePoint(host, rollT, theta, [0, 0, 0]);
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
    const fwd = volumeSurfacePoint(host, 0.06, theta, [0, 0, 0]);
    raws.push({ pos: [fwd[0], fwd[1], fwd[2]], exhaust: [0, 0, -1], cluster: 'rcsfwd' });
    const aft = volumeSurfacePoint(host, 0.94, theta, [0, 0, 0]);
    raws.push({ pos: [aft[0], aft[1], aft[2]], exhaust: [0, 0, 1], cluster: 'rcsaft' });
  }

  // Unit-thrust authority per axis, so the nozzles can be scaled to a target
  // rate rather than given a number that happens to feel right.
  let tx = 0, ty = 0, tz = 0;
  const rows = raws.map((r) => {
    const fx = -r.exhaust[0], fy = -r.exhaust[1], fz = -r.exhaust[2];
    const rx = r.pos[0] - com[0], ry = r.pos[1] - com[1], rz = r.pos[2] - com[2];
    const cx = ry * fz - rz * fy;
    const cy = rz * fx - rx * fz;
    const cz = rx * fy - ry * fx;
    tx += Math.abs(cx); ty += Math.abs(cy); tz += Math.abs(cz);
    return { r, f: [fx, fy, fz] as Vec3, c: [cx, cy, cz] as Vec3 };
  });

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
  // An axis with no authority must be reported, never divided by. The floor is
  // 2% of the strongest axis: below that the layout has a hole in it, and
  // sizing the whole set against the hole is how a nozzle ends up massing more
  // than the ship it steers.
  const strongest = Math.max(tx, ty, tz);
  const floor = strongest * 0.02;
  const auth: readonly [number, number, number] = [tx, ty, tz];
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

  const AXES: readonly Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const TRANS: readonly RcsGroup[][] = [['x+', 'x-'], ['y+', 'y-'], ['z+', 'z-']];
  const ROT: readonly RcsGroup[][] = [['pitch+', 'pitch-'], ['yaw+', 'yaw-'], ['roll+', 'roll-']];

  for (const row of rows) {
    const groups: RcsGroup[] = [];
    for (let a = 0; a < 3; a++) {
      const d = vDot(row.f, AXES[a]);
      if (d > 0.5) groups.push(TRANS[a][0]);
      else if (d < -0.5) groups.push(TRANS[a][1]);
    }
    const cm = vLength(row.c);
    if (cm > 1e-9) {
      for (let a = 0; a < 3; a++) {
        const d = vDot(row.c, AXES[a]) / cm;
        if (d > 0.5) groups.push(ROT[a][0]);
        else if (d < -0.5) groups.push(ROT[a][1]);
      }
    }
    if (groups.length === 0) continue;

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
}

interface Mount {
  readonly host: PrimaryVolume;
  readonly t: number;
  readonly theta: number;
  readonly frame: Frame;
  readonly clearance: number;
  readonly clearAngle: number;
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
        const m: Mount = { host, t, theta, frame, clearance, clearAngle: angle };

        if (straightOk && angle >= spec.minAngle) return m;

        const score = Math.min(1, clearance / Math.max(1e-9, spec.minClearance)) + Math.min(1, angle / Math.max(1e-9, spec.minAngle));
        if (score > bestScore) { bestScore = score; best = m; }
        reject(ctx, {
          stage: 'modules',
          rule: spec.rule,
          what: spec.what,
          at: [p[0], p[1], p[2]],
          measured: clearance < spec.minClearance * 0.999 ? clearance : angle,
          required: clearance < spec.minClearance * 0.999 ? spec.minClearance : spec.minAngle,
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
      half = [CONTAINER_LENGTH_KM * 0.2, CONTAINER_LENGTH_KM * 0.2, CONTAINER_LENGTH_KM * 0.5]; density = 200; break;
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
      ts: [0.1, 0.18, 0.28, 0.06, 0.4],
      thetas: [DORSAL, DORSAL - 0.5, DORSAL + 0.5, 0, Math.PI],
      // The view has to reach: two ship lengths of clear space, and a cone wide
      // enough to fly by. A cockpit looking into a cargo pod is not a cockpit.
      minClearance: L * 2,
      minAngle: 0.5,
      rule: 'cockpit-view-blocked',
      what: kind,
      aim: [0, 0, -1],
      aimWeight: 1.4,
      acceptBest: true,
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
  if (needs.has('radiator')) {
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
    const pairs = clamp(Math.round((wanted / 2) * heatRatio * doctrine), 1, 5);
    const hosts = hostsFor(ctx, ['afterbody', 'hull', 'midbody', 'keel', 'machinery']);
    const size = moduleSize(ctx, rng, 'radiator-panel');
    const wantSpan = size.half[0] * 2;
    // Below this a panel is not a radiator, it is a fin. If the hull cannot
    // give it this much clear space the element is refused rather than buried.
    const minSpan = Math.max(HATCH_WIDTH_KM * 2, B * 0.12);
    for (let i = 0; i < pairs; i++) {
      const t = 0.35 + (i / Math.max(1, pairs)) * 0.5;
      const theta = rng.chance(0.6) ? 0.35 : DORSAL - 0.3;
      const m = tryMount(ctx, {
        hosts,
        ts: [t, t + 0.1, t - 0.12, 0.6],
        thetas: [theta, DORSAL, 0.15, -0.35],
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
      const span = Math.min(wantSpan, m.clearance * 0.92);
      if (span < minSpan) {
        reject(ctx, {
          stage: 'secondary', rule: 'radiator-buried', what: 'radiator-panel',
          at: m.frame.origin, measured: m.clearance, required: minSpan, attempt: 9,
        });
        continue;
      }
      // Aspect ratio is the faction's; the span is the hull's.
      const half: Vec3 = [span * 0.5, span * 0.5 / Math.max(0.2, sampleRange(th.aspect, rng)), size.half[2]];
      const a = mountModule(ctx, rng, 'radiator-panel', m, { materialSlot: MAT_STRUCT, halfExtents: half });
      if (!a) continue;
      // `mirrored: false` licenses the salvage read — three panels at three
      // different angles — and is a real cultural difference, not an oversight.
      if (th.mirrored) {
        const mirrored: Mount = { ...m, frame: mirrorFrameXLocal(m.frame), theta: Math.PI - m.theta };
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
        // A turret needs half a radian of sky or it can only shoot its own hull.
        minAngle: 0.5,
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

  // --- cargo handling on the payload volumes themselves --------------------
  if (needs.has('cargo')) {
    const pods = ctx.volumes.filter((v) => v.kind === 'cargo-bay' || v.kind === 'cargo-rack' || v.kind === 'pod' || v.kind === 'tank');
    const hosts = pods.length > 0 ? pods : hostsFor(ctx, ['hull', 'midbody']);
    const n = clamp(Math.round(hosts.length * rng.range(0.8, 2.2)), 1, 8);
    for (let i = 0; i < n; i++) {
      const kind: ModuleKind = ctx.role === 'miner' || ctx.role === 'prospector' ? 'ore-bin' : rng.chance(0.5) ? 'cargo-container' : 'cargo-pod';
      const m = tryMount(ctx, {
        hosts: [hosts[i % hosts.length]],
        ts: [0.25 + (i % 3) * 0.25, 0.5],
        thetas: [DORSAL, 0, Math.PI, VENTRAL],
        minClearance: B * 0.2, minAngle: 0.3, rule: 'overlaps-existing', what: kind,
      });
      if (m) mountModule(ctx, rng, kind, m, { materialSlot: MAT_HULL });
    }
  }

  // --- landing gear, then navlights and emblems ----------------------------
  if (needs.has('landing')) placeLandingGear(ctx, rng);
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
  const maxLeg = H * 0.55 + clearGround;

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
  const hosts = hostsFor(ctx, ['hull', 'midbody', 'forebody', 'afterbody', 'keel']);
  const legs: LandingLeg[] = [];
  let contactY = 0;

  // Legs are spread over the fore-aft extent so the footprint is wide in Z, not
  // just in X: a ship on four legs in a square tips fore-and-aft first.
  const spots: readonly Vec2[] = tripod
    ? [[0.16, 0], [0.78, 0.55], [0.78, -0.55]]
    : [[0.2, 0.5], [0.2, -0.5], [0.8, 0.6], [0.8, -0.6]];

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

  // A footprint that does not contain the centre of mass is a ship that tips
  // over on touchdown. Worth saying out loud rather than discovering in play.
  if (!pointInPolygon([0, 0], footprint)) {
    reject(ctx, {
      stage: 'landing',
      rule: 'gear-not-lowest',
      what: 'footprint does not contain the centre of mass',
      at: [0, contactY, 0],
      measured: 0,
      required: 1,
      attempt: 1,
    });
  }
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
    mountModule(ctx, rng, kind, { host: v, t, theta, frame, clearance: ctx.prop.beamKm, clearAngle: 0.6 }, { crewAccessible: true });
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
      host: flat, t, theta, frame, clearance: ctx.prop.beamKm, clearAngle: 0.8,
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
    const n = rng.int(1, 3);
    const host = hostsFor(ctx, ['hull', 'keel', 'midbody', 'afterbody'])[0];
    const r = Math.max(p.beamKm, p.heightKm) * rng.range(0.1, 0.18);
    const shape = makeSection(rng, ctx.dna, 'tank', true);
    const scalars = makeScalars(rng, ctx.dna, shape, 'tank');
    for (let i = 0; i < n; i++) {
      const t = 0.45 + i * 0.14;
      const theta = n === 1 ? VENTRAL : (i % 2 === 0 ? 0.5 : Math.PI - 0.5);
      const sp = volumeSurfacePoint(host, clamp(t, 0.05, 0.9), theta, [0, 0, 0]);
      const sn = surfaceNormal(host, clamp(t, 0.05, 0.9), theta, [0, 0, 0]);
      ctx.volumes.push(sweptVolume(ctx, rng, {
        kind: 'tank',
        frame: axialFrame(sp[0] + sn[0] * r, sp[1] + sn[1] * r, sp[2] - L * 0.09),
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
  if (ctx.spec.needs.includes('sensor') && (ctx.role === 'science' || ctx.role === 'survey' || rng.chance(0.3))) {
    const host = hostsFor(ctx, ['forebody', 'hull', 'bridge'])[0];
    const t = rng.range(0.05, 0.25);
    const theta = rng.chance(0.6) ? DORSAL : VENTRAL;
    const sp = volumeSurfacePoint(host, t, theta, [0, 0, 0]);
    const sn = surfaceNormal(host, t, theta, [0, 0, 0]);
    ctx.volumes.push(sweptVolume(ctx, rng, {
      kind: 'boom',
      frame: frameAt([sp[0], sp[1], sp[2]], [sn[0], sn[1], sn[2]], FWD_Z),
      length: L * rng.range(0.12, 0.3),
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

function buildAccents(ctx: Ctx): void {
  const rng = new Rng(shipSubSeed(ctx.seed, 'accents'));
  const p = ctx.prop;
  const L = p.lengthKm;
  const host = hostsFor(ctx, ['hull', 'midbody', 'forebody', 'keel'])[0];
  if (!host) return;

  const options: (readonly [Accent, number])[] = [
    ['dorsal-fin', ctx.dna.dorsalChance * 6],
    ['tail-flare', 4],
    ['bow-ram', ctx.role === 'miner' || ctx.role === 'tug' || ctx.role === 'gunship' ? 5 : 1],
    ['canards', ctx.tech.atmosphereCapable ? 4 : 1],
    ['collar-ring', ctx.archetype === 'ring' ? 0 : 3],
    ['ventral-strake', ctx.dna.keelChance * 5],
    ['shoulder-pods', 3],
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
        ctx.volumes.push(sweptVolume(ctx, rng, {
          kind: 'fin',
          frame: frameAt([sp[0], sp[1], sp[2]], UP_Y, [0, 0, -1]),
          length: p.heightKm * rng.range(0.5, 1.1),
          halfWidth: Math.max(HATCH_WIDTH_KM * 0.6, p.beamKm * 0.035),
          halfHeight: L * rng.range(0.09, 0.2),
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
 * Rebase so the origin is the dry centre of mass, using `physics.ts`'s own mass
 * model.
 *
 * This must be `shipMassProperties` and not a second model built here. The
 * value the blueprint publishes as `physics.centreOfMass` comes from that
 * function; if the generator rebased against a different integration it would
 * publish a hull that its own physics says is out of balance, which is worse
 * than not rebasing at all. Mass is `physics.ts`'s to own — this file is the
 * only caller that has to agree with it, so it defers.
 *
 * Two passes: the mass model is linear in position so one is exact in theory,
 * but the module and engine mass laws quantise (an engine's bell length has a
 * floor), so a verification pass costs one integration and removes the doubt.
 */
function rebaseToCom(ctx: Ctx): number {
  const com = shipMassProperties(physicsView(ctx)).centreOfMass;
  applyShift(ctx, [-com[0], -com[1], -com[2]]);
  return Math.hypot(com[0], com[1], com[2]);
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
function balance(ctx: Ctx): ReturnType<typeof shipMassProperties> {
  // Exactly two integrations, and the count matters: `shipMassProperties` is
  // the most expensive call in this pipeline and BRIEF §6 gives a medium hull
  // 25 ms end to end.
  //
  //   pass 1  origin → balance point, then drive → origin
  //   pass 2  measure again (the drive moving shifted the balance point by its
  //           own share of the mass, a few percent), audit the thrust line
  //           while the measurement and the geometry still agree, then apply
  //           the exact correction.
  //
  // The final shift is applied AFTER the audit precisely so that the audit sees
  // a consistent pair; the shift itself is a pure translation and cannot change
  // the offset it would have measured.
  rebaseToCom(ctx);
  alignThrustAxis(ctx);
  const mass = shipMassProperties(physicsView(ctx));
  auditThrustAxis(ctx, mass);
  const c = mass.centreOfMass;
  applyShift(ctx, [-c[0], -c[1], -c[2]]);
  return mass;
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
        addDamage(kind, 'collision', rng.range(0.35, 0.8), when + rng.range(-60, 60), near,
          R * rng.range(0.25, 0.7), skin * rng.range(1.5, 5), [incidence[0], incidence[1], incidence[2]]);
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
      // Something was torn off and never replaced: the socket and the mounting
      // stubs stay, and that absence tells more of the story than the wound.
      const victims = ctx.modules.filter((m) => m.present && m.type !== 'engine' && m.type !== 'cockpit' && m.type !== 'landing');
      if (victims.length > 0 && rng.chance(0.45)) {
        const victim = rng.pick(victims);
        const vi = ctx.modules.indexOf(victim);
        ctx.modules[vi] = { ...victim, present: false, integrity: 0 };
        addDamage('module-torn-off', 'collision', 1, when, {
          v: ctx.volumes[0], t: 0.5, theta: 0, p: victim.frame.origin, n: victim.frame.forward,
        }, Math.max(victim.halfExtents[0], victim.halfExtents[1]), skin * 3,
          [incidence[0], incidence[1], incidence[2]]);
        ctx.damage[ctx.damage.length - 1] = {
          ...ctx.damage[ctx.damage.length - 1],
          target: { kind: 'module', moduleId: victim.id },
        };
      }
    }
  }

  // --- weapons, for hulls that live where that happens ---------------------
  if (ctx.spec.threat[1] > 0.1 || ctx.role === 'derelict' || ctx.role === 'salvager') {
    const hits = rng.int(0, Math.round(3 + damageLevel * 6));
    const incidence = vNormalize([rng.range(-1, 1), rng.range(-0.5, 0.5), rng.range(-1, 1)]);
    for (let i = 0; i < hits; i++) {
      const hit = randomSurface(ctx, rng, 0);
      if (!hit) break;
      addDamage(rng.chance(0.5) ? 'burn-through' : 'panel-loss', 'weapons', rng.range(0.4, 1),
        rng.range(0, age) * YEAR_S, hit, ctx.prop.beamKm * rng.range(0.02, 0.1), skin * rng.range(2, 8),
        [incidence[0], incidence[1], incidence[2]]);
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

function shipDimensions(ctx: Ctx, pressurisedVolumeM3: number): ShipDimensions {
  let box: Aabb | null = null;
  for (let i = 0; i < ctx.volumes.length; i++) {
    const b = boundsAt(ctx, i);
    box = box ? unionAabb(box, b) : b;
  }
  const b: Aabb = box ?? { min: [0, 0, 0], max: [0, 0, 0] };

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
function alignThrustAxis(ctx: Ctx): boolean {
  if (ctx.engines.length === 0) return false;
  // A hundredth of the beam: below that the couple is smaller than the RCS
  // trim authority and no pilot could tell.
  const tolerance = ctx.prop.beamKm * 0.01;

  // Thrust-weighted lateral centroid of the throats. Moving it to (0,0) puts
  // the line of action through the origin, which IS the centre of mass.
  let wx = 0, wy = 0, w = 0;
  for (const e of ctx.engines) { wx += e.frame.origin[0] * e.thrustN; wy += e.frame.origin[1] * e.thrustN; w += e.thrustN; }
  if (w <= 0) return false;
  const dx = -wx / w;
  const dy = -wy / w;
  if (Math.hypot(dx, dy) <= tolerance) return false;

  const moved = new Set<string>();
  for (let i = 0; i < ctx.engines.length; i++) {
    const e = ctx.engines[i];
    ctx.engines[i] = { ...e, frame: shiftFrame(e.frame, [dx, dy, 0]) };
    moved.add(e.socketId);
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
  return true;
}

/**
 * Report a thrust line the generator could not bring through the centre of
 * mass. BRIEF §5 allows the offset — it does not allow it to be silent.
 */
function auditThrustAxis(ctx: Ctx, mass: ReturnType<typeof shipMassProperties>): void {
  if (ctx.engines.length === 0) return;
  const tolerance = ctx.prop.beamKm * 0.01;
  const final = shipThrust(physicsView(ctx), mass);
  if (final.magnitudeN > 0 && final.offsetKm > tolerance) {
    reject(ctx, {
      stage: 'propulsion',
      rule: 'thrust-off-axis',
      what: 'resultant thrust line does not pass through the centre of mass',
      at: [0, 0, 0],
      measured: final.offsetKm,
      required: tolerance,
      attempt: 4,
    });
  }
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
  const maxLeg = ctx.prop.heightKm * 0.8 + clearGround;
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
    counters: new Map(),
    spine,
    landing: null,
    plumeLengthKm: 0,
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
  const version = params.generationVersion ?? SHIP_GENERATION_VERSION;
  const id = identity(params); //                          1  role and family
  const spine = buildSpine(id, params.seed); //            2  the load path
  const ctx = newContext(params, id, spine);

  buildPrimary(ctx); //                                    3  the silhouette
  const drive = buildDrive(ctx); //                        4  thrust through CoM
  placeModules(ctx); //                                    5  sockets + modules
  buildSecondary(ctx); //                                  6  tanks, wings, booms
  buildAccents(ctx); //                                    7  the recognisable shapes
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
        if (m.halfExtents[2] * 2 > sock.clearance * 1.0001) { bad++; out.push(`FAIL socket: ${m.kind} is ${fmt(m.halfExtents[2] * 2)} km deep into ${fmt(sock.clearance)} km of clearance`); }
        if (m.massKg > sock.budget.massKg * 1.0001) { bad++; out.push(`FAIL socket: ${m.kind} exceeds the mount's mass rating`); }
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

  // --- BRIEF §5 placement rules -------------------------------------------
  {
    const seeds = [7, 11, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73];
    let exhaust = 0, cockpit = 0, gear = 0, radiator = 0, weapon = 0, docking = 0, thrust = 0;
    let cockpits = 0, radiators = 0, weapons = 0, dockings = 0, geared = 0;
    let logged = 0;
    for (const s of seeds) {
      const bp = generateShip({ seed: s });
      logged += bp.placementLog.length;
      const byId = new Map(bp.sockets.map((k) => [k.id, k]));

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
          if (sock.clearAngle < 0.3) cockpit++;
        }
        if (m.kind === 'radiator-panel') {
          radiators++;
          if (sock.clearance < m.halfExtents[0]) radiator++;
        }
      }
      for (const h of bp.hardpoints) {
        if (h.kind === 'mining-laser' || h.kind === 'cutter' || h.kind === 'grapple') continue;
        weapons++;
        if (h.clearArc < 0.3) weapon++;
      }
      for (const d of bp.dockingPoints) {
        dockings++;
        if (d.approachClearance < d.diameter * 2) docking++;
      }
      if (bp.landingSystem) {
        geared++;
        // "Clearance below every other part": the gear's static height must put
        // the ground below the lowest non-gear point on the hull.
        if (bp.landingSystem.staticHeight < -bp.landingSystem.lowestFixedPoint) gear++;
      }
      // Thrust axis through the CoM, or an explicit reason why not.
      if (bp.physics.thrustN > 0 && bp.physics.thrustOffset > bp.dimensions.beamKm * 0.05
        && bp.physics.thrustOffsetReason === null) thrust++;
    }
    const rule = (n: number, of: number, label: string): string => `${label} ${n === 0 ? 'OK' : `FAIL ${n}`}/${of}`;
    out.push(`BRIEF §5 over ${seeds.length} hulls: ${[
      rule(exhaust, seeds.length, 'exhaust-clear'),
      rule(cockpit, cockpits, 'view-cone'),
      rule(gear, geared, 'gear-lowest'),
      rule(radiator, radiators, 'radiator-exposed'),
      rule(weapon, weapons, 'field-of-fire'),
      rule(docking, dockings, 'approach-corridor'),
      rule(thrust, seeds.length, 'thrust-through-CoM'),
    ].join(', ')}`);
    out.push(`placement log: ${logged} refusals recorded over ${seeds.length} hulls (${fmt(logged / seeds.length, 1)} per ship) — a generator that refuses nothing has not checked`);
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
    out.push(`thrust: ${accelBad === 0 ? 'OK' : `FAIL ${accelBad}`} against each role's own band — loaded acceleration ${fmt(A.min, 1)}–${fmt(A.max, 1)} m/s² (mean ${fmt(A.mean, 1)}); delta-v ${fmt(D.min, 1)}–${fmt(D.max, 1)} km/s; ${areaLimited}/${seeds.length} hulls are aft-area limited and say so in the log`);
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
        Math.min(9, bp.primaryVolumes.length),
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
    const physicsMs = profMs + massMs * 3;
    out.push(`  of which physics.ts: ${fmt(profMs, 1)} ms for shipPhysicsProfile + 3 × ${fmt(massMs, 1)} ms shipMassProperties (drive sizing, rebase, final) = ${fmt(physicsMs, 1)} ms; this generator's own geometry work is ${fmt(Math.max(0, mediumMs - physicsMs), 1)} ms`);
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
