# oneSpace v4: implementeringsplan (overblik)

> **For agentic workers:** Hver delplan udføres task for task med superpowers:subagent-driven-development
> eller superpowers:executing-plans. Trin bruger checkbox-syntaks (`- [ ]`).

**Mål:** Opfylde [`docs/v4/DESIGN.md`](DESIGN.md), så succeskriteriet holder: *log ind, min en asteroide,
tank op, og det huskes efter genindlæsning.*

**Arkitektur:**
- Fire delsystemer, der bygges i rækkefølge. Hver delplan efterlader et spil, der kan spilles og
  testes for sig.
- Ren spillogik ligger i små, rene TypeScript-moduler med Vitest-tests. Integration sker i de
  eksisterende `GameModule`s.
- Backend'en kommer sidst og overtager det lokale save-format uændret.

**Tech stack:**
- **Klient:** Three.js r180, TypeScript strict, Vite 6, Vitest og Playwright (GPU-flag, som v3).
- **Server (delplan 4):** Node/TypeScript, Postgres og Zod.

**Spec:** `docs/v4/DESIGN.md`

## Delplaner

| # | Delplan | Leverer | Afhænger af |
|---|---|---|---|
| 1 | [Brændstof](plan-1-fuel.md) ✅ | tank, forbrug, masse, cruise/hop-pris, HUD, nødudgang (dele + nødsignal) | v3 |
| 2 | [Asteroider og mining](plan-2-mining.md) | bælter, asteroider, scanning, udvinding, last, raffinering, reparation, start-system med bælte og 60 % tank | 1 |
| 3 | Gemt spil (lokalt) | versioneret format v1, snapshot plus handlingslog, IndexedDB, autosave, Continue, migrering af logbog | 1, 2 |
| 4 | Backend og sky | API, Postgres, OAuth (GitHub/Google), gæst → konto, sync med revisioner, én origin, Railway-klar | 3 |

**Rækkefølge:** delplan 2-4 skrives først, når den forrige er landet. De skal bygge på den faktiske
kode og ikke på gæt.

**Fælles grænseflader:** delplan 1 fastlægger `Propellant` (§ Interfaces i plan-1). Delplan 2
tilføjer `Cargo` med samme mønster. Delplan 3 gemmer begge, og alle ressource-ændringer går gennem
navngivne handlinger (P3).

## Global constraints (gælder alle delplaner)

- **TypeScript strict.** Zod til alt, der krydser en grænse: save, netværk og URL.
- **GS-TDD:** BDD Given-When-Then-tests skrives først, ejeren godkender, og derefter implementeres.
  Hver task har et ⏸-trin.
- **v3's flyveoplevelse må ikke gå tilbage.**
  - Eksisterende tests forbliver grønne uden ændrede forventninger, medmindre en task eksplicit
    siger andet.
  - `FlightModel` uden tank opfører sig præcis som v3.
- **v2's performance-budget holder.** Målt på GPU før og efter for hver delplan.
- **Multiplayer-principperne P1-P5** i DESIGN §4 er bindende.
- **Beslutningslog:** `docs/v4/DECISIONS.md` (D-numre fra D0).
- **Udlicitering:** Railway-udrulning, handel, faktioner, replikation og biosfærer er udenfor.

## Review focus (tværgående)

1. **Tab af fremdrift ved lukning midt i en handling:** fanen lukkes under raffinering eller
   nødudgang. Forventet: handlingen er enten sket helt eller slet ikke (delplan 3).
2. **Tom tank i det øjeblik autopiloten eller cruise kører:** forventet er et kontrolleret stop med
   besked, ikke en låst tilstand (delplan 1).
3. **Time compression 10×/100× under forbrug:** forbruget skal følge sim-tid, så det samme sker ved
   1× og 100× (delplan 1).
4. **To faner med samme konto:** handlingsloggen må aldrig dobbelt-tælle eller tabe (delplan 3/4).
5. **Gammelt save efter en formatændring:** det indlæses via migrering og må aldrig kasseres stille
   (delplan 3).
