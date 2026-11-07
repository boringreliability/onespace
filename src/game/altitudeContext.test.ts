/**
 * ALT and VEL say what they measure (v3 PLAN F / H1; audit moon-sheet.png).
 *
 * v2 (GAMEPLAY F11) made ALT prefer the SOI parent so VEL and ALT talk about
 * the same world, and that stays. What was missing: next to a moon the glass
 * read "ALT FYSS 8 356 km" with the moon filling the view and nothing saying
 * how far its surface was; and in the star frame ALT fell back to the nearest
 * body while VEL silently measured against the star.
 *
 * v3: ALT keeps its v2 choice; VEL names its frame whenever that frame is not
 * the body ALT names; and a body nearer than the ALT body gets a proximity
 * line of its own. Vertical speed / impact only run against the ALT body when
 * it is also VEL's frame (the only case where "vertical" means anything).
 */

import { describe, expect, it } from 'vitest';

import { ALT_RANGE_RADII, altitudeContext, verticalShown } from './flightAids';

describe('altitudeContext', () => {
  it('Given orbit around Fyss with Fyss nearest, Then ALT is Fyss, VEL needs no frame label, there is no proximity line, and V/S applies', () => {
    const r = altitudeContext(
      { parentName: 'Fyss', parentAltKm: 4344, parentRadiusKm: 6000, nearestName: 'Fyss', nearestAltKm: 4344 },
      'Fyss',
    );
    expect(r.alt).toEqual({ altitudeKm: 4344, bodyName: 'Fyss' });
    expect(r.velFrame).toBeNull();
    expect(r.proximity).toBeNull();
    expect(r.verticalApplies).toBe(true);
  });

  it('Given orbit around Fyss with its moon Fyss I nearer (3 000 km vs 8 356 km), Then ALT stays Fyss and a proximity line names Fyss I at 3 000 km', () => {
    const r = altitudeContext(
      { parentName: 'Fyss', parentAltKm: 8356, parentRadiusKm: 6000, nearestName: 'Fyss I', nearestAltKm: 3000 },
      'Fyss',
    );
    expect(r.alt).toEqual({ altitudeKm: 8356, bodyName: 'Fyss' });
    expect(r.proximity).toEqual({ bodyName: 'Fyss I', altitudeKm: 3000 });
    expect(r.velFrame).toBeNull();
    expect(r.verticalApplies).toBe(true);
  });

  it('Given the nearest body is a moon FARTHER than the parent surface, Then there is no proximity line', () => {
    const r = altitudeContext(
      { parentName: 'Fyss', parentAltKm: 500, parentRadiusKm: 6000, nearestName: 'Fyss I', nearestAltKm: 90_000 },
      'Fyss',
    );
    expect(r.proximity).toBeNull();
  });

  it('Given the star frame and a planet in altimeter range, Then ALT names the planet, VEL names the star it is measured against, and V/S does not apply', () => {
    const r = altitudeContext(
      { parentName: null, parentAltKm: Number.POSITIVE_INFINITY, parentRadiusKm: 0, nearestName: 'Vhessvaem', nearestAltKm: 90_000 },
      'Remit 31',
    );
    expect(r.alt).toEqual({ altitudeKm: 90_000, bodyName: 'Vhessvaem' });
    expect(r.velFrame).toBe('Remit 31');
    expect(r.verticalApplies).toBe(false);
  });

  it('Given the parent is beyond altimeter range and a moon is in range, Then ALT is the moon and VEL names the parent it is still measured against', () => {
    const r = altitudeContext(
      { parentName: 'Fyss', parentAltKm: 6000 * (ALT_RANGE_RADII + 1), parentRadiusKm: 6000, nearestName: 'Fyss I', nearestAltKm: 2000 },
      'Fyss',
    );
    expect(r.alt).toEqual({ altitudeKm: 2000, bodyName: 'Fyss I' });
    expect(r.velFrame).toBe('Fyss');
    expect(r.proximity).toBeNull();
    expect(r.verticalApplies).toBe(false);
  });

  it('Given nothing in range (deep space, star frame), Then no ALT, and VEL names the star', () => {
    const r = altitudeContext(
      { parentName: null, parentAltKm: Number.POSITIVE_INFINITY, parentRadiusKm: 0, nearestName: null, nearestAltKm: null },
      'Remit 31',
    );
    expect(r.alt).toBeNull();
    expect(r.velFrame).toBe('Remit 31');
    expect(r.proximity).toBeNull();
    expect(r.verticalApplies).toBe(false);
  });

  it('Given landed on Fyss (terrain ALT 4 m, sphere says −13.8 km), Then ALT is terrain, never the sphere figure, and no proximity line appears for the same body', () => {
    const r = altitudeContext(
      { parentName: 'Fyss', parentAltKm: 0.004, parentRadiusKm: 6000, nearestName: 'Fyss', nearestAltKm: -13.8 },
      'Fyss',
    );
    expect(r.alt).toEqual({ altitudeKm: 0.004, bodyName: 'Fyss' });
    expect(r.proximity).toBeNull();
  });
});

// review-v3b (D14 open point, a bug): under cruise V/S read "−104.36 km/s"
// and IMPACT counted down "0:44" (amber under 30 s) towards a world the drive
// drops out in front of by itself. Neither answers a question while the drive
// flies; both return the moment it is idle.
describe('verticalShown: V/S and impact only when they answer a question', () => {
  it('Given a parent and the cruise drive idle, Then V/S is shown', () => {
    expect(verticalShown(true, 'idle')).toBe(true);
  });

  it('Given the drive spooling, cruising or dropping, Then V/S and impact are hidden', () => {
    for (const phase of ['spooling', 'cruise', 'dropping'] as const) expect(verticalShown(true, phase)).toBe(false);
  });

  it('Given no parent (the star frame), Then hidden, as before', () => {
    expect(verticalShown(false, 'idle')).toBe(false);
  });
});
