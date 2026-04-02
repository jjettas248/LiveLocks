# LiveLocks — NCAAB Engine Behavior

*PropPulse / LiveLocks platform — pace-based projection model with Normal CDF probability*

**Engine Location:** `server/ncaabEngine.ts`

---

## Table of Contents

1. [Engine Architecture](#1-engine-architecture)
2. [Pace-Based Projection Model](#2-pace-based-projection-model)
3. [Normal CDF Probability](#3-normal-cdf-probability)
4. [Dynamic Multiplier](#4-dynamic-multiplier)
5. [12 Market Types](#5-12-market-types)
6. [Calibration Pipeline](#6-calibration-pipeline)
7. [Market-Specific Variance Table](#7-market-specific-variance-table)
8. [Pick Direction Logic](#8-pick-direction-logic)
9. [CLV Edge & Public Bet Fade Layer](#9-clv-edge--public-bet-fade-layer)
10. [Derived Signal Calibration](#10-derived-signal-calibration)
11. [Confidence Tiers](#11-confidence-tiers)
12. [Canonical Market Object Contract](#12-canonical-market-object-contract)
13. [Display & Validation](#13-display--validation)
14. [Constants Reference](#14-constants-reference)

---

## 1. Engine Architecture

The NCAAB engine is a three-layer pipeline:

```
Input (NCAABGameInput)
  ↓
Projection Layer (calculateNCAABProjection)
  ↓ NCAABProjectionResult
Probability Layer (calculateNCAABProbabilities)
  ↓ NCAABProbabilityResult
Full Engine Pipeline (runNCAABEngine)
  ↓ NCAABEngineOutput (canonical output contract)
```

The engine produces a single `NCAABEngineOutput` per game containing projections, probabilities, market verdicts, and a canonical `markets` object. The client renders exclusively from this output — no client-side recomputation.

---

## 2. Pace-Based Projection Model

**Location:** `server/ncaabEngine.ts → calculateNCAABProjection()`

The projection model uses three distinct paths depending on game state:

### H1 Path (First Half)

```
h1MinElapsed = (1200 - secondsRemainingInHalf) / 60
rawPaceH1Live = currentTotal / h1MinElapsed
blend = min(1.0, h1MinElapsed / 12)
blendedPace = rawPaceH1Live × blend + AVG_PACE × (1 - blend)

proj1HTotal = currentTotal + blendedPace × remainingH1Minutes
projectedTotal = proj1HTotal + (blendedPace × 20) + projTotalBonus
```

As more of H1 elapses, the live pace is weighted more heavily (up to 100% at 12 minutes).

### Halftime Path

```
paceH1 = min(h1Total / 20, AVG_PACE × PACE_CAP)
projectedTotal = h1Total + (paceH1 × 20) + projTotalBonus
proj2HTotal = paceH1 × 20 + projTotalBonus
```

At halftime, the H1 pace becomes the primary projection anchor for the second half.

### H2 Path (Second Half)

```
rawPaceH2Live = h2TotalSoFar / h2MinElapsed
paceH2Live = min(rawPaceH2Live, AVG_PACE × 1.5)
paceH2 = paceH2Live × 0.70 + paceH1 × 0.30

projectedTotal = h1Total + h2TotalSoFar + (paceH2 × remainingMin) + projTotalBonus
proj2HTotal = h2TotalSoFar + (paceH2 × remainingMin) + projTotalBonus
```

H2 pace blends the live H2 pace (70%) with the established H1 pace (30%).

### Spread Projection

- **H1:** Based on home scoring share of remaining H1 scoring
- **Halftime:** Current margin
- **H2:** Current margin + margin-per-minute × remaining minutes

### Team Total Projection

```
homeShare = (homeScore / currentTotal) × 0.6 + 0.5 × 0.4
projectedTeamTotalHome = projectedTotal × homeShare
projectedTeamTotalAway = projectedTotal × (1 - homeShare)
```

---

## 3. Normal CDF Probability

**Location:** `server/ncaabEngine.ts → calculateNCAABProbabilities()`

The engine uses a Normal CDF (Φ) for probability computation:

```
totalDiff = projectedTotal - effectiveLine
adjustedSigma = DEFAULT_VARIANCE / dynamicMultiplier
rawOverProb = Φ(totalDiff / adjustedSigma) × 100
```

### Spread Probability

```
spreadDiff = projectedSpread - adjustedSpreadLine
rawSpreadProb = Φ(spreadDiff / (adjustedSigma × 0.8)) × 100
```

The spread sigma is 80% of the total sigma because spreads have less inherent variance than totals.

### Half-Specific Probabilities

- **H1 Total:** Uses `MARKET_VARIANCE.h1_total` / dynamicMultiplier as sigma
- **H2 Total:** Uses `MARKET_VARIANCE.h2_total` / dynamicMultiplier as sigma

### Too-Early Guard

When fewer than 60 seconds have elapsed, all probabilities are set to 50% (no signal).

---

## 4. Dynamic Multiplier

**Location:** `server/ncaabEngine.ts → getDynamicMultiplier()`

The dynamic multiplier scales the sigma (variance) based on game progress, making the engine more confident as more game data is available:

| Game Progress | Multiplier |
|---|---|
| < 25% | 0.6 |
| 25–50% | 0.8 |
| 50–65% | 0.9 |
| 65–75% | 1.0 |
| 75–85% | 1.1 |
| 85–92% | 1.2 |
| > 92% | 1.4 |
| Overtime | 1.4 |

**Range:** Clamped to [0.6, 1.4]

**Effect:** Higher multiplier → smaller adjusted sigma → more decisive probabilities. At game start (multiplier = 0.6), probabilities stay closer to 50%. Near game end (multiplier = 1.4), small projection-vs-line gaps produce large probability swings.

---

## 5. 12 Market Types

The engine supports 12 market types across three game segments:

| Segment | Markets |
|---|---|
| Full Game | `full_game_total`, `spread`, `team_total_home`, `team_total_away` |
| First Half (H1) | `h1_total`, `h1_spread`, `h1_team_total_home`, `h1_team_total_away` |
| Second Half (H2) | `h2_total`, `h2_spread`, `h2_team_total_home`, `h2_team_total_away` |

### Canonical Market Keys (6 Core)

The 6 canonical markets are surfaced in the `markets` object:

1. `full_total` — Full Game Total
2. `full_spread` — Full Game Spread
3. `h1_total` — 1st Half Total
4. `h1_spread` — 1st Half Spread
5. `h2_total` — 2nd Half Total
6. `h2_spread` — 2nd Half Spread

---

## 6. Calibration Pipeline

**Location:** `server/ncaabEngine.ts → calibrateNCAABProbability()`

### Calibration Cap

All NCAAB probabilities are capped at **78%** (distance from 50% capped at 28 points):

```
distFrom50 = |calibrated - 50|
if distFrom50 > (78 - 50):
    calibrated = 50 ± 28
```

### Too-Early Override

If fewer than 60 seconds have elapsed, calibrated probability returns 50%.

### Final Clamp

All probabilities are clamped to [1, 99].

---

## 7. Market-Specific Variance Table

| Market Type | Variance (σ) |
|---|---|
| `full_game_total` | 12.0 |
| `h1_total` | 8.0 |
| `h2_total` | 8.0 |
| `spread` | 10.0 |
| `h1_spread` | 8.0 |
| `h2_spread` | 8.0 |
| `team_total_home` | 7.0 |
| `team_total_away` | 7.0 |
| `h1_team_total_home` | 5.0 |
| `h1_team_total_away` | 5.0 |
| `h2_team_total_home` | 5.0 |
| `h2_team_total_away` | 5.0 |

The variance is divided by the dynamic multiplier to produce the adjusted sigma used in probability computation.

---

## 8. Pick Direction Logic

**Location:** `server/ncaabEngine.ts → determineRecommendedSide()`

A three-gate decision process:

### Gate 1: Projection Gap

```
gap = projectedValue - line
if |gap| < EDGE_MIN_GAP (2.0): → NO_EDGE
```

### Gate 2: Projection/Probability Contradiction Guard

```
projectionSays = gap > 0 ? "OVER" : "UNDER"
probSays = overProb > underProb ? "OVER" : "UNDER"
if projectionSays ≠ probSays: → NO_EDGE + warning
```

This guard prevents signals where the projection and probability disagree — a sign of unstable model state.

### Gate 3: Minimum Probability

```
dominantProb = probability for the projected side
if dominantProb < EDGE_MIN_PROB (57%): → NO_EDGE
```

### Output

If all three gates pass: `side = projectionSays` with the dominant probability.

---

## 9. CLV Edge & Public Bet Fade Layer

**Location:** `server/ncaabEngine.ts` (canonical market construction)

### Closing Line Value (CLV) Edge

When opening and closing line data is available:

```
clvEdge = |liveLine - closingLine|
```

CLV measures how much the live line has moved since the closing line, indicating sharp money movement.

### Public Bet Percentage Fade

When public betting percentage data is available:

```
publicInflation = lineMovedTowardPublic(openLine, closingLine, publicPct, isTotal)
fadeRecommended = publicInflation AND publicPct > 50 (for totals)
```

If the line has moved toward the public side (indicating books haven't adjusted against public money), the engine flags a potential fade opportunity.

### Adjusted Edge Score

When both CLV and public data are available, the edge score can be adjusted:

```
adjustedEdgeScore = modelEdge + clvContribution + publicFadeContribution
```

---

## 10. Derived Signal Calibration

**Location:** `server/services/engineSignal.ts → computeConfidenceTier()`

When a line is not from a real sportsbook but is derived (estimated), the signal receives aggressive dampening:

- Derived edge and probability are scaled by **0.65×** (edge and probability distance from 50% both multiplied by 0.65)
- Derived confidence tier is recalculated after dampening — effectively capped at STRONG or below
- Derived total market probability is additionally clamped to [35%, 65%]
- Projection/line contradiction check: if derived total projects OVER but projection ≤ bookLine (or UNDER but projection ≥ bookLine), signal is suppressed

This prevents estimated lines from producing the same confidence level as real sportsbook lines.

---

## 11. Confidence Tiers

### Game-Level Confidence (ConfidenceTier)

| Tier | Criteria |
|---|---|
| HIGH | Probability ≥ 70% AND gap ≥ 5.0 |
| MEDIUM | Probability ≥ 62% AND gap ≥ 3.0 |
| LOW | Probability ≥ 57% AND gap ≥ 2.0 |
| NO_EDGE | Below LOW thresholds |

### Market-Level Confidence (MarketConfidenceTier)

| Tier | Edge Threshold |
|---|---|
| ELITE | |edge| ≥ 12 |
| STRONG | |edge| ≥ 8 |
| VALUE | |edge| ≥ 4 |
| NONE | |edge| < 4 |

### Probability-Based Confidence (ProbabilityConfidenceTier)

Used for unified signal output:

| Tier | Probability |
|---|---|
| ELITE | ≥ 75% |
| STRONG | ≥ 65% |
| LEAN | ≥ 55% |
| NO_EDGE | < 55% |

Derived lines are capped at STRONG regardless of probability.

---

## 12. Canonical Market Object Contract

**Location:** `server/ncaabEngine.ts → NCAABMarket interface`

Each canonical market in the `markets` object contains:

| Field | Type | Description |
|---|---|---|
| `available` | boolean | Whether this market has data |
| `marketKey` | NCAABMarketKey | One of 6 canonical keys |
| `label` | string | Display label (e.g., "Full Game Total") |
| `sportsbook` | string \| null | Source sportsbook |
| `bookLine` | number \| null | Sportsbook line |
| `projection` | number \| null | Engine projection |
| `modelProb` | number \| null | Calibrated probability |
| `bookImpliedProb` | number \| null | Book-implied probability from odds |
| `edge` | number \| null | Engine edge (modelProb - bookImplied) |
| `side` | OVER/UNDER/HOME/AWAY/null | Recommended side |
| `confidenceTier` | MarketConfidenceTier | ELITE/STRONG/VALUE/NONE |
| `clvEdge` | number \| null | Closing Line Value edge |
| `publicBetPct` | number \| null | Public betting percentage |
| `publicInflation` | boolean \| null | Whether public money inflated the line |
| `fadeRecommended` | boolean \| null | Whether a public fade is recommended |
| `adjustedEdgeScore` | number \| null | Edge score adjusted for CLV/public factors |
| `isDerived` | boolean | Whether line is estimated, not from a sportsbook |

---

## 13. Display & Validation

### Display Output

**Location:** `server/ncaabEngine.ts → buildNCAABDisplayOutput()`

The display output is a formatted version of the engine output:

- Projected total/spread as strings with 1 decimal
- Probabilities as percentage strings
- Edge labels: Slight Lean / Lean EV / Strong EV / Extreme EV
- Pre-game confidence labels: No Edge / Low / Moderate / High / Extreme

### Display Consistency Validation

**Location:** `server/ncaabEngine.ts → validateDisplayConsistency()`

Post-build validation catches:

- Wrong-side signals (projection vs. line mismatch)
- Probability sum mismatch (over + under ≠ ~100)
- Rounding mismatches between engine and display values
- High probability warnings (exceeds 75% threshold)
- Stale engine output (> 30 seconds old)
- Stale line data (> 120 seconds old)
- Enrichment skew between data sources (> 60 seconds)
- Display divergence from engine (side or tier mismatch)
- Market verdict contradictions

---

## 14. Constants Reference

| Constant | Value | Used For |
|---|---|---|
| `NCAAB_AVG_PACE` | 3.45 | Default pace per minute |
| `NCAAB_H1_FRACTION` | 0.47 | H1 scoring fraction |
| `NCAAB_PACE_CAP` | 1.35 | Maximum pace multiplier |
| `HALF_SECONDS` | 1200 | 20 minutes per half |
| `TOTAL_GAME_SECONDS` | 2400 | 40 minutes total |
| `DEFAULT_VARIANCE` | 12.0 | Base variance for total |
| `CALIBRATION_CAP` | 78 | Maximum calibrated probability |
| `CALIBRATION_WARN_THRESHOLD` | 75 | Warning threshold |
| `DYNAMIC_MULT_MIN` | 0.6 | Minimum dynamic multiplier |
| `DYNAMIC_MULT_MAX` | 1.4 | Maximum dynamic multiplier |
| `EDGE_MIN_GAP` | 2.0 | Minimum projection gap for edge |
| `EDGE_MIN_PROB` | 57 | Minimum probability for edge |
| Stale engine threshold | 30s | Engine output age limit |
| Stale line threshold | 120s | Line data age limit |
| Enrichment skew threshold | 60s | Source timestamp skew limit |
