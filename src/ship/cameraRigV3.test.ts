/**
 * [v3-T1] The chase camera, end to end, with a fake engine context.
 *
 * The owner's complaint — "the ship jumps back and forth on screen and
 * resets" — was five mechanisms (docs/v3/PLAN.md §1). These tests put each
 * one through the rig and measure what the player sees: where the hull lands
 * on screen, how far the lens moves and turns per frame.
 *
 * Screen numbers are for a 1600×900 viewport unless stated.
 */

import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';

import type { EngineContext } from '@/core/Engine';
import { openingAttitude } from '@/game/recovery';
import { CameraRig, type LandedFrameSource } from '@/ship/CameraRig';
import { fovPolicy } from '@/ship/fovPolicy';

const DEG = Math.PI / 180;

function fakeCtx(): EngineContext {
  return {
    origin: { offset: new Vector3() },
    input: {
      axes: { yaw: 0, pitch: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0, strafeZ: 0 },
      pressed: () => false,
      isDown: () => false,
      held: () => false,
    },
  } as unknown as EngineContext;
}

interface Sim {
  cam: PerspectiveCamera;
  rig: CameraRig;
  ctx: EngineContext;
  pos: Vector3;
  q: Quaternion;
  vel: Vector3;
  accel: Vector3;
  thrust: number;
  spool: number;
}

function sim(aspect = 16 / 9, mode: 'chase' | 'cockpit' = 'chase'): Sim {
  const cam = new PerspectiveCamera(62, aspect, 0.0005, 1e9);
  const rig = new CameraRig(cam);
  rig.handleToggleKey = false;
  rig.setMode(mode, true);
  return {
    cam,
    rig,
    ctx: fakeCtx(),
    pos: new Vector3(),
    q: new Quaternion(),
    vel: new Vector3(),
    accel: new Vector3(),
    thrust: 0,
    spool: 0,
  };
}

/** One frame: the ship moves by vel·dt (unless `move` is false), then the rig runs. */
function frame(s: Sim, dt: number, move = true): void {
  if (move) s.pos.addScaledVector(s.vel, dt);
  s.rig.setMotion(s.accel, s.thrust, s.spool);
  s.rig.update(dt, s.pos, s.q, s.vel, s.ctx);
}

function run(s: Sim, seconds: number, dt = 1 / 60): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) frame(s, dt);
}

function ndc(s: Sim, p: Vector3 = s.pos): Vector3 {
  s.cam.updateProjectionMatrix();
  s.cam.updateMatrixWorld();
  return p.clone().project(s.cam);
}

function px(a: Vector3, b: Vector3, w = 1600, h = 900): number {
  return Math.hypot(((a.x - b.x) * w) / 2, ((a.y - b.y) * h) / 2);
}

/** Camera position relative to the ship, in the ship's own axes. */
function relLocal(s: Sim): Vector3 {
  return s.cam.position.clone().sub(s.pos).applyQuaternion(s.q.clone().invert());
}

function dir(s: Sim): Vector3 {
  return s.cam.getWorldDirection(new Vector3());
}

// ---------------------------------------------------------------------------

describe('chase: discontinuities do not reach the screen (PLAN §1 mechanisms 1-2)', () => {
  it('Given orbit-speed flight, When one frame loses 8.3 ms of ship time (the v2 hitch), Then the hull moves less than 5 px on screen in every frame after', () => {
    const s = sim();
    s.vel.set(0, 0, -7); // 7 km/s along the nose
    run(s, 3, 1 / 120);
    let prev = ndc(s);
    let worst = 0;
    for (let i = 0; i < 240; i++) {
      if (i === 10) {
        // The world advanced 66.7 ms, the ship only 58.3 ms.
        s.pos.addScaledVector(s.vel, 0.0583);
        frame(s, 1 / 15, false);
      } else {
        frame(s, 1 / 120);
      }
      const n = ndc(s);
      worst = Math.max(worst, px(n, prev));
      prev = n;
    }
    expect(worst).toBeLessThan(5);
  });

  it('Given cruise at 15,000 km/s, When the drive drops to 5 km/s in one frame, Then the hull stays inside NDC ±0.8 and the view turns at most 3° per frame', () => {
    const s = sim();
    s.vel.set(0, 0, -15000);
    run(s, 3);
    let prevDir = dir(s);
    for (let i = 0; i < 180; i++) {
      if (i === 5) s.vel.set(5, 0, 0);
      frame(s, 1 / 60);
      const n = ndc(s);
      expect(Math.abs(n.x)).toBeLessThanOrEqual(0.8);
      expect(Math.abs(n.y)).toBeLessThanOrEqual(0.8);
      const d = dir(s);
      expect(d.angleTo(prevDir)).toBeLessThanOrEqual(3 * DEG);
      prevDir = d;
    }
  });

  it('Given cruise spooling at 1,000 km/s² (carried, no proper acceleration), When the ship accelerates, Then the camera does not trail at all (lag is not from position differences)', () => {
    const s = sim();
    run(s, 2);
    const rest = relLocal(s);
    for (let i = 0; i < 180; i++) {
      s.vel.z -= 1000 / 60;
      frame(s, 1 / 60);
      expect(relLocal(s).distanceTo(rest)).toBeLessThan(0.0005);
    }
  });

  it('Given the same fast flight at 30 and at 144 fps, Then the framing is the same (no frame-rate dependent snap)', () => {
    const a = sim();
    const b = sim();
    a.vel.set(0, 0, -2400); // 80 km a frame at 30 fps, 16.7 km at 144 fps
    b.vel.set(0, 0, -2400);
    run(a, 3, 1 / 30);
    run(b, 3, 1 / 144);
    expect(px(ndc(a), ndc(b))).toBeLessThan(1);
    expect(relLocal(a).distanceTo(relLocal(b))).toBeLessThan(0.0002);
  });
});

describe('chase: lag from filtered proper acceleration (PLAN A3)', () => {
  it('Given a 0.3 km/s² burn along the nose for 2 s, Then the camera trails ~6-7 m further back, and recovers within 1 m a second after the burn', () => {
    const s = sim();
    run(s, 2);
    const rest = relLocal(s);
    s.accel.set(0, 0, -0.3);
    for (let i = 0; i < 120; i++) {
      s.vel.addScaledVector(s.accel, 1 / 60);
      frame(s, 1 / 60);
    }
    const lag = relLocal(s).sub(rest);
    expect(lag.z).toBeGreaterThan(0.0055);
    expect(lag.z).toBeLessThan(0.0075);
    s.accel.set(0, 0, 0);
    run(s, 1);
    expect(relLocal(s).distanceTo(rest)).toBeLessThan(0.001);
  });

  it('Given a violent 10 km/s² event, Then the trail stays under 20 m and the hull stays in frame', () => {
    const s = sim();
    run(s, 2);
    const rest = relLocal(s);
    s.accel.set(0, 0, -10);
    for (let i = 0; i < 60; i++) {
      s.vel.addScaledVector(s.accel, 1 / 60);
      frame(s, 1 / 60);
      expect(relLocal(s).distanceTo(rest)).toBeLessThan(0.02);
      const n = ndc(s);
      expect(Math.abs(n.y)).toBeLessThan(0.9);
    }
  });

  it('Given the same burn at 30 and at 144 fps, Then the trail after 1 s agrees within 0.3 m', () => {
    const go = (dt: number) => {
      const s = sim();
      run(s, 2, dt);
      const rest = relLocal(s);
      s.accel.set(0, 0, -0.3);
      const n = Math.round(1 / dt);
      for (let i = 0; i < n; i++) {
        s.vel.addScaledVector(s.accel, dt);
        frame(s, dt);
      }
      return relLocal(s).sub(rest);
    };
    expect(go(1 / 30).distanceTo(go(1 / 144))).toBeLessThan(0.0003);
  });
});

describe('chase: attitude snaps and explicit reseat (robust to what cruise insertion may leave)', () => {
  it('Given flight at 5 km/s, When the attitude snaps 30° in one frame, Then the hull stays inside NDC ±0.8, the view turns ≤ 3° per frame, and the framing settles within 2 s', () => {
    const s = sim();
    s.vel.set(0, 0, -5);
    run(s, 3);
    const rest = ndc(s);
    let prevDir = dir(s);
    s.q.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 30 * DEG));
    s.vel.applyQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 30 * DEG));
    for (let i = 0; i < 120; i++) {
      frame(s, 1 / 60);
      const n = ndc(s);
      expect(Math.abs(n.x)).toBeLessThanOrEqual(0.8);
      expect(Math.abs(n.y)).toBeLessThanOrEqual(0.8);
      const d = dir(s);
      expect(d.angleTo(prevDir)).toBeLessThanOrEqual(3 * DEG);
      prevDir = d;
    }
    expect(px(ndc(s), rest)).toBeLessThan(10);
  });

  it('Given steady flight, When reseat() is called, Then that frame is not a cut (< 0.5 m, < 1°)', () => {
    const s = sim();
    s.vel.set(0, 0, -5);
    run(s, 2);
    const p0 = relLocal(s);
    const d0 = dir(s);
    s.rig.reseat(0.5);
    frame(s, 1 / 60);
    expect(relLocal(s).distanceTo(p0)).toBeLessThan(0.0005);
    expect(dir(s).angleTo(d0)).toBeLessThan(1 * DEG);
  });
});

describe('chase: aim follows turns (PLAN S3, A7)', () => {
  const turn = (axis: Vector3, rateDeg: number) => {
    const s = sim();
    run(s, 2);
    const rest = ndc(s);
    const dq = new Quaternion();
    let worst = 0;
    for (let i = 0; i < 150; i++) {
      // Body-axis rotation at a constant rate.
      dq.setFromAxisAngle(axis, rateDeg * DEG / 60);
      s.q.multiply(dq);
      frame(s, 1 / 60);
      if (i >= 60) {
        const n = ndc(s);
        worst = Math.max(worst, Math.abs(n.x - rest.x), Math.abs(n.y - rest.y));
      }
    }
    return worst;
  };

  it('Given a full-rate pitch (35°/s) held, Then the hull stays within NDC ±0.25 of its resting place (v2: 45 % of screen height)', () => {
    expect(turn(new Vector3(1, 0, 0), 35)).toBeLessThanOrEqual(0.25);
  });

  it('Given a full-rate yaw (28°/s) held, Then the hull stays within NDC ±0.25 of its resting place', () => {
    expect(turn(new Vector3(0, 1, 0), 28)).toBeLessThanOrEqual(0.25);
  });

  it('Given a 20° turn that stops, Then the view settles on the new framing within 2 s', () => {
    const s = sim();
    run(s, 2);
    const rest = ndc(s);
    const dq = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (20 * DEG) / 30);
    for (let i = 0; i < 30; i++) {
      s.q.multiply(dq);
      frame(s, 1 / 60);
    }
    run(s, 2);
    expect(px(ndc(s), rest)).toBeLessThan(5);
  });
});

describe('chase: framing and FOV (D0, PLAN phase C)', () => {
  it('Given plain flight at 16:9, Then the hull sits centred horizontally in the lower third', () => {
    const s = sim();
    run(s, 3);
    const n = ndc(s);
    expect(Math.abs(n.x)).toBeLessThan(0.02);
    expect(n.y).toBeLessThanOrEqual(-0.3);
    expect(n.y).toBeGreaterThanOrEqual(-0.62);
  });

  it('Given coasting at 7 km/s versus at rest, Then the fov is identical (never from orbital speed)', () => {
    const a = sim();
    const b = sim();
    b.vel.set(0, 0, -7);
    run(a, 4);
    run(b, 4);
    expect(b.cam.fov).toBeCloseTo(a.cam.fov, 6);
    expect(a.cam.fov).toBeCloseTo(fovPolicy({ aspect: 16 / 9, thrustFrac: 0, cruiseSpool: 0, mode: 'chase' }), 1);
  });

  it('Given full thrust for 3 s, Then the fov has breathed out to the policy value', () => {
    const s = sim();
    s.thrust = 1;
    run(s, 3);
    expect(s.cam.fov).toBeCloseTo(fovPolicy({ aspect: 16 / 9, thrustFrac: 1, cruiseSpool: 0, mode: 'chase' }), 1);
  });

  it('Given a 21:9 viewport, Then the fov follows the policy for that aspect (Vert- past 100°)', () => {
    const s = sim(21 / 9);
    run(s, 3);
    expect(s.cam.fov).toBeCloseTo(fovPolicy({ aspect: 21 / 9, thrustFrac: 0, cruiseSpool: 0, mode: 'chase' }), 1);
  });

  for (const [label, aspect] of [
    ['16:9', 16 / 9],
    ['2.1:1', 2.1],
    ['21:9', 21 / 9],
  ] as const) {
    it(`Given the opening orbit (1.6 R, nose 30° below prograde) at ${label}, Then the hull is in the lower third and the planet's limb is in frame`, () => {
      const R = 7240;
      const r = new Vector3(0, 0, 1.6 * R);
      const v = new Vector3(5, 0, 0);
      const s = sim(aspect);
      s.pos.copy(r);
      s.vel.copy(v);
      s.q.copy(openingAttitude(v, r));
      s.rig.setReferenceUp(r.clone().normalize());
      run(s, 6);
      const hull = ndc(s);
      expect(Math.abs(hull.x)).toBeLessThan(0.05);
      expect(hull.y).toBeLessThanOrEqual(-0.3);
      expect(hull.y).toBeGreaterThanOrEqual(-0.65);
      // The limb ahead: the horizon direction in the orbit plane.
      const d = Math.acos(1 / 1.6);
      const limbDir = new Vector3(Math.cos(d), 0, -Math.sin(d));
      const limb = s.pos.clone().addScaledVector(limbDir, Math.sqrt(1.6 * 1.6 - 1) * R);
      const n = ndc(s, limb);
      expect(n.z).toBeLessThan(1); // in front of the camera
      expect(n.y).toBeGreaterThanOrEqual(-0.9);
      expect(n.y).toBeLessThan(hull.y); // below the hull: the ship over the world
    });
  }
});

describe('shake and cockpit read the hull, not position differences (PLAN A8)', () => {
  it('Given strong proper acceleration with the engine at idle (drag, gear), Then there is no shake', () => {
    const s = sim();
    s.accel.set(0.5, 0.2, 0);
    run(s, 2);
    expect(s.rig.trauma).toBeLessThan(1e-3);
  });

  it('Given full thrust, Then there is a continuous rumble', () => {
    const s = sim();
    s.thrust = 1;
    run(s, 2);
    expect(s.rig.trauma).toBeGreaterThan(0.15);
  });

  it('Given an impact shake request, Then it still shakes regardless of thrust', () => {
    const s = sim();
    run(s, 1);
    s.rig.shake(0.8, 1);
    frame(s, 1 / 60);
    expect(s.rig.trauma).toBeGreaterThan(0.5);
  });

  it('Given the cockpit under steady thrust with jittery frame times, When the velocity is quantised to 1/120 s substeps, Then the eye moves exactly as with smooth velocity (no finite-difference noise)', () => {
    // In the game the velocity only changes in whole substeps (0-8 a frame)
    // while dt is wall time, so v2's finite-difference acceleration read
    // a·steps·h/dt — 0 % to 200 % of the real thrust, frame to frame.
    const dts = [1 / 60, 1 / 144, 1 / 60, 0.007, 1 / 30, 1 / 90, 1 / 60, 0.021];
    const A = 0.3;
    const smooth = sim(16 / 9, 'cockpit');
    const steppy = sim(16 / 9, 'cockpit');
    for (const x of [smooth, steppy]) {
      x.accel.set(0, 0, -A);
      x.thrust = 1;
    }
    let acc = 0;
    let worst = 0;
    for (let i = 0; i < 480; i++) {
      const dt = dts[i % dts.length]!;
      smooth.vel.z -= A * dt;
      acc += dt;
      while (acc >= 1 / 120) {
        steppy.vel.z -= A / 120;
        acc -= 1 / 120;
      }
      frame(smooth, dt);
      frame(steppy, dt);
      // Shake is identical in both (same clock, same thrust); compare eyes.
      worst = Math.max(worst, relLocal(smooth).distanceTo(relLocal(steppy)));
    }
    expect(worst).toBeLessThan(0.000001); // 1 mm
  });

  it('Given the cockpit under a position-only cruise ramp (no proper acceleration), Then the eye does not sink into the seat', () => {
    const s = sim(16 / 9, 'cockpit');
    run(s, 2);
    const p0 = relLocal(s);
    for (let i = 0; i < 120; i++) {
      s.vel.z -= 1000 / 60;
      frame(s, 1 / 60);
    }
    expect(relLocal(s).distanceTo(p0)).toBeLessThan(0.0001);
  });

  it('Given the cockpit and a burn, Then the eye is pushed back by the proper acceleration', () => {
    const s = sim(16 / 9, 'cockpit');
    run(s, 2);
    const p0 = relLocal(s);
    s.accel.set(0, 0, -0.3);
    run(s, 1);
    expect(relLocal(s).z - p0.z).toBeGreaterThan(0.0001);
  });
});

// ---------------------------------------------------------------------------
// Landed transitions (PLAN §1 mechanism 4, A7)
// ---------------------------------------------------------------------------

const source: LandedFrameSource = {
  sunDir: new Vector3(0.6, 0.5, 0.2).normalize(),
  skyWeight: 1,
  groundRiseAt: () => 0,
};

describe('landed transitions', () => {
  it('Given a chase descent, When the ship touches down, Then the reveal keeps the hull in frame (NDC ±0.8) every frame', () => {
    const s = sim();
    s.rig.setReferenceUp(new Vector3(0, 1, 0));
    s.vel.set(0, -0.002, 0);
    // Nose level, flying along -Z, descending.
    run(s, 3);
    s.vel.set(0, 0, 0);
    s.rig.setLandedFrame(source);
    s.rig.setMode('orbit');
    for (let i = 0; i < 60 * 12; i++) {
      frame(s, 1 / 60);
      const n = ndc(s);
      expect(Math.abs(n.x)).toBeLessThanOrEqual(0.8);
      expect(Math.abs(n.y)).toBeLessThanOrEqual(0.8);
      expect(n.z).toBeLessThan(1);
    }
  });

  it('Given a settled landed frame, When the ship lifts off back to chase, Then the lens never comes within 30 m of the hull and never turns faster than 90°/s (v2: 7 m, 512°/s)', () => {
    const s = sim();
    s.rig.setReferenceUp(new Vector3(0, 1, 0));
    run(s, 2);
    s.rig.setLandedFrame(source);
    s.rig.setMode('orbit');
    run(s, 25);
    s.rig.setLandedFrame(null);
    s.rig.setMode('chase');
    s.vel.set(0, 0.03, 0); // 30 m/s climb
    let prevDir = dir(s);
    let minDist = Infinity;
    let maxRate = 0;
    for (let i = 0; i < 60 * 5; i++) {
      frame(s, 1 / 60);
      minDist = Math.min(minDist, s.cam.position.distanceTo(s.pos));
      const d = dir(s);
      maxRate = Math.max(maxRate, d.angleTo(prevDir) * 60);
      prevDir = d;
    }
    expect(minDist).toBeGreaterThanOrEqual(0.03);
    expect(maxRate).toBeLessThanOrEqual(90 * DEG);
  });

  it('Given a liftoff, When the blend has run its course, Then the rig is the plain chase with the hull in its resting place', () => {
    const s = sim();
    s.rig.setReferenceUp(new Vector3(0, 1, 0));
    run(s, 2);
    const rest = ndc(s);
    s.rig.setLandedFrame(source);
    s.rig.setMode('orbit');
    run(s, 25);
    s.rig.setLandedFrame(null);
    s.rig.setMode('chase');
    run(s, 6);
    expect(s.rig.transitionProgress).toBe(1);
    expect(px(ndc(s), rest)).toBeLessThan(10);
  });
});
