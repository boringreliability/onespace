/**
 * v3 polish (D22a) — the touchdown line.
 *
 * Pilot graded on vertical speed alone, so an auto-land that set down with
 * the ground sliding past at ~22 m/s still read "TOUCHDOWN — CLEAN · 0.8 M/S".
 * The grade is now the worse of the sink rate and the slip against the
 * ground, and a slip worth mentioning is named. One line per touchdown: the
 * flight model no longer logs a bare "TOUCHDOWN" of its own after it.
 */

import { describe, expect, it } from 'vitest';
import { touchdownGrade } from './touchdownGrade';

describe('touchdownGrade', () => {
  it('Given 0.8 m/s down and no slip, Then "TOUCHDOWN — CLEAN · 0.8 M/S", good', () => {
    expect(touchdownGrade(0.0008, 0)).toEqual({ text: 'TOUCHDOWN — CLEAN · 0.8 M/S', tone: 'good' });
  });

  it('Given 0.8 m/s down and 0.6 m/s of slip, Then still CLEAN and the slip is not mentioned (under 1 m/s)', () => {
    expect(touchdownGrade(0.0008, 0.0006).text).toBe('TOUCHDOWN — CLEAN · 0.8 M/S');
  });

  it('Given 0.8 m/s down but 22 m/s of slip (the review’s skid), Then not CLEAN: HARD, warn, and the skid is named', () => {
    const g = touchdownGrade(0.0008, 0.022);
    expect(g.text).toBe('TOUCHDOWN — HARD · 0.8 M/S · SKID 22 M/S');
    expect(g.tone).toBe('warn');
  });

  it('Given 3 m/s down and 5 m/s of slip, Then the middle grade on the worse of the two, named, good', () => {
    expect(touchdownGrade(0.003, 0.005)).toEqual({ text: 'TOUCHDOWN · 3.0 M/S · SKID 5 M/S', tone: 'good' });
  });

  it('Given 9 m/s down, Then HARD and warn, as before', () => {
    expect(touchdownGrade(0.009, 0)).toEqual({ text: 'TOUCHDOWN — HARD · 9.0 M/S', tone: 'warn' });
  });

  it('Given the grade thresholds, Then 2 m/s and 8 m/s are the edges (unchanged), on either input', () => {
    expect(touchdownGrade(0.00199, 0).text.startsWith('TOUCHDOWN — CLEAN')).toBe(true);
    expect(touchdownGrade(0.002, 0).text.startsWith('TOUCHDOWN ·')).toBe(true);
    expect(touchdownGrade(0, 0.002).text.startsWith('TOUCHDOWN ·')).toBe(true);
    expect(touchdownGrade(0.00799, 0).text.startsWith('TOUCHDOWN ·')).toBe(true);
    expect(touchdownGrade(0, 0.008).text.startsWith('TOUCHDOWN — HARD')).toBe(true);
  });

  it('Given NaN or negative inputs, Then they count as 0 — never "NaN M/S"', () => {
    const g = touchdownGrade(Number.NaN, -1);
    expect(g.text).toBe('TOUCHDOWN — CLEAN · 0.0 M/S');
  });
});
