# oneSpace: performance-audit

*Audit af `main` @ 6bb512d, 2026-11-06.*

## Kort fortalt

Spillet er **GPU-bundet**, ikke CPU- eller dev-server-bundet.

- Main thread er ~88 % idle, og `step()` tager 1-3 ms.
- Frames tager 60-260 ms på en M4 Pro ved DPR 2. Dev og prod er lige langsomme under kørsel.

Tre hovedårsager:

1. **Terrain beregnes forfra i vertex-shaderen hver frame.** Det er 5 fulde
   evalueringer pr. vertex, hver med 11-13 oktaver fbm og ridged, warp og kratere.
2. **Fuld retina** (`maxPixelRatio: 2`), dvs. 3200×1800 = 5,8 Mpx.
3. **Adaptiv opløsning, der ikke kan se GPU-tid.** Den har stået på 1.0 i alle målinger.

Oven i det kommer hitches: lazy shader-compile (140-740 ms og 2,8 s ved kold
cache) og synkron skibsgenerering (~600 ms).

## Miljø og metode

- **Maskine og GPU:** Apple M4 Pro, Chromium med `--use-angle=metal --enable-gpu --ignore-gpu-blocklist`. Rendereren var den rigtige GPU: `ANGLE Metal Renderer: Apple M4 Pro`. `detectTier` valgte `high`.
- **SwiftShader-fælde:** Playwrights default headless og `scripts/shoot.mjs` (`--use-angle=default --enable-unsafe-swiftshader`) kører på SwiftShader. Deres fps-tal kan ikke bruges til at vurdere performance.
- **Viewport:** 1600×900 ved DPR 2. En fuld MacBook-skærm har ~34 % flere pixels.
- **Støj:** en anden agent delte GPU'en undervejs. Absolutte tal kan være op til ~2× for høje. Konklusionerne bygger derfor på interleavede A/B-målinger (median af forholdet, 3-4 gentagelser).
- **Kontrol:** en tom fullscreen WebGL-side giver 8,3 ms (120 Hz) både ved DPR 1 og 2.
- **Ingen direkte GPU-tid pr. pass:** timer-queries på ANGLE/Metal måler hele command-bufferen. GPU-omkostningen er derfor fundet ved *ablation*, altså ved at slå dele fra én ad gangen.

## Målinger (prod, median frame-tid)

| Scene | DPR 2 | DPR 1 | CPU `step()` | Tris | Calls |
|---|---|---|---|---|---|
| play (opening) | **112 ms** | 83 ms | 1,1 ms | 1,5 M | ~195 |
| planet-approach | **211-264 ms** | 102 ms | 2,3 ms | 0,35 M | 70 |
| planet-orbit | 64-74 ms | 35 ms | 0,9 ms | ~1 M | 125-139 |
| atmosphere-sunset | 162-168 ms | 92 ms | 3 ms | 0,3-0,5 M | 105-150 |
| clouds-orbit | 109 ms | – | 1,2 ms | 0,3 M | 68 |
| nebula-hero | 61 ms | – | 0,5 ms | 91 k | 41 |
| warp-tunnel (næsten tom) | **32 ms** | **8,3 ms** | 0,5 ms | 26 k | 36 |
| galaxy-map / gas-giant | 31-33 ms | – | 0,5 ms | 20-165 k | 34-38 |

Draw calls ligger langt under budgettet på 400. Problemet er, hvad hver vertex og hver pixel koster.

### Boot

| | dev kold | dev varm | prod |
|---|---|---|---|
| Tid til `__osReady` | 605 ms | 200 ms | 188-198 ms |
| Requests / overført | 63 / 9,6 MB | 63 / 9,6 MB | 2 / 0,53 MB |
| Long task ved første frame | 2.803 ms (kold shader-cache) | 268 ms | 259-291 ms |
| Hitch ~1,5 s efter boot | ~590 ms | ~590 ms | ~610-630 ms |

### Ablation (opening-scenen)

| Ændring | Besparelse |
|---|---|
| pixelRatio 2 → 1 | **40 %** |
| pixelRatio 2 → 1,5 | 15 % |
| Planet-patches skjult | **24 %** |
| Ocean skjult | 15 % |
| Sky-backdrop skjult | 7 % |
| Star skjult | 6 % |
| Atmosphere, clouds, sky-points, traffic, PostFX | ~0 % (inden for støjen) |
| **Ved pixelRatio 0,25 med planet-patches skjult** | **191 → 25,6 ms (−87 %)** |

Den sidste række er det afgørende bevis: når pixelomkostningen er fjernet, er terrain-arbejdet næsten hele framen.

### Shaders og CPU

- **Shader-compile:** 31 programmer ved boot og 48 efter alle scener. Hvert nyt område giver 1-5 links og long tasks på 142-739 ms.
- **CPU-benchmarks i node:**

| Kald | Tid |
|---|---|
| `generateShip` | 40 ms varm / 75 ms kold |
| `createShipVisual` | 33-44 ms |
| `generateStarField(160k)` | 40 ms |
| `sampleTerrain` | 17 µs pr. sample |
| `new PlanetRenderer` | 7-10 ms |
| `generateGalaxy` | 1 ms |
| `pickStartSystem` | 13 ms |

- **Moduler:** `update()` koster højst 1-2,4 ms (universe). HUD koster 0,06 ms, og DOM-ablation gav 0 %.

## Rodårsager

### 1. Terrain pr. vertex hver frame (~50-85 % af GPU-tiden nær en planet)

**Hvor det sker:**
- `Planet.ts:252` beregner `os_terrainHeight`.
- `Planet.ts:274` beregner `os_terrainNormal`, som laver 4 ekstra fulde evalueringer (`gen/terrain.ts:1550-1568`).
- Antallet af oktaver kommer fra `gen/system.ts:619-703`.
- `buildPatch` (`Planet.ts:1794`) bygger kun et fladt grid. Højden regnes igen hver frame, selvom en patch' geometri aldrig ændrer sig.

**Omfang:** ~1,43 M tris, ~0,7 M vertices og ~3,7 M terrain-evalueringer pr. frame. Fragment-shaderens skygge-march (`Planet.ts:549-565`, 4 steps) og ocean-dybden (`Planet.ts:826`) laver også fulde evalueringer pr. pixel. Derfor er planet-approach 2,6× langsommere ved DPR 2.

**Løsninger:**
- Hurtigt (S): `patchResolution` 65 → 33 på high.
- Rigtigt (M): bag højde og normal én gang pr. patch med den eksisterende `terrainGlsl()` i en render-to-texture-tile. Vertex-shaderen laver så kun et teksturopslag, og skygge og ocean sampler den samme tekstur. Forventet: 40-80 %.

### 2. Fuld retina og et fuldskærms-stack (~40 %)

- `Config.ts:84,106` sætter `maxPixelRatio: 2`.
- Disse passes kører i fuld opløsning:
  - scene-pass med log-depth
  - `SceneSpacePass` med 8 AO- og 8 motion-blur-samples (`PostFX.ts:164-290`)
  - sky-backdrop med 40 steps og 5 fbm pr. pixel, selvom billedet er statisk (`Sky.ts:239`, `:793`)

**Løsning:**
- (S) Sæt high til DPR 1,0-1,25 og ultra til 1,5, og upscale med sharpen.
- (S/M) Bag sky til en cubemap pr. system.

### 3. Den adaptive opløsning virker aldrig

- `Engine.ts:202` måler `performance.now()` rundt om `step()`, altså kun CPU og submit.
- Når skalaen justeres, reallokerer `applySize` → `pipeline.resize` alle HalfFloat-render-targets (`PostFX.ts:1514`), hver 30. frame.

**Løsning:**
- (S) Mål frame-tid som wall-clock mellem rAF-kald, med hysterese.
- (M) Brug faste render targets med skaleret viewport.

### 4. Lazy shader-compile

- Der er ingen kald til `compile` eller `compileAsync`.
- `Universe.acquireRenderers` (`Universe.ts:653-680`) opretter planet-renderere synkront ved 60 R.
- `streamRenderers` (`Universe.ts:623`) har ingen hysterese.

**Løsning (S):** `compileAsync`-prewarm bag boot, `checkShaderErrors` kun i dev, og hysterese (opret ved 60 R, frigiv ved 75 R).

### 5. `logarithmicDepthBuffer` slår early-Z fra (`Engine.ts:94`)

- `gl_FragDepth` skrives 126 steder i 12 filer.
- Effekten er ikke målt isoleret.

**Løsning (M):** reversed-Z med `EXT_clip_control`, som three r180 understøtter.

### 6. Synkron skibsgenerering

- `Traffic.populate()` (`Traffic.ts:151-232`) kører i første frame og ved hvert systemskift, med op til 4 × `generateShip`.
- `createShipVisual` (`Traffic.ts:337`) kommer oveni, plus første compile. Tilsammen giver det ~600 ms.

**Løsning:**
- (M) Web Worker med `Transferable`-buffere.
- Indtil da (S): højst ét skib pr. frame.

### 7. Mindre punkter

- Der allokeres pr. frame i `Engine.context`-getteren (`Engine.ts:131`) og i `streamRenderers` (`new Set`/`slice`/`sort`). Det koster under 0,1 ms, men bryder ARCHITECTURE §5.
- Gallery bygger en ekstra planet, nebula og ringe ved boot (`registry.ts:120-140`). Den bør bygges lazy.
- Der findes ingen kvalitetsvælger i UI. `setTier` kaldes kun i `Showroom.ts:1895`.

## Dev-server

Under kørsel er dev = prod (play 112,9 mod 112,2 ms, warp 31,7 mod 32 ms). Der er ingen `import.meta.env`-grene. Det dev-specifikke er:

- **Kold transform:** 63 modul-requests og 9,6 MB med inline sourcemaps (605 ms mod 200 ms varm).
- **Ingen HMR:** `import.meta.hot` bruges ingen steder. Hver gemning er en fuld reload med ny boot, ny skibsgenerering (~0,6 s) og ny shader-compile. Ændres shader-tekst, fryser det ~2,8 s.
- **Rigtig Chrome:** på fuld retina (~7,7 Mpx), ofte med DevTools åbne, og med andre faner eller harnesses på samme GPU.

**Løsninger (alle S):**
- Gem seed og kamera i `sessionStorage`.
- `import.meta.hot.accept` på shader-moduler.
- `?tier=` og `?dpr=`.
- `server.warmup` for `main.ts` og `registry.ts`.
- `shoot.mjs` → `--use-angle=metal`.

## Prioriteret fix-liste

| # | Fix | Effort | Gevinst |
|---|---|---|---|
| 1 | Cap DPR (high 1-1,25, ultra 1,5) | S | −40-60 % på fill-bundne scener |
| 2 | Adaptiv opløsning på wall-clock + hysterese | S | Holder 60 fps-målet |
| 3 | `patchResolution` 33, derefter bagt højde og normal | S→M | −20-25 % nu, −40-80 % senere |
| 4 | `compileAsync`-prewarm og streaming-hysterese | S | Hitches på 140-740 ms og 2,8 s forsvinder |
| 5 | Sky-backdrop som cubemap | S/M | −7 % altid |
| 6 | Skygge-march og ocean fra bagt tekstur | M | Stort nær overfladen |
| 7 | Skibsgenerering i worker, ét skib pr. frame | M | ~600 ms hitch forsvinder |
| 8 | Reversed-Z i stedet for log-depth | M | Early-Z tilbage (umålt) |
| 9 | Faste render targets med skaleret viewport | M | Ingen reallokering |
| 10 | Kvalitetsmenu og `?tier`/`?dpr` | S | Brugeren kan skalere selv |
| 11 | Lazy Gallery, fjern allokeringer pr. frame | S | Overholder §5 |

## Perf-arkitektur til v2

1. **`PerfGovernor`** på wall-clock. Den skalerer i rækkefølgen render-scale, så raymarch-steps, så LOD-dybde.
2. **Opstart:** start på DPR ≤ 1,25, og vælg tier med en kort benchmark bag boot. Valget gemmes i `localStorage`.
3. **Web Worker-pool til generering**, der sender `Transferable`-buffere. Terrain bages på GPU'en med samme GLSL.
4. **Bag alt statisk:** terrain-tiles, sky-cubemap og star-LUT. Regel: ingen fbm i en vertex-shader, der kører hver frame.
5. **Materialeregister** med `compileAsync`-prewarm og prefetch af næste zone.
6. **Streaming** med hysterese og look-ahead (afstand × hastighed).
7. **Kontrakten `GameModule.active(ctx)`.**
8. **Perf-overlay på F3:** wall-ms, CPU pr. modul, scale, calls, tris, programmer og long tasks.
9. **Perf-regression i CI:**
   - Playwright + Metal kører en fast sekvens og fejler ved +10 %.
   - En vitest `perf:budget` holder generatorer under budget (fx `generateShip` < 10 ms).
