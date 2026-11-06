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
    out.staleGeneration =
      gen !== null && /^\d{1,6}$/.test(gen) ? Number(gen) < SHIP_GENERATION_VERSION : false;
  }

  const universe = hex(q.get('seed'));
  if (universe !== undefined) out.universeSeed = universe;

  const shot = q.get('shot');
  if (shot !== null && SHOT.test(shot)) out.shot = shot;

  if (q.has('dev')) out.dev = true;
  return out;
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
