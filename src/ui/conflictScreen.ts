/**
 * The conflict screen's state, texts and boot orchestration (v4 sub-plan 4,
 * Task 6; DESIGN-4 §5.3; rulings R49, R55, R58). Pure: the DOM lives in
 * ConflictScreen.ts.
 *
 * Two saves diverged; the player keeps one — THIS DEVICE or CLOUD. The
 * screen appears only at boot, before the game continues (R49), and cannot
 * be dismissed without a choice. The chosen save comes back from the server
 * (`SyncClient.resolve`), is put in the store, and decideBoot continues it.
 */

import type { BootDecision, ResolveResult, SyncClient } from '@/net/SyncClient';
import { SYNC_CONFLICT_TEXT, SYNC_OFFLINE_TEXT, SYNC_REAUTH_TEXT } from '@/net/SyncClient';
import { cardSummary } from '@/save/conflict';
import type { SaveV1 } from '@/save/schema';
import { PROBE_TANK_CAPACITY_KG } from '@/ship/propellant';

export const CONFLICT_TITLE = 'TWO SAVES DIVERGED';
export const CONFLICT_DEVICE = 'THIS DEVICE';
export const CONFLICT_CLOUD = 'CLOUD';
export const KEEP_THIS_TEXT = 'KEEP THIS';
export const KEEP_CLOUD_TEXT = 'KEEP CLOUD';

export type ConflictChoice = 'device' | 'cloud';

export function keepLabel(choice: ConflictChoice): string {
  return choice === 'device' ? KEEP_THIS_TEXT : KEEP_CLOUD_TEXT;
}

export interface ConflictCard {
  readonly label: string;
  readonly system: string;
  readonly place: string;
  readonly tank: string;
  readonly cargo: string;
  readonly ago: string;
}

export type BodyNameFn = (id: string) => string | null;

export interface CardOptions {
  readonly nowMs: number;
  /** R55: the body's real name; best-effort (R58) — a resolver that throws counts as null. */
  readonly bodyName?: BodyNameFn;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How long ago a save was made: just now, N min, N h, N d (floored). */
export function agoText(savedAtMs: number, nowMs: number): string {
  const age = nowMs - savedAtMs;
  if (!(age >= MIN)) return 'just now';
  if (age < HOUR) return `${Math.floor(age / MIN)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  return `${Math.floor(age / DAY)} d ago`;
}

function safeName(fn: BodyNameFn | undefined): BodyNameFn | undefined {
  if (!fn) return undefined;
  return (id) => {
    try {
      return fn(id);
    } catch {
      return null;
    }
  };
}

/** One card: where the save is and what it carries — the tank as the HUD reads it. */
export function conflictCard(s: SaveV1, label: string, o: CardOptions): ConflictCard {
  const capacityKg = PROBE_TANK_CAPACITY_KG * (1 - s.ship.propellant.capacityLossFrac);
  const c = cardSummary(s, capacityKg, safeName(o.bodyName));
  return {
    label,
    system: c.systemName,
    place: c.place,
    tank: `${Math.round(Math.min(1, Math.max(0, c.tankFrac)) * 100)} %`,
    cargo: `${(c.cargoKg / 1000).toFixed(1)} t`,
    ago: agoText(c.savedAtWallMs, o.nowMs),
  };
}

export interface ConflictState {
  readonly choice: ConflictChoice;
  readonly device: ConflictCard;
  readonly cloud: ConflictCard;
}

export function initialConflict(local: SaveV1, cloud: SaveV1, o: CardOptions): ConflictState {
  return {
    choice: 'device',
    device: conflictCard(local, CONFLICT_DEVICE, o),
    cloud: conflictCard(cloud, CONFLICT_CLOUD, o),
  };
}

export type ConflictEvent =
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'enter' }
  | { kind: 'click'; choice: ConflictChoice };

export type ConflictEffect = { kind: 'none' } | { kind: 'choose'; keep: ConflictChoice };

export function conflictStep(s: ConflictState, e: ConflictEvent): { state: ConflictState; effect: ConflictEffect } {
  switch (e.kind) {
    case 'left':
      return { state: { ...s, choice: 'device' }, effect: { kind: 'none' } };
    case 'right':
      return { state: { ...s, choice: 'cloud' }, effect: { kind: 'none' } };
    case 'enter':
      return { state: s, effect: { kind: 'choose', keep: s.choice } };
    case 'click':
      return { state: { ...s, choice: e.choice }, effect: { kind: 'choose', keep: e.choice } };
  }
}

export interface ConflictKeyInput {
  readonly code: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
}

/**
 * A keydown while the screen is up. Every key is kept from the game and the
 * other menus (the DOM stops it); a browser chord keeps its default. Esc does
 * nothing: there is no way out without a choice.
 */
export function conflictKey(k: ConflictKeyInput): { event: ConflictEvent | null; preventDefault: boolean } {
  if (k.metaKey || k.ctrlKey || k.altKey) return { event: null, preventDefault: false };
  const event: ConflictEvent | null =
    k.code === 'ArrowLeft' || k.code === 'KeyA'
      ? { kind: 'left' }
      : k.code === 'ArrowRight' || k.code === 'KeyD'
        ? { kind: 'right' }
        : k.code === 'Enter' || k.code === 'Space'
          ? { kind: 'enter' }
          : null;
  return { event, preventDefault: true };
}

// -----------------------------------------------------------------------------
// R49 — the boot orchestration

export interface BootConflictDeps {
  readonly boot: { readonly decision: BootDecision; readonly cloud: SaveV1 | null; readonly local: SaveV1 | null };
  readonly sync: Pick<SyncClient, 'resolve'>;
  /** Show the screen (again) and resolve with the player's choice. */
  readonly choose: (view: ConflictState) => Promise<ConflictChoice>;
  readonly nowMs: () => number;
  readonly bodyName?: BodyNameFn;
}

export interface BootConflictOutcome {
  /** The save boot continues with (already in the store); null = continue the local save. */
  readonly resolved: SaveV1 | null;
  readonly notices: string[];
}

const failNotice = (r: Extract<ResolveResult, { ok: false }>): string =>
  r.reason === 'reauth' ? SYNC_REAUTH_TEXT : r.reason === 'offline' ? SYNC_OFFLINE_TEXT : SYNC_CONFLICT_TEXT;

/**
 * R49: a conflict decided at boot is chosen here, before the game continues.
 * resolve fails: offline / reauth → their text, continue local (the conflict
 * is kept); moved → the screen once more with the new cloud; moved again (or
 * moved with nothing to show) → continue local with the conflict text.
 */
export async function settleBootConflict(d: BootConflictDeps): Promise<BootConflictOutcome> {
  const { decision, local, cloud } = d.boot;
  if ((decision.kind !== 'conflict-same' && decision.kind !== 'conflict-different') || !local || !cloud) {
    return { resolved: null, notices: [] };
  }
  const opts = (): CardOptions => ({ nowMs: d.nowMs(), bodyName: d.bodyName });
  let view = initialConflict(local, cloud, opts());
  for (let attempt = 0; attempt < 2; attempt++) {
    const keep = await d.choose(view);
    const r = await d.sync.resolve(keep);
    if (r.ok) return { resolved: r.save, notices: [] };
    if (r.reason !== 'moved' || !r.cloud || attempt === 1) return { resolved: null, notices: [failNotice(r)] };
    view = { ...view, choice: 'device', cloud: conflictCard(r.cloud, CONFLICT_CLOUD, opts()) };
  }
  return { resolved: null, notices: [SYNC_CONFLICT_TEXT] };
}
