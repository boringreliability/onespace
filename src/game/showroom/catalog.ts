/**
 * The Yard's catalogue — which ships exist to be shown, and how the controls
 * step through them.
 *
 * Pure: no three, no DOM. Every answer is read off `families.ts` (who builds
 * what) and the role table (what sizes a role comes in), so a combination the
 * generator would quietly re-roll — Sillane do not build miners; nobody builds
 * a super-capital tug — is never offered in the first place. A Yard that let
 * you pick "Sillane miner" and then showed you a Sillane survey ship would be
 * lying on the label.
 */

import { FACTIONS, ROLE_IDS, factionRoleWeight, roleById, tryFactionById } from '@/gen/ships/families';
import type { ShipParams } from '@/gen/ships/blueprint';
import type { ShipRole, SizeClass } from '@/gen/ships/types';
import { serializeRoute, type RouteShip } from '@/core/Route';

/** What the Yard is showing. Always legal (see `isLegal`). */
export interface YardSelection {
  readonly seed: number;
  readonly factionId: string;
  readonly role: ShipRole;
  readonly sizeClass: SizeClass;
}

/** The HERO_SHIP's identity: the hull the review set is built around. */
export const DEFAULT_SELECTION: YardSelection = {
  seed: 0x5a17c0de,
  factionId: 'kessler',
  role: 'freighter',
  sizeClass: 'medium',
};

export const FACTION_IDS: readonly string[] = FACTIONS.map((f) => f.id);

/** Roles a faction builds at all, in `ROLE_IDS` order. Unknown faction → none. */
export function rolesFor(factionId: string): readonly ShipRole[] {
  const f = tryFactionById(factionId);
  if (!f) return [];
  return ROLE_IDS.filter((r) => factionRoleWeight(f, r) > 0);
}

/** Size classes a role is built in, as the role table lists them. */
export function sizesFor(role: ShipRole): readonly SizeClass[] {
  return roleById(role).sizeClasses;
}

export function isLegal(s: YardSelection): boolean {
  return (
    s.seed === s.seed >>> 0 && rolesFor(s.factionId).includes(s.role) && sizesFor(s.role).includes(s.sizeClass)
  );
}

/** Unsigned 32-bit successor; 0xffffffff wraps to 0. */
export function nextSeed(seed: number): number {
  return (seed + 1) >>> 0;
}

/** Unsigned 32-bit predecessor; 0 wraps to 0xffffffff. */
export function prevSeed(seed: number): number {
  return (seed - 1) >>> 0;
}

/** Step through a list with wrap. A value not in it lands on the first (or last). */
export function cycle<T>(list: readonly T[], current: T, step: 1 | -1): T {
  const i = list.indexOf(current);
  if (i < 0) return step > 0 ? list[0]! : list[list.length - 1]!;
  return list[(i + step + list.length) % list.length]!;
}

/**
 * The size a role is shown at when none was asked for. Medium where the role
 * is built in it — the band the review set and every faction comparison are
 * composed in — otherwise the middle of the role's own list.
 */
function defaultSize(role: ShipRole): SizeClass {
  const sizes = sizesFor(role);
  return sizes.includes('medium') ? 'medium' : sizes[Math.floor((sizes.length - 1) / 2)]!;
}

/**
 * Turn any partial request into a legal selection, keeping as much of it as
 * is legal. Repairs rather than rejects: a link that names a combination this
 * build cannot make should still open the Yard on the nearest thing it can.
 */
export function legalize(p: {
  readonly seed: number;
  readonly factionId?: string;
  readonly role?: ShipRole;
  readonly sizeClass?: SizeClass;
}): YardSelection {
  const factionId = p.factionId !== undefined && tryFactionById(p.factionId) ? p.factionId : DEFAULT_SELECTION.factionId;
  const roles = rolesFor(factionId);
  const role =
    p.role !== undefined && roles.includes(p.role)
      ? p.role
      : roles.includes(DEFAULT_SELECTION.role)
        ? DEFAULT_SELECTION.role
        : roles[0]!;
  const sizeClass =
    p.sizeClass !== undefined && sizesFor(role).includes(p.sizeClass) ? p.sizeClass : defaultSize(role);
  return { seed: p.seed >>> 0, factionId, role, sizeClass };
}

export function stepFaction(s: YardSelection, step: 1 | -1): YardSelection {
  return legalize({ ...s, factionId: cycle(FACTION_IDS, s.factionId, step) });
}

export function stepRole(s: YardSelection, step: 1 | -1): YardSelection {
  // The size is carried across when the new role is built in it: stepping
  // freighter → tanker at medium should stay at medium.
  return legalize({ ...s, role: cycle(rolesFor(s.factionId), s.role, step) });
}

export function stepSize(s: YardSelection, step: 1 | -1): YardSelection {
  return { ...s, sizeClass: cycle(sizesFor(s.role), s.sizeClass, step) };
}

export function stepSeed(s: YardSelection, step: 1 | -1): YardSelection {
  return { ...s, seed: step > 0 ? nextSeed(s.seed) : prevSeed(s.seed) };
}

/** A parsed route's ship (already whitelisted by `parseRoute`) as a legal selection. */
export function selectionFromRoute(ship: RouteShip | undefined): YardSelection {
  if (!ship) return DEFAULT_SELECTION;
  return legalize(ship);
}

/**
 * Generator parameters. Age, maintenance and damage are left to the seed —
 * the link carries only the four fields a person chose.
 */
export function toShipParams(s: YardSelection): ShipParams {
  return { seed: s.seed, factionId: s.factionId, role: s.role, sizeClass: s.sizeClass };
}

export function toRouteShip(s: YardSelection): RouteShip {
  return { seed: s.seed, factionId: s.factionId, role: s.role, sizeClass: s.sizeClass };
}

/** Query keys the Yard owns. Everything else in the URL belongs to someone else. */
const YARD_KEYS: readonly string[] = ['mode', 'ship', 'faction', 'role', 'size', 'gen'];

/**
 * The current query string with the Yard's fields replaced (or, with `null`,
 * removed). Other parameters — `?tier=`, `?dpr=`, `?dev` — survive, so
 * `history.replaceState` in the Yard never throws away a developer's overrides.
 */
export function withYardRoute(search: string, s: YardSelection | null): string {
  const q = new URLSearchParams(search);
  for (const k of YARD_KEYS) q.delete(k);
  if (s) {
    const yard = new URLSearchParams(serializeRoute({ mode: 'yard', ship: toRouteShip(s), warnings: [] }));
    for (const [k, v] of yard) q.set(k, v);
  }
  // `?dev` serialises as `dev=`; keep it the bare flag a person would type.
  const out = q.toString().replace(/(^|&)dev=(?=&|$)/, '$1dev');
  return out ? `?${out}` : '';
}
