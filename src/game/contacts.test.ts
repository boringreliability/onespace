/**
 * Contact brackets (v3 PLAN F; audit V2 "the traffic ship is never seen").
 *
 * Every vessel within ~50 km gets a faint bracket without pressing Tab, and
 * one that is off the glass gets a chevron on the frame edge pointing the
 * short way to it. Tab still selects one of them for the full range/closing
 * box; that one is drawn by the target reticle, not twice.
 */

import { describe, expect, it } from 'vitest';

import {
  CONTACT_RANGE_KM,
  MAX_CONTACT_BRACKETS,
  edgePlace,
  selectContacts,
  type ContactIn,
  type EdgePlacement,
} from './contacts';

const c = (id: string, dx: number, dy = 0, dz = 0): ContactIn => ({ id, dx, dy, dz });

describe('selectContacts', () => {
  it('Given the range is ~50 km, Then the constant says so', () => {
    expect(CONTACT_RANGE_KM).toBe(50);
  });

  it('Given contacts at 1.2 km, 49.9 km and 50.1 km, Then only the two inside 50 km are bracketed', () => {
    const out: number[] = [];
    const n = selectContacts([c('a', 1.2), c('b', 0, 49.9), c('c', 0, 0, -50.1)], null, out);
    expect(n).toBe(2);
    expect(out.slice(0, n).sort()).toEqual([0, 1]);
  });

  it('Given several contacts in range, Then they are ordered nearest first', () => {
    const out: number[] = [];
    const n = selectContacts([c('far', 30), c('near', 0, 2), c('mid', 0, 0, 9)], null, out);
    expect(out.slice(0, n)).toEqual([1, 2, 0]);
  });

  it('Given the Tab target is one of the contacts, Then it is left out (the target reticle draws it, with its box)', () => {
    const out: number[] = [];
    const n = selectContacts([c('a', 1), c('b', 2)], 'a', out);
    expect(out.slice(0, n)).toEqual([1]);
  });

  it('Given more contacts in range than bracket slots, Then only the nearest MAX are kept', () => {
    const list: ContactIn[] = [];
    for (let i = 0; i < MAX_CONTACT_BRACKETS + 4; i++) list.push(c(`v${i}`, 40 - i));
    const out: number[] = [];
    const n = selectContacts(list, null, out);
    expect(n).toBe(MAX_CONTACT_BRACKETS);
    // The nearest are the last ones pushed.
    expect(out[0]).toBe(list.length - 1);
  });

  it('Given no contacts, Then nothing is bracketed', () => {
    expect(selectContacts([], null, [])).toBe(0);
  });

  it('Given a contact with a non-finite position (not yet placed), Then it is skipped', () => {
    const out: number[] = [];
    expect(selectContacts([c('nan', Number.NaN)], null, out)).toBe(0);
  });

  it('Given an output array, Then it is written in place (no allocation per frame) and the count returned', () => {
    const out = [9, 9, 9, 9];
    const n = selectContacts([c('a', 3)], null, out);
    expect(n).toBe(1);
    expect(out[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Off-glass chevrons
// ---------------------------------------------------------------------------

const W = 1600;
const H = 900;
const M = 54;
const ep = (): EdgePlacement => ({ x: 0, y: 0, onScreen: false, angleDeg: 0 });

function onMarginBox(p: EdgePlacement): boolean {
  const onX = Math.abs(p.x - M) < 1e-6 || Math.abs(p.x - (W - M)) < 1e-6;
  const onY = Math.abs(p.y - M) < 1e-6 || Math.abs(p.y - (H - M)) < 1e-6;
  const inside = p.x >= M - 1e-6 && p.x <= W - M + 1e-6 && p.y >= M - 1e-6 && p.y <= H - M + 1e-6;
  return inside && (onX || onY);
}

describe('edgePlace', () => {
  it('Given a point inside the margin, Then it is placed where it is, on screen', () => {
    const p = edgePlace(700, 300, false, W, H, M, ep());
    expect(p).toEqual({ x: 700, y: 300, onScreen: true, angleDeg: p.angleDeg });
  });

  it('Given a point far to the right at mid height, Then the chevron sits on the right margin at mid height and points right (0°)', () => {
    const p = edgePlace(W + 900, H / 2, false, W, H, M, ep());
    expect(p.onScreen).toBe(false);
    expect(p.x).toBeCloseTo(W - M, 6);
    expect(p.y).toBeCloseTo(H / 2, 6);
    expect(p.angleDeg).toBeCloseTo(0, 6);
  });

  it('Given a point above the frame, Then the chevron points up (−90°, CSS y grows downward)', () => {
    const p = edgePlace(W / 2, -400, false, W, H, M, ep());
    expect(p.angleDeg).toBeCloseTo(-90, 6);
    expect(p.y).toBeCloseTo(M, 6);
  });

  it('Given a point off a corner, Then the chevron slides along the ray to the margin box — never parked in the corner of a wrong side', () => {
    const p = edgePlace(W * 3, H * 1.4, false, W, H, M, ep());
    expect(onMarginBox(p)).toBe(true);
    const ray = Math.atan2(H * 1.4 - H / 2, W * 3 - W / 2);
    expect((p.angleDeg * Math.PI) / 180).toBeCloseTo(ray, 6);
  });

  it('Given a contact BEHIND the camera that projects (mirrored) left of centre, Then the chevron is on the RIGHT — the short way round', () => {
    const p = edgePlace(W / 2 - 100, H / 2, true, W, H, M, ep());
    expect(p.onScreen).toBe(false);
    expect(p.x).toBeCloseTo(W - M, 6);
  });

  it('Given a contact behind and exactly on the axis, Then the placement is finite and on the margin box (no NaN)', () => {
    const p = edgePlace(W / 2, H / 2, true, W, H, M, ep());
    expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.angleDeg)).toBe(true);
    expect(onMarginBox(p)).toBe(true);
  });

  it('Given a point crossing the margin, Then the placement is continuous (bracket → chevron moves < 1 px)', () => {
    const a = edgePlace(W - M - 0.01, 300, false, W, H, M, ep());
    const b = edgePlace(W - M + 0.01, 300, false, W, H, M, ep());
    expect(a.onScreen).toBe(true);
    expect(b.onScreen).toBe(false);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1);
  });

  it('Given an output object, Then it is written and returned', () => {
    const o = ep();
    expect(edgePlace(1, 1, false, W, H, M, o)).toBe(o);
  });
});
