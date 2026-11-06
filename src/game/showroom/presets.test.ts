/**
 * The Yard's named presets are lifted out of the review shots. These tests
 * pin them to their source shots, so a re-lit review frame and the Yard's
 * button of the same name cannot drift apart silently.
 */

import { describe, expect, it } from 'vitest';

import { SHOT_DEFS } from './shots';
import {
  BURN,
  COLD,
  CRUISE,
  DRIVE_PRESETS,
  DRIVE_PRESET_IDS,
  KEY_LIGHT,
  LIGHT_PRESETS,
  LIGHT_PRESET_IDS,
  VIEW_PRESETS,
  VIEW_PRESET_IDS,
} from './presets';

function shot(name: string) {
  const s = SHOT_DEFS.find((d) => d.name === name);
  if (!s) throw new Error(`no shot ${name}`);
  return s;
}

function lightOf(name: string) {
  const s = shot(name).setup;
  return {
    sunDirection: s.sunDirection,
    sunColor: s.sunColor,
    sunIntensity: s.sunIntensity,
    fillColor: s.fillColor,
    fillDirection: s.fillDirection,
  };
}

describe('light presets', () => {
  it('Given the table, Then it has raking, rim, dark-side and planetshine in that order', () => {
    expect(LIGHT_PRESET_IDS).toEqual(['raking', 'rim', 'dark-side', 'planetshine']);
  });

  it('Given raking, Then it is the standard KEY_LIGHT', () => {
    expect(LIGHT_PRESETS.raking).toEqual(KEY_LIGHT);
  });

  it('Given rim, dark-side and planetshine, Then each equals the lighting of its source review shot', () => {
    expect(LIGHT_PRESETS.rim).toEqual(lightOf('ship-star-rimlight'));
    expect(LIGHT_PRESETS['dark-side']).toEqual(lightOf('ship-dark-side'));
    expect(LIGHT_PRESETS.planetshine).toEqual(lightOf('ship-planetshine'));
  });
});

describe('drive presets', () => {
  it('Given the table, Then cold, cruise and burn are the review drive states themselves', () => {
    expect(DRIVE_PRESET_IDS).toEqual(['cold', 'cruise', 'burn']);
    expect(DRIVE_PRESETS.cold).toBe(COLD);
    expect(DRIVE_PRESETS.cruise).toBe(CRUISE);
    expect(DRIVE_PRESETS.burn).toBe(BURN);
  });
});

describe('view presets', () => {
  it('Given the table, Then side, front, three-quarter, engine and detail exist', () => {
    expect(VIEW_PRESET_IDS).toEqual(['side', 'front', 'three-quarter', 'engine', 'detail']);
  });

  it('Given each bookmark, Then its direction, lens, fill and aim are its source shot’s, without roll or offset', () => {
    const source: Record<string, string> = {
      side: 'ship-silhouette-side',
      front: 'ship-silhouette-front',
      'three-quarter': 'ship-showroom-hero',
      engine: 'ship-engine-close',
      detail: 'ship-greeble-close',
    };
    for (const id of VIEW_PRESET_IDS) {
      const cam = shot(source[id]!).camera;
      const v = VIEW_PRESETS[id];
      expect(v.dir).toEqual(cam.dir);
      expect(v.fovDeg).toBe(cam.fovDeg);
      expect(v.fill).toBe(cam.fill);
      expect(v.aimAt).toBe(cam.aimAt);
      expect(v.faceAim).toBe(cam.faceAim);
      // An orbit camera has no roll and frames dead centre.
      expect(v.roll).toBeUndefined();
      expect(v.offsetX).toBeUndefined();
      expect(v.offsetY).toBeUndefined();
    }
  });
});
