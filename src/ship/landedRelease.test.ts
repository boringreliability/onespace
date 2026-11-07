/**
 * Leaving the landed frame (review-landed).
 *
 * Measured in the browser on the merged landed view: pressing L on the ground
 * moved the camera from 70.6 m to 200 m off the hull and turned it 40.6
 * degrees IN ONE FRAME. setLandedFrame(null) dropped the composition at once,
 * so the orbit pose the mode blend starts from was already the plain
 * inspection orbit — the blend began on the far side of a cut. Pre-merge the
 * worst liftoff frame was 11.6 m / 6.4 degrees.
 */

import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';

import type { EngineContext } from '@/core/Engine';
import { CameraRig, type LandedFrameSource } from '@/ship/CameraRig';

function fakeCtx(): EngineContext {
  return {
    origin: { offset: new Vector3() },
    input: {
      axes: { yaw: 0, pitch: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0 },
      pressed: () => false,
      isDown: () => false,
      held: () => false,
    },
  } as unknown as EngineContext;
}

const source: LandedFrameSource = {
  sunDir: new Vector3(0.6, 0.5, 0.2).normalize(),
  skyWeight: 1,
  groundRiseAt: () => 0,
};

const DT = 1 / 60;

function landedRig(mode: 'chase' | 'orbit') {
  const cam = new PerspectiveCamera(60, 16 / 9, 0.0001, 1e6);
  const rig = new CameraRig(cam);
  rig.handleToggleKey = false;
  const ctx = fakeCtx();
  const ship = new Vector3(0, 0, 0);
  const q = new Quaternion();
  const vel = new Vector3();
  rig.setReferenceUp(new Vector3(0, 1, 0));
  rig.setMode(mode, true);
  for (let i = 0; i < 120; i++) rig.update(DT, ship, q, vel, ctx);
  // Touchdown, as Pilot.enterLanded does it.
  rig.setLandedFrame(source);
  rig.setMode('orbit');
  for (let i = 0; i < 60 * 25; i++) rig.update(DT, ship, q, vel, ctx);
  return { cam, rig, ctx, ship, q, vel };
}

/** Largest per-frame step (km) and turn (radians) over `frames` frames. */
function worstFrame(r: ReturnType<typeof landedRig>, frames: number) {
  const prevPos = r.cam.position.clone();
  const prevDir = r.cam.getWorldDirection(new Vector3());
  let step = 0;
  let turn = 0;
  for (let i = 0; i < frames; i++) {
    // The ship climbs at 30 m/s, as it does on an L liftoff.
    r.ship.y += 0.03 * DT;
    r.rig.update(DT, r.ship, r.q, r.vel, r.ctx);
    const rel = r.cam.position.clone().sub(r.ship);
    const prevRel = prevPos.clone().sub(r.ship.clone().setY(r.ship.y - 0.03 * DT));
    step = Math.max(step, rel.distanceTo(prevRel));
    const dir = r.cam.getWorldDirection(new Vector3());
    turn = Math.max(turn, dir.angleTo(prevDir));
    prevPos.copy(r.cam.position);
    prevDir.copy(dir);
  }
  return { step, turn };
}

describe('leaving the landed frame', () => {
  it('Given a settled landed frame entered from chase, When the ship lifts off and the rig goes back to chase, Then no frame cuts', () => {
    const r = landedRig('chase');
    // Leaving, as Pilot.leaveLanded does it.
    r.rig.setLandedFrame(null);
    r.rig.setMode('chase');
    const w = worstFrame(r, 90);
    expect(w.step).toBeLessThan(0.02); // < 20 m per frame
    expect(w.turn).toBeLessThan((6 * Math.PI) / 180);
  });

  it('Given a settled landed frame entered from orbit, When the ship lifts off and the rig stays in orbit, Then no frame cuts', () => {
    const r = landedRig('orbit');
    r.rig.setLandedFrame(null);
    r.rig.setMode('orbit');
    const w = worstFrame(r, 90);
    expect(w.step).toBeLessThan(0.02);
    expect(w.turn).toBeLessThan((6 * Math.PI) / 180);
  });

  it('Given a liftoff in progress, When the hand-over has run its course, Then the rig is the plain view again', () => {
    const r = landedRig('chase');
    r.rig.setLandedFrame(null);
    r.rig.setMode('chase');
    worstFrame(r, 120);
    expect(r.rig.landedFrameActive).toBe(false);
    expect(r.rig.mode).toBe('chase');
  });

  it('Given a landed site whose vertical sweeps past world X as the world turns, When the frame is held, Then the eye never whips round the hull', () => {
    // The landed basis used to be world X laid onto the horizon, switching to
    // world Z within 0.57 degrees of X. Near X that reference spins through
    // 180 degrees, and at the switch it jumps — and the eye, held at a fixed
    // angle in that basis, teleported round the hull with it.
    const cam = new PerspectiveCamera(60, 16 / 9, 0.0001, 1e6);
    const rig = new CameraRig(cam);
    rig.handleToggleKey = false;
    const ctx = fakeCtx();
    const ship = new Vector3();
    const q = new Quaternion();
    const vel = new Vector3();
    // The vertical turns about an axis tilted 0.2 degrees off Z, so it passes
    // 0.2 degrees from +X. 3 degrees a second: a fast world at 100x.
    const axis = new Vector3(0, Math.sin(0.0035), Math.cos(0.0035));
    const up0 = new Vector3(Math.cos(0.6), -Math.sin(0.6), 0).projectOnPlane(axis).normalize();
    const up = new Vector3();
    const sun = new Vector3(0, 1, 0);
    const src: LandedFrameSource = { sunDir: sun, skyWeight: 1, groundRiseAt: () => 0 };
    const turn = new Quaternion();
    const at = (t: number) => {
      turn.setFromAxisAngle(axis, (3 * Math.PI) / 180 * t);
      up.copy(up0).applyQuaternion(turn);
      // The star, the hull's nose and the eye all turn with the world.
      sun.set(-0.3, 1, 0.4).normalize().applyQuaternion(turn);
      q.copy(turn);
      rig.setReferenceUp(up);
    };
    at(0);
    rig.setMode('orbit', true);
    rig.setLandedFrame(src);
    for (let i = 0; i < 60 * 30; i++) rig.update(DT, ship, q, vel, ctx);
    let t = 0;
    let worst = 0;
    const prev = cam.position.clone();
    for (let i = 0; i < 60 * 25; i++) {
      t += DT;
      at(t);
      rig.update(DT, ship, q, vel, ctx);
      worst = Math.max(worst, cam.position.distanceTo(prev));
      prev.copy(cam.position);
    }
    // The eye is 70 m out and the world turns 3 deg/s: ~4 mm a frame. Allow 0.5 m.
    expect(worst).toBeLessThan(0.0005);
  });
});
