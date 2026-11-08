# v4 beslutningslog

| D | Beslutning | Begrundelse | Pris hvis forkert |
|---|---|---|---|
| D1 | Udstødningshastighed `EXHAUST_VELOCITY_KMS` = 11 500 km/s. Målt (Task 3, node-sim, fuld tank): auto-land Remit 6,97 % af tanken, touchdown 0,83 m/s CLEAN, 67,2 s væg-tid (65,9 s uden tank); 10 s fuldt main-burn 0,162 % | v3's auto-land bruger ~75 km/s motorkraft (dyk til 39 km/s og opbremsning) mod en bane på 6,7 km/s. Ved ve 1000 kostede en landing 80 %; L·ve ≈ 828 km/s, så 11 500 giver ~7 % pr. auto-land og ~0,16 % for et 10 s brag | Manuel flyvning bliver næsten gratis; presset kommer fra autopilot og hop |
| D2 ⚑ ejer | Autopiloten forbliver hurtig (v3's landing) men er en dyr bekvemmelighed; det belønnes at flyve selv. Jump-pris 0,04 + 0,004·ly (maks 0,3), så 3 × (landing + opstigning) + 2 hop ≤ en fuld tank. Landingsstyringen læser massScale, så fuld tank lander CLEAN | Ejerens valg ("din anbefaling") mellem hurtig/dyr og langsom/sparsommelig autopilot | Bruger spillerne altid autopilot, føles brændstof som en autopilot-afgift |
