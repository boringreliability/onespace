/**
 * The cloud deck against the scene depth (v3 playtest, 2026-11-08: "the
 * atmosphere nearly hides our ship"). Low over a cloudy world the camera is
 * inside the deck's shell, where the composite cannot depth-test — so the only
 * thing that can stop cloud *behind* the hull being painted over it is the
 * march itself ending at the scene depth, as the atmosphere's already does.
 * The GPU half is measured in the browser (hull luminance with and without the
 * deck); what is pinned here is that the march is handed the depth and reads it.
 */

import { describe, expect, it } from 'vitest';
import { Texture, type ShaderMaterial } from 'three';

import { config } from '@/core/Config';
import { generateGalaxy, sampleSystemsNear } from '@/gen/galaxy';
import { generateSystem } from '@/gen/system';
import type { PlanetSpec } from '@/gen/types';
import { CloudRenderer } from './Clouds';

const GALAXY = generateGalaxy(0x51a1);
const STUBS = sampleSystemsNear(GALAXY, [GALAXY.radiusLy * 0.3, 0, 0], 300, 60);

function cloudyWorld(): PlanetSpec {
  for (const s of STUBS) {
    const w = generateSystem(GALAXY, s).planets.find((p) => p.clouds);
    if (w) return w;
  }
  throw new Error('fixture: no cloudy world in the sample');
}

function march(r: CloudRenderer): ShaderMaterial {
  return (r as unknown as { marchMaterial: ShaderMaterial }).marchMaterial;
}

describe('CloudRenderer — scene depth', () => {
  it('Given a cloud deck, When it is handed the scene depth, Then the march reads that texture and knows it has one', () => {
    const r = new CloudRenderer(cloudyWorld(), config.quality);
    const depth = new Texture();
    r.setDepthTexture(depth);
    expect(march(r).uniforms.uDepthTex!.value).toBe(depth);
    expect(march(r).uniforms.uHasDepth!.value).toBe(1);
    r.dispose();
  });

  it('Given a deck with depth, When the depth is withdrawn (null), Then the march falls back to the analytic planet and its sampler stays bound to a known texture, never null', () => {
    const r = new CloudRenderer(cloudyWorld(), config.quality);
    r.setDepthTexture(new Texture());
    r.setDepthTexture(null);
    expect(march(r).uniforms.uHasDepth!.value).toBe(0);
    expect(march(r).uniforms.uDepthTex!.value).toBeInstanceOf(Texture);
    r.dispose();
  });

  it('Given a deck that was never handed depth, Then it starts on the analytic fallback (a tier or host without a pipeline still draws a deck)', () => {
    const r = new CloudRenderer(cloudyWorld(), config.quality);
    expect(march(r).uniforms.uHasDepth!.value).toBe(0);
    expect(march(r).uniforms.uDepthTex!.value).toBeInstanceOf(Texture);
    r.dispose();
  });

  it('Given the march shader, Then it ends the ray at the decoded scene depth along the ray (log depth, divided by the cosine to the camera axis), gated on uHasDepth', () => {
    const fs = march(new CloudRenderer(cloudyWorld(), config.quality)).fragmentShader;
    expect(fs).toMatch(/uniform\s+sampler2D\s+uDepthTex/);
    expect(fs).toMatch(/uHasDepth\s*>\s*0\.5/);
    expect(fs).toMatch(/exp2\(\s*\w+\s*\*\s*uLogFar\s*\)\s*-\s*1\.0/);
    expect(fs).toMatch(/t1\s*=\s*min\(\s*t1\s*,/);
  });
});
