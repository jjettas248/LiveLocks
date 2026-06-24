# LiveLocks — MLB Engine Behavior

*PropPulse / LiveLocks platform — MLB probability engine with distribution models and Statcast archetypes*

**Engine Location:** `server/mlb/probabilityEngine.ts`, `server/mlb/archetypes.ts`, `server/mlb/featureEngineering.ts`, `server/mlb/hitProbabilityModel.ts`, `server/mlb/paEstimator.ts`, `server/mlb/types.ts`

---

## Table of Contents

1. [Distribution Model Selection](#1-distribution-model-selection)
2. [Batter Archetype System](#2-batter-archetype-system)
3. [Pitcher Archetype System](#3-pitcher-archetype-system)
4. [Statcast-Driven Classification](#4-statcast-driven-classification)
5. [PA Distribution Model](#5-pa-distribution-model)
6. [Projection Pipeline](#6-projection-pipeline)
7. [Probability Computation](#7-probability-computation)
8. [Calibration Pipeline](#8-calibration-pipeline)
9. [Safety Ceilings](#9-safety-ceilings)
10. [Experimental Market Dampening](#10-experimental-market-dampening)
11. [Signal Scoring Tiers](#11-signal-scoring-tiers)
12. [Feature Engineering](#12-feature-engineering)
13. [Markets Reference](#13-markets-reference)

---

## 1. Distribution Model Selection

The MLB engine selects a distribution model per market type. The choice is based on the statistical properties of each outcome:

| Market | Distribution | Rationale |
|---|---|---|
| Hits | Negative Binomial | Over-dispersed count data (variance > mean); models hit clustering |
| Total Bases (TB) | Negative Binomial | Multi-base hits create over-dispersion |
| HRR (Hits+Runs+RBIs) | Negative Binomial | Composite count with over-dispersion |
| Pitcher Strikeouts | Binomial | Binary per-batter outcome (K or not) |
| Batter Strikeouts | Binomial | Binary per-PA outcome |
| Home Runs | Binomial (HR-specific) | Rare binary event per PA |
| HR Allowed (pitcher) | Binomial (HR-specific) | Rare binary event per batter faced |
| Pitcher Outs | Binomial | Binary per-batter outcome |
| All others | Normal CDF | Fallback when no discrete model applies |

### Negative Binomial Implementation

```
meanOutcome = remainingPA × rate
variance = meanOutcome × 1.35  (overdispersion factor)
k = mean² / (variance - mean)  (shape parameter, floor = 1)
p = k / (k + mean)             (success probability)
P(OVER) = Σ NegBin_PMF(x, k, p) for x = target to cap
```

Falls back to Binomial when variance ≤ mean or parameters are non-finite.

### Binomial Implementation

```
P(OVER) = 1 - Σ C(n,k) × p^k × (1-p)^(n-k) for k = 0 to target-1
```

Where n = remaining PA (rounded), p = adjusted rate, target = needed outcomes.

### Normal CDF Fallback

```
z = (projection - threshold) / σ_market
P(OVER) = Φ(z)
```

---

## 2. Batter Archetype System

**Location:** `server/mlb/archetypes.ts → classifyBatterArchetype()`

8 batter archetypes based on Statcast metrics, recent form, and sample size:

| Archetype | Key Criteria |
|---|---|
| `elite_contact` | xBA ≥ 0.300, exit velocity ≥ 90 mph, batting order ≤ 3 |
| `power_first` | xBA < 0.260 with barrel rate ≥ 0.15, OR barrel ≥ 0.12 with EV ≥ 91 |
| `stable_regular` | xBA 0.260–0.300 (default for mid-range hitters) |
| `contact_specialist` | xBA ≥ 0.290, barrel rate < 0.08 |
| `platoon_hitter` | Platoon gap ≥ 0.080 |
| `hot_streak` | Last 7-game OPS exceeds season OPS by ≥ 0.200 |
| `cold_streak` | Last 7-game OPS trails season OPS by ≥ 0.200 |
| `limited_sample` | Season PA < 50 |

### Classification Priority

1. `limited_sample` (checked first — small sample override)
2. `hot_streak` / `cold_streak` (recent form override)
3. `platoon_hitter` (platoon gap override)
4. Statcast-based: `elite_contact` → `power_first` → `contact_specialist` → `stable_regular`

### Batter Variance Multipliers

| Archetype | Variance Mult | PA Fragility |
|---|---|---|
| `elite_contact` | 0.95 | 1.00 |
| `power_first` | 1.10 | 1.05 |
| `stable_regular` | 1.00 | 1.00 |
| `contact_specialist` | 0.90 | 1.00 |
| `platoon_hitter` | 1.20 | 1.15 |
| `hot_streak` | 0.95 | 1.00 |
| `cold_streak` | 1.25 | 1.10 |
| `limited_sample` | 1.40 | 1.30 |

---

## 3. Pitcher Archetype System

**Location:** `server/mlb/archetypes.ts → classifyPitcherArchetype()`

6 pitcher archetypes based on ERA, K/9, innings pitched, and games started:

| Archetype | Key Criteria |
|---|---|
| `ace` | ERA < 3.00, K/9 > 9–10, projected IP ≥ 180 |
| `quality_starter` | ERA 3.00–3.80 |
| `mid_rotation` | ERA 3.80–4.50 |
| `back_end` | ERA ≥ 4.50 |
| `opener_bulk` | Avg innings per start < 4 |
| `volatile_arm` | Catch-all for inconsistent pitchers |

### Pitcher Constants

| Archetype | Suppression Confidence | Deterioration Onset (pitches) |
|---|---|---|
| `ace` | 1.00 | 85 |
| `quality_starter` | 0.85 | 80 |
| `mid_rotation` | 0.65 | 70 |
| `back_end` | 0.45 | 60 |
| `opener_bulk` | 0.30 | 40 |
| `volatile_arm` | 0.50 | 65 |

---

## 4. Statcast-Driven Classification

**Location:** `server/mlb/archetypes.ts → classifyBatterArchetype()`

The batter archetype classification uses three primary Statcast inputs:

| Metric | Source | Used For |
|---|---|---|
| xBA (Expected Batting Average) | Baseball Savant | Contact quality anchor — separates elite/contact from power profiles |
| Barrel Rate | Baseball Savant | Power potential indicator |
| Exit Velocity | Baseball Savant | Contact quality indicator |

### xBA Modifier

**Location:** `server/mlb/hitProbabilityModel.ts → applyXBAModifier()`

xBA adjusts the hit rate as a "true talent" anchor:

```
delta = xBA - LEAGUE_AVG_BA (0.243)
abWeight = min(1.0, playerAB / 50)
modifier = 1 + delta × abWeight × 0.35
rate = rate × clamp(modifier, 0.92, 1.08)
```

### xSLG Modifier

```
delta = xSLG - LEAGUE_AVG_SLG (0.400)
abWeight = min(1.0, playerAB / 50)
modifier = 1 + delta × abWeight × 0.25
rate = rate × clamp(modifier, 0.94, 1.06)
```

---

## 5. PA Distribution Model

**Location:** `server/mlb/paEstimator.ts`

Remaining plate appearances are estimated based on inning, batting order position, and run-scoring pace.

### Batter PA Estimation

```
basePA = (9 - inning) × 0.44
slotAdj = SLOT_ADJUSTMENT[battingOrderSlot]
rawPA = basePA + slotAdj
```

**Batting order adjustments:**

| Slot | Adjustment |
|---|---|
| 1–2 | +0.45 |
| 3–5 | +0.30 |
| 6–7 | +0.10 |
| 8–9 | −0.10 |

**Pace factor:** If current runs and league average runs are available:

```
paceFactor = clamp(currentRuns / leagueAvgRuns, 0.85, 1.15)
rawPA *= paceFactor
```

**Final PA:** clamped to [1.0, 3.5]

### Pitcher BF Estimation

```
completedInnings = max(0, inning - 1)
remainingIP = max(0.5, expectedIP - completedInnings)
```

**Pitch count adjustments:**

- > 90 pitches → IP × 0.70
- > 75 pitches → IP × 0.85

```
remainingBF = max(3, round(adjustedIP × 4.3))
```

### PA Distribution for Probability

When available, the probability engine uses a discrete PA distribution rather than a point estimate:

```
paDistribution = { 1: prob_1pa, 2: prob_2pa, 3: prob_3pa }
```

This is integrated into the Negative Binomial model:

```
P(OVER) = Σ P(PA=k) × NegBin_P(OVER | k remaining PA)
```

---

## 6. Projection Pipeline

**Location:** `server/mlb/featureEngineering.ts`

The projection pipeline applies 10 capped modifier dimensions:

| Modifier | Cap | Description |
|---|---|---|
| Live form | ±0.25 | Contact quality score from today's at-bats |
| Pitcher | ±0.20 | Pitcher ERA, pitch count, times through order |
| Pitch type | ±0.10 | Fastball/breaking ball mix vs. batter profile |
| Weather/park | ±0.15 | Park factor, temperature, wind direction |
| Lineup | ±0.15 | Batting order slot, section strength, on-base |
| Bullpen | ±0.10 | Bullpen ERA, recent usage, reliever availability |
| Park history | ±0.08 | Batter's historical performance at this park |
| Handedness matchup | ±0.08 | Platoon advantage/disadvantage |
| BvP history | ±0.10 | Batter vs. pitcher career matchup |
| Pocket weakness | ±0.08 | Lineup pocket weakness around the batter |
| **Total cap** | ±0.50 | Maximum combined modifier adjustment |

### Two-AB Rule

Live form adjustments are gated by the Two-AB Rule:

- **Standard mode:** ≥ 2 completed at-bats → live form allowed
- **Early Explosive mode:** Only 1 AB completed but meets elite contact thresholds (EV ≥ 105, LA 15–35°, Distance ≥ 400ft) AND strong context score ≥ 0.65 AND environment score ≥ 0.35

---

## 7. Probability Computation

**Location:** `server/mlb/probabilityEngine.ts → computeModelProbability()`

### Market Routing

The engine routes each market to its optimal distribution model:

1. **Hits:** → `computeHitsDistributionProbability()` (Negative Binomial with PA distribution weighting)
2. **Home Runs / HR Allowed:** → `computeHRDistributionProbability()` (Binomial for rare events)
3. **Total Bases / HRR:** → `computeTBDistributionProbability()` (Negative Binomial with PA distribution)
4. **Batter Strikeouts / Pitcher Strikeouts / Pitcher Outs:** → `computeBinomialMarketProbability()` (Binomial)
5. **All others:** → `computeNormalCDFProbability()` (Normal CDF fallback)

### Market Sigma Values (Normal CDF)

| Market | σ |
|---|---|
| Hits | 0.65 |
| Total Bases | 1.10 |
| Pitcher Strikeouts | 1.40 |
| Hits Allowed | 1.20 |
| Walks Allowed | 0.90 |
| Home Runs | 0.40 |
| HRR | 1.50 |
| Pitcher Outs | 2.50 |
| Batter Strikeouts | 0.70 |
| HR Allowed | 0.50 |

### Probability Clamping

All probabilities are clamped to [5%, 96%] to prevent extreme outputs.

---

## 8. Calibration Pipeline

**Location:** `server/mlb/probabilityEngine.ts → calibrateModelProbability()`

### Calibration Shrinkage

Shrinkage is determined by the archetype × market volatility combination:

**Market Volatility Tiers:**

| Tier | Markets |
|---|---|
| Low | Hits, Pitcher Strikeouts |
| Mid | Total Bases, Batter Strikeouts, Pitcher Outs, Hits Allowed |
| High | Home Runs, HRR, Walks Allowed, HR Allowed |

**Batter Calibration Shrinkage:**

| Archetype | Low | Mid | High |
|---|---|---|---|
| `elite_contact` | 0.94 | 0.90 | 0.82 |
| `power_first` | 0.88 | 0.90 | 0.85 |
| `stable_regular` | 0.92 | 0.88 | 0.80 |
| `contact_specialist` | 0.94 | 0.85 | 0.70 |
| `platoon_hitter` | 0.86 | 0.82 | 0.72 |
| `hot_streak` | 0.92 | 0.88 | 0.80 |
| `cold_streak` | 0.84 | 0.80 | 0.72 |
| `limited_sample` | 0.78 | 0.74 | 0.68 |

**Pitcher Calibration Shrinkage:**

| Archetype | Low | Mid | High |
|---|---|---|---|
| `ace` | 0.94 | 0.90 | 0.85 |
| `quality_starter` | 0.90 | 0.86 | 0.80 |
| `mid_rotation` | 0.86 | 0.82 | 0.76 |
| `back_end` | 0.80 | 0.76 | 0.70 |
| `opener_bulk` | 0.74 | 0.70 | 0.65 |
| `volatile_arm` | 0.78 | 0.74 | 0.68 |

Default shrinkage (no archetype): 0.96

```
calibrated = 50 + (raw - 50) × shrinkage
```

---

## 9. Safety Ceilings

**Location:** `server/mlb/archetypes.ts → getMLBSafetyCeiling()`

Per-archetype, per-market maximum probability caps. If calibrated probability exceeds the ceiling, it is capped.

### Batter Safety Ceilings (select)

| Archetype | Hits | TB | HR | HRR | K |
|---|---|---|---|---|---|
| `elite_contact` | 96 | 94 | 80 | 92 | 88 |
| `power_first` | 90 | 94 | 82 | 92 | 85 |
| `stable_regular` | 92 | 90 | 78 | 88 | 85 |
| `contact_specialist` | 96 | 88 | 65 | 85 | 90 |
| `platoon_hitter` | 90 | 88 | 75 | 85 | 85 |
| `hot_streak` | 94 | 92 | 82 | 90 | 85 |
| `cold_streak` | 85 | 82 | 72 | 80 | 88 |
| `limited_sample` | 80 | 78 | 65 | 75 | 78 |

### Pitcher Safety Ceilings (select)

| Archetype | K | Outs | Hits Allowed | BB | HR Allowed |
|---|---|---|---|---|---|
| `ace` | 96 | 90 | 92 | 88 | 82 |
| `quality_starter` | 92 | 88 | 88 | 85 | 78 |
| `mid_rotation` | 88 | 85 | 85 | 82 | 75 |
| `back_end` | 82 | 80 | 80 | 78 | 70 |
| `opener_bulk` | 75 | 72 | 75 | 72 | 65 |
| `volatile_arm` | 80 | 78 | 78 | 75 | 70 |

### Market-Level Probability Caps

| Market | Cap |
|---|---|
| Hits | 96 |
| Total Bases | 96 |
| Pitcher Strikeouts | 96 |
| Home Runs | 85 |
| HRR | 90 |
| Pitcher Outs | 90 |
| Walks Allowed | 85 |
| Hits Allowed | 90 |
| Batter Strikeouts | 85 |
| HR Allowed | 80 |

---

## 10. Experimental Market Dampening

**Location:** `server/mlb/probabilityEngine.ts → computeFullModelProbability()`

Markets designated as experimental (`home_runs`, `batter_strikeouts`, `hr_allowed`) receive an additional dampening factor:

```
calibratedOver = 50 + (calibratedOver - 50) × 0.90
calibratedUnder = 50 + (calibratedUnder - 50) × 0.90
```

This 10% edge reduction prevents overconfident signals on markets where the model has less historical validation.

---

## 11. Signal Scoring Tiers

**Location:** `server/mlb/types.ts`

The MLB engine uses two parallel tier systems for different purposes:

### Edge Confidence Tiers (MLBConfidenceTier)

Used for edge-based signal classification (probability vs. book-implied):

| Tier | Description |
|---|---|
| `ELITE` | Highest confidence edge signals |
| `STRONG` | High confidence edge signals |
| `LEAN` | Moderate confidence edge signals |
| `NO_EDGE` | No actionable edge detected |

### Signal Quality Tiers (SignalConfidenceTier)

Used for composite signal quality ranking in the UI feed:

| Tier | Criteria |
|---|---|
| `ELITE` | Top-tier signal quality (highest composite score) |
| `STRONG` | High signal quality |
| `SOLID` | Reliable signal |
| `WATCHLIST` | Monitor — potential edge developing |
| `NO_SIGNAL` | No actionable signal |

### Edge Thresholds

| Tier | Edge Threshold |
|---|---|
| ELITE | ≥ 6.0 |
| STRONG | ≥ 3.5 |
| LEAN | ≥ 1.5 |

### Market Qualification Floors

| Market | Min Probability |
|---|---|
| Hits | 60% |
| Total Bases | 60% |
| Pitcher Strikeouts | 60% |
| Home Runs | 35% |
| HRR | 58% |
| Pitcher Outs | 60% |
| Walks Allowed | 58% |
| Hits Allowed | 58% |
| Batter Strikeouts | 58% |
| HR Allowed | 35% |

---

## 12. Feature Engineering

**Location:** `server/mlb/featureEngineering.ts`

### Contact Quality Classification

| Tier | Criteria |
|---|---|
| ELITE | EV ≥ 100, sweet spot LA, distance ≥ 380ft, HHR ≥ 0.50 |
| HARD | EV ≥ 95, distance ≥ 340ft, HHR ≥ 0.40 |
| MEDIUM | EV ≥ 88, distance ≥ 300ft |
| SOFT | Below MEDIUM thresholds |

### Composite Context Score (4 Dimensions)

Used for Early Explosion mode gating and signal quality:

| Dimension | Weight | Range |
|---|---|---|
| Contact quality | 30% | [0, 1] |
| Pitcher context | 20% | [0, 1] |
| Lineup context | 20% | [0, 1] |
| Handedness matchup | 15% | [0, 1] |
| Weather/environment | 15% | [0, 1] |

### Batter vs. Pitch Type Split

Cross-references pitcher's pitch mix with batter's hard-hit rate:

- Power hitters (HHR ≥ 0.45) benefit from fastball-heavy pitchers (+0.04) and are disadvantaged by breaking-heavy pitchers (−0.03)
- Contact hitters (HHR ≤ 0.35) get slight edges from both fastball (+0.01) and breaking ball (+0.02) heavy pitchers

### Form Indicator

| Indicator | Form Score Threshold |
|---|---|
| `hot` | ≥ 0.65 |
| `warm` | ≥ 0.40 |
| `neutral` | 0.20–0.40 |
| `cold` | ≥ 0.20 |
| `extreme_cold` | < 0.08 |

---

## 13. Markets Reference

### All MLB Markets

| Market Key | Display Name | Distribution | Volatility |
|---|---|---|---|
| `hits` | Hits | Negative Binomial | Low |
| `total_bases` | Total Bases | Negative Binomial | Mid |
| `pitcher_strikeouts` | Pitcher Strikeouts | Binomial | Low |
| `home_runs` | Home Runs | Binomial (HR) | High |
| `hrr` | Hits+Runs+RBIs | Negative Binomial | High |
| `batter_strikeouts` | Batter Strikeouts | Binomial | Mid |
| `pitcher_outs` | Pitcher Outs | Binomial | Mid |
| `hits_allowed` | Hits Allowed | Normal CDF | Mid |
| `walks_allowed` | Walks Allowed | Normal CDF | High |
| `hr_allowed` | HR Allowed | Binomial (HR) | High |

### User-Facing Markets (Phase A)

Hits, Total Bases, Pitcher Strikeouts, Home Runs

### Core vs. Experimental

- **Core:** Hits, Total Bases, Pitcher Strikeouts
- **Experimental:** Home Runs, Batter Strikeouts, HR Allowed (receive 0.90× dampening)

---

## 14. HR Radar Goldmaster v1 — User-Facing Surfacing Layer

**Engine Location:** `server/mlb/hrRadarUserStage.ts` (helpers), `server/storage.ts` (`getHrRadarLadder`, `getHrRadarGradingHistory`), `server/routes.ts` (`/api/mlb/hr-radar`, `/api/mlb/hr-radar-board`).

**Status:** Active (default ON). Pure surfacing/qualification layer. **Engine math, scoring, and calibration are NOT modified.**

### 14.1 What it does

Goldmaster v1 layers a user-facing 4-stage ladder on top of the existing HR Radar canonical model so end users see a clear Track → Build → Ready → Fire progression rather than internal engine state names. It also restores a 0–10 user score, surfaces qualifying signal types, and adds additive grading sub-buckets for finer offline analysis.

### 14.2 The ladder

| User stage | Internal trigger | Color |
|---|---|---|
| **Track** | dynamicState ∈ {WATCH, ∅} AND tier ∉ {strong, building} | Gray |
| **Build** | dynamicState=PREPARE OR legacyTier=building OR canonicalStage=building | Blue |
| **Ready** | legacyTier=strong | Orange |
| **Fire** | dynamicState=BET_NOW OR legacyState=attack OR canonicalStage=attack | Red (pulse) |
| **Resolved** | outcome ∉ {pending, active, ∅} | Gray |

The chosen user stage is the **STRONGER** of (a) the legacy mapped stage from the existing engine state and (b) the suggested stage derived from qualifying signals — see `strongerStage()` in `hrRadarUserStage.ts`. Resolved is sticky: if either side says resolved, the result is resolved.

### 14.3 The 0–10 score

`toSignalScore10(value)` accepts any readiness/build score (legacy 0–100 or already 0–10) and returns a 0.0–10.0 number rounded to one decimal. Values > 10 are treated as 0–100 wire scale.

`fallbackScoreForStage(stage)` returns a **display-only** score for rows whose engine has not yet emitted a readiness number: Track 2.5, Build 5.5, Ready 7.5, Fire 9.0. **Never used for grading** — only for the score badge so Track rows do not show a meaningless 0.0.

### 14.4 Qualifying signals

Nine qualifying signal types are derived from the engine's existing diagnostic snapshot — no new measurements:

- `elite_barrel` — barrels ≥ 1
- `near_barrel` — nearBarrels ≥ 1 OR triggerTags include "near_barrel"
- `two_hard_hit_balls` — hardHits ≥ 2
- `deep_fly_warning` — deepFlyouts ≥ 1 OR (maxLA ≥ 28 AND maxEV ≥ 95)
- `high_bat_speed_lift` — avgEV ≥ 95 AND maxEV ≥ 100
- `pitcher_collapse_power` — pitcherFatigueBoost > 0 OR fatigue/bullpen tags or drivers
- `late_game_power_build` — inning ≥ 6 AND any meaningful contact event
- `massive_single_contact` — maxEV ≥ 108 OR (barrel AND maxEV ≥ 105)
- `pre_hr_danger` — conversionProbability ≥ 0.10 OR pre_hr_danger / hrShaped tags

### 14.5 Suggested-stage derivation

```
massive_single_contact OR (elite_barrel AND pitcher_collapse_power) → fire
elite_barrel | two_hard_hit_balls | near_barrel | late_game_power_build → ready
deep_fly_warning | high_bat_speed_lift | pre_hr_danger | pitcher_collapse_power → build
otherwise → track
```

### 14.6 Additive timestamps

Each enriched row carries write-once timestamps:

| Field | Set when |
|---|---|
| `firstTrackedAt`/`Inning` | row first detected |
| `firstBuiltAt`/`Inning` | userStage reached `build` |
| `firstReadyAt`/`Inning` | userStage reached `ready` |
| `firstFireAt`/`Inning` | userStage reached `fire` |
| `hrOccurredAt`/`Inning` | row resolved as a hit |

Currently derived in-memory from `detectedAt` / `signalDetectedAt` / `hitDetectedAt` so nothing in the DB has to change. The follow-up to persist these as write-once columns lives in the agent inbox.

### 14.7 Official signal stage (additive grading shadow)

`officialSignalStage` is set **ONLY when the row reaches `fire`** (FIRE-only official record, 2026-06). Track, Build, and **Ready** rows are NEVER counted as official calls/misses against the radar grade — Ready is high-watch context, not an official HR call. At game-final reconciliation a no-HR row that never reached the FIRE commitment (peak HR-conversion in the BET_NOW band `>= 0.14`, or the `FAST_PROMOTE_ELITE` path) is stamped `expired`, not `called_miss` (`reachedFireCommitment` in `hrRadarSection.ts`). Pairs with `officialSignalAt` and `officialSignalInning`.

### 14.8 Grading sub-buckets

`getHrRadarGradingHistory` adds a per-day `subBuckets` object alongside the existing headline counts:

- `missedOfficialSignals` — official signals that did not produce a HR
- `lateSignals` — signals detected after the HR
- `uncalledHrs` — HRs hit with no official signal at all
- `earlyWindowHrs` — HRs that came before the suggested window opened
- `expiredTracking` — Track/Build rows that aged out without escalating

Original `dead`/`missed`/`hit` counts are unchanged.

### 14.9 Feature flag

`HR_RADAR_GOLDMASTER_V1` is read once at module load (`hrRadarUserStage.ts:30`):

- Default: **ON** (`true`)
- OFF when env var equals `false`, `0`, `off`, or `no` (case-insensitive)
- Never throws on bad env values

When OFF: `/api/mlb/hr-radar`, `/api/mlb/hr-radar-board`, and the ladder builder emit zero v1-only fields. The frontend ladder falls back to the original five sections (no Ready bucket; original ATTACK NOW / BUILDING / WATCH labels remain). Engine math is identical in both states.

`DEBUG_HR_RADAR_V1=true` (only takes effect when the main flag is on) emits one `[HR_RADAR_V1_TRACE]` JSON log per ladder row carrying the validation payload (player, oldStage, newUserStage, score10, qualifyingSignals, officialSignalStage, officialSignalAt, hrOccurredAt, wouldCountAsCalledHitV1).

### 14.10 Standing rule

Goldmaster v1 is purely a **surfacing/qualification** layer. Never modify HR engines (`hrAlertEngine.ts`, `evaluateHRAlert.ts`, `HRSignalBuilder.ts`), scoring math (`signalScore.ts`), or calibration. See `.local/skills/signal-engine/SKILL.md` for the agent guardrails.
