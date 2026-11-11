/**
 * v4 mining — fly among the rocks (owner playtest, binding decision 1 + 2).
 *
 * Playtest: after cruise drops you co-moving ~30 km past a belt field's edge,
 * the rocks "run away" the moment you manoeuvre, and K refuses. Cause: a
 * field has no SOI, so the ship's parent is the STAR; FA's lever hold, the
 * detent and Space-stop are all measured against the star, so a small W holds
 * ~0.2 km/s relative to the star — the ship sheds the field's ~18 km/s orbital
 * velocity and the whole field slides away. And formation needs a rock within
 * 50 km, while the drop leaves you 50–110 km from them.
 *
 * Decision 1 — the FIELD FRAME: within FIELD_FRAME_KM (300 km) of the nearest
 * field's centre (entered at ≤ 300, left beyond 330 — hysteresis) the FA
 * reference velocity is the field's velocity, made parent-relative. Lever
 * hold, the detent and Space-stop are relative to the field; the HUD's VEL
 * value and label are relative to the field (`VEL BELT · FYSS 398`).
 * Formation (K) overrides it while held. Leaving the frame is v3 again. ONE
 * module owns `FlightModel.assistReferenceVelocity` (FlightSense).
 *
 * Decision 2 — K in the field: formation on an asteroid is allowed anywhere
 * inside the field frame (not limited to 50 km); vessels keep the 50 km rule.
 *
 * World: the real start system (Fyss, beltFixture), field 398 on a live orbit
 * clock, a real Belt and a real FlightModel parented to the star (as after a
 * field drop: Cruise.field.test.ts), and the real FlightSense.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import type { InputAxes } from '@/core/Input';
import { FIELD_RADIUS_KM } from '@/gen/belt';
import { SOLAR_RADIUS } from '@/gen/types';
import { DEFAULT_SHIP_CONFIG, FlightModel, type ParentBody } from '@/ship/FlightModel';
import { FORMATION_RANGE_KM, mayHoldFormation } from '@/ship/formation';
import { beltTargetName } from '@/game/Belt';
import { beltRig, fieldCentre, fieldVelocity, fyssBelt, fyssField, startSystem } from '@/game/testing/beltFixture';
import { FlightSense, type FlightSenseOptions } from './FlightSense';
import { Instruments, type InstrumentsOptions } from './Instruments';
import type { HudInstruments } from '@/ui/Hud';

const H = 1 / 60;
const FIELD_K = 398;
/** Owner decision 1: enter the field frame within this centre distance, km. */
const FIELD_FRAME_KM = 300;
/** …and leave it only beyond this one (hysteresis), km. */
const FIELD_FRAME_EXIT_KM = 330;
/** Where a field drop leaves the ship: ~30 km past the edge (Cruise.field.test.ts). */
const DROP_KM = FIELD_RADIUS_KM + 30;

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  vi.unstubAllGlobals();
});

function facing(dir: Vector3): Quaternion {
  return new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir.clone().normalize());
}

interface Vessel {
  id: string;
  /** World position relative to the ship, km (fixed while the test runs). */
  offset: Vector3;
  /** Velocity relative to the field, km/s. */
  relVel: Vector3;
}

interface RigOptions {
  /** Ship position relative to the field centre (default: radially out, DROP_KM). */
  readonly offset?: Vector3;
  /** Ship velocity relative to the field's, km/s (default: co-moving). */
  readonly relVel?: Vector3;
  /** Nose direction (default: at the field centre). */
  readonly nose?: Vector3;
  readonly targetId?: string | null;
  readonly vessel?: Vessel;
  /** Universe.shipParent's world velocity as FlightSense sees it (default: none — the star). */
  readonly parentWorldVel?: Vector3 | null;
}

/** The ship at a field (real Belt, live clock), FA on, FlightSense in the loop. */
function fieldRig(opts: RigOptions = {}) {
  const sys = startSystem();
  const field = fyssField(FIELD_K);
  const starR = sys.stars[0]!.radius * SOLAR_RADIUS;
  const b = beltRig(sys);

  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  const star: ParentBody = { position: new Vector3(), velocity: new Vector3(), mu: fyssBelt().starMu, radius: starR };
  fm.setParent(star);
  const centre0 = fieldCentre(field, 0);
  const out = centre0.clone().normalize();
  const pos = centre0.clone().add(opts.offset ?? out.clone().multiplyScalar(DROP_KM));
  const vel = fieldVelocity(field, 0).add(opts.relVel ?? new Vector3());
  fm.teleport(pos, vel, facing(opts.nose ?? centre0.clone().sub(pos)));
  fm.flightAssist = true;

  const targeting = { targetId: opts.targetId ?? null };
  const vessel = opts.vessel ?? null;
  const fieldVelNow = (): Vector3 => {
    const v = new Vector3();
    expect(b.belt.fieldVelocity(field.id, v)).toBe(true);
    return v;
  };
  const centreNow = (): Vector3 => {
    const c = new Vector3();
    expect(b.belt.fieldWorld(field.id, c)).toBe(true);
    return c;
  };
  const noop = (): void => undefined;
  const universe = {
    flight: fm,
    shipParent: opts.parentWorldVel ? { worldVelocity: opts.parentWorldVel } : null,
  };
  const fsOpts = {
    universe,
    cruise: { drive: { phase: 'idle', capKmS: 0 } },
    traffic: {
      loudest: () => null,
      vesselVelocity: (id: string, o: Vector3) => (vessel && id === vessel.id ? (o.copy(fieldVelNow()).add(vessel.relVel), true) : false),
      vesselWorld: (id: string, o: Vector3) => (vessel && id === vessel.id ? (o.copy(fm.worldPosition).add(vessel.offset), true) : false),
    },
    targeting,
    audio: { setCruise: noop, setRcs: noop, setVesselProximity: noop, setHullStress: noop },
    sky: { setDriveField: noop },
    belt: b.belt,
  } as unknown as FlightSenseOptions;
  const fs = new FlightSense(fsOpts);
  const logs: string[] = [];
  offs.push(bus.on('log', ({ text }) => logs.push(text)));

  const axes: InputAxes = { pitch: 0, yaw: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0, strafeZ: 0 };
  const ctx = {} as EngineContext;
  const r = {
    fm,
    fs,
    b,
    field,
    targeting,
    axes,
    brake: false,
    logs,
    centreNow,
    fieldVelNow,
    /** |v_ship − v_field|, km/s (the star is the flight model's parent and stands still). */
    relSpeed: (): number => fm.velocity.clone().sub(fieldVelNow()).length(),
    /** One engine frame in the registry's order: Universe, Belt, Pilot, FlightSense. */
    frame: (): void => {
      b.world.orbitSeconds += H;
      fm.update(H);
      b.world.flight.worldPosition.copy(fm.worldPosition);
      b.frame();
      fm.applyInput(axes, false, r.brake);
      fs.update(H, ctx);
    },
    step: (seconds: number): void => {
      for (let t = 0; t < seconds - 1e-9; t += H) r.frame();
    },
    pressK: (): void => {
      (fs as unknown as { wantToggle: boolean }).wantToggle = true;
      fs.update(H, ctx);
    },
    /** Put the ship `km` from the field centre now (radially out), co-moving. */
    placeAt: (km: number): void => {
      const c = centreNow();
      const p = c.clone().add(c.clone().normalize().multiplyScalar(km));
      fm.teleport(p, fieldVelNow(), facing(c.clone().sub(p)));
      b.world.flight.worldPosition.copy(fm.worldPosition);
      b.frame();
      fs.update(H, ctx);
    },
  };
  // Frame 0: the Belt and FlightSense have seen the ship before the first integration.
  b.world.flight.worldPosition.copy(fm.worldPosition);
  b.frame();
  fs.update(H, ctx);
  return r;
}

type Rig = ReturnType<typeof fieldRig>;

/** FlightSense's field frame (the field id it references FA to, or null). */
function frameOf(r: Rig): string | null {
  return (r.fs as unknown as { fieldFrame: string | null | undefined }).fieldFrame ?? null;
}

/** Rocks of field 398 by SURFACE distance from the ship now, nearest first. */
function rocksBySurface(r: Rig): Array<{ id: string; km: number; radiusKm: number }> {
  const w = new Vector3();
  return r.field.asteroids
    .map((a) => {
      expect(r.b.belt.asteroidWorld(a.id, w)).toBe(true);
      return { id: a.id, km: w.distanceTo(r.fm.worldPosition) - a.radiusKm, radiusKm: a.radiusKm };
    })
    .sort((x, y) => x.km - y.km);
}

// ---------------------------------------------------------------------------
// Decision 1 — the field frame: enter / leave with hysteresis
// ---------------------------------------------------------------------------

describe('field frame: the rule (pure, src/game/fieldFrame.ts)', () => {
  it('Given the owner decision, Then FIELD_FRAME_KM is 300 and the exit radius is 330', async () => {
    const m = await import('./fieldFrame');
    expect(m.FIELD_FRAME_KM).toBe(FIELD_FRAME_KM);
    expect(m.FIELD_FRAME_EXIT_KM).toBe(FIELD_FRAME_EXIT_KM);
  });

  it('Given outside the frame, When the centre distance falls to 300 km (inclusive), Then the frame is entered — not at 300.001 km', async () => {
    const { fieldFrameHeld } = await import('./fieldFrame');
    expect(fieldFrameHeld(false, 310)).toBe(false);
    expect(fieldFrameHeld(false, 300.001)).toBe(false);
    expect(fieldFrameHeld(false, 300)).toBe(true);
    expect(fieldFrameHeld(false, 12)).toBe(true);
  });

  it('Given inside the frame, When the centre distance rises past 300 but stays ≤ 330 km, Then it is kept; beyond 330 km it is left', async () => {
    const { fieldFrameHeld } = await import('./fieldFrame');
    expect(fieldFrameHeld(true, 301)).toBe(true);
    expect(fieldFrameHeld(true, 330)).toBe(true);
    expect(fieldFrameHeld(true, 330.001)).toBe(false);
  });

  it('Given a non-finite distance (no field), Then never in the frame', async () => {
    const { fieldFrameHeld } = await import('./fieldFrame');
    expect(fieldFrameHeld(true, Number.NaN)).toBe(false);
    expect(fieldFrameHeld(false, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('field frame: FlightSense enters and leaves it (real Belt, field 398)', () => {
  it('Given a field drop (~110 km from the centre, co-moving), Then FlightSense is in the field frame of field 398 and the FA reference is the field velocity (star frame: no parent body)', () => {
    const r = fieldRig();
    expect(r.b.belt.nearestField()?.id).toBe(r.field.id);
    expect(frameOf(r)).toBe(r.field.id);
    const ref = r.fm.assistReferenceVelocity;
    expect(ref, 'no FA reference inside the field frame').not.toBeNull();
    expect(ref!.distanceTo(r.fieldVelNow())).toBeLessThan(1e-6);
  });

  it('Given a parent body with a world velocity, Then the reference is the field velocity minus the parent’s (the flight model’s frame)', () => {
    const parentVel = new Vector3(3.2, -0.4, 1.1);
    const r = fieldRig({ parentWorldVel: parentVel });
    const want = r.fieldVelNow().sub(parentVel);
    expect(r.fm.assistReferenceVelocity).not.toBeNull();
    expect(r.fm.assistReferenceVelocity!.distanceTo(want)).toBeLessThan(1e-6);
  });

  it('Given the ship walked out and in across 300 / 330 km, Then the frame follows the hysteresis: 310 out → 299 in → 320 in → 329 in → 331 out → 320 out → 299 in', () => {
    const r = fieldRig();
    // Start well outside (the rig starts at the drop point, inside).
    r.placeAt(400);
    expect(frameOf(r)).toBeNull();
    const seen: Array<[number, boolean]> = [];
    for (const km of [310, 299, 320, 329, 331, 320, 299]) {
      r.placeAt(km);
      expect(r.b.belt.nearestField()?.id).toBe(r.field.id);
      seen.push([km, frameOf(r) === r.field.id]);
    }
    expect(seen).toEqual([
      [310, false],
      [299, true],
      [320, true],
      [329, true],
      [331, false],
      [320, false],
      [299, true],
    ]);
  });

  it('Given the ship leaves the frame (beyond 330 km), Then the FA reference is gone (v3: relative to the parent again)', () => {
    const r = fieldRig();
    expect(frameOf(r)).toBe(r.field.id);
    r.placeAt(400);
    expect(frameOf(r)).toBeNull();
    expect(r.fm.assistReferenceVelocity).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Decision 1 — flying in the frame
// ---------------------------------------------------------------------------

describe('field frame: the field stays where you left it', () => {
  it('Given a field drop, When W holds a small lever for 30 s, Then the ship moves relative to the field centre by less than lever speed × 30 s + 1 km — it does not bleed off the field’s ~18 km/s orbital velocity', () => {
    const r = fieldRig();
    const rel0 = r.fm.worldPosition.clone().sub(r.centreNow());
    r.axes.throttle = 0.05;
    r.step(0.5);
    expect(r.fm.assistState).toBe('hold');
    const lever = r.fm.assistTargetKmS;
    expect(lever).toBeGreaterThan(0);
    expect(lever).toBeLessThan(1); // a small setting
    r.step(29.5);
    const rel1 = r.fm.worldPosition.clone().sub(r.centreNow());
    expect(rel1.distanceTo(rel0)).toBeLessThan(lever * 30 + 1);
    // …and the speed it holds is the lever's, relative to the field.
    expect(Math.abs(r.relSpeed() - lever)).toBeLessThan(0.02 * lever + 0.002);
  });

  it('Given drifting 0.2 km/s relative to the field, When Space (FA stop) is held for 20 s, Then the speed relative to the field is ~0 (< 0.002 km/s)', () => {
    const r = fieldRig({ relVel: new Vector3(0.12, -0.1, 0.12) });
    expect(r.relSpeed()).toBeGreaterThan(0.19);
    r.brake = true;
    r.step(20);
    expect(r.fm.assistState).toBe('stop');
    expect(r.relSpeed()).toBeLessThan(0.002);
  });

  it('Given drifting 0.05 km/s relative to the field, When the lever sits at its detent for 20 s, Then FA holds station on the field (hold, speed relative to it < 0.002 km/s)', () => {
    const r = fieldRig({ relVel: new Vector3(0, 0.05, 0) });
    r.axes.throttle = 0;
    r.step(20);
    expect(r.fm.assistState).toBe('hold');
    expect(r.relSpeed()).toBeLessThan(0.002);
  });

  it('Given the ship outside the frame (400 km), When W holds a small lever, Then it is v3: the hold is relative to the parent (the star), no reference', () => {
    const r = fieldRig();
    r.placeAt(400);
    r.axes.throttle = 0.05;
    r.step(2);
    expect(r.fm.assistReferenceVelocity).toBeNull();
    expect(r.fm.assistState).toBe('hold');
  });
});

describe('field frame: the HUD VEL is relative to the field', () => {
  function instrumentsFor(r: Rig) {
    vi.stubGlobal('document', { pointerLockElement: null });
    const packets: HudInstruments[] = [];
    const noop = (): void => undefined;
    const hud = {
      setInstruments: (p: HudInstruments) => packets.push({ ...p }),
      setAssist: noop,
      setPropellant: noop,
      clearPropellant: noop,
      setCargo: noop,
      setControlActivity: noop,
      setStickDeflection: noop,
      setCruise: noop,
    };
    const universe = {
      flight: r.fm,
      paused: false,
      shipParent: null,
      nearest: null,
      nearestAltitudeKm: null,
      nearestGapKm: Number.POSITIVE_INFINITY,
      system: startSystem(),
      cargo: null,
      allBodies: () => [],
    };
    const inst = new Instruments({
      universe,
      hud,
      fieldFrame: r.fs,
      belt: r.b.belt,
    } as unknown as InstrumentsOptions);
    const ctx = {
      camera: new PerspectiveCamera(60, 16 / 9, 0.001, 1e9),
      width: 1600,
      height: 900,
      input: { axes: r.axes, stickDeflection: { x: 0, y: 0 } },
    } as unknown as EngineContext;
    return {
      update: (): HudInstruments => {
        inst.update(H, ctx);
        return packets[packets.length - 1]!;
      },
    };
  }

  it('Given the ship in the field frame drifting 0.07 km/s relative to the field, Then VEL reads ~0.07 km/s and its label names the field (`VEL BELT · FYSS 398`)', () => {
    const r = fieldRig({ relVel: new Vector3(0.07, 0, 0) });
    expect(frameOf(r)).toBe(r.field.id);
    const p = instrumentsFor(r).update();
    expect(p.velFrame).toBe(beltTargetName(r.field.id, startSystem().name));
    expect(p.velFrame!.toUpperCase()).toBe(`BELT · ${startSystem().name.toUpperCase()} ${FIELD_K}`);
    // The VEL value: overrides the vitals speed, as altitudeKm overrides the vitals altitude.
    const speed = (p as HudInstruments & { speedKmS?: number | null }).speedKmS;
    expect(speed, 'Instruments publishes no field-relative VEL').not.toBeUndefined();
    expect(speed).not.toBeNull();
    expect(Math.abs(speed! - r.relSpeed())).toBeLessThan(1e-6);
    expect(Math.abs(speed! - 0.07)).toBeLessThan(1e-3);
  });

  it('Given the ship outside the frame, Then VEL is v3: no speed override, and the label names the star frame', () => {
    const r = fieldRig();
    r.placeAt(400);
    const p = instrumentsFor(r).update();
    const speed = (p as HudInstruments & { speedKmS?: number | null }).speedKmS;
    expect(speed ?? null).toBeNull();
    expect(p.velFrame).toBe(startSystem().name);
  });
});

// ---------------------------------------------------------------------------
// Decision 1 — one owner of assistReferenceVelocity; formation overrides
// ---------------------------------------------------------------------------

describe('field frame: one owner of the FA reference', () => {
  it('Given the source tree, Then exactly one module assigns FlightModel.assistReferenceVelocity (no two modules fighting per frame)', () => {
    const root = fileURLToPath(new URL('../', import.meta.url)); // src/
    const writers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('/testing/')) {
          const src = readFileSync(p, 'utf8');
          if (/\.assistReferenceVelocity\s*=(?!=)/.test(src)) writers.push(relative(root, p));
        }
      }
    };
    walk(root);
    expect(writers).toHaveLength(1);
  });

  it('Given formation held on a vessel inside the field frame, Then the reference is the vessel’s velocity (formation overrides the field)', () => {
    const vessel: Vessel = { id: 'ship:hauler', offset: new Vector3(4, 0, 0), relVel: new Vector3(0.08, 0, -0.03) };
    const r = fieldRig({ vessel, targetId: vessel.id });
    r.pressK();
    expect(r.fs.formation).toBe(vessel.id);
    const want = r.fieldVelNow().add(vessel.relVel);
    expect(r.fm.assistReferenceVelocity!.distanceTo(want)).toBeLessThan(1e-6);
  });

  it('Given formation released inside the field frame, Then the reference falls back to the field velocity — not to null', () => {
    const vessel: Vessel = { id: 'ship:hauler', offset: new Vector3(4, 0, 0), relVel: new Vector3(0.08, 0, -0.03) };
    const r = fieldRig({ vessel, targetId: vessel.id });
    r.pressK();
    expect(r.fs.formation).toBe(vessel.id);
    r.pressK();
    expect(r.fs.formation).toBeNull();
    expect(r.logs).toContain('FORMATION RELEASED');
    r.frame();
    expect(r.fm.assistReferenceVelocity, 'released to null inside the field frame').not.toBeNull();
    expect(r.fm.assistReferenceVelocity!.distanceTo(r.fieldVelNow())).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------------------
// Decision 2 — K in the field
// ---------------------------------------------------------------------------

describe('K in the field: asteroids anywhere in the frame, vessels within 50 km', () => {
  it('Given (pure) an asteroid target 80 km away inside the field frame, Then formation is allowed; outside the frame the 50 km rule stands', () => {
    const rock = { fa: true, targetIsVessel: false, targetIsAsteroid: true, distanceKm: 80, cruise: false };
    expect(mayHoldFormation({ ...rock, inFieldFrame: true } as Parameters<typeof mayHoldFormation>[0])).toBe(true);
    expect(mayHoldFormation({ ...rock, inFieldFrame: false } as Parameters<typeof mayHoldFormation>[0])).toBe(false);
    // The other gates still apply in the frame.
    expect(mayHoldFormation({ ...rock, inFieldFrame: true, fa: false } as Parameters<typeof mayHoldFormation>[0])).toBe(false);
    expect(mayHoldFormation({ ...rock, inFieldFrame: true, cruise: true } as Parameters<typeof mayHoldFormation>[0])).toBe(false);
  });

  it('Given (pure) a vessel 80 km away inside the field frame, Then formation is refused (vessels keep the 50 km rule)', () => {
    const ship = { fa: true, targetIsVessel: true, distanceKm: 80, cruise: false, inFieldFrame: true };
    expect(mayHoldFormation(ship as Parameters<typeof mayHoldFormation>[0])).toBe(false);
    expect(mayHoldFormation({ ...ship, distanceKm: FORMATION_RANGE_KM } as Parameters<typeof mayHoldFormation>[0])).toBe(true);
  });

  it('Given a field drop and a rock ~80 km away (surface), When K, Then formation holds on it with its velocity as reference, and keeps holding while you fly', () => {
    const probe = fieldRig();
    const far = rocksBySurface(probe).filter((x) => x.km > FORMATION_RANGE_KM);
    expect(far.length, 'field 398 has a rock beyond 50 km of the drop point').toBeGreaterThan(0);
    const rock = far.reduce((a, x) => (Math.abs(x.km - 80) < Math.abs(a.km - 80) ? x : a));

    const r = fieldRig({ targetId: rock.id });
    r.pressK();
    expect(r.logs).not.toContain('FORMATION — TARGET A VESSEL OR ASTEROID WITHIN 50 KM');
    expect(r.fs.formation).toBe(rock.id);
    expect(r.logs).toContain('FORMATION — HOLDING ON TARGET');
    const v = new Vector3();
    expect(r.b.belt.asteroidVelocity(rock.id, v)).toBe(true);
    expect(r.fm.assistReferenceVelocity!.distanceTo(v)).toBeLessThan(1e-6);
    r.axes.throttle = 0.05;
    r.step(5);
    expect(r.fs.formation).toBe(rock.id);
    expect(r.logs).not.toContain('FORMATION RELEASED');
  });

  it('Given a vessel 80 km away inside the field frame, When K, Then formation is refused with the 50 km warning', () => {
    const vessel: Vessel = { id: 'ship:far-hauler', offset: new Vector3(80, 0, 0), relVel: new Vector3() };
    const r = fieldRig({ vessel, targetId: vessel.id });
    expect(frameOf(r)).toBe(r.field.id);
    r.pressK();
    expect(r.fs.formation).toBeNull();
    expect(r.logs).toContain('FORMATION — TARGET A VESSEL OR ASTEROID WITHIN 50 KM');
  });
});
