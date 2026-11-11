/**
 * v4 sub-plan 2, Task 5 — mine (B), refine (U), repair (N), wired.
 *
 * - B on a targeted asteroid within MINE_RANGE_KM of its SURFACE, matched to
 *   within MINE_MAX_REL_KMS, starts a MINE_ACTION_S mine.
 * - U refines all the ice the tank can take; N repairs the tank. Neither needs
 *   a target.
 *
 * Every action counts SIM time (`universe.simulatedSeconds`, so 10× finishes
 * ten times sooner in wall time) and completes through `applyCargoAction`; a
 * completed mine is recorded in WorldState exactly once. The press frame only
 * starts the clock.
 *
 * R16: one gate. A mine asks `mayMine` on the press, every frame and on the
 * completion frame; refine and repair ask `mayAct` (no target, range or speed).
 * Any failure — drift, pause, freeze, cruise, a warp, or the beacon
 * (`ship:recovered`) — aborts the action with nothing applied and logs
 * MINING / REFINING / REPAIR ABORTED. An aborted action never resumes.
 *
 * Paused or frozen, the keys are silent. A hull without a tank or a hold is
 * inert. Nothing in update() allocates.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import type { Mode } from '@/core/Modes';
import { bus } from '@/core/EventBus';
import type { Resource } from '@/gen/belt';
import type { Belt } from '@/game/Belt';
import type { WorldState } from '@/game/worldState';
import { applyCargoAction, refineRefusal, repairRefusal, type Cargo } from '@/ship/cargo';
import type { Propellant } from '@/ship/propellant';
import {
  MINE_ACTION_S,
  MINE_MIN_KG,
  MINE_RANGE_KM,
  MINE_YIELD_KG,
  MINING_ABORTED_TEXT,
  REFINE_ACTION_S,
  REFINING_ABORTED_TEXT,
  REFUSAL_LOG,
  REPAIR_ABORTED_TEXT,
  REPAIR_ACTION_S,
  chooseResource,
  mayAct,
  mayMine,
  minedLog,
  refinedLog,
  repairedLog,
  type MiningRefusal,
} from './miningRules';

interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** What Mining reads of the universe. `Universe` satisfies it. */
export interface MiningWorld {
  readonly paused: boolean;
  readonly frozen: boolean;
  /** Simulated seconds the last update advanced (0 while paused or frozen). */
  readonly simulatedSeconds: number;
  readonly cargo: Cargo | null;
  readonly flight: {
    readonly propellant: Propellant | null;
    readonly worldPosition: Vec3;
    /** Relative to `shipParent` (the star when null). */
    readonly velocity: Vec3;
  };
  readonly shipParent: { readonly worldVelocity: Vec3 } | null;
}

export interface MiningOptions {
  readonly universe: MiningWorld;
  readonly belt: Pick<Belt, 'asteroidWorld' | 'asteroidVelocity' | 'asteroidSpec' | 'remainingKg'>;
  readonly worldState: Pick<WorldState, 'recordMined'>;
  readonly targeting: { readonly targetId: string | null };
  readonly cruise: { readonly busy: boolean };
  readonly warp: { readonly phase: string };
}

export type MiningKind = 'mine' | 'refine' | 'repair';

/** Below this many seconds left an action is done (240 × 1/60 sums to 3.99999999999999). */
const DONE_EPS_S = 1e-6;

const RESOURCES: readonly Resource[] = ['ice', 'metal', 'silicate', 'rare'];

const ABORT_TEXT: Readonly<Record<MiningKind, string>> = {
  mine: MINING_ABORTED_TEXT,
  refine: REFINING_ABORTED_TEXT,
  repair: REPAIR_ABORTED_TEXT,
};

export class Mining implements GameModule {
  readonly name = 'mining';

  private readonly opts: MiningOptions;
  /** The action underway; mutated in place, never reallocated per frame. */
  private readonly job = { kind: 'mine' as MiningKind, leftS: 0 };
  private active = false;
  /** The asteroid the mine underway was started on. */
  private jobAsteroid = '';
  private recovered = false;
  private offs: Array<() => void> = [];

  // Measured each frame (scratch).
  private readonly astPos = { x: 0, y: 0, z: 0 };
  private readonly astVel = { x: 0, y: 0, z: 0 };
  private readonly remaining: Record<Resource, number> = { ice: 0, metal: 0, silicate: 0, rare: 0 };
  private readonly gate = {
    paused: false,
    frozen: false,
    cruise: false,
    warpPhase: 'idle',
    targetIsAsteroid: false,
    surfaceRangeKm: Number.POSITIVE_INFINITY,
    relSpeedKmS: Number.POSITIVE_INFINITY,
    holdFreeKg: 0,
    remainingKg: 0,
  };
  private targetAsteroid: string | null = null;
  private inRange = false;

  constructor(opts: MiningOptions) {
    this.opts = opts;
  }

  /** The action underway and the sim seconds it has left, or null. */
  get busy(): null | { readonly kind: MiningKind; readonly leftS: number } {
    return this.active ? this.job : null;
  }

  /** An asteroid is targeted within MINE_RANGE_KM of its surface (the 'mine' hint). */
  get asteroidInRange(): boolean {
    return this.inRange;
  }

  init(_ctx?: EngineContext): void {
    this.active = false;
    this.recovered = false;
    this.offs.push(
      bus.on('ship:recovered', () => {
        this.recovered = true;
      }),
    );
  }

  /**
   * Gated to flight (game/gating.ts). A module that sleeps does not update,
   * so an action underway would stall behind a chart; it is aborted instead.
   */
  onModeChange(_from: Mode, to: Mode): void {
    if (to !== 'flight' && this.active) this.abort();
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.active = false;
  }

  update(_dt: number, ctx: EngineContext): void {
    const u = this.opts.universe;
    const cargo = u.cargo;
    const tank = u.flight.propellant;
    const recovered = this.recovered;
    this.recovered = false;
    if (!cargo || !tank) {
      // Inert: no tank or no hold (Yard, showroom).
      this.active = false;
      this.inRange = false;
      return;
    }
    this.measure(cargo);

    if (this.active) {
      if (recovered || !this.jobGate()) {
        this.abort();
      } else {
        this.job.leftS -= Math.max(0, u.simulatedSeconds);
        if (this.job.leftS <= DONE_EPS_S) this.complete(cargo, tank);
      }
    }

    // Paused or frozen: the keys say nothing at all.
    if (u.paused || u.frozen) return;
    const input = ctx.input;
    if (input.pressed('mine')) this.press('mine', cargo, tank);
    if (input.pressed('refine')) this.press('refine', cargo, tank);
    if (input.pressed('repair')) this.press('repair', cargo, tank);
  }

  // -------------------------------------------------------------------------

  /** Fill the gate from this frame's state. */
  private measure(cargo: Cargo): void {
    const { universe: u, belt, targeting, cruise, warp } = this.opts;
    const g = this.gate;
    g.paused = u.paused;
    g.frozen = u.frozen;
    g.cruise = cruise.busy;
    g.warpPhase = warp.phase;
    g.holdFreeKg = cargo.freeKg;

    const id = targeting.targetId;
    const spec = id !== null && id.startsWith('ast:') ? belt.asteroidSpec(id) : null;
    if (
      id === null ||
      spec === null ||
      !belt.asteroidWorld(id, this.astPos) ||
      !belt.asteroidVelocity(id, this.astVel)
    ) {
      this.targetAsteroid = null;
      g.targetIsAsteroid = false;
      g.surfaceRangeKm = Number.POSITIVE_INFINITY;
      g.relSpeedKmS = Number.POSITIVE_INFINITY;
      g.remainingKg = 0;
      this.inRange = false;
      return;
    }
    this.targetAsteroid = id;
    g.targetIsAsteroid = true;
    const p = u.flight.worldPosition;
    const a = this.astPos;
    g.surfaceRangeKm = Math.hypot(a.x - p.x, a.y - p.y, a.z - p.z) - spec.radiusKm;
    // The ship's world velocity: parent-relative plus the parent's own.
    const v = u.flight.velocity;
    const pv = u.shipParent?.worldVelocity;
    const vx = v.x + (pv ? pv.x : 0);
    const vy = v.y + (pv ? pv.y : 0);
    const vz = v.z + (pv ? pv.z : 0);
    const av = this.astVel;
    g.relSpeedKmS = Math.hypot(av.x - vx, av.y - vy, av.z - vz);
    let total = 0;
    for (let i = 0; i < RESOURCES.length; i++) {
      const r = RESOURCES[i]!;
      const kg = belt.remainingKg(id, r);
      this.remaining[r] = kg;
      // R18: dust is not minable; the gate sees only what a mine could take.
      if (kg >= MINE_MIN_KG) total += kg;
    }
    g.remainingKg = total;
    this.inRange = g.surfaceRangeKm <= MINE_RANGE_KM;
  }

  /** R16: the action underway may go on (asked every frame, the completion frame included). */
  private jobGate(): boolean {
    if (this.job.kind !== 'mine') return mayAct(this.gate);
    // The rock it started on, still targeted, still in reach.
    if (this.targetAsteroid !== this.jobAsteroid) return false;
    return mayMine(this.gate).ok;
  }

  private press(kind: MiningKind, cargo: Cargo, tank: Propellant): void {
    if (this.active) {
      this.log(REFUSAL_LOG.busy, 'warn');
      return;
    }
    let refusal: MiningRefusal | null;
    if (kind === 'mine') {
      const g = mayMine(this.gate);
      refusal = g.ok ? null : g.reason!;
    } else if (!mayAct(this.gate)) {
      refusal = 'busy';
    } else {
      refusal = kind === 'refine' ? refineRefusal(cargo, tank) : repairRefusal(cargo, tank);
    }
    if (refusal !== null) {
      this.log(REFUSAL_LOG[refusal], 'warn');
      return;
    }
    this.active = true;
    this.job.kind = kind;
    this.job.leftS = kind === 'mine' ? MINE_ACTION_S : kind === 'refine' ? REFINE_ACTION_S : REPAIR_ACTION_S;
    if (kind === 'mine') this.jobAsteroid = this.targetAsteroid!;
  }

  private abort(): void {
    this.active = false;
    this.log(ABORT_TEXT[this.job.kind], 'warn');
  }

  private complete(cargo: Cargo, tank: Propellant): void {
    this.active = false;
    const kind = this.job.kind;
    if (kind === 'mine') {
      const id = this.jobAsteroid;
      const r = chooseResource(this.remaining);
      if (r === null) {
        this.log(REFUSAL_LOG.depleted, 'warn');
        return;
      }
      const kg = Math.min(MINE_YIELD_KG, this.remaining[r]);
      const res = applyCargoAction(cargo, tank, { kind: 'mine', asteroidId: id, resource: r, kg });
      if (!res.ok) {
        this.log(REFUSAL_LOG[res.reason ?? 'invalid'], 'warn');
        return;
      }
      // Once per completed mine, with what the hold actually took.
      this.opts.worldState.recordMined(id, r, res.kgIn, 'local');
      this.log(minedLog(res.kgIn, r), 'good');
      // The gate's own line (mayMine): less room than MINE_MIN_KG is full.
      if (cargo.freeKg < MINE_MIN_KG) this.log(REFUSAL_LOG['hold-full'], 'warn');
      return;
    }
    const res = applyCargoAction(cargo, tank, { kind });
    if (!res.ok) {
      this.log(REFUSAL_LOG[res.reason ?? 'invalid'], 'warn');
      return;
    }
    this.log(kind === 'refine' ? refinedLog(res.fuelKg) : repairedLog(res.restoredFrac), 'good');
  }

  private log(text: string, tone: 'normal' | 'warn' | 'good'): void {
    bus.emit('log', { text, tone });
  }
}
