/**
 * `J` — the jump key.
 *
 * It used to be dead: only Cruise read it, and only to cancel cruise. A jump
 * took M, wheel out, click, Enter. Now `J` jumps to whatever is selected on
 * the galaxy chart, and when nothing is, it says how to select something
 * rather than doing nothing.
 */

import { describe, expect, it } from 'vitest';

import { JUMP_NO_SELECTION_HINT, resolveJumpKey } from './jumpKey';

const origin = 'sys-origin';
const target = { id: 'sys-b', name: 'Kessa', distanceLy: 12.5 };

describe('resolveJumpKey', () => {
  it('Given a system selected on the chart and the drive idle, When J is pressed, Then a jump to it is requested', () => {
    expect(resolveJumpKey({ selection: target, originId: origin, warpIdle: true })).toEqual({
      kind: 'jump',
      systemId: 'sys-b',
      name: 'Kessa',
      distanceLy: 12.5,
    });
  });

  it('Given nothing selected, When J is pressed, Then the pilot is told how to select a system', () => {
    const r = resolveJumpKey({ selection: null, originId: origin, warpIdle: true });
    expect(r).toEqual({ kind: 'hint', text: JUMP_NO_SELECTION_HINT });
    expect(JUMP_NO_SELECTION_HINT).toBe('SELECT A SYSTEM ON THE CHART — M');
  });

  it('Given the selection is the system we are already in, When J is pressed, Then it is treated as no selection', () => {
    const r = resolveJumpKey({
      selection: { id: origin, name: 'Here', distanceLy: 0 },
      originId: origin,
      warpIdle: true,
    });
    expect(r).toEqual({ kind: 'hint', text: JUMP_NO_SELECTION_HINT });
  });

  it('Given a jump already running, When J is pressed, Then nothing happens (the drive says its own piece)', () => {
    expect(resolveJumpKey({ selection: target, originId: origin, warpIdle: false })).toEqual({
      kind: 'none',
    });
  });
});
