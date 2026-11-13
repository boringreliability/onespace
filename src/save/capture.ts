/**
 * A save from the running game, and back (v4 sub-plan 3, Task 3).
 *
 * `buildSave` reads the live world into a SaveV1 and changes nothing in it
 * but the journal (drained into the save). `applySave` puts one back.
 *
 *  - Player and world are separate (P2); both clocks ride on everything (P5).
 *  - Cruise is saved as having dropped out at the nearest stable point
 *    (§5.2): a circular orbit at the ship's current radius about the DEEPEST
 *    body whose SOI holds it — moon, else its planet, else the star (R23) —
 *    PROGRADE: in the sense of that body's own children, else of its own
 *    orbit (R24). The live ship keeps cruising — a save reads, it does not act.
 *  - The books (R7): Cruise's pending leg is announced first, then the
 *    interval's unannounced thrust is booked, so the tank always balances.
 *  - The log is read with `exportState()` NOW (the sink's last write can be
 *    stale: mission time moves without writing).
 *  - applySave restores the Universe FIRST and imports the log AFTER (R6):
 *    the restore's `system:entered` logs an extra ARRIVED visit, which the
 *    import then overwrites. `grounded` is honoured only with a parent; a hull
 *    without a tank skips the tank.
 */

import { Vector3 } from 'three';

import type { ShipLog } from '@/game/Log';
import type { Universe } from '@/game/Universe';
import type { WorldState } from '@/game/worldState';
import { circularOrbitState, progradeAttitude, starRadiusKm } from '@/game/recovery';
import { START_FILL } from '@/ship/propellant';
import { compactEntries, MAX_ACTIONS, type ActionJournal } from './actionJournal';
import { CURRENT_FORMAT, type SaveV1 } from './schema';

/** The minimal surface a save needs of the running game. */
export interface SaveWorld {
  readonly universe: Universe;
  readonly worldState: WorldState;
  readonly shipLog: ShipLog;
  readonly emergency: { timesUsed: number };
  readonly journal: ActionJournal;
  /**
   * Cruise: its pending leg is announced before the tank is counted (R7);
   * a load resets it (R9).
   */
  readonly cruise?: { flushLeg(): void; reset?(): void };
  /** The pilot's lever: a load sets it to 0 (R9). */
  readonly input?: { setThrottle(v: number): void };
}

type Vec3 = [number, number, number];
type Flight = SaveV1['player']['flight'];

const tuple = (v: Vector3): Vec3 => [v.x, v.y, v.z];

type Body = ReturnType<Universe['allBodies']>[number];

/**
 * A circular orbit at the ship's current radius about a centre (§5.2),
 * turning the same way as `sense` (an angular momentum; zero: either way).
 */
function circularAt(
  fm: Universe['flight'],
  centre: Vector3,
  radiusKm: number,
  mu: number,
  parentId: string | null,
  sense: Vector3,
): { parentId: string | null; flight: Flight } {
  // R21: the ship at the stamped clock, not the substep carry behind it.
  const radial = new Vector3().subVectors(fm.renderWorldPosition, centre);
  const r = radial.length();
  const state = circularOrbitState(radial, radiusKm, mu, radiusKm > 0 && r > 0 ? r / radiusKm - 1 : undefined);
  // R24: prograde. circularOrbitState turns about +Y (UP × r̂); against the
  // system's sense, turn it round — the nose (roof still radial) with it.
  let q = state.orientation;
  if (new Vector3().crossVectors(state.position, state.velocity).dot(sense) < 0) {
    state.velocity.negate();
    q = progradeAttitude(state.velocity, state.position.clone().normalize());
  }
  return {
    parentId,
    flight: {
      position: tuple(state.position),
      velocity: tuple(state.velocity),
      orientation: [q.x, q.y, q.z, q.w],
      grounded: false,
      flightAssist: fm.flightAssist,
    },
  };
}

const ORIGIN = new Vector3();

/** Σ r × v of `bodies` about a centre at `centre` moving at `centreVel`. */
function angularMomentum(bodies: readonly Body[], centre: Vector3, centreVel: Vector3): Vector3 {
  const sum = new Vector3();
  const r = new Vector3();
  const v = new Vector3();
  for (const b of bodies) {
    r.subVectors(b.world, centre);
    v.subVectors(b.worldVelocity, centreVel);
    sum.add(new Vector3().crossVectors(r, v));
  }
  return sum;
}

/**
 * R24: the sense an orbit about `body` (null: the star) turns — its own
 * children's (the planets' for the star, a planet's moons'), else, without
 * children, the body's own orbit about its parent.
 */
function senseAbout(u: Universe, body: Body | null): Vector3 {
  const kids = u.allBodies().filter((b) => b.parent === body);
  if (body === null) return angularMomentum(kids, ORIGIN, ORIGIN);
  if (kids.length > 0) return angularMomentum(kids, body.world, body.worldVelocity);
  const p = body.parent;
  return angularMomentum([body], p ? p.world : ORIGIN, p ? p.worldVelocity : ORIGIN);
}

/**
 * R23: the deepest body whose SOI holds `at` (world, km): from the star down
 * to the child that holds it, and on — or null (the star). A strict
 * `< soiRadius` agrees with the Universe's hysteresis (enter < 0.98, leave
 * > 1.02): a ship restored there is neither entered into a child nor lifted
 * out on its first SOI check.
 */
function deepestSoi(u: Universe, at: Vector3): Body | null {
  const all = u.allBodies();
  let body: Body | null = null;
  for (;;) {
    const next = all.find((b) => b.parent === body && b.soiRadius > 0 && at.distanceTo(b.world) < b.soiRadius);
    if (!next) return body;
    body = next;
  }
}

/** Where the player is: parent-relative, or — cruising — a circular orbit. */
function playerPlace(u: Universe): { parentId: string | null; flight: Flight } {
  const fm = u.flight;
  if (fm.cruising) {
    // R23: about the deepest body whose SOI holds the ship at the stamped
    // clock. An orbit outside a body's SOI is not that body's to keep (M-4),
    // and the nearest body is not always the one that holds the ship (a moon
    // can be nearer than its planet). Else about the star.
    const body = deepestSoi(u, fm.renderWorldPosition);
    if (body) {
      return circularAt(fm, body.world, body.spec.radius, body.frame.mu, body.spec.id, senseAbout(u, body));
    }
    const star = u.system.stars[0];
    return circularAt(fm, ORIGIN, star ? starRadiusKm(star) : 0, u.starMu, null, senseAbout(u, null));
  }
  const parentId = u.shipParent ? u.shipParent.spec.id : null;
  const grounded = parentId !== null && fm.grounded;
  // R21/R22: the integrated state trails the clock by `timeBehindS`; the save
  // is stamped with the clock, so the ship goes in where the clock has it
  // (position, and orientation by its spin). A grounded ship is not
  // extrapolated: it rides the ground, its velocity is surface-relative.
  const at = grounded ? fm.position : fm.renderPosition;
  const q = grounded ? fm.orientation : fm.renderOrientation;
  return {
    parentId,
    flight: {
      position: tuple(at),
      velocity: tuple(fm.velocity),
      orientation: [q.x, q.y, q.z, q.w],
      grounded,
      flightAssist: fm.flightAssist,
    },
  };
}

export function buildSave(w: SaveWorld, prev: SaveV1 | null): SaveV1 {
  const u = w.universe;
  const tank = u.flight.propellant;

  // The books: announce cruise's pending leg, then book what is left as thrust.
  w.cruise?.flushLeg();
  w.journal.settleThrust(tank ? tank.massKg : null, tank ? tank.baseCapacityKg * START_FILL : 0);
  const actions = compactEntries([...(prev?.actions ?? []), ...w.journal.drain()], MAX_ACTIONS);

  const universeId = `${u.galaxy.id}:v1`;
  const sys = u.system;
  const { parentId, flight } = playerPlace(u);
  const log = w.shipLog.exportState();

  return {
    format: CURRENT_FORMAT,
    saveId: prev?.saveId ?? crypto.randomUUID(),
    universeId,
    revision: (prev?.revision ?? 0) + 1,
    savedAt: { wallMs: Date.now(), orbitSeconds: u.orbitSeconds },
    player: {
      system: { id: sys.id, seed: sys.seed, name: sys.name, positionLy: [sys.position[0], sys.position[1], sys.position[2]] },
      parentId,
      flight,
    },
    ship: {
      propellant: tank ? tank.snapshot() : { massKg: 0, capacityLossFrac: 0 },
      cargo: { ...u.cargo.snapshot() },
      emergencyTimesUsed: w.emergency.timesUsed,
    },
    log: { time: log.time, entries: log.entries.map((e) => ({ ...e, body: [...e.body] })) },
    world: { universeId, entries: w.worldState.entries().map((e) => ({ ...e })) },
    actions,
  };
}

/**
 * Put a save back into the running game. False — and nothing changed — when
 * its system (or parent body) cannot be found.
 */
export function applySave(w: SaveWorld, s: SaveV1): boolean {
  const u = w.universe;
  const p = s.player;
  const ok = u.restoreState({
    system: p.system,
    orbitSeconds: s.savedAt.orbitSeconds,
    parentId: p.parentId,
    flight: {
      position: p.flight.position,
      velocity: p.flight.velocity,
      orientation: p.flight.orientation,
      // A grounded ship needs ground: without a parent it would hang frozen.
      grounded: p.parentId !== null && p.flight.grounded,
    },
    flightAssist: p.flight.flightAssist,
  });
  if (!ok) return false;

  // R9: whatever the replaced timeline had running stops, silently — the
  // drive (no leg announced, no spool refunded) and the engine (lever and
  // spool), so the loaded ship burns nothing it does not log.
  w.cruise?.reset?.();
  u.flight.cutThrottle();
  w.input?.setThrottle(0);

  const tank = u.flight.propellant;
  if (tank) tank.restore(s.ship.propellant);
  u.cargo.restore(s.ship.cargo);
  w.emergency.timesUsed = s.ship.emergencyTimesUsed;
  w.worldState.restore(s.world.entries);
  // R6: after the Universe restore, so its ARRIVED visit is overwritten.
  w.shipLog.importState(s.log);
  w.journal.restore(s.actions);
  w.journal.setBaseline(tank ? tank.massKg : null);
  return true;
}
