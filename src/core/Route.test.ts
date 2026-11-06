/**
 * URL parameters. Every value is whitelisted: anything not recognised is
 * dropped, never passed through, so a crafted link cannot put arbitrary data
 * into the engine.
 */

import { describe, expect, it } from 'vitest';
import { parseDevParams } from './Route';

describe('parseDevParams', () => {
  it('Given no query, Then nothing is overridden', () => {
    expect(parseDevParams('')).toEqual({});
  });

  it('Given ?tier=low, Then the tier is low', () => {
    expect(parseDevParams('?tier=low')).toEqual({ tier: 'low' });
  });

  it('Given every real tier, Then each is accepted', () => {
    for (const t of ['low', 'medium', 'high', 'ultra'] as const) {
      expect(parseDevParams(`?tier=${t}`).tier).toBe(t);
    }
  });

  it('Given an unknown or hostile tier, Then it is dropped', () => {
    for (const bad of ['potato', 'HIGH', '<script>', '', 'high;drop']) {
      expect(parseDevParams(`?tier=${encodeURIComponent(bad)}`).tier).toBeUndefined();
    }
  });

  it('Given ?dpr=1 or ?dpr=0.5, Then it is taken', () => {
    expect(parseDevParams('?dpr=1').dpr).toBe(1);
    expect(parseDevParams('?dpr=0.5').dpr).toBe(0.5);
  });

  it('Given a dpr that is not a sane positive number, Then it is dropped', () => {
    for (const bad of ['abc', '-1', '0', '9', 'NaN', 'Infinity', '1e3', '']) {
      expect(parseDevParams(`?dpr=${bad}`).dpr).toBeUndefined();
    }
  });

  it('Given both and some noise, Then both are taken and the noise ignored', () => {
    expect(parseDevParams('?foo=bar&tier=medium&dpr=1.25&x')).toEqual({
      tier: 'medium',
      dpr: 1.25,
    });
  });
});
