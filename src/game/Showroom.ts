/**
 * Showroom — re-export of `src/game/showroom/*`.
 *
 * The 2.9k-line module was split at its natural seams (docs/v2/SHOWROOM.md
 * §3): the stage itself, its camera solver, the named presets and the review
 * shot table. This file stays so `registry.ts`, `Traffic.ts`,
 * `render/ships/ShipMesh.ts` and `scripts/ship-review.mjs` keep importing
 * from the path they always have.
 */

export * from './showroom/Stage';
export * from './showroom/camera';
export * from './showroom/presets';
export * from './showroom/shots';
