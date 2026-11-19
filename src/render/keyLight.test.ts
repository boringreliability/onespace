/**
 * v3-light: the key light every lit thing in a system shares — worlds, moons,
 * traffic and the player's own hull — as a function of where it stands.
 *
 * Owner's report: "in the outskirts of a solar system the planets are not lit
 * at all". Measured on the home system (Fyss, an M dwarf of L = 0.0098): the
 * gas giant Fyss VIII at 3.55 AU received sun colour 0.0008 against 1.04 at
 * the opening world, while the player's hull stayed at a flat 1.0 — the iris
 * metered the hull and the day side of a world filling the frame rendered
 * pure black.
 */

import { describe, expect, it } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import { AU } from '@/gen/types';
import { KEY_LIGHT_KNEE, keyIrradiance, physicalIrradiance, starDirectionLocal } from './keyLight';

const FYSS_L = 0.00984507536580091;

describe('physicalIrradiance', () => {
  it('Given Sol, When the body stands at 1 AU, Then it receives exactly Earth’s sunlight', () => {
    expect(physicalIrradiance(1, AU)).toBeCloseTo(1, 12);
  });

  it('Given Sol, When the body stands at 30 AU, Then it receives 1/900 (inverse square)', () => {
    expect(physicalIrradiance(1, 30 * AU)).toBeCloseTo(1 / 900, 12);
  });

  it('Given a body at the star’s centre (degenerate), Then the result is finite', () => {
    expect(Number.isFinite(physicalIrradiance(1, 0))).toBe(true);
  });

  it('Given a broken luminosity (NaN, 0, negative), Then it falls back to Sol rather than going black or NaN', () => {
    for (const bad of [Number.NaN, 0, -1]) expect(physicalIrradiance(bad, AU)).toBeCloseTo(1, 12);
  });
});

describe('keyIrradiance', () => {
  it('Given irradiance at or above the knee, Then it is unchanged (the opening world and every inner world look as before)', () => {
    for (const e of [KEY_LIGHT_KNEE, 0.5, 1, 1.0461, 4, 2500]) expect(keyIrradiance(e)).toBe(e);
  });

  it('Given the home world Remit 31 (0.097 AU of Fyss), Then its key light is bit-identical to the physical one', () => {
    const e = physicalIrradiance(FYSS_L, 0.097 * AU);
    expect(e).toBeGreaterThan(KEY_LIGHT_KNEE);
    expect(keyIrradiance(e)).toBe(e);
  });

  it('Given Fyss VIII at 3.55 AU (physically 1/1300 of the opening), Then its day side gets at least 1/50 of the opening world’s light', () => {
    const home = keyIrradiance(physicalIrradiance(FYSS_L, 0.097 * AU));
    const outer = keyIrradiance(physicalIrradiance(FYSS_L, 3.55 * AU));
    expect(outer / home).toBeGreaterThan(1 / 50);
  });

  it('Given a Neptune (Sol at 30 AU), Then it is lit at no less than 2% of Earth — legible once the iris opens', () => {
    expect(keyIrradiance(physicalIrradiance(1, 30 * AU))).toBeGreaterThan(0.02);
  });

  it('Given worlds further out, Then they are always dimmer (distance still reads), never brighter than the knee', () => {
    let prev = Infinity;
    for (let au = 0.05; au < 200; au *= 1.3) {
      const k = keyIrradiance(physicalIrradiance(1, au * AU));
      expect(k).toBeLessThanOrEqual(prev);
      expect(k).toBeGreaterThan(0);
      prev = k;
    }
  });

  it('Given the knee, Then the curve is continuous across it (no visible step when flying through it)', () => {
    const below = keyIrradiance(KEY_LIGHT_KNEE * (1 - 1e-9));
    expect(below).toBeCloseTo(KEY_LIGHT_KNEE, 6);
  });

  it('Given zero, negative or NaN irradiance, Then the key light is 0, not NaN', () => {
    expect(keyIrradiance(0)).toBe(0);
    expect(keyIrradiance(-1)).toBe(0);
    expect(keyIrradiance(Number.NaN)).toBe(0);
  });
});

describe('starDirectionLocal (the player hull’s key direction)', () => {
  it('Given a ship with the star dead astern, Then the hull is lit from local +Z, not from the authored bow-side default', () => {
    // Ship on +X of the star (at the origin), local +Z turned to world -X:
    // the stern faces the star.
    const pos = new Vector3(3.55 * AU, 0, 0);
    const att = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(-1, 0, 0));
    const d = starDirectionLocal(pos, att, new Vector3());
    expect(d.x).toBeCloseTo(0, 9);
    expect(d.y).toBeCloseTo(0, 9);
    expect(d.z).toBeCloseTo(1, 9);
  });

  it('Given an arbitrary attitude, When the local direction is turned back to world, Then it points at the star and is unit length', () => {
    const pos = new Vector3(0.7 * AU, 0.2 * AU, -1.1 * AU);
    const att = new Quaternion().setFromEuler(new Euler(0.4, -1.2, 2.1));
    const d = starDirectionLocal(pos, att, new Vector3());
    expect(d.length()).toBeCloseTo(1, 9);
    const back = d.clone().applyQuaternion(att);
    expect(back.distanceTo(pos.clone().negate().normalize())).toBeLessThan(1e-9);
  });

  it('Given any attitude, Then the caller’s quaternion is not mutated', () => {
    const att = new Quaternion(0.1, 0.2, 0.3, 0.9).normalize();
    const copy = att.clone();
    starDirectionLocal(new Vector3(AU, 0, 0), att, new Vector3());
    expect(att.equals(copy)).toBe(true);
  });
});
