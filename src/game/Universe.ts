/**
 * The universe: the state machine that turns generated data into a rendered,
 * flyable star system.
 *
 * This is the only file that knows about both halves of the project. The
 * generators do not know they will be drawn; the renderers do not know where
 * their subject is. Universe holds the world-space truth — where every body is
 * at time t — and each frame it hands each renderer the small, local view of
 * reality that renderer is allowed to see.
 *
 * Responsibilities, in order of importance:
 *   1. Keep world positions in float64 and hand out render-space positions.
 *   2. Decide which bodies deserve a renderer at all (budget), and stream them
 *      in and out as the ship moves.
 *   3. Drive the flight model's view of gravity and ground.
 *   4. Publish what the HUD and audio need to know.
 */

import { Color, Group, Matrix4, Object3D, Quaternion, Vector3 } from 'three';

/** Reused zero vector for basis construction; never mutated. */
const ZERO = new Vector3(0, 0, 0);

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { config } from '@/core/Config';
import { Rng, hashSeed } from '@/math/rng';

import {
  AU,
  type GalaxySpec,
  type PlanetSpec,
  type StarSystemSpec,
  type Vec3,
} from '@/gen/types';
import { generateGalaxy, sampleSystemsNear, type StarSystemStub } from '@/gen/galaxy';
import { shotOwnsScene } from '@/game/Shots';
import { generateSystem } from '@/gen/system';
import { orbitalPosition, orbitalVelocity } from '@/gen/orbit';

import { MutableViewState } from '@/render/ViewState';
import { PlanetRenderer } from '@/render/Planet';
import { CloudRenderer } from '@/render/Clouds';
import { RingRenderer } from '@/render/Rings';
import { StarRenderer } from '@/render/Star';
import { AtmosphereRenderer } from '@/render/Atmosphere';

import { DEFAULT_SHIP_CONFIG, FlightModel, type GravitySource } from '@/ship/FlightModel';

/**
 * Orbits run at 1:1 with the ship.
 *
 * An earlier version ran them at 400x so moons would visibly move. That is
 * incoherent: the ship's physics is real time, so the world accelerates away
 * from the player. Measured, an ice giant at 1.95 AU moves ~13 km/s, which at
 * 400x is 5200 km/s — the planet you are orbiting simply leaves, and the
 * altitude readout climbs while the ship sits still. Any time acceleration has
 * to move the ship too, which is a separate feature ("time warp"), not a
 * constant.
 */
const ORBIT_TIME_SCALE = 1;

/** Gravitational parameter of one Earth mass, km^3/s^2. */
const MU_EARTH = 398600.4418;
/** Gravitational parameter of one solar mass, km^3/s^2. */
const MU_SUN = 1.32712440018e11;

/** How many planets may hold a full renderer at once. */
const PLANET_RENDER_BUDGET = 5;

/**
 * The seed the game opens on. Chosen by hand from a survey of candidates —
 * it produces a ringed giant with three moons in the opening frame.
 */
export const DEFAULT_UNIVERSE_SEED = 0x05e5_9ace;

/**
 * A body in the current system, with whatever renderers it currently deserves.
 * Renderers are nullable: distance decides whether a body is a rendered world
 * or just a point of light, and that decision changes as the ship moves.
 */
interface Body {
  readonly spec: PlanetSpec;
  /** Parent body for moons; null for planets. */
  readonly parent: Body | null;
  /** World position, kilometres, star at the origin. float64. */
  readonly world: Vector3;
  /** Position relative to its parent (or the star), kilometres. */
  readonly local: Vector3;
  planet: PlanetRenderer | null;
  clouds: CloudRenderer | null;
  rings: RingRenderer | null;
  atmosphere: AtmosphereRenderer | null;
  readonly view: MutableViewState;
  readonly spin: Quaternion;
  /** Squared distance to the camera this frame — the streaming sort key. */
  distanceSq: number;
}

export interface UniverseOptions {
  /** Master seed. The same number always produces the same universe. */
  readonly seed?: number;
  /** Skip generating a ship and flight model (used by isolated review shots). */
  readonly headless?: boolean;
}


/**
 * Sunlight reaching a body, in units of Earth-at-1-AU-from-Sol.
 * Inverse square on the primary's luminosity — the one number that decides
 * whether a world is a sight or a silhouette.
 */
function illumination(system: StarSystemSpec, planet: PlanetSpec): number {
  const auDist = planet.orbit.semiMajorAxis / AU;
  return system.stars[0]!.luminosity / Math.max(auDist * auDist, 1e-9);
}

/** Below this the opening frame is black and the game looks broken. */
const MIN_ARRIVAL_ILLUMINATION = 0.12;

/** Saturating weight: being brighter than daylight buys nothing extra. */
function litWeight(lit: number): number {
  return Math.min(1, lit / MIN_ARRIVAL_ILLUMINATION) * 0.9 + 0.1;
}

export class Universe implements GameModule {
  readonly name = 'universe';

  readonly seed: number;
  readonly root = new Group();

  galaxy!: GalaxySpec;
  system!: StarSystemSpec;

  /** Every planet and moon in the current system, flattened. */
  private bodies: Body[] = [];
  private star: StarRenderer | null = null;

  readonly flight = new FlightModel(DEFAULT_SHIP_CONFIG);

  /** Simulated orbital time in seconds. Advances at ORBIT_TIME_SCALE. */
  private orbitTime = 0;

  /**
   * Set while the galaxy chart is open. The system keeps existing — it simply
   * stops advancing, so returning to flight does not teleport every moon.
   */
  paused = false;

  /** Nearest body, recomputed each frame — the HUD and audio both want it. */
  nearest: Body | null = null;
  nearestAltitudeKm: number | null = null;

  // Preallocated scratch. Nothing in update() may allocate (ARCHITECTURE §5).
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpDir = new Vector3();
  private readonly camWorld = new Vector3();
  private readonly sunDir = new Vector3();
  private readonly sunColor = new Color();
  private readonly starWorld = new Vector3();
  private readonly gravity: GravitySource[] = [];
  private readonly orbitScratch = { x: 0, y: 0, z: 0 };

  constructor(private readonly options: UniverseOptions = {}) {
    this.seed = options.seed ?? DEFAULT_UNIVERSE_SEED;
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  init(ctx: EngineContext): void {
    ctx.scene.add(this.root);

    this.galaxy = generateGalaxy(this.seed);
    bus.emit('galaxy:entered', { galaxy: this.galaxy });

    // Start somewhere with something to look at: sample the arm at a third of
    // the disc radius, where star formation put the interesting neighbours.
    const start = this.pickStartSystem();
    this.enterSystem(start, ctx);
  }

  /**
   * Choose an opening system. Deliberately biased: the first thing a player
   * sees decides whether they keep playing, so we reject systems with nothing
   * worth flying to rather than accepting whatever the seed offers first.
   */
  private pickStartSystem(): StarSystemSpec {
    const rng = new Rng(hashSeed(this.seed, 'start'));
    const r = this.galaxy.radiusLy * 0.34;
    const theta = rng.range(0, Math.PI * 2);
    const probe: Vec3 = [r * Math.cos(theta), rng.gaussian(0, 30), r * Math.sin(theta)];

    const stubs = sampleSystemsNear(this.galaxy, probe, 260, 96);
    let best: StarSystemSpec | null = null;
    let bestScore = -Infinity;

    for (const stub of stubs.slice(0, 24)) {
      const sys = generateSystem(this.galaxy, stub);
      let score = 0;
      let bestLit = 0;
      for (const p of sys.planets) {
        // Visual interest is worthless if the subject is not lit. Three
        // quarters of all stars are M dwarfs; one of luminosity 0.0019 leaves
        // a world at 2 AU receiving a two-thousandth of Earth's sunlight, and
        // the opening frame comes out genuinely, physically black. Weight
        // every body by what actually reaches it.
        const lit = illumination(sys, p);
        bestLit = Math.max(bestLit, lit);
        let s = 1;
        if (p.bands) s += 3;
        if (p.rings) s += 5;
        if (p.atmosphere) s += 2;
        if (p.ocean) s += 2;
        s += Math.min(p.moons.length, 3);
        score += s * litWeight(lit);
      }
      if (sys.planets.length < 3) score -= 6;
      // Reject outright: an unlit system is not a place, it is a black screen.
      if (bestLit < MIN_ARRIVAL_ILLUMINATION) score -= 100;
      if (score > bestScore) {
        bestScore = score;
        best = sys;
      }
    }

    // sampleSystemsNear is guaranteed non-empty for a probe inside the disc,
    // but fall back rather than throw — an empty sky is recoverable, a crash
    // on boot is not.
    return best ?? generateSystem(this.galaxy, stubs[0]!);
  }

  // -------------------------------------------------------------------------
  // System lifecycle
  // -------------------------------------------------------------------------

  enterSystem(system: StarSystemSpec, ctx: EngineContext): void {
    this.leaveSystem();
    this.system = system;

    const primary = system.stars[0]!;
    this.star = new StarRenderer(primary, config.quality);
    this.root.add(this.star.object3d);

    // Flatten planets and moons into one list. Moons carry a parent pointer so
    // their world position composes rather than orbiting the star directly.
    for (const spec of system.planets) {
      const body = this.makeBody(spec, null);
      this.bodies.push(body);
      for (const moonSpec of spec.moons) {
        this.bodies.push(this.makeBody(moonSpec, body));
      }
    }

    this.orbitTime = 0;
    this.updateOrbits();

    if (!this.options.headless) {
      // Gravity has to exist before the ship is placed: orbitalVelocityAt()
      // asks the flight model for the dominant attractor, and with no sources
      // registered it returns a zero vector. The ship was being spawned at
      // rest beside a planet and then simply falling — reported as "the speed
      // increases without doing anything".
      this.camWorld.set(0, 0, 0);
      for (const b of this.bodies) b.distanceSq = 0;
      this.applyGravity();
      this.placeShipOnArrival();
    }

    bus.emit('system:entered', { system });
    bus.emit('log', { text: `ARRIVED — ${system.name.toUpperCase()}`, tone: 'good' });
  }

  private makeBody(spec: PlanetSpec, parent: Body | null): Body {
    return {
      spec,
      parent,
      world: new Vector3(),
      local: new Vector3(),
      planet: null,
      clouds: null,
      rings: null,
      atmosphere: null,
      view: new MutableViewState(),
      spin: new Quaternion(),
      distanceSq: Infinity,
    };
  }

  /**
   * Drop the ship into a stable orbit around the most interesting body, high
   * enough that the whole disc is in frame. Arriving in freefall next to a
   * planet is a better opening shot than arriving in empty space.
   */
  private placeShipOnArrival(): void {
    const target = this.pickHeroBody();
    if (!target) {
      this.flight.teleport(new Vector3(0, 0, 6 * AU));
      return;
    }
    const alt = target.spec.radius * 2.6;
    this.tmpA.copy(target.world);
    // Offset towards the star so the terminator crosses the frame.
    this.tmpB.copy(target.world).normalize().multiplyScalar(-1);
    this.tmpB.y += 0.35;
    this.tmpB.normalize().multiplyScalar(alt);
    this.tmpA.add(this.tmpB);

    // Point the nose at the world we just arrived at. Position alone is not
    // enough: dropping in with a default orientation aims the camera at empty
    // space, and the opening frame is the one frame that has to earn the next
    // ten minutes.
    this.arrivalLook.copy(target.world).sub(this.tmpA).normalize();
    this.arrivalUp.copy(this.tmpA).normalize();
    // Orthogonalise the up vector against the view direction, otherwise a
    // near-radial approach degenerates the basis and the roll snaps.
    this.arrivalUp.addScaledVector(this.arrivalLook, -this.arrivalLook.dot(this.arrivalUp));
    if (this.arrivalUp.lengthSq() < 1e-6) this.arrivalUp.set(0, 1, 0);
    this.arrivalUp.normalize();

    this.arrivalMat.identity();
    // Matrix4.lookAt(eye, target, up) already builds a basis whose -Z points
    // from eye towards target, and -Z is the ship's nose. Negating the target
    // as well flips the nose onto the star and puts the chase camera inside
    // the hull.
    this.arrivalMat.lookAt(ZERO, this.arrivalLook, this.arrivalUp);
    this.arrivalQuat.setFromRotationMatrix(this.arrivalMat);

    // Circular velocity about the planet, PLUS the planet's own motion about
    // the star. Without the second term the ship is left behind at exactly the
    // planet's orbital speed and the altitude readout creeps upward forever —
    // which is what "the planet just disappeared" looked like the second time.
    this.flight.orbitalVelocityAt(this.tmpA, this.tmpB);
    this.bodyVelocity(target, this.arrivalVel);
    this.tmpB.add(this.arrivalVel);
    this.flight.teleport(this.tmpA, this.tmpB, this.arrivalQuat);
  }

  /**
   * World velocity of a body: its own Keplerian motion plus every parent's,
   * so a moon carries its planet's motion around the star.
   */
  bodyVelocity(body: Body, out: Vector3): Vector3 {
    out.set(0, 0, 0);
    for (let b: Body | null = body; b; b = b.parent) {
      const mu = b.parent
        ? MU_EARTH * b.parent.spec.mass
        : MU_SUN * this.system.stars[0]!.mass;
      orbitalVelocity(b.spec.orbit, this.orbitTime, mu, this.orbitScratch);
      out.x += this.orbitScratch.x;
      out.y += this.orbitScratch.y;
      out.z += this.orbitScratch.z;
    }
    return out;
  }

  private readonly arrivalVel = new Vector3();
  private readonly arrivalLook = new Vector3();
  private readonly arrivalUp = new Vector3();
  private readonly arrivalQuat = new Quaternion();
  private readonly arrivalMat = new Matrix4();

  private pickHeroBody(): Body | null {
    let best: Body | null = null;
    let bestScore = -Infinity;
    let brightest: Body | null = null;
    let brightestLit = -1;

    for (const b of this.bodies) {
      const lit = illumination(this.system, b.spec);
      if (lit > brightestLit) {
        brightestLit = lit;
        brightest = b;
      }
      if (b.spec.isMoon) continue;
      let s = 1;
      if (b.spec.rings) s += 6;
      if (b.spec.atmosphere) s += 3;
      if (b.spec.ocean) s += 3;
      if (b.spec.bands) s += 2;
      s += b.spec.moons.length;
      s *= litWeight(lit);
      if (s > bestScore) {
        bestScore = s;
        best = b;
      }
    }

    // If nothing interesting is lit, take whatever is brightest — a plain
    // world you can see beats a spectacular one you cannot.
    if (best && illumination(this.system, best.spec) < MIN_ARRIVAL_ILLUMINATION) {
      best = brightest ?? best;
    }
    return best ?? this.bodies[0] ?? null;
  }

  private leaveSystem(): void {
    for (const b of this.bodies) this.releaseRenderers(b);
    this.bodies = [];
    if (this.star) {
      this.root.remove(this.star.object3d);
      this.star.dispose();
      this.star = null;
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, ctx: EngineContext): void {
    // A review shot has placed its own fixtures and camera; touching the scene
    // now would undo all of it before the frame is captured.
    if (shotOwnsScene()) {
      this.root.visible = false;
      return;
    }
    if (this.paused) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    this.orbitTime += dt * ORBIT_TIME_SCALE;
    this.updateOrbits();

    if (!this.options.headless) {
      this.applyGravity();
      this.flight.update(dt);
      this.camWorld.copy(this.flight.position);
    } else {
      ctx.origin.toWorld(ctx.camera.position, this.camWorld);
    }

    // Rebase before computing render positions so everything shifts together.
    ctx.origin.rebaseIfNeeded(ctx.origin.toRender(this.camWorld, this.tmpA), this.tmpB);

    this.streamRenderers(ctx);
    this.updateBodies(dt, ctx);
    this.updateStar(dt, ctx);
    this.updateNearest();
  }

  /** Advance every body's Keplerian position. Moons compose onto their parent. */
  private updateOrbits(): void {
    for (const b of this.bodies) {
      orbitalPosition(b.spec.orbit, this.orbitTime, this.orbitScratch);
      b.local.set(this.orbitScratch.x, this.orbitScratch.y, this.orbitScratch.z);
      if (b.parent) b.world.copy(b.parent.world).add(b.local);
      else b.world.copy(b.local);

      // Axial rotation. Negative period means retrograde, which the modulo
      // handles for free.
      const spin = b.spec.rotationPeriod !== 0
        ? (this.orbitTime / b.spec.rotationPeriod) * Math.PI * 2
        : 0;
      this.tmpDir.set(Math.sin(b.spec.axialTilt), Math.cos(b.spec.axialTilt), 0).normalize();
      b.spin.setFromAxisAngle(this.tmpDir, spin);
    }
  }

  /** Feed the flight model real inverse-square gravity from the local bodies. */
  private applyGravity(): void {
    this.gravity.length = 0;
    const primary = this.system.stars[0]!;
    this.gravity.push({ position: this.starWorld, mu: MU_SUN * primary.mass });

    // Only bodies that could plausibly matter — everything else is noise
    // against the star and costs a square root per frame for nothing.
    for (const b of this.bodies) {
      // Relative cut-off: a moon stops mattering a few hundred of its own
      // radii away, but a gas giant still dominates at the same distance.
      const reach = b.spec.radius * 400;
      if (b.distanceSq > reach * reach) continue;
      this.gravity.push({
        position: b.world,
        mu: MU_EARTH * b.spec.mass,
        radius: b.spec.radius,
      });
    }
    this.flight.setGravitySources(this.gravity);
  }

  /**
   * Decide which bodies get renderers. Sorted by distance, the closest few get
   * full geometry; the rest are released. This is what keeps a system with
   * eleven planets and twenty moons inside the draw-call budget.
   */
  private streamRenderers(ctx: EngineContext): void {
    for (const b of this.bodies) {
      b.distanceSq = this.camWorld.distanceToSquared(b.world);
    }

    // Partial selection: we only need the top N, not a full sort.
    const wanted = new Set<Body>();
    const pool = this.bodies.slice();
    pool.sort((a, z) => a.distanceSq - z.distanceSq);
    for (let i = 0; i < Math.min(PLANET_RENDER_BUDGET, pool.length); i++) {
      const b = pool[i]!;
      // Beyond ~60 planet radii a world is a dot; a full quadtree for a dot is
      // waste. The star renderer's point-light impostor covers those.
      if (b.distanceSq < Math.pow(b.spec.radius * 60, 2)) wanted.add(b);
    }

    for (const b of this.bodies) {
      if (wanted.has(b)) this.acquireRenderers(b, ctx);
      else if (b.planet) this.releaseRenderers(b);
    }
  }

  private acquireRenderers(b: Body, _ctx: EngineContext): void {
    if (b.planet) return;
    const q = config.quality;

    b.planet = new PlanetRenderer(b.spec, q);
    this.root.add(b.planet.object3d);

    if (b.spec.clouds) {
      b.clouds = new CloudRenderer(b.spec, q);
      b.planet.object3d.add(b.clouds.object3d);
    }
    if (b.spec.rings) {
      b.rings = new RingRenderer(b.spec.rings, b.spec.radius, q);
      b.planet.object3d.add(b.rings.object3d);
    }
    if (b.spec.atmosphere) {
      b.atmosphere = new AtmosphereRenderer(b.spec, q);
      b.planet.object3d.add(b.atmosphere.object3d);
    }

    bus.emit('planet:approached', {
      planet: b.spec,
      altitudeKm: Math.sqrt(b.distanceSq) - b.spec.radius,
    });
  }

  private releaseRenderers(b: Body): void {
    if (b.clouds) {
      b.clouds.object3d.removeFromParent();
      b.clouds.dispose();
      b.clouds = null;
    }
    if (b.rings) {
      b.rings.object3d.removeFromParent();
      b.rings.dispose();
      b.rings = null;
    }
    if (b.atmosphere) {
      b.atmosphere.object3d.removeFromParent();
      b.atmosphere.dispose();
      b.atmosphere = null;
    }
    if (b.planet) {
      this.root.remove(b.planet.object3d);
      b.planet.dispose();
      b.planet = null;
      bus.emit('planet:left', { planet: b.spec });
    }
  }

  /** Fill each body's ViewState and drive its renderers. */
  private updateBodies(dt: number, ctx: EngineContext): void {
    const primary = this.system.stars[0]!;
    this.star?.lightColor(this.sunColor);

    for (const b of this.bodies) {
      if (!b.planet) continue;

      // Render-space placement.
      ctx.origin.toRender(b.world, this.tmpA);
      b.planet.object3d.position.copy(this.tmpA);
      b.planet.object3d.quaternion.copy(b.spin);

      // Local view: camera and sun expressed in the body's own frame.
      this.tmpB.copy(this.camWorld).sub(b.world);
      this.sunDir.copy(b.world).multiplyScalar(-1).normalize();

      // Inverse-square falloff so a planet at 30 AU is genuinely dim.
      const auDist = b.world.length() / AU;
      const irradiance = primary.luminosity / Math.max(auDist * auDist, 1e-6);
      this.tmpDir.set(this.sunColor.r, this.sunColor.g, this.sunColor.b).multiplyScalar(irradiance);
      this.sunColor.setRGB(this.tmpDir.x, this.tmpDir.y, this.tmpDir.z);

      b.view.set(
        this.tmpB,
        this.sunDir,
        this.sunColor,
        ctx.elapsed,
        (ctx.camera.fov * Math.PI) / 180,
        ctx.height,
      );

      b.planet.update(dt, ctx, b.view);
      b.clouds?.update(dt, ctx, b.view);
      b.rings?.update(dt, ctx, b.view);
      b.atmosphere?.update(dt, ctx, b.view);
    }
  }

  private updateStar(dt: number, ctx: EngineContext): void {
    if (!this.star) return;
    ctx.origin.toRender(this.starWorld, this.tmpA);
    this.star.object3d.position.copy(this.tmpA);

    this.tmpB.copy(this.camWorld).sub(this.starWorld);
    this.sunDir.copy(this.tmpB).normalize().multiplyScalar(-1);
    this.star.lightColor(this.sunColor);
    this.star.object3d.updateMatrixWorld();

    const view = this.starView;
    view.set(
      this.tmpB,
      this.sunDir,
      this.sunColor,
      ctx.elapsed,
      (ctx.camera.fov * Math.PI) / 180,
      ctx.height,
    );
    this.star.update(dt, ctx, view);
  }

  private readonly starView = new MutableViewState();

  /**
   * Track the closest body and the ship's altitude over it, and keep the flight
   * model's ground sampler pointed at whatever we are actually near.
   */
  private updateNearest(): void {
    let best: Body | null = null;
    let bestGap = Infinity;
    for (const b of this.bodies) {
      const gap = Math.sqrt(b.distanceSq) - b.spec.radius;
      if (gap < bestGap) {
        bestGap = gap;
        best = b;
      }
    }

    if (best !== this.nearest) {
      this.nearest = best;
      this.flight.setLandingContext(best ? best.spec : null);
      if (best?.planet) {
        const renderer = best.planet;
        const body = best;
        this.flight.setGroundSampler((worldPos: Vector3) => {
          // Height above the body's centre, in the body's own frame.
          this.tmpDir.copy(worldPos).sub(body.world).normalize();
          return renderer.surfaceRadius(this.tmpDir);
        });
      } else {
        this.flight.setGroundSampler(null);
      }
    }

    this.nearestAltitudeKm = best && bestGap < best.spec.radius * 40 ? bestGap : null;

    // Atmospheric density for drag and re-entry heating.
    if (best?.spec.atmosphere && this.nearestAltitudeKm !== null) {
      const a = best.spec.atmosphere;
      const density = Math.exp(-Math.max(0, this.nearestAltitudeKm) / a.scaleHeight);
      this.flight.setAtmosphere(density * a.pressure);
    } else {
      this.flight.setAtmosphere(0);
    }
  }

  // -------------------------------------------------------------------------
  // Queries used by UI and audio
  // -------------------------------------------------------------------------

  /** Nearby systems for the star map, without generating them all. */
  neighbours(radiusLy = 120, max = 200): StarSystemStub[] {
    return sampleSystemsNear(this.galaxy, this.system.position, radiusLy, max);
  }

  bodyById(id: string): Body | null {
    return this.bodies.find((b) => b.spec.id === id) ?? null;
  }

  /** Every body, for the HUD's target cycling. */
  allBodies(): readonly Body[] {
    return this.bodies;
  }

  get shipObject(): Object3D {
    return this.root;
  }

  dispose(): void {
    this.leaveSystem();
    this.flight.dispose();
    this.root.removeFromParent();
  }
}

export type { Body as UniverseBody };
