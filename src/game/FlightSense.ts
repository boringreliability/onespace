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
import type { Belt } from '@/game/Belt';
import type { Cruise } from '@/game/Cruise';
import type { Targeting } from '@/game/Targeting';
import type { Traffic } from '@/game/Traffic';
import type { Universe } from '@/game/Universe';
import type { Sky } from '@/render/Sky';
import { driveAberrationBeta, driveFieldAmount, driveSheen } from '@/render/driveField';
import { FORMATION_KEY, mayHoldFormation } from '@/ship/formation';
import { fieldFrameHeld } from '@/game/fieldFrame';

const ACTIVE: readonly Mode[] = ['flight', 'map'];

export interface FlightSenseOptions {
  readonly universe: Universe;
  readonly cruise: Cruise;
  readonly traffic: Traffic;
  readonly targeting: Targeting;
  readonly audio: Audio;
  readonly sky: Sky;
  /**
   * [v4-mining] Asteroid targets hold formation through it, and the field
   * frame (game/fieldFrame.ts) reads the nearest field. Absent: v3.
   */
  readonly belt?:
    | (Pick<Belt, 'asteroidWorld' | 'asteroidVelocity' | 'nearestField' | 'fieldWorld' | 'fieldVelocity'> &
        Partial<Pick<Belt, 'asteroidSpec'>>)
    | null;
}

export class FlightSense implements GameModule {
  readonly name = 'flight-sense';
  readonly activeIn = ACTIVE;

  private readonly o: FlightSenseOptions;
  private formationId: string | null = null;
  /** [v4-mining] The field whose frame FA and the glass are referenced to, or null. */
  private frameId: string | null = null;
  private readonly fieldRef = new Vector3();
  private readonly fieldCentre = new Vector3();
  private wantToggle = false;
  private readonly refVel = new Vector3();
  private readonly tgtWorld = new Vector3();
  private readonly apex = new Vector3();
  private readonly offs: Array<() => void> = [];

  constructor(opts: FlightSenseOptions) {
    this.o = opts;
  }

  /**
   * [v4-mining] The belt field the ship is flying in (its id), or null. While
   * set, FA's reference is the field's velocity (unless formation holds) and
   * VEL and the velocity markers are relative to the field (Instruments).
   */
  get fieldFrame(): string | null {
    return this.frameId;
  }

  /**
   * [v4-mining] The field frame's velocity, parent-relative (the flight
   * model's frame), into `out`. False outside the frame.
   */
  fieldFrameVelocity(out: Vector3): boolean {
    if (this.frameId === null) return false;
    out.copy(this.fieldRef);
    return true;
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
    // review-v3b: the window listener hears K in every mode; a press latched
    // while the Yard or the title was up must not fire on the next flight frame.
    this.wantToggle = false;
    if (ACTIVE.includes(to)) return;
    // Leaving flight (the Yard, the title): nothing of this may linger.
    this.release(null);
    this.clearReference();
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

    // --- [v4-mining] the field frame -----------------------------------------
    this.updateFieldFrame();

    // --- G: formation -------------------------------------------------------
    const id = targeting.targetId;
    const haveVel = id !== null && traffic.vesselVelocity(id, this.refVel);
    let distanceKm = Number.NaN;
    if (haveVel && traffic.vesselWorld(id!, this.tgtWorld)) distanceKm = this.tgtWorld.distanceTo(flight.worldPosition);
    // [v4-mining] An asteroid: its world velocity, made parent-relative (the
    // flight model's frame) by taking off the parent body's world velocity.
    let haveRock = false;
    const belt = this.o.belt;
    if (!haveVel && id !== null && belt && id.startsWith('ast:')) {
      haveRock = belt.asteroidVelocity(id, this.refVel) && belt.asteroidWorld(id, this.tgtWorld);
      if (haveRock) {
        const parent = universe.shipParent;
        if (parent) this.refVel.sub(parent.worldVelocity);
        // Measured to the rock's surface (owner decision 2).
        const spec = belt.asteroidSpec ? belt.asteroidSpec(id) : null;
        distanceKm = this.tgtWorld.distanceTo(flight.worldPosition) - (spec ? spec.radiusKm : 0);
      }
    }
    const allowed = mayHoldFormation({
      fa: flight.flightAssist,
      targetIsVessel: haveVel,
      targetIsAsteroid: haveRock,
      distanceKm,
      cruise: flight.cruising,
      inFieldFrame: this.frameId !== null,
    });

    if (this.wantToggle) {
      this.wantToggle = false;
      if (this.formationId) this.release('FORMATION RELEASED');
      else if (allowed) {
        this.formationId = id;
        bus.emit('log', { text: 'FORMATION — HOLDING ON TARGET', tone: 'good' });
      } else {
        bus.emit('log', {
          text: !flight.flightAssist ? 'FORMATION NEEDS FA' : 'FORMATION — TARGET A VESSEL OR ASTEROID WITHIN 50 KM',
          tone: 'warn',
        });
      }
    }

    if (this.formationId && (!allowed || id !== this.formationId)) this.release('FORMATION RELEASED');

    // --- the FA reference: this module is its ONE owner --------------------
    // Formation overrides the field frame; outside both, v3 (none). Cruise
    // carries its own frame (FlightModel.setCruiseFrame) and the autopilot
    // flies FA-off, so neither needs this.
    this.writeReference(this.formationId ? this.refVel : this.frameId !== null ? this.fieldRef : null);
  }

  /** [v4-mining] Enter / keep / leave the nearest field's frame (300 / 330 km). */
  private updateFieldFrame(): void {
    const belt = this.o.belt;
    const field = belt ? belt.nearestField() : null;
    if (!belt || !field || !belt.fieldWorld(field.id, this.fieldCentre)) {
      this.frameId = null;
      return;
    }
    const d = this.fieldCentre.distanceTo(this.o.universe.flight.worldPosition);
    if (!fieldFrameHeld(this.frameId === field.id, d) || !belt.fieldVelocity(field.id, this.fieldRef)) {
      this.frameId = null;
      return;
    }
    this.frameId = field.id;
    const parent = this.o.universe.shipParent;
    if (parent) this.fieldRef.sub(parent.worldVelocity);
  }

  private writeReference(v: Vector3 | null): void {
    this.o.universe.flight.assistReferenceVelocity = v;
  }

  private clearReference(): void {
    this.frameId = null;
    this.writeReference(null);
  }

  private release(say: string | null): void {
    if (this.formationId === null) return;
    this.formationId = null;
    if (say) bus.emit('log', { text: say, tone: 'normal' });
  }

  dispose(): void {
    this.release(null);
    this.clearReference();
    for (const off of this.offs) off();
    this.offs.length = 0;
  }
}
