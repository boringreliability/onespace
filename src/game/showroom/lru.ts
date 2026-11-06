/**
 * A least-recently-used map with an eviction callback.
 *
 * The Stage caches one assembled ship visual per parameter set, and in v1 that
 * cache only ever grew: fine for 21 review shots, a GPU leak for a player
 * paging through seeds in the Yard. Eviction is EXPLICIT (`trim`) rather than
 * on insert, because the Stage resolves a whole fleet before it lays it out,
 * and an insert-time eviction could free the hull resolved three lines
 * earlier for the same plate. `trim` takes a pin predicate for exactly that:
 * whatever is on stage now is never evicted, even if that leaves the cache
 * over capacity for a while.
 *
 * Built on `Map`'s insertion order: a touch is delete + re-insert, so the
 * first key is always the least recent.
 */

export class Lru<K, V> {
  private readonly map = new Map<K, V>();

  constructor(
    readonly capacity: number,
    private readonly onEvict: (key: K, value: V) => void,
  ) {}

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Read and mark as most recent. */
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  /** Read without touching recency. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  /** Insert or replace as most recent. Never evicts — see `trim`. */
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
  }

  /** Remove without the callback: the caller has taken ownership of the value. */
  delete(key: K): V | undefined {
    const v = this.map.get(key);
    this.map.delete(key);
    return v;
  }

  /** Evict least-recent entries until within capacity, skipping pinned ones. */
  trim(pinned?: (value: V, key: K) => boolean): void {
    if (this.map.size <= this.capacity) return;
    for (const [k, v] of this.map) {
      if (this.map.size <= this.capacity) break;
      if (pinned?.(v, k)) continue;
      this.map.delete(k);
      this.onEvict(k, v);
    }
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  /** Evict everything through the callback. */
  clear(): void {
    const entries = [...this.map];
    this.map.clear();
    for (const [k, v] of entries) this.onEvict(k, v);
  }
}
