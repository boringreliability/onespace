import { describe, expect, it } from 'vitest';
import { Texture } from 'three';

import { publishSceneDepth, type DepthReader } from './sceneDepth';

function shell(): DepthReader & { depth: Texture | null | undefined } {
  const s = {
    depth: undefined as Texture | null | undefined,
    setDepthTexture(d: Texture | null) {
      s.depth = d;
    },
  };
  return s;
}

describe('publishSceneDepth', () => {
  it('Given shells holding last frame\'s depth, When the composer has swapped buffers, Then every shell is moved to the new idle depth', () => {
    const a = new Texture();
    const b = new Texture();
    const shells = [shell(), shell()];
    const bodies = [{ atmosphere: shells[0]! }, { atmosphere: null }, { atmosphere: shells[1]! }];

    publishSceneDepth(bodies, a);
    publishSceneDepth(bodies, b);

    expect(shells.map((s) => s.depth)).toEqual([b, b]);
  });

  it('Given the pipeline withdrew its depth (null), When published, Then the shells fall back to analytic instead of keeping a stale attachment', () => {
    const s = shell();
    publishSceneDepth([{ atmosphere: s }], new Texture());
    publishSceneDepth([{ atmosphere: s }], null);
    expect(s.depth).toBeNull();
  });

  it('Given a world with both an atmosphere and a cloud deck, When depth is published, Then the deck gets it too — inside the deck there is no depth test, and without it cloud behind the hull is drawn over the hull', () => {
    const atmo = shell();
    const deck = shell();
    const d = new Texture();
    publishSceneDepth([{ atmosphere: atmo, clouds: deck }, { atmosphere: null, clouds: null }], d);
    expect(atmo.depth).toBe(d);
    expect(deck.depth).toBe(d);
  });

  it('Given a deck holding last frame\'s depth, When the pipeline withdraws it, Then the deck lets go as well (a stale attachment is a feedback loop on the next swap)', () => {
    const deck = shell();
    publishSceneDepth([{ atmosphere: null, clouds: deck }], new Texture());
    publishSceneDepth([{ atmosphere: null, clouds: deck }], null);
    expect(deck.depth).toBeNull();
  });
});
