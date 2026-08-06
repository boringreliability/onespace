/**
 * oneSpace — the ship blueprint contract.
 *
 * This file is the seam between the ship *generator* (`gen/ships/*`, pure) and
 * the ship *renderer* (`render/ships/*`, impure). It is the single source of
 * truth for what a ship IS. Everything downstream — geometry, materials,
 * propulsion, physics, the HUD scanner — reads this and nothing else.
 *
 *   seed ──▶ ShipBlueprint (plain JSON) ──▶ Object3D
 *
 * Three rules govern every type below:
 *
 * 1. **Serialisable.** Numbers, strings, booleans, readonly arrays and plain
 *    objects only. No classes, no Maps, no functions, no `Vector3`. A blueprint
 *    must survive `JSON.parse(JSON.stringify(bp))` unchanged, because that is
 *    how we diff two seeds and how a regression test pins a hull.
 * 2. **Absolute.** Every placeable thing carries a resolved `Frame` in
 *    ship-local coordinates. The renderer never solves for a position: no
 *    inverse kinematics, no "walk the spine to find where this goes". Where a
 *    thing was *derived from* is recorded separately, as provenance, for the
 *    physics reviewer and for damage.
 * 3. **Append-only.** Once published, fields are added, never removed or
 *    re-typed. Anything that changes the bytes a generator produces bumps
 *    `SHIP_GENERATION_VERSION`.
 *
 * ---------------------------------------------------------------------------
 * UNITS — identical to `gen/types.ts`, restated because ships are the one place
 * in the project where the numbers are small enough to get wrong.
 *
 *   Distance   kilometres. 1 render unit = 1 km. A 30 m courier is 0.03.
 *              A 2.4 m hatch is 0.0024. If you typed a number bigger than ~4
 *              you have built something the size of a capital ship.
 *   Time       seconds
 *   Mass       kilograms (NOT tonnes — `FlightModel.ShipConfig.mass` is kg)
 *   Force      newtons.  Torque: newton-kilometres (N·km), matching
 *              `ShipConfig.rcsTorque`, which divides by an inertia in kg·km².
 *   Inertia    kg·km²
 *   Angles     radians
 *   Colour     linear sRGB, 0..1 per channel
 *   Volume     cubic metres for human-facing scan readouts only
 *
 * ---------------------------------------------------------------------------
 * SHIP-LOCAL FRAME — the same handedness `Ship.ts` and `FlightModel.ts`
 * already use, so a generated hull drops into the player's seat unmodified.
 *
 *   -Z  forward (the nose)          `FlightModel.forward` is (0,0,-1)
 *   +Y  up (dorsal)
 *   +X  starboard
 *   +Z  aft (the exhaust goes this way)
 *
 * ORIGIN. The origin is the **dry centre of mass**. The generator builds in
 * whatever datum is convenient and rebases every position before returning, so
 * that `physics.centreOfMass` is ~(0,0,0). This is not cosmetic: `FlightModel`
 * rotates the hull about its object origin, so an origin that is not the centre
 * of mass makes the ship visibly pivot about a point in empty space. The
 * residual is reported in `physics.centreOfMass` and must satisfy
 * `|c| <= ORIGIN_TOLERANCE_KM`; the loaded (fuel + cargo) centre of mass is
 * reported separately and is expected to be non-zero.
 *
 * A "run" (the axis of a volume) advances **from the forward end to the aft
 * end** for axial parts, matching `HullShape` in `Ship.ts` where t = 0 is the
 * nose. So a hull's `Frame.forward` is usually ship +Z. Read `Frame.forward` as
 * "the direction this thing extends", never as "the direction the ship flies".
 */

import { hashSeed } from '@/math/rng';
import type { RGB, ScanResult, Vec3 } from '@/gen/types';

export type { RGB, Vec3 };

// ---------------------------------------------------------------------------
// Version and identity
// ---------------------------------------------------------------------------

/**
 * Bump whenever a change to any generator alters the bytes it produces for an
 * unchanged seed. Saved games pin the version they were generated under, so an
 * old ship keeps its old shape; the id carries the version for exactly that
 * reason.
 */
export const SHIP_GENERATION_VERSION = 1;

/**
 * Stable, human-diffable identity for a blueprint.
 *
 * Base-36 keeps a 32-bit seed to seven characters, which fits a HUD line, and
 * the version suffix means two blueprints from different engine versions can
 * coexist in one save without colliding. Matches the `a:b:c` id convention
 * already used by `gen/system.ts`.
 */
export function shipBlueprintId(seed: number, version: number): string {
  return `ship:${(seed >>> 0).toString(36).padStart(7, '0')}:v${version >>> 0}`;
}

/**
 * Named sub-seed streams.
 *
 * Every stage of generation, and every renderer that needs its own noise (the
 * greeble scatter, the wear field), derives from `shipSubSeed(bp.seed, stage)`.
 * Naming the stages here — rather than letting each module invent a salt — is
 * what stops two modules accidentally sharing a stream, which would make an
 * unrelated change to the hull move every rivet on the ship.
 */
export type ShipSeedStage =
  | 'family'
  | 'spine'
  | 'volumes'
  | 'propulsion'
  | 'sockets'
  | 'modules'
  | 'secondary'
  | 'accents'
  | 'greebles'
  | 'palette'
  | 'material'
  | 'history'
  | 'markings'
  | 'name';

/** Deterministic child seed for one generation stage. Never call Math.random(). */
export function shipSubSeed(seed: number, stage: ShipSeedStage): number {
  return hashSeed(seed >>> 0, `ship/${stage}`);
}

// ---------------------------------------------------------------------------
// Geometric primitives
// ---------------------------------------------------------------------------

/** 2D point/extent, kilometres unless stated. */
export type Vec2 = readonly [number, number];

/** Mutable scratch for the sampling helpers, so hot loops allocate nothing. */
export type MutVec2 = [number, number];
export type MutVec3 = [number, number, number];

/** Axis-aligned box in ship-local km. */
export interface Aabb {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Per-rotation-axis scalars. Field names mirror `ShipConfig.AxisTriple`. */
export interface AxisTriple {
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
}

/**
 * A placement: where something sits and which way it points.
 *
 * `forward` and `up` must be unit length and perpendicular; the third axis is
 * derived as `right = up × forward` (see `frameRight`). Storing two vectors
 * rather than a quaternion is deliberate — a reviewer reading raw JSON can see
 * that an engine points aft and a landing pad points down, which is not true of
 * four unlabelled numbers.
 *
 * Convention per consumer:
 *   volume   origin = start of the run,  forward = run direction
 *   socket   origin = centre of the mounting face, forward = OUTWARD normal
 *   engine   origin = nozzle throat,     forward = EXHAUST direction (aft-ish)
 *   thruster origin = nozzle,            forward = EXHAUST direction
 *   docking  origin = collar face,       forward = approach direction (outward)
 *   damage   origin = impact point,      forward = surface normal
 */
export interface Frame {
  readonly origin: Vec3;
  readonly forward: Vec3;
  readonly up: Vec3;
}

/** Largest tolerated distance between the ship origin and its dry CoM, km (1 m). */
export const ORIGIN_TOLERANCE_KM = 0.001;

/**
 * Human scale references. Every detail that tells the eye how big a ship is —
 * hatch, rung, handrail, deck, window — is a multiple of one of these, never a
 * hand-tuned constant. This is the difference between a 4 km capital that reads
 * as 4 km and one that reads as a 40 m model.
 */
export const HUMAN_HEIGHT_KM = 0.0018;
/** Deck-to-deck spacing including structure. Sets window rows and hull banding. */
export const DECK_HEIGHT_KM = 0.0026;
/** A standard personnel hatch. Sets airlock and handhold scale. */
export const HATCH_WIDTH_KM = 0.0009;
/** A standard freight container, long axis. Sets cargo bay and pod proportions. */
export const CONTAINER_LENGTH_KM = 0.0122;

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

export type VolumeId = string;
export type SpineNodeId = string;
export type SpineChainId = string;
export type ModuleId = string;
export type EngineId = string;
export type ThrusterId = string;
export type HardpointId = string;
export type DockingPortId = string;
export type DamageId = string;
export type RepairId = string;
/** Catalogue keys owned by `gen/ships/families.ts`. */
export type FactionId = string;
export type FamilyId = string;

/**
 * A socket id, branded with the socket's type.
 *
 * The brand is what makes an illegal placement unrepresentable: a
 * `CockpitModule` declares `socketId: SocketId<'cockpit'>`, so handing it the
 * id of an engine socket does not compile. The brand is erased at runtime — a
 * socket id is just a string in the JSON.
 */
export type SocketId<T extends SocketType = SocketType> = string & {
  readonly __socketType?: T;
};

/**
 * The one place a socket id is minted. The cast is unavoidable — TypeScript has
 * no way to attach a phantom type to a runtime string — and is confined here so
 * no other file needs one.
 */
export function makeSocketId<T extends SocketType>(raw: string): SocketId<T> {
  return raw as SocketId<T>;
}

/** Anything that can occupy a socket. All ids are strings; this is documentation. */
export type OccupantId = ModuleId | EngineId | ThrusterId | HardpointId | DockingPortId;

// ---------------------------------------------------------------------------
// Taxonomy — what the ship is for, who built it, how big it is
// ---------------------------------------------------------------------------

/**
 * Function decides form. The role is chosen first and every later stage reads
 * it; a role that is only a label on the same hull is a failure, not a
 * variation (BRIEF §4).
 */
export type ShipRole =
  | 'shuttle' //  short-hop personnel, tiny, all cabin
  | 'courier' //  fast, slender, minimal cargo
  | 'survey' //   sensors and antennae, the player's own class
  | 'freighter' // containers, spine-and-pod, huge volume
  | 'tanker' //   pressure vessels, no windows
  | 'miner' //    visible industrial machinery, cutting heads, ore bins
  | 'prospector' // small miner: one drill, one bin
  | 'refinery' // in-situ processing, stacks and flares
  | 'salvager' // cranes, grapples, cutting gear, mismatched plating
  | 'tug' //      almost all engine, a stubby cab, towing hardpoints
  | 'science' //  instrument booms, dishes, clean surfaces
  | 'liner' //    windows, decks, promenade — scale reads from the fenestration
  | 'colony' //   modular, one-way, agricultural drums
  | 'patrol' //   light weapons, sensors, endurance
  | 'gunship' //  weapons first, armour, hard angles
  | 'carrier' //  a flight deck is the silhouette
  | 'station-tender' // ugly, purposeful, no aerodynamic pretence
  | 'derelict'; //  hulk: no power, history only

/**
 * Size bands. These are not decoration: they select the module catalogue, the
 * LOD distances, the panel size and how much detail survives to LOD2.
 */
export type SizeClass = 'shuttle' | 'light' | 'medium' | 'heavy' | 'capital' | 'super-capital';

/**
 * Length bands in km. Overlapping by design — a heavy freighter and a light
 * capital can be the same length and differ in mass and construction.
 */
export const SIZE_CLASS_LENGTH_KM: Record<SizeClass, Vec2> = {
  shuttle: [0.008, 0.02],
  light: [0.02, 0.05],
  medium: [0.05, 0.14],
  heavy: [0.14, 0.4],
  capital: [0.4, 1.6],
  'super-capital': [1.6, 6.0],
};

/** Classify an overall length. Ties resolve to the smaller class. */
export function sizeClassFor(lengthKm: number): SizeClass {
  const order: readonly SizeClass[] = ['shuttle', 'light', 'medium', 'heavy', 'capital', 'super-capital'];
  for (const c of order) {
    if (lengthKm <= SIZE_CLASS_LENGTH_KM[c][1]) return c;
  }
  return 'super-capital';
}

/**
 * How this hull was built and how well it has been kept. This is the axis that
 * separates a shipyard-fresh corporate hull from a decade-old independent one
 * carrying the same family DNA, and it drives geometry (weld beads, cast
 * fillets, printed lattice) as much as material.
 */
export interface TechnologyProfile {
  /** Fabrication technique — the primary read at close range. */
  readonly fabrication:
    | 'riveted-plate' //  visible fastener rows, overlapping plates, oldest
    | 'welded-plate' //   bead seams, slight panel waviness
    | 'cast-monocoque' // continuous fillets, few seams, expensive
    | 'printed-lattice' // structural infill visible through cutouts
    | 'composite-wrap' // laid-up fibre, no fasteners, matte
    | 'salvage-weld'; //  three yards' worth of plate on one hull
  /** Main drive technology. Sets nozzle geometry, plume colour and radiator area. */
  readonly drive: 'chemical' | 'ion' | 'fusion-torch' | 'plasma' | 'reaction-plate';
  /** 0 = neglected wreck, 1 = maintained to survey standard. Drives wear weights. */
  readonly maintenance: number;
  /** How many refit generations are visible. >0 licenses mismatched modules. */
  readonly refits: number;
  /** Service age in years. Drives damage/repair counts and paint fade. */
  readonly ageYears: number;
  /** 0..1 — how much of the structure is left deliberately exposed. */
  readonly exposedStructure: number;
  /** True when the hull is pressurised, i.e. has windows, airlocks, seams. */
  readonly pressurised: boolean;
  /** True when the hull ever enters atmosphere: fairings, ablative edges, gear. */
  readonly atmosphereCapable: boolean;
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

export interface ShipDimensions {
  /** Overall, nose to exhaust plane, km. Everything else is derived from this. */
  readonly lengthKm: number;
  /** Overall width including booms, radiators and gear, km. */
  readonly beamKm: number;
  /** Overall height including masts and gear, km. */
  readonly heightKm: number;
  /** Tight box round every LOD0 part, ship-local km. */
  readonly bounds: Aabb;
  /** Radius of the bounding sphere about the origin, km. Culling and the HUD bracket. */
  readonly boundingRadius: number;
  /**
   * Enclosed pressurised volume, m³. Human-facing (scan readout, crew count)
   * and never used for physics — mass comes from `PhysicsProfile`.
   */
  readonly pressurisedVolumeM3: number;
  /**
   * Panel edge length, km. Derived from `lengthKm`, never a constant: a plate on
   * a 30 m courier and a plate on a 4 km capital cannot be the same size on
   * screen (BRIEF §7). The material profile repeats it because the shader wants
   * it; this is the authoritative value.
   */
  readonly panelSizeKm: number;
}

// ---------------------------------------------------------------------------
// Cross-sections — the type that decides whether the fleet looks different
// ---------------------------------------------------------------------------

/**
 * WHY THIS SHAPE, AND NOT A LIST OF PRIMITIVES.
 *
 * `Ship.ts` proved that one parameter family (a swept superellipse) spans boxy
 * freighter to rounded courier without changing code paths, and that a bare box
 * plus a bare cylinder gives a whole fleet exactly two silhouettes. So a volume
 * here is a *swept section*: a closed 2D curve, evaluated as a radius function
 * r(θ), swept along a path with per-station scale, offset and twist.
 *
 * The family is chosen per volume and its numeric parameters vary per station,
 * which is the key constraint: interpolating between two *parameter sets* of
 * one family is always well defined, whereas interpolating between a hexagon
 * and a teardrop is not. So a hull can morph round nose → boxy tail (Ship.ts
 * does exactly this by ramping the superellipse exponent) but can never morph
 * into an undefined shape.
 *
 * Three families, plus two universal modifiers, cover everything the brief
 * asks for:
 *
 *   superellipse  round ↔ box, the industrial default
 *   polygon       faceted: hexagonal tanks, triangular and square trusses,
 *                 and — with sides = 3 and a quarter-turn twist — the delta
 *                 wedge. Hard edges read completely differently from a
 *                 superellipse even at LOD2, which is the point.
 *   twin-lobe     two fused circles: catamaran and twin-boiler sections. A
 *                 silhouette no lathe can produce, and it degrades to a circle
 *                 at separation 0.
 *
 *   harmonics     periodic radial modulation, constant along the run. This is
 *                 what makes chines and flutes: Ship.ts keeps them constant
 *                 along the length *specifically* so they read as continuous
 *                 lines rather than lumps, and so do we.
 *   lobes         one localised bulge each: a ventral keel, a dorsal spine, a
 *                 side sponson, a blister. Any family plus a keel is still a
 *                 valid section, which multiplies the silhouette count far more
 *                 cheaply than adding families.
 *
 * A section is star-shaped about its centre by construction, so r(θ) is total
 * and the loft never self-intersects — the property that lets one evaluator
 * serve both the geometry builder and the mass-properties integrator.
 */
export type SectionFamily = 'superellipse' | 'polygon' | 'twin-lobe';

/**
 * Largest usable twin-lobe separation. Beyond 0.5 the two circles no longer
 * overlap and the section falls apart; 0.45 is the last value with a waist
 * thick enough to build.
 */
export const TWIN_LOBE_MAX_SEPARATION = 0.45;

/**
 * NORMALISATION, which every consumer depends on.
 *
 * All three families are normalised to fit inside the unit box: the bare
 * section never leaves [-1, 1] in x or y, so a station's `halfWidth` and
 * `halfHeight` really are half-extents and an AABB built from them is correct.
 * (A superellipse does reach 2^(1/2 - 1/n) radially at its diagonal — 1.30× at
 * n = 8 — so a bounding *sphere* from halfWidth is not.)
 *
 * The families do NOT all fill the box. A polygon has circumradius 1, so its
 * flats sit at cos(π/N): a triangular section is 0.5 deep below the centreline
 * and 1.0 above it. That asymmetry is the shape, not an error.
 *
 * `harmonics` and `lobes` are added on top and can push past 1 by their own
 * amplitude. `volumeBounds` samples rather than assuming, for exactly this
 * reason.
 */

/** Periodic radial modulation. `amplitude` lerps from t=0 to t=1 along the run. */
export interface SectionHarmonic {
  /** Lobes around the section. 3–7 reads as chines; >10 reads as fluting. */
  readonly frequency: number;
  /** Fractional radius modulation at the start and end of the run, e.g. 0.06. */
  readonly amplitude: Vec2;
  /** Radians. Sets where the chine sits — 0 = starboard, π/2 = dorsal. */
  readonly phase: number;
}

/** A single localised bulge — keel, dorsal spine, sponson, blister. */
export interface SectionLobe {
  /** Where it sits: 0 = starboard, π/2 = dorsal, -π/2 = ventral (a keel). */
  readonly angle: number;
  /** Angular half-width in radians. 0.25 is a fin, 0.8 is a fat blister. */
  readonly width: number;
  /** Added radius as a fraction of the section radius, at t=0 and t=1. */
  readonly depth: Vec2;
}

/**
 * The part of a section that is constant along a volume's run.
 *
 * `sides` lives here because a side count cannot be interpolated, and the
 * harmonics/lobes live here because varying them per station is what turns a
 * chine into a lump.
 */
export interface SectionShape {
  readonly family: SectionFamily;
  /** Polygon only. 3 = wedge, 4 = box, 6 = industrial tank, 8 = soft box. */
  readonly sides: number;
  readonly harmonics: readonly SectionHarmonic[];
  readonly lobes: readonly SectionLobe[];
}

/**
 * The interpolable scalars of a section. `VolumeStation` extends this, and the
 * sampler produces one of these for any t, so the evaluator can be handed
 * either a stored station or an interpolated sample.
 */
export interface SectionSampleLike {
  /** Position along the run, 0 = start (forward end), 1 = end. */
  readonly t: number;
  /** Superellipse exponent. 2 = ellipse, 4 = soft box, 8 ≈ box. */
  readonly exponent: number;
  /** Polygon corner chamfer, 0 = sharp corners, 1 = inscribed circle. */
  readonly chamfer: number;
  /**
   * Twin-lobe half-separation. 0 = one circle, `TWIN_LOBE_MAX_SEPARATION` =
   * two clearly separate lobes with a narrow waist. Values above the maximum
   * are clamped — see `sectionPoint`.
   */
  readonly lobeSeparation: number;
  /**
   * Ventral half scale, applied to y below the centreline only. 1 = symmetric,
   * 0.8 = a flat belly. Freighters land on their bellies; `Ship.ts` hard-codes
   * 0.82 for the same reason.
   */
  readonly ventralFlatten: number;
}

/**
 * One cross-section at a point along the run. The station list is the ship's
 * profile drawing: a geometry engineer lofts between consecutive stations, and
 * a physics integrator sums frusta between the same pairs.
 */
export interface VolumeStation extends SectionSampleLike {
  /** Half-width (x) at this station, km. */
  readonly halfWidth: number;
  /** Half-height (y) at this station, km. */
  readonly halfHeight: number;
  /** Lateral offset of the section centre from the run axis, km. The bend. */
  readonly offset: Vec2;
  /** Rotation of the section about the run axis, radians. */
  readonly twist: number;
  /**
   * Renderer hint: this station is a real structural frame, so it gets a ring
   * rib, a panel break and a hard normal crease rather than a smooth loft.
   */
  readonly isFrame: boolean;
  /**
   * Renderer hint: break the smooth normal here. Used where a nose fairing
   * meets a parallel mid-body — a soft join there reads as inflatable.
   */
  readonly hardEdge: boolean;
}

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------

/**
 * How the swept section is realised as surface. This is a discriminated union
 * so that a truss cannot accidentally carry a dome ratio, and so that the
 * geometry module can `switch` exhaustively.
 */
export type VolumeConstruction =
  | {
      /** Continuous plated skin. The default hull surface. */
      readonly kind: 'skin';
      /** Extra longitudinal panel breaks between stations. 0 = stations only. */
      readonly panelBreaks: number;
    }
  | {
      /** Skin with external ribs at frame stations — the freighter read. */
      readonly kind: 'ribbed';
      /** Rib height above the skin, km. */
      readonly ribDepth: number;
      /** Rib thickness along the run, km. */
      readonly ribWidth: number;
      /** Ribs per unit t, on top of `isFrame` stations. */
      readonly ribDensity: number;
    }
  | {
      /**
       * Open framework: longerons at section vertices, bracing between bays.
       * The load path made visible — a mining rig or a freighter spine.
       */
      readonly kind: 'truss';
      /** Longitudinal members. Usually the polygon side count. */
      readonly longerons: number;
      readonly brace: 'warren' | 'pratt' | 'x' | 'k' | 'zigzag';
      /** Member radius, km. Derived from carried load, not from taste. */
      readonly memberRadius: number;
      /** Bays along the run. Bay length should stay near-constant across sizes. */
      readonly bays: number;
    }
  | {
      /** Pressure vessel: domed ends, girth welds, no windows. */
      readonly kind: 'tank';
      /** Dome length as a fraction of the section radius. 1 = hemispherical. */
      readonly domeRatio: number;
      /** Girth bands (stiffener hoops) along the barrel. */
      readonly girthBands: number;
    }
  | {
      /** Thin swept slab: radiator, wing, fin, solar wing, flight deck floor. */
      readonly kind: 'panel';
      /** Slab thickness, km. */
      readonly thickness: number;
      /** Fold/segment count along the run, for deployable panels. */
      readonly segments: number;
      /** 0 = solid, 1 = mostly cut away (an open radiator grid). */
      readonly porosity: number;
    }
  | {
      /** A cowling or fairing: skin over something else, open at both ends. */
      readonly kind: 'shroud';
      /** Wall thickness so the open ends read as sheet, km. */
      readonly thickness: number;
    };

/** How a run terminates. */
export type CapStyle = 'open' | 'flat' | 'dome' | 'ogive' | 'taper' | 'blunt';

/**
 * The path the section is swept along, in the volume's own frame.
 *
 * `linear` covers everything with a straight load path — which is most of a
 * ship — and per-station `offset` bends it as much as a hull ever bends.
 * `arc` exists because a ring habitat and a curved dorsal spine need the frame
 * itself to turn, which an offset cannot express. A closed ring is
 * `sweep = 2π`.
 */
export type VolumePath =
  | { readonly kind: 'linear'; readonly length: number }
  | {
      readonly kind: 'arc';
      /** Turn radius, km. Positive curves to starboard of the run direction. */
      readonly radius: number;
      /** Swept angle, radians. 2π closes the ring. */
      readonly sweep: number;
    };

/**
 * What this mass *is*. Purely semantic — it drives module compatibility, wear
 * weighting, the scan readout and which greeble family a surface attracts. The
 * geometry comes entirely from `construction`, `shape` and `stations`.
 */
export type VolumeKind =
  | 'hull' //         the primary pressurised body
  | 'forebody' //     nose section: cockpit, sensors
  | 'midbody'
  | 'afterbody' //    engineering: reactor, drive
  | 'cargo-bay' //    enclosed freight volume
  | 'cargo-rack' //   open frame carrying containers
  | 'tank' //         propellant or process fluid
  | 'reactor' //      power plant housing
  | 'nacelle' //      engine pod
  | 'boom' //         a structural arm holding something away from the hull
  | 'pylon' //        a short structural stub
  | 'ring' //         closed hoop: spin habitat, jump ring, magnetic loop
  | 'pod' //          a detachable or bolted-on sub-hull
  | 'radiator' //     heat rejection panel
  | 'wing' //         atmospheric surface or a mounting plane
  | 'fin' //          stabiliser, mostly silhouette
  | 'bridge' //       command volume, windows
  | 'habitat' //      crew volume, windows, decks
  | 'machinery' //    exposed industrial plant: drills, cranes, mills
  | 'shroud' //       fairing over something else
  | 'keel'; //        the exposed structural backbone as a drawn volume

/**
 * One of the two or three masses that make the silhouette (BRIEF §4 stage 3),
 * or one of the secondary shapes hung off them (stage 6).
 *
 * A volume is *self-contained*: everything needed to build it is here, in ship
 * coordinates. `anchor` records where it came from so damage and the physics
 * reviewer can reason about the load path, but the renderer never needs it.
 */
export interface PrimaryVolume {
  readonly id: VolumeId;
  readonly kind: VolumeKind;
  /** Placement in ship-local space. `forward` is the run direction. */
  readonly frame: Frame;
  readonly path: VolumePath;
  readonly shape: SectionShape;
  readonly construction: VolumeConstruction;
  /**
   * Ordered by `t`, first at 0, last at 1, at least two entries. For a closed
   * arc the last station must equal the first or the ring will show a seam.
   */
  readonly stations: readonly VolumeStation[];
  readonly capStart: CapStyle;
  readonly capEnd: CapStyle;
  /** Provenance: the spine node or parent volume this hangs off. Null = free. */
  readonly anchor: VolumeAnchor | null;
  /**
   * If set, this volume is the mirror image in X of another. The renderer may
   * build the geometry once and instance it with a negative-X scale; the
   * blueprint still lists both so it stays printable and diffable.
   */
  readonly mirrorOf: VolumeId | null;
  /** Material sharing key. Volumes with equal keys must share one material. */
  readonly materialKey: string;
  /** 0..1 — how much greeble the surface attracts. Machinery high, tanks low. */
  readonly detailDensity: number;
  /**
   * 0..1 — how much of the ship's structural load runs through this volume.
   * Drives member thickness, rib count and how catastrophic damage here reads.
   */
  readonly loadShare: number;
  /** Deterministic seed for per-volume detail. Derived, never invented. */
  readonly seed: number;
  /** Renderer hint: this volume is hollow and the interior is visible. */
  readonly interiorVisible: boolean;
}

/** Where a volume is bolted. Provenance only — placement is already resolved. */
export type VolumeAnchor =
  | { readonly kind: 'spine'; readonly nodeId: SpineNodeId }
  | { readonly kind: 'volume'; readonly volumeId: VolumeId; readonly t: number }
  | { readonly kind: 'socket'; readonly socketId: SocketId };

// ---------------------------------------------------------------------------
// The spine — the load path
// ---------------------------------------------------------------------------

/**
 * What the spine looks like where it is visible. A mining rig wears its truss
 * on the outside; a courier buries a keel beam inside a monocoque and you only
 * ever see the frames through an open hatch.
 */
export type SpineExposure = 'buried' | 'partial' | 'exposed';

export type SpineMemberStyle =
  | 'box-truss' //   four longerons, cross-braced. The freighter/mining default.
  | 'tri-truss' //   three longerons. Lighter, reads as cheaper.
  | 'tube' //        a single large-diameter cylinder
  | 'keel-beam' //   an I-section running the belly
  | 'a-frame' //     two converging members, for forks and tugs
  | 'monocoque'; //  no discrete spine; the skin carries the load

export type SpineNodeKind =
  | 'nose-cap'
  | 'bulkhead' //     pressure boundary. Modules mount, nothing passes.
  | 'ring-frame' //   a hoop frame. The usual attachment point.
  | 'node-joint' //   a truss node where members meet. Booms fork here.
  | 'thrust-frame' // where engine loads enter the structure. Heaviest node.
  | 'tail-cap';

export interface SpineNode {
  readonly id: SpineNodeId;
  /** Normalised arclength along its chain, 0 = forward end, 1 = aft end. */
  readonly s: number;
  /** Resolved ship-local position, km. */
  readonly position: Vec3;
  /** Roll reference so sockets placed here share a consistent "up". Unit. */
  readonly up: Vec3;
  /** Structural radius here, km — how fat the load path is at this station. */
  readonly radius: number;
  readonly kind: SpineNodeKind;
  /**
   * Axial load carried through this node, newtons. Comes from the engines aft
   * of it accelerating the mass forward of it, so it peaks at the thrust frame
   * and falls to zero at the nose. Member radius is sized from this — that is
   * what makes the structure look engineered rather than drawn.
   */
  readonly loadN: number;
}

/**
 * One run of the spine. Chain 0 is the main keel; further chains are forks —
 * the twin booms of a catamaran, the outriggers of a mining rig, the pylons of
 * a carrier — each leaving the parent at a named node.
 */
export interface SpineChain {
  readonly id: SpineChainId;
  /** Null for the main chain. Otherwise the node this chain branches from. */
  readonly parentNodeId: SpineNodeId | null;
  /** Ordered forward → aft, at least two nodes. */
  readonly nodes: readonly SpineNode[];
  readonly member: SpineMemberStyle;
  readonly exposure: SpineExposure;
  /** Section used when the chain is drawn as visible structure. */
  readonly shape: SectionShape;
  readonly materialKey: string;
}

export interface StructuralSpine {
  /** Chain 0 is always the main keel and always has `parentNodeId === null`. */
  readonly chains: readonly SpineChain[];
  /**
   * Total length of the main chain, km. Usually close to, but not the same as,
   * the overall ship length: a nose fairing and an engine bell overhang it.
   */
  readonly mainLengthKm: number;
}

// ---------------------------------------------------------------------------
// Sockets
// ---------------------------------------------------------------------------

/** The socket taxonomy from BRIEF §5, unchanged. */
export type SocketType =
  | 'engine'
  | 'rcs'
  | 'cockpit'
  | 'bridge'
  | 'sensor'
  | 'docking'
  | 'airlock'
  | 'cargo'
  | 'habitat'
  | 'reactor'
  | 'radiator'
  | 'weapon'
  | 'mining'
  | 'salvage'
  | 'landing'
  | 'service'
  | 'navlight'
  | 'emblem';

/** The envelope a socket can carry. A module larger than this must not fit. */
export interface SocketBudget {
  /** Max radius of the mounted part measured from the socket axis, km. */
  readonly radius: number;
  /** Max extent along the outward normal, km. */
  readonly depth: number;
  /** Max mass the mount is rated for, kg. */
  readonly massKg: number;
}

/**
 * A typed mounting point.
 *
 * `clearance` and `clearAngle` are the fields that make BRIEF §5 checkable
 * without ray-casting at generation time: the generator measures free space
 * once, writes it here, and every later stage (and the physics reviewer) reads
 * it. An engine socket with `clearAngle` smaller than its plume half-angle is a
 * hull-melting bug that is now visible in the JSON.
 */
export interface Socket<T extends SocketType = SocketType> {
  readonly id: SocketId<T>;
  readonly type: T;
  /** origin = centre of the mounting face; forward = OUTWARD normal. */
  readonly frame: Frame;
  readonly budget: SocketBudget;
  /** What this socket is bolted to — for load path and for damage stubs. */
  readonly host: SocketHost;
  /**
   * Free distance along the outward normal before anything else is in the way,
   * km. `Infinity` is not allowed: write the largest measured value.
   */
  readonly clearance: number;
  /**
   * Half-angle of the unobstructed cone about the outward normal, radians. The
   * field of fire for a weapon, the view cone for a cockpit, the exhaust cone
   * for an engine, the approach cone for a docking port.
   */
  readonly clearAngle: number;
  /** Module kinds this socket will accept. Empty = accepts none (blanked off). */
  readonly accepts: readonly ModuleKind[];
  /** Occupant id, or null when the socket is bare (and may carry a blanking plate). */
  readonly occupiedBy: OccupantId | null;
  /** The socket this is the X-mirror of, for symmetric pairs. */
  readonly mirrorOf: SocketId | null;
}

export type SocketHost =
  | { readonly kind: 'volume'; readonly volumeId: VolumeId }
  | { readonly kind: 'spine'; readonly nodeId: SpineNodeId };

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

/**
 * Concrete hardware kinds. Finer-grained than `SocketType`: one `weapon` socket
 * can take a turret, a missile rack or a mining laser, and the socket's
 * `accepts` list decides which.
 */
export type ModuleKind =
  | 'cockpit'
  | 'bridge-tower'
  | 'sensor-dish'
  | 'sensor-array'
  | 'antenna-mast'
  | 'airlock'
  | 'docking-collar'
  | 'cargo-container'
  | 'cargo-pod'
  | 'ore-bin'
  | 'habitat-can'
  | 'reactor-can'
  | 'radiator-panel'
  | 'radiator-drum'
  | 'fuel-drum'
  | 'turret'
  | 'missile-rack'
  | 'point-defence'
  | 'mining-head'
  | 'mining-boom'
  | 'ore-processor'
  | 'grapple-arm'
  | 'cutting-rig'
  | 'crane'
  | 'winch'
  | 'landing-leg'
  | 'landing-skid'
  | 'service-hatch'
  | 'toolbox'
  | 'ladder'
  | 'handrail'
  | 'navlight'
  | 'beacon'
  | 'emblem-plate'
  | 'registry-plate'
  | 'blanking-plate'; //  what is left when a module is removed cleanly

/**
 * The socket type each module kind mounts on. Data, not policy — the generator
 * uses it to filter candidates, and `moduleFitsSocket` uses it to check.
 */
export const MODULE_SOCKET: Record<ModuleKind, SocketType> = {
  cockpit: 'cockpit',
  'bridge-tower': 'bridge',
  'sensor-dish': 'sensor',
  'sensor-array': 'sensor',
  'antenna-mast': 'sensor',
  airlock: 'airlock',
  'docking-collar': 'docking',
  'cargo-container': 'cargo',
  'cargo-pod': 'cargo',
  'ore-bin': 'cargo',
  'habitat-can': 'habitat',
  'reactor-can': 'reactor',
  'radiator-panel': 'radiator',
  'radiator-drum': 'radiator',
  'fuel-drum': 'service',
  turret: 'weapon',
  'missile-rack': 'weapon',
  'point-defence': 'weapon',
  'mining-head': 'mining',
  'mining-boom': 'mining',
  'ore-processor': 'mining',
  'grapple-arm': 'salvage',
  'cutting-rig': 'salvage',
  crane: 'salvage',
  winch: 'salvage',
  'landing-leg': 'landing',
  'landing-skid': 'landing',
  'service-hatch': 'service',
  toolbox: 'service',
  ladder: 'service',
  handrail: 'service',
  navlight: 'navlight',
  beacon: 'navlight',
  'emblem-plate': 'emblem',
  'registry-plate': 'emblem',
  'blanking-plate': 'service',
};

/**
 * A piece of mounted hardware.
 *
 * The type parameter ties the module to its socket type, so `socketId` cannot
 * be the id of a socket of the wrong type. `present: false` is a module that
 * was torn off: the renderer draws the mounting stubs described by the damage
 * event instead of the module, which is how "a torn-off module leaves its
 * mounting stubs" (BRIEF §7) becomes geometry rather than a decal.
 */
export interface ShipModule<T extends SocketType = SocketType> {
  readonly id: ModuleId;
  readonly kind: ModuleKind;
  readonly type: T;
  readonly socketId: SocketId<T>;
  /** Resolved placement. origin = the module's own origin on the mount face. */
  readonly frame: Frame;
  /** Half-extents of the module's own box, km, in its local axes. */
  readonly halfExtents: Vec3;
  readonly massKg: number;
  /**
   * Set when the module is itself a swept volume (a cargo pod, a habitat can,
   * a radiator wing) rather than a small greeble assembly. The volume carries
   * the geometry; this record carries the gameplay and physics meaning.
   */
  readonly volumeId: VolumeId | null;
  /** False = torn off. The socket stays, the stubs stay, the module is gone. */
  readonly present: boolean;
  /** 0 = destroyed but still attached, 1 = as new. Drives damage decals and HUD. */
  readonly integrity: number;
  /**
   * True when this module came from a different yard than the hull: it gets a
   * palette from `palette.mismatch`, a different panel size and its own wear
   * age. This is the cheapest possible read on "this ship has a history".
   */
  readonly mismatched: boolean;
  readonly materialKey: string;
  readonly mirrorOf: ModuleId | null;
  readonly seed: number;
  /**
   * Modules the crew reaches on foot — the renderer must connect them with
   * handrails and place a ladder. Purely a hint; ignore it and the ship still
   * builds, but it will not look inhabited.
   */
  readonly crewAccessible: boolean;
}

// ---------------------------------------------------------------------------
// Connections — the things that make a ship read as assembled, not modelled
// ---------------------------------------------------------------------------

/**
 * A run of hardware between two points: a pipe, a cable loom, a strut, a
 * transfer tunnel, a conveyor. These are what stop a spine-and-pod freighter
 * looking like parts floating near each other, and they are generated from the
 * function graph (reactor → engines, tank → engines, hab → hab), never for
 * decoration.
 */
export type ConnectionKind =
  | 'strut' //     structural, carries load
  | 'pipe' //      fluid, has bends and flanges
  | 'conduit' //   armoured cable run
  | 'cable' //     a catenary; sags, so it needs a droop
  | 'tunnel' //    pressurised, crew passes through
  | 'conveyor' //  ore or cargo transfer
  | 'umbilical' //  detachable service line
  | 'ladder-run';

export interface Connection {
  readonly id: string;
  readonly kind: ConnectionKind;
  /** Resolved ship-local polyline, at least two points. */
  readonly path: readonly Vec3[];
  /** Radius of the run, km. A bundle of cables is one fat conduit. */
  readonly radius: number;
  /**
   * Sag as a fraction of the span, for `cable`. 0 for anything rigid. A cable
   * with zero sag reads as a rod and destroys the sense of gravity-free slack.
   */
  readonly sag: number;
  /** Repeats along the run: flanges, clamps, insulation breaks per km. */
  readonly fittingDensity: number;
  readonly fromId: string;
  readonly toId: string;
  readonly materialKey: string;
  readonly seed: number;
}

// ---------------------------------------------------------------------------
// Propulsion
// ---------------------------------------------------------------------------

export type NozzleStyle =
  | 'bell' //         classic expansion bell
  | 'aerospike' //    a spike with an annular throat
  | 'annular' //      a ring of exhaust round a plug
  | 'grid' //         ion grid: flat, glowing, no bell
  | 'open-cycle' //   exposed turbomachinery round the throat
  | 'plate'; //       reaction plate: a flat disc, no nozzle at all

/**
 * A main drive.
 *
 * `frame.forward` is the EXHAUST direction. The force on the ship is the
 * negative of it, and `thrustAxis` states that explicitly so nobody has to
 * remember which way round it is at 2 a.m.
 */
export interface EnginePod {
  readonly id: EngineId;
  readonly socketId: SocketId<'engine'>;
  /** origin = nozzle throat; forward = exhaust direction (aft-ish). */
  readonly frame: Frame;
  /** Unit vector of the FORCE applied to the ship. Equals -frame.forward. */
  readonly thrustAxis: Vec3;
  /** Vacuum thrust of this pod alone, newtons. */
  readonly thrustN: number;
  readonly nozzle: {
    readonly style: NozzleStyle;
    /** Exit radius, km. Sets the plume width and the glow disc. */
    readonly exitRadius: number;
    /** Throat radius, km. */
    readonly throatRadius: number;
    /** Bell length, km. */
    readonly length: number;
    /** Number of nozzles in this pod. A cluster of four reads as heavy. */
    readonly count: number;
    /** Cluster radius when count > 1, km. */
    readonly clusterRadius: number;
    /** Max gimbal deflection, radians. 0 = fixed. */
    readonly gimbalLimit: number;
  };
  readonly plume: {
    /** Core colour at full throttle, linear RGB. Cool by art direction. */
    readonly coreColor: RGB;
    /** Outer colour, linear RGB. */
    readonly edgeColor: RGB;
    /** Plume length at full throttle as a multiple of `exitRadius`. */
    readonly lengthRatio: number;
    /** Shock diamond count. 0 for ion and plate drives. */
    readonly diamonds: number;
    /** 0..1 — instability. High for salvaged drives, near 0 for corporate. */
    readonly flicker: number;
  };
  /** Seconds for this drive to spool. Big drives are slow; feeds ShipConfig. */
  readonly spoolTime: number;
  /** Heat rejected at full throttle, watts. Sizes the radiators. */
  readonly heatW: number;
  readonly mirrorOf: EngineId | null;
  readonly materialKey: string;
  readonly seed: number;
}

/**
 * The RCS group a thruster belongs to. A thruster usually serves several: one
 * physical nozzle produces both a translation and a couple. The generator lists
 * every group the thruster contributes to, and `Ship.ts` fires the thruster
 * whose exhaust opposes the commanded vector — same rule here.
 */
export type RcsGroup =
  | 'pitch+'
  | 'pitch-'
  | 'yaw+'
  | 'yaw-'
  | 'roll+'
  | 'roll-'
  | 'x+'
  | 'x-'
  | 'y+'
  | 'y-'
  | 'z+'
  | 'z-';

export interface RcsThruster {
  readonly id: ThrusterId;
  readonly socketId: SocketId<'rcs'>;
  /** origin = nozzle mouth; forward = exhaust direction. */
  readonly frame: Frame;
  /** Thrust of this nozzle, newtons. */
  readonly thrustN: number;
  /** Nozzle mouth radius, km. Sets the puff sprite size. */
  readonly radius: number;
  /** Every control group this nozzle contributes to. */
  readonly groups: readonly RcsGroup[];
  /** Grouping key: nozzles in one quad fire together and share one draw. */
  readonly clusterKey: string;
  readonly mirrorOf: ThrusterId | null;
}

// ---------------------------------------------------------------------------
// Hardpoints, docking, landing
// ---------------------------------------------------------------------------

export type HardpointKind = 'turret' | 'fixed-gun' | 'missile-rack' | 'point-defence' | 'mining-laser' | 'cutter' | 'tractor' | 'grapple' | 'scanner';

export interface Hardpoint {
  readonly id: HardpointId;
  readonly kind: HardpointKind;
  readonly socketId: SocketId<'weapon' | 'mining' | 'salvage' | 'sensor'>;
  /** origin = the trunnion; forward = the boresight at rest. */
  readonly frame: Frame;
  /** Fixed mounts cannot traverse; their arc is the socket's clear cone. */
  readonly mount: 'fixed' | 'turret' | 'barbette';
  /** Traverse limits about the mount's up axis, radians, [min, max]. */
  readonly traverse: Vec2;
  /** Elevation limits, radians, [min, max]. */
  readonly elevation: Vec2;
  /**
   * Half-angle of genuinely unobstructed fire, radians, after the hull is taken
   * into account. This is the number BRIEF §5 is checked against, not the
   * mechanical limits above.
   */
  readonly clearArc: number;
  /** 0..1 threat weight this contributes to the scan profile. */
  readonly threatWeight: number;
  readonly moduleId: ModuleId | null;
  readonly mirrorOf: HardpointId | null;
}

export type DockingKind = 'clamp' | 'collar' | 'magnetic' | 'gantry' | 'cargo-arm' | 'umbilical';

export interface DockingPort {
  readonly id: DockingPortId;
  readonly socketId: SocketId<'docking'>;
  readonly kind: DockingKind;
  /** origin = collar face; forward = approach direction (outward from the hull). */
  readonly frame: Frame;
  /** Collar diameter, km. Must exceed the diameter of anything that docks. */
  readonly diameter: number;
  /** Half-angle of the clear approach corridor, radians. */
  readonly approachCone: number;
  /** Corridor length that must stay clear, km. */
  readonly approachClearance: number;
  /** True when crew can pass through it — implies pressurisation on both sides. */
  readonly pressurised: boolean;
  /** Guidance lights round the collar. The HUD homes on these. */
  readonly guideLightCount: number;
}

export interface LandingLeg {
  readonly id: string;
  readonly socketId: SocketId<'landing'>;
  /** origin = the hip joint; forward = the direction the leg extends. */
  readonly frame: Frame;
  readonly style: 'strut' | 'a-frame' | 'skid' | 'wheeled' | 'pad';
  /** Length from hip to footpad when deployed, km. */
  readonly length: number;
  /** Footpad radius, km. */
  readonly padRadius: number;
  /** Suspension travel, km. The renderer compresses this on touchdown. */
  readonly travel: number;
  /** Foot contact point when fully deployed and uncompressed, ship-local km. */
  readonly contactPoint: Vec3;
  readonly mirrorOf: string | null;
}

export interface LandingSystem {
  readonly legs: readonly LandingLeg[];
  /** True when the gear retracts into bays; false when it is always out. */
  readonly retracts: boolean;
  /**
   * Convex hull of the contact points projected onto the ship's XZ plane, km.
   * The flight model does not use it; the landing checker and the shadow do.
   * A footprint that does not contain the CoM projection is a ship that tips.
   */
  readonly footprint: readonly Vec2[];
  /**
   * Distance from the ship origin to the ground when parked, km. Drives the
   * parked pose and proves that BRIEF §5's "clearance below every other part"
   * holds: it must exceed the lowest point of every non-gear part.
   */
  readonly staticHeight: number;
  /** Lowest ship-local y of anything that is not landing gear, km. */
  readonly lowestFixedPoint: number;
}

// ---------------------------------------------------------------------------
// History — damage and repair that move geometry
// ---------------------------------------------------------------------------

/**
 * What part of the ship an event applies to. This is the field that makes
 * history structural rather than cosmetic: the renderer resolves the reference
 * and modifies *that* geometry.
 */
export type GeometryRef =
  | {
      readonly kind: 'volume';
      readonly volumeId: VolumeId;
      /** Affected run span, [t0, t1]. */
      readonly span: Vec2;
      /** Affected angular span about the section, [θ0, θ1] radians. */
      readonly arc: Vec2;
    }
  | { readonly kind: 'module'; readonly moduleId: ModuleId }
  | { readonly kind: 'socket'; readonly socketId: SocketId }
  | { readonly kind: 'spine'; readonly nodeId: SpineNodeId }
  | { readonly kind: 'engine'; readonly engineId: EngineId }
  | { readonly kind: 'connection'; readonly connectionId: string };

/**
 * Damage kinds, each with a defined geometric consequence. A kind that only
 * tints a material is a failure of this contract (BRIEF §7): every entry below
 * changes the mesh.
 */
export type DamageKind =
  | 'panel-loss' //      plate gone: recessed area, ragged rim, substructure visible
  | 'puncture' //        hole through the skin with an everted lip
  | 'burn-through' //    hole plus a melted, drooping rim
  | 'buckle' //          section dented inward: local scale/offset modulation
  | 'strut-bent' //      a member displaced; see `displacement`
  | 'strut-severed' //   a member missing between two nodes, ends left ragged
  | 'module-torn-off' // module absent, mounting stubs and sheared bolts remain
  | 'nozzle-cracked' //  a segment of the bell missing, plume asymmetric
  | 'antenna-snapped' // a mast shortened, the stub bent
  | 'ablation' //        leading edge eroded: the section is inset along an arc
  | 'scoring' //         the one material-only kind: a graze that removed paint
  | 'debris-embedded'; // something is stuck in the hull and still there

export type DamageCause =
  | 'micrometeorite'
  | 'weapons'
  | 'collision'
  | 'thermal'
  | 'decompression'
  | 'fatigue'
  | 'salvage-cut' //  someone removed this deliberately
  | 'unknown';

/** A rigid displacement, for bent struts and knocked-out modules. */
export interface Displacement {
  /** Translation, km. */
  readonly offset: Vec3;
  /** Rotation axis, unit. */
  readonly axis: Vec3;
  /** Rotation angle, radians. A 3° bend on a 20 m strut is very legible. */
  readonly angle: number;
  /** Pivot for the rotation, ship-local km. */
  readonly pivot: Vec3;
}

export interface DamageEvent {
  readonly id: DamageId;
  readonly kind: DamageKind;
  readonly cause: DamageCause;
  readonly target: GeometryRef;
  /** origin = the centre of the wound; forward = the outward surface normal. */
  readonly frame: Frame;
  /** Radius of the affected area on the surface, km. */
  readonly radius: number;
  /** Depth into the hull, km. Greater than the skin thickness = a hole. */
  readonly depth: number;
  /**
   * Unit vector the damage arrived along. Everything directional keys off this:
   * spall on the far side, soot streaked downstream, the lip everted away from
   * it. Uniform radial damage is the tell of a procedural system.
   */
  readonly incidence: Vec3;
  /** 0..1. Above ~0.6 the structure underneath is affected, not just the skin. */
  readonly severity: number;
  /**
   * Seconds since it happened. Fresh damage is bright metal and sharp edges;
   * old damage is oxidised, dirt-filled and soft-edged. This is the single
   * field that turns a scatter of holes into a timeline.
   */
  readonly ageSeconds: number;
  /** Set when the geometry moved rather than eroded. */
  readonly displacement: Displacement | null;
  /** The repair that addressed this, if any. */
  readonly repairedBy: RepairId | null;
  /** Deterministic seed for the wound's own detail (rim jitter, spall pattern). */
  readonly seed: number;
}

/**
 * Repair kinds. Same rule as damage: each one is geometry.
 *
 * `patch-plate` is the workhorse — a plate sitting *proud* of the hull in the
 * wrong shade with its own fastener ring, which is what BRIEF §7 means by "a
 * replaced panel sits slightly proud and in the wrong shade".
 */
export type RepairKind =
  | 'patch-plate' //     an extra plate over a hole, offset along the normal
  | 'panel-replaced' //  the plate is flush but a different shade and age
  | 'weld-seam' //       a raised bead across a crack
  | 'strut-splint' //    a doubler plate and clamps round a bent member
  | 'field-brace' //     a whole extra member added, at the wrong angle
  | 'module-replaced' // a newer, mismatched module in an old mount
  | 'sealant-foam' //    a lumpy blob; the cheapest, ugliest fix
  | 'plated-over' //     the damage was simply covered and forgotten
  | 'stub-capped'; //    a torn-off module's stubs cut flush and capped

export interface RepairEvent {
  readonly id: RepairId;
  readonly kind: RepairKind;
  /** The damage this addresses, or null for preventative/refit work. */
  readonly repairs: DamageId | null;
  readonly target: GeometryRef;
  /** origin = centre of the repair; forward = outward surface normal. */
  readonly frame: Frame;
  /** Plate/patch half-extents on the surface, km. */
  readonly halfExtents: Vec2;
  /** How far the repair stands proud of the surface, km. Never exactly zero. */
  readonly proud: number;
  /**
   * 0 = a field weld by someone in a suit with the wrong tools, 1 = a yard job.
   * Drives edge alignment jitter, fastener spacing regularity and whether the
   * patch is even rectangular.
   */
  readonly quality: number;
  /** Index into `palette.patchShades`. This is the "wrong shade". */
  readonly shadeIndex: number;
  /** Fasteners round the rim. 0 = welded. */
  readonly fastenerCount: number;
  /** Seconds since the repair. A fresh patch is cleaner than the hull round it. */
  readonly ageSeconds: number;
  /** Set when the repair moved geometry: a splint straightening a bent strut. */
  readonly displacement: Displacement | null;
  readonly seed: number;
}

// ---------------------------------------------------------------------------
// Palette and materials
// ---------------------------------------------------------------------------

/**
 * All colour on the ship, linear RGB. Rationed per ARCHITECTURE §6: the base is
 * near-black desaturated steel, and there is exactly one accent hue plus the
 * amber of the instruments and the cool of the drive.
 */
export interface ShipPalette {
  /** Base hull, lit side. Should sit below ~0.2 luminance — everything is dark. */
  readonly hull: RGB;
  /** Base hull, shaded side. Near black; there is no ambient fill in space. */
  readonly hullShadow: RGB;
  /**
   * Panel-to-panel shade drift. 3–5 entries, all within a few percent of
   * `hull`; the shader picks per panel id. This is what stops a large flat hull
   * reading as one painted surface.
   */
  readonly plateShades: readonly RGB[];
  /** Shades available to patches and replaced panels. Deliberately wrong. */
  readonly patchShades: readonly RGB[];
  /** Colours for modules from another yard. */
  readonly mismatch: readonly RGB[];
  /** The one saturated accent: faction stripe, hazard chevrons, tail flash. */
  readonly accent: RGB;
  /** Secondary trim: handrails, hatch surrounds, walkways. Usually desaturated. */
  readonly trim: RGB;
  /** Lit interiors spilling through windows. Amber by art direction. */
  readonly interiorLight: RGB;
  /** Engine core and outer glow. Cool by art direction — the only cold light. */
  readonly engineCore: RGB;
  readonly engineGlow: RGB;
  /** Navigation lights: port, starboard, strobe, beacon. */
  readonly navPort: RGB;
  readonly navStarboard: RGB;
  readonly navStrobe: RGB;
  readonly beacon: RGB;
  /** Exposed layers revealed by damage: primer under paint, bare metal, oxide. */
  readonly primer: RGB;
  readonly bareMetal: RGB;
  readonly oxide: RGB;
  /** Soot aft of thrusters and round burn-throughs. */
  readonly scorch: RGB;
}

export type MarkingKind =
  | 'registry' //    the hull number
  | 'name' //        the ship's name
  | 'emblem' //      faction mark
  | 'hazard' //      chevrons round exhaust and moving parts
  | 'stencil' //     "NO STEP", "FUEL", access instructions
  | 'numeral' //     bay and hatch numbers
  | 'stripe'; //     a painted band, the cheapest faction read

export interface Marking {
  readonly id: string;
  readonly kind: MarkingKind;
  /** Text where the kind carries text. Comes from `gen/names.ts`, never ad hoc. */
  readonly text: string;
  /** origin = centre of the marking; forward = outward surface normal. */
  readonly frame: Frame;
  /** Half-extents on the surface, km. Cap height should be ≥ HATCH_WIDTH_KM/2. */
  readonly halfExtents: Vec2;
  readonly color: RGB;
  /**
   * 0..1 — how worn the paint is. Markings near hatches and thrusters wear
   * first; a uniformly worn set of markings is the same failure as uniform
   * noise on a hull.
   */
  readonly wear: number;
  /** Which volume it is painted on, so the renderer can project it correctly. */
  readonly volumeId: VolumeId;
}

/**
 * Directional wear weights, 0..1 each. Detail follows function and orientation
 * (BRIEF §7); uniform noise laid evenly over everything will be rejected. Every
 * one of these is a *separate* mask in the shader, not a single grime slider.
 */
export interface WearWeights {
  /** Paint worn off convex edges and corners. */
  readonly edges: number;
  /** Scuffing round hatches, handholds and anything crew touch. */
  readonly hatches: number;
  /** Streaks along `flowDirection` — the airflow and vent story. */
  readonly streaks: number;
  /** Soot aft of thrusters and engines. Keyed to the actual nozzle positions. */
  readonly soot: number;
  /** Heat staining near radiators and drive plumes. */
  readonly heat: number;
  /** Micrometeorite pitting, concentrated on forward-facing surfaces. */
  readonly pitting: number;
  /** Oxide bloom round fasteners and weld seams. */
  readonly corrosion: number;
  /** Ice and frost near cryogenic tanks and vents. */
  readonly frost: number;
}

/**
 * One shareable surface. Ships in a family with equal `key` must be given the
 * same material instance — the budget is ≤ 3 materials per ship, shared across
 * ships of a family (BRIEF §6).
 */
export interface MaterialProfile {
  /** Sharing key. Equal keys ⇒ identical material ⇒ one GPU program. */
  readonly key: string;
  /** 0..1 base roughness of clean plate. Everything is dirty, so this is high. */
  readonly roughness: number;
  /** 0..1. Painted hull is 0; bare structural metal is 1. */
  readonly metalness: number;
  /** Panel edge length, km. Copied from `ShipDimensions.panelSizeKm`. */
  readonly panelSizeKm: number;
  /** 0..1 — how irregular panel sizes are. Real plating varies in size. */
  readonly panelJitter: number;
  /** Seam recess depth, km. Read as a groove, not a line. */
  readonly seamDepth: number;
  /** Rivet/fastener spacing along a seam, km. 0 = welded, no fasteners. */
  readonly fastenerPitch: number;
  readonly wear: WearWeights;
  /**
   * Unit vector along which grime streaks. Usually the ship's own airflow
   * direction (+Z, aft) but a radiator streaks along its own vent flow.
   */
  readonly flowDirection: Vec3;
  /** Micro-detail frequency multiplier, so a capital does not look smooth. */
  readonly microDetailScale: number;
  /** 0..1 how much the paint has faded from UV and thermal cycling. */
  readonly paintFade: number;
}

// ---------------------------------------------------------------------------
// Physics contract — consumed by FlightModel and the collision system
// ---------------------------------------------------------------------------

/**
 * The subset of `ShipConfig` (`src/ship/FlightModel.ts`) that depends on the
 * hull. Field names and units are an exact mirror so that
 * `new FlightModel(bp.physics.flight)` type-checks structurally with no
 * adaptor. If `ShipConfig` ever gains a hull-dependent field, add it here too;
 * `gen/ships/physics.ts` should assert assignability so the drift is caught at
 * compile time rather than in flight.
 */
export interface FlightTuning {
  /** Dry mass, kg. */
  readonly mass: number;
  /** Main drive, newtons, along the hull's -Z. Sum of every engine pod. */
  readonly mainThrust: number;
  readonly boostMultiplier: number;
  /** RCS translation authority, newtons, per axis. */
  readonly rcsThrust: number;
  /** Retro authority along -velocity, newtons. */
  readonly brakeThrust: number;
  /** Principal moments, kg·km². */
  readonly inertia: AxisTriple;
  /** Peak RCS couple per axis, N·km. */
  readonly rcsTorque: AxisTriple;
  /** Attitude-hold time constant, seconds. Heavier hulls feel slower. */
  readonly assistDampTime: number;
  /** Cruise ceiling, km/s. */
  readonly topSpeed: number;
  readonly speedFalloffExponent: number;
  /** Engine spool time, seconds. Taken from the slowest engine pod. */
  readonly throttleSpoolTime: number;
  /** Drag acceleration coefficient — see ShipConfig. Scales with frontal area. */
  readonly dragCoefficient: number;
  readonly aeroAlign: number;
  readonly aeroAngularDamp: number;
  readonly heatReference: number;
  /** Impact speed below which a touchdown is a landing, km/s. */
  readonly landingSpeed: number;
  /** Impact speed at which the hull fails, km/s. */
  readonly crashSpeed: number;
  readonly restitution: number;
  readonly groundFriction: number;
}

/**
 * Coarse collision proxy. Never the render mesh: a handful of capsules and
 * boxes is what a 120 Hz integrator can afford, and a ship that collides on its
 * silhouette instead of its geometry is indistinguishable in play.
 */
export type CollisionShape =
  | { readonly kind: 'sphere'; readonly centre: Vec3; readonly radius: number }
  | {
      readonly kind: 'capsule';
      /** Segment endpoints, ship-local km. */
      readonly a: Vec3;
      readonly b: Vec3;
      readonly radius: number;
    }
  | {
      readonly kind: 'box';
      readonly frame: Frame;
      readonly halfExtents: Vec3;
    };

export interface PhysicsProfile {
  /** Ready to hand to `new FlightModel(...)`. */
  readonly flight: FlightTuning;

  readonly dryMassKg: number;
  readonly fuelMassKg: number;
  /** Mass of cargo when full, kg. */
  readonly cargoMassKg: number;
  /** dry + fuel + cargo, kg. */
  readonly loadedMassKg: number;

  /**
   * Dry centre of mass, ship-local km. Must satisfy
   * `|centreOfMass| <= ORIGIN_TOLERANCE_KM` — the generator rebases the whole
   * blueprint so this holds. A non-zero value here is a bug report.
   */
  readonly centreOfMass: Vec3;
  /** Loaded centre of mass, km. Non-zero is normal and interesting. */
  readonly loadedCentreOfMass: Vec3;

  /** Principal moments about the CoM, kg·km². Mirrors `flight.inertia`. */
  readonly inertia: AxisTriple;
  /**
   * Off-diagonal terms Ixy, Ixz, Iyz, kg·km². `FlightModel` ignores them, but a
   * large value means the principal axes are not the hull axes — an asymmetric
   * ship that tumbles oddly with assist off. Keep for the reviewer.
   */
  readonly inertiaProducts: Vec3;

  /** Unit vector of total thrust on the ship. Should be ≈ (0,0,-1). */
  readonly thrustAxis: Vec3;
  /** Total vacuum thrust, newtons. */
  readonly thrustN: number;
  /**
   * Perpendicular distance from the resultant thrust line to the centre of
   * mass, km. Zero is the design goal (BRIEF §5). Non-zero means the drive
   * torques the ship; if it is deliberate, say why in `thrustOffsetReason`.
   */
  readonly thrustOffset: number;
  readonly thrustOffsetReason: string | null;

  /** RCS translation authority per body axis, newtons. */
  readonly rcsAuthorityN: Vec3;
  /** RCS couple per body axis, N·km. Mirrors `flight.rcsTorque`. */
  readonly rcsTorque: AxisTriple;

  readonly bounds: Aabb;
  readonly boundingRadius: number;
  readonly collision: readonly CollisionShape[];

  /** Projected areas, km², for drag and for radar cross-section. */
  readonly frontalAreaKm2: number;
  readonly sideAreaKm2: number;
  readonly planformAreaKm2: number;

  /** Usable cargo volume, m³. Feeds the scan readout and gameplay. */
  readonly cargoVolumeM3: number;
  /** Propellant capacity, kg. */
  readonly fuelCapacityKg: number;
  /** Delta-v at full load with full tanks, km/s. Honest Tsiolkovsky. */
  readonly deltaVKmS: number;
}

// ---------------------------------------------------------------------------
// Scan contract — consumed by the HUD scanner
// ---------------------------------------------------------------------------

/** `Hud.ts` renders exactly this many scanner rows (`SCAN_LINES`). */
export const SCAN_MAX_LINES = 10;

export type ThreatClass = 'derelict' | 'unarmed' | 'defensive' | 'armed' | 'warship';

/**
 * A part the HUD can target and the player can disable. `frame.origin` is where
 * the bracket is drawn; `radius` is how big the bracket is.
 */
export interface TargetableSubsystem {
  readonly id: string;
  /** Short uppercase label for the HUD: "DRIVE", "SENSOR MAST", "CARGO". */
  readonly label: string;
  readonly frame: Frame;
  readonly radius: number;
  /** 0..1. Below ~0.3 the subsystem is visibly failing. */
  readonly integrity: number;
  /** True when destroying it disables the ship rather than degrading it. */
  readonly critical: boolean;
  /** What it maps to, so a hit can be turned into a DamageEvent. */
  readonly target: GeometryRef;
}

export interface ScanProfile {
  /** What the HUD title shows. */
  readonly displayName: string;
  /** "Kessler-pattern heavy hauler" — family plus role, from families.ts. */
  readonly className: string;
  /** Hull registration, e.g. "KX-4471". */
  readonly registry: string;
  /** Operator's display name. */
  readonly operator: string;
  readonly role: ShipRole;
  readonly sizeClass: SizeClass;
  readonly massTonnes: number;
  readonly lengthM: number;
  readonly crew: number;
  readonly cargoCapacityM3: number;
  readonly threat: number;
  readonly threatClass: ThreatClass;
  /** Detection signatures, 0..1 each. Drives how far away the scanner sees it. */
  readonly thermalSignature: number;
  readonly radarSignature: number;
  readonly emSignature: number;
  readonly subsystems: readonly TargetableSubsystem[];
  /**
   * Pre-formatted readout lines, at most `SCAN_MAX_LINES`. Formatting lives
   * here, in pure data, so the HUD stays a typewriter and never learns what a
   * ship is.
   */
  readonly lines: readonly string[];
  /** One or two sentences for the codex. */
  readonly blurb: string;
}

// ---------------------------------------------------------------------------
// Render profile
// ---------------------------------------------------------------------------

/**
 * One level of detail. Distances are absolute km and must be derived from the
 * ship's length, not fixed: a 4 km capital that swaps to LOD1 at the same
 * distance as a 30 m courier pops in the middle of the screen.
 */
export interface LodLevel {
  /** 0 is the finest. */
  readonly level: number;
  /** Camera distance, km, at or beyond which this level takes over. */
  readonly minDistanceKm: number;
  /** Triangle budget for this level (BRIEF §6: 120k / 25k / 3k / impostor). */
  readonly triangleBudget: number;
  /** Segments around a section. Drops hard with level. */
  readonly sectionSegments: number;
  /** Subdivisions between consecutive stations along a run. */
  readonly stationSubdivisions: number;
  /** 0..1 fraction of greebles kept. 0 at LOD2 and beyond. */
  readonly greebleFraction: number;
  /** Below this size in km, a part is dropped entirely at this level. */
  readonly minFeatureKm: number;
  /** Whether modules are drawn individually or merged into the hull silhouette. */
  readonly separateModules: boolean;
  /** Whether connections (pipes, cables, struts) survive at this level. */
  readonly connections: boolean;
}

/**
 * A repeated detail the renderer should draw with one `InstancedMesh`. Every
 * greeble in `Ship.ts` is authored in a unit footprint precisely so one
 * per-instance scale drives all of them; the same rule applies here.
 */
export interface InstanceHint {
  /** Geometry cache key. Equal keys ⇒ one shared BufferGeometry. */
  readonly key: string;
  /** Expected instance count at LOD0. Sizes the InstancedMesh up front. */
  readonly count: number;
  /** Which material this batch draws with. */
  readonly materialKey: string;
  /** Level beyond which the batch is dropped entirely. */
  readonly dropAtLevel: number;
}

export interface RenderProfile {
  /** Ordered fine → coarse. Index 0 is LOD0. */
  readonly lods: readonly LodLevel[];
  /** Distance, km, beyond which the ship is one billboard quad. */
  readonly impostorDistanceKm: number;
  /** Distance, km, beyond which it is not drawn at all. */
  readonly cullDistanceKm: number;
  /** Every material key used, deduplicated. Length must be ≤ 3 (BRIEF §6). */
  readonly materialKeys: readonly string[];
  readonly instancing: readonly InstanceHint[];
  /** Expected LOD0 draw calls. Must be ≤ 12 (BRIEF §6). */
  readonly drawCallEstimate: number;
  /**
   * Analytic contact-shadow spheres to upload, capped at the shader's array
   * size (`OCC_MAX` = 28 in `Ship.ts`). Greebles darken the hull under them
   * without a shadow map.
   */
  readonly occluderBudget: number;
  /** Analytic window lamps, capped at `LAMP_MAX` = 6 in `Ship.ts`. */
  readonly lampBudget: number;
  /** Seed for renderer-side scatter (greeble placement, rivet jitter). */
  readonly detailSeed: number;
  /**
   * Emissive window positions, ship-local km, with an intensity each. Lit
   * interiors spill onto surrounding plate; this is the list the analytic lamp
   * uniforms are filled from.
   */
  readonly lamps: readonly { readonly position: Vec3; readonly radius: number; readonly intensity: number }[];
}

// ---------------------------------------------------------------------------
// The blueprint
// ---------------------------------------------------------------------------

/**
 * Everything there is to know about one ship.
 *
 * Generated in the order of BRIEF §4 — role and family, spine, primary volumes,
 * propulsion, modules, secondary volumes, accents, greebles — and each stage
 * may only read what earlier stages produced.
 */
export interface ShipBlueprint {
  readonly id: string;
  readonly seed: number;
  readonly generationVersion: number;

  /** Display name from `gen/names.ts`. */
  readonly name: string;
  readonly factionId: FactionId;
  /** The visual DNA this hull was drawn from. Owned by `families.ts`. */
  readonly familyId: FamilyId;
  readonly role: ShipRole;
  readonly sizeClass: SizeClass;
  readonly technologyProfile: TechnologyProfile;

  readonly dimensions: ShipDimensions;
  readonly structuralSpine: StructuralSpine;
  /** Silhouette-defining masses first, secondary shapes after. */
  readonly primaryVolumes: readonly PrimaryVolume[];
  readonly sockets: readonly Socket[];
  readonly modules: readonly ShipModule[];
  readonly connections: readonly Connection[];
  readonly engines: readonly EnginePod[];
  readonly thrusters: readonly RcsThruster[];
  readonly hardpoints: readonly Hardpoint[];
  readonly dockingPoints: readonly DockingPort[];
  /** Null for a ship that never lands. */
  readonly landingSystem: LandingSystem | null;

  readonly palette: ShipPalette;
  /** At most three (BRIEF §6). Index 0 is the primary hull material. */
  readonly materialProfiles: readonly MaterialProfile[];

  readonly damageHistory: readonly DamageEvent[];
  readonly repairHistory: readonly RepairEvent[];
  readonly markings: readonly Marking[];

  readonly physics: PhysicsProfile;
  readonly scan: ScanProfile;
  readonly renderProfile: RenderProfile;
}

// ===========================================================================
// Helpers
//
// Small, pure, allocation-conscious functions that every consumer would
// otherwise write for itself — and write slightly differently, which is how a
// physics module and a geometry module end up disagreeing about where the hull
// surface is. `sectionPoint` and `volumeSurfacePoint` in particular are the
// canonical definition of the hull: if you need a point on a ship, ask here.
// ===========================================================================

const TAU = Math.PI * 2;

/** Puts the centre of a polygon flat on the ventral centreline. See `sectionPoint`. */
const POLYGON_FLAT_PHASE = Math.PI * 0.5;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/** Wrap to (-π, π]. Used wherever an angular distance is taken. */
function wrapPi(a: number): number {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  if (x <= -Math.PI) x += TAU;
  return x;
}

// --- vector arithmetic on plain tuples -------------------------------------
// Deliberately not a Vector3 class: `gen/` must stay free of three.js, and the
// blueprint has to stay JSON. These allocate only when `out` is omitted.

export function vec3(x: number, y: number, z: number): Vec3 {
  return [x, y, z];
}

export function vAdd(a: Vec3, b: Vec3, out: MutVec3 = [0, 0, 0]): MutVec3 {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
  return out;
}

export function vSub(a: Vec3, b: Vec3, out: MutVec3 = [0, 0, 0]): MutVec3 {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
  return out;
}

export function vScale(a: Vec3, k: number, out: MutVec3 = [0, 0, 0]): MutVec3 {
  out[0] = a[0] * k;
  out[1] = a[1] * k;
  out[2] = a[2] * k;
  return out;
}

export function vDot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vCross(a: Vec3, b: Vec3, out: MutVec3 = [0, 0, 0]): MutVec3 {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function vLength(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

export function vNormalize(a: Vec3, out: MutVec3 = [0, 0, 0]): MutVec3 {
  const l = vLength(a);
  const k = l > 1e-12 ? 1 / l : 0;
  out[0] = a[0] * k;
  out[1] = a[1] * k;
  out[2] = a[2] * k;
  return out;
}

/**
 * The third axis of a frame. Derived rather than stored so a frame can never
 * hold an inconsistent basis.
 *
 * With `up = +Y` and `forward = +Z` (a hull run pointing aft) this gives +X,
 * i.e. starboard — "right" is always relative to the run direction, not to the
 * pilot.
 */
export function frameRight(f: Frame, out: MutVec3 = [0, 0, 0]): MutVec3 {
  return vNormalize(vCross(f.up, f.forward, out), out);
}

/** Transform a point from a frame's local space into ship space. */
export function frameToShip(f: Frame, local: Vec3, out: MutVec3 = [0, 0, 0]): MutVec3 {
  const r = frameRight(f, _r);
  out[0] = f.origin[0] + r[0] * local[0] + f.up[0] * local[1] + f.forward[0] * local[2];
  out[1] = f.origin[1] + r[1] * local[0] + f.up[1] * local[1] + f.forward[1] * local[2];
  out[2] = f.origin[2] + r[2] * local[0] + f.up[2] * local[1] + f.forward[2] * local[2];
  return out;
}

/** Rotate a direction (not a point) from frame-local into ship space. */
export function frameDirToShip(f: Frame, local: Vec3, out: MutVec3 = [0, 0, 0]): MutVec3 {
  const r = frameRight(f, _r);
  out[0] = r[0] * local[0] + f.up[0] * local[1] + f.forward[0] * local[2];
  out[1] = r[1] * local[0] + f.up[1] * local[1] + f.forward[1] * local[2];
  out[2] = r[2] * local[0] + f.up[2] * local[1] + f.forward[2] * local[2];
  return out;
}

/**
 * Mirror a frame through the ship's XZ centreline. The handedness flips, which
 * is exactly what a mirrored part wants — a port-side leg is a starboard leg
 * seen in a mirror, not a rotated one.
 */
export function mirrorFrameX(f: Frame): Frame {
  return {
    origin: [-f.origin[0], f.origin[1], f.origin[2]],
    forward: [-f.forward[0], f.forward[1], f.forward[2]],
    up: [-f.up[0], f.up[1], f.up[2]],
  };
}

/** Rodrigues rotation of `v` about unit `axis` by `angle`. */
export function rotateAbout(v: Vec3, axis: Vec3, angle: number, out: MutVec3 = [0, 0, 0]): MutVec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = vDot(axis, v);
  const cx = axis[1] * v[2] - axis[2] * v[1];
  const cy = axis[2] * v[0] - axis[0] * v[2];
  const cz = axis[0] * v[1] - axis[1] * v[0];
  out[0] = v[0] * c + cx * s + axis[0] * d * (1 - c);
  out[1] = v[1] * c + cy * s + axis[1] * d * (1 - c);
  out[2] = v[2] * c + cz * s + axis[2] * d * (1 - c);
  return out;
}

// Module-scope scratch. These helpers are generation- and build-time only —
// never called from a per-frame `update()` — but they run tens of thousands of
// times while lofting a hull, so they must not allocate.
const _r: MutVec3 = [0, 0, 0];
const _p2: MutVec2 = [0, 0];
const _tmp: MutVec3 = [0, 0, 0];
const _tmp2: MutVec3 = [0, 0, 0];

// --- sections --------------------------------------------------------------

/**
 * The canonical cross-section evaluator: a point on the unit section at angle
 * `theta`, before the station's half-width/half-height scaling.
 *
 * `theta` = 0 is starboard (+X), π/2 is up (+Y) — the same convention as
 * `HullShape.sample` in `Ship.ts`.
 *
 * The families are evaluated as a radius r(θ) and then converted to (x, y),
 * which is what lets one function serve three shapes plus two modifiers. Note
 * this parametrises the *same curves* as `Ship.ts` but distributes vertices
 * differently around them (uniform in angle rather than in the superellipse
 * parameter); that is a vertex-density choice, not a shape difference.
 *
 * Returns `out` so the caller can hoist one pair out of its loop.
 */
export function sectionPoint(
  shape: SectionShape,
  s: SectionSampleLike,
  theta: number,
  out: MutVec2 = [0, 0],
): MutVec2 {
  let r: number;

  switch (shape.family) {
    case 'superellipse': {
      // |x|^n + |y|^n = 1 in polar: r = (|cos|^n + |sin|^n)^(-1/n).
      // n = 2 is a circle, n → ∞ is a square. Below 2 it goes concave, which
      // no hull wants, so the exponent is clamped.
      const n = Math.max(2, s.exponent);
      const c = Math.abs(Math.cos(theta));
      const si = Math.abs(Math.sin(theta));
      r = Math.pow(Math.pow(c, n) + Math.pow(si, n), -1 / n);
      break;
    }
    case 'polygon': {
      // Regular N-gon of circumradius 1. `a` is the angle within the current
      // sector measured from the sector centre-line, where a flat faces
      // outward; so with twist 0 a flat faces starboard.
      const n = Math.max(3, Math.round(shape.sides));
      const sector = TAU / n;
      const half = sector * 0.5;
      // Phase so that a = 0 — the middle of a flat — lands on the VENTRAL
      // centreline (θ = -π/2) at zero twist. Ships sit on their bellies, so a
      // flat bottom is the useful default: N = 3 becomes a delta wedge with a
      // flat belly and an apex on top, N = 6 becomes a hex tank lying flat with
      // its corners outboard. Without the phase every polygon gets a corner at
      // the bottom, which is a shape nothing is ever built as.
      let a = (theta + POLYGON_FLAT_PHASE + half) % sector;
      if (a < 0) a += sector;
      a -= half;
      const apothem = Math.cos(half);
      r = apothem / Math.cos(a);
      // Chamfer by clamping the radius: this cuts the corners off flat, which
      // is what a real fabricator does to a plate corner. chamfer = 1 collapses
      // to the inscribed circle.
      const rMax = 1 - clamp(s.chamfer, 0, 1) * (1 - apothem);
      if (r > rMax) r = rMax;
      break;
    }
    case 'twin-lobe': {
      // Union of two circles of radius ρ centred at (±d, 0), normalised so the
      // widest point is 1. Closed form: r = d|cosθ| + sqrt(ρ² - d² sin²θ).
      //
      // Clamped at 0.45 and not higher: the section stays connected only while
      // ρ = 1 - d > d, i.e. d < 0.5, and at exactly 0.5 the two circles merely
      // touch and the waist pinches to zero — a degenerate hull. 0.45 leaves a
      // waist of ~0.32 of the half-beam, which reads clearly as two lobes.
      const d = clamp(s.lobeSeparation, 0, TWIN_LOBE_MAX_SEPARATION);
      const rho = 1 - d;
      const sn = Math.sin(theta);
      const k = rho * rho - d * d * sn * sn;
      r = d * Math.abs(Math.cos(theta)) + Math.sqrt(k > 0 ? k : 0);
      break;
    }
  }

  // Harmonics: constant frequency and phase along the run, amplitude lerped.
  // Constant phase is the whole point — that is what makes a chine a line.
  for (let i = 0; i < shape.harmonics.length; i++) {
    const h = shape.harmonics[i];
    const amp = lerp(h.amplitude[0], h.amplitude[1], s.t);
    r *= 1 + amp * Math.cos(h.frequency * theta + h.phase);
  }

  // Localised lobes: keel, dorsal spine, sponson. A gaussian in angle, so the
  // lobe blends smoothly into the parent section instead of creasing it.
  for (let i = 0; i < shape.lobes.length; i++) {
    const l = shape.lobes[i];
    const d = wrapPi(theta - l.angle) / Math.max(1e-4, l.width);
    r += lerp(l.depth[0], l.depth[1], s.t) * Math.exp(-0.5 * d * d);
  }

  if (r < 0) r = 0;

  const x = r * Math.cos(theta);
  let y = r * Math.sin(theta);
  // Flat belly: scale only the ventral half of y, exactly as `Ship.ts` does.
  // Scaling the radius instead would narrow the hull as well as flatten it.
  if (y < 0) y *= clamp(s.ventralFlatten, 0.05, 1);

  out[0] = x;
  out[1] = y;
  return out;
}

/** Mutable mirror of a station, produced by `sampleStation`. */
export interface StationSample extends SectionSampleLike {
  t: number;
  exponent: number;
  chamfer: number;
  lobeSeparation: number;
  ventralFlatten: number;
  halfWidth: number;
  halfHeight: number;
  offsetX: number;
  offsetY: number;
  twist: number;
}

export function newStationSample(): StationSample {
  return {
    t: 0,
    exponent: 2,
    chamfer: 0,
    lobeSeparation: 0,
    ventralFlatten: 1,
    halfWidth: 0,
    halfHeight: 0,
    offsetX: 0,
    offsetY: 0,
    twist: 0,
  };
}

/**
 * Interpolate the station list at `t`.
 *
 * Every parameter is a scalar of one family, so linear interpolation is always
 * defined — that is the reason `SectionShape` (family, side count, harmonics,
 * lobes) is per-volume and not per-station.
 */
export function sampleStation(
  stations: readonly VolumeStation[],
  t: number,
  out: StationSample = newStationSample(),
): StationSample {
  const n = stations.length;
  const tc = clamp(t, 0, 1);
  let i = 0;
  while (i < n - 2 && stations[i + 1].t < tc) i++;
  const a = stations[i];
  const b = stations[Math.min(n - 1, i + 1)];
  const span = b.t - a.t;
  const k = span > 1e-9 ? clamp((tc - a.t) / span, 0, 1) : 0;

  out.t = tc;
  out.exponent = lerp(a.exponent, b.exponent, k);
  out.chamfer = lerp(a.chamfer, b.chamfer, k);
  out.lobeSeparation = lerp(a.lobeSeparation, b.lobeSeparation, k);
  out.ventralFlatten = lerp(a.ventralFlatten, b.ventralFlatten, k);
  out.halfWidth = lerp(a.halfWidth, b.halfWidth, k);
  out.halfHeight = lerp(a.halfHeight, b.halfHeight, k);
  out.offsetX = lerp(a.offset[0], b.offset[0], k);
  out.offsetY = lerp(a.offset[1], b.offset[1], k);
  out.twist = lerp(a.twist, b.twist, k);
  return out;
}

/** A frame produced by sampling; mutable so hot loops can reuse it. */
export interface MutFrame {
  origin: MutVec3;
  forward: MutVec3;
  up: MutVec3;
}

export function newMutFrame(): MutFrame {
  return { origin: [0, 0, 0], forward: [0, 0, 1], up: [0, 1, 0] };
}

/**
 * The moving frame along a volume's run at parameter `t`, in ship space.
 *
 * For a linear path the frame simply translates. For an arc it rotates about
 * the volume's own `up`, with the centre of curvature to starboard of the run
 * for a positive radius — so a closed ring (`sweep = 2π`) lies in the plane
 * spanned by the volume's forward and right axes.
 */
export function volumePathFrame(v: PrimaryVolume, t: number, out: MutFrame = newMutFrame()): MutFrame {
  const f = v.frame;
  const tc = clamp(t, 0, 1);

  if (v.path.kind === 'linear') {
    const d = v.path.length * tc;
    out.origin[0] = f.origin[0] + f.forward[0] * d;
    out.origin[1] = f.origin[1] + f.forward[1] * d;
    out.origin[2] = f.origin[2] + f.forward[2] * d;
    out.forward[0] = f.forward[0];
    out.forward[1] = f.forward[1];
    out.forward[2] = f.forward[2];
    out.up[0] = f.up[0];
    out.up[1] = f.up[1];
    out.up[2] = f.up[2];
    return out;
  }

  const phi = v.path.sweep * tc;
  const right = frameRight(f, _r);
  // Centre of curvature, `radius` to starboard of the start of the run.
  const cx = f.origin[0] + right[0] * v.path.radius;
  const cy = f.origin[1] + right[1] * v.path.radius;
  const cz = f.origin[2] + right[2] * v.path.radius;
  _tmp[0] = f.origin[0] - cx;
  _tmp[1] = f.origin[1] - cy;
  _tmp[2] = f.origin[2] - cz;
  rotateAbout(_tmp, f.up, phi, _tmp2);
  out.origin[0] = cx + _tmp2[0];
  out.origin[1] = cy + _tmp2[1];
  out.origin[2] = cz + _tmp2[2];
  rotateAbout(f.forward, f.up, phi, out.forward);
  out.up[0] = f.up[0];
  out.up[1] = f.up[1];
  out.up[2] = f.up[2];
  return out;
}

/**
 * A point on a volume's surface, in ship space.
 *
 * THIS IS THE DEFINITION OF THE HULL. The geometry builder lofts it, the
 * mass-properties integrator sums it, the collision fitter bounds it and the
 * socket placer projects onto it. If two modules disagree about where the skin
 * is, one of them is not calling this.
 *
 * `t` runs 0 (start of the run, the forward end for axial volumes) to 1;
 * `theta` is the section angle, 0 = starboard, π/2 = up.
 */
export function volumeSurfacePoint(
  v: PrimaryVolume,
  t: number,
  theta: number,
  out: MutVec3 = [0, 0, 0],
  sample: StationSample = newStationSample(),
  frame: MutFrame = newMutFrame(),
): MutVec3 {
  sampleStation(v.stations, t, sample);
  sectionPoint(v.shape, sample, theta - sample.twist, _p2);
  const lx = sample.offsetX + _p2[0] * sample.halfWidth;
  const ly = sample.offsetY + _p2[1] * sample.halfHeight;
  volumePathFrame(v, t, frame);
  const right = frameRight(frame, _r);
  out[0] = frame.origin[0] + right[0] * lx + frame.up[0] * ly;
  out[1] = frame.origin[1] + right[1] * lx + frame.up[1] * ly;
  out[2] = frame.origin[2] + right[2] * lx + frame.up[2] * ly;
  return out;
}

// --- bounds ----------------------------------------------------------------

export function emptyAabb(): { min: MutVec3; max: MutVec3 } {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
}

export function growAabb(box: { min: MutVec3; max: MutVec3 }, p: Vec3): void {
  if (p[0] < box.min[0]) box.min[0] = p[0];
  if (p[1] < box.min[1]) box.min[1] = p[1];
  if (p[2] < box.min[2]) box.min[2] = p[2];
  if (p[0] > box.max[0]) box.max[0] = p[0];
  if (p[1] > box.max[1]) box.max[1] = p[1];
  if (p[2] > box.max[2]) box.max[2] = p[2];
}

export function unionAabb(a: Aabb, b: Aabb): Aabb {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export function aabbCentre(b: Aabb): Vec3 {
  return [(b.min[0] + b.max[0]) * 0.5, (b.min[1] + b.max[1]) * 0.5, (b.min[2] + b.max[2]) * 0.5];
}

export function aabbSize(b: Aabb): Vec3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

/** Radius of the sphere about the ship origin that contains the box. */
export function aabbRadiusFromOrigin(b: Aabb): number {
  const x = Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]));
  const y = Math.max(Math.abs(b.min[1]), Math.abs(b.max[1]));
  const z = Math.max(Math.abs(b.min[2]), Math.abs(b.max[2]));
  return Math.sqrt(x * x + y * y + z * z);
}

/**
 * Bounding box of one volume, by sampling the surface.
 *
 * Sampled rather than analytic because harmonics and lobes make the section's
 * extreme angles data-dependent; 16 × 24 samples is exact to well under a
 * panel width on anything we generate and costs nothing at build time.
 */
export function volumeBounds(v: PrimaryVolume, tSteps = 16, thetaSteps = 24): Aabb {
  const box = emptyAabb();
  const p: MutVec3 = [0, 0, 0];
  const sample = newStationSample();
  const frame = newMutFrame();
  for (let i = 0; i <= tSteps; i++) {
    const t = i / tSteps;
    for (let j = 0; j < thetaSteps; j++) {
      volumeSurfacePoint(v, t, (j / thetaSteps) * TAU, p, sample, frame);
      growAabb(box, p);
    }
  }
  return { min: [box.min[0], box.min[1], box.min[2]], max: [box.max[0], box.max[1], box.max[2]] };
}

/** Bounding box of a whole volume list. Empty list gives a degenerate box at 0. */
export function volumeListBounds(volumes: readonly PrimaryVolume[]): Aabb {
  if (volumes.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  let box = volumeBounds(volumes[0]);
  for (let i = 1; i < volumes.length; i++) box = unionAabb(box, volumeBounds(volumes[i]));
  return box;
}

// --- lookups ---------------------------------------------------------------

/**
 * Socket lookup, preserving the socket's type parameter.
 *
 * The cast is the price of storing a heterogeneous socket list in one array;
 * it is sound because `Socket.id` is branded with `Socket.type`, and this is
 * the only place that relies on it.
 */
export function findSocket<T extends SocketType>(
  bp: ShipBlueprint,
  id: SocketId<T>,
): Socket<T> | undefined {
  for (let i = 0; i < bp.sockets.length; i++) {
    if (bp.sockets[i].id === id) return bp.sockets[i] as Socket<T>;
  }
  return undefined;
}

export function socketsOfType<T extends SocketType>(bp: ShipBlueprint, type: T): readonly Socket<T>[] {
  const out: Socket<T>[] = [];
  for (let i = 0; i < bp.sockets.length; i++) {
    if (bp.sockets[i].type === type) out.push(bp.sockets[i] as Socket<T>);
  }
  return out;
}

/** Sockets with nothing mounted. Blanking plates count as free, not occupied. */
export function freeSockets(bp: ShipBlueprint): readonly Socket[] {
  return bp.sockets.filter((s) => s.occupiedBy === null);
}

export function findVolume(bp: ShipBlueprint, id: VolumeId): PrimaryVolume | undefined {
  for (let i = 0; i < bp.primaryVolumes.length; i++) {
    if (bp.primaryVolumes[i].id === id) return bp.primaryVolumes[i];
  }
  return undefined;
}

export function findSpineNode(spine: StructuralSpine, id: SpineNodeId): SpineNode | undefined {
  for (const chain of spine.chains) {
    for (const node of chain.nodes) if (node.id === id) return node;
  }
  return undefined;
}

/**
 * Position along a spine chain at normalised arclength `s`, by linear
 * interpolation between nodes. This is the placement rail: a generator walks
 * `s` to space bulkheads, sockets and ribs evenly along the load path.
 */
export function spinePointAt(chain: SpineChain, s: number, out: MutVec3 = [0, 0, 0]): MutVec3 {
  const nodes = chain.nodes;
  const sc = clamp(s, 0, 1);
  let i = 0;
  while (i < nodes.length - 2 && nodes[i + 1].s < sc) i++;
  const a = nodes[i];
  const b = nodes[Math.min(nodes.length - 1, i + 1)];
  const span = b.s - a.s;
  const k = span > 1e-9 ? clamp((sc - a.s) / span, 0, 1) : 0;
  out[0] = lerp(a.position[0], b.position[0], k);
  out[1] = lerp(a.position[1], b.position[1], k);
  out[2] = lerp(a.position[2], b.position[2], k);
  return out;
}

/**
 * Whether a module kind may be mounted on a socket. Checks the type mapping,
 * the socket's own accept list and the size budget — a module that is legal by
 * type but too big for the mount is still an illegal placement.
 */
export function moduleFitsSocket(
  kind: ModuleKind,
  socket: Socket,
  radius: number,
  depth: number,
  massKg: number,
): boolean {
  if (MODULE_SOCKET[kind] !== socket.type) return false;
  if (socket.accepts.length > 0 && !socket.accepts.includes(kind)) return false;
  if (radius > socket.budget.radius) return false;
  if (depth > socket.budget.depth) return false;
  if (massKg > socket.budget.massKg) return false;
  // A module deeper than the measured free space in front of the socket would
  // intersect whatever is out there. This is the check BRIEF §5 is about.
  return depth <= socket.clearance;
}

// --- render ----------------------------------------------------------------

/**
 * Which LOD index to draw at a given camera distance. Returns
 * `lods.length` when the ship is past the impostor threshold, and -1 when it
 * is past the cull distance, so the caller has one number to switch on.
 */
export function lodForDistance(profile: RenderProfile, distanceKm: number): number {
  if (distanceKm >= profile.cullDistanceKm) return -1;
  if (distanceKm >= profile.impostorDistanceKm) return profile.lods.length;
  let level = 0;
  for (let i = 0; i < profile.lods.length; i++) {
    if (distanceKm >= profile.lods[i].minDistanceKm) level = profile.lods[i].level;
  }
  return level;
}

// --- HUD -------------------------------------------------------------------

/**
 * Adapt a blueprint to the scanner's payload — the exact shape
 * `bus.emit('scan:complete', …)` expects. Truncated to the number of rows
 * `Hud.ts` actually builds, so an over-long profile silently loses its least
 * important line instead of vanishing off the bottom of the panel.
 */
export function toScanResult(bp: ShipBlueprint): ScanResult {
  return {
    targetId: bp.id,
    name: bp.scan.displayName,
    lines: bp.scan.lines.slice(0, SCAN_MAX_LINES),
  };
}
