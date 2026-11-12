/**
 * URL parameters → typed overrides.
 *
 * Whitelist only. A value that is not exactly one the game knows is dropped,
 * never passed through, so a link cannot smuggle arbitrary data into the
 * engine. Pure: takes the query string, returns plain data.
 */

import type { QualityTier } from './Config';
import type { BaseMode } from './Modes';
import { FACTIONS, ROLE_IDS } from '@/gen/ships/families';
import {
  SHIP_GENERATION_VERSION,
  SIZE_CLASS_LENGTH_KM,
  type ShipRole,
  type SizeClass,
} from '@/gen/ships/types';

const TIERS: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra'];

export interface DevParams {
  /** Force a quality tier instead of guessing from the GPU string. */
  readonly tier?: QualityTier;
  /** Force a device pixel ratio cap, 0 < dpr ≤ 3. */
  readonly dpr?: number;
}

/** Strict decimal: digits with an optional fraction. No exponents, no signs. */
const DECIMAL = /^\d+(\.\d+)?$/;

export function parseDevParams(search: string): DevParams {
  const q = new URLSearchParams(search);
  const out: { tier?: QualityTier; dpr?: number } = {};

  const tier = q.get('tier');
  if (tier !== null && (TIERS as readonly string[]).includes(tier)) out.tier = tier as QualityTier;

  const dpr = q.get('dpr');
  if (dpr !== null && DECIMAL.test(dpr)) {
    const v = Number(dpr);
    if (v > 0 && v <= 3) out.dpr = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The game route — boot mode, yard ship, universe seed.
// ---------------------------------------------------------------------------

/** Modes a link may boot into. `photo` is an overlay, `boot` is not a target. */
const BOOT_MODES: readonly BaseMode[] = ['title', 'flight', 'map', 'yard', 'review'];
const SIZES = Object.keys(SIZE_CLASS_LENGTH_KM) as SizeClass[];
const HEX = /^[0-9a-f]{1,8}$/i;
const SHOT = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface RouteShip {
  readonly seed: number;
  readonly factionId?: string;
  readonly role?: ShipRole;
  readonly sizeClass?: SizeClass;
}

export interface Route {
  readonly mode?: BaseMode;
  readonly ship?: RouteShip;
  readonly universeSeed?: number;
  /** Set when the link names a ship generation older than this build's. */
  readonly staleGeneration?: boolean;
  readonly shot?: string;
  readonly dev?: boolean;
  /** [v4-save] `?new=1`: start a new game even when a save exists. */
  readonly newGame?: true;
  /** Human-readable notes about dropped fields, for the log. */
  readonly warnings: readonly string[];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function hex(v: string | null): number | undefined {
  return v !== null && HEX.test(v) ? parseInt(v, 16) >>> 0 : undefined;
}

export function parseRoute(search: string): Route {
  const q = new URLSearchParams(search);
  const warnings: string[] = [];
  const out: Mutable<Route> = { warnings };

  const mode = q.get('mode');
  if (mode !== null) {
    if ((BOOT_MODES as readonly string[]).includes(mode)) out.mode = mode as BaseMode;
    else warnings.push(`unknown mode "${mode.slice(0, 24)}" ignored`);
  }

  const seed = hex(q.get('ship'));
  if (seed !== undefined) {
    const ship: Mutable<RouteShip> = { seed };
    const f = q.get('faction');
    if (f !== null) {
      if (FACTIONS.some((x) => x.id === f)) ship.factionId = f;
      else warnings.push('unknown faction ignored');
    }
    const r = q.get('role');
    if (r !== null) {
      if ((ROLE_IDS as readonly string[]).includes(r)) ship.role = r as ShipRole;
      else warnings.push('unknown role ignored');
    }
    const s = q.get('size');
    if (s !== null) {
      if ((SIZES as readonly string[]).includes(s)) ship.sizeClass = s as SizeClass;
      else warnings.push('unknown size ignored');
    }
    out.ship = ship;
    const gen = q.get('gen');
    // Any gen that is not exactly this build's is "not this standard": older
    // links name a ship this generator no longer makes, newer or garbled ones
    // a ship it never made. Silently re-pinning either shows a different hull
    // under the same link (review-p2). No gen at all = a hand-typed link.
    if (gen === null) out.staleGeneration = false;
    else if (/^\d{1,9}$/.test(gen)) out.staleGeneration = Number(gen) !== SHIP_GENERATION_VERSION;
    else {
      out.staleGeneration = true;
      warnings.push('unreadable ship generation');
    }
  }

  const universe = hex(q.get('seed'));
  if (universe !== undefined) out.universeSeed = universe;

  const shot = q.get('shot');
  if (shot !== null && SHOT.test(shot)) out.shot = shot;

  if (q.has('dev')) out.dev = true;

  // [v4-save] Whitelisted like the rest: exactly `1`, nothing else.
  const fresh = q.get('new');
  if (fresh !== null) {
    if (fresh === '1') out.newGame = true;
    else warnings.push(`unknown new "${fresh.slice(0, 24)}" ignored`);
  }
  return out;
}

/** [v4-save] Task 6: what a boot starts. */
export interface BootPlan {
  readonly mode: 'title' | 'flight' | 'yard';
  readonly start: 'continue' | 'new';
}

/**
 * Boot into the title unless a link names flight or the Yard (`map` and
 * `review` are entered from flight, not booted into). A save is continued
 * unless `?new=1` asks for a new game.
 */
export function bootPlan(route: Route, hasSave: boolean): BootPlan {
  const mode = route.mode === 'flight' || route.mode === 'yard' ? route.mode : 'title';
  return { mode, start: hasSave && route.newGame !== true ? 'continue' : 'new' };
}

/** Inverse of parseRoute for the fields a link carries. Pins the generation. */
export function serializeRoute(r: Route): string {
  const q = new URLSearchParams();
  if (r.mode) q.set('mode', r.mode);
  if (r.ship) {
    q.set('ship', (r.ship.seed >>> 0).toString(16));
    if (r.ship.factionId) q.set('faction', r.ship.factionId);
    if (r.ship.role) q.set('role', r.ship.role);
    if (r.ship.sizeClass) q.set('size', r.ship.sizeClass);
    q.set('gen', String(SHIP_GENERATION_VERSION));
  }
  if (r.universeSeed !== undefined) q.set('seed', (r.universeSeed >>> 0).toString(16));
  if (r.shot) q.set('shot', r.shot);
  if (r.dev) q.set('dev', '');
  const s = q.toString();
  return s ? `?${s}` : '';
}

// ---------------------------------------------------------------------------
// v3 T4 — SEE IN FLIGHT: a flight route that carries a ship names a companion.
// ---------------------------------------------------------------------------

/**
 * The ship to spawn beside the player, or null. Only an explicit
 * `?mode=flight` link spawns, and only a hull of THIS generation: an older
 * generator's ship is not this ship, and spawning a different one under the
 * same link is the review-p2 bug.
 */
export function companionShip(r: Route): RouteShip | null {
  if (r.mode !== 'flight' || !r.ship || r.staleGeneration !== false) return null;
  return r.ship;
}

/**
 * v3 polish (review low): the developer overrides SEE IN FLIGHT carries over
 * from the current URL. A whitelist — it used to keep every key that was not
 * a ship-route key, whatever it was.
 */
const CARRIED_KEYS: readonly string[] = ['tier', 'dpr', 'seed', 'dev'];

/** A generation-pinned flight route for `ship`, keeping only `search`'s developer overrides. */
export function seeInFlightSearch(search: string, ship: RouteShip): string {
  const from = new URLSearchParams(search);
  const q = new URLSearchParams();
  for (const k of CARRIED_KEYS) {
    const v = from.get(k);
    if (v !== null) q.set(k, v);
  }
  for (const [k, v] of new URLSearchParams(serializeRoute({ mode: 'flight', ship, warnings: [] }))) q.set(k, v);
  const out = q.toString().replace(/(^|&)dev=(?=&|$)/, '$1dev');
  return out ? `?${out}` : '';
}
// --- end v3 T4 ---------------------------------------------------------------

/** [v4-save] Where a confirmed NEW GAME goes: a new game in flight, keeping only the developer overrides. */
export function newGameSearch(search: string): string {
  const from = new URLSearchParams(search);
  const q = new URLSearchParams();
  for (const k of CARRIED_KEYS) {
    const v = from.get(k);
    if (v !== null) q.set(k, v);
  }
  q.set('new', '1');
  q.set('mode', 'flight');
  const out = q.toString().replace(/(^|&)dev=(?=&|$)/, '$1dev');
  return `?${out}`;
}
