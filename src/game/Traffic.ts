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

import { Color, Group, Quaternion, Vector3 } from 'three';

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { config } from '@/core/Config';
import { Rng, hashSeed } from '@/math/rng';

import { AU, type ScanResult } from '@/gen/types';
import { lodForDistance } from '@/gen/ships/types';
import type { ShipBlueprint } from '@/gen/ships/types';
import type { ShipParams } from '@/gen/ships/blueprint';
import { shipGen } from '@/gen/ships/shipGenClient';
import { shipScan } from '@/gen/ships/physics';
import { FACTIONS } from '@/gen/ships/families';

import { MutableViewState } from '@/render/ViewState';
import { createShipVisual } from '@/render/ships/ShipMesh';
import type { ShipVisual } from '@/game/Showroom';
import { shotOwnsScene } from '@/game/Shots';
import type { Universe, UniverseBody } from '@/game/Universe';
// v3 T4: legibility, scale through motion, SEE IN FLIGHT.
import {
  coOrbitVelocity,
  contactRangeKm,
  hullAttitude,
  hullSway,
  openingContactOffset,
  trafficThrottle,
  type HullSway,
} from '@/game/trafficMotion';
import { motionExclusionBuffer, packMotionExclusions, type MotionExclusionSphere } from '@/render/motionExclusion';
import { loudestHull } from '@/audio/audioCues';

/**
 * How many vessels a system carries. Small on purpose: this is the first
 * integration, and one ship you can actually fly to is worth more than a
 * skybox full of dots.
 */
const MAX_TRAFFIC = 4;
/**
 * Mesh builds (`createShipVisual`, 20-70 ms) allowed per frame. Blueprints no
 * longer count: they are generated on a worker (`shipGen`), and when there is
 * no worker the client's own fallback paces them one per task.
 */
const HEAVY_BUILDS_PER_FRAME = 1;

/** Beyond this the mesh is released entirely; the ship still exists as data. */
const RELEASE_DISTANCE_KM = 6e5;

/** Roles that plausibly loiter near a world rather than crossing the system. */
const PARKED_ROLES = ['freighter', 'tanker', 'salvager', 'miner', 'survey', 'station-tender'] as const;

/**
 * A circular orbit expressed in the plane the player is actually in, rather
 * than in the XZ plane. Deriving it from orbital elements put an earlier
 * attempt in the ecliptic while the player sat well off it, and a 40 km offset
 * came out as 4,061 km.
 *
 * This is a real orbit about the anchor, not station-keeping on the player. It
 * can be, now that the ship's own state is stored in the anchor's frame: the
 * two share a frame by construction, so a vessel given the player's orbit plus
 * a few km of offset simply stays off their shoulder. The earlier version had
 * to chase the player every frame because there was no shared frame to sit in.
 */
interface CoOrbit {
  /** Anchor-relative position at epoch, km. */
  readonly r0: Vector3;
  /** Unit normal of the orbit plane — r̂ × t̂ at capture. */
  readonly axis: Vector3;
  /** Mean motion, rad/s: the player's own tangential rate at capture. */
  readonly rate: number;
  /** `Traffic.time` at capture. */
  readonly epoch: number;
}

interface Vessel {
  /**
   * What to build. Generation is deferred: one `generateShip` is 40-75 ms and
   * a system carries up to four, which v1 built in a single frame on arrival.
   */
  readonly params: ShipParams;
  /** Null until the worker's answer arrives. The vessel is not drawn before. */
  blueprint: ShipBlueprint | null;
  /** The blueprint has been asked for; the answer lands in `blueprint`. */
  requested: boolean;
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
  // -- v3 T4 ------------------------------------------------------------------
  /** Per-vessel drive: powered, plume breathing (audit V2: it was throttle 0). */
  readonly drive: { throttle: number; boost: number; heating: number; rcs: Vector3 };
  /** Orientation along the orbit, plus the slow sway. World axes. */
  readonly attitude: Quaternion;
  /** Parent-relative velocity, km/s (co-orbital vessels only; zero otherwise). */
  readonly velocity: Vector3;
  /** Phase for the throttle breathe and the sway, 0..1. */
  readonly phase01: number;
  readonly sway: HullSway;
  /** Render-space exclusion sphere for the ground-referenced blur. */
  readonly exclusion: { readonly center: Vector3; radiusKm: number };
  /** SEE IN FLIGHT: this is the companion the player asked for. */
  readonly companion: boolean;
  // ---------------------------------------------------------------------------
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
  private readonly sunBase = new Color(1, 0.96, 0.9); // v3 T4
  private readonly fill = new Color(0.01, 0.014, 0.022);
  private time = 0;
  // -- v3 T4 ------------------------------------------------------------------
  private readonly invQ = new Quaternion();
  private readonly yawQ = new Quaternion();
  private static readonly Y = new Vector3(0, 1, 0);
  private readonly xAxis = new Vector3();
  private companionParams: ShipParams | null = null;
  private readonly exclusions: MotionExclusionSphere[] = [];
  private readonly humList: Array<{ distanceKm: number; radiusKm: number }> = [];
  // ---------------------------------------------------------------------------

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
        // v3 T4: a companion is spawned beside you in the system you asked
        // for it in; it does not follow you through a jump.
        this.companionParams = null;
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
      const isCompanion = i === 0 && this.companionParams !== null;
      const params: ShipParams = isCompanion ? this.companionParams! : {
        seed,
        factionId: faction.id,
        role,
        // Working hulls, not showpieces: something has happened to all of them.
        ageYears: rng.range(8, 60),
        damageLevel: rng.range(0.05, 0.45),
        maintenance: rng.range(0.2, 0.8),
      };

      // The FIRST vessel always anchors to the world the player is at — which
      // is now a well-defined thing: the ship's SOI parent. Picking anchors
      // uniformly across the system put the only contact 57 million km away,
      // where it is released before it is ever drawn — a correct simulation of
      // an empty sky, and useless as a first integration. One ship you can
      // actually fly to is the whole point.
      const home = this.universe.shipParent ?? this.universe.nearest;
      const anchor =
        i === 0 && home
          ? home
          : bodies.length > 0
            ? bodies[rng.int(0, bodies.length - 1)]!
            : null;
      // Co-orbital placement reads the player's state vector directly, and that
      // vector is only in the anchor's frame when the anchor IS the parent.
      // Requiring that rather than converting is what keeps the two frame lines
      // in FlightModel.rebase() the only ones in the project.
      const coOrbital = i === 0 && anchor !== null && anchor === this.universe.shipParent;
      // The first vessel shares the PLAYER'S orbit, not an arbitrary one.
      //
      // Parking it at 1.3 planet radii is physically sensible and visually
      // useless: the player sits at a different altitude, the separation came
      // out at 20,000 km, and a 396 m hull at that range is correctly culled
      // before it is ever drawn. Co-orbital, a few tens of km off, is the only
      // arrangement where the first contact is something you can actually see
      // and fly to.
      const playerRadius = anchor
        ? this.universe.flight.worldPosition.distanceTo(anchor.world)
        : 0;
      const radius =
        i === 0 && anchor
          ? playerRadius
          : anchor
            ? anchor.spec.radius * rng.range(1.35, 3.2)
            : AU * rng.range(0.2, 0.8);

      this.vessels.push({
        params,
        blueprint: null,
        requested: false,
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
        // v3 T4: contact 0 sits inside the opening composition, ~15° above
        // the nose at 1.5-2.5 km (audit V2: it was just over the top edge).
        coOrbit: coOrbital ? this.captureCoOrbit(anchor!, contactRangeKm(rng.next())) : null,
        visual: null,
        view: new MutableViewState(),
        drive: { throttle: 0.2, boost: 0, heating: 0, rcs: new Vector3() },
        attitude: new Quaternion(),
        velocity: new Vector3(),
        phase01: rng.next(),
        sway: { yawRad: 0, lateralM: 0, rcsYaw: 0, rcs: new Vector3() },
        exclusion: { center: new Vector3(), radiusKm: 0 },
        companion: isCompanion,
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
   *
   * `anchor` is the ship's SOI parent, so `flight.position` and
   * `flight.velocity` are ALREADY anchor-relative — nothing is converted here,
   * and there is nothing left to forget to convert.
   */
  private captureCoOrbit(anchor: UniverseBody, separationKm: number): CoOrbit | null {
    const flight = this.universe.flight;
    const r = flight.position.clone();
    const radiusKm = r.length();
    if (radiusKm < 1e-6) return null;

    // Tangential component of the player's velocity in the anchor's frame.
    const v = flight.velocity.clone();
    const rHat = r.clone().divideScalar(radiusKm);
    v.addScaledVector(rHat, -v.dot(rHat));
    if (v.lengthSq() < 1e-12) {
      // Coasting radially, or stationary: pick any perpendicular so the frame
      // is still well defined rather than degenerate.
      v.set(0, 1, 0).addScaledVector(rHat, -rHat.y);
      if (v.lengthSq() < 1e-12) v.set(1, 0, 0).addScaledVector(rHat, -rHat.x);
    }
    const speed = v.length();
    const tHat = v.clone().divideScalar(speed);

    // v3 T4: placed in the opening composition — `separationKm` along a ray
    // ~15° above the player's nose — rather than along the track, where the
    // tipped-down opening frame never saw it. It is still a rigid co-orbit, so
    // it stays where it was put for as long as both coast.
    const offset = openingContactOffset(flight.forward, flight.up, separationKm, new Vector3());
    return {
      r0: r.add(offset),
      axis: new Vector3().crossVectors(rHat, tHat).normalize(),
      // Mean motion of a circular orbit through the player's current state. It
      // is a genuine orbit, so a coasting player and this vessel stay together
      // without either of them steering.
      rate: speed / radiusKm,
      epoch: this.time,
    };
  }

  /** The player's current orbital phase about a body, in the same frame placeVessel uses. */
  private playerPhase(anchor: UniverseBody): number {
    this.tmp.copy(this.universe.flight.worldPosition).sub(anchor.world);
    return Math.atan2(this.tmp.z, this.tmp.x);
  }

  private clear(): void {
    for (const v of this.vessels) {
      this.release(v);
      // A system left before its hulls arrived: drop the work still queued.
      // One already on a worker finishes into the client's cache, and the
      // answer is ignored here because `this.vessels` no longer holds `v`.
      if (v.requested && !v.blueprint) shipGen.cancel(v.params);
    }
    this.vessels = [];
  }

  /**
   * Ask the worker for a vessel's blueprint. Once per vessel, never per frame:
   * the closure is the only allocation, and it is paid when the hull first
   * comes in range.
   */
  private requestBlueprint(v: Vessel): void {
    v.requested = true;
    shipGen.request(v.params).then(
      (bp) => {
        // Stale if the system changed while it was being built.
        if (this.vessels.includes(v)) {
          v.blueprint = bp;
          // v3 T4: SEE IN FLIGHT names what it put beside you.
          if (v.companion) bus.emit('log', { text: `ALONGSIDE — ${bp.name.toUpperCase()}`, tone: 'good' });
        }
      },
      () => {
        // Cancelled (we left) or the generator threw. Either way this vessel
        // stays undrawn rather than taking the frame down; a throw would
        // have thrown identically on the main thread.
      },
    );
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
      motionExclusionBuffer.fill(0); // v3 T4: nothing to keep sharp
      return;
    }
    this.root.visible = true;
    // Simulated time, not wall time (review-p4): at 100× a co-orbiting hull
    // ran at 1× and fell behind the player it is meant to share an orbit with.
    // `dt` stays for the visuals below.
    this.time += this.universe.simulatedSeconds;

    if (this.pendingPopulate && this.universe.nearest) {
      this.pendingPopulate = false;
      this.populate();
    }

    this.camWorld.copy(this.universe.flight.worldPosition);

    // At most one mesh build per frame (20-70 ms). Spread over a few frames
    // it is invisible; in one frame, together with the blueprints that now
    // run on a worker, it was the ~600 ms hitch the v2 audit measured just
    // after boot.
    let heavyBudget = HEAVY_BUILDS_PER_FRAME;

    for (const v of this.vessels) {
      this.placeVessel(v);
      v.distanceKm = this.camWorld.distanceTo(v.world);

      if (!v.blueprint) {
        // A hull 0.2-0.8 AU away is never drawn; building it would spend a
        // 40-75 ms frame on nothing. It is built when it comes in range.
        if (v.distanceKm > RELEASE_DISTANCE_KM) continue;
        if (!v.requested) this.requestBlueprint(v);
        continue;
      }

      const wanted =
        v.distanceKm > RELEASE_DISTANCE_KM
          ? -1
          : lodForDistance(v.blueprint.renderProfile, v.distanceKm);

      if (wanted < 0) {
        this.release(v);
        continue;
      }

      if (!v.visual) {
        if (heavyBudget <= 0) continue;
        heavyBudget--;
        v.visual = createShipVisual(v.blueprint, config.quality);
        this.root.add(v.visual.object3d);
        v.lod = -1;
      }
      const level = Math.min(wanted, 3) as 0 | 1 | 2 | 3;
      if (level !== v.lod) {
        v.visual.setLod(level);
        v.lod = level;
      }

      // -- v3 T4: oriented along the orbit, swaying slowly, powered ---------
      const lengthKm = v.blueprint.dimensions.lengthKm;
      hullSway(this.time, lengthKm, v.phase01, v.sway);
      this.yawQ.setFromAxisAngle(Traffic.Y, v.sway.yawRad);
      v.attitude.multiply(this.yawQ);
      v.drive.throttle = trafficThrottle(this.time, v.phase01);
      v.drive.rcs.copy(v.sway.rcs);
      v.visual.object3d.quaternion.copy(v.attitude);

      // Render-space placement through the floating origin, plus the slow
      // lateral station-keeping drift (metres, along the hull's own +X).
      ctx.origin.toRender(v.world, this.tmp);
      this.xAxis.set(1, 0, 0).applyQuaternion(v.attitude);
      this.tmp.addScaledVector(this.xAxis, v.sway.lateralM * 1e-3);
      v.visual.object3d.position.copy(this.tmp);
      v.exclusion.center.copy(this.tmp);
      v.exclusion.radiusKm = v.blueprint.dimensions.boundingRadius;

      // The view packet, in the vessel's OWN local frame — now that the hull
      // is rotated, camera and sun must be carried into its axes too.
      this.invQ.copy(v.attitude).invert();
      this.local.copy(this.camWorld).sub(v.world).applyQuaternion(this.invQ);
      this.sunDir.copy(v.world).multiplyScalar(-1).normalize().applyQuaternion(this.invQ);
      // The same key light the worlds get (Universe.updateBodies): the star's
      // luminosity over distance². A flat 1.0 left every hull near-black next
      // to the planet it orbits once the iris adapted to that planet (v3 T4,
      // measured: the same hull at 8× read as a grey hull, at 1× as a hole).
      this.sunColor.copy(this.sunBase).multiplyScalar(this.irradiance(v.world));
      // ---------------------------------------------------------------------
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
      v.visual.update(dt, ctx, v.view, v.drive);
    }
  }

  /** Keplerian enough: a circular orbit about the anchor, inclined and phased. */
  private placeVessel(v: Vessel): void {
    if (v.coOrbit && v.anchor) {
      // A REAL ORBIT in the anchor's frame, not station-keeping on the player.
      //
      // An earlier attempt derived the contact's own circular orbit and drifted
      // at about 49 km/s — the planet's own orbital speed about its star. The
      // cause was that the vessel's orbit was expressed about the planet while
      // the player's position was integrated about the star, so the two were
      // never in the same frame however carefully the basis was captured. That
      // is fixed at the root now: the ship's position is stored relative to the
      // same body this orbit is about, so rotating a captured offset is all
      // that is needed and the contact stays put with nothing chasing anything.
      const c = v.coOrbit;
      this.local.copy(c.r0).applyAxisAngle(c.axis, c.rate * (this.time - c.epoch));
      v.world.addVectors(v.anchor.world, this.local);
      // v3 T4: nose along the orbital velocity, roof radially out.
      coOrbitVelocity(c.axis, c.rate, this.local, v.velocity);
      hullAttitude(v.velocity, this.local, v.attitude);
      return;
    }
    if (!v.anchor) {
      v.world.set(
        Math.cos(v.phase) * v.orbitRadiusKm,
        Math.sin(v.inclination) * v.orbitRadiusKm * 0.1,
        Math.sin(v.phase) * v.orbitRadiusKm,
      );
      v.velocity.set(0, 0, 0);
      this.tmp.set(-Math.sin(v.phase), 0, Math.cos(v.phase));
      hullAttitude(this.tmp, v.world, v.attitude);
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
    // v3 T4: along the (anchor-relative) orbit; d/da of the placement above.
    this.tmp.set(-Math.sin(a), Math.cos(a) * si, Math.cos(a) * ci);
    this.local.copy(v.world).sub(v.anchor.world);
    hullAttitude(this.tmp, this.local, v.attitude);
    v.velocity.set(0, 0, 0); // not in the player's frame; formation refuses it
  }

  /** v3 T4: hand PostFX the hulls its ground-referenced blur must not smear. */
  lateUpdate(_dt: number, ctx: EngineContext): void {
    packMotionExclusions(this.motionExclusions(), ctx.camera.position, motionExclusionBuffer);
  }

  /** v3 T4: inverse-square irradiance from the primary, as the worlds are lit. */
  private irradiance(world: Vector3): number {
    const star = this.universe.system?.stars[0];
    const lum = star && Number.isFinite(star.luminosity) && star.luminosity > 0 ? star.luminosity : 1;
    const au = world.length() / AU;
    return lum / Math.max(au * au, 1e-6);
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
      if (!v.blueprint) continue;
      if (!best || v.distanceKm < best.distanceKm) best = v;
    }
    if (!best?.blueprint) return null;
    return { id: best.blueprint.id, name: best.blueprint.name, distanceKm: best.distanceKm };
  }

  /**
   * Built vessels, for targeting. Read-only: `contactAt` hands back the live
   * world vector, which the caller must not write or retain past the frame.
   * Unbuilt vessels have no id yet and are skipped by returning null.
   */
  get contactCount(): number {
    return this.vessels.length;
  }

  contactAt(i: number): { readonly id: string; readonly name: string; readonly world: Vector3 } | null {
    const v = this.vessels[i];
    if (!v?.blueprint) return null;
    return { id: v.blueprint.id, name: v.blueprint.name, world: v.world };
  }

  /** Copy a vessel's world position into `out`; false if it is not (yet) here. */
  vesselWorld(id: string, out: Vector3): boolean {
    for (let i = 0; i < this.vessels.length; i++) {
      const v = this.vessels[i]!;
      if (v.blueprint?.id === id) {
        out.copy(v.world);
        return true;
      }
    }
    return false;
  }

  /**
   * Scan result for the HUD. Cached: the lines are derived from the blueprint
   * and never change, and shipScan walks the whole mass model to build them.
   */
  scan(id: string): ScanResult | null {
    const v = this.vessels.find((x) => x.blueprint?.id === id);
    if (!v?.blueprint) return null;
    if (!v.scan) v.scan = shipScan(v.blueprint);
    return v.scan;
  }

  // -------------------------------------------------------------------------
  // v3 T4 — SEE IN FLIGHT, formation, blur exclusion, proximity hum
  // -------------------------------------------------------------------------

  /**
   * Spawn this exact hull as contact 0, co-orbital beside the player, in
   * frame. `null` returns contact 0 to the system's own traffic. The hull is
   * generated on the worker like any other; the route pinned its generation.
   */
  setCompanion(params: ShipParams | null): void {
    this.companionParams = params;
    this.pendingPopulate = true;
  }

  /** The companion's blueprint id once it has been built, else null. */
  companionId(): string | null {
    const v = this.vessels[0];
    return v?.companion && v.blueprint ? v.blueprint.id : null;
  }

  /**
   * Parent-relative velocity of a vessel, km/s — only for a co-orbital
   * vessel, whose frame IS the player's (its anchor is the ship's parent).
   */
  vesselVelocity(id: string, out: Vector3): boolean {
    for (const v of this.vessels) {
      if (v.blueprint?.id !== id) continue;
      if (!v.coOrbit || v.anchor !== this.universe.shipParent) return false;
      out.copy(v.velocity);
      return true;
    }
    return false;
  }

  /** Render-space spheres the ground-referenced motion blur must leave sharp. */
  motionExclusions(): ReadonlyArray<MotionExclusionSphere> {
    this.exclusions.length = 0;
    if (!this.root.visible) return this.exclusions;
    for (const v of this.vessels) {
      if (v.visual && v.exclusion.radiusKm > 0) this.exclusions.push(v.exclusion);
    }
    return this.exclusions;
  }

  /** The hull that looms largest (for the proximity hum), or null. */
  loudest(): { readonly distanceKm: number; readonly radiusKm: number } | null {
    const list = this.humList;
    let n = 0;
    for (const v of this.vessels) {
      if (!v.blueprint) continue;
      const slot = list[n] ?? (list[n] = { distanceKm: 0, radiusKm: 0 });
      slot.distanceKm = v.distanceKm;
      slot.radiusKm = v.blueprint.dimensions.boundingRadius;
      n++;
    }
    list.length = n;
    const i = loudestHull(list);
    return i < 0 ? null : list[i]!;
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
