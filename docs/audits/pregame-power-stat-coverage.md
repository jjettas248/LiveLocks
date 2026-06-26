# Pre-Game Power Radar — Full Stat Coverage Audit

Classification of every stat family in the task spec (A–R) against what the
codebase actually provides today (`server/mlb/dataSources.ts`,
`dataPullService.ts`, `rosterService.ts`) and which v2 **shadow** math module
consumes (or should consume) it.

**Status legend**
- **PU** present & used (production today) · **PUu** present but unused by production
- **MA** missing from engine but available from an existing source
- **MN** missing, needs a new data source · **SN** should NOT be used pregame (live-only)
- **SS** sample-size risk (needs shrinkage)

**Priority:** P0 (core, do first) · P1 (high) · P2 (medium) · P3 (low/nice-to-have).

v2 modules referenced: `scoreBatterTruePower`, `scoreBatTrackingPower`,
`scorePitcherHrVulnerability`, `scorePitchTypeInteraction`,
`scoreZoneLocationInteraction`, `scoreParkWeatherSprayInteraction`,
`scoreLineupOpportunity`, `scoreStarterBullpenPath`, `scoreMarketConfirmation`,
`scoreAvailabilitySuppressors`.

---

## A. Batter true HR skill
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| HR/PA, HR/AB, HR/game (season) | PU/MA | P0 | scoreBatterTruePower (season anchor, shrunk) |
| barrel rate, barrels/PA, HR/FB, HR/Barrel | PU (barrel%), MA (others) | P0 | scoreBatterTruePower |
| hard-hit %, avg EV, max EV, EV90/EV50 | PU (avg/max/hardhit), MA (EV90/50) | P0/P1 | scoreBatterTruePower |
| xSLG, xwOBAcon, xISO, ISO | PU (xSLG/xISO), MA (xwOBAcon/ISO) | P0 | scoreBatterTruePower |
| fly-ball %, air-ball %, line-drive %, GB% (suppressor) | PU (FB%), MA (others) | P1 | scoreBatterTruePower |
| pull %, pull-air %, pulled-fly %, oppo-fly % | PU (pull%), MA (air variants) | P1 | scoreBatterTruePower / park-spray |
| sweet-spot %, launch-angle avg/SD, ideal-HR-LA rate | PU (sweetspot), MA (LA), MN (LA-SD) | P1/P2 | scoreBatterTruePower |
| HR distance/spray distribution, no-doubter rate, would-be-HR-in-X-parks | MN | P2/P3 | park-spray (future) |
| platoon split vs pitcher hand | PU (OPS vs hand) | P0 | matchup (handled via pitcher split + batterHand) |
| home/away, day/night power splits | MA | P3 (SS) | — (sample-safe only) |
| rolling 7/15/30 xSLG/barrel/hardHit/pull-air/HR-PA | PUu (rolling OPS/SLG/HR-rate exist) | P1 (SS, heavy shrink) | scoreBatterTruePower (future rolling input) |
| starter confirmation, injury/return, rest | MA/MN | P1 | scoreAvailabilitySuppressors |

## B. Bat-tracking / swing quality
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| bat speed, swing length | PUu (in Savant pull, unused by score) | P1 | scoreBatTrackingPower |
| fast-swing rate, squared-up rate, blast rate | MA (Savant bat-tracking) | P2 | scoreBatTrackingPower |
| attack angle/direction, swing plane | MN | P3 | scoreBatTrackingPower (future) |
| whiff / chase / zone-contact / CSW | PUu (whiff by pitch type), MA | P2 (SS) | scorePitchTypeInteraction (whiff as suppressor) |

## C. Batter pitch-type damage (per family: FB/SI/CT/SL/SW/CB/CH/SP)
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| xSLG / xwOBAcon / barrel / hardHit vs pitch type | PU (xSLG vs FB/breaking/offspeed), MA (finer) | P1 (SS) | scorePitchTypeInteraction |
| whiff / chase / zone-contact vs pitch type | PUu (whiff), MA | P2 (SS) | scorePitchTypeInteraction |
| HR/PA, HR/swing, run value vs pitch type | MN | P2/P3 (SS) | scorePitchTypeInteraction (future) |
| sample size per split | — | P0 | enforced via `shrinkRates` (k=40) |

## D. Batter zone / location damage
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| xSLG/barrel/HR by zone, heart / middle-middle / elevated-FB / low-breaking | MN (no zone splits ingested) | P2 | scoreZoneLocationInteraction (no-op until sourced) |
| hot/cold heatmap | MN | P3 | scoreZoneLocationInteraction (future) |

## E. Pitcher HR vulnerability
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| HR/9, HR/PA allowed (vs hand) | PU (HR/9 vs LHB/RHB) | P0 | scorePitcherHrVulnerability |
| barrel/hardHit/FB allowed | MN (schema exists, no producer) | P1 | scorePitcherHrVulnerability (optional inputs ready) |
| EV/EV90/xSLG/xwOBAcon allowed, no-doubter allowed | MN | P2 | scorePitcherHrVulnerability (future) |
| GB% allowed (suppressor), LD% allowed | MN | P2 | scorePitcherHrVulnerability (future) |
| platoon split vs batter hand | PU | P0 | scorePitcherHrVulnerability (hrPer9VsHand) |
| recent 3/5-start / 30-day barrel/hardHit/HR allowed | MA (recent-starts feed exists) | P1 (SS) | scorePitcherHrVulnerability (future rolling) |
| velocity / pitch-shape / command trend | PUu (pitch-mix, velo), MN (trend) | P2/P3 | scorePitchTypeInteraction / future |
| **ERA** | PU but DEMOTED | — | NOT a primary HR input (per task) — excluded from v2 vuln term |

## F. Pitcher pitch-type weakness
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| pitch usage (overall, by hand) | PU (pitch-mix %), MA (by hand) | P1 | scorePitchTypeInteraction (usage weighting) |
| usage by count / times-through-order | MN | P2/P3 | scoreStarterBullpenPath (TTO, future) |
| HR / barrel / xSLG allowed by pitch type | MN | P1 | scorePitchTypeInteraction (future, currently batter-side weighted by usage) |
| hanger rate, mistake rate, middle-middle by pitch | MN | P2 | scoreZoneLocationInteraction (future) |
| velocity / spin / movement / extension / release by pitch | PUu (FB velo/spin), MN (rest) | P3 | similarity (future) |

## G. Pitcher location / command
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| zone / heart / chase / edge / first-pitch-strike rate | MN | P2 | scoreZoneLocationInteraction |
| walk / ball / meatball / noncompetitive rate | MA (BB/9 exists) | P2 | scoreZoneLocationInteraction (future) |
| release/extension/movement/velo/spin variance (historical) | MN | P3 | similarity (future) |
| command / location trend by recent starts | MN | P2 | future |

## H. Batter × pitcher interaction
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| batter power × pitcher HR vulnerability | PU (additive in v2 logit) | P0 | build pipeline (additive terms) |
| batter pitch-type damage × pitcher usage | PU (v2) | P1 | scorePitchTypeInteraction |
| batter zone damage × pitcher mistake zone | MN inputs | P2 | scoreZoneLocationInteraction |
| batter pull-air × pitcher pulled-air allowed | MA/MN | P2 | scoreParkWeatherSprayInteraction (pull gate) |
| batter platoon × pitcher hand split | PU | P0 | scorePitcherHrVulnerability |
| archetype / similarity (velocity band, mix, release, movement) | MN | P3 | future (replaces tiny BvP) |
| raw BvP | PU (capped modifier, prod) | P3 (SS) | v2: tiny/shrunk diagnostic only, never primary |

## I. Park / stadium geometry
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| generic park HR factor | PU | P0 | scoreParkWeatherSprayInteraction |
| park HR factor **by handedness** | PUu (exists, unused) | P0 | scoreParkWeatherSprayInteraction (uses `parkHrFactorHand`) |
| park factor by batted-ball type / spray sector, wall height, foul territory | MN | P2/P3 | future |
| altitude, roof type/status, surface, run environment | PU (indoor flag), MN (rest) | P2 | scoreParkWeatherSprayInteraction |
| would-be-HR-in-X-parks, batter pull-side fit to park | MN | P3 | future |

## J. Weather / air density / carry
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| temperature, wind speed, wind direction | PU (forecast) | P0 | scoreParkWeatherSprayInteraction |
| wind vector by field sector, pull-side wind boost by hand | MA (windDegrees + coords exist) | P1 | scoreParkWeatherSprayInteraction (pull gate; sector future) |
| humidity, pressure, air density, density altitude, heat index | PUu (humidity/pressure), MN (derived) | P2 | future |
| roof state/certainty, precip / postpone risk | PU (indoor), MN (precip) | P2 | scoreAvailabilitySuppressors (postpone, future) |
| weather forecast timestamp / available before first pitch | PU | P0 | leakage contract (must be pregame) |

## K. Lineup / opportunity / volume
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| confirmed lineup, batting-order slot | PU | P0 | estimatePregamePaDistribution + scoreLineupOpportunity |
| projected PA, P(PA=n) distribution | MA (derived in v2) | P0 | estimatePregamePaDistribution |
| team implied run total, game total | PU (implied runs) | P1 | estimate PA + scoreLineupOpportunity |
| OBP ahead, SLG behind, protection, pitch-around / IBB risk | PUu (obpAhead), MN | P2 | scoreLineupOpportunity / future |
| rest / doubleheader / day-after-night / travel fatigue | MA/MN | P2 | scoreAvailabilitySuppressors |

## L. Opposing starter opportunity
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| starter confirmed, opener/bulk risk | PU (starter), MN (opener) | P1 | scoreStarterBullpenPath |
| expected innings / batters faced / pitch count / leash | MA (recent-starts), MN (projection) | P2 | scoreStarterBullpenPath |
| times-through-order HR/barrel profile, 1st/2nd/3rd-through HR allowed | MN | P2 | scoreStarterBullpenPath (future) |
| projected PA vs starter vs bullpen | MA (derived) | P1 | scoreStarterBullpenPath (exposure weight) |

## M. Bullpen path
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| bullpen HR/9, HR/PA, barrel/hardHit/FB allowed, xSLG allowed | MN | P2 | scoreStarterBullpenPath (optional inputs ready, secondary cap) |
| bullpen handedness mix, fatigued/unavailable arms, recent workload | MN | P3 | future |
| **Bullpen must not dominate candidate creation** | — | — | enforced via small cap (0.20) × exposure |

## N. Catcher / umpire / battery
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| umpire zone size / high-low / walk-K tendency | MN | P3 | future (secondary context) |
| catcher framing / game-calling HR allowed | MN | P3 | future |

## O. Market / sportsbook
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| HR odds (open/current), implied & no-vig prob | MN (**no odds source wired**) | P1 | scoreMarketConfirmation (no-op until sourced; confirm/rank only) |
| odds movement, book dispersion, sharp-vs-soft | MN | P2 | future |
| team total / game total / ML movement | MN | P3 | future |
| **Market cannot create a candidate alone** | — | — | enforced: small cap, never sole driver |

## P. Injury / news / availability
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| confirmed active, late-scratch risk, return-from-IL, rest-day risk, platoon-sub risk | MN (news source) | P1 | scoreAvailabilitySuppressors (suppressor/confidence only) |

## Q. Similarity / archetype
| Stat | Status | Pri | v2 module |
| --- | --- | --- | --- |
| batter/pitcher archetypes, velocity-band / pitch-mix / release / movement similarity | MN | P3 | future (replaces tiny BvP when sample small) |

## R. Data quality / sample size / shrinkage
| Concern | Status | Pri | v2 module |
| --- | --- | --- | --- |
| sample size, stabilization thresholds, shrinkage, league fallback, confidence penalty, stale-data/timestamp, pregame availability | **PU (v2)** | P0 | `shrinkRates` (documented k by family), `confidenceScore`, `statCoverage`, leakage contract |

---

## Headline gaps (most impactful, ordered)
1. **P0 — park HR factor by handedness** is present but unused; v2 already consumes it.
2. **P1 — pitcher barrel/hardHit/FB allowed** (schema exists, no producer): wire a producer.
3. **P1 — rolling 7/15/30 power trends** (data exists) with heavy shrinkage.
4. **P1 — HR odds source** (none today) to enable market confirmation.
5. **P2 — zone/location splits** (batter hot zones × pitcher mistake zones): new source needed.
6. **P0 — calibration of HR probability** against outcomes — DEFERRED (needs historical backtest; see future-phases doc).
