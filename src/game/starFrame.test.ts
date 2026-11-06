/**
 * The star's frame radius is in kilometres.
 *
 * `StarSpec.radius` is in SOLAR radii. Universe handed it to the flight model
 * unconverted as `ParentBody.radius` — which is documented in km — so in the
 * star's frame the altimeter read the distance to a 1 km ball at the origin.
 * The star gap next to it already converted; the frame did not.
 */

import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';

import { AU, SOLAR_RADIUS } from '@/gen/types';
import { FlightModel } from '@/ship/FlightModel';
import { insideStar, starRadiusKm } from './recovery';

describe('starRadiusKm', () => {
  it('Given a star of 1 solar radius, Then its radius is 695,700 km', () => {
    expect(starRadiusKm({ radius: 1 })).toBe(SOLAR_RADIUS);
    expect(starRadiusKm({ radius: 0.12 })).toBeCloseTo(0.12 * SOLAR_RADIUS, 6);
  });

  it('Given no star or a nonsense radius, Then it is 0 (never NaN)', () => {
    expect(starRadiusKm(null)).toBe(0);
    expect(starRadiusKm(undefined)).toBe(0);
    expect(starRadiusKm({ radius: Number.NaN })).toBe(0);
    expect(starRadiusKm({ radius: -2 })).toBe(0);
  });

  it('Given a ship in the star frame at 1 AU, When the frame radius comes from starRadiusKm, Then altitude is above the photosphere', () => {
    const fm = new FlightModel();
    fm.setParent({
      position: new Vector3(),
      velocity: new Vector3(),
      mu: 1.32712440018e11,
      radius: starRadiusKm({ radius: 1 }),
    });
    fm.teleport(new Vector3(AU, 0, 0), new Vector3(0, 0, 29.78));
    fm.update(1 / 60);
    // 1/60 s of orbital motion moves the radius by metres, not kilometres.
    expect(Math.abs(fm.altitude - (AU - SOLAR_RADIUS))).toBeLessThan(1);
    fm.dispose();
  });

  it('Given the same radius, Then the photosphere predicate and the frame agree on where the surface is', () => {
    const r = starRadiusKm({ radius: 1 });
    expect(insideStar(r - 1, r)).toBe(true);
    expect(insideStar(r + 1, r)).toBe(false);
  });
});
