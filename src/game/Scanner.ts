/**
 * The scanner — the action behind the T key.
 *
 * `KeyT` has been bound to `'scan'` in the input map since the first week, the
 * HUD has rendered scan results with a typewriter reveal for just as long, and
 * `scan:complete` was declared on the bus. Nothing read the key. The only two
 * emitters of `scan:complete` in the whole codebase were showroom fixtures, so
 * the readout was a thing you could photograph but not use.
 *
 * This module is deliberately its own thing rather than more code inside Pilot.
 * It needs both the universe (for worlds) and the traffic fleet (for hulls),
 * and Pilot has no business knowing about the fleet. Registry builds Traffic
 * after Pilot, so a scanner living inside Pilot could not have reached it
 * anyway without a setter — and a setter that must be called from exactly one
 * place, or the feature silently does nothing, is the shape of defect this
 * project keeps paying for.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { planetScan } from '@/gen/scan';
import type { ScanResult } from '@/gen/types';
import type { Traffic } from '@/game/Traffic';
import type { Universe } from '@/game/Universe';

/** Seconds the array takes to resolve a target. Long enough to feel worked for. */
const SWEEP_TIME = 1.4;

/** A hull closer than this outranks the world below; km. */
const VESSEL_PRIORITY_KM = 400;

/** Beyond this the array cannot hold a world at all; multiples of its radius. */
const WORLD_RANGE_RADII = 60;

export interface ScannerOptions {
  readonly universe: Universe;
  readonly traffic?: Traffic | null;
}

export class Scanner implements GameModule {
  readonly name = 'scanner';

  private readonly universe: Universe;
  private readonly traffic: Traffic | null;

  /** Non-null while a sweep is running. */
  private pending: ScanResult | null = null;
  private sweep = 0;
  /**
   * Results are cached by target: the lines are a pure function of the spec,
   * and re-deriving them on every keypress would walk the whole mass model of
   * a ship for no reason.
   */
  private readonly cache = new Map<string, ScanResult>();

  constructor(opts: ScannerOptions) {
    this.universe = opts.universe;
    this.traffic = opts.traffic ?? null;
  }

  update(dt: number, ctx: EngineContext): void {
    if (this.pending) {
      this.sweep -= dt;
      if (this.sweep <= 0) {
        const result = this.pending;
        this.pending = null;
        bus.emit('scan:complete', result);
      }
      return;
    }
    if (!ctx.input.pressed('scan')) return;

    const target = this.pick();
    if (!target) {
      bus.emit('log', { text: 'ARRAY FINDS NOTHING IN RANGE', tone: 'warn' });
      return;
    }
    this.pending = target;
    this.sweep = SWEEP_TIME;
    bus.emit('scan:started', { targetId: target.targetId });
    bus.emit('log', { text: `SWEEPING — ${target.name.toUpperCase()}`, tone: 'normal' });
  }

  /**
   * Choose what the array locks onto.
   *
   * A hull within a few hundred kilometres wins over the planet underneath it:
   * if you have flown up alongside somebody, that is what you meant to scan.
   */
  private pick(): ScanResult | null {
    const contact = this.traffic?.nearest() ?? null;
    if (contact && contact.distanceKm < VESSEL_PRIORITY_KM) {
      const hit = this.cached(contact.id, () => this.traffic?.scan(contact.id) ?? null);
      if (hit) return hit;
    }

    const body = this.universe.nearest;
    if (body) {
      const gap = this.universe.nearestAltitudeKm;
      if (gap === null || gap < body.spec.radius * WORLD_RANGE_RADII) {
        const hit = this.cached(body.spec.id, () => planetScan(body.spec));
        if (hit) return hit;
      }
    }

    // Nothing below, but somebody out there: take the distant hull rather than
    // report an empty sky.
    if (contact) return this.cached(contact.id, () => this.traffic?.scan(contact.id) ?? null);
    return null;
  }

  private cached(id: string, build: () => ScanResult | null): ScanResult | null {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const made = build();
    if (made) this.cache.set(id, made);
    return made;
  }
}
