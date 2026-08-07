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
  NormalBlending,
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

/** The rung at which the ship stops being geometry and becomes one quad. */
const IMPOSTOR_LEVEL = 3;

/**
 * Level at and beyond which the engine bells and their fixtures stand down.
 *
 * At LOD2 the hull is 40–120 px. A nozzle throat is under a pixel of machined
 * metal; the additive plume and the navigation lights are the entire read, and
 * they are what `ship-extreme-distance` asks to still be there. So the *solid*
 * propulsion hardware goes and the emitters stay.
 */
const PROPULSION_HARDWARE_LEVEL = 2;

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

  /** Propulsion meshes stood down at the coarse rungs. Kept so restore is O(k). */
  private readonly stoodDown: Mesh[] = [];
  /** Measured once, in `propulsionTriangles`. -1 = not yet measured. */
  private propulsionTriAll = -1;
  private propulsionTriEmitters = -1;
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
    // Which family is which is decided once, on the full scatter, so a family
    // can never migrate between the two paths as the budget tightens.
    for (let i = 0; i < details.length; i++) {
      const d = details[i]!;
      const n = this.keep[i]!;
      if (d.instanced || n <= 0) continue;
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
      if (!d.instanced || n <= 0) continue;
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
    return {
      group,
      geometry,
      instances: [],
      triangles: 2,
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
    const out: DetailBatch[] = [];
    for (const s of scatters) {
      out.push({
        scatter: s,
        triPerInstance: s.count > 0 ? s.triangles / s.count : 0,
        instanced: instanced.has(s),
        score: rankDetail(s),
      });
      this.keep.push(s.count);
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
    const spent = structureTriangles + this.propulsionTriangles(level);
    return Math.max(
      0,
      Math.min(lod.triangleBudget * GREEBLE_TRI_SHARE, lod.triangleBudget - spent),
    );
  }

  /**
   * What the drive costs this rung, measured off its own scene graph.
   *
   * `propulsion` builds one engine bell set and never reduces it, and BRIEF
   * §6's per-rung triangle budget is for the *ship*, not for the hull. Nobody
   * was subtracting it, so a hull could sit inside its own budget while the
   * ship it belongs to was 7 % over. Measured rather than declared, for the
   * same reason `stats()` is: `ShipPropulsion` exposes no count, and a number
   * this file guessed would be wrong the first time propulsion changed.
   */
  private propulsionTriangles(level: number): number {
    const solid = level < PROPULSION_HARDWARE_LEVEL;
    if (solid && this.propulsionTriAll >= 0) return this.propulsionTriAll;
    if (!solid && this.propulsionTriEmitters >= 0) return this.propulsionTriEmitters;
    let all = 0;
    let emitters = 0;
    this.propulsion.object3d.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh !== true) return;
      const index = mesh.geometry.getIndex();
      const position = mesh.geometry.getAttribute('position');
      const verts = index ? index.count : position ? position.count : 0;
      const im = mesh as InstancedMesh;
      // Counted whether or not it is visible right now: the plume is hidden at
      // idle and a budget that only holds while the drive is cold is not one.
      const n = (verts / 3) * (im.isInstancedMesh === true ? im.count : 1);
      all += n;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (mat && (mat.transparent || mat.blending !== NormalBlending)) emitters += n;
    });
    this.propulsionTriAll = all;
    this.propulsionTriEmitters = emitters;
    return solid ? all : emitters;
  }

  /**
   * Fill `keep[i]` with how many instances of family `i` this rung draws.
   *
   * One ranking across all families, biggest hardware first, spent until the
   * budget runs out. Because `rankDetail` sorted each family into that same
   * order, the answer is a prefix of every family's arrays — so the per-
   * instance channels still line up with the matrices, and a coarser rung's
   * set is always a strict subset of a finer one's. That is the property that
   * makes the transition invisible: hardware can leave, nothing can arrive.
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
    let spent = 0;
    for (;;) {
      let best = -1;
      let bestScore = -Infinity;
      for (let i = 0; i < details.length; i++) {
        const d = details[i]!;
        const k = this.keep[i]!;
        if (k >= d.scatter.count) continue;
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
      if (spent + cost > budget) break;
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
    this.setPropulsionDetail(level);
    if (level >= IMPOSTOR_LEVEL && this.lastView) this.orientImpostor(this.lastView);

    // Materials are shared, so the per-ship uniforms have to be current at
    // draw time, not at tick time — hence onBeforeRender rather than update().
    for (const child of built.group.children) {
      child.onBeforeRender = this.pushUniforms;
    }
  }

  /**
   * Stand the solid propulsion hardware down at the coarse rungs.
   *
   * `propulsion` has no LOD of its own — it builds one engine bell set and
   * draws it at every range — so the assembler is the only place that knows
   * the ship is now 40 px wide. The discriminator is the blending mode, which
   * is the same one `Showroom.setSilhouette` uses and for the same reason:
   * normal-blended propulsion geometry is machined metal, additive propulsion
   * geometry is light. Metal under a pixel goes; light does not, because at
   * impostor range the plume and the navigation lights ARE the ship — which is
   * `ship-extreme-distance`'s own stated read, and killing them would make a
   * populated system look empty.
   */
  private setPropulsionDetail(level: number): void {
    if (level < PROPULSION_HARDWARE_LEVEL) {
      for (const m of this.stoodDown) m.visible = true;
      this.stoodDown.length = 0;
      return;
    }
    if (this.stoodDown.length > 0) return;
    this.propulsion.object3d.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh !== true || !mesh.visible) return;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (!mat || mat.transparent || mat.blending !== NormalBlending) return;
      mesh.visible = false;
      this.stoodDown.push(mesh);
    });
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
 * Rank a family's instances by how much of the ship's outline they are, and
 * permute the batch into that order.
 *
 * The instance matrix is placement × rotation × scale, so its column lengths
 * are the fitting's own size in kilometres — and column 1 is the mounting
 * normal, i.e. how far it stands proud of the plating. Height counts most
 * (a mast on the outline is the outline; a flush plate is not) and the plan
 * footprint counts for something (a wide bracket seen edge-on is a bump).
 *
 * Ranking is the entire trick. Dropping the *last* greebles placed drops a
 * random subset and the outline flickers; dropping the *smallest* is what LOD
 * has always meant, and it is what makes "sub-metre hardware may go, but the
 * primary and secondary masses must be untouched" achievable at all.
 */
function rankDetail(s: InstancedScatter): Float32Array {
  const n = s.count;
  const score = new Float32Array(n);
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    const sx = Math.hypot(s.matrices[o]!, s.matrices[o + 1]!, s.matrices[o + 2]!);
    const sy = Math.hypot(s.matrices[o + 4]!, s.matrices[o + 5]!, s.matrices[o + 6]!);
    const sz = Math.hypot(s.matrices[o + 8]!, s.matrices[o + 9]!, s.matrices[o + 10]!);
    score[i] = sy + Math.max(sx, sz) * 0.45;
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
  return ranked;
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
