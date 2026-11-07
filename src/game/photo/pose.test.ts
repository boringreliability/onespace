/**
 * review-p2: photo mode must open on exactly the frame the player was looking
 * at, and its look controls must follow the screen, whatever the flight
 * camera's roll against world Y.
 */

import { describe, expect, it } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';

import { createFlyCam, stepFlyCam, type FlyCamInput } from './flycam';
import { PhotoFrame } from './pose';

const idle: FlyCamInput = { move: [0, 0, 0], lookDx: 0, lookDy: 0, zoom: 0, fast: false };

/** A flight camera banked well off world Y, as measured in play (~65°). */
function flightPose(): { pos: Vector3; quat: Quaternion } {
  return {
    pos: new Vector3(-144.5, -1.4, -255.8),
    quat: new Quaternion(-0.28717, 0.29804, -0.5079, 0.75548).normalize(),
  };
}

describe('PhotoFrame', () => {
  it('Given a banked flight camera, When photo opens, Then the first photo frame is the flight frame exactly (no roll snap)', () => {
    const { pos, quat } = flightPose();
    const frame = new PhotoFrame();
    frame.anchor(pos, quat);
    const outP = new Vector3();
    const outQ = new Quaternion();
    frame.pose(createFlyCam([0, 0, 0], 0, 0, 60), outP, outQ);
    expect(outP.distanceTo(pos)).toBeLessThan(1e-9);
    expect(Math.abs(outQ.dot(quat))).toBeCloseTo(1, 12);
  });

  it('Given a banked flight camera, When the player drags horizontally, Then the view turns about the SCREEN vertical (entry up), not world Y', () => {
    const { pos, quat } = flightPose();
    const frame = new PhotoFrame();
    frame.anchor(pos, quat);
    const c = createFlyCam([0, 0, 0], 0, 0, 60);
    stepFlyCam(c, { ...idle, lookDx: 200 }, 1 / 60);
    const outQ = new Quaternion();
    frame.pose(c, new Vector3(), outQ);
    const upBefore = new Vector3(0, 1, 0).applyQuaternion(quat);
    const upAfter = new Vector3(0, 1, 0).applyQuaternion(outQ);
    // A pure yaw in the entry frame keeps the camera's up where it was.
    expect(upAfter.distanceTo(upBefore)).toBeLessThan(1e-9);
    const fwdBefore = new Vector3(0, 0, -1).applyQuaternion(quat);
    const fwdAfter = new Vector3(0, 0, -1).applyQuaternion(outQ);
    expect(fwdAfter.angleTo(fwdBefore)).toBeGreaterThan(0.1);
  });

  it('Given a banked flight camera, When W is held, Then the camera flies along the view it opened on', () => {
    const { pos, quat } = flightPose();
    const frame = new PhotoFrame();
    frame.anchor(pos, quat);
    const c = createFlyCam([0, 0, 0], 0, 0, 60);
    stepFlyCam(c, { ...idle, move: [0, 0, -1] }, 2);
    const outP = new Vector3();
    frame.pose(c, outP, new Quaternion());
    const moved = outP.clone().sub(pos).normalize();
    const fwd = new Vector3(0, 0, -1).applyQuaternion(quat);
    expect(moved.distanceTo(fwd)).toBeLessThan(1e-9);
  });

  it('Given an unrolled camera, Then the frame agrees with the old world-Y mapping', () => {
    const quat = new Quaternion().setFromEuler(new Euler(0, 0, 0, 'YXZ'));
    const frame = new PhotoFrame();
    frame.anchor(new Vector3(1, 2, 3), quat);
    const c = createFlyCam([0, 0, 0], 0.4, -0.2, 60);
    const outQ = new Quaternion();
    frame.pose(c, new Vector3(), outQ);
    const legacy = new Quaternion().setFromEuler(new Euler(-0.2, 0.4, 0, 'YXZ'));
    expect(Math.abs(outQ.dot(legacy))).toBeCloseTo(1, 12);
  });
});
