/**
 * A tiny typed publish/subscribe bus.
 *
 * Subsystems (flight, HUD, audio, director) need to react to each other
 * without importing each other — otherwise the module graph becomes a knot and
 * nothing can be tested or rebuilt in isolation. Everything cross-cutting goes
 * through here.
 */

import type { GameScale, PlanetSpec, StarSystemSpec, GalaxySpec, ScanResult } from '@/gen/types';

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
  'ui:toggle-map': void;
  'ui:toggle-codex': void;
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
