/**
 * FlightSense — v3 T4's glue (PLAN E2, E5, G).
 *
 * Reads what the flight already knows and hands it to the senses: the cruise
 * drive field to the sky, the silent events to the audio, and the formation
 * assist's reference velocity to the flight model. Owns no state of its own
 * beyond the formation toggle; every mapping is a pure function tested
 * elsewhere (driveField, audioCues, formation).
 *
 * Formation: K while a co-orbital vessel is targeted. The FA hold is then
 * referenced to that vessel's velocity, so the throttle detent means "sit
 * beside it" and the lever is a closing speed relative to it. It releases
 * itself the moment it stops making sense (FA off, cruise, target changed or
 * out of range) and says so in the log.
 */

import { Vector3 } from 'three';

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import type { Mode } from '@/core/Modes';
import type { Audio } from '@/audio/Audio';
import type { Cruise } from '@/game/Cruise';
import type { Targeting } from '@/game/Targeting';
import type { Traffic } from '@/game/Traffic';
import type { Universe } from '@/game/Universe';
import type { Sky } from '@/render/Sky';
import { driveAberrationBeta, driveFieldAmount, driveSheen } from '@/render/driveField';
import { FORMATION_KEY, mayHoldFormation } from '@/ship/formation';

const ACTIVE: readonly Mode[] = ['flight', 'map'];

export interface FlightSenseOptions {
  readonly universe: Universe;
  readonly cruise: Cruise;
  readonly traffic: Traffic;
  readonly targeting: Targeting;
  readonly audio: Audio;
  readonly sky: Sky;
}

export class FlightSense implements GameModule {
  readonly name = 'flight-sense';
  readonly activeIn = ACTIVE;

  private readonly o: FlightSenseOptions;
  private formationId: string | null = null;
  private wantToggle = false;
  private readonly refVel = new Vector3();
  private readonly tgtWorld = new Vector3();
  private readonly apex = new Vector3();
  private readonly offs: Array<() => void> = [];

  constructor(opts: FlightSenseOptions) {
    this.o = opts;
  }

  /** The vessel the formation assist is holding on, or null (for HUD / harness). */
  get formation(): string | null {
    return this.formationId;
  }

  init(): void {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== FORMATION_KEY || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      this.wantToggle = true;
    };
    window.addEventListener('keydown', onKey);
    this.offs.push(() => window.removeEventListener('keydown', onKey));
    this.offs.push(bus.on('system:entered', () => this.release(null)));
  }

  onModeChange(_from: Mode, to: Mode): void {
    if (ACTIVE.includes(to)) return;
    // Leaving flight (the Yard, the title): nothing of this may linger.
    this.release(null);
    this.o.sky.setDriveField(0, 0, this.apex);
    this.o.audio.setCruise('idle', 0);
    this.o.audio.setRcs(0, 0, 0);
    this.o.audio.setVesselProximity(Infinity, 0);
    this.o.audio.setHullStress(0);
  }

  update(_dt: number, _ctx: EngineContext): void {
    const { universe, cruise, traffic, targeting, audio, sky } = this.o;
    const flight = universe.flight;

    // --- E2: the cruise drive field ----------------------------------------
    const amount = driveFieldAmount(flight.cruising ? cruise.drive.capKmS : null);
    if (flight.velocity.lengthSq() > 1e-12) this.apex.copy(flight.velocity);
    else this.apex.copy(flight.forward);
    sky.setDriveField(driveAberrationBeta(amount), driveSheen(amount), this.apex);

    // --- E5: the silent events ---------------------------------------------
    audio.setCruise(cruise.drive.phase, amount);
    const c = flight.command;
    audio.setRcs(c.strafeX, c.strafeY, c.strafeZ);
    const loud = traffic.loudest();
    if (loud) audio.setVesselProximity(loud.distanceKm, loud.radiusKm);
    else audio.setVesselProximity(Infinity, 0);
    audio.setHullStress(flight.gForce);

    // --- G: formation -------------------------------------------------------
    const id = targeting.targetId;
    const haveVel = id !== null && traffic.vesselVelocity(id, this.refVel);
    let distanceKm = Number.NaN;
    if (haveVel && traffic.vesselWorld(id!, this.tgtWorld)) distanceKm = this.tgtWorld.distanceTo(flight.worldPosition);
    const allowed = mayHoldFormation({
      fa: flight.flightAssist,
      targetIsVessel: haveVel,
      distanceKm,
      cruise: flight.cruising,
    });

    if (this.wantToggle) {
      this.wantToggle = false;
      if (this.formationId) this.release('FORMATION RELEASED');
      else if (allowed) {
        this.formationId = id;
        bus.emit('log', { text: 'FORMATION — HOLDING ON TARGET', tone: 'good' });
      } else {
        bus.emit('log', {
          text: !flight.flightAssist ? 'FORMATION NEEDS FA' : 'FORMATION — TARGET A VESSEL WITHIN 50 KM',
          tone: 'warn',
        });
      }
    }

    if (this.formationId) {
      if (!allowed || id !== this.formationId) this.release('FORMATION RELEASED');
      else flight.assistReferenceVelocity = this.refVel;
    }
  }

  private release(say: string | null): void {
    if (this.formationId === null) return;
    this.formationId = null;
    this.o.universe.flight.assistReferenceVelocity = null;
    if (say) bus.emit('log', { text: say, tone: 'normal' });
  }

  dispose(): void {
    this.release(null);
    for (const off of this.offs) off();
    this.offs.length = 0;
  }
}
