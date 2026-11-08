/**
 * [v3-T1] A governor step must never resize the canvas between render and
 * present (it clears the drawing buffer → a black frame on screen).
 */

import { describe, expect, it } from 'vitest';
import { ResizeLatch } from './resizeLatch';

/** A frame as the engine runs it: maybe-resize, render, maybe-request. */
function frame(latch: ResizeLatch, log: string[], requestAfterRender: boolean): void {
  if (latch.takeBeforeRender()) log.push('resize');
  log.push('render');
  if (requestAfterRender) latch.request();
  log.push('present');
}

describe('ResizeLatch', () => {
  it('Given no request, Then a frame never resizes', () => {
    const l = new ResizeLatch();
    expect(l.takeBeforeRender()).toBe(false);
  });

  it('Given a request after a render, When that frame presents, Then nothing was resized between its render and its present', () => {
    const l = new ResizeLatch();
    const log: string[] = [];
    frame(l, log, true);
    expect(log).toEqual(['render', 'present']);
    expect(l.isPending).toBe(true);
  });

  it('Given a pending request, When the next frame starts, Then the resize happens before its render, exactly once', () => {
    const l = new ResizeLatch();
    const log: string[] = [];
    frame(l, log, true);
    frame(l, log, false);
    frame(l, log, false);
    expect(log).toEqual(['render', 'present', 'resize', 'render', 'present', 'render', 'present']);
  });

  it('Given many frames with requests, Then every "present" is directly preceded by a "render"', () => {
    const l = new ResizeLatch();
    const log: string[] = [];
    for (let i = 0; i < 50; i++) frame(l, log, i % 3 === 0);
    for (let i = 0; i < log.length; i++) if (log[i] === 'present') expect(log[i - 1]).toBe('render');
  });

  it('Given two requests in one frame, Then the next frame resizes once', () => {
    const l = new ResizeLatch();
    l.request();
    l.request();
    expect(l.takeBeforeRender()).toBe(true);
    expect(l.takeBeforeRender()).toBe(false);
  });
});
