/**
 * The pilot: the loop that closes input → physics → hull → camera → instruments.
 *
 * Universe owns *where things are*. Pilot owns *what the player is doing about
 * it*. Keeping them apart means the universe can be simulated headlessly for a
 * review shot with no ship in it at all, and the ship can be flown in a test
 * scene with no universe behind it.
 */

import { Color, Quaternion, Vector3 } from 'three';

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { config } from '@/core/Config';

import { Ship } from '@/ship/Ship';
import { CameraRig, type CameraMode, type LandedFrameSource } from '@/ship/CameraRig';
import { cruiseSpoolNow, flightActivity } from '@/core/flightActivity';
import type { Universe } from '@/game/Universe';
import { shotOwnsScene } from '@/game/Shots';
import type { Hud } from '@/ui/Hud';
import type { Audio } from '@/audio/Audio';
import { resolveJumpKey, type JumpSelection } from '@/game/jumpKey';
import { activeFlightPreset } from '@/game/flightPreset'; // [v2-p4]

/** What `J` needs from the galaxy chart. `StarMap` satisfies it. */
export interface JumpChart {
  selectedTarget(): JumpSelection | null;
  readonly origin: string | null;
}

/** What `J` needs from the jump drive. `Warp` satisfies it. */
export interface JumpDrive {
  readonly phase: string;
}

/** The hull the game opens with. Picked by eye from a batch of generated ships. */
const DEFAULT_SHIP_SEED = 0x5c_0117;

export interface PilotOptions {
  readonly universe: Universe;
  readonly hud?: Hud | null;
  readonly audio?: Audio | null;
  readonly shipSeed?: number;
}

export class Pilot implements GameModule {
  readonly name = 'pilot';

  readonly ship: Ship;
  /** Built in init(), where the camera first exists. */
  rig!: CameraRig;

  private readonly universe: Universe;
  private readonly hud: Hud | null;
  private readonly audio: Audio | null;

  // Preallocated: this runs every frame (ARCHITECTURE §5).
  private readonly renderPos = new Vector3();
  private readonly rcs = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private readonly toBody = new Vector3();
  private readonly shipState = {
    throttle: 0,
    boost: 0,
    heating: 0,
    rcs: this.rcs,
  };
  private readonly vitals = {
    throttle: 0,
    speedKmS: 0,
    altitudeKm: null as number | null,
    pitchRad: 0,
    rollRad: 0,
    gLoad: 1,
  };

  /**
   * What the landed frame needs to know about the world (ship/landedFraming.ts):
   * where the star is, whether there is a sky, and how the ground lies round
   * the hull. Refreshed every frame in update(); the rig only reads it.
   */
  private readonly landedSource: LandedFrameSource = {
    sunDir: new Vector3(1, 0, 0),
    skyWeight: 0,
    groundRiseAt: (offset: Vector3): number => this.groundRiseAt(offset),
  };
  private readonly riseDir = new Vector3();
  private readonly riseQ = new Quaternion();

  constructor(opts: PilotOptions) {
    this.universe = opts.universe;
    this.hud = opts.hud ?? null;
    this.audio = opts.audio ?? null;
    this.ship = new Ship(opts.shipSeed ?? DEFAULT_SHIP_SEED, config.quality);
  }

  init(ctx: EngineContext): void {
    ctx.scene.add(this.ship.object3d);
    // The rig needs a real camera, which only exists once the engine has one.
    this.rig = new CameraRig(ctx.camera);
    // Pilot owns the camera key (it also has to restore the mode after a
    // landing). Leaving the rig's own handler on as well made one press of V
    // cycle twice — chase → orbit → chase — so cockpit and cinematic were
    // unreachable.
    this.rig.handleToggleKey = false;

    bus.on('camera:shake', ({ intensity, duration }) => this.rig.shake(intensity, duration));

    bus.on('ship:touchdown', ({ speed, vertical }) => this.onTouchdown(speed, vertical));
    // A crash is not a landing: the recovery module fades to black and puts
    // the ship back in orbit (GAMEPLAY F6). Entering the landed state here
    // would swing the camera to orbit and then log AIRBORNE on the respawn.
    // This is the only HULL BREACH line; FlightModel no longer logs its own.
    bus.on('ship:crashed', ({ speed }) => {
      bus.emit('log', {
        text: `HULL BREACH — ${(speed * 1000).toFixed(0)} M/S`,
        tone: 'warn',
      });
    });
  }

  /**
   * Grade the arrival and say so. A pilot knows the difference between setting
   * a hull down and arriving at it, and the log is where the game admits it.
   */
  private onTouchdown(speed: number, vertical: number): void {
    this.enterLanded();
    const mps = Math.abs(vertical) * 1000;
    const grade =
      mps < 2 ? 'TOUCHDOWN — CLEAN' : mps < 8 ? 'TOUCHDOWN' : 'TOUCHDOWN — HARD';
    bus.emit('log', {
      text: `${grade} · ${mps.toFixed(1)} M/S`,
      tone: mps < 8 ? 'good' : 'warn',
    });
  }

  private enterLanded(): void {
    if (this.landed) return;
    this.landed = true;
    // Orbit framing puts the hull on the ground with the horizon behind it,
    // which is the read a chase camera cannot give once the ship has stopped:
    // a trailing camera behind a stationary object shows only the object.
    this.modeBeforeLanding = this.rig.mode;
    // Not the inspection orbit: a composed frame, low over the hull and looking
    // along the ground at the sky (DECISIONS open point "the frame on the
    // ground is a flat grey field"; ship/landedFraming.ts).
    this.refreshLandedSource();
    this.rig.setLandedFrame(this.landedSource);
    this.rig.setMode('orbit');
    // Cut the throttle. Sitting on a world with the engines spooled is how a
    // player discovers they have taken off again without meaning to.
    ctxInputSetThrottle(this.lastCtx, 0);
  }

  /** Star direction and sky weight for the landed frame, from the parent world. */
  private refreshLandedSource(): void {
    const body = this.universe.shipParent;
    const src = this.landedSource as { sunDir: Vector3; skyWeight: number };
    if (!body) return;
    // World axes (the star sits at the origin). Not body.view.sunDirection:
    // that is in the world's spinning frame, the camera is not.
    src.sunDir.copy(body.world).negate().normalize();
    // How much of the frame the sky deserves. Pressure, not presence: a trace
    // atmosphere is a black sky with a rim, and gets the ground's share.
    const air = body.spec.atmosphere;
    src.skyWeight = air ? Math.min(1, Math.max(0, (air.pressure - 0.05) * 2)) : 0;
  }

  /**
   * How far the terrain at `offset` (km from the hull, render/world axes)
   * stands above the ground under the hull, km. Takes the higher of the eye
   * spot and the midpoint, so a ridge between the lens and the hull lifts the
   * eye over it rather than hiding the ship. Two terrain samples a frame, only
   * while landed.
   */
  private groundRiseAt(offset: Vector3): number {
    const body = this.universe.shipParent;
    const planet = body?.planet;
    if (!body || !planet) return 0;
    const flight = this.universe.flight;
    const shipR = flight.position.length();
    if (shipR < 1e-9) return 0;
    const groundR = shipR - Math.max(0, Number.isFinite(flight.altitude) ? flight.altitude : 0);
    // The mesh turns with `spin`; the parent frame does not (Universe's ground
    // sampler makes the same conversion).
    this.riseQ.copy(body.spin).invert();
    this.riseDir.copy(offset).add(flight.position).normalize().applyQuaternion(this.riseQ);
    const atEye = planet.surfaceRadius(this.riseDir);
    this.riseDir.copy(offset).multiplyScalar(0.5).add(flight.position).normalize().applyQuaternion(this.riseQ);
    const midway = planet.surfaceRadius(this.riseDir);
    return Math.max(atEye, midway) - groundR;
  }

  private leaveLanded(): void {
    if (!this.landed) return;
    this.landed = false;
    this.rig.setLandedFrame(null);
    this.rig.setMode(this.modeBeforeLanding);
    bus.emit('log', { text: 'AIRBORNE', tone: 'normal' });
  }

  /**
   * Landed state.
   *
   * FlightModel has emitted ship:touchdown and ship:crashed since it was
   * written and nothing ever listened, so the ship could reach the ground,
   * stop, and the game would not acknowledge it. Being on a world is a state
   * the player is in, not an event that passes.
   */
  private landed = false;
  /** The camera mode to restore when the ship lifts off again. */
  private modeBeforeLanding: CameraMode = 'chase';
  private lastCtx: EngineContext | null = null;
  /** [v2-p1a] FA-ON has been applied as the player's default. */
  private faDefaulted = false;

  private chart: JumpChart | null = null;
  private drive: JumpDrive | null = null;

  /**
   * Hand `J` the galaxy chart and the drive. Separate from the constructor
   * because the chart is built after the pilot in registry order.
   */
  attachJump(chart: JumpChart, drive: JumpDrive): void {
    this.chart = chart;
    this.drive = drive;
  }

  /**
   * `J`: jump to the system selected on the galaxy chart (GAMEPLAY B5). It used
   * to be read only by Cruise, to cancel cruise. That still happens; this is
   * the jump itself, through the same request the chart's Enter sends.
   */
  private onJumpKey(): void {
    if (!this.chart) return;
    const r = resolveJumpKey({
      selection: this.chart.selectedTarget(),
      originId: this.chart.origin,
      warpIdle: (this.drive?.phase ?? 'idle') === 'idle',
    });
    if (r.kind === 'jump') {
      bus.emit('nav:jump-requested', { systemId: r.systemId, name: r.name, distanceLy: r.distanceLy });
      bus.emit('log', { text: `JUMP AUTHORISED — ${r.name}`, tone: 'good' });
    } else if (r.kind === 'hint') {
      bus.emit('log', { text: r.text, tone: 'normal' });
    }
  }

  /**
   * F2: save the frame as a PNG.
   *
   * The drawing buffer is not preserved, so it must be read after this frame's
   * render and before the browser composites it. A microtask queued from inside
   * the engine's rAF step runs exactly there: after `step()` has rendered and
   * before control returns to the event loop.
   */
  private screenshot(ctx: EngineContext): void {
    const canvas = ctx.renderer.domElement;
    queueMicrotask(() => {
      canvas.toBlob((blob) => {
        if (!blob) {
          bus.emit('log', { text: 'SCREENSHOT FAILED', tone: 'warn' });
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.href = url;
        a.download = `onespace-${stamp}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        bus.emit('log', { text: 'SCREENSHOT SAVED', tone: 'good' });
      }, 'image/png');
    });
  }

  update(dt: number, ctx: EngineContext): void {
    this.lastCtx = ctx;
    if (shotOwnsScene()) {
      // The ship may be the shot's own subject, framed by its own camera —
      // leave the hull exactly where the shot put it.
      return;
    }
    if (this.universe.paused) {
      this.ship.object3d.visible = false;
      return;
    }
    this.ship.object3d.visible = true;

    const input = ctx.input;
    if (input.pressed('screenshot')) this.screenshot(ctx);
    // Paused or behind the recovery fade: the hull holds still where it is.
    if (this.universe.frozen) return;

    const flight = this.universe.flight;

    // 1. Intent.
    // --- [v2-p1a] flight assist: FA-ON is the player's default, Z toggles it.
    // The FlightModel class defaults to FA-OFF so headless physics stays
    // Newtonian; the first frame turns it on (once) for the player's ship.
    if (!this.faDefaulted) {
      // [v2-p4] the flight preset decides the default (NEWTONIAN = FA-OFF).
      flight.flightAssist = activeFlightPreset().flightAssist;
      this.faDefaulted = true;
    }
    if (input.pressed('flightAssist')) flight.flightAssist = !flight.flightAssist;
    // --- [/v2-p1a]
    flight.applyInput(input.axes, input.held('boost'), input.held('brake'));

    if (input.pressed('toggleCamera')) this.rig.cycleMode();
    if (input.pressed('map')) bus.emit('ui:toggle-map');
    if (input.pressed('codex')) bus.emit('ui:toggle-codex');
    if (input.pressed('warp')) this.onJumpKey();
    // `L` (land) belongs to game/AutoPilot.ts [v2-p4], which runs after this
    // and overwrites the command while it flies. Cruise also reads it, as
    // "stop cruising".

    // 2. Physics already ran inside Universe.update(); read the interpolated
    //    render state so the hull does not stutter between fixed substeps.
    //    The flight model stores the ship relative to its parent body; the
    //    floating origin works in world coordinates, so take the derived one.
    ctx.origin.toRender(flight.renderWorldPosition, this.renderPos);

    // 3. Hull.
    this.rcs.set(input.axes.strafeX, input.axes.strafeY, -input.axes.throttle);
    this.shipState.throttle = flight.throttle;
    this.shipState.boost = flight.boosting ? 1 : 0;
    this.shipState.heating = flight.heating;

    this.ship.object3d.position.copy(this.renderPos);
    this.ship.object3d.quaternion.copy(flight.renderOrientation);
    this.ship.update(dt, ctx, this.shipState);

    // The camera cannot know which way is up on a world. Near a body the local
    // vertical is simply the parent-relative position; in open space there is
    // no such thing and the rig falls back to the hull's own attitude.
    if (this.universe.nearestAltitudeKm !== null) {
      this.rig.setReferenceUp(this.up.copy(flight.position).normalize());
    } else {
      this.rig.setReferenceUp(null);
    }

    if (this.landed) this.refreshLandedSource();

    // 4. Camera.
    // `flight.velocity` is parent-relative, which is what the rig wants: it
    // eases its aim towards the velocity vector, and a world one would point
    // along the planet's orbit around its sun no matter what the pilot did.
    // [v3-T1] What the hull feels — proper acceleration, engine output, cruise
    // spool — so the rig never differentiates positions. Under cruise the ship
    // is carried, not pushed: no thrust rumble. The cruise flags are a
    // fallback from FlightModel alone (core/flightActivity.ts).
    const fa = flightActivity;
    fa.cruiseFallback = flight.cruising;
    const spoolK = dt > 0 ? 1 - Math.exp(-dt / 0.6) : 0;
    fa.cruiseSpoolFallback += ((flight.cruising ? 1 : 0) - fa.cruiseSpoolFallback) * spoolK;
    this.rig.setMotion(flight.properAccel, flight.cruising ? 0 : flight.throttle, cruiseSpoolNow());
    this.rig.update(dt, this.renderPos, flight.renderOrientation, flight.velocity, ctx);

    // The ship leaves the ground the moment the model says it has, rather than
    // on a throttle press — a bounce off a ridge is a departure too.
    if (this.landed && !flight.grounded) this.leaveLanded();

    // 5. Instruments.
    this.publishVitals(flight);
    this.publishAudio(flight);
  }

  private publishVitals(flight: Universe['flight']): void {
    if (!this.hud) return;
    const v = this.vitals;
    v.throttle = flight.throttle;

    // Speed relative to the parent body. There is no other kind any more —
    // see the frame note at the top of FlightModel for why.
    v.speedKmS = flight.speed;
    v.altitudeKm = this.universe.nearestAltitudeKm;
    v.gLoad = flight.gForce;

    // Pitch and roll are only meaningful relative to a local horizon, which
    // only exists when there is a body underneath. In deep space, hold the last
    // value rather than showing a number that means nothing.
    const nearest = this.universe.nearest;
    if (nearest) {
      this.toBody.copy(flight.worldPosition).sub(nearest.world).normalize();
      v.pitchRad = Math.asin(clamp(flight.forward.dot(this.toBody), -1, 1));
      this.up.copy(this.toBody);
      v.rollRad = Math.atan2(flight.right.dot(this.up), flight.up.dot(this.up));
    }
    this.hud.setVitals(v);
  }

  private publishAudio(flight: Universe['flight']): void {
    if (!this.audio) return;
    this.audio.setEngine(flight.throttle, flight.boosting ? 1 : 0);

    const nearest = this.universe.nearest;
    const alt = this.universe.nearestAltitudeKm;
    if (nearest?.spec.atmosphere && alt !== null) {
      const density = Math.exp(-Math.max(0, alt) / nearest.spec.atmosphere.scaleHeight);
      this.audio.setAtmosphere(density, flight.speed);
    } else {
      this.audio.setAtmosphere(0, flight.speed);
    }

    if (nearest) {
      this.audio.setProximity(
        Math.sqrt(nearest.distanceSq),
        nearest.spec.radius,
      );
    }
  }

  dispose(): void {
    this.ship.object3d.removeFromParent();
    this.ship.dispose();
    this.rig.dispose();
  }
}

/** Cut the throttle without reaching through the engine context inline. */
function ctxInputSetThrottle(ctx: EngineContext | null, value: number): void {
  ctx?.input.setThrottle(value);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
