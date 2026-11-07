/**
 * v3 T4 / PLAN E3-E4 — traffic legibility and scale through motion.
 *
 * The audit's V2: the traffic ship is never seen. It sat just above the top
 * edge of the opening frame, axis-aligned to the world rather than to its
 * orbit, engines off (`throttle: 0`), and the ground-referenced motion blur
 * smeared it. These are the pure parts of the fix: where contact 0 goes, how
 * a hull is oriented, how its drive breathes and how a big hull moves.
 *
 * Frames: everything parent-relative (as FlightModel), ship-local axes as in
 * `gen/ships/types.ts`: -Z nose, +Y roof, +X starboard.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { BASE_HFOV_DEG } from '@/ship/fovPolicy';
import {
  CONTACT_CLEARANCE_FACTOR,
  CONTACT_CLEARANCE_PAD_KM,
  CONTACT_ELEVATION_RAD,
  CONTACT_RANGE_KM,
  HULL_ANGLE_DEG,
  hullContactRangeKm,
  TRAFFIC_THROTTLE_MAX,
  TRAFFIC_THROTTLE_MIN,
  contactRangeKm,
  coOrbitVelocity,
  hullAttitude,
  hullSway,
  openingContactOffset,
  trafficThrottle,
} from './trafficMotion';

const NOSE = new Vector3(0, 0, -1);
const ROOF = new Vector3(0, 1, 0);

describe('openingContactOffset: contact 0 inside the opening composition', () => {
  it('Given the elevation constant, Then it is ~15° above the nose', () => {
    expect((CONTACT_ELEVATION_RAD * 180) / Math.PI).toBeGreaterThanOrEqual(10);
    expect((CONTACT_ELEVATION_RAD * 180) / Math.PI).toBeLessThanOrEqual(20);
  });

  it('Given the nose and roof, Then the offset sits at the elevation angle above the nose, in the nose-roof plane', () => {
    const fwd = new Vector3(0.3, -0.5, -0.8).normalize();
    const roof = new Vector3(0, 1, 0).addScaledVector(fwd, -fwd.y).normalize();
    const o = openingContactOffset(fwd, roof, 2, new Vector3());
    const dir = o.clone().normalize();
    expect(Math.acos(dir.dot(fwd))).toBeCloseTo(CONTACT_ELEVATION_RAD, 6);
    expect(dir.dot(roof)).toBeGreaterThan(0); // above, not below
    const side = new Vector3().crossVectors(fwd, roof);
    expect(Math.abs(dir.dot(side))).toBeLessThan(1e-9); // dead ahead in azimuth
  });

  it('Given a range, Then the offset has exactly that length, in km', () => {
    expect(openingContactOffset(NOSE, ROOF, 1.8, new Vector3()).length()).toBeCloseTo(1.8, 12);
  });

  it('Given a roof hint not perpendicular to the nose, Then it is orthogonalised (still exactly at the elevation angle)', () => {
    const roof = new Vector3(0, 1, -0.4); // leans forward
    const dir = openingContactOffset(NOSE, roof, 2, new Vector3()).normalize();
    expect(Math.acos(dir.dot(NOSE))).toBeCloseTo(CONTACT_ELEVATION_RAD, 6);
  });

  it('Given the opening chase view (≥ ±25° vertical), Then 15° up is inside the frame', () => {
    expect(CONTACT_ELEVATION_RAD).toBeLessThan((25 * Math.PI) / 180);
  });
});

describe('contactRangeKm: 1.5-2.5 km', () => {
  it('Given the range constant, Then it is [1.5, 2.5] km', () => {
    expect(CONTACT_RANGE_KM[0]).toBe(1.5);
    expect(CONTACT_RANGE_KM[1]).toBe(2.5);
  });

  it('Given any uniform draw, Then the range is inside [1.5, 2.5] and monotone in the draw', () => {
    let prev = -1;
    for (let u = 0; u <= 1.0000001; u += 0.1) {
      const r = contactRangeKm(u);
      expect(r).toBeGreaterThanOrEqual(1.5);
      expect(r).toBeLessThanOrEqual(2.5);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it('Given a draw outside [0, 1] or NaN, Then it is clamped into the band', () => {
    expect(contactRangeKm(-3)).toBe(1.5);
    expect(contactRangeKm(7)).toBe(2.5);
    expect(contactRangeKm(Number.NaN)).toBeGreaterThanOrEqual(1.5);
  });
});

// v3 polish (D22c): SEE IN FLIGHT put a 30 m companion 1.6 km off — a few
// pixels, and the "your 30 m ship as yardstick" idea failed. The range now
// follows the hull: it is placed where it subtends 6-10° of the 88° frame.
describe('hullContactRangeKm: contact 0 placed by the size of its hull', () => {
  const subtends = (lengthKm: number, rangeKm: number): number => (2 * Math.atan(lengthKm / (2 * rangeKm)) * 180) / Math.PI;
  const clearance = (boundKm: number): number => CONTACT_CLEARANCE_FACTOR * (boundKm + CONTACT_CLEARANCE_PAD_KM);

  it('Given the target band, Then it is 6-10° of hull, out of the 88° horizontal frame', () => {
    expect(HULL_ANGLE_DEG).toEqual([6, 10]);
    expect(BASE_HFOV_DEG).toBe(88);
    expect(CONTACT_CLEARANCE_FACTOR).toBe(3);
    expect(CONTACT_CLEARANCE_PAD_KM).toBeCloseTo(0.03, 12);
  });

  for (const [label, len] of [['30 m (the player’s own size)', 0.03], ['120 m', 0.12], ['300 m', 0.3]] as const) {
    it(`Given a ${label} hull, Then it subtends 6-10° — the draw picks where in the band — and the range is inside 2.5 km`, () => {
      for (const u of [0, 0.25, 0.5, 0.75, 1]) {
        const r = hullContactRangeKm(u, len, 0.55 * len);
        const deg = subtends(len, r);
        expect(deg).toBeGreaterThanOrEqual(6 - 1e-9);
        expect(deg).toBeLessThanOrEqual(10 + 1e-9);
        expect(r).toBeLessThanOrEqual(CONTACT_RANGE_KM[1]);
      }
      expect(subtends(len, hullContactRangeKm(0.5, len, 0.55 * len))).toBeCloseTo(8, 6);
    });
  }

  it('Given a 30 m hull, Then it sits ~210 m off, not 1.6 km (the review’s few pixels)', () => {
    const r = hullContactRangeKm(0.5, 0.03, 0.017);
    expect(r).toBeGreaterThan(0.15);
    expect(r).toBeLessThan(0.3);
  });

  it('Given a hull long enough that 6-10° is beyond 2.5 km, Then the range is capped at 2.5 km (it only looks bigger)', () => {
    const r = hullContactRangeKm(0, 0.4, 0.22);
    expect(r).toBe(2.5);
    expect(subtends(0.4, r)).toBeGreaterThan(6);
  });

  it('Given any hull 5 m-3 km and any draw, Then the range is never inside 3 × (bounding radius + 30 m) — clearance beats both the angle and the cap', () => {
    for (let len = 0.005; len <= 3; len *= 1.17) {
      for (const k of [0.5, 0.6, 0.9]) {
        for (const u of [0, 0.5, 1]) {
          const bound = k * len;
          expect(hullContactRangeKm(u, len, bound)).toBeGreaterThanOrEqual(clearance(bound) - 1e-12);
        }
      }
    }
    // A 2 km capital: 3 × (1.1 + 0.03) = 3.39 km, past the 2.5 km cap.
    expect(hullContactRangeKm(0.5, 2, 1.1)).toBeCloseTo(3.39, 9);
  });

  it('Given a draw outside [0, 1] or NaN, Then it is clamped into the band', () => {
    expect(hullContactRangeKm(-4, 0.1, 0.06)).toBe(hullContactRangeKm(0, 0.1, 0.06));
    expect(hullContactRangeKm(9, 0.1, 0.06)).toBe(hullContactRangeKm(1, 0.1, 0.06));
    expect(Number.isFinite(hullContactRangeKm(Number.NaN, 0.1, 0.06))).toBe(true);
  });

  it('Given no usable length (NaN, 0, negative), Then the old 1.5-2.5 km band — never NaN', () => {
    for (const bad of [Number.NaN, 0, -1]) {
      const r = hullContactRangeKm(0.5, bad, bad);
      expect(r).toBe(contactRangeKm(0.5));
    }
  });

  it('Given the offset rescaled to the hull range, Then it is still exactly at the elevation angle above the nose (still in frame)', () => {
    const o = openingContactOffset(NOSE, ROOF, hullContactRangeKm(0.5, 0.03, 0.017), new Vector3());
    expect(Math.acos(o.clone().normalize().dot(NOSE))).toBeCloseTo(CONTACT_ELEVATION_RAD, 9);
  });
});

describe('coOrbitVelocity: the velocity of the rigid co-orbit Traffic already flies', () => {
  it('Given axis, rate and position, Then v = rate · (axis × r)', () => {
    const axis = new Vector3(0, 1, 0);
    const r = new Vector3(10000, 0, 0);
    const v = coOrbitVelocity(axis, 5e-4, r, new Vector3());
    expect(v.x).toBeCloseTo(0, 9);
    expect(v.z).toBeCloseTo(-5, 9); // +Y × +X = -Z
  });

  it('Given it matches the finite difference of the placement it describes', () => {
    const axis = new Vector3(0.2, 1, 0.1).normalize();
    const r0 = new Vector3(9000, 300, -2000);
    const rate = 6e-4;
    const dt = 1e-3;
    const a = r0.clone().applyAxisAngle(axis, rate * 10);
    const b = r0.clone().applyAxisAngle(axis, rate * (10 + dt));
    const fd = b.sub(a).divideScalar(dt);
    expect(coOrbitVelocity(axis, rate, a, new Vector3()).distanceTo(fd)).toBeLessThan(1e-4);
  });
});

describe('hullAttitude: oriented along the orbit, not the world axes', () => {
  const r = new Vector3(11000, 2000, -500);
  const v = new Vector3(-0.5, 0.4, 5.6);

  it('Given velocity and radial-out, Then the nose (-Z) points along the velocity', () => {
    const q = hullAttitude(v, r, new Quaternion());
    const nose = NOSE.clone().applyQuaternion(q);
    expect(nose.dot(v.clone().normalize())).toBeCloseTo(1, 9);
  });

  it('Given velocity and radial-out, Then the roof (+Y) faces away from the world (no rolled hull)', () => {
    const q = hullAttitude(v, r, new Quaternion());
    const roof = ROOF.clone().applyQuaternion(q);
    expect(roof.dot(r.clone().normalize())).toBeGreaterThan(0.9);
  });

  it('Given a zero velocity, Then the attitude is still a valid unit quaternion (no NaN)', () => {
    const q = hullAttitude(new Vector3(), r, new Quaternion());
    expect(Math.abs(q.length() - 1)).toBeLessThan(1e-9);
  });
});

describe('trafficThrottle: powered, with a slow plume flicker', () => {
  it('Given the band, Then it is ~0.15-0.3 (visibly powered, never full burn)', () => {
    expect(TRAFFIC_THROTTLE_MIN).toBeGreaterThanOrEqual(0.12);
    expect(TRAFFIC_THROTTLE_MAX).toBeLessThanOrEqual(0.32);
  });

  it('Given ten minutes at 60 Hz, Then it stays in the band, moves, and never steps (≤ 0.01 per frame)', () => {
    let min = 1;
    let max = 0;
    let prev = trafficThrottle(0, 0.37);
    for (let i = 1; i < 36000; i++) {
      const t = trafficThrottle(i / 60, 0.37);
      expect(t).toBeGreaterThanOrEqual(TRAFFIC_THROTTLE_MIN);
      expect(t).toBeLessThanOrEqual(TRAFFIC_THROTTLE_MAX);
      expect(Math.abs(t - prev)).toBeLessThanOrEqual(0.01);
      min = Math.min(min, t);
      max = Math.max(max, t);
      prev = t;
    }
    expect(max - min).toBeGreaterThan(0.03); // it flickers
  });

  it('Given two vessels with different phases, Then their plumes do not breathe in lockstep', () => {
    let diff = 0;
    for (let i = 0; i < 600; i++) diff += Math.abs(trafficThrottle(i / 60, 0.1) - trafficThrottle(i / 60, 0.8));
    expect(diff / 600).toBeGreaterThan(0.005);
  });
});

describe('hullSway: big hulls move slowly, with RCS puffs', () => {
  it('Given any hull, Then the sway is small (≤ 4°) and finite', () => {
    for (const len of [0.03, 0.4, 2]) {
      for (let i = 0; i < 2000; i++) {
        const s = hullSway(i * 0.1, len, 0.2);
        expect(Math.abs(s.yawRad)).toBeLessThanOrEqual((4 * Math.PI) / 180);
        expect(Number.isFinite(s.lateralM)).toBe(true);
      }
    }
  });

  it('Given a longer hull, Then its peak yaw rate is lower (mass reads as slowness)', () => {
    const peakRate = (len: number): number => {
      let m = 0;
      for (let i = 1; i < 6000; i++) {
        const a = hullSway((i - 1) * 0.05, len, 0).yawRad;
        const b = hullSway(i * 0.05, len, 0).yawRad;
        m = Math.max(m, Math.abs(b - a) / 0.05);
      }
      return m;
    };
    expect(peakRate(1.2)).toBeLessThan(peakRate(0.12));
  });

  it('Given the sway reversing, Then RCS fires against the motion, and only in short puffs (duty ≤ 25 %)', () => {
    let firing = 0;
    let opposed = 0;
    const N = 12000;
    for (let i = 1; i < N; i++) {
      const t = i * 0.05;
      const s = hullSway(t, 0.4, 0.5);
      const prev = hullSway(t - 0.05, 0.4, 0.5);
      const rate = (s.yawRad - prev.yawRad) / 0.05;
      if (s.rcs.lengthSq() > 1e-6) {
        firing++;
        // A puff decelerates the swing at the turnaround: its yaw torque
        // opposes the yaw displacement.
        if (Math.sign(s.rcsYaw) === -Math.sign(s.yawRad) || Math.abs(rate) < 1e-4) opposed++;
      }
    }
    expect(firing).toBeGreaterThan(0);
    expect(firing / N).toBeLessThanOrEqual(0.25);
    expect(opposed / firing).toBeGreaterThan(0.9);
  });

  it('Given a puff, Then the RCS command is ship-local and bounded to [-1, 1] per axis', () => {
    for (let i = 0; i < 4000; i++) {
      const s = hullSway(i * 0.05, 0.6, 0.9);
      for (const c of [s.rcs.x, s.rcs.y, s.rcs.z]) expect(Math.abs(c)).toBeLessThanOrEqual(1);
    }
  });
});
