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
  SOLAR_RADIUS,
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
import { sceneDepthTexture } from '@/render/PostFX';

import {
  DEFAULT_SHIP_CONFIG,
  entersSoi,
  FlightModel,
  leavesSoi,
  SOI_MIN_RADII,
  soiRadius,
  type ParentBody,
} from '@/ship/FlightModel';

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
  /** World velocity, km/s — its own Keplerian motion plus every parent's. */
  readonly worldVelocity: Vector3;
  /** Position relative to its parent (or the star), kilometres. */
  readonly local: Vector3;
  /**
   * The ship's-eye view of this body: world position and velocity by reference
   * (so the ship follows the body for free), plus mu and radius. Handed
   * straight to `FlightModel.rebase()`.
   */
  readonly frame: ParentBody;
  /**
   * Sphere-of-influence radius, km. Computed once at system entry — it depends
   * only on the semi-major axis and the two masses, none of which change.
   */
  soiRadius: number;
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
   * The clock every body's position is a function of. The local chart needs it
   * to place bodies itself rather than reading back positions it cannot see.
   */
  get orbitSeconds(): number {
    return this.orbitTime;
  }

  /**
   * Set while the galaxy chart is open. The system keeps existing — it simply
   * stops advancing, so returning to flight does not teleport every moon.
   */
  paused = false;

  /** Nearest body, recomputed each frame — the HUD and audio both want it. */
  nearest: Body | null = null;
  nearestAltitudeKm: number | null = null;
  /**
   * Distance to the nearest surface anywhere in the system, km — every body
   * plus the star. Unlike `nearestAltitudeKm` this is never null: the cruise
   * drive turns it directly into a speed ceiling, so a missing value would be
   * a missing speed limit.
   */
  nearestGapKm = Number.POSITIVE_INFINITY;

  /**
   * The body the ship's state vector is stored relative to, or null for the
   * star. Exactly one body's gravity acts, and this is it.
   */
  shipParent: Body | null = null;

  // Preallocated scratch. Nothing in update() may allocate (ARCHITECTURE §5).
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpDir = new Vector3();
  private readonly camWorld = new Vector3();
  private readonly sunDir = new Vector3();
  private readonly sunColor = new Color();
  private readonly starWorld = new Vector3();
  /** The star does not move in its own system's frame. Never written. */
  private readonly starVelocity = new Vector3();
  private starFrame: ParentBody = { position: this.starWorld, velocity: this.starVelocity, mu: 0 };
  private readonly orbitScratch = { x: 0, y: 0, z: 0 };
  private readonly velScratch = { x: 0, y: 0, z: 0 };

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

    // The root of the parent chain. Pinned at the world origin with zero
    // velocity by construction, so it needs no per-frame maintenance.
    this.starFrame = {
      position: this.starWorld,
      velocity: this.starVelocity,
      mu: MU_SUN * primary.mass,
      radius: primary.radius,
    };

    // Flatten planets and moons into one list. Moons carry a parent pointer so
    // their world position composes rather than orbiting the star directly.
    for (const spec of system.planets) {
      const body = this.makeBody(spec, null);
      this.bodies.push(body);
      for (const moonSpec of spec.moons) {
        this.bodies.push(this.makeBody(moonSpec, body));
      }
    }

    // r_soi = a·(m/M)^(2/5), once per body — a, m and M are all constants of
    // the generated system, so this never needs recomputing. The floor is the
    // one concession to playability; see SOI_MIN_RADII.
    for (const b of this.bodies) {
      b.soiRadius = Math.max(
        soiRadius(
          b.spec.orbit.semiMajorAxis,
          b.frame.mu,
          b.parent ? b.parent.frame.mu : this.starFrame.mu,
        ),
        b.spec.radius * SOI_MIN_RADII,
      );
    }

    this.orbitTime = 0;
    this.updateOrbits();

    if (!this.options.headless) {
      this.camWorld.set(0, 0, 0);
      for (const b of this.bodies) b.distanceSq = 0;
      this.placeShipOnArrival();
    }

    bus.emit('system:entered', { system });
    bus.emit('log', { text: `ARRIVED — ${system.name.toUpperCase()}`, tone: 'good' });
  }

  private makeBody(spec: PlanetSpec, parent: Body | null): Body {
    const world = new Vector3();
    const worldVelocity = new Vector3();
    return {
      spec,
      parent,
      world,
      worldVelocity,
      // Same Vector3 objects, not copies: the flight model holds this frame by
      // reference, so the body orbiting moves the ship with it at zero cost.
      frame: {
        position: world,
        velocity: worldVelocity,
        mu: MU_EARTH * spec.mass,
        radius: spec.radius,
      },
      soiRadius: 0,
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
      this.setShipParent(null);
      this.flight.teleport(new Vector3(0, 0, 6 * AU));
      return;
    }
    // The world we arrive at becomes the parent, so everything below is stated
    // in ITS frame: the offset is parent-relative and so is the velocity.
    this.setShipParent(target);

    // 1.6 radii, not 2.6. Arrival should put the world within a minute or two
    // of thrust, not an hour: at 0.25 km/s^2 a 2.6-radius standoff is a
    // four-minute burn each way before anything happens.
    const alt = target.spec.radius * 1.6;
    // Offset towards the star so the terminator crosses the frame.
    this.tmpA.copy(target.world).normalize().multiplyScalar(-1);
    this.tmpA.y += 0.35;
    this.tmpA.normalize().multiplyScalar(alt);

    // Point the nose at the world we just arrived at. Position alone is not
    // enough: dropping in with a default orientation aims the camera at empty
    // space, and the opening frame is the one frame that has to earn the next
    // ten minutes.
    this.arrivalLook.copy(this.tmpA).normalize().multiplyScalar(-1);
    // "Up" here is radial from the STAR, not from the planet — the latter is
    // antiparallel to the look direction and degenerates the basis.
    this.arrivalUp.copy(target.world).add(this.tmpA).normalize();
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

    // Circular velocity about the planet — and nothing else. The planet's own
    // 49 km/s about the star used to be added here by hand; it is now implicit
    // in the parent frame, which is the whole point of the change.
    this.flight.orbitalVelocityAt(this.tmpA, this.tmpB);
    this.flight.teleport(this.tmpA, this.tmpB, this.arrivalQuat);
    this.syncGroundSampler();
  }

  /**
   * World velocity of a body: its own Keplerian motion plus every parent's, so
   * a moon carries its planet's motion around the star. Maintained by
   * `updateOrbits()`; this is a copy of the cached value.
   */
  bodyVelocity(body: Body, out: Vector3): Vector3 {
    return out.copy(body.worldVelocity);
  }

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
    // Every Body about to be dropped is also a frame something might still be
    // holding. Clear the ship's parent explicitly rather than leaving it
    // pointing at a body from a system that no longer exists.
    this.shipParent = null;
    this.nearest = null;
    this.samplerBody = null;
    this.samplerRenderer = null;
    this.flight.setGroundSampler(null);
    this.flight.setParent(null);
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
      this.flight.update(dt);
      // Transitions are checked AFTER integration, so a substep is never taken
      // with the state vector and the frame disagreeing.
      this.updateShipParent();
      this.camWorld.copy(this.flight.worldPosition);
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

  /**
   * Advance every body's Keplerian position and velocity. Moons compose onto
   * their parent, which works because `bodies` is built planets-first, so a
   * parent is always updated before its children in a single pass.
   *
   * Velocity is maintained here rather than derived on demand because it is now
   * load-bearing: it *is* the frame the ship flies in, held by reference.
   */
  private updateOrbits(): void {
    for (const b of this.bodies) {
      orbitalPosition(b.spec.orbit, this.orbitTime, this.orbitScratch);
      b.local.set(this.orbitScratch.x, this.orbitScratch.y, this.orbitScratch.z);
      orbitalVelocity(
        b.spec.orbit,
        this.orbitTime,
        b.parent ? b.parent.frame.mu : this.starFrame.mu,
        this.velScratch,
      );
      b.worldVelocity.set(this.velScratch.x, this.velScratch.y, this.velScratch.z);
      if (b.parent) {
        b.world.copy(b.parent.world).add(b.local);
        b.worldVelocity.add(b.parent.worldVelocity);
      } else {
        b.world.copy(b.local);
      }

      // Axial rotation. Negative period means retrograde, which the modulo
      // handles for free.
      const spin = b.spec.rotationPeriod !== 0
        ? (this.orbitTime / b.spec.rotationPeriod) * Math.PI * 2
        : 0;
      this.tmpDir.set(Math.sin(b.spec.axialTilt), Math.cos(b.spec.axialTilt), 0).normalize();
      b.spin.setFromAxisAngle(this.tmpDir, spin);
    }
  }

  /**
   * Declare the ship's parent without converting its state. Only legitimate
   * when the state is about to be overwritten — system entry, warp arrival.
   * In flight, `updateShipParent()` is the only route, and it goes via
   * `FlightModel.rebase()`.
   */
  private setShipParent(body: Body | null): void {
    this.shipParent = body;
    this.flight.setParent(body ? body.frame : this.starFrame);
    this.flight.setLandingContext(body ? body.spec : null);
  }

  /**
   * Patched conics: check once per frame, after the ship has been integrated,
   * whether it has crossed a sphere-of-influence boundary.
   *
   * Descending into a child's SOI and ascending out of the current one are the
   * same operation with the roles swapped, and both are performed by
   * `FlightModel.rebase()` — the one function in the project that crosses
   * frames. Nothing here touches the state vector itself.
   */
  private updateShipParent(): void {
    const parent = this.shipParent;

    // --- ascend: outside the current parent's SOI ---------------------------
    if (parent) {
      if (leavesSoi(this.flight.position.length(), parent.soiRadius)) {
        this.rebaseShip(parent.parent);
        // Fall through: leaving a moon's SOI may drop us straight into a
        // sibling's, and waiting a frame would integrate one step in the wrong
        // frame. One transition per direction per frame is enough.
      }
    }

    // --- descend: inside a child's SOI --------------------------------------
    const current = this.shipParent;
    for (const b of this.bodies) {
      if (b.parent !== current || b === current) continue;
      const gap = this.tmpA.subVectors(this.flight.worldPosition, b.world).length();
      if (entersSoi(gap, b.soiRadius)) {
        this.rebaseShip(b);
        break;
      }
    }
  }

  private rebaseShip(next: Body | null): void {
    if (next === this.shipParent) return;
    this.shipParent = next;
    this.flight.rebase(next ? next.frame : this.starFrame);
    this.flight.setLandingContext(next ? next.spec : null);
    this.syncGroundSampler();
    bus.emit('log', {
      text: next
        ? `SOI — ${next.spec.name.toUpperCase()}`
        : `SOI — ${this.system.stars[0]!.name.toUpperCase()}`,
      tone: 'normal',
    });
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
      // The surface shader carries a cheap limb glow, Mie crescent, sunset band
      // and aerial haze of its own. With a real scattering shell attached they
      // are the same light computed twice, and the limb comes out blown. The
      // cheap path stays on by default so a world nobody wired still has air.
      b.planet.setAtmosphereShell(true);
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
      b.planet?.setAtmosphereShell(false);
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

    // Scene depth is what turns an atmosphere from a shell around a smooth
    // sphere into aerial perspective over real terrain, and it is also what
    // stops the sky drawing over the cockpit once the ship is in the air.
    // Re-published every frame rather than once at acquisition: renderers are
    // streamed in and out by distance, and the texture itself is replaced
    // whenever the drawing buffer is resized. Null when no pipeline owns the
    // frame (the ship-review host, tests) — the shell degrades to its analytic
    // fallback and nothing breaks.
    const sceneDepth = sceneDepthTexture();

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
      if (b.atmosphere) {
        b.atmosphere.setDepthTexture(sceneDepth);
        b.atmosphere.update(dt, ctx, b.view);
      }
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
   * The terrain query, installed for the ship's PARENT rather than for whatever
   * body happens to be nearest. You cannot land on something you are not in the
   * sphere of influence of, and the parent is the one body whose frame the
   * sampler's argument is already in — so there is no world-space round trip
   * and no way for the ground to slide out from under the ship.
   *
   * Re-checked every frame against the renderer as well as the body: renderers
   * stream in and out by distance, and the old code only re-installed when the
   * body changed, so a sampler could stay null after its planet arrived.
   */
  private syncGroundSampler(): void {
    const body = this.shipParent;
    const renderer = body?.planet ?? null;
    if (body === this.samplerBody && renderer === this.samplerRenderer) return;
    this.samplerBody = body;
    this.samplerRenderer = renderer;

    if (!body || !renderer) {
      this.flight.setGroundSampler(null);
      return;
    }
    this.flight.setGroundSampler((relPos: Vector3) => {
      // ALTITUDE above the terrain, not the terrain's radius. The flight
      // model treats a negative return as penetration and pushes out along
      // the surface normal; handing it a radius meant it saw ~11,000 km of
      // clearance everywhere and the ship flew straight through the ground.
      const dist = relPos.length();
      if (dist < 1e-9) return -body.spec.radius;
      this.tmpDir.copy(relPos).divideScalar(dist);
      return dist - renderer.surfaceRadius(this.tmpDir);
    });
  }

  private samplerBody: Body | null = null;
  private samplerRenderer: PlanetRenderer | null = null;

  /**
   * Track the closest body — the HUD's altimeter and the audio proximity both
   * want it, and it is not necessarily the parent (a moon you are passing).
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
    this.nearest = best;
    this.nearestAltitudeKm = best && bestGap < best.spec.radius * 40 ? bestGap : null;

    // Clearance to the nearest surface in the whole system, always — including
    // the star, which is not in `bodies` and is the one thing in a system you
    // most want a fast drive to notice. The altimeter deliberately reports
    // null once a body is far away; the cruise drive needs the number at every
    // range, because the number IS its speed limit.
    const starGap =
      this.tmpA.subVectors(this.flight.worldPosition, this.starWorld).length() -
      (this.system.stars[0]?.radius ?? 0) * SOLAR_RADIUS;
    this.nearestGapKm = Math.max(0, Math.min(bestGap, starGap));

    this.syncGroundSampler();

    // Atmospheric density for drag and re-entry heating. Read from the PARENT:
    // drag acts against the air's own motion, and the air moves with the body
    // whose frame the ship's velocity is already expressed in. Taking it from
    // `nearest` would let a moon you are flying past brake you against a
    // planet's atmosphere.
    const air = this.shipParent?.spec.atmosphere;
    if (air) {
      const altitude = this.flight.position.length() - this.shipParent!.spec.radius;
      const density = Math.exp(-Math.max(0, altitude) / air.scaleHeight);
      this.flight.setAtmosphere(density * air.pressure);
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
