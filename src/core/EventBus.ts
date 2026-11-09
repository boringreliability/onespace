/**
 * A tiny typed publish/subscribe bus.
 *
 * Subsystems (flight, HUD, audio, director) need to react to each other
 * without importing each other — otherwise the module graph becomes a knot and
 * nothing can be tested or rebuilt in isolation. Everything cross-cutting goes
 * through here.
 */

import type { GameScale, PlanetSpec, StarSystemSpec, GalaxySpec, ScanResult } from '@/gen/types';
import type { PropellantAction } from '@/ship/travelCost';
import type { CargoAction, CargoResult } from '@/ship/cargo';

export interface GameEvents {
  /** Boot progress, 0..1, plus a status line for the loading veil. */
  'boot:progress': { progress: number; status: string };
  'boot:done': void;

  'scale:changed': { from: GameScale; to: GameScale };

  'galaxy:entered': { galaxy: GalaxySpec };
  'system:entered': { system: StarSystemSpec };
  'system:left': { system: StarSystemSpec };

  'planet:approached': { planet: PlanetSpec; altitudeKm: number };
  'planet:left': { planet: PlanetSpec };
  'planet:landed': { planet: PlanetSpec };

  'warp:charging': { progress: number };
  'warp:engaged': { targetName: string };
  'warp:arrived': { targetName: string };
  'warp:aborted': void;

  'scan:started': { targetId: string };
  'scan:complete': ScanResult;

  'throttle:changed': { value: number };
  'target:changed': { id: string | null; name: string | null };

  /** Anything the HUD should print in the message log. */
  'log': { text: string; tone?: 'normal' | 'warn' | 'good' };

  'quality:changed': { tier: string };
  /** The one chart key. Opens the LOCAL chart; SystemMap routes from there. */
  'ui:toggle-map': void;
  /** Show or hide the galactic chart. Owned by MapMode, requested by SystemMap. */
  'ui:toggle-galaxy': void;
  /**
   * Which chart, if any, currently owns the screen.
   *
   * Each chart announces its own state and nothing else's. Anything that has
   * to stand down while a chart is up — the flight HUD, the other chart —
   * listens here rather than to one chart's private open/close events, which
   * is how the local chart first shipped with the HUD showing through it.
   */
  'ui:chart': { chart: 'system' | 'galaxy' | null };
  'ui:toggle-codex': void;

  /** The camera rig changed viewpoint. HUD dims/undims the cockpit chrome on this. */
  'camera:mode': { mode: 'cockpit' | 'chase' | 'cinematic' | 'orbit' };
  /**
   * Request a camera shake. Anything that hits, explodes or drops out of warp
   * emits this rather than importing the rig. `intensity` is 0..1, `duration`
   * is the decay time in seconds.
   */
  'camera:shake': { intensity: number; duration: number };

  /** Ship met the ground softly enough to survive. `vertical` is impact speed along the surface normal, km/s. */
  /** `slip`: horizontal speed against the (turning) ground at first contact, km/s. */
  'ship:touchdown': { speed: number; vertical: number; slip: number; planetId: string | null };
  /** Ship met the ground too fast. The hull is gone. */
  'ship:crashed': { speed: number; planetId: string | null };
  /**
   * The recovery cut has just teleported the ship into a circular orbit
   * (crash, star contact or RETURN TO ORBIT). Anything flying the ship — the
   * cruise drive above all — must let go, or it flies the ship out again.
   */
  'ship:recovered': { cause: 'crash' | 'star' | 'requested' | 'beacon' };

  /** [v4-fuel] The pilot took the emergency exit on an empty tank (sub-plan 3 logs it). */
  'emergency:used': {
    kind: 'cannibalize' | 'beacon';
    /** Cannibalizations so far, this one included (cannibalize only). */
    timesUsed?: number;
  };

  /**
   * [v4-fuel] A named tank action was applied (P3). `kg`: taken from the tank,
   * or put back for a refund. Cruise legs are announced per leg segment.
   */
  'propellant:action': { action: PropellantAction; ok: boolean; kg: number };

  /** [v4-mining] A named hold action was applied; refusals are announced too. */
  'cargo:action': { action: CargoAction; result: CargoResult };

  /** The star map's open transition started/ended. Flight input should stand down. */
  'ui:map-opened': void;
  'ui:map-closed': void;

  /** A course was plotted (or cleared, when `systemId` is null) on the star map. */
  'nav:route-set': { systemId: string | null; name: string | null; distanceLy: number };
  /** The pilot confirmed the jump. The warp drive decides whether it happens. */
  'nav:jump-requested': { systemId: string; name: string; distanceLy: number };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<never>>>();

  on<K extends keyof GameEvents>(event: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }

  once<K extends keyof GameEvents>(event: K, fn: Handler<GameEvents[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  emit<K extends keyof GameEvents>(
    event: K,
    ...args: GameEvents[K] extends void ? [] : [GameEvents[K]]
  ): void {
    const set = this.handlers.get(event);
    if (!set) return;
    const payload = args[0] as never;
    // Copy: handlers are allowed to unsubscribe themselves during dispatch.
    for (const fn of [...set]) {
      try {
        (fn as Handler<never>)(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${String(event)}" threw:`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

/** The single bus instance shared by the whole game. */
export const bus = new EventBus();
