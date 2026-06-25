# MLB Pre-Game Power Engine — Current-State Architectural Audit

> **Status:** READ-ONLY inspection. No production code was modified, committed, or refactored. No scoring changed. No Monte Carlo added.
> **Date:** 2026-06-25
> **Scope:** Map the *actual* (not intended) pregame MLB HR/power candidate logic and its relationship to HR Radar Live, for handoff to architectural improvement.
> **Method:** Full reads of `server/mlb/pregamePowerRadar/`, the HR Radar live engine, the core probability/scoring/feature layer, routes/storage/shared/persistence/analytics, and the UI/docs. All claims are pinned to `file:line`.

---

## 1. Executive Summary

**Does a true Pre-Game Power engine exist today?**
**Yes — partially.** A dedicated, isolated module exists at `server/mlb/pregamePowerRadar/` (29 files). It builds daily from confirmed lineups, scores batters 0–10 across five weighted components (batter power, pitcher vulnerability, matchup fit, park/weather, lineup opportunity), classifies tiers (`track → watch → power_watch → strong → elite → nuclear`), persists signals + build manifests to dedicated DB tables, exposes public + admin APIs, has a UI surface (`PregamePowerRadar.tsx`), and grades its own shadow outcomes. It is wired into boot/cron. **It is a real engine, not a stub.**

**But pregame logic is ALSO embedded inside the live engine — and the two are not the same code.**
The live HR conversion model carries its **own** inline "pregame HR-form prior" (`computePregameHrFormScore` + `pregamePriorMultiplier` in `hrConversionModel.ts:878–991`), gated by env flag `HR_PREGAME_PRIOR`, multiplied into the live per-PA base rate and decayed toward 1.0 as in-game contact accumulates. **This inline prior is computed independently from season stats and does NOT read the standalone `pregamePowerRadar/` module.** So "pregame power" lives in two unrelated places.

**Is the current logic cleanly separated from HR Radar Live?**
**Mostly yes, structurally — with two seams.**
- The standalone `pregamePowerRadar/` module never mutates the bus, lifecycle, ROI, or live probability. Its only live touch is a **read-only** `getPregameSignalFor(...)` lookup at `liveGameOrchestrator.ts:730`, used **inside the post-HR review/grading classifier** (attribution of why a HR was/wasn't called), plus read-only "did this pregame target become live ready/fire" bridge flags. **Neither path feeds live Ready/Fire scoring.** This is clean.
- **Seam 1 (duplication):** The live engine's *own* inline pregame prior (`hrConversionModel.ts`) duplicates the concept the standalone module is supposed to own. They are not reconciled.
- **Seam 2 (UI contamination):** The client re-buckets and re-derives some HR Radar staging/scoring values (see §8), which is a display-truth issue, not a pregame/live scoring bleed.

**Is there any Monte Carlo layer today?**
**No.** There is zero simulation, seeded randomness, PA sampling, pitcher-exposure sampling, or Bernoulli-per-PA event simulation anywhere in `server/mlb/` or `shared/`. The only grep hits for "simulate" are an English comment and a test label. Both the live HR probability and the pregame power score are **deterministic, closed-form** computations (cumulative-binomial over a Poisson PA distribution on the live side; weighted linear component averages on the pregame side).

**Biggest architectural issue.**
**There are two parallel, unreconciled pregame-power computations** (the standalone `pregamePowerRadar/` engine vs. the inline `computePregameHrFormScore` prior inside `hrConversionModel.ts`), and **the live HR Radar does not consume the standalone engine as its Power Prior**. The "Power Prior into HR Radar" contract the project wants does not exist — the live engine reinvents a thinner version inline. Any future Monte Carlo work must decide which one is canonical *before* building, or it will deepen the fork.

---

## 2. File Map

Legend for "Layer": **PG** = pregame, **LIVE** = in-game, **SH** = shared, **UI**, **API**, **PERSIST**, **ANALYTICS**, **MATH**.
"Affects" = scoring (S) / probability (P) / staging (St) / display (D) / grading (G).

### 2.1 Standalone Pre-Game Power engine — `server/mlb/pregamePowerRadar/`

| Path | Purpose | Layer | Affects | Key symbols |
|---|---|---|---|---|
| `types.ts` | Canonical pregame types + display contracts | PG/SH | D | `PregamePowerTier`, `PregamePowerMarket`, `PregamePowerSignal`, `PregameParkContext`, `PregamePlayerParkWindFit`, `PregamePowerDiagnostics`; `signalId = mlb-pregame:${date}:${gameId}:${batterId}` |
| `buildPregamePowerRadar.ts` | Daily build orchestrator (slate scan → per-batter hydrate → compose → store) | PG | S,St | `buildPregamePowerRadar()`, `setPregameBuildSink()` |
| `scoring.ts` | Composite 0–10 score, coverage caps, matchup penalty, tier classify | PG | S,St | `composePregameScore()`, `classifyTier()`, `computeDataCoverage()` |
| `scoreUtils.ts` | Pure math helpers | PG/MATH | — | `lin`, `clamp10`, `weightedAvg`, `round1` |
| `batterPowerProfile.ts` | Component 1 (w=0.30) season Statcast power | PG | S | xISO/barrel/xSLG/EV/maxEV/HRFB/pull/sweetspot weights |
| `pitcherVulnerability.ts` | Component 2 (w=0.25) pitcher HR/ERA vs batter hand | PG | S | switch-hitter handedness resolve; hr9/era/barrel-allowed weights |
| `matchupFit.ts` | Component 3 (w=0.20) platoon + OPS-vs-hand + pull-park + BvP modifier | PG | S | BvP shrinkage caps, zero-production gate |
| `parkWeatherScore.ts` | Component 4 (w=0.15) park HR factor + wind + temp + carry display | PG | S,D | `carryType/carryLabel` display contract |
| `playerParkWindFit.ts` | **Display-only** park/wind projection (never feeds score) | PG/D | D | `hydratePregamePlayerParkWindFit()` |
| `lineupOpportunity.ts` | Component 5 (w=0.10) slot volume + team runs + OBP-ahead | PG | S | slot volume `lin(10-slot,1,9)` |
| `batterOrderSplit.ts` | Optional: batter production from *today's* slot (penalty only) | PG | S(penalty) | shrinkage by PA; direction strong/weak/neutral |
| `pitcherOrderSplit.ts` | Optional: pitcher production allowed to opposing slot (vuln blend) | PG | S | hrRate/xbhRate/trafficRate; blends into pitcherVuln |
| `marketTagger.ts` | Classify best market (HR vs TB) — informational | PG | D | `hrScore`/`tbScore`, market setups |
| `liveBridge.ts` | Singleton non-blocking accessor for live ladder annotation | PG↔LIVE (read-only) | D | `getPregamePowerTargetMap()` |
| `liveBridgeCore.ts` | Pure map builder for bridge | PG/MATH | D | `bridgeKey()`, `buildPregamePowerTargetMap()` |
| `pregamePersistence.ts` | Build sink + DB fallback adapter | PERSIST | — | `installPregamePersistence()` |
| `pregamePowerRadarService.ts` | TTL cache + lazy rebuild + DB fallback | PG | — | `getRadarSnapshot()`, `peekRadarSnapshot()` (TTL 10min / 2min near first pitch) |
| `pregamePowerRadarStore.ts` | In-memory canonical snapshot | PG | — | `getPregameSignalFor()` (identity lookup) |
| `shadowOutcomes.ts` | Phase 4/5 shadow grading + read-only live-conversion flags | PG/G | G(shadow) | `gradePregameOutcomes()`, sets `becameLiveReady/becameLiveFire` |
| `diagnostics.ts` | Public-visibility predicate + response builder | API | D | `isPublicPregameSignal()`, `buildResponse()` |
| `*.test.ts` (8 files) | scoring, liveBridge, marketTagger, batter/pitcher order split, parkWeatherCarry, directionalityRegression, pregameParkWindDisplay | TEST | — | — |

### 2.2 HR Radar Live engine — `server/mlb/`

| Path | Purpose | Layer | Affects | Key symbols |
|---|---|---|---|---|
| `hrConversionModel.ts` | **Single source of truth for live HR per-PA + calibrated probability**; ALSO holds inline pregame prior | LIVE (+inline PG) | P,S | `computeHRConversionProbability()`, `computeLiveContactMultiplier()`, `computeHardHitInteractionMultiplier()`, **`computePregameHrFormScore()`/`pregamePriorMultiplier()`**, calibration table |
| `hrAlertEngine.ts` | Live dynamic state machine + readiness scoring + pitcher vuln | LIVE | St,S | `recomputeHrAlertState()`, `deriveState()`, thresholds BET_NOW 0.14 / PREPARE 0.07 / WATCH 0.05 |
| `evaluateHRAlert.ts` | Alert tier/decision (PATH_A–E, FAST_PROMOTE) | LIVE | St | `HR_CONVERSION_OFFICIAL_MIN=0.15`, `ALERT_MIN=0.08`, `WATCH_MIN=0.03` |
| `hrRadarStateMachine.ts` | Pure lifecycle FSM (inactive→watch→build→ready→fire→cashed/missed/model_review/expired) | SH | St | transition graph; terminal-sticky; display score floors |
| `hrRadarUserStage.ts` | Engine signals → user ladder (track/build/ready/fire/resolved) | LIVE | St,D | `READY_TO_FIRE_SUSTAIN_TICKS=3`, peak-currency gate 0.85, CONTACT-driver requirement |
| `hrRadarSection.ts` | Section + outcome mapping; FIRE-only official grading predicates | SH | St,G | `reachedFireCommitment()` (peak conv ≥0.14 OR FAST_PROMOTE_ELITE), near-HR credit |
| `hrRadarCanonicalStore.ts` | In-memory lifecycle persistence | SH | — | `getCanonicalHrRadarState()` |
| `hrRadarState.ts`, `hrRadarFreshnessOverlay.ts`, `hrRadarOutcomeStamp.ts` | State helpers, freshness overlay, outcome stamping | SH/LIVE | St,G | — |
| `nearHrContact.ts` | Phase 2.5 near-HR detector (pure; live EV/LA/dist only) | LIVE | St | LEAN EV≥102, WATCH EV≥98, hitter-park LA extension |
| `liveEventInterpretation.ts` | Live event scores (contact, near-HR, momentum, pitcher fatigue) | LIVE | S | EV_HARD 95, EV_POWER 98, NEAR_HR_DIST 300 |
| `hrThresholds.ts`, `hrMaxWindow.ts` | Shared constants + window expiry policy | SH | St,G | `DEEP_FLY_DISTANCE=330`, PA budget 2 |
| `hr/hrOverlay.ts` + `hr/subEngines.ts` + `hr/hrOverlayConstants.ts` + `hr/temporalFilter.ts` | Consolidated power/arsenal/launch/lineup/recency multiplier overlay (runs live; can run pregame) | LIVE (+PG-capable) | P | Ψ/Γ/Λ/Θ/Δ sub-engines, clamp [0.60,1.60], seasons 2024–26 |
| `HRSignalBuilder.ts`, `hrAlertEngine.ts`, `hrReviewClassifier.ts` | Signal build, alerting, post-HR review taxonomy | LIVE/G | St,G | `classifyHrReview()` (consumes pregame read-only) |

### 2.3 Core probability / scoring / features — `server/mlb/`

| Path | Purpose | Layer | Affects | Key symbols |
|---|---|---|---|---|
| `probabilityEngine.ts` | Normal CDF, neg-binomial, binomial dispatch; HRR/hits-allowed wrappers; safety ceilings | SH | P | `normalCDF()`, `negativeBinomialOverProbability()`, `applyModelSafetyCeiling()` |
| `signalScore.ts` | Signal score composition + confidence tiers; HR-market gap components | LIVE | S | `computeSignalScore()`, `scoreBatterOverSignal()`, `scoreHRRadar()`, `computePowerProfileScore()` |
| `featureEngineering.ts` | Feature normalization, contact-quality tiers | SH | S | contact-quality scoring |
| `archetypes.ts` | Batter/pitcher archetype + calibration shrinkage + safety ceilings | PG-ish | P | `classifyBatterArchetype()`, `CALIBRATION_SHRINKAGE`, ceilings |
| `paEstimator.ts` | Remaining-PA point estimate by inning/slot | PG/LIVE | P,St | `estimateRemainingPA()` `(9-inning)*0.44 + slotAdj`, clamp [1.0,3.5] |
| `paDistribution.ts` | Poisson PA distribution | PG/LIVE | P | `estimateRichPADistribution()`, `poissonPMF()` |
| `statcastXBA.ts` | xBA/xSLG grid, barrel def, HR-prob-from-geometry | PG | P | `computeXBA()`, `computeXSLG()`, `isBarrel()`, `estimateHRProbability()` |
| `hitProbabilityModel.ts` | xBA/xSLG/pitcher/park/bullpen/weather modifiers | PG | P | modifier functions |
| `math/distributions.ts` | Binomial/neg-binom/Poisson PMF, log-gamma | MATH | P | deterministic only |
| `normalizeSignal.ts` | Display contract (`applyDisplayContract`), smart tags | LIVE | D | `displaySide`, `displayProbability`, `isBettable` |
| `calibration.ts`, `directionalBias.ts`, `outcomeDistribution.ts`, `projections.ts` | Calibration helpers, directionality, distributions, projections | SH | P | — |

### 2.4 API / persistence / shared / analytics

| Path | Purpose | Layer | Affects |
|---|---|---|---|
| `server/routes.ts` | Pregame + HR Radar + signal-lifecycle routes (see §9) | API | D,G |
| `server/index.ts` | Boot/cron: pregame build + grading scheduling; live orchestrator start | API | — |
| `server/storage.ts` | `upsert/getPregamePowerRadarSignal*`, `record/getLatestPregamePowerBuild`, HR radar alert/stamp methods | PERSIST | G |
| `shared/schema.ts` | `pregame_power_radar_signals`, `pregame_power_radar_builds`, `hrRadarAlerts`, `hrRadarOutcomeStamps` | PERSIST | G |
| `shared/canonicalSignal.ts`, `mlbCanonicalSignal.ts`, `mlbSignal.ts`, `signalDrivers.ts` | Canonical transport + drivers contracts | SH | D |
| `shared/hrRadarStage.ts`, `hrRadarConviction.ts` | `CanonicalHrRadarStage`, conviction/seed tier labels (`PREGAME_SEED_CAP`) | SH | D |
| `server/analytics/*` (`hrRadarIntelligence`, `hrRadarMissTracer`, `hrRadarShadowMetrics`, `shadowAnalytics`, `driverIntelligence`, `analyticsEvent`) | Read-only Batch-E rollups | ANALYTICS | — |
| `server/growth/hrBoardStudio*` | Admin content studio over pregame board (read-only) | UI/API | D |

### 2.5 UI — `client/src/`

| Path | Purpose | Affects |
|---|---|---|
| `pages/mlb-live.tsx` | MLB live page; queries hr-radar/edge-feed; hosts `pregame_power` sub-tab | D |
| `components/mlb/PregamePowerRadar.tsx` | Renders pregame targets (server-stamped, verbatim) | D |
| `components/mlb/HrRadarLadder.tsx` | HR Radar ladder; **client-side re-bucketing + share-card derivation** (see §8) | D (contamination) |
| `lib/mlbUiMappers.ts` | `radarScoreToTier()` (legacy), `liveScoreToGrade()` | D (legacy derivation) |

---

## 3. Current Data Flow

### 3.1 Pre-Game Power (standalone module)

```
MLB Stats / Statcast / odds / park / weather feeds
   │  (dataPullService, dataSources, rosterService, gameDiscoveryService)
   ▼
buildPregamePowerRadar()  ── per confirmed-lineup batter ──┐
   │ batterPowerProfile (0.30) ─┐                          │
   │ pitcherVulnerability (0.25)─┤                          │
   │ matchupFit (0.20) ──────────┼─ composePregameScore ─→ score10 (0–10)
   │ parkWeatherScore (0.15) ────┤   + BvP modifier         │   + classifyTier
   │ lineupOpportunity (0.10) ───┘   + coverage caps        │   + suppression
   │                                 + matchup penalty       │
   ▼
pregamePowerRadarStore (in-memory snapshot)
   │                              │
   ├─ pregamePersistence ─→ DB: pregame_power_radar_signals / _builds
   │
   ├─ pregamePowerRadarService (TTL cache + DB fallback)
   │     │
   │     ▼
   │  Route GET /api/mlb/pregame-power-radar (requireMLBAccess)
   │     ▼
   │  UI: PregamePowerRadar.tsx (renders verbatim)
   │
   ├─ liveBridge.getPregamePowerTargetMap() ──(read-only)──→ /api/mlb/hr-radar/ladder
   │     (stamps pregamePowerTier/score10 badges on live rows — annotation only)
   │
   └─ shadowOutcomes.gradePregameOutcomes() ──(read-only state read)──→
         sets becameLiveReady/becameLiveFire + shadow hit-rate (NOT official ROI)
```

### 3.2 HR Radar Live (separate path)

```
liveGameOrchestrator (per-tick)
   │  live AB cache (EV/LA/dist/barrel), pitcher fatigue, count/state
   ▼
hrConversionModel.computeHRConversionProbability()
   │  baseRate
   │   × computePregameHrFormScore→pregamePriorMultiplier   ← INLINE pregame prior
   │       (decayed by liveness = hrBuildScore/4)             (NOT from §3.1 module)
   │   × liveContactMultiplier × hardHitInteraction
   │   × pitcher × environment × form × ibb × overlay
   │   → clamp per-PA [0.005, 0.12]
   │   → cumulative-binomial over Poisson PA dist → rawProb → calibratedProb
   ▼
evaluateHRAlert (alert tier) + hrAlertEngine.deriveState (WATCH/PREPARE/BET_NOW)
   ▼
hrRadarStateMachine (FSM) → hrRadarUserStage (track/build/ready/fire) → hrRadarSection
   ▼
LiveSignalBus → lifecycle store → normalizeSignal (display contract)
   ▼
Route GET /api/mlb/hr-radar(/ladder) → UI HrRadarLadder.tsx
   ▼
grading (FIRE-only official) → hrRadarOutcomeStamps + analytics (read-only)
```

**Key observation:** the two flows only ever meet **read-only** — at the ladder badge bridge and at the post-HR review classifier. The standalone Pre-Game Power score (§3.1) is **never multiplied into** the live probability (§3.2). The live probability uses its own inline prior instead.

---

## 4. Current Stat Coverage

"Owner" = where this input *should* live in the target two-engine design.

| Stat / input | Used? | Where used (file:fn) | PG or LIVE | Effect on output | Should own |
|---|---|---|---|---|---|
| barrel rate | Yes | `batterPowerProfile.ts` (w=3); `signalScore.computePowerProfileScore`; `featureEngineering` | PG + LIVE-season | raises power component / signalScore | Pre-Game Power |
| barrels per PA | Yes | `archetypes.classifyBatterArchetype` (≥0.18→elite); `hr/subEngines` Ψ | PG | archetype + overlay Ψ | Pre-Game Power |
| hard-hit rate | Yes | `batterPowerProfile` (w=2); `pitcherVulnerability` (allowed, optional) | PG | power / vuln components | Pre-Game Power |
| avg EV | Yes | `batterPowerProfile` (w=1); live multiplier | PG + LIVE | power component / live mult | shared (season=PG, live=Radar) |
| max / 90th EV | Yes | `batterPowerProfile` maxEV (w=2); `computeLiveContactMultiplier` (≥104→×1.25) | PG + LIVE | power component / live mult | shared |
| xSLG | Yes | `statcastXBA.computeXSLG`; `batterPowerProfile`; matchupFit family | PG | power/matchup | Pre-Game Power |
| xBA | Yes | `statcastXBA.computeXBA`; `hitProbabilityModel` | PG | hit-prob modifier | Pre-Game Power |
| xwOBAcon | Partial | `hr/subEngines` Ψ; `featureEngineering` xwOBA | PG | overlay Ψ | Pre-Game Power |
| sweet-spot rate | Yes | `statcastXBA`; `batterPowerProfile` (w=1) | PG | power component | Pre-Game Power |
| fly-ball rate | Yes | `batterPowerProfile`; `hrConversionModel.computePowerProfileMultiplier`; `hr/subEngines` Λ | PG | power mult | Pre-Game Power |
| pull-air rate | Partial | `signalScore.computePowerProfileScore` (pull%); `hr/subEngines` Λ (pull×FB) | PG | power | Pre-Game Power |
| HR/PA (season) | Yes | `archetypes` (≥0.055→elite_power); `computePregameHrFormScore` | PG | archetype + inline prior | Pre-Game Power |
| ISO | Partial | xISO (=xSLG−xBA) used; raw ISO not | PG | power | Pre-Game Power |
| recent 7/15/30 form | Yes | `signalScore.computeRecentFormScore` (0.4·L7+0.6·L15); `computeRecentFormMultiplier`; `hr/subEngines` Δ | PG + LIVE-season | form boost | Pre-Game Power |
| batting order slot | Yes | `paEstimator.SLOT_ADJUSTMENT`; `lineupOpportunity`; `hr/subEngines` Θ | PG | PA + opportunity | Pre-Game Power |
| projected PA | Yes | `paEstimator.estimateRemainingPA`; `paDistribution` | PG + LIVE | drives ≥1-HR prob | shared |
| starter confirmation | Yes | `buildPregamePowerRadar` (confirmed-lineup gate); `diagnostics.isPublicPregameSignal` | PG | gates publication | Pre-Game Power |
| pitcher HR/9 | Yes | `pitcherVulnerability` (w=4, vs hand); `signalScore.computeHrMatchupComponent` | PG | vuln component | Pre-Game Power |
| pitcher HR/PA allowed | Partial | indirect via handedness HR/9 splits | PG | vuln | Pre-Game Power |
| pitcher barrel rate allowed | **No** (defined but no producer) | `pitcherVulnerability` accepts `barrelAllowedPct?` optional, currently unfed | PG | none today | Pre-Game Power |
| pitcher hard-hit rate allowed | **No** (optional, unfed) | `pitcherVulnerability.hardHitAllowedPct?` | PG | none today | Pre-Game Power |
| pitcher xSLG allowed | **No** | not found | PG | none | Pre-Game Power |
| pitcher fly-ball rate allowed | **No** (optional, unfed) | `pitcherVulnerability.flyBallAllowedPct?` | PG | none today | Pre-Game Power |
| pitch-type matchup | Partial | `signalScore.computePitchMixMatchupScore`; `hr/subEngines` Γ (xSLG/whiff by pitch) | PG + LIVE | matchup mult | Pre-Game Power |
| batter xSLG by pitch type | Partial | `hrConversionModel` `pitchTypeSplits?` optional overlay; `hr/subEngines` Γ | PG | overlay | Pre-Game Power |
| pitcher HR allowed by pitch type | **No** | not found | PG | none | Pre-Game Power |
| handedness splits | Yes | `pitcherVulnerability` (vs hand); `signalScore.computeHandednessSplitsScore`; `matchupFit` | PG | vuln/matchup | Pre-Game Power |
| platoon advantage | Yes | `matchupFit` platoon scoring | PG | matchup | Pre-Game Power |
| park HR factor | Yes | `parkWeatherScore` (w=3); `hrConversionModel.computeEnvironmentMultiplier` | PG + LIVE-context | park component / env mult | shared (prior=PG) |
| park factor by handedness | **No** | only global park HR factor | PG | none | Pre-Game Power |
| park geometry | Partial | `parkWindFit.ts` / `playerParkWindFit` (display + spray fit) | PG-display | display only (not score) | Pre-Game Power |
| wind | Yes | `parkWeatherScore` (windOut/windIn); `parkWindFit` | PG | park/weather component | Pre-Game Power |
| temperature | Yes | `parkWeatherScore` (w=2) | PG | weather component | Pre-Game Power |
| humidity / air density | **No** | not found | PG | none | Pre-Game Power |
| roof status | Yes | `parkWeatherScore` (isIndoors → neutral) | PG | neutralizes weather | Pre-Game Power |
| bullpen HR vulnerability | **No** (modifier stub) | `hitProbabilityModel` has bullpen modifier; not in pregame power score | — | none in power score | Pre-Game Power |
| bullpen fatigue | **No** | not found | — | none | Pre-Game Power |
| market odds movement | **No** (pregame); Partial (signalScore price) | `signalScore` price component (edge vs odds) for non-HR; pregame power score has NO market input | LIVE-ish | minor | Pre-Game Power (target) |
| team total / game total | Partial | `lineupOpportunity.teamImpliedRuns` | PG | opportunity component | Pre-Game Power |
| live EV | Yes | `computeLiveContactMultiplier`, `nearHrContact`, `liveEventInterpretation` | LIVE | live mult / near-HR | HR Radar |
| live LA | Yes | `nearHrContact`, `liveEventInterpretation`, `statcastXBA` | LIVE | near-HR detection | HR Radar |
| live barrel / near-barrel | Yes | `nearHrContact`, `hrRadarSection` near-HR credit | LIVE | staging | HR Radar |
| live pitcher deterioration | Yes | `hrAlertEngine.computePitcherHrVulnerability` (PC≥100 +20, TTO≥3 +12, collapse +20) | LIVE | dynamic state | HR Radar |
| current count / game state | Yes | `liveEventInterpretation`, orchestrator | LIVE | live scores | HR Radar |

---

## 5. Current Formulas and Thresholds (quoted)

### 5.1 Pre-Game Power score — `pregamePowerRadar/scoring.ts`

- **Component weights:** `batterPower 0.30, pitcherVulnerability 0.25, matchupFit 0.20, parkWeather 0.15, lineupOpportunity 0.10`.
- **Data-coverage formula:** `batterPowerAvailable 0.35 + pitcherProfileAvailable 0.25 + confirmedLineup 0.20 + parkAvailable 0.10 + weatherAvailable 0.05 + bvpAvailable 0.05` (max 1.0).
- **Operation order:** `baseScore(weighted) → +BvP modifier → clamp(0,10) → applyCoverageCaps → score10 → classifyTier → suppression reasons`.
- **Coverage caps:** no batter power → cap 3.9; no pitcher profile → cap 5.9; park-only positive + no weather → cap 5.9; coverage <0.6 → cap 5.9.
- **Matchup penalty (cap 2.5):** `pitcherVuln<5 → +(5-v)*0.2`; pitcher slot suppressive → +0.8; batter slot weak → +0.5; BvP zero-production → +0.6 else BvP negative → +0.4.
- **Tier classify (`classifyTier`):** `batterPower≥7 & pitcherVuln<5.5 → power_watch`; `score≥8.8 & bp≥7 & pv≥6 & !eliteBlocked → nuclear`; `score≥7.3 & bp≥7 & pv≥6 & !eliteBlocked → elite`; `score≥6.8 & bp≥6.7 & pv≥5.5 → strong`; `score≥6.0 → strong`; `≥4.0 → watch`; else `track`.
- **Elite blocker:** BvP negative OR BvP zero-production OR pitcher slot suppressive OR batter slot weak.
- **Pitcher-vuln blend (build, ~line 359):** `available both → (handedness*2 + slotSplit*3)/5`; slot-only → slot; else handedness only.
- **Public gate (`diagnostics.isPublicPregameSignal`):** tier ∈ {power_watch, strong, elite, nuclear} AND confirmed lineup AND score10≥6.0 AND ≥2 positive drivers AND coverage≥0.6 AND batterPower available AND not suppressed AND game not final/postponed.

### 5.2 Live HR conversion probability — `hrConversionModel.ts`

- **Multiplicative chain (≈ line 942–1038):**
  `per_PA = baseRate × pregamePriorMult × hardHitInteraction × liveContact × pitcher × environment × form × ibb × overlay`, then **clamp `finalPerPARate = max(0.005, min(0.12, rate))`** (Phase 1.5 hard cap, line ~1038).
- **Inline pregame prior (line 982–991):**
  ```
  pregameFormScore = computePregameHrFormScore(input)        // 0–100, season stats
  fullMult        = pregamePriorMultiplier(pregameFormScore) // range [0.92, 1.15]
  liveness        = min(1, max(0, hrBuildScore / 4))
  pregamePriorMult= 1 + (fullMult - 1) * (1 - liveness)      // decays to 1.0 as live contact builds
  baseRate       *= pregamePriorMult
  ```
  Gated by env `HR_PREGAME_PRIOR` (default ON; `false/0/off/no` disables) at `hrConversionModel.ts:796`.
- **Live contact multiplier (cap 2.5):** elite HR +0.6 each; missed HR +0.4 each; pure HR-shaped +0.25 each; qualifiedEVMean ≥104→×1.25 / ≥101→×1.15 / ≥99→×1.08; maxDist ≥400→×1.20 / ≥390→×1.12 / ≥375→×1.06.
- **Hard-hit interaction (cap 1.25):** trigger EV≥104 or xBA≥0.65; base 1.10 (both) / 1.06; favorable LA∈[20,35] ×1.05; batSpeed≥75 ×1.05.
- **≥1-HR probability:** `pZeroHR = Σ_n paDist[n] · (1−finalPerPARate)^n; rawProb = 1 − pZeroHR` (deterministic; **no simulation**).
- **Calibration table (static, `CALIBRATION_BIN_EDGES`):** raw→calibrated, e.g. `0.30–0.40→0.36`, `0.40–1.00→0.46`; empirical buckets preferred when loaded.

### 5.3 Live staging thresholds

- `hrAlertEngine.ts`: `BET_NOW 0.14`, `PREPARE 0.07`, `WATCH 0.05` (on `calibratedProb × decayFactor`); pitcher vuln base 50, PC≥100 +20, TTO≥3 +12, collapse +20; readiness `confidencePts≤65 + conversionPts≤60`, `fwdProbGate = 0.4 + 0.6·min(1, calib/PREPARE)`.
- `evaluateHRAlert.ts`: `OFFICIAL_MIN 0.15`, `ALERT_MIN 0.08`, `WATCH_MIN 0.03` (0.015 in high-park late innings).
- `hrRadarUserStage.ts`: `READY_TO_FIRE_SUSTAIN_TICKS 3`, peak-currency ≥0.85 to fire, FIRE requires ≥1 CONTACT driver.
- `hrRadarStateMachine.ts`: display score floors watch 3.5 / build 5.5 / ready 7.5 / fire 9.0 (display fallback only, not transition math).

### 5.4 Probability engine constants

- `MARKET_SIGMA` (Normal CDF): hits 0.65, total_bases 1.10, home_runs 0.40, hrr 1.50, pitcher_outs 2.50, hr_allowed 0.50.
- `MARKET_PROBABILITY_CAPS`: home_runs 90, hrr 88, hits 96…; `MARKET_UNDER_CAPS`: pitcher_outs 72, hits_allowed 74, pitcher_strikeouts 76.
- Neg-binomial overdispersion `variance = mean × 1.35`; HRR compression floor 82 / justify 0.65; hits-allowed fatigue shift cap +12.

### 5.5 PA estimator — `paEstimator.ts`

`basePA = (9 - inning) × 0.44`; `SLOT_ADJUSTMENT {1:.45,2:.45, 3-5:.30, 6-7:.10, 8-9:-.10}`; pace factor `clamp(runs/leagueAvg, 0.85, 1.15)`; clamp `[1.0, 3.5]`; `remainingAB = floor(remainingPA × 0.87)`. PA distribution = Poisson PMF over adaptive support (`paDistribution.ts`).

### 5.6 Calibration / safety caps — `archetypes.ts`

`calibrated = 50 + (raw − 50) × shrinkage`, clamp [5,96]; shrinkage by archetype×market-volatility (e.g. `elite_power+high 0.88`, `limited_sample+high 0.68`); safety ceilings (e.g. `elite_power+home_runs 88`, `power_first+home_runs 82`). Phase 1.5 UNDER caps bind above all wrappers.

---

## 6. Pre-Game Power Readiness Assessment

| Capability | Status | Evidence |
|---|---|---|
| batter power score | **exists** | `batterPowerProfile.ts` (component 1, w=0.30) |
| pitcher vulnerability score | **exists** | `pitcherVulnerability.ts` + `pitcherOrderSplit.ts` blend |
| pitch-type matchup score | **partially exists** | covered in live `signalScore.computePitchMixMatchupScore` + `hr/subEngines` Γ; pregame `matchupFit` only does platoon/OPS/family — no dedicated pitch-type-vs-batter component in the pregame module |
| park / weather / spray score | **exists** | `parkWeatherScore.ts` (component 4) + display `playerParkWindFit.ts` |
| lineup opportunity score | **exists** | `lineupOpportunity.ts` (component 5) + `paEstimator` |
| bullpen path score | **missing** | no bullpen vulnerability/fatigue input in pregame power score |
| market confirmation score | **missing** | pregame power score consumes no odds/line input (`signalScore` price component is live, non-HR) |
| simulated HR probability | **missing** | pregame score is a 0–10 composite, not a probability; no simulation anywhere |
| confidence score | **partially exists** | `dataCoverageScore` + tier gating act as a confidence proxy; no calibrated probability/interval |
| Power Prior passed to HR Radar | **exists but mixed / forked** | HR Radar uses an **inline** `computePregameHrFormScore` prior in `hrConversionModel.ts`, NOT the standalone module; the module only feeds read-only badges + post-HR review attribution |

---

## 7. Monte Carlo Gap Analysis

**Nothing in the following list exists today** (verified by full reads + grep for `Math.random`, `monteCarlo`, `simulate`, `bernoulli`, `seededRandom` across `server/mlb/` and `shared/` — only hits are an English comment and a test label):

| Capability | Present? | Notes |
|---|---|---|
| simulation loop | No | all probabilities are closed-form |
| seeded randomness | No | none; note `Math.random()`/`Date.now()` are also restricted in this harness |
| PA distribution **sampling** | No | `paDistribution.ts` builds a Poisson PMF and is summed analytically, not sampled |
| pitcher exposure sampling | No | TTO/fatigue are deterministic multipliers |
| pitch-type exposure sampling | No | pitch-mix is a deterministic weighted score |
| weather uncertainty sampling | No | single deterministic park/weather score |
| Bernoulli HR event per PA | No | `1 − Π(1−p)^n` computed analytically |
| confidence interval / percentile output | No | single scalar score/probability only |
| simulation caching | No | only snapshot/TTL caching of deterministic builds |

**To add a Monte Carlo layer later, new files/functions would be needed** (do not build now):
- A new pure simulator, e.g. `server/mlb/pregamePowerRadar/monteCarlo.ts` exposing `simulatePlayerHR(input, draws): { pHR, p10/p50/p90, intervals }`, consuming: per-PA rate (from `hrConversionModel` engine math, NOT the composition layer), `paDistribution` as the PA prior, and park/weather/pitch-type/pitcher-exposure distributions.
- Seedable RNG abstraction (harness restricts `Math.random()` in workflow scripts — use an explicit injectable seed so results are reproducible/cacheable; pass timestamps/seeds in rather than reading the clock).
- A `PowerPrior` output type in `pregamePowerRadar/types.ts` (calibrated pHR + interval + provenance) and a sim cache keyed by `(buildId, batterId)`.
- A consumer hook so HR Radar's `hrConversionModel` reads the sim-derived `PowerPrior` instead of the inline `computePregameHrFormScore` (resolving Seam 1).

---

## 8. HR Radar Contamination Check

| Concern | Finding | Evidence |
|---|---|---|
| Pregame factors directly influence live Ready/Fire | **No (standalone module)** / **Yes but bounded (inline prior)** | Standalone module touches live only read-only (`liveGameOrchestrator.ts:730` review classifier; ladder badge bridge). The inline `pregamePriorMult` *does* multiply the live base rate but **decays to 1.0 by `hrBuildScore≥4`** (`hrConversionModel.ts:989`) and is capped by the 0.12 per-PA clamp, so it cannot drive a Ready/Fire on its own once live contact exists. |
| Live stats mixed into pregame scoring | **No** | `computePregameHrFormScore` (line 878) reads only season-level inputs; `pregamePowerRadar/` build reads season + slate context, never live EV/LA/count. |
| UI derives stages/scores client-side | **Yes — needs fixing** | `HrRadarLadder.tsx:1730–1849` re-buckets 0-AB FIRE/READY rows into a client-only "NO AB YET" section (flagged in `HR_RADAR_DIAGNOSTIC_AUDIT.md §6`); `HrRadarLadder.tsx:775–796` derives share-card hero numbers client-side; `mlbUiMappers.radarScoreToTier()` legacy score→tier mapping (`mlb-live.tsx:842`). These violate CLAUDE.md Hard Rule 4. |
| Route-level filters suppress signals incorrectly | **Low risk** | Pregame public gate (`diagnostics.isPublicPregameSignal`) is strict (tier≥power_watch, score≥6, coverage≥0.6) — intentional, but worth confirming it isn't hiding legitimate strong targets with thin coverage. |
| HR Radar and pregame share confusing names | **Yes** | "pregame power" means two different things: the `pregamePowerRadar/` module vs. `computePregameHrFormScore`/`pregameSeed`/`PREGAME_SEED_CAP`. Pregame tiers reuse `strong/elite` labels that also exist in live `signalTier`. |
| Scoring and display blended | **Partially (UI side)** | Server is clean; the UI ladder mixes capped vs. uncapped readiness in breakdown bars (`HrRadarLadder.tsx:597–604`). |

---

## 9. Persistence / Analytics Check

**Pregame candidates ARE persisted separately from live HR Radar signals.**

- **Pregame tables (`shared/schema.ts`):** `pregame_power_radar_signals` (PK `signalId`; includes `tier`, `score10`, `drivers`, `diagnostics`, `becameLiveReady`, `becameLiveFire`, `convertedLiveAt`, `outcomes` jsonb) and `pregame_power_radar_builds` (build manifest, `signalsCreated`, `suppressedCount`).
- **Live HR Radar tables:** `hrRadarAlerts` (`signalState`, `lifecycleState`, `gradingStatus`) and `hrRadarOutcomeStamps` (outcome audit).
- **Storage methods (`server/storage.ts`):** `upsertPregamePowerRadarSignal`, `getPregamePowerRadarSignalsByDate/ByGame`, `recordPregamePowerBuild`, `getLatestPregamePowerBuild` (impl ~lines 3186–3271). HR Radar grading uses the alert/stamp tables.
- **Analytics (`server/analytics/`):** read-only Batch-E (`hrRadarIntelligence`, `shadowAnalytics`, etc.) taps lifecycle/shadow/HR-radar emit sites; never mutates engine/bus/canonical fields.
- **Grading:**
  - **Live FIRE-only official:** `hrRadarSection.reachedFireCommitment()` gates the official called-pick record. Track/Build/Ready are NOT counted as official picks (READY is "high-watch").
  - **Pregame shadow-only:** `shadowOutcomes.gradePregameOutcomes()` grades pregame targets against box scores into their own `outcomes`/hit-rate proxy and sets `becameLiveReady/becameLiveFire` from a **read-only** canonical-state read. It **never** writes `persisted_plays`, official ROI, or W/L.
- **Are Track/Build/Ready/Fire counted correctly?** On the live side, yes (FIRE-only official; analytics splits shadow vs official). On the pregame side, pregame "tiers" are separate from live "stages"; pregame conversion to live ready/fire is tracked via the bridge flags, but **there is no unified calibration tying a pregame tier to an eventual live FIRE/cash rate** (gap for §10 Phase 5).

**Power Prior persisted/passed?** No artifact named `powerPrior`/`PowerPrior` exists. The closest persisted concept is `becameLiveReady/becameLiveFire` (outcome bridge) and the in-engine `PREGAME_SEED_CAP`/`pregameSeed` labels in `shared/hrRadarConviction.ts`. The live prior is recomputed inline, not loaded from the pregame store.

---

## 10. Improvement Recommendations (plan only — do NOT implement now)

> Guiding principle: **make `pregamePowerRadar/` the single canonical pregame brain, then have HR Radar consume its Power Prior — instead of the inline `computePregameHrFormScore` fork.** Build the contract first; never widen the fork.

**Phase 1 — Contracts / types only.**
- Files: `pregamePowerRadar/types.ts` (add `PowerPrior` type: calibrated pHR + interval + provenance + `source`), `shared/` (optional shared transport if UI needs it).
- Risk: **Low** (additive types, no runtime).
- Tests: type-level compile (`npx tsc --noEmit`); a unit test asserting `PowerPrior` defaults are no-ops.
- Don't touch: `hrConversionModel.ts` math, bus, lifecycle, `IMMUTABLE_FIELDS`.

**Phase 2 — Read-only Pre-Game Power board (consolidate, don't duplicate).**
- Files: `pregamePowerRadar/*` (extend scoring/coverage already present), `routes.ts` pregame endpoints, `PregamePowerRadar.tsx`.
- Add the **missing inputs** as additive/no-op-when-absent: bullpen path, market-confirmation, park-by-handedness, pitch-type-vs-batter component, pitcher barrel/hard-hit/FB allowed (the optional fields in `pitcherVulnerability.ts` already exist but are unfed — wire a producer).
- Risk: **Low–Medium** (pregame is isolated; no live mutation).
- Tests: extend `scoring.test.ts`, `directionalityRegression.test.ts`; add coverage-cap and new-input no-op tests.
- Don't touch: live engine, grading.

**Phase 3 — Monte Carlo layer (pregame only).**
- Files: new `pregamePowerRadar/monteCarlo.ts` (+ test), `paDistribution.ts` (reuse as PA prior), seedable RNG helper. Output calibrated pHR + p10/p50/p90 into `PowerPrior`.
- Risk: **Medium** (perf + determinism). Keep deterministic via injected seed; cache by `(buildId, batterId)`.
- Tests: distribution sanity (mean ≈ analytic `1−Π(1−p)^n`), seed-reproducibility, interval monotonicity, perf budget.
- Don't touch: `hrConversionModel.ts` clamps (sim must respect existing per-PA caps), bus, lifecycle.

**Phase 4 — Power Prior into HR Radar (resolve Seam 1).**
- Files: `hrConversionModel.ts` (replace inline `computePregameHrFormScore`/`pregamePriorMultiplier` with a read of the persisted `PowerPrior`, keeping the **same liveness decay** and **same 0.12 clamp**; keep behind `HR_PREGAME_PRIOR` flag for rollback). Re-baseline `MLB_GOLDMASTER_VERSION` in `goldmasterGuard.ts` per CLAUDE.md §7a.
- Risk: **High** (changes live probability path). Must be in the engine layer (allowed by §7a), additive, capped, re-baselined, regression-tested.
- Tests: full §1 regression suite (`phase3bRegression`, `hrRadar*`, `hrCalibration`), plus a new parity test that the prior is a no-op once `hrBuildScore≥4`.
- Don't touch: composition/normalizer/lifecycle/bus layers (Hard Rules 1,2,5,8).

**Phase 5 — Separate analytics / calibration.**
- Files: `server/analytics/` (new read-only pregame-prior calibration: pregame tier → eventual live FIRE/cash rate), `shadowOutcomes.ts` extensions.
- Risk: **Low** (analytics are read-only, try/catch wrapped).
- Tests: analytics rollup unit tests; assert no mutation of engine/bus.
- Don't touch: any runtime state (Hard Rule 8).

---

## 11. Test Inventory

**Existing (run before any change):**
- MLB probability / engine: `canonicalProbability.test.ts`, `canonicalSignalTier.test.ts`, `phase3bRegression.test.ts`, `statcastBarrel.test.ts`, `statcastXBA.ts` cases, `hrEvGate.test.ts`, `hrHardHitInteraction.test.ts`.
- HR Radar: `hrRadarStateMachine.test.ts`, `hrRadarReadyToFire.test.ts`, `hrRadarFireOnlyGrading.test.ts`, `hrRadarLifecycleRepair.test.ts`, `hrRadarFreshnessOverlay.test.ts`, `hrRadarRuntimeSmoke.test.ts`, `hrRadarPromotionUnify.test.ts`, `hrRadarNearHrCredit.test.ts`, `hrRadarSingleRenderer.test.ts`, `hrRadarBadges.test.ts`, `hrRadarHonestGrading.test.ts`, `hrRadarDisplayContract.test.ts`, `nearHrContact.test.ts`, `nearHrContactBenRice.test.ts`, `hrReviewClassifier.test.ts`.
- Signal scoring / form: `shadowOutcomeWiring.test.ts`, `pullAndPregame.test.ts`, `ibbAndRecentForm.test.ts`, `hrCalibration.test.ts`, `phase2Ingestion.test.ts`.
- Pregame power module: `pregamePowerRadar/scoring.test.ts`, `liveBridge.test.ts`, `marketTagger.test.ts`, `batterOrderSplit.test.ts`, `pitcherOrderSplit.test.ts`, `parkWeatherCarry.test.ts`, `directionalityRegression.test.ts`, `pregameParkWindDisplay.test.ts`.
- Park/weather: `parkWindFit.test.ts`, `parkWindFitWeatherSync.test.ts`, `pregamePowerRadar/parkWeatherCarry.test.ts`.
- Math: `math/distributions.test.ts`.
- Analytics split: `analytics/hrRadarOfficialSplit.test.ts`; growth: `growth/hrBoardStudio.test.ts`.

**Missing tests needed before changing anything:**
- A **PA-estimator** unit test (`paEstimator.ts` has no dedicated test).
- A **`computePregameHrFormScore` / `pregamePriorMultiplier`** unit test (the inline prior is untested in isolation).
- A **liveness-decay parity** test proving the prior → 1.0 at `hrBuildScore≥4` (locks the contamination boundary before Phase 4).
- A **pregame→live conversion calibration** test (pregame tier vs eventual FIRE/cash) — none today.
- Monte Carlo determinism/interval tests (Phase 3, when built).
- A **display-contract test** that the UI does not re-bucket server stages (would catch the `HrRadarLadder.tsx` 0-AB re-bucketing regression).

---

## 12. Final Handoff Summary

**Current true state.**
A real, isolated Pre-Game Power engine exists (`server/mlb/pregamePowerRadar/`): deterministic 5-component 0–10 scoring, dedicated DB tables, public/admin APIs, a UI tab, and shadow grading — all read-only toward the live engine. Separately, the live HR Radar (`hrConversionModel.ts`) computes its **own inline** pregame HR-form prior from season stats, capped and decayed by live contact. **There is no Monte Carlo anywhere**, and the live engine does **not** consume the standalone module as a Power Prior.

**Biggest risk.**
The **forked pregame logic** — two unreconciled "pregame power" computations. Building Monte Carlo or a Power Prior without first declaring `pregamePowerRadar/` canonical will deepen the fork and create two calibration surfaces that disagree. Secondary risk: UI client-side stage/score re-derivation in `HrRadarLadder.tsx` (display-truth violation of Hard Rule 4).

**Best next implementation target.**
Phase 1 + Phase 2: lock a `PowerPrior` contract type and consolidate the missing inputs (bullpen, market confirmation, pitch-type-vs-batter, pitcher contact-allowed feeds) into the standalone module — purely additive, no live-path risk.

**Files to change first (when authorized).**
`pregamePowerRadar/types.ts` (PowerPrior type), then `pregamePowerRadar/scoring.ts` + `pitcherVulnerability.ts` + `matchupFit.ts` (wire already-defined optional inputs), then a producer in the data layer (`dataPullService.ts`/`dataSources.ts`).

**Files to avoid touching (until Phase 4, with re-baseline + full regression).**
`hrConversionModel.ts` (live probability math), `liveSignalBus.ts`, `lifecycleEngine.ts`/`lifecycleStore.ts`, `normalizeSignal.ts`, `shared/canonicalSignal.ts` `IMMUTABLE_FIELDS`, `goldmasterGuard.ts` (only bump version when intentionally changing engine math), and the analytics layer's runtime state.

**Open questions (for the product/eng owner).**
1. Should the standalone `pregamePowerRadar/` engine become the canonical source of the live Power Prior, retiring inline `computePregameHrFormScore`? (Recommended.)
2. Should the pregame score evolve from a 0–10 composite into a **calibrated probability** (prereq for a meaningful Monte Carlo / Power Prior)?
3. What is the intended relationship between pregame tiers (`power_watch/strong/elite/nuclear`) and live stages (`track/build/ready/fire`) for unified track-record reporting?
4. Do we have data feeds for the currently-unfed inputs (pitcher barrel/hard-hit/FB allowed, park-by-handedness, bullpen, market movement)? Monte Carlo realism depends on them.
5. Is the strict public gate (`score≥6, coverage≥0.6`) suppressing legitimate high-power/thin-data targets?

---

*End of audit. No production code was modified.*
