/**
 * What `J` means right now. Pure; Pilot does the emitting.
 *
 * `J` jumps to the system selected on the galaxy chart. Without a selection it
 * tells the pilot how to make one rather than doing nothing (GAMEPLAY B5).
 */

export const JUMP_NO_SELECTION_HINT = 'SELECT A SYSTEM ON THE CHART — M';

export interface JumpSelection {
  readonly id: string;
  readonly name: string;
  readonly distanceLy: number;
}

export interface JumpKeyInput {
  /** The galaxy chart's current selection, or null. */
  readonly selection: JumpSelection | null;
  /** The system the ship is in. */
  readonly originId: string | null;
  /** False while a jump is already running. */
  readonly warpIdle: boolean;
}

export type JumpKeyResult =
  | { readonly kind: 'jump'; readonly systemId: string; readonly name: string; readonly distanceLy: number }
  | { readonly kind: 'hint'; readonly text: string }
  | { readonly kind: 'none' };

export function resolveJumpKey(input: JumpKeyInput): JumpKeyResult {
  // The drive logs its own state; a second voice here would only be noise.
  if (!input.warpIdle) return { kind: 'none' };
  const sel = input.selection;
  if (!sel || sel.id === input.originId) return { kind: 'hint', text: JUMP_NO_SELECTION_HINT };
  return { kind: 'jump', systemId: sel.id, name: sel.name, distanceLy: sel.distanceLy };
}
