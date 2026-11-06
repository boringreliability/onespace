/**
 * Flight instruments — the maths behind the new HUD readouts.
 *
 * GAMEPLAY F1: no prograde marker, so a newtonian ship's drift was invisible.
 * F2: no vertical speed and no time-to-impact, and on the ground ALT read
 * −13.8 km because it measured against the sphere, not the terrain.
 * F9: the title named the moon while the ship was at the planet.
 * F11: VEL and ALT could be about different bodies, and ALT never said which.
 */

import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';

import {
  ALT_RANGE_RADII,
  LEVEL_VS_KMS,
  MARKER_MIN_SPEED_KMS,
  locationLabel,
  pickAltitude,
  projectToScreen,
  velocityMarkers,
  verticalReadout,
  type ScreenPoint,
} from './flightAids';

// ---------------------------------------------------------------------------
// VSI and time-to-impact
// ---------------------------------------------------------------------------

describe('verticalReadout', () => {
  it('Given a descent of 50 m/s at 10 km, Then VSI is −0.05 km/s and impact is 200 s away', () => {
    const r = verticalReadout(-0.05, 10, false);
    expect(r.vsiKmS).toBeCloseTo(-0.05, 9);
    expect(r.ttiS).toBeCloseTo(200, 9);
  });

  it('Given the ship is climbing, Then VSI is positive and there is no time-to-impact', () => {
    const r = verticalReadout(0.12, 10, false);
    expect(r.vsiKmS).toBeCloseTo(0.12, 9);
    expect(r.ttiS).toBeNull();
  });

  it('Given the ship is on the ground, Then VSI reads zero and there is no time-to-impact', () => {
    const r = verticalReadout(-0.003, 0.001, true);
    expect(r.vsiKmS).toBe(0);
    expect(r.ttiS).toBeNull();
  });

  it('Given a sink slower than the level threshold, Then there is no time-to-impact', () => {
    expect(verticalReadout(-LEVEL_VS_KMS * 0.5, 10, false).ttiS).toBeNull();
  });

  it('Given no altitude reference (deep space), Then VSI is still reported but there is no time-to-impact', () => {
    const r = verticalReadout(-0.4, null, false);
    expect(r.vsiKmS).toBeCloseTo(-0.4, 9);
    expect(r.ttiS).toBeNull();
  });

  it('Given a descent with the terrain already at or above the hull, Then impact is now (0 s), never negative', () => {
    expect(verticalReadout(-0.05, -0.2, false).ttiS).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Altitude: which body, and against what
// ---------------------------------------------------------------------------

describe('pickAltitude', () => {
  it('Given a ground sampler under the parent, When landed where the sphere says −13.8 km, Then ALT is the terrain altitude and names the parent', () => {
    const r = pickAltitude({
      parentName: 'Fyss',
      parentAltKm: 0.004, // flight.altitude — terrain, since a sampler is installed
      parentRadiusKm: 6000,
      nearestName: 'Fyss',
      nearestAltKm: -13.8, // universe.nearestAltitudeKm — the sphere
    });
    expect(r).toEqual({ altitudeKm: 0.004, bodyName: 'Fyss' });
  });

  it('Given a moon is nearer but the ship orbits the planet, Then ALT is the parent planet, so VEL and ALT agree on the body', () => {
    const r = pickAltitude({
      parentName: 'Fyss',
      parentAltKm: 4344,
      parentRadiusKm: 6000,
      nearestName: 'Fyss I',
      nearestAltKm: 3000,
    });
    expect(r).toEqual({ altitudeKm: 4344, bodyName: 'Fyss' });
  });

  it('Given the ship is in the star frame (no parent body), Then ALT falls back to the nearest body and names it', () => {
    const r = pickAltitude({
      parentName: null,
      parentAltKm: Number.POSITIVE_INFINITY,
      parentRadiusKm: 0,
      nearestName: 'Vhessvaem',
      nearestAltKm: 90_000,
    });
    expect(r).toEqual({ altitudeKm: 90_000, bodyName: 'Vhessvaem' });
  });

  it('Given the parent is further than the altimeter range, Then ALT falls back to the nearest body', () => {
    const r = pickAltitude({
      parentName: 'Fyss',
      parentAltKm: 6000 * (ALT_RANGE_RADII + 1),
      parentRadiusKm: 6000,
      nearestName: 'Fyss I',
      nearestAltKm: 2000,
    });
    expect(r).toEqual({ altitudeKm: 2000, bodyName: 'Fyss I' });
  });

  it('Given nothing is in range, Then there is no altitude', () => {
    const r = pickAltitude({
      parentName: null,
      parentAltKm: Number.POSITIVE_INFINITY,
      parentRadiusKm: 0,
      nearestName: null,
      nearestAltKm: null,
    });
    expect(r).toBeNull();
  });
});

describe('locationLabel — the title line', () => {
  it('Given the ship is parented to Fyss (whose moon was streamed in last), Then the title is "Fyss", not the moon', () => {
    expect(locationLabel('Remit 31', 'Fyss')).toBe('Fyss');
  });

  it('Given the ship is in the star frame, Then the title is the system name', () => {
    expect(locationLabel('Remit 31', null)).toBe('Remit 31');
  });
});

// ---------------------------------------------------------------------------
// Screen projection and the velocity markers
// ---------------------------------------------------------------------------

const W = 1600;
const H = 900;

function camera(): PerspectiveCamera {
  const c = new PerspectiveCamera(60, W / H, 0.01, 1e9);
  c.position.set(0, 0, 0);
  c.lookAt(0, 0, -1);
  c.updateMatrixWorld();
  return c;
}

const pt = (): ScreenPoint => ({ x: 0, y: 0, behind: false });

describe('projectToScreen', () => {
  it('Given a direction straight down the camera axis, Then it lands at the centre of the screen and is not behind', () => {
    const out = projectToScreen(0, 0, -1, 0, camera(), W, H, pt());
    expect(out.x).toBeCloseTo(W / 2, 6);
    expect(out.y).toBeCloseTo(H / 2, 6);
    expect(out.behind).toBe(false);
  });

  it('Given a direction to the right of the view axis, Then it is right of centre', () => {
    expect(projectToScreen(0.3, 0, -1, 0, camera(), W, H, pt()).x).toBeGreaterThan(W / 2);
  });

  it('Given a direction above the view axis, Then it is above centre (CSS y grows downward)', () => {
    expect(projectToScreen(0, 0.3, -1, 0, camera(), W, H, pt()).y).toBeLessThan(H / 2);
  });

  it('Given a direction behind the camera, Then it is flagged behind', () => {
    expect(projectToScreen(0, 0, 1, 0, camera(), W, H, pt()).behind).toBe(true);
  });

  it('Given a direction, Then the camera position does not move it (a direction is at infinity)', () => {
    const c = camera();
    c.position.set(5e6, -3e5, 2e4);
    c.updateMatrixWorld();
    const out = projectToScreen(0, 0, -1, 0, c, W, H, pt());
    expect(out.x).toBeCloseTo(W / 2, 3);
    expect(out.y).toBeCloseTo(H / 2, 3);
  });

  it('Given a point ahead of a translated camera, Then it projects relative to the camera', () => {
    const c = camera();
    c.position.set(100, 0, 0);
    c.updateMatrixWorld();
    const centre = projectToScreen(100, 0, -50, 1, c, W, H, pt());
    expect(centre.x).toBeCloseTo(W / 2, 6);
    const left = projectToScreen(90, 0, -50, 1, c, W, H, pt());
    expect(left.x).toBeLessThan(W / 2);
  });

  it('Given an output object, Then it is written and returned (no allocation per call)', () => {
    const out = pt();
    expect(projectToScreen(0, 0, -1, 0, camera(), W, H, out)).toBe(out);
  });
});

describe('velocityMarkers', () => {
  it('Given a parent-relative velocity, Then prograde is its unit direction and retrograde the exact opposite', () => {
    const pro = new Vector3();
    const retro = new Vector3();
    expect(velocityMarkers(new Vector3(0, 3, 4), pro, retro)).toBe(true);
    expect(pro.x).toBeCloseTo(0, 9);
    expect(pro.y).toBeCloseTo(0.6, 9);
    expect(pro.z).toBeCloseTo(0.8, 9);
    expect(retro.clone().add(pro).length()).toBeCloseTo(0, 9);
  });

  it('Given a speed below the marker threshold (parked), Then there are no markers', () => {
    const v = new Vector3(MARKER_MIN_SPEED_KMS * 0.5, 0, 0);
    expect(velocityMarkers(v, new Vector3(), new Vector3())).toBe(false);
  });
});
