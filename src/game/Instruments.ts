/**
 * Instruments — the readouts the HUD cannot derive by itself.
 *
 * Prograde/retrograde markers (GAMEPLAY F1), vertical speed and time-to-impact
 * (F2), ALT measured above terrain against the body VEL is measured against,
 * with that body's name (F2, F11), and a title that names where the ship
 * actually is (F9).
 *
 * A module of its own rather than more of Pilot: Pilot already publishes the
 * vitals, and these readouts need the camera (for projection) and the
 * universe's frame bookkeeping. Registered after Pilot, so its altitude
 * replaces the sphere altitude Pilot fed in the same frame.
 */

import { Vector3 } from 'three';

import type { EngineContext, GameModule } from '@/core/Engine';
import { shotOwnsScene } from '@/game/Shots';
import type { Universe } from '@/game/Universe';
import {
  altitudeContext,
  locationLabel,
  projectToScreen,
  velocityMarkers,
  verticalReadout,
  verticalShown,
  type ScreenPoint,
  type VerticalReadout,
} from '@/game/flightAids';
import type { Hud, HudInstruments } from '@/ui/Hud';
import { assistReadout } from '@/game/assistReadout';
import { cruiseArrivalEta, cruiseReadout } from '@/game/cruiseReadout';
import { WorldMarker } from '@/game/worldMarker';
import type { CruisePhase } from '@/ship/CruiseDrive';

/** What Instruments reads of the cruise drive (T3's public state). Read-only. */
export interface InstrumentsCruise {
  readonly drive: { readonly phase: CruisePhase; readonly progress: number };
}

/** What Instruments reads of Targeting. Read-only. */
export interface InstrumentsTargeting {
  readonly targetId: string | null;
}

/** Below this stick or axis magnitude the pilot is hands-off. */
const INPUT_ACTIVE = 0.02;

export interface InstrumentsOptions {
  readonly universe: Universe;
  readonly hud: Hud;
  /** v3: the drive's state for the cruise readout. Optional for tests/shots. */
  readonly cruise?: InstrumentsCruise | null;
  readonly targeting?: InstrumentsTargeting | null;
}

export class Instruments implements GameModule {
  readonly name = 'instruments';

  private readonly universe: Universe;
  private readonly hud: Hud;
  private readonly cruise: InstrumentsCruise | null;
  private readonly targeting: InstrumentsTargeting | null;

  // Preallocated (ARCHITECTURE §5).
  private readonly pro = new Vector3();
  private readonly retro = new Vector3();
  /** v3 A8: prograde damped in WORLD space, projected every frame. */
  private readonly proMarker = new WorldMarker();
  private readonly toBody = new Vector3();
  private readonly relVel = new Vector3();
  private cruiseWas: CruisePhase = 'idle';
  private readonly screen: ScreenPoint = { x: 0, y: 0, behind: false };
  private readonly vertical: VerticalReadout = { vsiKmS: 0, ttiS: null };
  private readonly packet: HudInstruments = {
    hasVelocity: false,
    proX: 0,
    proY: 0,
    proBehind: true,
    retroX: 0,
    retroY: 0,
    retroBehind: true,
    vsiKmS: null,
    ttiS: null,
    altitudeKm: null,
    altBody: null,
    location: '',
    velFrame: null,
    proxBody: null,
    proxAltKm: null,
  };

  constructor(opts: InstrumentsOptions) {
    this.universe = opts.universe;
    this.hud = opts.hud;
    this.cruise = opts.cruise ?? null;
    this.targeting = opts.targeting ?? null;
  }

  update(dt: number, ctx: EngineContext): void {
    if (shotOwnsScene() || this.universe.paused) return;
    const u = this.universe;
    const flight = u.flight;
    const p = this.packet;

    // --- velocity markers: parent-relative, as VEL is ----------------------
    // v3 A8: the direction is damped in world space and the result projected
    // through this frame's camera, so a turning or shaking camera cannot
    // drag the marker off the sky. Retrograde is its exact opposite.
    p.hasVelocity = velocityMarkers(flight.velocity, this.pro, this.retro);
    if (!p.hasVelocity) this.proMarker.reset();
    if (p.hasVelocity) {
      const d = this.proMarker.step(this.pro, dt);
      this.pro.set(d.x, d.y, d.z);
      this.retro.copy(this.pro).negate();
      projectToScreen(this.pro.x, this.pro.y, this.pro.z, 0, ctx.camera, ctx.width, ctx.height, this.screen);
      p.proX = this.screen.x;
      p.proY = this.screen.y;
      p.proBehind = this.screen.behind;
      projectToScreen(this.retro.x, this.retro.y, this.retro.z, 0, ctx.camera, ctx.width, ctx.height, this.screen);
      p.retroX = this.screen.x;
      p.retroY = this.screen.y;
      p.retroBehind = this.screen.behind;
    }

    // --- altitude: the parent first, so VEL and ALT name the same world ----
    const parent = u.shipParent;
    const parentName = parent ? parent.spec.name : null;
    // v3: ALT keeps v2's choice; VEL names its frame when that differs, and a
    // nearer surface (a moon beside its planet) gets a line of its own.
    // Allocates two small objects per frame; the v2 pickAltitude did one.
    const ac = altitudeContext(
      {
        parentName,
        parentAltKm: parent ? flight.altitude : Number.POSITIVE_INFINITY,
        parentRadiusKm: parent ? parent.spec.radius : 0,
        nearestName: u.nearest ? u.nearest.spec.name : null,
        nearestAltKm: u.nearestAltitudeKm,
      },
      parentName ?? u.system.name,
    );
    const alt = ac.alt;
    p.altitudeKm = alt ? alt.altitudeKm : null;
    p.altBody = alt ? alt.bodyName : null;
    p.velFrame = ac.velFrame;
    p.proxBody = ac.proximity ? ac.proximity.bodyName : null;
    p.proxAltKm = ac.proximity ? ac.proximity.altitudeKm : null;

    // --- vertical speed: along the parent's local vertical -----------------
    // Time-to-impact only counts against the parent: that is the surface the
    // vertical speed is measured towards.
    const onParent = ac.verticalApplies;
    if (verticalShown(parent !== null, this.cruise ? this.cruise.drive.phase : 'idle')) {
      verticalReadout(flight.verticalSpeed, onParent ? alt!.altitudeKm : null, flight.grounded, this.vertical);
      p.vsiKmS = this.vertical.vsiKmS;
      p.ttiS = this.vertical.ttiS;
    } else {
      // In the star's frame "vertical" is radial from the star: a true number
      // that answers no question a pilot is asking. Under cruise likewise
      // (review-v3b): the drive's speed along the nose, not a descent rate.
      p.vsiKmS = null;
      p.ttiS = null;
    }

    p.location = locationLabel(u.system.name, parentName);
    this.hud.setInstruments(p);
    const f = this.universe.flight;
    this.publishCruise();
    this.hud.setAssist(assistReadout(f.assistState, f.assistTargetKmS));
    const ax = ctx.input.axes;
    const sd = ctx.input.stickDeflection;
    this.hud.setControlActivity(
      Math.abs(ax.pitch) > INPUT_ACTIVE ||
        Math.abs(ax.yaw) > INPUT_ACTIVE ||
        Math.abs(ax.roll) > INPUT_ACTIVE ||
        Math.abs(sd.x) > INPUT_ACTIVE ||
        Math.abs(sd.y) > INPUT_ACTIVE,
    );
    // The virtual stick's dot (track A's deflection → track B's HUD mark).
    // Hidden while the pointer is free: the stick only exists under lock.
    const d = ctx.input.stickDeflection;
    this.hud.setStickDeflection(document.pointerLockElement ? d.x : null, d.y);
  }

  /**
   * v3 F: while the drive runs, the throttle block shows the drive. ETA is to
   * what the drive is closing on — the locked body, else the nearest — with
   * the drive's own crossing law, as on the chart.
   */
  private publishCruise(): void {
    const c = this.cruise;
    const phase = c ? c.drive.phase : 'idle';
    if (phase === 'idle') {
      if (this.cruiseWas !== 'idle') this.hud.setCruise(null);
      this.cruiseWas = 'idle';
      return;
    }
    this.cruiseWas = phase;
    const u = this.universe;
    const flight = u.flight;
    let toward = u.nearest;
    let locked = false;
    const id = this.targeting ? this.targeting.targetId : null;
    if (id !== null && id.startsWith('body:')) {
      const bodies = u.allBodies();
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i]!;
        if (id.length === b.spec.name.length + 5 && id.endsWith(b.spec.name)) {
          toward = b;
          locked = true;
          break;
        }
      }
    }
    let eta: number | null = null;
    let closing = false;
    if (toward) {
      this.toBody.subVectors(toward.world, flight.worldPosition);
      this.relVel.copy(flight.velocity);
      if (u.shipParent) this.relVel.add(u.shipParent.worldVelocity);
      this.relVel.sub(toward.worldVelocity);
      closing = this.toBody.dot(this.relVel) > 0;
      eta = cruiseArrivalEta(this.toBody.length(), toward.spec.radius, toward.soiRadius, closing, u.nearestGapKm);
    }
    // Allocates one small object per frame while the drive runs; text only
    // reaches the DOM when it changes (Hud TextSlot).
    this.hud.setCruise(
      cruiseReadout({
        phase,
        progress: c!.drive.progress,
        speedKmS: flight.speed,
        etaS: eta,
        // A locked target is always named; the nearest-body fallback only
        // while closing on it, or the line names the world being left behind.
        destination: toward && (locked || closing) ? toward.spec.name : null,
      }),
    );
  }
}
