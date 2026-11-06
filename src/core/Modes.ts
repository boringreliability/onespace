/**
 * Modes — the one answer to "what is the game doing right now".
 *
 * v1 had no such answer. A review shot set a global flag that seven modules
 * checked on their own, the map set a separate `Universe.paused`, and every
 * module ticked every frame regardless. Here there is one machine with a
 * table of legal transitions; modules declare the modes they live in
 * (`GameModule.activeIn`) and the engine gates them (see `tick.ts`).
 *
 * `photo` is an OVERLAY, not a mode you go to: it sits on top of a base mode
 * (flight or yard), freezes it, and hands it back exactly when popped.
 * Pure TypeScript — no three, no DOM — so it is tested in node.
 */

export type Mode = 'boot' | 'title' | 'flight' | 'map' | 'yard' | 'photo' | 'review';
export type BaseMode = Exclude<Mode, 'photo'>;
export type Overlay = 'photo';

/** Legal `go()` transitions. Anything absent throws. */
const TRANSITIONS: Readonly<Record<BaseMode, readonly BaseMode[]>> = {
  boot: ['title', 'flight', 'yard', 'review'],
  title: ['flight', 'yard', 'review'],
  flight: ['map', 'yard', 'title', 'review'],
  map: ['flight', 'review'],
  yard: ['flight', 'title', 'review'],
  // A review shot can be left for anywhere a player could be.
  review: ['flight', 'yard', 'title', 'map'],
};

/** Base modes a photo overlay may sit on. */
const OVERLAY_HOSTS: readonly BaseMode[] = ['flight', 'yard'];

export type ModeListener = (from: Mode, to: Mode) => void;

export class ModeMachine {
  private _base: BaseMode;
  private _overlay: Overlay | null = null;
  private listeners = new Set<ModeListener>();

  constructor(initial: BaseMode = 'boot') {
    this._base = initial;
  }

  get base(): BaseMode {
    return this._base;
  }

  get overlay(): Overlay | null {
    return this._overlay;
  }

  /** What the player sees: the overlay if one is up, else the base. */
  get current(): Mode {
    return this._overlay ?? this._base;
  }

  can(to: Mode): boolean {
    if (to === 'photo' || this._overlay) return false;
    return to === this._base || TRANSITIONS[this._base].includes(to);
  }

  go(to: Mode): void {
    if (to === this._base && !this._overlay) return;
    if (!this.can(to)) {
      throw new Error(`illegal mode transition ${this.current} → ${to}`);
    }
    const from = this._base;
    this._base = to as BaseMode;
    this.emit(from, to);
  }

  push(overlay: Overlay): void {
    if (this._overlay) throw new Error(`overlay ${this._overlay} already up`);
    if (!OVERLAY_HOSTS.includes(this._base)) {
      throw new Error(`${overlay} cannot sit on ${this._base}`);
    }
    this._overlay = overlay;
    this.emit(this._base, overlay);
  }

  pop(): void {
    const o = this._overlay;
    if (!o) throw new Error('no overlay to pop');
    this._overlay = null;
    this.emit(o, this._base);
  }

  onChange(fn: ModeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(from: Mode, to: Mode): void {
    for (const fn of this.listeners) fn(from, to);
  }
}

/** The game's single instance. Tests construct their own. */
export const modes = new ModeMachine();
