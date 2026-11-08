/**
 * Draw a post pass's fullscreen quad without clearing the depth under it.
 *
 * The composer ping-pongs between two targets, and the scene's depth lives in
 * the attachment of whichever one the scene was drawn into. A post pass that
 * later writes into that same target (the grade does, every frame) used to go
 * through the renderer's autoClear, which wipes depth and stencil along with
 * colour — and that depth is exactly what `PostFX.sceneDepthTexture()` hands
 * every atmosphere and cloud deck on the next frame. They were reading a
 * cleared buffer: no aerial perspective, and haze and cloud painted straight
 * over the hull (v3 playtest 2026-11-08).
 *
 * The quads never depth-test or depth-write (every post material sets both
 * false), so the depth is simply none of their business: clear the colour as
 * before and leave the rest alone. `RenderPass` clears its own target
 * explicitly with these same flags, so they are restored however the draw ends.
 */

export interface PostQuadRenderer<T> {
  autoClearDepth: boolean;
  autoClearStencil: boolean;
  setRenderTarget(target: T | null): void;
}

export function drawPostQuad<T>(
  renderer: PostQuadRenderer<T>,
  target: T | null,
  draw: () => void,
): void {
  const depth = renderer.autoClearDepth;
  const stencil = renderer.autoClearStencil;
  renderer.setRenderTarget(target);
  renderer.autoClearDepth = false;
  renderer.autoClearStencil = false;
  try {
    draw();
  } finally {
    renderer.autoClearDepth = depth;
    renderer.autoClearStencil = stencil;
  }
}
