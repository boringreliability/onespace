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
   * Position the camera and configure the world. May be async (e.g. to await
   * terrain streaming). Called once when the shot is selected.
   */
  apply(ctx: EngineContext): void | Promise<void>;
  /** Optional: called every frame while this shot is active. */
  update?(dt: number, ctx: EngineContext): void;
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
  active = shot;
  await shot.apply(ctx);
}

export function activeShot(): Shot | null {
  return active;
}

export function updateActiveShot(dt: number, ctx: EngineContext): void {
  active?.update?.(dt, ctx);
}

export function clearShot(): void {
  active = null;
}
