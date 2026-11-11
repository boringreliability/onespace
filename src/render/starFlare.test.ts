/**
 * The star's screen-space flare must not paint lens ghosts (owner, 2026-11-11).
 *
 * A ghost sits on the line from the star through the frame centre, so it moves
 * as the camera turns, and the drive-field aberration and motion blur then warp
 * it like any other pixel — it reads as an object in space you cannot reach,
 * not as optics. The halo, spikes and anamorphic streak stay: they are centred
 * on the star itself.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('./Star.ts', import.meta.url)), 'utf8');
const flare = src.slice(src.indexOf('const FLARE_FRAG'), src.indexOf('// StarRenderer'));

describe('star flare', () => {
  it('Given the flare shader, Then it paints no lens ghosts (nothing placed along the star–centre line)', () => {
    expect(flare.length).toBeGreaterThan(0);
    expect(flare).not.toMatch(/GHOSTS/);
    expect(flare).not.toMatch(/uStar\s*\*\s*ks\[/);
  });

  it('Given the flare shader, Then the star-centred terms remain (halo, spikes, streak)', () => {
    expect(flare).toMatch(/haloC/);
    expect(flare).toMatch(/spike/);
    expect(flare).toMatch(/streak/);
  });
});
