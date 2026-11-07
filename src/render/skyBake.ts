/**
 * Schedule for baking the sky backdrop into a cubemap, one face per frame.
 *
 * The backdrop depends only on the galaxy, so it is integrated once per galaxy
 * and sampled thereafter. One face per frame keeps the bake (a supersampled
 * march over a 1024^2 face) inside a frame budget instead of a single hitch.
 * three-free so it is testable in node.
 */
export class SkyBakeSchedule {
  private key: string | null = null;
  private next = 0;

  /** True once all six faces hold the current key's sky. */
  get ready(): boolean {
    return this.key !== null && this.next >= 6;
  }

  /** Set the sky identity. Returns true if a rebake was started. */
  invalidate(key: string): boolean {
    if (key === this.key) return false;
    this.key = key;
    this.next = 0;
    return true;
  }

  /** Forget the bake (e.g. GPU context loss) without changing the key. */
  reset(): void {
    this.next = 0;
  }

  /** The face to bake now, or -1 when there is nothing to do. */
  nextFace(): number {
    if (this.key === null || this.next >= 6) return -1;
    return this.next;
  }

  faceDone(face: number): void {
    if (face === this.next && this.next < 6) this.next++;
  }
}
