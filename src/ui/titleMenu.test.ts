import { describe, expect, it } from 'vitest';
import { TITLE_ITEMS, initialTitle, parseSeedField, titleStep } from './titleMenu';

describe('titleStep', () => {
  it('Given a fresh title, Then UNDOCK is selected', () => {
    expect(TITLE_ITEMS[initialTitle().index]).toBe('undock');
  });

  it('Given UNDOCK, When down, Then THE YARD; When down past the end, Then it wraps', () => {
    let s = initialTitle();
    s = titleStep(s, { kind: 'down' }).state;
    expect(TITLE_ITEMS[s.index]).toBe('yard');
    for (let i = 0; i < TITLE_ITEMS.length - 1; i++) s = titleStep(s, { kind: 'down' }).state;
    expect(TITLE_ITEMS[s.index]).toBe('undock');
  });

  it('Given UNDOCK, When up, Then it wraps to the last item', () => {
    const s = titleStep(initialTitle(), { kind: 'up' }).state;
    expect(s.index).toBe(TITLE_ITEMS.length - 1);
  });

  it('Given UNDOCK, When enter, Then the effect is flight', () => {
    expect(titleStep(initialTitle(), { kind: 'enter' }).effect).toEqual({ kind: 'go', mode: 'flight' });
  });

  it('Given THE YARD, When enter, Then the effect is yard', () => {
    const s = titleStep(initialTitle(), { kind: 'down' }).state;
    expect(titleStep(s, { kind: 'enter' }).effect).toEqual({ kind: 'go', mode: 'yard' });
  });

  it('Given a click on an item, Then it is selected and activated in one step', () => {
    const r = titleStep(initialTitle(), { kind: 'click', index: 1 });
    expect(r.state.index).toBe(1);
    expect(r.effect).toEqual({ kind: 'go', mode: 'yard' });
  });

  it('Given a click on an index out of range, Then nothing happens', () => {
    const r = titleStep(initialTitle(), { kind: 'click', index: 99 });
    expect(r.effect).toEqual({ kind: 'none' });
    expect(r.state.index).toBe(0);
  });

  it('Given a valid seed submitted, Then the effect reloads with that seed', () => {
    expect(titleStep(initialTitle(), { kind: 'seed', text: '1A2B3C4D' }).effect).toEqual({
      kind: 'reseed',
      seed: 0x1a2b3c4d,
    });
  });

  it('Given an invalid seed submitted, Then it is refused with a reason and nothing reloads', () => {
    const r = titleStep(initialTitle(), { kind: 'seed', text: 'not a seed' });
    expect(r.effect.kind).toBe('none');
    expect(r.state.seedError).toBeTruthy();
  });

  it('Given the reducer, Then it never mutates the state it was given', () => {
    const s = initialTitle();
    const frozen = JSON.stringify(s);
    titleStep(s, { kind: 'down' });
    titleStep(s, { kind: 'seed', text: 'zz' });
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

describe('parseSeedField', () => {
  it('Given hex with or without 0x and spaces, Then it parses', () => {
    expect(parseSeedField('5c0117')).toBe(0x5c0117);
    expect(parseSeedField(' 0x5C0117 ')).toBe(0x5c0117);
  });

  it('Given anything else, Then it is null', () => {
    for (const bad of ['', 'xyz', '123456789', '-1', '1.5', '0x']) expect(parseSeedField(bad)).toBeNull();
  });
});
