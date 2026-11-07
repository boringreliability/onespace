/**
 * review-p2: the mode keys (P, Y) and who owns the keyboard while an overlay
 * is up. See entryGuards.ts for the three defects these pin.
 */

import { describe, expect, it } from 'vitest';

import { mayEnterPhoto, mayEnterYard, yardOwnsInput, type EntryContext } from './entryGuards';

const flight: EntryContext = { base: 'flight', overlay: null, menuOpen: false, busy: false };
const yard: EntryContext = { base: 'yard', overlay: null, menuOpen: false };

describe('mayEnterPhoto', () => {
  it('Given plain flight, When P is pressed, Then photo opens', () => {
    expect(mayEnterPhoto(flight)).toBe(true);
  });

  it('Given the Yard, When P is pressed, Then photo opens over it', () => {
    expect(mayEnterPhoto(yard)).toBe(true);
  });

  it('Given the pause sheet, codex or a chart is up, When P is pressed, Then photo does not open over it', () => {
    expect(mayEnterPhoto({ ...flight, menuOpen: true })).toBe(false);
  });

  it('Given photo is already up, When P is pressed, Then it is not entered a second time', () => {
    expect(mayEnterPhoto({ ...flight, overlay: 'photo' })).toBe(false);
  });

  it.each(['boot', 'title', 'map', 'review'] as const)('Given base %s, When P is pressed, Then photo does not open', (base) => {
    expect(mayEnterPhoto({ ...flight, base })).toBe(false);
  });

  it('Given a key repeat or a modifier chord (Cmd+P prints), When P arrives, Then photo does not open', () => {
    expect(mayEnterPhoto(flight, { repeat: true })).toBe(false);
    expect(mayEnterPhoto(flight, { metaKey: true })).toBe(false);
    expect(mayEnterPhoto(flight, { ctrlKey: true })).toBe(false);
    expect(mayEnterPhoto(flight, { altKey: true })).toBe(false);
  });

  it('Given a jump in progress, When P is pressed, Then photo still opens (a photo of the tunnel is the point)', () => {
    expect(mayEnterPhoto({ ...flight, busy: true })).toBe(true);
  });
});

describe('mayEnterYard', () => {
  it('Given plain flight, When Y is pressed, Then the Yard opens', () => {
    expect(mayEnterYard(flight)).toBe(true);
  });

  it('Given a jump or a recovery cut running, When Y is pressed, Then the Yard does not open', () => {
    expect(mayEnterYard({ ...flight, busy: true })).toBe(false);
  });

  it('Given a chart, codex or pause is up, When Y is pressed, Then the Yard does not open', () => {
    expect(mayEnterYard({ ...flight, menuOpen: true })).toBe(false);
  });

  it('Given photo over flight, When Y is pressed, Then the Yard does not open', () => {
    expect(mayEnterYard({ ...flight, overlay: 'photo' })).toBe(false);
  });

  it.each(['boot', 'title', 'map', 'yard', 'review'] as const)('Given base %s, When Y is pressed, Then nothing happens', (base) => {
    expect(mayEnterYard({ ...flight, base })).toBe(false);
  });

  it('Given a repeat or a modifier chord, When Y arrives, Then the Yard does not open', () => {
    expect(mayEnterYard(flight, { repeat: true })).toBe(false);
    expect(mayEnterYard(flight, { metaKey: true })).toBe(false);
  });
});

describe('yardOwnsInput', () => {
  it('Given the Yard with nothing on top, Then its controls answer', () => {
    expect(yardOwnsInput(yard)).toBe(true);
  });

  it('Given photo over the Yard, When Esc or an arrow is pressed, Then the Yard does not act on it', () => {
    expect(yardOwnsInput({ base: 'yard', overlay: 'photo' })).toBe(false);
  });

  it('Given any other base, Then the Yard does not own input', () => {
    expect(yardOwnsInput({ base: 'flight', overlay: null })).toBe(false);
  });
});
