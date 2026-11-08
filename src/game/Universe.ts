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

import { Color, Group, Object3D, Quaternion, Vector3 } from 'three';

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
import { keyLightAt } from '@/render/keyLight';
import { PlanetRenderer } from '@/render/Planet';
import { CloudRenderer } from '@/render/Clouds';
import { RingRenderer } from '@/render/Rings';
import { StarRenderer } from '@/render/Star';
import { AtmosphereRenderer } from '@/render/Atmosphere';
import { sceneDepthTexture, setMotionReferenceDisplacement } from '@/render/PostFX';
import { publishSceneDepth } from '@/game/sceneDepth';
import { referenceDisplacement } from '@/render/motionReference';
import { planStreaming, type StreamCandidate } from '@/game/streaming';
import { simSlices } from '@/game/timeCompression'; // [v2-p4]
import { openSpaceArrivalAttitude } from '@/ship/arrivalFraming'; // [v3-T4]
import { circularOrbitState, insideStar, openingAttitude, progradeAttitude, starRadiusKm } from '@/game/recovery';

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

  /**
   * Set by the pause overlay and by the recovery fade. Unlike `paused` (which
   * MapMode rewrites every frame and which hides the world for the chart),
   * this freezes the simulation and leaves the scene on screen behind it.
   */
  frozen = false;

  /**
   * [v2-p4] Time-compression factor applied to simulated time (1, 10, 100).
   * Written only by game/TimeCompression.ts, which owns when it is legal.
   */
  simRate = 1;
  private readonly slices = { count: 0, slice: 0 };
  /**
   * [v3-t3] Called before each sim slice is integrated, with its length.
   * The autopilot flies here (registry wires `AutoPilot.sliceStep`), so at
   * 10× it writes a fresh command every slice instead of one per frame.
   */
  beforeSlice: ((h: number) => void) | null = null;
  /**
   * Simulated seconds the last update advanced: dt × simRate within the
   * per-frame budget, 0 while paused, frozen or under a shot. Traffic runs
   * its clock on this so co-orbiting hulls keep pace under compression.
   */
  simulatedSeconds = 0;

  /** True while the ship is at or below the star's photosphere (GAMEPLAY F7). */
  insideStar = false;

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
  /** Camera minus hull, render/world axes, km — see update(). */
  private readonly eyeOffset = new Vector3();
  private readonly sunDir = new Vector3();
  private readonly sunColor = new Color();
  private readonly bodySun = new Color();
  private readonly spinInv = new Quaternion();
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
      // StarSpec.radius is in SOLAR radii; ParentBody.radius is km. Passing it
      // raw made the star-frame altimeter measure to a 1 km ball.
      radius: starRadiusKm(primary),
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
      // [v3-T4] arrival framing (PLAN E6): a system with no world used to put
      // the nose dead on the star, which the chase camera then hid exactly
      // behind the hull — 20 s of empty sky, measured. Hold the star in frame
      // above the hull instead; there is no orbit, so no prograde to keep.
      this.tmpA.set(0, 0, 6 * AU);
      this.tmpB.copy(this.tmpA).multiplyScalar(-1).normalize();
      openSpaceArrivalAttitude(this.tmpB, this.arrivalQuat);
      this.flight.teleport(this.tmpA, this.tmpB.set(0, 0, 0), this.arrivalQuat);
      // [/v3-T4]
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

    // Circular velocity about the planet — and nothing else. The planet's own
    // 49 km/s about the star used to be added here by hand; it is now implicit
    // in the parent frame, which is the whole point of the change.
    this.flight.orbitalVelocityAt(this.tmpA, this.tmpB);
    // Nose prograde, roof radially out (GAMEPLAY F8). It used to point at the
    // planet's centre, which framed the world nicely and made the first press
    // of W a dive. Prograde keeps the world filling the lower frame and makes
    // the throttle mean "faster along the orbit".
    // …pitched 30° down towards the limb (v2 merge): a purely prograde nose
    // put the limb 51° below it, outside the chase view — the opening shot
    // was empty sky. See game/openingAttitude.test.ts.
    openingAttitude(this.tmpB, this.tmpA, this.arrivalQuat);
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

  private readonly arrivalQuat = new Quaternion();

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
    this.simulatedSeconds = 0;
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
    if (this.frozen) {
      // The world still draws while frozen (an overlay is up), so the shells
      // must still follow the composer's ping-pong; see game/sceneDepth.ts.
      publishSceneDepth(this.bodies, sceneDepthTexture());
      return;
    }

    // [v2-p4] Time compression: `simRate` (1/10/100, set only by
    // game/TimeCompression.ts) scales SIMULATED time, here and nowhere else —
    // renderers, camera and UI below keep real dt. Advanced in slices because
    // FlightModel drops anything past 8 substeps a call; see
    // game/timeCompression.ts. At 1× this is one slice of exactly dt, i.e.
    // the previous code path.
    // Where the lens is relative to the hull, measured on last frame's poses
    // (the rig runs after us). Every renderer's `cameraLocal` used to be the
    // SHIP's position, which is a fine approximation in flight and a fatal one
    // on the ground: a ship sitting at sea level put the atmosphere's and the
    // clouds' ray origin exactly on the analytic planet sphere, float32 then
    // decided frame by frame whether the eye was inside the planet, and when
    // it was every sky ray was clipped to zero length — the whole sky blinked
    // black (measured: 1 frame in 12 on the home world). It also aimed the
    // sea's Fresnel and glint from 70 m beside the real eye.
    if (!this.options.headless) {
      ctx.origin.toRender(this.flight.renderWorldPosition, this.tmpA);
      this.eyeOffset.copy(ctx.camera.position).sub(this.tmpA);
      // A warp, a recovery or the first frame: the camera is somewhere else
      // entirely and the offset means nothing. Photo mode stays within this.
      if (this.eyeOffset.lengthSq() > 50 * 50) this.eyeOffset.set(0, 0, 0);
    }

    simSlices(dt, this.simRate, this.slices);
    this.simulatedSeconds = this.slices.count * this.slices.slice;
    for (let i = 0; i < this.slices.count; i++) {
      const h = this.slices.slice;
      this.orbitTime += h * ORBIT_TIME_SCALE;
      this.updateOrbits();
      if (!this.options.headless) {
        // [v3-t3] per-slice air and guidance: at 10× a frame is several
        // slices, and both used to be one frame stale for all of them.
        if (this.slices.count > 1) this.refreshAtmosphere();
        this.beforeSlice?.(h);
        // [/v3-t3]
        this.flight.update(h);
        // Transitions are checked AFTER integration, so a substep is never
        // taken with the state vector and the frame disagreeing.
        this.updateShipParent();
      }
    }
    // [/v2-p4]

    if (!this.options.headless) {
      this.camWorld.copy(this.flight.worldPosition).add(this.eyeOffset);
    } else {
      ctx.origin.toWorld(ctx.camera.position, this.camWorld);
    }

    // Rebase before computing render positions so everything shifts together.
    ctx.origin.rebaseIfNeeded(ctx.origin.toRender(this.camWorld, this.tmpA), this.tmpB);

    this.streamRenderers(ctx);
    this.updateBodies(dt, ctx);
    this.updateStar(dt, ctx);
    this.updateNearest();
    this.publishMotionReference();
  }

  /**
   * Tell the motion blur where the ground under the ship went this frame
   * (render/motionReference.ts). Without it a landed frame reprojects as a
   * ~1 km per frame dolly and the hull and the near ground smear.
   */
  private publishMotionReference(): void {
    const b = this.options.headless ? null : this.shipParent;
    if (b && b === this.refBody) {
      referenceDisplacement(this.refWorld, this.refSpin, b.world, b.spin, this.flight.position, this.refOut);
      setMotionReferenceDisplacement(this.refOut);
    } else {
      setMotionReferenceDisplacement(null);
    }
    this.refBody = b;
    if (b) {
      this.refWorld.copy(b.world);
      this.refSpin.copy(b.spin);
    }
  }

  private refBody: Body | null = null;
  private readonly refWorld = new Vector3();
  private readonly refSpin = new Quaternion();
  private readonly refOut = new Vector3();

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
      const carry = b === this.shipParent && this.flight.grounded;
      if (carry) this.spinDelta.copy(b.spin).invert();
      b.spin.setFromAxisAngle(this.tmpDir, spin);
      // A landed ship turns with its world (FlightModel.carryWithSurface).
      if (carry) this.flight.carryWithSurface(this.spinDelta.premultiply(b.spin));
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

    // Acquire at 60 radii, release at 75 — see game/streaming.ts for why the
    // two thresholds differ. The candidate array is reused across frames.
    const cands = this.streamCandidates;
    while (cands.length < this.bodies.length) cands.push({ distanceKm: 0, radiusKm: 1, streamed: false });
    cands.length = this.bodies.length;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i]!;
      const c = cands[i]!;
      c.distanceKm = Math.sqrt(b.distanceSq);
      c.radiusKm = b.spec.radius;
      c.streamed = b.planet !== null;
    }
    const wanted = planStreaming(cands, PLANET_RENDER_BUDGET, this.streamWanted);

    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i]!;
      if (wanted[i]) this.acquireRenderers(b, ctx);
      else if (b.planet) this.releaseRenderers(b);
    }
  }

  private streamCandidates: Array<{ -readonly [K in keyof StreamCandidate]: StreamCandidate[K] }> = [];
  private streamWanted: boolean[] = [];

  private acquireRenderers(b: Body, ctx: EngineContext): void {
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

    // Compile the new world's programs off the critical path. Without this
    // the first frame that draws it links them synchronously — 140-740 ms of
    // frozen screen at exactly the moment a planet comes into view. The
    // object stays hidden until its programs are ready; at 60 radii it is a
    // few pixels across, so a frame or two of absence is invisible.
    const obj = b.planet.object3d;
    obj.visible = false;
    const planet = b.planet;
    // The scene graph alone misses the heaviest programs: the terrain bake
    // and shadow clipmap, and the cloud/atmosphere marches, live in private
    // scenes (phase-0 review #4). Each renderer compiles its own.
    const settled = Promise.all([
      ctx.renderer.compileAsync(obj, ctx.camera, ctx.scene),
      planet.compileAsync(ctx.renderer, ctx.camera),
      b.clouds?.compileAsync(ctx.renderer, ctx.camera),
      b.atmosphere?.compileAsync(ctx.renderer, ctx.camera),
    ])
      .catch(() => undefined)
      .then(() => {
        this.pendingCompile.delete(planet);
        // Released while compiling: a new renderer may now own the slot.
        if (b.planet === planet) obj.visible = true;
      });
    this.pendingCompile.set(planet, settled);

    bus.emit('planet:approached', {
      planet: b.spec,
      altitudeKm: Math.sqrt(b.distanceSq) - b.spec.radius,
    });
  }

  /**
   * Programs still compiling, per planet renderer. Disposing a material while
   * three's compileAsync is polling it throws inside a setTimeout (its
   * properties are gone) and the promise never settles — so a release that
   * lands mid-compile detaches at once and disposes when the compile is done.
   */
  private pendingCompile = new Map<PlanetRenderer, Promise<void>>();

  private afterCompile(planet: PlanetRenderer | null, fn: () => void): void {
    const pending = planet ? this.pendingCompile.get(planet) : undefined;
    if (pending) void pending.then(fn);
    else fn();
  }

  private releaseRenderers(b: Body): void {
    const planet = b.planet;
    if (b.clouds) {
      const clouds = b.clouds;
      clouds.object3d.removeFromParent();
      this.afterCompile(planet, () => clouds.dispose());
      b.clouds = null;
    }
    if (b.rings) {
      const rings = b.rings;
      rings.object3d.removeFromParent();
      this.afterCompile(planet, () => rings.dispose());
      b.rings = null;
    }
    if (b.atmosphere) {
      const atmosphere = b.atmosphere;
      atmosphere.object3d.removeFromParent();
      this.afterCompile(planet, () => atmosphere.dispose());
      b.atmosphere = null;
      b.planet?.setAtmosphereShell(false);
    }
    if (planet) {
      this.root.remove(planet.object3d);
      this.afterCompile(planet, () => planet.dispose());
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

      // Local view: camera and sun expressed in the body's own frame — which
      // turns. The mesh carries `spin` (above), so a world-axes camera and sun
      // handed to it are off by the spin angle. That was invisible at boot
      // and grew with play: by touchdown on the home world it was 0.054
      // degrees, i.e. the planet's idea of where the eye stood was 6.8 km
      // from the eye. Its LOD ring was centred there and every fragment near
      // the lens measured its pixel footprint from 6.8 km away, so the fine
      // detail faded out exactly where the landed frame looks (v2-landed).
      this.spinInv.copy(b.spin).invert();
      this.tmpB.copy(this.camWorld).sub(b.world).applyQuaternion(this.spinInv);
      this.sunDir.copy(b.world).multiplyScalar(-1).normalize().applyQuaternion(this.spinInv);

      // Inverse-square falloff, compressed below a knee (render/keyLight.ts)
      // so an outer world is dim but lit — raw, Fyss VIII at 3.55 AU got
      // 1/1300 of the opening world's light and drew as a black disc. The
      // player's hull and traffic take the same key light. Into a per-body
      // colour: scaling the shared one in place compounded every earlier
      // body's irradiance into the next (a moon after its planet got both).
      const irradiance = keyLightAt(primary.luminosity, b.world.length());
      this.bodySun.setRGB(
        this.sunColor.r * irradiance,
        this.sunColor.g * irradiance,
        this.sunColor.b * irradiance,
      );

      b.view.set(
        this.tmpB,
        this.sunDir,
        this.bodySun,
        ctx.elapsed,
        (ctx.camera.fov * Math.PI) / 180,
        ctx.height,
      );

      b.planet.update(dt, ctx, b.view);
      // Before update(): the deck renders its march there, not in the scene pass.
      b.clouds?.setDepthTexture(sceneDepth);
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
      // Into the planet's own frame: the mesh is rotated by `spin`, the parent
      // frame is not. Sampling the unrotated direction put collision terrain
      // and drawn terrain out of step, drifting ~0.5 km/s at the surface.
      this.samplerQuat.copy(body.spin).invert();
      this.tmpDir.copy(relPos).divideScalar(dist).applyQuaternion(this.samplerQuat);
      return dist - renderer.surfaceRadius(this.tmpDir);
    });
  }

  private samplerBody: Body | null = null;
  private readonly samplerQuat = new Quaternion();
  private readonly spinDelta = new Quaternion();
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
    const starDist = this.tmpA.subVectors(this.flight.worldPosition, this.starWorld).length();
    const starR = starRadiusKm(this.system.stars[0]);
    const starGap = starDist - starR;
    this.insideStar = !this.options.headless && insideStar(starDist, starR);
    this.nearestGapKm = Math.max(0, Math.min(bestGap, starGap));

    this.syncGroundSampler();

    // Atmospheric density for drag and re-entry heating. Read from the PARENT:
    // drag acts against the air's own motion, and the air moves with the body
    // whose frame the ship's velocity is already expressed in. Taking it from
    // `nearest` would let a moon you are flying past brake you against a
    // planet's atmosphere.
    this.refreshAtmosphere();
  }

  /** Hand the flight model the parent's air density at the ship (see above). */
  private refreshAtmosphere(): void {
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

  /**
   * Put the ship back into a stable circular orbit (GAMEPLAY F6/F7, P5) —
   * 0.6 R above where it came down, nose prograde. Around the parent world,
   * or the nearest body when the parent is the star (a star contact), or the
   * opening world as a last resort. A teleport: call it behind black.
   */
  recoverToOrbit(): void {
    if (this.options.headless) return;
    const body = this.shipParent ?? this.nearest ?? this.pickHeroBody();
    this.flight.setCruise(null);
    if (!body) {
      this.setShipParent(null);
      this.flight.teleport(this.tmpA.set(0, 0, 6 * AU), this.tmpB.set(0, 0, 0));
      this.insideStar = false;
      return;
    }
    const radial = this.tmpA.subVectors(this.flight.worldPosition, body.world);
    const state = circularOrbitState(radial, body.spec.radius, body.frame.mu);
    this.setShipParent(body);
    this.flight.teleport(state.position, state.velocity, state.orientation);
    this.syncGroundSampler();
    this.insideStar = false;
    // review-p4: the same parent comes back, so nothing else told a flying
    // autopilot that its leg was cut — it dived straight back in. The one
    // caller, RecoveryCut, emits `ship:recovered` (with its cause) right after
    // this; AutoPilot, TimeControl and Cruise all listen to that one event.
  }

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
