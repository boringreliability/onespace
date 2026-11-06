/**
 * Targeting — owns the ONE current nav target.
 *
 * `Hud.setTarget()` was built in full (bracket, range, edge clamp) and only
 * ever called by review shots; `Tab` was bound to `cycleTarget` and nothing
 * read it; a selection on the local chart only cleared the glass (GAMEPLAY
 * B2). This module closes all three:
 *
 *  - `Tab` cycles bodies and vessels, ordered by angle from the nose.
 *  - A chart selection (`target:changed` from SystemMap) sets the same target.
 *  - Every frame the target is projected and handed to the HUD with range,
 *    closing speed and ETA.
 *
 * Contract shared with the other modules: body ids are `body:<spec.name>`,
 * vessel ids are the blueprint id, and every change is announced on the
 * existing `target:changed`. The cruise drive reads that to steer.
 *
 * It also places the distant-world dots, because "brighter when targeted" is
 * the one thing the dots need to know and this is where it is known.
 */

import { Vector3 } from 'three';

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { config } from '@/core/Config';
import { shotOwnsScene } from '@/game/Shots';
import type { Traffic } from '@/game/Traffic';
import type { Universe, UniverseBody } from '@/game/Universe';
import { projectToScreen, type ScreenPoint } from '@/game/flightAids';
import {
  TargetSelection,
  bodyTargetId,
  closingSpeed,
  etaSeconds,
  nextTargetId,
  orderByNoseAngle,
  targetRangeKm,
  type NamedBody,
  type TargetCandidate,
} from '@/game/targets';
import { BodyDotsRenderer, registerBodyDotsShots } from '@/render/BodyDots';
import { MutableViewState } from '@/render/ViewState';
import type { Hud, HudTarget } from '@/ui/Hud';

/** Slots in the dot renderer. Generated systems stay well under this. */
const DOT_CAPACITY = 96;
/** Dot brightness, 0..1: dim for the sky, full for the nav target. */
const DOT_DIM = 0.22;
const DOT_TARGET = 1;

export interface TargetingOptions {
  readonly universe: Universe;
  readonly traffic?: Traffic | null;
  readonly hud?: Hud | null;
}

type MutableHudTarget = { -readonly [K in keyof HudTarget]: HudTarget[K] };

export class Targeting implements GameModule {
  readonly name = 'targeting';

  readonly dots = new BodyDotsRenderer({ capacity: DOT_CAPACITY }, config.quality);

  private readonly universe: Universe;
  private readonly traffic: Traffic | null;
  private readonly hud: Hud | null;
  private readonly selection = new TargetSelection();
  private offs: Array<() => void> = [];

  /** Resolved each frame: the targeted body, or null for a vessel / nothing. */
  private body: UniverseBody | null = null;
  private targetName = '';
  private targetKind = '';
  /** The targeted body's name, cached at selection so resolving never slices. */
  private bodyName: string | null = null;

  // Preallocated (ARCHITECTURE §5).
  private readonly shipWorld = new Vector3();
  private readonly shipVel = new Vector3();
  private readonly tgtWorld = new Vector3();
  private readonly tgtVel = new Vector3();
  private readonly prevVesselWorld = new Vector3();
  private hasPrevVessel = false;
  private readonly rel = new Vector3();
  private readonly relVel = new Vector3();
  private readonly render = new Vector3();
  private readonly screen: ScreenPoint = { x: 0, y: 0, behind: false };
  private readonly view = new MutableViewState();
  private readonly hudTarget: MutableHudTarget = {
    id: '',
    name: '',
    x: 0,
    y: 0,
    behind: false,
    distanceKm: 0,
    kind: '',
    closingKmS: 0,
    etaS: null,
  };

  constructor(opts: TargetingOptions) {
    this.universe = opts.universe;
    this.traffic = opts.traffic ?? null;
    this.hud = opts.hud ?? null;
  }

  /** The current target id, or null. Read-only view for other modules. */
  get targetId(): string | null {
    return this.selection.id;
  }

  init(ctx: EngineContext): void {
    ctx.scene.add(this.dots.object3d);
    registerBodyDotsShots(this.dots);

    this.offs.push(
      bus.on('target:changed', ({ id }) => {
        // Our own announcements come back through here too; `apply` reports
        // no change for them, which is what stops the echo.
        if (!this.selection.apply(id, this.namedBodies())) return;
        this.onSelectionChanged();
        // Re-announce only when the id had to be canonicalised, so listeners
        // never act on a form the contract does not define.
        if (this.selection.id !== id) this.announce();
      }),
      bus.on('system:entered', () => this.dots.setCount(0)),
    );
  }

  update(dt: number, ctx: EngineContext): void {
    if (shotOwnsScene()) {
      // A shot may be judging the dots themselves; keep them easing, but
      // never place them or touch the HUD bracket the shot set.
      this.dots.update(dt, ctx, this.view);
      return;
    }
    if (this.universe.paused) {
      this.dots.object3d.visible = false;
      return;
    }
    this.dots.object3d.visible = true;

    const flight = this.universe.flight;
    this.shipWorld.copy(flight.worldPosition);
    // The ship's world velocity: its parent-relative velocity plus the frame's.
    this.shipVel.copy(flight.velocity);
    const parent = this.universe.shipParent;
    if (parent) this.shipVel.add(parent.worldVelocity);

    if (ctx.input.pressed('cycleTarget')) this.cycle(flight.forward);

    const found = this.resolve(dt);
    if (!found && this.selection.id !== null) {
      // The body left with its system, or the vessel was released.
      this.selection.apply(null, []);
      this.onSelectionChanged();
      this.announce();
    }

    this.placeDots(ctx);
    this.dots.update(dt, ctx, this.view);

    if (!this.hud) return;
    if (!found) {
      this.hud.setTarget(null);
      return;
    }
    this.publish(ctx);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.dots.object3d.removeFromParent();
    this.dots.dispose();
  }

  // -------------------------------------------------------------------------

  private cycle(nose: Vector3): void {
    // Allocates: runs once per key press, never per frame.
    const cands: TargetCandidate[] = [];
    for (const b of this.universe.allBodies()) {
      cands.push({
        id: bodyTargetId(b.spec.name),
        name: b.spec.name,
        rel: new Vector3().subVectors(b.world, this.shipWorld),
      });
    }
    const t = this.traffic;
    if (t) {
      for (let i = 0; i < t.contactCount; i++) {
        const c = t.contactAt(i);
        if (c) cands.push({ id: c.id, name: c.name, rel: new Vector3().subVectors(c.world, this.shipWorld) });
      }
    }
    const ordered = orderByNoseAngle(cands, nose).map((c) => c.id);
    const next = nextTargetId(ordered, this.selection.id);
    if (next === null) {
      bus.emit('log', { text: 'NO CONTACTS TO TARGET', tone: 'warn' });
      return;
    }
    if (this.selection.apply(next, [])) {
      this.onSelectionChanged();
      this.announce();
    }
  }

  /**
   * Find the target's world position and velocity this frame. Allocation-free:
   * bodies by name, vessels through Traffic's copy-out accessor.
   */
  private resolve(dt: number): boolean {
    const id = this.selection.id;
    this.body = null;
    if (id === null) return false;

    const name = this.bodyName;
    if (name !== null) {
      for (const b of this.universe.allBodies()) {
        if (b.spec.name === name) {
          this.body = b;
          this.tgtWorld.copy(b.world);
          this.tgtVel.copy(b.worldVelocity);
          return true;
        }
      }
      return false;
    }

    if (!this.traffic || !this.traffic.vesselWorld(id, this.tgtWorld)) return false;
    // Traffic keeps no velocity; difference the position. Exact enough for a
    // closing-speed readout and costs nothing.
    if (this.hasPrevVessel && dt > 0) {
      this.tgtVel.subVectors(this.tgtWorld, this.prevVesselWorld).divideScalar(dt);
    } else {
      this.tgtVel.copy(this.shipVel); // first frame: assume station-keeping
    }
    this.prevVesselWorld.copy(this.tgtWorld);
    this.hasPrevVessel = true;
    return true;
  }

  private publish(ctx: EngineContext): void {
    const h = this.hudTarget;
    this.rel.subVectors(this.tgtWorld, this.shipWorld);
    this.relVel.subVectors(this.tgtVel, this.shipVel);
    const closing = closingSpeed(this.rel, this.relVel);
    const range = targetRangeKm(this.rel.length(), this.body ? this.body.spec.radius : 0);

    ctx.origin.toRender(this.tgtWorld, this.render);
    projectToScreen(this.render.x, this.render.y, this.render.z, 1, ctx.camera, ctx.width, ctx.height, this.screen);

    h.id = this.selection.id ?? '';
    h.name = this.targetName;
    h.kind = this.targetKind;
    h.x = this.screen.x;
    h.y = this.screen.y;
    h.behind = this.screen.behind;
    h.distanceKm = range;
    h.closingKmS = closing;
    h.etaS = etaSeconds(range, closing);
    this.hud!.setTarget(h);
  }

  /** Dots for every body that has no visible disc of its own. */
  private placeDots(ctx: EngineContext): void {
    const bodies = this.universe.allBodies();
    const n = Math.min(bodies.length, this.dots.capacity);
    this.dots.setCount(n);
    for (let i = 0; i < n; i++) {
      const b = bodies[i]!;
      // A streamed-in world stays hidden while its shaders compile; the dot
      // covers that gap and fades as the disc arrives.
      const disc = b.planet !== null && b.planet.object3d.visible;
      ctx.origin.toRender(b.world, this.render);
      const bright = disc ? 0 : b === this.body ? DOT_TARGET : DOT_DIM;
      this.dots.setDot(i, this.render.x, this.render.y, this.render.z, bright);
    }
  }

  private onSelectionChanged(): void {
    this.hasPrevVessel = false;
    const id = this.selection.id;
    this.bodyName = id !== null && id.startsWith('body:') ? id.slice(5) : null;
    if (id === null) {
      this.targetName = '';
      this.targetKind = '';
      return;
    }
    if (id.startsWith('body:')) {
      const name = id.slice(5);
      const b = this.universe.allBodies().find((x) => x.spec.name === name);
      this.targetName = name;
      this.targetKind = b ? (b.spec.isMoon ? `moon · ${b.spec.type}` : b.spec.type) : '';
      return;
    }
    const t = this.traffic;
    let name = id;
    if (t) {
      for (let i = 0; i < t.contactCount; i++) {
        const c = t.contactAt(i);
        if (c && c.id === id) name = c.name;
      }
    }
    this.targetName = name;
    this.targetKind = 'vessel';
  }

  private announce(): void {
    bus.emit('target:changed', { id: this.selection.id, name: this.selection.id ? this.targetName : null });
  }

  private namedBodies(): NamedBody[] {
    return this.universe.allBodies().map((b) => ({ id: b.spec.id, name: b.spec.name }));
  }
}
