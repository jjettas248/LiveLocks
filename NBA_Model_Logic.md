# LiveLocks — NBA Engine Behavior (v5)

*PropPulse / LiveLocks platform — archetype-based probability engine with fragility scoring*

**Engine Location:** `server/nba/probabilityEngine.ts`, `server/nba/archetypes.ts`

---

## Table of Contents

1. [Archetype Classification System](#1-archetype-classification-system)
2. [Core Probability Engine (Z-Score / Normal CDF)](#2-core-probability-engine)
3. [Blended Rate Model](#3-blended-rate-model)
4. [Variance & Sigma Computation](#4-variance--sigma-computation)
5. [Combo Stat Covariance Modeling](#5-combo-stat-covariance-modeling)
6. [Fragility Scoring](#6-fragility-scoring)
7. [Calibration Pipeline](#7-calibration-pipeline)
8. [Safety Ceilings](#8-safety-ceilings)
9. [Under-Bias Correction](#9-under-bias-correction)
10. [Late-Season / Playoffs Volatility Adapter](#10-late-season--playoffs-volatility-adapter)
11. [Halftime 2H Automated Engine](#11-halftime-2h-automated-engine)
12. [Live In-Game Signals Engine](#12-live-in-game-signals-engine)
13. [Edge Thresholds & Color Tiers](#13-edge-thresholds--color-tiers)
14. [Constants Reference](#14-constants-reference)

---

## 1. Archetype Classification System

**Location:** `server/nba/archetypes.ts → classifyArchetype()`

Every NBA player is classified into one of 7 archetypes based on minutes, starter consistency, usage rate, position, and lineup disruption. The archetype drives variance multipliers, fragility multipliers, correlation defaults, combo variance extra, and safety ceilings throughout the engine.

### 7 Archetype Types

| Archetype | Criteria |
|---|---|
| `stable_star` | ≥30 avg min, ≥0.80 starter consistency, low variance |
| `stable_starter` | ≥24 avg min, is starter, low variance |
| `volatile_starter` | ≥22 avg min, is starter, high variance (minutesVar > 30) |
| `bench_microwave` | <22 avg min, usage ≥ 0.20 |
| `low_minute_big` | <22 avg min, position C or PF |
| `lineup_impacted` | lineup disrupted OR <15 games played |
| `role_uncertain` | starter consistency < 0.50 AND <22 avg min |

### Classification Inputs

| Field | Type | Description |
|---|---|---|
| `avgMinutes` | number | Season average minutes |
| `recentMinutesVariance` | number | Recent games minutes variance |
| `seasonMinutesVariance` | number | Full season minutes variance |
| `isStarter` | boolean | Starting lineup status |
| `starterConsistency` | number | Fraction of games started (0–1) |
| `usageRate` | number | Usage rate (0–1 scale) |
| `position` | string | PG / SG / SF / PF / C |
| `lineupDisrupted` | boolean | Injury/trade roster disruption |
| `gamesPlayed` | number | Games played this season |

### Archetype Multipliers

| Archetype | Variance Mult | Minutes Fragility Mult | Combo Variance Extra |
|---|---|---|---|
| `stable_star` | 1.00 | 1.00 | 1.00 |
| `stable_starter` | 1.05 | 1.05 | 1.00 |
| `volatile_starter` | 1.20 | 1.20 | 1.00 |
| `bench_microwave` | 1.30 | 1.30 | 1.00 |
| `low_minute_big` | 1.25 | 1.35 | 1.00 |
| `lineup_impacted` | 1.35 | 1.40 | 1.12 |
| `role_uncertain` | 1.40 | 1.50 | 1.12 |

---

## 2. Core Probability Engine

**Location:** `server/nba/probabilityEngine.ts → computeProbability()`

The engine uses a **Normal CDF (Z-score)** probability model. For each market, it computes a projected mean (μ) and standard deviation (σ), then calculates P(OVER) = Φ(z) where z = (μ - threshold) / σ.

### Probability Flow

```
1. Compute μ (mean) and σ² (variance) for the market
   - Single stat: rate × expected_minutes
   - Combo stat: sum of component means + covariance terms
2. Add currentStat to get total projection
3. threshold = line + 0.5 (half-point adjustment)
4. z = (totalMu - threshold) / σ
5. P_over_raw = Φ(z) via Normal CDF
6. Direction: OVER if totalMu > line with sufficient separation, UNDER if below
7. Apply fragility penalty
8. Apply family penalty factor
9. Apply under-bias correction (if UNDER)
10. Apply calibration shrinkage
11. Apply safety ceiling
12. Final signal: direction + displayConfidence
```

### Separation Thresholds

| Market Type | Minimum Separation (ε) |
|---|---|
| Single stat | 0.35 |
| Combo stat | 0.60 |

If the separation between projection and line is below ε, the signal is marked `NO_SIGNAL`.

### Minimum Edge Requirements

- Raw model edge must be ≥ 0.04 (4%)
- Display confidence must be ≥ 0.58 (58%)
- Final edge must be ≥ 0.04 (4%)
- Projection must align with direction (contradiction → NO_SIGNAL)

---

## 3. Blended Rate Model

**Location:** `server/nba/probabilityEngine.ts → getBlendedRate()`

The per-minute stat rate is a weighted blend of three rate sources:

| Source | Weight | Description |
|---|---|---|
| Recent (last ~10 games) | 45% | Short-term form |
| Season (full season) | 35% | Overall talent level |
| Role (positional/role-based) | 20% | Positional baseline |

**Small sample adjustment:** When `recentGameCount < 5`, the recent weight is reduced proportionally and redistributed to season weight:

```
reduction = wRecent × (1 - recentGameCount / 5)
wRecent -= reduction
wSeason += reduction
```

### Variance Rate Blending

Variance rates are blended separately with fixed weights:

| Source | Weight |
|---|---|
| Recent variance | 50% |
| Season variance | 30% |
| Role variance | 20% |

---

## 4. Variance & Sigma Computation

**Location:** `server/nba/probabilityEngine.ts → computeSingleStatMeanAndVariance()`

For each single stat:

```
E_min = max(8, expected_minutes)
mu = blended_rate × E_min
sigma_min = max(1.5, √(minutes_variance))
sigma_min_adj = sigma_min × MINUTES_FRAGILITY_MULTIPLIERS[archetype]
Var_min = sigma_min_adj²
rawVariance = E_min × blended_variance_rate + (rate²) × Var_min
adjVariance = rawVariance × VARIANCE_MULTIPLIERS[archetype]
adjVariance = max(adjVariance, STAT_SIGMA_FLOOR²)
```

### Stat Sigma Floors

| Stat | Floor (σ) |
|---|---|
| Points | 3.0 |
| Rebounds | 2.0 |
| Assists | 1.8 |
| Steals | 0.8 |
| Blocks | 0.8 |
| Threes | 1.2 |

---

## 5. Combo Stat Covariance Modeling

**Location:** `server/nba/probabilityEngine.ts → computeComboMeanAndVariance()`

For combo markets (pts_reb, pts_ast, reb_ast, pts_reb_ast, stl_blk):

```
mu_combo = Σ mu_i  (sum of component means)
var_combo = Σ var_i + Σ 2 × ρ_ij × σ_i × σ_j  (variances + covariance terms)
var_combo *= COMBO_VARIANCE_EXTRA[archetype]
var_combo *= COMBO_INFLATION[market]
```

### Default Correlations by Archetype

| Archetype | ρ(pts,reb) | ρ(pts,ast) | ρ(reb,ast) |
|---|---|---|---|
| `stable_star` | 0.20 | 0.28 | 0.12 |
| `stable_starter` | 0.18 | 0.22 | 0.10 |
| `volatile_starter` | 0.14 | 0.18 | 0.08 |
| `bench_microwave` | 0.08 | 0.12 | 0.05 |
| `low_minute_big` | 0.22 | 0.05 | 0.10 |
| `lineup_impacted` | 0.14 | 0.18 | 0.08 |
| `role_uncertain` | 0.14 | 0.18 | 0.08 |

Empirical correlations override defaults when available.

### Combo Inflation Multipliers

| Market | Inflation |
|---|---|
| pts_reb | 1.05 |
| pts_ast | 1.08 |
| reb_ast | 1.08 |
| pts_reb_ast | 1.12 |

---

## 6. Fragility Scoring

**Location:** `server/nba/probabilityEngine.ts → computeFragilityScore()`

A composite score (0–1) quantifying how fragile a player's projection is, based on 6 weighted inputs:

| Input | Weight | Flagged When |
|---|---|---|
| Normalized minutes variance | 25% | > 0.5 |
| Role uncertainty | 20% | > 0.5 |
| Lineup instability | 20% | > 0.5 |
| Blowout risk | 15% | > 0.5 |
| Usage shock | 10% | > 0.3 |
| Late-season chaos | 10% | > 0.3 |

**Fragility penalty applied to probability:**

```
fragilityPenalty = 0.45 × fragilityScore
P_side_fragile = 0.5 + (P_side_raw - 0.5) × (1 - fragilityPenalty)
```

A high fragility score (e.g., 0.8) results in a ~36% reduction of the edge magnitude, pulling the probability closer to 50%.

---

## 7. Calibration Pipeline

**Location:** `server/nba/probabilityEngine.ts → calibrate()`

After raw probability computation, fragility adjustment, and family penalty, the calibration step applies shrinkage to prevent overconfident signals:

### Calibration Shrinkage

| Market Type | Shrinkage Factor |
|---|---|
| Single stat | 0.88 |
| Combo stat | 0.78 |

```
P_calibrated = 0.5 + (P_side - 0.5) × shrinkage
```

### Volatile/Impacted Archetype Penalty

If the archetype is volatile (`volatile_starter`, `bench_microwave`, `low_minute_big`) or impacted (`lineup_impacted`, `role_uncertain`), an additional 0.90× shrinkage is applied:

```
P_calibrated = 0.5 + (P_calibrated - 0.5) × 0.90
```

---

## 8. Safety Ceilings

**Location:** `server/nba/archetypes.ts → getSafetyCeiling()`

Maximum confidence cap per archetype category:

| Category | Single Market | Combo Market |
|---|---|---|
| Stable (star, starter) | 80% | 74% |
| Volatile (volatile_starter, bench, low_minute_big) | 70% | 66% |
| Impacted (lineup_impacted, role_uncertain) | 64% | 64% |

If the calibrated probability exceeds the ceiling, it is capped at the ceiling value.

---

## 9. Under-Bias Correction

When `underBiasCorrectionActive = true` and direction is UNDER:

**Pre-calibration:** `P_side = 0.5 + (P_side - 0.5) × 0.92`

**In calibration:** An additional `0.95×` shrinkage is applied.

This reduces the systematic over-prediction of UNDER outcomes observed in historical data.

---

## 10. Late-Season / Playoffs Volatility Adapter

The `lateSeasonChaos` fragility input (weight: 10%) captures increased volatility during:

- Final 2 weeks of the regular season (rest days, seeding games)
- Playoffs (rotations tighten, pace changes, unfamiliar matchups)
- Back-to-back games in compressed schedules

When `lateSeasonChaos > 0.3`, it contributes to the fragility score, pulling probabilities toward 50%.

---

## 11. Halftime 2H Automated Engine

**Location:** `server/routes.ts → GET /api/halftime-plays`

### Flow

1. Detect halftime games from ESPN NBA scoreboard (`statusDesc === "Halftime"` or `period=2, clock=0:00`)
2. For each halftime game: fetch box score, resolve Odds API event ID, fetch game spread/total
3. For each player (≥3 min played in H1): extract H1 stats and shooting splits
4. For each of 11 stat types: look up real book lines (3-source waterfall: live → pre-game → SGO), use median consensus, skip if no real line or stat already cleared
5. Run probability engine with `currentPeriod=3, gameClock="12:00"` (start of 2H)
6. Edge filter: `|probability - 50| >= 10`
7. Persist to DB with deduplication, sort by edge descending, return top 20

### Alert Trigger

Plays with edge ≥ 35 (≥85% hit implied) fire push/SMS alerts, deduplicated per `playerName|statType|line` per session.

---

## 12. Live In-Game Signals Engine

**Location:** `server/routes.ts → GET /api/live-signals/:gameId`

### Flow

1. Fetch ESPN summary for the game (In Progress or Halftime)
2. For each player (≥3 min): match to DB, extract stats + shooting splits
3. Check 5 primary markets: Points, Rebounds, Assists, Threes, PRA
4. Line lookup: Odds API (live → pre-game) → SGO
5. Skip if currentStat ≥ liveLine
6. Run probability engine with actual period and clock
7. Edge filter: `|probability - 50| >= 5`
8. Sort by edge descending, cache for 90 seconds

---

## 13. Edge Thresholds & Color Tiers

### Display Tiers

| Color | Condition | Meaning |
|---|---|---|
| Green | probability ≥ 85% OVER | Strong over signal |
| Red | probability ≤ 15% (≥85% UNDER) | Strong under signal |
| Yellow | directional confidence 70–84% | Moderate edge |
| Teal | directional confidence 60–69% | Weak edge |

### Signal Thresholds

| Engine | Minimum edge to surface |
|---|---|
| Halftime 2H | `|prob - 50| >= 10` |
| Live in-game | `|prob - 50| >= 5` |

---

## 14. Constants Reference

| Constant | Value | Used For |
|---|---|---|
| Single stat ε | 0.35 | Minimum separation for single markets |
| Combo stat ε | 0.60 | Minimum separation for combo markets |
| Recent rate weight | 0.45 | Blended rate: recent games |
| Season rate weight | 0.35 | Blended rate: full season |
| Role rate weight | 0.20 | Blended rate: positional baseline |
| Single shrinkage | 0.88 | Calibration for single markets |
| Combo shrinkage | 0.78 | Calibration for combo markets |
| Volatile shrinkage | 0.90 | Additional shrinkage for volatile archetypes |
| Under-bias pre-cal | 0.92 | UNDER direction pre-calibration correction |
| Under-bias in-cal | 0.95 | UNDER direction in-calibration correction |
| Fragility penalty max | 0.45 | Maximum fragility reduction factor |
| Min display confidence | 0.58 | Below this → NO_SIGNAL |
| Min model edge | 0.04 | Below this → NO_SIGNAL |
| Halftime 2H edge | 10% | Minimum edge to surface halftime play |
| Live signal edge | 5% | Minimum edge to surface live signal |
| Alert threshold | 35% (≥85% hit) | Push/SMS alert trigger |

### Approved Books (Line Sourcing)

DraftKings, FanDuel, Hard Rock Bet, PrizePicks, Underdog Fantasy.
Lines from other books are excluded. If no approved-book line is available, the play is skipped — no synthetic lines are ever used.
