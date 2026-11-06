/**
 * v2 phase 4 (P4) — the `L` key, wired: engage, refuse, and hand back.
 *
 * The module is exercised with stubs for the universe, the input and the
 * jump drive, and the REAL FlightModel. The flying itself is proven in
 * `ship/autopilot.test.ts`; this file is about the contract with the pilot:
 *
 * - L engages (land from flight, orbit from the ground) and says so.
 * - L again, or ANY stick / lever / strafe / brake / boost input, disengages
 *   on that same frame with "AUTOPILOT DISENGAGED" — the pilot always wins.
 * - Where it cannot help it refuses with a reason, and changes nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import type { ActionName, InputAxes } from '@/core/Input';
import { DEFAULT_SHIP_CONFIG, FlightModel } from '@/ship/FlightModel';
import { AutoPilot, type AutoPilotWorld } from './AutoPilot';
import { FLIGHT_PRESETS, type FlightPresetId } from './flightPreset';
import { pilotIntervened } from '@/ship/autopilot';

const R = 1_000;
const MU = 1_500;

class StubInput {
  readonly axes: InputAxes = { pitch: 0, yaw: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0, strafeZ: 0 };
  readonly down = new Set<string>();
  readonly heldActions = new Set<ActionName>();
  private presses = new Set<ActionName>();
  lever = 0;
  press(a: ActionName): void {
    this.presses.add(a);
  }
  pressed(a: ActionName): boolean {
    return this.presses.has(a);
  }
  held(a: ActionName): boolean {
    return this.heldActions.has(a);
  }
  isDown(code: string): boolean {
    return this.down.has(code);
  }
  setThrottle(v: number): void {
    this.lever = v;
  }
  endFrame(): void {
    this.presses.clear();
  }
}

interface Harness {
  ap: AutoPilot;
  fm: FlightModel;
  input: StubInput;
  world: { -readonly [K in keyof AutoPilotWorld]: AutoPilotWorld[K] };
  warp: { phase: string };
  preset: { id: FlightPresetId };
  logs: string[];
  tick(n?: number): void;
}

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

function harness(opts: { grounded?: boolean } = {}): Harness {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  const frame = { position: new Vector3(), velocity: new Vector3(), mu: MU, radius: R };
  fm.setParent(frame);
  fm.setGroundSampler((p) => p.length() - R);
  fm.flightAssist = true;
  if (opts.grounded) {
    fm.teleport(new Vector3(0, R, 0));
  } else {
    const p = new Vector3(1.6 * R, 0, 0);
    fm.teleport(p, fm.orbitalVelocityAt(p), new Quaternion());
  }
  fm.update(1 / 60);

  const world: Harness['world'] = {
    flight: fm,
    paused: false,
    frozen: false,
    shipParent: {
      spec: { name: 'Fyss I', radius: R, atmosphere: null },
      frame,
    },
  };
  const warp = { phase: 'idle' };
  const preset = { id: 'survey' as FlightPresetId };
  const input = new StubInput();
  const ap = new AutoPilot({ universe: world, warp, preset: () => FLIGHT_PRESETS[preset.id] });
  const logs: string[] = [];
  offs.push(bus.on('log', ({ text }) => logs.push(text)));
  const ctx = { input, elapsed: 0 } as unknown as EngineContext;
  ap.init();

  return {
    ap,
    fm,
    input,
    world,
    warp,
    preset,
    logs,
    tick(n = 1) {
      for (let i = 0; i < n; i++) {
        // Pilot copies the stick into the command first, as in the game.
        fm.applyInput(input.axes, input.held('boost'), input.held('brake'));
        ap.update(1 / 60, ctx);
        fm.update(1 / 60);
        input.endFrame();
      }
    },
  };
}

describe('L engages the autopilot', () => {
  it('Given SURVEY in orbit near a world, When L is pressed, Then it engages a LANDING and logs it', () => {
    const h = harness();
    h.input.press('land');
    h.tick();
    expect(h.ap.active).toBe(true);
    expect(h.ap.goal).toBe('land');
    expect(h.logs.some((l) => l.startsWith('AUTOPILOT') && l.includes('LAND'))).toBe(true);
  });

  it('Given SURVEY on the ground, When L is pressed, Then it engages TO ORBIT', () => {
    const h = harness({ grounded: true });
    expect(h.fm.grounded).toBe(true);
    h.input.press('land');
    h.tick();
    expect(h.ap.active).toBe(true);
    expect(h.ap.goal).toBe('orbit');
    expect(h.logs.some((l) => l.startsWith('AUTOPILOT') && l.includes('ORBIT'))).toBe(true);
  });

  it('Given an engaged autopilot, Then it is the computer that writes the command (pilot hands-off), and it flies with thrust', () => {
    const h = harness();
    h.input.press('land');
    h.tick(240);
    expect(h.ap.active).toBe(true);
    // 4 s of deorbit burn out of a ~1 km/s orbit must have taken horizontal
    // speed off. (Total speed rises: the suicide burn dives first.)
    const up = h.fm.position.clone().normalize();
    const horizontal = h.fm.velocity.clone().addScaledVector(up, -h.fm.velocity.dot(up)).length();
    expect(horizontal).toBeLessThan(Math.sqrt(MU / (1.6 * R)) - 0.05);
    expect(h.fm.verticalSpeed).toBeLessThan(0);
  });

  it('Given an engaged autopilot, When L is pressed again, Then it disengages with "AUTOPILOT DISENGAGED" and FA is restored', () => {
    const h = harness();
    h.input.press('land');
    h.tick(30);
    h.input.press('land');
    h.tick();
    expect(h.ap.active).toBe(false);
    expect(h.logs).toContain('AUTOPILOT DISENGAGED');
    expect(h.fm.flightAssist).toBe(true);
  });
});

describe('the pilot always wins', () => {
  const cases: Array<[string, (h: Harness) => void]> = [
    ['the stick pitched', (h) => (h.input.axes.pitch = 0.6)],
    ['the stick yawed', (h) => (h.input.axes.yaw = -0.4)],
    ['a roll key', (h) => (h.input.axes.roll = 1)],
    ['W held (throttle)', (h) => h.input.down.add('KeyW')],
    ['S held (throttle)', (h) => h.input.down.add('KeyS')],
    ['the lever moved up (wheel)', (h) => (h.input.axes.throttle = 0.2)],
    ['X (throttle zero)', (h) => h.input.press('zeroThrottle')],
    ['a strafe key', (h) => (h.input.axes.strafeX = 1)],
    ['brake held', (h) => h.input.heldActions.add('brake')],
    ['boost held', (h) => h.input.heldActions.add('boost')],
  ];
  for (const [what, touch] of cases) {
    it(`Given an engaged autopilot, When ${what}, Then it disengages that same frame with "AUTOPILOT DISENGAGED"`, () => {
      const h = harness();
      h.input.press('land');
      h.tick(20);
      expect(h.ap.active).toBe(true);
      touch(h);
      h.tick();
      expect(h.ap.active).toBe(false);
      expect(h.logs).toContain('AUTOPILOT DISENGAGED');
    });
  }

  it('Given the mouse stick still deflected when L was pressed, When it merely recentres on its own, Then that is NOT a takeover', () => {
    const h = harness();
    h.input.axes.pitch = 0.5;
    h.input.press('land');
    h.tick();
    for (let i = 0; i < 30; i++) {
      h.input.axes.pitch = Math.max(0, h.input.axes.pitch - 0.01);
      h.tick();
    }
    expect(h.ap.active).toBe(true);
  });

  it('Given the lever easing down to the zero the autopilot set, Then that is NOT a takeover', () => {
    const h = harness();
    h.input.axes.throttle = 0.4;
    h.input.press('land');
    h.tick();
    expect(h.input.lever).toBe(0);
    for (let i = 0; i < 30; i++) {
      h.input.axes.throttle *= 0.9;
      h.tick();
    }
    expect(h.ap.active).toBe(true);
  });
});

describe('pilotIntervened (pure)', () => {
  const still: InputAxes = { pitch: 0, yaw: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0, strafeZ: 0 };
  const quiet = { throttleKeys: false, brake: false, boost: false, zeroThrottle: false };
  it('Given nothing moving, Then no intervention', () => {
    expect(pilotIntervened(still, still, quiet)).toBe(false);
  });
  it('Given a deflection that grows past the deadzone, Then intervention', () => {
    expect(pilotIntervened({ ...still, yaw: 0.2 }, still, quiet)).toBe(true);
  });
  it('Given a deflection that shrinks, Then no intervention', () => {
    expect(pilotIntervened({ ...still, yaw: 0.2 }, { ...still, yaw: 0.25 }, quiet)).toBe(false);
  });
  it('Given any throttle key, brake, boost or X, Then intervention', () => {
    for (const k of ['throttleKeys', 'brake', 'boost', 'zeroThrottle'] as const) {
      expect(pilotIntervened(still, still, { ...quiet, [k]: true })).toBe(true);
    }
  });
});

describe('refusals', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('Given the PILOT preset, When L is pressed, Then it refuses (no autopilot fitted) and does not engage', () => {
    h.preset.id = 'pilot';
    h.input.press('land');
    h.tick();
    expect(h.ap.active).toBe(false);
    expect(h.logs.some((l) => l.includes('AUTOPILOT') && l.includes('PILOT'))).toBe(true);
  });

  it('Given the NEWTONIAN preset, When L is pressed, Then it refuses', () => {
    h.preset.id = 'newtonian';
    h.input.press('land');
    h.tick();
    expect(h.ap.active).toBe(false);
    expect(h.logs.some((l) => l.includes('AUTOPILOT') && l.includes('NEWTONIAN'))).toBe(true);
  });

  it('Given the cruise drive carrying the ship, When L is pressed, Then it refuses with CRUISE', () => {
    h.fm.setCruise(50);
    h.input.press('land');
    h.tick();
    expect(h.ap.active).toBe(false);
    expect(h.logs.some((l) => l.includes('AUTOPILOT') && l.includes('CRUISE'))).toBe(true);
  });

  it('Given a jump in progress, When L is pressed, Then it refuses with JUMP', () => {
    h.warp.phase = 'charging';
    h.input.press('land');
    h.tick();
    expect(h.ap.active).toBe(false);
    expect(h.logs.some((l) => l.includes('AUTOPILOT') && l.includes('JUMP'))).toBe(true);
  });

  it('Given no world (the star is the parent), When L is pressed, Then it refuses with NO WORLD IN RANGE', () => {
    h.world.shipParent = null;
    h.input.press('land');
    h.tick();
    expect(h.ap.active).toBe(false);
    expect(h.logs.some((l) => l.includes('NO WORLD IN RANGE'))).toBe(true);
  });

  it('Given an engaged autopilot, When a jump starts, Then it disengages', () => {
    h.input.press('land');
    h.tick(10);
    h.warp.phase = 'charging';
    h.tick();
    expect(h.ap.active).toBe(false);
  });

  it('Given an engaged autopilot, When the preset is switched to PILOT, Then it disengages', () => {
    h.input.press('land');
    h.tick(10);
    h.preset.id = 'pilot';
    h.tick();
    expect(h.ap.active).toBe(false);
  });
});
