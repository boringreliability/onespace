/**
 * The pilot: the loop that closes input → physics → hull → camera → instruments.
 *
 * Universe owns *where things are*. Pilot owns *what the player is doing about
 * it*. Keeping them apart means the universe can be simulated headlessly for a
 * review shot with no ship in it at all, and the ship can be flown in a test
 * scene with no universe behind it.
 */

import { Color, Vector3 } from 'three';

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { config } from '@/core/Config';

import { Ship } from '@/ship/Ship';
import { CameraRig } from '@/ship/CameraRig';
import type { Universe } from '@/game/Universe';
import { shotOwnsScene } from '@/game/Shots';
import type { Hud } from '@/ui/Hud';
import type { Audio } from '@/audio/Audio';

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

    bus.on('camera:shake', ({ intensity, duration }) => this.rig.shake(intensity, duration));
  }

  update(dt: number, ctx: EngineContext): void {
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

    const flight = this.universe.flight;
    const input = ctx.input;

    // 1. Intent.
    flight.applyInput(input.axes, input.held('boost'), input.held('brake'));

    if (input.pressed('toggleCamera')) this.rig.cycleMode();
    if (input.pressed('map')) bus.emit('ui:toggle-map');
    if (input.pressed('codex')) bus.emit('ui:toggle-codex');

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

    // 4. Camera.
    // `flight.velocity` is parent-relative, which is what the rig wants: it
    // eases its aim towards the velocity vector, and a world one would point
    // along the planet's orbit around its sun no matter what the pilot did.
    this.rig.update(dt, this.renderPos, flight.renderOrientation, flight.velocity, ctx);

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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
