/**
 * ShipMesh — the assembler.
 *
 * Four modules were built independently against the blueprint: `volumes` makes
 * hull surface, `greebles` makes fittings, `ShipMaterial` makes the surface
 * look manufactured, and `propulsion` makes it burn. None of them knows the
 * others exist. This file is the only place that does.
 *
 * It owns three decisions the individual modules cannot make alone:
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
 */

import {
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  Object3D,
  Vector3,
  type BufferGeometry,
} from 'three';

import type { EngineContext } from '@/core/Engine';
import type { QualitySettings } from '@/core/Config';
import type { ViewState } from '@/render/ViewState';
import type { ShipBlueprint, LodLevel } from '@/gen/ships/types';
import { factionById, greebleVocabulary } from '@/gen/ships/families';
import type { ShipDriveState, ShipVisual } from '@/game/Showroom';

import {
  HullBuilder,
  buildSpine,
  buildVolume,
  type OccluderSphere,
  type SurfaceSeat,
  type VolumeBuildOptions,
} from './volumes';
import {
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

interface BuiltLod {
  readonly group: Group;
  readonly geometry: BufferGeometry;
  readonly instances: InstancedMesh[];
  readonly triangles: number;
  readonly drawCalls: number;
}

export class ShipMesh implements ShipVisual {
  readonly object3d: Object3D = new Group();

  private readonly materials: ShipMaterialSet;
  private readonly propulsion: ShipPropulsion;
  private readonly cache = new GreebleCache();

  /** One entry per LOD, built on first use and then kept. */
  private readonly lods: Array<BuiltLod | null> = [null, null, null, null];
  private active = -1;
  private disposed = false;

  // Per-frame state. Preallocated: nothing here may allocate (ARCHITECTURE §5).
  private readonly fill = new Color(0.01, 0.014, 0.022);
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

  private build(level: number): BuiltLod {
    const bp = this.blueprint;
    const lod = this.lodDescriptor(level);
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

    // Greebles last, and never to rescue a weak form (BRIEF §4).
    const scatterOccluders: OccluderSphere[] = [];
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
      outOccluders: scatterOccluders,
    });

    // The dense families earn a draw call; the long tail is welded into the
    // hull buffer, which costs vertices once instead of a bind every frame.
    const split = splitScatterBudget(scatters, MAX_GREEBLE_BATCHES);
    for (const s of split.baked) bakeScatter(s, hb);

    const geometry = hb.toGeometry(true);
    const group = new Group();
    const hull = new Mesh(geometry, this.materials.hull);
    hull.frustumCulled = false;
    group.add(hull);

    let triangles = hb.triangleCount;
    const instances: InstancedMesh[] = [];
    for (const s of split.instanced) {
      const im = this.makeInstanced(s);
      instances.push(im);
      group.add(im);
      triangles += s.triangles;
    }

    // Only now are the part ids known, so this is the first moment the
    // material can be told which caster belongs to which surface.
    this.publishOccluders(occluders, scatterOccluders);

    group.visible = false;
    this.object3d.add(group);

    return { group, geometry, instances, triangles, drawCalls: 1 + instances.length };
  }

  private makeInstanced(s: InstancedScatter): InstancedMesh {
    const im = new InstancedMesh(s.geometry, this.materials.greeble, s.count);
    im.frustumCulled = false;
    im.name = `greeble:${s.kind}`;
    // The matrices arrive already packed; write them straight through rather
    // than round-tripping every instance via Matrix4.
    im.instanceMatrix.array.set(s.matrices.subarray(0, s.count * 16));
    im.instanceMatrix.needsUpdate = true;
    s.geometry.setAttribute('aSurf', new InstancedBufferAttribute(s.surf, 4));
    s.geometry.setAttribute('aBent', new InstancedBufferAttribute(s.bent, 4));
    return im;
  }

  /**
   * Sort casters by radius before handing them over. The list is capped, and a
   * whip antenna must never evict a radiator — the biggest masses are the ones
   * whose contact shadow the eye actually reads.
   */
  private publishOccluders(hull: OccluderSphere[], greeble: OccluderSphere[]): void {
    const all = hull.concat(greeble);
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
    this.materials.setOccluders(spheres, parts, n);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  setLod(level: 0 | 1 | 2 | 3): void {
    if (this.disposed || level === this.active) return;
    const built = this.lods[level] ?? (this.lods[level] = this.build(level));
    if (this.active >= 0) {
      const prev = this.lods[this.active];
      if (prev) prev.group.visible = false;
    }
    built.group.visible = true;
    this.active = level;

    // Materials are shared, so the per-ship uniforms have to be current at
    // draw time, not at tick time — hence onBeforeRender rather than update().
    for (const child of built.group.children) {
      child.onBeforeRender = this.pushUniforms;
    }
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
  }

  setFillLight(color: Color): void {
    this.fill.copy(color);
    this.propulsion.fillColor.copy(color);
  }

  /** Diagnostics for the review manifest. */
  stats(): { lod: number; triangles: number; drawCalls: number } {
    const built = this.active >= 0 ? this.lods[this.active] : null;
    return {
      lod: this.active,
      triangles: built?.triangles ?? 0,
      drawCalls: (built?.drawCalls ?? 0) + 1, // + propulsion
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const built of this.lods) {
      if (!built) continue;
      built.geometry.dispose();
      // Instanced greeble geometry is owned by the shared cache, not by the
      // mesh — disposing it here would pull it out from under another ship.
      for (const im of built.instances) im.dispose();
      built.group.removeFromParent();
    }
    this.cache.dispose();
    this.propulsion.dispose();
    this.materials.dispose();
    this.object3d.removeFromParent();
  }
}

/** The factory the showroom and the universe both wire up. */
export function createShipVisual(bp: ShipBlueprint, quality: QualitySettings): ShipVisual {
  return new ShipMesh(bp, quality);
}
