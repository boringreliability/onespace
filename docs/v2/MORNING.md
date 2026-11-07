# God morgen: status på oneSpace v2

*Autonom kørsel 2026-11-06 23:45 til 2026-11-07 ~07:45. Branch `v2` og draft-PR #1.*

## TL;DR

Hele planen (fase 0-4) er implementeret, reviewet adversarielt med mutation
testing og verificeret i en rigtig browser på GPU. Derudover er der lavet to
ekstra spor: skibsgenerering i en worker og billedet fra overfladen.

**Spillet kan spilles fra titelskærm til hop mellem systemer:** UNDOCK → scan → Tab/kort →
G cruise → automatisk bane om målet → L land → `.` time compression → L op igen → J hop.

**Performance** (prod, M4 Pro, samme probe som auditten):

| Scene | v1 | v2 |
|---|---|---|
| Opening | 112 ms | 8,3 ms |
| Planet-approach | 211-264 ms | 11,4 ms |
| Atmosphere-sunset | 165 ms | 15-18 ms |
| Planet-orbit | 64-74 ms | 8,3 ms |
| Clouds-orbit | 109 ms | 16 ms |

**Kvalitet:** 1090 tests (fra 139). `npm run verify` er grønt. 8 adversarial reviews
har tilsammen fundet og rettet ~35 reelle fejl, bl.a. cruise ved throttle 0 = 0 m/s
og et skib der landede 14 km under havet. Mutation-score efter review: 94-100 % pr. modul.

## Prøv det

```bash
cd /Users/Z6DEC/kmddev/oneSpace
git fetch && git checkout v2      # din checkout har ucommittet MAP-Elites-arbejde: stash/commit det først
npm install && npm run dev
```

| URL | Hvad |
|---|---|
| `/` | Titelskærm (UNDOCK / THE YARD / SETTINGS / seed) |
| `/?mode=flight` | Direkte i flyvning |
| `/?mode=yard&ship=5a17c0de&faction=kessler&role=freighter&size=medium` | The Yard med et bestemt skib |
| `/?dev` | Dev-overlay (fps, ms, scale, calls, tris, mode, tier, tikkende moduler). Backtick toggler |
| `/?tier=low` / `?dpr=1` | Tving kvalitet eller pixel ratio |
| `/?seed=1a2b3c4d` | Andet univers |

**Taster i flyvning:**

| Tast | Handling |
|---|---|
| Mus | Styring (virtuel stick, amber prik) |
| W/S | Throttle. Under FA-ON er det farthold, og 0 betyder coast |
| X | Throttle 0 |
| Space | Stop |
| Z | Flight assist til/fra |
| Tab | Mål |
| G | Cruise |
| L | Auto-land eller auto-orbit |
| `,` `.` | Time compression |
| T | Scan |
| M | Kort |
| J | Hop |
| Y | The Yard |
| P | Fotomodus |
| V | Kamera |
| Esc | Pause |

## Læs først: de store beslutninger (⚠ i DECISIONS.md)

1. **D23 FA-ON, variant B.** Throttle 0 betyder coast, så baner overlever, når man ikke rører noget. Under cruise betyder throttle 0 "rid loftet" (D52).
2. **D6 DPR-loft.** High er 1,25 og medium 1,0, så billedet er blødere på retina. Fase 3 har frigjort plads, så high kan måske hæves igen.
3. **D31 Titelskærm som boot.** Scripts og playtests skal bruge `?mode=flight`.
4. **D37 Åbningsbilledet** er tippet 30° ned mod kanten.
5. **D43 Gating.** Flight-moduler er aktive i boot, title, flight, map og review. Kun Yard fryser flight.
6. **D2/D15/D57 Golden-testen** fanger dit MAP-Elites-arbejde. Før merge: bump `SHIP_GENERATION_VERSION` til 2 og kør `UPDATE_GOLDEN=1 npx vitest run src/gen/ships/golden.test.ts`. Re-record under samme version afvises.
7. **D54 Fase 3:** bagt terrain-atlas, clipmap-skygger, hav i surface-passet og sky-cubemap. Det koster hukommelse (~50 MB på high).
8. **D50/D59:** to rigtige fejl i fysik og grafik, som kun viste sig ved landing.

## Hvad der er åbent

- ~~GL "feedback loop" i fotomodus~~ blev fundet i slutverifikationen og er rettet (D64). Det endelige browser-flow har 0 konsolfejl.
- **Generator:** derelicts har aktive motorer, og nogle skrog falder uden for deres size-bånd. Kræver version-bump, og det er din beslutning (D46).
- **Auto-land** dykker ærligt med ~39 km/s, før den bremser. Det er fysisk korrekt, men kan virke hensynsløst. En tyk atmosfære giver ~8 min pr. leg, og 10× under autopilot er foreslået.
- **`createShipVisual`** (mesh, 20-70 ms) kører stadig på main thread (D62).
- **HalfFloat-fallback** virker ikke uden `EXT_color_buffer_float`, og Clouds/Atmosphere genbager ikke efter tabt kontekst.
- **"Flyv dette skib"** er sat til v3 (D0).
- **Billedet fra overfladen:** månen er stadig lidt flad, og Vassa er mørk under en lys himmel.

## Hvor tingene ligger

| Hvad | Hvor |
|---|---|
| Plan og auditterne | `docs/v2/PLAN.md`, `GAMEPLAY.md`, `PERFORMANCE.md`, `SHOWROOM.md` |
| Alle beslutninger | `docs/v2/DECISIONS.md` (D0-D62+) |
| PR | https://github.com/boringreliability/onespace/pull/1 (draft) |
| Screenshots og målescripts | `~/.claude/jobs/9463fd62/tmp/` (forsvinder med jobbet; vigtige tal står i DECISIONS) |
| Review-grene | `review-p0/p1/p1a/p2/p3/p4/worker`, alle merget ind i `v2` |
