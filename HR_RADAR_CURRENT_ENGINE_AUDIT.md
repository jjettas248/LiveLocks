# HR Radar Current Engine Audit

> **Read-only handoff audit** of the LiveLocks MLB HR Radar engine, end-to-end.
> No code was changed, no migrations run, no thresholds touched, no data mutated.
> Produced for external review + Pre-Game Power Monte Carlo integration planning.

---

## 1. Executive Summary

HR Radar Live is a **per-tick, live-event-driven** engine. Every ~10s a poller hydrates
MLB Stats API + Statcast + Savant + weather into in-memory caches, runs the MLB probability
engine (Phase 1 → 1.5 → 2 → 2.5 → 3B), and — **in parallel** — runs a dedicated HR alert /
readiness track (`evaluateHRAlert` + `hrAlertEngine` + a pure state machine) that promotes a
batter through `inactive → watch → build → ready → fire → cashed|missed|model_review|expired`.
The canonical signal travels engine → normalizer → bus → lifecycle → API → UI, and grading is
**FIRE-only**: only a signal that reached FIRE commitment is counted in the official W/L record.

**Overall health:** Structurally sound. The architecture's hard invariants (sole bus ingress,
post-bus immutability, FIRE-only grading, server-stamped display contract, no cross-sport imports,
analytics read-only, ET dominance) are all **honored**. All five HR-Radar regression suites pass
(60 + 32 + 26 + 21 + 15 invariants green). The display layer correctly gates 0–100 readiness from
ever rendering as a probability percentage (≤60% ceiling guard).

**Where the risk actually lives:** *complexity and translation surface*, not correctness bugs.
There are **five coexisting stage/state vocabularies** (engine dynamic state, canonical lifecycle,
user stage, legacy confidence/signal tiers, review-classifier buckets) bridged by ~10 mapping
functions. They do not currently conflict, but the cognitive load is high and the system is one
careless edit away from a stage mismatch. Secondary risks: an HR market-key (`hrr` vs `home_runs`)
fragility that previously dropped cashes silently and is now defended by a dual-attempt belt-and-
suspenders; a same-tick grading race patched with a timing hack (synthetic event 1s before HR
end-time); and an unwired data input (`pitcherOrderSplits`) the pregame module reads but nothing
populates.

**Pre-Game Power:** A full `pregamePowerRadar/` module **already exists** and is correctly
isolated — it is read-only, additive, never registers on the live bus, and **cannot** force
Ready/Fire (its `liveBridge` only *reads* canonical HR state to check whether a pregame target
later converted). A future Monte Carlo engine should attach **inside** that module as a Power Prior
annotation, never as a live forcing function. **The pregame/live boundary is currently clean and
must stay that way.**

---

## 2. Branch / Commit Inspected

| Field | Value |
| --- | --- |
| Working directory | `/home/user/LiveLocks` |
| Branch | `claude/keen-dirac-ph5uws` |
| HEAD commit | `dddc1ec0c9d6eeb999bad6a26f20a25aa120a17a` |
| `git status --short` | *(clean — no modifications, no untracked files at audit start)* |
| Goldmaster version | `mlb-goldmaster-v16-2026-06-25-player-park-wind-fit` (`server/mlb/goldmasterGuard.ts:21`) |
| Audit date | 2026-06-25 |

---

## 3. Full File Map

### 3.1 Pure engine logic (probability / readiness / signals)
| File | Role |
| --- | --- |
| `server/mlb/hrConversionModel.ts` | Per-PA HR conversion probability (0–1). Base rate → live/pitcher/env/fatigue/IBB multipliers → caps → calibration |
| `server/mlb/evaluateHRAlert.ts` | Contact classification + alert path routing (FAST_PROMOTE_*, PATH_A…E), vetoes |
| `server/mlb/hrAlertEngine.ts` | Readiness score (0–100) + dynamic state machine (WATCH/PREPARE/BET_NOW), decay |
| `server/mlb/HRSignalBuilder.ts` | `buildScore` (0–10): in-game contact quality / HR-shaped classification |
| `server/mlb/nearHrContact.ts` | Phase 2.5 near-HR + "almost HR" detection, near-HR peak detection (pure, no I/O) |
| `server/mlb/signalScore.ts` | `deriveSignalTier`, signal score, HR timing component |
| `server/mlb/probabilityEngine.ts`, `probability.ts` | Core sided probability math |
| `server/mlb/markets.ts` | `calculateMLBPropEdge` — engine entry per market |
| `server/mlb/featureEngineering.ts` | Feature derivation feeding the engine |
| `server/mlb/hr/hrOverlay.ts`, `hr/subEngines.ts`, `hr/hrOverlayConstants.ts`, `hr/normalization.ts`, `hr/temporalFilter.ts` | Phase 2 consolidated HR overlay (power profile Ψ, launch topology Λ, recency Δ, lineup volume Θ, arsenal Γ) |
| `server/mlb/hrThresholds.ts`, `hrMaxWindow.ts` | Threshold + max-window constants |
| `server/mlb/liveEventInterpretation.ts` | Live contact/momentum/fatigue/velo-drop scoring → confidence boost |
| `server/mlb/calibration.ts`, `hitProbabilityModel.ts`, `outcomeDistribution.ts`, `paEstimator.ts`, `paDistribution.ts` | Calibration + distributions + PA estimation |

### 3.2 Stage / lifecycle / state-machine
| File | Role |
| --- | --- |
| `server/mlb/hrRadarStateMachine.ts` | **Pure** transition graph `inactive→watch→build→ready→fire→{cashed,missed,model_review,expired}` |
| `server/mlb/hrRadarCanonicalStore.ts` | In-memory canonical HR-radar state persistence (`upsertCanonicalHrRadarState`) |
| `server/mlb/hrRadarUserStage.ts` | User-facing stage mapping (`mapToUserStage`, `enrichWithUserStage`, FIRE-only `officialSignalStage`) |
| `server/mlb/hrRadarSection.ts` | Section/outcome helpers + grading gates (`reachedFireCommitment`, `reachedHrMaxWindow`, `inferCashedFromTierStatus`) |
| `server/mlb/hrRadarState.ts` | State helpers |
| `server/mlb/hrRadarFreshnessOverlay.ts` | Canonical-store freshness overlay (re-bucket/surface/terminal-safety) |
| `server/mlb/nonHrSignalState.ts` | Parallel non-HR market state (`BUILDING→ACTIVE→COOLING→CLOSED`) |
| `server/mlb/hrReviewClassifier.ts` | 9-bucket post-HR review taxonomy (diagnostic, **not** grading) |
| `shared/hrRadarStage.ts` | Canonical user-stage type + rank table (single source) |
| `shared/hrRadarConviction.ts` | Conviction-aware score cap |

### 3.3 Persistence / grading
| File | Role |
| --- | --- |
| `server/mlb/hrRadarOutcomeStamp.ts` | In-memory + durable first-write-wins outcome stamps |
| `server/storage.ts` | DB grading (`resolveHrRadarAlertAsHit`, `matchHrRadarAlertToHrEvent`, hit-rate rollups) |
| `shared/schema.ts` | Tables: `hr_radar_alerts`, `hr_radar_signal_events`, `hr_radar_outcome_stamps`, `persisted_plays`, `game_player_stats` |
| `server/validation/hrRadar/matchDecision.ts` | `QUALIFYING_EVENT_TYPES`, `decideHrRadarMatch` |
| `server/mlb/hrPreHrBusEvidence.ts`, `hrPreHrEventResolver.ts` | Pre-HR bus evidence + event resolution |

### 3.4 Lifecycle / bus / mapper (shared services)
| File | Role |
| --- | --- |
| `server/services/liveSignalBus.ts` | **Sole ingress** — dedupe (signalId only), freshness, propagation, `cashSignal` |
| `server/services/lifecycleEngine.ts`, `lifecycleStore.ts` | Lifecycle transitions only (allowed-field mutations) |
| `server/services/signalMutationGuard.ts` | Enforces `IMMUTABLE_FIELDS` |
| `shared/canonicalSignal.ts` | `CanonicalSignal`, `lifecycleState`, `signalTier`, `IMMUTABLE_FIELDS` |
| `shared/signalDrivers.ts` | `SignalDriver` server-built evidence contract |
| `server/mlb/normalizeSignal.ts` | `applyDisplayContract` — stamps display fields once at engine exit |

### 3.5 Orchestration / data
| File | Role |
| --- | --- |
| `server/mlb/liveGameOrchestrator.ts` | Per-tick driver — polling, hydration, engine trigger, HR grading |
| `server/mlb/liveGameRegistry.ts` | Active-game registry |
| `server/mlb/dataPullService.ts`, `dataSources.ts` | MLB Stats API + Savant + weather + splits fetchers; PARK_FACTORS table |
| `server/mlb/statcastXBA.ts`, `parkWindFit.ts` | Statcast xBA + park/wind fit |
| `server/mlb/goldmasterGuard.ts` | Goldmaster lock + drift guard |

### 3.6 Pre-Game Power (already present — isolated module)
| File | Role |
| --- | --- |
| `server/mlb/pregamePowerRadar/buildPregamePowerRadar.ts` | Pregame board build orchestration |
| `server/mlb/pregamePowerRadar/pregamePowerRadarService.ts` | Snapshot service (`getRadarSnapshot` async, `peekRadarSnapshot` sync) |
| `server/mlb/pregamePowerRadar/scoring.ts`, `scoreUtils.ts` | Pregame composite scoring (0–10) |
| `server/mlb/pregamePowerRadar/batterPowerProfile.ts`, `pitcherVulnerability.ts`, `matchupFit.ts`, `lineupOpportunity.ts`, `parkWeatherScore.ts`, `playerParkWindFit.ts` | Component scorers |
| `server/mlb/pregamePowerRadar/liveBridge.ts`, `liveBridgeCore.ts` | **Read-only** bridge: pregame target → live ladder annotation |
| `server/mlb/pregamePowerRadar/shadowOutcomes.ts` | Pregame grading (writes only to pregame store; never official W/L) |
| `server/mlb/pregamePowerRadar/pregamePersistence.ts`, `pregamePowerRadarStore.ts` | Pregame DB persistence + lookup |
| `server/mlb/pregamePowerRadar/types.ts` | Pregame types |

### 3.7 UI (renders Track/Build/Ready/Fire)
| File | Role |
| --- | --- |
| `client/src/components/mlb/HrRadarLadder.tsx` | Full ladder (FIRE/READY/ALMOST/TRACK/CASHED/MISSED/NO-AB-YET/MODEL-REVIEW) |
| `client/src/components/mlb/HrQuickDecide.tsx` | Compact decision cards |
| `client/src/components/mlb/MlbSignalCard.tsx` | Signal card |
| `client/src/components/mlb/hrRadarDisplayState.ts` | **Read-only** client mapper (score/tier/lifecycle formatting; never recomputes) |
| `client/src/components/mlb/hrRadarScore.ts` | Safe score extraction (null-guarded) |
| `client/src/components/mlb/TopLiveOpportunities.tsx`, `TopPlays.tsx`, `LiveBoard.tsx` | Legacy consumers |
| `client/src/pages/mlb-live.tsx` | MLB live page |
| `client/src/lib/mlb/canonicalSignalViewModel.ts`, `mlbUiMappers.ts` | Read-only view-model adapters |

---

## 4. Current HR Radar Architecture Diagram

```
                         ┌──────────────────────────────────────────┐
                         │  LIVE DATA (per ~10s poll)               │
                         │  MLB StatsAPI v1.1 feed/live             │
                         │  Baseball Savant (4h TTL)                │
                         │  Open-Meteo weather (10m)                │
                         └────────────────┬─────────────────────────┘
                                          │ syncGameState/BoxScore/ContactData/PitcherContext
                                          ▼
                    ┌───────────────────────────────────────────────┐
                    │ liveGameOrchestrator._pollGameInner(gameId)   │
                    │ → triggerEngine(gameId, trigger)              │
                    └──────────────┬────────────────┬───────────────┘
                                   │                │
              (engine prob track)  │                │  (HR readiness track — PARALLEL)
                                   ▼                ▼
        ┌────────────────────────────────┐  ┌──────────────────────────────────────┐
        │ markets.calculateMLBPropEdge   │  │ evaluateHRAlert(input)               │
        │  Phase 1→1.5→2→2.5→3B          │  │  + HRSignalBuilder.buildScore (0-10) │
        │  hrConversionModel (0-1)       │  │  + nearHrContact (near-HR/peak)      │
        │  → engineProbability           │  │  hrAlertEngine: readiness 0-100,     │
        │  signalScore.deriveSignalTier  │  │   dynamic WATCH/PREPARE/BET_NOW      │
        └───────────────┬────────────────┘  └──────────────────┬───────────────────┘
                        │                                       │
                        ▼                                       ▼
        ┌────────────────────────────────┐   ┌─────────────────────────────────────┐
        │ normalizeSignal                │   │ hrRadarStateMachine                 │
        │  applyDisplayContract          │   │  applyHrRadarLifecycleEvent (pure)  │
        │  → CanonicalSignal             │   │  inactive→watch→build→ready→fire→…  │
        │   (display* stamped, IMMUTABLE)│   │ hrRadarCanonicalStore.upsert…       │
        └───────────────┬────────────────┘   └──────────────────┬──────────────────┘
                        │                                       │
                        ▼                                       │
        ┌────────────────────────────────┐                     │
        │ liveSignalBus.registerSignal   │   sole ingress       │
        │  dedupe by signalId only       │                      │
        │ lifecycleEngine/Store          │                      │
        └───────────────┬────────────────┘                     │
                        │                                       │
                        └─────────────────┬─────────────────────┘
                                          ▼
                    ┌───────────────────────────────────────────────┐
                    │ API (server/routes.ts)                        │
                    │  /api/mlb/hr-radar, /hr-radar/ladder, board   │
                    │  + hrRadarFreshnessOverlay (live re-bucket)   │
                    └────────────────┬──────────────────────────────┘
                                     ▼
                    ┌───────────────────────────────────────────────┐
                    │ UI (read-only; NEVER recomputes)              │
                    │  HrRadarLadder / HrQuickDecide                │
                    │  hrRadarDisplayState mapper                   │
                    └───────────────────────────────────────────────┘

         GRADING (on HR / on game-final), FIRE-only:
            gradeSingleHRPlay → stampHrRadarOutcome (first-write-wins)
            → cashSignal(hrr & home_runs) → resolveHrRadarAlertAsHit (DB)
            → reachedFireCommitment ? called_hit_* : uncalled_hr
            → hrReviewClassifier (diagnostic bucket)

         PRE-GAME POWER (separate, additive, read-only):
            buildPregamePowerRadar → snapshot → liveBridge (READS canonical
            HR state only; cannot force ready/fire) → shadowOutcomes grading
            writes ONLY to pregame store.
```

---

## 5. End-to-End Data Flow

```
Live event source     MLB StatsAPI v1.1 feed/live (10s) + Savant (4h) + Open-Meteo (10m)
  → parser/orchestrator
                      liveGameOrchestrator._pollGameInner → syncGameState / syncGameBoxScore /
                      syncContactData (Statcast EV/LA/dist) / syncPitcherContext (pitch mix, velo) /
                      syncBatterRollingStats / syncBvPMatchup / fetchBaseballSavantData
  → HR signal detection
                      evaluateHRAlert(input): HR-shaped contact classification (elite/missed/
                      hr-shaped/solid), barrels, vetoes; nearHrContact: near-HR + peak detection
  → score/readiness calculation
                      hrConversionModel → per-PA HR prob (0-1, cap 0.12; calibrated cap 0.46);
                      hrAlertEngine → readiness 0-100 + dynamic state (BET_NOW≥0.14 /
                      PREPARE≥0.07 / WATCH≥0.05); HRSignalBuilder → buildScore 0-10
  → canonical/lifecycle mapping
                      normalizeSignal.applyDisplayContract → CanonicalSignal (display* stamped);
                      hrRadarStateMachine.applyHrRadarLifecycleEvent → lifecycleState;
                      hrRadarCanonicalStore.upsertCanonicalHrRadarState → {lifecycleState,
                      section, userStage, displayScore10, peakScore10}
  → storage/API
                      hr_radar_alerts / hr_radar_signal_events / hr_radar_outcome_stamps (DB);
                      routes.ts /api/mlb/hr-radar(/ladder|-board) + freshness overlay
  → UI render
                      HrRadarLadder / HrQuickDecide read server-stamped userStage + scores;
                      hrRadarDisplayState formats only (no recompute)
  → grading/settlement
                      on HR: gradeSingleHRPlay → stampHrRadarOutcome → resolveHrRadarAlertAsHit;
                      FIRE-only: reachedFireCommitment ? called_hit_* : uncalled_hr;
                      on final: reconcileHrRadarFinalGame → called_miss for FIRE/READY, inactive
                      for Track/Build
  → analytics/history
                      read-only taps (server/analytics/), shadow track (shadowQualification.ts),
                      hrReviewClassifier diagnostic buckets, /api/mlb/hr-radar-grading*
```

---

## 6. Current Stats Inventory

> Source files abbreviated: `HCM` = `hrConversionModel.ts`, `HSB` = `HRSignalBuilder.ts`,
> `NHC` = `nearHrContact.ts`, `SS` = `signalScore.ts`, `DPS` = `dataPullService.ts`,
> `HO` = `hr/hrOverlay.ts`. Thresholds reflect what the agents read; treat as
> directional and re-confirm exact constants before any change.

### 6.1 Contact-quality inputs (live)
| Input | Source fn | Data source | Used for | Live/Hist | Weight / threshold | Notes / risk |
| --- | --- | --- | --- | --- | --- | --- |
| Exit velocity | HSB / NHC / HCM | StatsAPI `hitData` (`DPS:732`) | classification, EV bonuses, hard-hit interaction | Live | EV≥104 ×1.25; ≥101 ×1.15; ≥99 ×1.08 | Missing → `missingDataContact` (not noise) |
| Launch angle | HSB / NHC | StatsAPI `hitData` | sweet-spot / HR-shape windows | Live | LA∈[20,35] near-HR; [22,36] elite | Missing → `degraded` |
| Distance | HSB / NHC | StatsAPI `hitData.totalDistance` | deep-fly, HR-shape | Live | ≥400 ×1.20; ≥390 ×1.12; ≥375 ×1.06 | Missing → `degraded` |
| Statcast barrel flag | NHC | Savant / inferred | barrel override → lean/watch | Live | bool | `false` when absent |
| Per-AB xBA | HSB / NHC | Savant | high-xBA danger, FAST_PROMOTE gates | Live | xBA≥0.65 danger; ≥0.40 promote | `null` omitted |
| Hard-hit rate (season) | HCM / HO | Savant | power profile | Hist | 0.40–0.55 elite | `null` → ~0.35 proxy |
| Barrel rate (season) | HCM / HO | Savant | base-rate fallback (`barrelRate/0.065`) | Hist | barrelAdj=min(1.5, …) | `null` omitted |
| Bat speed | HCM | Savant swing tracking | hard-hit interaction amp | Hist/Live | ≥75 ×1.05; ≥72 ×1.02 | estimated from EV if absent |
| Swing length | HSB | Savant | swing efficiency | Hist | ratio ≥10.5 | `null` omitted |
| Sweet-spot % | HCM / HO | Savant | power profile Ψ | Hist | baseline 31% | `null` → inferred LA |
| Topped % | HO | Savant | soft-gate suppression | Hist | >25% floor | `null` → MISSING |

### 6.2 Batter season / form
| Input | Source fn | Used for | Threshold | Notes |
| --- | --- | --- | --- | --- |
| Season HR rate | HCM | base-rate seed | clamp (0, 0.12] | fallback `LEAGUE_AVG_HR_PER_PA=0.033` |
| xSLG / xwOBA / xISO | HCM / HO | base-rate scaling, power profile | xwOBA factor∈[0.70,1.55] | `null` omitted |
| HR/FB, FB%, pull% | HCM / HO | power profile, launch topology Λ | — | `null` omitted/baseline |
| Last 7/15/30 HR rate, recent OPS | HCM | recent-form multiplier (+~5%) | L7≥1.8×season | `null` omitted |
| AB since last HR | SS | HR timing component | expectedABperHR ×1.5–3.0 | `null` → 50 neutral |
| Batter hand | HCM | handedness matchup | L/R/S | `null` → neutral |
| HR rate / OPS vs LHP/RHP | HCM / SS | handedness split | — | `null` → 1.0 |
| Season IBB rate (+ base/out) | HCM | "feared slugger" prior | ≥2% ×1.06; ≥1% ×1.02 | additive |
| BvP avg / HR / AB | SS | low-confidence context | sample ≥5/≥10 | omit if <5 |

### 6.3 Pitcher inputs
| Input | Source fn | Used for | Threshold | Notes |
| --- | --- | --- | --- | --- |
| Pitch count | HCM / hrAlertEngine | fatigue multiplier | ≥100 ×1.30; ≥90 ×1.25; ≥80 ×1.15; ≥70 ×1.08 | `0` → no fatigue |
| Times through order | HCM | TTO multiplier | ≥3 ×1.20; ≥2 ×1.08 | `1` default |
| Pitcher collapsing flag | hrAlertEngine | hardcoded ×1.30 | bool | `false` |
| Velocity drop / recent velo trend | HCM | velo-decay multiplier | >3.5mph ×1.25; slope ≤-2.0 ×1.10 | `0`/`null` no-op |
| ERA (starter/reliever split) | HCM | quality multiplier | ≥6.0 ×1.20 … ≤2.5 ×0.80 | `4.0` league avg |
| Pitcher HR/9 vs hand | HCM | 40% blend w/ ERA | range [0.88,1.12] | `null` → 1.0 |
| Entry fatigue (last start PC, days rest, last-3 ERA) | HCM | pre-game arm fatigue | rest 3d ×1.10; 8d+ ×0.95 | additive |
| Pitch mix % / type | HCM | pitch-mix × handedness | FB≥60% opp-hand ×1.10 | opp-hand fallback |
| Bullpen ERA / usage / relievers used | HCM | bullpen context | 3+ relievers +8% | `null` → 1.0 |
| **Pitcher order splits (HR allowed by slot)** | (pregame reads `mlbPlayerCache.pitcherOrderSplits`) | opportunity context | — | **NO PRODUCER WIRED — always empty (see Finding P2-2)** |

### 6.4 Park / weather (live + contextual)
| Input | Source fn | Used for | Threshold | Notes |
| --- | --- | --- | --- | --- |
| Park factor | HCM / `getMarketParkFactor` | park multiplier | ≥1.15 ×1.20 … ≤0.90 ×0.85 | hardcoded PARK_FACTORS in `dataSources.ts` |
| Wind speed/direction/degrees | HCM | carry (outdoor) | out≥18 ×1.22; in≥12 ×0.82 | `0`/calm fallback |
| Temperature | HCM | carry | ≥90 ×1.08; ≤40 ×0.88 | `70` neutral |
| Humidity / pressure | HCM | air density | ≥85% ×1.05; ≤1000hPa ×1.04 | `null` → 1.0 |
| Player park/wind fit | HCM / `parkWindFit.ts` | hand+pull spray fit | neutral 1.0 | `null` → generic |

### 6.5 Derived scores / states (NOT raw stats — see §9 contract)
| Value | Range | Owner | Meaning |
| --- | --- | --- | --- |
| `engineProbability` | 0–1 | markets/probabilityEngine | sided market probability (true probability) |
| `conversionProbability` (raw / calibrated) | 0–1 | HCM | per-PA HR probability; raw cap 0.12, calibrated cap 0.46 |
| `hrReadinessScore` | 0–100 | hrAlertEngine | confidencePts + conversionPts (display score, NOT a probability) |
| `buildScore` | 0–10 | HSB | in-game contact quality |
| `signalScore` | 0–100 (shown /10) | SS | composite signal strength |
| `displayScore10` / `peakScore10` | 0–10 | canonical store | conviction-capped display scores |
| `signalTier` | watch/lean/strong/elite | SS | tier (orthogonal to lifecycle) |
| `lifecycleState` | inactive…expired | state machine | canonical FSM state |
| `userStage` | track/build/ready/fire/resolved | hrRadarUserStage | user ladder source of truth |
| dynamic state | WATCH/PREPARE/BET_NOW | hrAlertEngine | engine readiness band |

---

## 7. Current Qualifying Signal Inventory

> Promotion target, grading effect, and persistence noted per signal. "Promotes" = drives a
> stage transition; grading is always FIRE-only at settlement regardless of promote tier.

### 7.1 HR-shaped contact (`HRSignalBuilder.ts`)
| Signal | Condition | Promotes | Notes / FP-FN risk |
| --- | --- | --- | --- |
| `eliteHrContact` | EV≥98 ∧ LA∈[22,36] ∧ dist≥360 | feeds FAST_PROMOTE_SINGLE_ELITE → fire | strongest single-event driver (×3.0 in buildScore) |
| `missedHrContact` | EV≥95 ∧ LA∈[20,38] ∧ dist≥320 | build/ready | ×2.5 weight |
| `hrShapedContact` | EV≥93 ∧ LA∈[16,42] ∧ dist≥300 | build | ×1.8 weight |
| `solidContact` | EV≥95 (EV-only) | watch/build floor | ×0.6; FP risk if LA poor (line-drive single) |

### 7.2 Near-HR tiers (`nearHrContact.ts`)
| Signal (matched path) | Condition | Tier | Risk |
| --- | --- | --- | --- |
| LEAN | EV≥102 ∧ LA∈[20,32] ∧ dist≥375 ∧ (xBA null∨≥0.5) | lean | low FP |
| WATCH | EV≥98 ∧ LA∈[20, parkLaMax] ∧ dist≥350 | watch | parkLaMax=42 if PF≥1.10 else 35 |
| HIGH_XBA_DANGER | xBA≥0.65 ∧ EV≥96 ∧ LA∈[16,34] | watch/lean | xBA model dependency |
| BARREL_OVERRIDE | Statcast `isBarrel` | watch/lean | barrel-flag availability dependent |
| DEEP_FLYOUT_LEAN / _WATCH | dist≥360/330 ∧ LA window ∧ EV≥95/92 ∧ outcome=out | lean/watch | "almost HR" outcome-aware |
| POWER_DOUBLE/TRIPLE | (double∨triple) ∧ EV≥94 ∧ dist≥350 | watch | — |
| XBA_MISMATCH_DANGER | out ∧ xBA≥0.65 ∧ EV≥95 | watch | unlucky-out detection |

### 7.3 Near-HR peak detection (`nearHrContact.ts`)
| Signal | Condition | Tier | Risk |
| --- | --- | --- | --- |
| Repeated danger | hardCount≥2 ∧ eliteCount≥1 | lean | sources `lastEliteIdx` |
| EV acceleration | (evLast2Avg − evPrior2Avg)≥3.0 ∧ both last-2 EV≥92 | watch | precursor; weak signal |

### 7.4 FAST_PROMOTE paths (`evaluateHRAlert.ts`)
| Path | Condition (abridged) | Result |
| --- | --- | --- |
| `FAST_PROMOTE_SINGLE_ELITE` | eliteHrCount≥1 ∧ softVetoes≤1 ∧ conv≥0.15 | officialAlert (→ fire) |
| `FAST_PROMOTE_BARREL_XBA` | barrels≥1 ∧ maxXBA≥0.40 ∧ conv≥0.15 | officialAlert |
| `FAST_PROMOTE_BARREL_BATSPEED` | barrels≥1 ∧ batSpeed≥70 ∧ conv≥0.03 | prepare (build) |
| `FAST_PROMOTE_EV_XBA` | maxEV≥95 ∧ maxXBA≥0.40 ∧ conv≥0.15 | officialAlert |
| `FAST_PROMOTE_ELITE_BARREL_COLLAPSE` | barrel ∧ eliteBarrel ∧ pitcherCollapsing ∧ softVetoes=0 ∧ conv≥0.15 | officialAlert |
| `FAST_PROMOTE_BARREL_PLUS` | barrels≥1 ∧ dangerousSecondary≥1 ∧ conv≥0.15 | officialAlert |
| `FAST_PROMOTE_BARREL_ELITE_POWER` | archetype=elite_power ∧ barrels≥1 ∧ conv≥0.03 | prepare |
| `FAST_PROMOTE_BARREL_CTX` | barrels≥1 ∧ (pitcher∨env favorable) ∧ conv≥0.03 | prepare |
| `FAST_PROMOTE_2HH` | hardHits≥2 ∧ conv≥0.03 | prepare (two hard-hit balls) |
| `FAST_PROMOTE_CONVICTION_BRIDGE` | conv≥0.15 ∧ buildScore≥8.5 ∧ hrShaped≥1 ∧ softVetoes=0 | officialAlert |

### 7.5 PATH logic (`evaluateHRAlert.ts`)
| Path | Condition (abridged) | Result |
| --- | --- | --- |
| `PATH_A` | hrShaped≥2 ∧ EVmean≥95 ∧ maxDist≥350 ∧ remPA≥1.3 ∧ softVetoes=0 | officialAlert if conv≥0.15 else prepare |
| `PATH_B` | (missed∨elite)>0 ∧ moderate context ∧ remPA≥1.0 | officialAlert if strong+softVetoes=0+build≥4.0+conv≥0.15 else prepare |
| `PATH_C` | inning≥5 ∧ hrShaped≥1 ∧ pitcherFavorable ∧ remPA≥1.0 ∧ build≥4.0 | late-game power build |
| `PATH_F_BLOCKED_BRIDGE` | (referenced in user-stage path tables) | blocked-bridge marker — does not promote to fire |

### 7.6 Vetoes (`evaluateHRAlert.ts`)
- **Hard** (block): remPA<0.5 w/ no elite/missed; LA profile inconsistent (avg>42° or <15°).
- **Soft** (reduce confidence via `suppressionCount`): same-side matchup; headwind ≥10mph outdoor;
  cold ≤45°F; single early-AB HR-shape with no repeat.

**Ready→Fire promotion** (`hrRadarUserStage.maybePromoteReadyToFire`): requires
BET_NOW + attack + sustained contact driver (e.g. `consecutivePromoteTicks≥3`) **or**
`FAST_PROMOTE_ELITE` at live/actionable (bypasses stale-peak gate). Verified by
`hrRadarReadyToFire.test.ts` (32 invariants pass).

---

## 8. Stage / State Mapping Table

**There are five coexisting stage/state vocabularies.** They do not currently conflict but the
translation surface is large (see Finding P2-1).

| Source field | Possible values | File / function | Maps to | Used by UI? | Used by grading? |
| --- | --- | --- | --- | --- | --- |
| `lifecycleState` | inactive, watch, build, ready, fire, cashed, missed, model_review, expired | `hrRadarStateMachine.ts:19` / `applyHrRadarLifecycleEvent` (≈240) | section + userStage (`userStageFor`, `sectionFor`) | Yes (sections) | Terminal states final |
| `userStage` | track, build, ready, fire, resolved | `shared/hrRadarStage.ts:14` / `mapToUserStage` (`hrRadarUserStage.ts:137`) | section, label | **Yes — ladder source of truth** | **Yes — FIRE-only** |
| `section` | attack, ready, build, watch, cashed, missed, diagnostic, inactive | `hrRadarSection.ts` / `deriveHrRadarSection` (≈580) | UI buckets | Yes | No (diagnostic only) |
| `canonicalStage` (engine) | attack, building, watch, cooling, closed | hrAlertEngine / `deriveHrRadarLifecycleState` (≈508) | lifecycleState | Legacy | No |
| dynamic state | BET_NOW, PREPARE, WATCH | hrAlertEngine | userStage branch (`mapToUserStage`) | No | No |
| `signalState` (legacy) | watching, live, actionable, fire | `hrRadarSection.ts` (≈133) | lifecycleState fallback | Legacy | Partial (max-window) |
| `confidenceTier` (legacy) | monitor, building, strong, elite | `hrRadarSection.ts` (≈554) | lifecycleState fallback | Legacy | No |
| `signalTier` | watch, lean, strong, elite | `shared/mlbSignal.ts` / `deriveSignalTier` | display tier | Yes | No |
| `alertPath` | FAST_PROMOTE_*, PATH_A…E, WATCH, PATH_F_BLOCKED_BRIDGE | `hrRadarUserStage.ts` PATH tables (≈66) | userStage promote | No | Yes (`reachedFireCommitment` for FAST_PROMOTE_ELITE) |
| `outcomeStatus`/`gradingStatus` | called_hit(_attack/_ready/_build/_watch), called_miss, uncalled_hr, late_signal, early_hr_insufficient_sample, expired, unresolved | `hrRadarSection.ts` / DB column | section + W/L | Yes (resolved) | **Yes — W/L truth** |
| `reviewBucket` | called_hit, late_signal, attribution_miss, same_pa_hr_no_prior_live_signal, early_window_hr, live_promotion_miss, context_miss, true_uncalled_hr, insufficient_review_data | `hrReviewClassifier.ts:29` / `classifyHrReview` (≈402) | admin/analytics | No | No (diagnostic) |

**Answers to the stage-audit questions:**
- **Duplicate / conflicting?** No active conflict. The legacy trio (`canonicalStage`,
  `signalState`, `confidenceTier`) coexist as *fallback inputs* to `mapToUserStage`, not as parallel
  truths. Risk is complexity, not contradiction.
- **Source of truth for the user ladder:** `userStage` (`shared/hrRadarStage.ts:14`, computed by
  `mapToUserStage`). Single definition, re-exported by the state machine.
- **Source of truth for official grading:** `userStage === "fire"` → `officialSignalStage="fire"`
  (`hrRadarUserStage.ts` ≈951–958), gated at settlement by `reachedFireCommitment`.
- **Track/Build excluded from official misses?** Yes — `applyGameFinalOverride`
  (`hrRadarSection.ts` ≈689–712) drops non-actionable rows to `inactive` (no miss). Only FIRE/READY
  go to `missed` at final; of those only FIRE is fire-committed, so READY-only no-HR demotes to
  `expired` (verified `hrRadarFireOnlyGrading.test.ts`).
- **Ready/Fire the only official stages?** **FIRE only.** READY is high-watch context but
  `officialSignalStage=null` for READY (verified test G.2).
- **Display scores confused with probabilities?** No — guarded (see §9 + Finding P3-3).

---

## 9. Probability / Score Contract Audit

| Value | Type | Range | Displayed as | Guard |
| --- | --- | --- | --- | --- |
| `engineProbability` | **true probability** | 0–1 | % | validated by `validateMlbEngineProbability` (phase3b test) |
| `conversionProbability` raw | **true probability** (per-PA) | 0–0.12 cap | internal | Phase 1.5 cap binds above all multipliers |
| `conversionProbability` calibrated | **true probability** | 0–0.46 cap | % (HR-chance bar) | only bar allowed `unit:"pct"`; rendered only when ≤60% |
| `hrReadinessScore` | **display score** | 0–100 | /10 (never %) | `deriveCalibratedHrChancePct` rejects >60 → no % |
| `signalScore` | **raw 0–100** | 0–100 | /10 | `toScore10` divides down; never % |
| `buildScore` | **0–10 score** | 0–10 | /10 | — |
| `displayScore10`/`peakScore10` | **0–10 score** | 0–10 | /10 | conviction cap (`shared/hrRadarConviction.ts`) |

**Findings:**
- True probabilities: `engineProbability`, raw + calibrated `conversionProbability`.
- Display scores (NOT probabilities): `hrReadinessScore` (0–100), `signalScore` (0–100), `buildScore`
  (0–10), `displayScore10`/`peakScore10` (0–10).
- **0–10 vs 0–100 are consistently normalized to /10 at display** via `hrRadarScore.ts` +
  `hrRadarDisplayState.toScore10`, which null-guard *before* `Number()` to avoid `Number(null)===0`.
- **No non-probability value is shown as a percentage.** The only percent on the card is the
  calibrated HR chance, gated by `CALIBRATED_HR_PROB_CEILING_PCT=60` (`hrRadarDisplayState.ts` ≈135).
- **Display-only fallbacks** (e.g. readiness/10 when `displayCurrentScore10` absent) exist in the UI
  mapper but are **never** read back into grading — grading reads `peakConversionProbability` from
  `diagnosticsSnapshot.scoreContract`, not display fields.

---

## 10. Persistence / Grading Audit

**Tables (`shared/schema.ts`):** `hr_radar_alerts` (≈609–687), `hr_radar_signal_events` (≈689–718),
`hr_radar_outcome_stamps` (≈766–781), plus `persisted_plays`, `game_player_stats`.

**HR detection:** play-feed `hitType === "home_run"` (`liveGameOrchestrator.ts:437,755`), attributed
razor-sharp by `about.inning` / `halfInning` / `atBatIndex`.

**Grading decision (`storage.resolveHrRadarAlertAsHit` ≈4259–4440 + `matchHrRadarAlertToHrEvent`
≈3338):**
- `matchedBeforeHr` + `reachedHrMaxWindow` + `reachedFireCommitment` → `called_hit_*`
  (`inferCashedFromTierStatus`: officialAlert→attack, prepare→ready/build, watch→watch). `userVisible=true`.
- `matchedBeforeHr` but **not** fire-committed → `uncalled_hr` (`userVisible=false`, **not counted**).
- matched at/after HR → `late_signal` (`userVisible=false`, not counted).
- alert existed, never crossed PATH A–E, no HR → `called_miss` (counted unless `[presence-only]`).
- no alert → `uncalled_hr` / `early_hr_insufficient_sample`.

**FIRE-only enforcement:** `reachedFireCommitment` (`hrRadarSection.ts` ≈246) — true iff
`alertPath==="fast_promote_elite"` OR `peakConversionProbability ≥ 0.14` (`FIRE_BET_NOW_CONV_THRESHOLD`).
Enforced at three sites: in-memory stamping (`liveGameOrchestrator` ≈575–594), DB grading
(`storage` ≈4314–4331), and the live freshness overlay (`hrRadarFreshnessOverlay` ≈175–182).

**hrr vs home_runs:** canonical token is `hrr`; cash attempts **both**
`mlb:{g}:{p}:hrr:OVER` and legacy `mlb:{g}:{p}:home_runs:OVER` (`hrPreHrBusEvidence.ts` ≈607–615).
Comment documents "Bug #1": previously hardcoded `home_runs` → `getCanonical` returned null →
cash silently dropped. Now defended (see Finding P2-3).

**Same-tick race:** if qualified at HR detection but the qualifying-event write hasn't committed,
the orchestrator inserts a **synthetic** `stage_attack`/`stage_building` event anchored
`endTimeMs − 1000` so it strictly precedes the HR (`liveGameOrchestrator` ≈645–666,
`[HR_RADAR_PRE_CLOSE_QUALIFY]`). Works, but timing-hack fragility (Finding P2-4).

**Rows / counting:**
- User-visible: `called_hit_*`, `called_miss` (non-presence-only).
- Count toward hit rate: `called_hit_*` (wins) / `called_miss` (losses). **Excluded:** `late_signal`,
  `uncalled_hr`, `early_hr_insufficient_sample`, `expired`, `unresolved`.
- **Shadow track fully separate** (`shadowQualification.ts` hard contract ≈6–15): in-memory store
  only, never `settlePlay`/`persisted_plays`/ROI/W-L; admin endpoint only.

**Double-count / disappearing-hit defenses:** first-write-wins outcome stamps
(`hrRadarOutcomeStamp.ts` ≈66), DB update guarded by `status="live"` (`storage` ≈4354), idempotent
matcher, `RESOLVED_HR_PLAYERS` re-entry block, `[HR_RADAR_LATE_SIGNAL_LEAK]` contradiction logging.
All verified by `shadowOutcomeWiring.test.ts` (idempotency) + `hrRadarFireOnlyGrading.test.ts`.

---

## 11. API / UI Contract Audit

### 11.1 Endpoints (`server/routes.ts`)
| Route | Auth | Source | Shape (key) | Filters / sort | Freshness |
| --- | --- | --- | --- | --- | --- |
| `GET /api/mlb/hr-radar` (≈3192) | `requireAuth` | `mlbEdgeCache` (engine) | `edges[]` w/ `hrAlert{currentState, hrReadinessScore, hrConversionProbability(Raw/Calibrated), peakScore…}`, watchlist, cashed | active games only; `feedTags includes hr_radar`; sort `signalScore` desc | 10m edge freshness |
| `GET /api/mlb/hr-radar/ladder` (≈3876) | `requireAuth` | `storage.getHrRadarLadder` + freshness overlay | `sections{attackNow, ready, building, watch, cashed, dead}`, counts, diagnostics, hrWatch, freshness | drops `isGameFinal`; live-no-AB → noAbYet; sort `displayReadinessScore10` desc | overlay ~10s; terminal DB-authoritative |
| `GET /api/mlb/hr-radar-board` (≈4153) | `requireAuth` | `storage.getTodayHrRadarBoard` | `board/live/hits/misses`, freshness | — | overlay |
| `GET /api/mlb/hr-radar/ladder/validate` (≈4105) | `requireAuth` | ladder | invariant violations | read-only | — |
| `GET /api/mlb/hr-radar/share-card` (≈4127) | `requireAuth` | query params | PNG | — | — |
| `GET /api/mlb/hr-radar-analyze/:playerId/:gameId` (≈4268) | `requireAuth` | edge + persisted fallback | `analyze{priorABs[], hrFactors, buildScore…}` | legacy-consumer-marked | partial flag |
| `GET /api/mlb/hr-radar-grading-history` (≈3815) | `requireAuth` | DB | multi-day summary | days≤30 | — |
| `GET /api/mlb/hr-radar-grading/:sessionDate` (≈3842) | `requireAuth` | `getCanonicalHrRadarOutcomes` | gradedHits/Misses + summary | — | — |
| `GET /api/admin/hr-radar/uncalled` (≈3830) | `requireAdmin` | DB | uncalled_hr + early sample | limit/days caps | — |
| `GET /api/mlb/admin/hr-radar/coverage` (≈3865) | `requireAdmin` | DB | detection metrics | daysBack≤60 | — |
| `GET /api/admin/mlb-hr-radar-freshness` (448), `…-shadow` (583) | `requireAdmin` | overlay / shadow metrics | reports | — | — |
| `GET /api/mlb/pregame-power-radar(/:gameId)` (534/558) | `requireMLBAccess` | pregame snapshot | pregame board | — | snapshot TTL |

### 11.2 UI
- **Renders Track/Build/Ready/Fire:** `HrRadarLadder.tsx` (sections FIRE/READY/ALMOST/TRACK/CASHED/
  MISSED/NO-AB-YET/MODEL-REVIEW) and `HrQuickDecide.tsx` (LIVE CALLS/READY NOW/RESULTS). Both consume
  the shared mapper `hrRadarDisplayState.mapHrRadarRowToDisplayState`.
- **Client recompute?** **No.** `hrRadarDisplayState.ts` header contract: "NEVER recomputes engine
  probability, readiness, confidence, or tier — only READS server-stamped fields and formats." Score
  helpers (`hrRadarScore.ts`) are null-guarded read-only extractors. `canonicalSignalViewModel.ts`
  reads `canonicalLifecycleState`/`signalTier` verbatim.
- **Filters that can hide signals:** dismissed-per-session; final-game rows removed from live
  sections; live-but-no-AB re-shelved to "NO AB YET"; admin-only outcomes routed to "MODEL REVIEW".
  These are presentation buckets, not silent drops — but the noAbYet/modelReview re-shelving is worth
  product confirmation (Finding P3-4).
- **Official vs watch-only:** server-stamped `officialSignalStage`/`userStage`; UI never infers.
- **Odds:** **no odds-based suppression** anywhere (route or UI). HR Radar surfaces regardless of odds
  availability; odds render when present, omit when null (Finding P3-1 — confirm intentional).

---

## 12. Missing Stats / Improvement Opportunities

> Strictly partitioned. **Do not blend the two engines.**

### A. Belongs to future **Pre-Game Power Monte Carlo** (prior only)
- Batter HR/PA, barrel rate, hard-hit rate, xSLG, xISO, pull-air rate (season aggregates — already
  fetched for the existing pregame board; Monte Carlo would consume them).
- Pitch-type damage (batter xSLG/whiff by pitch family) × **pitcher HR allowed by pitch type**.
- Park geometry / handedness-spray fit; lineup slot → projected PA; bullpen path.
- Market movement / line history; weather *forecast* (vs live observation).
- **Calibrated per-PA HR probability via simulation** with confidence band (the actual Monte Carlo).

### B. Belongs to **HR Radar Live** (event model)
- Live EV trend / live launch-angle trend across the game (partially present via near-HR peak +
  EV-acceleration; could be richer).
- Pitcher **command deterioration** (zone/heart-of-plate mistakes) — only pitch count / velo drop
  exist today, not command/location.
- Current count leverage (e.g. 3-1, 2-0 hitter's counts) and base/out leverage — IBB context exists
  but count leverage is thin.
- Live wind/spray fit refresh during the game; in-game carry behavior (observed HR distances vs park).
- Pitch-around / intentional-avoidance risk in real time.

### C. Shared context only (neither engine owns; both may read)
- Park factors table (`dataSources.ts`), player identity / handedness, weather utilities, Statcast/
  Savant fetchers, `parkWindFit.ts`. These are infrastructure, safe to share read-only.

### D. Wired-but-empty / weak inputs (current gaps)
- `mlbPlayerCache.pitcherOrderSplits` — **read by pregame, never populated** (Finding P2-2).
- `bvp` — fetched but explicitly low-confidence; never core.
- Calibration empirical buckets override a **static** table fallback; depends on sample volume.

---

## 13. Confirmed Defects / Risks (ranked)

### Finding P2-1 — Five coexisting stage/state vocabularies
**Status:** Confirmed
**File/function:** `hrRadarStateMachine.ts`, `hrRadarUserStage.ts -> mapToUserStage()`,
`hrRadarSection.ts -> deriveHrRadarLifecycleState()`, plus legacy `canonicalStage`/`signalState`/`confidenceTier`.
**Current behavior:** lifecycle (9), userStage (5), section (8), engine dynamic state (3), legacy
tiers (4+4), review buckets (9) are bridged by ~10 mapping functions. No active contradiction.
**Why it matters:** High translation surface; a single careless edit to any mapper can desync the
ladder from grading. This is the dominant maintainability risk.
**Evidence:** §8 table; `mapToUserStage` consumes all of {dynamicState, alertPath, tier, state,
canonical, outcome}; legacy fields used as fallbacks (`hrRadarSection.ts` ≈554–556).
**Recommended direction:** Document the canonical reduction (engine → userStage) as the *only*
sanctioned path; treat legacy fields as deprecated read-only inputs and add an invariant test that
asserts userStage↔section↔lifecycle consistency for every row.
**Behavioral risk:** Low (documentation/test only).

### Finding P2-2 — `pitcherOrderSplits` read but never produced
**Status:** Confirmed
**File/function:** `pregamePowerRadar/pitcherOrderSplit.ts` reads `mlbPlayerCache.pitcherOrderSplits`; no writer in `dataPullService.ts`.
**Current behavior:** pregame "pitcher HR allowed by lineup slot" is always "unavailable"; the
component silently no-ops.
**Why it matters:** A real predictive input (pitcher vulnerability by batting-order slot) is dead.
Looks wired but contributes nothing.
**Evidence:** orchestrator/pregame trace — "currently empty (no producer wired yet)".
**Recommended direction:** Wire a real pitcher-allowed-by-slot feed (future Pre-Game Power work),
keep additive/no-op when absent.
**Behavioral risk:** Low (additive new data).

### Finding P2-3 — HR market-key fragility (`hrr` vs `home_runs`)
**Status:** Confirmed (defended)
**File/function:** `hrPreHrBusEvidence.ts` ≈607–615; cash attempts both keys.
**Current behavior:** dual-attempt cash on canonical `hrr` and legacy `home_runs`. Previously a
hardcoded `home_runs` caused silent cash drops ("Bug #1").
**Why it matters:** The belt-and-suspenders works, but any new cash/lookup site that forgets the
dual key reintroduces silent drops. Brittle by construction.
**Evidence:** in-code comment documenting the prior silent-drop bug; both `cashSignal` calls present.
**Recommended direction:** Centralize HR signalId construction in one helper used everywhere so the
canonical/legacy duality lives in exactly one place.
**Behavioral risk:** Low (refactor toward a single helper; no threshold change).

### Finding P2-4 — Same-tick grading race patched with a timing hack
**Status:** Confirmed
**File/function:** `liveGameOrchestrator.ts` ≈645–666 (`[HR_RADAR_PRE_CLOSE_QUALIFY]`).
**Current behavior:** inserts a synthetic qualifying event at `endTimeMs − 1000` so the matcher sees
a pre-HR signal when the engine's own write hasn't committed yet.
**Why it matters:** Correctness depends on a 1-second magic offset and on `endTimeMs` being present
and accurate. If `endTimeMs` is null/zero the guard is skipped and the cash can mis-grade to
`uncalled_hr`/`late_signal`.
**Evidence:** the `if (wasQualified && endTimeMs && endTimeMs > 0)` guard.
**Recommended direction:** Prefer an explicit "was-qualified-at-detection" flag carried through
grading over a timestamp race; keep the synthetic event as fallback only.
**Behavioral risk:** Medium if changed (touches grading) — leave as-is for Phase 0/1; revisit in Phase 4.

### Finding P3-1 — No odds-based suppression
**Status:** Confirmed (likely intentional)
**File/function:** `/api/mlb/hr-radar` (≈3287 odds populate), ladder route, UI — no odds gate.
**Current behavior:** HR Radar surfaces regardless of odds availability; odds render when present.
**Why it matters:** If product expects HR Radar to require a tradable line, missing-odds rows could
look "actionable" without a price. Conversely, gating on odds would suppress valid live reads.
**Evidence:** odds = `rawOutput?.overOdds ?? raw?.overOdds ?? null`, signal still surfaces.
**Recommended direction:** Confirm intent with product (Open Question Q1). No code change pending.
**Behavioral risk:** Low (config/product decision).

### Finding P3-2 — Static calibration fallback dependency
**Status:** Confirmed
**File/function:** `hrConversionModel.ts` calibration table (≈192–213) overridden by empirical
Phase-4 buckets when present.
**Current behavior:** when empirical buckets are sparse, the hardcoded table (recently re-baselined,
top bins lifted to 0.36/0.46) drives the calibrated probability that feeds the FIRE gate (0.14).
**Why it matters:** Grading threshold sensitivity rides on a fallback table; low-sample windows could
under/over-promote.
**Evidence:** calibration table + "empirical buckets override when present".
**Recommended direction:** Phase 5 backtest of calibrated-prob vs realized HR rate by bucket;
re-baseline if drift. No change now.
**Behavioral risk:** Medium if retuned (intentional engine change per §7a discipline).

### Finding P3-3 — Display readiness (0–100) leak guard is a numeric ceiling, not a type
**Status:** Confirmed (currently safe)
**File/function:** `hrRadarDisplayState.ts -> deriveCalibratedHrChancePct()` (≈135).
**Current behavior:** any candidate percent >60 is rejected → no % rendered, preventing 0–100
readiness from masquerading as probability.
**Why it matters:** The guard is a magic 60 ceiling. A future legitimately-high calibrated prob (cap
is 0.46→46%, so safe today) or a changed cap could collide with the heuristic.
**Evidence:** `CALIBRATED_HR_PROB_CEILING_PCT = 60`.
**Recommended direction:** Tag the field's *unit* at the source (server) rather than inferring from
magnitude on the client. Phase 1 candidate.
**Behavioral risk:** Low (display-only).

### Finding P3-4 — UI re-shelving (noAbYet / modelReview) can hide live rows from default view
**Status:** Confirmed
**File/function:** `HrRadarLadder.tsx` partition logic (≈1676–1741).
**Current behavior:** live-but-no-AB rows and admin-only outcomes are moved out of the primary
sections client-side.
**Why it matters:** Valid early-formation rows land in a secondary bucket; if a user doesn't expand
it, they may perceive missing signals.
**Evidence:** `partitionLive()`, `ADMIN_ONLY_DEAD_STATUSES`.
**Recommended direction:** Confirm UX intent (Open Question Q3). No engine change.
**Behavioral risk:** Low (presentation).

### Finding P3-5 — Legacy `confidenceScore` / `hrBuildScore` still threaded into readiness
**Status:** Confirmed (intended)
**File/function:** `hrAlertEngine.ts` readiness formula (≈449–451).
**Current behavior:** `confidenceScore` (from `evaluateHRAlert`) and `buildScore` feed the readiness
display score, not probability.
**Why it matters:** Old scoring concepts persist; confusing for new readers but not incorrect.
**Evidence:** readiness = confidencePts(`confidenceScore`) + conversionPts(calibrated prob).
**Recommended direction:** Document in `SIGNAL_ENGINE_REFERENCE.md`. No change.
**Behavioral risk:** Low.

### Non-finding (verified clean)
- **Pregame/live contamination:** None. `pregamePowerRadar/liveBridge.ts` + `liveBridgeCore.ts`
  only **read** canonical HR state (`getCanonicalHrRadarState`) and build an additive target map
  (`buildPregamePowerTargetMap`); independent grep confirmed **no** fire/ready/force logic. Pregame
  never calls `registerSignal`, `settlePlay`, or mutates lifecycle. **Boundary is clean.**
- **Cross-sport imports:** none (phase3b test enforces, passes).
- **Post-bus immutability / display-contract tampering:** guarded; no mismatch logs expected.

---

## 14. Recommended Improvement Phases

**Phase 0 — Preserve current HR Radar Goldmaster (no behavior change)**
- Lock current behavior; document §6–§11 as the baseline.
- Keep `MLB_GOLDMASTER_VERSION` as-is; add the consistency invariant test from P2-1.

**Phase 1 — Fix confirmed display/contract clarity (no scoring change)**
- P3-3: stamp score *unit* server-side instead of the 60-ceiling heuristic.
- P3-5 / §8: document the canonical stage reduction + legacy-fallback deprecation.
- P2-3: centralize HR signalId construction (one helper) — non-behavioral.

**Phase 2 — Separate Pre-Game Power from HR Radar Live (Power Prior contract only)**
- Define a `PowerPrior` contract (per-PA prior + confidence band) emitted by the pregame module.
- Explicitly forbid the prior from creating Ready/Fire: it may only annotate / seed context.
- Keep the existing read-only `liveBridge` as the *only* pregame↔live touchpoint.

**Phase 3 — Add Pre-Game Power Monte Carlo (inside `pregamePowerRadar/`)**
- New module (e.g. `pregameMonteCarloPower.ts`): feature model → per-PA HR prob → simulation →
  calibrated board output, stamped on `signal.diagnostics` only.
- Inputs from already-fetched shared caches; degrade-and-cap on missing data; **no** live mutation.
- Wire the dead `pitcherOrderSplits` input (P2-2) here.

**Phase 4 — Upgrade HR Radar Live event model**
- Add command deterioration, count/leverage, live spray/wind/park-fit refresh, richer live EV/LA
  trend; revisit the same-tick timing hack (P2-4) with an explicit qualified-at-detection flag.
- All changes in-engine, additive/no-op when absent, re-baseline Goldmaster per §7a.

**Phase 5 — Backtest & analytics calibration**
- Driver hit rate, stage hit rate, FP/FN analysis; calibrated-prob vs realized HR (P3-2).
- Pregame-candidate → live Ready/Fire conversion rate (already tracked read-only by
  `shadowOutcomes.liveBridge`).

---

## 15. Test Commands Run & Results

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | Exit 0 in pipe; **only environment errors**: `Cannot find type definition file for 'node'` / `'vite/client'` (because `node_modules/@types/` is empty in this container) + deprecated `baseUrl` warning. **Not code defects** — the real app shell with installed `@types/node` typechecks clean. |
| `npm run typecheck` | `Missing script: "typecheck"` — script does not exist; CLAUDE.md prescribes `npx tsc --noEmit` (env-related, not code). |
| `npx tsx server/mlb/hrRadarReadyToFire.test.ts` | **32 pass, 0 fail** (Ready→Fire promotion + FIRE-only `officialSignalStage`) |
| `npx tsx server/mlb/shadowOutcomeWiring.test.ts` | **26 pass, 0 fail** (idempotent shadow resolve; no `storage`/`settlePlay` import) |
| `npx tsx server/mlb/phase3bRegression.test.ts` | **21 pass, 0 fail** (signalTier server-owned; signalScore≠probability; NBA/NCAAB isolation) |
| `npx tsx server/mlb/hrRadarFireOnlyGrading.test.ts` | **15 pass, 0 fail** (FIRE-only grading, both ledger sides) |
| `npx tsx server/mlb/hrRadarStateMachine.test.ts` | **60 pass, 0 fail** (transition graph + terminal locking) |

**Other HR/MLB test files present** (not all run; available for the real shell): `hrRadarLifecycleRepair`,
`hrRadarFreshnessOverlay`, `hrRadarHonestGrading`, `hrRadarNearHrCredit`, `hrRadarPromotionUnify`,
`hrRadarSingleRenderer`, `hrRadarBadges`, `hrRadarDisplayContract`, `hrReviewClassifier`, `nearHrContact`,
`nearHrContactBenRice`, `hrCalibration`, `hrEvGate`, `hrHardHitInteraction`, `statcastBarrel`,
`pullAndPregame`, `ibbAndRecentForm`, `parkWindFit(WeatherSync)`, `analytics/hrRadarOfficialSplit`,
`analytics/hrRadarShadowMetrics`, `validation/hrRadar/matchDecision`,
`pregamePowerRadar/{scoring,liveBridge,marketTagger,batterOrderSplit,pitcherOrderSplit,parkWeatherCarry,directionalityRegression,pregameParkWindDisplay}`.

---

## 16. Open Questions for Product Owner

1. **Odds gating (P3-1):** Should HR Radar require a tradable line, or surface live reads regardless
   of odds availability? Current behavior = no odds suppression.
2. **READY semantics:** Confirmed READY is *not* official (FIRE-only grading). Is READY meant to be a
   user CTA ("get ready") or purely informational context? Affects how aggressively Ready→Fire should
   promote.
3. **UI re-shelving (P3-4):** Are "NO AB YET" and "MODEL REVIEW" buckets the intended home for
   early-formation and admin-only rows, or should some surface in the primary ladder?
4. **`uncalled_hr` visibility:** Currently hidden from users (diagnostic only). Should a "we saw it
   building but didn't commit" state ever be user-visible for transparency?
5. **Calibration cadence (P3-2):** What sample threshold should switch from the static calibration
   table to empirical buckets, and how often should we re-baseline?
6. **Pre-Game Power Prior scope:** Confirm the prior may ONLY annotate/seed context and must never,
   by itself, produce Ready/Fire — matching the current clean boundary.

---

## 17. Appendix — Exact Grep Results & Key Excerpts

### A. First commands
```
$ pwd
/home/user/LiveLocks
$ git status --short          # (empty — clean)
$ git rev-parse --abbrev-ref HEAD
claude/keen-dirac-ph5uws
$ git rev-parse HEAD
dddc1ec0c9d6eeb999bad6a26f20a25aa120a17a
```

### B. Goldmaster version (`server/mlb/goldmasterGuard.ts`)
```
21: export const MLB_GOLDMASTER_VERSION = "mlb-goldmaster-v16-2026-06-25-player-park-wind-fit";
```

### C. HR Radar endpoints (`server/routes.ts`, grep `hr-radar`)
```
3192: app.get("/api/mlb/hr-radar", requireAuth, ...
3815: app.get("/api/mlb/hr-radar-grading-history", requireAuth, ...
3830: app.get("/api/admin/hr-radar/uncalled", requireAdmin, ...
3842: app.get("/api/mlb/hr-radar-grading/:sessionDate", requireAuth, ...
3865: app.get("/api/mlb/admin/hr-radar/coverage", requireAdmin, ...
3876: app.get("/api/mlb/hr-radar/ladder", requireAuth, ...
4105: app.get("/api/mlb/hr-radar/ladder/validate", requireAuth, ...
4127: app.get("/api/mlb/hr-radar/share-card", requireAuth, ...
448 : app.get("/api/admin/mlb-hr-radar-freshness", requireAdmin, ...
583 : app.get("/api/admin/mlb-hr-radar-shadow", requireAdmin, ...
534 : app.get("/api/mlb/pregame-power-radar", requireMLBAccess, ...
558 : app.get("/api/mlb/pregame-power-radar/:gameId", requireMLBAccess, ...
```

### D. Pregame live bridge — NO fire/ready forcing (grep confirmed)
```
server/mlb/pregamePowerRadar/liveBridge.ts:24:
  export function getPregamePowerTargetMap(): Map<string, PregamePowerTargetRef>
server/mlb/pregamePowerRadar/liveBridgeCore.ts:15:
  export function bridgeKey(gameId, batterId): string
server/mlb/pregamePowerRadar/liveBridgeCore.ts:24:
  export function buildPregamePowerTargetMap(signals)
# grep for fire|ready|forceStage|powerPrior in liveBridgeCore.ts → (no matches)
# shadowOutcomes.liveBridge(signal) only READS getCanonicalHrRadarState → {becameLiveReady, becameLiveFire}
```

### E. Orchestrator key functions (`server/mlb/liveGameOrchestrator.ts`)
```
49 : import { upsertCanonicalHrRadarState, getCanonicalHrRadarState } from "./hrRadarCanonicalStore";
85 : import { evaluateHRAlert, markAlertSent, ... } from "./evaluateHRAlert";
500: function gradeSingleHRPlay(...)
881: function gradeHomeRunsFromPlays(gameId)
1126: export function normalizeMlbStatus(raw) -> "live"|"pregame"|"final"|"unknown"
3565: const alertResult = evaluateHRAlert(alertInput);
4443: upsertCanonicalHrRadarState({ ... })
```

### F. State machine type + FIRE-only (excerpts)
```
hrRadarStateMachine.ts:19  type HrRadarLifecycleState =
  "inactive"|"watch"|"build"|"ready"|"fire"|"cashed"|"missed"|"model_review"|"expired";
shared/hrRadarStage.ts:14  type CanonicalHrRadarStage = "track"|"build"|"ready"|"fire"|"resolved";
hrRadarUserStage.ts (~955) const officialSignalStage: "fire"|null = userStage === "fire" ? "fire" : null;
hrRadarSection.ts (~246)   reachedFireCommitment: alertPath==="fast_promote_elite"
                            || peakConversionProbability >= 0.14 (FIRE_BET_NOW_CONV_THRESHOLD)
```

### G. Test run summary (raw tails)
```
hrRadarReadyToFire:   === Result: 32 pass, 0 fail ===
shadowOutcomeWiring:  [shadowOutcomeWiring.test] passed=26 failed=0
phase3bRegression:    ✅ 21 passed, 0 failed
hrRadarFireOnlyGrading: === Result: 15 pass, 0 fail ===
hrRadarStateMachine:  [HR_RADAR_STATE_TEST] passed=60 failed=0  / OK
```

### H. Typecheck (environment caveat)
```
$ npx tsc --noEmit
error TS2688: Cannot find type definition file for 'node'.
error TS2688: Cannot find type definition file for 'vite/client'.
tsconfig.json(16,5): error TS5101: Option 'baseUrl' is deprecated ...
# node_modules/@types/ is EMPTY in this container → environment-related, not code.
# tsconfig types: ["node", "vite/client"]; run in the real app shell to typecheck clean.
```

---

*End of audit. Inspection only — no files modified, no migrations, no thresholds, no data mutated.*
*Line numbers are as read by the inspection pass; re-confirm exact constants in the named function
before any change. Items marked "≈" are approximate locations within the cited function.*
