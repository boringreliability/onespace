# oneSpace: "Showroom m.m." til v2

*Audit af `main` @ 6bb512d, 2026-11-06.*

## Kort fortalt

- **Showroom-motoren kan bruges af spillere allerede.** Den har isolering, cache, multi-ship-layout, kamera-fit, lys og skalafigur. Det, der mangler, er en ejer af tilstanden: input, UI, en vej ind og en vej ud.
- **Det største hul er arkitekturen, ikke showroomet.** Der findes ingen modes. Syv moduler spørger hver for sig et globalt flag, `shotOwnsScene()`. Ved siden af lever en pause i `Universe.paused`, og alle 17 moduler tikker hver frame.
- **Forslag til v2:**
  - mode-maskine
  - URL-routing
  - titelskærm
  - Ship Yard
  - minimalt photo mode
  - dev-overlay bag `?dev`
- **"Flyv dette skib" venter til v3.** `Ship.ts` er frosset af BRIEF §2, og kamera og flight er tunet til et skib på 30 m.
- **Seed-deling kræver en versionsvagt først.** `generationVersion` styrer ingenting i dag.

## 1. Hvad findes

### 1.1 `src/game/Showroom.ts` (2.907 linjer)

**Kontrakter og hjælpeobjekter**
- `ShipVisual`-kontrakt og factory (`:94`, `:113`, `:140-151`). Factoryen kobles på i `registry.ts:329`.
- `BlockoutVisual`-fallback (`:443`).
- Skalareference (`:539`, `:1201`).
- Silhuet-materiale (`:179-290`, `:1253`).

**`class Showroom` (`:855`)**
- `enter`, `isolate` og `exit` (`:932`, `:947`, `:962`) skjuler resten af scenen efter identitet og gendanner synligheden igen.
- `configure(ctx, ShowroomSetup)` (`:764`, `:999`) styrer skibssæt, tier, silhuet, LOD, drive, lys, skala, spacing, rows og pose.
- Cachen (`:1180`) er ubegrænset.

**Kamera, opdatering og indhold**
- Kamera: `aim` med `layout|hull|engine|hardware|scale` (`:1321`) og fit-solveren `placeCamera` (`:2656`, privat).
- `update` og `lateUpdate` (`:1602-1650`) returnerer straks, når showroomet er inaktivt, og allokerer ikke.
- Skibssæt: `HERO_SHIP`, `WRECK_SHIP`, `FAMILY_FLEET` og `FACTION_FLEET` (`:1913-1974`).
- Drive-presets: CRUISE, BURN og COLD.
- Kun `KEY_LIGHT` er navngivet. Andre lysopsætninger er overrides i de enkelte shots.
- 22 review-shots.

**Mangler:** turntable, orbit- og zoom-input, UI, offentlig API og baggrund. Baggrunden er altid sort.

### 1.2 Gallery (`registry.ts:104`)

- Gallery er én fast review-fixture: planet, ringe (eller `FALLBACK_RINGS`) og nebula.
- `ReviewGuard` (`:215`) viser den kun for `GALLERY_SHOTS`.

### 1.3 Wiring

- `shotOwnsScene()` (`Shots.ts:82`) er i praksis spillets mode-system. Det tjekkes i Universe, Pilot, Traffic, Cruise og MapMode.
- `activeShotName()` tjekkes i Codex, SystemMap, Clouds, Atmosphere og registry.
- `Universe.paused` sættes af MapMode.
- `clearShot()` er ikke eksponeret, så man kan ikke komme tilbage fra et shot.
- `Engine.step()` kalder alle moduler uden betingelser.

### 1.4 Hvad kan vises

**Skibe**
- `generateShip(ShipParams)` tager seed, faction, role, sizeClass, ageYears, damageLevel, maintenance og generationVersion.
- Indholdet tæller 3 fraktioner med 3 skrog-familier hver, 18 roller og 6 størrelsesklasser.
- Specs findes allerede: `shipScanLines` (`physics.ts:2548`) og `shipPhysicsProfile` (`:2389`).

**Galakse og system**
- `generateGalaxy`, `generateSystem` og `generatePlanet`.
- `Universe` tager en seed-option, men `registry.ts` sender den aldrig.

### 1.5 Målinger

| Situation | Calls | Tris | Note |
|---|---|---|---|
| Flight | 160 | 1,21 M | |
| ship-showroom-hero | 32 | 54 k | |
| ship-fleet-factions | 45 | 134 k | 3 skrog genereres på 192 ms synkront |

- Efter `__osSettle` bliver `fixedDt` stående på 1/60. Det giver slow-motion, hvis man vender tilbage til spillet.

### 1.6 Det ucommittede MAP-Elites-arbejde

- `applyEvolvedHeroSculpt(ctx, rng)` kalder `rng.next()` for alle fraktioner via `:default`. Det forskyder hele RNG-strømmen, så alle seeds giver andre skibe end i dag, også HERO_SHIP, FACTION_FLEET og trafik.
- `SHIP_GENERATION_VERSION` er stadig 1 og bliver kun stemplet på resultatet. Den vælger ikke kode.
- Hygiejne: den nye funktion står mellem doc-kommentaren for `enforceSalvageMassing` og selve funktionen, og der er et `import` over fil-headeren.

### 1.7 Hvad mangler for spillere

1. Modes og gating af moduler.
2. En vej ind og ud. `exit()` gendanner ikke kameraet.
3. Save og restore af flight: kamera, `camera.up`, `fixedDt`, pointer lock, rig-mode og HUD.
4. Input. Klik beder om pointer lock overalt.
5. UI.
6. Generering uden hak.
7. URL-parametre. `URLSearchParams` findes ingen steder i koden.
8. Lys-presets.
9. En offentlig `placeCamera`.
10. Et grade-API i PostFX. Kun `setExposureBias` findes.

## 2. Design

Grundideen er, at **The Yard er et værft og et skibsregister i fiktionen**, ikke en asset-viewer.

- **Typografi:** samme som Codex og HUD. Specs vises som dot-leader readouts.
- **Baggrund:** "void" er standard. "anchorage" lægger en fjern occluder ind (silhuetten af en gasgigant), så kompositionen virker.
- **Skift af skib:** lyset fader ned og op igen. Ingen snap, og genereringstiden skjules.

### Scope

| # | Feature | Prioritet | Effort |
|---|---|---|---|
| A | Mode-maskine og gating i Engine | MUST | M |
| B | URL-routing | MUST | S |
| K | Versionsvagt og golden-test | MUST | S |
| C | Titelskærm | MUST | S |
| D | Ship Yard | MUST | M-L |
| E | Photo mode (minimal) | SHOULD (høj) | M |
| F | Dev-overlay bag `?dev` | SHOULD | S |
| G | Sammenlign | SHOULD | S |
| H | Body viewer | LATER (v2.1) | M-L |
| I | Seed- og univers-browser | LATER | L |
| J | "Flyv dette skib" | LATER (v3) | L |

### Flow

```
boot → TITLE ──UNDOCK──▶ FLIGHT ──M──▶ MAP ──Esc──▶ FLIGHT
         │                 │ Y   ▲Esc          P (overlay, stack)
         └──THE YARD──▶   YARD ──P──▶ PHOTO ──Esc──▶ forrige mode
SEED-felt → reload ?seed=…
```

### Skitser

**Titelskærm**

```
                     O  N  E  S  P  A  C  E
               a procedurally generated noir odyssey
                       ▸ UNDOCK
                         THE YARD
                         SETTINGS          quality [ HIGH ▾ ]
  seed 0x5C0117 [ edit ]                          v0.2 · gen 2
```

**The Yard**

```
┌ THE YARD · KESSLER PLATELINE ───────────────────── [⎘ LINK] [Esc] ┐
│ FACTION ▸kessler      ╱▔▔▔▔▔▔▔╲__            class ...... plateline │
│   sillane  ossuary ≡▶▕ [skrog]  ▏══>         hull ... freighter 96 m│
│ ROLE ▸freighter …      ╲_______╱             mass ... 4.1/9 kt      │
│ SIZE ◂ medium ▸                              drive .. 2 × fusion    │
│ SEED ◂ 5A17C0DE ▸ [⟳]                        accel .. 0.31 g  Δv …  │
│ LIGHT ▸raking rim dark-side planetshine  DRIVE cold ▸cruise burn    │
│ VIEW ▸free side front 3/4 engine detail  ☐silhouette ☐scale         │
│ BACKDROP ▸void anchorage          [+ COMPARE]   [P PHOTO]           │
└ træk=orbit · hjul=zoom · ←/→ seed · ↑/↓ rolle · F=fit ─────────────┘
```

**Photo mode** (bjælken skjules efter 2 s)

```
FOV ━━●━ 38° · EXP ━●━━ +0.3 · GRAIN ● · CA ○ · ROLL ━●━ · [⏎ SAVE]
```

**Dev-overlay**

```
58 fps · 17.2 ms · scale .95 · calls 160 · tris 1.21M
mode FLIGHT · tier [high▾] · shot [none▾][clear] · ticking 9/17
```

## 3. Arkitektur

### Modes (`src/core/Modes.ts`, ren TS)

- **Modes:** `boot | title | flight | map | yard | photo | review`. `photo` er et overlay.
- **API:** `current`, `can`, `go` (kaster ved ulovlig overgang), `push('photo')`, `pop()` og `onChange`.
- **Event:** `mode:changed`, tilføjet til `GameEvents`.

Tilladte overgange:

| Fra | Til |
|---|---|
| boot | title, flight, yard, review |
| title | flight, yard |
| flight | map, yard, title, photo, review |
| map | flight |
| yard | flight, title, photo, review |
| review | flight, yard, title |

### Gating i Engine

`GameModule` får `activeIn?: Mode[]` og `onModeChange?(from, to, ctx)`. Engine-løkken skal ligge i en ren `tickModules(modules, mode, dt, ctx)`.

| Moduler | `activeIn` |
|---|---|
| universe, pilot, traffic, cruise, scanner, warp, hud | `['flight']` |
| map-mode, system-map | `['flight','map']` |
| showroom | `['yard','review']` |
| gallery | `['review']` |
| sky | alle undtagen yard |
| log, codex, audio, shot-driver | altid |

- Photo oven på flight kører flight-moduler med `dt = 0`.
- **Migrering:**
  - `shotOwnsScene()` bliver `mode === 'review' && !shot.live`.
  - `Universe.paused` bliver en getter, der returnerer `mode !== 'flight'`.
  - De syv eksisterende tjek af flaget virker uændret og kan fjernes ét ad gangen.

### Genbrug af Showroom

Showroom.ts deles ved de naturlige grænser **uden logikændringer**:

| Ny fil | Indhold |
|---|---|
| `src/game/showroom/Stage.ts` | klassen, BlockoutVisual og skalareferencen |
| `src/game/showroom/camera.ts` | `placeCamera`, `swingToFace` og `CameraSpec`, nu eksporteret |
| `src/game/showroom/presets.ts` | navngivne lys-, drive- og view-presets |
| `src/game/showroom/shots.ts` | `SHOT_DEFS` og `registerShowroomShots` |
| `src/game/showroom/catalog.ts` | ren: lovlige kombinationer af fraktion, rolle og størrelse, næste og forrige seed |
| `src/game/showroom/specs.ts` | ren: `shipScanLines` plus Δv |

- `src/game/Showroom.ts` bliver en re-eksport.
- De nye `src/game/Yard.ts` og `src/ui/YardPanel.ts` bygges ovenpå.
- Stage får `setLight`, `setDrive` og `prewarm`, og cachen bliver en LRU.
- Opdelingen kontrolleres ved at PNG-diffe de 22 review-frames før og efter.

### FlightSnapshot, Route og Photo

**FlightSnapshot**
- Gemmer kamera (pos, quat, up, fov), rigMode, HUD, exposureBias, pointer lock og fixedDt.
- Ved exit fra review kaldes altid `resumeRealtime()`.

**Route (`src/core/Route.ts`, ren)**
- Valideres efter whitelist: faction skal findes i `FACTIONS`, role og size skal være gyldige værdier, og seed skal matche `^[0-9a-f]{1,8}$`. Ukendte felter ignoreres, og ugyldige værdier falder tilbage til default med en log-linje.
- Hvis `gen` ikke matcher den aktuelle version, står der "registered under an older yard standard".
- Yard opdaterer URL'en med `history.replaceState`.

**Photo**
- Billedet tages med `engine.captureNextFrame()` → `canvas.toBlob` lige efter render.
- `PostFX.setGrade({ exposure, grain, ca, vignette })`.
- Fly-cam'en er uafhængig af `CameraRig`.

### Filer

| Fil | Ændring | Effort |
|---|---|---|
| `src/core/Modes.ts` + test | ny | S |
| `src/core/Route.ts` + test | ny | S |
| `src/core/Engine.ts` | `activeIn`, `onModeChange`, `tickModules`, `captureNextFrame` | S-M |
| `src/core/EventBus.ts` | tilføj events | S |
| `src/core/Input.ts` | pointer lock kun i flight, tasterne Y, P og backtick | S |
| `src/main.ts` | route, startmode, `__osClearShot` | S |
| `src/game/registry.ts` | `activeIn`, seed, nye moduler | S |
| `src/game/Shots.ts` | flag via modes, eksportér `clearShot` | S |
| `src/game/Showroom.ts` → `showroom/*` | opdeling | M |
| `src/game/Yard.ts`, `src/ui/YardPanel.ts` | nye | M-L |
| `src/game/FlightSnapshot.ts` | ny | S |
| `src/ui/Title.ts` | ny | S |
| `src/game/Photo.ts`, `src/ui/PhotoBar.ts` | nye | M |
| `src/render/PostFX.ts` | `setGrade` | S |
| `src/ui/DevOverlay.ts` | ny | S |
| golden-test af skibsgenerering | ny | S |

## 4. Tests først (Vitest, Given-When-Then)

**Modes**
- Given `title`, when `go('flight')`, then er `current` lig `flight`, og `onChange('title','flight')` er kaldt.
- Given `map`, when `go('yard')`, then kastes der, og `current` er stadig `map`.
- Given `yard`, when `push('photo')` og derefter `pop()`, then er `current` lig `yard`, og der er udsendt præcis 2 events.
- Given `photo`, when `push('photo')`, then kastes der.

**tickModules**
- Given et modul med `activeIn: ['flight']` og et modul uden `activeIn`, when der tikkes i `yard`, then kaldes kun modulet uden `activeIn`.
- Given modulerne A og B, when der tikkes, then kaldes alle `update` før nogen `lateUpdate`, i rækkefølge.
- Given photo-overlay, when der tikkes, then får flight-moduler `dt = 0`.

**Route**
- Given den fulde yard-URL, when den parses, then giver den korrekte `ShipParams`.
- Given `faction=<script>` eller `role=dreadnought`, when den parses, then ignoreres værdien, og der logges en advarsel.
- Given `ship=zz` eller `ship=1ffffffff`, when den parses, then bruges default.
- Given en gyldig route, when den serialiseres og parses igen, then er `parse(serialize(r))` lig `r`.
- Given `gen=0`, when den parses, then er `staleGeneration` true.

**catalog**
- Given sillane, when rollerne listes, then er ingen `neverBuilds`-roller med.
- Given tug, when størrelserne listes, then er de lig rollens `sizes`.
- Given seed `0xffffffff`, when `nextSeed` kaldes, then er resultatet 0.

**specs**
- Given HERO_SHIP, when specs genereres, then er rækkefølgen class, hull, mass, drive, accel.
- Given en derelict, when specs genereres, then står der "no active drive signature".

**Golden**
- Given 5 faste parametersæt, when de genereres to gange, then er resultaterne deep equal.
- Given de samme sæt, when hashen beregnes, then matcher den den committede golden for `SHIP_GENERATION_VERSION`. Fejlbeskeden lyder "bump SHIP_GENERATION_VERSION".

**FlightSnapshot**
- Given `fixedDt = 1/60` fra review, when der gendannes til flight, then er `fixedDt` lig null.

## 5. Risici

| Risiko | Afbødning |
|---|---|
| Seed-links går i stykker, hver gang generatoren ændres | Golden-test, `gen=` i URL'en og version-bumps |
| Opdelingen af Showroom ændrer review-frames i det skjulte | Ren flytning efterfulgt af PNG-diff |
| Gating stopper et modul, som noget i det stille afhang af | Default er altid aktiv, og der indføres én test pr. modul. Dev-overlayet viser "ticking" |
| Hak når man bladrer gennem seeds | Fade, prewarm og LRU, senere en worker |
| Pointer lock og taster lækker mellem modes | Input ejes af den aktive mode |
| Spillerne forventer at kunne flyve skibene i Yard | "Registry only" i v2 og en v3-brief |
