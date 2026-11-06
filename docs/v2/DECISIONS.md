# v2 — beslutningslog

Autonom kørsel fra 2026-11-06 ~23:45, med ejerens mandat: *"Claude tager alle
beslutningerne, godkender tests på mine vegne, laver adversarial reviews og
mutation testing."* Hver beslutning har en kort begrundelse og en konsekvens.
**Store** beslutninger er markeret ⚠ og er dem, der bør gennemgås først.

| # | Tid | Beslutning | Begrundelse | Konsekvens |
|---|---|---|---|---|
| D0 | 23:45 | Ejerens svar: FA-ON er default, `SHIP_GENERATION_VERSION` bumpes med golden-test, "flyv dette skib" er sat til v3 | Svar på PLAN §4 | Styrer fase 1-2 |
| D1 | 23:45 | Alt arbejde ligger på branch `v2` (fra `docs/v2-plan`), med commit og push pr. delopgave og draft-PR til sidst. Intet går til `main` | Sikker standard. Ejeren kan merge selv | — |
| D2 | 23:45 | Ejerens ucommittede MAP-Elites-arbejde i hans checkout er ikke rørt. Golden-testen bygges, så den fejler, når det merges, indtil versionen bumpes | Det er hans arbejde, og testen håndhæver hans beslutning | Merge af hans arbejde kræver at `SHIP_GENERATION_VERSION` bumpes til 2 og at golden opdateres |
| D3 | 23:50 | Der findes ingen `.cursor/rules`, så GS-TDD følger den globale CLAUDE.md: BDD-tests først, godkendelse (af Claude), implementering, verifikation | Fallback er beskrevet i CLAUDE.md | — |
| D4 | 23:55 | Fase 0-testene er godkendt af Claude: cruise-tærskel, `ResolutionGovernor`, `planStreaming`, `parseDevParams` og tier-guards | Testene dækker de målte fejl, og grænsetilfældene er med (spike, flapping, cooldown, churn, whitelist) | — |
| D5 | 00:05 | Tre governor-tests er justeret efter Red. Det delvise vindue tømmes før assert, og en "lettere last" på 21 ms erstatter 25 ms, som ramte loftet for, hvor meget skalaen må falde pr. skridt | Det var fejl i testdesignet, ikke i logikken. Hensigten er uændret: ingen flapping, ingen stigning i cooldown, proportionalt fald | — |
| D6 ⚠ | 00:05 | DPR-loft: low 1, **medium 1 (før 1,5)**, high 1,25 (før 2), ultra 1,5 (før 2). `patchResolution` på high er 33 (før 65) | Audit: DPR 2→1 sparer 40 %. Medium blev sænket for at holde tiers monotone | Billedet er blødere på retina. Fase 3 (bagt terrain) kan give plads til at hæve igen |
| D7 | 00:05 | Atmosfære-cutoff 1e-6 relativ densitet (~14 skalahøjder) | Toppen af enhver reel atmosfære. Remit 31: cruise er tilladt over ~200 km mod tidligere ~10.900 km | — |
| D8 | 00:10 | Governoren har bund 0,5, vindue 500 ms, op-cooldown 3 s og ignorerer spikes > 250 ms. Fixed-step (review-harness) fodrer den ikke | Hver ændring reallokerer render targets, og fixed-step er ikke realtid | `stats().fps` er nu wall-clock. `cpuMs` er tilføjet |
| D9 | 00:10 | Streaming: acquire ved 60 R og release ved 75 R. Ny renderer skjules, indtil `compileAsync` er færdig | Fjerner churn og synkron link ved approach. three kompilerer også skjulte meshes (`scene.traverse`) | En planet kan være usynlig i 1-2 frames ved 60 R, hvor den er et par pixels stor |
| D10 | 00:10 | Trafik: højst én tung build (blueprint eller mesh) pr. frame. Blueprint genereres lazy | ~600 ms hitch efter boot | Skibe dukker op over ~4-8 frames i stedet for i én |
| D11 | 00:10 | `shoot.mjs` beholder SwiftShader som default. `OS_GPU=1` giver Metal | Review-frames skal være bit-identiske på tværs af maskiner, mens målinger skal bruge den rigtige GPU | — |

**Fase 0-måling** (prod, M4 Pro, DPR 2-viewport, samme probe som i auditten): opening 112 → **28 ms**, planet-approach 211-264 → **67 ms**, sunset 165 → **43 ms**. Ingen nye shader-links ved approach. Governoren lander på sin bund (0,5), så terrain er stadig flaskehalsen, og det tages i fase 3.
**Fundet under verifikation:** cruise afvises nu med "MASS TOO CLOSE" ved spawn (4.474 km < 5.000 km engage). Det løses i fase 1 med radius-relative tærskler.
