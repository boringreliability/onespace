/**
 * [v3-T1] Where in the frame a drawing-buffer resize may happen.
 *
 * Resizing a WebGL canvas (`renderer.setSize` / `setPixelRatio` → new
 * `canvas.width`/`height`) CLEARS the drawing buffer. v2's resolution
 * governor resized right after `render()`, in the same rAF task — so the
 * browser presented the freshly cleared buffer: one fully black scene frame
 * (only the DOM HUD on top) at every governor step. The owner caught one in a
 * screenshot.
 *
 * The latch makes the order explicit: a resize requested after the render is
 * held, and taken at the START of the next frame, before anything is drawn
 * into the new buffer. A frame is therefore always rendered into the buffer
 * the browser presents.
 */
export class ResizeLatch {
  private pending = false;

  /** Ask for a resize. Never applied immediately. */
  request(): void {
    this.pending = true;
  }

  /** At the start of a frame, before rendering: true once per request. */
  takeBeforeRender(): boolean {
    if (!this.pending) return false;
    this.pending = false;
    return true;
  }

  get isPending(): boolean {
    return this.pending;
  }
}
