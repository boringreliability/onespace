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
  locationLabel,
  pickAltitude,
  projectToScreen,
  velocityMarkers,
  verticalReadout,
  type ScreenPoint,
  type VerticalReadout,
} from '@/game/flightAids';
import type { Hud, HudInstruments } from '@/ui/Hud';
import { assistReadout } from '@/game/assistReadout';

export interface InstrumentsOptions {
  readonly universe: Universe;
  readonly hud: Hud;
}

export class Instruments implements GameModule {
  readonly name = 'instruments';

  private readonly universe: Universe;
  private readonly hud: Hud;

  // Preallocated (ARCHITECTURE §5).
  private readonly pro = new Vector3();
  private readonly retro = new Vector3();
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
  };

  constructor(opts: InstrumentsOptions) {
    this.universe = opts.universe;
    this.hud = opts.hud;
  }

  update(_dt: number, ctx: EngineContext): void {
    if (shotOwnsScene() || this.universe.paused) return;
    const u = this.universe;
    const flight = u.flight;
    const p = this.packet;

    // --- velocity markers: parent-relative, as VEL is ----------------------
    p.hasVelocity = velocityMarkers(flight.velocity, this.pro, this.retro);
    if (p.hasVelocity) {
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
    const alt = pickAltitude({
      parentName,
      parentAltKm: parent ? flight.altitude : Number.POSITIVE_INFINITY,
      parentRadiusKm: parent ? parent.spec.radius : 0,
      nearestName: u.nearest ? u.nearest.spec.name : null,
      nearestAltKm: u.nearestAltitudeKm,
    });
    p.altitudeKm = alt ? alt.altitudeKm : null;
    p.altBody = alt ? alt.bodyName : null;

    // --- vertical speed: along the parent's local vertical -----------------
    // Time-to-impact only counts against the parent: that is the surface the
    // vertical speed is measured towards.
    const onParent = alt !== null && parentName !== null && alt.bodyName === parentName;
    if (parent) {
      verticalReadout(flight.verticalSpeed, onParent ? alt!.altitudeKm : null, flight.grounded, this.vertical);
      p.vsiKmS = this.vertical.vsiKmS;
      p.ttiS = this.vertical.ttiS;
    } else {
      // In the star's frame "vertical" is radial from the star: a true number
      // that answers no question a pilot is asking.
      p.vsiKmS = null;
      p.ttiS = null;
    }

    p.location = locationLabel(u.system.name, parentName);
    this.hud.setInstruments(p);
    const f = this.universe.flight;
    this.hud.setAssist(assistReadout(f.assistState, f.assistTargetKmS));
    // The virtual stick's dot (track A's deflection → track B's HUD mark).
    // Hidden while the pointer is free: the stick only exists under lock.
    const d = ctx.input.stickDeflection;
    this.hud.setStickDeflection(document.pointerLockElement ? d.x : null, d.y);
  }
}
