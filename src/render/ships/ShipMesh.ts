/**
 * ShipMesh — the assembler.
 *
 * Four modules were built independently against the blueprint: `volumes` makes
 * hull surface, `greebles` makes fittings, `ShipMaterial` makes the surface
 * look manufactured, and `propulsion` makes it burn. None of them knows the
 * others exist. This file is the only place that does.
 *
 * It owns five decisions the individual modules cannot make alone:
 *
 *  1. THE DRAW-CALL BUDGET. A faction vocabulary is up to 24 greeble families,
 *     which as 24 InstancedMeshes would be 24 draw calls for detail alone. The
 *     dense families stay instanced; the sparse ones are welded into the hull
 *     buffer. See `splitScatterBudget`.
 *  2. THE OCCLUDER SET. Only the assembler knows the part ids the geometry
 *     actually allocated, and without them a caster whose id matches the
 *     surface it sits on cannot be rejected — a slab shadows itself into a
 *     black stripe down its own face.
 *  3. WHEN UNIFORMS ARE PUSHED. Materials are shared between ships of a
 *     family, so per-ship values must be current at *draw* time, not at tick
 *     time. They go in `onBeforeRender`, never in `update()`.
 *  4. WHAT A LOD RUNG IS ALLOWED TO CHANGE. `volumes` and `greebles` each see
 *     one `LodLevel` and reduce themselves against it, independently. Only the
 *     assembler can see that the two reductions land on the same silhouette,
 *     and that one of them is legitimate and the other is a pop. See
 *     `shapeDescriptor` and `detail`.
 *  5. WHERE THE SHIP STOPS BEING GEOMETRY. Level 3 is not a hull rung, it is
 *     one billboard. See `buildImpostor`.
 */

import {
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  Vector3,
} from 'three';

import type { EngineContext } from '@/core/Engine';
import type { QualitySettings } from '@/core/Config';
import type { ViewState } from '@/render/ViewState';
import type { ShipBlueprint, LodLevel } from '@/gen/ships/types';
import { factionById, greebleVocabulary } from '@/gen/ships/families';
import type { ShipDriveState, ShipVisual } from '@/game/Showroom';

import {
  BRIEF_TRIANGLE_CAP,
  HullBuilder,
  buildImpostorQuad,
  buildSpine,
  buildVolume,
  impostorFor,
  type OccluderSphere,
  type SurfaceSeat,
  type VolumeBuildOptions,
} from './volumes';
import {
  GREEBLE_TRI_SHARE,
  GreebleCache,
  bakeScatter,
  scatterGreebles,
  splitScatterBudget,
  type InstancedScatter,
} from './greebles';
import { shipMaterials, shipPanelSizeKm, type ShipMaterialSet } from './ShipMaterial';
import { ShipPropulsion, type ShipDriveState as DriveState } from './propulsion';

/** How many instanced greeble batches a ship may spend. The rest is baked. */
const MAX_GREEBLE_BATCHES = 5;

/**
 * Fewest instances that still earn a batch its own draw call.
 *
 * A bind plus a draw for twenty fittings is a bargain and for three is not,
 * and the difference only shows up at the coarse rungs, where the budget has
 * trimmed most families to single figures. See the demotion in `build`.
 */
const INSTANCE_MIN = 20;

/**
 * The share of a rung's triangle cap that belongs to the OUTLINE, whatever the
 * rest of the accounting says.
 *
 * Measured on the hero hull with the detail layer forced on at every rung: the
 * lofted structure alone is already stable — LOD0-vs-LOD1 outline XOR 0.42 %
 * and LOD0-vs-LOD2 2.11 % — and every point above that came from fittings
 * being culled. LOD2's ladder budget is 2,633 triangles against 2,508 of hull,
 * which leaves the detail layer 125 and in practice zero, so the whole rim of
 * every volume lost its hardware in one step: XOR 9.8 %.
 *
 * So a rung reserves this much of its cap for detail even when the ordinary
 * arithmetic says there is nothing left. Nothing is overspent to pay for it:
 * `volumes.ts:COARSE_SURFACE_SHARE` stops the skin taking 90 % of a rung it
 * does not need, and this is where that goes. On the hero that turns LOD2's
 * detail allowance from 125 triangles into 852 — nine of its twelve
 * support-owning fittings — for a rung that still draws 2,888 in total.
 */
const SILHOUETTE_RESERVE = 0.3;

/**
 * How much a fitting NEAR one of the ship's supports outranks one that is not.
 *
 * A pure value-per-triangle ranking is right for AREA and wrong for EXTENT: a
 * mast is 124 triangles of almost no projected area, so it is the first thing
 * a knapsack drops — and it is also the 25 px of dorsal boom the LOD critic
 * measured going missing between LOD1 and LOD2. Extent is what the eye reads
 * as "the ship changed shape", so a fitting standing at the end of the ship
 * competes at 33× its honest value per triangle, and the ones that actually
 * OWN a support (see `EXTREME_DIRS`) do not compete at all — they sort above
 * the whole field. On the hero that second set is 12 fittings out of 429, and
 * 1,240 triangles out of LOD0's 28,694.
 */
const EXTREME_BONUS = 32;

/**
 * How wide the band round each support is, as a fraction of hull length.
 *
 * A boom is a mast plus the clamps and the conduit that run out along it, and
 * a ranking that favoured only the tip would leave a floating spike whenever
 * the rung could afford two fittings and not three. 6 % of the hero's 62 m is
 * 3.7 m, which is the fitting cluster and not the hull under it.
 */
const EXTREME_BAND_FRACTION = 0.06;

/**
 * The directions a silhouette extreme is measured along.
 *
 * Six axes are not enough, and the review camera is the proof: it looks down
 * (0.7, 0.3, 0.65), so the leftmost pixel of the hero's outline is the tip
 * that maximises (−0.68, 0, 0.73) — a direction no axis names. Holding the
 * axis owners alone kept the dorsal boom and still lost 22 px off the aft end.
 *
 * So the axes are joined by the eight corner diagonals of the cube: fourteen
 * directions, no two of which are more than 55° apart, which bounds how far
 * the true support in any view direction can fall below the nearest one that
 * is held. Fourteen directions do NOT mean fourteen fittings — on the hero
 * they resolve to twelve, because a mast at the top of the ship owns +y and
 * the diagonals either side of it at once.
 */
const EXTREME_DIRS = ((): Float32Array => {
  const d: number[] = [];
  for (let a = 0; a < 3; a++) {
    for (const s of [1, -1]) d.push(a === 0 ? s : 0, a === 1 ? s : 0, a === 2 ? s : 0);
  }
  const k = 1 / Math.sqrt(3);
  for (let i = 0; i < 8; i++) {
    d.push((i & 1 ? k : -k), (i & 2 ? k : -k), (i & 4 ? k : -k));
  }
  return Float32Array.from(d);
})();

/** How many of them there are. `EXTREME_DIRS` is three floats each. */
const EXTREME_DIR_COUNT = EXTREME_DIRS.length / 3;

/**
 * The offset that lifts a held fitting clear of every unheld one.
 *
 * Scores are value-per-triangle in square kilometres, which on a 62 m hull is
 * of order 1e-5; 1 is nine orders of magnitude above the largest of them and
 * still exactly representable, so the sort can never interleave the two sets
 * and "held" stays a prefix.
 */
const PROTECT_RANK = 1;

/** The rung at which the ship stops being geometry and becomes one quad. */
const IMPOSTOR_LEVEL = 3;

/**
 * Millisecond ceiling on one frame's share of the background LOD prebuild.
 * ARCHITECTURE §5 caps synchronous work at 4 ms; a rung cannot be split below
 * one rung, so this bounds how many rungs may share a frame, not a rung.
 */
const WARM_BUDGET_MS = 4;

interface BuiltLod {
  readonly group: Group;
  /** Geometry this rung owns and must free. Null when it borrows only. */
  readonly geometry: BufferGeometry;
  readonly instances: InstancedMesh[];
  readonly triangles: number;
  readonly drawCalls: number;
  /**
   * The analytic caster set this rung computed. Uploaded when the rung goes
   * active rather than when it is built — with the rungs now prebuilt in the
   * background, "last built" and "currently drawn" are no longer the same
   * thing, and the material must follow the second.
   */
  readonly occSpheres: Float32Array;
  readonly occParts: Float32Array;
  readonly occCount: number;
}

/**
 * One greeble family, placed once and thereafter only trimmed.
 *
 * WHY THE PLACEMENT IS SHARED ACROSS RUNGS. `scatterGreebles` walks a single
 * seeded stream, and the number of draws it takes depends on the quota, which
 * depends on `lod.greebleFraction`. Call it once per rung and every rung gets
 * a *different* scatter, not a subset of the finest one: measured on the hero
 * hull, LOD1 grew a dorsal fin LOD0 does not have while losing the ventral
 * plate LOD0 does — masses traded for masses, which is exactly the failure
 * `ship-lod1` names ("the silhouette changes at all; a mass disappears"). So
 * the scatter runs once, at LOD0's parameters, and every coarser rung is a
 * prefix of it. A prefix can only lose hardware, never invent it.
 */
interface DetailBatch {
  readonly scatter: InstancedScatter;
  /** Triangles one instance of this family costs. */
  readonly triPerInstance: number;
  /** True if this family earns a draw call; false if it is welded into the hull. */
  readonly instanced: boolean;
  /**
   * Per-instance rank, descending, index-aligned with the instance arrays —
   * which `rankDetail` has already permuted into this order, so that "spend
   * less" is "take fewer from the front" and the per-instance channels still
   * line up with the matrices.
   */
  readonly score: Float32Array;
  /**
   * How many of the leading instances OWN one of the ship's supports.
   *
   * `rankDetail` sorts them to the front of the family and above every
   * unheld fitting on the ship, so they are the first thing any rung buys and
   * the last thing it gives up — and "held" is still a prefix, which is what
   * keeps every rung's set a subset of the finer one's. They are bought out of
   * the budget rather than exempted from it: an exemption put the hero's LOD2
   * at 3,348 triangles against BRIEF §6's 3,000, and a rung that holds its
   * shape by going over budget has moved the problem, not solved it.
   */
  readonly protect: number;
}

export class ShipMesh implements ShipVisual {
  readonly object3d: Object3D = new Group();

  private readonly materials: ShipMaterialSet;
  private readonly propulsion: ShipPropulsion;
  private readonly cache = new GreebleCache();

  /** One entry per LOD. Built eagerly in the background; see `warmStep`. */
  private readonly lods: Array<BuiltLod | null> = [null, null, null, null];
  private active = -1;
  private disposed = false;

  /** Rungs still to prebuild, in the order the player meets them. */
  private readonly warm: number[] = [IMPOSTOR_LEVEL, 1, 2];

  /** Placed once, at LOD0's parameters. See `DetailBatch`. */
  private details: DetailBatch[] | null = null;
  private readonly detailOccluders: OccluderSphere[] = [];
  /** Scratch, one slot per family. Refilled per rung; never reallocated. */
  private readonly keep: number[] = [];
  /** Families whose next instance no longer fits. Scratch, as `keep`. */
  private readonly capped: boolean[] = [];
  /** cx, cy, cz, hx, hy, hz of the blueprint's bounds. Set once, in `detail`. */
  private readonly detailBox = new Float32Array(6);
  /** The detail layer's own supports, one per `EXTREME_DIRS`. Set in `detail`. */
  private readonly detailExtremes = new Float32Array(EXTREME_DIR_COUNT);
  /** Which (family, instance) owns each of them. Set once, in `detail`. */
  private readonly detailExtremeOwner = new Int32Array(EXTREME_DIR_COUNT * 2);

  /** Impostor state. All of it is set once, in `buildImpostor`. */
  private impostor: Mesh | null = null;
  private impostorQuadRadius = 1;
  private impostorHalfLength = 0;
  private readonly impostorAxis = new Vector3(0, 0, 1);
  /** The two ship axes perpendicular to `impostorAxis`, and their half-extents. */
  private readonly impostorPlanAxis = new Vector3(1, 0, 0);
  private readonly impostorSideAxis = new Vector3(0, 1, 0);
  private impostorPlanHalf = 0;
  private impostorSideHalf = 0;

  /** What the drive costs at each rung. Measured lazily; -1 = not yet. */
  private readonly propulsionTri = [-1, -1, -1, -1];
  /** What LOD0 cost to build, ms. The yardstick `warmStep` predicts from. */
  private lod0BuildMs = 0;

  // Per-frame state. Preallocated: nothing here may allocate (ARCHITECTURE §5).
  private readonly fill = new Color(0.01, 0.014, 0.022);
  private readonly toCamera = new Vector3();
  private readonly billboardNormal = new Vector3();
  private readonly billboardUp = new Vector3();
  private readonly billboardBasis = new Matrix4();
  /**
   * The showroom and the propulsion module each declared the drive state they
   * needed, and they are not the same shape — the showroom asks for a single
   * `rcs` vector, propulsion wants translation, rotation and a power flag.
   * Neither is wrong; the assembler is where they meet.
   */
  private readonly drive: {
    throttle: number; boost: number; heating: number;
    translation: Vector3; angular: Vector3; powered: boolean;
  } = {
    throttle: 0, boost: 0, heating: 0,
    translation: new Vector3(), angular: new Vector3(), powered: true,
  };
  private readonly surfaceState = { throttle: 0, heat: 0, fill: this.fill };
  private lastView: ViewState | null = null;

  constructor(
    readonly blueprint: ShipBlueprint,
    private readonly quality: QualitySettings,
  ) {
    this.object3d.name = `ship:${blueprint.id}`;
    this.materials = shipMaterials(blueprint, quality);
    this.propulsion = new ShipPropulsion(blueprint, quality);
    this.object3d.add(this.propulsion.object3d);
    // LOD0 first and synchronously: it is the only rung that must exist before
    // the ship can be drawn at all, and `detail()` is placed against its seats.
    this.setLod(0);
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  private lodDescriptor(level: number): LodLevel {
    const ladder = this.blueprint.renderProfile.lods;
    // Clamp rather than throw: a quality tier may ask for a rung this hull
    // does not have, and a missing LOD should degrade, not crash a frame.
    return ladder[Math.min(level, ladder.length - 1)] ?? ladder[ladder.length - 1]!;
  }

  /**
   * The descriptor the *shape* is built against, which is not the same thing
   * as the descriptor the *budget* is taken from.
   *
   * A `LodLevel` packs two different reductions into one struct:
   *
   *   TESSELLATION — `sectionSegments`, `stationSubdivisions`, and the
   *   `level`-keyed row and rib ceilings inside `volumes`. These inscribe the
   *   same shape in fewer polygons. The outline moves by the sagitta of the
   *   section polygon, which is fractions of a pixel at the range the rung is
   *   for, and it moves *smoothly* — there is no moment where something is
   *   suddenly not there.
   *
   *   FEATURE CULLING — `minFeatureKm` and `connections`. These delete whole
   *   parts: `buildVolume` drops a volume under the floor outright, and
   *   `buildSpine` drops a member. That is a mass appearing and disappearing,
   *   which is the single artefact `ship-lod1`'s fail list names outright, and
   *   it is what was costing 40 px of ventral mass and 25 px of dorsal boom.
   *
   * So the coarser rungs inherit the tessellation but not the culling. LOD1
   * builds every part LOD0 builds. LOD2 keeps the floor no higher than 2 % of
   * the hull's own length — a part shorter than that is genuinely under a
   * pixel at 40–120 px — instead of the ladder's own value, which on the hero
   * hull is 3.1 m on a 62 m ship, i.e. a fifth of the beam.
   *
   * The triangles this costs come out of greeble instancing, which is detail
   * nobody can resolve at those ranges: see `detailTriangleBudget`.
   */
  private shapeDescriptor(level: number): LodLevel {
    const lod = this.lodDescriptor(level);
    if (level <= 0 || level >= IMPOSTOR_LEVEL) return lod;
    const fine = this.lodDescriptor(0);
    if (level === 1) {
      return { ...lod, minFeatureKm: fine.minFeatureKm, connections: fine.connections };
    }
    const floor = Math.min(lod.minFeatureKm, this.blueprint.dimensions.lengthKm * 0.02);
    return { ...lod, minFeatureKm: floor, connections: fine.connections };
  }

  private build(level: number): BuiltLod {
    if (level >= IMPOSTOR_LEVEL) return this.buildImpostor();

    const bp = this.blueprint;
    const lod = this.shapeDescriptor(level);
    const faction = factionById(bp.factionId);

    const hb = new HullBuilder();
    const occluders: OccluderSphere[] = [];
    const seats: SurfaceSeat[] = [];

    const base: VolumeBuildOptions = {
      lod,
      hullLengthKm: bp.dimensions.lengthKm,
      panelSizeKm: shipPanelSizeKm(bp),
      curvature: faction.surface.curvature,
      occluders,
      seats,
    };

    // Structure first, so the spine's members are already seats and casters by
    // the time the hull plating and then the fittings go on over them.
    buildSpine(bp.structuralSpine, hb, { ...base });
    for (const v of bp.primaryVolumes) {
      buildVolume(v, hb, {
        ...base,
        // GeometryRef is a discriminated union — a damage event can point at a
        // module, a spine node or an engine as easily as at a volume.
        damage: bp.damageHistory.filter(
          (d) => d.target.kind === 'volume' && d.target.volumeId === v.id,
        ),
        repairs: bp.repairHistory.filter(
          (r) => r.target.kind === 'volume' && r.target.volumeId === v.id,
        ),
      });
    }

    // What the structure left behind is what detail may spend. Read before any
    // bake, because a bake adds to the same counter.
    const structureTriangles = hb.triangleCount;

    // Greebles last, and never to rescue a weak form (BRIEF §4).
    const details = this.detail(seats, occluders);
    this.detailKeep(this.detailTriangleBudget(level, structureTriangles));

    // The dense families earn a draw call; the long tail is welded into the
    // hull buffer, which costs vertices once instead of a bind every frame.
    //
    // WHICH FAMILY IS WHICH IS DECIDED ONCE, on the full scatter, so a family
    // can never migrate as the budget tightens — but a batch that has been
    // trimmed to three instances is not worth a bind at any budget, so a rung
    // may additionally *demote* one to the baked path. That direction is safe
    // where the other is not, for a reason worth stating: `ShipMaterialSet`
    // binds `greeble` to the very same material object as `hull` (see there),
    // so the two paths differ in how the geometry is submitted and in nothing
    // that reaches a pixel. The trigger is the coarse rungs, where LOD2 was
    // spending five instanced draws on twelve fittings — 8 draw calls for a
    // 40-pixel ship, which at forty ships in a system is the frame.
    for (let i = 0; i < details.length; i++) {
      const d = details[i]!;
      const n = this.keep[i]!;
      if (n <= 0 || (d.instanced && n >= INSTANCE_MIN)) continue;
      bakeScatter(trimmed(d.scatter, n), hb);
    }

    const geometry = hb.toGeometry(true);
    const group = new Group();
    const hull = new Mesh(geometry, this.materials.hull);
    // Culled, with the bounding sphere `toGeometry` computed from the actual
    // vertices. The comment that used to sit here ("the ship is the near
    // subject and the integrator culls it as a whole") is true of the showroom
    // and false of `Universe.ts`, where a system holds dozens of ships and
    // ARCHITECTURE §5's 400 draw calls are for the whole frame.
    hull.frustumCulled = true;
    group.add(hull);

    let triangles = hb.triangleCount;
    const instances: InstancedMesh[] = [];
    for (let i = 0; i < details.length; i++) {
      const d = details[i]!;
      const n = this.keep[i]!;
      if (!d.instanced || n < INSTANCE_MIN) continue;
      const im = this.makeInstanced(d.scatter, n);
      instances.push(im);
      group.add(im);
      triangles += d.triPerInstance * n;
    }

    // Only now are the part ids known, so this is the first moment the
    // material can be told which caster belongs to which surface.
    const occ = this.packOccluders(occluders);

    group.visible = false;
    this.object3d.add(group);

    return {
      group,
      geometry,
      instances,
      triangles,
      drawCalls: 1 + instances.length,
      occSpheres: occ.spheres,
      occParts: occ.parts,
      occCount: occ.count,
    };
  }

  /**
   * Level 3 is one billboard, not a fourth hull.
   *
   * BRIEF §6 budgets the impostor at one quad. Treating it as another rung of
   * the ladder gave it its own 900–3,200 triangle hull mesh plus every
   * propulsion draw on top — up to 13 k triangles and four draw calls for a
   * ship a few pixels across, which at forty ships in a system is the whole
   * frame's draw-call budget spent on nothing anyone can see.
   *
   * The quad is a CYLINDRICAL billboard, not a screen-aligned one: it spins
   * about the hull's own long axis to face the camera and keeps its length
   * along that axis. A ship at 30 px still has an attitude — it is pointing
   * somewhere — and a screen-aligned square throws that away and reads as a
   * blob. Its cross-axis half-height is the support of the hull's elliptical
   * cross-section in whatever direction the roll leaves upright, so the quad
   * is the ship's real projected height from the side and its real width from
   * above, rather than the bounding sphere both times.
   */
  private buildImpostor(): BuiltLod {
    const desc = impostorFor(this.blueprint.primaryVolumes);
    const geometry = buildImpostorQuad(desc);
    const group = new Group();
    const quad = new Mesh(geometry, this.materials.hull);
    quad.name = `impostor:${this.blueprint.id}`;
    quad.frustumCulled = true;

    const [lo, hi] = desc.axisRangeKm;
    this.impostorQuadRadius = Math.max(desc.radiusKm, 1e-6);
    this.impostorHalfLength = Math.max((hi - lo) * 0.5, 1e-6);
    // `impostorFor` picks the axis from the bounds, so a tower archetype's
    // long axis is +Y and its "side" profile is the Z extent. Follow it rather
    // than assuming +Z, or the impostor is built across the ship.
    const a = desc.axis;
    this.impostorAxis.set(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0);
    // side = the axis `sideProfile` was measured on, plan = the other one.
    if (a === 2) {
      this.impostorPlanAxis.set(1, 0, 0);
      this.impostorSideAxis.set(0, 1, 0);
    } else if (a === 1) {
      this.impostorPlanAxis.set(1, 0, 0);
      this.impostorSideAxis.set(0, 0, 1);
    } else {
      this.impostorPlanAxis.set(0, 0, 1);
      this.impostorSideAxis.set(0, 1, 0);
    }
    this.impostorPlanHalf = maxOf(desc.planProfile);
    this.impostorSideHalf = maxOf(desc.sideProfile);
    quad.position.copy(this.impostorAxis).multiplyScalar((lo + hi) * 0.5);
    quad.scale.set(
      this.impostorHalfLength / this.impostorQuadRadius,
      Math.max(this.impostorSideHalf, 1e-6) / this.impostorQuadRadius,
      1,
    );

    group.add(quad);
    group.visible = false;
    this.object3d.add(group);
    this.impostor = quad;
    // Stand it up side-on before anything has told it where the camera is.
    // `Box3.setFromObject` walks invisible children, so a quad left in the
    // geometry's own XY plane puts the hull's whole LENGTH across the ship's
    // X axis and inflates the ship's world AABB by 5x at every other rung.
    this.billboardNormal.copy(this.impostorPlanAxis);
    this.billboardUp.crossVectors(this.billboardNormal, this.impostorAxis).normalize();
    this.billboardBasis.makeBasis(this.impostorAxis, this.billboardUp, this.billboardNormal);
    quad.quaternion.setFromRotationMatrix(this.billboardBasis);
    if (this.lastView) this.orientImpostor(this.lastView);

    // No analytic casters: there is no surface left for a contact shadow to
    // land on. An empty set is uploaded so the rung does not inherit whichever
    // rung happened to be built before it.
    const idx = geometry.getIndex();
    return {
      group,
      geometry,
      instances: [],
      // Measured, not declared: `buildImpostorQuad` cuts the hull's outline
      // into the strip and the station count is its business, not this file's.
      triangles: idx ? idx.count / 3 : 0,
      drawCalls: 1,
      occSpheres: new Float32Array(0),
      occParts: new Float32Array(0),
      occCount: 0,
    };
  }

  /**
   * Place every greeble family ONCE, at LOD0's parameters.
   *
   * Called from the first `build`, which the constructor guarantees is LOD0,
   * so the seats and casters the scatter rejects against are the finest hull's
   * — the one the placement is authored for. Coarser rungs reuse this list;
   * the millimetres by which a coarser section wall has moved under a fitting
   * are two orders of magnitude below a pixel at the range those rungs serve,
   * and they buy a silhouette that cannot pop.
   */
  private detail(seats: SurfaceSeat[], occluders: OccluderSphere[]): DetailBatch[] {
    if (this.details) return this.details;
    const bp = this.blueprint;
    const faction = factionById(bp.factionId);
    const lod = this.lodDescriptor(0);

    const scatters = scatterGreebles({
      targets: bp.primaryVolumes.map((v) => ({ volume: v, density: 1 })),
      families: greebleVocabulary(faction),
      seed: bp.renderProfile.detailSeed,
      lod,
      hullLengthKm: bp.dimensions.lengthKm,
      cache: this.cache,
      budget: Math.round(lod.triangleBudget * lod.greebleFraction * 0.02),
      seats,
      occluders,
      outOccluders: this.detailOccluders,
    });

    const split = splitScatterBudget(scatters, MAX_GREEBLE_BATCHES);
    const instanced = new Set(split.instanced);
    // Two passes, and they cannot be one: "is this fitting at the ship's
    // ventral extreme" is a question about every family at once, and a
    // per-family ranking that answered it from its own instances alone would
    // protect the lowest hatch on the ship as if it were the keel.
    const band = bp.dimensions.lengthKm * EXTREME_BAND_FRACTION;
    measureExtremes(scatters, this.detailExtremes, this.detailExtremeOwner);
    const bnd = bp.dimensions.bounds;
    this.detailBox[0] = (bnd.min[0] + bnd.max[0]) * 0.5;
    this.detailBox[1] = (bnd.min[1] + bnd.max[1]) * 0.5;
    this.detailBox[2] = (bnd.min[2] + bnd.max[2]) * 0.5;
    this.detailBox[3] = Math.max((bnd.max[0] - bnd.min[0]) * 0.5, 1e-9);
    this.detailBox[4] = Math.max((bnd.max[1] - bnd.min[1]) * 0.5, 1e-9);
    this.detailBox[5] = Math.max((bnd.max[2] - bnd.min[2]) * 0.5, 1e-9);

    const out: DetailBatch[] = [];
    for (let f = 0; f < scatters.length; f++) {
      const s = scatters[f]!;
      const triPerInstance = s.count > 0 ? s.triangles / s.count : 0;
      const ranked = rankDetail(
        s,
        f,
        triPerInstance,
        this.detailBox,
        this.detailExtremes,
        this.detailExtremeOwner,
        band,
        Math.max(bp.dimensions.lengthKm, 1e-9),
      );
      out.push({
        scatter: s,
        triPerInstance,
        instanced: instanced.has(s),
        score: ranked.score,
        protect: ranked.protect,
      });
      this.keep.push(s.count);
      this.capped.push(false);
    }
    this.details = out;
    return out;
  }

  /**
   * How many triangles the detail layer may spend at this rung.
   *
   * Two ceilings, and the tighter one wins: the share BRIEF §6 allows detail
   * of the rung's budget, and whatever the structure actually left behind.
   * Detail is the last thing generated and the first thing that gives way
   * (BRIEF §4) — which is the whole point, because holding the primary and
   * secondary masses through LOD1 has to be paid for out of something, and
   * sub-metre fittings at 120–400 px are the only honest source.
   */
  private detailTriangleBudget(level: number, structureTriangles: number): number {
    const lod = this.lodDescriptor(level);
    /**
     * The cap is the TIGHTER of the blueprint's ladder value and BRIEF §6's.
     *
     * `LodLevel.triangleBudget` is `120000 · sizeK` with `sizeK` running to
     * 1.6, so a capital hull is handed a 40 k licence for a rung the brief caps
     * at 25 k — and this method used to spend against the licence. Measured on
     * a 1.4 km miner: LOD1 came out at 38,516 triangles against a 25,000 cap,
     * 17,550 of them detail nobody had authorised. `volumes.ts` already takes
     * this same `min` and states why: the brief is the contract, the ladder is
     * advice, and a blueprint may ask for less than the brief allows but never
     * for more.
     */
    const brief = BRIEF_TRIANGLE_CAP[Math.min(Math.max(level | 0, 0), 3)] ?? 0;
    const cap = Math.min(lod.triangleBudget, brief);
    const spent = structureTriangles + this.propulsionTriangles(level);
    /**
     * ...and the floor under the share, which is what stops a coarse rung
     * changing shape.
     *
     * `greebleFraction` is 0 at LOD2 and above, so the ordinary share is zero
     * there and the whole detail layer went in one step — every volume on the
     * ship lost the hardware round its rim, and `ship-lod2`'s brief says the
     * silhouette is the only thing that matters at that rung. The reserve is
     * paid for on the other side by `volumes.ts:COARSE_SURFACE_SHARE`, which
     * stops the skin taking 90 % of a rung it does not need, so this is a
     * reallocation and never an overspend: both terms are bounded by what the
     * cap has left after the hull and the drive, and a rung that is already
     * over reserves nothing.
     */
    const share = Math.min(cap * GREEBLE_TRI_SHARE, Math.max(0, cap - spent));
    // The reserve — and only the reserve — is measured against BRIEF §6's cap
    // rather than the tighter of the two. The ladder's own value is a
    // tessellation hint the generator derived from the hull's size class; the
    // brief's is the number the review manifest is checked against. Spending
    // the gap between them is allowed when what it buys is the outline and
    // never when it is ordinary detail, which is the difference between the
    // hero's LOD2 having 265 triangles for its silhouette hardware and having
    // 632 — the difference between holding two of its nine support-owning
    // fittings and holding five.
    const reserve = Math.min(brief * SILHOUETTE_RESERVE, Math.max(0, brief - spent));
    return Math.max(share, reserve);
  }

  /**
   * What the drive costs AT THIS RUNG, measured off its own scene graph.
   *
   * BRIEF §6's per-rung triangle budget is for the *ship*, not for the hull,
   * so the drive has to be subtracted before the hull's detail layer is told
   * what it may spend. It used to be measured once and charged at that figure
   * to every rung, because `propulsion` genuinely did build one bell set and
   * draw it from arm's length to the horizon. It no longer does: it has four
   * rungs of its own, and `setLod` now hands it the level (see there). One
   * measurement per rung, taken by walking the rung that is parented — the
   * module detaches the others precisely so that this traversal is true.
   *
   * Measuring rather than declaring, for the same reason `stats()` does: a
   * number this file guessed would be wrong the first time propulsion changed.
   */
  private propulsionTriangles(level: number): number {
    const i = Math.min(Math.max(level | 0, 0), 3);
    const cached = this.propulsionTri[i]!;
    if (cached >= 0) return cached;
    // Measuring a rung means having it parented, which means borrowing the
    // drive for the length of one traversal. Put it back afterwards: `build`
    // runs for rungs the ship is not showing (see `warmStep`), and a drive
    // left on a rung the hull is not on is a visible pop for a measurement.
    const restore = this.active >= 0 ? this.active : 0;
    this.propulsion.setLod(i as 0 | 1 | 2 | 3);
    let all = 0;
    this.propulsion.object3d.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh !== true) return;
      const index = mesh.geometry.getIndex();
      const position = mesh.geometry.getAttribute('position');
      const verts = index ? index.count : position ? position.count : 0;
      const im = mesh as InstancedMesh;
      // Counted whether or not it is visible right now: the plume is hidden at
      // idle and a budget that only holds while the drive is cold is not one.
      all += (verts / 3) * (im.isInstancedMesh === true ? im.count : 1);
    });
    this.propulsionTri[i] = all;
    if (restore !== i) this.propulsion.setLod(restore as 0 | 1 | 2 | 3);
    return all;
  }

  /**
   * Fill `keep[i]` with how many instances of family `i` this rung draws.
   *
   * One ranking across all families, best outline-per-triangle first, spent
   * until the budget runs out. Because `rankDetail` sorted each family into
   * that same order, the answer is a prefix of every family's arrays — so the
   * per-instance channels still line up with the matrices, and a coarser
   * rung's set is always a strict subset of a finer one's. That is the
   * property that makes the transition invisible: hardware can leave, nothing
   * can arrive.
   *
   * The fittings that own the ship's own supports are first in that order by
   * construction (`PROTECT_RANK`), so a rung buys its outline before it buys
   * anything else and gives it up last. That is what a rung that drops them
   * loses: not detail, but length — which is what `ship-lod2`'s brief calls a
   * whole mass collapsing. On the hero, LOD2 buys nine of the twelve for 852
   * of its 2,888 triangles, and its outline then spans exactly the pixels
   * LOD0's does on both screen axes.
   */
  private detailKeep(budget: number): void {
    const details = this.details;
    if (!details) return;
    let total = 0;
    for (let i = 0; i < details.length; i++) {
      this.keep[i] = 0;
      total += details[i]!.scatter.triangles;
    }
    if (total <= budget) {
      for (let i = 0; i < details.length; i++) this.keep[i] = details[i]!.scatter.count;
      return;
    }
    for (let i = 0; i < details.length; i++) this.capped[i] = false;
    let spent = 0;
    for (;;) {
      let best = -1;
      let bestScore = -Infinity;
      for (let i = 0; i < details.length; i++) {
        const d = details[i]!;
        const k = this.keep[i]!;
        if (k >= d.scatter.count || this.capped[i] === true) continue;
        const s = d.score[k]!;
        // Ties break on family order, which `scatterGreebles` derives from the
        // faction vocabulary — never on floating-point luck.
        if (s > bestScore) {
          bestScore = s;
          best = i;
        }
      }
      if (best < 0) break;
      const cost = details[best]!.triPerInstance;
      if (spent + cost > budget) {
        // Retire this family and carry on rather than ending the whole spend.
        // Families do not cost the same — a ladder is 168 triangles and a
        // bracket 36 — so stopping at the first thing that will not fit left
        // 2,209 of LOD1's 21,939 triangles unspent while the outline was
        // missing hardware that would have fitted in them four times over.
        this.capped[best] = true;
        continue;
      }
      spent += cost;
      this.keep[best]!++;
    }
  }

  private makeInstanced(s: InstancedScatter, count: number): InstancedMesh {
    // `s.geometry` already carries this batch's `aSurf`/`aBent`/`aShade` as
    // InstancedBufferAttributes — `GreebleCache.instanceView` binds them, and
    // rebinding them here was building three throwaway attribute objects over
    // the very same arrays on every rung.
    const im = new InstancedMesh(s.geometry, this.materials.greeble, count);
    // The batch geometry is authored in a unit footprint and sized by the
    // instance matrix, so three's own `computeBoundingSphere` — which walks
    // the matrices — gives a correct, tight bound. Measured on the hero:
    // 30 × 52 × 60 m against a 29 × 50 × 62 m blueprint box.
    im.frustumCulled = true;
    im.name = `greeble:${s.kind}`;
    // The matrices arrive already packed; write them straight through rather
    // than round-tripping every instance via Matrix4.
    im.instanceMatrix.array.set(s.matrices.subarray(0, count * 16));
    im.instanceMatrix.needsUpdate = true;
    return im;
  }

  /**
   * Sort casters by radius before handing them over. The list is capped, and a
   * whip antenna must never evict a radiator — the biggest masses are the ones
   * whose contact shadow the eye actually reads.
   *
   * The greeble casters are the same list at every rung even when the rung
   * draws fewer fittings. That is deliberate: `ship-lod1` fails a rung whose
   * hull *value* shifts, and a caster whose fitting is a fraction of a pixel
   * still darkens the plate by exactly what it darkened it by at LOD0.
   */
  private packOccluders(hull: OccluderSphere[]): {
    spheres: Float32Array; parts: Float32Array; count: number;
  } {
    const all = hull.concat(this.detailOccluders);
    all.sort((a, z) => z.r - a.r);
    const n = Math.min(all.length, this.materials.occluderSlots);
    const spheres = new Float32Array(n * 4);
    const parts = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = all[i]!;
      spheres[i * 4] = o.x;
      spheres[i * 4 + 1] = o.y;
      spheres[i * 4 + 2] = o.z;
      spheres[i * 4 + 3] = o.r;
      parts[i] = o.part;
    }
    return { spheres, parts, count: n };
  }

  /**
   * Build the rungs the player has not reached yet, off the critical path.
   *
   * `setLod` used to build lazily, so the first time a ship receded across a
   * LOD boundary it paid 3.7–6.8 ms of geometry work *inside that frame* —
   * during play, while the camera was moving, and again for every new ship in
   * every encounter. Spending it in the frames just after the ship spawns is
   * strictly better: the cost is the same, it is bounded per frame, and it is
   * paid once at a moment the player is not crossing anything.
   *
   * The impostor goes first because it is free, then LOD1, which is the band
   * the ship spends most of its life in.
   */
  private warmStep(): void {
    const t0 = performance.now();
    const perFrame = Math.max(1, this.quality.patchBuildBudget);
    const fine = this.lodDescriptor(0).triangleBudget;
    let built = 0;
    while (this.warm.length > 0 && built < perFrame) {
      const level = this.warm[0]!;
      // A rung's cost tracks its triangle budget almost exactly — LOD0 at
      // 112 k took 20 ms and LOD1 at 23 k took 4.2 ms on the same hull — so
      // LOD0's measured build time predicts the rest to within a millisecond.
      // Predicting rather than measuring afterwards is the difference between
      // a frame that overruns and one that declines to start the work.
      const predicted = this.lod0BuildMs * (this.lodDescriptor(level).triangleBudget / Math.max(fine, 1));
      // Always let the first rung of a frame through: a rung cannot be split,
      // and refusing every rung that is bigger than the slice never builds.
      if (built > 0 && performance.now() - t0 + predicted > WARM_BUDGET_MS) break;
      this.warm.shift();
      if (!this.lods[level]) this.lods[level] = this.build(level);
      built++;
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  setLod(level: 0 | 1 | 2 | 3): void {
    if (this.disposed || level === this.active) return;
    // Normally already prebuilt by `warmStep`. The fallback stays because a
    // correct frame beats a smooth one: a ship that has not had three updates
    // yet must still be able to change rung.
    let built = this.lods[level];
    if (!built) {
      const t0 = performance.now();
      built = this.lods[level] = this.build(level);
      if (level === 0) this.lod0BuildMs = performance.now() - t0;
      const queued = this.warm.indexOf(level);
      if (queued >= 0) this.warm.splice(queued, 1);
    }
    if (this.active >= 0) {
      const prev = this.lods[this.active];
      if (prev) prev.group.visible = false;
    }
    built.group.visible = true;
    this.active = level;

    // The casters belong to the rung that is drawing, not to the rung that was
    // built last — and with the ladder prebuilt those are different things.
    // The impostor publishes none, and publishing *none* would strip the
    // casters off every other ship sharing this material, so it is the one
    // rung that leaves the uniform where it found it.
    if (built.occCount > 0) {
      this.materials.setOccluders(built.occSpheres, built.occParts, built.occCount);
    }
    // The drive goes to the same rung as the hull. `propulsion.ts` builds four
    // rungs of its own and says in as many words that `ShipMesh.setLod` should
    // forward to it; nothing did, so the drive drew its LOD0 bells at every
    // range and this file compensated by hiding them wholesale above LOD1.
    // Both halves of that were wrong: 6,744 triangles of bell — a third of
    // LOD1's whole ship budget — were charged to a rung that had reduced
    // nothing, which is what starved the detail layer that carries the
    // outline; and hiding them at LOD2 deleted a mass the module's own ladder
    // had already decided to keep.
    this.propulsion.setLod(level);
    if (level >= IMPOSTOR_LEVEL && this.lastView) this.orientImpostor(this.lastView);

    // Materials are shared, so the per-ship uniforms have to be current at
    // draw time, not at tick time — hence onBeforeRender rather than update().
    for (const child of built.group.children) {
      child.onBeforeRender = this.pushUniforms;
    }
  }

  /** Spin the impostor quad about the hull's long axis to face the camera. */
  private orientImpostor(view: ViewState): void {
    const quad = this.impostor;
    if (!quad) return;
    this.toCamera.copy(view.cameraLocal).sub(quad.position);
    const along = this.toCamera.dot(this.impostorAxis);
    this.billboardNormal.copy(this.toCamera).addScaledVector(this.impostorAxis, -along);
    // Dead astern or dead ahead: any roll is as right as any other.
    if (this.billboardNormal.lengthSq() < 1e-18) this.billboardNormal.copy(this.impostorSideAxis);
    this.billboardNormal.normalize();
    // Right-handed: x = long axis, z = towards the camera, y = z × x.
    this.billboardUp.crossVectors(this.billboardNormal, this.impostorAxis).normalize();
    this.billboardBasis.makeBasis(this.impostorAxis, this.billboardUp, this.billboardNormal);
    quad.quaternion.setFromRotationMatrix(this.billboardBasis);

    // Support of an ellipse with half-axes (plan, side) in the direction the
    // roll left upright. From the side that is the hull's height, from above
    // its beam, and in between the honest blend of the two.
    const dp = this.billboardUp.dot(this.impostorPlanAxis) * this.impostorPlanHalf;
    const ds = this.billboardUp.dot(this.impostorSideAxis) * this.impostorSideHalf;
    quad.scale.set(
      this.impostorHalfLength / this.impostorQuadRadius,
      Math.max(Math.sqrt(dp * dp + ds * ds), 1e-6) / this.impostorQuadRadius,
      1,
    );
  }

  private readonly pushUniforms = (): void => {
    if (this.lastView) this.materials.apply(this.lastView, this.surfaceState);
  };

  update(dt: number, ctx: EngineContext, view: ViewState, state: ShipDriveState): void {
    if (this.disposed) return;
    this.lastView = view;
    this.surfaceState.throttle = state.throttle;
    this.surfaceState.heat = state.heating;

    this.drive.throttle = state.throttle;
    this.drive.boost = state.boost;
    this.drive.heating = state.heating;
    this.drive.translation.copy(state.rcs);
    this.propulsion.update(dt, ctx, view, this.drive as DriveState);
    if (this.active >= IMPOSTOR_LEVEL) this.orientImpostor(view);
    // The only allocating branch in this method, and it runs at most three
    // times in a ship's life. Once `warm` is empty the steady state is
    // allocation-free, which is what BRIEF §6 asks for.
    if (this.warm.length > 0) this.warmStep();
  }

  setFillLight(color: Color): void {
    this.fill.copy(color);
    this.propulsion.fillColor.copy(color);
  }

  /**
   * Diagnostics for the review manifest — measured, not declared.
   *
   * This used to add a literal `+ 1` for propulsion and count only the hull
   * group's triangles, which under-reported by 2 draw calls and 4,584
   * triangles on the hero and by 5,600 on a 139 m science hull. The error ran
   * one way: it hid budget failures, and it hid them worst at the coarse rungs
   * where the budget is tightest. A traversal cannot drift from the truth
   * because it *is* the truth — it counts what the renderer will count.
   */
  stats(): { lod: number; triangles: number; drawCalls: number } {
    let drawCalls = 0;
    let triangles = 0;
    this.object3d.traverseVisible((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh !== true) return;
      const index = mesh.geometry.getIndex();
      const position = mesh.geometry.getAttribute('position');
      const verts = index ? index.count : position ? position.count : 0;
      const im = mesh as InstancedMesh;
      const count = im.isInstancedMesh === true ? im.count : 1;
      drawCalls++;
      triangles += (verts / 3) * count;
    });
    return { lod: this.active, triangles, drawCalls };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const built of this.lods) {
      if (!built) continue;
      built.geometry.dispose();
      // Instanced greeble geometry is owned by the shared cache, not by the
      // mesh — disposing it here would pull it out from under another ship,
      // and now also out from under this ship's other rungs, which draw the
      // same batch views.
      for (const im of built.instances) im.dispose();
      built.group.removeFromParent();
    }
    this.cache.dispose();
    this.propulsion.dispose();
    this.materials.dispose();
    this.object3d.removeFromParent();
  }
}

/**
 * A prefix view of a batch. The arrays are shared by reference and already in
 * rank order, so nothing is copied and instance `i` still owns channel `i`.
 */
function trimmed(s: InstancedScatter, count: number): InstancedScatter {
  return count >= s.count ? s : { ...s, count, triangles: (s.triangles / s.count) * count };
}

/**
 * The six axis-aligned supports of everything the detail layer placed, as the
 * *tips* of the fittings rather than their mounting points: +x, +y, +z, −x,
 * −y, −z. A fitting is only an extreme if the end that sticks out is.
 *
 * `owner` is filled alongside them with the family and instance that holds
 * each one — 12 integers, six (family, instance) pairs. Those six fittings,
 * and only those six, are what the ship's drawn length, beam and height are
 * made of, so they are the set `detailKeep` refuses to spend.
 */
function measureExtremes(
  scatters: readonly InstancedScatter[],
  out: Float32Array,
  owner: Int32Array,
): void {
  out.fill(-Infinity);
  owner.fill(-1);
  for (let f = 0; f < scatters.length; f++) {
    const s = scatters[f]!;
    for (let i = 0; i < s.count; i++) {
      const o = i * 16;
      // Translation plus column 1 — the mounting normal scaled by the
      // fitting's own height, which is exactly the vector from the plating to
      // the tip.
      const tx = s.matrices[o + 12]! + s.matrices[o + 4]!;
      const ty = s.matrices[o + 13]! + s.matrices[o + 5]!;
      const tz = s.matrices[o + 14]! + s.matrices[o + 6]!;
      for (let d = 0; d < EXTREME_DIR_COUNT; d++) {
        const p =
          tx * EXTREME_DIRS[d * 3]! + ty * EXTREME_DIRS[d * 3 + 1]! + tz * EXTREME_DIRS[d * 3 + 2]!;
        if (p > out[d]!) {
          out[d] = p;
          owner[d * 2] = f;
          owner[d * 2 + 1] = i;
        }
      }
    }
  }
}

/**
 * Rank a family's instances by how much of the ship's OUTLINE they are per
 * triangle they cost, and permute the batch into that order.
 *
 * WHY THIS IS NOT A SIZE SORT ANY MORE. The previous ranking was
 * `sy + 0.45·max(sx, sz)` — the fitting's own size — spent by a greedy that
 * compared sizes across families and ignored what each family cost. Three
 * things were wrong with it, and together they are the whole of the LOD1 pop:
 *
 *   1. SIZE IS NOT OUTLINE. A slab bolted to the inboard face of a pylon, deep
 *      in the canyon between the hull and a nacelle, is never on any silhouette
 *      from any angle. It outranked the hardware on the ventral rim, which is
 *      on the silhouette from half of them.
 *   2. A RANKING WITHOUT A PRICE IS NOT A BUDGET. A ladder costs 168 triangles
 *      and a bracket 36. Comparing their sizes and not their prices spent the
 *      rung's whole detail allowance on a handful of expensive fittings.
 *   3. EXTENT IS NOT AREA. A mast is 124 triangles of almost no projected
 *      area, so any honest value-per-triangle ranking drops it first — and it
 *      is the dorsal boom whose disappearance the critic measured in pixels.
 *
 * So: the value of a fitting is the outline area it adds *when it is on the
 * rim*, which is its standoff times its width; that is multiplied by how far
 * its tip actually reaches out of the hull along its own mounting normal, so
 * hardware pointing into a gap is discounted and hardware on the outer skin is
 * not; the result is divided by the triangles it costs, which makes the
 * greedy in `detailKeep` a real value-density knapsack; and finally anything
 * standing at one of the ship's six extremes is lifted clear of the ranking
 * altogether, because losing an extreme is losing a shape and not losing a
 * detail.
 *
 * @param box    cx, cy, cz, hx, hy, hz — the blueprint's declared bounds.
 * @param band   how close to an extreme still counts as owning it, km.
 */
function rankDetail(
  s: InstancedScatter,
  family: number,
  triPerInstance: number,
  box: Float32Array,
  extremes: Float32Array,
  owner: Int32Array,
  band: number,
  hullLengthKm: number,
): { score: Float32Array; protect: number } {
  const n = s.count;
  const score = new Float32Array(n);
  const order: number[] = [];
  const cost = Math.max(triPerInstance, 1);
  const inv = 1 / Math.max(band, 1e-9);
  let protect = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    const sx = Math.hypot(s.matrices[o]!, s.matrices[o + 1]!, s.matrices[o + 2]!);
    const sy = Math.hypot(s.matrices[o + 4]!, s.matrices[o + 5]!, s.matrices[o + 6]!);
    const sz = Math.hypot(s.matrices[o + 8]!, s.matrices[o + 9]!, s.matrices[o + 10]!);
    // The mounting normal, and the tip it carries.
    const h = sy > 1e-12 ? 1 / sy : 0;
    const nx = s.matrices[o + 4]! * h;
    const ny = s.matrices[o + 5]! * h;
    const nz = s.matrices[o + 6]! * h;
    const tx = s.matrices[o + 12]! + s.matrices[o + 4]!;
    const ty = s.matrices[o + 13]! + s.matrices[o + 5]!;
    const tz = s.matrices[o + 14]! + s.matrices[o + 6]!;
    // How far out of the hull the tip reaches along its own normal, as a
    // fraction of the hull box's support in that direction. ~1 on the outer
    // skin pointing outward; small or negative down a canyon or under a wing.
    const support = Math.abs(nx) * box[3]! + Math.abs(ny) * box[4]! + Math.abs(nz) * box[5]!;
    const reach =
      ((tx - box[0]!) * nx + (ty - box[1]!) * ny + (tz - box[2]!) * nz) / Math.max(support, 1e-9);
    const exposure = reach < 0 ? 0 : reach > 1 ? 1 : reach;
    // The bump it adds to the outline: standoff × width, weighted so a fitting
    // that is all height still counts as more than a flush plate of the same
    // footprint.
    const value =
      sy * (Math.max(sx, sz) * 0.75 + sy * 0.25) * (0.12 + 0.88 * exposure * exposure);
    // Does it own one of the ship's six extremes?
    let edge = 0;
    for (let d = 0; d < EXTREME_DIR_COUNT; d++) {
      const p =
        tx * EXTREME_DIRS[d * 3]! + ty * EXTREME_DIRS[d * 3 + 1]! + tz * EXTREME_DIRS[d * 3 + 2]!;
      const near = 1 - (extremes[d]! - p) * inv;
      if (near > edge) edge = near;
    }
    if (edge < 0) edge = 0;
    // The bonus is a bias inside the ranking; OWNING a support is a separate
    // and much harder statement, made about a handful of fittings on the whole
    // ship. Everything merely *near* an extreme competes for budget like
    // everything else — it just competes well.
    let owned = 0;
    for (let d = 0; d < EXTREME_DIR_COUNT; d++) {
      if (owner[d * 2] === family && owner[d * 2 + 1] === i) owned++;
    }
    if (owned > 0) protect++;
    // Held instances are offset clear of every unheld score so the sort below
    // cannot interleave them, which is what keeps "held" a prefix and
    // therefore expressible as a count.
    const density = (value / cost) * (1 + EXTREME_BONUS * edge * edge);
    // Held fittings are ordered among THEMSELVES by how many supports they own
    // and then by how far they stand proud — never by density, which is the
    // one ranking that is certainly wrong here. A mast is the worst value per
    // triangle on the ship and it is also four metres of ship; a hatch at the
    // same extreme is 36 triangles and thirty centimetres. When a rung can
    // only afford two held fittings it has to buy the metres, not the count.
    // Both terms are below 1, so neither can reorder the one above it, and
    // density remains the final tiebreak.
    score[i] =
      owned > 0
        ? PROTECT_RANK + owned + Math.min(sy / hullLengthKm, 0.9) + density
        : density;
    order.push(i);
  }
  // Placement index breaks ties, so the ranking is byte-identical on every
  // machine regardless of the sort implementation.
  order.sort((a, b) => score[b]! - score[a]! || a - b);

  const mats = s.matrices.slice();
  const surf = s.surf.slice();
  const bent = s.bent.slice();
  const shade = s.shade.slice();
  const ranked = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const i = order[k]!;
    s.matrices.set(mats.subarray(i * 16, i * 16 + 16), k * 16);
    s.surf.set(surf.subarray(i * 4, i * 4 + 4), k * 4);
    s.bent.set(bent.subarray(i * 4, i * 4 + 4), k * 4);
    s.shade[k] = shade[i]!;
    ranked[k] = score[i]!;
  }
  return { score: ranked, protect };
}

function maxOf(a: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! > m) m = a[i]!;
  return m;
}

/** The factory the showroom and the universe both wire up. */
export function createShipVisual(bp: ShipBlueprint, quality: QualitySettings): ShipVisual {
  return new ShipMesh(bp, quality);
}
