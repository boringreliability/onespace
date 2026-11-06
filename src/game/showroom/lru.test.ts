/**
 * The Stage's visual cache: least-recently-used, bounded, and never evicting
 * a hull that is on stage right now.
 */

import { describe, expect, it } from 'vitest';
import { Lru } from './lru';

function make(capacity: number) {
  const evicted: string[] = [];
  const lru = new Lru<string, string>(capacity, (k) => evicted.push(k));
  return { lru, evicted };
}

describe('Lru', () => {
  it('Given an empty cache, When a key is set and read, Then the value comes back', () => {
    const { lru } = make(2);
    lru.set('a', 'A');
    expect(lru.get('a')).toBe('A');
    expect(lru.size).toBe(1);
  });

  it('Given a full cache, When set goes over capacity, Then nothing is evicted until trim', () => {
    const { lru, evicted } = make(2);
    lru.set('a', 'A');
    lru.set('b', 'B');
    lru.set('c', 'C');
    expect(evicted).toEqual([]);
    expect(lru.size).toBe(3);
    lru.trim();
    expect(evicted).toEqual(['a']);
    expect(lru.size).toBe(2);
  });

  it('Given a, b and a read of a, When c is added and trimmed, Then b (least recent) is evicted', () => {
    const { lru, evicted } = make(2);
    lru.set('a', 'A');
    lru.set('b', 'B');
    lru.get('a');
    lru.set('c', 'C');
    lru.trim();
    expect(evicted).toEqual(['b']);
    expect(lru.has('a')).toBe(true);
    expect(lru.has('c')).toBe(true);
  });

  it('Given pinned entries, When trimmed, Then pinned ones survive even if that leaves the cache over capacity', () => {
    const { lru, evicted } = make(1);
    lru.set('a', 'A');
    lru.set('b', 'B');
    lru.set('c', 'C');
    lru.trim((v) => v === 'A' || v === 'B');
    expect(evicted).toEqual(['c']);
    expect(lru.size).toBe(2);
  });

  it('Given peek, When it reads a key, Then recency is not changed', () => {
    const { lru, evicted } = make(1);
    lru.set('a', 'A');
    lru.set('b', 'B');
    expect(lru.peek('a')).toBe('A');
    lru.trim();
    expect(evicted).toEqual(['a']);
  });

  it('Given delete, When a key is removed, Then onEvict is NOT called (the caller owns it now)', () => {
    const { lru, evicted } = make(2);
    lru.set('a', 'A');
    expect(lru.delete('a')).toBe('A');
    expect(evicted).toEqual([]);
    expect(lru.has('a')).toBe(false);
  });

  it('Given a cache, When cleared, Then every entry is evicted through the callback', () => {
    const { lru, evicted } = make(4);
    lru.set('a', 'A');
    lru.set('b', 'B');
    lru.clear();
    expect(evicted.sort()).toEqual(['a', 'b']);
    expect(lru.size).toBe(0);
  });

  it('Given a key set twice, When trimmed, Then the old value is replaced without being evicted', () => {
    const { lru, evicted } = make(2);
    lru.set('a', 'A1');
    lru.set('a', 'A2');
    expect(lru.get('a')).toBe('A2');
    expect(lru.size).toBe(1);
    expect(evicted).toEqual([]);
  });

  it('Given values(), Then every value is listed', () => {
    const { lru } = make(3);
    lru.set('a', 'A');
    lru.set('b', 'B');
    expect([...lru.values()].sort()).toEqual(['A', 'B']);
  });
});
