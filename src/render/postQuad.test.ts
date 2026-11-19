/**
 * The scene depth that every atmosphere and cloud deck reads in flight is the
 * depth attachment of the composer buffer the scene was drawn into last frame.
 * The grade pass draws its fullscreen quad into that same buffer, and with the
 * renderer's default autoClear the draw cleared its depth first — so the shells
 * were handed an empty depth texture every frame (measured on GPU: 0 % of
 * texels held geometry), and the hull disappeared under haze and cloud.
 */

import { describe, expect, it } from 'vitest';

import { drawPostQuad, type PostQuadRenderer } from './postQuad';

interface Stub extends PostQuadRenderer<object> {
  autoClear: boolean;
  autoClearColor: boolean;
  target: object | null | 'unset';
  calls: Array<{ target: object | null | 'unset'; color: boolean; depth: boolean; stencil: boolean; autoClear: boolean }>;
}

function renderer(): Stub {
  const r: Stub = {
    autoClear: true,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
    target: 'unset',
    calls: [],
    setRenderTarget(t: object | null) {
      r.target = t;
    },
  };
  return r;
}

describe('drawPostQuad', () => {
  it('Given a renderer that auto-clears, When a post pass draws into a ping-pong buffer, Then the colour is cleared but the depth and stencil the scene left there are not', () => {
    const r = renderer();
    const buffer = {};
    drawPostQuad(r, buffer, () => {
      r.calls.push({ target: r.target, color: r.autoClearColor, depth: r.autoClearDepth, stencil: r.autoClearStencil, autoClear: r.autoClear });
    });
    expect(r.calls).toEqual([{ target: buffer, color: true, depth: false, stencil: false, autoClear: true }]);
  });

  it('Given the draw has run, Then the renderer\'s clear flags are exactly as they were (RenderPass clears its own target with them next frame)', () => {
    const r = renderer();
    r.autoClearDepth = true;
    r.autoClearStencil = false;
    drawPostQuad(r, {}, () => {});
    expect([r.autoClearDepth, r.autoClearStencil]).toEqual([true, false]);
  });

  it('Given the draw throws, Then the flags are still restored', () => {
    const r = renderer();
    expect(() =>
      drawPostQuad(r, {}, () => {
        throw new Error('lost context');
      }),
    ).toThrow('lost context');
    expect([r.autoClearDepth, r.autoClearStencil]).toEqual([true, true]);
  });

  it('Given the pass draws to the screen (null target), Then it draws there too, and the depth is left alone just the same', () => {
    const r = renderer();
    let seen: unknown = 'unset';
    drawPostQuad(r, null, () => {
      seen = r.target;
      expect(r.autoClearDepth).toBe(false);
    });
    expect(seen).toBeNull();
  });
});
