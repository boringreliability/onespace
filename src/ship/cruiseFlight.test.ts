/**
 * The cruise drive against the real integrator.
 *
 * `cruise.test.ts` proves the speed law is safe. This proves the *flight model*
 * honours it — that the ceiling is applied hard, every substep, with no easing
 * between the drive's number and the ship's speed. That gap is the only place
 * the design can fail silently: a lagged ceiling looks identical at every
 * moment except the one where the ship ends up inside a planet.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { DEFAULT_SHIP_CONFIG, FlightModel } from './FlightModel';
import { CRUISE_DEFAULTS, CruiseDrive, cruiseCapKmS } from './CruiseDrive';

const BODY_RADIUS = 10_000;
const START_GAP = 1e8;

/** A ship at rest, nose pointed straight down the -X axis at a body at the origin. */
function ship(): FlightModel {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  // No gravity: mu 0. The cruise path suspends gravity anyway, and this keeps
  // the test measuring one thing.
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0, radius: BODY_RADIUS });
  const pos = new Vector3(BODY_RADIUS + START_GAP, 0, 0);
  // The hull's nose is -Z; aim it at the origin from +X.
  const look = new Quaternion().setFromUnitVectors(
    new Vector3(0, 0, -1),
    new Vector3(-1, 0, 0),
  );
  fm.teleport(pos, new Vector3(), look);
  return fm;
}

/** Full throttle, no boost, no brake. */
function fullAhead(fm: FlightModel): void {
  fm.command.throttle = 1;
  fm.command.boost = false;
  fm.command.brake = false;
  fm.command.pitch = 0;
  fm.command.yaw = 0;
  fm.command.roll = 0;
}

describe('flying under cruise', () => {
  it('actually crosses the distance, which sublight cannot', () => {
    const fm = ship();
    fullAhead(fm);
    const drive = new CruiseDrive();
    const h = 1 / 60;

    for (let i = 0; i < 60 * 120; i++) {
      const gap = fm.position.length() - BODY_RADIUS;
      drive.update(h, {
        requested: true,
        clearanceKm: gap,
        grounded: false,
        atmosphericDensity: 0,
      });
      fm.setCruise(drive.engaged ? drive.capKmS : null);
      fm.update(h);
      if (drive.phase === 'idle' && i > 60) break;
    }

    const gap = fm.position.length() - BODY_RADIUS;
    // It should have arrived at the drop threshold rather than still be out in
    // the dark. Sublight at 60 km/s would have covered 0.4% of this in 120 s.
    expect(gap).toBeLessThan(CRUISE_DEFAULTS.engageClearanceKm);
  });

  it('never carries the ship inside the body, at any frame rate', () => {
    // The whole point. Run it at three timesteps, including a bad one.
    //
    // Measured only WHILE THE DRIVE IS CARRYING THE SHIP. Once it lets go the
    // ship is on ordinary sublight flight, and a pilot who keeps the throttle
    // open and the nose down will hit the planet — as they should. The drive's
    // contract is to hand over at a safe distance and a sublight speed, not to
    // fly for you afterwards.
    for (const h of [1 / 120, 1 / 60, 1 / 30]) {
      const fm = ship();
      fullAhead(fm);
      const drive = new CruiseDrive();
      let closestUnderDrive = Infinity;
      let gapAtHandover = Infinity;

      for (let i = 0; i < Math.ceil(300 / h); i++) {
        const gap = fm.position.length() - BODY_RADIUS;
        const wasEngaged = drive.engaged;
        if (wasEngaged) closestUnderDrive = Math.min(closestUnderDrive, gap);
        drive.update(h, {
          requested: true,
          clearanceKm: gap,
          grounded: false,
          atmosphericDensity: 0,
        });
        if (wasEngaged && !drive.engaged) gapAtHandover = gap;
        fm.setCruise(drive.engaged ? drive.capKmS : null);
        fm.update(h);
      }

      // It got close enough to be worth arriving at...
      expect(closestUnderDrive).toBeLessThan(CRUISE_DEFAULTS.engageClearanceKm);
      // ...without ever scraping the surface...
      expect(closestUnderDrive).toBeGreaterThan(CRUISE_DEFAULTS.dropClearanceKm * 0.5);
      // ...and let go with room to spare.
      expect(gapAtHandover).toBeGreaterThan(CRUISE_DEFAULTS.dropClearanceKm * 0.5);
    }
  });

  it('hands back a sublight state vector', () => {
    // What the orbital machinery inherits has to be an ordinary velocity, or
    // the first frame after the drop flings the ship out of the system.
    const fm = ship();
    fullAhead(fm);
    const drive = new CruiseDrive();
    const h = 1 / 60;

    for (let i = 0; i < 60 * 300; i++) {
      const gap = fm.position.length() - BODY_RADIUS;
      drive.update(h, {
        requested: true,
        clearanceKm: gap,
        grounded: false,
        atmosphericDensity: 0,
      });
      fm.setCruise(drive.engaged ? drive.capKmS : null);
      fm.update(h);
      if (i > 60 && drive.phase === 'idle') break;
    }

    expect(fm.cruising).toBe(false);
    expect(fm.velocity.length()).toBeLessThanOrEqual(
      CRUISE_DEFAULTS.exitSpeedKmS * 1.05,
    );
  });

  it('obeys a ceiling that collapses under it', () => {
    // A lagged clamp would show up here and nowhere else: hold the ship at a
    // high ceiling, then drop the ceiling by four orders of magnitude and
    // check the very next step is already slow.
    const fm = ship();
    fullAhead(fm);
    fm.setCruise(cruiseCapKmS(1e8));
    for (let i = 0; i < 600; i++) fm.update(1 / 60);
    expect(fm.velocity.length()).toBeGreaterThan(1e6);

    fm.setCruise(cruiseCapKmS(1e4));
    fm.update(1 / 60);
    // Within a rounding error of the ceiling, not merely near it: the clamp is
    // an assignment, so anything above this is a lag that should not exist.
    expect(fm.velocity.length()).toBeLessThanOrEqual(cruiseCapKmS(1e4) * (1 + 1e-9));
  });

  it('leaves the throttle in charge of how fast you close', () => {
    const fm = ship();
    fullAhead(fm);
    fm.command.throttle = 0.25;
    fm.setCruise(cruiseCapKmS(1e8));
    for (let i = 0; i < 900; i++) fm.update(1 / 60);
    const quarter = fm.velocity.length();

    const fm2 = ship();
    fullAhead(fm2);
    fm2.setCruise(cruiseCapKmS(1e8));
    for (let i = 0; i < 900; i++) fm2.update(1 / 60);

    expect(quarter).toBeLessThan(fm2.velocity.length() * 0.5);
  });

  it('does not report g-force for a drive that does not push the crew', () => {
    const fm = ship();
    fullAhead(fm);
    fm.setCruise(cruiseCapKmS(1e8));
    for (let i = 0; i < 600; i++) fm.update(1 / 60);
    expect(fm.gForce).toBeLessThan(0.05);
  });

  it('returns to ordinary flight when the ceiling is removed', () => {
    const fm = ship();
    fullAhead(fm);
    fm.setCruise(cruiseCapKmS(1e6));
    for (let i = 0; i < 300; i++) fm.update(1 / 60);
    expect(fm.cruising).toBe(true);

    fm.setCruise(null);
    fm.update(1 / 60);
    expect(fm.cruising).toBe(false);
    expect(Number.isFinite(fm.velocity.length())).toBe(true);
    expect(Number.isFinite(fm.position.length())).toBe(true);
  });
});
