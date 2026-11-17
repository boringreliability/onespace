/**
 * The conflict screen's body names (v4 sub-plan 4, Task 6; R55, R58).
 *
 * A save stores its parent body by id; a card should read the body's name.
 * Names come from the generator, which is not cheap (a galaxy and a system),
 * so this is lazy and best-effort: nothing is generated until a card asks —
 * i.e. only when a conflict screen is actually shown — and anything that
 * fails answers null (the card then shows the id).
 */

import { generateGalaxy, sampleSystemsNear } from '@/gen/galaxy';
import { generateSystem } from '@/gen/system';
import type { GalaxySpec, PlanetSpec } from '@/gen/types';
import type { SaveV1 } from '@/save/schema';

/** `gx-<base36>:v1` → the universe seed (as bootLoad reads it). */
function seedOf(universeId: string): number | null {
  const m = /^gx-([0-9a-z]+):v1$/.exec(universeId);
  if (!m) return null;
  const n = parseInt(m[1]!, 36);
  return Number.isFinite(n) ? n >>> 0 : null;
}

/**
 * A resolver over the saves the screen may show: a body id is looked up in
 * the system of the save whose parent it is. Generated systems are cached.
 */
export function bodyNameResolver(saves: ReadonlyArray<SaveV1 | null>): (id: string) => string | null {
  const galaxies = new Map<number, GalaxySpec>();
  const names = new Map<string, Map<string, string> | null>();

  const systemNames = (s: SaveV1): Map<string, string> | null => {
    const key = `${s.universeId}|${s.player.system.id}`;
    if (names.has(key)) return names.get(key)!;
    let out: Map<string, string> | null = null;
    try {
      const seed = seedOf(s.universeId);
      if (seed !== null) {
        let g = galaxies.get(seed);
        if (!g) {
          g = generateGalaxy(seed);
          galaxies.set(seed, g);
        }
        const p = s.player.system.positionLy;
        const stub = sampleSystemsNear(g, [p[0], p[1], p[2]], 1, 8).find((x) => x.id === s.player.system.id);
        if (stub) {
          const spec = generateSystem(g, stub);
          out = new Map();
          const visit = (b: PlanetSpec): void => {
            out!.set(b.id, b.name);
            for (const m of b.moons) visit(m);
          };
          for (const pl of spec.planets) visit(pl);
        }
      }
    } catch {
      out = null;
    }
    names.set(key, out);
    return out;
  };

  return (id) => {
    for (const s of saves) {
      if (!s || s.player.parentId !== id) continue;
      const name = systemNames(s)?.get(id);
      if (name) return name;
    }
    return null;
  };
}
