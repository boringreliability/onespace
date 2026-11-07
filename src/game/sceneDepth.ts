/**
 * Hands this frame's scene depth to every atmosphere (and, through its shared
 * uniforms, the cloud deck) in the system.
 *
 * `PostFX.sceneDepthTexture()` is the idle half of a ping-pong pair: which of
 * the two depth textures it names flips as the composer swaps buffers. A shell
 * that keeps last frame's answer is therefore sampling the depth attachment the
 * scene pass is writing into on every other frame — a feedback loop, which
 * Chromium rejects per draw ("Feedback loop formed between Framebuffer and
 * active Texture"). So this must run every frame the bodies are drawn, frozen
 * or not, not only on frames that advance the simulation.
 */

import type { Texture } from 'three';

export interface DepthReader {
  setDepthTexture(depth: Texture | null): void;
}

export function publishSceneDepth(
  bodies: Iterable<{ atmosphere: DepthReader | null }>,
  depth: Texture | null,
): void {
  for (const b of bodies) b.atmosphere?.setDepthTexture(depth);
}
