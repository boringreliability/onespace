/**
 * Patched conics: the sphere-of-influence radius, the boundary conversion, and
 * the hysteresis that keeps a ship from flip-flopping across it.
 *
 * These exist because the bug they close was invisible for a whole session. The
 * ship was integrated in the star-centred frame while its *speed* was measured
 * against a nearby body, so a body was the parent of the velocity and not of
 * the position. Every consumer had to add the planet's ~49 km/s by hand, and
 * two of them forgot. The symptom was a ship descending at 20 m/s whose height
 * above ground ROSE — 36.9 km, then 198.7, then 490.4 over a minute — because
 * the planet was leaving at its orbital speed and taking the ground with it.
 *
 * The last three describes in this file are that measurement, at unit scale.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import { generateGalaxy, sampleSystemsNear } from '@/gen/galaxy';
import { generateSystem } from '@/gen/system';
import {
  entersSoi,
  FlightModel,
  leavesSoi,
  SOI_ENTER_FACTOR,
  SOI_LEAVE_FACTOR,
  SOI_MIN_RADII,
  soiRadius,
  type ParentBody,
} from '@/ship/FlightModel';

const MU_SUN = 1.32712440018e11;
const MU_EARTH = 398600.4418;
const MU_MOON = 4902.8;
/** Universe.ts's own conversion: km³/s² per Earth mass. */
const MU_EARTH_PER_MASS = MU_EARTH;

const GALAXY = generateGalaxy(0x51a1);
const SAMPLE_SYSTEMS = sampleSystemsNear(GALAXY, [GALAXY.radiusLy * 0.3, 0, 0], 400, 120)
  .slice(0, 80)
  .map((s) => generateSystem(GALAXY, s));

/** A parent body at rest at the origin, for tests that do not care about motion. */
function still(mu: number, radius?: number): ParentBody {
  return { position: new Vector3(), velocity: new Vector3(), mu, radius };
}

// ---------------------------------------------------------------------------
// 1. The formula
// ---------------------------------------------------------------------------

describe('soiRadius — r_soi = a·(m/M)^(2/5)', () => {
  it('reproduces the two spheres of influence anyone can look up', () => {
    // If the exponent were 1/3 (the Hill sphere, which is the other formula in
    // the same neighbourhood) Earth would come out at 1.5e6 km, not 9.2e5. A
    // test against remembered numbers is the only thing that catches that.
    const earth = soiRadius(1.496e8, MU_EARTH, MU_SUN);
    expect(earth / 9.24e5, `Earth's SOI came out ${(earth / 1e3).toFixed(0)}e3 km`).toBeCloseTo(
      1,
      1,
    );

    const moon = soiRadius(384_400, MU_MOON, MU_EARTH);
    expect(moon / 6.61e4, `the Moon's SOI came out ${(moon / 1e3).toFixed(0)}e3 km`).toBeCloseTo(
      1,
      1,
    );
  });

  it('keeps the boundary well inside the orbit that defines it', () => {
    // A sphere of influence larger than the semi-major axis is not a patched
    // conic, it is a body that swallows its own primary — and it would make the
    // ascent test below unsatisfiable. For every mass ratio a planet can
    // plausibly have, r_soi/a must stay small.
    for (const ratio of [1e-8, 1e-6, 1e-4, 1e-3, 1e-2]) {
      const a = 1e8;
      const r = soiRadius(a, ratio * MU_SUN, MU_SUN);
      expect(r / a, `mass ratio ${ratio} put the SOI at ${(r / a).toFixed(3)}·a`).toBeLessThan(0.16);
    }
  });

  it('grows with mass and with distance, and never inverts', () => {
    // Monotonicity is what makes "the innermost SOI containing the ship wins"
    // a well-defined rule. A non-monotonic radius would let a lighter moon
    // capture a ship out from under a heavier planet at the same distance.
    const light = soiRadius(1e8, 1e-6 * MU_SUN, MU_SUN);
    const heavy = soiRadius(1e8, 1e-4 * MU_SUN, MU_SUN);
    expect(heavy).toBeGreaterThan(light);

    const near = soiRadius(1e7, 1e-6 * MU_SUN, MU_SUN);
    const far = soiRadius(1e9, 1e-6 * MU_SUN, MU_SUN);
    expect(far).toBeGreaterThan(near);
  });

  it('needs its floor: real generated bodies fall inside their own surface', () => {
    // Not a hypothetical. Across 80 generated systems, 12 of 699 bodies have a
    // formula SOI smaller than their own radius — the worst at 0.54 radii. Such
    // a body can never become the ship's parent, so the ground sampler is never
    // installed for it and the hull flies through the surface. The floor is
    // what makes every world in the universe landable; this test is what stops
    // someone deleting it as an unexplained fudge.
    let below = 0;
    let worst = Infinity;
    for (const s of SAMPLE_SYSTEMS) {
      const muStar = MU_SUN * s.stars[0]!.mass;
      for (const p of s.planets) {
        const muP = MU_EARTH_PER_MASS * p.mass;
        const bodies: Array<[number, number, number, number]> = [
          [p.orbit.semiMajorAxis, muP, muStar, p.radius],
          ...p.moons.map(
            (m) =>
              [m.orbit.semiMajorAxis, MU_EARTH_PER_MASS * m.mass, muP, m.radius] as [
                number,
                number,
                number,
                number,
              ],
          ),
        ];
        for (const [a, mu, parentMu, radius] of bodies) {
          const ratio = soiRadius(a, mu, parentMu) / radius;
          if (ratio < 1) below++;
          worst = Math.min(worst, ratio);
        }
      }
    }
    expect(below, 'the floor has become unnecessary — check before removing it').toBeGreaterThan(0);
    expect(worst).toBeLessThan(1);
    // And the floor clears the surface with room to fly a descent.
    expect(SOI_MIN_RADII).toBeGreaterThan(1);
  });

  it('gives the star an unbounded sphere, so nothing can escape the system', () => {
    // The star has no primary. Returning a big finite number instead would put
    // a silent teleport at whatever radius that number happened to be.
    expect(soiRadius(0, MU_SUN, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(leavesSoi(1e30, soiRadius(0, MU_SUN, 0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. The conversion
// ---------------------------------------------------------------------------

describe('rebase — the one place frames are crossed', () => {
  /**
   * A planet at 1 AU doing 49 km/s about a star, and the star itself. These are
   * the two frames the whole bug lived between.
   */
  const star = (): ParentBody => ({
    position: new Vector3(0, 0, 0),
    velocity: new Vector3(0, 0, 0),
    mu: MU_SUN,
    radius: 7e5,
  });
  const planet = (): ParentBody => ({
    position: new Vector3(1.496e8, 0, 0),
    velocity: new Vector3(0, 0, 48.99),
    mu: MU_EARTH,
    radius: 6371,
  });

  it('leaves the ship exactly where it was, in world coordinates', () => {
    const fm = new FlightModel();
    const p = planet();
    fm.setParent(p);
    fm.teleport(new Vector3(0, 7000, 0), new Vector3(7.5, 0, 0));

    const worldBefore = fm.worldPosition.clone();

    fm.rebase(star());

    // Position is invariant under a change of frame. If this drifts, every
    // boundary crossing is a small teleport and orbits will not close.
    expect(fm.worldPosition.distanceTo(worldBefore)).toBeLessThan(1e-6);
    // And the state really did change frame — it is not a no-op.
    expect(fm.position.length()).toBeCloseTo(1.496e8, 0);
  });

  it('adds the parent’s motion on the way out and removes it on the way in', () => {
    // THE MEASUREMENT THAT NAMED THE BUG. A ship handed the body's own velocity
    // is, in the body's frame, stationary — and in the star's frame it is doing
    // the body's 48.99 km/s. Both readings are correct and they are the same
    // state; the old engine could only produce one of them, and reported 48.99
    // where 0.02 was expected.
    const fm = new FlightModel();
    fm.setParent(planet());
    fm.teleport(new Vector3(0, 7000, 0), new Vector3(0, 0, 0));
    expect(fm.speed).toBeLessThan(1e-9);

    fm.rebase(star());
    expect(fm.velocity.length()).toBeCloseTo(48.99, 6);

    fm.rebase(planet());
    expect(fm.velocity.length()).toBeLessThan(1e-9);
  });

  it('round-trips a state vector through both boundaries unchanged', () => {
    // Descend, ascend, descend again. Any asymmetry between the two directions
    // shows up here as a residue, and a residue on every crossing is a slow
    // orbital decay that would take an hour of play to notice.
    const fm = new FlightModel();
    fm.setParent(star());
    fm.teleport(new Vector3(1.496e8, 7000, 0), new Vector3(0.3, 0, 48.99));

    const pos0 = fm.position.clone();
    const vel0 = fm.velocity.clone();

    fm.rebase(planet());
    fm.rebase(star());

    expect(fm.position.distanceTo(pos0)).toBeLessThan(1e-6);
    expect(fm.velocity.distanceTo(vel0)).toBeLessThan(1e-9);
  });

  it('refreshes the readouts it invalidates', () => {
    // Readouts are cached during update(); a transition happens after it. If
    // rebase() left them alone, the HUD would show the previous frame's speed
    // for one frame — a 49 km/s jump in a number the pilot did not change, on
    // the exact frame where a discontinuity is most likely to be believed.
    const fm = new FlightModel();
    fm.setParent(planet());
    fm.teleport(new Vector3(0, 7000, 0), new Vector3(0, 0, 0));
    fm.update(1 / 60);
    expect(fm.speed).toBeLessThan(1e-3);

    fm.rebase(star());
    expect(fm.speed).toBeCloseTo(48.99, 3);
  });

  it('is a no-op when the parent is unchanged', () => {
    // updateShipParent() may reach rebase twice in one frame while falling
    // through from an ascent to a descent. A self-rebase must not double the
    // conversion.
    const fm = new FlightModel();
    const p = planet();
    fm.setParent(p);
    fm.teleport(new Vector3(0, 7000, 0), new Vector3(7.5, 0, 0));
    fm.rebase(p);
    expect(fm.velocity.length()).toBeCloseTo(7.5, 9);
  });

  it('switches which body’s gravity acts', () => {
    // Exactly one source, and it is the parent. Under the star at 1 AU the pull
    // is ~5.9e-6 km/s²; under a planet at 7000 km it is ~8.1e-3 — three orders
    // apart, so a mixed-up parent is not a subtle error.
    const fm = new FlightModel();
    fm.setParent(planet());
    fm.teleport(new Vector3(0, 7000, 0), new Vector3(7.5, 0, 0));
    fm.update(1 / 120);
    const underPlanet = fm.gravityAccel.length();

    fm.rebase(star());
    fm.update(1 / 120);
    const underStar = fm.gravityAccel.length();

    expect(underPlanet).toBeCloseTo(MU_EARTH / 7000 ** 2, 9);
    expect(underStar).toBeCloseTo(MU_SUN / 1.496e8 ** 2, 12);
    expect(underPlanet / underStar).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// 3. The hysteresis
// ---------------------------------------------------------------------------

describe('SOI hysteresis', () => {
  const R = 66_100; // the Moon's, in km — any positive number would do

  it('opens a dead band around the boundary', () => {
    // Entering low and leaving high is the entire mechanism. If the two factors
    // were equal, a ship sitting exactly on the boundary would satisfy both
    // tests and swap parents every frame — and each swap subtracts two large
    // nearly-equal numbers, which is the one operation in this design that
    // costs precision.
    expect(SOI_ENTER_FACTOR).toBeLessThan(SOI_LEAVE_FACTOR);

    // Exactly on the nominal radius: neither test fires.
    expect(entersSoi(R, R)).toBe(false);
    expect(leavesSoi(R, R)).toBe(false);

    // Anywhere in the band: still neither.
    for (const f of [0.985, 0.99, 1.0, 1.01, 1.015]) {
      expect(entersSoi(R * f, R), `entered at ${f}·r_soi`).toBe(false);
      expect(leavesSoi(R * f, R), `left at ${f}·r_soi`).toBe(false);
    }
  });

  it('fires only outside the band, in the right direction', () => {
    expect(entersSoi(R * 0.97, R)).toBe(true);
    expect(leavesSoi(R * 0.97, R)).toBe(false);

    expect(leavesSoi(R * 1.03, R)).toBe(true);
    expect(entersSoi(R * 1.03, R)).toBe(false);
  });

  it('does not flip a ship parked on the boundary, however long it sits there', () => {
    // The failure this guards: a ship in a grazing orbit oscillating by a
    // kilometre either side of r_soi, changing parents 120 times a second.
    let inside = false;
    let flips = 0;
    const amplitude = R * (SOI_LEAVE_FACTOR - SOI_ENTER_FACTOR) * 0.4; // inside the band
    for (let i = 0; i < 2000; i++) {
      const d = R + Math.sin(i * 0.37) * amplitude;
      if (inside && leavesSoi(d, R)) {
        inside = false;
        flips++;
      } else if (!inside && entersSoi(d, R)) {
        inside = true;
        flips++;
      }
    }
    expect(flips, `${flips} parent changes from a ship that never really moved`).toBe(0);
  });

  it('still transitions when the ship genuinely crosses', () => {
    // The band must be dead, not deaf. A ship on a real trajectory through the
    // boundary changes parent exactly once per crossing.
    let inside = false;
    let flips = 0;
    for (let i = 0; i < 2000; i++) {
      const d = R + Math.sin(i * 0.01) * R * 0.2; // ±20%: four crossings
      if (inside && leavesSoi(d, R)) {
        inside = false;
        flips++;
      } else if (!inside && entersSoi(d, R)) {
        inside = true;
        flips++;
      }
    }
    expect(flips).toBeGreaterThan(0);
    expect(flips).toBeLessThan(12);
  });
});

// ---------------------------------------------------------------------------
// 4. What the whole change was for
// ---------------------------------------------------------------------------

/**
 * A world on a realistic 49 km/s orbit about its star. `advance` moves it the
 * way `Universe.updateOrbits()` does — in place, which is exactly why the
 * flight model can hold it by reference and follow it for free.
 *
 * `speed` is a parameter so the same trajectory can be run against a stationary
 * world and a moving one and the two compared. That comparison is the sharpest
 * statement of what this design buys.
 */
function world(
  mu: number,
  radius: number,
  speed = 48.99,
): { frame: ParentBody; advance: (dt: number) => void } {
  const frame: ParentBody = {
    position: new Vector3(1.496e8, 0, 0),
    velocity: new Vector3(0, 0, speed),
    mu,
    radius,
  };
  return {
    frame,
    advance: (dt: number) => frame.position.addScaledVector(frame.velocity, dt),
  };
}

/** A small icy moon: 600 km across, 0.4 m/s² at the surface. */
const MOON_MU = 144;
const MOON_R = 600;

describe('a ship dropped towards a moving world reaches the ground', () => {
  it('touches down from 1.5 km at 20 m/s of descent', () => {
    // THE MEASUREMENT THAT FAILED ALL SESSION. Under the old model the planet
    // departed at 48.99 km/s while the ship stayed put in inertial space, so
    // the height above ground climbed to 36.9 km, then 198.7, then 490.4 over a
    // minute. Here the ship's position IS parent-relative, so the world's
    // motion is not a term in the descent at all.
    //
    // A small body, because "touchdown" is a claim about the impact speed as
    // well as about arriving: 1.5 km of free fall at Earth's 9.8 m/s² arrives
    // at 173 m/s, which this ship's own config calls a crash. At 0.4 m/s² it
    // arrives at 37 m/s and the landing gear holds. The Earth-gravity case is
    // the test below.
    const w = world(MOON_MU, MOON_R);

    const fm = new FlightModel();
    fm.setParent(w.frame);
    fm.setGroundSampler((rel) => rel.length() - MOON_R);
    // Straight down at 20 m/s from 1.5 km with no horizontal motion — the
    // simplest descent there is, and the one whose altitude was rising.
    fm.teleport(new Vector3(0, MOON_R + 1.5, 0), new Vector3(0, -0.02, 0), new Quaternion());

    let touchdown: { vertical: number } | null = null;
    const off = bus.on('ship:touchdown', (e) => {
      touchdown = { vertical: e.vertical };
    });

    const h = 1 / 60;
    const altitudes: number[] = [];
    for (let i = 0; i < 60 * 300 && touchdown === null; i++) {
      w.advance(h); // the world keeps going, as it does in the game
      if (i % 600 === 0) altitudes.push(fm.altitude);
      fm.update(h);
    }
    off();

    // The diagnostic that mattered: altitude falls, monotonically, from the
    // first sample. The old failure was visible in exactly this array.
    expect(
      altitudes.every((a, i) => i === 0 || a < altitudes[i - 1]!),
      `altitude trace km: ${altitudes.map((a) => a.toFixed(2)).join(' → ')}`,
    ).toBe(true);

    expect(touchdown, 'no ship:touchdown was ever emitted').not.toBeNull();
    expect(fm.grounded).toBe(true);
    expect(Math.abs(fm.altitude)).toBeLessThan(0.01);
    // Its world travelled thousands of km during the descent. The ship went
    // with it without a single line of code saying so.
    expect(w.frame.position.z).toBeGreaterThan(1000);
  });

  it('reaches the ground at full planetary gravity too', () => {
    // Same descent onto an Earth-mass world. It arrives at 173 m/s and the hull
    // fails, which is correct — the property under test is that the ground is
    // reached at all. Under the old model this was the case that produced
    // "height above ground rises while radial velocity is negative".
    const w = world(MU_EARTH, 6371);
    const fm = new FlightModel();
    fm.setParent(w.frame);
    fm.setGroundSampler((rel) => rel.length() - 6371);
    fm.teleport(new Vector3(0, 6371 + 1.5, 0), new Vector3(0, -0.02, 0), new Quaternion());

    let arrived = false;
    const offA = bus.on('ship:touchdown', () => {
      arrived = true;
    });
    const offB = bus.on('ship:crashed', () => {
      arrived = true;
    });

    const h = 1 / 60;
    for (let i = 0; i < 60 * 120 && !arrived; i++) {
      w.advance(h);
      fm.update(h);
    }
    offA();
    offB();

    expect(arrived, `still airborne at ${fm.altitude.toFixed(1)} km`).toBe(true);
    expect(Math.abs(fm.altitude)).toBeLessThan(0.01);
  });

  it('reads its own descent rate, not its world’s orbital speed', () => {
    // `relativeSpeed` used to sit at 48.99 km/s for a ship that had just been
    // handed its body's velocity — the last open question in the README. There
    // is now only one speed and it is this one. 20 m/s is 0.02 km/s.
    const w = world(MU_EARTH, 6371);
    const fm = new FlightModel();
    fm.setParent(w.frame);
    fm.teleport(new Vector3(0, 6371 + 1.5, 0), new Vector3(0, -0.02, 0));

    w.advance(1);
    fm.update(1 / 60);

    expect(fm.speed).toBeCloseTo(0.02, 3);
    expect(fm.verticalSpeed).toBeLessThan(0);
  });
});

describe('a coasting ship holds its altitude', () => {
  /** Fly a circular orbit for `seconds` about a world moving at `speed`. */
  function coast(speed: number, seconds: number): { radii: number[]; worldEnd: Vector3 } {
    const w = world(MU_EARTH, 6371, speed);
    const fm = new FlightModel();
    fm.setParent(w.frame);
    const r = 6771;
    const v = fm.orbitalVelocityAt(new Vector3(r, 0, 0));
    fm.teleport(new Vector3(r, 0, 0), v);

    const h = 1 / 60;
    const radii: number[] = [];
    for (let i = 0; i < seconds * 60; i++) {
      w.advance(h);
      fm.update(h);
      radii.push(fm.position.length());
    }
    return { radii, worldEnd: w.frame.position.clone() };
  }

  it('is completely unaffected by how fast its world is travelling', () => {
    // The sharpest form of the regression guard, and the one that would have
    // caught the original bug instantly: the parent's motion must not enter the
    // relative dynamics AT ALL. Not "to within a tolerance" — identically.
    // Anything that leaks the frame in shows up here as a non-zero difference.
    const still = coast(0, 60);
    const moving = coast(48.99, 60);

    let worst = 0;
    for (let i = 0; i < still.radii.length; i++) {
      worst = Math.max(worst, Math.abs(still.radii[i]! - moving.radii[i]!));
    }
    expect(worst, `${(worst * 1e6).toFixed(3)} mm of difference`).toBeLessThan(1e-9);
    // ...and the moving one really did travel 2,939 km while the still one sat.
    expect(moving.worldEnd.z - still.worldEnd.z).toBeGreaterThan(2900);
  });

  it('keeps its radius bounded over five minutes', () => {
    // Acceptance §1. 5 minutes is 5% of this orbit's 92-minute period, so what
    // is measured is the 120 Hz discretisation, not a decay: the excursion is
    // ~11 m on 6771 km, 1.6 parts per million. The failure this replaces moved
    // the ship 490 km in one minute.
    const { radii } = coast(48.99, 300);
    const min = Math.min(...radii);
    const max = Math.max(...radii);
    expect(
      (max - min) / 6771,
      `radius wandered ${((max - min) * 1000).toFixed(2)} m out of 6771 km`,
    ).toBeLessThan(1e-5);
  });

  it('parks motionless above the same terrain indefinitely', () => {
    // Acceptance §2: a parent-relative position with zero relative velocity is
    // a ship sitting on the ground, and it must stay there while its world
    // travels thousands of kilometres.
    const w = world(MU_EARTH, 6371);
    const fm = new FlightModel();
    fm.setParent(w.frame);
    fm.setGroundSampler((rel) => rel.length() - 6371);
    fm.teleport(new Vector3(0, 6371, 0), new Vector3(0, 0, 0));

    const h = 1 / 60;
    for (let i = 0; i < 60 * 60; i++) {
      w.advance(h);
      fm.update(h);
    }

    expect(Math.abs(fm.altitude), `altitude drifted to ${fm.altitude}`).toBeLessThan(0.01);
    expect(fm.grounded).toBe(true);
    expect(w.frame.position.z).toBeGreaterThan(2900); // the world really did move
  });
});
