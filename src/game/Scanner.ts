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

import { Vector3 } from 'three';

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { asteroidScan, planetScan } from '@/gen/scan';
import type { ScanResult } from '@/gen/types';
import type { Traffic } from '@/game/Traffic';
import type { Universe, UniverseBody } from '@/game/Universe';
import { beltTargetName, type Belt } from '@/game/Belt';
import { ASTEROID_SCAN_RANGE_KM, asteroidInScanRange, chooseScanTarget, type ScanBody } from '@/game/scanChoice';
import { FIELD_RADIUS_KM, type Resource } from '@/gen/belt';
import { bodyTargetId } from '@/game/targets';

/** Seconds the array takes to resolve a target. Long enough to feel worked for. */
const SWEEP_TIME = 1.4;

/** Beyond this the array cannot hold a world at all; multiples of its radius. */
const WORLD_RANGE_RADII = 60;

export interface ScannerOptions {
  readonly universe: Universe;
  readonly traffic?: Traffic | null;
  /** The nav target, if targeting is wired. Read only. */
  readonly targeting?: { readonly targetId: string | null } | null;
  /** [v4-mining] Asteroid targets are assayed through it. Absent: v3 behaviour. */
  readonly belt?: Pick<Belt, 'asteroidSpec' | 'asteroidWorld' | 'remainingKg' | 'fieldWorld'> | null;
}

export class Scanner implements GameModule {
  readonly name = 'scanner';

  private readonly universe: Universe;
  private readonly traffic: Traffic | null;
  private readonly targeting: { readonly targetId: string | null } | null;
  private readonly belt: NonNullable<ScannerOptions['belt']> | null;

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
    this.targeting = opts.targeting ?? null;
    this.belt = opts.belt ?? null;
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

    this.outOfRangeReported = false;
    const target = this.pick();
    if (!target) {
      if (!this.outOfRangeReported) bus.emit('log', { text: 'ARRAY FINDS NOTHING IN RANGE', tone: 'warn' });
      return;
    }
    this.pending = target;
    this.sweep = SWEEP_TIME;
    bus.emit('scan:started', { targetId: target.targetId });
    bus.emit('log', { text: `SWEEPING — ${target.name.toUpperCase()}`, tone: 'normal' });
  }

  /**
   * Choose what the array locks onto: the nav target if there is one, else
   * the world under the reticle, else the world being orbited. A hull is only
   * scanned as a target. The old rule let any hull within 400 km outrank the
   * planet, so with a co-orbiting freighter at spawn the spawn world could
   * never be scanned (GAMEPLAY F3). Runs once per key press, so it may
   * allocate.
   */
  private pick(): ScanResult | null {
    const flight = this.universe.flight;
    const ship = flight.worldPosition;
    const nose = flight.forward;
    const byId = new Map<string, UniverseBody>();
    const bodies: ScanBody[] = [];
    const rel = new Vector3();
    for (const b of this.universe.allBodies()) {
      const id = bodyTargetId(b.spec.name);
      byId.set(id, b);
      rel.subVectors(b.world, ship);
      const d = rel.length();
      const angle = d > 1e-9 ? Math.acos(Math.min(1, Math.max(-1, rel.dot(nose) / d))) : 0;
      bodies.push({
        id,
        angleRad: angle,
        angularRadiusRad: d > b.spec.radius ? Math.asin(b.spec.radius / d) : Math.PI,
        distanceKm: d,
        inRange: d - b.spec.radius < b.spec.radius * WORLD_RANGE_RADII,
      });
    }

    const targetId = this.targeting?.targetId ?? null;
    // [v4-mining] A belt field is not scanned as a whole (R23): beyond the
    // array's reach it is named; within it, the pilot is pointed at a rock.
    if (targetId !== null && this.belt && targetId.startsWith('field:')) {
      const at = new Vector3();
      if (this.belt.fieldWorld(targetId, at)) {
        const edgeKm = at.distanceTo(ship) - FIELD_RADIUS_KM;
        const name = beltTargetName(targetId, this.universe.system?.name) ?? targetId;
        bus.emit('log', {
          text: edgeKm > ASTEROID_SCAN_RANGE_KM ? `${name.toUpperCase()} BEYOND ARRAY RANGE` : 'TAB TO TARGET A ROCK',
          tone: 'warn',
        });
        this.outOfRangeReported = true;
        return null;
      }
    }
    let target: { id: string; inRange: boolean } | null = null;
    let asteroid = false;
    if (targetId !== null) {
      const tb = byId.get(targetId);
      const astWorld = new Vector3();
      if (!tb && this.belt && targetId.startsWith('ast:') && this.belt.asteroidWorld(targetId, astWorld)) {
        // [v4-mining] An asteroid answers only to the array's short reach.
        asteroid = true;
        target = { id: targetId, inRange: asteroidInScanRange(astWorld.distanceTo(ship)) };
      } else if (tb) {
        target = { id: targetId, inRange: bodies.find((x) => x.id === targetId)!.inRange };
      } else if (this.traffic) {
        // A targeted hull answers its transponder at any range.
        target = { id: targetId, inRange: true };
      }
    }

    const parent = this.universe.shipParent;
    const choice = chooseScanTarget({
      target,
      bodies,
      parentId: parent ? bodyTargetId(parent.spec.name) : null,
    });

    if (choice.kind === 'none') return null;
    if (choice.kind === 'out-of-range') {
      const b = byId.get(choice.id);
      bus.emit('log', {
        text: `${(b?.spec.name ?? beltTargetName(choice.id, this.universe.system?.name) ?? choice.id).toUpperCase()} BEYOND ARRAY RANGE`,
        tone: 'warn',
      });
      this.outOfRangeReported = true;
      return null;
    }
    if (asteroid && choice.id === targetId) return this.assay(choice.id);
    const b = byId.get(choice.id);
    if (b) return this.cached(b.spec.id, () => planetScan(b.spec));
    return this.cached(choice.id, () => this.traffic?.scan(choice.id) ?? null);
  }

  /**
   * [v4-mining] An asteroid's assay. Never cached: what is left changes as it
   * is mined, and a stale "remaining" would be a lie the pilot acts on.
   */
  private assay(id: string): ScanResult | null {
    const a = this.belt?.asteroidSpec(id);
    if (!a || !this.belt) return null;
    const left = { ice: 0, metal: 0, silicate: 0, rare: 0 } as Record<Resource, number>;
    for (const r of ['ice', 'metal', 'silicate', 'rare'] as const) left[r] = this.belt.remainingKg(id, r);
    return asteroidScan(id, beltTargetName(id) ?? id, a, left);
  }

  /** Set when `pick()` already explained itself, so update() stays quiet. */
  private outOfRangeReported = false;

  private cached(id: string, build: () => ScanResult | null): ScanResult | null {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const made = build();
    if (made) this.cache.set(id, made);
    return made;
  }
}
