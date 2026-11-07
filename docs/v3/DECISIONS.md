# v3: beslutningslog

Autonom kørsel med ejerens mandat fra v2 (Claude godkender tests på ejerens vegne og kører adversarial review og mutation testing). ⚠ markerer store beslutninger.

| # | Beslutning | Begrundelse | Konsekvens |
|---|---|---|---|
| D0 | **Ejerens valg 2026-11-07:** (1) rate-command med skarpt stop: τ_up 0,22, τ_down 0,10, maks 35/28/75°/s; (2) FOV 88° vandret ved 16:9, Hor+ op til 100°, ånding fra thrust og cruise, aldrig fra banefart, og åbningsbilledet reframes; (3) auto-land med ærlig fysik plus auto-10× over 20 km og glattere faseskift; (4) "flyv dette skib" som SEE IN FLIGHT (S), mens board venter til V4 | Svar på PLAN §4 | Styrer fase B, C, D og G |
| D1 | Arbejdet ligger på branch `v3` fra `v3-plan` og deles i 5 spor i hver sin worktree: T1 tid og kamera (A+C), T2 styring (B), T3 cruise og autopilot (A5-6 + D), T4 fart, skala, lyd og SEE IN FLIGHT (E+G), T5 HUD (F). Hvert spor afleverer tests til godkendelse før implementering | Samme form som v2, med filejerskab pr. spor | Claude løser merge-konflikter i FlightModel, Universe og registry |
