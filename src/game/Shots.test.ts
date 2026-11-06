/**
 * Review shots and the mode machine. A shot is a mode now: setting one puts
 * the game in `review`, clearing it hands back the mode it interrupted, and
 * `shotOwnsScene()` keeps meaning exactly what it meant in v1.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { EngineContext } from '@/core/Engine';
import { modes } from '@/core/Modes';
import { activeShotName, clearShot, registerShot, setShot, shotOwnsScene } from './Shots';

const ctx = {} as EngineContext;
const torn: string[] = [];

beforeAll(() => {
  registerShot({ name: 'owned', description: '', apply() {}, teardown: () => void torn.push('owned') });
  registerShot({ name: 'owned-2', description: '', apply() {}, teardown: () => void torn.push('owned-2') });
  registerShot({ name: 'live', description: '', live: true, apply() {} });
  modes.go('flight');
});

describe('Shots and modes', () => {
  it('Given flight, When a shot is set, Then the mode is review and the shot owns the scene', async () => {
    await setShot('owned', ctx);
    expect(modes.base).toBe('review');
    expect(shotOwnsScene()).toBe(true);
  });

  it('Given a shot replaced by another, When cleared, Then the mode returns to flight (not to review)', async () => {
    await setShot('owned-2', ctx);
    expect(torn).toEqual(['owned']);
    clearShot(ctx);
    expect(modes.base).toBe('flight');
    expect(activeShotName()).toBeNull();
    expect(shotOwnsScene()).toBe(false);
  });

  it('Given an active shot, When cleared, Then its teardown runs', async () => {
    torn.length = 0;
    await setShot('owned', ctx);
    clearShot(ctx);
    expect(torn).toEqual(['owned']);
  });

  it('Given a live shot, When set, Then the mode is review but the shot does NOT own the scene', async () => {
    await setShot('live', ctx);
    expect(modes.base).toBe('review');
    expect(shotOwnsScene()).toBe(false);
    clearShot(ctx);
    expect(modes.base).toBe('flight');
  });

  it('Given the yard, When a shot is set and cleared, Then the yard comes back', async () => {
    modes.go('yard');
    await setShot('owned', ctx);
    expect(modes.base).toBe('review');
    clearShot(ctx);
    expect(modes.base).toBe('yard');
    modes.go('flight');
  });

  it('Given no active shot, When cleared, Then nothing changes', () => {
    clearShot(ctx);
    expect(modes.base).toBe('flight');
  });
});
