/**
 * The Yard's spec readout: the scanner's own lines, re-ordered for a registry
 * page, plus the delta-v the scanner has no room for.
 */

import { describe, expect, it } from 'vitest';

import { generateShip } from '@/gen/ships/blueprint';
import { shipScanLines } from '@/gen/ships/physics';
import { HERO_SHIP } from './presets';
import { formatDeltaV, shipRegistry, shipSpecs } from './specs';

const hero = generateShip(HERO_SHIP);
const derelict = generateShip({ seed: 0x0dead, factionId: 'ossuary', role: 'derelict', sizeClass: 'medium' });

describe('specs', () => {
  it('Given HERO_SHIP, When specs are generated, Then the order starts class, hull, mass, drive, accel', () => {
    const labels = shipSpecs(hero).map((l) => l.label);
    expect(labels.slice(0, 5)).toEqual(['class', 'hull', 'mass', 'drive', 'accel']);
  });

  it('Given HERO_SHIP, When specs are generated, Then delta-v follows accel and matches the physics profile', () => {
    const lines = shipSpecs(hero);
    expect(lines[5]!.label).toBe('Δv');
    expect(lines[5]!.value).toBe(formatDeltaV(hero.physics.deltaVKmS));
  });

  it('Given HERO_SHIP, When specs are generated, Then every value is the scanner’s own value for that label', () => {
    const scan = new Map<string, string>();
    for (const row of shipScanLines(hero)) {
      const m = /^(\S+) \.{3,} (.*)$/.exec(row)!;
      scan.set(m[1]!, m[2]!);
    }
    for (const l of shipSpecs(hero)) {
      if (l.label === 'Δv') continue;
      expect(scan.get(l.label)).toBe(l.value);
    }
  });

  it('Given HERO_SHIP, When specs are generated, Then registry and operator are not readout rows (they head the page)', () => {
    const labels = shipSpecs(hero).map((l) => l.label);
    expect(labels).not.toContain('registry');
    expect(labels).not.toContain('operator');
  });

  it('Given a derelict, When specs are generated, Then the drive reads "no active drive signature" and there is no accel or delta-v', () => {
    const lines = shipSpecs(derelict);
    const drive = lines.find((l) => l.label === 'drive');
    expect(drive?.value).toBe('no active drive signature');
    expect(lines.some((l) => l.label === 'accel')).toBe(false);
    expect(lines.some((l) => l.label === 'Δv')).toBe(false);
  });

  it('Given a delta-v, When formatted, Then it is km/s with precision that suits its size', () => {
    expect(formatDeltaV(4.237)).toBe('4.24 km/s');
    expect(formatDeltaV(42.37)).toBe('42.4 km/s');
    expect(formatDeltaV(182.6)).toBe('183 km/s');
    expect(formatDeltaV(0)).toBe('0.00 km/s');
  });

  it('Given HERO_SHIP, When its registry header is read, Then it names the ship and its registry', () => {
    const r = shipRegistry(hero);
    expect(r.name.length).toBeGreaterThan(0);
    expect(typeof r.registry).toBe('string');
    expect(r.className.length).toBeGreaterThan(0);
  });
});
