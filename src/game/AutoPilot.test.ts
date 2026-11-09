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
import { EXHAUST_VELOCITY_KMS, PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
import { autoLandVerdict, landingEstimateKg } from '@/ui/propellantReadout';

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
  /** v3 T3: what AutoPilot reads of the cruise module (busy = drive or settle running). */
  cruise: { busy: boolean };
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
  const cruise = { busy: false };
  const ap = new AutoPilot({ universe: world, warp, cruise, preset: () => FLIGHT_PRESETS[preset.id] });
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
    cruise,
    logs,
    tick(n = 1) {
      for (let i = 0; i < n; i++) {
        // v3 T3: the engine's frame order. Universe integrates first, and its
        // slice loop steps the autopilot before each slice (`sliceStep`);
        // then Pilot copies the stick into the command; then AutoPilot.update
        // judges the pilot's hands, engages, and hands back.
        ap.sliceStep(1 / 60);
        fm.update(1 / 60);
        fm.applyInput(input.axes, input.held('boost'), input.held('brake'));
        ap.update(1 / 60, ctx);
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
    // [v3-T2] the flip is flown at the D0 pitch maximum (35°/s); [v3-T3] the
    // attitude setpoint swings at 25°/s, so the 180° flip to retrograde takes
    // ~7 s before the burn: 10 s, not 4.
    h.tick(600);
    expect(h.ap.active).toBe(true);
    // 10 s of deorbit burn out of a ~1 km/s orbit must have taken horizontal
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

// ---------------------------------------------------------------------------
// review-p4: hand-backs the first cut missed
// ---------------------------------------------------------------------------

describe('review-p4: the leg ends when something else takes the ship', () => {
  it('Given an engaged landing, When the recovery cut puts the ship back in orbit (RETURN TO ORBIT keeps the same parent), Then the autopilot disengages instead of diving straight back in', () => {
    const h = harness();
    h.input.press('land');
    h.tick(60);
    expect(h.ap.active).toBe(true);
    bus.emit('ship:recovered', { cause: 'requested' });
    expect(h.ap.active).toBe(false);
    expect(h.logs).toContain('AUTOPILOT DISENGAGED');
    h.tick(60);
    expect(h.ap.active).toBe(false);
  });

  it('Given an engaged landing (FA was ON at engage), When Z turns FA back on mid-leg, Then the autopilot disengages that frame and FA stays ON — the computer never flies raw thrust through the assist', () => {
    const h = harness();
    h.input.press('land');
    h.tick(60);
    expect(h.fm.flightAssist).toBe(false);
    h.fm.flightAssist = true; // Pilot handles Z before AutoPilot runs
    h.tick();
    expect(h.ap.active).toBe(false);
    expect(h.fm.flightAssist).toBe(true);
    expect(h.logs).toContain('AUTOPILOT DISENGAGED');
  });

  it('Given an engaged landing from an FA-OFF pilot, When Z turns FA on mid-leg, Then the pilot gets the FA they just asked for, not the one saved at engage', () => {
    const h = harness();
    h.fm.flightAssist = false;
    h.input.press('land');
    h.tick(60);
    h.fm.flightAssist = true;
    h.tick();
    expect(h.ap.active).toBe(false);
    expect(h.fm.flightAssist).toBe(true);
  });

  it('Given an engaged landing with FA saved ON, When the pause sheet switches to NEWTONIAN, Then the autopilot disengages and FA follows the preset (OFF), not the saved ON', () => {
    const h = harness();
    expect(h.fm.flightAssist).toBe(true);
    h.input.press('land');
    h.tick(60);
    h.preset.id = 'newtonian';
    h.fm.flightAssist = false; // what Pause applies with the preset
    h.tick();
    expect(h.ap.active).toBe(false);
    expect(h.fm.flightAssist).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// v3 T3: L during cruise is queued (PLAN §2 D)
// ---------------------------------------------------------------------------

describe('v3: L during cruise is queued, not refused', () => {
  /** Cruise carrying the ship: FlightModel under a ceiling, the module busy. */
  function cruising(): Harness {
    const h = harness();
    h.fm.setCruise(50);
    h.cruise.busy = true;
    return h;
  }
  /** The drive lets go (Cruise.ts: drop → insertion → settle → idle). */
  function cruiseEnds(h: Harness): void {
    h.fm.setCruise(null);
    h.cruise.busy = false;
  }

  it('Given the cruise drive carrying the ship, When L is pressed, Then the landing is QUEUED (logged) and nothing engages yet', () => {
    const h = cruising();
    h.input.press('land');
    h.tick();
    expect(h.ap.active).toBe(false);
    expect(h.ap.queued).toBe(true);
    expect(h.logs.some((l) => l.includes('AUTOPILOT') && l.includes('QUEUED'))).toBe(true);
    expect(h.logs.some((l) => l.includes('DENIED'))).toBe(false);
  });

  it('Given a queued landing, While cruise is still busy (dropping or settling) though no longer cruising, Then it waits', () => {
    const h = cruising();
    h.input.press('land');
    h.tick();
    h.fm.setCruise(null); // handed over, but the settle is still turning the ship
    h.tick(5);
    expect(h.ap.active).toBe(false);
    expect(h.ap.queued).toBe(true);
  });

  it('Given a queued landing, When cruise goes idle with a parent in range, Then the autopilot engages a LANDING by itself', () => {
    const h = cruising();
    h.input.press('land');
    h.tick();
    cruiseEnds(h);
    h.tick();
    expect(h.ap.queued).toBe(false);
    expect(h.ap.active).toBe(true);
    expect(h.ap.goal).toBe('land');
    expect(h.logs.some((l) => l.startsWith('AUTOPILOT ENGAGED') && l.includes('LANDING'))).toBe(true);
  });

  it('Given a queued landing, When cruise goes idle with NO parent world, Then it is dropped with NO WORLD IN RANGE — the queue is not a loop', () => {
    const h = cruising();
    h.input.press('land');
    h.tick();
    h.world.shipParent = null;
    cruiseEnds(h);
    h.tick();
    expect(h.ap.active).toBe(false);
    expect(h.ap.queued).toBe(false);
    expect(h.logs.some((l) => l.includes('NO WORLD IN RANGE'))).toBe(true);
  });

  it('Given a queued landing, When L is pressed again, Then the queue is cancelled and nothing engages when cruise ends', () => {
    const h = cruising();
    h.input.press('land');
    h.tick();
    h.input.press('land');
    h.tick();
    expect(h.ap.queued).toBe(false);
    cruiseEnds(h);
    h.tick(3);
    expect(h.ap.active).toBe(false);
  });

  it('Given a queued landing, When a jump starts, Then the queue is cancelled', () => {
    const h = cruising();
    h.input.press('land');
    h.tick();
    bus.emit('warp:engaged', {} as never);
    h.tick();
    expect(h.ap.queued).toBe(false);
    cruiseEnds(h);
    h.tick(3);
    expect(h.ap.active).toBe(false);
  });

  it('Given a queued landing under a preset without an autopilot, When L is pressed, Then it is refused outright (PRESET), not queued', () => {
    const h = cruising();
    h.preset.id = 'pilot';
    h.input.press('land');
    h.tick();
    expect(h.ap.queued).toBe(false);
    expect(h.logs.some((l) => l.includes('NOT FITTED'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v3 T3: the autopilot flies per sim slice (PLAN §2 D)
// ---------------------------------------------------------------------------

describe('v3: the autopilot is stepped per sim slice', () => {
  it('Given an engaged autopilot, When Universe runs ten slices in one frame (10×), Then the computer writes a fresh command before each one — not one command for the whole frame', () => {
    const h = harness();
    h.input.press('land');
    h.tick(30);
    expect(h.ap.active).toBe(true);
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) {
      h.fm.command.pitch = 99; // poison: sliceStep must overwrite it
      h.ap.sliceStep(1 / 60);
      seen.push(h.fm.command.pitch);
      h.fm.update(1 / 60);
    }
    expect(seen.every((p) => p !== 99 && Math.abs(p) <= 1)).toBe(true);
  });

  it('Given no autopilot engaged, When a slice is stepped, Then the command is left alone (the pilot’s)', () => {
    const h = harness();
    h.fm.command.pitch = 0.3;
    h.ap.sliceStep(1 / 60);
    expect(h.fm.command.pitch).toBe(0.3);
  });

  it('Given AutoPilot.update with the autopilot engaged and hands off, Then update itself does not fly (Universe’s slices do) — a frame is one guidance step per slice, never an extra one', () => {
    const h = harness();
    h.input.press('land');
    h.tick(30);
    const ctx = { input: h.input, elapsed: 0 } as unknown as EngineContext;
    h.fm.command.pitch = 0.123;
    h.ap.update(1 / 60, ctx);
    expect(h.fm.command.pitch).toBe(0.123);
  });

  it('Given the leg completing inside a slice (touchdown), Then the autopilot disengages there and logs LANDED once', () => {
    const h = harness();
    h.input.press('land');
    h.tick(60 * 600);
    expect(h.ap.active).toBe(false);
    expect(h.logs.filter((l) => l === 'AUTOPILOT OFF — LANDED').length).toBe(1);
  });

  // review-v3b: Universe re-parents the ship AFTER each slice (updateShipParent),
  // but AutoPilot.update — which ends the leg on an SOI change — runs once per
  // frame. At 10× the remaining slices of that frame were flown with the old
  // world's radius and μ against a state vector already in the new frame.
  it('Given an engaged leg at 10×, When a slice carries the ship across an SOI boundary, Then the very next slice ends the leg instead of flying the new frame with the old world', () => {
    const h = harness();
    h.input.press('land');
    h.tick(30);
    expect(h.ap.active).toBe(true);
    // Universe's slice loop: the parent changed after the previous slice.
    h.world.shipParent = { spec: { name: 'Fyss I a', radius: 50, atmosphere: null }, frame: { mu: 5 } };
    h.ap.sliceStep(1 / 60);
    expect(h.ap.active).toBe(false);
    expect(h.logs).toContain('AUTOPILOT DISENGAGED');
    // Handed back clean: the computer's lever is not left burning in the new frame.
    expect(h.fm.command.throttle).toBe(0);
  });

  it('Given an engaged leg, Then its phase is readable by TimeControl (phase getter)', () => {
    const h = harness();
    expect(h.ap.phase).toBe('idle');
    h.input.press('land');
    h.tick();
    expect(h.ap.phase).not.toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// v4 sub-plan 1 (propellant), Task 5 — the autopilot checks the tank before a
// landing, and lets go when the tank runs dry.
// ---------------------------------------------------------------------------

describe('v4: the autopilot checks propellant before landing', () => {
  /** Attach a tank holding `ratio` × the landing estimate for this hull. */
  function tankAt(h: Harness, ratio: number): number {
    h.fm.attachPropellant(new Propellant(PROBE_TANK_CAPACITY_KG, 1), EXHAUST_VELOCITY_KMS);
    const need = landingEstimateKg(h.fm);
    h.fm.propellant!.massKg = Math.min(PROBE_TANK_CAPACITY_KG, ratio * need);
    return need;
  }

  function toneLogs(): Array<{ text: string; tone?: string }> {
    const out: Array<{ text: string; tone?: string }> = [];
    offs.push(bus.on('log', (e) => out.push(e)));
    return out;
  }

  it('Given propellant below half the landing estimate, When L is pressed, Then autopilot does not engage and logs "AUTOPILOT · PROPELLANT LOW"', () => {
    const h = harness();
    tankAt(h, 0.4);
    expect(autoLandVerdict(h.fm.propellant!.massKg, landingEstimateKg(h.fm))).toBe('refuse');
    h.input.press('land');
    h.tick();
    expect(h.ap.active).toBe(false);
    expect(h.logs).toContain('AUTOPILOT · PROPELLANT LOW');
    expect(h.logs.some((l) => l.startsWith('AUTOPILOT ENGAGED'))).toBe(false);
  });

  it('Given marginal propellant, When L is pressed, Then it engages with a caution log', () => {
    const h = harness();
    const logs = toneLogs();
    tankAt(h, 0.75);
    expect(autoLandVerdict(h.fm.propellant!.massKg, landingEstimateKg(h.fm))).toBe('marginal');
    h.input.press('land');
    h.tick();
    expect(h.ap.active).toBe(true);
    expect(h.ap.goal).toBe('land');
    expect(logs.some((l) => l.tone === 'warn' && l.text.includes('PROPELLANT'))).toBe(true);
  });

  it('Given propellant at or above the landing estimate, When L is pressed, Then it engages with no propellant warning', () => {
    const h = harness();
    tankAt(h, 1.5);
    expect(autoLandVerdict(h.fm.propellant!.massKg, landingEstimateKg(h.fm))).toBe('go');
    h.input.press('land');
    h.tick();
    expect(h.ap.active).toBe(true);
    expect(h.logs.some((l) => l.includes('PROPELLANT'))).toBe(false);
  });

  it('Given autopilot engaged, When the tank runs dry (thrustStarved), Then autopilot disengages with "AUTOPILOT OFF · PROPELLANT" and never re-engages by itself', () => {
    const h = harness();
    tankAt(h, 1e6); // clamped to a full tank: the check is a GO
    h.input.press('land');
    // Past the flip (~7 s) and into the burn, where thrust is wanted.
    h.tick(600);
    expect(h.ap.active).toBe(true);

    h.fm.propellant!.massKg = 0;
    let starvedSeen = false;
    for (let i = 0; i < 120 && h.ap.active; i++) {
      h.tick();
      starvedSeen ||= h.fm.thrustStarved;
    }
    expect(starvedSeen).toBe(true);
    expect(h.ap.active).toBe(false);
    expect(h.logs).toContain('AUTOPILOT OFF · PROPELLANT');

    // Never by itself: not on the next frames, not even once the tank is refilled.
    h.tick(120);
    expect(h.ap.active).toBe(false);
    h.fm.propellant!.massKg = PROBE_TANK_CAPACITY_KG;
    h.tick(120);
    expect(h.ap.active).toBe(false);
    expect(h.logs.filter((l) => l.startsWith('AUTOPILOT ENGAGED'))).toHaveLength(1);
  });
});
