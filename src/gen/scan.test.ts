/**
 * The planet scanner.
 *
 * These tests exist because the scanner is the only place where the generated
 * physics is *shown to the player as a number*. Everywhere else a wrong value
 * hides inside a shader or a trajectory; here it is printed in 14-point mono on
 * the glass, and a scale error is the difference between a world that reads as
 * observed and one that reads as invented.
 */

import { describe, expect, it } from 'vitest';
import { generateGalaxy, sampleSystemsNear } from './galaxy';
import { generateSystem } from './system';
import { planetScan, SCAN_ROWS } from './scan';
import type { PlanetSpec, StarSystemSpec } from './types';

const GALAXY = generateGalaxy(0x51a1);
const STUBS = sampleSystemsNear(GALAXY, [GALAXY.radiusLy * 0.3, 0, 0], 300, 60);
const SYSTEMS: StarSystemSpec[] = STUBS.slice(0, 25).map((s) => generateSystem(GALAXY, s));
const PLANETS: PlanetSpec[] = SYSTEMS.flatMap((s) => s.planets);
const WORLDS: PlanetSpec[] = PLANETS.flatMap((p) => [p, ...p.moons]);

describe('shape', () => {
  it('fills every HUD row for every world in the sample', () => {
    // The HUD's rows are fixed nodes allocated once. A scanner that returns
    // nine lines leaves the tenth showing the previous target's data.
    expect(WORLDS.length).toBeGreaterThan(50);
    for (const p of WORLDS) {
      const r = planetScan(p);
      expect(r.lines.length).toBe(SCAN_ROWS);
      for (const line of r.lines) expect(line.length).toBeGreaterThan(0);
    }
  });

  it('carries the body identity so the log can key on it', () => {
    const p = WORLDS[0]!;
    const r = planetScan(p);
    expect(r.targetId).toBe(p.id);
    expect(r.name).toBe(p.name);
  });

  it('aligns every value to the same column', () => {
    // The readout is monospaced dot-leader. Misalignment is the loudest
    // possible tell that the lines were assembled by hand.
    for (const p of WORLDS.slice(0, 30)) {
      for (const line of planetScan(p).lines) {
        const dot = line.indexOf('. ');
        expect(dot).toBeGreaterThan(0);
        expect(line.slice(0, dot + 2).length).toBe(17);
      }
    }
  });

  it('never overflows the HUD scanner panel', () => {
    // 48 characters is what 330px of 9px monospace holds. A row longer than
    // that does not wrap — it clips against the panel edge mid-word.
    for (const p of WORLDS) {
      for (const line of planetScan(p).lines) expect(line.length).toBeLessThanOrEqual(48);
    }
  });

  it('never truncates a measurement row', () => {
    // Only the note may end in an ellipsis. Losing a clause off a sentence is
    // a style; losing "tidally locked" off a classification is losing a fact.
    for (const p of WORLDS) {
      for (const line of planetScan(p).lines) {
        if (line.startsWith('note')) continue;
        expect(line.endsWith('…')).toBe(false);
      }
    }
  });

  it('is deterministic', () => {
    const p = WORLDS[3]!;
    expect(planetScan(p)).toEqual(planetScan(p));
  });
});

describe('the numbers are the generated ones', () => {
  it('prints the radius the generator produced', () => {
    for (const p of WORLDS.slice(0, 20)) {
      const line = planetScan(p).lines.find((l) => l.startsWith('radius'))!;
      const digits = Number(line.replace(/[^0-9]/g, ''));
      // Printed with thin spaces as thousands separators and rounded, so
      // compare within a kilometre of the rounded truth.
      expect(Math.abs(digits - Math.round(p.radius))).toBeLessThanOrEqual(1);
    }
  });

  it('prints gravity in m/s² to one decimal', () => {
    for (const p of WORLDS.slice(0, 20)) {
      const line = planetScan(p).lines.find((l) => l.startsWith('gravity'))!;
      expect(line).toContain(p.gravity.toFixed(1));
      expect(line).toContain('m/s²');
    }
  });

  it('prints the mean temperature in kelvin, with a capital K', () => {
    // Lower-case k is the kilo prefix. The readout said "266 k mean" until a
    // blanket toLowerCase() over the whole row was removed.
    for (const p of WORLDS.slice(0, 20)) {
      const line = planetScan(p).lines.find((l) => l.startsWith('temperature'))!;
      expect(line).toContain(`${Math.round(p.temperature)} K mean`);
    }
  });

  it('keeps chemical formulae capitalised', () => {
    // CO2, not co2. Same reason as kelvin: case is meaning, not styling.
    const withAir = WORLDS.filter((p) => p.atmosphere !== null);
    const seen = withAir.map(
      (p) => planetScan(p).lines.find((l) => l.startsWith('atmosphere'))!,
    );
    const formulae = seen.filter((l) => /[A-Z]/.test(l.slice(17)));
    expect(formulae.length).toBeGreaterThan(0);
    for (const l of seen) expect(l).not.toMatch(/\b(co2|n2|o2|h2|he|ch4|so2)\b/);
  });

  it('says vacuum when the generator gave no atmosphere', () => {
    const airless = WORLDS.filter((p) => p.atmosphere === null);
    expect(airless.length).toBeGreaterThan(0);
    for (const p of airless.slice(0, 15)) {
      const line = planetScan(p).lines.find((l) => l.startsWith('atmosphere'))!;
      expect(line).toMatch(/vacuum|none/);
    }
  });

  it('counts the moons the generator attached', () => {
    const parents = PLANETS.filter((p) => p.moons.length > 0);
    expect(parents.length).toBeGreaterThan(0);
    for (const p of parents.slice(0, 15)) {
      const line = planetScan(p).lines.find((l) => l.startsWith('moons'))!;
      expect(line).toContain(String(p.moons.length));
    }
  });

  it('marks retrograde rotation, and only when the period is negative', () => {
    for (const p of WORLDS.slice(0, 40)) {
      const line = planetScan(p).lines.find((l) => l.startsWith('rotation'))!;
      expect(line.includes('retrograde')).toBe(p.rotationPeriod < 0);
    }
  });

  it('reports rings only for worlds that have them', () => {
    // Checked on the class line specifically, not anywhere in the readout:
    // "ring" is a substring of "during", and the closing note is prose.
    for (const p of WORLDS.slice(0, 40)) {
      const classLine = planetScan(p).lines[0]!;
      expect(classLine.includes('ringed')).toBe(p.rings !== null);
    }
  });
});

describe('voice', () => {
  it('keeps every label lower case, like the rest of the instruments', () => {
    // The register is lower case; the exceptions are units and formulae, and
    // those live in the value. The label never has one.
    for (const p of WORLDS.slice(0, 25)) {
      for (const line of planetScan(p).lines) {
        const label = line.slice(0, line.indexOf(' '));
        expect(label).toBe(label.toLowerCase());
      }
    }
  });

  it('keeps the prose rows free of upper case', () => {
    // The note is the generator's own sentence, and it is the one row that is
    // writing rather than measurement. Sentence case in the middle of a
    // readout reads as a rendering fault.
    for (const p of WORLDS.slice(0, 25)) {
      for (const label of ['note', 'anomaly', 'class']) {
        const line = planetScan(p).lines.find((l) => l.startsWith(label))!;
        expect(line).toBe(line.toLowerCase());
      }
    }
  });

  it('closes with the generator own sentence about the place', () => {
    for (const p of WORLDS.slice(0, 20)) {
      const last = planetScan(p).lines[SCAN_ROWS - 1]!;
      expect(last.startsWith('note')).toBe(true);
      expect(last.length).toBeGreaterThan(18);
    }
  });
});
