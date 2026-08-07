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
 *      That bound is the floor of `proportion.slendernessBand`, it is enforced
 *      by `lengthBeamFor` after every other influence has had its say, and it
 *      rises with the acceleration the role demands — because the hull is long
 *      in order to shed heat, and more thrust is more heat.
 *
 *      The *comparative* half of that statement — a Sillane is finer than a
 *      Kessler — is `proportion.slendernessGain`, and it is a MULTIPLIER on what
 *      the role asked for rather than a band the role gets projected into. That
 *      distinction is this round's correction and it matters: two signals do not
 *      fit through one projection. Round two encoded the yard as a narrow
 *      absolute band and the role as a position inside it, which made the yard
 *      legible and flattened every role in it — eighteen roles inside a Kessler
 *      window 1.77× wide, and a tug, a liner and a gunship from one seed came
 *      out as the same box in three sizes. As a product, the yard ratio is 1.5×
 *      between adjacent yards on every role and the role ratio is 5× in every
 *      yard, and neither costs the other anything.
 *
 *   0. And the one this file was missing until round five: A CULTURE IS THE SET
 *      OF MASSES IT BUILDS FROM. A census over 150 shared seeds found the three
 *      yards emitting the same volume kinds in the same proportions to within a
 *      few per cent — boom 1.41/1.34/1.70, pylon 2.51/2.49/2.77, nacelle
 *      2.55/2.51/2.49 — because `FactionDna` had blocks for structure,
 *      propulsion, thermal, sensors, markings, palette and proportion and none
 *      at all for what the culture builds out of. `MassingDna` is that block,
 *      and it is numbered zero because BRIEF §4 puts primary volumes at stage 3,
 *      ahead of every other difference in this file.
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
 * function decides form (BRIEF §4), so a Sillane freighter carries its mass
 * where a freighter must carry it before it carries it where Sillane like to.
 * The result is always non-empty, which matters because the generator has no
 * fallback path.
 *
 * NOT used for slenderness. That was the mistake this rule made everywhere it
 * was applied to `lengthBeam`: where a role's mass centroid and a faction's are
 * two opinions about the same quantity, a role's L/B band and a faction's are
 * not — one is a preference and the other is a thermal and structural limit, and
 * averaging a limit with a preference deletes the limit. See `lengthBeamFor`.
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

// ---------------------------------------------------------------------------
// Massing — WHAT MASSES A CULTURE BUILDS FROM, and how it joins them
// ---------------------------------------------------------------------------

/**
 * The topologies a yard is able to build. Structurally the same string union as
 * `blueprint.ts:HullArchetype`, restated here rather than imported because
 * `blueprint.ts` imports this file and a type import in the other direction
 * would draw the dependency arrow backwards. `blueprint.ts` should assert the
 * two are assignable in one line; if this list ever falls behind, that
 * assertion is where it fails.
 */
export type MassingArchetype =
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
 * How two masses on one hull are made into one ship. This is the joint
 * doctrine at *silhouette* scale, where `ConstructionDna.joint` is the same
 * question at plate scale.
 */
export type AssemblyDoctrine =
  | 'slung' //   masses hang off a visible frame on short pylons, in pairs
  | 'fused' //   there is one mass; anything else is a swelling in the same loft
  | 'threaded'; // unequal found cans clamped along somebody else's keel

/** What physically holds an external mass on. */
export type MassAttachment =
  | 'pylon' //     a short structural stub, always in a mirrored pair
  | 'flush' //     the mass is part of the loft; there is no attachment
  | 'keel-clamp'; // band clamps and torch-cut brackets onto the found keel

/** How many of one volume kind a hull of this culture carries. Integers. */
export interface VolumeKindBudget {
  readonly kind: VolumeKind;
  /** Inclusive count band per hull, before the role has its say. */
  readonly count: Range;
}

/**
 * WHAT THIS CULTURE BUILDS ITS SHIPS OUT OF.
 *
 * The block this file was missing, and the reason a per-hull volume-kind census
 * over 150 shared seeds came back within a few per cent between all three yards
 * on every kind but `radiator`: boom 1.41/1.34/1.70, pylon 2.51/2.49/2.77,
 * nacelle 2.55/2.51/2.49, tank 2.01/1.99/2.01. Three factions were drawing from
 * one parts bin in one set of proportions, and every other block in `FactionDna`
 * — structure, propulsion, thermal, sensors, markings, palette, proportion — is
 * downstream of a massing decision that nothing was making.
 *
 * BRIEF §4 puts primary volumes at stage 3, ahead of everything cosmetic. A
 * faction that only differs from stage 6 onwards is one design language in three
 * palettes, and no amount of surface, value or clutter repairs that.
 *
 * THE THREE ANSWERS, in one line each, which is what a reviewer checks a black
 * silhouette against:
 *
 *   Kessler  masses are SLUNG. Pods and tanks hang off a visible frame on short
 *            pylons in mirrored pairs, because a pod on a pylon is a pod a
 *            gantry can reach. Many parts, all from one catalogue, all the same
 *            size as each other.
 *   Sillane  masses are FUSED. There is one mass. What looks like a second is a
 *            swelling in the same loft, and there is no external volume of any
 *            kind — no pod, no boom, no pylon, no nacelle, no rack, no fin.
 *   Ossuary  masses are THREADED. Unequal salvaged cans clamped along a keel
 *            somebody else built, each a different diameter, at whatever clock
 *            angle cleared. The widest vocabulary in the fleet, because none of
 *            it was chosen.
 *
 * HOW IT MUST BE APPLIED, because the existing soft version of this already
 * failed. `blueprint.ts:FACTION_ARCHETYPE_BIAS` states similar preferences as
 * multipliers, and then `ARCHETYPE_FLOOR_SHARE` puts every non-zero entry back
 * up to 11% of the role's table — so a 0.2 and a 3.0 both end up somewhere
 * between 11% and 45%, and the doctrine is gone. A refusal has to be a ZERO to
 * survive that floor, which is why `archetypes` here is an allow-list and
 * `forbiddenKinds` is a list rather than a small number. A culture's habit may
 * make a shape rare; only its trade may make one impossible.
 */
export interface MassingDna {
  /** The sentence a reviewer checks a black silhouette against. */
  readonly doctrine: string;
  readonly assembly: AssemblyDoctrine;
  readonly attach: MassAttachment;
  /**
   * The ONLY topologies this yard builds. Everything absent is zero, and zero
   * must stay zero downstream — see the note above about the floor share.
   *
   * Never empties a role's own table: every entry in `ROLE_TOPOLOGY` shares at
   * least one archetype with every faction that builds that role, and a
   * generator that finds an empty intersection anyway must fall back to the
   * role's table rather than to a default hull.
   */
  readonly archetypes: readonly MassingArchetype[];
  /**
   * How many masses carry the load path from the drives to the nose (BRIEF §4
   * stage 2/3). Integers. This is the count that decides whether a hull reads as
   * a structure or as a pile: Kessler's frame carries through two or three
   * welded blocks, a Sillane is one shell, an Ossuary hangs everything on one
   * found keel it did not design.
   */
  readonly loadBearingMasses: Range;
  /**
   * How many masses sit OUTSIDE the primary loft — pods, tanks, nacelles,
   * booms, racks. Integers. Zero is a statement, not a small number: it is the
   * whole of the Sillane silhouette.
   */
  readonly externalMasses: Range;
  /**
   * Largest ÷ smallest external mass. Near 1 means a catalogue: every pod is
   * the same pod. High means salvage, and it is the strongest single read of a
   * scavenger hull at silhouette distance.
   */
  readonly massRatio: Range;
  /**
   * How many DISTINCT volume kinds one hull may use. A yard with one catalogue
   * builds from few kinds; a breakers' anchorage builds from whatever came
   * through the gate. Bounding this is what stops all three factions using all
   * twenty-one kinds in the same proportions, which is what the census found.
   */
  readonly maxDistinctKinds: number;
  /**
   * Count band per volume kind, per hull, before the role has its say. Kinds
   * absent from this list are role-driven (`hull`, `forebody`, `midbody`,
   * `afterbody`, `bridge`, `habitat`, `cargo-bay`) and are not a faction
   * statement. A kind listed at [0, 0] is a refusal with a reason.
   */
  readonly budget: readonly VolumeKindBudget[];
  /**
   * Never, under any seed or role. The identity lives here as much as anywhere.
   *
   * PRECEDENCE against `RoleSpec.requiredVolumeKinds`, which is the one place in
   * this file where a role and a faction can make contradictory demands.
   * Everywhere else the ROLE wins (`intersectRange`, and BRIEF §4's "function
   * decides form"), and that stays true here — but a required volume kind names
   * the USUAL FORM of a function, not the function. A culture may refuse the
   * form if, and only if, it has already declared another way of performing the
   * same function somewhere else in its own DNA. Every live case is a Sillane
   * one and every one of them is answered:
   *
   *   role wants          Sillane refuses    because it already declares
   *   ─────────────────────────────────────────────────────────────────────────
   *   radiator (7 roles)  radiator           `thermal.architecture: 'skin'`,
   *                                          `elementCounts: [0]`, and a
   *                                          length/beam floor that exists to
   *                                          make the skin big enough
   *   boom (survey)       boom               `sensors.language:
   *                                          'conformal-array'`, standoff
   *                                          0–0.03: the instruments are IN the
   *                                          skin, which is the whole read
   *   keel (colony)       keel               `structure.exposure: 'buried'`
   *   pylon (carrier)     pylon              `propulsion.mounting: 'recessed'`
   *                                          and a monocoque: a Sillane carrier
   *                                          swallows its craft, it does not
   *                                          hang them outside
   *   ring (colony)       ring               a Sillane colony hull spins about
   *                                          its own long axis. It is one loft;
   *                                          there is nothing to hang a hoop on
   *
   * A refusal with no such answer is a bug in this file, not a style. Use
   * `requiredVolumeKindsFor` rather than reading `RoleSpec.requiredVolumeKinds`
   * directly, so the subtraction happens in one audited place.
   */
  readonly forbiddenKinds: readonly VolumeKind[];
}

/** Proportion rules — the part of identity that survives at impostor range. */
export interface ProportionDna {
  /**
   * The culture's multiplier on the fleet-wide role fineness scale.
   *
   * THE TWO SIGNALS ARE INDEPENDENT AND BOTH MUST SURVIVE. Round two fixed "the
   * three factions look alike" by making `slendernessBand` a narrow absolute
   * interval per faction and reading the role's own `lengthBeam` as a *relative*
   * position inside it. It worked, and it broke the other half: Kessler's whole
   * band was 2.15–3.80, so every one of eighteen roles landed inside a 1.77×
   * window and a Kessler tug, liner and gunship came out as the same box. That
   * is BRIEF §4's "a role that is only a label on the same hull is a failure",
   * caused by the fix for BRIEF §8's "the faction's DNA is recognisable".
   *
   * A projection cannot carry two signals; a product can. The role states an
   * absolute fineness on one shared scale (`RoleSpec.lengthBeam` — a courier is
   * 5–9 and a tug is 1.4–2.4, in every yard), the culture states a gain, and the
   * two multiply. Both then read at full strength and neither compresses the
   * other:
   *
   *   - within a yard, courier ÷ tug is the ROLE ratio, about 3×, whatever the
   *     gain is;
   *   - on one role, Sillane ÷ Kessler is the GAIN ratio, about 2×, whatever the
   *     role is.
   *
   * That second number is the faction signature and it is now visible on ONE
   * hull rather than in a histogram, which is what the round-two note asked for
   * and did not get.
   *
   * HOW BIG THE GAIN RATIO HAS TO BE, which round three authored by feel and
   * round five measured. The r5 probe compared the three yards on 200 shared
   * seeds across 8 roles and found the pair ordering held on 89% of seeds for
   * Sillane/Kessler (authored 1.68×) but only 67% for Sillane/Ossuary (1.23×)
   * and 71% for Ossuary/Kessler (1.37×). Those are not authoring mistakes, they
   * are what those ratios are worth once the generator has finished with them:
   *
   *   authored ratio     band alone     + the ×0.78–1.30 per-seed fineness
   *                                       jitter in `blueprint.ts`
   *                                                    + the ×0.5–1.15 archetype
   *                                                      fineness modifier
   *   1.23×                 82%              75%               66%
   *   1.37×                 93%              85%               74%
   *   1.55×                 99%              93%               84%
   *   1.75×                100%              97%               88%
   *   2.00×                100%              99%               92%
   *
   * Two things follow, and both are why the numbers below are what they are.
   * First, an adjacent pair needs at least 1.5× before it survives the trip —
   * so the three gains are now spaced 1.55× and 1.49× (0.86, 1.33, 1.98) rather
   * than 1.37× and 1.23×, which puts Sillane at 2.3× Kessler across the fleet.
   * Second, the last column is not reachable from this file: at 2.0× the
   * measured ordering is still 92%, because the archetype modifier alone is a
   * ×2.3 spread applied AFTER the yard's band. Narrowing the bands does not
   * help either — it buys one point. The remaining separation has to come from
   * the archetype being chosen by doctrine instead of drawn from a role table
   * that every yard shares, which is what `MassingDna.archetypes` is for.
   */
  readonly slendernessGain: number;
  /**
   * Length ÷ beam of the PRIMARY HULL: the envelope this culture is physically
   * able to build in, whatever the role, the hull line or the topology asks for.
   *
   * An envelope, not an identity — the identity is `slendernessGain`. This band
   * exists to stop the product of a gain and an extreme role band leaving what
   * the yard can weld, cast or find: a Kessler hull finer than its floor is an
   * unsupported span its own load table forbids, a Sillane hull below its floor
   * cannot reject its drive heat through its own skin, and neither is a hull
   * anybody would fly. `lengthBeamFor` slides into it rather than clamping to
   * it, so a role pushed against the wall keeps its spread instead of collapsing
   * to a point.
   *
   * MEASUREMENT NOTE, because it has bitten two rounds running. This is the
   * fineness of the primary hull. The number a reviewer reads off a frame is
   * `dimensions.beamKm`, which `types.ts` defines as "overall width including
   * booms, radiators and gear", and which is additionally scaled by
   * `ARCHETYPE_PROPORTION` in `blueprint.ts` (a ring is ×0.5, a tower ×0.55, a
   * slab ×0.62 on fineness). Measured over 4 seeds × 7 roles × 3 factions the
   * overall ratio comes out at 0.50–0.52 of what this band says. The bands below
   * are authored honestly for the hull and carry a stated allowance for that
   * factor; if anyone retunes `ARCHETYPE_PROPORTION` or the outboard gear, the
   * gains here must come down by the same amount. See `lengthBeamFor`.
   */
  readonly slendernessBand: Range;
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

/**
 * How a hull of this culture ENDS at the front.
 *
 * A separate, mandatory field rather than a consequence of the loft, because it
 * is the first thing a player sees on an approaching contact and it was carrying
 * zero faction information: over two review rounds all three yards terminated in
 * the same swept dome, because the cap was chosen per hull LINE, every line's
 * choice was then rewritten by the nose-bluntness fallback in `blueprint.ts`
 * (`noseCapFor`), and the three cultures' choices collapsed onto the two styles
 * that fallback prefers. A faction-level declaration cannot collapse: whatever a
 * hull line wants, the yard only knows one way to close a bow.
 *
 * The three styles are three *manufacturing* answers, which is the only kind of
 * difference that survives a seed change:
 *
 *   - `bulkhead` — you cannot press a compound curve with a brake press, so the
 *     bow is a flat plate with a ring frame standing proud of it and a load
 *     table stencilled beside the door;
 *   - `ogive` — the hull left the mould in one piece, so the bow is the same
 *     surface as the flank with no break anywhere along it;
 *   - `graft` — the nose came off a different ship. It is a torch-cut edge, a
 *     visible diameter mismatch and a weld bead, and it is the honest read of a
 *     culture that never started from zero.
 */
export type ForeEndStyle = 'bulkhead' | 'ogive' | 'graft';

export interface ForeEndDna {
  readonly style: ForeEndStyle;
  /**
   * The cap the forward-most volume must be lofted with.
   *
   * Chosen for what SURVIVES `blueprint.ts:noseCapFor`, not only for what reads
   * best in isolation. That function rewrites `flat`→`ogive`/`taper` and
   * `ogive`→`dome` depending on how blunt the loft came out, and since
   * `noseEnd` is capped at `tailEnd * 0.62 ≤ 0.61` its last branch never fires.
   * What is left: `taper` and `open` are fixed points, `blunt` survives ~82% of
   * draws, `ogive` survives every draw on a role whose acceleration exceeds
   * 150 m/s² (those never reach `noseEnd` 0.40), and `flat` survives under half.
   * So a culture that wants a flat bow declares `blunt`, and a culture that
   * wants a point declares `taper` on its slow lines and `ogive` on its fast
   * ones. Nothing here declares `dome`.
   */
  readonly cap: CapStyle;
  /**
   * Diameter of the forward-most mass ÷ the mass immediately behind it.
   *
   * 1.0 is one continuous body. Ossuary's band is far from 1 in both directions
   * because the donor nose was never sized for this keel, and that mismatch — not
   * the cap — is what makes a graft read as a graft at 400%.
   */
  readonly graftRatio: Range;
  /** An external frame or ring standing proud of the forward face. */
  readonly ringFrame: boolean;
  /** The sentence a reviewer checks a 400% crop of the forward 400 px against. */
  readonly read: string;
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
  /**
   * A small trim on the yard's `slendernessGain`, and deliberately small.
   *
   * These used to run 0.78–1.30, which double-counted the role: a Revenue only
   * serves patrol, gunship and carrier, and those roles are already the fine end
   * of `RoleSpec.lengthBeam`, so a 1.25 line bias on top multiplied the same
   * statement twice and then had to be slid back inside the envelope, which
   * dragged the whole band down and undid it. A hull line is a product decision
   * worth a few per cent of proportion; what it is FOR is worth a factor of
   * five, and that already lives in the role.
   *
   * HARD RULE, ±5%, from round five: no entry may leave 0.95–1.05. The ±12% the
   * table had settled on was still a tenth of the yard gain it multiplies, and
   * two yards' lines can pull in opposite directions on the same role. They did:
   * the Sillane Carapace (0.92) and the Ossuary Threadline (1.05) between them
   * serve freighter, tanker, carrier and colony, and turned an authored 1.23×
   * yard ratio into 1.08× on precisely the roles the fleet shot pins. A line trim
   * that can cancel the faction signature is not a trim.
   */
  readonly lengthBeamBias: number;
  /** Section family this line prefers over the faction default, or null. */
  readonly sectionFamily: SectionFamily | null;
  /**
   * Cap style this line prefers at the nose.
   *
   * Constrained by `FactionDna.foreEnd`: a line may pick a cap that expresses
   * the yard's `foreEnd.style`, and may not pick one that contradicts it. Three
   * lines with three different bows is a yard with no bow, which is how all
   * three factions ended up terminating in the same dome.
   */
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
  /**
   * What masses this culture builds from and how it joins them. Read at BRIEF
   * §4 stage 3 (primary volumes) and stage 6 (secondary volumes), before
   * anything cosmetic exists.
   */
  readonly massing: MassingDna;
  readonly proportion: ProportionDna;
  /** How this yard closes a bow. Mandatory; see `ForeEndDna`. */
  readonly foreEnd: ForeEndDna;
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

  // Everything hangs off the frame, and the frame is the ship. A Kessler mass is
  // a rolled box on two pylons in a mirrored pair, because a crew with a gantry
  // has to be able to unbolt it, and because a mirrored parts list is half as
  // long to stock. The catalogue is SMALL — six kinds — and every pod on the
  // hull is the same pod, which is the read that separates a chartered yard from
  // a breakers' anchorage at silhouette distance even though both hulls are
  // "several masses held off a core".
  massing: {
    doctrine:
      'Rectangular masses slung off a visible frame on short pylons, always in mirrored pairs, every one of them the same size as its twin and drawn from one catalogue.',
    assembly: 'slung',
    attach: 'pylon',
    // No cluster, no asymmetric, no ring. A bundle of parallel capsules round a
    // core is not a thing you can walk between with a spanner, an asymmetric
    // hull is a hull nobody sized from a load table, and a spin ring is a
    // mechanism — the three things this doctrine exists to refuse.
    archetypes: ['monolithic', 'stacked', 'slab', 'tower', 'fork', 'spine-and-pod'],
    loadBearingMasses: [2, 3],
    externalMasses: [4, 10],
    // A catalogue: every pod is the same pod, to within the batch.
    massRatio: [1.0, 1.2],
    maxDistinctKinds: 7,
    budget: [
      { kind: 'pod', count: [2, 4] },
      { kind: 'pylon', count: [2, 6] },
      // Low, and it is `PropulsionDna.mounting` speaking: an `exposed-frame`
      // yard puts bare bells on a visible thrust structure, so what the eye
      // gets is frame and pylon, not pod. The pods on a Kessler carry cargo.
      { kind: 'nacelle', count: [0, 2] },
      // Tracks `ThermalDna.elementCounts` exactly, and must keep doing so —
      // radiator COUNT is the thermal block's decision, and this budget is only
      // here so a stage-6 caller reading one block does not contradict the
      // other. What separates a Kessler radiator from an Ossuary one is
      // `mirrored` and `aspect`, not how many there are.
      { kind: 'radiator', count: [2, 4] },
      { kind: 'tank', count: [1, 3] },
      { kind: 'machinery', count: [0, 2] },
      // A boom holds something AWAY from the hull, which is the opposite of
      // "within reach". Kessler put it on a pylon or they put it inside.
      { kind: 'boom', count: [0, 1] },
      { kind: 'cargo-rack', count: [0, 2] },
      { kind: 'shroud', count: [0, 1] },
      { kind: 'keel', count: [0, 1] },
      { kind: 'wing', count: [0, 1] },
      // A ring VOLUME is a welded hoop — a docking collar, a magnetic loop —
      // and a plate yard can roll one. A ring TOPOLOGY is a rotating habitat,
      // i.e. a mechanism with a schedule, and that is why `archetypes` above
      // has no 'ring' in it. The two are different statements and only the
      // second is a refusal.
      { kind: 'ring', count: [0, 1] },
    ],
    // A fin is styling on a hull that never sees air, and it is already refused
    // in prose by `neverBuildsPhysically`; this is the enforceable half of that
    // sentence.
    forbiddenKinds: ['fin'],
  },

  proportion: {
    // The bluntest gain in the fleet. A Kessler hull is a box that has been
    // persuaded to have a front, because a slender hull is a long unsupported
    // span and Kessler sizes members from a load table that punishes exactly
    // that.
    //
    // Was 0.95, against Sillane 1.6 and Ossuary 1.3 — ratios of 1.68 and 1.37
    // that the downstream noise ate. Measured over 200 shared seeds the yards
    // ordered correctly on only 67% and 71% of the two weak pairs, i.e. one
    // Ossuary in three came out finer than the Sillane built from the same seed.
    // A ratio of 1.55 per adjacent pair is what survives that noise; see the
    // arithmetic on `slendernessGain` in `ProportionDna`.
    slendernessGain: 0.86,
    // The envelope, not the identity. Ceiling 6.6 is the load table talking:
    // their finest product is a revenue cutter and even that is a plated box
    // with a wedge on the front, and finer than that is an unsupported span
    // their own members will not carry.
    //
    // FLOOR LOWERED 2.0 → 1.35, and it is a bug fix rather than a taste change.
    // The load table punishes SPAN, which is a statement about the ceiling; there
    // has never been a structural reason a Kessler cannot be stubby, and the
    // doctrine says the opposite ("a tug is a brick and the load table is happy
    // about it"). At 2.0 the floor clipped SEVEN roles — miner, salvager,
    // shuttle, prospector, refinery, tug and station-tender — onto the identical
    // band 2.70–4.2, which is BRIEF §4's "a role that is only a label on the same
    // hull", in this file, in a number nobody had measured. Both ends are stated
    // in HULL fineness — see the measurement note below.
    slendernessBand: [1.35, 6.6],
    // Deliberately well above the slenderness band, which is the same statement
    // in the other axis: L/H above L/B means H < B, so a Kessler section is a
    // WIDE FLAT SLAB rather than a tube. That is the read the welded-plate story
    // demands — rolled plate wants big flat faces — and it is what separates a
    // Kessler from a Sillane in outline at 100 px, where surface detail has long
    // since disappeared. Raised with the fineness band so the inequality still
    // holds at the fine end: at the old [3.0, 6.0] a 5.5-fineness Kessler came
    // out taller than it was wide, i.e. a tower, which is the Ossuary read.
    lengthHeight: [4.2, 9.5],
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

  // A brake press cannot make a compound curve and a roller cannot make a
  // point, so a Kessler bow is the only thing those two tools can produce: a
  // flat plate. The ring frame round it is the same frame that is at every
  // other station on the hull, and the load table is stencilled beside the bow
  // door because Kessler stencil everything.
  foreEnd: {
    style: 'bulkhead',
    cap: 'blunt',
    // One body: the bow plate is the same diameter as the section behind it.
    graftRatio: [0.94, 1.0],
    ringFrame: true,
    read: 'A flat, broad forward face with a hard edge all the way round it and an external frame standing proud of that edge. There is no curve anywhere in the termination.',
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
    // Overwhelmingly polygon. The generator draws a section family PER VOLUME,
    // so a 6:4 split does not mean "mostly boxy" — it means adjacent masses on
    // the same hull disagree about what shape they are, which is the Ossuary
    // read, not the Kessler one. A yard with one brake press and one roller
    // builds every section the same way, so the weight is 9:1 and the odd
    // superellipse is the pressure vessel they bought in.
    sectionFamilies: [
      ['polygon', 9],
      ['superellipse', 1],
      ['twin-lobe', 0],
    ],
    // High exponents only: a Kessler superellipse is a box with the corners
    // taken off, never an ellipse.
    exponent: [4, 8],
    // Four and six sides only. An octagon is a circle at any range where the
    // silhouette is what you are reading, and the whole point of the faceted
    // culture is that you can count its flats.
    polygonSides: [4, 6],
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
    // Cold grey industrial primer. Sits at ~0.06 linear luminance, unchanged
    // from the grey-green it replaces — this is a HUE rotation at constant
    // value, not a brightness change.
    //
    // WHY IT ROTATED. The hero shot is a Kessler, and its lit plate measured
    // R/B 1.43 with 0.30 saturation: a tan hull. Decompose that and the pigment
    // is the culprit, not the exposure — the showroom key is (3.0, 2.79, 2.46),
    // R/B 1.22, and 1.43 ÷ 1.22 is 1.16, which was exactly this line's old
    // R/B. A hull that is itself a warm 0.30-saturation surface spends the
    // whole frame's colour budget on its own base coat, which is why the oxide
    // chevrons and the tail band barely separated from the plate they sit on.
    // ARCHITECTURE §6 rations colour to amber instruments and one saturated
    // accent, and it names the base as desaturated steel-blue.
    //
    // The number below is 0.821 R/B, which is the reciprocal of the key's own
    // 1.22: a plate of this pigment comes back off the key neutral, and every
    // degree of warmth left in the frame is then genuinely `uScorch`, `uOxide`
    // and the bake term — the things that are supposed to be warm. The faction
    // spread stays in hue, not in warmth: Sillane sits colder still at 0.64 and
    // Ossuary just warm of neutral.
    hull: [0.0558, 0.0609, 0.0679],
    hullShadow: [0.0055, 0.0062, 0.0072],
    // Rotated onto the same hue at each shade's own original luminance, so the
    // plate-to-plate drift that keeps a Kessler hull from looking painted is
    // preserved exactly and only the tint moved. These feed uPlate0..3.
    plateShades: [
      [0.0504, 0.0549, 0.0613],
      [0.0585, 0.0638, 0.0712],
      [0.0535, 0.0583, 0.0651],
      [0.0614, 0.0670, 0.0748],
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
      lengthBeamBias: 1,
      sectionFamily: 'polygon',
      noseCap: 'blunt',
      accentOverride: null,
    },
    {
      id: 'kessler/revenue',
      name: 'Revenue',
      roles: ['patrol', 'gunship', 'carrier'],
      signature:
        'The same plate, stepped: the armour belt is a visible thickening amidships and the bow plate is a narrow chined face rather than a broad one.',
      // Was 1.1. See `HullFamily.lengthBeamBias`: a line trim of ±10% is a tenth
      // of the yard gain it sits on, and the three yards are separated by 1.55×.
      // Two yards' lines pulling in opposite directions on the same role cancel
      // most of that — a Sillane Carapace at 0.92 against an Ossuary Threadline
      // at 1.05 turned a 1.23× yard ratio into 1.08× on exactly the roles a
      // fleet shot pins. ±5% is what "a hull line is worth a few per cent" meant.
      lengthBeamBias: 1.05,
      sectionFamily: 'superellipse',
      // Was 'taper'. A hull line may not contradict `foreEnd.style`: three
      // Kessler lines with three different bows meant the yard had no bow, and
      // a taper is what Sillane do. The Revenue's difference from a Plateline
      // now lives where the doctrine puts it — in the armour step and the chine
      // — and not in the one feature that has to identify the builder.
      noseCap: 'blunt',
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
      // Was 0.9; see the Revenue's note.
      lengthBeamBias: 0.96,
      sectionFamily: 'polygon',
      // Was 'flat', which `noseCapFor` rewrites to an ogive or a taper on more
      // than half of all draws — the exact mechanism that put a dome on the
      // front of a welded-plate hull. 'blunt' survives 82% of draws and its
      // fallback is the same ogive, so this is strictly the flatter of the two.
      noseCap: 'blunt',
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

  // ONE MASS. Everything else in this block follows from that and none of it is
  // a preference: a hull that left the mould in one piece cannot have a pod on
  // it, because a pod is a part, and a part is a seam, and a seam is an
  // admission. So the external mass count is not "low", it is ZERO — the only
  // zero of its kind in the fleet, and the reason a Sillane reads as a round of
  // ammunition next to two hulls that read as assemblies.
  //
  // The census that provoked this block had Sillane emitting 1.34 booms, 2.49
  // pylons and 2.51 nacelles per hull — three kinds the culture's own
  // `neverBuildsPhysically` list says out loud it cannot make.
  massing: {
    doctrine:
      'One continuous loft. Where a hull needs more volume the loft swells; where it needs less it draws out again. Nothing is attached to a Sillane hull, because there is nothing to attach it to.',
    assembly: 'fused',
    attach: 'flush',
    // Three topologies, all of which are one body: a single loft, a single loft
    // with a moulded waist, and a single loft stood on its end. Cluster,
    // asymmetric, fork, spine-and-pod, slab and ring are all statements about
    // separate masses, and there are no separate masses.
    archetypes: ['monolithic', 'stacked', 'tower'],
    loadBearingMasses: [1, 1],
    externalMasses: [0, 0],
    massRatio: [1.0, 1.0],
    // The smallest vocabulary in the fleet by a wide margin, and it is the
    // identity: a hull, a nose, a tail and the fairing over the drive throat.
    maxDistinctKinds: 4,
    budget: [
      { kind: 'pod', count: [0, 0] },
      { kind: 'boom', count: [0, 0] },
      { kind: 'pylon', count: [0, 0] },
      { kind: 'nacelle', count: [0, 0] },
      { kind: 'radiator', count: [0, 0] },
      { kind: 'cargo-rack', count: [0, 0] },
      { kind: 'keel', count: [0, 0] },
      { kind: 'wing', count: [0, 0] },
      { kind: 'fin', count: [0, 0] },
      { kind: 'ring', count: [0, 0] },
      // Internal, and there is at most one of them: a moulded bay inside the
      // loft rather than a bottle strapped to it.
      { kind: 'tank', count: [0, 1] },
      { kind: 'machinery', count: [0, 1] },
      // The one thing they do build twice: the fairing round the recessed drive
      // throat, which is the same surface as the flank and reads as hull.
      { kind: 'shroud', count: [1, 2] },
    ],
    // The longest refusal list in the fleet, exactly as `forbiddenGreebles` is,
    // and for the same reason. Every one of these is a separate object bolted to
    // a hull that has no bolts.
    forbiddenKinds: ['pod', 'boom', 'pylon', 'nacelle', 'radiator', 'cargo-rack', 'keel', 'wing', 'fin', 'ring'],
  },

  proportion: {
    // 2.3× Kessler's gain and 1.49× Ossuary's, and those ratios ARE the faction
    // signature: they apply to every role the yards both build, so a Sillane
    // freighter is 2.3× as fine as a Kessler freighter and a Sillane tug 2.3× as
    // fine as a Kessler tug — a difference you can see on one hull without
    // knowing what a Kessler looks like, which is what the previous
    // non-overlapping-absolute-bands scheme was trying and failing to buy.
    //
    // Was 1.6. The r5 probe measured the Sillane/Ossuary pair ordering correctly
    // on 133 of 200 shared seeds — 67%, i.e. one Ossuary in three came out finer
    // than the Sillane built from the same seed — against an authored ratio of
    // 1.23×. The full arithmetic is on `ProportionDna.slendernessGain`; the short
    // version is that 1.23× is smaller than the per-seed noise the generator adds
    // downstream, and 1.5× is not.
    slendernessGain: 1.98,
    // THE THERMAL FLOOR. 4.8 is the shortest hull that can reject a plasma
    // drive's heat through its own skin at a working acceleration; below it the
    // flanks glow. No role, no hull line and no archetype may go under it, which
    // is why the floor of the envelope is the load-bearing half of this field
    // and the ceiling is only a sanity stop.
    //
    // The floor is not even constant: `slendernessBandFor` raises it with the
    // role's design acceleration, because radiating area goes as L×B while the
    // heat to reject goes as mass×accel ≈ L×B²×a. Cancel L×B and the beam has a
    // hard ceiling of order 1/a — so a fast Sillane is not a stubby Sillane
    // with a bigger drive, it is a longer one.
    // CEILING RAISED 9.5 → 11.0, and this is not the widening the review warned
    // against. The overlap it warned about was at the BLUNT end, where Ossuary's
    // [1.9, 9.5] swallowed this band whole; raising a ceiling moves the two
    // further apart, not closer. What it repairs is a role collapse inside this
    // yard: at 9.5 both a Sillane courier and a Sillane patrol saturated against
    // the same wall and came out with the same band, which is the other half of
    // BRIEF §8. Ossuary's ceiling is now 8.2, so the two no longer saturate onto
    // one number.
    slendernessBand: [4.8, 11.0],
    // Tracks the slenderness band closely, which makes H ≈ B: a Sillane section
    // is round. Kessler's L/H is far above its L/B and Sillane's sits on top of
    // its own, and that single difference is "slab" versus "spindle" in outline.
    // Moved with the band above, because it is the same statement.
    lengthHeight: [4.8, 11.0],
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

  // The hull left the mould in one piece, so there is no forward *joint* to
  // detail — the bow is the flank, continued until it closes. That is the whole
  // statement, and it is why the graft ratio is pinned at 1: a step in diameter
  // anywhere on a Sillane, including at the nose, would be a seam, and a seam is
  // an admission.
  foreEnd: {
    style: 'ogive',
    // 'ogive' and not 'dome'. A dome is the shape all three yards were arriving
    // at and it is therefore the one shape this field exists to forbid; see the
    // survival note on `ForeEndDna.cap`. The Needle line carries fast roles and
    // holds a true ogive on every draw; the slower lines declare 'taper', which
    // `noseCapFor` never rewrites at all.
    cap: 'ogive',
    graftRatio: [1.0, 1.0],
    ringFrame: false,
    read: 'One unbroken curve that leaves the flank tangentially and closes to a point, with no edge, no step and no fastener anywhere along it. You cannot say where the bow starts.',
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
    // ONE family, at weight 1, and the other two at zero on purpose.
    //
    // This used to be 7 superellipse / 3 twin-lobe, and that was the single
    // worst line in the file. The generator draws a family per volume, so three
    // in ten Sillane masses came out as a twin lobe with a visible separation
    // between them — a hull whose entire identity is "poured in one piece" was
    // arriving as two parallel tubes with a valley down the middle, which is
    // also exactly what an Ossuary hull looks like from the front. A monocoque
    // culture cannot have a section vocabulary; it has a section.
    //
    // Twin-lobe now belongs to Ossuary alone, where two mismatched pressure
    // hulls welded side by side is the true story rather than a contradiction.
    sectionFamilies: [
      ['superellipse', 1],
      ['twin-lobe', 0],
      ['polygon', 0],
    ],
    // Low exponents, and a narrow band: an ellipse or barely more. Narrow
    // matters as much as low, because the exponent is drawn per volume too — a
    // band of [2, 3.2] lets one mass be an ellipse and the next a rounded box,
    // and the step between them reads as a joint. There are no joints.
    exponent: [2.0, 2.7],
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
    // No 'dome'. It was the only cap all three yards shared and it is now
    // declared out of the Sillane vocabulary entirely — see `foreEnd`.
    caps: ['ogive', 'taper'],
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
        'A single ogive spindle with a 3-lobe chine and a recessed throat; the beam never exceeds a seventh of the length.',
      // Was 1.08; see the Kessler Revenue's note on line trims.
      lengthBeamBias: 1.05,
      sectionFamily: 'superellipse',
      noseCap: 'ogive',
      accentOverride: null,
    },
    {
      id: 'sillane/carapace',
      name: 'Carapace',
      roles: ['freighter', 'tanker', 'liner', 'carrier', 'colony'],
      // Was described as a twin-lobe body, which contradicted the culture and
      // in practice arrived as two parallel tubes. The volume it needs comes
      // from girth inside one fairing, not from a second lobe: a Carapace is a
      // Needle that has swallowed something, with a moulded waist amidships and
      // still no seam anywhere on it.
      signature:
        'One continuous fairing swollen amidships and drawn out again aft, with a moulded waist rather than a joint; the fattest thing Sillane build and still finer than anything Kessler do.',
      // Was 0.92, and it was the single worst line trim in the file: the
      // Carapace serves freighter, tanker, liner, carrier and colony, and every
      // one of those is served on the Ossuary side by the Threadline at 1.05.
      // The two lines pulled against each other and turned the yard ratio into
      // 1.08x on exactly the roles the fleet shot pins.
      lengthBeamBias: 0.96,
      sectionFamily: 'superellipse',
      // Was 'dome', and this single line is why the fleet-contrast shot showed
      // three identical rounded caps: the Carapace serves 'freighter', the role
      // that shot pins, and 'dome' is the one style `noseCapFor` never rewrites
      // — so a hundred per cent of Sillane freighters arrived as a hemisphere.
      // 'taper' is the other fixed point and it is a point, not a ball.
      noseCap: 'taper',
      accentOverride: null,
    },
    {
      id: 'sillane/lector',
      name: 'Lector',
      roles: ['survey', 'science', 'salvager', 'miner', 'prospector', 'tug', 'refinery', 'station-tender', 'derelict'],
      signature:
        'The Needle body with a dorsal instrument spine faired into it, so the sensors read as a swelling in the hull rather than as hardware bolted on top.',
      lengthBeamBias: 1,
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

  // Threaded, not slung. The difference between this and Kessler is the whole of
  // the r5 census finding: both hulls are "several masses held off a core", and
  // the numbers said so — pylon 2.51 against 2.77, nacelle 2.55 against 2.49,
  // boom 1.41 against 1.70. Two cultures with opposite doctrines were building
  // from one parts bin in one set of proportions.
  //
  // What actually separates them is the SIZE and the COUNT, not the kind. A
  // Kessler pod is one of four identical pods on mirrored pylons; an Ossuary can
  // is one of six that do not match, clamped straight to the found keel at
  // whatever clock angle cleared, with the biggest three times the smallest.
  // That is why `massRatio`, `maxDistinctKinds` and the `count` bands carry the
  // identity here and the kind list barely does.
  massing: {
    doctrine:
      'Unequal salvaged cans clamped along a keel somebody else built, no two the same diameter, at whatever clock angle was free, with the bare keel visible between them.',
    assembly: 'threaded',
    attach: 'keel-clamp',
    // Monolithic is out, and it is the only hard refusal in the list: a
    // breakers' anchorage cannot pour a single body, which is the exact
    // inversion of Sillane. Slab and ring go with it — both are one large
    // precision structure, and the anchorage has never made one.
    archetypes: ['asymmetric', 'cluster', 'fork', 'spine-and-pod', 'tower', 'stacked'],
    // One found keel. Everything else on the ship is cargo as far as the load
    // path is concerned, which is exactly why the thrust axis misses the centre
    // of mass and why they counterweight instead of re-mounting.
    loadBearingMasses: [1, 2],
    externalMasses: [5, 14],
    // Nothing matches. The largest can on the keel is two to four times the
    // smallest, because both were somebody else's answer to somebody else's
    // problem.
    massRatio: [1.8, 4.0],
    // The widest vocabulary in the fleet, and the only one that is wide because
    // the culture had no say in it.
    maxDistinctKinds: 12,
    budget: [
      // Every tank on the ship was a tank when they found it — the highest tank
      // count in the fleet by more than double, against Kessler's 1–3 and
      // Sillane's 0–1.
      { kind: 'tank', count: [3, 6] },
      { kind: 'boom', count: [2, 5] },
      { kind: 'cargo-rack', count: [1, 4] },
      { kind: 'machinery', count: [1, 4] },
      // Bare pipe loops are a bad radiator, so there are a lot of them and they
      // are never a matched pair.
      { kind: 'radiator', count: [1, 5] },  // = `thermal.elementCounts`
      { kind: 'keel', count: [1, 2] },
      // `podded`, and `engineCounts` says one to three of them. Twice Kessler's,
      // because a Kessler bell hangs on a frame and an Ossuary drive arrives
      // already in somebody else's pod.
      { kind: 'nacelle', count: [1, 3] },
      // They do not build pods and they do not build pylons: a pod is a
      // designed sub-hull and a pylon is a designed mount. What they have is
      // cans and clamps.
      { kind: 'pod', count: [0, 1] },
      { kind: 'pylon', count: [0, 2] },
      { kind: 'fin', count: [0, 2] },
      { kind: 'wing', count: [0, 1] },
      { kind: 'ring', count: [0, 1] },
    ],
    // The cowling was the first thing sold. Nothing on an Ossuary hull is
    // faired over, which is the inversion of Sillane's one permitted kind.
    forbiddenKinds: ['shroud'],
  },

  proportion: {
    // Between the other two, because a scavenger inherits the fleet's average
    // rather than a doctrine — 1.55× Kessler's and 1.49× under Sillane's, which
    // are the ratios that survive the generator's own per-seed noise. Was 1.3
    // against Sillane's 1.6: a 1.23× separation that the r5 probe could only
    // read on two seeds in three.
    slendernessGain: 1.33,
    // A REAL INTERVAL, at last. This was [1.9, 9.5] — the union of the other two
    // yards' envelopes, which is not a band but the absence of one. It let an
    // Ossuary hull be blunter than any Kessler and finer than any Sillane, and
    // since it shared its ceiling with Sillane exactly, every fast role in both
    // yards saturated against the same wall and came out the same shape. The
    // measured distributions duly overlapped almost completely: p10–p90 of
    // 1.54–6.49 against Sillane's 1.98–7.16.
    //
    // The floor sits above Kessler's and the ceiling below Sillane's, so no two
    // of the three envelopes now share a wall and a clipped role stays ordered.
    // The culture's "no policy" has not been deleted, it has been moved to where
    // it is actually visible: `diameterStep` 0.45–0.85, `massConcentration`
    // 0.2–0.55, `primaryMasses` 3–6, `panelSizeVariance` 0.65 and the whole
    // `massing` block above. A salvage yard is unpredictable in what it bolts
    // on, not in how long its hulls are — the keels it starts from came out of
    // the same fleet as everyone else's.
    slendernessBand: [2.05, 8.2],
    // Far below the slenderness band, which is the inverse of Kessler: an
    // Ossuary hull is TALLER than it is wide, because things got welded on top
    // of the keel where there was room and nothing was ever faired back in.
    lengthHeight: [1.9, 5.5],
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

  // Nobody at the anchorage has ever built a bow. What is on the front of an
  // Ossuary hull is the front of a different ship, cut off with a torch where
  // the plate was still sound and welded onto this keel — which means the one
  // dimension that never matched is the one you see head-on. The graft ratio is
  // the whole read: a nose visibly fatter or visibly thinner than the body
  // behind it, with a bead round the join and a collar of filler plate where the
  // two circles did not.
  foreEnd: {
    style: 'graft',
    // 'open' is a fixed point under `noseCapFor` and it is also the literal
    // truth: a torch cut leaves a hole, and what closes it is a plate somebody
    // welded across afterwards, not a moulded cap. The Threadline and Scrapjack
    // lines carry it too, so all three read the same way.
    cap: 'open',
    // Both directions, and never 1. A donor nose that happened to match would
    // not be a graft.
    graftRatio: [0.45, 1.75],
    ringFrame: true,
    read: 'A forward mass of obviously the wrong diameter for the body behind it, meeting it at an irregular cut line with a weld bead and filler plate round the step. The termination itself is a flat cut, not a shape.',
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
    // Twin-lobe is now theirs alone, and its weight goes up accordingly: two
    // pressure hulls welded side by side with a valley between them is a true
    // Ossuary story (nobody poured that; somebody butted two donors together)
    // and a false Sillane one. It is also the only place in the fleet where a
    // head-on outline is two circles, so it is worth a third of the vocabulary.
    sectionFamilies: [
      ['polygon', 4],
      ['superellipse', 4],
      ['twin-lobe', 3],
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
    // 'dome' is gone. Nothing at the anchorage can press one, and it was the
    // shape all three yards were converging on — see `foreEnd`.
    caps: ['open', 'flat', 'blunt'],
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
    // Grey-black with the warmth taken out of the BASE and left in the rust.
    //
    // The old value was R/B 1.77 at 0.43 saturation — a hull that was itself
    // brown, which under the showroom key lands at R/B 2.16 and spends the
    // frame's entire colour ration on its own primer before a single oxide
    // streak is drawn. ARCHITECTURE §6 allows one saturated accent per location
    // and Ossuary's is the acid green.
    //
    // Losing the brown costs the rust story nothing, and in fact buys it: the
    // rust lives in `primer`, `oxide` and a corrosion wear weight of 1.0 — all
    // still as warm as they ever were — and those now read AGAINST the plate
    // instead of being the plate. Ossuary stays the warm end of the fleet's hue
    // spread (Sillane 0.64, Kessler 0.82, Ossuary 1.05 R/B) at a fraction of
    // the chroma.
    hull: [0.0385, 0.0370, 0.0367],
    hullShadow: [0.0042, 0.004, 0.004],
    // Wide, not tight: these are genuinely different plates from different
    // yards, so the drift is large enough to see across the hull. The SPREAD is
    // the identity here, so it is preserved in full — only the mean hue moved,
    // and the one entry that is a Sillane plate stays cold.
    plateShades: [
      [0.0300, 0.0286, 0.0282],
      [0.0455, 0.0400, 0.0356],
      [0.0392, 0.0398, 0.0410],
      [0.0510, 0.0458, 0.0400],
      [0.0255, 0.0262, 0.0284],
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
      // Kessler's hull colour exactly, tracking `KESSLER.palette.hull`: a
      // Kessler plate on an Ossuary keel is the best story in the palette and it
      // costs one line. Keep the two in step if either moves.
      [0.0558, 0.0609, 0.0679],
      // Sillane's hull colour exactly.
      [0.036, 0.043, 0.056],
      // Bare red primer off something that never got a topcoat, and a yard grey.
      // These two are allowed to be warm and saturated: a mismatch panel is the
      // ONE place a hue is supposed to shout, which only works because the plate
      // around it no longer does.
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
      // Was 1.05. See the Sillane Carapace: these two lines serve the same
      // roles from opposite directions and cancelled the yard signature.
      lengthBeamBias: 1.02,
      sectionFamily: null,
      // Was 'flat', which `noseCapFor` rewrites to a taper or an ogive on more
      // than half of all draws — this line carries 'freighter', the role the
      // faction-contrast shot pins, so half of that shot's Ossuary bows were a
      // point. 'open' is a fixed point under that function and it is the graft
      // itself: a torch cut, with the next can visible through it at a
      // different diameter. See `foreEnd`.
      noseCap: 'open',
      accentOverride: null,
    },
    {
      id: 'ossuary/gutwork',
      name: 'Gutwork',
      roles: ['salvager', 'miner', 'prospector', 'refinery'],
      signature:
        'A short keel almost buried under working machinery, with two jointed arms that can fold back past the drives and a floodlit open working bay amidships.',
      // Was 0.88.
      lengthBeamBias: 0.95,
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
      // Was 1.12, the largest trim in the fleet, on the line that serves the
      // fast roles where this yard has to stay clear of Sillane.
      lengthBeamBias: 1.05,
      sectionFamily: 'superellipse',
      // Was 'blunt', which is Kessler's bow: a scavenger line and a plate yard
      // arriving at the same broad flat face is the failure this whole field
      // exists to stop. "Everything non-essential cut off" includes the nose.
      noseCap: 'open',
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
  /**
   * Length ÷ beam this role wants, on ONE absolute scale shared by every role
   * in the fleet, before the builder's `slendernessGain` is applied.
   *
   * The scale runs from a station tender at 1.3 to a courier at 9, and the
   * ORDERING is the contract — a reviewer holding two renders checks the order,
   * not the numbers. Read it as a single sentence: a courier and a gunship are
   * lances, a patrol is nearly one, a liner and a freighter are long boxes, a
   * tanker and a carrier are shorter boxes, and a tug, a miner and a tender are
   * bricks with the machinery on the outside.
   *
   * Two entries were previously the wrong way round against their own
   * `distinguishFrom` prose and both showed up in the r3 review as roles that
   * had collapsed into their neighbours: a gunship was BLUNTER than a freighter
   * (2.4–4.2 against 3.0–6.0) and a liner was FINER than a patrol boat
   * (4.0–7.0 against 3.2–5.5). Ordering errors here are invisible in a table
   * and unmissable in a fleet shot.
   *
   * These numbers are not a hull's final fineness. They are multiplied by the
   * yard's gain and then held inside its envelope; see `lengthBeamFor`.
   */
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
    lengthBeam: [5.0, 9.0],
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
      { role: 'shuttle', by: 'from the same yard, a shuttle is the blunt one and a courier the fine one — the courier\'s length/beam is at least twice the shuttle\'s, whoever built them.' },
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
    lengthBeam: [3.0, 5.0],
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
    lengthBeam: [1.5, 2.6],
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
    lengthBeam: [2.8, 4.4],
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
    lengthBeam: [4.0, 6.5],
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
      { role: 'courier', by: 'a patrol\'s beam carries barbettes and its L/B never exceeds 6.5; a courier is a smooth line with nothing on it and never below 5.' },
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
    lengthBeam: [1.8, 3.0],
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
    lengthBeam: [1.6, 2.8],
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
    lengthBeam: [1.8, 3.0],
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
      { role: 'courier', by: 'a shuttle\'s delta-v is under 15 km/s and a courier\'s over 90; and from the same yard the courier is at least twice the shuttle\'s length/beam.' },
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
    lengthBeam: [2.5, 4.2],
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
    lengthBeam: [2.0, 3.2],
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
    lengthBeam: [1.6, 2.8],
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
    lengthBeam: [1.4, 2.4],
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
    lengthBeam: [3.0, 4.8],
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
    lengthBeam: [3.2, 5.2],
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
    lengthBeam: [4.0, 7.0],
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
    lengthBeam: [2.2, 3.6],
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
    lengthBeam: [1.3, 2.4],
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
    lengthBeam: [1.6, 6.0],
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

// ---------------------------------------------------------------------------
// Massing — the interface `blueprint.ts` reads at BRIEF §4 stage 3 and stage 6
// ---------------------------------------------------------------------------

/**
 * THE FOUR CALLS THE GENERATOR MAKES, and the order it makes them in.
 *
 *   stage 3, before any dimension exists:
 *     `archetypeWeightsFor(faction, ROLE_TOPOLOGY[role].archetypes)`
 *        → the role's own table with everything this yard cannot build zeroed.
 *          Feed the result to the existing weighting; zeros MUST stay zero
 *          through `ARCHETYPE_FLOOR_SHARE`, which is the reason this returns
 *          zeros rather than small numbers. `FACTION_ARCHETYPE_BIAS` may keep
 *          shading the survivors — the two compose, and the bias is a
 *          preference where this is a capability.
 *     `massCountFor(faction, 'load-bearing' | 'external')`
 *        → how many masses carry the load path, and how many hang outside it.
 *
 *   stage 6, per candidate secondary volume:
 *     `allowsVolumeKind(faction, kind)` → a hard refusal, before any placement
 *        work is done. A Sillane hull emits no `pod`, `boom`, `pylon`,
 *        `nacelle`, `radiator`, `cargo-rack`, `keel`, `wing`, `fin` or `ring`
 *        under any seed, any role and any archetype.
 *     `volumeKindBudgetFor(faction, kind)` → the count band for a kind this
 *        yard does build, to be intersected with whatever the role demands.
 *
 * Everything here is a pure function of frozen data and does no drawing, so a
 * caller may evaluate it before it has an `Rng` and cache the result per
 * (faction, role) for a fleet.
 */
export function massingFor(faction: FactionDna): MassingDna {
  return faction.massing;
}

/** True when this culture will emit this volume kind at all. */
export function allowsVolumeKind(faction: FactionDna, kind: VolumeKind): boolean {
  const m = faction.massing;
  if (m.forbiddenKinds.includes(kind)) return false;
  for (const b of m.budget) if (b.kind === kind) return b.count[1] >= 1;
  // Unlisted kinds are the role-driven ones (`hull`, `forebody`, `midbody`,
  // `afterbody`, `bridge`, `habitat`, `cargo-bay`). A faction has no opinion
  // about whether a ship has a nose.
  return true;
}

/**
 * The count band for a volume kind, per hull, before the role has its say.
 *
 * `[0, 0]` for a refusal — a caller that treats that as "rare" rather than as
 * "never" has reintroduced exactly the bug this block exists to fix. Unlisted
 * kinds return `null`, which means "not a faction decision, ask the role".
 */
export function volumeKindBudgetFor(faction: FactionDna, kind: VolumeKind): Range | null {
  const m = faction.massing;
  if (m.forbiddenKinds.includes(kind)) return [0, 0];
  for (const b of m.budget) if (b.kind === kind) return b.count;
  return null;
}

/**
 * The role's required volume kinds, minus the ones this culture performs
 * another way. See the precedence table on `MassingDna.forbiddenKinds`: a
 * required kind names the usual FORM of a function, and a yard that has already
 * declared a different architecture for that function does not also owe the
 * form. Reading `RoleSpec.requiredVolumeKinds` directly is how a Sillane hull
 * ends up owing a radiator fin.
 *
 * Never returns a kind the yard refuses, and never invents one.
 */
export function requiredVolumeKindsFor(faction: FactionDna, role: RoleSpec): readonly VolumeKind[] {
  const out: VolumeKind[] = [];
  for (const k of role.requiredVolumeKinds) if (allowsVolumeKind(faction, k)) out.push(k);
  return out;
}

/** How many masses of each structural duty a hull of this culture carries. */
export function massCountFor(faction: FactionDna, duty: 'load-bearing' | 'external'): Range {
  const m = faction.massing;
  return duty === 'load-bearing' ? m.loadBearingMasses : m.externalMasses;
}

/**
 * The role's archetype table with everything this yard cannot build zeroed.
 *
 * Generic in the weight-list element so `blueprint.ts` can pass its own
 * `readonly [HullArchetype, number][]` straight in and get the same shape back,
 * without this file importing anything from it.
 *
 * Falls back to the role's own table if the intersection is empty. That should
 * be unreachable — every role in `ROLE_TOPOLOGY` shares at least one archetype
 * with every faction that builds it, and `factionRoleWeight` already excludes
 * the pairings that do not exist — but a generator with nothing to draw from
 * would silently produce a default hull, which is the worst failure mode
 * available here.
 */
export function archetypeWeightsFor<A extends string>(
  faction: FactionDna,
  roleWeights: readonly (readonly [A, number])[],
): readonly (readonly [A, number])[] {
  const allowed = faction.massing.archetypes as readonly string[];
  const out: (readonly [A, number])[] = [];
  let total = 0;
  for (const [a, w] of roleWeights) {
    const v = allowed.includes(a) ? w : 0;
    total += v;
    out.push([a, v]);
  }
  return total > 0 ? out : roleWeights;
}

/**
 * How much of the declared hull fineness survives to the measured outline.
 *
 * NOT a fudge factor, and it is written down here rather than folded silently
 * into the bands so that whoever fixes the two causes can delete it.
 *
 * `ProportionDna.slendernessBand` and `RoleSpec.lengthBeam` describe the primary
 * hull. What a reviewer measures off a frame is `ShipDimensions.beamKm`, which
 * `types.ts` defines as "overall width including booms, radiators and gear", and
 * which `blueprint.ts` additionally scales through `ARCHETYPE_PROPORTION` — a
 * ring hull is ×0.5 on fineness, a tower ×0.55, a slab ×0.62, a cluster ×0.78.
 * Measured over 4 seeds × 7 roles × 3 factions, the ratio of outline fineness to
 * declared hull fineness is 0.50–0.52 and it is remarkably stable across all
 * three yards.
 *
 * Two thirds of that is legitimate — a slab-topology hull with two radiator
 * slabs really is wider than its own hull tube — and one third is the archetype
 * multiplier leaving a band the doc comment says nothing may leave. So the bands
 * carry a stated allowance of 1.35, not the full 2.0 it would take to make the
 * measured numbers hit a target: inflating a declared band to cancel a
 * downstream multiply is how the number stops meaning anything, and if anyone
 * repairs `ARCHETYPE_PROPORTION` while this is set to 2.0 the whole fleet turns
 * into needles overnight.
 *
 * Applied ONCE, at the end of `lengthBeamFor`, after the envelope has had its
 * say — so every band above stays authored in hull fineness and only the value
 * handed to the generator is in outline fineness. That is a unit conversion at a
 * boundary, which is a thing you can delete; a band inflated to cancel a
 * downstream multiply is not.
 */
const OUTLINE_ALLOWANCE = 1.35;

/**
 * The acceleration a skin-radiator hull is proportioned against, m/s².
 *
 * Half the player's own 200 (`DEFAULT_SHIP_CONFIG`) — a working hull rather than
 * a fast one. Below this the culture's baseline floor already sheds the heat, so
 * the term does nothing; above it the floor climbs.
 */
const SKIN_RADIATOR_REFERENCE_ACCEL_MS2 = 100;

/**
 * How hard the floor climbs with acceleration.
 *
 * The physics wants 1: radiating area goes as L·B, heat to reject as m·a ≈
 * ρ·L·B²·a, so B ≤ k/a and L/B ≥ L·a/k — linear. Linear over the 30× spread of
 * `accelMs2` across the role table would put a Sillane gunship at L/B 40, which
 * is not a ship. A quarter power keeps the ORDER exactly right (every hotter
 * role is forced longer than every cooler one) inside a band a hull can
 * actually be built in, which is the honest version of a heroic engine.
 */
const SKIN_RADIATOR_SLENDERNESS_EXP = 0.25;

/**
 * Slide `inner` until it lies inside `hard`, keeping its RATIO.
 *
 * A plain clamp collapses a band that falls outside onto a point, and a point
 * means every seed of that (faction, role) comes out with the same proportion —
 * trading one BRIEF §8 failure ("the faction's DNA is not recognisable") for the
 * other ("different seeds are the same ship redressed"). Sliding keeps the
 * variation the role and the hull line asked for and moves it somewhere legal.
 *
 * WHAT IS PRESERVED IS THE RATIO, NOT THE WIDTH, and that is this round's
 * correction. A fineness band is multiplicative: the role table's `[5.0, 9.0]`
 * for a courier says "1.8× of spread", and the same 1.8× at the blunt end of the
 * table is `[1.4, 2.4]` — an absolute width of 4.0 against 1.0. Preserving the
 * absolute width when a band is pushed against a wall therefore INFLATES it:
 * a Sillane courier arrived as 2.16× of spread and an Ossuary courier as 2.58×,
 * against the 1.8× the role asked for, and every bit of that extra spread is
 * pure per-seed noise landing exactly where two yards meet. It cost the
 * Sillane/Ossuary pair ordering directly, since both were saturating against a
 * shared ceiling with bands the clip had widened.
 *
 * Geometric sliding also cannot produce a floor below zero or an inverted band,
 * which the linear version could for a hard band narrower than the inner one.
 */
function slideIntoBand(inner: Range, hard: Range): Range {
  const lo0 = Math.max(inner[0], 1e-6);
  if (!(hard[1] > hard[0]) || hard[0] <= 0) return [hard[0], hard[0]];
  // The inner band's ratio, never below 1 (a reversed band is a caller bug, and
  // collapsing it to a point here is the safe reading) and never wider than the
  // envelope itself.
  const want = inner[1] / lo0;
  const room = hard[1] / hard[0];
  const r = want < 1 ? 1 : want > room ? room : want;
  let lo = lo0;
  if (lo < hard[0]) lo = hard[0];
  if (lo * r > hard[1]) lo = hard[1] / r;
  return [lo, lo * r];
}

/**
 * The faction's binding slenderness band for one role.
 *
 * For every culture but one this is simply `proportion.slendernessBand`. For a
 * culture whose radiator IS its skin, the floor is a function of the drive it
 * is asked to carry, because that is what the doctrine actually says: the hull
 * is long *in order to* reject its own heat, so a hull asked to reject more of
 * it has to be longer. A Sillane gunship is not a stubby Sillane with a big
 * drive; there is no such object.
 *
 * The rise is capped at three quarters of the band so a hot role still has room
 * to vary — a floor that swallows the band would make every Sillane courier
 * identical.
 */
export function slendernessBandFor(faction: FactionDna, role: RoleSpec): Range {
  const hard = faction.proportion.slendernessBand;
  if (faction.thermal.architecture !== 'skin') return hard;
  const a = rangeMid(role.accelMs2);
  if (!(a > SKIN_RADIATOR_REFERENCE_ACCEL_MS2)) return hard;
  const rise = Math.pow(a / SKIN_RADIATOR_REFERENCE_ACCEL_MS2, SKIN_RADIATOR_SLENDERNESS_EXP);
  const ceiling = hard[0] + 0.75 * (hard[1] - hard[0]);
  const floor = Math.min(hard[0] * rise, ceiling);
  return [floor, hard[1]];
}

/**
 * The length/beam band for a specific (faction, role, family).
 *
 * A PRODUCT, not a projection, and that is the whole of this round's change.
 *
 * Round two composed the two signals by reading the role's band as a *relative*
 * position and projecting it onto the faction's absolute band. Two signals do
 * not fit through one projection: whichever band is narrow wins and the other
 * one is compressed into it. With Kessler's band at 2.15–3.80, every one of
 * eighteen roles landed inside a 1.77× window, and the r3 fleet came back with a
 * tug, a liner and a gunship built from the same seed as the same box in three
 * sizes — BRIEF §4's stated failure, produced by the fix for BRIEF §8's.
 *
 * A product carries both at full strength and neither compresses the other:
 *
 *   1. the ROLE states an absolute fineness on the fleet's one shared scale, and
 *      that number is the same in every yard — this is "function decides form",
 *      and it is now the term with the largest dynamic range (1.3 to 9, about
 *      5×, where it used to have about 1.5×);
 *   2. the FACTION states a gain, and the gain is the same for every role it
 *      builds — so the Sillane-to-Kessler ratio is 1.7× on a freighter, on a
 *      tug and on a patrol alike, which is what makes the yard readable off ONE
 *      hull instead of off a histogram;
 *   3. the FAMILY biases the product, because a hull line is a product decision;
 *   4. the ENVELOPE has the last word, because it is the only physical
 *      constraint of the four — a Kessler span its load table will not carry, or
 *      a Sillane too short to shed its own drive heat, is not a ship. It is
 *      applied by SLIDING, so a role pushed against a wall keeps its spread
 *      instead of collapsing to a point and giving every seed the same hull.
 *
 * The Sillane thermal floor survives intact and is still the strongest statement
 * in the file, because a floor composes with a product without distorting it:
 * `slendernessBandFor` raises the envelope's lower wall with the role's drive
 * heat, and step 4 slides the whole band above it.
 */
export function lengthBeamFor(faction: FactionDna, role: RoleSpec, family: HullFamily): Range {
  const envelope = slendernessBandFor(faction, role);
  const gain = faction.proportion.slendernessGain * family.lengthBeamBias;
  const wanted: Range = [role.lengthBeam[0] * gain, role.lengthBeam[1] * gain];
  // Everything to here is in HULL fineness, which is the unit every band in this
  // file is authored in and the unit the envelope means. The generator wants the
  // number that makes the OUTLINE come out at that fineness, so the conversion
  // happens once, here, at the boundary — and never by quietly inflating a band.
  const hull = slideIntoBand(wanted, envelope);
  return [hull[0] * OUTLINE_ALLOWANCE, hull[1] * OUTLINE_ALLOWANCE];
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
