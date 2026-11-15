// Negative control for purity.test.ts: deliberately impure. Imports `three`
// and reads `window` at module level. Never import this from app code.
import { Vector3 } from 'three';

export const origin = new Vector3();
export const w = window;
