/**
 * v2 phase 1 — supercruise steers itself at a locked target.
 *
 * The controller is a PD loop on the nose error, tuned critically damped
 * against the ship's own rotational model (RCS alpha plus the assist's
 * exponential rate decay), and it acts only through `FlightModel.command` —
 * the same channel as the pilot's stick, so it cannot do anything a pilot
 * could not. Any pilot rotation input wins on the frame it appears.
 *
 * Measured through the real FlightModel, so sign conventions (yawAxisSign is
 * -1 on the default hull) are tested rather than assumed.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { DEFAULT_SHIP_CONFIG, FlightModel } from './FlightModel';
import { noseErrorRad, steerToward } from './cruiseSteer';

const DEG = Math.PI / 180;

function ship(assist = true): FlightModel {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0 });
  fm.teleport(new Vector3(), new Vector3(), new Quaternion());
  fm.flightAssist = assist;
  return fm;
}

interface Pilot {
  pitch: number;
  yaw: number;
  roll: number;
}

/**
 * One frame as the game runs it: Pilot copies the stick into the command,
 * the steering may overwrite it, then the integrator runs.
 */
function frame(fm: FlightModel, target: Vector3, pilot: Pilot, h = 1 / 60): ReturnType<typeof steerToward> {
  fm.command.pitch = pilot.pitch;
  fm.command.yaw = pilot.yaw;
  fm.command.roll = pilot.roll;
  fm.command.throttle = 0;
  const who = steerToward(fm, target);
  fm.update(h);
  return who;
}

const HANDS_OFF: Pilot = { pitch: 0, yaw: 0, roll: 0 };

/** Signed nose error about one body axis, for overshoot. */
function signedPitchError(fm: FlightModel, target: Vector3): number {
  const d = target.clone().sub(fm.worldPosition).applyQuaternion(fm.orientation.clone().invert());
  return Math.atan2(d.y, -d.z);
}
function signedYawError(fm: FlightModel, target: Vector3): number {
  const d = target.clone().sub(fm.worldPosition).applyQuaternion(fm.orientation.clone().invert());
  return Math.atan2(d.x, -d.z);
}

describe('steering to a locked target', () => {
  for (const assist of [true, false]) {
    const mode = assist ? 'assist on' : 'assist off (Newtonian)';

    it(`Given a target 90° above the nose (${mode}), When hands-off for 6 s, Then the nose is within 1° of it`, () => {
      const fm = ship(assist);
      const target = new Vector3(0, 1e6, 0);
      for (let i = 0; i < 6 * 60; i++) frame(fm, target, HANDS_OFF);
      expect(noseErrorRad(fm, target)).toBeLessThan(1 * DEG);
    });

    it(`Given a target 90° above the nose (${mode}), Then the pitch error never overshoots past 3°`, () => {
      const fm = ship(assist);
      const target = new Vector3(0, 1e6, 0);
      let lowest = Infinity;
      for (let i = 0; i < 10 * 60; i++) {
        frame(fm, target, HANDS_OFF);
        lowest = Math.min(lowest, signedPitchError(fm, target));
      }
      expect(lowest).toBeGreaterThan(-3 * DEG);
    });

    it(`Given a target 90° to the side (${mode}), Then yaw converges without overshooting past 3° — yawAxisSign is honoured`, () => {
      for (const side of [1, -1]) {
        const fm = ship(assist);
        const target = new Vector3(side * 1e6, 0, 0);
        let worst = -Infinity;
        for (let i = 0; i < 10 * 60; i++) {
          frame(fm, target, HANDS_OFF);
          // Overshoot is the error crossing to the other side of zero.
          worst = Math.max(worst, -side * signedYawError(fm, target));
        }
        expect(noseErrorRad(fm, target)).toBeLessThan(1 * DEG);
        expect(worst).toBeLessThan(3 * DEG);
      }
    });
  }

  it('Given a target off both axes, Then it converges on the combined error', () => {
    const fm = ship();
    const target = new Vector3(4e5, -3e5, -2e5);
    for (let i = 0; i < 8 * 60; i++) frame(fm, target, HANDS_OFF);
    expect(noseErrorRad(fm, target)).toBeLessThan(1 * DEG);
  });

  it('Given a target dead astern (180°, the degenerate case), Then it still turns round — no NaN, no stall', () => {
    const fm = ship();
    const target = new Vector3(0, 0, 1e6);
    for (let i = 0; i < 10 * 60; i++) frame(fm, target, HANDS_OFF);
    expect(Number.isFinite(fm.orientation.w)).toBe(true);
    expect(noseErrorRad(fm, target)).toBeLessThan(1 * DEG);
  });

  it('Given the nose already on the target, Then the commands are quiet (no hunting)', () => {
    const fm = ship();
    const target = new Vector3(0, 0, -1e6);
    for (let i = 0; i < 60; i++) frame(fm, target, HANDS_OFF);
    fm.command.pitch = 0;
    fm.command.yaw = 0;
    steerToward(fm, target);
    expect(Math.abs(fm.command.pitch)).toBeLessThan(0.05);
    expect(Math.abs(fm.command.yaw)).toBeLessThan(0.05);
  });

  it('Given any error, Then the steering never commands roll and never exceeds full stick', () => {
    const fm = ship();
    const target = new Vector3(3e5, 7e5, 1e5);
    for (let i = 0; i < 3 * 60; i++) {
      fm.command.pitch = 0;
      fm.command.yaw = 0;
      fm.command.roll = 0;
      steerToward(fm, target);
      expect(fm.command.roll).toBe(0);
      expect(Math.abs(fm.command.pitch)).toBeLessThanOrEqual(1);
      expect(Math.abs(fm.command.yaw)).toBeLessThanOrEqual(1);
      fm.update(1 / 60);
    }
  });
});

describe('the pilot always wins', () => {
  it('Given pilot yaw input, When steering would pitch, Then the pilot’s command passes through untouched', () => {
    const fm = ship();
    const target = new Vector3(0, 1e6, 0);
    const who = frame(fm, target, { pitch: 0, yaw: 0.6, roll: 0 });
    expect(who).toBe('pilot');
    expect(fm.command.yaw).toBe(0.6);
    expect(fm.command.pitch).toBe(0);
  });

  it('Given pilot input of any axis — even roll alone, even a small mouse nudge —, Then the steering yields that frame', () => {
    for (const p of [
      { pitch: 0.1, yaw: 0, roll: 0 },
      { pitch: 0, yaw: -0.1, roll: 0 },
      { pitch: 0, yaw: 0, roll: 0.1 },
    ]) {
      const fm = ship();
      expect(frame(fm, new Vector3(0, 1e6, 0), p)).toBe('pilot');
    }
  });

  it('Given the pilot flies away from the target for 1 s and lets go, Then steering resumes and reacquires', () => {
    const fm = ship();
    const target = new Vector3(0, 1e6, 0);
    for (let i = 0; i < 60; i++) frame(fm, target, { pitch: -1, yaw: 0, roll: 0 });
    const away = noseErrorRad(fm, target);
    expect(away).toBeGreaterThan(90 * DEG);
    expect(frame(fm, target, HANDS_OFF)).toBe('steer');
    for (let i = 0; i < 8 * 60; i++) frame(fm, target, HANDS_OFF);
    expect(noseErrorRad(fm, target)).toBeLessThan(1 * DEG);
  });
});
