/**
 * oneSpace — faction visual DNA and role requirements.
 *
 * This file is the *industrial design* layer of the ship generator. It sits
 * between the blueprint contract (`types.ts`, which says what a ship IS) and the
 * generator (`blueprint.ts`, which builds one). It answers two questions and
 * nothing else:
 *
 *   WHO BUILT IT  →  `FactionDna`  — a manufacturing culture, not a colour swatch
 *   WHAT IS IT FOR →  `RoleSpec`   — functional requirements, not shapes
 *
 * Purity: no three.js, no DOM, no I/O, no module-level mutable state, no
 * `Math.random`. Every export is either frozen data or a pure function of its
 * arguments. The two derived tables (`ROLES`, `FACTION_BY_ID`) are computed once
 * from literals at module load, which is a pure computation — the same pattern
 * `gen/names.ts` uses for `DIALECT_WEIGHTS`.
 *
 * ---------------------------------------------------------------------------
 * THE ARGUMENT THIS FILE MAKES
 *
 * A fleet fails when three factions are three tints of one hull. It fails
 * differently, and worse, when seven roles are seven labels on one hull. The two
 * failures have the same cause: the generator was given *decoration* to vary
 * instead of *constraints* to satisfy.
 *
 * So nothing below is a colour or a shape unless a manufacturing decision forces
 * it to be. Three examples, which are the three ideas the whole file is built
 * from:
 *
 *   1. Sillane hulls are long because their skin is their radiator. Radiating
 *      area is length × girth, and they refuse external fins, so their
 *      length/beam ratio has a *thermal* lower bound. A designer cannot make a
 *      stubby Sillane; the physics of their own design language forbids it.
 *
 *   2. Kessler engines stand off the hull on a visible thrust frame because a
 *      Kessler crew must be able to change one in the field with a gantry. That
 *      single maintenance doctrine produces the external frame, the four-bell
 *      cluster, the walkways, the handrails, the floodlights and the blunt tail
 *      — six silhouette features from one cultural belief.
 *
 *   3. Ossuary ships have no symmetry policy because they start from a keel
 *      somebody else built and already broke. Every mass is bolted where the
 *      structure happened to be sound. Their asymmetry is not a style; it is a
 *      consequence, which is why it reads as true and a randomised asymmetry
 *      would not.
 *
 * Roles work the same way. A role here is a list of things that must be true —
 * modules that must exist, where the mass must sit, what the silhouette must
 * communicate — plus, crucially, `distinguishFrom`: an explicit statement of the
 * one thing that must differ between this role and its nearest neighbour. That
 * field is what makes "two roles cannot come out looking the same" checkable by
 * a reviewer instead of hoped for.
 *
 * ---------------------------------------------------------------------------
 * UNITS  — as `types.ts`: km, s, kg, N, rad, linear RGB. Accelerations are
 * quoted in m/s² because that is the number a human can judge; `FlightModel`
 * converts (`mainAccel = mainThrust / mass * M_TO_KM`). The reference point for
 * every acceleration figure below is the player's own ship in
 * `DEFAULT_SHIP_CONFIG`: 4.0e7 N on 2.0e5 kg = 200 m/s². This engine is heroic,
 * not Newtonian-realistic, and every role is scaled against that 200.
 */

import { Rng, hashSeed } from '@/math/rng';
import type {
  CapStyle,
  FactionId,
  FamilyId,
  MarkingKind,
  ModuleKind,
  NozzleStyle,
  RGB,
  SectionFamily,
  SectionHarmonic,
  SectionLobe,
  SectionShape,
  ShipPalette,
  ShipRole,
  SizeClass,
  SocketType,
  SpineExposure,
  SpineMemberStyle,
  TechnologyProfile,
  ThreatClass,
  Vec2,
  VolumeKind,
  WearWeights,
} from '@/gen/ships/types';
import { DECK_HEIGHT_KM } from '@/gen/ships/types';

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/**
 * An inclusive `[min, max]` band. Structurally identical to `Vec2`, and
 * deliberately the same type so it stays JSON and matches
 * `SIZE_CLASS_LENGTH_KM`, which already uses `Vec2` as a range.
 *
 * Almost every number in this file is a range rather than a value. That is the
 * central mechanism for "the faction's DNA is recognisable across seeds, and
 * different seeds are genuinely different ships": the *band* is the identity,
 * the point drawn inside it is the variation.
 */
export type Range = Vec2;

/** Linear interpolation into a range. `k` is clamped to 0..1. */
export function rangeAt(r: Range, k: number): number {
  const c = k < 0 ? 0 : k > 1 ? 1 : k;
  return r[0] + (r[1] - r[0]) * c;
}

export function rangeMid(r: Range): number {
  return (r[0] + r[1]) * 0.5;
}

/** Uniform draw. The only randomness permitted anywhere in generation. */
export function sampleRange(r: Range, rng: Rng): number {
  return rng.range(r[0], r[1]);
}

/**
 * Combine a role's requirement with a faction's habit.
 *
 * Where the bands overlap, the overlap is the answer. Where they do not, the
 * ROLE wins and the faction is pulled to the nearest edge of the role's band:
 * function decides form (BRIEF §4), so a Sillane freighter is a stubby Sillane
 * before it is a freighter that cannot carry anything. The result is always
 * non-empty, which matters because the generator has no fallback path.
 */
export function intersectRange(role: Range, faction: Range): Range {
  const lo = Math.max(role[0], faction[0]);
  const hi = Math.min(role[1], faction[1]);
  if (lo <= hi) return [lo, hi];
  // Disjoint: clamp the faction's band onto the nearest edge of the role's.
  const edge = faction[0] > role[1] ? role[1] : role[0];
  return [edge, edge];
}

// ---------------------------------------------------------------------------
// Detail vocabulary
// ---------------------------------------------------------------------------

/**
 * The greeble families a hull may wear.
 *
 * `Ship.ts` proved the principle: a bare box and a bare cylinder gave the whole
 * hull exactly two silhouettes, and the fix was authoring each detail as an
 * *assembly* in a unit footprint. Its five families (hatch, bracket, ribbed,
 * stack, pipe) are the first five here, kept under the same names so
 * `render/ships/greebles.ts` can reuse the existing geometry directly.
 *
 * The rest exist because a culture is defined at least as much by the detail it
 * refuses as by the detail it uses. `SurfaceDna.forbiddenGreebles` is not a
 * performance hint — it is the identity. A Sillane hull with one external cable
 * loom on it stops being a Sillane hull.
 */
export type GreebleFamily =
  | 'hatch' //          bolted access panel, raised rim
  | 'bracket' //        an L or gusset carrying something
  | 'ribbed' //         a stiffened box: heat exchanger, avionics case
  | 'stack' //          a pile of unequal boxes, the "equipment" read
  | 'pipe' //           external run with bends and flanges
  | 'vent' //           louvred or grilled opening
  | 'grille' //         flat mesh over a recess
  | 'louvre' //         angled slats cut INTO the surface, casts no shadow proud
  | 'flush-panel' //    inspection panel with no rim; only a moulded surface has these
  | 'blister' //        a smooth fairing over a lump
  | 'cable-loom' //     a bundle of cables clipped along the outside
  | 'conduit' //        armoured cable run, a pipe by another name but square
  | 'antenna-whip' //   a thin flexible rod; snaps, so nobody armoured builds them
  | 'mast' //           a rigid instrument mast with a ladder up it
  | 'ladder' //         crew access; implies people go outside
  | 'handrail' //       crew access; implies people go outside
  | 'clamp' //          band clamp round a drum or a pipe
  | 'drum' //           a cylindrical pressure bottle strapped on
  | 'strut' //          a diagonal brace added after the fact
  | 'doubler-plate' //  a plate welded over a plate, the reinforcement read
  | 'weld-bead' //      a raised seam; only a welding culture has these
  | 'tarp' //           foil or fabric lashed over something
  | 'sealant' //        a lumpy blob of cured foam
  | 'floodlight' //     a work light aimed at the ship's own hull
  | 'fairlead' //       a cable guide; implies winches
  | 'winch-drum'; //    a spool of cable

/**
 * The full vocabulary, for the geometry module to assert it implements all of
 * them and for `forbiddenGreebles` to be derived by subtraction in tests.
 */
export const GREEBLE_FAMILIES: readonly GreebleFamily[] = [
  'hatch', 'bracket', 'ribbed', 'stack', 'pipe', 'vent', 'grille', 'louvre',
  'flush-panel', 'blister', 'cable-loom', 'conduit', 'antenna-whip', 'mast',
  'ladder', 'handrail', 'clamp', 'drum', 'strut', 'doubler-plate', 'weld-bead',
  'tarp', 'sealant', 'floodlight', 'fairlead', 'winch-drum',
];

/**
 * How a joint between two masses is made. This is the single most legible read
 * on manufacturing culture at close range, and it is geometry, not material: a
 * bolted flange has a visible ring of fasteners standing proud, a cast fillet
 * has none and no seam at all.
 */
export type JointStyle =
  | 'welded-bead' //    ground-back or left proud; a continuous line
  | 'bolted-flange' //  two rings of plate and a bolt circle
  | 'cast-fillet' //    a continuous radius; the parts were never separate
  | 'clamped-collar' // a band clamp round two butted tubes
  | 'torch-cut-graft'; // an irregular cut edge welded to another irregular cut

/**
 * How the main drives attach. Named for what the eye reads, not for what a
 * catalogue would call it.
 */
export type EngineMounting =
  | 'exposed-frame' // bells standing off the hull on a visible thrust structure
  | 'recessed' //     nozzle inside a shroud; you see a lit throat, not a bell
  | 'integrated' //   the tail of the hull IS the nozzle
  | 'podded' //       a nacelle on a pylon, clearly a separate object
  | 'outrigger'; //   pods held well outboard on booms

/**
 * Heat rejection architecture. This is the field with the largest effect on
 * silhouette per byte, because a radiator is enormous and cannot be hidden.
 */
export type RadiatorArchitecture =
  | 'flat-panel' //  fixed braced slabs, always in mirrored pairs
  | 'folding-fin' // deployable fins that stow; implies a mechanism
  | 'pipe-loop' //   bare tubing on a frame; obviously field-made
  | 'drum' //        a rotating drum shedding a film; heavy and industrial
  | 'skin' //        the hull itself radiates; no external hardware at all
  | 'none'; //       a hull with no heat problem, i.e. no drive worth the name

/** Sensor and antenna language. */
export type SensorLanguage =
  | 'caged-dish' //      a squat dish inside a protective cage
  | 'conformal-array' // flush phased-array patches; no protrusion
  | 'boom-instrument' // instruments held away from the hull on booms
  | 'whip-forest' //     an accumulation of mismatched aerials
  | 'mast-array' //      one rigid mast carrying stacked elements
  | 'radome'; //         everything hidden under a smooth dome

/**
 * The symmetry doctrine. Three genuinely different stories, not three amounts
 * of one thing — that distinction is the reason this is a union and not a
 * float.
 */
export type SymmetryPolicy =
  | 'strict-mirror' //      everything mirrors, including things that need not
  | 'mirror-with-signature' // mirrored, except one designed asymmetry
  | 'opportunistic'; //     mirrored only where physics forces it

/** Where a thing may sit around a section, as an angle policy. */
export type ClockPolicy =
  | 'aligned' //    only at the section's own flats/vertices
  | 'quantised' //  on a fixed angular grid
  | 'arbitrary'; // anywhere; whatever was free

// ---------------------------------------------------------------------------
// Faction DNA — sub-records
// ---------------------------------------------------------------------------

/** How this culture makes things, and how well it keeps them. */
export interface ConstructionDna {
  /** The fabrication a new hull of this faction uses. */
  readonly primary: TechnologyProfile['fabrication'];
  /** What a later refit or a bolted-on module looks like. Drives `mismatched`. */
  readonly refit: TechnologyProfile['fabrication'];
  readonly joint: JointStyle;
  /**
   * Multiplier on the length-derived panel size. Panel size is never a
   * constant (BRIEF §7); this says how big *this yard's* plate is relative to
   * the ship, which is a real difference — a yard that rolls 12 m plate builds
   * visibly coarser ships than one that presses 3 m panels.
   */
  readonly panelSizeFactor: number;
  /**
   * 0..1 — how much panel size varies from volume to volume. Near zero for a
   * single casting; high for a hull assembled from three donors, where each
   * section keeps the plate size of the yard that built it.
   */
  readonly panelSizeVariance: number;
  /** Multiplier on seam recess depth. A cast hull has almost none. */
  readonly seamDepthFactor: number;
  /**
   * Multiplier on fastener pitch along a seam. Exactly 0 means *no fasteners*,
   * which is a statement about the culture, not a small number.
   */
  readonly fastenerPitchFactor: number;
  /** Band for `TechnologyProfile.exposedStructure`. */
  readonly exposedStructure: Range;
  /**
   * 0..1 — how badly adjacent parts line up. This is the field that separates
   * "engineered" from "assembled at random" (BRIEF §8) in the other direction:
   * perfect alignment everywhere reads as CAD, and a little honest misalignment
   * reads as fabrication.
   */
  readonly toleranceJitter: number;
  /** Band for `RepairEvent.quality`. A yard job is 1, a suited field weld is 0. */
  readonly repairQuality: Range;
  /** Band for `TechnologyProfile.maintenance`. */
  readonly maintenance: Range;
  /** Band for `TechnologyProfile.refits`, rounded to integers. */
  readonly refits: Range;
  /** Band for `TechnologyProfile.ageYears`. */
  readonly ageYears: Range;
  /**
   * Damage events per decade of service, before role and maintenance. A
   * scavenger hull carries other people's damage as well as its own.
   */
  readonly damageRatePerDecade: Range;
  /** Fraction of damage events that ever got repaired at all. */
  readonly repairFraction: Range;
}

/** Proportion rules — the part of identity that survives at impostor range. */
export interface ProportionDna {
  /** Overall length ÷ overall beam. The single strongest silhouette number. */
  readonly lengthBeam: Range;
  /** Overall length ÷ overall height. */
  readonly lengthHeight: Range;
  /**
   * Where the dry centre of mass sits along the hull, 0 = nose, 1 = exhaust
   * plane. The generator rebases the blueprint so the CoM is the origin
   * (`types.ts` ORIGIN), so this number is really "how much hull is forward of
   * the origin" — and that is what makes a ship look like it is falling
   * forward or dragging its tail.
   */
  readonly massCentroid: Range;
  /**
   * 0..1 — 1 means the mass is one dense block, 0 means it is spread evenly
   * along the hull. Drives inertia as much as it drives looks: a concentrated
   * hull rolls and pitches fast, a spread one wallows.
   */
  readonly massConcentration: Range;
  /** How many masses make the silhouette (BRIEF §4 stage 3). Integers. */
  readonly primaryMasses: Range;
  /**
   * 0..1 — how much the diameter changes between adjacent masses. Near zero
   * gives one continuous body; high gives the stepped, stacked-cans read.
   */
  readonly diameterStep: Range;
  /** 0..1 — how much the body narrows towards its ends. */
  readonly taper: Range;
  /**
   * How far things protrude past the primary hull, as a fraction of beam. This
   * is what makes a ship read as cluttered or clean from head-on, which is the
   * hardest of the three review angles to make interesting.
   */
  readonly overhang: Range;
}

/** Symmetry doctrine. */
export interface SymmetryDna {
  readonly policy: SymmetryPolicy;
  /** 0..1 — fraction of placeable things that get an X-mirrored twin. */
  readonly mirrorRate: number;
  /**
   * Legal rotational counts for radial arrangements (engine clusters, tank
   * rings, radiator fans). An empty list means the culture does not think
   * radially at all.
   */
  readonly radialCounts: readonly number[];
  /**
   * The one designed asymmetry, described. Null for cultures that have none.
   * A *designed* asymmetry reads completely differently from an accidental
   * one, which is why this is prose the reviewer can check against, not a
   * probability.
   */
  readonly signature: string | null;
  /** Which side the signature always sits on. Always the same side, or it is noise. */
  readonly signatureSide: 'port' | 'starboard' | null;
  readonly clock: ClockPolicy;
  /** Radians, when `clock` is 'quantised'. */
  readonly clockQuantum: number;
}

/** Surface language: what the skin is made of and what grows on it. */
export interface SurfaceDna {
  readonly curvature: 'faceted' | 'mixed' | 'continuous';
  /** Weighted preference over section families. Weights need not be normalised. */
  readonly sectionFamilies: readonly (readonly [SectionFamily, number])[];
  /** Superellipse exponent band. 2 = ellipse, 4 = soft box, 8 ≈ box. */
  readonly exponent: Range;
  /** Legal polygon side counts. */
  readonly polygonSides: readonly number[];
  readonly chamfer: Range;
  /** Ventral flatten band. `Ship.ts` uses 0.82; a ship that lands wants ≤0.85. */
  readonly ventralFlatten: Range;
  /** Harmonic count band (integers), and the frequencies this culture uses. */
  readonly harmonicCount: Range;
  readonly harmonicFrequencies: readonly number[];
  readonly harmonicAmplitude: Range;
  /** Localised lobe count band (integers) and their angular half-width band. */
  readonly lobeCount: Range;
  readonly lobeWidth: Range;
  readonly lobeDepth: Range;
  /** Preferred cap styles, in order of preference. */
  readonly caps: readonly CapStyle[];
  readonly greebles: readonly GreebleFamily[];
  /** Never, under any seed. The identity lives at least as much here. */
  readonly forbiddenGreebles: readonly GreebleFamily[];
  /** Band for `PrimaryVolume.detailDensity`. */
  readonly detailDensity: Range;
  /** Multiplier on `MaterialProfile.microDetailScale`. */
  readonly microDetailScale: number;
  readonly roughness: Range;
  /** Band for `MaterialProfile.paintFade`. */
  readonly paintFade: Range;
}

/** Structure doctrine — how the load path is drawn. */
export interface StructureDna {
  readonly member: SpineMemberStyle;
  /** Fallback member when the primary cannot carry the role's load. */
  readonly heavyMember: SpineMemberStyle;
  readonly exposure: SpineExposure;
  readonly brace: 'warren' | 'pratt' | 'x' | 'k' | 'zigzag';
  /**
   * Working stress, N per km² of member cross-section, used to size members
   * from `SpineNode.loadN`. Not a real material property — it is the knob that
   * makes one culture's structure visibly heavier than another's for the same
   * load, which is exactly the read we want. Kessler over-builds; Sillane
   * builds to the number.
   */
  readonly workingStressNPerKm2: number;
  /** Bay length as a fraction of the local structural radius. */
  readonly bayAspect: Range;
}

/** Propulsion doctrine. */
export interface PropulsionDna {
  readonly drive: TechnologyProfile['drive'];
  readonly mounting: EngineMounting;
  readonly nozzle: NozzleStyle;
  /** Legal main-drive counts. Even counts read as heavy; odd as cheap or exotic. */
  readonly engineCounts: readonly number[];
  /** Nozzles per pod. A cluster of four in one pod reads very differently to four pods. */
  readonly nozzlesPerPod: readonly number[];
  /** Exit radius as a fraction of the hull's local half-height. */
  readonly exitRadiusRatio: Range;
  /** Bell length ÷ exit radius. Long bells read as vacuum-optimised. */
  readonly bellAspect: Range;
  /** Max gimbal, radians. Zero = fixed, which forces RCS to do all the work. */
  readonly gimbal: Range;
  /** Plume length ÷ exit radius. */
  readonly plumeLength: Range;
  /** Shock diamonds. 0 for ion and reaction-plate drives. */
  readonly plumeDiamonds: Range;
  /** 0..1 plume instability. Corporate drives are steady; salvaged ones are not. */
  readonly plumeFlicker: Range;
  /** Spool time band, seconds. Feeds `FlightTuning.throttleSpoolTime`. */
  readonly spoolTime: Range;
  /** RCS nozzles per quad, and how far outboard the quads sit (fraction of beam). */
  readonly rcsPerQuad: number;
  readonly rcsOutboard: Range;
}

/** Heat doctrine. */
export interface ThermalDna {
  readonly architecture: RadiatorArchitecture;
  /**
   * Radiating area per watt of drive heat, km²/W. Absurdly small in absolute
   * terms — the point is the *ratio* between factions, which decides how much
   * of the silhouette is radiator.
   */
  readonly areaPerWatt: number;
  /** Radiator panel aspect ratio (length ÷ width). */
  readonly aspect: Range;
  /** How many radiator elements. Mirrored pairs mean even counts. */
  readonly elementCounts: readonly number[];
  /**
   * True when the radiators must be in mirrored pairs. False licenses the
   * "three panels at three different angles" salvage read.
   */
  readonly mirrored: boolean;
  /** Band for `WearWeights.heat` contribution. Skin radiators stain their flanks. */
  readonly heatStaining: Range;
}

/** Sensor and antenna language. */
export interface SensorDna {
  readonly language: SensorLanguage;
  /** Sensor module kinds this culture mounts. */
  readonly modules: readonly ModuleKind[];
  /** How far instruments stand off the hull, as a fraction of beam. */
  readonly standoff: Range;
  /** Dish diameter as a fraction of beam, where dishes are used at all. */
  readonly dishRatio: Range;
  /** How many separate sensor objects a hull carries, before role. */
  readonly count: Range;
}

/** Markings, numbering and emblem placement. */
export interface MarkingDna {
  readonly kinds: readonly MarkingKind[];
  /** Registry pattern: 'A' = letter from `registryLetters`, '9' = digit. */
  readonly registryPattern: string;
  /** The letter pool. Small and consonantal, so registries look institutional. */
  readonly registryLetters: string;
  /**
   * Marking cap height as a multiple of `DECK_HEIGHT_KM`. Text is the cheapest
   * scale cue there is, so its size is derived from a human dimension and never
   * from the ship — a 4 km capital with 4 km-scaled lettering reads as a model.
   */
  readonly capHeightDecks: Range;
  readonly placement: readonly (
    | 'bow-flank'
    | 'dorsal-aft'
    | 'engine-shroud'
    | 'ventral'
    | 'nose'
    | 'largest-flat'
    | 'tail-band'
  )[];
  readonly application: 'stencil' | 'etched' | 'hand-painted' | 'decal';
  /**
   * 0..1 — how much of a previous owner's markings still shows through. The
   * cheapest possible statement that a hull had a life before this one.
   */
  readonly overpaint: number;
  /** Band for `Marking.wear`. */
  readonly wear: Range;
  /** Whether ships of this culture carry a name at all, or only a number. */
  readonly namesShips: boolean;
}

/**
 * A hull line within a faction.
 *
 * `ShipBlueprint` carries both `factionId` and `familyId`, so a faction is a
 * culture and a family is one of its product lines. Families exist so that two
 * ships from the same yard can differ structurally rather than only by seed —
 * a Kessler ore hauler and a Kessler patrol cutter share a welding shop and
 * share nothing else.
 */
export interface HullFamily {
  readonly id: FamilyId;
  readonly name: string;
  /** Roles this line serves. First match wins in `familyFor`. */
  readonly roles: readonly ShipRole[];
  /** The one sentence that says what this line looks like. */
  readonly signature: string;
  /** Multiplier on the faction's length/beam band. */
  readonly lengthBeamBias: number;
  /** Section family this line prefers over the faction default, or null. */
  readonly sectionFamily: SectionFamily | null;
  /** Cap style this line prefers at the nose. */
  readonly noseCap: CapStyle;
  /** Replaces `palette.accent` for this line, or null to inherit. */
  readonly accentOverride: RGB | null;
}

// ---------------------------------------------------------------------------
// Faction DNA
// ---------------------------------------------------------------------------

export interface FactionDna {
  readonly id: FactionId;
  /** Full name, for the codex. */
  readonly name: string;
  /** ≤ 12 characters, for a HUD line. */
  readonly shortName: string;
  /**
   * How this culture designates a hull class: "Kessler-pattern heavy hauler".
   * A *pattern* implies a drawing exists; a *type* implies a mould; *-built*
   * implies neither. The word itself carries the manufacturing culture, which
   * is why it is data and not a template in `blueprint.ts`.
   */
  readonly patternWord: 'pattern' | 'type' | 'built';
  /** One or two sentences, noir register, for the codex and the scan blurb. */
  readonly blurb: string;
  /** The doctrine, in one line. Used by the reviewer, not by the renderer. */
  readonly doctrine: string;

  readonly construction: ConstructionDna;
  readonly proportion: ProportionDna;
  readonly symmetry: SymmetryDna;
  readonly surface: SurfaceDna;
  readonly structure: StructureDna;
  readonly propulsion: PropulsionDna;
  readonly thermal: ThermalDna;
  readonly sensors: SensorDna;
  readonly markings: MarkingDna;

  readonly palette: ShipPalette;
  /** Baseline wear character, multiplied by the role's bias and by maintenance. */
  readonly wear: WearWeights;

  readonly families: readonly HullFamily[];

  /**
   * Roles this culture will not build under any seed. This is the "what would
   * this culture never build" answer in enforceable form: `factionRoleWeight`
   * returns 0 and the fleet generator must pick someone else.
   */
  readonly neverBuilds: readonly ShipRole[];
  /**
   * Relative likelihood of building a role, where absent means 1. Used to
   * weight fleet composition so a system's traffic reads as an economy.
   */
  readonly roleAffinity: Partial<Record<ShipRole, number>>;
  /** Prose, for the report and for the reviewer to check a hull against. */
  readonly neverBuildsPhysically: readonly string[];
}

// ---------------------------------------------------------------------------
// Faction 1 — Kessler Plate & Structural
// ---------------------------------------------------------------------------

/**
 * KESSLER — the heavy industrial welded-plate culture.
 *
 * A chartered yard that builds ships the way a previous century built bridges:
 * rolled plate, welded, stiffened with external ribs at every frame, and every
 * member sized from a load that is stamped next to it. The doctrine is
 * *field maintainability*, and it is the root of everything you can see:
 *
 *   - the drives stand off the tail on an open thrust frame, because a crew with
 *     a gantry must be able to change one;
 *   - the structure is on the outside, because a fairing is a thing you have to
 *     remove before you can work;
 *   - the radiators are fixed braced slabs, because a deployable is a mechanism
 *     and a mechanism is a failure waiting for a schedule;
 *   - there are ladders, handrails, walkways and floodlights everywhere, because
 *     people work on the outside of these ships;
 *   - nothing is a compound curve, because compound curves need a press and a
 *     press cannot be taken to a mining station.
 *
 * The read, as a black silhouette: a rectangular block with visible ribbing, two
 * enormous flat radiator slabs in a mirrored pair, and four bells standing clear
 * of the tail on an open frame. It reads as *civil engineering*.
 */
const KESSLER: FactionDna = {
  id: 'kessler',
  name: 'Kessler Plate & Structural',
  shortName: 'Kessler',
  patternWord: 'pattern',
  blurb:
    'A chartered yard that has never once been accused of elegance. Kessler builds to a load table and stamps the load beside the weld, and its hulls outlive the companies that order them.',
  doctrine: 'Anything a crew cannot reach with a spanner is a part that will one day strand them.',

  construction: {
    primary: 'welded-plate',
    refit: 'riveted-plate',
    joint: 'bolted-flange',
    // Kessler rolls large plate: 1.35× the length-derived default, which is what
    // makes their hulls read as coarse and structural rather than as detailed.
    panelSizeFactor: 1.35,
    panelSizeVariance: 0.12,
    seamDepthFactor: 1.5,
    fastenerPitchFactor: 1.0,
    exposedStructure: [0.35, 0.7],
    toleranceJitter: 0.25,
    repairQuality: [0.55, 0.9],
    maintenance: [0.5, 0.85],
    refits: [0, 3],
    ageYears: [4, 40],
    damageRatePerDecade: [2, 7],
    repairFraction: [0.7, 0.95],
  },

  proportion: {
    // Blunt. A Kessler hull is a box that has been persuaded to have a front.
    lengthBeam: [2.6, 5.2],
    lengthHeight: [2.4, 4.4],
    // Mass well aft: the reactor and the thrust frame are a solid block at the
    // tail and everything forward of the midships bulkhead is comparatively
    // empty. This is why a Kessler pitches slowly and looks like it is dragging.
    massCentroid: [0.58, 0.72],
    massConcentration: [0.55, 0.8],
    primaryMasses: [2, 4],
    diameterStep: [0.25, 0.5],
    taper: [0.1, 0.35],
    overhang: [0.35, 0.8],
  },

  symmetry: {
    policy: 'strict-mirror',
    // They mirror things that do not need mirroring, because a mirrored parts
    // list is half as long to stock.
    mirrorRate: 0.95,
    radialCounts: [2, 4, 6, 8],
    signature: null,
    signatureSide: null,
    clock: 'aligned',
    clockQuantum: Math.PI / 4,
  },

  surface: {
    curvature: 'faceted',
    sectionFamilies: [
      ['polygon', 6],
      ['superellipse', 4],
      ['twin-lobe', 0],
    ],
    // High exponents only: a Kessler superellipse is a box with the corners
    // taken off, never an ellipse.
    exponent: [4, 8],
    polygonSides: [4, 6, 8],
    chamfer: [0.15, 0.45],
    ventralFlatten: [0.7, 0.88],
    // One or two chines, low frequency, running the full length as continuous
    // lines — the `Ship.ts` rationale for constant phase applies exactly.
    harmonicCount: [0, 2],
    harmonicFrequencies: [4, 6, 8],
    harmonicAmplitude: [0.02, 0.06],
    lobeCount: [1, 2],
    lobeWidth: [0.35, 0.7],
    lobeDepth: [0.08, 0.22],
    caps: ['flat', 'blunt', 'taper'],
    greebles: [
      'hatch', 'bracket', 'ribbed', 'stack', 'pipe', 'vent', 'grille', 'conduit',
      'mast', 'ladder', 'handrail', 'clamp', 'drum', 'strut', 'doubler-plate',
      'weld-bead', 'floodlight',
    ],
    // No whip aerials (they snap and a snapped aerial is an unplanned repair),
    // no loose cable (everything is conduited), no blisters or louvres or flush
    // panels (all three need a die), no tarp or sealant (that is somebody else's
    // way of working, and Kessler will say so).
    forbiddenGreebles: [
      'antenna-whip', 'cable-loom', 'blister', 'louvre', 'flush-panel', 'tarp',
      'sealant', 'winch-drum', 'fairlead',
    ],
    detailDensity: [0.45, 0.8],
    microDetailScale: 1.0,
    roughness: [0.72, 0.92],
    paintFade: [0.2, 0.6],
  },

  structure: {
    member: 'box-truss',
    heavyMember: 'box-truss',
    exposure: 'exposed',
    brace: 'warren',
    // Deliberately the lowest working stress of the three: for the same load,
    // Kessler members come out fattest. That is the over-built read, and it is
    // arithmetic rather than art direction.
    workingStressNPerKm2: 9.0e11,
    bayAspect: [1.2, 1.8],
  },

  propulsion: {
    drive: 'fusion-torch',
    mounting: 'exposed-frame',
    nozzle: 'bell',
    // Even counts only. An odd number of drives means one of them is special,
    // and Kessler does not stock special parts.
    engineCounts: [2, 4],
    nozzlesPerPod: [1, 2],
    exitRadiusRatio: [0.3, 0.5],
    bellAspect: [1.3, 1.9],
    gimbal: [0.05, 0.12],
    plumeLength: [7, 13],
    plumeDiamonds: [3, 6],
    plumeFlicker: [0.04, 0.12],
    spoolTime: [1.2, 3.0],
    rcsPerQuad: 4,
    rcsOutboard: [0.75, 1.0],
  },

  thermal: {
    architecture: 'flat-panel',
    areaPerWatt: 2.6e-13,
    aspect: [2.2, 4.0],
    elementCounts: [2, 4],
    mirrored: true,
    heatStaining: [0.35, 0.6],
  },

  sensors: {
    language: 'caged-dish',
    modules: ['sensor-dish', 'sensor-array'],
    standoff: [0.05, 0.15],
    dishRatio: [0.12, 0.24],
    count: [1, 3],
  },

  markings: {
    kinds: ['registry', 'name', 'emblem', 'hazard', 'stencil', 'numeral', 'stripe'],
    // "KX-4471" — the exact form the blueprint contract uses as its example.
    registryPattern: 'AA-9999',
    registryLetters: 'KXVTRDNGBMHZ',
    // Enormous: three to five decks tall on the bow flank, legible from another
    // ship, because Kessler ships are read by traffic control and by dock crews.
    capHeightDecks: [1.2, 3.4],
    placement: ['bow-flank', 'dorsal-aft', 'engine-shroud', 'tail-band'],
    application: 'stencil',
    overpaint: 0.1,
    wear: [0.25, 0.6],
    namesShips: true,
  },

  palette: {
    // Grey-green industrial primer. Sits at ~0.06 linear, well under the 0.2
    // luminance ceiling ARCHITECTURE §6 sets for a lit hull.
    hull: [0.058, 0.062, 0.05],
    hullShadow: [0.0055, 0.0062, 0.0072],
    plateShades: [
      [0.052, 0.056, 0.046],
      [0.061, 0.065, 0.052],
      [0.056, 0.059, 0.051],
      [0.065, 0.068, 0.054],
    ],
    // A Kessler patch is a Kessler plate from a different batch, plus the one
    // that never got its topcoat.
    patchShades: [
      [0.078, 0.07, 0.048],
      [0.04, 0.046, 0.044],
      [0.095, 0.048, 0.022],
    ],
    mismatch: [
      [0.044, 0.05, 0.058],
      [0.07, 0.062, 0.044],
      [0.03, 0.033, 0.03],
    ],
    // Oxide-orange. The single saturated hue on the ship, and it appears only on
    // hazard chevrons, the tail band and the load-rating stencils.
    accent: [0.4, 0.078, 0.008],
    trim: [0.105, 0.098, 0.062],
    interiorLight: [0.95, 0.42, 0.1],
    // Cool by art direction. Slightly whiter than the player's ship because a
    // fusion torch runs hotter than the hero drive.
    engineCore: [0.44, 0.66, 1.0],
    engineGlow: [0.1, 0.24, 0.66],
    navPort: [0.36, 0.012, 0.012],
    navStarboard: [0.012, 0.3, 0.055],
    navStrobe: [0.85, 0.9, 1.0],
    beacon: [0.55, 0.1, 0.012],
    primer: [0.125, 0.034, 0.018],
    // Exactly `uMetal` from `Ship.ts`, so bare steel matches the hero ship.
    bareMetal: [0.2, 0.21, 0.235],
    oxide: [0.088, 0.032, 0.013],
    scorch: [0.011, 0.0095, 0.0088],
  },

  wear: {
    edges: 0.7,
    hatches: 0.8,
    streaks: 0.45,
    soot: 0.7,
    heat: 0.5,
    pitting: 0.5,
    corrosion: 0.65,
    frost: 0.25,
  },

  families: [
    {
      id: 'kessler/plateline',
      name: 'Plateline',
      roles: ['freighter', 'tanker', 'miner', 'refinery', 'station-tender', 'tug', 'prospector'],
      signature:
        'A parallel-sided hexagonal body with external ribs at every frame and a flat transom; the whole ship is a rectangle in profile and a hexagon head-on.',
      lengthBeamBias: 1.0,
      sectionFamily: 'polygon',
      noseCap: 'blunt',
      accentOverride: null,
    },
    {
      id: 'kessler/revenue',
      name: 'Revenue',
      roles: ['patrol', 'gunship', 'carrier'],
      signature:
        'The same plate, stepped: the armour belt is a visible thickening amidships and the bow is a chined wedge rather than a box.',
      lengthBeamBias: 1.25,
      sectionFamily: 'superellipse',
      noseCap: 'taper',
      accentOverride: null,
    },
    {
      id: 'kessler/tenement',
      name: 'Tenement',
      // 'colony' IS the habitat ship; `ShipRole` has no 'habitat' member. See
      // `HABITAT_ROLE`.
      roles: ['colony', 'liner', 'science', 'survey'],
      signature:
        'Habitat cans on a spine with punched window rows at deck spacing, and unused mounting frames left on for the next module.',
      lengthBeamBias: 0.8,
      sectionFamily: 'polygon',
      noseCap: 'flat',
      accentOverride: null,
    },
  ],

  // A yard whose entire value proposition is field maintainability has no way to
  // build a courier: every gram of their doctrine is weight.
  neverBuilds: ['courier', 'derelict'],
  roleAffinity: {
    freighter: 2.4,
    tanker: 1.8,
    miner: 2.0,
    refinery: 1.6,
    'station-tender': 1.8,
    tug: 1.5,
    patrol: 1.2,
    colony: 1.3,
    survey: 0.6,
    science: 0.4,
    liner: 0.5,
    shuttle: 0.9,
    salvager: 0.7,
  },
  neverBuildsPhysically: [
    'A compound curve. Every surface is developable — rolled, folded or flat — because that is what a brake press and a roller produce.',
    'An aerodynamic fairing on a hull that never enters atmosphere.',
    'A part with no stencil on it saying what it is and what it is rated for.',
    'A sealed assembly. If it cannot be opened it cannot be inspected, and Kessler inspects.',
    'A single-piece structure too large to cut in half and ship on a barge.',
  ],
};

// ---------------------------------------------------------------------------
// Faction 2 — Sillane Formworks
// ---------------------------------------------------------------------------

/**
 * SILLANE — the lean, cast, monocoque culture.
 *
 * Sillane hulls are poured, not assembled. A hull leaves the mould as one
 * continuous object with no seam, no fastener and no part number visible
 * anywhere on it. The doctrine is *closure*: a Sillane ship is a finished
 * article, and everything that follows is downstream of refusing to let anyone
 * see how it comes apart.
 *
 * The consequences are severe and they are what make the ships:
 *
 *   - THE SKIN IS THE RADIATOR. Sillane will not hang fins off a moulded
 *     surface, so heat leaves through the hull, and radiating area is length ×
 *     girth. Their length/beam ratio therefore has a *thermal floor*: a stubby
 *     Sillane cannot reject its own drive heat. This is the single best example
 *     in the fleet of a proportion rule that is an engineering consequence
 *     rather than a style, and it is why their ships look like weapons.
 *   - The drives are recessed. You never see a bell, only a lit throat inside a
 *     shroud, because a bell is a part and parts are visible.
 *   - There is no external structure of any kind: no truss, no boom, no ladder,
 *     no handrail. Their crews do not go outside; there is nothing out there for
 *     them.
 *   - A Sillane hull cannot be repaired, only replaced. So damage on an old one
 *     reads as scarring on a continuous surface, and any repair is somebody
 *     else's bolted-on plate in obviously the wrong shade — a culture with no
 *     repair vocabulary of its own.
 *
 * One designed asymmetry, always to port: a single conformal sensor fairing set
 * off the centreline. It is the head-on identification mark, it costs one
 * feature, and it is the reason a Sillane is recognisable from the one angle
 * where a smooth spindle is otherwise generic.
 *
 * The read, as a black silhouette: one continuous tapered spindle with a
 * hairline chine and nothing protruding. It reads as a *round of ammunition*.
 */
const SILLANE: FactionDna = {
  id: 'sillane',
  name: 'Sillane Formworks',
  shortName: 'Sillane',
  patternWord: 'type',
  blurb:
    'Sillane hulls arrive finished and leave the same way. Nothing on one is labelled, nothing unbolts, and the yard has never published a drawing; when a Sillane is damaged it is not repaired, it is written off and the crew are given another.',
  doctrine: 'A seam is an admission. Pour it in one piece and there is nothing to admit.',

  construction: {
    primary: 'cast-monocoque',
    // A refit is always foreign work: Sillane themselves do not refit.
    refit: 'welded-plate',
    joint: 'cast-fillet',
    // Small panels because there are almost none — what reads as a panel on a
    // Sillane is a moulded surface break, not a plate.
    panelSizeFactor: 0.7,
    panelSizeVariance: 0.02,
    seamDepthFactor: 0.15,
    // Zero. Not "few fasteners" — none, anywhere, on a hull they built.
    fastenerPitchFactor: 0.0,
    exposedStructure: [0.0, 0.06],
    toleranceJitter: 0.04,
    // When a Sillane is repaired it is by someone who does not have the mould.
    repairQuality: [0.15, 0.5],
    maintenance: [0.6, 0.95],
    refits: [0, 1],
    ageYears: [1, 18],
    damageRatePerDecade: [1, 4],
    repairFraction: [0.3, 0.6],
  },

  proportion: {
    // The thermal floor. 5.5 is the shortest hull that can reject a plasma
    // drive's heat through its own skin; below it the flanks glow.
    lengthBeam: [5.5, 11.0],
    lengthHeight: [5.0, 9.5],
    // Just forward of centre. A Sillane carries its payload amidships-forward
    // and trails a long, nearly empty tail, which is what produces the read of a
    // ship falling forward rather than pushing.
    massCentroid: [0.4, 0.52],
    massConcentration: [0.6, 0.85],
    primaryMasses: [1, 2],
    // Near zero: adjacent masses share a diameter because they share a mould.
    diameterStep: [0.02, 0.12],
    taper: [0.45, 0.75],
    overhang: [0.02, 0.15],
  },

  symmetry: {
    policy: 'mirror-with-signature',
    mirrorRate: 0.9,
    // Odd counts are available to them precisely because nothing is designed for
    // field replacement, so there is no parts-stocking argument for pairs.
    radialCounts: [1, 3],
    signature:
      'One conformal sensor fairing set off the centreline, always to port, always forward of the midships station. It is the only thing that breaks the mirror and it is deliberate.',
    signatureSide: 'port',
    clock: 'quantised',
    clockQuantum: Math.PI / 3,
  },

  surface: {
    curvature: 'continuous',
    sectionFamilies: [
      ['superellipse', 7],
      ['twin-lobe', 3],
      ['polygon', 0],
    ],
    // Low exponents: an ellipse or barely more. The opposite end of the same
    // parameter family Kessler lives at, which is exactly why one family spans
    // the fleet.
    exponent: [2.0, 3.2],
    polygonSides: [],
    chamfer: [0.6, 1.0],
    ventralFlatten: [0.9, 1.0],
    // Always at least one harmonic: the chine that runs nose to tail is the
    // Sillane signature line and it is what stops a smooth spindle reading as a
    // pill. Constant phase along the run, per `Ship.ts`, so it reads as a line.
    harmonicCount: [1, 2],
    harmonicFrequencies: [2, 3, 4],
    harmonicAmplitude: [0.025, 0.055],
    lobeCount: [0, 1],
    lobeWidth: [0.5, 1.0],
    lobeDepth: [0.04, 0.12],
    caps: ['ogive', 'taper', 'dome'],
    greebles: ['flush-panel', 'louvre', 'vent', 'grille', 'blister'],
    // The longest forbidden list in the fleet, and that is the character. Every
    // one of these implies either a fastener, a person outside, or a part.
    forbiddenGreebles: [
      'hatch', 'bracket', 'ribbed', 'stack', 'pipe', 'cable-loom', 'conduit',
      'antenna-whip', 'mast', 'ladder', 'handrail', 'clamp', 'drum', 'strut',
      'doubler-plate', 'weld-bead', 'tarp', 'sealant', 'floodlight', 'fairlead',
      'winch-drum',
    ],
    detailDensity: [0.05, 0.22],
    // Higher micro-detail than the others: the surface is smooth, so if it does
    // not carry fine weave it becomes a flat gradient, which ARCHITECTURE §6
    // forbids outright.
    microDetailScale: 1.6,
    roughness: [0.45, 0.68],
    paintFade: [0.05, 0.3],
  },

  structure: {
    member: 'monocoque',
    heavyMember: 'keel-beam',
    exposure: 'buried',
    brace: 'x',
    // Built to the number, not over it. Highest working stress of the three, so
    // for the same load a Sillane member is the thinnest — and since it is
    // buried, what the eye actually gets is a hull with no visible structure.
    workingStressNPerKm2: 2.1e12,
    bayAspect: [2.0, 3.2],
  },

  propulsion: {
    drive: 'plasma',
    mounting: 'recessed',
    nozzle: 'grid',
    engineCounts: [1, 2, 3],
    nozzlesPerPod: [1],
    exitRadiusRatio: [0.5, 0.85],
    // Short: there is no bell, the expansion happens inside the tail.
    bellAspect: [0.25, 0.6],
    gimbal: [0.0, 0.03],
    plumeLength: [11, 20],
    plumeDiamonds: [0, 1],
    plumeFlicker: [0.01, 0.04],
    spoolTime: [0.4, 1.1],
    rcsPerQuad: 4,
    // Tucked in tight against the hull, in recessed ports.
    rcsOutboard: [0.35, 0.6],
  },

  thermal: {
    architecture: 'skin',
    areaPerWatt: 1.9e-13,
    aspect: [6.0, 12.0],
    elementCounts: [0],
    mirrored: true,
    // The whole point: no fins means the flanks stain. Highest heat weighting in
    // the fleet, and it appears as long thermal strakes running aft, which is
    // detail that follows function exactly as BRIEF §7 demands.
    heatStaining: [0.7, 1.0],
  },

  sensors: {
    language: 'conformal-array',
    modules: ['sensor-array', 'antenna-mast'],
    standoff: [0.0, 0.03],
    dishRatio: [0.0, 0.0],
    count: [1, 2],
  },

  markings: {
    kinds: ['registry', 'emblem'],
    registryPattern: '9999',
    registryLetters: '',
    // A tenth of Kessler's, and cut into the surface rather than painted. It
    // exists for traffic control, not for people.
    capHeightDecks: [0.12, 0.3],
    placement: ['ventral', 'nose'],
    application: 'etched',
    overpaint: 0.0,
    wear: [0.02, 0.15],
    // Sillane hulls carry a number and no name. The crews name them anyway, and
    // that name never appears on the hull.
    namesShips: false,
  },

  palette: {
    // Cold blue-grey, darker than Kessler. The hue difference alone is enough to
    // tell the two apart under a warm star.
    hull: [0.036, 0.043, 0.056],
    hullShadow: [0.0035, 0.0042, 0.006],
    // Within 2% of each other: one casting, one batch of pigment. The plate-to-
    // plate drift that saves a Kessler hull from looking painted is exactly what
    // a Sillane hull must not have.
    plateShades: [
      [0.0352, 0.0421, 0.0549],
      [0.0368, 0.0439, 0.0571],
      [0.036, 0.043, 0.056],
    ],
    // Foreign work, and it shows: warm greys and red primer against a cold hull.
    patchShades: [
      [0.082, 0.07, 0.05],
      [0.048, 0.052, 0.046],
      [0.1, 0.052, 0.024],
    ],
    mismatch: [
      [0.075, 0.066, 0.05],
      [0.052, 0.048, 0.042],
    ],
    // Bone white, not a hue: a single hairline along the chine and a ring round
    // the drive throat. Unsaturated accent is *more* noir than a coloured one,
    // and it separates cleanly from Kessler's orange and Ossuary's green.
    accent: [0.52, 0.5, 0.45],
    trim: [0.07, 0.076, 0.088],
    interiorLight: [0.9, 0.46, 0.14],
    engineCore: [0.3, 0.58, 1.0],
    engineGlow: [0.055, 0.15, 0.5],
    navPort: [0.3, 0.01, 0.01],
    navStarboard: [0.01, 0.26, 0.048],
    navStrobe: [0.9, 0.94, 1.0],
    beacon: [0.6, 0.14, 0.02],
    // Grey primer, not red oxide: they do not use an iron-rich primer, so damage
    // on a Sillane never shows the rust-red under-layer everyone else has.
    primer: [0.055, 0.056, 0.052],
    bareMetal: [0.19, 0.2, 0.225],
    oxide: [0.07, 0.036, 0.02],
    scorch: [0.01, 0.01, 0.011],
  },

  wear: {
    edges: 0.3,
    hatches: 0.15,
    streaks: 0.35,
    soot: 0.3,
    // Skin radiator. This is the dominant wear story on every Sillane hull.
    heat: 0.95,
    pitting: 0.55,
    corrosion: 0.15,
    frost: 0.2,
  },

  families: [
    {
      id: 'sillane/needle',
      name: 'Needle',
      roles: ['courier', 'shuttle', 'patrol', 'gunship'],
      signature:
        'A single ogive spindle with a 3-lobe chine and a recessed throat; the beam never exceeds a tenth of the length.',
      lengthBeamBias: 1.2,
      sectionFamily: 'superellipse',
      noseCap: 'ogive',
      accentOverride: null,
    },
    {
      id: 'sillane/carapace',
      name: 'Carapace',
      roles: ['freighter', 'tanker', 'liner', 'carrier', 'colony'],
      signature:
        'A twin-lobe body — two fused pressure hulls under one continuous skin, with a waist you can see from head-on and nowhere else.',
      lengthBeamBias: 0.78,
      sectionFamily: 'twin-lobe',
      noseCap: 'dome',
      accentOverride: null,
    },
    {
      id: 'sillane/lector',
      name: 'Lector',
      roles: ['survey', 'science', 'salvager', 'miner', 'prospector', 'tug', 'refinery', 'station-tender', 'derelict'],
      signature:
        'The Needle body with a dorsal instrument spine faired into it, so the sensors read as a swelling in the hull rather than as hardware bolted on top.',
      lengthBeamBias: 1.0,
      sectionFamily: 'superellipse',
      noseCap: 'taper',
      accentOverride: null,
    },
  ],

  // Mining and salvage require external machinery, jointed arms and people
  // working outside. Every one of those is a thing Sillane cannot make.
  neverBuilds: ['miner', 'salvager', 'refinery', 'station-tender', 'prospector'],
  roleAffinity: {
    courier: 2.6,
    patrol: 1.8,
    gunship: 1.4,
    science: 1.6,
    survey: 1.2,
    liner: 1.4,
    shuttle: 1.2,
    freighter: 0.7,
    tanker: 0.7,
    carrier: 0.6,
    colony: 0.4,
    tug: 0.3,
  },
  neverBuildsPhysically: [
    'An external truss, boom or outrigger. If it is structure, it is inside the skin.',
    'A ladder or a handrail. Nobody goes outside a Sillane hull in flight.',
    'A radiator fin. The hull rejects its own heat, which is why the hull is long.',
    'A visible fastener anywhere on a hull they built.',
    'A ship whose function you can identify from the outside — every Sillane looks like every other Sillane until it does something.',
  ],
};

// ---------------------------------------------------------------------------
// Faction 3 — Ossuary Reach Breakers
// ---------------------------------------------------------------------------

/**
 * OSSUARY — the scavenger culture that builds by accretion onto salvaged spines.
 *
 * Not a company. A breakers' anchorage where hulls are cut up and the good parts
 * go back out on somebody else's keel. Nothing an Ossuary crew makes starts from
 * zero: the keel already existed, was already flown by two other operators, and
 * has already been repaired badly at least once.
 *
 * That single fact produces the whole design language, which is why it holds up:
 *
 *   - NO SYMMETRY POLICY. Masses go where the found keel is still sound. Their
 *     asymmetry is a consequence, not a style, and that is the difference
 *     between "assembled by people" and "randomised by a generator".
 *   - The keel is *exposed*, because they did not build it and cannot fair it.
 *     It is the one thing on the ship that looks engineered, precisely because
 *     someone else engineered it.
 *   - Adjacent volumes do not share a section family, a diameter or a plate
 *     size. Each donor kept its own. `panelSizeVariance` is the highest in the
 *     fleet, and it is the strongest close-range read there is.
 *   - The engines are a mismatched pair, because two identical drives never come
 *     out of one breaking at the same time. The thrust axis therefore misses the
 *     centre of mass, and they counterweight rather than re-mount — which is a
 *     legitimate, statable `thrustOffsetReason` and one the physics reviewer can
 *     accept instead of flagging.
 *   - Radiators are bare pipe loops on field-made frames plus whatever panels
 *     came off the last hull, bolted at whatever angles cleared. Never a
 *     matched pair.
 *   - The crew live on the outside as much as the inside: ladders, handrails,
 *     fairleads, floodlights, lashed drums, a tarp over the thing that leaks.
 *
 * The read, as a black silhouette: a stick with mismatched cans threaded onto
 * it and an antenna forest at the front. It reads as a *pile that flies*.
 */
const OSSUARY: FactionDna = {
  id: 'ossuary',
  name: 'Ossuary Reach Breakers',
  shortName: 'Ossuary',
  // Not "pattern": a pattern implies a drawing, and there has never been one.
  patternWord: 'built',
  blurb:
    'Ossuary Reach cuts up ships and sends the good parts back out on somebody else\'s keel. Nothing they fly was designed; every hull is an argument between three previous owners that the current crew is losing slowly.',
  doctrine: 'It flew here, so it will fly out. Weld the new one on and do not ask what happened to the last crew.',

  construction: {
    primary: 'salvage-weld',
    refit: 'riveted-plate',
    joint: 'torch-cut-graft',
    panelSizeFactor: 1.0,
    // The highest in the fleet by a wide margin, and the single most legible
    // "this is a scavenger hull" cue at close range: each section keeps the
    // plate size of the yard that originally built it.
    panelSizeVariance: 0.65,
    seamDepthFactor: 1.9,
    fastenerPitchFactor: 0.75,
    exposedStructure: [0.6, 0.95],
    // Nothing lines up, because nothing was cut to fit anything.
    toleranceJitter: 0.75,
    repairQuality: [0.05, 0.45],
    maintenance: [0.1, 0.5],
    refits: [2, 5],
    // Ages that make no sense for one ship, because it is not one ship.
    ageYears: [25, 120],
    damageRatePerDecade: [6, 16],
    // Half the damage on an Ossuary hull predates the current crew and will
    // outlast them.
    repairFraction: [0.35, 0.7],
  },

  proportion: {
    lengthBeam: [2.2, 4.6],
    lengthHeight: [1.8, 3.6],
    // The widest band in the fleet, and deliberately so: the mass sits wherever
    // the found keel put it. This is the value the counterweight and the canted
    // engine exist to compensate for.
    massCentroid: [0.4, 0.75],
    // Lumpy. Low concentration and a wide band means the inertia tensor comes
    // out with real off-diagonal terms, so an Ossuary hull tumbles oddly with
    // assist off — which is a gameplay consequence of a visual decision.
    massConcentration: [0.2, 0.55],
    primaryMasses: [3, 6],
    // Enormous steps: the cans do not match and were never meant to.
    diameterStep: [0.45, 0.85],
    taper: [0.0, 0.2],
    // Everything sticks out. Head-on, an Ossuary is twice the width of its hull.
    overhang: [0.9, 1.9],
  },

  symmetry: {
    policy: 'opportunistic',
    // Mirrored only where physics forces it: landing gear and RCS quads. Nothing
    // else.
    mirrorRate: 0.15,
    radialCounts: [1, 2, 3, 5],
    signature: null,
    signatureSide: null,
    // Anywhere round the spine that was free — which, because the spine is the
    // only sound structure, is where everything ends up.
    clock: 'arbitrary',
    clockQuantum: 0,
  },

  surface: {
    curvature: 'mixed',
    // All three families in play, and adjacent volumes are allowed to differ —
    // legal because `SectionShape` is per-volume, and the resulting welded
    // collar between a hexagon and a circle is the shape of this faction.
    sectionFamilies: [
      ['polygon', 4],
      ['superellipse', 4],
      ['twin-lobe', 2],
    ],
    exponent: [2.2, 7.0],
    polygonSides: [3, 4, 6, 8],
    chamfer: [0.0, 0.8],
    ventralFlatten: [0.65, 1.0],
    harmonicCount: [0, 1],
    harmonicFrequencies: [3, 5, 6],
    harmonicAmplitude: [0.03, 0.09],
    // Blisters and sponsons everywhere: every one is something that would not
    // fit inside, so it got a bulge welded over it.
    lobeCount: [1, 4],
    lobeWidth: [0.2, 0.9],
    lobeDepth: [0.1, 0.35],
    caps: ['flat', 'blunt', 'open', 'dome'],
    // Everything. The accumulation is the point.
    greebles: [
      'hatch', 'bracket', 'ribbed', 'stack', 'pipe', 'vent', 'grille', 'blister',
      'cable-loom', 'conduit', 'antenna-whip', 'mast', 'ladder', 'handrail',
      'clamp', 'drum', 'strut', 'doubler-plate', 'weld-bead', 'tarp', 'sealant',
      'floodlight', 'fairlead', 'winch-drum',
    ],
    // The two things that need a die and a mould, which is the exact inversion
    // of Sillane's list. Nothing on an Ossuary hull was pressed.
    forbiddenGreebles: ['flush-panel', 'louvre'],
    detailDensity: [0.7, 1.0],
    microDetailScale: 1.15,
    roughness: [0.8, 0.97],
    paintFade: [0.6, 1.0],
  },

  structure: {
    // A found keel: usually somebody's box-truss, sometimes a cut-down tube.
    member: 'box-truss',
    heavyMember: 'tube',
    exposure: 'exposed',
    // Zigzag because it is the brace pattern you can cut and fit by eye.
    brace: 'zigzag',
    // Between the other two — the keel was properly engineered by whoever built
    // it, so the members are correctly sized. It is everything bolted to them
    // that is not.
    workingStressNPerKm2: 1.4e12,
    bayAspect: [0.9, 2.4],
  },

  propulsion: {
    // An old torch running rich, or straight chemical when the torch died.
    drive: 'fusion-torch',
    mounting: 'podded',
    // Exposed turbomachinery round the throat: the drive with its cowling gone,
    // because the cowling was the first thing sold.
    nozzle: 'open-cycle',
    // Two, and they will not match. Three when the third came free.
    engineCounts: [1, 2, 3],
    nozzlesPerPod: [1, 2, 3],
    exitRadiusRatio: [0.25, 0.6],
    bellAspect: [0.9, 1.7],
    gimbal: [0.0, 0.06],
    plumeLength: [5, 11],
    plumeDiamonds: [2, 5],
    // Ten times Sillane's. A flickering plume is the cheapest possible statement
    // that a drive is out of tune, and it is visible from further away than any
    // amount of hull detail.
    plumeFlicker: [0.25, 0.55],
    spoolTime: [2.0, 5.0],
    // Three, not four: one of the quad has been dead for years.
    rcsPerQuad: 3,
    rcsOutboard: [0.6, 1.3],
  },

  thermal: {
    architecture: 'pipe-loop',
    // Terrible efficiency — bare tube is a bad radiator — so an Ossuary hull
    // needs a lot of it, and that clutter is a large part of the silhouette.
    areaPerWatt: 5.5e-13,
    aspect: [1.2, 3.0],
    // Odd counts allowed and expected.
    elementCounts: [1, 2, 3, 5],
    mirrored: false,
    heatStaining: [0.5, 0.85],
  },

  sensors: {
    language: 'whip-forest',
    modules: ['sensor-dish', 'sensor-array', 'antenna-mast'],
    standoff: [0.15, 0.6],
    // A dish that is obviously off a much larger ship. The mismatch is the joke
    // and it is also the front-on identification.
    dishRatio: [0.25, 0.55],
    count: [3, 7],
  },

  markings: {
    kinds: ['registry', 'name', 'emblem', 'hazard', 'stencil', 'numeral'],
    // One or two digits: the anchorage has only ever had a few dozen hulls.
    registryPattern: 'A-99',
    registryLetters: 'BPGDRWK',
    capHeightDecks: [0.6, 2.2],
    placement: ['largest-flat', 'bow-flank', 'nose'],
    application: 'hand-painted',
    // Two thirds of the previous owner's markings still show through, and on a
    // hull with three previous owners you can read all of them.
    overpaint: 0.65,
    wear: [0.55, 0.95],
    namesShips: true,
  },

  palette: {
    // Brown-black: iron oxide over three greys, none of which was the plan.
    hull: [0.046, 0.035, 0.026],
    hullShadow: [0.005, 0.0042, 0.0035],
    // Wide, not tight: these are genuinely different plates from different
    // yards, so the drift is large enough to see across the hull.
    plateShades: [
      [0.032, 0.028, 0.024],
      [0.055, 0.04, 0.028],
      [0.04, 0.04, 0.036],
      [0.062, 0.046, 0.03],
      [0.026, 0.026, 0.028],
    ],
    patchShades: [
      [0.115, 0.04, 0.02],
      [0.07, 0.072, 0.062],
      [0.024, 0.03, 0.034],
      [0.09, 0.078, 0.046],
    ],
    // Five donors, and the second entry is literally Sillane's hull colour: a
    // Sillane module on an Ossuary hull is the best story in the palette, and it
    // costs one line.
    mismatch: [
      [0.058, 0.062, 0.05],
      [0.036, 0.043, 0.056],
      [0.1, 0.038, 0.018],
      [0.07, 0.066, 0.058],
      [0.022, 0.024, 0.026],
    ],
    // Acid green. Nothing else in the game is green, so it separates at any
    // distance from Kessler's orange and Sillane's bone, and it reads as cheap
    // industrial spray paint rather than as livery.
    accent: [0.145, 0.255, 0.016],
    trim: [0.15, 0.115, 0.02],
    interiorLight: [1.0, 0.38, 0.07],
    // Cool, per art direction, but muddier and dimmer than the other two: the
    // instability lives in `plumeFlicker`, not in the hue.
    engineCore: [0.34, 0.44, 0.86],
    engineGlow: [0.12, 0.16, 0.42],
    navPort: [0.34, 0.014, 0.01],
    navStarboard: [0.014, 0.26, 0.05],
    navStrobe: [0.8, 0.82, 0.88],
    beacon: [0.6, 0.16, 0.014],
    // Red oxide, and a lot of it — most of an Ossuary hull is primer that never
    // got a topcoat, which is why the base hull colour is brown in the first
    // place.
    primer: [0.15, 0.045, 0.022],
    bareMetal: [0.2, 0.21, 0.235],
    oxide: [0.105, 0.038, 0.014],
    scorch: [0.013, 0.01, 0.008],
  },

  wear: {
    edges: 0.9,
    hatches: 0.95,
    streaks: 0.85,
    soot: 0.95,
    heat: 0.6,
    pitting: 0.85,
    corrosion: 1.0,
    frost: 0.5,
  },

  families: [
    {
      id: 'ossuary/threadline',
      name: 'Threadline',
      roles: ['freighter', 'tanker', 'tug', 'station-tender', 'colony', 'liner', 'carrier'],
      signature:
        'An exposed box-truss keel with four to six mismatched cans threaded onto it at arbitrary clock angles, and the gaps between them left open.',
      lengthBeamBias: 1.15,
      sectionFamily: null,
      noseCap: 'flat',
      accentOverride: null,
    },
    {
      id: 'ossuary/gutwork',
      name: 'Gutwork',
      roles: ['salvager', 'miner', 'prospector', 'refinery'],
      signature:
        'A short keel almost buried under working machinery, with two jointed arms that can fold back past the drives and a floodlit open working bay amidships.',
      lengthBeamBias: 0.85,
      sectionFamily: 'polygon',
      noseCap: 'open',
      // A working hull gets more of the acid green than a hauler does: the
      // hazard striping round the arms is the largest marked area on the ship.
      accentOverride: [0.17, 0.3, 0.02],
    },
    {
      id: 'ossuary/scrapjack',
      name: 'Scrapjack',
      roles: ['courier', 'shuttle', 'patrol', 'gunship', 'survey', 'science', 'derelict'],
      signature:
        'One donor hull with everything non-essential cut off and a drive far too large for it bolted to the transom on a field-welded frame.',
      lengthBeamBias: 1.3,
      sectionFamily: 'superellipse',
      noseCap: 'blunt',
      accentOverride: null,
    },
  ],

  // A liner is a promise about safety. Ossuary cannot make one and would not.
  neverBuilds: ['liner'],
  roleAffinity: {
    salvager: 3.0,
    prospector: 2.0,
    miner: 1.6,
    tug: 1.8,
    freighter: 1.4,
    derelict: 2.5,
    'station-tender': 1.4,
    refinery: 1.1,
    courier: 0.8,
    patrol: 0.5,
    gunship: 0.5,
    survey: 0.7,
    science: 0.3,
    colony: 0.9,
    carrier: 0.3,
  },
  neverBuildsPhysically: [
    'Anything symmetric on purpose. Where an Ossuary hull is symmetric it is because the part came in a pair.',
    'A pressure vessel from scratch. Every tank on the ship was a tank when they found it.',
    'A flush surface. Every plate on the hull overlaps the one beside it.',
    'A part that cannot be cut off with a torch in under an hour.',
    'A ship that could not be broken up again for parts inside a week — which is the only design requirement they actually hold themselves to.',
  ],
};

/**
 * The fleet. Ordered coarse → fine in visual weight, which is also the order a
 * showroom should present them in.
 */
export const FACTIONS: readonly FactionDna[] = [KESSLER, SILLANE, OSSUARY];

export const FACTION_IDS: readonly FactionId[] = FACTIONS.map((f) => f.id);

/** Used when a caller has no opinion. The most generic of the three. */
export const DEFAULT_FACTION_ID: FactionId = 'kessler';

const FACTION_BY_ID: ReadonlyMap<string, FactionDna> = new Map(FACTIONS.map((f) => [f.id, f]));

// ---------------------------------------------------------------------------
// Roles — functional requirements, not shapes
// ---------------------------------------------------------------------------

/** How many sockets of a type a role needs. */
export interface SocketDemand {
  readonly type: SocketType;
  readonly min: number;
  readonly max: number;
}

/**
 * What must be different between this role and its nearest neighbour.
 *
 * This is the most important field in the file. Two roles collapse into one hull
 * when the generator satisfies both of their requirement lists with the same
 * shape, and the only defence is to state, per pair, the one thing that must
 * differ. A reviewer holding two renders can check every entry here without
 * knowing anything about the generator.
 */
export interface RoleContrast {
  readonly role: ShipRole;
  readonly by: string;
}

export interface RoleSpec {
  readonly id: ShipRole;
  /** Uppercase-safe short label for the HUD and the scan line. */
  readonly label: string;
  /** One sentence: what this ship is for. */
  readonly summary: string;

  // --- what the role demands -----------------------------------------------

  /** Without every one of these the hull does not perform the role. */
  readonly requiredModules: readonly ModuleKind[];
  /**
   * At least one of these must be present AND must be among the largest visible
   * objects on the ship. This is what turns "has a sensor" into "is a sensor
   * ship" — the difference between a role and a label.
   */
  readonly signatureModules: readonly ModuleKind[];
  /** Never, on this role, regardless of faction or seed. */
  readonly forbiddenModules: readonly ModuleKind[];
  readonly sockets: readonly SocketDemand[];
  readonly requiredVolumeKinds: readonly VolumeKind[];
  readonly forbiddenVolumeKinds: readonly VolumeKind[];

  // --- mass, proportion, performance ---------------------------------------

  /**
   * Where the dry CoM must sit along the hull, 0 = nose, 1 = exhaust plane.
   * Intersected with the faction's band by `proportionFor`.
   */
  readonly massCentroid: Range;
  /**
   * How far the CoM moves when the ship is fully loaded, as a signed fraction of
   * length; negative is forward. A freighter's shifts a long way and a courier's
   * barely moves, and that difference is a real handling difference the player
   * feels, not a statistic.
   */
  readonly loadedCentroidShift: Range;
  readonly massConcentration: Range;
  readonly lengthBeam: Range;
  readonly sizeClasses: readonly SizeClass[];
  readonly crew: Range;
  /**
   * Main-drive acceleration at dry mass, m/s². The player's own ship is 200
   * (`DEFAULT_SHIP_CONFIG`: 4.0e7 N ÷ 2.0e5 kg), and every band here is scaled
   * against that.
   */
  readonly accelMs2: Range;
  /** Angular authority relative to the player's ship, where 1 matches it. */
  readonly agility: Range;
  /** Delta-v at full load, km/s. Feeds `PhysicsProfile.deltaVKmS`. */
  readonly deltaVKmS: Range;
  /** Cruise ceiling, km/s. `DEFAULT_SHIP_CONFIG.topSpeed` is 60. */
  readonly topSpeedKmS: Range;
  /**
   * Cargo volume as a fraction of enclosed pressurised volume. Zero means the
   * role carries nothing and must not look as though it could.
   */
  readonly cargoFraction: Range;

  // --- what the silhouette must communicate ---------------------------------

  /** Statements a critic must be able to make about the black silhouette. */
  readonly silhouetteReads: readonly string[];
  /** Statements a critic must NOT be able to make. Any one of these is a reject. */
  readonly silhouetteMustNot: readonly string[];
  /** The pairwise separations that keep the seven roles seven. */
  readonly distinguishFrom: readonly RoleContrast[];

  // --- surface and story ----------------------------------------------------

  /** Band for `PrimaryVolume.detailDensity`, before the faction's band. */
  readonly detailDensity: Range;
  /**
   * Wear multipliers for this role, applied on top of the faction's baseline.
   * A miner is pitting and edges; a colony is corrosion and frost. This is how
   * "wear tells a specific story" (BRIEF §8) is made per-role rather than
   * per-ship-noise.
   */
  readonly wearBias: WearWeights;
  readonly markings: readonly MarkingKind[];
  readonly threatClass: ThreatClass;
  /** Whether this role's hull is pressurised, and whether it ever lands. */
  readonly pressurised: boolean;
  readonly lands: boolean;
  /** 0..1 baseline detection signatures. Drives `ScanProfile`. */
  readonly thermalSignature: Range;
  readonly radarSignature: Range;
  readonly emSignature: Range;
}

/** No wear emphasis in any direction; the faction baseline stands. */
const NEUTRAL_WEAR: WearWeights = {
  edges: 1,
  hatches: 1,
  streaks: 1,
  soot: 1,
  heat: 1,
  pitting: 1,
  corrosion: 1,
  frost: 1,
};

/**
 * The seven roles the brief names, plus the eleven remaining `ShipRole` values.
 *
 * Written as a `Record<ShipRole, RoleSpec>` on purpose: TypeScript then refuses
 * to compile if a role is missing, so `roleById` is total by construction and
 * `blueprint.ts` can never hit a hole. The seven briefed roles carry the design
 * argument; the other eleven are real specifications and not aliases, because an
 * alias is exactly the "same hull, different label" failure the brief rejects.
 *
 * MAPPING NOTE. The brief's seventh role is "habitat". `ShipRole` has no
 * `'habitat'` member — the habitat ship is `'colony'`, and `'habitat'` exists in
 * the contract only as a `SocketType`, a `VolumeKind` and a `ModuleKind`.
 * `HABITAT_ROLE` below is the alias, so nobody has to rediscover this.
 */
const ROLE_TABLE: Record<ShipRole, RoleSpec> = {
  // =========================================================================
  // 1 of 7 — COURIER / SCOUT
  // =========================================================================
  courier: {
    id: 'courier',
    label: 'Courier',
    summary:
      'Moves one small, urgent thing a very long way. Everything on the hull is either propellant, drive, or the person who signs for it.',
    requiredModules: ['cockpit', 'sensor-array', 'navlight', 'airlock'],
    // The drive is the signature. On a courier the nozzle assembly is a larger
    // object than the cabin, and if it is not, the ship has failed the role.
    signatureModules: ['cockpit', 'sensor-array'],
    forbiddenModules: [
      'cargo-container', 'cargo-pod', 'ore-bin', 'crane', 'winch', 'grapple-arm',
      'mining-head', 'mining-boom', 'ore-processor', 'cutting-rig', 'radiator-drum',
      'habitat-can', 'missile-rack',
    ],
    sockets: [
      { type: 'cockpit', min: 1, max: 1 },
      { type: 'engine', min: 1, max: 2 },
      { type: 'rcs', min: 8, max: 16 },
      { type: 'sensor', min: 1, max: 2 },
      { type: 'airlock', min: 1, max: 1 },
      { type: 'docking', min: 1, max: 1 },
      { type: 'navlight', min: 4, max: 8 },
      { type: 'emblem', min: 1, max: 2 },
    ],
    requiredVolumeKinds: ['forebody', 'tank', 'afterbody'],
    forbiddenVolumeKinds: ['cargo-rack', 'machinery', 'ring', 'boom'],
    // Aft: the tank and the drive are essentially the whole ship.
    massCentroid: [0.58, 0.7],
    loadedCentroidShift: [-0.02, 0.01],
    massConcentration: [0.65, 0.9],
    lengthBeam: [5.0, 10.0],
    sizeClasses: ['shuttle', 'light', 'medium'],
    crew: [1, 3],
    // The fastest thing in the game after a gunship, and the only role allowed
    // above the player's own 200 m/s² as a matter of course.
    accelMs2: [240, 620],
    agility: [1.1, 1.8],
    deltaVKmS: [90, 220],
    topSpeedKmS: [80, 140],
    cargoFraction: [0.02, 0.1],
    silhouetteReads: [
      'the hull is one continuous line from nose to nozzle with nothing interrupting it',
      'the drive is large in proportion to the body',
      'the pressurised part is a small cap on the front of a much longer tank',
      'nothing protrudes far enough sideways to change the head-on outline',
    ],
    silhouetteMustNot: [
      'look as though it could carry freight',
      'carry anything on the outside of the hull',
      'be as wide as it is deep — a courier is a line, not a block',
      'have a radiator you can see from the side',
    ],
    distinguishFrom: [
      { role: 'survey', by: 'a courier carries one small flush sensor; a survey ship\'s instruments are the largest objects on it and are held clear of the hull on booms.' },
      { role: 'patrol', by: 'a courier has no weapon socket and no armour stepping; a patrol\'s beam is visibly thickened amidships to carry barbettes.' },
      { role: 'shuttle', by: 'a shuttle is blunt and short (L/B under 3); a courier\'s L/B is never below 5.' },
      { role: 'gunship', by: 'a gunship trades range for weapons — its delta-v is a third of a courier\'s and its tanks are armoured, not the whole hull.' },
    ],
    detailDensity: [0.1, 0.35],
    wearBias: {
      edges: 1.2,
      hatches: 1.0,
      // Streaked hard: a courier spends its life at full throttle.
      streaks: 1.4,
      soot: 1.3,
      heat: 1.2,
      // Forward-facing surfaces take a decade of dust at cruise speed.
      pitting: 1.5,
      corrosion: 0.5,
      frost: 0.7,
    },
    markings: ['registry', 'name', 'emblem', 'stripe'],
    threatClass: 'unarmed',
    pressurised: true,
    lands: true,
    thermalSignature: [0.55, 0.85],
    radarSignature: [0.1, 0.28],
    emSignature: [0.2, 0.45],
  },

  // =========================================================================
  // 2 of 7 — FREIGHTER
  // =========================================================================
  freighter: {
    id: 'freighter',
    label: 'Freighter',
    summary:
      'Carries countable units of other people\'s property. The cargo is the ship; the crew section is a room bolted to the front of it.',
    requiredModules: ['cockpit', 'cargo-container', 'docking-collar', 'airlock', 'navlight'],
    signatureModules: ['cargo-container', 'cargo-pod'],
    forbiddenModules: [
      'turret', 'missile-rack', 'mining-head', 'mining-boom', 'cutting-rig',
      'grapple-arm', 'ore-processor',
    ],
    sockets: [
      { type: 'cockpit', min: 1, max: 1 },
      { type: 'cargo', min: 4, max: 40 },
      { type: 'engine', min: 2, max: 6 },
      { type: 'rcs', min: 12, max: 32 },
      { type: 'docking', min: 1, max: 4 },
      { type: 'airlock', min: 1, max: 3 },
      { type: 'radiator', min: 2, max: 6 },
      { type: 'landing', min: 0, max: 6 },
      { type: 'navlight', min: 8, max: 24 },
      { type: 'service', min: 4, max: 20 },
      { type: 'emblem', min: 2, max: 4 },
    ],
    requiredVolumeKinds: ['forebody', 'cargo-bay', 'afterbody', 'radiator'],
    forbiddenVolumeKinds: ['machinery'],
    massCentroid: [0.6, 0.74],
    // The largest loaded shift of any role, and a real one: a laden freighter
    // pitches around a different point than an empty one, which is why the trim
    // tanks and the RCS quads are where they are.
    loadedCentroidShift: [-0.2, -0.09],
    massConcentration: [0.25, 0.5],
    lengthBeam: [3.0, 6.0],
    sizeClasses: ['medium', 'heavy', 'capital', 'super-capital'],
    crew: [2, 9],
    accelMs2: [18, 70],
    agility: [0.25, 0.55],
    deltaVKmS: [20, 55],
    topSpeedKmS: [25, 45],
    cargoFraction: [0.55, 0.85],
    silhouetteReads: [
      'the cargo is the majority of the volume and is visibly a separate, separable thing',
      'you can count the units — a freighter has a number of containers, not an amount of cargo',
      'the crew section is small and stuck on the front',
      'the load path from the cargo to the engines is visible as structure',
    ],
    silhouetteMustNot: [
      'look armed',
      'look fast',
      'hide its cargo inside a smooth continuous hull — that is a tanker or a liner',
      'have the crew section anywhere but the extreme forward end',
    ],
    distinguishFrom: [
      { role: 'tanker', by: 'a freighter\'s cargo has flat faces, hard edges and countable units; a tanker\'s is one pressure vessel with domed ends, girth bands and no separable parts.' },
      { role: 'miner', by: 'a freighter has no machinery outboard of its hull at all; the forwardmost object on a miner is a tool.' },
      { role: 'colony', by: 'freight containers have no windows; habitat cans have window rows at deck spacing, and that is readable at any distance where the ship is more than a dot.' },
      { role: 'carrier', by: 'a freighter\'s bays are closed and face outward for a cargo arm; a carrier\'s deck is open along the ship\'s axis and is the silhouette.' },
    ],
    detailDensity: [0.4, 0.7],
    wearBias: {
      // Everything the cargo handling touches: the dominant wear story is
      // loading, not flight.
      edges: 1.4,
      hatches: 1.5,
      streaks: 1.0,
      soot: 0.9,
      heat: 0.8,
      pitting: 0.9,
      corrosion: 1.2,
      frost: 0.9,
    },
    markings: ['registry', 'name', 'emblem', 'hazard', 'stencil', 'numeral', 'stripe'],
    threatClass: 'unarmed',
    pressurised: true,
    lands: false,
    thermalSignature: [0.4, 0.7],
    radarSignature: [0.7, 1.0],
    emSignature: [0.25, 0.5],
  },

  // =========================================================================
  // 3 of 7 — MINER
  // =========================================================================
  miner: {
    id: 'miner',
    label: 'Miner',
    summary:
      'Takes a rock apart and keeps the useful third. Industrial machinery is on the outside because dust would destroy anything you tried to fair over it.',
    // The floodlights a miner obviously needs are greebles, not modules — see
    // `GreebleFamily`. Only load-bearing hardware is listed here.
    requiredModules: ['cockpit', 'mining-head', 'ore-bin', 'radiator-panel', 'landing-leg'],
    signatureModules: ['mining-head', 'mining-boom', 'ore-processor'],
    forbiddenModules: ['missile-rack', 'cargo-container'],
    sockets: [
      { type: 'cockpit', min: 1, max: 1 },
      { type: 'mining', min: 2, max: 8 },
      { type: 'cargo', min: 2, max: 12 },
      { type: 'engine', min: 2, max: 4 },
      { type: 'rcs', min: 12, max: 24 },
      { type: 'radiator', min: 2, max: 6 },
      { type: 'landing', min: 3, max: 6 },
      { type: 'airlock', min: 1, max: 3 },
      { type: 'service', min: 8, max: 30 },
      { type: 'navlight', min: 6, max: 16 },
      { type: 'emblem', min: 1, max: 3 },
    ],
    requiredVolumeKinds: ['machinery', 'cargo-rack', 'keel', 'radiator'],
    forbiddenVolumeKinds: ['ring'],
    // Spread: cutting gear forward, bins amidships, drive aft. The lowest
    // concentration of any powered role, which is why a miner wallows.
    massCentroid: [0.48, 0.62],
    loadedCentroidShift: [-0.12, -0.04],
    massConcentration: [0.15, 0.4],
    lengthBeam: [2.2, 4.0],
    sizeClasses: ['medium', 'heavy', 'capital'],
    crew: [4, 14],
    accelMs2: [25, 90],
    agility: [0.3, 0.6],
    deltaVKmS: [15, 40],
    topSpeedKmS: [20, 38],
    cargoFraction: [0.3, 0.55],
    silhouetteReads: [
      'the forwardmost object on the ship is a tool, not a window',
      'there is a machine on the outside that obviously moves, and you can see its travel',
      'ore goes in somewhere and you can see where',
      'the structure is exposed for its whole length because there is no point fairing it',
      'the ship is asymmetric front-to-back in a way a hauler never is',
    ],
    silhouetteMustNot: [
      'look clean',
      'look like a warship because it has a large object on the nose',
      'have its machinery enclosed',
      'be the same shape read forwards and backwards',
    ],
    distinguishFrom: [
      { role: 'salvager', by: 'a miner\'s tools are fixed and point forward along the thrust axis; a salvager\'s arms are jointed, traverse past 180°, and can reach behind the ship.' },
      { role: 'freighter', by: 'on a miner the machinery outweighs the bins and the bins are open-topped; on a freighter there is no machinery and the containers are sealed.' },
      { role: 'refinery', by: 'a refinery has stacks, flares and a continuous process train; a miner has a drill and a bin, and nothing on it burns.' },
      { role: 'prospector', by: 'a prospector carries one head and one bin and is a light hull; a miner carries a battery of heads and a processing train.' },
    ],
    detailDensity: [0.7, 1.0],
    wearBias: {
      edges: 1.5,
      hatches: 1.3,
      streaks: 0.8,
      soot: 1.0,
      heat: 1.2,
      // Abrasive dust, constantly, on every forward-facing surface. The
      // strongest single wear signal in the fleet.
      pitting: 1.8,
      corrosion: 1.3,
      frost: 0.8,
    },
    markings: ['registry', 'name', 'hazard', 'stencil', 'numeral'],
    threatClass: 'defensive',
    pressurised: true,
    lands: true,
    thermalSignature: [0.7, 1.0],
    radarSignature: [0.55, 0.85],
    emSignature: [0.5, 0.8],
  },

  // =========================================================================
  // 4 of 7 — SURVEY  (the player's own class)
  // =========================================================================
  survey: {
    id: 'survey',
    label: 'Survey',
    summary:
      'Measures things nobody has measured. The instruments are held away from the hull because the hull is the loudest source of interference on the ship.',
    requiredModules: ['cockpit', 'sensor-dish', 'sensor-array', 'antenna-mast', 'radiator-panel'],
    signatureModules: ['sensor-dish', 'sensor-array', 'antenna-mast'],
    forbiddenModules: ['ore-bin', 'mining-head', 'crane', 'cutting-rig', 'missile-rack', 'cargo-container'],
    sockets: [
      { type: 'cockpit', min: 1, max: 1 },
      { type: 'sensor', min: 4, max: 12 },
      { type: 'engine', min: 1, max: 4 },
      { type: 'rcs', min: 12, max: 24 },
      { type: 'radiator', min: 2, max: 4 },
      { type: 'cargo', min: 1, max: 4 },
      { type: 'landing', min: 3, max: 4 },
      { type: 'airlock', min: 1, max: 2 },
      { type: 'docking', min: 1, max: 2 },
      { type: 'navlight', min: 6, max: 14 },
      { type: 'service', min: 4, max: 16 },
      { type: 'emblem', min: 1, max: 3 },
    ],
    requiredVolumeKinds: ['forebody', 'boom', 'radiator'],
    forbiddenVolumeKinds: ['cargo-rack', 'ring'],
    // Near the middle, and deliberately spread by the booms — which is the
    // point: the booms are what give a survey hull its distinctive inertia and
    // its distinctive lazy roll.
    massCentroid: [0.45, 0.58],
    loadedCentroidShift: [-0.04, 0.0],
    massConcentration: [0.2, 0.45],
    // Modest, because the booms eat the beam. A survey ship is the only role
    // whose *overall* proportions are set by things that are not hull.
    lengthBeam: [2.6, 4.5],
    sizeClasses: ['light', 'medium', 'heavy'],
    crew: [3, 9],
    // Straddles the player's 200 m/s², because this is the player's class and
    // the generated ones must feel like siblings of the hero ship.
    accelMs2: [130, 280],
    agility: [0.6, 1.0],
    deltaVKmS: [55, 130],
    topSpeedKmS: [50, 75],
    cargoFraction: [0.08, 0.2],
    silhouetteReads: [
      'the instruments are held deliberately away from the hull, and you can see why',
      'the ship is wider than it is deep — the booms spread it laterally, not vertically',
      'it is quiet: no weapons, few thrusters, and the largest single object is a dish',
      'the booms make it read as an insect rather than as a brick',
    ],
    silhouetteMustNot: [
      'look armed',
      'look like a freighter with a dish stuck on it — the sensors must dominate the outline',
      'have the instruments buried against the hull',
      'be bilaterally boring: the boom layout is the composition',
    ],
    distinguishFrom: [
      { role: 'courier', by: 'a survey ship\'s booms push its beam past a quarter of its length; a courier\'s beam never exceeds a fifth.' },
      { role: 'science', by: 'a science ship\'s instruments are enclosed, clean and thermally isolated; a survey ship\'s are exposed, field-serviceable and covered in handrails.' },
      { role: 'patrol', by: 'patrol sensors are armoured and flush because they get shot at; survey sensors are fragile and stand off the hull because they get calibrated.' },
      { role: 'prospector', by: 'a prospector points its instruments at one rock from close range and carries a bin; a survey ship points its instruments at everything and carries nothing.' },
    ],
    detailDensity: [0.35, 0.65],
    wearBias: {
      edges: 0.9,
      // People are outside working on the instruments constantly.
      hatches: 1.4,
      streaks: 1.0,
      soot: 0.8,
      heat: 0.9,
      pitting: 1.2,
      corrosion: 0.8,
      frost: 1.3,
    },
    markings: ['registry', 'name', 'emblem', 'stencil', 'numeral'],
    threatClass: 'unarmed',
    pressurised: true,
    lands: true,
    thermalSignature: [0.35, 0.6],
    radarSignature: [0.4, 0.7],
    // The loudest ship in the game on the EM band, by function.
    emSignature: [0.8, 1.0],
  },

  // =========================================================================
  // 5 of 7 — PATROL
  // =========================================================================
  patrol: {
    id: 'patrol',
    label: 'Patrol',
    summary:
      'Stays out for a long time and can make somebody stop. Endurance first, weapons second — a patrol hull is a fuel tank that argues.',
    requiredModules: ['cockpit', 'turret', 'sensor-array', 'docking-collar', 'airlock', 'point-defence'],
    signatureModules: ['turret', 'point-defence', 'sensor-array'],
    forbiddenModules: [
      'ore-bin', 'mining-head', 'mining-boom', 'crane', 'winch', 'cutting-rig',
      'grapple-arm', 'radiator-drum', 'habitat-can',
    ],
    sockets: [
      { type: 'cockpit', min: 1, max: 1 },
      { type: 'weapon', min: 2, max: 8 },
      { type: 'sensor', min: 2, max: 5 },
      { type: 'engine', min: 2, max: 4 },
      { type: 'rcs', min: 16, max: 32 },
      { type: 'radiator', min: 2, max: 4 },
      { type: 'docking', min: 1, max: 2 },
      { type: 'airlock', min: 1, max: 2 },
      { type: 'landing', min: 0, max: 4 },
      { type: 'navlight', min: 6, max: 12 },
      { type: 'emblem', min: 2, max: 4 },
    ],
    requiredVolumeKinds: ['forebody', 'midbody', 'afterbody', 'tank'],
    forbiddenVolumeKinds: ['cargo-rack', 'machinery', 'ring'],
    massCentroid: [0.52, 0.64],
    loadedCentroidShift: [-0.03, 0.02],
    // The most concentrated hull in the fleet: armour and magazine amidships,
    // which is also why it out-turns everything its size.
    massConcentration: [0.7, 0.95],
    lengthBeam: [3.2, 5.5],
    sizeClasses: ['light', 'medium', 'heavy'],
    crew: [4, 14],
    accelMs2: [180, 400],
    agility: [1.2, 1.9],
    deltaVKmS: [60, 140],
    topSpeedKmS: [60, 95],
    cargoFraction: [0.03, 0.12],
    silhouetteReads: [
      'every protrusion is either a weapon or armoured — nothing on it is fragile',
      'the fields of fire are unobstructed and you can see that they are',
      'nothing hangs below the hull that a hard landing would break',
      'the ship is oriented: it is obviously pointing at you',
      'the beam is thickened amidships where the armour belt is',
    ],
    silhouetteMustNot: [
      'look civilian',
      'carry visible cargo',
      'have long unbraced booms or masts',
      'be all weapon — that is a gunship, and a patrol has to come home',
    ],
    distinguishFrom: [
      { role: 'gunship', by: 'a patrol carries a boarding airlock and a docking collar and spends under 30% of dry mass on weapons; a gunship carries neither and spends over half, and its armour steps are the silhouette.' },
      { role: 'courier', by: 'a patrol\'s beam carries barbettes and its L/B never exceeds 5.5; a courier is a smooth line with nothing on it.' },
      { role: 'survey', by: 'a patrol\'s sensors are flush and armoured; a survey ship\'s are the largest thing on it and stand clear on booms.' },
    ],
    detailDensity: [0.3, 0.55],
    wearBias: {
      edges: 1.1,
      hatches: 1.2,
      streaks: 1.2,
      soot: 1.3,
      heat: 1.1,
      pitting: 1.3,
      corrosion: 0.7,
      frost: 0.6,
    },
    markings: ['registry', 'name', 'emblem', 'hazard', 'stencil', 'numeral', 'stripe'],
    threatClass: 'armed',
    pressurised: true,
    lands: true,
    thermalSignature: [0.5, 0.8],
    radarSignature: [0.3, 0.6],
    emSignature: [0.55, 0.85],
  },

  // =========================================================================
  // 6 of 7 — SALVAGER
  // =========================================================================
  salvager: {
    id: 'salvager',
    label: 'Salvager',
    summary:
      'Takes ships apart in the dark and carries the pieces home. The most important part of the ship is the empty space in the middle of it.',
    requiredModules: ['cockpit', 'grapple-arm', 'cutting-rig', 'crane', 'winch', 'radiator-panel'],
    signatureModules: ['grapple-arm', 'crane', 'cutting-rig'],
    forbiddenModules: ['missile-rack', 'cargo-container'],
    sockets: [
      { type: 'cockpit', min: 1, max: 1 },
      { type: 'salvage', min: 3, max: 10 },
      { type: 'cargo', min: 2, max: 10 },
      { type: 'engine', min: 1, max: 4 },
      { type: 'rcs', min: 12, max: 28 },
      { type: 'radiator', min: 1, max: 5 },
      { type: 'docking', min: 1, max: 4 },
      { type: 'airlock', min: 1, max: 3 },
      { type: 'landing', min: 0, max: 6 },
      { type: 'service', min: 10, max: 40 },
      { type: 'navlight', min: 8, max: 20 },
      { type: 'emblem', min: 1, max: 2 },
    ],
    requiredVolumeKinds: ['machinery', 'cargo-rack', 'keel'],
    forbiddenVolumeKinds: ['ring'],
    // The widest band of any role, because what a salvager is carrying is by
    // definition not what it was designed to carry.
    massCentroid: [0.42, 0.68],
    loadedCentroidShift: [-0.14, 0.1],
    massConcentration: [0.15, 0.45],
    lengthBeam: [2.0, 3.8],
    sizeClasses: ['light', 'medium', 'heavy'],
    crew: [3, 12],
    accelMs2: [30, 110],
    agility: [0.35, 0.7],
    deltaVKmS: [18, 50],
    topSpeedKmS: [22, 42],
    cargoFraction: [0.25, 0.5],
    silhouetteReads: [
      'there is an open working area with nothing in it, and it is the middle of the ship',
      'the arms can reach the working area and can reach behind the ship',
      'the ship is lit for work: floodlights point at its own hull',
      'what it is carrying does not match it and never did',
      'the ship is asymmetric and it is obvious that nobody planned it',
    ],
    silhouetteMustNot: [
      'look tidy',
      'have an enclosed cargo bay',
      'point its tools forward like a miner',
      'be mirror-symmetric about its centreline',
    ],
    distinguishFrom: [
      { role: 'miner', by: 'salvage arms are jointed and traverse past 180° so they can work on the ship itself; mining heads are fixed, forward and cannot reach the hull.' },
      { role: 'tug', by: 'a tug is almost all engine with a stubby cab and towing hardpoints and no arms at all; a salvager\'s arms are the largest things on it.' },
      { role: 'freighter', by: 'a salvager carries irregular junk on an open rack under a net; a freighter carries identical sealed units in a closed bay.' },
      { role: 'station-tender', by: 'a tender\'s arms are inspection and docking arms with light payloads; a salvager\'s carry a cutting head and a winch rated to move a hull section.' },
    ],
    detailDensity: [0.8, 1.0],
    wearBias: {
      edges: 1.6,
      hatches: 1.5,
      streaks: 1.1,
      soot: 1.2,
      // Cutting gear. The heat story on a salvager is local and bright, not
      // ambient.
      heat: 1.5,
      pitting: 1.2,
      corrosion: 1.5,
      frost: 1.0,
    },
    markings: ['registry', 'name', 'hazard', 'stencil', 'numeral'],
    threatClass: 'defensive',
    pressurised: true,
    lands: false,
    thermalSignature: [0.6, 0.9],
    radarSignature: [0.5, 0.8],
    emSignature: [0.45, 0.75],
  },

  // =========================================================================
  // 7 of 7 — HABITAT  (ShipRole 'colony'; see HABITAT_ROLE)
  // =========================================================================
  colony: {
    id: 'colony',
    label: 'Habitat',
    summary:
      'A place that happens to move, once. Propulsion is an afterthought; the ship is decks, air, water and the argument about who gets the window.',
    requiredModules: ['bridge-tower', 'habitat-can', 'radiator-panel', 'docking-collar', 'airlock', 'reactor-can'],
    signatureModules: ['habitat-can', 'docking-collar'],
    forbiddenModules: ['turret', 'missile-rack', 'mining-head', 'cutting-rig', 'grapple-arm'],
    sockets: [
      { type: 'bridge', min: 1, max: 2 },
      { type: 'habitat', min: 4, max: 24 },
      { type: 'reactor', min: 1, max: 3 },
      { type: 'radiator', min: 4, max: 12 },
      { type: 'docking', min: 3, max: 10 },
      { type: 'airlock', min: 3, max: 10 },
      { type: 'engine', min: 1, max: 4 },
      { type: 'rcs', min: 12, max: 32 },
      { type: 'cargo', min: 2, max: 16 },
      { type: 'navlight', min: 12, max: 32 },
      { type: 'service', min: 10, max: 40 },
      { type: 'emblem', min: 1, max: 3 },
    ],
    requiredVolumeKinds: ['habitat', 'ring', 'radiator', 'reactor', 'keel'],
    forbiddenVolumeKinds: ['machinery'],
    // Balanced, because it has to be: an unbalanced spin section is not a
    // styling problem, it is a structural failure.
    massCentroid: [0.45, 0.6],
    loadedCentroidShift: [-0.05, 0.02],
    massConcentration: [0.1, 0.35],
    lengthBeam: [1.4, 3.0],
    sizeClasses: ['heavy', 'capital', 'super-capital'],
    crew: [40, 2000],
    // Slowest powered role in the game by an order of magnitude. It is not a
    // vehicle.
    accelMs2: [3, 22],
    agility: [0.05, 0.2],
    deltaVKmS: [6, 20],
    topSpeedKmS: [8, 20],
    cargoFraction: [0.15, 0.35],
    silhouetteReads: [
      'the fenestration tells you how many decks there are, and therefore how big the ship is',
      'there is a rotating element and it is obviously balanced about the thrust axis',
      'the engines are an afterthought bolted to the back of something much larger',
      'it is built to be added to: there are unused mounting frames waiting for the next module',
      'the radiators are sized for people, not for a drive, and there are far too many of them',
    ],
    silhouetteMustNot: [
      'look fast',
      'look finished',
      'look like a freighter — the difference is windows and it must be unmistakable',
      'have an unbalanced spin section',
    ],
    distinguishFrom: [
      { role: 'freighter', by: 'habitat cans carry window rows at DECK_HEIGHT_KM spacing and radiators sized for life support; freight containers have no windows and the ship has radiators only for the drive.' },
      { role: 'liner', by: 'a liner\'s windows are one continuous promenade band on a smooth hull; a colony\'s are punched into separate cans that do not line up with each other.' },
      { role: 'carrier', by: 'a carrier\'s open deck runs along the ship\'s axis and is empty; a colony\'s open structure is a spin ring and is inhabited.' },
      { role: 'station-tender', by: 'a colony is the thing being tended: it has docking collars facing outward on every side and no arms of its own.' },
    ],
    detailDensity: [0.45, 0.75],
    wearBias: {
      edges: 0.9,
      hatches: 1.3,
      streaks: 1.4,
      soot: 0.5,
      heat: 1.2,
      pitting: 1.1,
      // Decades in one place, venting water vapour the whole time.
      corrosion: 1.6,
      frost: 1.7,
    },
    markings: ['registry', 'name', 'emblem', 'stencil', 'numeral', 'stripe'],
    threatClass: 'unarmed',
    pressurised: true,
    lands: false,
    thermalSignature: [0.75, 1.0],
    radarSignature: [0.85, 1.0],
    emSignature: [0.6, 0.9],
  },

  // =========================================================================
  // The remaining eleven. Real specifications, not aliases — each one names the
  // single thing that separates it from the briefed role it is nearest to.
  // =========================================================================

  shuttle: {
    id: 'shuttle',
    label: 'Shuttle',
    summary: 'Moves people between two things that are already close together. All cabin, no range.',
    requiredModules: ['cockpit', 'airlock', 'docking-collar', 'navlight', 'landing-leg'],
    signatureModules: ['docking-collar', 'airlock'],
    forbiddenModules: ['turret', 'missile-rack', 'mining-head', 'crane', 'ore-bin', 'habitat-can'],
    sockets: [
      { type: 'cockpit', min: 1, max: 1 },
      { type: 'engine', min: 1, max: 2 },
      { type: 'rcs', min: 8, max: 16 },
      { type: 'docking', min: 1, max: 2 },
      { type: 'airlock', min: 1, max: 2 },
      { type: 'landing', min: 3, max: 4 },
      { type: 'navlight', min: 4, max: 10 },
      { type: 'emblem', min: 1, max: 2 },
    ],
    requiredVolumeKinds: ['hull'],
    forbiddenVolumeKinds: ['cargo-rack', 'machinery', 'ring', 'boom'],
    massCentroid: [0.5, 0.62],
    loadedCentroidShift: [-0.06, 0.0],
    massConcentration: [0.5, 0.75],
    // The only role in the fleet allowed below 2. A shuttle is a room with an
    // engine, and its blunt proportions are exactly what separates it from a
    // courier.
    lengthBeam: [1.6, 3.0],
    sizeClasses: ['shuttle', 'light'],
    crew: [1, 2],
    accelMs2: [90, 220],
    agility: [0.9, 1.4],
    deltaVKmS: [4, 15],
    topSpeedKmS: [20, 40],
    cargoFraction: [0.1, 0.25],
    silhouetteReads: [
      'it is a room with windows and an engine, in that order',
      'the docking collar is on the nose and is a large fraction of the frontal area',
      'the landing gear is permanently visible',
    ],
    silhouetteMustNot: ['look long-ranged', 'look streamlined', 'carry anything outside'],
    distinguishFrom: [
      { role: 'courier', by: 'a shuttle\'s L/B is under 3 and its delta-v under 15 km/s; a courier is over 5 and over 90.' },
    ],
    detailDensity: [0.3, 0.55],
    wearBias: { ...NEUTRAL_WEAR, hatches: 1.7, edges: 1.3, corrosion: 1.2, pitting: 0.6 },
    markings: ['registry', 'numeral', 'emblem', 'stripe'],
    threatClass: 'unarmed',
    pressurised: true,
    lands: true,
    thermalSignature: [0.25, 0.5],
    radarSignature: [0.1, 0.3],
    emSignature: [0.15, 0.35],
  },

  tanker: {
    id: 'tanker',
    label: 'Tanker',
    summary: 'Carries fluid. Nothing about it can be opened, and that is the whole silhouette.',
    requiredModules: ['cockpit', 'fuel-drum', 'docking-collar', 'radiator-panel', 'airlock'],
    signatureModules: ['fuel-drum'],
    forbiddenModules: ['turret', 'missile-rack', 'crane', 'grapple-arm', 'mining-head', 'ore-bin'],
    sockets: [
      { type: 'cockpit', min: 1, max: 1 },
      { type: 'engine', min: 2, max: 6 },
      { type: 'rcs', min: 12, max: 28 },
      { type: 'docking', min: 2, max: 6 },
      { type: 'radiator', min: 2, max: 6 },
      { type: 'service', min: 6, max: 24 },
      { type: 'airlock', min: 1, max: 2 },
      { type: 'navlight', min: 8, max: 20 },
      { type: 'emblem', min: 1, max: 3 },
    ],
    requiredVolumeKinds: ['tank', 'forebody', 'afterbody'],
    forbiddenVolumeKinds: ['cargo-rack', 'machinery', 'ring'],
    massCentroid: [0.5, 0.66],
    loadedCentroidShift: [-0.18, -0.06],
    massConcentration: [0.35, 0.6],
    lengthBeam: [3.0, 5.5],
    sizeClasses: ['medium', 'heavy', 'capital'],
    crew: [2, 8],
    accelMs2: [15, 55],
    agility: [0.2, 0.45],
    deltaVKmS: [15, 45],
    topSpeedKmS: [22, 40],
    cargoFraction: [0.7, 0.92],
    silhouetteReads: [
      'the body is one or two pressure vessels with domed ends and girth bands',
      'there are no openings, no hatches on the barrel and no windows aft of the nose',
      'the plumbing is at the ends, and it is the only detail on the ship',
    ],
    silhouetteMustNot: ['have countable cargo units', 'have an openable bay', 'look fast'],
    distinguishFrom: [
      { role: 'freighter', by: 'a tanker\'s cargo is a single unopenable vessel with domed ends; a freighter\'s is a countable stack of flat-faced units.' },
    ],
    detailDensity: [0.15, 0.35],
    wearBias: { ...NEUTRAL_WEAR, frost: 2.0, corrosion: 1.3, hatches: 0.5, streaks: 1.4 },
    markings: ['registry', 'name', 'hazard', 'stencil', 'stripe'],
    threatClass: 'unarmed',
    pressurised: false,
    lands: false,
    thermalSignature: [0.3, 0.6],
    radarSignature: [0.7, 0.95],
    emSignature: [0.2, 0.4],
  },

  prospector: {
    id: 'prospector',
    label: 'Prospector',
    summary: 'Finds out whether a rock is worth a miner. One head, one bin, and a crew of two who have been out too long.',
    requiredModules: ['cockpit', 'mining-head', 'ore-bin', 'sensor-array', 'landing-leg'],
    signatureModules: ['mining-head', 'sensor-array'],
    forbiddenModules: ['ore-processor', 'crane', 'missile-rack', 'habitat-can', 'cargo-container'],
    sockets: [
      { type: 'cockpit', min: 1, max: 1 },
      { type: 'mining', min: 1, max: 2 },
      { type: 'sensor', min: 2, max: 4 },
      { type: 'cargo', min: 1, max: 3 },
      { type: 'engine', min: 1, max: 2 },
      { type: 'rcs', min: 8, max: 16 },
      { type: 'radiator', min: 1, max: 2 },
      { type: 'landing', min: 3, max: 4 },
      { type: 'airlock', min: 1, max: 1 },
      { type: 'service', min: 4, max: 14 },
      { type: 'navlight', min: 4, max: 10 },
      { type: 'emblem', min: 1, max: 2 },
    ],
    requiredVolumeKinds: ['machinery', 'forebody'],
    forbiddenVolumeKinds: ['ring', 'cargo-bay'],
    massCentroid: [0.5, 0.64],
    loadedCentroidShift: [-0.1, -0.02],
    massConcentration: [0.35, 0.6],
    lengthBeam: [2.2, 3.6],
    sizeClasses: ['light', 'medium'],
    crew: [2, 5],
    accelMs2: [60, 160],
    agility: [0.6, 1.0],
    deltaVKmS: [30, 70],
    topSpeedKmS: [30, 55],
    cargoFraction: [0.15, 0.3],
    silhouetteReads: [
      'one drill and one bin, and you can see both from any angle',
      'the landing gear is heavy for the hull because it sits on rocks',
      'a sensor mast that would look reasonable on a ship twice the size',
    ],
    silhouetteMustNot: ['look industrial at scale', 'carry a processing train', 'look clean'],
    distinguishFrom: [
      { role: 'miner', by: 'a prospector is a light hull with a single head and a single bin; a miner is heavy, carries a battery of heads and processes on board.' },
      { role: 'survey', by: 'a prospector\'s instruments point at one rock from a hundred metres and it carries a bin; a survey ship\'s point at everything and it carries nothing.' },
    ],
    detailDensity: [0.55, 0.85],
    wearBias: { ...NEUTRAL_WEAR, pitting: 1.8, edges: 1.5, corrosion: 1.3, hatches: 1.3 },
    markings: ['registry', 'name', 'hazard', 'numeral'],
    threatClass: 'unarmed',
    pressurised: true,
    lands: true,
    thermalSignature: [0.4, 0.7],
    radarSignature: [0.2, 0.45],
    emSignature: [0.55, 0.85],
  },

  refinery: {
    id: 'refinery',
    label: 'Refinery',
    summary: 'Turns rock into ingots in situ so nobody has to haul the waste. Everything about it is a process, and the process is on the outside.',
    requiredModules: ['bridge-tower', 'ore-processor', 'ore-bin', 'radiator-panel', 'reactor-can', 'docking-collar'],
    signatureModules: ['ore-processor'],
    forbiddenModules: ['turret', 'missile-rack', 'cargo-container'],
    sockets: [
      { type: 'bridge', min: 1, max: 1 },
      { type: 'mining', min: 2, max: 8 },
      { type: 'cargo', min: 4, max: 20 },
      { type: 'reactor', min: 1, max: 3 },
      { type: 'radiator', min: 4, max: 12 },
      { type: 'engine', min: 2, max: 4 },
      { type: 'rcs', min: 12, max: 28 },
      { type: 'docking', min: 2, max: 6 },
      { type: 'airlock', min: 2, max: 5 },
      { type: 'service', min: 12, max: 48 },
      { type: 'navlight', min: 10, max: 28 },
      { type: 'emblem', min: 1, max: 3 },
    ],
    requiredVolumeKinds: ['machinery', 'reactor', 'radiator', 'keel', 'tank'],
    forbiddenVolumeKinds: ['ring'],
    massCentroid: [0.48, 0.64],
    loadedCentroidShift: [-0.1, -0.02],
    massConcentration: [0.2, 0.45],
    lengthBeam: [1.8, 3.4],
    sizeClasses: ['heavy', 'capital'],
    crew: [20, 200],
    accelMs2: [8, 35],
    agility: [0.1, 0.3],
    deltaVKmS: [8, 25],
    topSpeedKmS: [12, 28],
    cargoFraction: [0.3, 0.55],
    silhouetteReads: [
      'a continuous process train: material goes in one end and comes out somewhere else, and you can follow it',
      'stacks and flare tips are the tallest things on the ship',
      'more radiator area than any other role — heat is the product it cannot sell',
    ],
    silhouetteMustNot: ['look mobile', 'look symmetric front-to-back', 'hide the process inside a hull'],
    distinguishFrom: [
      { role: 'miner', by: 'a refinery has stacks, flares and a visible process train and no drill; a miner has a drill and a bin and nothing on it burns.' },
    ],
    detailDensity: [0.85, 1.0],
    wearBias: { ...NEUTRAL_WEAR, heat: 1.8, soot: 1.7, corrosion: 1.5, pitting: 1.2 },
    markings: ['registry', 'name', 'hazard', 'stencil', 'numeral'],
    threatClass: 'unarmed',
    pressurised: true,
    lands: false,
    thermalSignature: [0.9, 1.0],
    radarSignature: [0.75, 1.0],
    emSignature: [0.5, 0.8],
  },

  tug: {
    id: 'tug',
    label: 'Tug',
    summary: 'Almost entirely engine. A cab, a towing frame, and more thrust than anything its size has a right to.',
    requiredModules: ['cockpit', 'docking-collar', 'radiator-panel', 'navlight'],
    signatureModules: ['docking-collar'],
    forbiddenModules: ['cargo-container', 'habitat-can', 'missile-rack', 'mining-head', 'ore-bin'],
    sockets: [
      { type: 'cockpit', min: 1, max: 1 },
      { type: 'engine', min: 2, max: 8 },
      { type: 'rcs', min: 16, max: 40 },
      { type: 'docking', min: 2, max: 6 },
      { type: 'salvage', min: 0, max: 3 },
      { type: 'radiator', min: 2, max: 6 },
      { type: 'airlock', min: 1, max: 2 },
      { type: 'service', min: 6, max: 20 },
      { type: 'navlight', min: 8, max: 20 },
      { type: 'emblem', min: 1, max: 2 },
    ],
    requiredVolumeKinds: ['afterbody', 'forebody', 'radiator'],
    forbiddenVolumeKinds: ['cargo-bay', 'cargo-rack', 'ring', 'habitat'],
    // The most extreme mass distribution in the fleet: it is a drive with a
    // window on the front.
    massCentroid: [0.68, 0.84],
    loadedCentroidShift: [0.0, 0.02],
    massConcentration: [0.75, 0.95],
    lengthBeam: [1.4, 2.6],
    sizeClasses: ['light', 'medium', 'heavy'],
    crew: [2, 6],
    accelMs2: [200, 500],
    agility: [0.8, 1.3],
    deltaVKmS: [10, 30],
    topSpeedKmS: [18, 35],
    cargoFraction: [0.0, 0.06],
    silhouetteReads: [
      'the drive section is more than half the length and most of the volume',
      'the cab is a small blister at the extreme front and is the only pressurised part',
      'the towing frame is heavy, forward, and obviously rated for something enormous',
    ],
    silhouetteMustNot: ['look like it carries anything', 'have arms', 'be slender'],
    distinguishFrom: [
      { role: 'salvager', by: 'a tug has no arms at all and its mass is 70% aft; a salvager\'s arms are its largest feature and its mass sits anywhere.' },
    ],
    detailDensity: [0.5, 0.8],
    wearBias: { ...NEUTRAL_WEAR, soot: 1.9, heat: 1.6, edges: 1.4, streaks: 1.3 },
    markings: ['registry', 'name', 'hazard', 'numeral', 'stripe'],
    threatClass: 'unarmed',
    pressurised: true,
    lands: false,
    thermalSignature: [0.8, 1.0],
    radarSignature: [0.25, 0.5],
    emSignature: [0.25, 0.5],
  },

  science: {
    id: 'science',
    label: 'Science',
    summary: 'A laboratory that flies. Everything is enclosed, thermally isolated and clean, because the instruments care and the crew do not get a vote.',
    requiredModules: ['bridge-tower', 'sensor-array', 'sensor-dish', 'radiator-panel', 'habitat-can', 'docking-collar'],
    signatureModules: ['sensor-dish', 'sensor-array'],
    forbiddenModules: ['turret', 'missile-rack', 'mining-head', 'ore-bin', 'crane', 'cutting-rig'],
    sockets: [
      { type: 'bridge', min: 1, max: 1 },
      { type: 'sensor', min: 4, max: 10 },
      { type: 'habitat', min: 2, max: 8 },
      { type: 'radiator', min: 3, max: 8 },
      { type: 'reactor', min: 1, max: 2 },
      { type: 'engine', min: 1, max: 3 },
      { type: 'rcs', min: 12, max: 24 },
      { type: 'docking', min: 2, max: 4 },
      { type: 'airlock', min: 2, max: 4 },
      { type: 'navlight', min: 8, max: 18 },
      { type: 'emblem', min: 1, max: 2 },
    ],
    requiredVolumeKinds: ['hull', 'radiator', 'habitat'],
    forbiddenVolumeKinds: ['cargo-rack', 'machinery'],
    massCentroid: [0.45, 0.58],
    loadedCentroidShift: [-0.03, 0.0],
    massConcentration: [0.35, 0.6],
    lengthBeam: [3.0, 5.5],
    sizeClasses: ['medium', 'heavy'],
    crew: [10, 60],
    accelMs2: [60, 150],
    agility: [0.4, 0.75],
    deltaVKmS: [40, 100],
    topSpeedKmS: [40, 65],
    cargoFraction: [0.05, 0.15],
    silhouetteReads: [
      'the instruments are enclosed and the hull round them is smooth and deliberate',
      'the radiators are large and precisely aligned, because the instruments have a temperature',
      'it is the cleanest silhouette in the fleet and that is itself the read',
    ],
    silhouetteMustNot: ['look field-serviceable', 'look armed', 'have exposed instruments'],
    distinguishFrom: [
      { role: 'survey', by: 'a science ship\'s instruments are enclosed, radome-covered and thermally isolated; a survey ship\'s are naked, on booms, and covered in handrails.' },
    ],
    detailDensity: [0.15, 0.4],
    wearBias: { ...NEUTRAL_WEAR, heat: 1.3, corrosion: 0.5, edges: 0.7, hatches: 0.8 },
    markings: ['registry', 'name', 'emblem', 'stencil'],
    threatClass: 'unarmed',
    pressurised: true,
    lands: false,
    thermalSignature: [0.45, 0.75],
    radarSignature: [0.4, 0.7],
    emSignature: [0.75, 1.0],
  },

  liner: {
    id: 'liner',
    label: 'Liner',
    summary: 'Sells the idea that space is comfortable. The fenestration is the product and it is also how you read the scale.',
    requiredModules: ['bridge-tower', 'habitat-can', 'docking-collar', 'radiator-panel', 'airlock', 'reactor-can'],
    signatureModules: ['habitat-can', 'bridge-tower'],
    forbiddenModules: ['turret', 'missile-rack', 'mining-head', 'ore-bin', 'crane', 'cutting-rig', 'grapple-arm'],
    sockets: [
      { type: 'bridge', min: 1, max: 2 },
      { type: 'habitat', min: 6, max: 20 },
      { type: 'reactor', min: 1, max: 2 },
      { type: 'radiator', min: 4, max: 10 },
      { type: 'engine', min: 2, max: 6 },
      { type: 'rcs', min: 16, max: 36 },
      { type: 'docking', min: 3, max: 8 },
      { type: 'airlock', min: 4, max: 12 },
      { type: 'cargo', min: 2, max: 8 },
      { type: 'navlight', min: 16, max: 48 },
      { type: 'emblem', min: 2, max: 4 },
    ],
    requiredVolumeKinds: ['hull', 'habitat', 'radiator', 'bridge'],
    forbiddenVolumeKinds: ['cargo-rack', 'machinery', 'keel'],
    massCentroid: [0.5, 0.64],
    loadedCentroidShift: [-0.05, 0.0],
    massConcentration: [0.4, 0.65],
    lengthBeam: [4.0, 7.0],
    sizeClasses: ['heavy', 'capital'],
    crew: [60, 900],
    accelMs2: [25, 80],
    agility: [0.2, 0.45],
    deltaVKmS: [20, 55],
    topSpeedKmS: [30, 55],
    cargoFraction: [0.05, 0.18],
    silhouetteReads: [
      'a continuous promenade band of windows runs most of the length',
      'the hull is smooth and the machinery is hidden, because the machinery is not the product',
      'the bridge is high and forward and deliberately visible',
    ],
    silhouetteMustNot: ['look industrial', 'show its radiators from the passenger side', 'look modular'],
    distinguishFrom: [
      { role: 'colony', by: 'a liner\'s windows are one continuous band on a smooth hull; a colony\'s are punched into separate cans that do not line up.' },
    ],
    detailDensity: [0.2, 0.45],
    wearBias: { ...NEUTRAL_WEAR, streaks: 1.3, corrosion: 0.6, hatches: 0.7, edges: 0.8 },
    markings: ['registry', 'name', 'emblem', 'stripe', 'numeral'],
    threatClass: 'unarmed',
    pressurised: true,
    lands: false,
    thermalSignature: [0.6, 0.85],
    radarSignature: [0.7, 0.95],
    emSignature: [0.4, 0.7],
  },

  gunship: {
    id: 'gunship',
    label: 'Gunship',
    summary: 'Weapons first, armour second, and no third consideration. It does not have to come back the same week.',
    requiredModules: ['cockpit', 'turret', 'missile-rack', 'point-defence', 'sensor-array'],
    signatureModules: ['turret', 'missile-rack'],
    forbiddenModules: [
      'cargo-container', 'cargo-pod', 'ore-bin', 'habitat-can', 'crane', 'winch',
      'grapple-arm', 'mining-head', 'antenna-mast',
    ],
    sockets: [
      { type: 'cockpit', min: 1, max: 1 },
      { type: 'weapon', min: 4, max: 14 },
      { type: 'sensor', min: 2, max: 4 },
      { type: 'engine', min: 2, max: 6 },
      { type: 'rcs', min: 20, max: 40 },
      { type: 'radiator', min: 2, max: 4 },
      { type: 'airlock', min: 1, max: 1 },
      { type: 'navlight', min: 4, max: 10 },
      { type: 'emblem', min: 2, max: 4 },
    ],
    requiredVolumeKinds: ['forebody', 'midbody', 'afterbody'],
    forbiddenVolumeKinds: ['cargo-bay', 'cargo-rack', 'machinery', 'ring', 'habitat'],
    massCentroid: [0.5, 0.62],
    loadedCentroidShift: [-0.02, 0.03],
    massConcentration: [0.75, 1.0],
    lengthBeam: [2.4, 4.2],
    sizeClasses: ['light', 'medium', 'heavy'],
    crew: [2, 20],
    accelMs2: [280, 700],
    agility: [1.5, 2.4],
    deltaVKmS: [25, 70],
    topSpeedKmS: [70, 110],
    cargoFraction: [0.0, 0.04],
    silhouetteReads: [
      'the armour steps are visible as discrete thickenings and they are the silhouette',
      'more than half of what protrudes is a weapon',
      'nothing on it is fragile and nothing on it is for comfort',
    ],
    silhouetteMustNot: ['carry cargo', 'have a docking collar', 'look like it could be mistaken for a civil hull'],
    distinguishFrom: [
      { role: 'patrol', by: 'a gunship has no boarding airlock and no docking collar, spends over half its dry mass on weapons, and has a third of a patrol\'s delta-v.' },
    ],
    detailDensity: [0.25, 0.5],
    wearBias: { ...NEUTRAL_WEAR, soot: 1.6, edges: 1.3, heat: 1.4, corrosion: 0.5 },
    markings: ['registry', 'emblem', 'hazard', 'numeral', 'stencil'],
    threatClass: 'warship',
    pressurised: true,
    lands: false,
    thermalSignature: [0.55, 0.85],
    radarSignature: [0.25, 0.55],
    emSignature: [0.6, 0.9],
  },

  carrier: {
    id: 'carrier',
    label: 'Carrier',
    summary: 'A runway with engines. Everything else on the ship exists to keep the deck clear.',
    requiredModules: ['bridge-tower', 'docking-collar', 'radiator-panel', 'point-defence', 'reactor-can'],
    signatureModules: ['docking-collar', 'bridge-tower'],
    forbiddenModules: ['mining-head', 'ore-bin', 'crane', 'cutting-rig'],
    sockets: [
      { type: 'bridge', min: 1, max: 2 },
      { type: 'docking', min: 6, max: 24 },
      { type: 'weapon', min: 2, max: 10 },
      { type: 'reactor', min: 1, max: 3 },
      { type: 'radiator', min: 4, max: 10 },
      { type: 'engine', min: 2, max: 6 },
      { type: 'rcs', min: 20, max: 40 },
      { type: 'habitat', min: 2, max: 10 },
      { type: 'airlock', min: 3, max: 8 },
      { type: 'navlight', min: 20, max: 60 },
      { type: 'emblem', min: 2, max: 4 },
    ],
    requiredVolumeKinds: ['hull', 'bridge', 'radiator', 'pylon'],
    forbiddenVolumeKinds: ['ring'],
    // Forward of most warships, because the deck is aft and it is empty.
    massCentroid: [0.42, 0.56],
    loadedCentroidShift: [-0.08, 0.0],
    massConcentration: [0.35, 0.6],
    lengthBeam: [2.6, 4.6],
    sizeClasses: ['capital', 'super-capital'],
    crew: [200, 3000],
    accelMs2: [40, 110],
    agility: [0.15, 0.4],
    deltaVKmS: [25, 65],
    topSpeedKmS: [35, 60],
    cargoFraction: [0.1, 0.3],
    silhouetteReads: [
      'an open deck runs along the ship\'s axis and it is empty',
      'the island is offset to one side of the deck and is the only tall thing',
      'the ship is asymmetric in plan and unmistakably so',
    ],
    silhouetteMustNot: ['have anything overhanging the deck', 'be symmetric in plan', 'look like a freighter with a slot in it'],
    distinguishFrom: [
      { role: 'freighter', by: 'a carrier\'s bay is open along the axis and must stay clear; a freighter\'s bays are closed and face outward for a cargo arm.' },
    ],
    detailDensity: [0.45, 0.75],
    wearBias: { ...NEUTRAL_WEAR, soot: 1.5, edges: 1.4, hatches: 1.3, streaks: 1.2 },
    markings: ['registry', 'name', 'emblem', 'hazard', 'numeral', 'stripe'],
    threatClass: 'warship',
    pressurised: true,
    lands: false,
    thermalSignature: [0.8, 1.0],
    radarSignature: [0.9, 1.0],
    emSignature: [0.8, 1.0],
  },

  'station-tender': {
    id: 'station-tender',
    label: 'Tender',
    summary: 'Services things that are not going anywhere. Ugly, purposeful, and with no pretence of ever entering an atmosphere.',
    requiredModules: ['cockpit', 'grapple-arm', 'docking-collar', 'radiator-panel', 'airlock', 'toolbox'],
    signatureModules: ['grapple-arm', 'docking-collar'],
    forbiddenModules: ['turret', 'missile-rack', 'mining-head', 'habitat-can'],
    sockets: [
      { type: 'cockpit', min: 1, max: 1 },
      { type: 'salvage', min: 2, max: 6 },
      { type: 'docking', min: 3, max: 10 },
      { type: 'cargo', min: 2, max: 10 },
      { type: 'engine', min: 2, max: 4 },
      { type: 'rcs', min: 20, max: 40 },
      { type: 'radiator', min: 2, max: 6 },
      { type: 'airlock', min: 2, max: 5 },
      { type: 'service', min: 12, max: 40 },
      { type: 'navlight', min: 10, max: 26 },
      { type: 'emblem', min: 1, max: 2 },
    ],
    requiredVolumeKinds: ['machinery', 'keel', 'radiator'],
    forbiddenVolumeKinds: ['ring', 'wing', 'fin'],
    massCentroid: [0.46, 0.62],
    loadedCentroidShift: [-0.08, 0.06],
    massConcentration: [0.25, 0.5],
    // Almost square in plan. A tender has no reason to be long — it never
    // cruises anywhere.
    lengthBeam: [1.2, 2.4],
    sizeClasses: ['light', 'medium'],
    crew: [3, 12],
    accelMs2: [30, 90],
    agility: [1.0, 1.6],
    deltaVKmS: [4, 14],
    topSpeedKmS: [10, 25],
    cargoFraction: [0.15, 0.35],
    silhouetteReads: [
      'RCS everywhere: more thruster quads than any other role, because it works in close',
      'arms and docking collars on every face — it has no preferred orientation',
      'no streamlining, no nose, no tail, no front',
    ],
    silhouetteMustNot: ['have a direction', 'look aerodynamic', 'look fast'],
    distinguishFrom: [
      { role: 'salvager', by: 'a tender\'s arms are light inspection and handling arms and its hull has no open working bay; a salvager\'s carry a cutting head and a winch rated to move a hull section.' },
    ],
    detailDensity: [0.7, 1.0],
    wearBias: { ...NEUTRAL_WEAR, hatches: 1.6, edges: 1.5, corrosion: 1.4, soot: 1.2 },
    markings: ['registry', 'hazard', 'stencil', 'numeral'],
    threatClass: 'unarmed',
    pressurised: true,
    lands: false,
    thermalSignature: [0.35, 0.65],
    radarSignature: [0.3, 0.6],
    emSignature: [0.35, 0.65],
  },

  derelict: {
    id: 'derelict',
    label: 'Derelict',
    summary: 'A hull with no power and no crew. Everything readable about it is history — this role is the damage system with a hull attached.',
    requiredModules: ['blanking-plate'],
    signatureModules: ['blanking-plate'],
    forbiddenModules: ['navlight', 'beacon'],
    sockets: [
      { type: 'service', min: 4, max: 30 },
      { type: 'emblem', min: 0, max: 2 },
    ],
    requiredVolumeKinds: ['hull'],
    forbiddenVolumeKinds: [],
    // Unconstrained: a derelict inherits whatever role it used to be, and its
    // mass is wherever the missing sections left it.
    massCentroid: [0.3, 0.8],
    loadedCentroidShift: [0.0, 0.0],
    massConcentration: [0.1, 0.9],
    lengthBeam: [1.2, 9.0],
    sizeClasses: ['shuttle', 'light', 'medium', 'heavy', 'capital', 'super-capital'],
    crew: [0, 0],
    accelMs2: [0, 0],
    agility: [0, 0],
    deltaVKmS: [0, 0],
    topSpeedKmS: [0, 0],
    cargoFraction: [0.0, 0.6],
    silhouetteReads: [
      'something large is missing and you can see where it was bolted',
      'the outline is broken: severed struts, a torn-off module, a section vented open',
      'nothing on it is lit',
    ],
    silhouetteMustNot: ['look intact', 'look powered', 'look like it was built this way'],
    distinguishFrom: [
      { role: 'salvager', by: 'a derelict is the thing being cut up; it has no arms, no lights and no closed outline.' },
    ],
    detailDensity: [0.6, 1.0],
    wearBias: {
      edges: 2.0,
      hatches: 1.5,
      streaks: 1.6,
      soot: 1.2,
      heat: 0.3,
      pitting: 2.0,
      corrosion: 2.0,
      frost: 1.8,
    },
    markings: ['registry', 'name', 'stencil'],
    threatClass: 'derelict',
    pressurised: false,
    lands: false,
    thermalSignature: [0.0, 0.05],
    radarSignature: [0.5, 1.0],
    emSignature: [0.0, 0.08],
  },
};

/**
 * Every role, in declaration order. `Object.values` on a string-keyed object is
 * insertion-ordered per the language spec, so this is deterministic — which
 * matters, because a fleet generator picking `ROLES[i]` must give the same
 * answer on every machine forever.
 */
export const ROLES: readonly RoleSpec[] = Object.values(ROLE_TABLE);

export const ROLE_IDS: readonly ShipRole[] = ROLES.map((r) => r.id);

/**
 * The seven roles BRIEF §1 names, in its order. Everything else in `ROLES` is a
 * neighbour of one of these and is separated from it by an entry in
 * `distinguishFrom`.
 */
export const BRIEFED_ROLES: readonly ShipRole[] = [
  'courier',
  'freighter',
  'miner',
  'survey',
  'patrol',
  'salvager',
  'colony',
];

/**
 * The brief's "habitat" role. `ShipRole` has no `'habitat'` member — in the
 * contract `habitat` is a socket, a volume kind and a module kind, and the
 * *ship* that is a habitat is `'colony'`. Named here so the mapping is written
 * down once instead of being rediscovered.
 */
export const HABITAT_ROLE: ShipRole = 'colony';

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Faction by id.
 *
 * Throws on an unknown id rather than falling back. A generator handed a faction
 * that does not exist has a bug upstream, and a silent fallback would produce a
 * plausible-looking ship under the wrong DNA — the hardest class of bug to
 * notice and the easiest to ship. Callers that legitimately probe should use
 * `tryFactionById`.
 */
export function factionById(id: string): FactionDna {
  const f = FACTION_BY_ID.get(id);
  if (f === undefined) {
    throw new Error(`Unknown faction '${id}'. Known factions: ${FACTION_IDS.join(', ')}.`);
  }
  return f;
}

/** Non-throwing lookup, for save-file migration and for tests. */
export function tryFactionById(id: string): FactionDna | undefined {
  return FACTION_BY_ID.get(id);
}

/**
 * Role by id. Total by construction: `ROLE_TABLE` is typed
 * `Record<ShipRole, RoleSpec>`, so a missing role is a compile error rather
 * than a runtime hole.
 */
export function roleById(id: ShipRole): RoleSpec {
  return ROLE_TABLE[id];
}

/** The hull line a faction uses for a role. Falls back to the faction's first. */
export function familyFor(faction: FactionDna, role: ShipRole): HullFamily {
  for (const fam of faction.families) {
    if (fam.roles.includes(role)) return fam;
  }
  return faction.families[0];
}

export function familyById(faction: FactionDna, id: FamilyId): HullFamily | undefined {
  for (const fam of faction.families) if (fam.id === id) return fam;
  return undefined;
}

// ---------------------------------------------------------------------------
// Combining a faction with a role
// ---------------------------------------------------------------------------

/**
 * Relative likelihood that this faction builds this role. Zero means never, and
 * a fleet generator must treat zero as a hard exclusion rather than as a small
 * number — "what this culture would never build" is an identity statement, not
 * a rarity.
 */
export function factionRoleWeight(faction: FactionDna, role: ShipRole): number {
  if (faction.neverBuilds.includes(role)) return 0;
  const w = faction.roleAffinity[role];
  return w === undefined ? 1 : w;
}

/** Every faction that will build this role at all. Never empty for a valid role. */
export function factionsBuilding(role: ShipRole): readonly FactionDna[] {
  return FACTIONS.filter((f) => factionRoleWeight(f, role) > 0);
}

/**
 * The length/beam band for a specific (faction, role, family).
 *
 * Three constraints meet here and the order matters: the role's requirement is
 * intersected with the faction's habit (role wins on disagreement, per
 * `intersectRange`), and the family's bias then scales the result — a bias is a
 * product line's emphasis, not a veto, so it is applied last and cannot pull the
 * hull back outside the role's requirement.
 */
export function lengthBeamFor(faction: FactionDna, role: RoleSpec, family: HullFamily): Range {
  const base = intersectRange(role.lengthBeam, faction.proportion.lengthBeam);
  const biased: Range = [base[0] * family.lengthBeamBias, base[1] * family.lengthBeamBias];
  return intersectRange(role.lengthBeam, biased);
}

/** Where the dry centre of mass sits along the hull, role ∩ faction. */
export function massCentroidFor(faction: FactionDna, role: RoleSpec): Range {
  return intersectRange(role.massCentroid, faction.proportion.massCentroid);
}

/**
 * Final wear weights for a hull.
 *
 * The faction supplies the character (a Sillane hull is heat; an Ossuary hull is
 * corrosion), the role scales it (a miner is pitting), and maintenance scales
 * the whole thing down — a well-kept ship is not a differently-worn ship, it is
 * a less-worn one. Clamped to 0..1 because `WearWeights` are shader masks.
 *
 * Never returns all-equal weights: uniform noise laid evenly over everything is
 * the single most common failure and will be rejected (BRIEF §7).
 */
export function wearWeightsFor(
  faction: FactionDna,
  role: RoleSpec,
  maintenance: number,
): WearWeights {
  // 0.35 floor: even a survey-standard hull is dirty. There is no clean ship in
  // this game, and a maintenance of 1 must not erase the wear system.
  const k = 1 - 0.65 * (maintenance < 0 ? 0 : maintenance > 1 ? 1 : maintenance);
  const f = faction.wear;
  const r = role.wearBias;
  const m = (a: number, b: number): number => {
    const v = a * b * k;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };
  return {
    edges: m(f.edges, r.edges),
    hatches: m(f.hatches, r.hatches),
    streaks: m(f.streaks, r.streaks),
    soot: m(f.soot, r.soot),
    heat: m(f.heat, r.heat),
    pitting: m(f.pitting, r.pitting),
    corrosion: m(f.corrosion, r.corrosion),
    frost: m(f.frost, r.frost),
  };
}

/** The palette for a hull line: the faction's, with the family's accent if it has one. */
export function paletteFor(faction: FactionDna, family: HullFamily): ShipPalette {
  if (family.accentOverride === null) return faction.palette;
  return { ...faction.palette, accent: family.accentOverride };
}

// ---------------------------------------------------------------------------
// Deterministic derivations
// ---------------------------------------------------------------------------

/**
 * A weighted draw over the faction's section families.
 *
 * Zero-weighted entries are listed rather than omitted so that adding a family
 * to a faction later is a weight change and not a structural one — and so a
 * reviewer can see that Kessler's twin-lobe weight is deliberately 0 rather than
 * simply forgotten.
 */
export function pickSectionFamily(faction: FactionDna, rng: Rng): SectionFamily {
  const entries = faction.surface.sectionFamilies;
  let total = 0;
  for (const e of entries) total += e[1];
  if (total <= 0) return 'superellipse';
  let x = rng.next() * total;
  for (const e of entries) {
    x -= e[1];
    if (x <= 0) return e[0];
  }
  return entries[entries.length - 1][0];
}

/**
 * A `SectionShape` in this faction's language.
 *
 * Everything here is drawn from the faction's own bands, so the same call with
 * the same seed gives the same section forever, and two ships of one faction
 * share a section *vocabulary* without sharing a section. `family` overrides the
 * weighted draw when a hull line insists on one — a Sillane Carapace is
 * twin-lobe by definition, not by luck.
 */
export function defaultSectionShape(
  faction: FactionDna,
  seed: number,
  family: SectionFamily | null = null,
): SectionShape {
  const rng = new Rng(hashSeed(seed >>> 0, `families/section/${faction.id}`));
  const s = faction.surface;
  const chosen = family ?? pickSectionFamily(faction, rng);

  const sides =
    chosen === 'polygon' && s.polygonSides.length > 0 ? rng.pick(s.polygonSides) : 4;

  const nHarm = Math.round(sampleRange(s.harmonicCount, rng));
  const harmonics: SectionHarmonic[] = [];
  for (let i = 0; i < nHarm; i++) {
    const amp = sampleRange(s.harmonicAmplitude, rng);
    harmonics.push({
      frequency: s.harmonicFrequencies.length > 0 ? rng.pick(s.harmonicFrequencies) : 4,
      // Amplitude grows slightly aft on every faction: a chine that widens as
      // the hull widens reads as a designed line, one that is constant reads as
      // a texture. Both ends come from the same band so the growth is small.
      amplitude: [amp * 0.8, amp] as Vec2,
      // Quantised to the eighth: an arbitrary phase puts a chine halfway up a
      // flank where no fabricator would ever put one.
      phase: rng.int(0, 7) * (Math.PI / 4),
    });
  }

  const nLobe = Math.round(sampleRange(s.lobeCount, rng));
  const lobes: SectionLobe[] = [];
  for (let i = 0; i < nLobe; i++) {
    const depth = sampleRange(s.lobeDepth, rng);
    // Ventral keel first, then dorsal spine, then sponsons — in that order,
    // because a keel is what a hull that lands wants and it is the lobe that
    // most changes the silhouette. -π/2 is ventral per `sectionPoint`.
    const angle =
      i === 0 ? -Math.PI / 2 : i === 1 ? Math.PI / 2 : rng.chance(0.5) ? 0 : Math.PI;
    lobes.push({
      angle,
      width: sampleRange(s.lobeWidth, rng),
      // Lobes grow aft for the same reason harmonics do: a keel that deepens
      // towards the tail reads as structure carrying load, one of constant
      // depth reads as a moulding.
      depth: [depth * 0.6, depth],
    });
  }

  return { family: chosen, sides, harmonics, lobes };
}

/**
 * A `TechnologyProfile` in this faction's language, biased by the role.
 *
 * This is the record that separates a shipyard-fresh corporate hull from a
 * decade-old independent one carrying the same DNA, so it is drawn from the
 * faction's construction bands and then adjusted for the two role facts that
 * genuinely change fabrication: whether the hull is pressurised and whether it
 * ever meets an atmosphere.
 */
export function technologyProfileFor(
  faction: FactionDna,
  role: RoleSpec,
  seed: number,
): TechnologyProfile {
  const rng = new Rng(hashSeed(seed >>> 0, `families/tech/${faction.id}/${role.id}`));
  const c = faction.construction;

  const ageYears = sampleRange(c.ageYears, rng);
  const refits = Math.round(sampleRange(c.refits, rng));
  // Maintenance decays with age within the faction's band. A forty-year-old
  // Kessler is not a badly-built Kessler, it is a tired one — and that
  // distinction is what stops age reading as poor workmanship.
  const ageK = Math.min(1, ageYears / 60);
  const maintenance = rangeAt([c.maintenance[1], c.maintenance[0]], ageK * rng.range(0.6, 1.0));

  return {
    // A hull that has been refitted more than once shows the refit fabrication
    // somewhere, and on a derelict the salvage-weld read dominates outright.
    fabrication: refits >= 2 && rng.chance(0.5) ? c.refit : c.primary,
    drive: faction.propulsion.drive,
    maintenance,
    refits,
    ageYears,
    exposedStructure: sampleRange(c.exposedStructure, rng),
    pressurised: role.pressurised,
    atmosphereCapable: role.lands,
  };
}

/**
 * A hull registration in this faction's format.
 *
 * `'A'` draws a letter from the faction's pool and `'9'` a digit; every other
 * character is copied through. Kessler's `AA-9999` over `KXVTRDNGBMHZ` produces
 * exactly the `"KX-4471"` the blueprint contract uses as its example, which is
 * the point: the example in `types.ts` is a real output of this function rather
 * than a placeholder somebody invented.
 */
export function registryFor(faction: FactionDna, seed: number): string {
  const rng = new Rng(hashSeed(seed >>> 0, `families/registry/${faction.id}`));
  const pattern = faction.markings.registryPattern;
  const letters = faction.markings.registryLetters;
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === 'A' && letters.length > 0) out += letters[rng.int(0, letters.length - 1)];
    // Leading digits start at 1 so a registry never reads as "0047", which looks
    // like a placeholder rather than like a filing system with a history.
    else if (ch === '9') out += String(out.length === 0 || out[out.length - 1] === '-' ? rng.int(1, 9) : rng.int(0, 9));
    else out += ch;
  }
  return out;
}

/**
 * The class name the scanner shows: "Kessler-pattern heavy hauler".
 *
 * The pattern word carries the manufacturing culture — a *pattern* implies a
 * drawing, a *type* implies a mould, and *-built* implies neither — so the
 * string is assembled here rather than templated in `blueprint.ts`, where the
 * distinction would be lost.
 */
export function shipClassName(faction: FactionDna, role: RoleSpec, sizeClass: SizeClass): string {
  const size = SIZE_WORD[sizeClass];
  const noun = ROLE_NOUN[role.id];
  const head =
    faction.patternWord === 'built'
      ? `${faction.shortName}-built`
      : `${faction.shortName}-${faction.patternWord}`;
  return size.length > 0 ? `${head} ${size} ${noun}` : `${head} ${noun}`;
}

/**
 * Size adjectives. 'medium' is deliberately empty: a chart does not write
 * "medium hauler", it writes "hauler", and the absence is what makes "heavy"
 * mean something.
 */
const SIZE_WORD: Record<SizeClass, string> = {
  shuttle: 'light',
  light: 'light',
  medium: '',
  heavy: 'heavy',
  capital: 'capital',
  'super-capital': 'fleet',
};

/**
 * The noun a chart would actually use for each role. Not the enum name: nobody
 * writes "station-tender" on a manifest, they write "yard tender".
 */
const ROLE_NOUN: Record<ShipRole, string> = {
  shuttle: 'shuttle',
  courier: 'courier',
  survey: 'survey ship',
  freighter: 'hauler',
  tanker: 'tanker',
  miner: 'mining rig',
  prospector: 'prospector',
  refinery: 'refinery ship',
  salvager: 'breaker',
  tug: 'tug',
  science: 'research ship',
  liner: 'liner',
  colony: 'habitat ship',
  patrol: 'cutter',
  gunship: 'gunship',
  carrier: 'carrier',
  'station-tender': 'yard tender',
  derelict: 'hulk',
};

/**
 * Marking cap height in km for a given faction.
 *
 * Derived from `DECK_HEIGHT_KM`, never from the ship: text is the cheapest scale
 * cue in the game, and lettering scaled to the hull is exactly what makes a 4 km
 * capital read as a 40 m model. `k` walks the faction's band so a hull can carry
 * a large registry on the bow and small stencils beside a hatch.
 */
export function markingCapHeightKm(faction: FactionDna, k: number): number {
  return rangeAt(faction.markings.capHeightDecks, k) * DECK_HEIGHT_KM;
}

/**
 * Whether a greeble family may appear on this faction's hull.
 *
 * Forbidden wins over allowed, so a family listed in both is refused — the
 * refusals are the identity and must not be defeatable by an editing accident.
 */
export function allowsGreeble(faction: FactionDna, family: GreebleFamily): boolean {
  if (faction.surface.forbiddenGreebles.includes(family)) return false;
  return faction.surface.greebles.includes(family);
}

/** Greebles this faction will actually place, in a stable order. */
export function greebleVocabulary(faction: FactionDna): readonly GreebleFamily[] {
  return GREEBLE_FAMILIES.filter((g) => allowsGreeble(faction, g));
}
