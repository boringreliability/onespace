/**
 * v4 sub-plan 2, Task 5 — mine (B), refine (U), repair (N), wired.
 * v4 sub-plan 5, Task 3 — mining is a continuous EXTRACTION.
 *
 * - B on a targeted asteroid within MINE_RANGE_KM of its SURFACE, matched to
 *   within MINE_MAX_REL_KMS, with room in the hold, starts an extraction of ONE
 *   resource (chooseResource). From the next frame on it accrues sim time into
 *   bites (extraction.ts); each bite goes through `applyCargoAction` and
 *   `worldState.recordMined` like any mine, and is announced as `mining:bite`.
 * - It ends — keeping every finished bite — on B again, a full hold, the
 *   resource or the rock running out, or a broken requirement; one log line
 *   (`extractionLog`) and one `mining:ended`. The last bite of a rock also
 *   announces `asteroid:destroyed`, in that same frame.
 * - U refines all the ice the tank can take; N repairs the tank. Neither needs
 *   a target. Timed actions, as in sub-plan 2.
 *
 * R16: one gate. An extraction asks `mayMine` on the press and once every
 * frame BEFORE that frame's bites; refine and repair ask `mayAct` (no target,
 * range or speed) every frame and on the completion frame. A broken
 * requirement ends an extraction with its reason; it aborts a refine or repair
 * with nothing applied (REFINING / REPAIR ABORTED). Nothing ever resumes.
 *
 * Task 7: a refine or repair is announced — `action:started` in the frame of
 * the accepted press, and exactly one `action:ended` (ok: true on completion,
 * false on every abort, a lost tank or hold, or a refused completion). A
 * refusal at the press announces nothing; dispose() announces nothing (F5).
 *
 * Paused or frozen, the keys are silent. A hull without a tank or a hold is
 * inert. update() allocates nothing on a frame without a bite (a bite's
 * cargo action and bus payloads are new objects: the journal keeps them).
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
  accrue,
  commitBite,
  extractionLog,
  nextBiteKg,
  shownKg,
  startExtraction,
  type Extraction,
  type ExtractionEnd,
} from './extraction';
import {
  MINE_MAX_REL_KMS,
  MINE_MIN_KG,
  MINE_RANGE_KM,
  REFINE_ACTION_S,
  REFINING_ABORTED_TEXT,
  REFUSAL_LOG,
  REPAIR_ABORTED_TEXT,
  REPAIR_ACTION_S,
  chooseResource,
  mayAct,
  mayMine,
  refinedLog,
  repairedLog,
  type MiningRefusal,
} from './miningRules';

interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface MutVec3 {
  x: number;
  y: number;
  z: number;
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
    /**
     * [v4-mining] The ship at the ORBIT clock's time (state + velocity ×
     * substep carry) — what a rock's position is compared with. Absent: the
     * state's worldPosition.
     */
    readonly renderWorldPosition?: Vec3;
    /** Relative to `shipParent` (the star when null). */
    readonly velocity: Vec3;
    /** [v4-mining] Plan 5: the nose's direction (unit). Absent: the source is the ship's centre. */
    readonly forward?: Vec3;
  };
  readonly shipParent: { readonly worldVelocity: Vec3 } | null;
}

export interface MiningOptions {
  readonly universe: MiningWorld;
  readonly belt: Pick<Belt, 'asteroidWorld' | 'asteroidVelocity' | 'asteroidSpec' | 'remainingKg' | 'isDestroyed'>;
  readonly worldState: Pick<WorldState, 'recordMined'>;
  readonly targeting: { readonly targetId: string | null };
  readonly cruise: { readonly busy: boolean };
  readonly warp: { readonly phase: string };
}

export type MiningKind = 'mine' | 'refine' | 'repair';

/** One extraction underway: what the beam and the wear are drawn from. */
export interface MiningOperation {
  readonly asteroidId: string;
  readonly resource: Resource;
  /** The ship's nose, world km. */
  readonly source: Readonly<Vec3>;
  /** The point on the rock's surface nearest the ship, world km. */
  readonly impact: Readonly<Vec3>;
}

/**
 * What the HUD reads for one action. Every state carries `progress`,
 * `shownKg`, `leftS` and `resource`; they mean something only while
 * `running` (0 / null otherwise, read through a shared prototype so a ready or
 * blocked state's own keys are only `kind` and `reason`).
 */
interface ActionNumbers {
  /** mine: the hold's fill 0..1, the begun part of the next bite included; refine/repair: elapsed share. */
  readonly progress: number;
  /** mine: kilograms this extraction has mined plus the begun part of the next bite; else 0. */
  readonly shownKg: number;
  /** refine/repair: sim seconds left; mine: 0. */
  readonly leftS: number;
  /** mine: the extraction's resource; else null. */
  readonly resource: Resource | null;
}
export type ActionState =
  | (ActionNumbers & { readonly kind: 'ready' })
  | (ActionNumbers & { readonly kind: 'blocked'; readonly reason: MiningRefusal | 'cruise' | 'jump' })
  | (ActionNumbers & { readonly kind: 'running' });

/** How far ahead of the ship's centre the nose is, km (the look is Task 6's). */
const NOSE_OFFSET_KM = 0.005;

/** Below this many seconds left an action is done (240 × 1/60 sums to 3.99999999999999). */
const DONE_EPS_S = 1e-6;

const RESOURCES: readonly Resource[] = ['ice', 'metal', 'silicate', 'rare'];

const ABORT_TEXT: Readonly<Record<'refine' | 'repair', string>> = {
  refine: REFINING_ABORTED_TEXT,
  repair: REPAIR_ABORTED_TEXT,
};

const ACTION_S: Readonly<Record<'refine' | 'repair', number>> = {
  refine: REFINE_ACTION_S,
  repair: REPAIR_ACTION_S,
};

/** The numbers of a state that is not running, shared through the prototype. */
const IDLE_NUMBERS: ActionNumbers = Object.freeze({ progress: 0, shownKg: 0, leftS: 0, resource: null });

const READY: ActionState = Object.freeze(Object.assign(Object.create(IDLE_NUMBERS) as ActionNumbers, { kind: 'ready' as const }));

type BlockedState = { kind: 'blocked'; reason: MiningRefusal | 'cruise' | 'jump' } & ActionNumbers;
type RunningState = { kind: 'running'; progress: number; shownKg: number; leftS: number; resource: Resource | null };

function blockedState(): BlockedState {
  return Object.assign(Object.create(IDLE_NUMBERS) as ActionNumbers, { kind: 'blocked' as const, reason: 'busy' as BlockedState['reason'] });
}

function runningState(): RunningState {
  return { kind: 'running', progress: 0, shownKg: 0, leftS: 0, resource: null };
}

const NO_OPERATIONS: readonly MiningOperation[] = Object.freeze([]);

export class Mining implements GameModule {
  readonly name = 'mining';

  private readonly opts: MiningOptions;
  /** The refine or repair underway; mutated in place, never reallocated per frame. */
  private readonly job = { kind: 'refine' as 'refine' | 'repair', leftS: 0 };
  private active = false;
  /** The extraction underway, or null. A new one always comes from startExtraction. */
  private ext: Extraction | null = null;
  private recovered = false;
  /** An extraction ended in this update (cleared at its start): a B press in the same frame is swallowed. */
  private endedThisFrame = false;
  /** The last update had a tank and a hold (the gate below is current). */
  private hull = false;
  private offs: Array<() => void> = [];

  // The one operation, reused across extractions and updated in place.
  private readonly opSource: MutVec3 = { x: 0, y: 0, z: 0 };
  private readonly opImpact: MutVec3 = { x: 0, y: 0, z: 0 };
  private readonly op: { asteroidId: string; resource: Resource; source: MutVec3; impact: MutVec3 } = {
    asteroidId: '',
    resource: 'ice',
    source: this.opSource,
    impact: this.opImpact,
  };
  private readonly oneOperation: readonly MiningOperation[] = [this.op];

  // What status() hands out: one object per kind and state, mutated in place.
  private readonly blocked: Readonly<Record<MiningKind, BlockedState>> = {
    mine: blockedState(),
    refine: blockedState(),
    repair: blockedState(),
  };
  private readonly running: Readonly<Record<MiningKind, RunningState>> = {
    mine: runningState(),
    refine: runningState(),
    repair: runningState(),
  };

  // Measured each frame (scratch).
  private readonly astPos = { x: 0, y: 0, z: 0 };
  private readonly astVel = { x: 0, y: 0, z: 0 };
  private astRadiusKm = 0;
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

  /** The refine or repair underway and the sim seconds it has left, or null. An extraction is in status('mine'). */
  get busy(): null | { readonly kind: MiningKind; readonly leftS: number } {
    return this.active ? this.job : null;
  }

  /** An asteroid is targeted within MINE_RANGE_KM of its surface (the 'mine' hint). */
  get asteroidInRange(): boolean {
    return this.inRange;
  }

  /** Speed relative to the targeted asteroid, km/s (∞ without one). */
  get relSpeedKmS(): number {
    return this.gate.relSpeedKmS;
  }

  /** The relative speed is within MINE_MAX_REL_KMS (meaningful with a rock targeted). */
  get speedOk(): boolean {
    return this.gate.relSpeedKmS <= MINE_MAX_REL_KMS;
  }

  /** The extraction underway as an operation (empty or one element). Read `mining.operations` every frame and do not keep the array: it is one of two arrays, and the single `MiningOperation` object is reused and updated in place while an extraction runs. */
  get operations(): readonly MiningOperation[] {
    return this.ext ? this.oneOperation : NO_OPERATIONS;
  }

  /**
   * What the HUD shows for one action, from the last update's measurements and
   * the live hold. The returned object is reused (one per kind and state) and
   * mutated by later calls: read it, do not keep it.
   */
  status(kind: MiningKind): ActionState {
    const u = this.opts.universe;
    const cargo = u.cargo;
    const g = this.gate;
    if (kind === 'mine') {
      const e = this.ext;
      if (e && cargo) {
        const s = this.running.mine;
        const begun = shownKg(e, cargo.freeKg, this.remaining[e.resource]) - e.minedKg;
        const cap = cargo.capacityKg;
        s.progress = cap > 0 ? Math.min(1, Math.max(0, (cargo.totalKg + begun) / cap)) : 0;
        s.shownKg = e.minedKg + begun;
        s.leftS = 0;
        s.resource = e.resource;
        return s;
      }
    } else if (this.active && this.job.kind === kind) {
      const s = this.running[kind];
      const total = ACTION_S[kind];
      const left = Math.max(0, this.job.leftS);
      s.progress = Math.min(1, Math.max(0, 1 - left / total));
      s.shownKg = 0;
      s.leftS = left;
      s.resource = null;
      return s;
    }
    let reason: BlockedState['reason'] | null;
    if (!this.hull || !cargo || !u.flight.propellant) reason = 'no-tank';
    else if (this.active || this.ext) reason = 'busy';
    else if (g.cruise) reason = 'cruise';
    else if (g.warpPhase !== 'idle') reason = 'jump';
    else if (kind === 'mine') {
      const m = mayMine(g);
      reason = m.ok ? null : m.reason!;
    } else if (!mayAct(g)) reason = 'busy';
    else reason = kind === 'refine' ? refineRefusal(cargo, u.flight.propellant) : repairRefusal(cargo, u.flight.propellant);
    if (reason === null) return READY;
    const s = this.blocked[kind];
    s.reason = reason;
    return s;
  }

  init(_ctx?: EngineContext): void {
    this.active = false;
    this.ext = null;
    this.recovered = false;
    this.offs.push(
      bus.on('ship:recovered', () => {
        this.recovered = true;
      }),
    );
  }

  /**
   * Gated to flight (game/gating.ts). A module that sleeps does not update, so
   * an extraction ends (interrupted) and a refine or repair is aborted.
   */
  onModeChange(_from: Mode, to: Mode): void {
    if (to === 'flight') return;
    if (this.ext) this.endExtraction('interrupted');
    if (this.active) this.abort();
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.active = false;
    this.ext = null;
  }

  update(_dt: number, ctx: EngineContext): void {
    const u = this.opts.universe;
    const cargo = u.cargo;
    const tank = u.flight.propellant;
    const recovered = this.recovered;
    this.recovered = false;
    this.endedThisFrame = false;
    if (!cargo || !tank) {
      // Inert: no tank or no hold (Yard, showroom).
      if (this.ext) this.endExtraction('interrupted');
      // Task 7 (R16): a refine or repair dropped here is still announced as ended.
      if (this.active) this.endAction(false);
      this.inRange = false;
      this.hull = false;
      return;
    }
    this.hull = true;
    this.measure(cargo);

    if (this.ext) this.extract(cargo, tank, recovered, u.simulatedSeconds);

    if (this.active) {
      if (recovered || !mayAct(this.gate)) {
        this.abort();
      } else {
        this.job.leftS -= Math.max(0, u.simulatedSeconds);
        if (this.job.leftS <= DONE_EPS_S) this.complete(cargo, tank);
      }
    }

    // Paused or frozen: the keys say nothing at all.
    if (u.paused || u.frozen) return;
    const input = ctx.input;
    if (input.pressed('mine') && !this.endedThisFrame) this.press('mine', cargo, tank);
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
    // A destroyed rock has no spec: it is not a target (the id may linger a frame).
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
    this.astRadiusKm = spec.radiusKm;
    g.targetIsAsteroid = true;
    // The ship on the rocks' clock, not up to a substep behind it.
    const p = u.flight.renderWorldPosition ?? u.flight.worldPosition;
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

  /** Why the extraction underway may not go on this frame, or null (asked once, before the bites). */
  private extractionGate(e: Extraction, recovered: boolean): ExtractionEnd | null {
    if (recovered) return 'interrupted';
    const m = mayMine(this.gate);
    // Pause, freeze, cruise or a jump own the ship now.
    if (m.reason === 'busy') return 'interrupted';
    // It belongs to the rock it started on.
    if (this.targetAsteroid !== null && this.targetAsteroid !== e.asteroidId) return 'interrupted';
    if (m.ok) return null;
    switch (m.reason) {
      case 'no-target':
      case 'range':
      case 'speed':
      case 'hold-full':
        return m.reason;
      default:
        // 'depleted': every resource under MINE_MIN_KG (such a rock is already gone).
        return 'resource-depleted';
    }
  }

  /** One frame of the extraction: the gate, the time, then every bite it pays. */
  private extract(cargo: Cargo, tank: Propellant, recovered: boolean, simSeconds: number): void {
    const e = this.ext!;
    const end = this.extractionGate(e, recovered);
    if (end !== null) {
      this.endExtraction(end);
      return;
    }
    accrue(e, simSeconds);
    const { belt, worldState } = this.opts;
    const id = e.asteroidId;
    const r = e.resource;
    let rest = this.remaining[r];
    let bitten = false;
    for (;;) {
      const kg = nextBiteKg(e, cargo.freeKg, rest);
      if (kg <= 0) break;
      const res = applyCargoAction(cargo, tank, { kind: 'mine', asteroidId: id, resource: r, kg });
      if (!res.ok) {
        // The size is within the room and the rest, so the hold should not refuse.
        this.endExtraction(res.reason === 'hold-full' ? 'hold-full' : 'interrupted');
        if (bitten) this.measure(cargo);
        return;
      }
      bitten = true;
      commitBite(e, res.kgIn);
      worldState.recordMined(id, r, res.kgIn, 'local');
      rest = belt.remainingKg(id, r);
      bus.emit('mining:bite', { asteroidId: id, resource: r, kg: res.kgIn });
      if (belt.isDestroyed(id)) {
        bus.emit('asteroid:destroyed', { asteroidId: id });
        this.endExtraction('rock-depleted');
        this.measure(cargo);
        return;
      }
    }
    // The bite size is 0: end now, so carry can never pay out later as a burst.
    if (!(cargo.freeKg >= MINE_MIN_KG)) this.endExtraction('hold-full');
    else if (!(rest >= MINE_MIN_KG)) this.endExtraction('resource-depleted');
    // The hold and the rock changed: the gate and status() read this frame's state.
    if (bitten) this.measure(cargo);
    if (this.ext) this.placeOperation();
  }

  /** The operation's source (the nose) and impact (the rock's surface nearest the ship), in place. */
  private placeOperation(): void {
    const f = this.opts.universe.flight;
    const p = f.renderWorldPosition ?? f.worldPosition;
    const a = this.astPos;
    let dx = p.x - a.x;
    let dy = p.y - a.y;
    let dz = p.z - a.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > 1e-12) {
      dx /= d;
      dy /= d;
      dz /= d;
    } else {
      dx = 1;
      dy = 0;
      dz = 0;
    }
    const rad = this.astRadiusKm;
    const im = this.opImpact;
    im.x = a.x + dx * rad;
    im.y = a.y + dy * rad;
    im.z = a.z + dz * rad;
    const fw = f.forward;
    const s = this.opSource;
    s.x = p.x + (fw ? fw.x * NOSE_OFFSET_KM : 0);
    s.y = p.y + (fw ? fw.y * NOSE_OFFSET_KM : 0);
    s.z = p.z + (fw ? fw.z * NOSE_OFFSET_KM : 0);
  }

  private endExtraction(end: ExtractionEnd): void {
    const e = this.ext;
    if (!e) return;
    this.ext = null;
    this.endedThisFrame = true;
    const good = e.minedKg >= MINE_MIN_KG && (end === 'stopped' || end === 'hold-full' || end === 'resource-depleted' || end === 'rock-depleted');
    this.log(extractionLog(end, e.minedKg, e.resource), good ? 'good' : 'warn');
    bus.emit('mining:ended', { asteroidId: e.asteroidId, resource: e.resource, minedKg: e.minedKg, end });
  }

  private press(kind: MiningKind, cargo: Cargo, tank: Propellant): void {
    // B again stops the extraction underway.
    if (kind === 'mine' && this.ext) {
      this.endExtraction('stopped');
      return;
    }
    if (this.active || this.ext) {
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
    if (kind === 'mine') {
      const r = chooseResource(this.remaining);
      if (r === null) {
        // The gate passed on ≥ MINE_MIN_KG in all, so one resource has it; kept for safety.
        this.log(REFUSAL_LOG.depleted, 'warn');
        return;
      }
      const id = this.targetAsteroid!;
      this.ext = startExtraction(id, r);
      this.op.asteroidId = id;
      this.op.resource = r;
      this.placeOperation();
      bus.emit('mining:started', { asteroidId: id, resource: r });
      return;
    }
    this.active = true;
    this.job.kind = kind;
    this.job.leftS = ACTION_S[kind];
    bus.emit('action:started', { kind });
  }

  private abort(): void {
    this.active = false;
    this.log(ABORT_TEXT[this.job.kind], 'warn');
    this.endAction(false);
  }

  private complete(cargo: Cargo, tank: Propellant): void {
    this.active = false;
    const kind = this.job.kind;
    const res = applyCargoAction(cargo, tank, { kind });
    if (!res.ok) {
      this.log(REFUSAL_LOG[res.reason ?? 'invalid'], 'warn');
      this.endAction(false);
      return;
    }
    this.log(kind === 'refine' ? refinedLog(res.fuelKg) : repairedLog(res.restoredFrac), 'good');
    this.endAction(true);
  }

  /** The refine or repair underway is over: the one `action:ended` it gets (Task 7). */
  private endAction(ok: boolean): void {
    this.active = false;
    bus.emit('action:ended', { kind: this.job.kind, ok });
  }

  private log(text: string, tone: 'normal' | 'warn' | 'good'): void {
    bus.emit('log', { text, tone });
  }
}
