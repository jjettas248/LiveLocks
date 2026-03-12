# LiveLocks — NBA Model Logic
*PropPulse / LiveLocks platform — core probability engine + automated signal generators*

---

## Table of Contents
1. [Core Probability Engine](#1-core-probability-engine)
2. [Halftime 2H Automated Engine](#2-halftime-2h-automated-engine)
3. [Live In-Game Signals Engine](#3-live-in-game-signals-engine)
4. [Edge Thresholds & Color Tiers](#4-edge-thresholds--color-tiers)
5. [Constants Reference](#5-constants-reference)

---

## 1. Core Probability Engine

**Location:** `server/storage.ts → DatabaseStorage.calculateProbability()`  
**Called by:** Both the halftime engine and the live signals engine.

### Input Fields

| Field | Type | Description |
|---|---|---|
| `playerId` | number | DB player ID |
| `opponentTeam` | string | 3-letter abbreviation (e.g. "BOS") |
| `halftimeMinutes` | number | Minutes played so far this game |
| `halftimeFouls` | number | Personal fouls so far |
| `halftimeStat` | number | Current game total for the stat type |
| `liveLine` | number | Real book line (never fabricated) |
| `statType` | string | e.g. "points", "rebounds", "pts_reb_ast" |
| `halftimeScore` | string | e.g. "54-61" (away-home) |
| `currentPeriod` | number | 0=pre, 1=Q1, 2=Q2, 3=Q3, 4=Q4 |
| `gameClock` | string | "M:SS" remaining in current period |
| `gameSpread` | number? | Game spread (used for garbage-time cuts) |
| `gameTotalLine` | number? | Game O/U total (used for pace blending) |
| `liveFgm/Fga` | number? | Live FGM/FGA (hot/cold modifier) |
| `liveFtm/Fta` | number? | Live FTM/FTA (hot/cold modifier) |
| `liveFg3m/Fg3a` | number? | Live 3PM/3PA (threes modifier) |

---

### Step 1: Game Minutes Remaining

```
periodsFullyRemaining = max(0, 4 - currentPeriod)
gameMinutesRemaining  = periodsFullyRemaining × 12 + clockMins
isHalftimeContext     = gameMinutesRemaining >= 22
```

`isHalftimeContext` controls pace cap, regression weight, and scale factors throughout.

---

### Step 2: H2 Baseline Selection

When the player is in Q3 or Q4 and has H2 averages on file:

```
inSecondHalf = currentPeriod >= 3
useH2        = inSecondHalf AND h2avgMinutes > 3
baselineSource = useH2 ? "h2" : "fullGame"
```

If `useH2 = true`, all per-minute rates are computed from H2 averages instead of full-game averages. This makes the projection use the player's second-half-specific splits.

---

### Step 3: Projected Remaining Minutes

```
minuteBase          = useH2 ? h2avgMinutes : avgMinutes
minuteGameFraction  = useH2 ? gameMinLeft / 24 : gameMinLeft / 48
remainingMinutes    = minuteBase × minuteGameFraction
```

**Foul trouble cuts:**
- 4+ fouls → `remainingMinutes × 0.45`
- 3 fouls  → `remainingMinutes × 0.70`

**Rotation check (halftime context only):**  
If the player played <75% of their expected H1 minutes (season avg prorated to one half), cap projected H2 minutes at 110% of actual H1 minutes. Catches injury management, coach's doghouse, matchup sits.

---

### Step 4: Pace Multiplier

```
gamePaceAvg    = (playerTeamPace + opponentPace) / 2
paceMultiplier = gamePaceAvg / LEAGUE_AVG_PACE (99.4)
```

**Game total line blend (if available):**
```
totalBasedPace  = gameTotalLine / 228   (228 = expected full-game total)
paceMultiplier  = totalBasedPace × 0.5 + paceMultiplier × 0.5
```

**Live score blend (if game is in progress):**
```
impliedFullGame   = (currentScoreTotal / elapsedMins) × 48
livePaceMultiplier = impliedFullGame / gameTotalLine (or 228 if no line)
paceMultiplier    = livePaceMultiplier × 0.6 + paceMultiplier × 0.4
```

**Cap:**
- Halftime context (≥22 min): max 1.12
- Live Q3/Q4: max 1.22
- Floor: 0.78

Halftime cap is lower because H1 observed pace is already embedded in `halftimeStat` and double-counting would inflate the projection.

---

### Step 5: Spread → Garbage Time

```
absSpread = |gameSpread|
```

| Condition | Reduction |
|---|---|
| Spread ≥ 20 AND usageRate ≥ 0.25 | 0.82 |
| Spread ≥ 15 AND usageRate ≥ 0.25 | 0.90 |
| Spread ≥ 15 AND usageRate ≥ 0.20 | 0.95 |
| Q4, <4 min clock, spread > 12 | min(current, 0.70) |

`remainingMinutes × spreadMinuteReduction`

---

### Step 6: Defense Multiplier

Sourced from the `team_defense` table (synced from NBA.com opponent stats).  
Stored as a multiplier relative to 1.0: >1.0 = softer defense, <1.0 = harder defense.  
Default 1.0 if team/position not on file.  
Cap: 0.86 – 1.14.

---

### Step 7: Efficiency Index

```
efficiencyIndex = clamp(offRating / 110, 0.70, 1.30)
```

110 = league-average offensive rating. Sourced from NBA.com Advanced sync.  
Falls back to 1.0 (neutral) when `offRating` is unavailable.

---

### Step 8: Live Shooting Modifier

Adjusts expected output for points/threes/combo props based on how the player is shooting in this game.

**For points (and pts_* combos):**
```
fgWeight    = min(maxFgWeight, liveFGA / 16)        # maxFgWeight: 0.25 halftime, 0.50 live
blendedFgPct = liveFgPct × fgWeight + seasonFgPct × (1 - fgWeight)
fgMod        = blendedFgPct / seasonFgPct

ftWeight     = min(0.40, liveFTA / 10)
blendedFtPct = liveFtPct × ftWeight + seasonFtPct × (1 - ftWeight)
ftMod        = blendedFtPct / seasonFtPct

shootingModifier = fgMod × 0.65 + ftMod × 0.35
shootingModifier = clamp(shootingModifier, 0.75, 1.25)
```

**For threes:**
```
fg3Weight    = min(maxFg3Weight, liveFG3A / 8)      # maxFg3Weight: 0.25 halftime, 0.55 live
blendedPct   = live3pPct × fg3Weight + season3pPct × (1 - fg3Weight)
threeMod     = blendedPct / season3pPct
shootingModifier = clamp(threeMod, 0.70, 1.30)
```

Halftime weights are capped lower because a 10-attempt H1 sample is too small to fully trust.

---

### Step 9: Observed vs Season Blend

**Per-minute rates:**
```
seasonPerMin  = seasonStatAvg / baseMin        (uses H2 baselines if useH2=true)
observedPerMin = halftimeStat / minutesPlayed
```

**Usage-weighted blend (less time played → lean harder on season):**

| Condition | observedW | seasonW |
|---|---|---|
| minutesPlayed < 5, usageRate ≥ 0.28 | 0.35 | 0.65 |
| minutesPlayed < 5, usageRate ≥ 0.22 | 0.25 | 0.75 |
| minutesPlayed < 5, else | 0.15 | 0.85 |
| minutesPlayed ≥ 5, usageRate ≥ 0.28 | 0.65 | 0.35 |
| minutesPlayed ≥ 5, usageRate ≥ 0.22 | 0.55 | 0.45 |
| minutesPlayed ≥ 5, else | 0.45 | 0.55 |

High-usage stars get more weight on observed (their H1 rates are more stable).  
Low-usage bench players regress harder to their season mean.

**Halftime regression (applied when `isHalftimeContext = true`):**
```
regressionFactor = 0.92
observedW = observedW × 0.92
seasonW   = 1 - observedW
```

Pulls 8% more weight toward season baseline when a full 2H still remains.

```
blendedPerMin = observedPerMin × observedW + seasonPerMin × seasonW
```

---

### Step 10: Expected Projection

```
expectedFromHere = blendedPerMin × remainingMinutes × defenseMultiplier × paceMultiplier × shootingModifier
expectedTotal    = halftimeStat + expectedFromHere
difference       = expectedTotal - liveLine
```

---

### Step 11: Sigmoid Probability

```
usageNorm = usageRate / 0.22
```

**Scale factors (by stat type):**

| Stat Type | Halftime | Live Q3/Q4 |
|---|---|---|
| steals / blocks / stl_blk | 10 | 14 |
| threes | 9 | 12 |
| rebounds / assists | 7.5 | 10 |
| combo stats (contains "_") | 4.0 | 5.5 |
| points (default) | 6 | 8 |

```
scaleFactor = baseScaleFactor × usageNorm × efficiencyIndex
scaleFactor = clamp(scaleFactor, 4, 20)

probability = 50 + difference × scaleFactor
probability = clamp(probability, 2, 98)
```

---

## 2. Halftime 2H Automated Engine

**Location:** `server/routes.ts → GET /api/halftime-plays`  
**Trigger:** Polled by authenticated frontend when games are at halftime.

### Flow

1. **Detect halftime games** — ESPN NBA scoreboard, filter for `statusDesc === "Halftime"` or `period=2, clock=0:00`.

2. **For each halftime game:**
   - Fetch ESPN summary boxscore for H1 stats
   - Resolve Odds API event ID for this game
   - Fetch game-level spread & total from Odds API (for pace + garbage-time use)

3. **For each player (≥3 min played in H1):**
   - Match ESPN name → DB player (exact match, then first+last fuzzy fallback)
   - Extract H1 stats: pts, reb, ast, stl, blk, 3PM, minutes, fouls
   - Extract H1 shooting splits: FGM/FGA, FTM/FTA, 3PM/3PA

4. **For each stat type** (points, rebounds, assists, threes, steals, blocks, pts_reb, pts_ast, pts_reb_ast, reb_ast, stl_blk):
   - **Line lookup (3-source waterfall):**
     1. Odds API live in-play lines (halftime-adjusted)
     2. Odds API pre-game lines (if no live line)
     3. SGO NBA (if still unresolved)
     4. Skip if no real book line — never fabricate
   - Use **median consensus** across books (never pick extremes)
   - Skip if `halftimeStat >= liveLine` (line already cleared — not actionable)
   - Call `calculateProbability()` with `currentPeriod=3, gameClock="12:00"`

5. **Edge filter:** `|probability - 50| >= 10`

6. **Persist to DB** (with dedup lock):
   - In-process Set check → DB select check → insert
   - Feeds Model Performance analytics

7. **Sort** by edge descending, return to frontend.

---

## 3. Live In-Game Signals Engine

**Location:** `server/routes.ts → GET /api/live-signals/:gameId`  
**Trigger:** Polled per game card in the Live Games tab. Cache TTL: 90 seconds.

### Flow

1. **Fetch ESPN summary** for the specific game.
2. **Check game status** — only runs for `"In Progress"` or `"Halftime"`.
3. **Resolve Odds API event ID** for spread/total modifiers.
4. **For each player (≥3 min played):**
   - Match ESPN name → DB player
   - Extract live stats and shooting splits (same parsing as halftime engine)

5. **Stat configs:** points, rebounds, assists, threes, pts_reb_ast (5 types for live, vs 11 for halftime).

6. **Line lookup (2-source):**
   1. Odds API (live in-play, then pre-game)
   2. SGO NBA

7. Skip if `currentStat >= liveLine`.

8. **Call `calculateProbability()`** with the actual `currentPeriod` and `displayClock`.

9. **Edge filter:** `|probability - 50| >= 5` (lower threshold than halftime — less time to mean-revert).

10. **Sort** by edge descending, cache result.

---

## 4. Edge Thresholds & Color Tiers

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

## 5. Constants Reference

| Constant | Value | Used for |
|---|---|---|
| `LEAGUE_AVG_PACE` | 99.4 | Pace normalization denominator |
| `EXPECTED_GAME_TOTAL` | 228 | Pace from O/U total |
| `isHalftimeContext` threshold | ≥22 min remaining | Switches halftime vs live path |
| `regressionFactor` | 0.92 | Halftime observed weight pullback |
| `usageNorm` denominator | 0.22 | League-avg usage rate |
| Scale factor clamp | [4, 20] | Probability spread control |
| `efficiencyIndex` clamp | [0.70, 1.30] | offRating normalization |
| `shootingModifier` clamp (pts) | [0.75, 1.25] | Hot/cold shooting adjustment |
| `shootingModifier` clamp (3s) | [0.70, 1.30] | 3PT hot/cold adjustment |
| Spread garbage-time threshold | spread ≥ 15 | Star-minute reduction trigger |
| H2 baseline minimum | h2avgMinutes > 3 | Minimum to use H2 splits |
| Halftime pace cap | 1.12 | Max pace multiplier at halftime |
| Live pace cap | 1.22 | Max pace multiplier in Q3/Q4 |
| Pace floor | 0.78 | Min pace multiplier |
| Max FG weight (halftime) | 0.25 | Shooting modifier cap |
| Max FG weight (live) | 0.50 | Shooting modifier cap |
| Max 3P weight (halftime) | 0.25 | 3PT shooting modifier cap |
| Max 3P weight (live) | 0.55 | 3PT shooting modifier cap |

---

### Approved Books (line sourcing)

DraftKings, FanDuel, Hard Rock Bet, Fanatics, PrizePicks, Underdog Fantasy.  
Lines from any other book are excluded. If no approved-book line is available, the play is skipped — no synthetic lines are ever used.
