/**
 * Traffic — the procedural fleet, in the actual universe.
 *
 * Until now the ships existed only in the showroom, framed on black by a camera
 * that was told where to stand. Four review rounds judged them there, and the
 * standing criticism was that the frames read as a museum turntable: no
 * occluder, no flare, and a drive that lit nothing around it. That is not a
 * material problem, it is a *placement* problem, and the fix is to put the ship
 * somewhere — against planetshine, across a terminator, through a nebula.
 *
 * This module is deliberately small. It generates a handful of vessels from the
 * system's own seed, parks them in plausible orbits, streams their meshes by
 * distance, and hands them to the HUD as scan targets. No AI, no trade, no
 * combat. The point is to find out what breaks when the ships stop being the
 * only thing in the frame — because in this project, everything that worked in
 * isolation has broken on contact with integration.
 */

import { Color, Group, Vector3 } from 'three';

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { config } from '@/core/Config';
import { Rng, hashSeed } from '@/math/rng';

import { AU, type ScanResult } from '@/gen/types';
import { lodForDistance } from '@/gen/ships/types';
import type { ShipBlueprint } from '@/gen/ships/types';
import { generateShip } from '@/gen/ships/blueprint';
import { shipScan } from '@/gen/ships/physics';
import { FACTIONS } from '@/gen/ships/families';

import { MutableViewState } from '@/render/ViewState';
import { createShipVisual } from '@/render/ships/ShipMesh';
import type { ShipVisual } from '@/game/Showroom';
import { shotOwnsScene } from '@/game/Shots';
import type { Universe, UniverseBody } from '@/game/Universe';

/**
 * How many vessels a system carries. Small on purpose: this is the first
 * integration, and one ship you can actually fly to is worth more than a
 * skybox full of dots.
 */
const MAX_TRAFFIC = 4;

/** Reused origin for the anchor-relative radial. */
const ZERO3 = new Vector3();

/** Beyond this the mesh is released entirely; the ship still exists as data. */
const RELEASE_DISTANCE_KM = 6e5;

/** Roles that plausibly loiter near a world rather than crossing the system. */
const PARKED_ROLES = ['freighter', 'tanker', 'salvager', 'miner', 'survey', 'station-tender'] as const;

/**
 * A circular orbit expressed in the plane the player is actually in, rather
 * than in the XZ plane. Deriving it from orbital elements put an earlier
 * attempt in the ecliptic while the player sat well off it, and a 40 km offset
 * came out as 4,061 km.
 */
interface CoOrbit {
  /** Fallback direction of travel, if the player is momentarily stationary. */
  readonly t0: Vector3;
  /** Fallback radial direction. */
  readonly r0: Vector3;
  /** Distance ahead along the player's track, km. */
  readonly aheadKm: number;
  /** Distance outward from the body below, km. */
  readonly aboveKm: number;
}

interface Vessel {
  readonly blueprint: ShipBlueprint;
  /** World position, kilometres. Same frame as Universe's bodies. */
  readonly world: Vector3;
  /** The body it orbits, or null for a vessel in open space. */
  readonly anchor: UniverseBody | null;
  /** Orbit radius about the anchor, km, and phase at epoch. */
  readonly orbitRadiusKm: number;
  readonly phase: number;
  readonly inclination: number;
  /**
   * Set for co-orbital contacts: the player's own orbit, captured at spawn.
   *
   * A vessel parked at a fixed world offset is stationary while the player
   * orbits at kilometres per second, so the contact separates continuously —
   * measured, 541 km after ten seconds. Sharing the orbit keeps it off your
   * shoulder for as long as you both coast, which is what "there is a ship
   * out there" has to mean before anything else can be built on it.
   */
  readonly coOrbit: CoOrbit | null;
  visual: ShipVisual | null;
  readonly view: MutableViewState;
  distanceKm: number;
  lod: number;
  scan: ScanResult | null;
}

export class Traffic implements GameModule {
  readonly name = 'traffic';
  readonly root = new Group();

  private vessels: Vessel[] = [];
  private disposers: Array<() => void> = [];

  // Preallocated. Nothing below may allocate (ARCHITECTURE §5).
  private readonly camWorld = new Vector3();
  private readonly tmp = new Vector3();
  private readonly local = new Vector3();
  private readonly sunDir = new Vector3(0, 0, 1);
  private readonly sunColor = new Color(1, 0.96, 0.9);
  private readonly fill = new Color(0.01, 0.014, 0.022);
  private readonly drive = { throttle: 0, boost: 0, heating: 0, rcs: new Vector3() };
  private time = 0;

  constructor(private readonly universe: Universe) {
    this.root.name = 'traffic';
  }

  /**
   * Population is deferred to the first frame, not done in init().
   *
   * `Universe.nearest` is computed during update(), so at init() time it is
   * still null and every anchor falls through to a random body — which is how
   * the only contact in the system ended up 57 million km away, released
   * before it was ever drawn.
   */
  private pendingPopulate = true;

  init(ctx: EngineContext): void {
    ctx.scene.add(this.root);
    this.disposers.push(
      bus.on('system:entered', () => {
        this.pendingPopulate = true;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Population
  // -------------------------------------------------------------------------

  /**
   * Derive this system's traffic from the system's own seed, so the same system
   * always carries the same vessels — a ship you scanned once is still there
   * when you come back, without anything being stored.
   */
  private populate(): void {
    this.clear();
    const sys = this.universe.system;
    if (!sys) return;

    const rng = new Rng(hashSeed(sys.seed, 'traffic'));
    // A picked-over system carries more hulls than an empty one. `civilisation`
    // is already generated per system; this is the first thing that reads it.
    const count = Math.min(MAX_TRAFFIC, 1 + Math.floor(rng.next() * (1 + sys.civilisation * 4)));

    const bodies = this.universe.allBodies().filter((b) => !b.spec.isMoon);
    for (let i = 0; i < count; i++) {
      const seed = hashSeed(sys.seed, `vessel:${i}`);
      const faction = rng.pick(FACTIONS);
      const role = rng.pick(PARKED_ROLES);
      const blueprint = generateShip({
        seed,
        factionId: faction.id,
        role,
        // Working hulls, not showpieces: something has happened to all of them.
        ageYears: rng.range(8, 60),
        damageLevel: rng.range(0.05, 0.45),
        maintenance: rng.range(0.2, 0.8),
      });

      // The FIRST vessel always anchors to the world the player is at.
      //
      // Picking anchors uniformly across the system put the only contact 57
      // million km away, where it is released before it is ever drawn — a
      // correct simulation of an empty sky, and useless as a first
      // integration. One ship you can actually fly to is the whole point.
      const anchor =
        i === 0 && this.universe.nearest
          ? this.universe.nearest
          : bodies.length > 0
            ? bodies[rng.int(0, bodies.length - 1)]!
            : null;
      // The first vessel shares the PLAYER'S orbit, not an arbitrary one.
      //
      // Parking it at 1.3 planet radii is physically sensible and visually
      // useless: the player sits at a different altitude, the separation came
      // out at 20,000 km, and a 396 m hull at that range is correctly culled
      // before it is ever drawn. Co-orbital, a few tens of km off, is the only
      // arrangement where the first contact is something you can actually see
      // and fly to.
      const playerRadius = anchor
        ? this.universe.flight.position.distanceTo(anchor.world)
        : 0;
      const radius =
        i === 0 && anchor
          ? playerRadius
          : anchor
            ? anchor.spec.radius * rng.range(1.35, 3.2)
            : AU * rng.range(0.2, 0.8);

      this.vessels.push({
        blueprint,
        world: new Vector3(),
        anchor,
        orbitRadiusKm: radius,
        // Phase-offset just enough to sit off the player's shoulder rather than
        // inside them: an arc of ~40 km at the orbit radius in use.
        phase:
          i === 0 && anchor
            ? this.playerPhase(anchor) + 40 / Math.max(radius, 1)
            : rng.range(0, Math.PI * 2),
        inclination: i === 0 ? 0 : rng.gaussian(0, 0.4),
        coOrbit: i === 0 && anchor ? this.captureCoOrbit(anchor, rng.range(1.6, 4.2)) : null,
        visual: null,
        view: new MutableViewState(),
        distanceKm: Infinity,
        lod: -1,
        scan: null,
      });
    }

    if (this.vessels.length > 0) {
      bus.emit('log', {
        text: `CONTACTS — ${this.vessels.length} VESSEL${this.vessels.length > 1 ? 'S' : ''}`,
        tone: 'normal',
      });
    }
  }

  /**
   * Capture the player's current circular orbit about `anchor`, with the
   * vessel leading by `separationKm` along the track.
   */
  private captureCoOrbit(anchor: UniverseBody, separationKm: number): CoOrbit | null {
    const flight = this.universe.flight;
    const r = new Vector3().subVectors(flight.position, anchor.world);
    const radiusKm = r.length();
    if (radiusKm < 1e-6) return null;

    // Tangential component of the player's velocity in the anchor's frame.
    const v = new Vector3().copy(flight.relativeVelocity);
    const rHat = r.clone().divideScalar(radiusKm);
    v.addScaledVector(rHat, -v.dot(rHat));
    if (v.lengthSq() < 1e-12) {
      // Coasting radially, or stationary: pick any perpendicular so the frame
      // is still well defined rather than degenerate.
      v.set(0, 1, 0).addScaledVector(rHat, -rHat.y);
      if (v.lengthSq() < 1e-12) v.set(1, 0, 0).addScaledVector(rHat, -rHat.x);
    }
    const speed = v.length();
    const tHat = v.divideScalar(speed);

    return {
      r0: rHat,
      t0: tHat,
      aheadKm: separationKm,
      // A little higher, so the contact reads against the planet rather than
      // against the same patch of black the player is looking at.
      aboveKm: separationKm * 0.35,
    };
  }

  /** The player's current orbital phase about a body, in the same frame placeVessel uses. */
  private playerPhase(anchor: UniverseBody): number {
    this.tmp.copy(this.universe.flight.position).sub(anchor.world);
    return Math.atan2(this.tmp.z, this.tmp.x);
  }

  private clear(): void {
    for (const v of this.vessels) this.release(v);
    this.vessels = [];
  }

  private release(v: Vessel): void {
    if (!v.visual) return;
    v.visual.object3d.removeFromParent();
    v.visual.dispose();
    v.visual = null;
    v.lod = -1;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, ctx: EngineContext): void {
    // A review shot owns the scene: traffic would wander into a frame that is
    // supposed to contain one subject. Same rule as Universe and Pilot.
    if (shotOwnsScene() || this.universe.paused) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;
    this.time += dt;

    if (this.pendingPopulate && this.universe.nearest) {
      this.pendingPopulate = false;
      this.populate();
    }

    this.camWorld.copy(this.universe.flight.position);

    for (const v of this.vessels) {
      this.placeVessel(v);
      v.distanceKm = this.camWorld.distanceTo(v.world);

      const wanted =
        v.distanceKm > RELEASE_DISTANCE_KM
          ? -1
          : lodForDistance(v.blueprint.renderProfile, v.distanceKm);

      if (wanted < 0) {
        this.release(v);
        continue;
      }

      if (!v.visual) {
        v.visual = createShipVisual(v.blueprint, config.quality);
        this.root.add(v.visual.object3d);
        v.lod = -1;
      }
      const level = Math.min(wanted, 3) as 0 | 1 | 2 | 3;
      if (level !== v.lod) {
        v.visual.setLod(level);
        v.lod = level;
      }

      // Render-space placement through the floating origin.
      ctx.origin.toRender(v.world, this.tmp);
      v.visual.object3d.position.copy(this.tmp);

      // The view packet, in the vessel's own local frame.
      this.local.copy(this.camWorld).sub(v.world);
      this.sunDir.copy(v.world).multiplyScalar(-1).normalize();
      v.view.set(
        this.local,
        this.sunDir,
        this.sunColor,
        ctx.elapsed,
        (ctx.camera.fov * Math.PI) / 180,
        ctx.height,
      );

      // Planetshine, so a hull in orbit does not read as a cut-out against its
      // own world. This is the term the showroom could never supply.
      v.visual.setFillLight?.(this.fillFor(v));
      v.visual.update(dt, ctx, v.view, this.drive);
    }
  }

  /** Keplerian enough: a circular orbit about the anchor, inclined and phased. */
  private placeVessel(v: Vessel): void {
    if (v.coOrbit) {
      // STATION-KEEPING, not an independently integrated orbit.
      //
      // An earlier attempt derived the contact's own circular orbit and
      // drifted at about 49 km/s. That looked like a reference-frame
      // mismatch, because it is close to the planet's own orbital speed
      // around its star — but it was not. Measured afterwards
      // (src/gen/frame.test.ts, and in the running game): the body's
      // finite-difference speed matches Universe.bodyVelocity to 0.2%, and a
      // ship left coasting holds its altitude to the metre over tens of
      // seconds. The frames agree. The 49 km/s was a bug in that attempt's
      // own basis, captured before the reference velocity existed.
      //
      // Station-keeping is kept anyway, because it is also simply what a ship
      // parked near another ship does, and it survives the player
      // manoeuvring rather than only coasting.
      const c = v.coOrbit;
      const flight = this.universe.flight;
      this.tmp.copy(flight.relativeVelocity);
      if (this.tmp.lengthSq() < 1e-12) this.tmp.copy(c.t0);
      else this.tmp.normalize();
      // Radial direction: away from the body below, or the epoch vector.
      this.local.copy(v.anchor ? v.anchor.world : ZERO3);
      this.local.subVectors(flight.position, this.local);
      if (this.local.lengthSq() < 1e-12) this.local.copy(c.r0);
      else this.local.normalize();

      v.world
        .copy(flight.position)
        .addScaledVector(this.tmp, c.aheadKm)
        .addScaledVector(this.local, c.aboveKm);
      return;
    }
    if (!v.anchor) {
      v.world.set(
        Math.cos(v.phase) * v.orbitRadiusKm,
        Math.sin(v.inclination) * v.orbitRadiusKm * 0.1,
        Math.sin(v.phase) * v.orbitRadiusKm,
      );
      return;
    }
    // Orbital period from the anchor's mass, so a close parking orbit visibly
    // moves and a distant one barely does.
    const mu = 398600.4418 * v.anchor.spec.mass;
    const n = Math.sqrt(mu / Math.pow(v.orbitRadiusKm, 3));
    const a = v.phase + n * this.time;
    const ci = Math.cos(v.inclination);
    const si = Math.sin(v.inclination);
    v.world.set(
      v.anchor.world.x + Math.cos(a) * v.orbitRadiusKm,
      v.anchor.world.y + Math.sin(a) * v.orbitRadiusKm * si,
      v.anchor.world.z + Math.sin(a) * v.orbitRadiusKm * ci,
    );
  }

  /** Planetshine falls off with distance from the lit body below. */
  private fillFor(v: Vessel): Color {
    if (!v.anchor) return this.fill.setRGB(0.01, 0.014, 0.022);
    const altitude = Math.max(1, v.world.distanceTo(v.anchor.world) - v.anchor.spec.radius);
    const k = Math.min(1, v.anchor.spec.radius / (altitude * 2));
    return this.fill.setRGB(0.01 + 0.1 * k, 0.014 + 0.126 * k, 0.022 + 0.198 * k);
  }

  // -------------------------------------------------------------------------
  // Queries — targeting and the scanner
  // -------------------------------------------------------------------------

  /** Nearest vessel, for Tab targeting. */
  nearest(): { id: string; name: string; distanceKm: number } | null {
    let best: Vessel | null = null;
    for (const v of this.vessels) {
      if (!best || v.distanceKm < best.distanceKm) best = v;
    }
    if (!best) return null;
    return { id: best.blueprint.id, name: best.blueprint.name, distanceKm: best.distanceKm };
  }

  /**
   * Scan result for the HUD. Cached: the lines are derived from the blueprint
   * and never change, and shipScan walks the whole mass model to build them.
   */
  scan(id: string): ScanResult | null {
    const v = this.vessels.find((x) => x.blueprint.id === id);
    if (!v) return null;
    if (!v.scan) v.scan = shipScan(v.blueprint);
    return v.scan;
  }

  /** Diagnostics for the review harness. */
  stats(): { vessels: number; resident: number; lods: number[] } {
    return {
      vessels: this.vessels.length,
      resident: this.vessels.filter((v) => v.visual !== null).length,
      lods: this.vessels.map((v) => v.lod),
    };
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.clear();
    this.root.removeFromParent();
  }
}
