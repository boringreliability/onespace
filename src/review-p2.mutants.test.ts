/**
 * review-p2 — tests written to kill mutants that survived the existing suite.
 * Each block names the mutant it pins; the mutation table is in the review
 * report. Kept in one file so the provenance stays visible.
 */

import { describe, expect, it } from 'vitest';

import { ModeMachine } from '@/core/Modes';
import { parseRoute } from '@/core/Route';
import { initialTitle, titleStep } from '@/ui/titleMenu';
import { clampGrade, createFlyCam, stepFlyCam, FLYCAM_DEFAULTS } from '@/game/photo/flycam';
import { formatDevLines } from '@/ui/devFormat';
import { DEFAULT_SELECTION, isLegal, legalize, withYardRoute } from '@/game/showroom/catalog';
import { PerspectiveCamera } from 'three';
import { formatDeltaV, shipRegistry } from '@/game/showroom/specs';
import { Lru } from '@/game/showroom/lru';
import { FlightSnapshot } from '@/game/FlightSnapshot';
import type { ShipBlueprint } from '@/gen/ships/types';

const still = { move: [0, 0, 0] as const, lookDx: 0, lookDy: 0, zoom: 0, fast: false };

describe('Modes — legal targets (MO2, MO10)', () => {
  it('Given flight, When asked whether flight is reachable, Then yes (go(same) is a legal no-op)', () => {
    const m = new ModeMachine('flight');
    expect(m.can('flight')).toBe(true);
  });

  it('Given the Yard entered from the title, When Esc returns, Then yard → title is legal', () => {
    const m = new ModeMachine('yard');
    expect(m.can('title')).toBe(true);
    m.go('title');
    expect(m.base).toBe('title');
  });
});

describe('parseRoute — whitelist edges (R4, R6, R7, R11)', () => {
  it('Given ?mode=boot, Then it is not a boot target and is dropped with a warning', () => {
    const r = parseRoute('?mode=boot');
    expect(r.mode).toBeUndefined();
    expect(r.warnings.length).toBe(1);
  });

  // Semantics changed after this review (DECISIONS D58): a gen that is not
  // exactly this build's — garbled, signed, fractional, exponent — is flagged
  // as "not this standard" rather than silently treated as current.
  it.each(['-1', '0.5', '0000000', '1e0', ' 0'])('Given gen=%s (not this build’s generation), Then the ship is flagged stale', (gen) => {
    expect(parseRoute(`?mode=yard&ship=1&gen=${encodeURIComponent(gen)}`).staleGeneration).toBe(true);
  });

  it('Given a shot name starting with a dash, Then it is dropped', () => {
    expect(parseRoute('?shot=-planet').shot).toBeUndefined();
  });

  it('Given ?seed=0, Then universe seed 0 is kept, not mistaken for absent', () => {
    expect(parseRoute('?seed=0').universeSeed).toBe(0);
  });
});

describe('titleStep — click bounds and seed error (TM3, TM4, TM8)', () => {
  it('Given a click on index n (one past the menu), Then nothing happens', () => {
    const r = titleStep(initialTitle(), { kind: 'click', index: 3 });
    expect(r.effect).toEqual({ kind: 'none' });
    expect(r.state.index).toBe(0);
  });

  it('Given a fractional click index, Then nothing happens', () => {
    expect(titleStep(initialTitle(), { kind: 'click', index: 1.5 }).effect).toEqual({ kind: 'none' });
  });

  it('Given a seed error is showing, When a valid seed is entered, Then the error clears', () => {
    const bad = titleStep(initialTitle(), { kind: 'seed', text: 'zz' }).state;
    expect(bad.seedError).not.toBeNull();
    const good = titleStep(bad, { kind: 'seed', text: 'abc' });
    expect(good.state.seedError).toBeNull();
    expect(good.effect).toEqual({ kind: 'reseed', seed: 0xabc });
  });
});

describe('flycam — look direction, easing, exposure floor (F6, F9, F11)', () => {
  it('Given a drag to the right, When stepped, Then yaw decreases (the view turns right, as in flight)', () => {
    const c = createFlyCam([0, 0, 0], 0, 0, 60);
    stepFlyCam(c, { ...still, lookDx: 100 }, 1 / 60);
    expect(c.yaw).toBeCloseTo(-100 * FLYCAM_DEFAULTS.lookSensitivity, 12);
  });

  it('Given a camera at rest, When W is pressed for one 60 Hz frame, Then velocity eases in rather than snapping to cruise', () => {
    const c = createFlyCam([0, 0, 0], 0, 0, 60);
    stepFlyCam(c, { ...still, move: [0, 0, -1] }, 1 / 60);
    const speed = Math.hypot(...c.velocity);
    const expected = FLYCAM_DEFAULTS.speedKmS * (1 - Math.exp(-1 / 60 / FLYCAM_DEFAULTS.tau));
    expect(speed).toBeCloseTo(expected, 12);
    expect(speed).toBeLessThan(FLYCAM_DEFAULTS.speedKmS * 0.1);
  });

  it('Given exposure 0 (a black frame), When clamped, Then it is held at the 0.1 floor', () => {
    expect(clampGrade({ exposure: 0 }).exposure).toBe(0.1);
  });
});

describe('formatDevLines — boundaries (D1, D2, D7, D10)', () => {
  const base = { fps: 60, frameMs: 16.6, cpuMs: 2, scale: 1, calls: 1, tris: 1, programs: 1 };
  const ctx = { mode: 'flight', tier: 'high', ticking: 1, modules: 1 };
  it('Given exactly one million triangles, Then it reads 1.00M', () => {
    expect(formatDevLines({ ...base, tris: 1e6 }, ctx)[0]).toContain('tris 1.00M');
  });
  it('Given 5 400 triangles (under 10k), Then it reads plainly', () => {
    expect(formatDevLines({ ...base, tris: 5400 }, ctx)[0]).toContain('tris 5400 ');
  });
  it('Given 58.6 fps, Then it rounds to 59', () => {
    expect(formatDevLines({ ...base, fps: 58.6 }, ctx)[0].startsWith('59 fps')).toBe(true);
  });
  it('Given a fractional small triangle count, Then it is rounded', () => {
    expect(formatDevLines({ ...base, tris: 812.4 }, ctx)[0]).toContain('tris 812 ');
  });
});

describe('catalog.isLegal — the seed is part of legality (C5)', () => {
  it.each([-1, 1.5, 2 ** 32, Number.NaN])('Given seed %s, Then the selection is not legal', (seed) => {
    expect(isLegal({ ...DEFAULT_SELECTION, seed })).toBe(false);
  });
});

describe('catalog — link hygiene and seed range (C10, C11)', () => {
  it('Given ?dev in the URL, When the Yard rewrites the route, Then dev stays the bare flag', () => {
    const s = withYardRoute('?dev', DEFAULT_SELECTION);
    expect(s).toMatch(/(^\?|&)dev(&|$)/);
    expect(s).not.toContain('dev=');
  });

  it('Given a negative seed, When legalized, Then it becomes its unsigned 32-bit value', () => {
    expect(legalize({ seed: -1 }).seed).toBe(0xffffffff);
  });
});

describe('specs — delta-v format and registry name (S3, S4, S7)', () => {
  it('Given exactly 10 km/s, Then it reads with one decimal', () => {
    expect(formatDeltaV(10)).toBe('10.0 km/s');
  });

  it('Given a negative delta-v, Then it reads as zero', () => {
    expect(formatDeltaV(-3)).toBe('0.00 km/s');
  });

  it('Given a scanned display name, Then the registry header leads with it, not the internal name', () => {
    const bp = {
      name: 'internal',
      familyId: 'f',
      role: 'tug',
      scan: { displayName: 'KSV Long Patience', className: 'C', registry: 'R', operator: 'O' },
    } as unknown as ShipBlueprint;
    expect(shipRegistry(bp).name).toBe('KSV Long Patience');
  });
});

describe('Lru — re-set refreshes recency (L4)', () => {
  it('Given a, b cached, When a is set again and the cache trims to 1, Then b is evicted, not a', () => {
    const evicted: string[] = [];
    const lru = new Lru<string, number>(1, (k) => evicted.push(k));
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('a', 3);
    lru.trim();
    expect(evicted).toEqual(['b']);
    expect(lru.peek('a')).toBe(3);
  });
});

describe('FlightSnapshot — the lens is the one captured (FS7)', () => {
  it('Given flight on a 70° lens, When the Yard leaves the camera at 24° and flight is restored, Then the fov is 70°', () => {
    const cam = new PerspectiveCamera(70, 1, 0.0005, 1e12);
    const snap = new FlightSnapshot();
    snap.capture(cam, { exposureBias: 1, pointerLocked: false });
    cam.fov = 24;
    snap.restore(cam, { fixedDt: null, resumeRealtime() {} });
    expect(cam.fov).toBe(70);
  });
});
