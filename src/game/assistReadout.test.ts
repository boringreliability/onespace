/**
 * The flight-assist readout under the throttle gauge (review-p1a: under FA-ON
 * the THR gauge shows engine output — 0 % while holding speed in vacuum — so
 * the pilot could not see what speed the computer was holding).
 */

import { describe, expect, it } from 'vitest';
import { assistReadout } from './assistReadout';

describe('assistReadout', () => {
  it('Given FA off, Then it reads FA OFF', () => {
    expect(assistReadout('off', 0)).toBe('FA OFF');
  });

  it('Given the coast detent, Then it reads FA · COAST', () => {
    expect(assistReadout('coast', 0)).toBe('FA · COAST');
  });

  it('Given a hold above 1 km/s, Then it reads km/s with two decimals', () => {
    expect(assistReadout('hold', 1.7046)).toBe('FA · HOLD 1.70 KM/S');
  });

  it('Given a hold below 1 km/s, Then it reads whole m/s (landing speeds)', () => {
    expect(assistReadout('hold', 0.0516)).toBe('FA · HOLD 52 M/S');
  });

  it('Given an active stop, Then it reads FA · STOP', () => {
    expect(assistReadout('stop', 0)).toBe('FA · STOP');
  });

  it('Given a non-finite set speed, Then the hold reads a dash rather than NaN', () => {
    expect(assistReadout('hold', NaN)).toBe('FA · HOLD —');
  });
});
