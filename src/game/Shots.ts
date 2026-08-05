/**
 * Named camera setups for automated visual review.
 *
 * Every renderer module registers at least one "hero shot" that frames its own
 * work at its best — the frame it wants to be judged on. `scripts/shoot.mjs`
 * drives these and hands the PNGs to the visual critics.
 *
 * A shot must be *deterministic*: same seed, same camera, same frame. If a shot
 * depends on animation it must reach a steady state within the settle window.
 */

import type { EngineContext } from '@/core/Engine';

export interface Shot {
  /** Kebab-case, stable — it becomes the PNG filename. */
  readonly name: string;
  /** What a reviewer should be looking at. Shown in the review report. */
  readonly description: string;
  /**
   * Set when the shot wants the *running game* rather than an isolated fixture.
   *
   * By default a shot OWNS the scene: the universe stops placing bodies, the
   * pilot stops flying, and the HUD stands down, so the shot's own camera and
   * fixtures survive the frame. Without that, the simulation would overwrite
   * every transform the shot just set and the subject would never be in frame.
   */
  readonly live?: boolean;
  /**
   * Position the camera and configure the world. May be async (e.g. to await
   * terrain streaming). Called once when the shot is selected.
   */
  apply(ctx: EngineContext): void | Promise<void>;
  /** Optional: called every frame while this shot is active. */
  update?(dt: number, ctx: EngineContext): void;
  /**
   * Optional: called when this shot is replaced by another.
   *
   * The capture harness drives every shot in one page load, so a fixture built
   * by one shot is still in the scene when the next runs. Without this, shots
   * silently contaminate each other — and a borrowed fixture is worse than a
   * missing one, because the frame looks plausible and is wrong.
   */
  teardown?(ctx: EngineContext): void;
}

const shots = new Map<string, Shot>();
let active: Shot | null = null;

export function registerShot(shot: Shot): void {
  if (shots.has(shot.name)) {
    console.warn(`[Shots] "${shot.name}" registered twice — the later one wins`);
  }
  shots.set(shot.name, shot);
}

export function shotNames(): string[] {
  return [...shots.keys()].sort();
}

export function shotList(): Array<{ name: string; description: string }> {
  return shotNames().map((n) => ({ name: n, description: shots.get(n)!.description }));
}

export async function setShot(name: string, ctx: EngineContext): Promise<void> {
  const shot = shots.get(name);
  if (!shot) throw new Error(`unknown shot "${name}"`);
  if (active && active !== shot) active.teardown?.(ctx);
  active = shot;
  await shot.apply(ctx);
}

export function activeShot(): Shot | null {
  return active;
}

export function activeShotName(): string | null {
  return active?.name ?? null;
}

/**
 * True when a review shot has taken the scene over. Simulation modules must
 * check this and leave every transform alone — see the `live` note above.
 */
export function shotOwnsScene(): boolean {
  return active !== null && active.live !== true;
}

export function updateActiveShot(dt: number, ctx: EngineContext): void {
  active?.update?.(dt, ctx);
}

export function clearShot(): void {
  active = null;
}
